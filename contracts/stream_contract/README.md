# `stream_contract`

Soroban smart contract for time-based token streaming with optional protocol fees.

## Overview

`stream_contract` lets a sender deposit tokens into a stream that accrues linearly to a recipient over time.
The contract supports stream creation, top-ups, withdrawals, cancellation, pause/resume controls, and protocol fee administration.

- Fee cap: `MAX_FEE_RATE_BPS = 1000` (10%)
- Fee unit: basis points (`bps`), where `100 bps = 1%`
- Fee collection points: `create_stream`, `top_up_stream`

## Public API

All entrypoints are in `src/lib.rs` under `impl StreamContract`.

### Protocol administration

| Function | Purpose |
|---|---|
| `initialize(env, admin, treasury, fee_rate_bps)` | One-time protocol config setup |
| `update_fee_config(env, admin, treasury, fee_rate_bps)` | Update treasury and/or fee rate (admin-only) |
| `transfer_admin(env, current_admin, new_admin)` | Transfer admin role |
| `get_fee_config(env)` | Read current fee config (`Option<ProtocolConfig>`) |

### Stream lifecycle

| Function | Purpose |
|---|---|
| `create_stream(env, sender, recipient, token_address, amount, duration)` | Create stream from deposited funds |
| `top_up_stream(env, sender, stream_id, amount)` | Add more funds to an active stream |
| `withdraw(env, recipient, stream_id)` | Recipient withdraws currently claimable amount |
| `cancel_stream(env, sender, stream_id)` | Sender cancels stream and receives remaining balance |
| `pause_stream(env, sender, stream_id)` | Freeze accrual on an active stream |
| `resume_stream(env, sender, stream_id)` | Resume accrual and recompute stream end time |

### Read-only queries

| Function | Purpose |
|---|---|
| `get_stream(env, stream_id)` | Return full stream record (`Option<Stream>`) |
| `is_stream_completed(env, stream_id)` | Return completion status |
| `get_claimable_amount(env, stream_id)` | Compute current claimable amount without state changes |

## Fee and treasury model

Protocol fee config is optional; if not initialized, fee collection is a no-op.

When initialized and `fee_rate_bps > 0`:

- Fee formula: `fee = amount * fee_rate_bps / 10_000`
- Net credited to stream: `amount - fee`
- Fee recipient: configured `treasury` address
- Fee event: `fee_collected` is emitted only when `fee > 0`

### Rounding behavior

Fee math uses integer division. For tiny amounts, fee can round down to zero.

Example:
- `amount = 1`
- `fee_rate_bps = 200` (2%)
- `fee = 1 * 200 / 10_000 = 0`

In this case:
- no transfer to treasury occurs,
- no `fee_collected` event is emitted,
- full amount is credited to the stream.

## Event topics

Events are emitted with the following topics (see `src/events.rs`):

| Event struct | Topic |
|---|---|
| `InitializedEvent` | `("initialized",)` |
| `FeeConfigUpdatedEvent` | `("fee_config_updated",)` |
| `AdminTransferredEvent` | `("admin_transferred",)` |
| `StreamCreatedEvent` | `("stream_created", stream_id)` |
| `StreamToppedUpEvent` | `("stream_topped_up", stream_id)` |
| `TokensWithdrawnEvent` | `("tokens_withdrawn", stream_id)` |
| `StreamCancelledEvent` | `("stream_cancelled", stream_id)` |
| `StreamPausedEvent` | `("stream_paused", stream_id)` |
| `StreamResumedEvent` | `("stream_resumed", stream_id)` |
| `StreamCompletedEvent` | `("stream_completed", stream_id)` |
| `FeeCollectedEvent` | `("fee_collected", stream_id)` |

## `StreamError` reference

Error codes from `src/errors.rs`:

| Code | Variant | Meaning |
|---:|---|---|
| 1 | `InvalidAmount` | Amount is zero/negative/out of range |
| 2 | `StreamNotFound` | Stream ID does not exist |
| 3 | `Unauthorized` | Caller not authorized for stream action |
| 4 | `StreamInactive` | Operation requires an active stream |
| 5 | `AlreadyInitialized` | `initialize` called more than once |
| 6 | `NotAdmin` | Caller is not protocol admin |
| 7 | `InvalidFeeRate` | Fee exceeds `MAX_FEE_RATE_BPS` |
| 8 | `NotInitialized` | Protocol config not initialized |
| 9 | `InvalidDuration` | Duration is zero |
| 10 | `InvalidTokenAddress` | Token address is not a token contract |
| 11 | `InvalidRate` | `amount / duration` rounds to zero |

## Typical flow

1. Admin calls `initialize` with treasury and fee rate.
2. Sender calls `create_stream`.
3. Sender may call `top_up_stream`, `pause_stream`, `resume_stream`, or `cancel_stream`.
4. Recipient calls `withdraw` over time until fully drained.
5. Final withdrawal emits `stream_completed`.
