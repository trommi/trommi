//! The vault: this installation's device (`trommi_core::device::Device`) over its journal, and beside it what the
//! connector keeps of stored content (spec/v2.md section 9): every sender's chain, the objects' states, the
//! registers, its own chain, the commands it acted on.
//!
//! **One write per operation.** Every method stages its changes; [`Vault::commit`] writes them as one record
//! (`store.rs`). The client commits before it sends or answers anything, so what an operation of the core left
//! behind and what the connector derived from it are stored together or not at all.
//!
//! **What stands in for the core here.** The core's device does groups and MLS messages; stored content and
//! joining by link are, in its own words, "being wired in". Until `Device` offers them, this file composes the
//! core's pure modules (`envelope`, `chain`, `objects`, `registers`) behind [`ContentDevice`], the one seam the
//! rest of the connector uses. Two things follow that go when the core's calls arrive, and are reported:
//!
//! - the device's signature key is read from the stored entry the core wrote it to ([`Vault::signing_key`]),
//!   because sealing an envelope, answering an invite and signing in need it and the device hands out none;
//! - what the content rules ask about a group's past ([`trommi_core::chain::GroupFacts`]) is answered from a
//!   ledger the vault keeps from the Commits it processed. The epochs before this device joined a group it
//!   learns as the trait asks, from the group's founding GroupInfo and its Commits, which the hub keeps
//!   ([`Vault::learn_past`]): they are followed with the core's observer against a room history that is itself
//!   followed from the room's founding and must arrive at the room state this device was invited at. Until
//!   that has happened for a group, nobody was a leaf of its earlier epochs as far as this device answers.
use crate::error::{Fault, Result};
use crate::store::{CoreStore, Journal, SIDE};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use trommi_core::chain::{
    self, ChainRecords, Chains, EpochEnd, GroupFacts, Head, Mode, OwnChain, Receipt, Role, Served,
};
use trommi_core::crypto::{Secret, SigningKey, SystemEntropy};
use trommi_core::device::Device;
use trommi_core::envelope::{Draft, Subject};
use trommi_core::ids::{DeviceId, GroupId, Hash32, RoomId};
use trommi_core::mls::observer::{Context, NoSessions, Observer};
use trommi_core::mls::profile::Cut;
use trommi_core::objects::{self, Decision, GateLog, Objects, OwnRecord};
use trommi_core::recovery::PublicRules;
use trommi_core::registers::{self, OwnIds, Registers};
use trommi_core::store::table;
use trommi_core::Error;

/// Where the core keeps the device's signature key: its device table, entry 0, the 32-byte seed. Read only by
/// [`Vault::signing_key`]; see the module's documentation.
const CORE_SEED_KEY: [u8; 2] = [table::DEVICE, 0];

const TAG_CHAINS: u8 = b'c';
const TAG_OBJECTS: u8 = b'o';
const TAG_REGISTERS: u8 = b'r';
const TAG_OWN_CHAIN: u8 = b'w';
const TAG_OWN_IDS: u8 = b'i';
const TAG_LEDGER: u8 = b'l';
const TAG_ACCEPTED: u8 = b'h';
const TAG_GATE: u8 = b'G';

/// The key of one of the connector's own entries: [`SIDE`], a tag, then the parts, each with its length so that
/// no key is the start of another.
pub fn side_key(tag: u8, parts: &[&[u8]]) -> Vec<u8> {
    let mut key = vec![SIDE, tag];
    for part in parts {
        key.push(part.len() as u8);
        key.extend_from_slice(part);
    }
    key
}

fn damaged(what: &str) -> Fault {
    Fault::new(
        "state-damaged",
        format!("the stored state does not read ({what})"),
    )
}

/// A role as the ledger stores it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
enum StoredRole {
    Human,
    Agent,
    Opener,
    Helper,
}

impl From<StoredRole> for Role {
    fn from(role: StoredRole) -> Self {
        match role {
            StoredRole::Human => Role::Human,
            StoredRole::Agent => Role::Agent,
            StoredRole::Opener => Role::Opener,
            StoredRole::Helper => Role::Helper,
        }
    }
}

/// What the vault knows of one group's past: the leaves and their roles per epoch from the epoch it joined at,
/// when each epoch ended, and the Cut of every device a Commit removed. Device ids and hashes are base64url.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Ledger {
    /// The first epoch the vault saw: the one it joined or founded the group at.
    first: u64,
    /// The lowest epoch whose leaves are known: `first`, or 0 once the group's past was learned.
    #[serde(default)]
    known_from: Option<u64>,
    /// When this device joined, by its clock.
    joined_at: u64,
    epochs: BTreeMap<u64, BTreeMap<String, StoredRole>>,
    /// Per ended epoch: when the vault processed the Commit that ended it, and that Commit's `time`.
    ends: BTreeMap<u64, (u64, u64)>,
    cuts: BTreeMap<String, (u64, String)>,
}

