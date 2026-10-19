# FlowFi STRIDE Threat Model

- Version: 1.0 (2026-09-25)
- Scope: Soroban `stream_contract`, Node.js backend API + indexer, Next.js
  frontend + wallet integrations, RPC/relay path.
- Companion docs: [ADRs](../adr/README.md), [Architecture](../ARCHITECTURE.md),
  [Backend architecture](../../backend/docs/ARCHITECTURE.md),
  [Keeper blast radius](../audits/1274-keeper-key-blast-radius.md).
- Methodology: STRIDE per trust boundary (Microsoft). Each finding lists
  vector → impact → mitigation → residual risk → owner.

## 1. System Architecture & Trust Boundaries

```
[ B1: User Browser + Wallet Extension (Freighter / WC / HW) ]
        │ signed envelopes, SSE subscription (JWT)
        ▼
[ B2: Next.js Frontend + CDN ] ──REST/SSE──▶ [ B3: Node.js Backend API + Indexer ]
        │                                              │ RPC + Prisma + Redis
        ▼                                              ▼
[ Stellar Wallets / Auth ]              [ B4: Soroban Stream Contract + Stellar Ledger ]
```

| Boundary | Components | Trust assumption |
|---|---|---|
| B1 — Browser + wallet | Freighter / WalletConnect / hardware signers, `@flowfi/sdk` (`FreighterSigner`, `CustomSigner`), SSE client | User device is benign; wallet keeps keys secret; browser origin isolation holds |
| B2 — Frontend + CDN | Next.js dashboard, `NEXT_PUBLIC_*` config, static assets | CDN serves untampered JS; env config is public-safe (no secrets) |
| B3 — Backend API + indexer | Express REST, JWT/SEP-10 auth, `SorobanEventWorker`, Prisma/Postgres, Redis fanout, `KEEPER_SECRET_KEY` (top-ups only) | Server secrets stay secret; DB/Redis are trusted stores; RPC endpoint is authenticated transport |
| B4 — Contract + ledger | `stream_contract` (streams, fees, TTL, `close_stream`), Stellar asset contracts, Soroban RPC | Contract code is correct; ledger ordering/finality holds; token contracts honor SAC semantics |

Data flows: B1 signs → B4 directly (wallet path) or via B3 relay (top-up only);
B4 emits events → B3 indexer → Postgres → SSE → B2/B1; B2 REST reads served from B3.

## 2. Threat Analysis Matrix

Severity: **H**igh / **M**edium / **L**ow. Status: ✅ mitigated / 🟡 partial / 🔴 accepted risk.

### S — Spoofing

| ID | Threat / vector | Impact | Mitigation | Residual / owner |
|---|---|---|---|---|
| S-01 | Attacker replays SEP-10 challenge to impersonate a user at B3 auth | Unauthorized stream reads/writes via API | Nonce-bound challenges, short expiry, signature verifies `publicKey`; JWT scoped + short-lived | 🟡 Challenge replay window (seconds); owner: backend auth |
| S-02 | Attacker calls contract with victim's `sender` without their key | Direct fund theft / stream hijack at B4 | Contract `require_auth()` on sender/recipient/admin; wallet-only signing per ADR-0002 | ✅ mitigated (contract-enforced); owner: contracts |
| S-03 | Rogue frontend (phishing clone) tricks user into signing attacker contract call | Signed malicious stream / drain | SDK pins `contractId`; frontend displays decoded call summary; Freighter origin check | 🟡 user must verify domain; owner: frontend + SDK |
| S-04 | Attacker spoofs indexer/SSE events to frontend | Fake balances, phishing prompts | SSE requires Bearer JWT; events cross-checked against REST + ledger on sensitive actions | 🟡 UI spoof until refresh; owner: backend SSE |

### T — Tampering

| ID | Threat / vector | Impact | Mitigation | Residual / owner |
|---|---|---|---|---|
| T-01 | MITM alters unsigned tx between build and sign (malicious dApp) | diverted recipient/amount | SDK signs only `assembledXdr` from `simulateTransaction`; wallet shows full call diff; `contract.call` args typed | 🟡 compromised dApp can still present misleading UI; owner: SDK |
| T-02 | Attacker tampers with `StreamEvent` rows / `IndexerState` cursor via SQL injection | Corrupted balances, skipped ledgers | Prisma parameterized queries, Zod validation, least-privilege DB role; cursor updates transactional with batch | ✅ mitigated; owner: backend |
| T-03 | Malicious token contract passed as `token_address` | Reentrancy / fake balances | `validate_token_contract` (`decimals` probe); CEI ordering (state before transfer); checked arithmetic | 🟡 non-standard tokens may still misbehave; owner: contracts |
| T-04 | CDN asset tampering (B2) | Keylogging, address swap | Pinned builds, SRI where applicable, CSP; no secrets in `NEXT_PUBLIC_*` | 🟡 CDN compromise still severe; owner: frontend/DevOps |
| T-05 | TTL-bump griefing (`extend_stream_ttl` spam on dead streams) | Wasted RPC/state, obscures pruning | `close_stream` prunes settled streams; bump is cheap read-path; monitors alert on abnormal bump volume | 🔴 accepted (permissionless bump is by design); owner: contracts |

### R — Repudiation

