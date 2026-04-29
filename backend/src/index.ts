import dotenv from "dotenv";
import app from "./app.js";
import logger from "./logger.js";
import { sorobanIndexerService } from "./services/soroban-indexer.service.js";
import { startWorkers, stopWorkers } from "./workers/index.js";
import { sseService } from "./services/sse.service.js";
import { connectRedis, disconnectRedis } from "./lib/redis.js";

dotenv.config();

const SHUTDOWN_TIMEOUT_MS = 30_000;

const startServer = async () => {
  try {
    const { prisma } = await import("./lib/prisma.js");
    await prisma.$connect();
    await prisma.$queryRaw`SELECT 1`;
    logger.info("Database connection established successfully");

    // Connect Redis (graceful fallback to single-instance mode when absent)
    await connectRedis();
    await sseService.initRedisSubscription();
    
    // Start SSE heartbeat for connection management
    sseService.startHeartbeat();

    const port = process.env.PORT || 3001;
    const server = app.listen(port, () => {
      logger.info(`Server started on port ${port}`);
      logger.info(
        `API Documentation available at http://localhost:${port}/api-docs`,
      );
    });

    sorobanIndexerService.start();
    await startWorkers();

    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}. Shutting down gracefully...`);

      // 1. Notify all active SSE clients to reconnect (sets shuttingDown flag)
      sseService.sendReconnectToAll();

      // 2. Stop accepting new HTTP connections
      server.close();

      // 3. Stop indexers (clears poll timers)
      try {
        sorobanIndexerService.stop?.();
      } catch (err) {
        logger.warn("Error while stopping soroban indexer:", err);
      }
      stopWorkers();

      // 4. Wait for in-flight indexer batch to finish (max 30s)
      let exitCode = 0;
      try {
        const { sorobanEventWorker } = await import(
          "./workers/soroban-event-worker.js"
        );
        await Promise.race([
          sorobanEventWorker.waitForDrain(),
          new Promise<void>((_, reject) =>
            setTimeout(
              () => reject(new Error("Indexer drain timeout")),
              SHUTDOWN_TIMEOUT_MS,
            ),
          ),
        ]);
        logger.info("Indexer drained successfully.");
      } catch (err) {
        logger.warn("Indexer drain timed out:", err);
        exitCode = 1;
      }

      // 5. Disconnect Redis
      await disconnectRedis();

      // 6. Close Prisma DB connection
      const { prisma: db } = await import("./lib/prisma.js");
      await db.$disconnect();
      logger.info("Database connection closed.");

      process.exit(exitCode);
    };

    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
  } catch (error) {
    logger.error(
      "Failed to start server due to database connection error:",
      error,
    );
    process.exit(1);
  }
};

startServer();
