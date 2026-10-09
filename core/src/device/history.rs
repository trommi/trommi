//! A group's past, for a device that came later (4.4, 9.0.5, 9.0.6): the epochs before the one it joined at.
//!
//! **The walk.** [`Device::learn_history`] replays the group's public history as an observer, from the
//! founding GroupInfo (epoch 0) through the Commits the hub serves, each judged by the rules every verifier
//! applies, up to the epoch where the device's own knowledge of the group begins. For every epoch on the way
//! it writes the record the device keeps of its own epochs (the leaves, their roles, the seat, the `time` of
//! the Commit that ended it), marked as learned, and every Cut those Commits carry, in one write.
//!
//! **What authenticates it.** Nothing the hub serves is trusted. The walk is taken only if it arrives at
//! the device's own state: where the device's knowledge begins (the epoch it joined at as a leaf, or began
//! to follow as an observer), the walk's GroupContext is byte for byte the GroupContext the device's own
//! state had there, which it wrote down then. A GroupContext holds the confirmed transcript hash, and that
//! hash chains every Commit since the founding with its signature (RFC 9420 section 8.2). Each of those
//! signatures is over the GroupContext its Commit builds on, with the tree hash and the extensions of that
//! epoch, and the walk verified each against the state it had reached. So equality at one epoch fixes every
//! Commit before it and every state between: the leaves, the room's roles, the notes with their room epochs,
//! times and Cuts. This rests on SHA-256 being collision resistant and on an Ed25519 signature fitting one
//! key and one message. The hub's change numbers are not covered and decide nothing here: a session
//! Commit is judged against the room state its own note names, and a helper session's against its main
//! session's agent leaf at that room epoch.
//!
//! **Order.** A session Commit names a room state, and a helper session's the agent leaf of its main
//! session: the room group's past is learned first (`room-behind` otherwise), then a main session's, then
//! its helper sessions' (`group-behind` otherwise).
//!
//! **First contact (5.2.6).** A history that is the group's own, by the test above, and does not obey
//! section 5 is the finding `bad-group`: the session group is closed as after a failed first contact. A
//! history that is not the group's own is `bad-group` too, and changes nothing: the hub lied, not the group.

use super::facts::{group_key, EpochFacts, SUB_EPOCH, SUB_FINDING, SUB_ORIGIN};
use super::Device;
use crate::chain::EpochEnd;
use crate::codec::{self, Decode, Encode, Reader, Writer};
use crate::error::Error;
use crate::ids::{DeviceId, GroupId, SessionId};
use crate::mls::group;
use crate::mls::observer::{self, Context, Observer};
use crate::mls::profile::{Cut, TrommiSession, MAX_HUMAN_DEVICES_IN_RECOVERY};
use crate::mls::provider::{MlsEntries, Provider};
use crate::mls::rules::{self, Parent, RoomHistory, SessionFacts};
use crate::recovery::{PublicRules, ServedCommit, ServedGroup, Walked, WalkedEnd, WalkedEpoch};
use crate::store::{table, Batch, Storage};
use openmls::group::{ProposalStore, PublicGroup};
use openmls::prelude::{LeafNodeIndex, ProcessedMessageContent};
use openmls_traits::OpenMlsProvider as _;
use std::collections::{BTreeMap, BTreeSet};
use tls_codec::Serialize as _;

/// The largest stored GroupContext this module reads: a room's holds up to 256 agent devices.
const MAX_CONTEXT_LEN: usize = 1 << 16;

/// Where the device's own knowledge of a group begins: the epoch it joined at as a leaf, or began to follow
/// at as an observer, with the GroupContext its own state had there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Origin {
    pub epoch: u64,
    /// The GroupContext of that epoch, in its TLS encoding.
    pub context: Vec<u8>,
    /// Whether the device holds the group's past before that epoch: it learned it, or there is none.
    pub learned: bool,
}

impl Encode for Origin {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.u64(self.epoch);
        writer.opaque(&self.context)?;
        writer.u8(u8::from(self.learned));
        Ok(())
    }
}

