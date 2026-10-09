//! One device: its OpenMLS state, its signature key, the epoch keys it has learnt.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Mutex;

use openmls::group::{JoinBuilder, MlsGroup, ProcessedWelcome, StagedWelcome};
use openmls::schedule::{ExternalPsk, PreSharedKeyId, Psk};
use openmls::treesync::LeafNodeParameters;
use openmls::prelude::{tls_codec::Deserialize as _, tls_codec::Serialize as _, *};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::{MemoryStorage, RustCrypto};
use openmls_traits::random::OpenMlsRand;
use sha2::{Digest, Sha256};

use crate::rules::{self, By, Facts, GroupMeta, Kind, RoomView};
use crate::seal::{self, ArchiveRow, Envelope, EpochKeyRow};
use crate::{hex, Gid, Key, SigKey, CS, EXT_META, LABEL_ARCHIVE, LABEL_CONTENT};

/// Randomness: the operating system's, or a stream derived from a seed. The second
/// is what lets a recovery member's key package be re-made from the recovery code.
pub struct Rand {
    det: Option<Mutex<(Vec<u8>, u64)>>,
    os: RustCrypto,
}

impl Rand {
    fn det_bytes(&self, n: usize) -> Option<Vec<u8>> {
        let mut st = self.det.as_ref()?.lock().unwrap();
        let mut out = Vec::with_capacity(n + 32);
        while out.len() < n {
            let mut h = Sha256::new();
            h.update(&st.0);
            h.update(st.1.to_be_bytes());
            st.1 += 1;
            out.extend(h.finalize());
        }
        out.truncate(n);
        Some(out)
    }
}

impl OpenMlsRand for Rand {
    type Error = <RustCrypto as OpenMlsRand>::Error;
    fn random_array<const N: usize>(&self) -> Result<[u8; N], Self::Error> {
        match self.det_bytes(N) {
            Some(v) => Ok(v.try_into().unwrap()),
            None => self.os.random_array(),
        }
    }
    fn random_vec(&self, len: usize) -> Result<Vec<u8>, Self::Error> {
        match self.det_bytes(len) {
            Some(v) => Ok(v),
            None => self.os.random_vec(len),
        }
    }
}

pub struct Prov {
    pub crypto: RustCrypto,
    pub rand: Rand,
    pub storage: MemoryStorage,
}

impl openmls_traits::OpenMlsProvider for Prov {
    type CryptoProvider = RustCrypto;
    type RandProvider = Rand;
    type StorageProvider = MemoryStorage;
    fn storage(&self) -> &MemoryStorage {
        &self.storage
    }
    fn crypto(&self) -> &RustCrypto {
        &self.crypto
    }
    fn rand(&self) -> &Rand {
        &self.rand
    }
}

/// What a device hands to the hub with a commit.
#[derive(Clone, Debug)]
pub struct Out {
    pub gid: Gid,
    /// the epoch the commit builds on
    pub epoch: u64,
    pub commit: Vec<u8>,
    pub welcome: Option<Vec<u8>>,
    pub group_info: Vec<u8>,
}

#[derive(Default, Clone)]
pub struct Change {
    /// serialized key packages
    pub adds: Vec<Vec<u8>>,
    pub removes: Vec<SigKey>,
    pub meta: Option<GroupMeta>,
    pub aad: Vec<u8>,
    /// an external PSK to inject: (id, value)
    pub psk: Option<(Vec<u8>, Vec<u8>)>,
}

pub struct Device {
    pub name: String,
    pub prov: Prov,
    pub signer: SignatureKeyPair,
    pub cred: CredentialWithKey,
    pub groups: HashMap<Gid, MlsGroup>,
    /// content keys by (group, epoch)
    pub keys: BTreeMap<(Gid, u64), Key>,
    /// the room's archive keys by epoch (human devices only)
    pub archive: BTreeMap<u64, Key>,
    pub room: Option<Gid>,
    /// how many past epochs OpenMLS keeps message secrets for
    pub max_past_epochs: usize,
}

