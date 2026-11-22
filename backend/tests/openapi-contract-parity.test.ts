/**
 * OpenAPI route and response-contract parity (issue #1767).
 *
 * `src/config/swagger.ts` builds the published contract from `@openapi` JSDoc,
 * and the only thing CI checked about it was that the generated JSON matched
 * whatever the annotations happened to say. Nothing compared the document with
 * the routes the server actually registers, and nothing asserted that a
 * documented failure path still looks like the documented failure shape. So a
 * route could be renamed, dropped, or added with no effect on the docs, and a
 * handler could change its error envelope in the same commit that "documented"
 * it.
 *
 * Three layers, all deterministic and offline:
 *  1. the route table parsed out of the router source vs `swaggerSpec.paths`;
 *  2. the internal contract of the document (refs, path parameters, tags,
 *     security schemes, and the schema every documented failure shares);
 *  3. live requests through the real app for the paths that need no database,
 *     asserting the emitted envelope satisfies the documented `Error` schema.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import request from 'supertest';

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    $queryRaw: vi.fn(),
    indexerState: { findUnique: vi.fn() },
  },
}));

vi.mock('../src/lib/prisma.js', () => ({ prisma: prismaMock, default: prismaMock }));

vi.mock('../src/workers/soroban-event-worker.js', () => ({
  sorobanEventWorker: {
    getEventCounters: vi.fn(() => ({
      eventsProcessed: 0,
      eventsFailed: 0,
      lastErrorAt: null,
      degraded: false,
    })),
  },
  SorobanEventWorker: vi.fn(),
}));

// /health probes Redis and Soroban RPC; keep the parity checks off the network.
vi.mock('../src/lib/redis.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/redis.js')>()),
  getPublisher: vi.fn(() => null),
}));

vi.mock('../src/services/sorobanService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/sorobanService.js')>()),
  checkRpcHealth: vi.fn(async () => true),
  getLatestLedger: vi.fn(async () => 0),
}));

import { swaggerSpec } from '../src/config/swagger.js';
import app from '../src/app.js';

/**
 * The document is read as plain data here on purpose: these tests assert the
 * shape the *consumers* of `/api-docs.json` see, not the TypeScript model of the
 * generator that produced it.
 */
type Document_ = Record<string, any>;
const document: Document_ = swaggerSpec as unknown as Document_;

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

const BACKEND_ROOT = path.resolve(__dirname, '..');

/**
 * The version dispatcher in `src/app.ts` is a plain middleware that calls the v1
 * router after `apiVersionMiddleware` has stripped the prefix, so the `/v1`
 * mount is not expressible as a `router.use('/v1', …)` source pattern.
 */
const VERSIONED_ENTRYPOINT = 'src/routes/v1/index.ts';
const VERSIONED_PREFIX = '/v1';

/**
 * Server routes that are deliberately not part of the REST contract, so they
 * have no `@openapi` annotation and never will.
 */
const OUTSIDE_REST_CONTRACT: string[] = [
  // The contract is served from the document, it is not described by it.
  'GET /api-docs.json',
  // The GraphQL surface is documented in `docs/api/README.md`.
  'GET /graphql',
  'POST /graphql',
];

/**
 * REST routes the server registers with no `@openapi` annotation.
 *
 * This backlog may only shrink: documenting a route means deleting its line, and
 * shipping a new undocumented route makes the sets differ and fails the suite.
 */
const UNDOCUMENTED_API_ROUTES: string[] = [
  'GET /v1/streams/{streamId}/snapshot',
  'GET /v1/tokens/{address}',
  'GET /v1/webhooks/{id}/deliveries',
  'PATCH /v1/webhooks/{id}',
  'POST /v1/webhooks/{id}/secret',
];

const UNDOCUMENTED_ROUTES = [...OUTSIDE_REST_CONTRACT, ...UNDOCUMENTED_API_ROUTES];

type Operation = { path: string; method: HttpMethod; spec: Record<string, any> };

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Identifiers in this file that hold an Express router. */
function routerIdentifiers(source: string): Set<string> {
  const found = new Set<string>();
  const pattern = /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:express\.)?Router\(\s*\)/g;
  for (const match of source.matchAll(pattern)) found.add(match[1]!);
  return found;
}

function importedModules(source: string): Map<string, string> {
  const found = new Map<string, string>();
  const pattern = /import\s+(?:\{([^}]*)\}|(\w+))\s+from\s+['"](\.[^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[3]!;
    if (match[2]) found.set(match[2], specifier);
    for (const named of (match[1] ?? '').split(',')) {
      const identifier = named.trim().split(/\s+as\s+/).pop()!.trim();
      if (identifier) found.set(identifier, specifier);
    }
  }
  return found;
}

