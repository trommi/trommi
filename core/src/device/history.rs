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
//! key and one message. The hub's change numbers are its word alone: a walk places each session Commit by
//! its change number, which must lie in the room epoch the Commit's own note names (5.2.1), and records
//! where each room epoch began. A wrong number can fail a walk; in a walk that is taken it changes nothing
//! of what is recorded but those places. A helper session's Commit is judged against its main session's
//! agent leaf at the Commit's place: a main session can lose its agent leaf and gain another within one
//! room epoch.
//!
//! **Order.** A session Commit names a room state, and a helper session's the agent leaf of its main
//! session: the room group's past is learned first (`room-behind` otherwise), then a main session's, then
//! its helper sessions' (`group-behind` otherwise).
//!
//! **First contact (5.2.6).** A history that is the group's own, by the test above, and that breaks
//! section 5 by its own word is the finding `bad-group`: the session group is closed as after a failed
//! first contact. Its own word is what the transcript binds: the Commits, their notes and the trees. The
//! change numbers, their order and a `RecoveryAuth` stored beside a Commit are the hub's word: a history
//! that fails only by them, or that is not the group's own, is `bad-group` too, and changes nothing. The
//! hub lied, not the group.

use super::facts::{group_key, EpochFacts, SUB_EPOCH, SUB_FINDING, SUB_ORIGIN};
use super::Device;
use crate::chain::EpochEnd;
use crate::codec::{self, Decode, Encode, Reader, Writer};
use crate::error::Error;
use crate::ids::{DeviceId, GroupId, SessionId};
use crate::mls::group;
use crate::mls::observer::{self, Context, Observer, Place, RoomEpochAt};
use crate::mls::profile::{Cut, TrommiSession, MAX_HUMAN_DEVICES_IN_RECOVERY};
use crate::mls::rules::{
    self, JoinClaim, Parent, RecoveryRules, RoomHistory, SealedKeyClaim, SessionFacts,
};
use crate::recovery::{
    fits_a_slice, slice_of, At, PublicRules, ServedCommit, ServedGroup, SessionsAt, Walked,
    WalkedEnd, WalkedEpoch, MAX_WALK_COMMITS,
};
use crate::store::{table, Batch, Storage};
use openmls::group::GroupContext;
use openmls::prelude::LeafNodeIndex;
use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};
use tls_codec::{Deserialize as _, Serialize as _};

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
        let context = reader.opaque()?;
        if context.is_empty() || context.len() > MAX_CONTEXT_LEN {
            return Err(Error::BadFormat);
        }
        let learned = match reader.u8()? {
            0 => false,
            1 => true,
            _ => return Err(Error::BadFormat),
        };
        if epoch == 0 && !learned {
            return Err(Error::BadFormat);
        }
        Ok(Self {
            epoch,
            context: context.to_vec(),
            learned,
        })
    }
}