pub fn caps() -> Capabilities {
    Capabilities::new(
        None,
        None,
        Some(&[ExtensionType::Unknown(EXT_META), ExtensionType::LastResort]),
        None,
        Some(&[CredentialType::Basic]),
    )
}

pub fn meta_ext(meta: &GroupMeta) -> Extension {
    Extension::Unknown(EXT_META, UnknownExtension(meta.to_bytes()))
}

/// The whole extension list of a group context. OpenMLS accepts a GroupContextExtensions
/// proposal with an unknown extension type only if a RequiredCapabilities extension
/// in the same list names that type; the proposal replaces the whole list.
pub fn context_exts(meta: &GroupMeta) -> Extensions<GroupContext> {
    Extensions::from_vec(vec![
        Extension::RequiredCapabilities(RequiredCapabilitiesExtension::new(
            &[ExtensionType::Unknown(EXT_META)],
            &[],
            &[CredentialType::Basic],
        )),
        meta_ext(meta),
    ])
    .unwrap()
}

pub fn meta_of(ctx: &GroupContext) -> Result<GroupMeta, String> {
    let e = ctx
        .extensions()
        .unknown(EXT_META)
        .ok_or("group without a Trommi statement")?;
    GroupMeta::from_bytes(&e.0)
}

/// The signature key a key package speaks for. Whoever adds a device compares it with
/// the key it expects: the hub hands out key packages and could hand out its own.
pub fn key_package_owner(kp: &[u8], crypto: &RustCrypto) -> Result<SigKey, String> {
    KeyPackageIn::tls_deserialize(&mut &kp[..])
        .map_err(|e| format!("key package unreadable: {e:?}"))?
        .validate(crypto, ProtocolVersion::Mls10)
        .map(|k| k.leaf_node().signature_key().as_slice().to_vec())
        .map_err(|e| format!("key package invalid: {e:?}"))
}

pub fn parse_msg(bytes: &[u8]) -> Result<MlsMessageIn, String> {
    MlsMessageIn::tls_deserialize(&mut &bytes[..]).map_err(|e| format!("not an MLS message: {e:?}"))
}

/// Reads what a commit does. Used by devices (on their group) and by the hub
/// (on the public state): the same facts, the same rules.
pub fn facts(gid: &[u8], meta: &GroupMeta, epoch: u64, members: &[Member], pm: &ProcessedMessage) -> Result<Facts, String> {
    let ProcessedMessageContent::StagedCommitMessage(staged) = pm.content() else {
        return Err("not a commit".into());
    };
    let key_at = |i: LeafNodeIndex| -> Result<SigKey, String> {
        members
            .iter()
            .find(|m| m.index == i)
            .map(|m| m.signature_key.clone())
            .ok_or_else(|| "leaf not in the tree".to_string())
    };
    let by = match pm.sender() {
        Sender::Member(i) => By::Member(key_at(*i)?),
        Sender::NewMemberCommit => By::External(
            staged
                .update_path_leaf_node()
                .ok_or("external commit without a leaf")?
                .signature_key()
                .as_slice()
                .to_vec(),
        ),
        _ => return Err("commit from an unexpected kind of sender".into()),
    };
    let mut f = Facts {
        gid: gid.to_vec(),
        meta: meta.clone(),
        epoch,
        members: members.iter().map(|m| m.signature_key.clone()).collect(),
        by,
        adds: vec![],
        removes: vec![],
        new_meta: None,
        aad: pm.aad().to_vec(),
        parent_members: None,
        unknown: 0,
    };
    for q in staged.queued_proposals() {
        match q.proposal() {
            Proposal::Add(a) => f.adds.push(a.key_package().leaf_node().signature_key().as_slice().to_vec()),
            Proposal::Remove(r) => f.removes.push(key_at(r.removed())?),
            Proposal::GroupContextExtensions(g) => {
                let e = g.extensions().unknown(EXT_META).ok_or("statement removed")?;
                f.new_meta = Some(GroupMeta::from_bytes(&e.0)?);
            }
            Proposal::Update(_) | Proposal::PreSharedKey(_) | Proposal::ExternalInit(_) => {}
            _ => f.unknown += 1,
        }
    }
    Ok(f)
}