function resolveModule(fromFile: string, specifier: string): string {
  const base = path.resolve(path.dirname(fromFile), specifier).replace(/\.js$/, '');
  for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot resolve "${specifier}" from ${fromFile}`);
}

/** Express `:name` templates become OpenAPI `{name}`, with the mount prefix joined. */
function toOpenApiPath(mount: string, routePath: string): string {
  const joined = `${mount}${routePath === '/' ? '' : routePath}` || '/';
  const normalized = joined
    .replace(/\/{2,}/g, '/')
    .replace(/:([A-Za-z0-9_]+)/g, '{$1}')
    .replace(/\/$/, '');
  return normalized === '' ? '/' : normalized;
}

/** Every `router.<method>('/x')` reachable from `entry` through its mounts. */
function collectRegisteredRoutes(entry: string, prefix: string): string[] {
  const routes: string[] = [];
  const visited = new Set<string>();

  function visit(file: string, mount: string): void {
    if (visited.has(file)) return;
    visited.add(file);
    const source = stripComments(fs.readFileSync(file, 'utf8'));
    const routers = routerIdentifiers(source);
    // `src/app.ts` registers its own routes on the Express instance itself.
    if (path.basename(file) === 'app.ts') routers.add('app');
    const imports = importedModules(source);

    const declarations = /\b(\w+)\.(get|post|put|patch|delete|all)\(\s*['"`]([^'"`]*)['"`]/g;
    for (const match of source.matchAll(declarations)) {
      if (!routers.has(match[1]!)) continue;
      const verbs = match[2] === 'all' ? HTTP_METHODS : [match[2] as HttpMethod];
      for (const verb of verbs) {
        routes.push(`${verb.toUpperCase()} ${toOpenApiPath(mount, match[3]!)}`);
      }
    }

    const mounts = /\b(\w+)\.use\(\s*['"`]([^'"`]*)['"`]\s*,\s*([\s\S]*?)\)\s*;/g;
    for (const match of source.matchAll(mounts)) {
      for (const argument of match[3]!.split(',').map((part) => part.trim())) {
        if (!/^\w+$/.test(argument)) continue;
        const specifier = imports.get(argument);
        if (!specifier) continue;
        const child = resolveModule(file, specifier);
        if (routerIdentifiers(stripComments(fs.readFileSync(child, 'utf8'))).size === 0) continue;
        visit(child, mount + (match[2] === '/' ? '' : match[2]));
      }
    }
  }

  visit(entry, prefix);
  return routes;
}

function registeredRoutes(): Set<string> {
  return new Set([
    ...collectRegisteredRoutes(path.join(BACKEND_ROOT, 'src/app.ts'), ''),
    ...collectRegisteredRoutes(path.join(BACKEND_ROOT, VERSIONED_ENTRYPOINT), VERSIONED_PREFIX),
  ]);
}

function operations(): Operation[] {
  const found: Operation[] = [];
  for (const [route, item] of Object.entries(document.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = (item as Record<string, any>)[method];
      if (operation) found.push({ path: route, method, spec: operation });
    }
  }
  return found;
}

function labelled(operation: Operation): string {
  return `${operation.method.toUpperCase()} ${operation.path}`;
}

/** Resolves a `#/…` pointer against the document itself. */
function dereference(ref: string): unknown {
  let cursor: unknown = document;
  for (const segment of ref.replace(/^#\//, '').split('/')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function collectRefs(node: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const entry of node) collectRefs(entry, found);
    return found;
  }
  if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === '$ref' && typeof value === 'string') found.add(value);
      else collectRefs(value, found);
    }
  }
  return found;
}

function statusCodesOf(operation: Operation): string[] {
  return Object.keys(operation.spec.responses ?? {});
}

function isSuccess(code: string): boolean {
  return code.startsWith('2');
}

function isFailure(code: string): boolean {
  return /^[45]/.test(code);
}

/** The declared schema for a failure status, when the document gives it one. */
function failureSchema(operation: Operation, code: string): Record<string, unknown> | undefined {
  const content = operation.spec.responses[code]?.content as Record<string, any> | undefined;
  if (!content) return undefined;
  return Object.values(content)[0]?.schema;
}

/** Asserts the live body carries the fields the shared `Error` schema requires. */
function expectDocumentedErrorEnvelope(body: unknown): void {
  expect(body).toBeTypeOf('object');
  expect(body).toHaveProperty('error');
  const error = (body as { error?: Record<string, unknown> }).error;
  expect(error?.code).toBeTypeOf('string');
  expect((error?.code as string).length).toBeGreaterThan(0);
  expect(error?.message).toBeTypeOf('string');
  expect((error?.message as string).length).toBeGreaterThan(0);
}

const ENV_KEYS = ['API_BASE_URL'] as const;

/** `swaggerSpec` is computed at import time, so env cases reload the module. */
async function loadDocumentWithEnv(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
  vi.resetModules();
  const fresh = (await import('../src/config/swagger.js')).swaggerSpec as unknown as Document_;
  return fresh;
}

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('documented routes against registered routes', () => {
  const live = registeredRoutes();
  const documented = operations().map(labelled);

  it('parses the whole router graph, including the versioned surface', () => {
    // Guards the parser itself: a scanner that silently stopped recursing would
    // turn the two parity checks below into a vacuous pass.
    expect(live.has('POST /v1/streams/{streamId}/withdraw')).toBe(true);
    expect(live.has('GET /health')).toBe(true);
    expect(live.has('GET /')).toBe(true);
    expect(live.size).toBeGreaterThan(documented.length);
  });

  it('documents no route the server does not register', () => {
    // A stale entry means the contract advertises an endpoint that no longer
    // exists, so every client generated from it breaks with a 404.
    const stale = documented.filter((entry) => !live.has(entry)).sort();
    expect(stale).toEqual([]);
  });

  it('registers no route beyond the documented set and the pinned backlog', () => {
    const known = new Set([...documented, ...UNDOCUMENTED_ROUTES]);
    const undocumented = [...live].filter((entry) => !known.has(entry)).sort();
    expect(undocumented).toEqual([]);
  });

  it('pins the backlog at exactly the routes still awaiting documentation', () => {
    // The list is only honest if it has no entries that are in fact documented:
    // otherwise a route could be "pinned" forever and the check above would
    // never notice a regression.
    for (const entry of UNDOCUMENTED_ROUTES) {
      expect(live.has(entry), `${entry} is not registered`).toBe(true);
      expect(documented, `${entry} is already documented`).not.toContain(entry);
    }
  });
});

describe('internal contract of the generated document', () => {
  const ops = operations();

  it('describes the version and server list the docs render from', () => {
    expect(document.openapi).toBe('3.1.0');
    expect(document.info.title).toBe('FlowFi API');
    expect(document.servers).toEqual([
      { url: 'http://localhost:3001/v1', description: 'Development server (v1)' },
      { url: 'https://api.flowfi.io/v1', description: 'Production server (v1)' },
    ]);
  });

  it('resolves every local $ref', () => {
    const refs = [...collectRefs(document)].filter((ref) => ref.startsWith('#/'));
    const unresolved = refs.filter((ref) => dereference(ref) === undefined).sort();
    expect(unresolved).toEqual([]);
    // The shared error schema is referenced by name from many operations, so an
    // unresolvable pointer would silently strip error typing from the client.
    expect(refs).toContain('#/components/schemas/Error');
  });

  it('gives every operation a summary, a success status and a failure status', () => {
    const problems: string[] = [];
    for (const operation of ops) {
      if (!operation.spec.summary) problems.push(`${labelled(operation)}: no summary`);
      const codes = statusCodesOf(operation);
      if (!codes.some(isSuccess)) problems.push(`${labelled(operation)}: no 2xx response`);
      if (!codes.some(isFailure)) problems.push(`${labelled(operation)}: no failure response`);
      for (const [code, response] of Object.entries<Record<string, any>>(operation.spec.responses)) {
        if (!response?.description) problems.push(`${labelled(operation)}: ${code} has no description`);
      }
    }
    // An operation that advertises no failure status cannot tell a client what
    // to handle. This is a backlog, so the expected value is asserted exactly:
    // it may shrink, and any new entry fails the suite.
    expect(problems.sort()).toEqual(
      [
        'GET /: no failure response',
        'GET /v1/tokens: no failure response',
        'POST /v1/admin/indexer/dead-letter/replay-all: no failure response',
      ].sort(),
    );
  });

  it('declares each path parameter exactly once, and as required', () => {
    const problems: string[] = [];
    for (const operation of ops) {
      const template = [...operation.path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!);
      const parameters = (operation.spec.parameters ?? []) as Record<string, any>[];
      const pathParameters = parameters.filter((p) => p.in === 'path').map((p) => p.name as string);
      for (const name of template) {
        if (!pathParameters.includes(name)) problems.push(`${labelled(operation)}: {${name}} undocumented`);
        if (template.filter((c) => c === name).length !== 1) {
          problems.push(`${labelled(operation)}: {${name}} repeated in the template`);
        }
      }
      for (const name of pathParameters) {
        if (!template.includes(name)) problems.push(`${labelled(operation)}: ${name} is not in the template`);
      }
      for (const parameter of parameters) {
        if (parameter.in === 'path' && parameter.required !== true) {
          problems.push(`${labelled(operation)}: path parameter ${parameter.name} is optional`);
        }
        if (!parameter.name) problems.push(`${labelled(operation)}: parameter without a name`);
        if (parameter.in === 'query' && !parameter.schema && !parameter.content) {
          problems.push(`${labelled(operation)}: query parameter ${parameter.name} has no schema`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('tags every operation with a tag the document declares', () => {
    const declared = new Set<string>((document.tags ?? []).map((tag: Record<string, unknown>) => tag.name as string));
    const problems: string[] = [];
    for (const operation of ops) {
      const tags = operation.spec.tags as string[] | undefined;
      if (!tags || tags.length === 0) {
        problems.push(`${labelled(operation)}: no tag`);
        continue;
      }
      for (const tag of tags) {
        if (!declared.has(tag)) problems.push(`${labelled(operation)}: undeclared tag ${tag}`);
      }
    }
    // Swagger UI parks undeclared tags in an ungrouped bucket and generated
    // clients lose the section, so the tag list is part of the contract.
    expect(problems.sort()).toEqual([]);
  });

  it('references only declared security schemes', () => {
    const schemes = new Set(Object.keys(document.components?.securitySchemes ?? {}));
    const unknown = new Set<string>();
    for (const operation of ops) {
      for (const requirement of (operation.spec.security ?? []) as Record<string, unknown>[]) {
        for (const name of Object.keys(requirement)) {
          if (!schemes.has(name)) unknown.add(`${labelled(operation)}: ${name}`);
        }
      }
    }
    expect([...unknown].sort()).toEqual([]);
  });

  it('keeps the case-sensitive bearer aliases distinct', () => {
    // `BearerAuth` and `bearerAuth` are two separate scheme ids; an annotation
    // that invents a third spelling authenticates against nothing at all.
    const schemes = document.components?.securitySchemes as Record<string, any>;
    expect(
      Object.keys(schemes)
        .filter((key) => key.toLowerCase() === 'bearerauth')
        .sort(),
    ).toEqual(['BearerAuth', 'bearerAuth']);
    for (const key of ['BearerAuth', 'bearerAuth', 'adminAuth']) {
      expect(schemes[key]).toMatchObject({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
    }
  });

  it('documents every versioned failure response with the shared Error schema', () => {
    const shared = { $ref: '#/components/schemas/Error' };
    const divergent: string[] = [];
    for (const operation of ops) {
      // `/health` answers 503 with the health payload by contract, so the shared
      // envelope is asserted over the versioned REST surface the SDK generates.
      if (!operation.path.startsWith('/v1/')) continue;
      for (const code of statusCodesOf(operation).filter(isFailure)) {
        const schema = failureSchema(operation, code);
        // Failures that declare no schema at all are the documentation backlog;
        // anything that DOES declare one has to declare the shared envelope.
        if (schema && JSON.stringify(schema) !== JSON.stringify(shared)) {
          divergent.push(`${labelled(operation)}: ${code} -> ${JSON.stringify(schema)}`);
        }
      }
    }
    expect(divergent).toEqual([]);
  });

  it('requires the two fields every error response is built from', () => {
    const error = document.components?.schemas?.Error as Record<string, any>;
    expect(error.required).toEqual(['error']);
    expect(error.properties.error.required).toEqual(['code', 'message']);
    // `details` is how validation failures reach a client: optional, but typed.
    expect(error.properties.error.properties.details.type).toBe('array');
    expect(error.properties.error.properties.details.items).toEqual({ type: 'object' });
    expect(error.properties.error.required).not.toContain('details');
  });
});

describe('servers follow API_BASE_URL', () => {
  it('lists the development and production servers when unset', async () => {
    const spec = await loadDocumentWithEnv({});
    expect(spec.servers).toHaveLength(2);
    expect(spec.servers[0].url).toBe('http://localhost:3001/v1');
    expect(spec.servers[1].url).toBe('https://api.flowfi.io/v1');
  });

  it('collapses to the configured base URL and keeps the version prefix', async () => {
    const spec = await loadDocumentWithEnv({ API_BASE_URL: 'https://api.example.test' });
    expect(spec.servers).toEqual([{ url: 'https://api.example.test/v1', description: 'API server' }]);
  });

  it('appends /v1 to a trailing slash without de-duplicating it', async () => {
    // Boundary input. `API_BASE_URL` is operator-supplied and the copy-paste form
    // of an origin usually carries the slash, so the published document
    // advertises `//v1`. Pinned so the quirk is visible rather than silent.
    const spec = await loadDocumentWithEnv({ API_BASE_URL: 'https://api.example.test/' });
    expect(spec.servers).toEqual([{ url: 'https://api.example.test//v1', description: 'API server' }]);
  });
});

describe('documented failure paths behave as documented', () => {
  it('answers an unauthenticated protected route with the documented 401 envelope', async () => {
    const response = await request(app).post('/v1/streams/1/pause');

    expect(response.status).toBe(401);
    expectDocumentedErrorEnvelope(response.body);
    expect(response.body.error.code).toBe('UNAUTHORIZED');

    const paths = document.paths as Record<string, any>;
    expect(paths['/v1/streams/{streamId}/pause'].post.responses['401'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/Error',
    });
  });

  it('answers a malformed body with the documented 400 envelope', async () => {
    const response = await request(app)
      .post('/v1/streams')
      .set('Content-Type', 'application/json')
      .send('{"recipient":');

    expect(response.status).toBe(400);
    expectDocumentedErrorEnvelope(response.body);

    const paths = document.paths as Record<string, any>;
    expect(Object.keys(paths['/v1/streams'].post.responses)).toContain('400');
    expect(paths['/v1/streams'].post.responses['400'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/Error',
    });
  });

  it('enforces the 100kb body ceiling on ordinary routes and 1mb on bulk routes', async () => {
    const body = JSON.stringify({ blob: 'x'.repeat(120 * 1024) });

    const rejected = await request(app)
      .post('/v1/streams')
      .set('Content-Type', 'application/json')
      .send(body);

    expect(rejected.status).toBe(413);
    expectDocumentedErrorEnvelope(rejected.body);
    expect(rejected.body.error.code).toBe('PAYLOAD_TOO_LARGE');

    // `/v1/streams/simulate` is mounted on the wide parser, so the same body
    // gets past parsing and reaches authentication. The registration order of
    // the two `express.json` calls is what makes this work: the wide parser has
    // to run first, or every bulk route would be capped at 100kb.
    const accepted = await request(app)
      .post('/v1/streams/simulate')
      .set('Content-Type', 'application/json')
      .send(body);

    // The wide parser took it, so the request reached the route's own
    // validation instead of the body limit.
    expect(accepted.status).toBe(400);
    expectDocumentedErrorEnvelope(accepted.body);
    const paths = document.paths as Record<string, any>;
    expect(Object.keys(paths['/v1/streams/simulate'].post.responses)).toContain('400');

    // 413 is reachable from every POST route but documented by none of them.
    const documented413 = operations().filter((operation) => statusCodesOf(operation).includes('413'));
    expect(documented413).toEqual([]);
  });

  it('answers an unknown versioned path outside the documented envelope', async () => {
    const response = await request(app).get('/v1/streams/1/nonexistent');

    expect(response.status).toBe(404);
    // Express' default handler answers unmatched paths with an HTML page naming
    // the path, so a client that parses `error.code` on every non-2xx throws.
    // No documented operation declares this shape.
    expect(response.body).toEqual({});
    expect(response.text).toContain('Cannot GET /v1/streams/1/nonexistent');
  });

  it('reports a degraded database as the documented 503 health shape', async () => {
    prismaMock.$queryRaw.mockRejectedValue(new Error('database is down'));
    prismaMock.indexerState.findUnique.mockResolvedValue(null);

    const response = await request(app).get('/health');

    expect(response.status).toBe(503);
    const paths = document.paths as Record<string, any>;
    expect(paths['/health'].get.responses['503'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/HealthResponse',
    });
    const healthSchema = document.components.schemas.HealthResponse as Record<string, any>;
    for (const field of healthSchema.required as string[]) {
      expect(response.body).toHaveProperty(field);
    }
    expect(response.body.db).toBe('disconnected');
    expect(response.body.checks.database.status).toBe('down');
  });
});
