import dotenv from 'dotenv';
import app from './app.js';
import logger from './logger.js';
import { startWorkers, stopWorkers } from './workers/index.js';

dotenv.config();

const startServer = async () => {
    try {
        // Validate database connectivity
        const { prisma } = await import('./lib/prisma.js');
        await prisma.$connect();
        await prisma.$queryRaw`SELECT 1`;
        logger.info('Database connection established successfully');

        const port = process.env.PORT || 3001;
        const server = app.listen(port, () => {
            logger.info(`Server started on port ${port}`);
            logger.info(`API Documentation available at http://localhost:${port}/api-docs`);
        });

        // Start background workers after the HTTP server is up.
        await startWorkers();

        // Graceful shutdown: stop workers before closing the HTTP server.
        const shutdown = (signal: string) => {
            logger.info(`Received ${signal}. Shutting down gracefully...`);
            stopWorkers();
            server.close(() => {
                logger.info('HTTP server closed.');
                process.exit(0);
            });
        };

        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
    } catch (error) {
        logger.error('Failed to start server due to database connection error:', error);
        process.exit(1);
    }
};

startServer();