impl Device {
    pub fn new(name: &str) -> Self {
        Self::build(name, None, SignatureKeyPair::new(SignatureScheme::ED25519).unwrap())
    }

    /// A device whose every key follows from a seed (the recovery member).
    pub fn from_seed(name: &str, seed: &[u8]) -> Self {
        let crypto = RustCrypto::default();
        let seed = Sha256::digest(seed);
        let signer = seal::signer_from_seed(&seal::kdf(&crypto, &seed, "trommi/v2/member-sign"));
        Self::build(name, Some(seal::kdf(&crypto, &seed, "trommi/v2/member-rand")), signer)
    }

    fn build(name: &str, seed: Option<Vec<u8>>, signer: SignatureKeyPair) -> Self {
        let cred = CredentialWithKey {
            credential: BasicCredential::new(name.as_bytes().to_vec()).into(),
            signature_key: signer.to_public_vec().into(),
        };
        Device {
            name: name.to_string(),
            prov: Prov {
                crypto: RustCrypto::default(),
                rand: Rand { det: seed.map(|s| Mutex::new((s, 0))), os: RustCrypto::default() },
                storage: MemoryStorage::default(),
            },
            signer,
            cred,
            groups: HashMap::new(),
            keys: BTreeMap::new(),
            archive: BTreeMap::new(),
            room: None,
            max_past_epochs: 0,
        }
    }

    /// From here on this device draws from the operating system. A device made from a
    /// seed must call this as soon as its key package is re-made: every later commit
    /// needs fresh randomness, or two recoveries from the same code would repeat it.
    pub fn fresh_randomness(&mut self) {
        self.prov.rand.det = None;
    }

    pub fn sig(&self) -> SigKey {
        self.signer.to_public_vec()
    }

    pub fn crypto(&self) -> &RustCrypto {
        &self.prov.crypto
    }

    pub fn key_package(&self, last_resort: bool) -> Vec<u8> {
        self.key_package_for(last_resort, None)
    }

    pub fn key_package_for(&self, last_resort: bool, not_after: Option<u64>) -> Vec<u8> {
        let mut b = KeyPackage::builder().leaf_node_capabilities(caps());
        if last_resort {
            b = b.mark_as_last_resort();
        }
        if let Some(s) = not_after {
            b = b.key_package_lifetime(Lifetime::init(0, s)); // fixed, so that the package can be re-made
        }
        b.build(CS, &self.prov, &self.signer, self.cred.clone())
            .unwrap()
            .key_package()
            .tls_serialize_detached()
            .unwrap()
    }

    fn join_config(&self) -> MlsGroupJoinConfig {
        MlsGroupJoinConfig::builder()
            .wire_format_policy(PURE_PLAINTEXT_WIRE_FORMAT_POLICY)
            .use_ratchet_tree_extension(true)
            .max_past_epochs(self.max_past_epochs)
            .build()
    }

    /// Founds a group with this device as its only member. Returns the GroupInfo
    /// (with the tree) for the hub.
    pub fn found(&mut self, gid: &[u8], meta: &GroupMeta) -> Vec<u8> {
        let cfg = MlsGroupCreateConfig::builder()
            .wire_format_policy(PURE_PLAINTEXT_WIRE_FORMAT_POLICY)
            .use_ratchet_tree_extension(true)
            .max_past_epochs(self.max_past_epochs)
            .ciphersuite(CS)
            .capabilities(caps())
            .with_group_context_extensions(context_exts(meta))
            .build();
        let g = MlsGroup::new_with_group_id(&self.prov, &self.signer, &cfg, GroupId::from_slice(gid), self.cred.clone())
            .expect("found group");
        let gi = g
            .export_group_info(&self.prov.crypto, &self.signer, true)
            .unwrap()
            .to_bytes()
            .unwrap();
        self.groups.insert(gid.to_vec(), g);
        if meta.kind == Kind::Room {
            self.room = Some(gid.to_vec());
        }
        self.record(gid);
        gi
    }

