//! Envelope chains (section 9.0). Every sender numbers its envelopes per group and links each to the one before,
//! so a gap, a reordering or a second envelope under one number shows. This module holds the sender's side (the
//! next number, never used twice), the receiver's nine checks in their order, and what hangs on them: Cuts, void
//! records, provisional envelopes and `heads`. The hub runs the same checks through [`hub_take`].
//!
//! Nothing here does I/O. State is plain data that the caller loads, passes in and stores: [`Chains`] (per
//! group: every sender's last accepted envelope), [`OwnChain`] (per group: this device's last signed envelope)
//! and [`crate::objects::Objects`]. A function that changes state returns the change ([`Advance`],
//! [`crate::objects::Transition`], [`CutEffect`]) for the caller to apply and store in one write. What the
//! functions need to know about groups they ask a [`GroupFacts`]; what was accepted earlier, a [`ChainRecords`].

use crate::codec::{self, Decode, Encode, Reader, Writer};
use crate::crypto::{Entropy, Secret, SigningKey};
use crate::envelope::{self, Body, Draft, Envelope, Header, Slot};
use crate::error::Error;
use crate::ids::{base64url_decode, DeviceId, GroupId, Hash32, RoomId};
use crate::objects::{self, Objects, Opened, Transition};
use serde::de::{Deserialize, Deserializer, MapAccess, Visitor};
use std::collections::BTreeMap;
use std::fmt;

/// How long after the Commit that ended an epoch an envelope of that epoch is still taken, in ms.
pub const LIVE_GRACE_MS: u64 = 120_000;
/// How far an envelope's `time` may lie behind the `time` of the Commit that ended its epoch when it is read
/// back, in ms.
pub const READ_BACK_GRACE_MS: u64 = 300_000;
/// How many envelopes one group takes in one epoch.
pub const MAX_ENVELOPES_PER_EPOCH: u64 = 1 << 24;
/// The codes a void record may carry (section 9.0.8).
const VOID_CODES: [Error; 5] = [
    Error::Forbidden,
    Error::WrongEpoch,
    Error::StaleSession,
    Error::EpochFull,
    Error::TooLarge,
];
/// The largest stored chain state this module reads.
const MAX_STATE_LEN: usize = 1 << 26;

/// A place in a sender's chain: an envelope's number and hash. Also what a Cut names and what `heads` and a
/// board snapshot's frontier list per sender.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Head {
    /// The envelope's number; 0 before the first.
    pub seq: u64,
    /// Its `envelope_hash`; zeros before the first.
    pub hash: Hash32,
}

impl Head {
    /// Before the first envelope: number 0, hash zeros.
    pub const START: Self = Self {
        seq: 0,
        hash: Hash32::ZERO,
    };
}

impl Encode for Head {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.u64(self.seq);
        writer.fixed(self.hash.as_bytes());
        Ok(())
    }
}

impl Decode for Head {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        Ok(Self {
            seq: reader.u64()?,
            hash: reader.value()?,
        })
    }
}

/// What a leaf of a group is (section 4.1), as far as stored content cares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// A human device: a leaf of the room group.
    Human,
    /// The agent device of a main session.
    Agent,
    /// The opener of a helper session: its main session's agent device.
    Opener,
    /// A helper device of a helper session.
    Helper,
}

/// The Commit that ended an epoch of a group.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EpochEnd {
    /// When the verifier processed that Commit, by its own clock, in ms. At the hub: when it arrived.
    pub processed_at: u64,
    /// The `time` of the Commit's `CommitNote`: the committer's clock, in ms.
    pub time: u64,
}

/// What the stored-content rules need to know about the groups of a room. A device answers from the MLS state
/// it holds and the Commits it processed (as a member, or as an observer of a group's public history); the hub
/// from the groups it follows. "Processed" always means: merged into the verifier's own view of the group, in
/// the hub's order.
///
/// Every method may fail with `Error::Storage` or `Error::Internal`; such a failure aborts the calling function
/// and changes nothing. `Ok(None)` and `Ok(false)` are answers, not failures.
pub trait GroupFacts {
    /// The room this verifier works in. An envelope of any other room is `wrong-room`.
    fn room(&self) -> RoomId;

    /// The newest epoch of `group` whose beginning the verifier has processed: for a group it founded or
    /// joined, the epoch its state stands in; `None` for a group it does not know (not yet founded in its view,
    /// or not of this room). Every epoch from 0 up to this one must be answerable by [`GroupFacts::leaf_role`],
    /// [`GroupFacts::seat`] and, below this one, [`GroupFacts::epoch_end`]: a device that joined later learns
    /// the earlier epochs from the group's founding GroupInfo and Commits, which the hub keeps. If it has not
    /// done that for an epoch, it answers as if the group stood before that epoch.
    fn processed_epoch(&self, group: &GroupId) -> Result<Option<u64>, Error>;

    /// The role `device` had as a leaf of `group` in `epoch` (the tree after the Commit that began `epoch`, or
    /// the founding tree for epoch 0); `None` if it was no leaf then. The role is the one that Commit was
    /// judged with (section 5.2.1): [`Role::Human`] for a key in `H(r)` of the Commit's `room_epoch` r, and
    /// every leaf of the room group; [`Role::Agent`] for the agent leaf of a main session; in a helper session
    /// [`Role::Opener`] for the leaf that was its main session's agent leaf, and [`Role::Helper`] for every
    /// other leaf that is not a human device. Asked only for `epoch` at or below
    /// [`GroupFacts::processed_epoch`].
    fn leaf_role(
        &self,
        group: &GroupId,
        epoch: u64,
        device: &DeviceId,
    ) -> Result<Option<Role>, Error>;

    /// The device a human addresses in a session, and to which an object passes when its owner has left: in a
    /// main session group the leaf with [`Role::Agent`] in `epoch`, in a helper session group the leaf with
    /// [`Role::Opener`] in `epoch`. `None` while the session has no such leaf, and for the room group.
    fn seat(&self, group: &GroupId, epoch: u64) -> Result<Option<DeviceId>, Error>;

    /// The Cut of `device` in `group`: present once the verifier has processed a Commit of `group` that removed
    /// the device's leaf, and equal to the entry for that device in that Commit's `CommitNote.cuts` (number 0
    /// and hash zeros if the remover had accepted nothing). `None` only if no processed Commit of `group` ever
    /// removed the device. A Cut is for ever for whatever the device signed for an epoch before it was a leaf
    /// again: it stays the answer if the same key is added to the group again
    /// ([`GroupFacts::leaf_again_at`]). Of a key that came back and was removed again, the Cut of its last
    /// removal is the answer: the device's chain up to it is the one that Cut names.
    fn cut(&self, group: &GroupId, device: &DeviceId) -> Result<Option<Head>, Error>;

