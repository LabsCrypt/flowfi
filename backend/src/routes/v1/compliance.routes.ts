import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.js';
import { complianceService } from '../../services/compliance.service.js';
import { getComplianceConfig } from '../../config/compliance.config.js';
import type { AuthenticatedRequest } from '../../types/auth.types.js';
import { sendApiError } from '../../types/api-error.js';
import logger from '../../logger.js';

const router = Router();

/**
 * SEP-0009 (Standard KYC / AML Fields) identity payload.
 *
 * The canonical field set uses snake_case names as defined by the proposal.
 * Unknown vendor extensions are passed through rather than rejected so
 * deployments can attach provider-specific metadata.
 */
const sep9FieldsSchema = z
  .object({
    first_name: z.string().min(1).optional(),
    last_name: z.string().min(1).optional(),
    additional_name: z.string().optional(),
    address_country_code: z.string().length(2).optional(),
    state_or_province: z.string().optional(),
    city: z.string().optional(),
    postal_code: z.string().optional(),
    address: z.string().optional(),
    mobile_number: z.string().optional(),
    email_address: z.string().email().optional(),
    birth_date: z.string().optional(),
    birth_place: z.string().optional(),
    birth_country_code: z.string().length(2).optional(),
    tax_id: z.string().optional(),
    tax_id_name: z.string().optional(),
    occupation: z.string().optional(),
    employer_name: z.string().optional(),
    employer_address: z.string().optional(),
    language_code: z.string().optional(),
    id_type: z.string().optional(),
    id_number: z.string().optional(),
    id_issuing_country_code: z.string().length(2).optional(),
    id_issue_date: z.string().optional(),
    id_expiration_date: z.string().optional(),
  })
  .passthrough()
  .refine((fields) => Object.keys(fields).length > 0, {
    message: 'At least one SEP-0009 identity field must be provided',
  });

const kycAttestationSchema = z.object({
  subjectAddress: z.string().min(1, 'subjectAddress is required'),
  organization: z.string().min(1).optional(),
  proof: z.string().min(1, 'proof is required'),
  proofType: z.enum(['ed25519', 'secp256k1', 'stellar-signature']).optional(),
  fields: sep9FieldsSchema,
});

const screenBodySchema = z.object({
  address: z.string().min(1, 'address is required'),
});

/**
 * @openapi
 * /v1/compliance/kyc-attestation:
 *   post:
 *     tags:
 *       - Compliance
 *     summary: Submit a SEP-0009 KYC/AML attestation
 *     description: |
 *       Allows an organization to submit a cryptographic proof of identity
 *       verification for a wallet, following the SEP-0009 (Standard KYC / AML
 *       Fields) schema. Attestations are stored as PENDING for out-of-band
 *       review and are recorded in the compliance audit trail.
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [subjectAddress, proof, fields]
 *             properties:
 *               subjectAddress:
 *                 type: string
 *                 description: Stellar public key the identity belongs to
 *               organization:
 *                 type: string
 *                 description: Organization identifier; defaults to the authenticated wallet
 *               proof:
 *                 type: string
 *                 description: Cryptographic proof / signature over the identity payload
 *               proofType:
 *                 type: string
 *                 enum: [ed25519, secp256k1, stellar-signature]
 *               fields:
 *                 type: object
 *                 description: SEP-0009 KYC/AML fields (snake_case, vendor fields passthrough)
 *     responses:
 *       201:
 *         description: Attestation accepted for review
 *       400:
 *         description: Invalid attestation payload
 *       401:
 *         description: Unauthorized - missing or invalid authentication
 *       500:
 *         description: Internal server error
 */
router.post('/kyc-attestation', requireAuth, async (req, res) => {
  try {
    const parsed = kycAttestationSchema.safeParse(req.body);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`)
        .join('; ');
      return sendApiError(res, 400, 'VALIDATION_ERROR', message, parsed.error.issues);
    }

    const organization =
      parsed.data.organization ?? (req as AuthenticatedRequest).user.publicKey;

    const attestation = await complianceService.submitKycAttestation({
      organization,
      subjectAddress: parsed.data.subjectAddress,
      sep9Fields: parsed.data.fields,
      proof: parsed.data.proof,
      ...(parsed.data.proofType ? { proofType: parsed.data.proofType } : {}),
    });

    return res.status(201).json({
      success: true,
      attestation: {
        id: attestation.id,
        organization: attestation.organization,
        subjectAddress: attestation.subjectAddress,
        status: attestation.status,
        createdAt: attestation.createdAt,
      },
    });
  } catch (error) {
    logger.error('[Compliance] Error submitting KYC attestation:', error);
    return sendApiError(
      res,
      500,
      'INTERNAL_SERVER_ERROR',
      'A technical error occurred. Please try again later.',
    );
  }
});

/**
 * @openapi
 * /v1/compliance/screen:
 *   post:
 *     tags:
 *       - Compliance
 *     summary: Screen an address against sanctions data
 *     description: |
 *       Runs the configured sanctions / risk screening provider for a wallet
 *       address and returns the result. Results are cached for the configured
 *       TTL. Requires authentication to prevent open enumeration.
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [address]
 *             properties:
 *               address:
 *                 type: string
 *                 description: Stellar public key to screen
 *     responses:
 *       200:
 *         description: Screening result
 *       400:
 *         description: Invalid request body
 *       401:
 *         description: Unauthorized - missing or invalid authentication
 *       503:
 *         description: Screening provider unavailable
 */
router.post('/screen', requireAuth, async (req, res) => {
  const parsed = screenBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return sendApiError(res, 400, 'VALIDATION_ERROR', 'address is required');
  }

  const config = getComplianceConfig();
  try {
    const result = await complianceService.screenAddress(parsed.data.address, config);
    return res.status(200).json({
      ...result,
      sanctioned: result.isSanctioned,
      blocked: complianceService.isBlocked(result, config),
      threshold: config.riskThreshold,
    });
  } catch (error) {
    logger.error('[Compliance] Error screening address:', error);
    return sendApiError(
      res,
      503,
      'COMPLIANCE_SCREENING_UNAVAILABLE',
      'Compliance screening is temporarily unavailable. Please try again later.',
    );
  }
});

/**
 * @openapi
 * /v1/compliance/screen/{address}:
 *   get:
 *     tags:
 *       - Compliance
 *     summary: Screen a wallet address (read-only)
 *     description: Convenience GET variant of /v1/compliance/screen for audit tooling.
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *         description: Stellar public key to screen
 *     responses:
 *       200:
 *         description: Screening result
 *       400:
 *         description: Address is required
 *       401:
 *         description: Unauthorized - missing or invalid authentication
 *       503:
 *         description: Screening provider unavailable
 */
router.get('/screen/:address', requireAuth, async (req, res) => {
  const address = Array.isArray(req.params.address)
    ? req.params.address[0]
    : (req.params.address ?? '').trim();

  if (!address) {
    return sendApiError(res, 400, 'INVALID_ADDRESS', 'Address is required');
  }

  const config = getComplianceConfig();
  try {
    const result = await complianceService.screenAddress(address, config);
    return res.status(200).json({
      ...result,
      sanctioned: result.isSanctioned,
      blocked: complianceService.isBlocked(result, config),
      threshold: config.riskThreshold,
    });
  } catch (error) {
    logger.error('[Compliance] Error screening address:', error);
    return sendApiError(
      res,
      503,
      'COMPLIANCE_SCREENING_UNAVAILABLE',
      'Compliance screening is temporarily unavailable. Please try again later.',
    );
  }
});

export default router;