    pub fn group(&self, gid: &[u8]) -> &MlsGroup {
        self.groups.get(gid).expect("not in that group")
    }

    pub fn epoch(&self, gid: &[u8]) -> u64 {
        self.group(gid).epoch().as_u64()
    }

    pub fn meta(&self, gid: &[u8]) -> GroupMeta {
        meta_of(self.group(gid).public_group().group_context()).unwrap()
    }

    pub fn members(&self, gid: &[u8]) -> Vec<SigKey> {
        self.group(gid).members().map(|m| m.signature_key).collect()
    }

    /// The room as this human device sees it, from its own group state.
    pub fn room_view(&self) -> RoomView {
        let gid = self.room.clone().expect("not a room member");
        let meta = self.meta(&gid);
        RoomView {
            epoch: self.epoch(&gid),
            humans: self.members(&gid).into_iter().collect(),
            agents: meta.agents.iter().map(|a| crate::unhex(a)).collect(),
            recovery_sign: meta.recovery_sign.as_ref().map(|h| crate::unhex(h)),
            gid,
        }
    }

    /// The keys of a group's epoch through the standard exporter: (content key, archive key).
    fn export(&self, gid: &[u8], kind: Kind, from: impl Fn(&str) -> Vec<u8>) -> (Key, Option<Key>) {
        let _ = gid;
        match kind {
            Kind::Room => {
                let archive = from(LABEL_ARCHIVE);
                (seal::kdf(&self.prov.crypto, &archive, LABEL_CONTENT), Some(archive))
            }
            Kind::Session => (from(LABEL_CONTENT), None),
        }
    }

    /// Remembers the current epoch's keys. OpenMLS exports for the current epoch (and
    /// for a staged commit) only: a device that wants an old epoch's key keeps it itself.
    fn record(&mut self, gid: &[u8]) {
        let g = self.group(gid);
        if !g.is_active() {
            return;
        }
        let epoch = g.epoch().as_u64();
        let kind = self.meta(gid).kind;
        let (content, archive) = self.export(gid, kind, |l| g.export_secret(&self.prov.crypto, l, gid, 32).unwrap());
        self.keys.insert((gid.to_vec(), epoch), content);
        if let Some(a) = archive {
            self.archive.insert(epoch, a);
        }
    }

    /// The keys of the epoch a pending commit leads to, before the hub has accepted it.
    pub fn staged_keys(&self, gid: &[u8]) -> (Key, Option<Key>) {
        let g = self.group(gid);
        let kind = self.meta(gid).kind;
        match g.pending_commit() {
            Some(staged) => self.export(gid, kind, |l| staged.export_secret(&self.prov.crypto, l, gid, 32).unwrap()),
            // after an external commit OpenMLS hands back a group that already stands
            // in the new epoch: there is nothing pending
            None => self.export(gid, kind, |l| g.export_secret(&self.prov.crypto, l, gid, 32).unwrap()),
        }
    }