impl Ledger {
    /// The leaves of `epoch` with their roles; none for an epoch this device has neither seen nor learned
    /// (`Vault::learn_past`): it then answers as if the group stood before that epoch.
    fn roles(&self, epoch: u64) -> Option<&BTreeMap<String, StoredRole>> {
        self.epochs.get(&epoch)
    }
}

/// The content state of one group, each part in the core's stored form.
#[derive(Default)]
struct Content {
    chains: Chains,
    objects: Objects,
    registers: Registers,
    own: OwnChain,
    ids: OwnIds,
}

/// What the content rules ask about the groups, answered from the device and the ledgers.
struct Facts<'a> {
    device: &'a Device<CoreStore>,
    ledgers: &'a BTreeMap<GroupId, Ledger>,
}

impl GroupFacts for Facts<'_> {
    fn room(&self) -> RoomId {
        self.device.room().unwrap_or(RoomId::ZERO)
    }

    fn processed_epoch(&self, group: &GroupId) -> std::result::Result<Option<u64>, Error> {
        if !self.ledgers.contains_key(group) {
            return Ok(None);
        }
        match self.device.group(group) {
            Ok(summary) => Ok(Some(summary.epoch)),
            Err(Error::NotFound) => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn leaf_role(
        &self,
        group: &GroupId,
        epoch: u64,
        device: &DeviceId,
    ) -> std::result::Result<Option<Role>, Error> {
        Ok(self
            .ledgers
            .get(group)
            .and_then(|ledger| ledger.roles(epoch))
            .and_then(|roles| roles.get(&device.to_base64url()))
            .map(|role| (*role).into()))
    }

    fn seat(&self, group: &GroupId, epoch: u64) -> std::result::Result<Option<DeviceId>, Error> {
        let seat = self
            .ledgers
            .get(group)
            .and_then(|ledger| ledger.roles(epoch))
            .and_then(|roles| {
                roles
                    .iter()
                    .find(|(_, role)| matches!(role, StoredRole::Agent | StoredRole::Opener))
            })
            .and_then(|(device, _)| DeviceId::from_base64url(device).ok());
        Ok(seat)
    }

    fn cut(&self, group: &GroupId, device: &DeviceId) -> std::result::Result<Option<Head>, Error> {
        let Some((seq, hash)) = self
            .ledgers
            .get(group)
            .and_then(|ledger| ledger.cuts.get(&device.to_base64url()))
        else {
            return Ok(None);
        };
        Ok(Some(Head {
            seq: *seq,
            hash: Hash32::from_base64url(hash)
                .map_err(|_| Error::Storage("a stored Cut does not read".into()))?,
        }))
    }

    fn epoch_end(
        &self,
        group: &GroupId,
        epoch: u64,
    ) -> std::result::Result<Option<EpochEnd>, Error> {
        let Some(ledger) = self.ledgers.get(group) else {
            return Ok(None);
        };
        Ok(ledger
            .ends
            .get(&epoch)
            .map(|(processed_at, time)| EpochEnd {
                processed_at: *processed_at,
                time: *time,
            }))
    }

    fn is_stale(&self, group: &GroupId) -> std::result::Result<bool, Error> {
        match self.device.group(group) {
            Ok(summary) => Ok(!summary.disallowed.is_empty()),
            Err(Error::NotFound) => Ok(false),
            Err(error) => Err(error),
        }
    }

    fn is_human_now(&self, device: &DeviceId) -> std::result::Result<bool, Error> {
        Ok(self
            .device
            .room_history()
            .is_some_and(|history| history.newest().is_human(device)))
    }

    fn content_key(
        &self,
        group: &GroupId,
        epoch: u64,
    ) -> std::result::Result<Option<Secret<32>>, Error> {
        match self.device.content_key(group, epoch) {
            Ok(key) => Ok(Some(key)),
            Err(Error::NoKey | Error::NotFound) => Ok(None),
            Err(error) => Err(error),
        }
    }
}

/// The envelopes accepted so far, by their place: one stored hash per group, sender and number.
struct Accepted<'a>(&'a Journal);

fn accepted_key(group: &GroupId, sender: &DeviceId, seq: u64) -> Vec<u8> {
    side_key(
        TAG_ACCEPTED,
        &[group.as_bytes(), sender.as_bytes(), &seq.to_be_bytes()],
    )
}

