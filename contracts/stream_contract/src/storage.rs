//! Centralized ledger access for stream records and protocol configuration.
//!
//! Every persistent and instance entry this contract owns is read and written
//! through the helpers in this module. Centralizing access keeps the storage
//! key strategy in one place and — more importantly for auditors and new
//! contributors — makes the TTL bump policy reviewable in isolation, as
//! documented in
//! [ADR 0001](../../../docs/adr/0001-soroban-storage-ttl-bump-strategy.md).
//!
//! # Storage key layout
//!
//! All keys are variants of [`DataKey`], which `#[contracttype]` serializes
//! deterministically. There are no ad-hoc string keys anywhere in the contract.
//! The variants touched by this module, and where each one lives:
//!
//! | [`DataKey`] variant | Storage | Value | Accessed by |
//! |---|---|---|---|
//! | `Stream(id)` | persistent | [`Stream`] (or [`LegacyStream`]) | [`load_stream`], [`try_load_stream`], [`save_stream`], [`remove_stream`] |
//! | `StreamCounter` | instance | `u64` next stream ID | [`next_stream_id`] |
//! | `ProtocolConfig` | instance | [`ProtocolConfig`] | [`config_exists`], [`load_config`], [`try_load_config`], [`save_config`] |
//! | `ContractVersion` | instance | `u32` state schema version | [`get_contract_version`], [`save_contract_version`] |
//! | `ContractWasmHash` | instance | `BytesN<32>` executable hash | [`get_recorded_wasm_hash`], [`save_recorded_wasm_hash`] |
//!
//! Instance storage is a *single* ledger entry shared by all four instance
//! keys, so a TTL bump on instance storage renews `StreamCounter`,
//! `ProtocolConfig`, `ContractVersion`, and `ContractWasmHash` at once. That is
//! why [`next_stream_id`] and [`save_config`] call `extend_ttl` without naming a
//! key — see the SDK's `soroban_sdk::storage::Instance`, whose `extend_ttl` is
//! keyed on nothing because there is only one instance entry.
//!
//! Only [`DataKey::Stream`] lives in persistent storage, which is where the
//! per-entry rent cost is actually incurred.
//!
//! # TTL bump semantics
//!
//! Soroban charges rent for persistent entries and evicts entries whose TTL
//! lapses, so a stream record that is never renewed can disappear. The two
//! knobs are coarse and independent:
//!
//! - `threshold` — renew only if fewer than this many ledgers remain.
//! - `extend_to` — the TTL the entry is set to when renewal triggers.
//!   This is a **target, not an increment**: an entry already at 400 000
//!   remaining ledgers is left alone, and a renewal always lands on exactly
//!   `extend_to`, never `remaining + extend_to`.
//!
//! At ~5 s per ledger the constants below are roughly 7 days of threshold and
//! ~30 days of renewed lifetime.
//!
//! # Which operations bump
//!
//! Bumps happen on the **write** paths only, so renewal rides along with normal
//! stream traffic without a keeper cron:
//!
//! - [`save_stream`] bumps its own [`DataKey::Stream`] key (per-entry).
//! - [`save_config`] and [`next_stream_id`] bump the shared instance entry.
//!
//! The read paths ([`load_stream`], [`try_load_stream`], [`load_config`],
//! [`try_load_config`], the version and hash getters) do **not** bump, and
//! neither do [`save_contract_version`], [`save_recorded_wasm_hash`], or
//! [`remove_stream`]. Note that ADR 0001 rule 1 describes reads as bumping too;
//! the code here does not, and this module is the authoritative record of the
//! shipped behavior. Reads still transitively renew a stream, because the
//! entrypoints that call them almost always write the record back.

use soroban_sdk::{Env, Map, Symbol, TryFromVal, Val};

/// Minimum ledgers remaining before a persistent entry is renewed.
///
/// ~7 days at ~5 s per ledger. See [`PERSISTENT_BUMP_AMOUNT`] for the value the
/// TTL is set to when this threshold triggers.
pub const PERSISTENT_LIFETIME_THRESHOLD: u32 = 120_960;

