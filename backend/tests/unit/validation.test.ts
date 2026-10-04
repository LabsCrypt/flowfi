import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  INVALID_PARAMETERS_TYPE,
  assertResponseMatches,
  validateRequest,
} from "../../src/middleware/schema-validator.middleware.js";

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