| ID | Threat / vector | Impact | Mitigation | Residual / owner |
|---|---|---|---|---|
| R-01 | User denies authorizing a stream action | Dispute / support burden | Ledger signatures + `initialized / stream_* / fee_collected` events with caller + timestamp; backend `StreamEvent` ledger linkage + `requestId` logs | ✅ mitigated; owner: contracts + backend |
| R-02 | Admin denies fee-config change | Governance dispute | `fee_config_updated` / `admin_transferred` events with old/new values; `IndexerDeadLetterEvent` audit trail | ✅ mitigated; owner: contracts |
| R-03 | Backend denies indexer replay / admin action | Audit gap | Admin actions logged with `requestId` correlation; replay endpoints return `{ replayingFrom, requestId }` | 🟡 logs must be retained; owner: backend |

### I — Information Disclosure

| ID | Threat / vector | Impact | Mitigation | Residual / owner |
|---|---|---|---|---|
| I-01 | `KEEPER_SECRET_KEY` leak (env, logs, image layers) | Attacker funds arbitrary top-ups; reputation loss | Scoped to top-ups only (ADR-0002); never logged; documented rotation; least-privilege deploy secrets | 🟡 top-up abuse until rotation; owner: DevOps |
| I-02 | JWT / SSE stream leakage across users | Private payroll amounts exposed | Per-stream/per-user SSE channels + authz checks; user summary cached but scoped; rate limits | 🟡 mis-subscription bug class; owner: backend |
| I-03 | Verbose errors exposing ledger internals / SQL | Recon for injection | Central `error.middleware.ts` sanitizes production errors; Prisma errors mapped | ✅ mitigated; owner: backend |
| I-04 | Preview databases (PR envs) leaking production data | Payroll PII exposure | Previews use seeded demo data only, never prod snapshots; ephemeral DB per PR; auto-drop on close | ✅ mitigated by design (#1456); owner: DevOps |

### D — Denial of Service

| ID | Threat / vector | Impact | Mitigation | Residual / owner |
|---|---|---|---|---|
| D-01 | SSE connection exhaustion | Legit clients dropped | 10k/server, 5/IP, 10/user caps; ≥64KB slow-client drops; Redis fanout avoids sticky overload | 🟡 L7 flood still needs WAF; owner: backend |
| D-02 | Indexer poison event halting polls | Stale balances, missed payouts | Dead-letter queue: persist + skip + continue; replay endpoint; wire-format pin tests | ✅ mitigated (ADR-0003); owner: backend |
| D-03 | Storage-bloat / TTL-expiry griefing | Evicted active streams; RPC scan bloat | Central TTL constants + on-demand bumps (ADR-0001); `close_stream` pruning; `isStale` RPC fallback | 🟡 idle-stream expiry documented; owner: contracts |
| D-04 | Preview-env resource exhaustion (many open PRs) | CI minutes / Fly / DB quota burn | Per-PR concurrency cancel; `pr-preview-cleanup.yml` auto-teardown; Fly/Neon quotas + manual destroy script | 🟡 quota alerts required; owner: DevOps |
| D-05 | Fee-griefing via dust streams (`amount/duration → 0 rate`) | Locked dust, support load | `InvalidRate` guard rejects zero-rate streams at build time | ✅ mitigated; owner: contracts |

### E — Elevation of Privilege

| ID | Threat / vector | Impact | Mitigation | Residual / owner |
|---|---|---|---|---|
| E-01 | Non-admin calls `update_fee_config` / `transfer_admin` | Fee theft / admin takeover | `load_config` + `config.admin != caller → NotAdmin`; `transfer_admin` requires current-admin auth | ✅ mitigated; owner: contracts |
| E-02 | Non-sender calls `pause/resume/top_up/cancel` on victim stream | Fund lock / theft | `validate_stream_ownership` (sender) / recipient checks; `close_stream` allows sender/recipient/admin only | ✅ mitigated; owner: contracts |
| E-03 | Cancelled stream resumed to drain funds | State-invariant break (Testing #94) | `resume_stream` rejects `!is_active`; `cancel` clears `paused`; `close_stream` requires terminal status | ✅ mitigated + regression-tested; owner: contracts |
| E-04 | Keeper key used to submit wallet-owned actions (regression) | Bypasses ADR-0002 | Code-review rule + `ARCHITECTURE.md` "do not wire" guard; SDK is the only wallet-submit path | 🟡 process control, not code control; owner: backend |
| E-05 | Admin SSE channel / metrics scraped by non-admin | Operational intel leak | Admin broadcast gated on `ADMIN_PUBLIC_KEY`; admin routes behind bearer secret + rate limits | 🟡 secret rotation discipline; owner: backend |

## 3. Residual Risks & Acceptance

1. **Keeper top-up key remains custodial** (I-01/E-04) — accepted with rotation,
   scoping, and monitoring; full removal would degrade payroll-bot UX.
2. **User-device compromise** (S-03/T-01) — out of scope; mitigated with
   contract-ID pinning and wallet call previews, but a fully compromised
   browser cannot be saved by protocol design.
3. **Long-idle stream expiry** (D-03) — documented; clients must bump or close.
4. **Preview quota burn** (D-04) — accepted with auto-cleanup + alerts.

## 4. Audit Touchpoints

- Contract entrypoints to fuzz: `create_stream`, `withdraw`, `cancel_stream`,
  `pause/resume`, `top_up_stream`, `close_stream`, `transfer_admin`.
- Invariants: cancelled ⇒ never resumable; `withdrawn ≤ deposited`;
  `claimable ≤ remaining`; pruned ID ⇒ `get_stream == None`.
- Backend surfaces: SEP-10/JWT, SSE authz, indexer cursor + dead letters,
  keeper scoping, preview data hygiene.
- Frontend surfaces: wallet call previews, SSE reconnection, no-secret env discipline.
