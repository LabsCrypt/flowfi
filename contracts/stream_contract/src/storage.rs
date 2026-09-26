use soroban_sdk::{Env, Map, Symbol, TryFromVal, Val};

/// Minimum ledgers remaining before a persistent entry is renewed.
pub const PERSISTENT_LIFETIME_THRESHOLD: u32 = 120_960;
/// Number of ledgers added when renewing persistent storage.
pub const PERSISTENT_BUMP_AMOUNT: u32 = 518_400;
/// Minimum ledgers remaining before instance storage is renewed.
pub const INSTANCE_LIFETIME_THRESHOLD: u32 = 120_960;
/// Number of ledgers added when renewing instance storage.
pub const INSTANCE_BUMP_AMOUNT: u32 = 518_400;

use crate::errors::StreamError;
use crate::types::{
    DataKey, LegacyProtocolConfig, LegacyStream, ProtocolConfig, Stream, VestingSchedule,
};

// ─── Version-Tolerant Decoding ────────────────────────────────────────────────

/// Field counts of the current and pre-v2 record shapes.
///
/// A `#[contracttype]` struct is stored as a host `Map` with one entry per field,
/// and decoding it walks the map positionally. The current shapes are described
/// here only so the two can be told apart before a decode is attempted.
const CONFIG_FIELD_COUNT: u32 = 5;
const LEGACY_CONFIG_FIELD_COUNT: u32 = 3;
const STREAM_FIELD_COUNT: u32 = 13;
const LEGACY_STREAM_FIELD_COUNT: u32 = 12;

/// Returns the number of fields in a stored record, or `None` if it is not a map.
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
/// Uses instance storage for the counter (O(1) access, singleton semantics).
/// IDs start at 1.
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

/// Loads a stream by ID from persistent storage, tolerating the legacy shape.
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
/// Always use this instead of calling `.set` directly so that the key
/// strategy remains the single source of truth.
pub fn save_stream(env: &Env, stream_id: u64, stream: &Stream) {
    let key = DataKey::Stream(stream_id);
    env.storage().persistent().set(&key, stream);
    env.storage().persistent().extend_ttl(
        &key,
        PERSISTENT_LIFETIME_THRESHOLD,
        PERSISTENT_BUMP_AMOUNT,
    );
}

/// Returns the stream if it exists, `None` otherwise (used by read-only queries).
pub fn try_load_stream(env: &Env, stream_id: u64) -> Option<Stream> {
    let raw: Option<Val> = env.storage().persistent().get(&DataKey::Stream(stream_id));

    // Reading as a bare `Val` is what makes the legacy fallback possible:
    // `storage.get::<_, Stream>` collapses "absent" and "undecodable" into the
    // same `None`, so the value is inspected before anything is decoded.
    let raw = raw?;

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
        is_active: legacy.is_active,
        paused: legacy.paused,
        paused_at: legacy.paused_at,
        status: legacy.status,
        // A stream with no schedule field predates step vesting: it is a
        // continuous drip by construction.
        schedule: VestingSchedule::Linear,
    }
}

// ─── Protocol Config ──────────────────────────────────────────────────────────

/// Checks whether the protocol config has already been initialized.
pub fn config_exists(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::ProtocolConfig)
}

/// Loads the protocol config, transparently upgrading a pre-v2 record in memory.
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
/// `0` means the state was written before versioning existed and still uses the
/// legacy layout.
pub fn get_contract_version(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get::<DataKey, u32>(&DataKey::ContractVersion)
        .unwrap_or(0)
}

/// Persists the state schema version.
pub fn save_contract_version(env: &Env, version: u32) {
    env.storage()
        .instance()
        .set(&DataKey::ContractVersion, &version);
}

// ─── Executable Hash Tracking ─────────────────────────────────────────────────

/// Reads the executable hash recorded by the most recent `upgrade`.
///
/// Returns `BytesN::zero` when the contract has never been upgraded in place,
/// since the host offers no way to read the live executable.
pub fn get_recorded_wasm_hash(env: &Env) -> soroban_sdk::BytesN<32> {
    env.storage()
        .instance()
        .get::<DataKey, soroban_sdk::BytesN<32>>(&DataKey::ContractWasmHash)
        .unwrap_or_else(|| soroban_sdk::BytesN::from_array(env, &[0u8; 32]))
}

/// Records the executable hash installed by an `upgrade`.
pub fn save_recorded_wasm_hash(env: &Env, hash: &soroban_sdk::BytesN<32>) {
    env.storage()
        .instance()
        .set(&DataKey::ContractWasmHash, hash);
}