    /// For a device with a Cut in `group`: the epoch in which its key became a leaf of the group again after
    /// the removal that [`GroupFacts::cut`] names, the epoch begun by the Commit that added it again (sections
    /// 3.7, 9.0.10; a Commit that removes the leaf and adds the key at once begins it). `None` while the key
    /// has not come back, which is every key in the room group and every revoked key (section 4.2). From that
    /// epoch on the device's chain goes on from its Cut; for every earlier epoch the Cut ends it.
    fn leaf_again_at(&self, _group: &GroupId, _device: &DeviceId) -> Result<Option<u64>, Error> {
        Ok(None)
    }

    /// Whether `device` had ceased to be a leaf of `group` by `epoch`: whether a Commit that began an epoch at
    /// or below `epoch` removed its leaf. It stays true if the same key is a leaf of the group again later. An
    /// object passes from such a device to the session's seat for good (section 9.2).
    ///
    /// The answer given here follows from [`GroupFacts::cut`] and [`GroupFacts::leaf_role`]: no Cut, never
    /// removed; else the device was removed by `epoch` if an epoch in which it was a leaf is followed, up to
    /// `epoch`, by one in which it was none. A verifier that keeps the epoch of each removal answers from
    /// that instead, and must do so if it takes a Commit that removes a leaf and adds the same key at once.
    fn removed_by(&self, group: &GroupId, epoch: u64, device: &DeviceId) -> Result<bool, Error> {
        if self.cut(group, device)?.is_none() {
            return Ok(false);
        }
        let mut was_leaf = false;
        for earlier in 0..=epoch {
            match self.leaf_role(group, earlier, device)? {
                Some(_) => was_leaf = true,
                None if was_leaf => return Ok(true),
                None => {}
            }
        }
        Ok(false)
    }

    /// The Commit that ended `epoch` of `group` (the one that began `epoch + 1`): when the verifier processed
    /// it and the `time` of its `CommitNote`. `None` if `epoch` is the newest processed epoch or above it.
    fn epoch_end(&self, group: &GroupId, epoch: u64) -> Result<Option<EpochEnd>, Error>;

    /// Whether `group` is stale in the verifier's newest state (section 5.2.8): a session group that has a leaf
    /// the newest processed room state does not allow (a revoked key), or a helper session group whose opener
    /// leaf is not the agent leaf of its main session in that session's newest processed state. Both are
    /// judged at the verifier's place in the hub's order across groups. Always `false` for the room group.
    fn is_stale(&self, group: &GroupId) -> Result<bool, Error>;

    /// Whether `device` is a human device now: a leaf of the room group in the newest room state the verifier
    /// has processed (as a member or as an observer).
    fn is_human_now(&self, device: &DeviceId) -> Result<bool, Error>;

    /// `content_key(group, epoch)`, if the verifier holds it (derived, or handed over). The hub holds none.
    fn content_key(&self, group: &GroupId, epoch: u64) -> Result<Option<Secret<32>>, Error>;
}

/// The envelopes a verifier accepted earlier, by their place: its table of stored envelopes, which has at most
/// one row per group, sender and number.
pub trait ChainRecords {
    /// The `envelope_hash` of the envelope accepted into the chain of `sender` in `group` under `seq`; `None`
    /// if the verifier keeps no such row (the chain started at a board snapshot's frontier beyond it, or the
    /// row was dropped by a Cut).
    fn accepted_hash(
        &self,
        group: &GroupId,
        sender: &DeviceId,
        seq: u64,
    ) -> Result<Option<Hash32>, Error>;
}

/// The chains of one group as a verifier has accepted them: per sender the last envelope, and per epoch how
/// many envelopes took a number.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Chains {
    heads: BTreeMap<DeviceId, Head>,
    counts: BTreeMap<u64, u64>,
    /// The chains that began at a board snapshot's frontier (section 10.3) and whose envelopes up to it
    /// are not all verified yet.
    starts: BTreeMap<DeviceId, Start>,
    /// How many changes this state has taken. An envelope is checked against one revision and its step fits
    /// only that one.
    revision: u64,
}

/// A chain that began at a frontier instead of number 1: the frontier, and how far the envelopes below it
/// were verified from number 1 since.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Start {
    frontier: Head,
    verified: Head,
}

struct StartEntry(DeviceId, Start);

impl Encode for StartEntry {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.fixed(self.0.as_bytes());
        writer.value(&self.1.frontier)?;
        writer.value(&self.1.verified)
    }
}

impl Decode for StartEntry {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        Ok(Self(
            reader.value()?,
            Start {
                frontier: reader.value()?,
                verified: reader.value()?,
            },
        ))
    }
}

struct HeadEntry(DeviceId, Head);

impl Encode for HeadEntry {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.fixed(self.0.as_bytes());
        writer.value(&self.1)
    }
}

impl Decode for HeadEntry {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        Ok(Self(reader.value()?, reader.value()?))
    }
}

struct CountEntry(u64, u64);

impl Encode for CountEntry {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.u64(self.0);
        writer.u64(self.1);
        Ok(())
    }
}

impl Decode for CountEntry {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        Ok(Self(reader.u64()?, reader.u64()?))
    }
}

/// A stored value that does not decode.
fn corrupt(_: Error) -> Error {
    Error::Storage("stored chain state does not decode".into())
}

impl Chains {
    /// No chain yet.
    pub fn new() -> Self {
        Self::default()
    }

    /// Chains that start at these heads instead of number 1: the frontier of a board snapshot (section 10.3),
    /// the one shortcut around verifying a chain from its first envelope. It stands for the board's items only:
    /// the state of the group's objects is still replayed from all of their envelopes.
    pub fn from_frontier(frontier: &[(DeviceId, Head)]) -> Self {
        let mut chains = Self::new();
        for (sender, head) in frontier.iter().filter(|(_, head)| head.seq > 0) {
            chains.heads.insert(*sender, *head);
            chains.starts.insert(
                *sender,
                Start {
                    frontier: *head,
                    verified: Head::START,
                },
            );
        }
        chains
    }