impl Decode for Origin {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        let epoch = reader.u64()?;
        let context = reader.opaque()?.to_vec();
        let learned = match reader.u8()? {
            0 => false,
            1 => true,
            _ => return Err(Error::BadFormat),
        };
        if context.is_empty() || context.len() > MAX_CONTEXT_LEN || (epoch == 0 && !learned) {
            return Err(Error::BadFormat);
        }
        Ok(Self {
            epoch,
            context,
            learned,
        })
    }
}

/// How far back the device's knowledge of a group reaches.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GroupPast {
    /// The epoch the device's own knowledge of the group begins at: the one it joined at, or began to
    /// follow at.
    pub from_epoch: u64,
    /// Whether it holds every epoch before that one too ([`Device::learn_history`]); true for a group it
    /// founded. While false, an envelope of an earlier epoch is `group-behind`.
    pub learned: bool,
}

/// What [`Device::learn_history`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Learned {
    /// How many epochs it recorded; 0 when there was nothing to learn.
    pub epochs: u64,
}

/// Why a served history is not taken.
enum Refusal {
    /// It did not verify, did not obey the rules, or did not arrive at the device's state.
    BadGroup,
    /// Anything else: it came too early, or the device itself failed.
    Other(Error),
}

impl From<Error> for Refusal {
    fn from(error: Error) -> Self {
        Self::Other(error)
    }
}

/// The room's main sessions as a walk of the past asks about them: only those whose whole past the device
/// holds answer. Which agent device sat where else at that time, and how many helper sessions lived, a
/// reader of one group's history cannot know: the hub judged both when it took the Commit.
struct PastSessions {
    seats: BTreeMap<SessionId, Vec<(u64, Option<DeviceId>)>>,
}

impl SessionFacts for PastSessions {
    fn main_session(&self, session: &SessionId, room_epoch: u64) -> Parent {
        match self.seats.get(session) {
            Some(seats) => Parent::Seat(observer::seat_at(seats, room_epoch)),
            None => Parent::Unknown,
        }
    }

    fn main_session_of(&self, _: &DeviceId) -> Option<SessionId> {
        None
    }

    fn live_helpers(&self, _: &SessionId) -> usize {
        0
    }
}

fn damaged(what: &'static str) -> Error {
    Error::Storage(format!("{what} does not decode"))
}

fn is_fault(error: &Error) -> bool {
    matches!(
        error,
        Error::Storage(_) | Error::Internal(_) | Error::Entropy
    )
}

fn origin_key(group: &GroupId) -> Vec<u8> {
    group_key(table::CHAIN, SUB_ORIGIN, group, &[])
}

/// A main session's agent leaf over time: what a walk found up to where the device's own record begins,
/// then what the device recorded from the Commits it processed itself. The first entry of the device's own
/// record stands for the state it started from, which the walk arrives at.
fn joined_seats(
    walked: &[(u64, Option<DeviceId>)],
    own: &[(u64, Option<DeviceId>)],
) -> Vec<(u64, Option<DeviceId>)> {
    let mut seats = walked.to_vec();
    for change in own.iter().skip(1) {
        if seats.last().map(|(_, seat)| *seat) != Some(change.1) {
            seats.push(*change);
        }
    }
    seats
}

