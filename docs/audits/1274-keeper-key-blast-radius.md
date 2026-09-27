# Issue #1274: Keeper Key Blast Radius Reduction

## Problem
All state-changing on-chain actions (cancel, topup, pause, resume, withdraw) use a single `KEEPER_SECRET_KEY` for cryptographic authorization. This means:

1. **Single point of failure**: If the keeper key is compromised, an attacker can manipulate ALL users' streams
2. **No per-action authorization**: The backend enforces authorization via JWT/DB checks, but the on-chain contract calls use the same key for all users
3. **Blast radius**: A single key compromise affects every stream in the system

## Current Architecture
- `KEEPER_SECRET_KEY` is stored in the backend environment
- All contract calls (`cancelStream`, `topUpStream`, etc.) use this single key
- Authorization is enforced at the DB/JWT level, not at the contract level
- If the auth/DB layer is bypassed, an attacker can move funds or cancel/mutate arbitrary users' streams

## Design Decision
Move toward **client-side signing** where the wallet signs the actual contract invocation, and the backend only relays/simulates. This ensures on-chain authorization matches the contract's own `require_auth` semantics.

### Priority Order for Migration
1. **cancel** - Highest priority (already has the pattern in place via `senderSecret` parameter)
2. **topUpStream** - Secondary priority
3. **pause/resume** - Tertiary priority (currently only simulated, not submitted)
4. **withdraw** - Quaternary priority

### Proof of Concept: Cancel Action
The `cancelStream` function was migrated to accept a `senderSecret` parameter from the request body instead of using `KEEPER_SECRET_KEY`. This demonstrates the pattern:

**Before**: `const secretKey = process.env.KEEPER_SECRET_KEY; const txHash = await sorobanService.cancelStream(parsedStreamId, secretKey);`

**After**: The frontend signs the transaction with the sender's wallet private key, passes the signature in the request body, and the backend uses that secret for the on-chain call.

### Benefits
- **Reduced blast radius**: Compromise of the keeper key no longer affects cancel operations
- **Per-action authorization**: Each action is authorized by the actual stream owner's key
- **Contract-level security**: Authorization matches the contract's `require_auth` semantics
- **Backward compatible**: The existing `senderSecret` parameter was already in the codebase, just not being used

### Next Steps
1. Migrate `topUpStream` to use client-side signing
2. Implement actual submit (not just simulation) for `pauseStream` and `resumeStream`
3. Implement `withdraw` with client-side signing
4. Update frontend to sign transactions with sender wallets
5. Monitor keeper key usage and rotate periodically

### Risk Assessment
- **Low risk**: The `senderSecret` parameter was already in the codebase, just not utilized
- **Backward compatibility**: Requires frontend changes to sign with sender keys
- **Performance**: Negligible impact (one additional parameter passed)