impl ChainRecords for Accepted<'_> {
    fn accepted_hash(
        &self,
        group: &GroupId,
        sender: &DeviceId,
        seq: u64,
    ) -> std::result::Result<Option<Hash32>, Error> {
        match self.0.get(&accepted_key(group, sender, seq)) {
            None => Ok(None),
            Some(bytes) => Hash32::from_slice(&bytes)
                .map(Some)
                .map_err(|_| Error::Storage("a stored envelope hash does not read".into())),
        }
    }
}

/// What the hub keeps of a group's past, for [`Vault::learn_past`]: Commits with the `RecoveryAuth` stored beside
/// a join from outside, in the order of the group's log.
#[derive(Debug, Clone, Default)]
pub struct Past {
    /// The room group's GroupInfo of epoch 0.
    pub room_info: Vec<u8>,
    /// The room group's Commits.
    pub room_commits: Vec<(Vec<u8>, Option<Vec<u8>>)>,
    /// The group's GroupInfo of epoch 0.
    pub info: Vec<u8>,
    /// The group's Commits.
    pub commits: Vec<(Vec<u8>, Option<Vec<u8>>)>,
    /// The room's change number of each of the group's Commits, in the same order.
    pub changes: Vec<u64>,
    /// The GroupInfo the hub offers as the group's current one.
    pub current: Vec<u8>,
}

/// A register value an envelope set, as the model takes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegisterChange {
    /// The name.
    pub name: String,
    /// The device whose own value it is; none for a shared name.
    pub of: Option<DeviceId>,
    /// The value as JSON text; none for a deletion.
    pub value: Option<String>,
    /// Whether it is now the current value of the name.
    pub current: bool,
}

/// An envelope that took its place in its sender's chain, already applied to the vault's state.
#[derive(Debug)]
pub struct Taken {
    /// The core's receipt: the envelope, its hash, what became of it.
    pub receipt: Receipt,
    /// For a register envelope whose value was taken: the change.
    pub register: Option<RegisterChange>,
    /// For another device's `heads` (9.0.7): whether it names envelopes this device does not hold, and whether
    /// it names another envelope under a number this device holds.
    pub heads: Option<(bool, bool)>,
}

/// A new envelope of this device, sealed and numbered.
#[derive(Debug, Clone)]
pub struct Sealed {
    /// The envelope as it is posted.
    pub bytes: Vec<u8>,
    /// Its hash.
    pub hash: Hash32,
    /// Its number in this device's chain of the group.
    pub seq: u64,
    /// The epoch it was sealed in.
    pub epoch: u64,
}

/// Stored content as the connector needs it from the core: the calls `trommi_core::device::Device` does not
/// offer yet (see the module's documentation). [`Vault`] implements it on the core's pure modules; when the
/// device itself seals and receives envelopes, this trait is implemented by forwarding to it.
pub trait ContentDevice {
    /// Seals this device's next envelope in `group` and stages it with the chain state it leaves (13.2). The
    /// refusals are the core's (`chain::seal_next`): nothing is signed for what the hub would refuse.
    fn seal(&mut self, group: &GroupId, draft: &Draft, now_ms: u64) -> Result<Sealed>;

    /// The draft of a register envelope that sets `name` in `group` (9.3), with this device's id for the name
    /// and its next lamport.
    fn register_draft(&mut self, group: &GroupId, name: &str, value: Option<&str>)
        -> Result<Draft>;

    /// Runs the receiver's checks on an envelope from the hub (9.0.5) and, when it takes its place in the
    /// chain, applies and stages the chain's step, the object's transition and a register's value.
    fn receive(&mut self, bytes: &[u8], served: &Served, mode: Mode, now_ms: u64) -> Result<Taken>;

    /// The command gate (9.0.9) on a received envelope; an `Act` is staged as started before it is returned.
    fn gate(&mut self, receipt: &Receipt, own: &OwnRecord<'_>, now_ms: u64) -> Result<Decision>;

    /// Records that the command of the envelope `hash` had its effect.
    fn gate_finish(&mut self, hash: &Hash32) -> Result<()>;
}

/// The device, its journal and the content state. See the module's documentation.
pub struct Vault {
    journal: Journal,
    /// The core's device. Whoever calls it commits the vault before anything leaves.
    pub device: Device<CoreStore>,
    key: SigningKey,
    ledgers: BTreeMap<GroupId, Ledger>,
    content: BTreeMap<GroupId, Content>,
    gate: GateLog,
}

impl std::fmt::Debug for Vault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Vault({})", self.device.id().to_base64url())
    }
}

fn group_of_key(key: &[u8]) -> Option<GroupId> {
    // [SIDE, tag, len, group…]
    let len = *key.get(2)? as usize;
    GroupId::from_bytes(key.get(3..3 + len)?).ok()
}

