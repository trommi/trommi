//! Following a group without being in it (4.4, 14.1): the hub on every group, a device that is not a human
//! device on the room group, a helper device on its main session's group. An [`Observer`] holds the group's
//! public state (OpenMLS's `PublicGroup`), takes each Commit only if it verifies there and obeys the rules of
//! [`crate::mls::rules`], and for the room group records the roles per epoch.
//!
//! An observer cannot check membership tags, confirmation tags or the encrypted part of a path: members do.
//!
//! Its state is kept by its holder: [`Observer::take_changes`] gives what changed since the last call as a
//! [`Batch`] of entries, [`Observer::load`] reads them back. Stored entries are untrusted.

use crate::codec::{self, Decode, Encode, Reader, Writer};
use crate::crypto;
use crate::error::Error;
use crate::ids::{DeviceId, GroupId, Hash32, SessionId};
use crate::mls::profile::{self, GroupKind, TrommiSession, MAX_COMMIT_REQUEST_LEN};
use crate::mls::provider::{self, MlsEntries, Provider};
use crate::mls::rules::{
    self, CommitFacts, ContextChange, Judged, Parent, RecoveryRules, RoomHistory, RoomState,
    SealedKeyClaim, SessionBefore, SessionFacts, Verifier,
};
use crate::recovery;
use crate::store::{Batch, Entry};
use openmls::group::{ProposalStore, PublicGroup};
use openmls::messages::group_info::VerifiableGroupInfo;
use openmls::prelude::{
    LeafNodeIndex, MlsMessageBodyIn, MlsMessageIn, OpenMlsSignaturePublicKey,
    ProcessedMessageContent, Proposal, Verifiable as _,
};
use openmls_traits::types::SignatureScheme;
use openmls_traits::OpenMlsProvider as _;
use std::collections::BTreeSet;
use tls_codec::{Deserialize as _, Serialize as _, Size as _};

/// The first byte of an observer's entry keys: OpenMLS's entries, the observer's own record, one room state.
const KEY_MLS: u8 = 0;
const KEY_RECORD: u8 = 1;
const KEY_ROOM_STATE: u8 = 2;

/// A Commit as it is posted to the hub, with what must come with it (5.4.2).
#[derive(Debug, Clone, Copy)]
pub struct PostedCommit<'a> {
    /// The Commit.
    pub commit: &'a [u8],
    /// The GroupInfo of the epoch it leads to.
    pub group_info: &'a [u8],
    /// The Welcome, if it adds.
    pub welcome: Option<&'a [u8]>,
    /// The `SealedKey` of the epoch it leads to.
    pub sealed_key: &'a [u8],
    /// The `RecoveryAuth`, for a join from outside.
    pub recovery_auth: Option<&'a [u8]>,
    /// The GroupInfo the hub holds for the epoch the Commit builds on: what a join from outside must name
    /// (8.4). A join posted without it is `incomplete`.
    pub base_group_info: Option<&'a [u8]>,
}

/// What an observer judges a Commit against besides the group it follows.
#[derive(Clone, Copy)]
pub struct Context<'a> {
    /// The room's role history, for the observer of a session group; the observer of the room group uses its own.
    pub room: Option<&'a RoomHistory>,
    /// The room's other sessions.
    pub sessions: &'a dyn SessionFacts,
    /// The recovery construct's checks.
    pub recovery: &'a dyn RecoveryRules,
    /// The most human devices the room may hold: the limit of section 16, or one more while a recovery runs.
    pub max_human_devices: usize,
}

/// The room epoch a session Commit read from a log is judged against (5.2.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoomEpochAt {
    /// The newest one the room's history holds: the log is followed in the hub's order.
    Newest,
    /// This one, which was current at the Commit's place: the holder's record of the room reaches beyond
    /// that place.
    Epoch(u64),
    /// The one the Commit's own note names. This reads the Commit by its own word alone, without the hub's
    /// word on where it stands; it shows what the group did, not where.
    Named,
}

/// Where a Commit read from a log stands in the hub's order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Place {
    /// The Commit's change number.
    pub change: u64,
    /// The room epoch it is judged against.
    pub room_epoch: RoomEpochAt,
}

/// A session group's record beside its public state.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SessionRecord {
    session: TrommiSession,
    /// The `room_epoch` of the group's last Commit.
    previous_room_epoch: u64,
    /// For a main session: its agent leaf over time, as (the change number of the Commit that changed it,
    /// the leaf after it). A follower that is told no place records 0: it reads the seat as it stands.
    seats: Vec<(u64, Option<DeviceId>)>,
}

impl Encode for SessionRecord {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.value(&self.session)?;
        writer.u64(self.previous_room_epoch);
        let mut seats = Writer::new();
        for (change, seat) in &self.seats {
            seats.u64(*change);
            seats.value(&seat.unwrap_or(DeviceId::ZERO))?;
        }
        writer.opaque(&seats.into_bytes())
    }
}

impl Decode for SessionRecord {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        let session = reader.value()?;
        let previous_room_epoch = reader.u64()?;
        let mut listed = Reader::new(reader.opaque()?);
        let mut seats = Vec::new();
        while !listed.is_empty() {
            let change = listed.u64()?;
            let seat: DeviceId = listed.value()?;
            seats.push((change, Some(seat).filter(|seat| !seat.is_zero())));
        }
        Ok(Self {
            session,
            previous_room_epoch,
            seats,
        })
    }
}

enum Followed {
    Room(RoomHistory),
    Session(SessionRecord),
}

