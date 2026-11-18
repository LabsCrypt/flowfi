import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    complianceAuditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
    kycAttestation: { create: vi.fn() },
  },
}));

vi.mock('../src/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { user: { publicKey: string } }).user = {
      publicKey: 'GAUTHENTICATEDORGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    };
    next();
  },
}));

import { getComplianceConfig } from '../src/config/compliance.config.js';
import type { ComplianceConfig } from '../src/config/compliance.config.js';
import {
  ComplianceService,
  ComplianceScreeningError,
  type ScreeningResult,
  type ComplianceAuditEvent,
} from '../src/services/compliance.service.js';
import {
  complianceScreening,
  extractComplianceAddresses,
  type ComplianceScreeningService,
} from '../src/middleware/compliance.middleware.js';
import complianceRoutes from '../src/routes/v1/compliance.routes.js';
import { prisma } from '../src/lib/prisma.js';

const USER = 'GAUTHENTICATEDORGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CLEAN = 'GCLEANADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const SANCTIONED = 'GOFACSANCTIONEDADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ALLOWLISTED = 'GALLOWLISTEDADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const MW_SANCTIONED = 'GMWSANCTIONEDADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function config(overrides: Partial<ComplianceConfig> = {}): ComplianceConfig {
  return {
    enforcementEnabled: true,
    riskThreshold: 70,
    failureMode: 'fail-closed',
    cacheTtlSeconds: 3600,
    provider: 'local',
    externalApiTimeoutMs: 1000,
    allowlist: [],
    denylist: [],
    ...overrides,
  };
}

function fakeService(
  overrides: Partial<ComplianceScreeningService> = {},
): ComplianceScreeningService {
  return {
    screenAddresses: vi.fn(async (addresses: string[]) =>
      addresses.map<ScreeningResult>((address) => ({
        address,
        isSanctioned: false,
        riskScore: 0,
        tags: [],
        screenedAt: new Date(),
        cached: false,
      })),
    ),
    isBlocked: (result, cfg) => result.isSanctioned || result.riskScore > cfg.riskThreshold,
    writeAuditLog: vi.fn(async (_event: ComplianceAuditEvent) => undefined),
    ...overrides,
  };
}

function buildApp(cfg: ComplianceConfig, service?: ComplianceScreeningService) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: { publicKey: string } }).user = { publicKey: USER };
    next();
  });
  app.post(
    '/streams',
    complianceScreening({ action: 'stream.create', config: cfg, ...(service ? { service } : {}) }),
    (_req: Request, res: Response) => res.status(201).json({ ok: true }),
  );
  return app;
}

describe('Compliance configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const key of [
      'COMPLIANCE_ENFORCEMENT_ENABLED',
      'COMPLIANCE_RISK_THRESHOLD',
      'COMPLIANCE_FAILURE_MODE',
      'COMPLIANCE_CACHE_TTL_SECONDS',
      'COMPLIANCE_PROVIDER',
      'COMPLIANCE_ALLOWLIST',
      'COMPLIANCE_DENYLIST',
      'COMPLIANCE_EXTERNAL_API_URL',
      'COMPLIANCE_EXTERNAL_API_KEY',
      'COMPLIANCE_EXTERNAL_API_TIMEOUT_MS',
      'COMPLIANCE_SANCTIONS_FILE',
    ]) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('defaults to disabled enforcement (open-source / local testing friendly)', () => {
    const cfg = getComplianceConfig();
    expect(cfg.enforcementEnabled).toBe(false);
    expect(cfg.riskThreshold).toBe(70);
    expect(cfg.failureMode).toBe('fail-closed');
    expect(cfg.provider).toBe('local');
    expect(cfg.cacheTtlSeconds).toBe(86400);
  });

  it('parses enforcement, threshold, provider and failure mode', () => {
    process.env.COMPLIANCE_ENFORCEMENT_ENABLED = 'true';
    process.env.COMPLIANCE_RISK_THRESHOLD = '40';
    process.env.COMPLIANCE_PROVIDER = 'external';
    process.env.COMPLIANCE_FAILURE_MODE = 'fail-open';
    process.env.COMPLIANCE_EXTERNAL_API_URL = 'https://provider.test/screen';
    process.env.COMPLIANCE_EXTERNAL_API_KEY = 'secret';

    const cfg = getComplianceConfig();
    expect(cfg.enforcementEnabled).toBe(true);
    expect(cfg.riskThreshold).toBe(40);
    expect(cfg.provider).toBe('external');
    expect(cfg.failureMode).toBe('fail-open');
    expect(cfg.externalApiUrl).toBe('https://provider.test/screen');
    expect(cfg.externalApiKey).toBe('secret');
  });

  it('parses comma-separated allow and deny lists, trimming whitespace', () => {
    process.env.COMPLIANCE_ALLOWLIST = ' GA, GB ,';
    process.env.COMPLIANCE_DENYLIST = 'GX,GY';
    const cfg = getComplianceConfig();
    expect(cfg.allowlist).toEqual(['GA', 'GB']);
    expect(cfg.denylist).toEqual(['GX', 'GY']);
  });

  it('throws on invalid boolean, number, provider and failure mode values', () => {
    process.env.COMPLIANCE_ENFORCEMENT_ENABLED = 'yes';
    expect(() => getComplianceConfig()).toThrowError(/COMPLIANCE_ENFORCEMENT_ENABLED/);
    delete process.env.COMPLIANCE_ENFORCEMENT_ENABLED;

    process.env.COMPLIANCE_RISK_THRESHOLD = '101';
    expect(() => getComplianceConfig()).toThrowError(/COMPLIANCE_RISK_THRESHOLD/);
    delete process.env.COMPLIANCE_RISK_THRESHOLD;

    process.env.COMPLIANCE_RISK_THRESHOLD = 'abc';
    expect(() => getComplianceConfig()).toThrowError(/COMPLIANCE_RISK_THRESHOLD/);
    delete process.env.COMPLIANCE_RISK_THRESHOLD;

    process.env.COMPLIANCE_PROVIDER = 'chainalysis';
    expect(() => getComplianceConfig()).toThrowError(/COMPLIANCE_PROVIDER/);
    delete process.env.COMPLIANCE_PROVIDER;

    process.env.COMPLIANCE_FAILURE_MODE = 'open';
    expect(() => getComplianceConfig()).toThrowError(/COMPLIANCE_FAILURE_MODE/);
    delete process.env.COMPLIANCE_FAILURE_MODE;
  });
});