    /// Starts the chain of `sender`, of which nothing is held, at `frontier` (section 10.3): the envelope
    /// after it is the next one taken. The envelopes up to the frontier can be read from number 1 at any
    /// time later; they must then lead to the frontier's envelope (`equivocation` otherwise), and until they
    /// did, [`Chains::started_at`] names the frontier. `Error::Internal` for a chain that holds an envelope
    /// or for a frontier before the first envelope.
    pub fn start_at(&mut self, sender: DeviceId, frontier: Head) -> Result<(), Error> {
        if self.head(&sender) != Head::START || frontier.seq == 0 {
            return Err(Error::Internal("a chain started twice"));
        }
        self.heads.insert(sender, frontier);
        self.starts.insert(
            sender,
            Start {
                frontier,
                verified: Head::START,
            },
        );
        self.revision = self.revision.saturating_add(1);
        Ok(())
    }

    /// The frontier the chain of `sender` began at, while the envelopes up to it are not all verified from
    /// number 1; none for a chain that is whole.
    pub fn started_at(&self, sender: &DeviceId) -> Option<Head> {
        self.starts.get(sender).map(|start| start.frontier)
    }

    /// The last accepted envelope of `sender`; [`Head::START`] if none.
    pub fn head(&self, sender: &DeviceId) -> Head {
        self.heads.get(sender).copied().unwrap_or(Head::START)
    }

    /// Every chain with at least one accepted envelope, ascending by sender: what `heads` lists.
    pub fn heads(&self) -> Vec<(DeviceId, Head)> {
        self.heads
            .iter()
            .filter(|(_, head)| head.seq > 0)
            .map(|(sender, head)| (*sender, *head))
            .collect()
    }

    /// How many envelopes took a number in `epoch`.
    pub fn count(&self, epoch: u64) -> u64 {
        self.counts.get(&epoch).copied().unwrap_or(0)
    }

    /// Takes an accepted envelope into its sender's chain. `Error::Internal`, and no change, if the chain no
    /// longer stands where the envelope was checked: a step is applied once, before the next envelope of the
    /// group is checked.
    pub fn apply(&mut self, advance: &Advance) -> Result<(), Error> {
        if self.revision != advance.revision {
            return Err(Error::Internal("a chain step applied out of turn"));
        }
        // A step below the frontier a chain began at verifies one more envelope from number 1.
        let below = self
            .starts
            .get(&advance.sender)
            .filter(|start| advance.head.seq <= start.frontier.seq)
            .copied();
        match below {
            Some(start) => {
                if start.verified != advance.prev {
                    return Err(Error::Internal("a chain step applied out of turn"));
                }
                if advance.head.seq == start.frontier.seq {
                    self.starts.remove(&advance.sender);
                } else if let Some(start) = self.starts.get_mut(&advance.sender) {
                    start.verified = advance.head;
                }
            }
            None => {
                if self.head(&advance.sender) != advance.prev {
                    return Err(Error::Internal("a chain step applied out of turn"));
                }
                self.heads.insert(advance.sender, advance.head);
            }
        }
        self.revision = self.revision.saturating_add(1);
        let count = self.counts.entry(advance.epoch).or_insert(0);
        *count = count.saturating_add(1);
        Ok(())
    }

    /// Ends a removed sender's chain at its Cut.
    pub fn apply_cut(&mut self, effect: &CutEffect) {
        if let Some(head) = effect.head {
            self.heads.insert(effect.sender, head);
            // A chain that began at a frontier beyond the Cut ends at the Cut: what is still to be verified
            // from number 1 leads there.
            let whole = match self.starts.get_mut(&effect.sender) {
                Some(start) if head.seq < start.frontier.seq => {
                    start.frontier = head;
                    start.verified.seq >= head.seq
                }
                _ => false,
            };
            if whole {
                self.starts.remove(&effect.sender);
            }
        }
        self.revision = self.revision.saturating_add(1);
    }

    /// The stored form.
    pub fn to_bytes(&self) -> Result<Vec<u8>, Error> {
        let heads: Vec<HeadEntry> = self.heads.iter().map(|(d, h)| HeadEntry(*d, *h)).collect();
        let counts: Vec<CountEntry> = self
            .counts
            .iter()
            .map(|(e, n)| CountEntry(*e, *n))
            .collect();
        let starts: Vec<StartEntry> = self
            .starts
            .iter()
            .map(|(sender, start)| StartEntry(*sender, *start))
            .collect();
        let mut writer = Writer::new();
        writer.u64(self.revision);
        writer.vector(&heads)?;
        writer.vector(&counts)?;
        writer.vector(&starts)?;
        Ok(writer.into_bytes())
    }

    /// Reads the stored form; `Error::Storage` if it does not decode.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() > MAX_STATE_LEN {
            return Err(corrupt(Error::TooLarge));
        }
        let mut reader = Reader::new(bytes);
        let revision = reader.u64().map_err(corrupt)?;
        let heads: Vec<HeadEntry> = reader.vector().map_err(corrupt)?;
        let counts: Vec<CountEntry> = reader.vector().map_err(corrupt)?;
        let starts: Vec<StartEntry> = reader.vector().map_err(corrupt)?;
        reader.finish().map_err(corrupt)?;
        let mut chains = Self {
            revision,
            ..Self::new()
        };
        for HeadEntry(sender, head) in heads {
            if chains.heads.insert(sender, head).is_some() {
                return Err(corrupt(Error::BadFormat));
            }
        }
        for CountEntry(epoch, count) in counts {
            if chains.counts.insert(epoch, count).is_some() {
                return Err(corrupt(Error::BadFormat));
            }
        }
        for StartEntry(sender, start) in starts {
            // A start is kept only while envelopes below its frontier are unverified, and the chain it
            // belongs to stands at the frontier or beyond.
            let fits = start.verified.seq < start.frontier.seq
                && (start.verified.seq == 0) == start.verified.hash.is_zero()
                && chains.head(&sender).seq >= start.frontier.seq;
            if !fits || chains.starts.insert(sender, start).is_some() {
                return Err(corrupt(Error::BadFormat));
            }
        }
        Ok(chains)
    }
}

/// This device's own chain in one group: the last envelope it signed there. It runs ahead of the device's entry
/// in [`Chains`], which advances when the envelope comes back from the hub at its place in the hub's order.
/// There is one per device and group, and no way to copy it: [`seal_next`] moves it on as it signs.
#[derive(Debug, PartialEq, Eq)]
pub struct OwnChain {
    head: Head,
}

impl Default for OwnChain {
    fn default() -> Self {
        Self::new()
    }
}