/// A follower of one group's public state.
pub struct Observer {
    provider: Provider,
    group: GroupId,
    followed: Followed,
    /// OpenMLS's entries as the holder last took them.
    taken: MlsEntries,
    /// The first room epoch not yet handed to the holder, and whether the session record changed.
    untaken_from: u64,
    record_changed: bool,
}

impl std::fmt::Debug for Observer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Observer({})", self.group)
    }
}

fn mls_fault<E>(_: E) -> Error {
    Error::Storage("the MLS storage failed".into())
}

fn damaged() -> Error {
    Error::Storage("an observer entry does not decode".into())
}

/// The refusal of a founding whose first tree holds a leaf that is not the profile's: `bad-commit`, as for
/// such a leaf in any Commit.
fn founding(error: Error) -> Error {
    match error {
        Error::BadGroup => Error::BadCommit,
        other => other,
    }
}

/// A GroupInfo as it travels, parsed.
pub(crate) fn parse_group_info(bytes: &[u8]) -> Result<VerifiableGroupInfo, Error> {
    if bytes.len() > MAX_COMMIT_REQUEST_LEN {
        return Err(Error::TooLarge);
    }
    match MlsMessageIn::tls_deserialize_exact(bytes).map(MlsMessageIn::extract) {
        Ok(MlsMessageBodyIn::GroupInfo(group_info)) => Ok(group_info),
        _ => Err(Error::BadFormat),
    }
}

/// The confirmation tag and the signer's leaf index inside a GroupInfo as it travels: `MLSMessage { version,
/// wire_format, GroupInfo { GroupContext, extensions<V>, confirmation_tag<V>, uint32 signer, signature<V> } }`.
fn tag_and_signer_of(
    bytes: &[u8],
    group_info: &VerifiableGroupInfo,
) -> Result<(Vec<u8>, u32), Error> {
    let context_len = group_info.group_context().tls_serialized_len();
    let mut reader = Reader::new(bytes);
    reader.take(4)?;
    reader.take(context_len)?;
    reader.opaque()?;
    let tag = reader.opaque()?.to_vec();
    Ok((tag, reader.u32()?))
}

impl Observer {
    fn public(&self) -> Result<PublicGroup, Error> {
        let id = openmls::prelude::GroupId::from_slice(self.group.as_bytes());
        PublicGroup::load(self.provider.storage(), &id)
            .map_err(mls_fault)?
            .ok_or_else(damaged)
    }

    /// Starts from a GroupInfo with its tree.
    ///
    /// OpenMLS (`PublicGroup::from_external`) verifies, and any failure is `bad-signature`: the suite is one
    /// it supports; the signature of every leaf, with the group id for a leaf from a Commit or an Update;
    /// the parent hashes of the tree; that no two leaves share a signature key and no two nodes an
    /// encryption key; that every unmerged leaf is a blank-free descendant listed all the way up; that each
    /// leaf's extensions are valid in a leaf and covered by its own capabilities, that its capabilities
    /// cover its credential type and what the group context requires, and that every leaf supports every
    /// other leaf's credential type; that the lifetime of a leaf from a KeyPackage holds the present time;
    /// the GroupInfo's signature under the key of the leaf it names as its signer; that the tree hashes to
    /// the group context's tree hash; that the version is `mls10`. It does not check the confirmation tag
    /// (an observer holds no key), nor that the GroupInfo is the newest.
    ///
    /// The core adds what OpenMLS leaves open, since it takes any credential, any capabilities above the
    /// required ones and any group context: the GroupInfo carries the tree and `external_pub`
    /// (`bad-format`); every leaf of the tree is the profile's, a basic credential that is the leaf's
    /// signature key, exactly the profile's capabilities and no leaf extension (`bad-group`); the epoch is
    /// one a group reaches by Commits (`bad-group`); and the group context is the profile's: `mls10`, the
    /// suite, and the extension list of a room or of a session group with its `required_capabilities`
    /// (`bad-format`). A leaf's lifetime is not readable outside OpenMLS: that it spans no more than the
    /// profile's ten years is checked where a KeyPackage is verified, before it is stored or added and
    /// where a Commit adds it, not for a leaf already in a tree.
    fn start(group_info: &[u8]) -> Result<(Provider, PublicGroup, GroupId, GroupKind), Error> {
        let verifiable = parse_group_info(group_info)?;
        let tree = verifiable
            .extensions()
            .ratchet_tree()
            .ok_or(Error::BadFormat)?
            .ratchet_tree()
            .clone();
        if verifiable.extensions().external_pub().is_none() {
            return Err(Error::BadFormat);
        }
        let provider = Provider::without_entropy(MlsEntries::new())?;
        let (public, _) = PublicGroup::from_external(
            provider.crypto(),
            provider.storage(),
            tree,
            verifiable,
            ProposalStore::new(),
        )
        .map_err(|_| Error::BadSignature)?;
        // OpenMLS takes any credential and any capabilities: that each leaf is the profile's is checked here.
        rules::profile_leaves(&public)?;
        // An epoch no group reaches by Commits: such a state is not stored, since it would not open again.
        if public.group_context().epoch().as_u64() > profile::MAX_STORED_EPOCH {
            return Err(Error::BadGroup);
        }
        let (group, kind) = profile::kind_of_context(public.group_context())?;
        Ok((provider, public, group, kind))
    }

