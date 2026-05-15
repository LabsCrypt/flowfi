use soroban_sdk::{Address, Env, Vec};

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
    id
}

// ─── Stream CRUD ─────────────────────────────────────────────────────────────

/// Loads a stream by ID from persistent storage.
///
/// Returns `StreamNotFound` if no entry exists, keeping error handling
/// central and preventing duplicated `match storage.get(...)` patterns.
pub fn load_stream(env: &Env, stream_id: u64) -> Result<Stream, StreamError> {
    env.storage()
        .persistent()
        .get(&DataKey::Stream(stream_id))
        .ok_or(StreamError::StreamNotFound)
}

/// Persists a stream record in persistent storage.
///
/// Always use this instead of calling `.set` directly so that the key
/// strategy remains the single source of truth.
pub fn save_stream(env: &Env, stream_id: u64, stream: &Stream) {
    env.storage()
        .persistent()
        .set(&DataKey::Stream(stream_id), stream);
}

/// Loads the stream IDs owned by `sender` from persistent storage.
pub fn load_sender_stream_ids(env: &Env, sender: &Address) -> Vec<u64> {
    env.storage()
        .persistent()
        .get(&DataKey::SenderStreams(sender.clone()))
        .unwrap_or(Vec::new(env))
}

/// Persists the stream IDs owned by `sender`.
pub fn save_sender_stream_ids(env: &Env, sender: &Address, stream_ids: &Vec<u64>) {
    env.storage()
        .persistent()
        .set(&DataKey::SenderStreams(sender.clone()), stream_ids);
}

/// Appends a stream ID to the sender-owned history list.
pub fn append_sender_stream_id(env: &Env, sender: &Address, stream_id: u64) {
    let mut stream_ids = load_sender_stream_ids(env, sender);
    stream_ids.push_back(stream_id);
    save_sender_stream_ids(env, sender, &stream_ids);
}

/// Returns the stream if it exists, `None` otherwise (used by read-only queries).
pub fn try_load_stream(env: &Env, stream_id: u64) -> Option<Stream> {
    env.storage().persistent().get(&DataKey::Stream(stream_id))
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
}

/// Persists the protocol config.
pub fn save_config(env: &Env, config: &ProtocolConfig) {
    env.storage()
        .instance()
        .set(&DataKey::ProtocolConfig, config);
}

/// Reads the protocol config as an `Option` (returns `None` if unset).
/// Used by optional fee-collection logic.
pub fn try_load_config(env: &Env) -> Option<ProtocolConfig> {
    env.storage().instance().get(&DataKey::ProtocolConfig)
}
