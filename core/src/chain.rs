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
    /// removed the device. A Cut is for ever: it stays the answer even if the same key is a leaf of the group
    /// again later, and if the key was removed more than once, the first Cut stands.
    fn cut(&self, group: &GroupId, device: &DeviceId) -> Result<Option<Head>, Error>;

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
    /// How many changes this state has taken. An envelope is checked against one revision and its step fits
    /// only that one.
    revision: u64,
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
        Self {
            heads: frontier.iter().copied().collect(),
            ..Self::new()
        }
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
        if self.revision != advance.revision || self.head(&advance.sender) != advance.prev {
            return Err(Error::Internal("a chain step applied out of turn"));
        }
        self.revision = self.revision.saturating_add(1);
        self.heads.insert(advance.sender, advance.head);
        let count = self.counts.entry(advance.epoch).or_insert(0);
        *count = count.saturating_add(1);
        Ok(())
    }

    /// Ends a removed sender's chain at its Cut.
    pub fn apply_cut(&mut self, effect: &CutEffect) {
        if let Some(head) = effect.head {
            self.heads.insert(effect.sender, head);
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
        let mut writer = Writer::new();
        writer.u64(self.revision);
        writer.vector(&heads)?;
        writer.vector(&counts)?;
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
/// what [`envelope::seal`] refuses. A refusal uses up no number and leaves `own` as it was.
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
    if facts.cut(&group, &sender)?.is_some() {
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
    /// 9: the opened body, or `no-key`, `pruned`, `decrypt-failed`, `bad-format`, `newer-version` (the hub, which
    /// holds no key, always has `no-key`). Without a body nothing is shown or acted on, but the transition
    /// counts: object state follows the headers.
    Taken {
        /// The object's change of state.
        transition: Option<Box<Transition>>,
        /// The body, or why there is none.
        body: Result<Body, Error>,
    },
    /// It failed check 7 or 8, or what the hub checks beside them: `forbidden`, `wrong-epoch`, `stale-session`,
    /// `epoch-full`, `too-large`. It is chained and never applied; the hub stores it as a void record.
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
        if header.seq > cut.seq {
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

/// Check 6: the envelope is the next of its sender's chain. `replay` for an envelope already accepted,
/// `equivocation` for another one under an accepted number, `gap` for a number beyond the next, `chain-break`
/// for the next number with a `prev` that is not the last accepted hash.
fn link(
    records: &dyn ChainRecords,
    chains: &Chains,
    header: &Header,
    hash: &Hash32,
) -> Result<Head, Error> {
    let last = chains.head(&header.sender);
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
    Ok(Head {
        seq: header.seq,
        hash: *hash,
    })
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
    if verified.envelope.is_oversize() {
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
    let head = link(records, chains, header, &verified.hash)?;
    let advance = Advance {
        sender: header.sender,
        prev: chains.head(&header.sender),
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
/// whether the group state in `facts` is the one of the envelope's place in that order or a later one; a pruned envelope is checked like a full one and ends
/// with the body `pruned`. This device's own envelopes come back through here like everyone's.
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
/// signed by `signed_in`, and `bad-format` for a reserved kind. `Ok` with [`Outcome::Taken`] (its body is
/// `no-key`: the hub reads none) is an accepted envelope; `Ok` with [`Outcome::Refused`] is a void record: the
/// hub stores the envelope pruned with that code and answers `voided: true`. Either way the number is taken.
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
    if envelope.header.subject.is_reserved() {
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

#[cfg(test)]
pub(crate) mod testing {
    //! A hand-written room for the tests of the stored-content modules: groups with their epochs, leaves and
    //! roles, and a receiver that stores what it accepts.

    use super::*;
    use crate::envelope::testing::{device, key, signer, TestEntropy};
    use crate::ids::SessionId;
    use std::collections::BTreeSet;

    pub(crate) const ROOM: RoomId = RoomId::new([1; 32]);
    pub(crate) const SESSION: SessionId = SessionId::new([2; 16]);
    pub(crate) const HELPER_SESSION: SessionId = SessionId::new([3; 16]);
    /// The receiver's clock in most tests.
    pub(crate) const NOW: u64 = 1_700_000_000_000;

    pub(crate) fn room() -> GroupId {
        GroupId::room(ROOM)
    }

    pub(crate) fn session() -> GroupId {
        GroupId::session(ROOM, SESSION)
    }

    pub(crate) fn helper_session() -> GroupId {
        GroupId::session(ROOM, HELPER_SESSION)
    }

    #[derive(Default, Clone)]
    pub(crate) struct FakeEpoch {
        pub leaves: BTreeMap<DeviceId, Role>,
        pub end: Option<EpochEnd>,
        pub no_key: bool,
    }

    #[derive(Default, Clone)]
    pub(crate) struct FakeGroup {
        pub epochs: Vec<FakeEpoch>,
        pub cuts: BTreeMap<DeviceId, Head>,
        pub stale: bool,
    }

    /// Group facts written by hand, and the receiver's table of accepted envelopes.
    #[derive(Default, Clone)]
    pub(crate) struct Fake {
        pub groups: BTreeMap<GroupId, FakeGroup>,
        pub humans_now: BTreeSet<DeviceId>,
        pub accepted: BTreeMap<(GroupId, DeviceId, u64), Hash32>,
        pub hub: bool,
    }

    impl Fake {
        /// Devices 1 and 2 are human, 3 is the agent of the main session, which has opened a helper session
        /// with helper device 4. Every group stands in epoch 0.
        pub(crate) fn new() -> Self {
            let mut fake = Self::default();
            let humans = [(device(1), Role::Human), (device(2), Role::Human)];
            fake.humans_now = humans.iter().map(|(d, _)| *d).collect();
            fake.add_group(room(), &humans);
            fake.add_group(session(), &[humans[0], humans[1], (device(3), Role::Agent)]);
            fake.add_group(
                helper_session(),
                &[
                    humans[0],
                    humans[1],
                    (device(3), Role::Opener),
                    (device(4), Role::Helper),
                ],
            );
            fake
        }

        pub(crate) fn add_group(&mut self, group: GroupId, leaves: &[(DeviceId, Role)]) {
            let epoch = FakeEpoch {
                leaves: leaves.iter().copied().collect(),
                ..FakeEpoch::default()
            };
            self.groups.insert(
                group,
                FakeGroup {
                    epochs: vec![epoch],
                    ..FakeGroup::default()
                },
            );
        }

        pub(crate) fn group(&mut self, group: &GroupId) -> &mut FakeGroup {
            self.groups.get_mut(group).unwrap()
        }

        /// A Commit in `group`, processed at `processed_at` with the note's `time`: the next epoch begins with
        /// the leaves `change` makes of the current ones.
        pub(crate) fn commit(
            &mut self,
            group: &GroupId,
            processed_at: u64,
            time: u64,
            change: impl FnOnce(&mut BTreeMap<DeviceId, Role>),
        ) {
            let epochs = &mut self.group(group).epochs;
            let last = epochs.last_mut().unwrap();
            last.end = Some(EpochEnd { processed_at, time });
            let mut leaves = last.leaves.clone();
            change(&mut leaves);
            epochs.push(FakeEpoch {
                leaves,
                ..FakeEpoch::default()
            });
        }

        fn epoch(&self, group: &GroupId, epoch: u64) -> Option<&FakeEpoch> {
            self.groups
                .get(group)?
                .epochs
                .get(usize::try_from(epoch).ok()?)
        }
    }

    impl GroupFacts for Fake {
        fn room(&self) -> RoomId {
            ROOM
        }

        fn processed_epoch(&self, group: &GroupId) -> Result<Option<u64>, Error> {
            Ok(self.groups.get(group).map(|g| g.epochs.len() as u64 - 1))
        }

        fn leaf_role(
            &self,
            group: &GroupId,
            epoch: u64,
            device: &DeviceId,
        ) -> Result<Option<Role>, Error> {
            Ok(self
                .epoch(group, epoch)
                .and_then(|e| e.leaves.get(device).copied()))
        }

        fn seat(&self, group: &GroupId, epoch: u64) -> Result<Option<DeviceId>, Error> {
            Ok(self.epoch(group, epoch).and_then(|e| {
                e.leaves
                    .iter()
                    .find(|(_, role)| matches!(role, Role::Agent | Role::Opener))
                    .map(|(device, _)| *device)
            }))
        }

        fn cut(&self, group: &GroupId, device: &DeviceId) -> Result<Option<Head>, Error> {
            Ok(self
                .groups
                .get(group)
                .and_then(|g| g.cuts.get(device).copied()))
        }

        fn epoch_end(&self, group: &GroupId, epoch: u64) -> Result<Option<EpochEnd>, Error> {
            Ok(self.epoch(group, epoch).and_then(|e| e.end))
        }

        fn is_stale(&self, group: &GroupId) -> Result<bool, Error> {
            Ok(self.groups.get(group).is_some_and(|g| g.stale))
        }

        fn is_human_now(&self, device: &DeviceId) -> Result<bool, Error> {
            Ok(self.humans_now.contains(device))
        }

        fn content_key(&self, group: &GroupId, epoch: u64) -> Result<Option<Secret<32>>, Error> {
            Ok(self
                .epoch(group, epoch)
                .filter(|e| !e.no_key && !self.hub)
                .map(|_| key(epoch)))
        }
    }

    impl ChainRecords for Fake {
        fn accepted_hash(
            &self,
            group: &GroupId,
            sender: &DeviceId,
            seq: u64,
        ) -> Result<Option<Hash32>, Error> {
            Ok(self.accepted.get(&(*group, *sender, seq)).copied())
        }
    }

    /// One receiver (device 1 unless said otherwise) with its state, and every sender's own chain.
    pub(crate) struct World {
        pub fake: Fake,
        pub me: DeviceId,
        pub chains: BTreeMap<GroupId, Chains>,
        pub objects: BTreeMap<GroupId, Objects>,
        pub own: BTreeMap<(GroupId, u8), OwnChain>,
        pub entropy: TestEntropy,
        pub now: u64,
    }

    impl World {
        pub(crate) fn new() -> Self {
            Self {
                fake: Fake::new(),
                me: device(1),
                chains: BTreeMap::new(),
                objects: BTreeMap::new(),
                own: BTreeMap::new(),
                entropy: TestEntropy(1),
                now: NOW,
            }
        }

        pub(crate) fn chains(&self, group: &GroupId) -> Chains {
            self.chains.get(group).cloned().unwrap_or_default()
        }

        pub(crate) fn objects(&self, group: &GroupId) -> Objects {
            self.objects.get(group).cloned().unwrap_or_default()
        }

        /// Device `n` signs its next envelope in `group` in `epoch`, whatever the rules say about it.
        pub(crate) fn sign_in_epoch(
            &mut self,
            n: u8,
            group: GroupId,
            epoch: u64,
            draft: &Draft,
        ) -> envelope::Sealed {
            let own = self.own.entry((group, n)).or_default();
            let slot = own.slot(group, epoch, device(n), self.now).unwrap();
            let sealed =
                envelope::seal(draft, &slot, &key(epoch), &signer(n), &mut self.entropy).unwrap();
            own.head = Head {
                seq: slot.seq,
                hash: sealed.hash,
            };
            sealed
        }

        /// What device `n` would sign next in `group`, with its header changed by `change` and signed as
        /// changed: a header no honest writer makes. The body stays sealed under the header before the change.
        pub(crate) fn forge(
            &mut self,
            n: u8,
            group: GroupId,
            draft: &Draft,
            change: impl FnOnce(&mut Header),
        ) -> Envelope {
            let mut envelope = self.sign(n, group, draft).envelope;
            change(&mut envelope.header);
            let hash = envelope.hash().unwrap();
            envelope.signature =
                crate::crypto::sign_with_label(&signer(n), "TrommiEnvelope", hash.as_bytes())
                    .unwrap()
                    .try_into()
                    .unwrap();
            self.own.insert(
                (group, n),
                OwnChain {
                    head: Head {
                        seq: envelope.header.seq,
                        hash,
                    },
                },
            );
            envelope
        }

        /// Device `n` signs its next envelope in `group`, in the group's newest epoch.
        pub(crate) fn sign(&mut self, n: u8, group: GroupId, draft: &Draft) -> envelope::Sealed {
            let epoch = self.fake.processed_epoch(&group).unwrap().unwrap();
            self.sign_in_epoch(n, group, epoch, draft)
        }

        /// The receiver's checks on `bytes`; what passes check 6 is applied and recorded.
        pub(crate) fn take_as(
            &mut self,
            bytes: &[u8],
            served: &Served,
            mode: Mode,
        ) -> Result<Receipt, Error> {
            let group = Envelope::decode(bytes)
                .map(|e| e.header.group)
                .unwrap_or(room());
            let receipt = receive(
                &self.fake,
                &self.fake,
                &self.chains(&group),
                &self.objects(&group),
                &self.me,
                bytes,
                served,
                mode,
                self.now,
            )?;
            self.record(&receipt);
            Ok(receipt)
        }

        pub(crate) fn record(&mut self, receipt: &Receipt) {
            let group = receipt.envelope.header.group;
            self.chains
                .entry(group)
                .or_default()
                .apply(&receipt.advance)
                .unwrap();
            if let Outcome::Taken {
                transition: Some(transition),
                ..
            } = &receipt.outcome
            {
                self.objects
                    .entry(group)
                    .or_default()
                    .apply(transition)
                    .unwrap();
            }
            self.fake.accepted.insert(
                (group, receipt.advance.sender, receipt.advance.head.seq),
                receipt.hash,
            );
        }

        /// The receiver's checks on a stored envelope that comes in the hub's order.
        pub(crate) fn take(&mut self, envelope: &Envelope) -> Result<Receipt, Error> {
            self.take_as(&envelope.encode().unwrap(), &Served::Stored, Mode::InOrder)
        }

        /// Device `n` signs `draft` in `group` and the receiver takes it.
        pub(crate) fn post(&mut self, n: u8, group: GroupId, draft: &Draft) -> Receipt {
            let sealed = self.sign(n, group, draft);
            self.take(&sealed.envelope).unwrap()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;
    use crate::envelope::testing::{device, payload, signer, version_payload, NoEntropy};
    use crate::envelope::{Content, ObjectType, Subject, Urgency};
    use crate::ids::{BoardId, RegisterId, SessionId};
    use serde_json::json;

    fn chat(text: &str) -> Draft {
        Draft::session_chat(SESSION, device(3), &payload(text))
    }

    fn agent_chat(text: &str) -> Draft {
        Draft::session_chat(SESSION, DeviceId::ZERO, &payload(text))
    }

    fn stroke() -> Draft {
        Draft::board_item(BoardId::ALL_DESKS, &payload("stroke"))
    }

    fn card() -> Draft {
        Draft::first_version(
            ObjectType::Card,
            Urgency::Normal,
            &version_payload(&Hash32::ZERO, json!({ "title": "?" })),
        )
        .unwrap()
    }

    fn taken(receipt: &Receipt) -> &Result<Body, Error> {
        match &receipt.outcome {
            Outcome::Taken { body, .. } => body,
            other => panic!("not taken: {other:?}"),
        }
    }

    #[test]
    fn a_chain_of_three_is_accepted_in_order() {
        let mut world = World::new();
        let mut prev = Hash32::ZERO;
        for (seq, text) in [(1, "one"), (2, "two"), (3, "three")] {
            let receipt = world.post(2, session(), &chat(text));
            assert_eq!(receipt.envelope.header.seq, seq);
            assert_eq!(receipt.envelope.header.prev, prev);
            assert_eq!(
                receipt.advance,
                Advance {
                    sender: device(2),
                    prev: Head {
                        seq: seq - 1,
                        hash: prev
                    },
                    head: Head {
                        seq,
                        hash: receipt.hash
                    },
                    epoch: 0,
                    revision: seq - 1
                }
            );
            assert_eq!(taken(&receipt).as_ref().unwrap().payload(), payload(text));
            prev = receipt.hash;
        }
        let chains = world.chains(&session());
        assert_eq!(chains.head(&device(2)), Head { seq: 3, hash: prev });
        assert_eq!(chains.head(&device(3)), Head::START);
        assert_eq!(chains.count(0), 3);
        // Chains of different senders and groups do not touch.
        world.post(3, session(), &agent_chat("hi"));
        world.post(2, room(), &stroke());
        assert_eq!(world.chains(&session()).head(&device(3)).seq, 1);
        assert_eq!(world.chains(&session()).head(&device(2)).seq, 3);
        assert_eq!(world.chains(&room()).head(&device(2)).seq, 1);
    }

    #[test]
    fn check_1_refuses_bad_encodings_and_other_rooms() {
        let mut world = World::new();
        let sealed = world.sign(2, session(), &chat("x"));
        let bytes = sealed.envelope.encode().unwrap();
        let take = |world: &mut World, bytes: &[u8]| {
            world
                .take_as(bytes, &Served::Stored, Mode::InOrder)
                .map(|_| ())
        };

        assert_eq!(
            take(&mut world, &bytes[..bytes.len() - 1]),
            Err(Error::BadFormat)
        );
        let mut flags = bytes.clone();
        flags[3] = 2;
        assert_eq!(take(&mut world, &flags), Err(Error::BadFormat));
        let mut newer = bytes.clone();
        newer[1] = 3;
        assert_eq!(take(&mut world, &newer), Err(Error::NewerVersion));
        assert_eq!(
            take(&mut world, &vec![0; envelope::MAX_ENVELOPE_LEN + 1]),
            Err(Error::TooLarge)
        );

        let other_room = GroupId::session(RoomId::new([9; 32]), SESSION);
        world
            .fake
            .add_group(other_room, &[(device(2), Role::Human)]);
        let foreign = world.sign(2, other_room, &chat("x"));
        assert_eq!(
            take(&mut world, &foreign.envelope.encode().unwrap()),
            Err(Error::WrongRoom)
        );
        // Nothing was consumed.
        assert_eq!(world.chains(&session()), Chains::new());
        assert!(take(&mut world, &bytes).is_ok());
    }

    #[test]
    fn check_2_refuses_an_epoch_or_group_not_yet_processed() {
        let mut world = World::new();
        let ahead = world.sign_in_epoch(2, session(), 1, &chat("x"));
        assert_eq!(world.take(&ahead.envelope).err(), Some(Error::GroupBehind));
        let unknown = GroupId::session(ROOM, SessionId::new([8; 16]));
        let mut sender = World::new();
        sender.fake.add_group(unknown, &[(device(2), Role::Human)]);
        let sealed = sender.sign(2, unknown, &chat("x"));
        assert_eq!(world.take(&sealed.envelope).err(), Some(Error::GroupBehind));
        // Once the Commit is processed the envelope is taken.
        world.fake.commit(&session(), NOW, NOW, |_| {});
        assert!(world.take(&ahead.envelope).is_ok());
    }

    #[test]
    fn check_3_refuses_a_sender_that_was_no_leaf_in_the_epoch() {
        let mut world = World::new();
        // Device 5 is a leaf of nothing.
        let sealed = world.sign(5, session(), &agent_chat("x"));
        assert_eq!(world.take(&sealed.envelope).err(), Some(Error::NotMember));
        // The agent is no leaf of the room group.
        let sealed = world.sign(3, room(), &stroke());
        assert_eq!(world.take(&sealed.envelope).err(), Some(Error::NotMember));
        // Device 5 joins in epoch 1: its envelope naming epoch 0 is still refused.
        world.fake.commit(&session(), NOW, NOW, |leaves| {
            leaves.insert(device(5), Role::Human);
        });
        let early = world.sign_in_epoch(5, session(), 0, &chat("x"));
        assert_eq!(world.take(&early.envelope).err(), Some(Error::NotMember));
        assert_eq!(world.chains(&session()), Chains::new());
    }

    #[test]
    fn check_4_ends_a_removed_senders_chain_at_its_cut() {
        let mut world = World::new();
        let first = world.post(2, session(), &chat("one"));
        let second = world.sign(2, session(), &chat("two"));
        let third = world.sign(2, session(), &chat("three"));
        // The remover had accepted number 2. This receiver holds number 1.
        world.fake.commit(&session(), NOW, NOW, |leaves| {
            leaves.remove(&device(2));
        });
        let cut = Head {
            seq: 2,
            hash: second.hash,
        };
        world.fake.group(&session()).cuts.insert(device(2), cut);
        let effect = cut_chain(
            &world.fake,
            &world.chains(&session()),
            &session(),
            &device(2),
            &cut,
        )
        .unwrap();
        assert_eq!(
            (effect.head, effect.drop_from, effect.finding),
            (None, None, None)
        );

        // Beyond the Cut: refused, in whatever order it comes.
        assert_eq!(
            world.take(&third.envelope).err(),
            Some(Error::RemovedSender)
        );
        // Up to the Cut the chain is still read.
        let receipt = world
            .take_as(
                &second.envelope.encode().unwrap(),
                &Served::Stored,
                Mode::ReadingBack,
            )
            .unwrap();
        assert_eq!(receipt.advance.head, cut);
        assert_eq!(
            world.take(&third.envelope).err(),
            Some(Error::RemovedSender)
        );
        assert_eq!(world.chains(&session()).head(&device(2)), cut);
        assert_ne!(first.hash, second.hash);
    }

    #[test]
    fn check_4_finds_another_envelope_at_the_cut() {
        let mut world = World::new();
        world.post(2, session(), &chat("one"));
        // The sender signs two envelopes under number 2: the remover saw one, this receiver is served the other.
        let seen_by_remover = world.sign(2, session(), &chat("two"));
        world.own.insert(
            (session(), 2),
            OwnChain {
                head: world.chains(&session()).head(&device(2)),
            },
        );
        let served_here = world.sign(2, session(), &chat("two, again"));
        world.fake.commit(&session(), NOW, NOW, |leaves| {
            leaves.remove(&device(2));
        });
        world.fake.group(&session()).cuts.insert(
            device(2),
            Head {
                seq: 2,
                hash: seen_by_remover.hash,
            },
        );
        assert_eq!(
            world
                .take_as(
                    &served_here.envelope.encode().unwrap(),
                    &Served::Stored,
                    Mode::ReadingBack
                )
                .err(),
            Some(Error::Equivocation)
        );
        // A Cut of nothing refuses everything.
        let mut world = World::new();
        let sealed = world.sign(2, session(), &chat("one"));
        world
            .fake
            .group(&session())
            .cuts
            .insert(device(2), Head::START);
        assert_eq!(
            world.take(&sealed.envelope).err(),
            Some(Error::RemovedSender)
        );
    }

    #[test]
    fn check_5_refuses_a_wrong_signature_before_the_chain_moves() {
        let mut world = World::new();
        let sealed = world.sign(2, session(), &chat("x"));
        let mut forged = sealed.envelope.clone();
        forged.signature[10] ^= 1;
        assert_eq!(world.take(&forged).err(), Some(Error::BadSignature));
        // Signed by another leaf than the header names.
        let mut renamed = sealed.envelope.clone();
        renamed.header.sender = device(1);
        assert_eq!(world.take(&renamed).err(), Some(Error::BadSignature));
        // A header changed after signing.
        let mut moved = sealed.envelope.clone();
        moved.header.time += 1;
        assert_eq!(world.take(&moved).err(), Some(Error::BadSignature));
        assert_eq!(world.chains(&session()), Chains::new());
        assert!(world.take(&sealed.envelope).is_ok());
    }

    #[test]
    fn check_6_tells_replay_equivocation_gap_and_chain_break() {
        let mut world = World::new();
        let one = world.sign(2, session(), &chat("one"));
        let two = world.sign(2, session(), &chat("two"));
        let three = world.sign(2, session(), &chat("three"));

        // A gap: number 2 before number 1.
        assert_eq!(world.take(&two.envelope).err(), Some(Error::Gap));
        assert_eq!(world.take(&three.envelope).err(), Some(Error::Gap));
        world.take(&one.envelope).unwrap();
        assert_eq!(world.take(&three.envelope).err(), Some(Error::Gap));
        // A replay of the last and of an earlier one.
        assert_eq!(world.take(&one.envelope).err(), Some(Error::Replay));
        world.take(&two.envelope).unwrap();
        assert_eq!(world.take(&one.envelope).err(), Some(Error::Replay));
        assert_eq!(world.take(&two.envelope).err(), Some(Error::Replay));

        // A second envelope under number 2, and one under number 1.
        let slot = |seq, prev| Slot {
            group: session(),
            epoch: 0,
            sender: device(2),
            seq,
            prev,
            time: NOW,
        };
        let mut forge = |slot: Slot| {
            envelope::seal(
                &chat("other"),
                &slot,
                &crate::envelope::testing::key(0),
                &signer(2),
                &mut world.entropy,
            )
            .unwrap()
            .envelope
        };
        let second_two = forge(slot(2, one.hash));
        let second_one = forge(slot(1, Hash32::ZERO));
        // The right number with a `prev` that is not the last accepted hash.
        let broken_three = forge(slot(3, one.hash));
        assert_eq!(world.take(&second_two).err(), Some(Error::Equivocation));
        assert_eq!(world.take(&second_one).err(), Some(Error::Equivocation));
        assert_eq!(world.take(&broken_three).err(), Some(Error::ChainBreak));
        // Without a record of number 1 the receiver cannot tell, and takes it for a replay.
        world.fake.accepted.remove(&(session(), device(2), 1));
        assert_eq!(world.take(&second_one).err(), Some(Error::Replay));

        // None of this moved the chain.
        assert_eq!(
            world.chains(&session()).head(&device(2)),
            Head {
                seq: 2,
                hash: two.hash
            }
        );
        world.take(&three.envelope).unwrap();
    }

    #[test]
    fn check_7_chains_a_forbidden_envelope_and_applies_nothing() {
        let mut world = World::new();
        // A human device may not create a card.
        let sealed = world.sign(2, session(), &card());
        let receipt = world.take(&sealed.envelope).unwrap();
        assert_eq!(receipt.outcome, Outcome::Refused(Error::Forbidden));
        assert!(receipt.opened().is_none());
        assert_eq!(world.objects(&session()), Objects::new());
        // The chain has advanced: the sender's next envelope links to the refused one.
        let next = world.post(2, session(), &chat("next"));
        assert_eq!(next.envelope.header.prev, receipt.hash);
        assert_eq!(next.envelope.header.seq, 2);
        assert_eq!(world.chains(&session()).count(0), 2);
    }

    #[test]
    fn check_8_live_gives_an_old_epoch_two_minutes() {
        let mut world = World::new();
        let early = world.sign(2, session(), &chat("written before the Commit"));
        let late = world.sign(2, session(), &chat("too late"));
        world.fake.commit(&session(), NOW, NOW, |_| {});

        world.now = NOW + LIVE_GRACE_MS;
        assert!(taken(&world.take(&early.envelope).unwrap()).is_ok());
        world.now = NOW + LIVE_GRACE_MS + 1;
        let receipt = world.take(&late.envelope).unwrap();
        assert_eq!(receipt.outcome, Outcome::Refused(Error::WrongEpoch));
        // Chained all the same.
        assert_eq!(world.chains(&session()).head(&device(2)).seq, 2);
        // An envelope of the current epoch is fresh at any time, and a clock that ran backwards harms nothing.
        world.now = NOW + 10 * LIVE_GRACE_MS;
        assert!(taken(&world.post(2, session(), &chat("now"))).is_ok());
        let old = world.sign_in_epoch(1, session(), 0, &chat("old"));
        world.now = NOW - 5;
        assert!(taken(&world.take(&old.envelope).unwrap()).is_ok());
    }

    #[test]
    fn check_8_reading_back_compares_the_times_of_envelope_and_commit() {
        let mut world = World::new();
        let commit_time = NOW + 1000;
        world.now = commit_time + READ_BACK_GRACE_MS;
        let in_time = world.sign(2, session(), &chat("in time"));
        world.now += 1;
        let late = world.sign(2, session(), &chat("late"));
        // The Commit was processed long ago: reading back does not ask for that.
        world.fake.commit(&session(), NOW, commit_time, |_| {});
        world.now = NOW + 365 * 24 * 3600 * 1000;

        let back = |world: &mut World, envelope: &Envelope| {
            world
                .take_as(
                    &envelope.encode().unwrap(),
                    &Served::Stored,
                    Mode::ReadingBack,
                )
                .unwrap()
        };
        assert!(taken(&back(&mut world, &in_time.envelope)).is_ok());
        assert_eq!(
            back(&mut world, &late.envelope).outcome,
            Outcome::Refused(Error::WrongEpoch)
        );
        // The same early envelope, read live a year later, is refused.
        let mut live = World::new();
        live.now = commit_time;
        let sealed = live.sign(2, session(), &chat("in time"));
        live.fake.commit(&session(), NOW, commit_time, |_| {});
        live.now = NOW + 365 * 24 * 3600 * 1000;
        assert_eq!(
            live.take(&sealed.envelope).unwrap().outcome,
            Outcome::Refused(Error::WrongEpoch)
        );
    }

    #[test]
    fn check_9_gives_each_body_failure_its_code_and_still_counts_the_header() {
        let mut world = World::new();
        // No key for the epoch.
        world.fake.group(&session()).epochs[0].no_key = true;
        let sealed = world.sign(3, session(), &card());
        let receipt = world.take(&sealed.envelope).unwrap();
        let Outcome::Taken { transition, body } = &receipt.outcome else {
            panic!("taken");
        };
        assert_eq!(body, &Err(Error::NoKey));
        // The object exists all the same: its state follows the headers.
        assert!(transition.is_some());
        assert!(receipt.opened().is_none());
        assert_eq!(world.objects(&session()).iter().count(), 1);
        world.fake.group(&session()).epochs[0].no_key = false;

        // A pruned envelope carries the chain.
        let sealed = world.sign(3, session(), &agent_chat("pruned"));
        let pruned = sealed.envelope.prune().unwrap();
        let receipt = world.take(&pruned).unwrap();
        assert_eq!(taken(&receipt), &Err(Error::Pruned));
        assert_eq!(receipt.hash, sealed.hash);

        // A body sealed under another key.
        let slot = world.own[&(session(), 3)]
            .slot(session(), 0, device(3), NOW)
            .unwrap();
        let wrong_key = envelope::seal(
            &agent_chat("x"),
            &slot,
            &Secret::new([9; 32]),
            &signer(3),
            &mut world.entropy,
        )
        .unwrap();
        let receipt = world.take(&wrong_key.envelope).unwrap();
        assert_eq!(taken(&receipt), &Err(Error::DecryptFailed));
        assert_eq!(world.chains(&session()).head(&device(3)).seq, 3);
    }

    #[test]
    fn a_reserved_kind_is_verified_and_chained_and_nothing_else() {
        let mut world = World::new();
        let one = world.post(2, session(), &chat("one"));
        let mut envelope = world.forge(2, session(), &chat("two"), |header| {
            header.subject = Subject::Reserved {
                kind: 9,
                block: [0xEE; envelope::OBJECT_BLOCK_LEN],
            };
        });
        let receipt = world.take(&envelope).unwrap();
        assert_eq!(receipt.outcome, Outcome::Reserved);
        assert_eq!(receipt.envelope.header.prev, one.hash);
        assert_eq!(world.chains(&session()).head(&device(2)).seq, 2);
        // With a wrong signature it is refused like any other.
        let mut forged = envelope.clone();
        forged.header.seq = 3;
        assert_eq!(world.take(&forged).err(), Some(Error::BadSignature));
        // The hub takes none.
        let mut hub = World::new();
        hub.fake.hub = true;
        envelope.header.seq = 1;
        assert_eq!(
            hub_take(
                &hub.fake,
                &hub.fake,
                &Chains::new(),
                &Objects::new(),
                &device(2),
                &envelope.encode().unwrap(),
                NOW
            )
            .err(),
            Some(Error::BadFormat)
        );
        // Nor is one shown before its chain arrives.
        assert_eq!(
            provisional(
                &world.fake,
                &world.fake,
                &world.chains(&session()),
                &receipt.envelope.encode().unwrap(),
                NOW
            )
            .err(),
            Some(Error::NewerVersion)
        );
    }

    fn void(world: &mut World, envelope: &Envelope, code: Error, mode: Mode) -> Outcome {
        world
            .take_as(
                &envelope.prune().unwrap().encode().unwrap(),
                &Served::Void(code),
                mode,
            )
            .unwrap()
            .outcome
    }

    #[test]
    fn a_void_record_is_chained_and_never_applied() {
        let mut world = World::new();
        // The hub voided a card that a human device tried to create: the receiver finds the same.
        let forbidden = world.sign(2, session(), &card());
        assert_eq!(
            void(
                &mut world,
                &forbidden.envelope,
                Error::Forbidden,
                Mode::InOrder
            ),
            Outcome::Void {
                code: Error::Forbidden,
                finding: None
            }
        );
        assert_eq!(world.objects(&session()), Objects::new());
        assert_eq!(world.chains(&session()).head(&device(2)).seq, 1);
        assert_eq!(world.chains(&session()).count(0), 1);
        // The next envelope links to the void record.
        let next = world.post(2, session(), &chat("next"));
        assert_eq!(next.envelope.header.prev, forbidden.hash);

        // A void record still has to pass checks 1 to 6.
        let again = world.sign(2, session(), &chat("x"));
        let mut forged = again.envelope.prune().unwrap();
        forged.signature[0] ^= 1;
        assert_eq!(
            world
                .take_as(
                    &forged.encode().unwrap(),
                    &Served::Void(Error::Forbidden),
                    Mode::InOrder
                )
                .err(),
            Some(Error::BadSignature)
        );
    }

    #[test]
    fn a_void_of_another_sender_that_cannot_be_checked_again_is_a_finding() {
        let finding = Some(Error::HubVoidedOther);
        let mut world = World::new();

        // `forbidden` on an envelope the receiver's own rules allow.
        let allowed = world.sign(2, session(), &chat("fine"));
        assert_eq!(
            void(
                &mut world,
                &allowed.envelope,
                Error::Forbidden,
                Mode::InOrder
            ),
            Outcome::Void {
                code: Error::Forbidden,
                finding: finding.clone()
            }
        );
        // `wrong-epoch` on an envelope of the current epoch; fine once the epoch has ended.
        let current = world.sign(2, session(), &chat("x"));
        assert_eq!(
            void(
                &mut world,
                &current.envelope,
                Error::WrongEpoch,
                Mode::InOrder
            ),
            Outcome::Void {
                code: Error::WrongEpoch,
                finding: finding.clone()
            }
        );
        let old = world.sign(2, session(), &chat("x"));
        world.fake.commit(&session(), NOW, NOW, |_| {});
        assert_eq!(
            void(&mut world, &old.envelope, Error::WrongEpoch, Mode::InOrder),
            Outcome::Void {
                code: Error::WrongEpoch,
                finding: None
            }
        );
        // `stale-session`: checked against the state of the moment, so only in the hub's order.
        let sealed = world.sign(2, session(), &chat("x"));
        assert_eq!(
            void(
                &mut world,
                &sealed.envelope,
                Error::StaleSession,
                Mode::InOrder
            ),
            Outcome::Void {
                code: Error::StaleSession,
                finding: finding.clone()
            }
        );
        world.fake.group(&session()).stale = true;
        let sealed = world.sign(2, session(), &chat("x"));
        assert_eq!(
            void(
                &mut world,
                &sealed.envelope,
                Error::StaleSession,
                Mode::InOrder
            ),
            Outcome::Void {
                code: Error::StaleSession,
                finding: None
            }
        );
        let sealed = world.sign(2, session(), &chat("x"));
        assert_eq!(
            void(
                &mut world,
                &sealed.envelope,
                Error::StaleSession,
                Mode::ReadingBack
            ),
            Outcome::Void {
                code: Error::StaleSession,
                finding: finding.clone()
            }
        );
        world.fake.group(&session()).stale = false;
        // `epoch-full` below the limit; `too-large`, which a pruned record cannot show; any other code.
        for code in [Error::EpochFull, Error::TooLarge, Error::RateLimited] {
            let sealed = world.sign(2, session(), &chat("x"));
            assert_eq!(
                void(&mut world, &sealed.envelope, code.clone(), Mode::InOrder),
                Outcome::Void {
                    code,
                    finding: finding.clone()
                }
            );
        }
        // `epoch-full` at the limit.
        let mut full = World::new();
        full.chains.insert(
            session(),
            Chains {
                counts: [(0, MAX_ENVELOPES_PER_EPOCH)].into(),
                ..Chains::new()
            },
        );
        let sealed = full.sign(2, session(), &chat("x"));
        assert_eq!(
            void(&mut full, &sealed.envelope, Error::EpochFull, Mode::InOrder),
            Outcome::Void {
                code: Error::EpochFull,
                finding: None
            }
        );

        // A code no void record may carry is a finding even on the receiver's own envelope.
        let mut own = World::new();
        own.me = device(2);
        let sealed = own.sign(2, session(), &chat("x"));
        assert_eq!(
            void(
                &mut own,
                &sealed.envelope,
                Error::BadSignature,
                Mode::InOrder
            ),
            Outcome::Void {
                code: Error::BadSignature,
                finding: finding.clone()
            }
        );
        // So is a void record that still carries its body.
        let sealed = own.sign(2, session(), &chat("x"));
        let receipt = own
            .take_as(
                &sealed.envelope.encode().unwrap(),
                &Served::Void(Error::WrongEpoch),
                Mode::InOrder,
            )
            .unwrap();
        assert_eq!(
            receipt.outcome,
            Outcome::Void {
                code: Error::WrongEpoch,
                finding: finding.clone()
            }
        );
        // The receiver's own voided envelope is no finding: the hub told it why.
        let mut own = World::new();
        own.me = device(2);
        let sealed = own.sign(2, session(), &chat("x"));
        assert_eq!(
            void(&mut own, &sealed.envelope, Error::TooLarge, Mode::InOrder),
            Outcome::Void {
                code: Error::TooLarge,
                finding: None
            }
        );
    }

    #[test]
    fn a_stale_session_a_full_epoch_and_an_oversize_body_are_refused_after_the_chain() {
        let mut world = World::new();
        world.fake.group(&session()).stale = true;
        let sealed = world.sign(2, session(), &chat("x"));
        assert_eq!(
            world.take(&sealed.envelope).unwrap().outcome,
            Outcome::Refused(Error::StaleSession)
        );
        // Reading back, the state of the moment says nothing about then.
        let sealed = world.sign(2, session(), &chat("x"));
        let receipt = world
            .take_as(
                &sealed.envelope.encode().unwrap(),
                &Served::Stored,
                Mode::ReadingBack,
            )
            .unwrap();
        assert!(taken(&receipt).is_ok());
        world.fake.group(&session()).stale = false;

        let mut full = World::new();
        full.chains.insert(
            session(),
            Chains {
                counts: [(0, MAX_ENVELOPES_PER_EPOCH - 1)].into(),
                ..Chains::new()
            },
        );
        assert!(taken(&full.post(2, session(), &chat("the last one"))).is_ok());
        let sealed = full.sign(2, session(), &chat("one too many"));
        assert_eq!(
            full.take(&sealed.envelope).unwrap().outcome,
            Outcome::Refused(Error::EpochFull)
        );

        // A sealed body beyond the largest padded size: decoded, chained, refused.
        let mut envelope = world.sign(2, session(), &chat("x")).envelope;
        envelope.content = Content::Full(vec![0; envelope::MAX_PADDED_LEN + 17]);
        let hash = envelope.hash().unwrap();
        envelope.signature =
            crate::crypto::sign_with_label(&signer(2), "TrommiEnvelope", hash.as_bytes())
                .unwrap()
                .try_into()
                .unwrap();
        assert_eq!(
            world.take(&envelope).unwrap().outcome,
            Outcome::Refused(Error::TooLarge)
        );
    }

    #[test]
    fn the_hub_runs_the_same_checks_without_the_body() {
        let mut hub = World::new();
        hub.fake.hub = true;
        let take = |hub: &mut World, signed_in: u8, envelope: &Envelope| {
            let group = envelope.header.group;
            let receipt = hub_take(
                &hub.fake,
                &hub.fake,
                &hub.chains(&group),
                &hub.objects(&group),
                &device(signed_in),
                &envelope.encode().unwrap(),
                hub.now,
            )?;
            hub.record(&receipt);
            Ok::<_, Error>(receipt)
        };

        let sealed = hub.sign(3, session(), &card());
        // Posted by another device than the one that signed it.
        assert_eq!(
            take(&mut hub, 2, &sealed.envelope).err(),
            Some(Error::WrongSender)
        );
        let receipt = take(&mut hub, 3, &sealed.envelope).unwrap();
        let Outcome::Taken { transition, body } = &receipt.outcome else {
            panic!("taken");
        };
        assert_eq!(body, &Err(Error::NoKey));
        assert!(transition.is_some());
        // The same bytes again take no second number.
        assert_eq!(
            take(&mut hub, 3, &sealed.envelope).err(),
            Some(Error::Replay)
        );
        // What 9.2 forbids becomes a void record.
        let forbidden = hub.sign(2, session(), &card());
        assert_eq!(
            take(&mut hub, 2, &forbidden.envelope).unwrap().outcome,
            Outcome::Refused(Error::Forbidden)
        );
        // Checks 1 to 6 as on a device.
        let mut forged = hub.sign(2, session(), &chat("x")).envelope;
        forged.signature[0] ^= 1;
        assert_eq!(take(&mut hub, 2, &forged).err(), Some(Error::BadSignature));

        // Freshness at the hub: the epoch before, within two minutes of the Commit's arrival, and no older one.
        let mut hub = World::new();
        hub.fake.hub = true;
        let in_time = hub.sign(2, session(), &chat("x"));
        let late = hub.sign(2, session(), &chat("x"));
        let two_back = hub.sign(2, session(), &chat("x"));
        hub.fake.commit(&session(), NOW, NOW, |_| {});
        hub.now = NOW + LIVE_GRACE_MS;
        assert!(matches!(
            take(&mut hub, 2, &in_time.envelope).unwrap().outcome,
            Outcome::Taken { .. }
        ));
        hub.now += 1;
        assert_eq!(
            take(&mut hub, 2, &late.envelope).unwrap().outcome,
            Outcome::Refused(Error::WrongEpoch)
        );
        hub.fake.commit(&session(), hub.now, hub.now, |_| {});
        assert_eq!(
            take(&mut hub, 2, &two_back.envelope).unwrap().outcome,
            Outcome::Refused(Error::WrongEpoch)
        );
        // A device in the hub's order gives that envelope its two minutes after the newest Commit it ended in.
        hub.fake.group(&session()).stale = true;
        let sealed = hub.sign(2, session(), &chat("x"));
        assert_eq!(
            take(&mut hub, 2, &sealed.envelope).unwrap().outcome,
            Outcome::Refused(Error::StaleSession)
        );
    }

    #[test]
    fn a_provisional_envelope_is_accepted_when_the_chain_reaches_it() {
        let mut world = World::new();
        let one = world.sign(2, session(), &chat("one"));
        let two = world.sign(2, session(), &chat("two"));
        let fetch = |world: &World, envelope: &Envelope| {
            provisional(
                &world.fake,
                &world.fake,
                &world.chains(&session()),
                &envelope.encode().unwrap(),
                world.now,
            )
        };
        // A page of the Chat brings number 2 before the chain has reached it.
        let page = fetch(&world, &two.envelope).unwrap();
        assert_eq!(page.standing, Standing::Provisional);
        assert_eq!(page.body.payload(), payload("two"));
        assert_eq!(world.chains(&session()), Chains::new());

        let first = world.take(&one.envelope).unwrap();
        assert_eq!(page.confirm(&first), Ok(Standing::Provisional));
        let second = world.take(&two.envelope).unwrap();
        assert_eq!(page.confirm(&second), Ok(Standing::Accepted));
        // Fetched again later, it is accepted at once.
        assert_eq!(
            fetch(&world, &two.envelope).unwrap().standing,
            Standing::Chained
        );
        assert_eq!(
            fetch(&world, &one.envelope).unwrap().standing,
            Standing::Chained
        );
        // Another sender's step says nothing about it.
        let other = world.post(3, session(), &agent_chat("x"));
        assert_eq!(page.confirm(&other), Ok(Standing::Provisional));
    }

    #[test]
    fn a_provisional_envelope_that_the_chain_contradicts_is_a_hash_mismatch() {
        let mut world = World::new();
        let one = world.sign(2, session(), &chat("one"));
        let two = world.sign(2, session(), &chat("two"));
        // The page shows another number 2 than the chain will bring.
        let other_two = envelope::seal(
            &chat("two, as the page had it"),
            &Slot {
                group: session(),
                epoch: 0,
                sender: device(2),
                seq: 2,
                prev: one.hash,
                time: NOW,
            },
            &crate::envelope::testing::key(0),
            &signer(2),
            &mut world.entropy,
        )
        .unwrap();
        let fetch = |world: &World, envelope: &Envelope| {
            provisional(
                &world.fake,
                &world.fake,
                &world.chains(&session()),
                &envelope.encode().unwrap(),
                world.now,
            )
        };
        let page = fetch(&world, &other_two.envelope).unwrap();
        world.take(&one.envelope).unwrap();
        let second = world.take(&two.envelope).unwrap();
        assert_eq!(page.confirm(&second), Err(Error::HashMismatch));
        // Fetched after the chain passed that number: the same finding, for the last number and an earlier one.
        assert_eq!(
            fetch(&world, &other_two.envelope).err(),
            Some(Error::HashMismatch)
        );
        world.post(2, session(), &chat("three"));
        assert_eq!(
            fetch(&world, &other_two.envelope).err(),
            Some(Error::HashMismatch)
        );
    }

    #[test]
    fn a_provisional_envelope_passes_checks_1_to_5_and_7_to_9() {
        let mut world = World::new();
        let fetch = |world: &World, envelope: &Envelope| {
            provisional(
                &world.fake,
                &world.fake,
                &world.chains(&envelope.header.group),
                &envelope.encode().unwrap(),
                world.now,
            )
            .map(|p| p.standing)
        };
        let good = world.sign(2, session(), &chat("x"));
        assert_eq!(fetch(&world, &good.envelope), Ok(Standing::Provisional));

        let mut forged = good.envelope.clone();
        forged.signature[0] ^= 1;
        assert_eq!(fetch(&world, &forged), Err(Error::BadSignature));
        let stranger = world.sign(5, session(), &agent_chat("x"));
        assert_eq!(fetch(&world, &stranger.envelope), Err(Error::NotMember));
        let ahead = world.sign_in_epoch(2, session(), 1, &chat("x"));
        assert_eq!(fetch(&world, &ahead.envelope), Err(Error::GroupBehind));
        // Check 7: an agent may not write a board item, a human device may not create a card.
        let by_human = world.sign(2, session(), &card());
        assert_eq!(fetch(&world, &by_human.envelope), Err(Error::Forbidden));
        // Check 9.
        assert_eq!(
            fetch(&world, &good.envelope.prune().unwrap()),
            Err(Error::Pruned)
        );
        world.fake.group(&session()).epochs[0].no_key = true;
        assert_eq!(fetch(&world, &good.envelope), Err(Error::NoKey));
        world.fake.group(&session()).epochs[0].no_key = false;
        // Check 8, as when reading back.
        world.now = NOW + READ_BACK_GRACE_MS + 1;
        let late = world.sign(1, session(), &chat("x"));
        world.fake.commit(&session(), NOW, NOW, |_| {});
        assert_eq!(fetch(&world, &late.envelope), Err(Error::WrongEpoch));
        assert_eq!(fetch(&world, &good.envelope), Ok(Standing::Provisional));
        // A removed sender's envelope beyond its Cut.
        world
            .fake
            .group(&session())
            .cuts
            .insert(device(2), Head::START);
        assert_eq!(fetch(&world, &good.envelope), Err(Error::RemovedSender));
    }

    #[test]
    fn a_cut_drops_what_the_receiver_had_accepted_beyond_it() {
        let mut world = World::new();
        let one = world.post(2, session(), &chat("one"));
        let two = world.post(2, session(), &chat("two"));
        let three = world.post(2, session(), &chat("three"));
        let cut_at = |world: &World, cut: Head| {
            cut_chain(
                &world.fake,
                &world.chains(&session()),
                &session(),
                &device(2),
                &cut,
            )
            .unwrap()
        };

        // The remover had accepted number 1 only.
        let cut = Head {
            seq: 1,
            hash: one.hash,
        };
        let effect = cut_at(&world, cut);
        assert_eq!(
            effect,
            CutEffect {
                sender: device(2),
                head: Some(cut),
                drop_from: Some(2),
                finding: None
            }
        );
        // The remover had accepted everything this receiver has, or more.
        let all = Head {
            seq: 3,
            hash: three.hash,
        };
        assert_eq!(
            (cut_at(&world, all).head, cut_at(&world, all).drop_from),
            (None, None)
        );
        let more = Head {
            seq: 9,
            hash: Hash32::new([9; 32]),
        };
        assert_eq!(cut_at(&world, more).head, None);
        // The remover had accepted nothing.
        let effect = cut_at(&world, Head::START);
        assert_eq!(
            (effect.head, effect.drop_from, effect.finding.clone()),
            (Some(Head::START), Some(1), None)
        );
        // The remover names another envelope under number 2, or under the receiver's last number.
        for seq in [2, 3] {
            let other = Head {
                seq,
                hash: Hash32::new([7; 32]),
            };
            let effect = cut_at(&world, other);
            assert_eq!(
                (effect.head, effect.drop_from, effect.finding),
                (Some(other), Some(seq), Some(Error::Equivocation))
            );
        }

        let mut chains = world.chains(&session());
        chains.apply_cut(&cut_at(&world, cut));
        assert_eq!(chains.head(&device(2)), cut);
        chains.apply_cut(&cut_at(&world, Head::START));
        assert_eq!(chains.head(&device(2)), Head::START);
        assert!(chains.heads().is_empty());
        assert_ne!(two.hash, three.hash);
    }

    #[test]
    fn heads_name_every_accepted_chain() {
        let mut world = World::new();
        assert_eq!(heads_value(&world.chains(&session())).unwrap(), "{}");
        let human = world.post(2, session(), &chat("x"));
        world.post(3, session(), &agent_chat("x"));
        let agent = world.post(3, session(), &agent_chat("y"));
        let value = heads_value(&world.chains(&session())).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&value).unwrap();
        assert_eq!(
            parsed[device(3).to_base64url()],
            json!([2, agent.hash.to_base64url()])
        );
        assert_eq!(
            parsed[device(2).to_base64url()],
            json!([1, human.hash.to_base64url()])
        );
        assert_eq!(
            parse_heads(&value).unwrap(),
            world.chains(&session()).heads()
        );
        assert_eq!(parse_heads("{}").unwrap(), Vec::new());
    }

    #[test]
    fn heads_are_read_strictly() {
        let sender = device(2).to_base64url();
        let hash = Hash32::new([5; 32]).to_base64url();
        let good = format!(r#"{{"{sender}":[3,"{hash}"]}}"#);
        assert_eq!(parse_heads(&good).unwrap().len(), 1);
        let cases = [
            "[]".to_string(),
            "null".to_string(),
            format!(r#"{{"{sender}":[0,"{hash}"]}}"#),
            format!(r#"{{"{sender}":[3]}}"#),
            format!(r#"{{"{sender}":[3,"{hash}",1]}}"#),
            format!(r#"{{"{sender}":["3","{hash}"]}}"#),
            format!(r#"{{"{sender}":[-1,"{hash}"]}}"#),
            format!(r#"{{"{sender}":[3.5,"{hash}"]}}"#),
            format!(r#"{{"{sender}":[3,"{sender}x"]}}"#),
            format!(r#"{{"{sender}=":[3,"{hash}"]}}"#),
            format!(r#"{{"short":[3,"{hash}"]}}"#),
            format!(r#"{{"{sender}":[3,"{hash}"],"{sender}":[3,"{hash}"]}}"#),
            format!(r#"{{"{sender}":[3,"{hash}"]}} x"#),
        ];
        for text in cases {
            assert_eq!(parse_heads(&text), Err(Error::BadFormat), "{text}");
        }
    }

    #[test]
    fn heads_show_what_a_reader_lacks_and_what_differs() {
        let mut writer = World::new();
        let one = writer.post(2, session(), &chat("one"));
        let two = writer.post(2, session(), &chat("two"));
        let named = writer.chains(&session()).heads();
        let compare = |world: &World, named: &[(DeviceId, Head)]| {
            compare_heads(&world.fake, &world.chains(&session()), &session(), named)
                .unwrap()
                .into_iter()
                .map(|(_, standing)| standing)
                .collect::<Vec<_>>()
        };

        // A reader that was served nothing, then one envelope, then both.
        let mut reader = World::new();
        assert_eq!(compare(&reader, &named), [HeadStanding::Behind { have: 0 }]);
        reader.take(&one.envelope).unwrap();
        let standing = compare(&reader, &named);
        assert_eq!(standing, [HeadStanding::Behind { have: 1 }]);
        // The hub has nothing more: withheld.
        assert_eq!(standing[0].after_fetch(), Err(Error::Withheld));
        reader.take(&two.envelope).unwrap();
        assert_eq!(compare(&reader, &named), [HeadStanding::Held]);
        assert_eq!(HeadStanding::Held.after_fetch(), Ok(()));

        // A head that names another hash under the reader's last number, and under an earlier one.
        let other = |seq| {
            vec![(
                device(2),
                Head {
                    seq,
                    hash: Hash32::new([7; 32]),
                },
            )]
        };
        assert_eq!(compare(&reader, &other(2)), [HeadStanding::Equivocation]);
        assert_eq!(compare(&reader, &other(1)), [HeadStanding::Equivocation]);
        assert_eq!(
            HeadStanding::Equivocation.after_fetch(),
            Err(Error::Equivocation)
        );
        // An earlier number that the reader holds, and one it keeps no record of.
        let earlier = vec![(
            device(2),
            Head {
                seq: 1,
                hash: one.hash,
            },
        )];
        assert_eq!(compare(&reader, &earlier), [HeadStanding::Held]);
        reader.fake.accepted.remove(&(session(), device(2), 1));
        assert_eq!(compare(&reader, &earlier), [HeadStanding::Unknown]);
        assert_eq!(HeadStanding::Unknown.after_fetch(), Ok(()));
    }

    #[test]
    fn the_sender_never_gives_one_number_twice() {
        let world = World::new();
        let mut entropy = crate::envelope::testing::TestEntropy(5);
        let mut seal = |own: &mut OwnChain, draft: &Draft, n: u8| {
            seal_next(
                &world.fake,
                &Chains::new(),
                &Objects::new(),
                own,
                draft,
                session(),
                &signer(n),
                NOW,
                &mut entropy,
            )
        };
        let mut own = OwnChain::new();
        let first = seal(&mut own, &chat("one"), 2).unwrap();
        assert_eq!(first.envelope.header.seq, 1);
        assert_eq!(first.envelope.header.prev, Hash32::ZERO);
        assert_eq!(first.envelope.header.epoch, 0);
        assert_eq!(first.envelope.header.time, NOW);
        // Signing moved the chain on: the same call again signs the next number.
        assert_eq!(
            own.head(),
            Head {
                seq: 1,
                hash: first.hash
            }
        );
        // The stored state is what the next envelope builds on.
        let mut stored = OwnChain::from_bytes(&own.to_bytes().unwrap()).unwrap();
        assert_eq!(stored, own);
        let second = seal(&mut stored, &chat("two"), 2).unwrap();
        assert_eq!(second.envelope.header.seq, 2);
        assert_eq!(second.envelope.header.prev, first.hash);
        let third = seal(&mut stored, &chat("two"), 2).unwrap();
        assert_eq!(third.envelope.header.seq, 3);
        // A receiver accepts them in order.
        let mut receiver = World::new();
        for outgoing in [&first, &second, &third] {
            receiver.take(&outgoing.envelope).unwrap();
        }

        // Refusals use up nothing.
        let before = stored.head();
        assert_eq!(seal(&mut stored, &card(), 2).err(), Some(Error::Forbidden));
        assert_eq!(
            seal(&mut stored, &chat("x"), 5).err(),
            Some(Error::NotMember)
        );
        let too_long = Draft::session_chat(SESSION, device(3), &payload(&"a".repeat(60_000)));
        assert_eq!(seal(&mut stored, &too_long, 2).err(), Some(Error::TooLarge));
        assert_eq!(stored.head(), before);
    }

    #[test]
    fn the_sender_refuses_what_the_hub_would_void() {
        let mut world = World::new();
        let seal = |world: &World, chains: &Chains, group: GroupId, entropy: &mut dyn Entropy| {
            let mut own = OwnChain::new();
            let result = seal_next(
                &world.fake,
                chains,
                &Objects::new(),
                &mut own,
                &chat("x"),
                group,
                &signer(2),
                NOW,
                entropy,
            );
            assert_eq!(own, OwnChain::new());
            result.map(|_| ())
        };
        let mut entropy = crate::envelope::testing::TestEntropy(5);
        assert_eq!(
            seal(&world, &Chains::new(), session(), &mut NoEntropy),
            Err(Error::Entropy)
        );
        let unknown = GroupId::session(ROOM, SessionId::new([8; 16]));
        assert_eq!(
            seal(&world, &Chains::new(), unknown, &mut entropy),
            Err(Error::GroupBehind)
        );
        let foreign = GroupId::session(RoomId::new([9; 32]), SESSION);
        assert_eq!(
            seal(&world, &Chains::new(), foreign, &mut entropy),
            Err(Error::WrongRoom)
        );
        let full = Chains {
            counts: [(0, MAX_ENVELOPES_PER_EPOCH)].into(),
            ..Chains::new()
        };
        assert_eq!(
            seal(&world, &full, session(), &mut entropy),
            Err(Error::EpochFull)
        );
        world.fake.group(&session()).stale = true;
        assert_eq!(
            seal(&world, &Chains::new(), session(), &mut entropy),
            Err(Error::StaleSession)
        );
        world.fake.group(&session()).stale = false;
        world.fake.group(&session()).epochs[0].no_key = true;
        assert_eq!(
            seal(&world, &Chains::new(), session(), &mut entropy),
            Err(Error::NoKey)
        );
        // A device whose chain a Cut ended signs nothing more there, even as a leaf again.
        world.fake.group(&session()).epochs[0].no_key = false;
        world
            .fake
            .group(&session())
            .cuts
            .insert(device(2), Head::START);
        assert_eq!(
            seal(&world, &Chains::new(), session(), &mut entropy),
            Err(Error::RemovedSender)
        );
    }

    #[test]
    fn a_step_is_applied_once_and_in_turn() {
        let mut world = World::new();
        let one = world.sign(2, session(), &chat("one"));
        let card = world.sign(3, session(), &card());
        let receipt = receive(
            &world.fake,
            &world.fake,
            &Chains::new(),
            &Objects::new(),
            &device(1),
            &one.envelope.encode().unwrap(),
            &Served::Stored,
            Mode::InOrder,
            NOW,
        )
        .unwrap();
        let mut chains = Chains::new();
        chains.apply(&receipt.advance).unwrap();
        assert!(matches!(
            chains.apply(&receipt.advance),
            Err(Error::Internal(_))
        ));
        assert_eq!(chains.count(0), 1);
        // Two envelopes of different senders checked against the same state: only one step fits.
        let other = world.sign(1, session(), &chat("x"));
        let second = receive(
            &world.fake,
            &world.fake,
            &Chains::new(),
            &Objects::new(),
            &device(1),
            &other.envelope.encode().unwrap(),
            &Served::Stored,
            Mode::InOrder,
            NOW,
        )
        .unwrap();
        assert!(matches!(
            chains.apply(&second.advance),
            Err(Error::Internal(_))
        ));
        assert_eq!(
            Chains::from_bytes(&chains.to_bytes().unwrap()).unwrap(),
            chains
        );
        // A transition judged against a state that has moved on since.
        let receipt = world.take(&card.envelope).unwrap();
        let Outcome::Taken {
            transition: Some(transition),
            ..
        } = &receipt.outcome
        else {
            panic!("taken");
        };
        let mut objects = world.objects(&session());
        assert!(matches!(objects.apply(transition), Err(Error::Internal(_))));
        assert_eq!(objects, world.objects(&session()));
    }

    #[test]
    fn a_provisional_envelope_that_its_chain_refuses_is_dropped() {
        let mut world = World::new();
        // An answer to a version that is not current passes what a page can check of 9.2, and is refused when
        // the chain brings it.
        let v1 = world.post(3, session(), &card());
        let id = v1.envelope.header.subject.object().unwrap().object_id;
        let bind = envelope::AnswerBind {
            object_id: id,
            version_hash: Hash32::new([9; 32]),
            choices: Vec::new(),
        };
        let draft = Draft::answer(bind, false, Urgency::Normal, device(3), b"{}");
        let sealed = world.sign(2, session(), &draft);
        let fetch = |world: &World, envelope: &Envelope| {
            provisional(
                &world.fake,
                &world.fake,
                &world.chains(&session()),
                &envelope.encode().unwrap(),
                NOW,
            )
            .unwrap()
        };
        let page = fetch(&world, &sealed.envelope);
        assert_eq!(page.standing, Standing::Provisional);
        let receipt = world.take(&sealed.envelope).unwrap();
        assert_eq!(page.confirm(&receipt), Err(Error::Forbidden));
        // The same for one the hub serves as a void record.
        let sealed = world.sign(2, session(), &chat("x"));
        let page = fetch(&world, &sealed.envelope);
        let receipt = world
            .take_as(
                &sealed.envelope.prune().unwrap().encode().unwrap(),
                &Served::Void(Error::WrongEpoch),
                Mode::InOrder,
            )
            .unwrap();
        assert_eq!(page.confirm(&receipt), Err(Error::WrongEpoch));
    }

    #[test]
    fn chain_state_round_trips_and_refuses_damage() {
        let mut world = World::new();
        world.post(2, session(), &chat("x"));
        world.post(3, session(), &agent_chat("x"));
        world.fake.commit(&session(), NOW, NOW, |_| {});
        world.post(3, session(), &agent_chat("y"));
        let chains = world.chains(&session());
        let bytes = chains.to_bytes().unwrap();
        assert_eq!(Chains::from_bytes(&bytes).unwrap(), chains);
        assert_eq!(
            Chains::from_bytes(&Chains::new().to_bytes().unwrap()).unwrap(),
            Chains::new()
        );
        for len in 0..bytes.len() {
            assert!(matches!(
                Chains::from_bytes(&bytes[..len]),
                Err(Error::Storage(_))
            ));
        }
        let mut longer = bytes.clone();
        longer.push(0);
        assert!(matches!(
            Chains::from_bytes(&longer),
            Err(Error::Storage(_))
        ));
        // The same sender twice.
        let entry = HeadEntry(device(2), Head::START);
        let mut writer = Writer::new();
        writer
            .vector(&[HeadEntry(device(2), Head::START), entry])
            .unwrap();
        writer.vector::<CountEntry>(&[]).unwrap();
        assert!(matches!(
            Chains::from_bytes(&writer.into_bytes()),
            Err(Error::Storage(_))
        ));

        assert_eq!(
            OwnChain::from_bytes(&OwnChain::new().to_bytes().unwrap()).unwrap(),
            OwnChain::new()
        );
        assert!(matches!(
            OwnChain::from_bytes(&[0; 39]),
            Err(Error::Storage(_))
        ));
        assert!(matches!(
            OwnChain::from_bytes(&[1; 41]),
            Err(Error::Storage(_))
        ));
        // A number without a hash, a hash without a number.
        let mut odd = [0u8; 40];
        odd[7] = 1;
        assert!(matches!(OwnChain::from_bytes(&odd), Err(Error::Storage(_))));
        let mut odd = [0u8; 40];
        odd[39] = 1;
        assert!(matches!(OwnChain::from_bytes(&odd), Err(Error::Storage(_))));
    }

    #[test]
    fn a_board_snapshots_frontier_starts_chains_beyond_number_one() {
        let mut writer = World::new();
        writer.post(2, room(), &stroke());
        let two = writer.post(2, room(), &stroke());
        let three = writer.sign(2, room(), &stroke());
        let four = writer.sign(2, room(), &stroke());

        let mut reader = World::new();
        reader.chains.insert(
            room(),
            Chains::from_frontier(&writer.chains(&room()).heads()),
        );
        assert_eq!(reader.take(&four.envelope).err(), Some(Error::Gap));
        let receipt = reader
            .take_as(
                &three.envelope.prune().unwrap().encode().unwrap(),
                &Served::Stored,
                Mode::ReadingBack,
            )
            .unwrap();
        assert_eq!(taken(&receipt), &Err(Error::Pruned));
        reader.take(&four.envelope).unwrap();
        // What lies at or before the frontier is not new.
        assert_eq!(reader.take(&two.envelope).err(), Some(Error::Replay));
    }

    #[test]
    fn a_register_and_a_reserved_kind_change_no_object() {
        let mut world = World::new();
        let draft = Draft::register(RegisterId::new([5; 16]), &payload("x"));
        let receipt = world.post(2, room(), &draft);
        assert!(matches!(
            receipt.outcome,
            Outcome::Taken {
                transition: None,
                body: Ok(_)
            }
        ));
        assert!(receipt.opened().is_some());
    }
}