    fn assemble(provider: Provider, group: GroupId, followed: Followed) -> Self {
        let untaken_from = match &followed {
            Followed::Room(history) => history.states().next().map_or(0, |state| state.epoch),
            Followed::Session(_) => 0,
        };
        Self {
            provider,
            group,
            followed,
            taken: MlsEntries::new(),
            untaken_from,
            record_changed: true,
        }
    }

    /// Follows the room group from the GroupInfo of any epoch (4.4, 12.1.6). `expected_state`, if given, is the
    /// `room_state` the follower was told: the GroupInfo must hash to it (`bad-format` otherwise). The role
    /// history starts here.
    pub fn follow_room(group_info: &[u8], expected_state: Option<&Hash32>) -> Result<Self, Error> {
        let (provider, public, group, kind) = Self::start(group_info)?;
        if !matches!(kind, GroupKind::Room(_)) {
            return Err(Error::BadFormat);
        }
        let leaves = rules::leaves_of(public.members())?;
        let state = rules::room_state_of(public.group_context(), &leaves)?;
        if expected_state.is_some_and(|expected| *expected != state.state) {
            return Err(Error::BadFormat);
        }
        Ok(Self::assemble(
            provider,
            group,
            Followed::Room(RoomHistory::new(state)),
        ))
    }

    /// An observer of the room group from the public state a leaf of it holds (`public`: the entries of
    /// [`provider::public_entries`]) and that leaf's record of the roles, whose newest state must be the one
    /// the public state stands in. For a device that is removed from the room group and follows it from there:
    /// nothing is verified again, the leaf verified all of it.
    pub(crate) fn from_member(
        public: MlsEntries,
        group: GroupId,
        history: RoomHistory,
    ) -> Result<Self, Error> {
        provider::validate_entries(&public)?;
        let observer = Self::assemble(
            Provider::without_entropy(public)?,
            group,
            Followed::Room(history),
        );
        let held = observer.public()?;
        let leaves = rules::leaves_of(held.members())?;
        let stands = rules::room_state_of(held.group_context(), &leaves)?;
        match &observer.followed {
            Followed::Room(history) if *history.newest() == stands => Ok(observer),
            _ => Err(damaged()),
        }
    }

    /// The room's roles per epoch, for the holder that takes them over when it becomes a leaf of the room group.
    pub(crate) fn into_history(self) -> Option<RoomHistory> {
        match self.followed {
            Followed::Room(history) => Some(history),
            Followed::Session(_) => None,
        }
    }

    /// Follows a session group from a GroupInfo of any epoch, as a helper device follows its main session's
    /// group. What happened before is unknown to it.
    pub fn follow_session(group_info: &[u8], room: &RoomState) -> Result<Self, Error> {
        let (provider, public, group, kind) = Self::start(group_info)?;
        let GroupKind::Session(session) = kind else {
            return Err(Error::BadFormat);
        };
        let leaves = rules::leaves_of(public.members())?;
        let mut record = SessionRecord {
            session,
            previous_room_epoch: 0,
            seats: Vec::new(),
        };
        record.seats.push((0, seat(&session, &leaves, room)));
        Ok(Self::assemble(provider, group, Followed::Session(record)))
    }

    /// Takes the founding of a room (5.1.1): the GroupInfo of epoch 0 with one leaf, the founder, who signed it,
    /// and the `SealedKey` of epoch 0. Returns the observer and the founder.
    pub fn found_room(
        group_info: &[u8],
        sealed_key: &[u8],
        recovery: &dyn RecoveryRules,
    ) -> Result<(Self, DeviceId), Error> {
        let observer = Self::follow_room(group_info, None).map_err(founding)?;
        let Followed::Room(history) = &observer.followed else {
            return Err(Error::Internal("room observer"));
        };
        let first = history.newest();
        rules::check_room_founding(first)?;
        let founder = *first.humans.iter().next().ok_or(Error::BadCommit)?;
        recovery.verify_sealed_key(
            &SealedKeyClaim {
                group: &observer.group,
                epoch: 0,
                group_info,
                room_epoch: 0,
                recovery_hpke_key: &first.room.recovery_hpke_key,
                writer: &founder,
                writer_is_human: true,
            },
            sealed_key,
        )?;
        Ok((observer, founder))
    }

    /// Takes the founding of a session group (5.2.5), which is one request: the GroupInfo of epoch 0 with the
    /// founder alone, its `SealedKey`, and the first Commit with its parts. `context.room` is the room's history.
    pub fn found_session(
        group_info: &[u8],
        sealed_key: &[u8],
        first: &PostedCommit<'_>,
        context: &Context<'_>,
    ) -> Result<(Self, CommitFacts), Error> {
        let mut observer = Self::follow_founding(group_info)?;
        let group = observer.group;
        let facts = observer.check_posted_commit(first, context)?;
        let note = facts.note.as_ref().ok_or(Error::BadCommit)?;
        let room = context
            .room
            .and_then(|history| history.at(note.room_epoch))
            .ok_or(Error::RoomBehind)?;
        context.recovery.verify_sealed_key(
            &SealedKeyClaim {
                group: &group,
                epoch: 0,
                group_info,
                room_epoch: note.room_epoch,
                recovery_hpke_key: &room.room.recovery_hpke_key,
                writer: &facts.committer,
                writer_is_human: room.is_human(&facts.committer),
            },
            sealed_key,
        )?;
        Ok((observer, facts))
    }

