//! The hub as observer of MLS groups (spec/v2.md 14.1): it follows every group's PUBLIC state from GroupInfo and
//! Commits with OpenMLS's `PublicGroup` and reads from it who is in a group and what a Commit does. It holds no
//! secret of any group: nothing in this module can derive or open one.
//!
//! Seam for the merge with `trommi-core`: the core does not export an observer yet. `Observer` is the small
//! surface the hub needs from it; `MlsObserver` implements it the way `proofs/keys/src/hub.rs` does. Once the core
//! has `observe`, `process` and the labelled helpers, `MlsObserver` becomes a thin call into it.

use std::collections::HashMap;

use openmls::group::{ProposalStore, PublicGroup};
use openmls::prelude::tls_codec::{Deserialize as _, Serialize as _};
use openmls::prelude::*;
use openmls_memory_storage::MemoryStorage;
use openmls_rust_crypto::RustCrypto;
use openmls_traits::crypto::OpenMlsCrypto;
use openmls_traits::types::SignatureScheme;

use crate::wire::{self, Reader, TrommiRoom, TrommiSession, Writer, EXT_ROOM, EXT_SESSION};

pub type Device = [u8; 32];

pub const SUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519;

/// Why the observer refuses something; each maps to one error code of the spec.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Refusal {
    /// the work for this call was not prepared on the state the transaction found: try again
    Busy,
    /// not parseable, not valid MLS on the public state, or outside the profile of section 3
    BadCommit(String),
    BadKeyPackage(String),
    BadFormat(String),
}

type Res<T> = Result<T, Refusal>;

fn bad(what: impl Into<String>) -> Refusal {
    Refusal::BadCommit(what.into())
}

/// The serialised public state of one group: tree, group context, interim transcript hash and confirmation tag,
/// as OpenMLS stores them. Public data only.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct GroupState(pub Vec<u8>);

/// What anyone can read from a group's public state at one epoch.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Snapshot {
    pub group_id: Vec<u8>,
    pub epoch: u64,
    /// the signature keys of the leaves, in leaf order
    pub leaves: Vec<Device>,
    pub room: Option<TrommiRoom>,
    pub session: Option<TrommiSession>,
    /// the TLS-encoded GroupContext: `room_state` is its RefHash, and a posted GroupInfo must carry exactly it
    pub context: Vec<u8>,
    pub confirmation_tag: Vec<u8>,
}

