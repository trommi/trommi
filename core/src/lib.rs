//! trommi-core: the one key core of all three clients (web through WASM, iOS through UniFFI, the connector directly).
//!
//! A feasibility proof, deliberately tiny. The edge of this crate carries byte arrays and plain structs only: no
//! OpenMLS type leaves it, so an OpenMLS upgrade changes this crate and nothing else. No network: bytes in, bytes out.
//! It does read the clock: OpenMLS stamps a key package with a lifetime and checks it against the current time when
//! the package is validated (`SystemTime::now`; in a browser `Date.now`), so a device with a wrong clock can refuse
//! a good key package.
//!
//! What this proof leaves open, on purpose: an operation's outgoing bytes (commit, Welcome) are not stored with the
//! state they belong to, so a crash between the store's write and the send loses them (the real core needs an outbox
//! in the same batch); stored entries are trusted (a damaged entry can panic inside OpenMLS's storage code); Trommi's
//! own rules for commits are not checked; if the system has no randomness to give when a device is created or
//! loaded, OpenMLS's provider panics instead of returning an error.
//!
//! MLS distributes keys only: content is sealed under a key exported from a group's epoch (`export_key`, the MLS
//! exporter) with AES-256-GCM (`seal`, `open`).
//!
//! Ciphersuite: MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519. Crypto provider: `openmls_rust_crypto` (pure Rust).

use std::collections::HashMap;

use openmls::prelude::tls_codec::{Deserialize as _, Serialize as _};
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;

mod store;
pub use store::{MemoryStore, StateStore, StoreError};

/// The one ciphersuite of this proof.
const SUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

/// The length of an exported key and of the key `seal` and `open` take.
pub const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;

/// The store key of this crate's own record (identity and signature public key). Every other key in the store is
/// one of OpenMLS's.
const DEVICE_RECORD: &[u8] = b"trommi-core/device/1";

/// Why a call failed. `message` is for logs, never for a decision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreError {
    pub kind: ErrorKind,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    /// The bytes handed in are not what the call expects (not a key package, not a Welcome, not a commit ...).
    Malformed,
    /// The group is not in this device's state.
    UnknownGroup,
    /// This device was removed from the group: no key of the current epoch for it.
    Evicted,
    /// The member named is not in the group.
    UnknownMember,
    /// MLS refused the operation (a failed check, a wrong epoch ...).
    Rejected,
    /// The body could not be opened: wrong key, wrong associated data or changed bytes.
    Unsealed,
    /// The state store failed. The operation did not happen: the state in memory is again what the store last took.
    Storage,
}

impl std::fmt::Display for CoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.message)
    }
}
impl std::error::Error for CoreError {}

fn err(kind: ErrorKind, message: impl std::fmt::Debug) -> CoreError {
    CoreError { kind, message: format!("{message:?}") }
}

/// What adding a member gives the caller to send: the commit for the members, the Welcome for the newcomer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Added {
    pub commit: Vec<u8>,
    pub welcome: Vec<u8>,
}

/// What processing a commit did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Processed {
    /// The group's epoch after the commit.
    pub epoch: u64,
    /// The commit removed this device: it holds no key from this epoch on.
    pub removed: bool,
}

/// One device: its signature key and its groups, all of it in the state store.
pub struct Device<S: StateStore> {
    provider: OpenMlsRustCrypto,
    signer: SignatureKeyPair,
    identity: Vec<u8>,
    store: S,
    /// What the store holds, to find the keys an operation changed.
    stored: HashMap<Vec<u8>, Vec<u8>>,
}

impl<S: StateStore> Device<S> {
    /// A new device identity (an Ed25519 signature key) in an empty store. `identity` is the name in its credential.
    pub fn create(identity: &[u8], store: S) -> Result<Self, CoreError> {
        if !store.load().map_err(|e| err(ErrorKind::Storage, e))?.is_empty() {
            return Err(err(ErrorKind::Rejected, "the store is not empty"));
        }
        let provider = OpenMlsRustCrypto::default();
        let signer = SignatureKeyPair::new(SUITE.signature_algorithm()).map_err(|e| err(ErrorKind::Rejected, e))?;
        signer.store(provider.storage()).map_err(|e| err(ErrorKind::Storage, e))?;
        let mut record = Vec::with_capacity(34 + identity.len());
        record.extend_from_slice(&(signer.public().len() as u16).to_be_bytes());
        record.extend_from_slice(signer.public());
        record.extend_from_slice(identity);
        provider.storage().values.write().unwrap().insert(DEVICE_RECORD.to_vec(), record);
        let mut device = Device { provider, signer, identity: identity.to_vec(), store, stored: HashMap::new() };
        device.flush()?;
        Ok(device)
    }