    /// Follows a session group from its founding GroupInfo (epoch 0, the founder alone), as a reader that
    /// verifies the group from its beginning does (8.4): the first Commit it then processes is judged as the
    /// founding Commit (5.2.5). `bad-commit` for another GroupInfo.
    pub fn follow_founding(group_info: &[u8]) -> Result<Self, Error> {
        let (provider, public, group, kind) = Self::start(group_info)?;
        let GroupKind::Session(session) = kind else {
            return Err(Error::BadCommit);
        };
        if public.group_context().epoch().as_u64() != 0 || public.members().count() != 1 {
            return Err(Error::BadCommit);
        }
        let record = SessionRecord {
            session,
            previous_room_epoch: 0,
            seats: Vec::new(),
        };
        Ok(Self::assemble(provider, group, Followed::Session(record)))
    }

    /// Reads an observer back from its entries. `Error::Storage` for anything that does not decode or fit.
    pub fn load(entries: Vec<Entry>) -> Result<Self, Error> {
        let mut mls = MlsEntries::new();
        let mut record = None;
        let mut states = Vec::new();
        for entry in &entries {
            match entry.key.split_first() {
                Some((&KEY_MLS, key)) => {
                    mls.insert(key.to_vec(), entry.value.clone());
                }
                Some((&KEY_RECORD, [])) => record = Some(entry.value.as_slice()),
                Some((&KEY_ROOM_STATE, _)) => {
                    let state: RoomState =
                        codec::decode(&entry.value, entry.value.len()).map_err(|_| damaged())?;
                    states.push(state);
                }
                _ => return Err(damaged()),
            }
        }
        provider::validate_entries(&mls)?;
        let mut record = Reader::new(record.ok_or_else(damaged)?);
        let group: GroupId = record.value().map_err(|_| damaged())?;
        let followed = if group.is_room() {
            states.sort_by_key(|state| state.epoch);
            let mut states = states.into_iter();
            let mut history = RoomHistory::new(states.next().ok_or_else(damaged)?);
            for state in states {
                history.record(state).map_err(|_| damaged())?;
            }
            Followed::Room(history)
        } else {
            let session: SessionRecord = record.value().map_err(|_| damaged())?;
            if session.session.group_id() != group || !states.is_empty() {
                return Err(damaged());
            }
            Followed::Session(session)
        };
        record.finish().map_err(|_| damaged())?;
        let observer = Self {
            provider: Provider::without_entropy(mls.clone())?,
            group,
            untaken_from: match &followed {
                Followed::Room(history) => history.newest().epoch.saturating_add(1),
                Followed::Session(_) => 0,
            },
            followed,
            taken: mls,
            record_changed: false,
        };
        // The public state must load and be the group and epoch the record names.
        let public = observer.public()?;
        let (stored_group, _) =
            profile::kind_of_context(public.group_context()).map_err(|_| damaged())?;
        let epoch = public.group_context().epoch().as_u64();
        let fits = match &observer.followed {
            Followed::Room(history) => history.newest().epoch == epoch,
            Followed::Session(_) => true,
        };
        if stored_group != group || !fits || epoch > profile::MAX_STORED_EPOCH {
            return Err(damaged());
        }
        Ok(observer)
    }

    /// A second follower of the same group in the same state: for a hub that stages a recovery, whose parts
    /// are checked against a copy of the public state while every other reader sees the state from before.
    pub fn fork(&self) -> Result<Self, Error> {
        Ok(Self {
            provider: Provider::without_entropy(self.provider.entries())?,
            group: self.group,
            followed: match &self.followed {
                Followed::Room(history) => Followed::Room(history.clone()),
                Followed::Session(record) => Followed::Session(record.clone()),
            },
            taken: self.taken.clone(),
            untaken_from: self.untaken_from,
            record_changed: self.record_changed,
        })
    }

    /// What changed since the last call, for the holder to store in one write.
    pub fn take_changes(&mut self) -> Result<Batch, Error> {
        let mut batch = Batch::new();
        let (put, delete) = self.provider.changes(&self.taken);
        for (key, value) in put {
            batch.put([&[KEY_MLS][..], &key].concat(), value);
        }
        for key in delete {
            batch.delete([&[KEY_MLS][..], &key].concat());
        }
        self.taken = self.provider.entries();
        if let Followed::Room(history) = &self.followed {
            for state in history
                .states()
                .filter(|state| state.epoch >= self.untaken_from)
            {
                let key = [&[KEY_ROOM_STATE][..], &state.epoch.to_be_bytes()].concat();
                batch.put(key, codec::encode(state)?);
            }
            self.untaken_from = history.newest().epoch.saturating_add(1);
        }
        if self.record_changed {
            let mut record = Writer::new();
            record.value(&self.group)?;
            if let Followed::Session(session) = &self.followed {
                record.value(session)?;
            }
            batch.put(vec![KEY_RECORD], record.into_bytes());
            self.record_changed = false;
        }
        Ok(batch)
    }

    /// The group followed.
    pub fn group(&self) -> GroupId {
        self.group
    }

    /// The group's epoch.
    pub fn epoch(&self) -> Result<u64, Error> {
        Ok(self.public()?.group_context().epoch().as_u64())
    }

    /// The group's GroupContext as it stands, in its TLS encoding. It carries the confirmed transcript hash,
    /// which chains every Commit since the founding.
    pub fn group_context(&self) -> Result<Vec<u8>, Error> {
        self.public()?
            .group_context()
            .tls_serialize_detached()
            .map_err(|_| Error::Internal("group context encoding"))
    }

