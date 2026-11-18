import type { PrismaClient } from "../generated/prisma/index.js";
import { createDataLoaders, type DataLoaders } from "./dataloaders/index.js";

/**
 * Execution context shared by every GraphQL resolver. A fresh context (and a
 * fresh set of DataLoaders) is created per request so batching never leaks
 * across requests.
 */
export interface GraphQLContext {
  prisma: PrismaClient;
  loaders: DataLoaders;
}

export function createContext(prisma: PrismaClient): GraphQLContext {
  return {
    prisma,
    loaders: createDataLoaders(prisma),
  };
}
