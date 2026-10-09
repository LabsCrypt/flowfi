-- Compliance / sanctions screening schema (Issue #1470)
--
-- ComplianceAuditLog: immutable audit trail for screening decisions.
--   Every blocked or failed screening records the address, request IP, risk
--   score and provider tags so enterprise deployments can prove wallets were
--   screened before funds moved.
-- KycAttestation: SEP-0009 KYC/AML identity attestations submitted by
--   organizations, stored with their cryptographic proof.

-- CreateTable
CREATE TABLE "ComplianceAuditLog" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "action" TEXT,
    "address" TEXT NOT NULL,
    "ipAddress" TEXT,
    "riskScore" INTEGER NOT NULL,
    "tags" TEXT[],
    "isSanctioned" BOOLEAN NOT NULL DEFAULT false,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComplianceAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KycAttestation" (
    "id" TEXT NOT NULL,
    "organization" TEXT NOT NULL,
    "subjectAddress" TEXT NOT NULL,
    "sep9Fields" TEXT NOT NULL,
    "proof" TEXT NOT NULL,
    "proofType" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KycAttestation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ComplianceAuditLog_address_idx" ON "ComplianceAuditLog"("address");

-- CreateIndex
CREATE INDEX "ComplianceAuditLog_eventType_idx" ON "ComplianceAuditLog"("eventType");

-- CreateIndex
CREATE INDEX "ComplianceAuditLog_createdAt_idx" ON "ComplianceAuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "KycAttestation_organization_idx" ON "KycAttestation"("organization");

-- CreateIndex
CREATE INDEX "KycAttestation_subjectAddress_idx" ON "KycAttestation"("subjectAddress");

-- CreateIndex
CREATE INDEX "KycAttestation_status_idx" ON "KycAttestation"("status");