    /// Puts what a walk from the group's founding verified before the state this observer started from in
    /// front of its own record: the room's roles of the earlier epochs, or a main session's agent leaf over
    /// that time. The caller has checked that the walk arrives at the state this observer started from.
    pub(crate) fn prepend(
        &mut self,
        earlier_room: Option<&RoomHistory>,
        earlier_seats: &[(u64, Option<DeviceId>)],
    ) -> Result<(), Error> {
        match &mut self.followed {
            Followed::Room(history) => {
                let earlier = earlier_room.ok_or(Error::Internal("room observer"))?;
                let mut whole = earlier.clone();
                for state in history
                    .states()
                    .filter(|state| state.epoch > earlier.newest().epoch)
                {
                    whole.record(state.clone())?;
                }
                *history = whole;
                self.untaken_from = 0;
            }
            Followed::Session(record) => {
                let mut seats = earlier_seats.to_vec();
                for change in record.seats.iter().skip(1) {
                    if seats.last().map(|(_, seat)| *seat) != Some(change.1) {
                        seats.push(*change);
                    }
                }
                record.seats = seats;
                self.record_changed = true;
            }
        }
        Ok(())
    }

    /// The devices of the group's leaves.
    pub fn leaves(&self) -> Result<BTreeSet<DeviceId>, Error> {
        let leaves = rules::leaves_of(self.public()?.members())?;
        Ok(leaves.into_iter().map(|(_, device)| device).collect())
    }

    /// The room's roles per epoch, if this observer follows the room group.
    pub fn history(&self) -> Option<&RoomHistory> {
        match &self.followed {
            Followed::Room(history) => Some(history),
            Followed::Session(_) => None,
        }
    }

    /// The session's extension, if this observer follows a session group.
    pub fn session(&self) -> Option<&TrommiSession> {
        match &self.followed {
            Followed::Room(_) => None,
            Followed::Session(record) => Some(&record.session),
        }
    }

    /// The `room_epoch` of a session group's last Commit.
    pub fn previous_room_epoch(&self) -> u64 {
        match &self.followed {
            Followed::Room(history) => history.newest().epoch,
            Followed::Session(record) => record.previous_room_epoch,
        }
    }

    /// A main session's agent leaf at the place `change` of the hub's order: what
    /// [`SessionFacts::main_session`] answers from this observer for a Commit that stands there;
    /// `u64::MAX` for the leaf as it stands.
    pub fn seat_at(&self, change: u64) -> Parent {
        match &self.followed {
            Followed::Session(record) if record.session.parent.is_zero() => {
                parent_at(&record.seats, change)
            }
            _ => Parent::NotAMainSession,
        }
    }

    /// A main session's agent leaf over time, as [`Observer::seat_at`] reads it.
    pub(crate) fn seats(&self) -> &[(u64, Option<DeviceId>)] {
        match &self.followed {
            Followed::Session(record) => &record.seats,
            Followed::Room(_) => &[],
        }
    }

    /// The leaves of a session group that `room` does not allow (5.2.8): not empty means stale.
    pub fn disallowed_leaves(
        &self,
        history: &RoomHistory,
        room: &RoomState,
        sessions: &dyn SessionFacts,
    ) -> Result<Vec<DeviceId>, Error> {
        let Followed::Session(record) = &self.followed else {
            return Ok(Vec::new());
        };
        let parent = parent_of(&record.session, sessions, room.epoch);
        Ok(rules::disallowed_leaves(
            history,
            room,
            &record.session,
            parent,
            &self.leaves()?,
        ))
    }

    /// Whether this session group is stale under `room`, and why (5.2.8).
    pub fn staleness(
        &self,
        history: &RoomHistory,
        room: &RoomState,
        sessions: &dyn SessionFacts,
    ) -> Result<rules::Staleness, Error> {
        let Followed::Session(record) = &self.followed else {
            return Ok(rules::Staleness::default());
        };
        let parent = parent_of(&record.session, sessions, room.epoch);
        Ok(rules::staleness(
            history,
            room,
            &record.session,
            parent,
            &self.leaves()?,
        ))
    }

    /// The hub's check of a Commit being posted (14.1), in one call: it parses and verifies against the public
    /// state, builds on the current epoch (`epoch-taken` otherwise), obeys sections 3 to 5 with the newest room
    /// epoch, comes with a GroupInfo signed by the committer whose group context, tree and confirmation tag are
    /// the observer's after the Commit, with a Welcome for every Add and with its `SealedKey`. On success the
    /// observer has followed the Commit; on any refusal it is unchanged.
    pub fn check_posted_commit(
        &mut self,
        posted: &PostedCommit<'_>,
        context: &Context<'_>,
    ) -> Result<CommitFacts, Error> {
        let parts = [
            posted.commit,
            posted.group_info,
            posted.welcome.unwrap_or_default(),
        ];
        let total = parts
            .iter()
            .try_fold(0usize, |sum, part| sum.checked_add(part.len()));
        if total.is_none_or(|total| total > MAX_COMMIT_REQUEST_LEN) {
            return Err(Error::TooLarge);
        }
        let base = posted
            .base_group_info
            .map(|base| crypto::ref_hash(recovery::GROUP_INFO_LABEL, base))
            .transpose()?;
        self.guarded(|observer| {
            let (facts, added) = observer.follow(
                posted.commit,
                posted.recovery_auth,
                context,
                Some(base.as_ref()),
                None,
            )?;
            // 8.4: the hub holds the GroupInfo a join from outside builds on, and the join names it.
            if facts.external && base.is_none() {
                return Err(Error::Incomplete);
            }
            observer.check_group_info(posted.group_info, &facts.committer)?;
            check_welcome(posted.welcome, &added)?;
            let claim = observer.sealed_key_claim(&facts, posted.group_info, context)?;
            context.recovery.verify_sealed_key(
                &SealedKeyClaim {
                    group: &facts.group,
                    epoch: facts.epoch.saturating_add(1),
                    group_info: posted.group_info,
                    room_epoch: claim.0,
                    recovery_hpke_key: &claim.1,
                    writer: &facts.committer,
                    writer_is_human: claim.2,
                },
                posted.sealed_key,
            )?;
            Ok(facts)
        })
    }

