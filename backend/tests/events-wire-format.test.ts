import { describe, it, expect } from 'vitest';
import { xdr } from '@stellar/stellar-sdk';
import { decodeMap } from '../src/workers/soroban-event-worker.js';

/**
 * Pins the exact set of Map field names each event handler in
 * soroban-event-worker.ts reads via decodeMap(), mirroring the
 * `#[contracttype]` structs emitted by contracts/stream_contract/src/events.rs.
 * A field rename/removal on the contract side must be reflected here and in
 * the matching handler, or this test (and the contract-side
 * test_stream_created_event_field_names_match_decoder_expectations) will fail.
 */
const EXPECTED_EVENT_FIELDS: Record<string, string[]> = {
  stream_created: [
    'stream_id',
    'sender',
    'recipient',
    'rate_per_second',
    'token_address',
    'deposited_amount',
    'start_time',
  ],
  stream_topped_up: ['stream_id', 'sender', 'amount', 'new_deposited_amount'],
  tokens_withdrawn: ['stream_id', 'recipient', 'amount', 'timestamp'],
  stream_cancelled: [
    'stream_id',
    'sender',
    'recipient',
    'amount_withdrawn',
    'refunded_amount',
  ],
  fee_collected: ['stream_id', 'treasury', 'fee_amount', 'token'],
  fee_config_updated: [
    'admin',
    'old_treasury',
    'new_treasury',
    'old_fee_rate_bps',
    'new_fee_rate_bps',
  ],
  admin_transferred: ['previous_admin', 'new_admin'],
  stream_paused: ['stream_id', 'sender', 'paused_at'],
  stream_resumed: ['stream_id', 'sender', 'new_end_time'],
};

/** Fields each handler actually reads via `body["field"]`, independent of EXPECTED_EVENT_FIELDS above. */
const HANDLER_READ_FIELDS: Record<string, string[]> = {
  stream_created: [
    'sender',
    'recipient',
    'token_address',
    'rate_per_second',
    'deposited_amount',
    'start_time',
  ],
  stream_topped_up: ['amount', 'new_deposited_amount'],
  tokens_withdrawn: ['recipient', 'amount', 'timestamp'],
  stream_cancelled: ['amount_withdrawn', 'refunded_amount'],
  fee_collected: ['treasury', 'fee_amount', 'token'],
  fee_config_updated: [
    'admin',
    'old_treasury',
    'new_treasury',
    'old_fee_rate_bps',
    'new_fee_rate_bps',
  ],
  admin_transferred: ['previous_admin', 'new_admin'],
  stream_paused: ['sender', 'paused_at'],
  stream_resumed: ['sender', 'new_end_time'],
};

function buildScMap(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  const entries = Object.entries(fields).map(
    ([key, val]) =>
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val }),
  );
  return xdr.ScVal.scvMap(entries);
}

describe('event wire format', () => {
  it.each(Object.entries(EXPECTED_EVENT_FIELDS))(
    '%s: decodeMap exposes every field the handler reads',
    (eventName, allFields) => {
      const scMap = buildScMap(
        Object.fromEntries(
          allFields.map((f) => [f, xdr.ScVal.scvU32(0)]),
        ),
      );

      const decoded = decodeMap(scMap);
      const decodedKeys = Object.keys(decoded).sort();

      expect(decodedKeys).toEqual([...allFields].sort());

      for (const field of HANDLER_READ_FIELDS[eventName] ?? []) {
        expect(decoded).toHaveProperty(field);
      }
    },
  );
});