impl Vault {
    /// A new device in an empty journal, written before this returns.
    pub fn create(journal: Journal) -> Result<Vault> {
        if !journal.is_empty() {
            return Err(damaged("a new device needs an empty state"));
        }
        let device = Device::create(journal.core_store(), Box::new(SystemEntropy))?;
        let mut vault = Self::around(journal, device)?;
        vault.commit()?;
        Ok(vault)
    }

    /// The device a journal holds. `state-damaged` when anything in it does not read: the human then
    /// reconnects the session; nothing is re-keyed here.
    pub fn open(journal: Journal) -> Result<Vault> {
        let device = Device::open(journal.core_store(), Box::new(SystemEntropy))
            .map_err(|error| damaged(&Fault::from(error).text()))?;
        Self::around(journal, device)
    }

    fn around(journal: Journal, device: Device<CoreStore>) -> Result<Vault> {
        let seed = journal
            .get(&CORE_SEED_KEY)
            .and_then(|seed| Secret::<32>::from_slice(&seed).ok())
            .ok_or_else(|| damaged("no device key"))?;
        let key = SigningKey::from_seed(seed);
        if key.public() != *device.id().as_bytes() {
            return Err(damaged("the device key is not the device's"));
        }
        let mut ledgers = BTreeMap::new();
        for (entry_key, value) in journal.scan(&[SIDE, TAG_LEDGER]) {
            let group = group_of_key(&entry_key).ok_or_else(|| damaged("a ledger's group"))?;
            let ledger: Ledger = serde_json::from_slice(&value).map_err(|_| damaged("a ledger"))?;
            ledgers.insert(group, ledger);
        }
        let mut content: BTreeMap<GroupId, Content> = BTreeMap::new();
        for tag in [
            TAG_CHAINS,
            TAG_OBJECTS,
            TAG_REGISTERS,
            TAG_OWN_CHAIN,
            TAG_OWN_IDS,
        ] {
            for (entry_key, value) in journal.scan(&[SIDE, tag]) {
                let group = group_of_key(&entry_key).ok_or_else(|| damaged("a group"))?;
                let state = content.entry(group).or_default();
                let read = match tag {
                    TAG_CHAINS => Chains::from_bytes(&value).map(|v| state.chains = v),
                    TAG_OBJECTS => Objects::from_bytes(&value).map(|v| state.objects = v),
                    TAG_REGISTERS => Registers::from_bytes(&value).map(|v| state.registers = v),
                    TAG_OWN_CHAIN => OwnChain::from_bytes(&value).map(|v| state.own = v),
                    _ => OwnIds::from_bytes(&value).map(|v| state.ids = v),
                };
                read.map_err(|_| damaged("a group's content state"))?;
            }
        }
        // A group's five parts are written together: one of them missing is damage, never a fresh start (an
        // empty own chain would sign number 1 again).
        for group in content.keys() {
            for tag in [
                TAG_CHAINS,
                TAG_OBJECTS,
                TAG_REGISTERS,
                TAG_OWN_CHAIN,
                TAG_OWN_IDS,
            ] {
                if journal.get(&side_key(tag, &[group.as_bytes()])).is_none() {
                    return Err(damaged("a group's content state is incomplete"));
                }
            }
        }
        for group in ledgers.keys() {
            if !content.contains_key(group) {
                return Err(damaged("a group without its content state"));
            }
        }
        let gate = match journal.get(&side_key(TAG_GATE, &[])) {
            Some(bytes) => GateLog::from_bytes(&bytes).map_err(|_| damaged("the command log"))?,
            None => GateLog::new(),
        };
        Ok(Vault {
            journal,
            device,
            key,
            ledgers,
            content,
            gate,
        })
    }

    /// The journal, for the connector's other entries.
    pub fn journal(&self) -> &Journal {
        &self.journal
    }

    /// This device's id.
    pub fn me(&self) -> DeviceId {
        self.device.id()
    }

    /// The device's signature key, for what the core's device does not sign itself yet: the Request of an
    /// invite and the sign-in to the hub. It never leaves the process and is never printed.
    pub fn signing_key(&self) -> &SigningKey {
        &self.key
    }

    /// Writes everything staged as one record.
    pub fn commit(&mut self) -> Result<()> {
        Ok(self.journal.commit()?)
    }

