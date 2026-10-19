/**
 * Compliance screening middleware (Issue #1470)
 *
 * Intercepts stream funding and withdrawal requests and screens the
 * participating wallet addresses before the handler runs. When enforcement is
 * enabled and an address is sanctioned (or exceeds the configured risk
 * threshold) the request is rejected with a structured 403 and a security audit
 * event is persisted.
 *
 * Enforcement is controlled by `COMPLIANCE_ENFORCEMENT_ENABLED` so local
 * development and self-hosted deployments remain fully permissive by default.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import logger from '../logger.js';
import { getComplianceConfig, type ComplianceConfig } from '../config/compliance.config.js';
import {
  ComplianceScreeningError,
  complianceService,
  type ComplianceAuditEvent,
  type ScreeningResult,
} from '../services/compliance.service.js';
import type { AuthenticatedRequest } from '../types/auth.types.js';

/** Logical action being screened, used for the audit trail. */
export type ComplianceAction =
  | 'stream.create'
  | 'stream.deposit'
  | 'stream.withdraw'
  | 'compliance.screen';

/**
 * The subset of the compliance service the middleware depends on. Typed as an
 * interface so tests can inject a fake without touching the network or DB.
 */
export interface ComplianceScreeningService {
  screenAddresses(
    addresses: string[],
    config?: ComplianceConfig,
  ): Promise<ScreeningResult[]>;
  isBlocked(result: ScreeningResult, config: ComplianceConfig): boolean;
  writeAuditLog(event: ComplianceAuditEvent): Promise<void>;
}

export interface ComplianceMiddlewareOptions {
  /** Logical action label recorded in audit events. */
  action: ComplianceAction;
  /** Override address extraction (mostly for tests / special routes). */
  addressExtractor?: (req: Request) => string[];
  /** Override config resolution (mostly for tests). */
  config?: ComplianceConfig;
  /** Override the screening service (mostly for tests). */
  service?: ComplianceScreeningService;
}

/**
 * Default address extraction. Only addresses already present on the request are
 * screened; for withdraw/top-up the authenticated wallet is what we know
 * synchronously, which is exactly the actor initiating the fund movement.
 */
export function extractComplianceAddresses(req: Request): string[] {
  const addresses: string[] = [];

  const push = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) {
      addresses.push(value.trim());
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === 'string' && entry.trim()) addresses.push(entry.trim());
      }
    }
  };

  const user = (req as AuthenticatedRequest).user;
  push(user?.publicKey);

  const body = (req.body ?? {}) as Record<string, unknown>;
  push(body.sender);
  push(body.recipient);
  push(body.address);
  push(body.recipientAddress);
  push(body.destination);
  push(body.publicKey);

  push((req.params as Record<string, unknown>)?.address);

  push((req.query as Record<string, unknown>)?.sender);
  push((req.query as Record<string, unknown>)?.recipient);
  push((req.query as Record<string, unknown>)?.address);

  return Array.from(new Set(addresses));
}

function resolveClientIp(req: Request): string | undefined {
  if (typeof req.ip === 'string' && req.ip) return req.ip;
  const socket = (req as Request & { socket?: { remoteAddress?: string } }).socket;
  return socket?.remoteAddress;
}

function toAuditEvent(
  result: ScreeningResult,
  options: {
    action: ComplianceAction;
    ipAddress?: string;
    eventType: string;
    metadata?: Record<string, unknown>;
  },
): ComplianceAuditEvent {
  const event: ComplianceAuditEvent = {
    eventType: options.eventType,
    action: options.action,
    address: result.address,
    riskScore: result.riskScore,
    tags: result.tags,
    isSanctioned: result.isSanctioned,
  };
  if (options.ipAddress) event.ipAddress = options.ipAddress;
  if (options.metadata) event.metadata = options.metadata;
  return event;
}

/**
 * Build the screening middleware for a given action.
 */
export function complianceScreening(options: ComplianceMiddlewareOptions): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const config = options.config ?? getComplianceConfig();

    // Disabled by default: preserve local testing and open-source sovereignty.
    if (!config.enforcementEnabled) {
      next();
      return;
    }

    const service = options.service ?? complianceService;
    const extractor = options.addressExtractor ?? extractComplianceAddresses;
    const addresses = extractor(req);

    if (addresses.length === 0) {
      next();
      return;
    }

    let results: ScreeningResult[];
    try {
      results = await service.screenAddresses(addresses, config);
    } catch (error) {
      const isScreeningError = error instanceof ComplianceScreeningError;
      logger.error(
        `[Compliance] Screening failed for ${options.action}: ${(error as Error).message}`,
        { action: options.action, screeningError: error instanceof ComplianceScreeningError },
      );

      // Record the failure so operators can see screening outages in the audit trail.
      const screeningErrorIp = resolveClientIp(req);
      await service.writeAuditLog({
        eventType: 'SCREENING_ERROR',
        action: options.action,
        address: addresses.join(','),
        ...(screeningErrorIp ? { ipAddress: screeningErrorIp } : {}),
        riskScore: 0,
        tags: [],
        isSanctioned: false,
        metadata: {
          reason: (error as Error).message,
          screeningError: isScreeningError,
        },
      });

      if (config.failureMode === 'fail-closed') {
        res.status(503).json({
          error: 'COMPLIANCE_SCREENING_UNAVAILABLE',
          message:
            'Compliance screening is temporarily unavailable. Please try again later.',
        });
        return;
      }

      // fail-open: let the request through, but it has already been audited.
      next();
      return;
    }

    const blocked = results.filter((result) => service.isBlocked(result, config));

    if (blocked.length > 0) {
      const ipAddress = resolveClientIp(req);

      await Promise.all(
        blocked.map((result) =>
          service.writeAuditLog(
            toAuditEvent(result, {
              action: options.action,
              eventType: 'SCREENING_BLOCKED',
              ...(ipAddress ? { ipAddress } : {}),
              metadata: { threshold: config.riskThreshold, provider: config.provider },
            }),
          ),
        ),
      );

      res.status(403).json({
        error: 'COMPLIANCE_RESTRICTION',
        message: 'Address restricted under compliance policy',
        details: blocked.map((result) => ({
          address: result.address,
          riskScore: result.riskScore,
          tags: result.tags,
          isSanctioned: result.isSanctioned,
        })),
      });
      return;
    }

    next();
  };
}
