import dotenv from 'dotenv';
import app from './app.js';
import logger from './logger.js';

dotenv.config();

const startServer = async () => {
    try {
        // Validate database connectivity
        const { prisma } = await import('./lib/prisma.js');
        await prisma.$connect();
        await prisma.$queryRaw`SELECT 1`;
        logger.info('Database connection established successfully');

        const port = process.env.PORT || 3001;
        app.listen(port, () => {
            logger.info(`Server started on port ${port}`);
            logger.info(`API Documentation available at http://localhost:${port}/api-docs`);
        });
    } catch (error) {
        logger.error('Failed to start server due to database connection error:', error);
        process.exit(1);
    }
};

startServer();