    /// The device a store holds, with all its groups.
    pub fn load(store: S) -> Result<Self, CoreError> {
        let entries = store.load().map_err(|e| err(ErrorKind::Storage, e))?;
        let stored: HashMap<Vec<u8>, Vec<u8>> = entries.into_iter().collect();
        let record = stored.get(DEVICE_RECORD).ok_or_else(|| err(ErrorKind::Malformed, "no device in the store"))?;
        if record.len() < 2 {
            return Err(err(ErrorKind::Malformed, "device record"));
        }
        let key_len = u16::from_be_bytes([record[0], record[1]]) as usize;
        if record.len() < 2 + key_len {
            return Err(err(ErrorKind::Malformed, "device record"));
        }
        let public = record[2..2 + key_len].to_vec();
        let identity = record[2 + key_len..].to_vec();
        let provider = OpenMlsRustCrypto::default();
        *provider.storage().values.write().unwrap() = stored.clone();
        let signer = SignatureKeyPair::read(provider.storage(), &public, SUITE.signature_algorithm())
            .ok_or_else(|| err(ErrorKind::Malformed, "no signature key in the store"))?;
        Ok(Device { provider, signer, identity, store, stored })
    }

    /// The device's public signature key: how other members name it.
    pub fn signature_key(&self) -> Vec<u8> {
        self.signer.public().to_vec()
    }

    /// The store, e.g. to copy what it holds.
    pub fn store(&self) -> &S {
        &self.store
    }

    /// The store, e.g. to take what it queued.
    pub fn store_mut(&mut self) -> &mut S {
        &mut self.store
    }

    /// A fresh key package: what another device needs to add this one to a group. Its private half stays in the
    /// store until the Welcome arrives; each key package is for one use.
    pub fn key_package(&mut self) -> Result<Vec<u8>, CoreError> {
        let result = (|| {
            let bundle = KeyPackage::builder()
                .build(SUITE, &self.provider, &self.signer, self.credential())
                .map_err(|e| err(ErrorKind::Rejected, e))?;
            bundle.key_package().tls_serialize_detached().map_err(|e| err(ErrorKind::Rejected, e))
        })();
        self.settle(result)
    }

    /// Found a group with this device as its only member.
    pub fn found_group(&mut self, group_id: &[u8]) -> Result<(), CoreError> {
        match self.group(group_id) {
            Err(CoreError { kind: ErrorKind::UnknownGroup, .. }) => {}
            Err(e) => return Err(e),
            Ok(_) => return Err(err(ErrorKind::Rejected, "the group exists")),
        }
        let config = MlsGroupCreateConfig::builder()
            .ciphersuite(SUITE)
            // Handshake messages readable: the hub orders commits and follows who is a member, never a key.
            .wire_format_policy(PURE_PLAINTEXT_WIRE_FORMAT_POLICY)
            // The Welcome carries the tree: a newcomer needs nothing else.
            .use_ratchet_tree_extension(true)
            .build();
        let result = MlsGroup::new_with_group_id(
            &self.provider,
            &self.signer,
            &config,
            GroupId::from_slice(group_id),
            self.credential(),
        )
        .map(|_| ())
        .map_err(|e| err(ErrorKind::Rejected, e));
        self.settle(result)
    }

    /// Add the device behind a key package. The group moves to a new epoch at once; the caller sends the commit to
    /// the other members and the Welcome to the newcomer.
    pub fn add_member(&mut self, group_id: &[u8], key_package: &[u8]) -> Result<Added, CoreError> {
        let mut group = self.group(group_id)?;
        let key_package = KeyPackageIn::tls_deserialize_exact(key_package)
            .map_err(|e| err(ErrorKind::Malformed, e))?
            .validate(self.provider.crypto(), ProtocolVersion::Mls10)
            .map_err(|e| err(ErrorKind::Malformed, e))?;
        let result = (|| {
            let (commit, welcome, _) = group
                .add_members(&self.provider, &self.signer, &[key_package])
                .map_err(|e| err(ErrorKind::Rejected, e))?;
            group.merge_pending_commit(&self.provider).map_err(|e| err(ErrorKind::Rejected, e))?;
            Ok(Added {
                commit: commit.tls_serialize_detached().map_err(|e| err(ErrorKind::Rejected, e))?,
                welcome: welcome.tls_serialize_detached().map_err(|e| err(ErrorKind::Rejected, e))?,
            })
        })();
        self.settle(result)
    }

