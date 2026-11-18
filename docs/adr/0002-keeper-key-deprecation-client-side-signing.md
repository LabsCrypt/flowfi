# ADR 0002: Keeper-Key Deprecation & Client-Side Signing

- Status: Accepted
- Date: 2026-09-25
- Deciders: FlowFi core (contracts + backend + frontend + SDK)
- Related: `docs/audits/1274-keeper-key-blast-radius.md`, SDK (#1453),
  `backend/src/services/sorobanService.ts`, `backend/docs/ARCHITECTURE.md`

## Context

Historically every mutating Soroban call was submitted by the backend with a
single custodial `KEEPER_SECRET_KEY`. Authorization lived in JWT/DB checks, not
in on-chain `require_auth`. Compromise of one key could cancel, top up, or
mutate **all** users' streams — the blast radius documented in
`docs/audits/1274-keeper-key-blast-radius.md`.

The contract itself already enforces per-action auth
(`sender.require_auth()` / `recipient.require_auth()` / admin checks), but the
backend bypassed that intent by signing as the keeper.

## Decision

Migrate to **non-custodial client-side signing** as the default, keeping
exactly one custodial exception:

| Action | Signer | Rationale |
|---|---|---|
| Create / withdraw / cancel / pause / resume / close | User wallet (Freighter / WalletConnect / HW via SDK `Signer`) | Matches contract `require_auth`; backend only simulates + relays |
| Top-up | Server keeper (`KEEPER_SECRET_KEY`) | Sender funds a stream they own; custodial relay preserves one-click UX for payroll bots — explicitly documented as the sole exception |

Supporting changes:

1. New standalone `@flowfi/sdk` (`FlowFiClient` + `FreighterSigner` /
   `KeypairSigner` / `CustomSigner`) builds, simulates (`simulateTransaction`
   → footprint + auth), fee-pads, signs, and submits without the backend.
2. Backend `sorobanService.ts` keeps `simulate*` endpoints for fee estimation
   but must NOT add server-submit paths for wallet-owned actions.
3. Frontend signs via the connected wallet and submits directly to the RPC;
   `topUpStream` remains the only keeper-submitted flow.

Migration order (highest blast-radius reduction first):
cancel → withdraw → pause/resume → create → close; top-up stays custodial.

## Consequences

Positive:

- On-chain auth now matches off-chain intent; a backend/DB bypass alone
  cannot move funds.
- Keeper compromise is contained to top-ups (auditable, rate-limited,
  rotatable).
- Third-party dApps integrate without trusting FlowFi backend keys.

Negative / residual:

- UX burden: every wallet action needs an explicit signature (mitigated with
  SDK batching + clear frontend copy).
- `KEEPER_SECRET_KEY` still exists for top-ups — must be rotated, scoped, and
  monitored (see STRIDE threat model).
- Legacy keeper-submit code paths must be guarded against reintroduction via
  review + the `backend/docs/ARCHITECTURE.md` "do not wire" rule.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Keep keeper key + harden backend auth | Leaves single point of failure; contract auth stays decorative |
| Per-user server wallets (HSM per user) | Operational nightmare; still custodial, still honeypot |
| Full custodial relayer with allowlist | Reintroduces central trust; incompatible with institutional non-custodial requirement |