/// Target ledger lifetime for a persistent entry, applied when renewal triggers.
///
/// ~30 days at ~5 s per ledger. Despite the "bump amount" name this is the TTL
/// the entry is *set to*, not a number of ledgers added to what remains: a
/// renewal lands on exactly this value.
pub const PERSISTENT_BUMP_AMOUNT: u32 = 518_400;

/// Minimum ledgers remaining before instance storage is renewed.
///
/// ~7 days at ~5 s per ledger. Applies to the single shared instance entry,
/// which carries every instance-backed key in the table above.
pub const INSTANCE_LIFETIME_THRESHOLD: u32 = 120_960;

/// Target ledger lifetime for the instance entry, applied when renewal triggers.
///
/// ~30 days at ~5 s per ledger. A target, not an increment — see
/// [`PERSISTENT_BUMP_AMOUNT`] for the same caveat.
pub const INSTANCE_BUMP_AMOUNT: u32 = 518_400;

use crate::errors::StreamError;
use crate::types::{
    DataKey, DisputeStatus, LegacyProtocolConfig, LegacyStream, ProtocolConfig, StorageKey, Stream,
    VestingSchedule,
};

// ─── Version-Tolerant Decoding ────────────────────────────────────────────────

/// Field counts of the current and pre-v3 record shapes.
///
/// A `#[contracttype]` struct is stored as a host `Map` with one entry per field,
/// and decoding it walks the map positionally. The current shapes are described
/// here only so the two can be told apart before a decode is attempted.
const CONFIG_FIELD_COUNT: u32 = 5;
const LEGACY_CONFIG_FIELD_COUNT: u32 = 3;
const STREAM_FIELD_COUNT: u32 = 17;
const LEGACY_STREAM_FIELD_COUNT: u32 = 12;

/// Returns the number of fields in a stored record, or `None` if it is not a map.
///
/// Operates on an already-read [`Val`], so it performs no storage access and no
/// TTL bump of its own.
///
/// This is the only safe way to distinguish the two record shapes. "Decode as
/// the current struct, and fall back to the legacy struct on `Err`" does **not**
/// work: a positional decode that runs off the end of a shorter map raises a
/// *host* error, which surfaces as a panic that aborts the invocation rather
/// than an `Err` the caller could branch on. Inspecting the map first means the
/// decode that does run is always the one that matches the stored bytes.
fn record_field_count(env: &Env, raw: &Val) -> Option<u32> {
    Map::<Symbol, Val>::try_from_val(env, raw)
        .ok()
        .map(|m| m.len())
}

// ─── Stream Counter ───────────────────────────────────────────────────────────

/// Returns the next stream ID and persists the updated counter.
///
/// **Key:** [`DataKey::StreamCounter`] in instance storage — O(1) access,
/// singleton semantics, shared with the other instance keys.
///
/// **TTL:** Bumps the shared instance entry to [`INSTANCE_BUMP_AMOUNT`] ledgers
/// when it has fallen below [`INSTANCE_LIFETIME_THRESHOLD`]. Because the
/// instance is one shared entry, this renews [`DataKey::ProtocolConfig`],
/// [`DataKey::ContractVersion`], and [`DataKey::ContractWasmHash`] too.
///
/// IDs start at 1. Read-modify-write is not re-entrant-safe in general, but
/// Soroban serializes invocations per contract, so no two callers can observe
/// the same pre-increment value.
pub fn next_stream_id(env: &Env) -> u64 {
    let id: u64 = env
        .storage()
        .instance()
        .get(&DataKey::StreamCounter)
        .unwrap_or(0)
        + 1;
    env.storage().instance().set(&DataKey::StreamCounter, &id);
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
    id
}

// ─── Stream CRUD ─────────────────────────────────────────────────────────────

/// Extends the persistent storage TTL for a position or stream metadata entry
/// up to the contract maximum lifetime.
pub fn bump_position_ttl(env: &Env, key: &StorageKey) {
    if env.storage().persistent().has(key) {
        env.storage().persistent().extend_ttl(
            key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );
    }
}

