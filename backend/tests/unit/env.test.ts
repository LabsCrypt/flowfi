/**
 * Environment validation tests (issue #1646).
 *
 * The validator must catch missing/invalid startup-critical variables with
 * clear per-variable messages, accept a production config when complete,
 * and supply development/test defaults so a fresh clone boots without a
 * fully populated .env.
 */

import { describe, it, expect } from "vitest";
import {
  DEV_DATABASE_URL,
  DEV_SOROBAN_RPC_URL,
  validateEnv,
} from "../../src/config/env.js";

const productionEnv = {
  NODE_ENV: "production",
  PORT: "8080",
  DATABASE_URL: "postgresql://user:pass@db.example:5432/flowfi",
  SOROBAN_RPC_URL: "https://soroban.example.com",
};

describe("validateEnv (#1646)", () => {
  it("accepts a complete production environment", () => {
    const result = validateEnv(productionEnv);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.env).toEqual({
      nodeEnv: "production",
      port: 8080,
      databaseUrl: productionEnv.DATABASE_URL,
      sorobanRpcUrl: productionEnv.SOROBAN_RPC_URL,
    });
  });

  it("reports each missing required variable in production", () => {
    const result = validateEnv({ NODE_ENV: "production" });
    expect(result.ok).toBe(false);
    expect(result.env).toBeNull();
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/DATABASE_URL/),
        expect.stringMatching(/SOROBAN_RPC_URL/),
      ]),
    );
  });

  it("reports an invalid PORT with the accepted range", () => {
    const result = validateEnv({ ...productionEnv, PORT: "not-a-port" });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/PORT/);
    expect(result.errors[0]).toMatch(/1 and 65535/);
  });

  it("rejects out-of-range and non-integer ports", () => {
    expect(validateEnv({ ...productionEnv, PORT: "0" }).ok).toBe(false);
    expect(validateEnv({ ...productionEnv, PORT: "70000" }).ok).toBe(false);
    expect(validateEnv({ ...productionEnv, PORT: "3.5" }).ok).toBe(false);
  });

  it("rejects an invalid NODE_ENV", () => {
    const result = validateEnv({ ...productionEnv, NODE_ENV: "staging" });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/NODE_ENV/);
  });

  it("rejects a non-postgres DATABASE_URL", () => {
    const result = validateEnv({
      ...productionEnv,
      DATABASE_URL: "mysql://user:pass@db/flowfi",
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/DATABASE_URL/);
  });

  it("rejects an invalid SOROBAN_RPC_URL", () => {
    const result = validateEnv({
      ...productionEnv,
      SOROBAN_RPC_URL: "not a url",
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/SOROBAN_RPC_URL/);
  });

  it("substitutes development defaults for an empty environment", () => {
    const result = validateEnv({ NODE_ENV: "development" });
    expect(result.ok).toBe(true);
    expect(result.env).toEqual({
      nodeEnv: "development",
      port: 3001,
      databaseUrl: DEV_DATABASE_URL,
      sorobanRpcUrl: DEV_SOROBAN_RPC_URL,
    });
  });

  it("substitutes test defaults for an empty environment", () => {
    const result = validateEnv({ NODE_ENV: "test" });
    expect(result.ok).toBe(true);
    expect(result.env?.databaseUrl).toBe(DEV_DATABASE_URL);
    expect(result.env?.sorobanRpcUrl).toBe(DEV_SOROBAN_RPC_URL);
    expect(result.env?.port).toBe(3001);
  });

  it("keeps explicit values over development defaults", () => {
    const result = validateEnv({
      NODE_ENV: "development",
      PORT: "4000",
      DATABASE_URL: productionEnv.DATABASE_URL,
      SOROBAN_RPC_URL: productionEnv.SOROBAN_RPC_URL,
    });
    expect(result.ok).toBe(true);
    expect(result.env?.port).toBe(4000);
    expect(result.env?.databaseUrl).toBe(productionEnv.DATABASE_URL);
    expect(result.env?.sorobanRpcUrl).toBe(productionEnv.SOROBAN_RPC_URL);
  });

  it("still surfaces malformed values in development", () => {
    const result = validateEnv({
      NODE_ENV: "development",
      PORT: "abc",
      SOROBAN_RPC_URL: "nope",
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(2);
  });
});
