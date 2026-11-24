/**
 * Fail-fast environment variable validation (issue #1646).
 *
 * Historically a missing `DATABASE_URL`, `PORT`, `NODE_ENV`, or
 * `SOROBAN_RPC_URL` surfaced later as an opaque stack trace from whichever
 * route or worker first touched the undefined value. This module validates
 * the four startup-critical variables up front, prints a clear table of
 * missing/invalid entries, and — in production — refuses to boot.
 *
 * Development and test environments receive sensible defaults so a fresh
 * clone runs without ceremony:
 *   - PORT → 3001
 *   - NODE_ENV → "development"
 *   - DATABASE_URL → local docker-compose Postgres (see .env.example)
 *   - SOROBAN_RPC_URL → Stellar public testnet RPC
 *
 * The pure `validateEnv` function is unit-tested; `loadEnv` is the startup
 * side-effecting wrapper used by `src/index.ts`.
 */

import { z } from "zod";
import logger from "../logger.js";

export const DEV_DATABASE_URL =
  "postgresql://user:password@localhost:5433/flowfi?schema=public";
export const DEV_SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";

const nodeEnvSchema = z.enum(["development", "test", "production"]);
const portSchema = z.coerce.number().int().min(1).max(65535);
const httpUrlSchema = z.string().url();

export interface ValidatedEnv {
  nodeEnv: z.infer<typeof nodeEnvSchema>;
  port: number;
  databaseUrl: string;
  sorobanRpcUrl: string;
}

export interface EnvValidationResult {
  ok: boolean;
  /** Populated only when `ok` is true. */
  env: ValidatedEnv | null;
  /** Human-readable "NAME: reason" lines, one per problem. */
  errors: string[];
}

/**
 * Validate the startup-critical environment variables.
 *
 * In production every variable is required. In development and test the
 * defaults above are substituted, so `errors` stays empty on a fresh clone.
 * Pass `mode` to force strictness (e.g. in tests).
 */
export function validateEnv(
  source: NodeJS.ProcessEnv = process.env,
  mode?: z.infer<typeof nodeEnvSchema>,
): EnvValidationResult {
  const errors: string[] = [];
  // Mode comes from the source being validated (source defaults to
  // process.env), so callers can test production strictness by passing
  // { NODE_ENV: "production" } without mutating the real environment.
  const effectiveMode = mode ?? source.NODE_ENV ?? "development";
  const parsedMode = nodeEnvSchema.safeParse(effectiveMode);
  if (!parsedMode.success) {
    return {
      ok: false,
      env: null,
      errors: [
        `NODE_ENV: expected one of development | test | production, got "${String(effectiveMode)}"`,
      ],
    };
  }
  const nodeEnv = parsedMode.data;
  const strict = nodeEnv === "production";

  const rawPort = source.PORT?.trim();
  let port = 3001;
  if (rawPort) {
    const parsedPort = portSchema.safeParse(rawPort);
    if (!parsedPort.success) {
      errors.push(`PORT: expected an integer between 1 and 65535, got "${String(source.PORT)}"`);
    } else {
      port = parsedPort.data;
    }
  }

  const rawDatabaseUrl = source.DATABASE_URL?.trim();
  if (!rawDatabaseUrl) {
    if (strict) {
      errors.push("DATABASE_URL: required in production but not set");
    }
  } else if (rawDatabaseUrl.startsWith("postgres://") === false && rawDatabaseUrl.startsWith("postgresql://") === false) {
    errors.push(`DATABASE_URL: expected a postgres:// or postgresql:// URL, got "${rawDatabaseUrl.slice(0, 32)}"`);
  }

  const rawRpcUrl = source.SOROBAN_RPC_URL?.trim();
  if (!rawRpcUrl) {
    if (strict) {
      errors.push("SOROBAN_RPC_URL: required in production but not set");
    }
  } else if (!httpUrlSchema.safeParse(rawRpcUrl).success) {
    errors.push(`SOROBAN_RPC_URL: expected a valid URL, got "${rawRpcUrl}"`);
  }

  if (errors.length > 0) {
    return { ok: false, env: null, errors };
  }

  return {
    ok: true,
    errors: [],
    env: {
      nodeEnv,
      port,
      databaseUrl: rawDatabaseUrl || DEV_DATABASE_URL,
      sorobanRpcUrl: rawRpcUrl || DEV_SOROBAN_RPC_URL,
    },
  };
}

/**
 * Validate `process.env`, apply development/test defaults, and on failure
 * log the problem table and exit with code 1 (always fatal here; callers in
 * production and local dev both benefit from the same clear diagnostic).
 *
 * Returns the validated values so `src/index.ts` can use them directly.
 */
export function loadEnv(): ValidatedEnv {
  const result = validateEnv(process.env);
  if (!result.ok || !result.env) {
    logger.error("Environment validation failed. Fix the following and restart:");
    for (const line of result.errors) {
      logger.error(`  - ${line}`);
    }
    process.exit(1);
  }

  // Normalise so downstream modules reading process.env directly see the
  // same validated values.
  process.env.NODE_ENV = result.env.nodeEnv;
  process.env.PORT = String(result.env.port);
  process.env.DATABASE_URL = result.env.databaseUrl;
  process.env.SOROBAN_RPC_URL = result.env.sorobanRpcUrl;

  return result.env;
}