    fn facts(&self) -> Facts<'_> {
        Facts {
            device: &self.device,
            ledgers: &self.ledgers,
        }
    }

    fn stage_content(&mut self, group: &GroupId) -> Result<()> {
        let Some(state) = self.content.get(group) else {
            return Ok(());
        };
        let parts: [(u8, Vec<u8>); 5] = [
            (TAG_CHAINS, state.chains.to_bytes()?),
            (TAG_OBJECTS, state.objects.to_bytes()?),
            (TAG_REGISTERS, state.registers.to_bytes()?),
            (TAG_OWN_CHAIN, state.own.to_bytes()?),
            (TAG_OWN_IDS, state.ids.to_bytes()?),
        ];
        for (tag, bytes) in parts {
            self.journal.put(side_key(tag, &[group.as_bytes()]), bytes);
        }
        Ok(())
    }

    /// Whether the epochs of `group` before this device joined it are known (it founded the group, joined at
    /// its first epoch, or learned its past).
    pub fn past_known(&self, group: &GroupId) -> bool {
        self.ledgers
            .get(group)
            .is_some_and(|ledger| ledger.first == 0 || ledger.known_from == Some(0))
    }

    /// The epoch this device joined `group` at, if it knows the group.
    pub fn first_epoch(&self, group: &GroupId) -> Option<u64> {
        self.ledgers.get(group).map(|ledger| ledger.first)
    }

    /// The device a human addresses in `group` now: its agent leaf, or a helper session's opener.
    pub fn seat(&self, group: &GroupId) -> Option<DeviceId> {
        let epoch = self.device.group(group).ok()?.epoch;
        self.facts().seat(group, epoch).ok().flatten()
    }

    /// The current value of a register name in `group`, as JSON text.
    pub fn register(&self, group: &GroupId, name: &str) -> Option<String> {
        self.content
            .get(group)
            .and_then(|state| state.registers.get(name))
            .map(str::to_owned)
    }

    /// The value a device holds under one of the names of which each device has its own (`device/<id>`).
    pub fn register_of(&self, group: &GroupId, name: &str, device: &DeviceId) -> Option<String> {
        self.content
            .get(group)
            .and_then(|state| state.registers.get_of(name, device))
            .map(str::to_owned)
    }

    /// Every chain accepted in `group`, as the value of the `heads` register (9.0.7).
    pub fn heads_value(&self, group: &GroupId) -> Result<Option<String>> {
        match self.content.get(group) {
            Some(state) => Ok(Some(chain::heads_value(&state.chains)?)),
            None => Ok(None),
        }
    }

    /// This device's last signed envelope in `group`.
    pub fn own_head(&self, group: &GroupId) -> Head {
        self.content
            .get(group)
            .map_or(Head::START, |state| state.own.head())
    }

    /// The last envelope of `sender` accepted in `group`: what a Cut of it names.
    pub fn head_of(&self, group: &GroupId, sender: &DeviceId) -> Head {
        self.content
            .get(group)
            .map_or(Head::START, |state| state.chains.head(sender))
    }

    /// The object's state in `group`, from headers alone.
    pub fn object(
        &self,
        group: &GroupId,
        object: &trommi_core::ids::ObjectId,
    ) -> Option<objects::Object> {
        self.content
            .get(group)
            .and_then(|state| state.objects.get(object))
            .cloned()
    }

    /// Records the epoch `group` stands in now, with its leaves and their roles: after joining or founding it,
    /// and after every Commit processed. `ended` is the `time` of the Commit that ended the epoch before, and
    /// `cuts` what that Commit says of the leaves it removed; each Cut ends its sender's chain here (9.0.10).
    /// Returns the findings (`equivocation`) the Cuts brought, and whether a Cut dropped envelopes this device had
    /// accepted: what was derived from them (object states, registers, the model) is then built again from
    /// what the hub still serves.
    pub fn note_epoch(
        &mut self,
        group: &GroupId,
        ended: Option<u64>,
        cuts: &[Cut],
        now_ms: u64,
    ) -> Result<(Vec<Error>, bool)> {
        let summary = self.device.group(group)?;
        let me = self.me();
        let history = self.device.room_history();
        let was_human = |device: &DeviceId| {
            history.is_some_and(|history| history.states().any(|state| state.is_human(device)))
        };
        let is_main = summary
            .session
            .is_none_or(|session| session.parent.is_zero());
        // A helper session's opener is its main session's agent leaf: this device, wherever it is a leaf of a
        // helper session at all (the connector runs as an agent device, never as a helper device).
        let opener = summary
            .session
            .filter(|session| !session.parent.is_zero())
            .and_then(|session| {
                let parent = GroupId::session(session.room_id, session.parent);
                self.seat(&parent)
            })
            .unwrap_or(me);
        let roles: BTreeMap<String, StoredRole> = summary
            .leaves
            .iter()
            .map(|leaf| {
                let role = if group.is_room() || was_human(leaf) {
                    StoredRole::Human
                } else if is_main {
                    StoredRole::Agent
                } else if *leaf == opener {
                    StoredRole::Opener
                } else {
                    StoredRole::Helper
                };
                (leaf.to_base64url(), role)
            })
            .collect();
        let known = self.ledgers.contains_key(group);
        let ledger = self.ledgers.entry(*group).or_default();
        if !known {
            ledger.first = summary.epoch;
            ledger.joined_at = now_ms;
        }
        ledger.epochs.insert(summary.epoch, roles);
        if let (Some(time), Some(before)) = (ended, summary.epoch.checked_sub(1)) {
            ledger.ends.entry(before).or_insert((now_ms, time));
        }
        let mut findings = Vec::new();
        let mut dropped = false;
        for cut in cuts {
            // The first Cut of a device stands for ever.
            let head = Head {
                seq: cut.seq,
                hash: cut.hash,
            };
            if self
                .ledgers
                .get(group)
                .is_some_and(|ledger| ledger.cuts.contains_key(&cut.device.to_base64url()))
            {
                continue;
            }
            let state = self.content.entry(*group).or_default();
            let effect = chain::cut_chain(
                &Accepted(&self.journal),
                &state.chains,
                group,
                &cut.device,
                &head,
            )?;
            state.chains.apply_cut(&effect);
            if let Some(from) = effect.drop_from {
                dropped = true;
                // What lies beyond the Cut is no longer an accepted envelope of this group.
                let last = self.journal.scan(&side_key(
                    TAG_ACCEPTED,
                    &[group.as_bytes(), cut.device.as_bytes()],
                ));
                for (key, _) in last {
                    let seq = key
                        .get(key.len().saturating_sub(8)..)
                        .and_then(|b| b.try_into().ok())
                        .map(u64::from_be_bytes);
                    if seq.is_some_and(|seq| seq >= from) {
                        self.journal.delete(key);
                    }
                }
            }
            findings.extend(effect.finding);
            if let Some(ledger) = self.ledgers.get_mut(group) {
                ledger.cuts.insert(
                    cut.device.to_base64url(),
                    (cut.seq, cut.hash.to_base64url()),
                );
            }
        }
        let ledger = self.ledgers.get(group).ok_or_else(|| damaged("a ledger"))?;
        self.journal.put(
            side_key(TAG_LEDGER, &[group.as_bytes()]),
            serde_json::to_vec(ledger)?,
        );
        // A group that has a ledger has its content state, from its first epoch on.
        self.content.entry(*group).or_default();
        self.stage_content(group)?;
        Ok((findings, dropped))
    }

    /// First contact with a session joined by Welcome (5.2.6), as the core's device checks it: the group is
    /// verified from its founding through its Commits against the room states this device holds, and must end
    /// in the state this device stands in. `Ok(false)` when this device's record of the room does not reach
    /// back to the founding (a session that is older than this device's enrolment), which is no finding;
    /// `bad-group` is one: the session's content is then not opened.
    pub fn first_contact(&self, group: &GroupId, past: &Past) -> Result<bool> {
        let commits: Vec<trommi_core::recovery::ServedCommit<'_>> = past
            .commits
            .iter()
            .zip(&past.changes)
            .map(
                |((commit, auth), change)| trommi_core::recovery::ServedCommit {
                    change: *change,
                    commit,
                    recovery_auth: auth.as_deref(),
                },
            )
            .collect();
        let served = trommi_core::recovery::ServedGroup {
            founding: &past.info,
            commits: &commits,
            current: &past.current,
        };
        match self.device.verify_founding(group, &served) {
            Ok(()) => Ok(true),
            Err(Error::RoomBehind | Error::GroupBehind) => Ok(false),
            Err(error) => Err(error.into()),
        }
    }

    /// Learns the epochs of `group` before this device joined it (`chain::GroupFacts::processed_epoch`): who
    /// its leaves were and in which role, when each epoch ended, which Cuts its Commits named.
    ///
    /// `past` is what the hub keeps: the room group's founding GroupInfo and Commits, and the group's own. The
    /// room is followed from its founding and must arrive at `anchor`, the room epoch and state this device
    /// was invited at (12.1.6): a room state names its whole history. The group is followed from its founding
    /// through every Commit up to the epoch this device joined at, each judged by the core's rules against
    /// that room history, and must arrive at the leaves this device's own group has. On any refusal nothing
    /// is learned and the error says why.
    pub fn learn_past(
        &mut self,
        group: &GroupId,
        past: &Past,
        anchor: (u64, Hash32),
        now_ms: u64,
    ) -> Result<()> {
        let summary = self.device.group(group)?;
        let Some(first) = self.first_epoch(group) else {
            return Err(Fault::new("not-found", "a group this device does not hold"));
        };
        let unfit = |what: &str| {
            Fault::new(
                "bad-group",
                format!("the group's past does not fit: {what}"),
            )
        };
        let recovery = PublicRules;
        let sessions = NoSessions;

        let mut room = Observer::follow_room(&past.room_info, None)?;
        if room.epoch()? != 0 {
            return Err(unfit("the room's founding"));
        }
        for (commit, auth) in &past.room_commits {
            let context = Context {
                room: None,
                sessions: &sessions,
                recovery: &recovery,
                max_human_devices: 33,
            };
            room.process_commit(commit, auth.as_deref(), &context)?;
        }
        let history = room.history().ok_or_else(|| unfit("no room history"))?;
        if history.at(anchor.0).map(|state| state.state) != Some(anchor.1) {
            return Err(unfit("the room this device was invited to"));
        }

        let founding = history
            .at(0)
            .ok_or_else(|| unfit("the room's first state"))?;
        let mut session = Observer::follow_session(&past.info, founding)?;
        if session.group() != *group || session.epoch()? != 0 {
            return Err(unfit("the group's founding"));
        }
        let extension = *session
            .session()
            .ok_or_else(|| unfit("not a session group"))?;
        let is_main = extension.parent.is_zero();
        let roles_at = |leaves: &std::collections::BTreeSet<DeviceId>, room_epoch: u64| {
            let state = history.at(room_epoch);
            leaves
                .iter()
                .map(|leaf| {
                    let role = if state.is_none_or(|state| state.is_human(leaf)) {
                        StoredRole::Human
                    } else if is_main {
                        StoredRole::Agent
                    } else if state.is_some_and(|state| state.is_agent(leaf)) {
                        StoredRole::Opener
                    } else {
                        StoredRole::Helper
                    };
                    (leaf.to_base64url(), role)
                })
                .collect::<BTreeMap<String, StoredRole>>()
        };
        let mut epochs = BTreeMap::new();
        let mut ends = BTreeMap::new();
        let mut cuts: BTreeMap<String, (u64, String)> = BTreeMap::new();
        epochs.insert(0, roles_at(&session.leaves()?, 0));
        for (commit, auth) in &past.commits {
            let before = session.epoch()?;
            if before >= first {
                break;
            }
            let context = Context {
                room: Some(history),
                sessions: &sessions,
                recovery: &recovery,
                max_human_devices: 33,
            };
            let facts = session.process_commit(commit, auth.as_deref(), &context)?;
            let note = facts
                .note
                .ok_or_else(|| unfit("a Commit without its note"))?;
            ends.insert(before, (now_ms, note.time));
            for cut in &note.cuts {
                cuts.entry(cut.device.to_base64url())
                    .or_insert((cut.seq, cut.hash.to_base64url()));
            }
            epochs.insert(
                session.epoch()?,
                roles_at(&session.leaves()?, note.room_epoch),
            );
        }
        // It must arrive at the leaves this device recorded from its own group when it joined.
        let own_leaves: Option<std::collections::BTreeSet<String>> = self
            .ledgers
            .get(group)
            .and_then(|ledger| ledger.epochs.get(&first))
            .map(|roles| roles.keys().cloned().collect());
        let learned: std::collections::BTreeSet<String> = session
            .leaves()?
            .iter()
            .map(DeviceId::to_base64url)
            .collect();
        if session.epoch()? != first || own_leaves.as_ref() != Some(&learned) {
            return Err(unfit("it does not arrive at this device's group"));
        }
        let _ = summary;
        let ledger = self
            .ledgers
            .get_mut(group)
            .ok_or_else(|| damaged("a ledger"))?;
        // What this device recorded itself, from the epoch it joined at, stands.
        epochs.remove(&first);
        for (epoch, roles) in epochs {
            ledger.epochs.entry(epoch).or_insert(roles);
        }
        for (epoch, end) in ends {
            ledger.ends.entry(epoch).or_insert(end);
        }
        for (device, cut) in cuts {
            ledger.cuts.entry(device).or_insert(cut);
        }
        ledger.known_from = Some(0);
        self.journal.put(
            side_key(TAG_LEDGER, &[group.as_bytes()]),
            serde_json::to_vec(ledger)?,
        );
        Ok(())
    }

    /// Forgets what was received in `group` (chains, objects, registers and the accepted hashes), keeping this
    /// device's own chain, its register ids and the ledger: the group's envelopes are then read again from the
    /// hub's first, as after a key handover that opened what could not be read before.
    pub fn forget_received(&mut self, group: &GroupId) -> Result<()> {
        if let Some(state) = self.content.get_mut(group) {
            state.chains = Chains::new();
            state.objects = Objects::new();
            state.registers = Registers::new();
        }
        for (key, _) in self
            .journal
            .scan(&side_key(TAG_ACCEPTED, &[group.as_bytes()]))
        {
            self.journal.delete(key);
        }
        self.stage_content(group)
    }
}