    /// Follows a Commit read from the hub's log, in the hub's order: it verifies against the public state and
    /// obeys sections 3 to 5. A session Commit must name the room epoch `context.room` stands in, which at
    /// its place in that order is the one that was current at the hub: one that names a newer epoch came too
    /// early (`room-behind`), one that names an older epoch is never taken (`bad-group`). On a refusal the
    /// observer is unchanged.
    pub fn process_commit(
        &mut self,
        commit: &[u8],
        recovery_auth: Option<&[u8]>,
        context: &Context<'_>,
    ) -> Result<CommitFacts, Error> {
        self.guarded(|observer| {
            observer
                .follow(commit, recovery_auth, context, None, None)
                .map(|(facts, _)| facts)
        })
    }

    /// As [`Observer::process_commit`], for a holder that knows the Commit's place in the hub's order:
    /// `place` names its change number, by which a main session's agent leaf is recorded over time, and
    /// the room epoch a session Commit is judged against (5.2.1): the one that was current at that place,
    /// for a holder whose record of the room reaches beyond it (one that replays a session's log, or is
    /// handed the log of a group it joined late).
    pub fn process_commit_at(
        &mut self,
        commit: &[u8],
        recovery_auth: Option<&[u8]>,
        context: &Context<'_>,
        place: &Place,
    ) -> Result<CommitFacts, Error> {
        self.guarded(|observer| {
            observer
                .follow(commit, recovery_auth, context, None, Some(place))
                .map(|(facts, _)| facts)
        })
    }

    /// Follows a Commit as MLS alone, without Trommi's rules: it verifies against the public state and is
    /// merged. For a reader that asks only whether a served history is the group's own, whatever the group
    /// did in it. The record beside the public state is not kept up. On a refusal the observer is unchanged.
    pub(crate) fn follow_unjudged(&mut self, commit: &[u8]) -> Result<(), Error> {
        self.guarded(|observer| {
            let message = rules::parse_commit(commit)?;
            let mut public = observer.public()?;
            let processed = public
                .process_message(observer.provider.crypto(), message)
                .map_err(|_| Error::BadCommit)?;
            let ProcessedMessageContent::StagedCommitMessage(staged) = processed.into_content()
            else {
                return Err(Error::BadCommit);
            };
            public
                .merge_commit(observer.provider.storage(), *staged)
                .map_err(mls_fault)
        })
    }

    /// Runs `step` and puts OpenMLS's entries and the record back when it fails.
    fn guarded<T>(&mut self, step: impl FnOnce(&mut Self) -> Result<T, Error>) -> Result<T, Error> {
        let entries = self.provider.entries();
        let followed = match &self.followed {
            Followed::Room(history) => Followed::Room(history.clone()),
            Followed::Session(record) => Followed::Session(record.clone()),
        };
        let result = step(self);
        if result.is_err() {
            self.provider.restore(entries);
            self.followed = followed;
        }
        result
    }

