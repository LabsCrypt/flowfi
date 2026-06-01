## Description
This PR resolves two backend issues:
1. **Issue #524 [Backend] Indexer ignores fee_config_updated and admin_transferred governance events**: Added indexing and SSE broadcasting for `fee_config_updated` and `admin_transferred` contract governance events. Used an elegant, referentially safe `streamId = 0` system stream fallback to preserve Prisma schema integrity and foreign-key constraints.
2. **Issue #525 [Backend] migration_lock.toml declares sqlite but the datasource is postgresql**: Fixed a production-blocking validation mismatch in Prisma by changing `provider` from `"sqlite"` to `"postgresql"` in `migration_lock.toml`.

## Type of Change
<!-- Mark the relevant option with an 'x' -->

- [x] 🐛 Bug fix (non-breaking change which fixes an issue)
- [x] ✨ New feature (non-breaking change which adds functionality)
- [ ] 💥 Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] 📚 Documentation update
- [ ] 🔧 Refactoring (no functional changes)
- [ ] ⚡ Performance improvement
- [x] 🧪 Test addition or update

## Related Issues
<!-- Link related issues using keywords like "Closes", "Fixes", "Resolves" -->
<!-- Example: Closes #123, Fixes #456 -->

Closes #524
Closes #525

## Changes Made
- **Database Configuration**:
  - Updated `provider` in `backend/prisma/migrations/migration_lock.toml` to `"postgresql"`.
- **Worker Indexer (`soroban-event-worker.ts`)**:
  - Added `decodeU32` helper function to decode `u32` event values.
  - Implemented `ensureSystemStream` to upsert a system user and stream with `streamId = 0` during transaction callbacks to prevent database foreign-key constraint violations when writing protocol-level events.
  - Modified `processEvent` to allow single-topic events (`topic.length === 1`) for the two new protocol events while keeping the `streamId` requirement for per-stream events.
  - Implemented `handleFeeConfigUpdated` and `handleAdminTransferred` handlers to write records of types `FEE_CONFIG_UPDATED` and `ADMIN_TRANSFERRED` and broadcast payloads over the SSE admin channels `stream.fee_config_updated` and `stream.admin_transferred`.
- **Classification Lists**:
  - Added `FEE_CONFIG_UPDATED` and `ADMIN_TRANSFERRED` to allowed list arrays in `events.routes.ts` (`EVENT_TYPES`) and `stream.controller.ts` (`validEventTypes`).
- **Syntax and Compile Fixes**:
  - Resolved a pre-existing syntax error (missing arrow function opening brace `{`) in `backend/tests/integration/stream-actions.test.ts` to allow the test runner to compile all files.

## Testing
<!-- Describe the tests you ran and how to verify your changes -->

### Test Coverage
- [x] Unit tests added/updated
- [x] Integration tests added/updated
- [x] Manual testing performed

### Test Steps
<!-- If applicable, provide steps to test the changes -->
1. Run mocked event worker unit tests validating governance event decoding, database upserts, and SSE broadcast trigger:
   ```bash
   npx vitest run tests/soroban-event-worker.test.ts
   ```
2. Run database-mocked integration tests asserting the event lifecycle:
   ```bash
   DATABASE_URL=postgresql://localhost/flowfi npx vitest run src/__tests__/integration/streams.test.ts
   ```
3. Verify that the Prisma migrate status check successfully resolves schema and migration lock providers without crashing:
   ```bash
   DATABASE_URL=postgresql://localhost/flowfi npx prisma migrate status
   ```

## Breaking Changes
<!-- If this PR includes breaking changes, describe them here -->
<!-- If none, you can remove this section -->

## Screenshots/Demo
<!-- If applicable, add screenshots or a link to a demo -->

## Checklist
<!-- Mark completed items with an 'x' -->

- [x] My code follows the project's style guidelines
- [x] I have performed a self-review of my own code
- [x] I have commented my code, particularly in hard-to-understand areas
- [x] I have made corresponding changes to the documentation
- [x] My changes generate no new warnings
- [x] I have added tests that prove my fix is effective or that my feature works
- [x] New and existing unit tests pass locally with my changes
- [x] Any dependent changes have been merged and published
- [x] I have checked for breaking changes and documented them if applicable

## Additional Notes
<!-- Any additional information that reviewers should know -->
