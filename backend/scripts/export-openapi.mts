/**
 * Export the OpenAPI spec to a committed JSON file so it can be consumed
 * without booting the API server (e.g. by `openapi-typescript` codegen and the
 * CI drift check).
 *
 *   npm run codegen:openapi
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { swaggerSpec } from '../src/config/swagger.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'swagger');
const outFile = join(outDir, 'flowfi.openapi.json');

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, `${JSON.stringify(swaggerSpec, null, 2)}\n`);
console.log(`OpenAPI spec written to ${outFile}`);