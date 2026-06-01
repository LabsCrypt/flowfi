# Pull Request: Frontend cleanup — dead code removal, modal a11y, shared API helpers

## Summary

This PR addresses four related frontend maintenance issues in a single branch:

- **#556** — Remove unused `useCancelStream` / `useWithdrawStream` hooks and their dead REST helpers (`cancelStream` / `withdrawStream` in `lib/api/streams.ts`). Active cancel/withdraw flows remain on Soroban (stream detail) and `useIncomingStreams`.
- **#557** — Delete the never-mounted `Banner` component and `banner.config.ts` (no global announcement banner is wired today).
- **#558** — Consolidate duplicated stream-endpoint resolver and stroop conversion helpers into `lib/api/_shared.ts`; `dashboard.ts` and `api/streams.ts` now import from one source.
- **#559** — Add `role="dialog"`, `aria-modal`, `aria-labelledby`, Tab focus trapping, and focus restoration on close for `StreamCreationWizard`, `CancelConfirmModal`, and `TopUpModal` via a shared `useModalDialog` hook (Escape-to-close preserved).

## Changes by issue

| Issue | Files |
|-------|-------|
| #556 | Removed `hooks/useCancelStream.ts`, `hooks/useWithdrawStream.ts`; trimmed `lib/api/streams.ts` |
| #557 | Removed `components/ui/Banner.tsx`, `lib/banner.config.ts` |
| #558 | Added `lib/api/_shared.ts`; updated `lib/dashboard.ts`, `lib/api/streams.ts` |
| #559 | Added `hooks/useModalDialog.ts`; updated stream-creation modals |

## Test plan

- [ ] `npm run build --workspace=frontend` passes
- [ ] `npm test --workspace=frontend` passes (existing utils tests unchanged)
- [ ] Confirm no imports of removed hooks, Banner, or `cancelStream`/`withdrawStream` REST helpers
- [ ] Open **Create Stream** wizard — Tab cycles within modal only; Escape closes; focus returns to trigger
- [ ] Open **Cancel Stream** confirm modal — same keyboard/a11y behavior; Escape blocked while submitting
- [ ] Open **Top Up** modal — input auto-focused; Tab trapped; Escape closes when idle
- [ ] Dashboard and incoming streams pages still load stream lists correctly (shared endpoint resolver)

## Notes

- `shortenAddress` in `dashboard.ts` was left local (dashboard-only); `streams.ts` continues using `shortenPublicKey` from wallet utils.
- Overlap with **#456** (authenticate/remove unused cancel/withdraw REST helpers) is resolved here by deleting the dead REST helpers entirely.
