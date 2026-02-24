import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './config/swagger.js';
import { apiVersionMiddleware, type VersionedRequest } from './middleware/api-version.middleware.js';
import { sandboxMiddleware } from './middleware/sandbox.middleware.js';
import { globalRateLimiter } from './middleware/rate-limiter.middleware.js';
import v1Routes from './routes/v1/index.js';

const app = express();

// Apply global rate limiter first
app.use(globalRateLimiter);

app.use(cors());
app.use(express.json());

// Sandbox mode detection (before versioning)
app.use(sandboxMiddleware);

// Swagger UI setup
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
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
    next(); // Not versioned, continue to deprecated handlers
});

// Legacy routes (deprecated - redirect to v1)
// These will be removed in a future version
// Only match unversioned requests
app.use('/streams', (req: Request, res: Response, next) => {
    res.status(410).json({
        error: 'Deprecated endpoint',
        message: 'This endpoint has been deprecated. Please use /v1/streams instead.',
        deprecated: true,
        migration: {
            old: '/streams',
            new: '/v1/streams',
        },
        sunsetDate: '2024-12-31',
    });
});

app.use('/events', (req: Request, res: Response, next) => {
    res.status(410).json({
        error: 'Deprecated endpoint',
        message: 'This endpoint has been deprecated. Please use /v1/events instead.',
        deprecated: true,
        migration: {
            old: '/events',
            new: '/v1/events',
        },
        sunsetDate: '2024-12-31',
    });
});

/**
 * @openapi
 * /:
 *   get:
 *     tags:
 *       - Health
 *     summary: Health check endpoint
 *     description: Returns a simple message to verify the API is running
 *     responses:
 *       200:
 *         description: API is running successfully
 *         content:
 *           text/plain:
 *             schema:
 *               type: string
 *               example: FlowFi Backend is running
 */
app.get('/', (req: Request, res: Response) => {
    res.send('FlowFi Backend is running');
});

/**
 * @openapi
 * /health:
 *   get:
 *     tags:
 *       - Health
 *     summary: Detailed health check
 *     description: Returns detailed health information about the API
 *     responses:
 *       200:
 *         description: Health check details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: healthy
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   example: 2024-02-21T14:30:00.000Z
 *                 uptime:
 *                   type: number
 *                   description: Server uptime in seconds
 *                   example: 3600
 *                 version:
 *                   type: string
 *                   example: 1.0.0
 *                 apiVersions:
 *                   type: object
 *                   properties:
 *                     supported:
 *                       type: array
 *                       items:
 *                         type: string
 *                       example: ["v1"]
 *                     default:
 *                       type: string
 *                       example: "v1"
 */
app.get('/health', async (req: Request, res: Response) => {
    const { getSandboxConfig } = await import('./config/sandbox.js');
    const sandboxConfig = getSandboxConfig();
    
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        version: '1.0.0',
        apiVersions: {
            supported: ['v1'],
            default: 'v1',
        },
        sandbox: {
            enabled: sandboxConfig.enabled,
            available: sandboxConfig.enabled,
        },
    });
});

export default app;
