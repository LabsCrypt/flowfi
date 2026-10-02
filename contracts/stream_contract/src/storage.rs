use soroban_sdk::{Env, Map, Symbol, TryFromVal, Val};

/// Minimum ledgers remaining on the instance entry before it is renewed.
///
/// When the instance TTL falls to or below this threshold, any write that calls
/// `extend_ttl` will bump the TTL back up to `INSTANCE_BUMP_AMOUNT`. At ~6 s
/// per ledger this is roughly 8.5 days of remaining life before a renewal is
/// triggered.
pub const PERSISTENT_LIFETIME_THRESHOLD: u32 = 120_960;

/// Number of ledgers added to an instance entry when it is renewed.
///
/// Equivalent to roughly 365 days at ~6 s per ledger. Every write to instance
/// storage bumps the whole instance to this TTL so that all singleton keys
/// (counter, config, version, wasm hash) expire together and the renewal cost
/// is paid once per write.
pub const PERSISTENT_BUMP_AMOUNT: u32 = 518_400;

/// Minimum ledgers remaining on an instance entry before it is renewed.
///
/// Mirrors `PERSISTENT_LIFETIME_THRESHOLD`. Both thresholds are the same value
/// today so that the renewal policy is uniform across storage classes.
pub const INSTANCE_LIFETIME_THRESHOLD: u32 = 120_960;

/// Number of ledgers added to instance storage when it is renewed.
///
/// Mirrors `PERSISTENT_BUMP_AMOUNT`. Keeping these identical means a single
/// extend_ttl call on the instance covers all singletons for a full year.
pub const INSTANCE_BUMP_AMOUNT: u32 = 518_400;

use crate::errors::StreamError;
use crate::types::{
    DataKey, DisputeStatus, LegacyProtocolConfig, LegacyStream, ProtocolConfig, Stream,
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
/// # Storage
/// - **Key**: [`DataKey::StreamCounter`] — instance storage (singleton).
/// - **TTL bump**: extends the entire instance entry by [`INSTANCE_BUMP_AMOUNT`]
///   ledgers whenever the remaining TTL is below [`INSTANCE_LIFETIME_THRESHOLD`].
///
/// Instance storage is used because the counter is a single global value that
/// must be accessible with O(1) cost. IDs start at 1; a missing entry is treated
/// as 0 and immediately incremented before being saved.
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
/// # Storage
/// - **Key**: [`DataKey::Stream(stream_id)`][DataKey::Stream] — persistent storage.
/// - **TTL bump**: none — this is a read-only helper. TTL is only extended on
///   writes via [`save_stream`].
///
/// A pre-v2 record has no `schedule` field, so decoding it as the current
/// [`Stream`] fails. Rather than bricking escrowed funds after an in-place code
/// upgrade, fall back to [`LegacyStream`] and report it as the linear drip it
/// was created as. The upgraded record is not written back here — the next
/// `save_stream` for that ID persists the current shape, which is how
/// `migrate`'s lazy per-stream healing works.
///
/// # Errors
/// - [`StreamError::StreamNotFound`] — no entry exists in either shape.
pub fn load_stream(env: &Env, stream_id: u64) -> Result<Stream, StreamError> {
    try_load_stream(env, stream_id).ok_or(StreamError::StreamNotFound)
}

/// Persists a stream record in persistent storage.
///
/// # Storage
/// - **Key**: [`DataKey::Stream(stream_id)`][DataKey::Stream] — persistent storage.
/// - **TTL bump**: extends the *individual* stream entry by [`PERSISTENT_BUMP_AMOUNT`]
///   ledgers whenever its remaining TTL is below [`PERSISTENT_LIFETIME_THRESHOLD`].
///   Each stream has its own TTL; bumping one does not affect others.
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

/// Returns the stream if it exists, `None` otherwise.
///
/// # Storage
/// - **Key**: [`DataKey::Stream(stream_id)`][DataKey::Stream] — persistent storage.
/// - **TTL bump**: none — read-only. Call [`save_stream`] to renew the TTL.
///
/// Used by read-only queries and as the basis for [`load_stream`]. Reading the
/// raw [`Val`] before attempting a typed decode is what makes the legacy
/// fallback possible: `storage.get::<_, Stream>` collapses "absent" and
/// "undecodable" into the same `None`, losing the ability to distinguish a
/// corrupt record from a simply absent one.
///
/// Shape detection logic:
/// - [`STREAM_FIELD_COUNT`] fields → decode as current [`Stream`].
/// - [`LEGACY_STREAM_FIELD_COUNT`] fields → decode as [`LegacyStream`] and widen
///   via [`upgrade_legacy_stream`].
/// - Any other count → treated as corrupt; returns `None`.
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
        // New fields default to no arbiter, no dispute, and non-allowance-based.
        arbiter: None,
        dispute_status: DisputeStatus::None,
        is_allowance_based: false,
    }
}

// ─── Protocol Config ──────────────────────────────────────────────────────────

/// Returns `true` if the protocol config has already been written to instance storage.
///
/// # Storage
/// - **Key**: [`DataKey::ProtocolConfig`] — instance storage (singleton).
/// - **TTL bump**: none — presence check only; does not touch TTL.
///
/// Used by the `initialize` entrypoint to guard against double-initialization.
/// Calling `has` is cheaper than `get` because no deserialization is performed.
pub fn config_exists(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::ProtocolConfig)
}

