import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { parsePagination } from "../../src/validators/stream.validator.js";

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