impl Snapshot {
    pub fn room_state(&self) -> [u8; 32] {
        wire::ref_hash("Trommi Room State", &self.context)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum By {
    Member(Device),
    /// a join from outside: the key of the leaf it brings
    External(Device),
}

impl By {
    pub fn device(&self) -> &Device {
        match self {
            By::Member(d) | By::External(d) => d,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Added {
    pub device: Device,
    /// RFC 9420 KeyPackageRef: what a Welcome names its receivers by
    pub key_package_ref: Vec<u8>,
}

/// What a Commit does, read from the Commit and the public state before and after it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct CommitFacts {
    pub by: By,
    pub adds: Vec<Added>,
    pub removes: Vec<Device>,
    pub changes_extensions: bool,
    pub has_path: bool,
    pub aad: Vec<u8>,
    pub before: Snapshot,
    pub after: Snapshot,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct KeyPackageFacts {
    pub device: Device,
    pub key_package_ref: Vec<u8>,
    pub last_resort: bool,
    /// the end of its lifetime, seconds since the Unix epoch
    pub not_after: u64,
}

pub trait Observer {
    /// Start following a group from a GroupInfo that carries the tree. Returns the state, what it shows and the
    /// leaf that signed the GroupInfo.
    fn open(&self, group_info: &[u8]) -> Res<(GroupState, Snapshot, Device)>;
    /// Verify a Commit on the public state and apply it. Nothing is written: the caller keeps the returned state
    /// only if its own rules pass.
    fn commit(&self, state: &GroupState, commit: &[u8]) -> Res<(GroupState, CommitFacts)>;
    /// The posted GroupInfo of a new epoch: signed by `signer`, with the tree and the external public key, and its
    /// group context and confirmation tag equal to the hub's own.
    fn check_group_info(&self, group_info: &[u8], expected: &Snapshot, signer: &Device) -> Res<()>;
    fn key_package(&self, bytes: &[u8]) -> Res<KeyPackageFacts>;
    /// The KeyPackageRefs a Welcome is for.
    fn welcome_receivers(&self, welcome: &[u8]) -> Res<Vec<Vec<u8>>>;
    /// Group and epoch of an application message (`PrivateMessage`); nothing else of it is readable.
    fn application_message(&self, bytes: &[u8]) -> Res<(Vec<u8>, u64)>;
    /// `SignWithLabel` verification under an Ed25519 key.
    fn verify(&self, key: &[u8], label: &str, content: &[u8], signature: &[u8]) -> bool;
}

pub const MAX_GROUP_INFO: usize = 96 * 1024;

#[derive(Default)]
pub struct MlsObserver {
    crypto: RustCrypto,
}

fn encode_state(storage: &MemoryStorage) -> GroupState {
    let values = storage.values.read().expect("storage lock");
    let mut rows: Vec<(&Vec<u8>, &Vec<u8>)> = values.iter().collect();
    rows.sort();
    let mut w = Writer::default();
    for (k, v) in rows {
        w.vec(k).vec(v);
    }
    GroupState(w.0)
}

fn decode_state(state: &GroupState) -> Res<MemoryStorage> {
    let mut map = HashMap::new();
    let mut r = Reader::new(&state.0);
    while r.position() < state.0.len() {
        let k = r
            .vec()
            .map_err(|_| bad("stored group state unreadable"))?
            .to_vec();
        let v = r
            .vec()
            .map_err(|_| bad("stored group state unreadable"))?
            .to_vec();
        map.insert(k, v);
    }
    let storage = MemoryStorage::default();
    *storage.values.write().expect("storage lock") = map;
    Ok(storage)
}

fn device_of(leaf_key: &[u8], credential: &Credential) -> Res<Device> {
    let key: Device = leaf_key
        .try_into()
        .map_err(|_| bad("a signature key that is not 32 bytes"))?;
    if credential.credential_type() != CredentialType::Basic
        || credential.serialized_content() != key
    {
        return Err(bad("a credential that is not the leaf's signature key"));
    }
    Ok(key)
}

/// Section 3: the capabilities of every leaf and KeyPackage, exactly: `mls10`, suite 0x0003, basic credentials,
/// the extensions 0xF001, 0xF002 and last_resort, default proposals.
fn check_capabilities(caps: &Capabilities) -> Res<()> {
    let mut extensions: Vec<u16> = caps.extensions().iter().map(|e| u16::from(*e)).collect();
    extensions.sort_unstable();
    let mut wanted = vec![EXT_ROOM, EXT_SESSION, u16::from(ExtensionType::LastResort)];
    wanted.sort_unstable();
    let fits = caps.versions() == [ProtocolVersion::Mls10]
        && caps.ciphersuites() == [VerifiableCiphersuite::from(SUITE)]
        && caps.credentials() == [CredentialType::Basic]
        && extensions == wanted
        && caps.proposals().is_empty();
    if fits {
        Ok(())
    } else {
        Err(bad(
            "a leaf whose capabilities are not those of the profile",
        ))
    }
}

/// The largest tree a group of the profile can have: 33 human devices, an agent device and 7 helper devices fit
/// in 64 leaves, 127 nodes.
const MAX_LEAVES: usize = 64;

fn snapshot_of(group: &PublicGroup) -> Res<Snapshot> {
    let ctx = group.group_context();
    if ctx.ciphersuite() != SUITE || ctx.protocol_version() != ProtocolVersion::Mls10 {
        return Err(bad("another suite or version"));
    }
    let mut leaves = Vec::new();
    for m in group.members() {
        leaves.push(device_of(&m.signature_key, &m.credential)?);
        check_capabilities(
            group
                .leaf(m.index)
                .ok_or_else(|| bad("a member without a leaf"))?
                .capabilities(),
        )?;
    }
    if leaves.len() > MAX_LEAVES {
        return Err(bad("more leaves than any group of the profile has"));
    }
    if ctx.extensions().iter().count() != 2 {
        return Err(bad(
            "a group context holds required_capabilities and one Trommi extension",
        ));
    }
    let ext = ctx.extensions();
    let room = match ext.unknown(EXT_ROOM) {
        Some(e) => Some(TrommiRoom::parse(&e.0).map_err(|m| bad(format!("TrommiRoom: {}", m.0)))?),
        None => None,
    };
    let session = match ext.unknown(EXT_SESSION) {
        Some(e) => {
            Some(TrommiSession::parse(&e.0).map_err(|m| bad(format!("TrommiSession: {}", m.0)))?)
        }
        None => None,
    };
    if room.is_some() == session.is_some() {
        return Err(bad("a group is a room group or a session group"));
    }
    let required = ctx
        .required_capabilities()
        .ok_or_else(|| bad("no required capabilities"))?;
    for wanted in [EXT_ROOM, EXT_SESSION] {
        if !required
            .extension_types()
            .contains(&ExtensionType::Unknown(wanted))
        {
            return Err(bad(
                "required capabilities do not name the Trommi extensions",
            ));
        }
    }
    Ok(Snapshot {
        group_id: ctx.group_id().as_slice().to_vec(),
        epoch: ctx.epoch().as_u64(),
        leaves,
        room,
        session,
        context: ctx
            .tls_serialize_detached()
            .map_err(|_| bad("group context"))?,
        confirmation_tag: group
            .confirmation_tag()
            .tls_serialize_detached()
            .map_err(|_| bad("confirmation tag"))?,
    })
}

fn message(bytes: &[u8]) -> Res<MlsMessageIn> {
    let mut rest = bytes;
    let msg = MlsMessageIn::tls_deserialize(&mut rest).map_err(|_| bad("not an MLS message"))?;
    if !rest.is_empty() {
        return Err(bad("bytes after the MLS message"));
    }
    Ok(msg)
}

/// The leaf index that signed a GroupInfo. OpenMLS keeps the field private, so it is read from the encoding: a
/// GroupInfo ends with `uint32 signer; opaque signature<V>`, and an Ed25519 signature is 64 bytes.
fn group_info_signer(bytes: &[u8]) -> Res<u32> {
    // a 64-byte vector has the two-byte length prefix 0x40 0x40
    let n = bytes.len();
    if n < 70 || bytes[n - 66..n - 64] != [0x40, 0x40] {
        return Err(bad("GroupInfo signature"));
    }
    Ok(u32::from_be_bytes(
        bytes[n - 70..n - 66].try_into().expect("four bytes"),
    ))
}

impl MlsObserver {
    fn read_group_info(&self, storage: &MemoryStorage, bytes: &[u8]) -> Res<(PublicGroup, Device)> {
        // A tree of the profile's size encodes in a few kB. The bound keeps a GroupInfo full of blank nodes from
        // being unpacked into a large tree before any other check.
        if bytes.len() > MAX_GROUP_INFO {
            return Err(bad(
                "a GroupInfo larger than any group of the profile needs",
            ));
        }
        let signer = group_info_signer(bytes)?;
        let MlsMessageBodyIn::GroupInfo(info) = message(bytes)?.extract() else {
            return Err(bad("not a GroupInfo"));
        };
        let tree = info
            .extensions()
            .ratchet_tree()
            .ok_or_else(|| bad("GroupInfo without the tree"))?
            .ratchet_tree()
            .clone();
        if info.extensions().external_pub().is_none() {
            return Err(bad("GroupInfo without external_pub"));
        }
        let (group, _) =
            PublicGroup::from_external(&self.crypto, storage, tree, info, ProposalStore::new())
                .map_err(|e| bad(format!("GroupInfo: {e:?}")))?;
        let leaf = group
            .leaf(LeafNodeIndex::new(signer))
            .ok_or_else(|| bad("GroupInfo signed by no leaf"))?;
        let device = device_of(leaf.signature_key().as_slice(), leaf.credential())?;
        Ok((group, device))
    }

    fn load(&self, state: &GroupState) -> Res<(MemoryStorage, PublicGroup)> {
        let storage = decode_state(state)?;
        // The group id is not known before loading: it is part of every storage key, so take it from the context.
        let group = load_any(&storage)?;
        Ok((storage, group))
    }
}

/// A `GroupState` holds exactly one group. Its id is needed to load it; it is kept as the first row.
const ID_KEY: &[u8] = b"trommi/group-id";

fn load_any(storage: &MemoryStorage) -> Res<PublicGroup> {
    let id = storage
        .values
        .read()
        .expect("storage lock")
        .get(ID_KEY)
        .cloned()
        .ok_or_else(|| bad("stored group state has no id"))?;
    PublicGroup::load(storage, &GroupId::from_slice(&id))
        .map_err(|e| bad(format!("stored group state: {e:?}")))?
        .ok_or_else(|| bad("stored group state incomplete"))
}

fn remember_id(storage: &MemoryStorage, group: &PublicGroup) {
    storage
        .values
        .write()
        .expect("storage lock")
        .insert(ID_KEY.to_vec(), group.group_id().as_slice().to_vec());
}

impl Observer for MlsObserver {
    fn open(&self, group_info: &[u8]) -> Res<(GroupState, Snapshot, Device)> {
        let storage = MemoryStorage::default();
        let (group, signer) = self.read_group_info(&storage, group_info)?;
        remember_id(&storage, &group);
        let snapshot = snapshot_of(&group)?;
        Ok((encode_state(&storage), snapshot, signer))
    }

    fn commit(&self, state: &GroupState, commit: &[u8]) -> Res<(GroupState, CommitFacts)> {
        let (storage, mut group) = self.load(state)?;
        let before = snapshot_of(&group)?;
        let members: Vec<Member> = group.members().collect();
        let key_at = |i: LeafNodeIndex| -> Res<Device> {
            let m = members
                .iter()
                .find(|m| m.index == i)
                .ok_or_else(|| bad("a leaf that is not in the tree"))?;
            device_of(&m.signature_key, &m.credential)
        };
        let msg = message(commit)?;
        // 3: handshake messages are PublicMessage, always.
        if msg.wire_format() != WireFormat::PublicMessage {
            return Err(bad("a Commit travels as PublicMessage"));
        }
        let protocol = msg
            .try_into_protocol_message()
            .map_err(|e| bad(format!("{e:?}")))?;
        if protocol.group_id().as_slice() != before.group_id {
            return Err(bad("a Commit of another group"));
        }
        let processed = group
            .process_message(&self.crypto, protocol)
            .map_err(|e| bad(format!("{e:?}")))?;
        let aad = processed.aad().to_vec();
        let sender = processed.sender().clone();
        let ProcessedMessageContent::StagedCommitMessage(staged) = processed.into_content() else {
            // 3: proposals only inside a Commit
            return Err(bad("not a Commit"));
        };
        let has_path = staged.update_path_leaf_node().is_some();
        let by = match sender {
            Sender::Member(i) => By::Member(key_at(i)?),
            Sender::NewMemberCommit => {
                let leaf = staged
                    .update_path_leaf_node()
                    .ok_or_else(|| bad("a join from outside without a leaf"))?;
                By::External(device_of(
                    leaf.signature_key().as_slice(),
                    leaf.credential(),
                )?)
            }
            _ => return Err(bad("a Commit from an unexpected kind of sender")),
        };
        if let Some(leaf) = staged.update_path_leaf_node() {
            device_of(leaf.signature_key().as_slice(), leaf.credential())?;
        }
        let (mut adds, mut removes, mut changes_extensions, mut external_init) =
            (Vec::new(), Vec::new(), false, 0);
        for queued in staged.queued_proposals() {
            if !matches!(queued.proposal_or_ref_type(), ProposalOrRefType::Proposal) {
                return Err(bad("a proposal by reference"));
            }
            match queued.proposal() {
                Proposal::Add(add) => {
                    let kp = add.key_package();
                    let device = device_of(
                        kp.leaf_node().signature_key().as_slice(),
                        kp.leaf_node().credential(),
                    )?;
                    let key_package_ref = kp
                        .hash_ref(&self.crypto)
                        .map_err(|_| bad("key package reference"))?
                        .as_slice()
                        .to_vec();
                    adds.push(Added {
                        device,
                        key_package_ref,
                    });
                }
                Proposal::Remove(remove) => removes.push(key_at(remove.removed())?),
                Proposal::GroupContextExtensions(_) => changes_extensions = true,
                Proposal::ExternalInit(_) => external_init += 1,
                // Update, PreSharedKey, ReInit, AppAck, custom and whatever a later version adds
                _ => return Err(bad("a proposal of a kind the profile does not allow")),
            }
        }
        // 3.4
        match &by {
            By::External(joiner) => {
                if external_init != 1
                    || !adds.is_empty()
                    || changes_extensions
                    || removes.len() > 1
                    || !has_path
                {
                    return Err(bad("a join from outside holds one ExternalInit, at most its own Remove, and a path"));
                }
                if removes.iter().any(|r| r != joiner) {
                    return Err(bad("a join from outside removes only its own old leaf"));
                }
            }
            By::Member(_) => {
                if external_init != 0 {
                    return Err(bad("ExternalInit from a member"));
                }
                let only_adds = !adds.is_empty() && removes.is_empty() && !changes_extensions;
                if !has_path && !only_adds {
                    return Err(bad("a Commit without a path holds only Adds"));
                }
            }
        }
        group
            .merge_commit(&storage, *staged)
            .map_err(|e| bad(format!("{e:?}")))?;
        let after = snapshot_of(&group)?;
        if after.epoch != before.epoch + 1 {
            return Err(bad("epoch"));
        }
        Ok((
            encode_state(&storage),
            CommitFacts {
                by,
                adds,
                removes,
                changes_extensions,
                has_path,
                aad,
                before,
                after,
            },
        ))
    }

    fn check_group_info(&self, group_info: &[u8], expected: &Snapshot, signer: &Device) -> Res<()> {
        let storage = MemoryStorage::default();
        let (group, signed_by) = self.read_group_info(&storage, group_info)?;
        let shown = snapshot_of(&group)?;
        if &signed_by != signer {
            return Err(bad("GroupInfo not signed by the committer"));
        }
        // The context holds group id, epoch, tree hash, transcript hash and extensions; OpenMLS checked the tree
        // in the GroupInfo against that tree hash.
        if shown.context != expected.context
            || shown.confirmation_tag != expected.confirmation_tag
            || shown.leaves != expected.leaves
        {
            return Err(bad("GroupInfo does not show the state after the Commit"));
        }
        Ok(())
    }

    fn key_package(&self, bytes: &[u8]) -> Res<KeyPackageFacts> {
        let fail = |what: &str| Refusal::BadKeyPackage(what.to_string());
        let MlsMessageBodyIn::KeyPackage(kp) = message(bytes)
            .map_err(|_| fail("not an MLS message"))?
            .extract()
        else {
            return Err(fail("not a KeyPackage"));
        };
        let kp = kp
            .validate(&self.crypto, ProtocolVersion::Mls10)
            .map_err(|e| Refusal::BadKeyPackage(format!("{e:?}")))?;
        if kp.ciphersuite() != SUITE {
            return Err(fail("another suite"));
        }
        let leaf = kp.leaf_node();
        let device = device_of(leaf.signature_key().as_slice(), leaf.credential())
            .map_err(|_| fail("credential"))?;
        check_capabilities(leaf.capabilities())
            .map_err(|_| fail("capabilities are not those of the profile"))?;
        Ok(KeyPackageFacts {
            device,
            key_package_ref: kp
                .hash_ref(&self.crypto)
                .map_err(|_| fail("reference"))?
                .as_slice()
                .to_vec(),
            last_resort: kp.last_resort(),
            not_after: kp.life_time().not_after(),
        })
    }

    fn welcome_receivers(&self, welcome: &[u8]) -> Res<Vec<Vec<u8>>> {
        let MlsMessageBodyIn::Welcome(w) = message(welcome)?.extract() else {
            return Err(bad("not a Welcome"));
        };
        if w.ciphersuite() != SUITE {
            return Err(bad("a Welcome of another suite"));
        }
        Ok(w.secrets()
            .iter()
            .map(|s| s.new_member().as_slice().to_vec())
            .collect())
    }

    fn application_message(&self, bytes: &[u8]) -> Res<(Vec<u8>, u64)> {
        let fail = |what: &str| Refusal::BadFormat(what.to_string());
        let msg = message(bytes).map_err(|_| fail("not an MLS message"))?;
        if msg.wire_format() != WireFormat::PrivateMessage {
            return Err(fail("an application message travels as PrivateMessage"));
        }
        let protocol = msg
            .try_into_protocol_message()
            .map_err(|_| fail("not a group message"))?;
        if protocol.content_type() != ContentType::Application {
            return Err(fail("not an application message"));
        }
        Ok((
            protocol.group_id().as_slice().to_vec(),
            protocol.epoch().as_u64(),
        ))
    }

    fn verify(&self, key: &[u8], label: &str, content: &[u8], signature: &[u8]) -> bool {
        key.len() == 32
            && signature.len() == 64
            && self
                .crypto
                .verify_signature(
                    SignatureScheme::ED25519,
                    &wire::sign_content(label, content),
                    key,
                    signature,
                )
                .is_ok()
    }
}

/// A plain Ed25519 signature (no label), as a passkey makes one.
pub fn ed25519_verify(key: &[u8], message: &[u8], signature: &[u8]) -> bool {
    key.len() == 32
        && signature.len() == 64
        && RustCrypto::default()
            .verify_signature(SignatureScheme::ED25519, message, key, signature)
            .is_ok()
}