/// Loads the protocol config, transparently upgrading a pre-v2 record in memory.
///
/// # Storage
/// - **Key**: [`DataKey::ProtocolConfig`] — instance storage (singleton).
/// - **TTL bump**: none — read-only. TTL is extended by [`save_config`] on every
///   write.
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
/// - [`StreamError::NotInitialized`] — no config present in either shape.
pub fn load_config(env: &Env) -> Result<ProtocolConfig, StreamError> {
    try_load_config(env).ok_or(StreamError::NotInitialized)
}

/// Reads the protocol config as an `Option`, tolerating the legacy three-field shape.
///
/// # Storage
/// - **Key**: [`DataKey::ProtocolConfig`] — instance storage (singleton).
/// - **TTL bump**: none — read-only.
///
/// Used both by the mandatory load path ([`load_config`]) and by optional
/// fee-collection logic that wants to skip silently when no config exists.
///
/// Shape detection logic:
/// - [`CONFIG_FIELD_COUNT`] fields → decode as current [`ProtocolConfig`].
/// - [`LEGACY_CONFIG_FIELD_COUNT`] fields → decode as [`LegacyProtocolConfig`]
///   and synthesize the missing fields with safe defaults.
/// - Any other count → treated as corrupt; returns `None`.
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

/// Persists the protocol config and renews the instance storage TTL.
///
/// # Storage
/// - **Key**: [`DataKey::ProtocolConfig`] — instance storage (singleton).
/// - **TTL bump**: extends the *entire* instance entry by [`INSTANCE_BUMP_AMOUNT`]
///   ledgers whenever the remaining TTL is below [`INSTANCE_LIFETIME_THRESHOLD`].
///   Because all singleton keys share a single instance ledger entry, this one
///   call renews the counter, config, version, and wasm-hash keys simultaneously.
pub fn save_config(env: &Env, config: &ProtocolConfig) {
    env.storage()
        .instance()
        .set(&DataKey::ProtocolConfig, config);
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

// ─── State Schema Versioning ──────────────────────────────────────────────────

/// Reads the persisted state schema version from instance storage.
///
/// # Storage
/// - **Key**: [`DataKey::ContractVersion`] — instance storage (singleton).
/// - **TTL bump**: none — read-only. TTL is extended by [`save_contract_version`].
///
/// The version is used by the `migrate` entrypoint to determine which upgrade
/// path to execute. A return value of `0` means the state was written before
/// versioning existed and still uses the legacy three-field config and
/// twelve-field stream layout.
pub fn get_contract_version(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get::<DataKey, u32>(&DataKey::ContractVersion)
        .unwrap_or(0)
}

/// Persists the state schema version.
///
/// # Storage
/// - **Key**: [`DataKey::ContractVersion`] — instance storage (singleton).
/// - **TTL bump**: none directly. The instance TTL is kept alive by the
///   surrounding `migrate` call which also invokes [`save_config`] (which does
///   bump the instance TTL). Standalone callers should renew the instance entry
///   separately if needed.
///
/// Called once per `migrate` invocation after all per-stream upgrades are
/// complete.
pub fn save_contract_version(env: &Env, version: u32) {
    env.storage()
        .instance()
        .set(&DataKey::ContractVersion, &version);
}

// ─── Executable Hash Tracking ─────────────────────────────────────────────────

/// Reads the executable hash recorded by the most recent `upgrade`.
///
/// # Storage
/// - **Key**: [`DataKey::ContractWasmHash`] — instance storage (singleton).
/// - **TTL bump**: none — read-only. TTL is extended by [`save_recorded_wasm_hash`].
///
/// The Soroban host exposes no getter for a contract's *live* executable hash,
/// so this value is written explicitly during every upgrade and serves as the
/// on-chain upgrade audit trail. Returns `BytesN::zero` when the contract has
/// never been upgraded in place (i.e., the key is absent).
pub fn get_recorded_wasm_hash(env: &Env) -> soroban_sdk::BytesN<32> {
    env.storage()
        .instance()
        .get::<DataKey, soroban_sdk::BytesN<32>>(&DataKey::ContractWasmHash)
        .unwrap_or_else(|| soroban_sdk::BytesN::from_array(env, &[0u8; 32]))
}

/// Records the executable hash installed by an `upgrade`.
///
/// # Storage
/// - **Key**: [`DataKey::ContractWasmHash`] — instance storage (singleton).
/// - **TTL bump**: none directly. The instance entry is kept alive by
///   [`save_contract_version`] or [`save_config`] which are called as part of
///   the same upgrade flow. Standalone callers should renew the instance entry
///   separately if needed.
///
/// Should be called immediately after `env.deployer().update_current_contract_wasm`
/// so the stored hash always reflects the live executable.
pub fn save_recorded_wasm_hash(env: &Env, hash: &soroban_sdk::BytesN<32>) {
    env.storage()
        .instance()
        .set(&DataKey::ContractWasmHash, hash);
}

// ─── Stream Deletion ──────────────────────────────────────────────────────────

/// Removes a stream record from persistent storage.
///
/// # Storage
/// - **Key**: [`DataKey::Stream(stream_id)`][DataKey::Stream] — persistent storage.
/// - **TTL bump**: none — the entry is deleted, so TTL is irrelevant. Soroban
///   refunds the rent reserve for the removed entry to the contract's balance.
///
/// Used to prune fully settled streams and reclaim storage rent. Callers are
/// responsible for verifying that the stream is in a terminal state before
/// invoking this function; no validation is performed here.
pub fn remove_stream(env: &Env, stream_id: u64) {
    let key = DataKey::Stream(stream_id);
    env.storage().persistent().remove(&key);
}