describe('ComplianceService screening', () => {
  let service: ComplianceService;

  beforeEach(() => {
    service = new ComplianceService();
  });

  it('returns a clean result for an unknown address', async () => {
    const result = await service.screenAddress(CLEAN, config());
    expect(result).toMatchObject({
      address: CLEAN,
      isSanctioned: false,
      riskScore: 0,
      cached: false,
    });
    expect(result.screenedAt).toBeInstanceOf(Date);
  });

  it('flags denylisted addresses as sanctioned with OFAC tags', async () => {
    const cfg = config({ denylist: [SANCTIONED] });
    const result = await service.screenAddress(SANCTIONED, cfg);
    expect(result.isSanctioned).toBe(true);
    expect(result.riskScore).toBe(100);
    expect(result.tags).toContain('OFAC');
  });

  it('lets the allowlist override the denylist', async () => {
    const cfg = config({ denylist: [ALLOWLISTED], allowlist: [ALLOWLISTED] });
    const result = await service.screenAddress(ALLOWLISTED, cfg);
    expect(result.isSanctioned).toBe(false);
    expect(result.riskScore).toBe(0);
  });

  it('caches results and reports cached=true on the second lookup', async () => {
    const address = 'GCACHETESTADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const cfg = config();
    const first = await service.screenAddress(address, cfg);
    expect(first.cached).toBe(false);

    const second = await service.screenAddress(address, cfg);
    expect(second.cached).toBe(true);
    expect(second.isSanctioned).toBe(first.isSanctioned);
  });

  it('deduplicates addresses when screening a batch', async () => {
    const results = await service.screenAddresses(
      ['GBATCHONEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'GBATCHONEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
      config(),
    );
    expect(results).toHaveLength(1);
  });

  it('applies the risk threshold strictly greater-than', () => {
    const cfg = config({ riskThreshold: 70 });
    const below: ScreeningResult = {
      address: CLEAN,
      isSanctioned: false,
      riskScore: 70,
      tags: [],
      screenedAt: new Date(),
      cached: false,
    };
    const above: ScreeningResult = { ...below, riskScore: 71 };
    expect(service.isBlocked(below, cfg)).toBe(false);
    expect(service.isBlocked(above, cfg)).toBe(true);
  });

  describe('external provider', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it('parses a successful external screening response', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ isSanctioned: true, riskScore: 99, tags: ['OFAC', 'Darknet'] }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const cfg = config({
        provider: 'external',
        externalApiUrl: 'https://provider.test/screen',
        externalApiKey: 'key',
      });
      const result = await service.screenAddress(
        'GEXTERNALONEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        cfg,
      );

      expect(result.isSanctioned).toBe(true);
      expect(result.riskScore).toBe(99);
      expect(result.tags).toEqual(['OFAC', 'Darknet']);
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('throws ComplianceScreeningError on a non-OK response', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({}) }));
      const cfg = config({
        provider: 'external',
        externalApiUrl: 'https://provider.test/screen',
      });
      await expect(
        service.screenAddress('GEXTERNALTWOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', cfg),
      ).rejects.toBeInstanceOf(ComplianceScreeningError);
    });

    it('throws ComplianceScreeningError on network failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
      const cfg = config({
        provider: 'external',
        externalApiUrl: 'https://provider.test/screen',
      });
      await expect(
        service.screenAddress('GEXTERNALTHREEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', cfg),
      ).rejects.toBeInstanceOf(ComplianceScreeningError);
    });

    it('throws when no endpoint is configured', async () => {
      await expect(
        service.screenAddress(
          'GEXTERNALFOURAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          config({ provider: 'external' }),
        ),
      ).rejects.toBeInstanceOf(ComplianceScreeningError);
    });
  });

  describe('audit logging', () => {
    it('persists an audit event through prisma', async () => {
      await service.writeAuditLog({
        eventType: 'SCREENING_BLOCKED',
        address: SANCTIONED,
        ipAddress: '203.0.113.7',
        riskScore: 100,
        tags: ['OFAC'],
        isSanctioned: true,
        action: 'stream.create',
      });
      expect(prisma.complianceAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            address: SANCTIONED,
            ipAddress: '203.0.113.7',
            riskScore: 100,
            isSanctioned: true,
          }),
        }),
      );
    });

    it('never throws when the audit table write fails', async () => {
      (prisma.complianceAuditLog.create as any).mockRejectedValueOnce(new Error('db down'));
      await expect(
        service.writeAuditLog({
          eventType: 'SCREENING_BLOCKED',
          address: SANCTIONED,
          riskScore: 100,
          tags: ['OFAC'],
          isSanctioned: true,
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('SEP-0009 KYC attestation', () => {
    it('stores a SEP-0009 attestation', async () => {
      (prisma.kycAttestation.create as any).mockResolvedValueOnce({
        id: 'att-1',
        organization: 'GORG',
        subjectAddress: CLEAN,
        status: 'PENDING',
        createdAt: new Date(),
      });

      const attestation = await service.submitKycAttestation({
        organization: 'GORG',
        subjectAddress: CLEAN,
        sep9Fields: { first_name: 'Ada', last_name: 'Lovelace' },
        proof: 'signed-proof',
        proofType: 'ed25519',
      });

      expect(attestation.id).toBe('att-1');
      expect(prisma.kycAttestation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          organization: 'GORG',
          subjectAddress: CLEAN,
          proofType: 'ed25519',
          status: 'PENDING',
        }),
      });
    });
  });
});

