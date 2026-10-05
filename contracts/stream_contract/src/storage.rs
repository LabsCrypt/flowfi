use soroban_sdk::Env;

/// Minimum ledgers remaining before a persistent entry is renewed.
pub const PERSISTENT_LIFETIME_THRESHOLD: u32 = 120_960;
/// Number of ledgers added when renewing persistent storage.
pub const PERSISTENT_BUMP_AMOUNT: u32 = 518_400;
/// Minimum ledgers remaining before instance storage is renewed.
pub const INSTANCE_LIFETIME_THRESHOLD: u32 = 120_960;
/// Number of ledgers added when renewing instance storage.
pub const INSTANCE_BUMP_AMOUNT: u32 = 518_400;

use crate::errors::StreamError;
use crate::types::{DataKey, ProtocolConfig, Stream};

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

/// Loads a stream by ID from persistent storage.
///
/// Returns `StreamNotFound` if no entry exists, keeping error handling
/// central and preventing duplicated `match storage.get(...)` patterns.
pub fn load_stream(env: &Env, stream_id: u64) -> Result<Stream, StreamError> {
    let key = DataKey::Stream(stream_id);
    let stream = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(StreamError::StreamNotFound)?;
    env.storage().persistent().extend_ttl(
        &key,
        PERSISTENT_LIFETIME_THRESHOLD,
        PERSISTENT_BUMP_AMOUNT,
    );
    Ok(stream)
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
    let key = DataKey::Stream(stream_id);
    let stream = env.storage().persistent().get(&key);
    if stream.is_some() {
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );
    }
    stream
}

// ─── Protocol Config ──────────────────────────────────────────────────────────

/// Checks whether the protocol config has already been initialized.
pub fn config_exists(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::ProtocolConfig)
}

/// Loads the protocol config.
///
/// Returns `NotInitialized` if `initialize` has not been called yet.
pub fn load_config(env: &Env) -> Result<ProtocolConfig, StreamError> {
    env.storage()
        .instance()
        .get(&DataKey::ProtocolConfig)
        .ok_or(StreamError::NotInitialized)
        .inspect(|_| {
            env.storage()
                .instance()
                .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        })
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

/// Reads the protocol config as an `Option` (returns `None` if unset).
/// Used by optional fee-collection logic.
pub fn try_load_config(env: &Env) -> Option<ProtocolConfig> {
    let config = env.storage().instance().get(&DataKey::ProtocolConfig);
    if config.is_some() {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
    }
    config
}
