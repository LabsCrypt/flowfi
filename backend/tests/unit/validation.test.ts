import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  INVALID_PARAMETERS_TYPE,
  assertResponseMatches,
  validateRequest,
} from "../../src/middleware/schema-validator.middleware.js";
import { parsePagination } from "../../src/validators/stream.validator.js";

const streamResponse = z.object({ id: z.string(), duration: z.number().int().positive() });

function buildApp() {
  const app = express();
  app.use(express.json());
  app.post(
    "/streams/:id",
    validateRequest({
      params: z.object({ id: z.string().regex(/^\d+$/, "Expected numeric id") }),
      query: z.object({ dryRun: z.enum(["true", "false"]).optional() }).strict(),
      headers: z.object({ "x-client": z.string().min(1, "Header is required") }),
      body: z.object({
        duration: z.number().int("Expected positive integer").positive("must be greater than 0"),
      }),
    }),
    (req, res) => {
      const { params, body } = res.locals.validated;
      res.json({ id: params.id, duration: body.duration });
    },
  );
  return app;
}

describe("schema validator middleware", () => {
  it("passes valid requests with parsed values to the controller", async () => {
    const res = await request(buildApp())
      .post("/streams/42?dryRun=true")
      .set("x-client", "web")
      .send({ duration: 3600 });

    expect(res.status).toBe(200);
    expect(assertResponseMatches(streamResponse, res.body)).toEqual({ id: "42", duration: 3600 });
  });

  it("rejects an invalid body with RFC 7807 problem details", async () => {
    const res = await request(buildApp()).post("/streams/42").set("x-client", "web").send({ duration: 0 });

    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/application\/problem\+json/);
    expect(res.body).toEqual({
      type: INVALID_PARAMETERS_TYPE,
      title: "Invalid Request Parameters",
      status: 400,
      detail: "Invalid parameter 'duration': must be greater than 0",
      invalidParams: [{ name: "duration", reason: "must be greater than 0" }],
    });
  });

  it("rejects undocumented query parameters", async () => {
    const res = await request(buildApp())
      .post("/streams/42?debug=1")
      .set("x-client", "web")
      .send({ duration: 10 });

    expect(res.status).toBe(400);
    expect(res.body.invalidParams[0].reason).toMatch(/debug/);
  });

  it("rejects invalid path params and missing headers together", async () => {
    const res = await request(buildApp()).post("/streams/abc").send({ duration: 10 });

    expect(res.status).toBe(400);
    const names = res.body.invalidParams.map((p: { name: string }) => p.name);
    expect(names).toEqual(expect.arrayContaining(["x-client", "id"]));
  });

  it("does not coerce string numbers in the body", async () => {
    const res = await request(buildApp()).post("/streams/42").set("x-client", "web").send({ duration: "10" });
    expect(res.status).toBe(400);
  });

  it("assertResponseMatches flags contract drift", () => {
    expect(() => assertResponseMatches(streamResponse, { id: "1", duration: "10" })).toThrow(/duration/);
  });
});

describe("parsePagination (#1644)", () => {
  function paginationApp() {
    const app = express();
    app.use(express.json());
    app.get("/paginated", (req, res) => {
      const result = parsePagination(req.query as Record<string, unknown>);
      if (!result.ok) {
        res.status(400).json({ error: result.message });
        return;
      }
      res.json(result);
    });
    app.get("/paginated/large", (req, res) => {
      const result = parsePagination(req.query as Record<string, unknown>, {
        defaultLimit: 50,
        maxLimit: 200,
      });
      if (!result.ok) {
        res.status(400).json({ error: result.message });
        return;
      }
      res.json(result);
    });
    return app;
  }

  it("defaults limit=20, page=1, offset=0 when parameters are absent", () => {
    expect(parsePagination({})).toEqual({ ok: true, page: 1, limit: 20, offset: 0 });
  });

  it("accepts a valid limit and clamps it to maxLimit", async () => {
    const res = await request(paginationApp()).get("/paginated?limit=50");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, page: 1, limit: 50, offset: 0 });

    const capped = await request(paginationApp()).get("/paginated?limit=999999");
    expect(capped.status).toBe(200);
    expect(capped.body.limit).toBe(100);
  });

  it("uses per-endpoint defaults and caps", () => {
    const custom = parsePagination({ limit: "999" }, { defaultLimit: 50, maxLimit: 200 });
    expect(custom).toEqual({ ok: true, page: 1, limit: 200, offset: 0 });
    const fallback = parsePagination({}, { defaultLimit: 50, maxLimit: 200 });
    expect(fallback).toEqual({ ok: true, page: 1, limit: 50, offset: 0 });
  });

  it("rejects negative, zero, and non-integer limits with a 400", async () => {
    for (const bad of ["-5", "0", "abc", "1.5"]) {
      const res = await request(paginationApp()).get(`/paginated?limit=${bad}`);
      expect(res.status, `limit=${bad}`).toBe(400);
      expect(res.body.error).toMatch(/limit/);
    }
  });

  it("derives offset from page", async () => {
    const res = await request(paginationApp()).get("/paginated?page=3&limit=25");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, page: 3, limit: 25, offset: 50 });
  });

  it("rejects negative, zero, and non-integer pages with a 400", async () => {
    for (const bad of ["-1", "0", "first", "2.7"]) {
      const res = await request(paginationApp()).get(`/paginated?page=${bad}`);
      expect(res.status, `page=${bad}`).toBe(400);
      expect(res.body.error).toMatch(/page/);
    }
  });

  it("prefers an explicit offset over page", () => {
    const result = parsePagination({ page: "3", offset: "10", limit: "20" });
    expect(result).toEqual({ ok: true, page: 3, limit: 20, offset: 10 });
  });

  it("rejects a negative offset", () => {
    expect(parsePagination({ offset: "-5" }).ok).toBe(false);
  });

  it("rejects repeated (array) query parameters", () => {
    expect(parsePagination({ limit: ["1", "2"] }).ok).toBe(false);
    expect(parsePagination({ page: ["1", "2"] }).ok).toBe(false);
  });
});