describe('Compliance screening middleware', () => {
  it('extracts addresses from the authenticated user and request body', () => {
    const req = {
      body: { sender: USER, recipient: SANCTIONED },
      params: {},
      query: {},
      user: { publicKey: USER },
    } as unknown as Request;
    const addresses = extractComplianceAddresses(req);
    expect(addresses).toEqual([USER, SANCTIONED]);
  });

  it('is a no-op when enforcement is disabled', async () => {
    const service = fakeService();
    const app = buildApp(config({ enforcementEnabled: false, denylist: [SANCTIONED] }), service);

    const res = await request(app).post('/streams').send({ sender: USER, recipient: SANCTIONED });
    expect(res.status).toBe(201);
    expect(service.screenAddresses).not.toHaveBeenCalled();
  });

  it('allows clean addresses through', async () => {
    const app = buildApp(config({ denylist: [SANCTIONED] }));
    const res = await request(app).post('/streams').send({ sender: USER, recipient: CLEAN });
    expect(res.status).toBe(201);
  });

  it('blocks sanctioned addresses with a structured 403 and writes an audit event', async () => {
    // Uses the real local-provider service so the denylist is actually consulted.
    const app = buildApp(config({ denylist: [MW_SANCTIONED] }));

    const res = await request(app).post('/streams').send({ sender: USER, recipient: MW_SANCTIONED });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('COMPLIANCE_RESTRICTION');
    expect(res.body.message).toBe('Address restricted under compliance policy');
    expect(prisma.complianceAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'SCREENING_BLOCKED', isSanctioned: true }),
      }),
    );
  });

  it('blocks addresses whose risk score exceeds the threshold', async () => {
    const service = fakeService({
      screenAddresses: vi.fn(async (addresses: string[]) =>
        addresses.map<ScreeningResult>((address) => ({
          address,
          isSanctioned: false,
          riskScore: 85,
          tags: ['MIXER'],
          screenedAt: new Date(),
          cached: false,
        })),
      ),
    });
    const app = buildApp(config({ riskThreshold: 70 }), service);

    const res = await request(app).post('/streams').send({ sender: USER, recipient: CLEAN });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('COMPLIANCE_RESTRICTION');
  });

  it('allows an address whose risk score equals the threshold', async () => {
    const service = fakeService({
      screenAddresses: vi.fn(async (addresses: string[]) =>
        addresses.map<ScreeningResult>((address) => ({
          address,
          isSanctioned: false,
          riskScore: 70,
          tags: [],
          screenedAt: new Date(),
          cached: false,
        })),
      ),
    });
    const app = buildApp(config({ riskThreshold: 70 }), service);

    const res = await request(app).post('/streams').send({ sender: USER, recipient: CLEAN });
    expect(res.status).toBe(201);
  });

  it('fails closed with 503 when screening errors and failure mode is fail-closed', async () => {
    const service = fakeService({
      screenAddresses: vi.fn().mockRejectedValue(new ComplianceScreeningError('provider down')),
    });
    const app = buildApp(config({ failureMode: 'fail-closed' }), service);

    const res = await request(app).post('/streams').send({ sender: USER, recipient: CLEAN });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('COMPLIANCE_SCREENING_UNAVAILABLE');
    expect(service.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'SCREENING_ERROR' }),
    );
  });

  it('fails open when screening errors and failure mode is fail-open', async () => {
    const service = fakeService({
      screenAddresses: vi.fn().mockRejectedValue(new ComplianceScreeningError('provider down')),
    });
    const app = buildApp(config({ failureMode: 'fail-open' }), service);

    const res = await request(app).post('/streams').send({ sender: USER, recipient: CLEAN });

    expect(res.status).toBe(201);
    expect(service.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'SCREENING_ERROR' }),
    );
  });
});

