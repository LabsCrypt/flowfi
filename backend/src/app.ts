import express, { type Request, type Response } from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './config/swagger.js';
import streamRoutes from './routes/stream.routes.js';
import eventsRoutes from './routes/events.routes.js';
import { globalRateLimiter } from './middleware/rate-limiter.middleware.js';

const app = express();

// Apply global rate limiter first
app.use(globalRateLimiter);

app.use(cors());
app.use(express.json());

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

// Routes
app.use('/streams', streamRoutes);
app.use('/events', eventsRoutes);

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
 */
app.get('/health', (req: Request, res: Response) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        version: '1.0.0',
    });
});

export default app;