impl OwnChain {
    /// A chain without an envelope.
    pub fn new() -> Self {
        Self { head: Head::START }
    }

    /// A chain that goes on from `cut`: this device's leaf was removed with that Cut, and whatever it signed
    /// beyond it is void (section 9.0.10). If its key is added to the group again, its next envelope is the
    /// one after the Cut.
    pub(crate) fn from_cut(cut: Head) -> Self {
        Self { head: cut }
    }

    /// The last envelope signed.
    pub fn head(&self) -> Head {
        self.head
    }

    /// The place of the next envelope.
    pub(crate) fn slot(
        &self,
        group: GroupId,
        epoch: u64,
        sender: DeviceId,
        now_ms: u64,
    ) -> Result<Slot, Error> {
        Ok(Slot {
            group,
            epoch,
            sender,
            seq: self
                .head
                .seq
                .checked_add(1)
                .ok_or(Error::Internal("chain number"))?,
            prev: self.head.hash,
            time: now_ms,
        })
    }

    /// The stored form.
    pub fn to_bytes(&self) -> Result<Vec<u8>, Error> {
        codec::encode(&self.head)
    }

    /// Reads the stored form; `Error::Storage` if it does not decode.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, Error> {
        let head: Head = codec::decode(bytes, 64).map_err(corrupt)?;
        if (head.seq == 0) != head.hash.is_zero() {
            return Err(corrupt(Error::BadFormat));
        }
        Ok(Self { head })
    }
}

/// A new envelope of this device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outgoing {
    /// The envelope to post.
    pub envelope: Envelope,
    /// Its hash.
    pub hash: Hash32,
}

/// Seals this device's next envelope in `group`, in the group's current epoch, as number `own.head().seq + 1`.
///
/// Refuses, before anything is signed, what the hub would refuse: `group-behind` for a group the device does
/// not know, `not-member` when it is no leaf, `removed-sender` when a Cut ended its chain, `stale-session`, `epoch-full`, `forbidden` when 9.2 does not let
/// this device write the item against the object state it has, `no-key` without the epoch's content key; and
/// what `envelope::seal` refuses. A refusal uses up no number and leaves `own` as it was.
///
/// On success `own` has moved on: the number is used up, and a second call signs the next one. The caller
/// stores `own` in the same write as the envelope's outbox entry, before the envelope leaves (section 13.2); a
/// retry sends the stored bytes. If that write fails, the envelope is dropped unsent and the stored chain is
/// loaded again: a number is signed twice only for an envelope that never left.
#[allow(clippy::too_many_arguments)]
pub fn seal_next(
    facts: &dyn GroupFacts,
    chains: &Chains,
    objects: &Objects,
    own: &mut OwnChain,
    draft: &Draft,
    group: GroupId,
    signer: &SigningKey,
    now_ms: u64,
    entropy: &mut dyn Entropy,
) -> Result<Outgoing, Error> {
    let sender = DeviceId::new(signer.public());
    if group.room_id() != facts.room() {
        return Err(Error::WrongRoom);
    }
    let epoch = facts.processed_epoch(&group)?.ok_or(Error::GroupBehind)?;
    if facts.leaf_role(&group, epoch, &sender)?.is_none() {
        return Err(Error::NotMember);
    }
    // 9.0.10: a Cut ends this device's chain unless its key is a leaf again, and then for this epoch on.
    if facts.cut(&group, &sender)?.is_some()
        && !facts
            .leaf_again_at(&group, &sender)?
            .is_some_and(|again| epoch >= again)
    {
        return Err(Error::RemovedSender);
    }
    if facts.is_stale(&group)? {
        return Err(Error::StaleSession);
    }
    if chains.count(epoch) >= MAX_ENVELOPES_PER_EPOCH {
        return Err(Error::EpochFull);
    }
    let slot = own.slot(group, epoch, sender, now_ms)?;
    let header = draft.header(&slot)?;
    // The hash is not known before sealing and decides nothing about whether the item may be written.
    objects::judge(facts, objects, &header, &Hash32::ZERO)?;
    let key = facts.content_key(&group, epoch)?.ok_or(Error::NoKey)?;
    let sealed = envelope::seal(draft, &slot, &key, signer, entropy)?;
    own.head = Head {
        seq: slot.seq,
        hash: sealed.hash,
    };
    Ok(Outgoing {
        envelope: sealed.envelope,
        hash: sealed.hash,
    })
}

/// Who checks an envelope, and against which state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// The hub, taking a new envelope: only the group's current epoch, or the one before within
    /// [`LIVE_GRACE_MS`] of its Commit's arrival.
    Hub,
    /// A device processing in the hub's order (the stream, or catching up through the changes): its group
    /// state is the state at the envelope's place in that order.
    InOrder,
    /// A device reading back: a chain from its first envelope, a page of a Chat, an object. Its group state is
    /// later than the envelope, so freshness is judged by the envelope's `time` against the Commit's `time`,
    /// and what only the state of the moment can tell (`stale-session`, `epoch-full`) is left to the hub.
    ReadingBack,
}

/// How the hub served an envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Served {
    /// As a stored item.
    Stored,
    /// As a void record, with its `void_code` (section 9.0.8).
    Void(Error),
}

/// The step a sender's chain takes with an accepted envelope.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Advance {
    /// The sender.
    pub sender: DeviceId,
    /// Its last envelope before this one: the state the envelope was checked against.
    pub prev: Head,
    /// Its new last envelope.
    pub head: Head,
    /// The epoch the envelope names.
    pub epoch: u64,
    /// The revision of the [`Chains`] the envelope was checked against.
    pub revision: u64,
}

/// What became of an envelope that took its place in the chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// It passed checks 7 and 8. `transition` is the change of its object's state, to be applied and stored
    /// with the [`Advance`]; `None` for an item and a register. `body` is check
    /// 9: the opened body, or `no-key`, `pruned`, `too-large`, `decrypt-failed`, `bad-format`, `newer-version`
    /// (the hub, which holds no key, always has `no-key`). Without a body nothing is shown or acted on, but the transition
    /// counts: object state follows the headers.
    Taken {
        /// The object's change of state.
        transition: Option<Box<Transition>>,
        /// The body, or why there is none.
        body: Result<Body, Error>,
    },
    /// It failed check 7 or 8, or what the hub checks beside them: `forbidden`, `wrong-epoch`, `stale-session`,
    /// `epoch-full`, and at the hub `too-large`. It is chained and never applied; the hub stores it as a void
    /// record.
    Refused(Error),
    /// The hub served it as a void record: chained, never applied. `finding` is `hub-voided-other` when the
    /// record is another sender's and its reason cannot be checked again from the header and the group state,
    /// and for any code that is none of the five a void record may carry.
    Void {
        /// The hub's `void_code`.
        code: Error,
        /// The finding to show, if any.
        finding: Option<Error>,
    },
    /// A kind this version does not know: chained, nothing applied, shown as "needs a newer Trommi".
    Reserved,
}

