import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import cors from "cors";
import swaggerUi from "swagger-ui-express";
import { swaggerSpec } from "./config/swagger.js";
import {
  apiVersionMiddleware,
  type VersionedRequest,
} from "./middleware/api-version.middleware.js";
import { sandboxMiddleware } from "./middleware/sandbox.middleware.js";
import { globalRateLimiter, healthRateLimiter } from "./middleware/rate-limiter.middleware.js";
import { metricsMiddleware } from "./middleware/metrics.middleware.js";
import { requestIdMiddleware } from "./middleware/requestId.js";
import { buildCorsOptions, CorsError } from "./config/cors.js";
import logger from "./logger.js";
import { bigIntSafeJsonMiddleware } from "./lib/serialize.js";
import v1Routes from "./routes/v1/index.js";
import healthRoutes from "./routes/health.routes.js";
import metricsRoutes from "./routes/metrics.routes.js";

const app = express();

// Resolved once at startup; throws in production when FRONTEND_URL is missing
// or invalid, so the server never runs with an open CORS policy.
const corsOptions = buildCorsOptions();

// Apply global rate limiter first
app.use(globalRateLimiter);

// Request ID tracing
app.use(requestIdMiddleware);

// Request counting/latency for the Prometheus registry
app.use(metricsMiddleware);

app.disable("x-powered-by");

// Helmet-equivalent core headers without external dependency.
// Strict CSP applied globally; the /api-docs route overrides it below for Swagger UI.
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  res.setHeader("X-Download-Options", "noopen");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; object-src 'none'",
  );
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (process.env.NODE_ENV === "production") {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }
  next();
});

// CORS runs before the body parser, auth and routes, so preflight OPTIONS
// requests are answered here and never reach route-level auth.
app.use(cors(corsOptions));

// Convert CORS errors into 403 responses so callers get a clear status code
app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (err instanceof CorsError) {
    logger.warn("CORS origin rejected", {
      origin: err.origin.slice(0, 256),
      method: req.method,
      path: req.path,
    });
    res.status(err.statusCode).json({ error: err.message });
    return;
  }
  next(err);
});
// JSON body parsing.
//
// Standard REST endpoints get a tight 100kb ceiling so a multi-megabyte body
// cannot pin memory or stall the event loop. The bulk routes that legitimately
// carry many records (batch stream creation, CSV payroll import, and the
// batch-withdraw simulation payload) get 1mb instead.
//
// The larger parser MUST be registered first: Express runs middleware in
// registration order, so a request that reaches the 100kb parser first can
// never be rescued by the larger one further down the chain.
const BULK_JSON_PATHS = [
  "/v1/streams/batch",
  "/v1/streams/import",
  "/v1/payroll/import",
  // `/v1/streams/simulate` accepts `batch_withdraw`, whose `streamIds` array can
  // be large for payroll recipients.
  "/v1/streams/simulate",
];
app.use(BULK_JSON_PATHS, express.json({ limit: "1mb" }));
app.use(express.json({ limit: "100kb" }));

// BigInt-safe JSON responses (Issue #1493): Prisma bigint columns must be
// emitted as decimal strings, never throw in res.json().
app.use(bigIntSafeJsonMiddleware);

// Sandbox mode detection (before versioning)
app.use(sandboxMiddleware);

// Swagger UI setup
// Override CSP for /api-docs only: Swagger UI requires inline scripts/styles.
app.use(
  "/api-docs",
  (req: Request, res: Response, next: NextFunction) => {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; object-src 'none'",
    );
    next();
  },
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpec, {
    customCss: ".swagger-ui .topbar { display: none }",
    customSiteTitle: "FlowFi API Documentation",
  }),
);

// Serve raw OpenAPI spec as JSON
app.get("/api-docs.json", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "application/json");
  res.send(swaggerSpec);
});

// API Versioning
// All versioned routes must include version prefix (e.g., /v1/streams)
app.use(apiVersionMiddleware);

// Versioned API routes
// After versioning middleware, /v1/streams becomes /streams, so we mount v1Routes at root
// But only handle requests that had a version prefix (apiVersion is set)
app.use((req: Request, res: Response, next: NextFunction) => {
  const versionedReq = req as VersionedRequest;
  if (versionedReq.apiVersion) {
    // This was a versioned request, route to v1 handlers
    return v1Routes(req, res, next);
  }
  return next(); // Not versioned, continue to deprecated handlers
});

// Health check routes
app.use("/health", healthRateLimiter, healthRoutes);

// Prometheus scrape endpoint. Mounted after the metrics middleware so scrapes
// are themselves counted, and outside the versioned API surface because
// Prometheus cannot send a version prefix or an Authorization header by
// default. Access control lives in the router (see metrics.routes.ts).
app.use("/metrics", metricsRoutes);

/**
 * @openapi
 * /:
 *   get:
 *     tags:
 *       - Health
 *     summary: Simple health check
 *     description: Returns a simple message to verify the API is running
 *     responses:
 *       200:
 *         description: API is running successfully
 */
app.get("/", (req: Request, res: Response) => {
  res.send("FlowFi Backend is running");
});

import { errorHandler } from "./middleware/error.middleware.js";

app.use(errorHandler);

export default app;