    /// Remove the member with this signature key. The group moves to a new epoch at once; returns the commit.
    pub fn remove_member(&mut self, group_id: &[u8], signature_key: &[u8]) -> Result<Vec<u8>, CoreError> {
        let mut group = self.group(group_id)?;
        let index = group
            .members()
            .find(|m| m.signature_key == signature_key)
            .map(|m| m.index)
            .ok_or_else(|| err(ErrorKind::UnknownMember, "not a member"))?;
        let result = (|| {
            let (commit, _, _) = group
                .remove_members(&self.provider, &self.signer, &[index])
                .map_err(|e| err(ErrorKind::Rejected, e))?;
            group.merge_pending_commit(&self.provider).map_err(|e| err(ErrorKind::Rejected, e))?;
            commit.tls_serialize_detached().map_err(|e| err(ErrorKind::Rejected, e))
        })();
        self.settle(result)
    }

    /// Join the group a Welcome is for; returns the group's id. Uses up the key package the Welcome was made for.
    pub fn join(&mut self, welcome: &[u8]) -> Result<Vec<u8>, CoreError> {
        let message = MlsMessageIn::tls_deserialize_exact(welcome).map_err(|e| err(ErrorKind::Malformed, e))?;
        let MlsMessageBodyIn::Welcome(welcome) = message.extract() else {
            return Err(err(ErrorKind::Malformed, "not a Welcome"));
        };
        let config = MlsGroupJoinConfig::builder()
            .wire_format_policy(PURE_PLAINTEXT_WIRE_FORMAT_POLICY)
            .use_ratchet_tree_extension(true)
            .build();
        let result = (|| {
            let staged = StagedWelcome::new_from_welcome(&self.provider, &config, welcome, None)
                .map_err(|e| err(ErrorKind::Rejected, e))?;
            // OpenMLS files a group under its id and would overwrite one this device already has: whoever holds
            // one of our key packages could replace a group of ours with one of theirs.
            let group_id = staged.group_context().group_id().clone();
            match self.group(group_id.as_slice()) {
                Err(CoreError { kind: ErrorKind::UnknownGroup, .. }) => {}
                Err(e) => return Err(e),
                Ok(_) => return Err(err(ErrorKind::Rejected, "the group exists")),
            }
            if staged.group_context().ciphersuite() != SUITE {
                return Err(err(ErrorKind::Rejected, "another ciphersuite"));
            }
            let group = staged.into_group(&self.provider).map_err(|e| err(ErrorKind::Rejected, e))?;
            Ok(group.group_id().as_slice().to_vec())
        })();
        self.settle(result)
    }

    /// Take in another member's commit: checked by MLS, then merged.
    pub fn process_commit(&mut self, group_id: &[u8], commit: &[u8]) -> Result<Processed, CoreError> {
        let mut group = self.group(group_id)?;
        let message = MlsMessageIn::tls_deserialize_exact(commit)
            .map_err(|e| err(ErrorKind::Malformed, e))?
            .try_into_protocol_message()
            .map_err(|e| err(ErrorKind::Malformed, e))?;
        let result = (|| {
            let processed =
                group.process_message(&self.provider, message).map_err(|e| err(ErrorKind::Rejected, e))?;
            let ProcessedMessageContent::StagedCommitMessage(staged) = processed.into_content() else {
                return Err(err(ErrorKind::Malformed, "not a commit"));
            };
            // Here Trommi's own rules will be checked (who may add, remove, enrol) before the merge.
            group.merge_staged_commit(&self.provider, *staged).map_err(|e| err(ErrorKind::Rejected, e))?;
            Ok(Processed { epoch: group.epoch().as_u64(), removed: !group.is_active() })
        })();
        self.settle(result)
    }

    /// The group's current epoch.
    pub fn epoch(&self, group_id: &[u8]) -> Result<u64, CoreError> {
        Ok(self.group(group_id)?.epoch().as_u64())
    }

    /// The signature keys of the group's members, in tree order.
    pub fn members(&self, group_id: &[u8]) -> Result<Vec<Vec<u8>>, CoreError> {
        Ok(self.group(group_id)?.members().map(|m| m.signature_key).collect())
    }