    /// Builds a commit and leaves it pending: nothing changes until `confirm`.
    pub fn commit(&mut self, gid: &[u8], change: Change) -> Result<Out, String> {
        let mut kps = vec![];
        for b in &change.adds {
            let kp = KeyPackageIn::tls_deserialize(&mut &b[..])
                .map_err(|e| format!("key package unreadable: {e:?}"))?
                .validate(&self.prov.crypto, ProtocolVersion::Mls10)
                .map_err(|e| format!("key package invalid: {e:?}"))?;
            kps.push(kp);
        }
        let mut psk_ids = vec![];
        if let Some((id, value)) = &change.psk {
            let pid = PreSharedKeyId::new(CS, &self.prov.rand, Psk::External(ExternalPsk::new(id.clone())))
                .map_err(|e| format!("{e:?}"))?;
            pid.store(&self.prov, value).map_err(|e| format!("{e:?}"))?;
            psk_ids.push(pid);
        }
        let g = self.groups.get_mut(gid).ok_or("not in that group")?;
        let epoch = g.epoch().as_u64();
        let idx: Vec<LeafNodeIndex> = g
            .members()
            .filter(|m| change.removes.contains(&m.signature_key))
            .map(|m| m.index)
            .collect();
        if idx.len() != change.removes.len() {
            return Err("a device to remove is not a member".into());
        }
        g.set_aad(change.aad.clone());
        let mut b = g
            .commit_builder()
            .propose_adds(kps)
            .propose_removals(idx)
            .force_self_update(true);
        if let Some(m) = &change.meta {
            b = b.propose_group_context_extensions(context_exts(m)).map_err(|e| format!("{e:?}"))?;
        }
        for pid in psk_ids {
            b = b.add_proposal(Proposal::PreSharedKey(Box::new(PreSharedKeyProposal::new(pid))));
        }
        let bundle = b
            .load_psks(&self.prov.storage)
            .map_err(|e| format!("{e:?}"))?
            .create_group_info(true)
            .use_ratchet_tree_extension(true)
            .build(&self.prov.rand, &self.prov.crypto, &self.signer, |_| true)
            .map_err(|e| format!("commit not built: {e:?}"))?
            .stage_commit(&self.prov)
            .map_err(|e| format!("{e:?}"))?;
        let (commit, welcome, gi) = bundle.into_contents();
        Ok(Out {
            gid: gid.to_vec(),
            epoch,
            commit: commit.to_bytes().unwrap(),
            welcome: welcome.map(|w| MlsMessageOut::from_welcome(w, ProtocolVersion::Mls10).to_bytes().unwrap()),
            group_info: MlsMessageOut::from(gi.expect("group info")).to_bytes().unwrap(),
        })
    }

    /// The hub accepted the pending commit.
    pub fn confirm(&mut self, gid: &[u8]) {
        let g = self.groups.get_mut(gid).unwrap();
        if g.pending_commit().is_some() {
            g.merge_pending_commit(&self.prov).expect("merge own commit");
        }
        if self.meta(gid).kind == Kind::Room {
            self.room = Some(gid.to_vec());
        }
        self.record(gid);
    }

    /// The hub refused the pending commit (another one won the epoch).
    pub fn abort(&mut self, gid: &[u8]) {
        let g = self.groups.get_mut(gid).unwrap();
        g.clear_pending_commit(&self.prov.storage).unwrap();
    }

    /// Checks a commit against Trommi's rules and merges it. `room`: the room's public
    /// state for a device that is not in the room group (an agent, following as observer);
    /// a human device uses its own room group.
    pub fn process(&mut self, gid: &[u8], commit: &[u8], room: Option<&RoomView>) -> Result<(), String> {
        let own_view = if room.is_none() && self.room.is_some() { Some(self.room_view()) } else { None };
        let room = room.or(own_view.as_ref());
        let meta = self.meta(gid);
        let parent_members = meta
            .parent
            .as_ref()
            .and_then(|p| self.groups.get(&crate::unhex(p)))
            .map(|g| g.members().map(|m| m.signature_key).collect::<Vec<_>>());
        let g = self.groups.get_mut(gid).ok_or("not in that group")?;
        let epoch = g.epoch().as_u64();
        let members: Vec<Member> = g.members().collect();
        let pm = parse_msg(commit)?
            .try_into_protocol_message()
            .map_err(|e| format!("{e:?}"))?;
        let processed = g.process_message(&self.prov, pm).map_err(|e| format!("MLS refused: {e:?}"))?;
        if matches!(processed.content(), ProcessedMessageContent::OwnPendingCommit) {
            g.merge_pending_commit(&self.prov).map_err(|e| format!("{e:?}"))?;
            self.record(gid);
            return Ok(());
        }
        let mut f = facts(gid, &meta, epoch, &members, &processed)?;
        f.parent_members = parent_members;
        let placeholder;
        let room = match room {
            Some(r) => r,
            None => {
                placeholder = RoomView { gid: vec![], epoch: 0, humans: BTreeSet::new(), agents: BTreeSet::new(), recovery_sign: None };
                &placeholder
            }
        };
        rules::check(&f, room, &self.prov.crypto)?;
        let ProcessedMessageContent::StagedCommitMessage(staged) = processed.into_content() else {
            unreachable!()
        };
        g.merge_staged_commit(&self.prov, *staged).map_err(|e| format!("{e:?}"))?;
        self.record(gid);
        Ok(())
    }