/// An envelope that passed checks 1 to 6: it has its place in the chain, whatever else became of it. Only
/// [`receive`] and [`hub_take`] make one, so that what reaches the command gate has been through the checks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Receipt {
    pub(crate) envelope: Envelope,
    pub(crate) hash: Hash32,
    pub(crate) advance: Advance,
    pub(crate) outcome: Outcome,
}

impl Receipt {
    /// The envelope.
    pub fn envelope(&self) -> &Envelope {
        &self.envelope
    }

    /// Its hash.
    pub fn hash(&self) -> Hash32 {
        self.hash
    }

    /// The step of the sender's chain: the caller applies it to its [`Chains`] and stores it together with
    /// the envelope, under the envelope's group, sender and number.
    pub fn advance(&self) -> &Advance {
        &self.advance
    }

    /// What became of the envelope.
    pub fn outcome(&self) -> &Outcome {
        &self.outcome
    }

    /// The envelope as the command gate takes it (section 9.0.9): present only if it passed all nine checks.
    pub fn opened(&self) -> Option<Opened<'_>> {
        match &self.outcome {
            Outcome::Taken {
                transition,
                body: Ok(body),
            } => Some(Opened {
                header: &self.envelope.header,
                hash: self.hash,
                body,
                before: transition.as_ref().and_then(|t| t.before.as_ref()),
            }),
            _ => None,
        }
    }
}

/// An envelope after checks 1 to 5.
struct Verified {
    envelope: Envelope,
    hash: Hash32,
    /// The newest epoch of the group that the verifier has processed.
    current: u64,
}

/// Checks 1 to 5 on a decoded envelope (decoding is the first half of check 1: `bad-format`, `newer-version`,
/// `too-large`): the room (`wrong-room`), the group's progress (`group-behind`), the sender's leaf (`not-member`), its Cut (`removed-sender`,
/// `equivocation`), the signature (`bad-signature`).
fn first_five(facts: &dyn GroupFacts, envelope: Envelope) -> Result<Verified, Error> {
    let header = &envelope.header;
    if header.group.room_id() != facts.room() {
        return Err(Error::WrongRoom);
    }
    let current = facts
        .processed_epoch(&header.group)?
        .filter(|current| header.epoch <= *current)
        .ok_or(Error::GroupBehind)?;
    if facts
        .leaf_role(&header.group, header.epoch, &header.sender)?
        .is_none()
    {
        return Err(Error::NotMember);
    }
    let hash = envelope.hash()?;
    if let Some(cut) = facts.cut(&header.group, &header.sender)? {
        // Beyond the Cut lies only what the device signed for the epoch that added its key again, or a later
        // one. An envelope it signed for an earlier epoch, whenever it is handed in, stays refused.
        if header.seq > cut.seq
            && !facts
                .leaf_again_at(&header.group, &header.sender)?
                .is_some_and(|again| header.epoch >= again)
        {
            return Err(Error::RemovedSender);
        }
        if header.seq == cut.seq && hash != cut.hash {
            return Err(Error::Equivocation);
        }
    }
    envelope.verify()?;
    Ok(Verified {
        envelope,
        hash,
        current,
    })
}

/// Check 6: the envelope is the next of its sender's chain; the step is returned as the place before it and
/// its own. `replay` for an envelope already accepted,
/// `equivocation` for another one under an accepted number, `gap` for a number beyond the next, `chain-break`
/// for the next number with a `prev` that is not the last accepted hash.
fn link(
    records: &dyn ChainRecords,
    chains: &Chains,
    header: &Header,
    hash: &Hash32,
) -> Result<(Head, Head), Error> {
    let last = chains.head(&header.sender);
    // A chain that began at a frontier takes the envelopes up to it from number 1, each the next of those
    // verified so far, and the one at the frontier's number must be the frontier's.
    let below = chains
        .starts
        .get(&header.sender)
        .filter(|start| header.seq > start.verified.seq && header.seq <= start.frontier.seq);
    if let Some(start) = below {
        if start.verified.seq.checked_add(1) != Some(header.seq) {
            return Err(Error::Gap);
        }
        if header.prev != start.verified.hash {
            return Err(Error::ChainBreak);
        }
        if header.seq == start.frontier.seq && *hash != start.frontier.hash {
            return Err(Error::Equivocation);
        }
        let head = Head {
            seq: header.seq,
            hash: *hash,
        };
        return Ok((start.verified, head));
    }
    if header.seq <= last.seq {
        let accepted = if header.seq == last.seq {
            Some(last.hash)
        } else {
            records.accepted_hash(&header.group, &header.sender, header.seq)?
        };
        // Below the last accepted number without a record there is nothing to compare with: it is not new.
        return match accepted {
            Some(accepted) if accepted != *hash => Err(Error::Equivocation),
            _ => Err(Error::Replay),
        };
    }
    if last.seq.checked_add(1) != Some(header.seq) {
        return Err(Error::Gap);
    }
    if header.prev != last.hash {
        return Err(Error::ChainBreak);
    }
    let head = Head {
        seq: header.seq,
        hash: *hash,
    };
    Ok((last, head))
}

/// Check 8: an envelope of the newest processed epoch is fresh; one of an older epoch is `wrong-epoch` unless
/// it came within the grace of the Commit that ended its epoch.
fn fresh(
    facts: &dyn GroupFacts,
    header: &Header,
    current: u64,
    mode: Mode,
    now_ms: u64,
) -> Result<bool, Error> {
    if header.epoch == current {
        return Ok(true);
    }
    // Check 2 has passed, so the epoch is older and its end is known, unless the facts contradict themselves.
    let end = facts
        .epoch_end(&header.group, header.epoch)?
        .ok_or(Error::Internal("an ended epoch without its Commit"))?;
    Ok(match mode {
        Mode::Hub => {
            header.epoch.checked_add(1) == Some(current)
                && now_ms.saturating_sub(end.processed_at) <= LIVE_GRACE_MS
        }
        Mode::InOrder => now_ms.saturating_sub(end.processed_at) <= LIVE_GRACE_MS,
        Mode::ReadingBack => header.time.saturating_sub(end.time) <= READ_BACK_GRACE_MS,
    })
}