impl ContentDevice for Vault {
    fn seal(&mut self, group: &GroupId, draft: &Draft, now_ms: u64) -> Result<Sealed> {
        let facts = Facts {
            device: &self.device,
            ledgers: &self.ledgers,
        };
        let state = self.content.entry(*group).or_default();
        let outgoing = chain::seal_next(
            &facts,
            &state.chains,
            &state.objects,
            &mut state.own,
            draft,
            *group,
            &self.key,
            now_ms,
            &mut SystemEntropy,
        )?;
        let sealed = Sealed {
            bytes: outgoing.envelope.encode()?,
            hash: outgoing.hash,
            seq: outgoing.envelope.header.seq,
            epoch: outgoing.envelope.header.epoch,
        };
        self.stage_content(group)?;
        Ok(sealed)
    }

    fn register_draft(
        &mut self,
        group: &GroupId,
        name: &str,
        value: Option<&str>,
    ) -> Result<Draft> {
        let state = self.content.entry(*group).or_default();
        Ok(registers::write(
            &state.registers,
            &mut state.ids,
            name,
            value,
            &mut SystemEntropy,
        )?)
    }

    fn receive(&mut self, bytes: &[u8], served: &Served, mode: Mode, now_ms: u64) -> Result<Taken> {
        let group = trommi_core::envelope::Envelope::decode(bytes)?.header.group;
        let me = self.me();
        let facts = Facts {
            device: &self.device,
            ledgers: &self.ledgers,
        };
        let state = self.content.entry(group).or_default();
        let own_before = state.own.head();
        let receipt = chain::receive(
            &facts,
            &Accepted(&self.journal),
            &state.chains,
            &state.objects,
            &me,
            bytes,
            served,
            mode,
            now_ms,
        )?;
        let header = &receipt.envelope().header;
        if header.sender == me && header.seq > own_before.seq {
            // The hub holds an envelope of this device that this state has not signed yet: the state is older
            // than what the device already sent (a restored copy, a lost write). Signing on would put a
            // second envelope under a used number.
            return Err(Fault::new(
                "state-rolled-back",
                "this connector's stored state is older than what it already sent",
            ));
        }
        state.chains.apply(receipt.advance())?;
        let mut register = None;
        let mut heads = None;
        if let chain::Outcome::Taken { transition, body } = receipt.outcome() {
            if let Some(transition) = transition {
                state.objects.apply(transition)?;
            }
            if let (Subject::Register(_), Ok(body)) = (&header.subject, body) {
                // A value that is not taken (a name its sender may not write, a second id for a name) changes
                // nothing; the envelope keeps its place in the chain.
                if let Ok(update) = state.registers.judge(&facts, header, body.payload()) {
                    state.registers.apply(&update)?;
                    if let (registers::HEADS, Some(value), false) =
                        (update.name.as_str(), &update.value, header.sender == me)
                    {
                        // What another device says it accepted, held against what this one did.
                        if let Ok(named) = chain::parse_heads(value) {
                            let standings = chain::compare_heads(
                                &Accepted(&self.journal),
                                &state.chains,
                                &group,
                                &named,
                            )?;
                            let is = |want: fn(&chain::HeadStanding) -> bool| {
                                standings.iter().any(|(_, standing)| want(standing))
                            };
                            heads = Some((
                                is(|s| matches!(s, chain::HeadStanding::Behind { .. })),
                                is(|s| matches!(s, chain::HeadStanding::Equivocation)),
                            ));
                        }
                    }
                    register = Some(RegisterChange {
                        name: update.name.clone(),
                        of: update.of,
                        value: update.value.clone(),
                        current: update.current,
                    });
                }
            }
        }
        self.journal.put(
            accepted_key(&group, &header.sender, header.seq),
            receipt.hash().as_bytes().to_vec(),
        );
        self.stage_content(&group)?;
        Ok(Taken {
            receipt,
            register,
            heads,
        })
    }

    fn gate(&mut self, receipt: &Receipt, own: &OwnRecord<'_>, now_ms: u64) -> Result<Decision> {
        let Some(opened) = receipt.opened() else {
            return Ok(Decision::Refused(objects::Refusal::NotACommand));
        };
        let me = self.me();
        let facts = Facts {
            device: &self.device,
            ledgers: &self.ledgers,
        };
        let decision = objects::command_gate(&facts, &mut self.gate, &me, &opened, own, now_ms)?;
        if matches!(decision, Decision::Act(_)) {
            self.journal
                .put(side_key(TAG_GATE, &[]), self.gate.to_bytes()?);
        }
        Ok(decision)
    }

    fn gate_finish(&mut self, hash: &Hash32) -> Result<()> {
        self.gate.finish(hash)?;
        self.journal
            .put(side_key(TAG_GATE, &[]), self.gate.to_bytes()?);
        Ok(())
    }
}