/// Whether the served history, read as MLS alone without Trommi's rules, arrives at `origin`: every Commit
/// verifies against the state before it, and at the origin's epoch the GroupContext is the origin's. Then
/// the Commits served are the group's own, whatever they did.
fn arrives(founding: &[u8], commits: &[ServedCommit<'_>], origin: &Origin) -> bool {
    let replay = || -> Result<Vec<u8>, Error> {
        let verifiable = observer::parse_group_info(founding)?;
        let tree = verifiable
            .extensions()
            .ratchet_tree()
            .ok_or(Error::BadFormat)?
            .ratchet_tree()
            .clone();
        let provider = Provider::without_entropy(MlsEntries::new())?;
        let (mut public, _) = PublicGroup::from_external(
            provider.crypto(),
            provider.storage(),
            tree,
            verifiable,
            ProposalStore::new(),
        )
        .map_err(|_| Error::BadSignature)?;
        let mut served = commits.iter();
        while public.group_context().epoch().as_u64() < origin.epoch {
            let commit = served.next().ok_or(Error::BadGroup)?;
            let message = rules::parse_commit(commit.commit)?;
            let processed = public
                .process_message(provider.crypto(), message)
                .map_err(|_| Error::BadCommit)?;
            let ProcessedMessageContent::StagedCommitMessage(staged) = processed.into_content()
            else {
                return Err(Error::BadCommit);
            };
            public
                .merge_commit(provider.storage(), *staged)
                .map_err(|_| Error::BadCommit)?;
        }
        public
            .group_context()
            .tls_serialize_detached()
            .map_err(|_| Error::Internal("group context encoding"))
    };
    replay().is_ok_and(|context| context == origin.context)
}

impl<S: Storage> Device<S> {
    pub(super) fn origin(&self, group: &GroupId) -> Result<Option<Origin>, Error> {
        self.stored(&origin_key(group))
            .map(|value| codec::decode(value, value.len()).map_err(|_| damaged("a group's origin")))
            .transpose()
    }

    /// Writes down where this device's knowledge of `group` begins: `epoch`, which the group it holds as a
    /// leaf stands in, with its GroupContext.
    pub(super) fn put_origin(
        &mut self,
        batch: &mut Batch,
        group: &GroupId,
        epoch: u64,
    ) -> Result<(), Error> {
        let held = group::load(&self.provider, group)?;
        let context = held.public_group().group_context();
        if context.epoch().as_u64() != epoch {
            return Err(Error::Internal("a group's first epoch"));
        }
        let origin = Origin {
            epoch,
            context: context
                .tls_serialize_detached()
                .map_err(|_| Error::Internal("group context encoding"))?,
            learned: epoch == 0,
        };
        self.put_stored(batch, origin_key(group), codec::encode(&origin)?);
        Ok(())
    }

    /// Writes down where this device began to follow a group as an observer.
    pub(super) fn put_observed_origin(
        &mut self,
        batch: &mut Batch,
        observer: &Observer,
    ) -> Result<(), Error> {
        let epoch = observer.epoch()?;
        let origin = Origin {
            epoch,
            context: observer.group_context()?,
            learned: epoch == 0,
        };
        self.begin(0);
        self.put_stored(
            batch,
            origin_key(&observer.group()),
            codec::encode(&origin)?,
        );
        Ok(())
    }

    /// How far back this device's knowledge of `group` reaches; none for a group it neither holds nor
    /// follows.
    pub fn group_past(&self, group: &GroupId) -> Result<Option<GroupPast>, Error> {
        self.owner()?;
        Ok(self.origin(group)?.map(|origin| GroupPast {
            from_epoch: origin.epoch,
            learned: origin.learned,
        }))
    }

    /// Learns the past of `group` from its public history (4.4, 9.0.6): `founding` is its founding GroupInfo
    /// (epoch 0), `commits` its Commits from the first on, in order, as the hub's log serves them; what lies
    /// beyond the epoch this device's own knowledge begins at is not read. The group is one this device is
    /// a leaf of, or follows as an observer (`not-found` otherwise).
    ///
    /// Each Commit is judged as every verifier judges it, a session's against the room states this device
    /// holds, and the history is taken only if it arrives at this device's own state: the GroupContext it
    /// reaches at that epoch is byte for byte the one this device's state had there. Then every earlier
    /// epoch is recorded as the device records its own, with the Cuts of the Commits on the way, in one
    /// write; envelopes of those epochs are checked from then on, with the freshness of reading back (9.0.5,
    /// check 8). For a group it follows as an observer the device takes the room's roles of the earlier
    /// epochs, or a main session's agent leaf over that time.
    ///
    /// Nothing to learn (the device founded the group, or learned its past before) is no error. `bad-group`
    /// for a history that does not verify, does not obey section 5, ends before the device's epoch or does
    /// not arrive at its state: nothing is written. If such a history of a session group is the group's own
    /// and broke the rules, the group is closed as after a failed first contact (5.2.6) and the finding is
    /// kept ([`Device::findings`]). `room-behind`: learn the room group's past first, or process its log
    /// further. `group-behind`: learn the main session's past first.
    pub fn learn_history(
        &mut self,
        group: &GroupId,
        founding: &[u8],
        commits: &[ServedCommit<'_>],
    ) -> Result<Learned, Error> {
        let learned = self.transact(|this, batch| {
            this.begin(0);
            match this.learn(batch, group, founding, commits) {
                Ok(learned) => Ok(learned),
                Err(Refusal::BadGroup) => Err(Error::BadGroup),
                Err(Refusal::Other(error)) => Err(error),
            }
        });
        match learned {
            Ok(learned) => Ok(learned),
            Err(Error::BadGroup) => {
                // The hub's word decides nothing about the group: only a history that is the group's own
                // closes it.
                let origin = self.origin(group)?;
                let own = !group.is_room()
                    && self.is_leaf_of(group)
                    && origin.is_some_and(|origin| arrives(founding, commits, &origin));
                if own {
                    self.transact(|this, batch| {
                        this.begin(0);
                        this.meta(group)?.distrusted = true;
                        this.put_group(batch, group)?;
                        this.put_stored(
                            batch,
                            group_key(table::CHAIN, SUB_FINDING, group, DeviceId::ZERO.as_bytes()),
                            Error::BadGroup.code().as_bytes().to_vec(),
                        );
                        Ok(())
                    })?;
                }
                Err(Error::BadGroup)
            }
            Err(error) => Err(error),
        }
    }

    /// First contact with a session group this device joined by Welcome (5.2.6): learns the group's past
    /// from its founding ([`Device::learn_history`], with the founding GroupInfo and the Commits of
    /// `served`), so that a helper session is known to have been founded by its main session's agent leaf
    /// of that time and to have obeyed 5.2.3 since. `bad-group` is the finding; when the history served is
    /// the group's own, the device then opens none of the session's content and writes nothing into it but
    /// the Commit that removes leaves. `room-behind` and `group-behind` are no findings: the room's past, or
    /// the main session's, is learned first.
    pub fn verify_founding(
        &mut self,
        group: &GroupId,
        served: &ServedGroup<'_>,
    ) -> Result<(), Error> {
        self.owner()?;
        if !self.is_leaf_of(group) || group.is_room() {
            return Err(Error::NotFound);
        }
        self.learn_history(group, served.founding, served.commits)
            .map(|_| ())
    }

    /// The main sessions whose agent leaf over the whole time this device holds.
    fn past_sessions(&self) -> Result<PastSessions, Error> {
        let mut seats = BTreeMap::new();
        for (group, meta) in &self.memory.groups {
            let Some(session) = meta.session.filter(|session| session.parent.is_zero()) else {
                continue;
            };
            if self.origin(group)?.is_some_and(|origin| origin.learned) {
                seats.insert(session.session_id, meta.seats.clone());
            }
        }
        for (group, observer) in &self.memory.observers {
            let Some(session) = observer
                .session()
                .filter(|session| session.parent.is_zero())
            else {
                continue;
            };
            if self.origin(group)?.is_some_and(|origin| origin.learned) {
                seats
                    .entry(session.session_id)
                    .or_insert_with(|| observer.seats().to_vec());
            }
        }
        Ok(PastSessions { seats })
    }

    fn learn(
        &mut self,
        batch: &mut Batch,
        group: &GroupId,
        founding: &[u8],
        commits: &[ServedCommit<'_>],
    ) -> Result<Learned, Refusal> {
        let room_id = self.memory.record.room.ok_or(Error::NoRoom)?;
        if group.room_id() != room_id {
            return Err(Error::WrongRoom.into());
        }
        let member = self.memory.groups.contains_key(group);
        if !member && !self.memory.observers.contains_key(group) {
            return Err(Error::NotFound.into());
        }
        let mut origin = self
            .origin(group)?
            .ok_or_else(|| damaged("a group's origin"))?;
        if origin.learned {
            return Ok(Learned { epochs: 0 });
        }
        let session: Option<TrommiSession> = if group.is_room() {
            None
        } else {
            let held = self.memory.groups.get(group).and_then(|meta| meta.session);
            let followed = self
                .memory
                .observers
                .get(group)
                .and_then(|observer| observer.session().copied());
            Some(
                held.or(followed)
                    .ok_or(Error::Internal("a session group without its extension"))?,
            )
        };
        // A session's Commits name room states from the room's founding on.
        let room_history = match session {
            None => None,
            Some(_) => {
                let room_learned = self
                    .origin(&GroupId::room(room_id))?
                    .is_some_and(|origin| origin.learned);
                if !room_learned {
                    return Err(Error::RoomBehind.into());
                }
                Some(self.history()?.clone())
            }
        };
        let sessions = self.past_sessions()?;
        if let Some(session) = session.filter(|session| !session.parent.is_zero()) {
            // 5.2.6: a helper session is judged against its main session's agent leaf of the time,
            // which only a device that holds that session's whole past can tell.
            if !sessions.seats.contains_key(&session.parent) {
                return Err(Error::GroupBehind.into());
            }
        }

        let started = if group.is_room() {
            Observer::follow_room(founding, None)
        } else {
            Observer::follow_founding(founding)
        };
        let mut observer = started.map_err(|_| Refusal::BadGroup)?;
        if observer.group() != *group || observer.epoch()? != 0 {
            return Err(Refusal::BadGroup);
        }
        if let Some(history) = observer.history() {
            rules::check_room_founding(history.newest()).map_err(|_| Refusal::BadGroup)?;
        }
        let context = Context {
            room: room_history.as_ref(),
            sessions: &sessions,
            recovery: &PublicRules,
            max_human_devices: MAX_HUMAN_DEVICES_IN_RECOVERY,
        };
        let mut walked = Walked::begin(&observer)?;
        let mut served = commits.iter();
        let mut places: Vec<(u64, u64)> = Vec::new();
        while observer.epoch()? < origin.epoch {
            // A history that ends before the device's own epoch is cut short.
            let commit = served.next().ok_or(Refusal::BadGroup)?;
            // A group's Commits stand in the hub's order.
            if places
                .last()
                .is_some_and(|(_, last)| *last >= commit.change)
            {
                return Err(Refusal::BadGroup);
            }
            // 5.2.1: a session Commit names the room epoch that was current at its place.
            let at = match session {
                Some(_) => Some(self.room_epoch_at(commit.change)?),
                None => None,
            };
            match walked.follow(&mut observer, commit, &context, at) {
                Ok(_) => places.push((observer.epoch()?, commit.change)),
                Err(fault) if is_fault(&fault) => return Err(fault.into()),
                Err(early @ (Error::RoomBehind | Error::NewerVersion)) => return Err(early.into()),
                Err(_) => return Err(Refusal::BadGroup),
            }
        }
        // The one test that authenticates all of it.
        if observer.group_context()? != origin.context {
            return Err(Refusal::BadGroup);
        }
        let upto = usize::try_from(origin.epoch).map_err(|_| Error::Internal("epoch"))?;
        let (past, arrived) = walked
            .epochs
            .split_at_checked(upto)
            .ok_or(Error::Internal("a walk shorter than its epochs"))?;
        let arrived = arrived.first().ok_or(Error::Internal("a walk's end"))?;

        if let Some(earlier) = observer.history() {
            self.take_room_past(batch, group, earlier)?;
            // Where each room epoch began in the hub's order, by which a session Commit is judged at
            // its place. A place the device knows from the log itself stays.
            for (epoch, change) in places {
                if !self.memory.room_places.contains_key(&epoch) {
                    self.put_room_place(batch, epoch, change);
                }
            }
        }
        if session.is_some_and(|session| session.parent.is_zero()) {
            if member {
                let meta = self
                    .memory
                    .groups
                    .get_mut(group)
                    .ok_or(Error::Internal("a group's record"))?;
                meta.seats = joined_seats(observer.seats(), &meta.seats);
            } else if let Some(follower) = self.memory.observers.get_mut(group) {
                follower.prepend(None, observer.seats())?;
            }
        }
        if member {
            self.record_past(batch, group, past)?;
            self.correct_first_epoch(batch, group, origin.epoch, arrived)?;
            // The Commit that led to the device's first epoch is the group's last one until the device
            // processes another.
            let stands_there = self.is_leaf_of(group)
                && group::load(&self.provider, group)?.epoch().as_u64() == origin.epoch;
            if stands_there && session.is_some() {
                self.meta(group)?.previous_room_epoch = arrived.room_epoch;
            }
            self.put_group(batch, group)?;
        }
        origin.learned = true;
        self.put_stored(batch, origin_key(group), codec::encode(&origin)?);
        Ok(Learned {
            epochs: origin.epoch,
        })
    }

    /// Puts the room's roles of the earlier epochs, as a walk found them, in front of what this device
    /// holds. Every state it holds already must be the walk's (`bad-group`).
    fn take_room_past(
        &mut self,
        batch: &mut Batch,
        group: &GroupId,
        earlier: &RoomHistory,
    ) -> Result<(), Refusal> {
        let held = self.history()?.clone();
        let reached = earlier.newest().epoch;
        let agrees = held
            .states()
            .filter(|state| state.epoch <= reached)
            .all(|state| earlier.at(state.epoch) == Some(state));
        if !agrees || held.at(reached).is_none() {
            return Err(Refusal::BadGroup);
        }
        if self.memory.history.is_some() {
            let mut whole = earlier.clone();
            for state in held.states().filter(|state| state.epoch > reached) {
                whole.record(state.clone())?;
            }
            for state in earlier.states() {
                batch.put(super::history_key(state.epoch), codec::encode(state)?);
            }
            self.memory.history = Some(whole);
        } else {
            self.memory
                .observers
                .get_mut(group)
                .ok_or(Error::Internal("room observer"))?
                .prepend(Some(earlier), &[])?;
        }
        Ok(())
    }

    /// The record of one epoch as this device keeps it, from what a walk found: the leaves with the roles
    /// the Commit that began the epoch was judged with, and the seat.
    fn facts_of(&self, group: &GroupId, epoch: &WalkedEpoch) -> Result<EpochFacts, Error> {
        let leaves: Vec<(LeafNodeIndex, DeviceId)> = epoch
            .leaves
            .iter()
            .zip(0u32..)
            .map(|(device, index)| (LeafNodeIndex::new(index), *device))
            .collect();
        self.roles(group, &leaves, epoch.room_epoch)
    }

    /// Records the epochs `past` of `group`, all of which ended, as learned, and ends the chains their
    /// Commits cut. The room's roles and the sessions' seats of that time are in memory already.
    pub(super) fn record_past(
        &mut self,
        batch: &mut Batch,
        group: &GroupId,
        past: &[WalkedEpoch],
    ) -> Result<(), Error> {
        let mut cuts: Vec<(Cut, u64)> = Vec::new();
        for (number, epoch) in (0u64..).zip(past) {
            let end = epoch
                .end
                .as_ref()
                .ok_or(Error::Internal("a past epoch without its end"))?;
            let mut facts = self.facts_of(group, epoch)?;
            facts.learned = true;
            // The device did not process this Commit when it came: no clock of its own stands for it.
            facts.end = Some(EpochEnd {
                processed_at: 0,
                time: end.time,
            });
            self.put_stored(
                batch,
                group_key(table::CHAIN, SUB_EPOCH, group, &number.to_be_bytes()),
                codec::encode(&facts)?,
            );
            let began = number.saturating_add(1);
            for cut in &end.cuts {
                // The first Cut of a device stands (9.0.10).
                if !cuts.iter().any(|(held, _)| held.device == cut.device) {
                    cuts.push((*cut, began));
                }
            }
        }
        // A Cut of the past is earlier than any this device took from a Commit it processed itself.
        for (cut, began) in cuts {
            self.end_chain(batch, group, &cut, began)?;
        }
        Ok(())
    }

    /// The record of the device's first epoch in `group`, written when it joined without knowing the
    /// Commit that led there, gets the roles that Commit was judged with. The leaves are the walk's.
    fn correct_first_epoch(
        &mut self,
        batch: &mut Batch,
        group: &GroupId,
        epoch: u64,
        arrived: &WalkedEpoch,
    ) -> Result<(), Refusal> {
        let mut own = self
            .epoch_facts(group, epoch)?
            .ok_or_else(|| damaged("an epoch record"))?;
        let judged = self.facts_of(group, arrived)?;
        let devices = |facts: &EpochFacts| -> BTreeSet<DeviceId> {
            facts.leaves.iter().map(|(device, _)| *device).collect()
        };
        if devices(&own) != devices(&judged) {
            return Err(Refusal::BadGroup);
        }
        own.leaves = judged.leaves;
        own.seat = judged.seat;
        self.put_stored(
            batch,
            group_key(table::CHAIN, SUB_EPOCH, group, &epoch.to_be_bytes()),
            codec::encode(&own)?,
        );
        Ok(())
    }

    /// A device that joined `group` from outside with the code (8.4) verified the group from its founding
    /// before it joined: what that walk found becomes its record of the group's past, in the write of the
    /// join. The walk's last epoch is the one the join ended, at `now_ms`.
    pub(super) fn record_walked(
        &mut self,
        batch: &mut Batch,
        group: &GroupId,
        walked: &Walked,
        now_ms: u64,
    ) -> Result<(), Error> {
        let mut past = walked.epochs.clone();
        if let Some(last) = past.last_mut() {
            last.end = Some(WalkedEnd {
                time: now_ms,
                cuts: Vec::new(),
            });
        }
        let mut origin = self
            .origin(group)?
            .ok_or_else(|| damaged("a group's origin"))?;
        if u64::try_from(past.len()).ok() != Some(origin.epoch) {
            return Err(Error::Internal(
                "a walk that does not end where the join begins",
            ));
        }
        self.record_past(batch, group, &past)?;
        origin.learned = true;
        self.put_stored(batch, origin_key(group), codec::encode(&origin)?);
        Ok(())
    }

    /// Whether the records of every group's epochs fit together: they run without a hole from the first
    /// to the newest, those before the group's origin are learned and reach back to epoch 0, and no other
    /// is. `Error::Storage` otherwise. For the device being opened.
    pub(super) fn check_past(&self) -> Result<(), Error> {
        let prefix = [table::CHAIN, SUB_EPOCH];
        let mut epochs: BTreeMap<GroupId, Vec<(u64, bool)>> = BTreeMap::new();
        for (key, value) in self.stored_under(&prefix) {
            let mut rest = Reader::new(key.get(prefix.len()..).unwrap_or_default());
            let parsed = (|| {
                let group = super::group_after(&mut rest)?;
                let epoch = rest.u64()?;
                rest.finish()?;
                let facts: EpochFacts = codec::decode(&value, value.len())?;
                Ok::<_, Error>((group, epoch, facts.learned))
            })()
            .map_err(|_| damaged("an epoch record"))?;
            epochs
                .entry(parsed.0)
                .or_default()
                .push((parsed.1, parsed.2));
        }
        for (group, held) in epochs {
            let origin = self
                .origin(&group)?
                .ok_or_else(|| damaged("a group's origin"))?;
            let first = held.first().map_or(0, |(epoch, _)| *epoch);
            let whole = (first..).zip(&held).all(|(expected, (epoch, learned))| {
                *epoch == expected && *learned == (*epoch < origin.epoch)
            });
            let begins = if origin.learned { 0 } else { origin.epoch };
            if !whole || first != begins {
                return Err(damaged("a group's epochs"));
            }
        }
        Ok(())
    }
}