/// Checks 7 and 8 and what the hub checks beside them, for an envelope that has its place in the chain: the
/// transition of its object, or the code it is refused with.
fn judge_chained(
    facts: &dyn GroupFacts,
    chains: &Chains,
    objects: &Objects,
    verified: &Verified,
    mode: Mode,
    now_ms: u64,
) -> Result<Result<Option<Transition>, Error>, Error> {
    let header = &verified.envelope.header;
    let transition = match objects::judge(facts, objects, header, &verified.hash) {
        Ok(transition) => transition,
        Err(Error::Forbidden) => return Ok(Err(Error::Forbidden)),
        Err(fault) => return Err(fault),
    };
    if !fresh(facts, header, verified.current, mode, now_ms)? {
        return Ok(Err(Error::WrongEpoch));
    }
    if mode != Mode::ReadingBack {
        if facts.is_stale(&header.group)? {
            return Ok(Err(Error::StaleSession));
        }
        if chains.count(header.epoch) >= MAX_ENVELOPES_PER_EPOCH {
            return Ok(Err(Error::EpochFull));
        }
    }
    // The length of the sealed body is the hub's alone to judge: it takes only the full form. A device may
    // be served the same envelope pruned, where no length is left, and the signature covers the body's hash,
    // not its length. So a device takes an envelope the hub served as stored by its header in either form,
    // and a body that is too long does not open (check 9).
    if mode == Mode::Hub && verified.envelope.is_oversize() {
        return Ok(Err(Error::TooLarge));
    }
    Ok(Ok(transition))
}

/// Whether a void record's reason holds against the receiver's own header checks and group state: the finding
/// `hub-voided-other` if it cannot be checked again.
fn recheck_void(
    facts: &dyn GroupFacts,
    chains: &Chains,
    objects: &Objects,
    verified: &Verified,
    code: &Error,
    mode: Mode,
) -> Result<Option<Error>, Error> {
    let header = &verified.envelope.header;
    let holds = match code {
        Error::Forbidden => match objects::judge(facts, objects, header, &verified.hash) {
            Ok(_) => false,
            Err(Error::Forbidden) => true,
            Err(fault) => return Err(fault),
        },
        // The hub's two minutes cannot be measured again; that the epoch has ended can.
        Error::WrongEpoch => header.epoch < verified.current,
        Error::StaleSession => mode == Mode::InOrder && facts.is_stale(&header.group)?,
        Error::EpochFull => {
            mode == Mode::InOrder && chains.count(header.epoch) >= MAX_ENVELOPES_PER_EPOCH
        }
        // A void record is pruned: its size is gone. Nothing else is a reason for a void record.
        _ => false,
    };
    Ok((!holds).then_some(Error::HubVoidedOther))
}

#[allow(clippy::too_many_arguments)]
fn take(
    facts: &dyn GroupFacts,
    records: &dyn ChainRecords,
    chains: &Chains,
    objects: &Objects,
    me: Option<&DeviceId>,
    verified: Verified,
    served: &Served,
    mode: Mode,
    now_ms: u64,
) -> Result<Receipt, Error> {
    let header = &verified.envelope.header;
    let (prev, head) = link(records, chains, header, &verified.hash)?;
    let advance = Advance {
        sender: header.sender,
        prev,
        head,
        epoch: header.epoch,
        revision: chains.revision,
    };
    let outcome = if let Served::Void(code) = served {
        // A void record is pruned and carries one of five codes; any other is a finding whoever sent it.
        let well_formed = VOID_CODES.contains(code) && verified.envelope.is_pruned();
        let finding = if !well_formed {
            Some(Error::HubVoidedOther)
        } else if me == Some(&header.sender) {
            None
        } else {
            recheck_void(facts, chains, objects, &verified, code, mode)?
        };
        Outcome::Void {
            code: code.clone(),
            finding,
        }
    } else if header.subject.is_reserved() {
        Outcome::Reserved
    } else {
        match judge_chained(facts, chains, objects, &verified, mode, now_ms)? {
            Err(code) => Outcome::Refused(code),
            Ok(transition) => {
                let body = if mode == Mode::Hub {
                    Err(Error::NoKey)
                } else {
                    open(facts, &verified.envelope)
                };
                // A fault of the verifier itself is not a property of the envelope.
                if let Err(fault @ (Error::Storage(_) | Error::Internal(_) | Error::Entropy)) = body
                {
                    return Err(fault);
                }
                Outcome::Taken {
                    transition: transition.map(Box::new),
                    body,
                }
            }
        }
    };
    Ok(Receipt {
        hash: verified.hash,
        envelope: verified.envelope,
        advance,
        outcome,
    })
}

/// Check 9: the body, opened with the content key of the envelope's group and epoch.
fn open(facts: &dyn GroupFacts, envelope: &Envelope) -> Result<Body, Error> {
    if envelope.is_pruned() {
        return Err(Error::Pruned);
    }
    let key = facts
        .content_key(&envelope.header.group, envelope.header.epoch)?
        .ok_or(Error::NoKey)?;
    envelope.open(&key)
}

/// A device's checks on an envelope from the hub, in the order of section 9.0.5.
///
/// `Err` is a failure of checks 1 to 6 and consumes nothing: `too-large`, `bad-format`, `newer-version`,
/// `wrong-room`, `group-behind`, `not-member`, `removed-sender`, `equivocation`, `bad-signature`, `replay`,
/// `gap`, `chain-break` (or a fault of the verifier's own store). `Ok` means the envelope has taken its place in
/// its sender's chain: the caller applies [`Receipt::advance`] and, for [`Outcome::Taken`], the transition, and
/// stores both with the envelope in one write, whatever [`Receipt::outcome`] says.
///
/// `chains` and `objects` are the state of the envelope's group. `me` is this device. The envelopes of a group
/// are handed in by ascending change number, the hub's order, by whichever route they came: an object's state
/// is judged against the envelopes before it in that order, and a sender's numbers ascend with it. `mode` says
/// whether the group state in `facts` is the one of the envelope's place in that order or a later one. A pruned
/// envelope is checked like a full one and ends with the body `pruned`; whatever the hub served as stored
/// gives the same receipt in both forms but for the body. This device's own envelopes come back through here
/// like everyone's.
#[allow(clippy::too_many_arguments)]
pub fn receive(
    facts: &dyn GroupFacts,
    records: &dyn ChainRecords,
    chains: &Chains,
    objects: &Objects,
    me: &DeviceId,
    bytes: &[u8],
    served: &Served,
    mode: Mode,
    now_ms: u64,
) -> Result<Receipt, Error> {
    let verified = first_five(facts, Envelope::decode(bytes)?)?;
    take(
        facts,
        records,
        chains,
        objects,
        Some(me),
        verified,
        served,
        mode,
        now_ms,
    )
}

