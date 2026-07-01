import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './config/swagger.js';
import { apiVersionMiddleware, type VersionedRequest } from './middleware/api-version.middleware.js';
import { sandboxMiddleware } from './middleware/sandbox.middleware.js';
import { globalRateLimiter } from './middleware/rate-limiter.middleware.js';
import { requestIdMiddleware } from './middleware/requestId.js';
import v1Routes from './routes/v1/index.js';

import healthRoutes from './routes/health.routes.js';

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
const rawCors = process.env.CORS_ALLOWED_ORIGINS ?? '';
const allowedOrigins = rawCors
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

// Default in development to only localhost:3000 (frontend dev server)
if (!process.env.CORS_ALLOWED_ORIGINS && !isProduction) {
    allowedOrigins.push('http://localhost:3000');
}

// Apply global rate limiter first
app.use(globalRateLimiter);

// Request ID tracing
app.use(requestIdMiddleware);

app.disable('x-powered-by');

// Helmet-equivalent core headers without external dependency.
// Strict CSP applied globally; the /api-docs route overrides it below for Swagger UI.
app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('X-Download-Options', 'noopen');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; object-src 'none'");
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (process.env.NODE_ENV === 'production') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
});

app.use(cors({
    origin(origin, callback) {
        // Allow non-browser clients (no Origin header)
        if (!origin) {
            callback(null, true);
            return;
        }

        if (allowedOrigins.includes(origin)) {
            callback(null, true);
            return;
        }

        // Not allowed
        callback(new Error('CORS origin not allowed'));
    },
    credentials: true,
}));

// Convert CORS errors into 403 responses so callers get a clear status code
app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (err instanceof Error && err.message === 'CORS origin not allowed') {
        res.status(403).json({ error: 'CORS origin not allowed' });
        return;
    }
    next(err);
});
app.use(express.json());

// Sandbox mode detection (before versioning)
app.use(sandboxMiddleware);

// Swagger UI setup
// Override CSP for /api-docs only: Swagger UI requires inline scripts/styles.
app.use('/api-docs', (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; object-src 'none'");
    next();
}, swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'FlowFi API Documentation',
}));

// Serve raw OpenAPI spec as JSON
app.get('/api-docs.json', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json');
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
app.use('/health', healthRoutes);

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
app.get('/', (req: Request, res: Response) => {
    res.send('FlowFi Backend is running');
});

import { errorHandler } from './middleware/error.middleware.js';

app.use(errorHandler);

export default app;