    /// A 32-byte key of the group's current epoch (RFC 9420 section 8.5, the MLS exporter). Every member of the
    /// epoch derives the same key for the same label and context; nobody else can.
    pub fn export_key(&self, group_id: &[u8], label: &str, context: &[u8]) -> Result<[u8; KEY_LEN], CoreError> {
        let group = self.group(group_id)?;
        if !group.is_active() {
            return Err(err(ErrorKind::Evicted, "removed from the group"));
        }
        let key = group
            .export_secret(self.provider.crypto(), label, context, KEY_LEN)
            .map_err(|e| err(ErrorKind::Rejected, e))?;
        key.try_into().map_err(|_| err(ErrorKind::Rejected, "key length"))
    }

    fn credential(&self) -> CredentialWithKey {
        CredentialWithKey {
            credential: BasicCredential::new(self.identity.clone()).into(),
            signature_key: self.signer.public().into(),
        }
    }

    fn group(&self, group_id: &[u8]) -> Result<MlsGroup, CoreError> {
        MlsGroup::load(self.provider.storage(), &GroupId::from_slice(group_id))
            .map_err(|e| err(ErrorKind::Storage, e))?
            .ok_or_else(|| err(ErrorKind::UnknownGroup, "no such group"))
    }

    /// After an operation on OpenMLS's state: store what it changed. If the operation failed, or the store did not
    /// take the batch, the state in memory goes back to what the store holds: a refused commit or a failed write
    /// leaves no trace, and nothing the operation made is handed out.
    fn settle<T>(&mut self, result: Result<T, CoreError>) -> Result<T, CoreError> {
        let result = result.and_then(|value| self.flush().map(|()| value));
        if result.is_err() {
            *self.provider.storage().values.write().unwrap() = self.stored.clone();
        }
        result
    }

    /// Hand the store every key the last operation changed or removed, as one batch. The store's contract is all or
    /// nothing: after an error nothing of the batch is stored.
    fn flush(&mut self) -> Result<(), CoreError> {
        let now = self.provider.storage().values.read().unwrap().clone();
        let put: Vec<(Vec<u8>, Vec<u8>)> = now
            .iter()
            .filter(|(k, v)| self.stored.get(*k) != Some(*v))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let delete: Vec<Vec<u8>> = self.stored.keys().filter(|k| !now.contains_key(*k)).cloned().collect();
        if put.is_empty() && delete.is_empty() {
            return Ok(());
        }
        self.store.apply(put, delete).map_err(|e| err(ErrorKind::Storage, e))?;
        self.stored = now;
        Ok(())
    }
}

/// Seal a body under a 32-byte key with AES-256-GCM. Returns nonce (12 bytes, random) ‖ ciphertext ‖ tag (16 bytes).
/// `aad` is authenticated, not hidden: the envelope header belongs there. The nonce comes straight from the system's
/// random source; if that fails, this returns an error.
pub fn seal(key: &[u8; KEY_LEN], aad: &[u8], body: &[u8]) -> Result<Vec<u8>, CoreError> {
    use aes_gcm::aead::{rand_core::RngCore as _, Aead as _, KeyInit as _, OsRng, Payload};
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.try_fill_bytes(&mut nonce).map_err(|e| err(ErrorKind::Rejected, e))?;
    let sealed = aes_gcm::Aes256Gcm::new(key.into())
        .encrypt((&nonce).into(), Payload { msg: body, aad })
        .map_err(|e| err(ErrorKind::Rejected, e))?;
    let mut out = Vec::with_capacity(NONCE_LEN + sealed.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// Open what `seal` made. Fails for a wrong key, other associated data or a single changed bit. Needs no randomness.
pub fn open(key: &[u8; KEY_LEN], aad: &[u8], sealed: &[u8]) -> Result<Vec<u8>, CoreError> {
    use aes_gcm::aead::{Aead as _, KeyInit as _, Payload};
    if sealed.len() < NONCE_LEN + TAG_LEN {
        return Err(err(ErrorKind::Malformed, "too short"));
    }
    let (nonce, ciphertext) = sealed.split_at(NONCE_LEN);
    aes_gcm::Aes256Gcm::new(key.into())
        .decrypt(nonce.into(), Payload { msg: ciphertext, aad })
        .map_err(|e| err(ErrorKind::Unsealed, e))
}