/// Loads a stream by ID from persistent storage, tolerating the legacy shape.
///
/// **Key:** `DataKey::Stream(stream_id)` in persistent storage. This is the
/// only key in the contract that incurs per-entry rent.
///
/// **TTL:** No bump. See the module-level "Which operations bump" section; the
/// entrypoints that read a stream generally write it back through
/// [`save_stream`] in the same invocation, which is what renews it.
///
/// A pre-v2 record has no `schedule` field, so decoding it as the current
/// [`Stream`] fails. Rather than bricking escrowed funds after an in-place code
/// upgrade, fall back to [`LegacyStream`] and report it as the linear drip it
/// was created as. The upgraded record is not written back here — the next
/// `save_stream` for that ID persists the current shape, which is how
/// `migrate`'s lazy per-stream healing works.
///
/// Returns `StreamNotFound` if no entry exists in either shape.
pub fn load_stream(env: &Env, stream_id: u64) -> Result<Stream, StreamError> {
    try_load_stream(env, stream_id).ok_or(StreamError::StreamNotFound)
}

/// Persists a stream record in persistent storage.
///
/// **Key:** `DataKey::Stream(stream_id)` in persistent storage.
///
/// **TTL:** Bumps this entry's TTL to [`PERSISTENT_BUMP_AMOUNT`] ledgers when it
/// has fallen below [`PERSISTENT_LIFETIME_THRESHOLD`]. This is the primary
/// renewal path for a live stream, and the reason normal stream traffic keeps a
/// record alive without a dedicated keeper.
///
/// Always use this instead of calling `.set` directly so that the key
/// strategy and the TTL bump remain the single source of truth.
pub fn save_stream(env: &Env, stream_id: u64, stream: &Stream) {
    let key = DataKey::Stream(stream_id);
    env.storage().persistent().set(&key, stream);
    bump_position_ttl(env, &key);
}

/// Removes a stream record from persistent storage.
///
/// **Key:** `DataKey::Stream(stream_id)` in persistent storage.
///
/// **TTL:** None, and none is possible — a removed entry has no TTL left to
/// extend. Removal *reclaims* the rent that [`save_stream`] was paying rather
/// than renewing it, so this path deliberately does not call `extend_ttl`.
///
/// Only ever called once a stream is terminal *and* fully settled, so the
/// record being dropped can no longer be read for a payout. Used by
/// [`close_stream`](crate::StreamContract::close_stream) to prune fully settled
/// streams; this is the only state-deleting path in the contract, and per ADR
/// 0001 rule 3 the caller is responsible for having already settled all funds —
/// after this returns, the record is gone and cannot be reloaded. Always use
/// this instead of calling `.remove` directly so the key strategy stays in one
/// place.
pub fn remove_stream(env: &Env, stream_id: u64) {
    env.storage()
        .persistent()
        .remove(&DataKey::Stream(stream_id));
}

/// Returns the stream if it exists, `None` otherwise (used by read-only queries).
///
/// **Key:** `DataKey::Stream(stream_id)` in persistent storage.
///
/// **TTL:** No bump. As with [`load_stream`], renewal comes from the
/// [`save_stream`] that typically follows in the same invocation.
///
/// `None` covers three distinct cases that are deliberately not distinguished:
/// the key is absent, the stored value is corrupt (an unrecognized field
/// count), or a legacy record failed to decode. Callers that need to tell
/// "no such stream" from "unreadable stream" cannot with this signature.
pub fn try_load_stream(env: &Env, stream_id: u64) -> Option<Stream> {
    let key = DataKey::Stream(stream_id);
    let raw: Option<Val> = env.storage().persistent().get(&key);

    // Reading as a bare `Val` is what makes the legacy fallback possible:
    // `storage.get::<_, Stream>` collapses "absent" and "undecodable" into the
    // same `None`, so the value is inspected before anything is decoded.
    let raw = raw?;

    bump_position_ttl(env, &key);

    match record_field_count(env, &raw)? {
        STREAM_FIELD_COUNT => Stream::try_from_val(env, &raw).ok(),
        LEGACY_STREAM_FIELD_COUNT => LegacyStream::try_from_val(env, &raw)
            .ok()
            .map(upgrade_legacy_stream),
        // An unknown shape is a corrupt record, not a legacy one. Reporting it
        // as "missing" would look like an empty stream to every caller.
        _ => None,
    }
}