    /// Verifies, judges and merges one Commit. `posted` is given for a Commit being posted, with the hash of
    /// the GroupInfo held for the epoch it builds on. Returns its facts and the references of the KeyPackages
    /// it adds.
    fn follow(
        &mut self,
        commit: &[u8],
        recovery_auth: Option<&[u8]>,
        context: &Context<'_>,
        posted: Option<Option<&Hash32>>,
        place: Option<&Place>,
    ) -> Result<(CommitFacts, Vec<Vec<u8>>), Error> {
        let posting = posted.is_some();
        let message = rules::parse_commit(commit)?;
        let mut public = self.public()?;
        let epoch = public.group_context().epoch().as_u64();
        if GroupId::from_bytes(message.group_id().as_slice()) != Ok(self.group) {
            return Err(Error::BadCommit);
        }
        match message.epoch().as_u64() {
            named if named < epoch => return Err(Error::EpochTaken),
            named if named > epoch => return Err(Error::GroupBehind),
            _ => {}
        }
        let leaves = rules::leaves_of(public.members())?;
        let processed = public
            .process_message(self.provider.crypto(), message)
            .map_err(|_| Error::BadCommit)?;
        let ProcessedMessageContent::StagedCommitMessage(staged) = processed.content() else {
            return Err(Error::BadCommit);
        };
        let facts = rules::commit_facts(&self.group, &leaves, &processed, staged)?;
        let mut added = Vec::new();
        for queued in staged.queued_proposals() {
            if let Proposal::Add(add) = queued.proposal() {
                let reference = add
                    .key_package()
                    .hash_ref(self.provider.crypto())
                    .map_err(|_| Error::Internal("key package reference"))?;
                added.push(reference.as_slice().to_vec());
            }
        }
        let judged = Judged {
            facts: &facts,
            commit,
            recovery_auth,
            base_group_info: posted.flatten(),
        };
        let note_epoch = facts.note.as_ref().map_or(0, |note| note.room_epoch);
        match &self.followed {
            Followed::Room(history) => rules::check_room_commit(
                &Verifier {
                    history,
                    sessions: context.sessions,
                    recovery: context.recovery,
                    max_human_devices: context.max_human_devices,
                    room_epoch: history.newest().epoch,
                },
                &judged,
            )?,
            Followed::Session(record) => {
                // 5.2.1: the room epoch at the Commit's place is the one the room's history stands in:
                // the hub takes a post against its newest state, and a log is followed in the hub's order.
                // A holder whose history reaches further names the epoch itself.
                let history = context.room.ok_or(Error::RoomBehind)?;
                let verifier = Verifier {
                    history,
                    sessions: context.sessions,
                    recovery: context.recovery,
                    max_human_devices: context.max_human_devices,
                    room_epoch: match place.map(|place| place.room_epoch) {
                        None | Some(RoomEpochAt::Newest) => history.newest().epoch,
                        Some(RoomEpochAt::Epoch(epoch)) => epoch,
                        Some(RoomEpochAt::Named) => note_epoch,
                    },
                };
                let before = SessionBefore {
                    session: record.session,
                    leaves: leaves.iter().map(|(_, device)| *device).collect(),
                    previous_room_epoch: record.previous_room_epoch,
                };
                if posting {
                    rules::check_session_commit(&verifier, &before, &judged)?;
                } else {
                    rules::check_stored_session_commit(&verifier, &before, &judged)?;
                }
            }
        }
        let ProcessedMessageContent::StagedCommitMessage(staged) = processed.into_content() else {
            return Err(Error::BadCommit);
        };
        public
            .merge_commit(self.provider.storage(), *staged)
            .map_err(mls_fault)?;
        let leaves = rules::leaves_of(public.members())?;
        match &mut self.followed {
            Followed::Room(history) => {
                history.record(rules::room_state_of(public.group_context(), &leaves)?)?;
            }
            Followed::Session(record) => {
                record.previous_room_epoch = note_epoch;
                if record.session.parent.is_zero() {
                    let room = context
                        .room
                        .and_then(|history| history.at(note_epoch))
                        .ok_or(Error::RoomBehind)?;
                    let now = seat(&record.session, &leaves, room);
                    if record.seats.last().map(|(_, seat)| *seat) != Some(now) {
                        record
                            .seats
                            .push((place.map_or(0, |place| place.change), now));
                    }
                }
                self.record_changed = true;
            }
        }
        Ok((facts, added))
    }

    /// The room epoch, the recovery HPKE key and the writer's role that the `SealedKey` of a Commit must name
    /// (8.2), read after the Commit was followed.
    fn sealed_key_claim(
        &self,
        facts: &CommitFacts,
        _group_info: &[u8],
        context: &Context<'_>,
    ) -> Result<(u64, [u8; 32], bool), Error> {
        let note = facts.note.as_ref().ok_or(Error::BadCommit)?;
        let history = match &self.followed {
            Followed::Room(history) => history,
            Followed::Session(_) => context.room.ok_or(Error::RoomBehind)?,
        };
        let named = history.at(note.room_epoch).ok_or(Error::RoomBehind)?;
        if let ContextChange::To(GroupKind::Room(room)) = &facts.context {
            if room.recovery_hpke_key != named.room.recovery_hpke_key {
                // A room Commit that replaces the recovery keys seals its new epoch to the new key.
                return Ok((
                    note.room_epoch.saturating_add(1),
                    room.recovery_hpke_key,
                    true,
                ));
            }
        }
        let human = named.is_human(&facts.committer) || facts.group.is_room();
        Ok((note.room_epoch, named.room.recovery_hpke_key, human))
    }

    /// Whether `group_info` is the GroupInfo of the observer's present state, signed by `signer` (14.1, 8.5).
    /// `incomplete` otherwise.
    pub fn check_group_info(&self, group_info: &[u8], signer: &DeviceId) -> Result<(), Error> {
        if self.group_info_signer(group_info)? == *signer {
            Ok(())
        } else {
            Err(Error::Incomplete)
        }
    }

    /// The device that signed `group_info`, if it is a GroupInfo of the observer's present state
    /// (`signer_of`); `incomplete` otherwise.
    pub fn group_info_signer(&self, group_info: &[u8]) -> Result<DeviceId, Error> {
        signer_of(&self.public()?, group_info)
    }
}

/// The device that signed `group_info`, if it is a GroupInfo of the state `public`: its group context is byte
/// for byte that state's, its tree and confirmation tag are that state's, the leaf it names as its signer is a
/// leaf of that tree, and its signature verifies under that leaf's key. `incomplete` otherwise.
pub(crate) fn signer_of(public: &PublicGroup, group_info: &[u8]) -> Result<DeviceId, Error> {
    let verifiable = parse_group_info(group_info).map_err(|_| Error::Incomplete)?;
    let (their_tag, signer_index) =
        tag_and_signer_of(group_info, &verifiable).map_err(|_| Error::Incomplete)?;
    let signer = rules::leaves_of(public.members())?
        .into_iter()
        .find(|(index, _)| index.u32() == signer_index)
        .map(|(_, device)| device)
        .ok_or(Error::Incomplete)?;
    let key = OpenMlsSignaturePublicKey::from_signature_key(
        signer.as_bytes().to_vec().into(),
        SignatureScheme::ED25519,
    );
    let encoded = |value: &dyn Fn() -> Result<Vec<u8>, tls_codec::Error>| {
        value().map_err(|_| Error::Internal("group info encoding"))
    };
    let own_tree = encoded(&|| public.export_ratchet_tree().tls_serialize_detached())?;
    let their_tree = verifiable
        .extensions()
        .ratchet_tree()
        .map(|extension| extension.ratchet_tree().tls_serialize_detached());
    let own_tag = encoded(&|| public.confirmation_tag().tls_serialize_detached())?;
    let fits = verifiable.group_context() == public.group_context()
        && verifiable.extensions().external_pub().is_some()
        && their_tree.is_some_and(|tree| tree.ok() == Some(own_tree))
        && codec::encode(&codec::Opaque(their_tag)).ok() == Some(own_tag)
        && verifiable
            .verify_no_out(crypto::rust_crypto()?, &key)
            .is_ok();
    if fits {
        Ok(signer)
    } else {
        Err(Error::Incomplete)
    }
}