    /// Opens a Welcome without joining yet, so that the group can be checked first.
    pub fn stage_welcome(&self, welcome: &[u8]) -> Result<StagedWelcome, String> {
        let MlsMessageBodyIn::Welcome(w) = parse_msg(welcome)?.extract() else {
            return Err("not a Welcome".into());
        };
        StagedWelcome::new_from_welcome(&self.prov, &self.join_config(), w, None).map_err(|e| format!("Welcome refused: {e:?}"))
    }

    /// Trommi's check of a session group a human device is welcomed into.
    pub fn check_welcome(&self, staged: &StagedWelcome) -> Result<(), String> {
        let meta = meta_of(staged.group_context())?;
        if meta.kind != Kind::Session {
            return Ok(());
        }
        let room = self.room_view();
        if meta.room != hex(&room.gid) {
            return Err("session group of another room".into());
        }
        let members: Vec<SigKey> = staged.members().map(|m| m.signature_key).collect();
        if let Some(missing) = room.humans.iter().find(|h| !members.contains(h)) {
            return Err(format!("the group leaves out human device {}", &hex(missing)[..8]));
        }
        let sender = staged
            .welcome_sender()
            .map_err(|e| format!("{e:?}"))?
            .signature_key()
            .as_slice()
            .to_vec();
        if room.humans.contains(&sender) {
            if meta.parent.is_none() {
                if let Some(x) = members.iter().find(|m| !room.humans.contains(*m) && !room.agents.contains(*m)) {
                    return Err(format!("member {} is neither a human device nor an enrolled agent", &hex(x)[..8]));
                }
            }
            return Ok(());
        }
        // welcomed by an agent: only a helper it founded under a session it is in
        let parent = meta.parent.as_ref().ok_or("an agent founds helper groups only")?;
        if meta.founder != hex(&sender) {
            return Err("welcomed by an agent that did not found the group".into());
        }
        let parent_group = self
            .groups
            .get(&crate::unhex(parent))
            .ok_or("helper of a session this device does not know")?;
        let pmeta = meta_of(parent_group.public_group().group_context())?;
        if pmeta.kind != Kind::Session || pmeta.room != meta.room {
            return Err("the parent is not a session of this room".into());
        }
        if !parent_group.members().any(|m| m.signature_key == sender) {
            return Err("helper founded by a device that is not a member of the parent session".into());
        }
        if staged.group_context().epoch().as_u64() != 1 {
            return Err("an agent welcomes human devices in the founding commit only".into());
        }
        Ok(())
    }

    /// The same, without checking the lifetimes of the leaves in the Welcome's tree
    /// against today's clock: needed to join from a Welcome that is old.
    pub fn stage_old_welcome(&self, welcome: &[u8]) -> Result<StagedWelcome, String> {
        let MlsMessageBodyIn::Welcome(w) = parse_msg(welcome)?.extract() else {
            return Err("not a Welcome".into());
        };
        let processed = ProcessedWelcome::new_from_welcome(&self.prov, &self.join_config(), w).map_err(|e| format!("Welcome refused: {e:?}"))?;
        JoinBuilder::new(&self.prov, processed)
            .skip_lifetime_validation()
            .build()
            .map_err(|e| format!("Welcome refused: {e:?}"))
    }

    /// Stores an external PSK, so that a commit or Welcome that names it can be processed.
    pub fn store_psk(&self, id: &[u8], value: &[u8]) {
        PreSharedKeyId::new(CS, &self.prov.rand, Psk::External(ExternalPsk::new(id.to_vec())))
            .unwrap()
            .store(&self.prov, value)
            .unwrap();
    }