impl Origin {
    /// Whether the context written down is a GroupContext of `group` at the origin's epoch: what a walk
    /// of that group can arrive at.
    fn is_of(&self, group: &GroupId) -> bool {
        GroupContext::tls_deserialize_exact(&self.context).is_ok_and(|context| {
            context.group_id().as_slice() == group.as_bytes()
                && context.epoch().as_u64() == self.epoch
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

/// The room's main sessions as a walk of the past asks about them: only those whose whole past the device
/// holds answer. Which agent device sat where else at that time, and how many helper sessions lived, a
/// reader of one group's history cannot know: the hub judged both when it took the Commit.
struct PastSessions {
    seats: BTreeMap<SessionId, Vec<(u64, Option<DeviceId>)>>,
}

impl SessionsAt for PastSessions {
    fn main_session_at(&self, session: &SessionId, change: u64) -> Parent {
        match self.seats.get(session) {
            Some(seats) => observer::parent_at(seats, change),
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

/// The main sessions for a reading of a helper session's Commit by the group's own word (5.2.6): the hub
/// says where a Commit stands, the Commit's signed note says which room epoch it names. Within that room
/// epoch the main session may have had several agent leaves, one after the other; each is offered in turn,
/// and the Commit broke the rules only if it breaks them against every one.
struct AnyPlace<'a> {
    sessions: &'a PastSessions,
    /// Per room epoch, the place of the Commit that led to it.
    places: &'a BTreeMap<u64, u64>,
    /// Which of the main session's states is offered.
    pick: Cell<usize>,
    /// How many there are, as the last question found.
    offered: Cell<usize>,
}

impl SessionFacts for AnyPlace<'_> {
    fn main_session(&self, session: &SessionId, room_epoch: u64) -> Parent {
        let Some(seats) = self.sessions.seats.get(session) else {
            return Parent::Unknown;
        };
        // The room epoch reaches from the place of the Commit that led to it to the next one's.
        let from = match (room_epoch, self.places.get(&room_epoch)) {
            (_, Some(place)) => *place,
            (0, None) => 0,
            (_, None) => return Parent::Unknown,
        };
        let until = room_epoch
            .checked_add(1)
            .and_then(|next| self.places.get(&next))
            .copied()
            .unwrap_or(u64::MAX);
        let mut states = vec![observer::parent_at(seats, from)];
        for (change, seat) in seats {
            let state = Parent::Seat(*seat);
            if *change > from && *change < until && !states.contains(&state) {
                states.push(state);
            }
        }
        self.offered.set(states.len());
        states
            .get(self.pick.get())
            .copied()
            .unwrap_or(Parent::Unknown)
    }

    fn main_session_of(&self, _: &DeviceId) -> Option<SessionId> {
        None
    }

    fn live_helpers(&self, _: &SessionId) -> usize {
        0
    }
}

/// The recovery construct for a reading by the group's own word: a `RecoveryAuth` is stored beside its
/// Commit, not in it, so whether a join carried one is the hub's word, and no join is held against the
/// group for it.
struct DetachedAuth;

impl RecoveryRules for DetachedAuth {
    fn verify_join(&self, _: &JoinClaim<'_>) -> Result<(), Error> {
        Ok(())
    }

    fn verify_sealed_key(&self, _: &SealedKeyClaim<'_>, _: &[u8]) -> Result<(), Error> {
        Err(Error::Incomplete)
    }
}

/// Where a walk of a group's past stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LearnProgress {
    /// The epoch the walk has reached: the next Commit it takes builds on it.
    pub epoch: u64,
    /// The epoch the walk ends at: the one this device's own knowledge of the group begins at.
    pub upto: u64,
}

/// How a walk reads the Commits it is handed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reading {
    /// As every verifier judges them, each at the place the hub names. Only such a walk is taken.
    Rules,
    /// A Commit failed that reading. The rest is read by the group's own word, without the hub's: the
    /// walk is not taken, and is read on only to learn whether the group itself broke the rules.
    OwnWord,
    /// As MLS alone, to learn whether the history is the group's own. `broke`: a Commit broke the rules by
    /// the group's own word; otherwise one could not be judged, or only the hub's word failed.
    Mls { broke: bool },
}

/// A walk of a group's past between its start and its finish. It is held in memory beside the device's
/// state and is none of it: built from what a hub served, and compared with the device's own state only
/// at the finish.
pub(super) struct PastWalk {
    /// Where the device's own knowledge of the group begins, as it stood when the walk began.
    origin: Origin,
    session: Option<TrommiSession>,
    observer: Observer,
    walked: Walked,
    /// Per epoch the walk reached, the change number of the Commit that led to it.
    places: Vec<(u64, u64)>,
    reading: Reading,
}

impl PastWalk {
    fn progress(&self) -> Result<LearnProgress, Error> {
        Ok(LearnProgress {
            epoch: self.observer.epoch()?.min(self.origin.epoch),
            upto: self.origin.epoch,
        })
    }
}

/// Follows a Commit of a session group by the group's own word (5.2.6), whatever the hub says beside it:
/// against the room epoch its signed note names, a helper session's against every agent leaf its main
/// session had in that room epoch, and without its `RecoveryAuth`. Whether it obeys section 5 so; an error
/// when this device cannot judge it (`room-behind`, a newer version).
fn follow_by_its_own_word(
    walk: &mut PastWalk,
    commit: &ServedCommit<'_>,
    room: Option<&RoomHistory>,
    sessions: &PastSessions,
    places: &BTreeMap<u64, u64>,
) -> Result<bool, Error> {
    let any = AnyPlace {
        sessions,
        places,
        pick: Cell::new(0),
        offered: Cell::new(1),
    };
    let context = Context {
        room,
        sessions: &any,
        recovery: &DetachedAuth,
        max_human_devices: MAX_HUMAN_DEVICES_IN_RECOVERY,
    };
    let place = Place {
        change: commit.change,
        room_epoch: RoomEpochAt::Named,
    };
    loop {
        any.offered.set(1);
        match walk
            .observer
            .process_commit_at(commit.commit, None, &context, &place)
        {
            Ok(_) => return Ok(true),
            Err(fault) if is_fault(&fault) => return Err(fault),
            Err(unjudged @ (Error::RoomBehind | Error::NewerVersion)) => return Err(unjudged),
            Err(_) => {
                let next = any.pick.get().saturating_add(1);
                if next >= any.offered.get() {
                    return Ok(false);
                }
                any.pick.set(next);
            }
        }
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

/// Whether the places of the room's epochs ascend with the epochs, as the hub's order has them (5.4.1).
pub(super) fn ascending(places: &BTreeMap<u64, u64>) -> bool {
    places
        .values()
        .zip(places.values().skip(1))
        .all(|(earlier, later)| earlier < later)
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

    /// Learns the past of `group` from its public history (4.6, 9.0.6) in one call: `founding` is its
    /// founding GroupInfo (epoch 0), `commits` its Commits from the first on, in order, as the hub's log
    /// serves them; what lies beyond the epoch this device's own knowledge begins at is not read. This is
    /// [`Device::learn_start`], the Commits in slices, and [`Device::learn_finish`]: a caller that cannot
    /// hold a group's whole history in one call makes those calls itself.
    ///
    /// Nothing to learn (the device founded the group, or learned its past before) is no error. `bad-group`
    /// for a history that does not verify, does not obey section 5, ends before the device's epoch or does
    /// not arrive at its state: nothing is written. If such a history of a session group is the group's own
    /// and broke the rules by its own word, the group is closed as after a failed first contact (5.2.6) and
    /// the finding is kept ([`Device::findings`]). `room-behind`: learn the room group's past first, or
    /// process its log further. `group-behind`: learn the main session's past first.
    pub fn learn_history(
        &mut self,
        group: &GroupId,
        founding: &[u8],
        commits: &[ServedCommit<'_>],
    ) -> Result<Learned, Error> {
        self.learn_start(group, founding)?;
        let mut rest = commits;
        while !rest.is_empty() && self.walks.contains_key(group) {
            let count = slice_of(rest.iter().map(|commit| commit.commit.len()));
            let (slice, later) = rest
                .split_at_checked(count)
                .ok_or(Error::Internal("a slice of a history"))?;
            let progress = self.learn_slice(group, slice)?;
            if progress.epoch >= progress.upto {
                break;
            }
            rest = later;
        }
        self.learn_finish(group)
    }

    /// Begins a walk of the past of `group` (4.6) at its founding GroupInfo (epoch 0). The group is one this
    /// device is a leaf of, or follows as an observer (`not-found` otherwise). The Commits follow in
    /// slices ([`Device::learn_slice`]), and [`Device::learn_finish`] takes the walk or refuses it.
    ///
    /// The walk is held in memory only and is no state of the device: nothing of it is written, and
    /// nothing the device answers reads it, before the finish has compared it with the device's own state.
    /// A device that is opened again holds no walk: the caller starts again. A second start for a group
    /// replaces the first.
    ///
    /// Nothing to learn is no error: the progress then stands at its end and no walk is held. `bad-group`
    /// for a GroupInfo that is not the group's founding. `room-behind`: learn the room group's past first.
    /// `group-behind`: learn the main session's past first. `too-large`: the device's first epoch lies
    /// beyond [`MAX_WALK_COMMITS`].
    pub fn learn_start(
        &mut self,
        group: &GroupId,
        founding: &[u8],
    ) -> Result<LearnProgress, Error> {
        self.owner()?;
        self.walks.remove(group);
        let room_id = self.memory.record.room.ok_or(Error::NoRoom)?;
        if group.room_id() != room_id {
            return Err(Error::WrongRoom);
        }
        let member = self.memory.groups.contains_key(group);
        if !member && !self.memory.observers.contains_key(group) {
            return Err(Error::NotFound);
        }
        let origin = self
            .origin(group)?
            .ok_or_else(|| damaged("a group's origin"))?;
        if origin.learned {
            return Ok(LearnProgress {
                epoch: origin.epoch,
                upto: origin.epoch,
            });
        }
        if origin.epoch > MAX_WALK_COMMITS {
            return Err(Error::TooLarge);
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
        if session.is_some() {
            // A session's Commits name room states from the room's founding on.
            let room_learned = self
                .origin(&GroupId::room(room_id))?
                .is_some_and(|origin| origin.learned);
            if !room_learned {
                return Err(Error::RoomBehind);
            }
        }
        if let Some(session) = session.filter(|session| !session.parent.is_zero()) {
            // 5.2.6: a helper session is judged against its main session's agent leaf of the time,
            // which only a device that holds that session's whole past can tell.
            if !self.past_sessions()?.seats.contains_key(&session.parent) {
                return Err(Error::GroupBehind);
            }
        }
        let started = if group.is_room() {
            Observer::follow_room(founding, None)
        } else {
            Observer::follow_founding(founding)
        };
        let observer = started.map_err(|_| Error::BadGroup)?;
        if observer.group() != *group || observer.epoch()? != 0 {
            return Err(Error::BadGroup);
        }
        if let Some(history) = observer.history() {
            rules::check_room_founding(history.newest()).map_err(|_| Error::BadGroup)?;
        }
        let walk = PastWalk {
            walked: Walked::begin(&observer)?,
            origin,
            session,
            observer,
            places: Vec::new(),
            reading: Reading::Rules,
        };
        let progress = walk.progress()?;
        self.walks.insert(*group, walk);
        Ok(progress)
    }

    /// Hands the walk of `group` the next Commits of the group's log, in order, as the hub serves them: at
    /// most [`crate::recovery::MAX_SLICE_COMMITS`] of them, of at most [`crate::recovery::MAX_SLICE_LEN`] bytes together (`too-large`
    /// otherwise, and the walk stands where it was). Each Commit is judged as every verifier judges it, a
    /// session's against the room state, and a helper session's against its main session's agent leaf, at
    /// the place its change number names. What lies beyond the epoch this device's own knowledge begins at
    /// is not read. Nothing is written.
    ///
    /// A slice follows the one before it: the walk takes each Commit only on the state the Commits before
    /// it led to, so a slice handed twice, out of turn or from another history does not verify there. A
    /// Commit that does not verify or obey the rules ends the walk (`bad-group`), and the caller starts
    /// again; so do `room-behind` (process the room's log further) and every other failure. For a session
    /// group this device is a leaf of, the walk goes on after a Commit that broke the rules, reading the
    /// rest only to learn whether that history is the group's own (5.2.6): [`Device::learn_finish`] says so.
    /// `not-found` without a walk.
    pub fn learn_slice(
        &mut self,
        group: &GroupId,
        commits: &[ServedCommit<'_>],
    ) -> Result<LearnProgress, Error> {
        self.owner()?;
        let Some(mut walk) = self.walks.remove(group) else {
            return self.nothing_to_learn(group).map(|origin| LearnProgress {
                epoch: origin.epoch,
                upto: origin.epoch,
            });
        };
        if !fits_a_slice(commits.iter().map(|commit| commit.commit.len())) {
            self.walks.insert(*group, walk);
            return Err(Error::TooLarge);
        }
        let room = match walk.session {
            Some(_) => Some(self.history()?.clone()),
            None => None,
        };
        let sessions = self.past_sessions()?;
        let closable = walk.session.is_some() && self.is_leaf_of(group);
        for commit in commits {
            if walk.observer.epoch()? >= walk.origin.epoch {
                break;
            }
            self.walk_on(&mut walk, commit, room.as_ref(), &sessions, closable)?;
        }
        let progress = walk.progress()?;
        self.walks.insert(*group, walk);
        Ok(progress)
    }

    /// Ends the walk of `group` and takes it, if it arrived at this device's own state: the GroupContext
    /// it reached at the epoch this device's knowledge begins at is byte for byte the one this device's
    /// state had there (4.6). Only then every earlier epoch is recorded as the device records its own, with
    /// the Cuts of the Commits on the way, in one write; envelopes of those epochs are checked from then
    /// on, with the freshness of reading back (9.0.5, check 8). For a group it follows as an observer the
    /// device takes the room's roles of the earlier epochs, or a main session's agent leaf over that time.
    ///
    /// `bad-group` for a walk that was not handed every Commit up to that epoch, that arrives elsewhere, or
    /// that read a Commit which broke the rules: nothing is written, but for a session group whose own
    /// history broke the rules by its own word, which is closed (5.2.6) with its finding
    /// ([`Device::findings`]). Whatever the answer, the walk is gone. Nothing to learn is no error;
    /// `not-found` without a walk.
    pub fn learn_finish(&mut self, group: &GroupId) -> Result<Learned, Error> {
        self.owner()?;
        let Some(walk) = self.walks.remove(group) else {
            return self.nothing_to_learn(group).map(|_| Learned { epochs: 0 });
        };
        // The one test that authenticates all of it. The device's own state is the one the walk began
        // for.
        let arrived = walk.observer.epoch()? == walk.origin.epoch
            && walk.observer.group_context()? == walk.origin.context
            && self.origin(group)?.as_ref() == Some(&walk.origin);
        if !arrived {
            return Err(Error::BadGroup);
        }
        match walk.reading {
            Reading::Rules => self.transact(|this, batch| {
                this.begin(0);
                this.take_walk(batch, group, walk)
            }),
            Reading::Mls { broke: true } if self.is_leaf_of(group) => {
                // The history is the group's own, and it broke the rules by its own word.
                self.transact(|this, batch| {
                    this.begin(0);
                    let meta = this.meta(group)?;
                    meta.distrusted = true;
                    meta.closed = true;
                    this.put_group(batch, group)?;
                    this.put_stored(
                        batch,
                        group_key(table::CHAIN, SUB_FINDING, group, DeviceId::ZERO.as_bytes()),
                        Error::BadGroup.code().as_bytes().to_vec(),
                    );
                    Ok(())
                })?;
                Err(Error::BadGroup)
            }
            // What failed was the hub's word, or cannot be judged: it says nothing about the group.
            Reading::OwnWord | Reading::Mls { .. } => Err(Error::BadGroup),
        }
    }

    /// Gives up the walk of `group`, if one is held.
    pub fn learn_abandon(&mut self, group: &GroupId) {
        self.walks.remove(group);
    }

    /// The origin of a group whose past this device holds already; `not-found` for any other group, of
    /// which a walk would have to be started first.
    fn nothing_to_learn(&self, group: &GroupId) -> Result<Origin, Error> {
        self.origin(group)?
            .filter(|origin| origin.learned)
            .ok_or(Error::NotFound)
    }

    /// Reads the next Commit of a walk, by the reading the walk is in. A Commit that the rules refuse
    /// ends the walk, unless the group is `closable` (a session group this device is a leaf of): then the
    /// walk reads on, first by the group's own word, then as MLS alone, to learn at the finish whether
    /// the history is the group's own.
    fn walk_on(
        &self,
        walk: &mut PastWalk,
        commit: &ServedCommit<'_>,
        room: Option<&RoomHistory>,
        sessions: &PastSessions,
        closable: bool,
    ) -> Result<(), Error> {
        loop {
            match walk.reading {
                Reading::Rules => {
                    // A group's Commits stand in the hub's order.
                    let ordered = walk
                        .places
                        .last()
                        .is_none_or(|(_, last)| *last < commit.change);
                    let followed = if ordered {
                        self.follow_by_the_rules(walk, commit, room, sessions)
                    } else {
                        Err(Error::BadGroup)
                    };
                    match followed {
                        Ok(()) => {
                            walk.places.push((walk.observer.epoch()?, commit.change));
                            return Ok(());
                        }
                        Err(fault) if is_fault(&fault) => return Err(fault),
                        Err(early @ (Error::RoomBehind | Error::NewerVersion)) => {
                            return Err(early)
                        }
                        Err(_) if closable => walk.reading = Reading::OwnWord,
                        Err(_) => return Err(Error::BadGroup),
                    }
                }
                Reading::OwnWord => match follow_by_its_own_word(
                    walk,
                    commit,
                    room,
                    sessions,
                    &self.memory.room_places,
                ) {
                    Ok(true) => return Ok(()),
                    Ok(false) => walk.reading = Reading::Mls { broke: true },
                    Err(fault) if is_fault(&fault) => return Err(fault),
                    Err(_) => walk.reading = Reading::Mls { broke: false },
                },
                Reading::Mls { .. } => {
                    return walk
                        .observer
                        .follow_unjudged(commit.commit)
                        .map_err(|error| {
                            if is_fault(&error) {
                                error
                            } else {
                                Error::BadGroup
                            }
                        });
                }
            }
        }
    }

    /// Follows a Commit as every verifier judges it, at the place its change number names.
    fn follow_by_the_rules(
        &self,
        walk: &mut PastWalk,
        commit: &ServedCommit<'_>,
        room: Option<&RoomHistory>,
        sessions: &PastSessions,
    ) -> Result<(), Error> {
        // 5.2.1: a session Commit names the room epoch that was current at its place, and a helper
        // session's is judged against its main session's agent leaf there.
        let at = match walk.session {
            Some(_) => RoomEpochAt::Epoch(self.room_epoch_at(commit.change)?),
            None => RoomEpochAt::Newest,
        };
        let context = Context {
            room,
            sessions: &At(sessions, commit.change),
            recovery: &PublicRules,
            max_human_devices: MAX_HUMAN_DEVICES_IN_RECOVERY,
        };
        walk.walked
            .follow(&mut walk.observer, commit, &context, at)
            .map(|_| ())
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

    /// Writes what a walk found, which arrived at this device's own state by the rules: the learned
    /// records, the Cuts, the room's roles or a main session's agent leaf of the earlier time, and the
    /// origin as learned, all in `batch`.
    fn take_walk(
        &mut self,
        batch: &mut Batch,
        group: &GroupId,
        walk: PastWalk,
    ) -> Result<Learned, Error> {
        let PastWalk {
            mut origin,
            session,
            observer,
            walked,
            places,
            ..
        } = walk;
        let member = self.memory.groups.contains_key(group);
        let upto = usize::try_from(origin.epoch).map_err(|_| Error::Internal("epoch"))?;
        let (past, arrived) = walked
            .epochs
            .split_at_checked(upto)
            .ok_or(Error::Internal("a walk shorter than its epochs"))?;
        let arrived = arrived.first().ok_or(Error::Internal("a walk's end"))?;

        if let Some(earlier) = observer.history() {
            // Where each room epoch began in the hub's order, by which a session Commit is judged at
            // its place. The places are the hub's word, and one hub's word does not contradict itself:
            // a place the device knows from the log itself stays, the walk names the same one for that
            // epoch, and all of them together ascend with the epochs.
            let mut whole = self.memory.room_places.clone();
            for (epoch, change) in &places {
                if *whole.entry(*epoch).or_insert(*change) != *change {
                    return Err(Error::BadGroup);
                }
            }
            if !ascending(&whole) {
                return Err(Error::BadGroup);
            }
            self.take_room_past(batch, group, earlier)?;
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
    ) -> Result<(), Error> {
        let held = self.history()?.clone();
        let reached = earlier.newest().epoch;
        let agrees = held
            .states()
            .filter(|state| state.epoch <= reached)
            .all(|state| earlier.at(state.epoch) == Some(state));
        if !agrees || held.at(reached).is_none() {
            return Err(Error::BadGroup);
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
        self.roles(group, &leaves, epoch.room_epoch, Some(epoch.change))
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
    /// Commit that led there, gets the roles that Commit was judged with. The leaves are the walk's. Where
    /// a role changes, the group's object states and registers are built again.
    fn correct_first_epoch(
        &mut self,
        batch: &mut Batch,
        group: &GroupId,
        epoch: u64,
        arrived: &WalkedEpoch,
    ) -> Result<(), Error> {
        let mut own = self
            .epoch_facts(group, epoch)?
            .ok_or_else(|| damaged("an epoch record"))?;
        let judged = self.facts_of(group, arrived)?;
        let devices = |facts: &EpochFacts| -> BTreeSet<DeviceId> {
            facts.leaves.iter().map(|(device, _)| *device).collect()
        };
        if devices(&own) != devices(&judged) {
            return Err(Error::BadGroup);
        }
        let corrected = own.leaves != judged.leaves || own.seat != judged.seat;
        own.leaves = judged.leaves;
        own.seat = judged.seat;
        self.put_stored(
            batch,
            group_key(table::CHAIN, SUB_EPOCH, group, &epoch.to_be_bytes()),
            codec::encode(&own)?,
        );
        if corrected {
            // What the device took of that epoch was judged with the roles it held then: the group's
            // objects and registers are built again from its records, each judged with the roles now
            // known (9.2.1).
            self.replay_group(batch, group)?;
        }
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

    /// Whether the records of every group's epochs fit together: every group the device holds or follows
    /// has its origin, an origin's context is a GroupContext of its group at its epoch, the records run
    /// without a hole from the first to the newest, those before the group's origin are learned and reach
    /// back to epoch 0, and no other is. `Error::Storage` otherwise. For the device being opened.
    pub(super) fn check_past(&self) -> Result<(), Error> {
        let origins = [table::CHAIN, SUB_ORIGIN];
        for (key, _) in self.stored_under(&origins) {
            let mut rest = Reader::new(key.get(origins.len()..).unwrap_or_default());
            let group = super::group_after(&mut rest)
                .and_then(|group| rest.finish().map(|()| group))
                .map_err(|_| damaged("a group's origin"))?;
            if !self
                .origin(&group)?
                .is_some_and(|origin| origin.is_of(&group))
            {
                return Err(damaged("a group's origin"));
            }
        }
        let held = self.memory.groups.keys();
        for group in held.chain(self.memory.observers.keys()) {
            if self.origin(group)?.is_none() {
                return Err(damaged("a group's origin"));
            }
        }
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