/// Reads a Commit against a group's public state without following it: OpenMLS verifies it there as it does
/// for any observer, and the result is described as for every verifier. `public` are the entries of
/// [`provider::public_entries`]. For a device that judges its own Commit, from the bytes it will post, by the
/// rules a receiver applies. Returns the facts, the group's leaves before the Commit, and the group context
/// the Commit leads to, as a follower of the public state computes it: a member that merges its own staged
/// copy of the Commit must arrive at the same.
pub(crate) fn read_commit(
    public: MlsEntries,
    group: &GroupId,
    commit: &[u8],
) -> Result<(CommitFacts, BTreeSet<DeviceId>, Vec<u8>), Error> {
    provider::validate_entries(&public)?;
    let provider = Provider::without_entropy(public)?;
    let id = openmls::prelude::GroupId::from_slice(group.as_bytes());
    let mut held = PublicGroup::load(provider.storage(), &id)
        .map_err(mls_fault)?
        .ok_or_else(damaged)?;
    let message = rules::parse_commit(commit)?;
    let leaves = rules::leaves_of(held.members())?;
    let processed = held
        .process_message(provider.crypto(), message)
        .map_err(|_| Error::BadCommit)?;
    let ProcessedMessageContent::StagedCommitMessage(staged) = processed.content() else {
        return Err(Error::BadCommit);
    };
    let facts = rules::commit_facts(group, &leaves, &processed, staged)?;
    let ProcessedMessageContent::StagedCommitMessage(staged) = processed.into_content() else {
        return Err(Error::BadCommit);
    };
    held.merge_commit(provider.storage(), *staged)
        .map_err(mls_fault)?;
    let after = held
        .group_context()
        .tls_serialize_detached()
        .map_err(|_| Error::Internal("group context encoding"))?;
    let leaves = leaves.into_iter().map(|(_, device)| device).collect();
    Ok((facts, leaves, after))
}

/// A main session's agent leaf under `room`: its leaf that is not a human device. A group with several has no
/// agent leaf the rules would name.
pub(crate) fn seat(
    session: &TrommiSession,
    leaves: &[(LeafNodeIndex, DeviceId)],
    room: &RoomState,
) -> Option<DeviceId> {
    if !session.parent.is_zero() {
        return None;
    }
    let mut others = leaves
        .iter()
        .map(|(_, device)| *device)
        .filter(|device| !room.is_human(device));
    let first = others.next();
    first.filter(|_| others.next().is_none())
}

/// A main session at the place `change` of the hub's order, from its agent leaf over time: the leaf after
/// the last of its Commits that does not stand behind that place. Before the first of them the session
/// did not exist: no main session has that id there.
pub(crate) fn parent_at(seats: &[(u64, Option<DeviceId>)], change: u64) -> Parent {
    seats
        .iter()
        .rev()
        .find(|(since, _)| *since <= change)
        .map_or(Parent::NotAMainSession, |(_, seat)| Parent::Seat(*seat))
}

fn parent_of(session: &TrommiSession, sessions: &dyn SessionFacts, room_epoch: u64) -> Parent {
    if session.parent.is_zero() {
        Parent::NotAMainSession
    } else {
        sessions.main_session(&session.parent, room_epoch)
    }
}

/// A Welcome must be present exactly when the Commit adds, and name every KeyPackage it adds (14.1).
fn check_welcome(welcome: Option<&[u8]>, added: &[Vec<u8>]) -> Result<(), Error> {
    let Some(bytes) = welcome else {
        return if added.is_empty() {
            Ok(())
        } else {
            Err(Error::Incomplete)
        };
    };
    let welcome = match MlsMessageIn::tls_deserialize_exact(bytes).map(MlsMessageIn::extract) {
        Ok(MlsMessageBodyIn::Welcome(welcome)) => welcome,
        _ => return Err(Error::Incomplete),
    };
    let named: BTreeSet<Vec<u8>> = welcome
        .secrets()
        .iter()
        .map(|secrets| secrets.new_member().as_slice().to_vec())
        .collect();
    let every_add = added.iter().all(|reference| named.contains(reference));
    if every_add && named.len() == added.len() && !added.is_empty() {
        Ok(())
    } else {
        Err(Error::Incomplete)
    }
}

/// An answer to [`SessionFacts`] for a verifier that follows no other session. It knows no main session, and
/// so judges no Commit of a helper session (`room-behind`).
#[derive(Debug, Clone, Copy, Default)]
pub struct NoSessions;

impl SessionFacts for NoSessions {
    fn main_session(&self, _: &SessionId, _: u64) -> Parent {
        Parent::Unknown
    }

    fn main_session_of(&self, _: &DeviceId) -> Option<SessionId> {
        None
    }

    fn live_helpers(&self, _: &SessionId) -> usize {
        0
    }
}