/// Widens a legacy stream record to the current shape.
///
/// Pure in-memory transform: reads nothing from and writes nothing to storage.
/// The widened value is only persisted when some later [`save_stream`] call
/// stores it, which is the per-stream half of `migrate`'s lazy healing.
fn upgrade_legacy_stream(legacy: LegacyStream) -> Stream {
    Stream {
        sender: legacy.sender,
        recipient: legacy.recipient,
        token_address: legacy.token_address,
        rate_per_second: legacy.rate_per_second,
        deposited_amount: legacy.deposited_amount,
        withdrawn_amount: legacy.withdrawn_amount,
        start_time: legacy.start_time,
        last_update_time: legacy.last_update_time,
        // A pre-v2 record has no cliff, so gating stays off and accrual runs
        // from creation exactly as it did before the upgrade.
        cliff_time: None,
        is_active: legacy.is_active,
        paused: legacy.paused,
        paused_at: legacy.paused_at,
        status: legacy.status,
        // A stream with no schedule field predates step vesting: it is a
        // continuous drip by construction.
        schedule: VestingSchedule::Linear,
        // New fields default to no arbiter, no dispute, and non-allowance-based.
        arbiter: None,
        dispute_status: DisputeStatus::None,
        is_allowance_based: false,
    }
}

// ─── Protocol Config ──────────────────────────────────────────────────────────

/// Checks whether the protocol config has already been initialized.
///
/// **Key:** [`DataKey::ProtocolConfig`] in instance storage. Uses `has`, so it
/// does not decode the value — this is what makes it a valid guard in
/// [`StreamContract::initialize`](crate::StreamContract::initialize) without
/// paying for a decode of a possibly-absent entry.
///
/// **TTL:** No bump. An existence check on a live contract is not a signal
/// that the config is being kept warm, and bumping here would let a probe
/// renew config indefinitely.
pub fn config_exists(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::ProtocolConfig)
}

/// Loads the protocol config, transparently upgrading a pre-v2 record in memory.
///
/// **Key:** [`DataKey::ProtocolConfig`] in instance storage.
///
/// **TTL:** No bump. [`save_config`] is the renewing write path.
///
/// An older deployment persisted a three-field [`LegacyProtocolConfig`]. A
/// `#[contracttype]` struct decodes field-by-field from a Soroban `Map`, so
/// reading the five-field [`ProtocolConfig`] out of a legacy record does not
/// fail cleanly — see [`record_field_count`]. Rather than bricking the contract
/// after an in-place code upgrade, the record's field count selects the legacy
/// shape and reports it with the safe defaults `is_protocol_paused: false` and
/// `emergency_guardian: None`.
///
/// The upgraded value is *not* written back here — `load_config` is read-only.
/// [`crate::StreamContract::migrate`] performs the actual persisted upgrade.
///
/// # Errors
/// - `NotInitialized` — no config present in either shape.
pub fn load_config(env: &Env) -> Result<ProtocolConfig, StreamError> {
    try_load_config(env).ok_or(StreamError::NotInitialized)
}