    /// Bytes of this device's OpenMLS state (the in-memory key-value store).
    pub fn state_bytes(&self) -> usize {
        self.prov.storage.values.read().unwrap().iter().map(|(k, v)| k.len() + v.len()).sum()
    }

    pub fn accept(&mut self, staged: StagedWelcome) -> Gid {
        let g = staged.into_group(&self.prov).expect("join");
        let gid = g.group_id().as_slice().to_vec();
        let kind = meta_of(g.public_group().group_context()).unwrap().kind;
        self.groups.insert(gid.clone(), g);
        if kind == Kind::Room {
            self.room = Some(gid.clone());
        }
        self.record(&gid);
        gid
    }

    pub fn join(&mut self, welcome: &[u8]) -> Result<Gid, String> {
        let staged = self.stage_welcome(welcome)?;
        if self.room.is_some() {
            self.check_welcome(&staged)?;
        }
        Ok(self.accept(staged))
    }

    /// Joins by external commit from the group's public GroupInfo. Pending until `confirm`.
    pub fn external_join(&mut self, group_info: &[u8], aad: Vec<u8>) -> Result<Out, String> {
        let MlsMessageBodyIn::GroupInfo(vgi) = parse_msg(group_info)?.extract() else {
            return Err("not a GroupInfo".into());
        };
        let (g, bundle) = MlsGroup::external_commit_builder()
            .with_config(self.join_config())
            .with_aad(aad)
            .build_group(&self.prov, vgi, self.cred.clone())
            .map_err(|e| format!("external commit not started: {e:?}"))?
            // the new leaf must state that it understands the Trommi statement, or
            // OpenMLS refuses: LeafNodeValidation(UnsupportedExtensions)
            .leaf_node_parameters(LeafNodeParameters::builder().with_capabilities(caps()).build())
            .load_psks(&self.prov.storage)
            .map_err(|e| format!("{e:?}"))?
            .create_group_info(true)
            .use_ratchet_tree_extension(true)
            .build(&self.prov.rand, &self.prov.crypto, &self.signer, |_| true)
            .map_err(|e| format!("external commit not built: {e:?}"))?
            .finalize(&self.prov)
            .map_err(|e| format!("{e:?}"))?;
        let gid = g.group_id().as_slice().to_vec();
        // the group OpenMLS returns is already in the epoch AFTER the external commit
        let epoch = g.epoch().as_u64() - 1;
        let (commit, _w, gi) = bundle.into_contents();
        self.groups.insert(gid.clone(), g);
        Ok(Out {
            gid,
            epoch,
            commit: commit.to_bytes().unwrap(),
            welcome: None,
            group_info: MlsMessageOut::from(gi.expect("group info")).to_bytes().unwrap(),
        })
    }

    pub fn forget(&mut self, gid: &[u8]) {
        self.groups.remove(gid);
    }

    // ---- content ----

    pub fn key(&self, gid: &[u8], epoch: u64) -> Option<&Key> {
        self.keys.get(&(gid.to_vec(), epoch))
    }

    pub fn seal(&self, gid: &[u8], kind: &str, body: &[u8]) -> Envelope {
        let epoch = self.epoch(gid);
        let key = self.key(gid, epoch).expect("no key for the current epoch");
        Envelope::seal(&self.prov.crypto, key, gid, epoch, &self.sig(), kind, body)
    }

    pub fn open(&self, env: &Envelope) -> Result<Vec<u8>, String> {
        let key = self
            .key(&env.group, env.epoch)
            .ok_or_else(|| format!("no key for epoch {} of that group", env.epoch))?;
        env.open(&self.prov.crypto, key)
    }

    // ---- the archive (human devices) ----