/// The hub's checks on an envelope a device posts (section 9.0.11): checks 1 to 8 without the body, the rules
/// of 9.2, `stale-session` and `epoch-full`, all by the code the devices run. `signed_in` is the device whose
/// token carried the request.
///
/// `Err` takes no number: what [`receive`] refuses in checks 1 to 6, `wrong-sender` when the envelope is not
/// signed by `signed_in`, and `bad-format` for a reserved kind or a pruned envelope. `Ok` with [`Outcome::Taken`] (its body is
/// `no-key`: the hub reads none) is an accepted envelope; `Ok` with [`Outcome::Refused`] is a void record: the
/// hub stores the envelope pruned with that code and answers `voided: true`. Either way the number is taken.
/// A new envelope comes in full form: a pruned one is `bad-format`, since nothing of its body can be judged
/// or stored.
/// The agent's lease (`lease-lost`) and the rules for files (section 11.3) are the hub's own, before this.
pub fn hub_take(
    facts: &dyn GroupFacts,
    records: &dyn ChainRecords,
    chains: &Chains,
    objects: &Objects,
    signed_in: &DeviceId,
    bytes: &[u8],
    now_ms: u64,
) -> Result<Receipt, Error> {
    let envelope = Envelope::decode(bytes)?;
    if envelope.header.subject.is_reserved() || envelope.is_pruned() {
        return Err(Error::BadFormat);
    }
    if envelope.header.sender != *signed_in {
        return Err(Error::WrongSender);
    }
    let verified = first_five(facts, envelope)?;
    take(
        facts,
        records,
        chains,
        objects,
        None,
        verified,
        &Served::Stored,
        Mode::Hub,
        now_ms,
    )
}

/// Where an envelope fetched out of order stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Standing {
    /// Its sender's chain reached its number with this very envelope, which passed checks 7 and 8 there.
    Accepted,
    /// Its sender's chain already holds this very envelope. Whether it was taken or refused there is in the
    /// receiver's record of that envelope.
    Chained,
    /// The chain has not reached it, or no record of that number is kept: it may be shown, marked as not yet
    /// confirmed, and no command is executed on it.
    Provisional,
}

/// An envelope fetched out of order (section 9.0.6): a page of a Chat, an object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Provisional {
    /// The envelope.
    pub envelope: Envelope,
    /// Its hash.
    pub hash: Hash32,
    /// Its body.
    pub body: Body,
    /// Whether the chain has confirmed it.
    pub standing: Standing,
}

impl Provisional {
    /// The standing after the sender's chain took the envelope of `receipt`: unchanged if that is another
    /// place of the chain; `hash-mismatch` if the chain reached this envelope's number with another envelope;
    /// `Accepted` if it reached it with this one and took it. If the chain refused it there, or the hub served
    /// it as a void record, the error is that code: the envelope is dropped from what is shown.
    pub fn confirm(&self, receipt: &Receipt) -> Result<Standing, Error> {
        let header = &self.envelope.header;
        let advance = &receipt.advance;
        if receipt.envelope.header.group != header.group
            || advance.sender != header.sender
            || advance.head.seq != header.seq
        {
            return Ok(self.standing);
        }
        if advance.head.hash != self.hash {
            return Err(Error::HashMismatch);
        }
        match &receipt.outcome {
            Outcome::Taken { .. } => Ok(Standing::Accepted),
            Outcome::Refused(code) | Outcome::Void { code, .. } => Err(code.clone()),
            Outcome::Reserved => Err(Error::NewerVersion),
        }
    }
}

/// Checks an envelope fetched out of order: checks 1 to 5, the sender's right to write such an item (check 7,
/// as far as it follows from the sender's role in the envelope's epoch; the object's state is judged when the
/// chain arrives, since it depends on the envelopes before it in the hub's order), freshness as when reading
/// back (check 8) and the body (check 9). Each failure is its check's code. `hash-mismatch` when the sender's
/// chain already holds another envelope under that number. The chain is not touched.
pub fn provisional(
    facts: &dyn GroupFacts,
    records: &dyn ChainRecords,
    chains: &Chains,
    bytes: &[u8],
    now_ms: u64,
) -> Result<Provisional, Error> {
    let verified = first_five(facts, Envelope::decode(bytes)?)?;
    let header = &verified.envelope.header;
    if header.subject.is_reserved() {
        return Err(Error::NewerVersion);
    }
    objects::sender_may(facts, header)?;
    if !fresh(facts, header, verified.current, Mode::ReadingBack, now_ms)? {
        return Err(Error::WrongEpoch);
    }
    let body = open(facts, &verified.envelope)?;
    let last = chains.head(&header.sender);
    let accepted = if header.seq == last.seq {
        Some(last.hash)
    } else if header.seq < last.seq {
        records.accepted_hash(&header.group, &header.sender, header.seq)?
    } else {
        None
    };
    let standing = match accepted {
        Some(accepted) if accepted == verified.hash => Standing::Chained,
        Some(_) => return Err(Error::HashMismatch),
        None => Standing::Provisional,
    };
    Ok(Provisional {
        hash: verified.hash,
        envelope: verified.envelope,
        body,
        standing,
    })
}

/// What a Cut does to a receiver that had accepted envelopes of the removed sender.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CutEffect {
    /// The removed sender.
    pub sender: DeviceId,
    /// The sender's chain head from now on, if it changes: the Cut.
    pub head: Option<Head>,
    /// The receiver's accepted envelopes of this sender from this number on lie beyond the Cut: it marks them
    /// `cut`, drops them from what it shows, and replays the group's object state without them
    /// ([`crate::objects::replay`]). `None` if it holds none.
    pub drop_from: Option<u64>,
    /// `equivocation` when the receiver had accepted another envelope under the Cut's number than the Cut
    /// names. The chain still ends at the Cut.
    pub finding: Option<Error>,
}