describe('Compliance routes', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.COMPLIANCE_ENFORCEMENT_ENABLED;
    delete process.env.COMPLIANCE_DENYLIST;
    delete process.env.COMPLIANCE_ALLOWLIST;
    delete process.env.COMPLIANCE_PROVIDER;
    vi.clearAllMocks();
    (prisma.complianceAuditLog.create as any).mockResolvedValue({ id: 'audit-1' });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function app() {
    const instance = express();
    instance.use(express.json());
    instance.use('/compliance', complianceRoutes);
    return instance;
  }

  it('accepts a valid SEP-0009 KYC attestation', async () => {
    (prisma.kycAttestation.create as any).mockResolvedValueOnce({
      id: 'att-42',
      organization: USER,
      subjectAddress: CLEAN,
      status: 'PENDING',
      createdAt: new Date().toISOString(),
    });

    const res = await request(app())
      .post('/compliance/kyc-attestation')
      .send({
        subjectAddress: CLEAN,
        proof: 'signed-proof',
        proofType: 'ed25519',
        fields: { first_name: 'Ada', last_name: 'Lovelace', email_address: 'ada@example.com' },
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.attestation.id).toBe('att-42');
    expect(prisma.kycAttestation.create).toHaveBeenCalledOnce();
  });

  it('rejects an attestation missing the required proof', async () => {
    const res = await request(app())
      .post('/compliance/kyc-attestation')
      .send({ subjectAddress: CLEAN, fields: { first_name: 'Ada' } });

    expect(res.status).toBe(400);
    expect(prisma.kycAttestation.create).not.toHaveBeenCalled();
  });

  it('rejects an attestation with an empty SEP-0009 field set', async () => {
    const res = await request(app())
      .post('/compliance/kyc-attestation')
      .send({ subjectAddress: CLEAN, proof: 'sig', fields: {} });

    expect(res.status).toBe(400);
  });

  it('screens an address via POST /compliance/screen', async () => {
    process.env.COMPLIANCE_DENYLIST = SANCTIONED;

    const res = await request(app())
      .post('/compliance/screen')
      .send({ address: SANCTIONED });

    expect(res.status).toBe(200);
    expect(res.body.isSanctioned).toBe(true);
    expect(res.body.blocked).toBe(true);
  });

  it('returns 400 when screening without an address', async () => {
    const res = await request(app()).post('/compliance/screen').send({});
    expect(res.status).toBe(400);
  });

  it('screens an address via GET /compliance/screen/:address', async () => {
    process.env.COMPLIANCE_DENYLIST = SANCTIONED;

    const res = await request(app()).get(`/compliance/screen/${CLEAN}`);

    expect(res.status).toBe(200);
    expect(res.body.address).toBe(CLEAN);
    expect(res.body.isSanctioned).toBe(false);
  });
});