    /// The archive row that goes with a pending room commit.
    /// The recovery key it is sealed to comes from the room statement this device holds
    /// (the new one, if the commit changes it), never from the hub. A device that does
    /// not hold the previous archive key cannot make the row: it must not commit.
    pub fn archive_row_for_pending(&self, new_meta: Option<&GroupMeta>) -> Result<ArchiveRow, String> {
        let gid = self.room.as_ref().unwrap();
        let (_, archive) = self.staged_keys(gid);
        let prev_epoch = self.epoch(gid);
        let prev = self.archive.get(&prev_epoch).ok_or("the previous archive key is missing")?;
        let own = self.meta(gid);
        let pk = new_meta.unwrap_or(&own).recovery_hpke.clone().ok_or("no recovery key in the room statement")?;
        Ok(seal::make_archive_row(&self.prov.crypto, gid, prev_epoch + 1, &archive.unwrap(), Some((prev_epoch, prev)), &crate::unhex(&pk)))
    }

    /// Walks back from every archive key this device holds through the hub's rows.
    /// Returns how many epochs were opened.
    pub fn walk_archive(&mut self, rows: &BTreeMap<u64, ArchiveRow>) -> usize {
        let gid = self.room.clone().unwrap();
        self.walk_archive_of(&gid, rows)
    }

    /// The same for a reader that is not a member (the holder of the recovery code).
    pub fn walk_archive_of(&mut self, gid: &[u8], rows: &BTreeMap<u64, ArchiveRow>) -> usize {
        let gid = gid.to_vec();
        let mut opened = 0;
        let mut at = self.archive.keys().next_back().copied();
        while let Some(e) = at {
            let Some(row) = rows.get(&e) else { break };
            let key = self.archive[&e].clone();
            if row.epoch != e {
                break;
            }
            match seal::open_link(&self.prov.crypto, &gid, row, &key) {
                Ok(Some((pe, pk))) => {
                    if self.archive.get(&pe).is_some_and(|known| *known != pk) {
                        break; // a row that contradicts a key this device derived itself
                    }
                    self.keys.insert((gid.clone(), pe), seal::kdf(&self.prov.crypto, &pk, LABEL_CONTENT));
                    self.archive.insert(pe, pk);
                    opened += 1;
                    at = Some(pe);
                }
                _ => break,
            }
        }
        opened
    }

    pub fn epoch_key_row(&self, gid: &[u8], epoch: u64, key: &[u8]) -> EpochKeyRow {
        let (re, archive) = self.archive.iter().next_back().expect("no archive key");
        seal::make_epoch_key_row(&self.prov.crypto, gid, epoch, key, *re, archive)
    }

    /// Opens the session epoch keys the hub holds, with the archive keys this device has.
    pub fn learn_epoch_keys<'a>(&mut self, rows: impl Iterator<Item = &'a EpochKeyRow>) -> usize {
        let mut n = 0;
        for r in rows {
            if let Some(a) = self.archive.get(&r.room_epoch) {
                if let Ok(k) = seal::open_epoch_key_row(&self.prov.crypto, r, a) {
                    // a key this device derived itself is never replaced by a row
                    self.keys.entry((r.group.clone(), r.epoch)).or_insert(k);
                    n += 1;
                }
            }
        }
        n
    }

    /// The hand-over for a group: every epoch key of it this device holds, before `before`.
    pub fn handover(&self, gid: &[u8], before: u64) -> Envelope {
        let keys: Vec<(u64, Key)> = self
            .keys
            .range((gid.to_vec(), 0)..(gid.to_vec(), before))
            .map(|((_, e), k)| (*e, k.clone()))
            .collect();
        self.seal(gid, "handover", &seal::handover_body(&keys))
    }

    pub fn take_handover(&mut self, env: &Envelope) -> Result<usize, String> {
        if env.kind != "handover" {
            return Err("not a hand-over".into());
        }
        // Who may send one (a human device; the envelope's signature says who sent it)
        // is the real envelope's business and not built here.
        let body = self.open(env)?;
        let keys = seal::parse_handover(&body)?;
        let n = keys.len();
        for (e, k) in keys {
            // only epochs BEFORE the hand-over's own, and never over a key already held
            if e < env.epoch {
                self.keys.entry((env.group.clone(), e)).or_insert(k);
            }
        }
        Ok(n)
    }
}