/// Applies the Cut of a removed sender (section 9.0.10) to the receiver's chain of it, when the receiver
/// processes the removing Commit. From then on check 4 refuses what lies beyond the Cut.
pub fn cut_chain(
    records: &dyn ChainRecords,
    chains: &Chains,
    group: &GroupId,
    sender: &DeviceId,
    cut: &Head,
) -> Result<CutEffect, Error> {
    let last = chains.head(sender);
    let mut effect = CutEffect {
        sender: *sender,
        head: None,
        drop_from: None,
        finding: None,
    };
    if last.seq < cut.seq {
        return Ok(effect);
    }
    let at_cut = if cut.seq == 0 {
        Some(Hash32::ZERO)
    } else if last.seq == cut.seq {
        Some(last.hash)
    } else {
        records.accepted_hash(group, sender, cut.seq)?
    };
    let equivocated = matches!(at_cut, Some(hash) if hash != cut.hash);
    if equivocated {
        effect.finding = Some(Error::Equivocation);
        effect.drop_from = Some(cut.seq);
    } else if last.seq > cut.seq {
        effect.drop_from = cut.seq.checked_add(1);
    }
    if last != *cut {
        effect.head = Some(*cut);
    }
    Ok(effect)
}

/// Whether a Commit may add to a group again a key that it, or an earlier Commit, removed with `cut` (section
/// 9.0.10): only if the verifier holds nothing of that key beyond the Cut. `held` is the last envelope of the
/// key's chain that the verifier holds, counting what a Cut already ended: for the hub every envelope it ever
/// took, for a member the head of the chain it accepted before it applies the Commit. `bad-commit` otherwise:
/// the chain is to go on from the Cut, and under the number after it another envelope already stands.
///
/// The hub decides this for everyone, since it holds every envelope it took. A member can tell only for what
/// it was served: one that holds more than the Cut names was served it by the hub, which should have refused
/// the Commit, and does not merge it. A member that holds less cannot tell and relies on the hub; what a hub
/// then serves of the old chain beyond the Cut fails check 4.
pub fn check_added_again(held: &Head, cut: &Head) -> Result<(), Error> {
    let beyond = held.seq > cut.seq || (held.seq == cut.seq && held.hash != cut.hash);
    if beyond {
        Err(Error::BadCommit)
    } else {
        Ok(())
    }
}

/// The value of the register `heads` (section 9.0.7): `{ "<sender>": [seq, envelope_hash] }` for every chain
/// accepted in the group, as JSON text; sender and hash in base64url.
pub fn heads_value(chains: &Chains) -> Result<String, Error> {
    let map: serde_json::Map<String, serde_json::Value> = chains
        .heads()
        .into_iter()
        .map(|(sender, head)| {
            (
                sender.to_base64url(),
                serde_json::json!([head.seq, head.hash.to_base64url()]),
            )
        })
        .collect();
    serde_json::to_string(&map).map_err(|_| Error::Internal("heads value"))
}

/// `{ "<sender>": [seq, envelope_hash] }` as it stands in JSON, read entry by entry so that a sender named
/// twice shows.
pub(crate) struct HeadsWire(Vec<(String, (u64, String))>);

impl<'de> Deserialize<'de> for HeadsWire {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Entries;

        impl<'de> Visitor<'de> for Entries {
            type Value = HeadsWire;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("an object of heads")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<HeadsWire, A::Error> {
                let mut entries = Vec::new();
                while let Some(entry) = map.next_entry()? {
                    entries.push(entry);
                }
                Ok(HeadsWire(entries))
            }
        }

        deserializer.deserialize_map(Entries)
    }
}

impl HeadsWire {
    /// The heads, ascending by sender; `bad-format` for a sender named twice, a number 0, or an id or hash
    /// that is not its canonical base64url.
    pub(crate) fn heads(self) -> Result<Vec<(DeviceId, Head)>, Error> {
        let mut heads = BTreeMap::new();
        for (sender, (seq, hash)) in self.0 {
            let sender = DeviceId::from_base64url(&sender)?;
            let hash = Hash32::from_slice(&base64url_decode(&hash)?)?;
            if seq == 0 || heads.insert(sender, Head { seq, hash }).is_some() {
                return Err(Error::BadFormat);
            }
        }
        Ok(heads.into_iter().collect())
    }
}

/// The heads a `heads` value names; `bad-format` unless the text is exactly such an object, each sender once,
/// no number 0.
pub fn parse_heads(value: &str) -> Result<Vec<(DeviceId, Head)>, Error> {
    serde_json::from_str::<HeadsWire>(value)
        .map_err(|_| Error::BadFormat)?
        .heads()
}

/// How a reader's own chain of one sender compares with a head another device names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeadStanding {
    /// The reader holds the named envelope.
    Held,
    /// The reader holds less: it fetches the sender's chain after `have`. If the hub then has nothing, the
    /// finding is `withheld` ([`HeadStanding::after_fetch`]).
    Behind {
        /// The reader's last accepted number of that sender.
        have: u64,
    },
    /// The reader holds another envelope under the named number: the finding is `equivocation`.
    Equivocation,
    /// The reader holds more than the named number and keeps no record of it: nothing to compare.
    Unknown,
}

impl HeadStanding {
    /// The finding once the hub was asked for the missing envelopes and the comparison was made again:
    /// `withheld` if the reader is still behind, `equivocation` for another hash under the same number.
    pub fn after_fetch(&self) -> Result<(), Error> {
        match self {
            Self::Held | Self::Unknown => Ok(()),
            Self::Behind { .. } => Err(Error::Withheld),
            Self::Equivocation => Err(Error::Equivocation),
        }
    }
}

/// Compares the heads another device wrote with the reader's own chains of the same group (section 9.0.7).
pub fn compare_heads(
    records: &dyn ChainRecords,
    chains: &Chains,
    group: &GroupId,
    named: &[(DeviceId, Head)],
) -> Result<Vec<(DeviceId, HeadStanding)>, Error> {
    let mut standings = Vec::new();
    for (sender, head) in named {
        let own = chains.head(sender);
        let standing = if own.seq < head.seq {
            HeadStanding::Behind { have: own.seq }
        } else {
            let held = if own.seq == head.seq {
                Some(own.hash)
            } else {
                records.accepted_hash(group, sender, head.seq)?
            };
            match held {
                Some(hash) if hash == head.hash => HeadStanding::Held,
                Some(_) => HeadStanding::Equivocation,
                None => HeadStanding::Unknown,
            }
        };
        standings.push((*sender, standing));
    }
    Ok(standings)
}