/// Reads the protocol config as an `Option`, tolerating the legacy shape.
///
/// **Key:** [`DataKey::ProtocolConfig`] in instance storage.
///
/// **TTL:** No bump.
///
/// Used both by the mandatory load path and by optional fee-collection logic.
pub fn try_load_config(env: &Env) -> Option<ProtocolConfig> {
    let raw: Option<Val> = env.storage().instance().get(&DataKey::ProtocolConfig);

    // See `record_field_count`: the shape must be known before a decode is
    // attempted, so a legacy record is never fed to the wider current struct.
    let raw = raw?;

    match record_field_count(env, &raw)? {
        CONFIG_FIELD_COUNT => ProtocolConfig::try_from_val(env, &raw).ok(),
        LEGACY_CONFIG_FIELD_COUNT => {
            LegacyProtocolConfig::try_from_val(env, &raw)
                .ok()
                .map(|legacy| ProtocolConfig {
                    admin: legacy.admin,
                    treasury: legacy.treasury,
                    fee_rate_bps: legacy.fee_rate_bps,
                    is_protocol_paused: false,
                    emergency_guardian: None,
                })
        }
        _ => None,
    }
}

/// Persists the protocol config.
///
/// **Key:** [`DataKey::ProtocolConfig`] in instance storage.
///
/// **TTL:** Bumps the shared instance entry to [`INSTANCE_BUMP_AMOUNT`] ledgers
/// when it has fallen below [`INSTANCE_LIFETIME_THRESHOLD`], renewing every
/// instance-backed key at once.
///
/// This is also the function that *materializes* an in-memory legacy upgrade:
/// [`load_config`] and [`try_load_config`] only default the missing fields, so
/// without a write through here a pre-v2 record would stay legacy forever.
pub fn save_config(env: &Env, config: &ProtocolConfig) {
    env.storage()
        .instance()
        .set(&DataKey::ProtocolConfig, config);
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

// ─── State Schema Versioning ──────────────────────────────────────────────────

/// Reads the persisted state schema version.
///
/// **Key:** [`DataKey::ContractVersion`] in instance storage.
///
/// **TTL:** No bump.
///
/// `0` means the state was written before versioning existed and still uses the
/// legacy layout. Note that an absent key and a stored `0` are
/// indistinguishable here, which is intentional: both mean "use the legacy
/// path".
pub fn get_contract_version(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get::<DataKey, u32>(&DataKey::ContractVersion)
        .unwrap_or(0)
}

/// Persists the state schema version.
///
/// **Key:** [`DataKey::ContractVersion`] in instance storage.
///
/// **TTL:** No bump. Only [`save_config`] and [`next_stream_id`] renew the shared
/// instance entry, and every caller of this function ([`migrate`](crate::StreamContract::migrate)
/// and [`initialize`](crate::StreamContract::initialize)) also calls
/// [`save_config`] in the same invocation, so the version rides along on that
/// bump rather than needing its own.
pub fn save_contract_version(env: &Env, version: u32) {
    env.storage()
        .instance()
        .set(&DataKey::ContractVersion, &version);
}

// ─── Executable Hash Tracking ─────────────────────────────────────────────────

/// Reads the executable hash recorded by the most recent `upgrade`.
///
/// **Key:** [`DataKey::ContractWasmHash`] in instance storage.
///
/// **TTL:** No bump.
///
/// Returns `BytesN::zero` when the contract has never been upgraded in place,
/// since the host offers no way to read the live executable. An absent key and
/// a stored zero hash are therefore indistinguishable, which is why the zero
/// value is not a valid recorded hash.
pub fn get_recorded_wasm_hash(env: &Env) -> soroban_sdk::BytesN<32> {
    env.storage()
        .instance()
        .get::<DataKey, soroban_sdk::BytesN<32>>(&DataKey::ContractWasmHash)
        .unwrap_or_else(|| soroban_sdk::BytesN::from_array(env, &[0u8; 32]))
}

/// Records the executable hash installed by an `upgrade`.
///
/// **Key:** [`DataKey::ContractWasmHash`] in instance storage.
///
/// **TTL:** No bump. Like [`save_contract_version`], this is a rare,
/// admin-authorized write that does not carry a renewal of its own; the
/// instance entry is kept alive by ordinary config and counter traffic.
pub fn save_recorded_wasm_hash(env: &Env, hash: &soroban_sdk::BytesN<32>) {
    env.storage()
        .instance()
        .set(&DataKey::ContractWasmHash, hash);
}
