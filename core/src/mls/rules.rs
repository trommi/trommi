//! Trommi's rules for Commits (sections 3.3, 3.4, 4 and 5), as pure checks. A member before it merges, an
//! observer before it follows and the hub before it accepts all describe a Commit by the same [`CommitFacts`]
//! and judge it with the same functions, against the state of the group before it and the room's role history.
//!
//! A role is never claimed (4.1): a human device is a leaf of the room group, an agent device a key in
//! `TrommiRoom.agents`, a revoked key one that was either and no longer is. [`RoomHistory`] holds these sets per
//! room epoch, so that a session Commit is judged against the room state it names and never a later one.

use crate::codec::{self, Decode, Encode, Reader, Writer};
use crate::error::Error;
use crate::ids::{DeviceId, GroupId, Hash32, SessionId};
use crate::mls::key_package;
use crate::mls::profile::{
    self, CommitNote, GroupKind, TrommiRoom, TrommiSession, MAX_AGENT_DEVICES,
    MAX_COMMIT_REQUEST_LEN, MAX_HELPER_DEVICES, MAX_HUMAN_DEVICES, MAX_LIVE_HELPERS, MAX_NOTE_LEN,
    RECOVERY_KEY_LEN,
};
use openmls::group::{PublicGroup, StagedCommit};
use openmls::prelude::{
    ContentType, GroupContext, LeafNodeIndex, Member, MlsMessageIn, ProcessedMessage, Proposal,
    ProposalOrRefType, ProtocolMessage, Sender,
};
use std::collections::{BTreeMap, BTreeSet};
use tls_codec::Deserialize as _;

/// The room group at one epoch: who is a human device, who an agent device, and the recovery keys.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomState {
    /// The room group's epoch.
    pub epoch: u64,
    /// `RefHash("Trommi Room State", GroupContext)` at that epoch.
    pub state: Hash32,
    /// `H`: the leaves of the room group.
    pub humans: BTreeSet<DeviceId>,
    /// The room's extension: `A` and the recovery public keys.
    pub room: TrommiRoom,
}

impl RoomState {
    /// Whether `device` is a human device at this epoch.
    pub fn is_human(&self, device: &DeviceId) -> bool {
        self.humans.contains(device)
    }

    /// Whether `device` is an enrolled agent device at this epoch.
    pub fn is_agent(&self, device: &DeviceId) -> bool {
        self.room.agents.binary_search(device).is_ok()
    }
}

impl Encode for RoomState {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.u64(self.epoch);
        writer.value(&self.state)?;
        let humans: Vec<DeviceId> = self.humans.iter().copied().collect();
        writer.vector(&humans)?;
        writer.value(&self.room)
    }
}

impl Decode for RoomState {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        let epoch = reader.u64()?;
        let state = reader.value()?;
        let listed: Vec<DeviceId> = reader.vector()?;
        let humans: BTreeSet<DeviceId> = listed.iter().copied().collect();
        if humans.len() != listed.len() {
            return Err(Error::BadFormat);
        }
        Ok(Self {
            epoch,
            state,
            humans,
            room: reader.value()?,
        })
    }
}

/// The room's roles per epoch, from the first epoch its holder saw. The hub holds the whole history; a device
/// what it processed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomHistory {
    states: BTreeMap<u64, RoomState>,
    /// Every revoked key, with the first epoch in which it was neither a human nor an agent device.
    revoked: BTreeMap<DeviceId, u64>,
    /// Every recovery key, signature or HPKE, a recorded state held.
    recovery_keys: BTreeSet<[u8; RECOVERY_KEY_LEN]>,
    newest: u64,
}

impl RoomHistory {
    /// A history that starts with `first`.
    pub fn new(first: RoomState) -> Self {
        let mut history = Self {
            states: BTreeMap::new(),
            revoked: BTreeMap::new(),
            recovery_keys: BTreeSet::new(),
            newest: first.epoch,
        };
        history.insert(first);
        history
    }

    fn insert(&mut self, state: RoomState) {
        self.recovery_keys.insert(state.room.recovery_signature_key);
        self.recovery_keys.insert(state.room.recovery_hpke_key);
        self.newest = state.epoch;
        self.states.insert(state.epoch, state);
    }

    /// Adds the state that follows the newest one. Whoever was a human or agent device before and is neither
    /// now is revoked from this epoch on.
    pub fn record(&mut self, next: RoomState) -> Result<(), Error> {
        let before = self.newest();
        if before.epoch.checked_add(1) != Some(next.epoch) {
            return Err(Error::Internal("room history out of order"));
        }
        let gone: Vec<DeviceId> = before
            .humans
            .iter()
            .chain(before.room.agents.iter())
            .filter(|device| !next.is_human(device) && !next.is_agent(device))
            .copied()
            .collect();
        for device in gone {
            self.revoked.entry(device).or_insert(next.epoch);
        }
        self.insert(next);
        Ok(())
    }

    /// The newest state.
    pub fn newest(&self) -> &RoomState {
        // `states` always holds `newest`: both are set together.
        self.states
            .get(&self.newest)
            .or_else(|| self.states.values().next_back())
            .unwrap_or(&EMPTY_STATE)
    }

    /// The state at `epoch`, if this history holds it.
    pub fn at(&self, epoch: u64) -> Option<&RoomState> {
        self.states.get(&epoch)
    }

    /// Every state held, ascending by epoch.
    pub fn states(&self) -> impl Iterator<Item = &RoomState> {
        self.states.values()
    }

    /// Whether `device` was revoked at or before `epoch`.
    pub fn is_revoked(&self, device: &DeviceId, epoch: u64) -> bool {
        self.revoked
            .get(device)
            .is_some_and(|since| *since <= epoch)
    }

    /// Whether a state of this history held `key` as a recovery key.
    pub fn held_recovery_key(&self, key: &[u8; RECOVERY_KEY_LEN]) -> bool {
        self.recovery_keys.contains(key)
    }
}

static EMPTY_STATE: RoomState = RoomState {
    epoch: 0,
    state: Hash32::ZERO,
    humans: BTreeSet::new(),
    room: TrommiRoom {
        recovery_signature_key: [0; RECOVERY_KEY_LEN],
        recovery_hpke_key: [0; RECOVERY_KEY_LEN],
        agents: Vec::new(),
    },
};

/// What a GroupContextExtensions proposal in a Commit sets the context's extensions to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContextChange {
    /// The Commit holds no such proposal.
    None,
    /// The new list is the profile's, of this kind.
    To(GroupKind),
    /// The new list is not one the profile allows.
    Malformed,
}

/// One Commit, described once for every verifier.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitFacts {
    /// The group.
    pub group: GroupId,
    /// The epoch the Commit builds on.
    pub epoch: u64,
    /// The committer: a leaf's device, or for a Commit from outside the device of the leaf it brings.
    pub committer: DeviceId,
    /// Whether the Commit comes from outside the group (an external commit).
    pub external: bool,
    /// The devices of the KeyPackages it adds.
    pub adds: Vec<DeviceId>,
    /// The devices of the leaves it removes.
    pub removes: Vec<DeviceId>,
    /// Its GroupContextExtensions proposal.
    pub context: ContextChange,
    /// Whether it has an update path.
    pub has_path: bool,
    /// How many ExternalInit proposals it holds.
    pub external_inits: usize,
    /// Whether it holds anything the profile refuses: a proposal by reference or of another sender, an Update,
    /// PreSharedKey or ReInit proposal, a proposal type the profile does not know; or a new leaf (added, or the
    /// committer's own in the path) that is not the profile's: another credential than its signature key,
    /// other capabilities, a path leaf under another key than the committer's.
    pub forbidden: bool,
    /// Its `authenticated_data` as a [`CommitNote`]; none when it does not decode.
    pub note: Option<CommitNote>,
    /// Whether the note names a version above this build's: `note` is none then, and the Commit is refused as
    /// `newer-version`, not as `bad-commit`.
    pub newer_version: bool,
}

/// A main session as a verifier of a helper session's Commit sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Parent {
    /// The verifier does not follow that session, and so does not know its agent leaf. This grants nothing:
    /// no device is taken for the opener, and a Commit of the helper session is not judged (`room-behind`:
    /// the verifier processes the main session first, as a leaf of it or as an observer).
    Unknown,
    /// No live main session of this room has that id.
    NotAMainSession,
    /// A live main session, with its agent leaf; none while it waits for a takeover.
    Seat(Option<DeviceId>),
}

/// What a verifier knows of the room's other sessions.
pub trait SessionFacts {
    /// The main session `session` at the place of a Commit naming `room_epoch`: its agent leaf after the last of
    /// its Commits whose `room_epoch` is not above that one. A verifier that processes the hub's order holds
    /// no later Commit of it at that place, so this is the main session's state there (5.2.1).
    fn main_session(&self, session: &SessionId, room_epoch: u64) -> Parent;

    /// The live main session whose agent leaf `agent` is now, if the verifier knows one.
    fn main_session_of(&self, agent: &DeviceId) -> Option<SessionId>;

    /// How many live helper sessions hang under `parent`, as far as the verifier knows.
    fn live_helpers(&self, parent: &SessionId) -> usize;
}

/// A join from outside as section 8.4 authorises it: what a [`RecoveryRules`] checks the attachment against.
#[derive(Debug, Clone, Copy)]
pub struct JoinClaim<'a> {
    /// The group joined.
    pub group: &'a GroupId,
    /// The epoch the Commit builds on.
    pub epoch: u64,
    /// The device of the Commit's new leaf.
    pub joiner: &'a DeviceId,
    /// The Commit's note.
    pub note: &'a CommitNote,
    /// The Commit as posted.
    pub commit: &'a [u8],
    /// The hash of the GroupInfo posted for the epoch the Commit builds on, for a verifier that holds that
    /// GroupInfo: the hub. A member holds none.
    pub base_group_info: Option<&'a Hash32>,
    /// The `recovery_signature_key` of the room state at the note's `room_epoch`.
    pub recovery_signature_key: &'a [u8; RECOVERY_KEY_LEN],
    /// The `RecoveryAuth` that came with the Commit, if any.
    pub recovery_auth: Option<&'a [u8]>,
}

/// What the `SealedKey` that comes with a Commit or a founding must be for (8.2).
#[derive(Debug, Clone, Copy)]
pub struct SealedKeyClaim<'a> {
    /// The group.
    pub group: &'a GroupId,
    /// The epoch whose content key is sealed.
    pub epoch: u64,
    /// The GroupInfo posted for that epoch.
    pub group_info: &'a [u8],
    /// The room epoch the row must name.
    pub room_epoch: u64,
    /// The key it must be sealed to: the room's `recovery_hpke_key` at that room epoch.
    pub recovery_hpke_key: &'a [u8; RECOVERY_KEY_LEN],
    /// The committer or founder: the row's writer.
    pub writer: &'a DeviceId,
    /// Whether the writer is a human device, whose row carries a `mac`.
    pub writer_is_human: bool,
}

/// The public checks of the recovery construct (section 8) that members, observers and the hub run on a Commit.
/// The rules of the groups call them and know nothing of the construct's bytes.
pub trait RecoveryRules {
    /// Whether the join is authorised by its `RecoveryAuth` (8.4); `bad-commit` or `bad-signature` otherwise.
    fn verify_join(&self, claim: &JoinClaim<'_>) -> Result<(), Error>;

    /// Whether `sealed_key` is a `SealedKey` for the claim (8.2); `incomplete` otherwise.
    fn verify_sealed_key(&self, claim: &SealedKeyClaim<'_>, sealed_key: &[u8])
        -> Result<(), Error>;
}

/// A verifier without the recovery construct: it refuses every join from outside (`bad-commit`) and every
/// `SealedKey` (`incomplete`), because it can check neither. Whatever needs a join or a Commit taken carries the
/// construct's own checks.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoRecovery;

impl RecoveryRules for NoRecovery {
    fn verify_join(&self, _: &JoinClaim<'_>) -> Result<(), Error> {
        Err(Error::BadCommit)
    }

    fn verify_sealed_key(&self, _: &SealedKeyClaim<'_>, _: &[u8]) -> Result<(), Error> {
        Err(Error::Incomplete)
    }
}

/// Everything a Commit is judged against besides the state of its own group.
#[derive(Clone, Copy)]
pub struct Verifier<'a> {
    /// The room's roles per epoch.
    pub history: &'a RoomHistory,
    /// The room's other sessions.
    pub sessions: &'a dyn SessionFacts,
    /// The recovery construct's checks.
    pub recovery: &'a dyn RecoveryRules,
    /// The most human devices the room may hold after the Commit: the limit of section 16, or one more while
    /// a recovery runs. A verifier that cannot know whether one runs (a device) gives the larger. Above the
    /// limit the rules take only what a recovery does, whatever is given here: a join from outside, and in a
    /// room that holds more than the limit a Commit that adds nobody.
    pub max_human_devices: usize,
    /// The room epoch that was current at the Commit's place in the hub's order (5.2.1, 5.4.1): a session
    /// Commit names exactly this one. For the hub that takes a post, and for whoever processes the log in the
    /// hub's order, it is the newest epoch of `history`. A device that is handed an entry behind its cursor
    /// (the log of a group it joined late) gives the epoch its room group stood in at that entry's change
    /// number.
    pub room_epoch: u64,
}

/// A Commit with what was posted beside it.
#[derive(Debug, Clone, Copy)]
pub struct Judged<'a> {
    /// What the Commit does.
    pub facts: &'a CommitFacts,
    /// The Commit as posted.
    pub commit: &'a [u8],
    /// The `RecoveryAuth` posted with it, if any.
    pub recovery_auth: Option<&'a [u8]>,
    /// The hash of the GroupInfo posted for the epoch it builds on, where the verifier holds it.
    pub base_group_info: Option<&'a Hash32>,
}

/// A session group before a Commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionBefore {
    /// Its extension.
    pub session: TrommiSession,
    /// Its leaves.
    pub leaves: BTreeSet<DeviceId>,
    /// The `room_epoch` of its previous Commit; 0 before the first. A member that joined later takes the room
    /// epoch at the place of the Commit that added it, once the log showed it that Commit.
    pub previous_room_epoch: u64,
}

fn refuse(condition: bool, error: Error) -> Result<(), Error> {
    if condition {
        Err(error)
    } else {
        Ok(())
    }
}

/// The checks every Commit of every group passes: the proposal whitelist, the note, the shape of 3.4, the Cuts.
/// A note of a newer version is `newer-version`.
fn check_shape(facts: &CommitFacts) -> Result<&CommitNote, Error> {
    // A newer version may hold what this build takes for forbidden: it is named first.
    refuse(facts.newer_version, Error::NewerVersion)?;
    refuse(facts.forbidden, Error::BadCommit)?;
    let note = facts.note.as_ref().ok_or(Error::BadCommit)?;
    refuse(note.join != facts.external, Error::BadCommit)?;
    if facts.external {
        // 3.4: exactly one ExternalInit, at most one Remove (the joiner's own old leaf), a path, nothing else.
        let own_old_leaf = facts.removes.iter().all(|gone| *gone == facts.committer);
        refuse(
            facts.external_inits != 1
                || facts.removes.len() > 1
                || !own_old_leaf
                || !facts.adds.is_empty()
                || facts.context != ContextChange::None
                || !facts.has_path,
            Error::BadCommit,
        )?;
    } else {
        refuse(facts.external_inits != 0, Error::BadCommit)?;
        // A Commit without a path holds only Adds, and at least one.
        let only_adds = !facts.adds.is_empty()
            && facts.removes.is_empty()
            && facts.context == ContextChange::None;
        refuse(!facts.has_path && !only_adds, Error::BadCommit)?;
    }
    let removed: BTreeSet<DeviceId> = facts.removes.iter().copied().collect();
    refuse(removed.len() != facts.removes.len(), Error::BadCommit)?;
    let cut: Vec<DeviceId> = note.cuts.iter().map(|cut| cut.device).collect();
    refuse(!removed.iter().eq(cut.iter()), Error::BadCommit)?;
    let added: BTreeSet<DeviceId> = facts.adds.iter().copied().collect();
    refuse(added.len() != facts.adds.len(), Error::BadCommit)?;
    Ok(note)
}

/// Judges a Commit of the room group (5.1) against the newest state of `verifier.history`, which must be the
/// state it builds on.
pub fn check_room_commit(verifier: &Verifier<'_>, judged: &Judged<'_>) -> Result<(), Error> {
    let facts = judged.facts;
    let history = verifier.history;
    let before = history.newest();
    refuse(
        !facts.group.is_room() || facts.epoch != before.epoch,
        Error::Internal("room commit against another state"),
    )?;
    let note = check_shape(facts)?;
    refuse(
        note.room_epoch != before.epoch || note.room_state != before.state,
        Error::BadCommit,
    )?;
    let revoked = |device: &DeviceId| history.is_revoked(device, before.epoch);

    let mut humans = before.humans.clone();
    for gone in &facts.removes {
        refuse(!humans.remove(gone), Error::BadCommit)?;
    }
    if facts.external {
        // 5.1.4: the one Commit from a non-member is the join with the code.
        refuse(
            revoked(&facts.committer) || before.is_agent(&facts.committer),
            Error::BadCommit,
        )?;
        verifier.recovery.verify_join(&JoinClaim {
            group: &facts.group,
            epoch: facts.epoch,
            joiner: &facts.committer,
            note,
            commit: judged.commit,
            base_group_info: judged.base_group_info,
            recovery_signature_key: &before.room.recovery_signature_key,
            recovery_auth: judged.recovery_auth,
        })?;
        refuse(!humans.insert(facts.committer), Error::BadCommit)?;
    } else {
        // 5.1.2: only a human device commits; agent and helper devices are no leaves here.
        refuse(!before.is_human(&facts.committer), Error::BadCommit)?;
        refuse(judged.recovery_auth.is_some(), Error::BadCommit)?;
    }
    refuse(facts.adds.len() > 1, Error::BadCommit)?;
    for added in &facts.adds {
        // 4.2: a revoked key never returns, and no key is both a human and an agent device. 3.7: nor does
        // the key of a leaf that this same Commit removes; into the room group there is no second try.
        let removed_here = facts.removes.contains(added);
        refuse(
            revoked(added) || removed_here || !humans.insert(*added),
            Error::BadCommit,
        )?;
    }

    let room = match &facts.context {
        ContextChange::None => &before.room,
        ContextChange::To(GroupKind::Room(room)) => room,
        ContextChange::To(GroupKind::Session(_)) | ContextChange::Malformed => {
            return Err(Error::BadCommit)
        }
    };
    refuse(room.agents.len() > MAX_AGENT_DEVICES, Error::TooMany)?;
    for agent in &room.agents {
        let enrolled_now = !before.is_agent(agent);
        refuse(enrolled_now && revoked(agent), Error::BadCommit)?;
        refuse(humans.contains(agent), Error::BadCommit)?;
    }
    for gone in &facts.removes {
        refuse(room.agents.binary_search(gone).is_ok(), Error::BadCommit)?;
    }
    // 8.1, 8.6: the two recovery keys change together, to keys the room never held, and are no device's key.
    let signature_changed = room.recovery_signature_key != before.room.recovery_signature_key;
    let hpke_changed = room.recovery_hpke_key != before.room.recovery_hpke_key;
    refuse(signature_changed != hpke_changed, Error::BadCommit)?;
    let keys = [room.recovery_signature_key, room.recovery_hpke_key];
    if signature_changed {
        refuse(
            keys.iter().any(|key| history.held_recovery_key(key))
                || room.recovery_signature_key == room.recovery_hpke_key,
            Error::BadCommit,
        )?;
    }
    for key in keys {
        let as_device = DeviceId::new(key);
        refuse(
            humans.contains(&as_device) || room.agents.binary_search(&as_device).is_ok(),
            Error::BadCommit,
        )?;
    }
    // Section 16, 8.7: the limit of human devices. The one beyond it comes only by a join from outside, and a
    // room that holds one more takes on only Commits that add nobody, so that the recovery's removal passes.
    // Whether a recovery runs is the hub's to know: it sets the most to the limit outside one, and then no
    // join makes a device beyond it.
    let recovering =
        facts.external || (before.humans.len() > MAX_HUMAN_DEVICES && facts.adds.is_empty());
    let most = if recovering {
        verifier.max_human_devices
    } else {
        verifier.max_human_devices.min(MAX_HUMAN_DEVICES)
    };
    refuse(humans.len() > most, Error::TooMany)
}

/// What a session group's leaves are judged against: the room state its Commit names, and the main session a
/// helper session hangs under.
struct Allowed<'a> {
    history: &'a RoomHistory,
    room: &'a RoomState,
    session: &'a TrommiSession,
    parent: Parent,
}

impl Allowed<'_> {
    fn is_helper_session(&self) -> bool {
        !self.session.parent.is_zero()
    }

    /// The opener of a helper session: the main session's agent leaf, as the verifier knows it. A verifier
    /// that does not know the main session takes no device for the opener.
    fn is_opener(&self, device: &DeviceId) -> bool {
        match self.parent {
            Parent::Seat(seat) => seat == Some(*device) && self.room.is_agent(device),
            Parent::Unknown | Parent::NotAMainSession => false,
        }
    }

    /// Whether `device` may be a leaf: a human device; in a main session an agent device; in a helper session
    /// its opener, or a helper device, which never was a human or agent device.
    fn allows(&self, device: &DeviceId) -> bool {
        if self.room.is_human(device) {
            return true;
        }
        if self.history.is_revoked(device, self.room.epoch) {
            return false;
        }
        if self.is_helper_session() {
            self.is_opener(device) || !self.room.is_agent(device)
        } else {
            self.room.is_agent(device)
        }
    }

    /// The leaves that are neither human devices nor the opener.
    fn others<'s>(&'s self, leaves: &'s BTreeSet<DeviceId>) -> impl Iterator<Item = &'s DeviceId> {
        leaves
            .iter()
            .filter(|leaf| !self.room.is_human(leaf))
            .filter(|leaf| !(self.is_helper_session() && self.is_opener(leaf)))
    }
}

/// The leaves of a session group that the room state does not allow (5.2.8): a group with one is stale
/// ([`staleness`] is the whole predicate). For a helper session `parent` is its main session at that place.
pub fn disallowed_leaves(
    history: &RoomHistory,
    room: &RoomState,
    session: &TrommiSession,
    parent: Parent,
    leaves: &BTreeSet<DeviceId>,
) -> Vec<DeviceId> {
    let allowed = Allowed {
        history,
        room,
        session,
        parent,
    };
    let mut unfit: Vec<DeviceId> = leaves
        .iter()
        .filter(|leaf| !allowed.allows(leaf))
        .copied()
        .collect();
    if !allowed.is_helper_session() {
        // 5.2.2: one agent device at most; of several, none is allowed until one is left. A leaf that is
        // unfit by itself, such as a removed human device, does not count as one.
        let agents: Vec<DeviceId> = allowed
            .others(leaves)
            .filter(|leaf| allowed.allows(leaf))
            .copied()
            .collect();
        if agents.len() > 1 {
            unfit.extend(agents);
            unfit.sort_unstable();
        }
    }
    unfit
}

/// Why a session group is stale (5.2.8): nobody writes into it, and it takes nothing but a join by 8.4 and
/// the Commit that removes the leaves named here and adds the opener named here.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Staleness {
    /// The leaves the room state does not allow, ascending.
    pub disallowed: Vec<DeviceId>,
    /// The opener a helper session lacks: its main session's agent leaf, an agent device of the room, that
    /// is no leaf of the helper session. None for a main session, and while the main session has no agent
    /// leaf (5.2.3, 5.3.3): the helper session then waits without an opener and is not stale for that.
    pub missing_opener: Option<DeviceId>,
}

impl Staleness {
    /// Whether the group is stale.
    pub fn is_stale(&self) -> bool {
        !self.disallowed.is_empty() || self.missing_opener.is_some()
    }
}

/// Whether a session group with these leaves is stale under `room`, and why (5.2.8). The one predicate of
/// the hub, of every member and of every observer. For a helper session `parent` is its main session at that
/// place.
pub fn staleness(
    history: &RoomHistory,
    room: &RoomState,
    session: &TrommiSession,
    parent: Parent,
    leaves: &BTreeSet<DeviceId>,
) -> Staleness {
    let missing_opener = match parent {
        Parent::Seat(Some(seat)) if !session.parent.is_zero() => {
            Some(seat).filter(|seat| room.is_agent(seat) && !leaves.contains(seat))
        }
        _ => None,
    };
    Staleness {
        disallowed: disallowed_leaves(history, room, session, parent, leaves),
        missing_opener,
    }
}

/// The helper devices among a helper session's leaves (5.2.3): those that are neither human devices nor the
/// opener. `parent` is its main session at that place. None for a main session.
pub fn helper_devices(
    history: &RoomHistory,
    room: &RoomState,
    session: &TrommiSession,
    parent: Parent,
    leaves: &BTreeSet<DeviceId>,
) -> Vec<DeviceId> {
    let allowed = Allowed {
        history,
        room,
        session,
        parent,
    };
    if !allowed.is_helper_session() {
        return Vec::new();
    }
    allowed.others(leaves).copied().collect()
}

/// Judges a Commit of a session group (5.2, 5.3) against the group before it and the room state at its place
/// in the hub's order, which it must name (`room-behind` otherwise, whether it names an older or a newer one).
pub fn check_session_commit(
    verifier: &Verifier<'_>,
    before: &SessionBefore,
    judged: &Judged<'_>,
) -> Result<(), Error> {
    let facts = judged.facts;
    let history = verifier.history;
    let session = &before.session;
    refuse(
        facts.group != session.group_id(),
        Error::Internal("session commit against another group"),
    )?;
    let note = check_shape(facts)?;
    // A session group's extension never changes.
    refuse(facts.context != ContextChange::None, Error::BadCommit)?;

    // 5.2.1: the Commit names the room epoch that was current at its place in the hub's order, neither an
    // older one nor one the verifier has not reached; that epoch's state is the one named, and it is not
    // below the one the group's previous Commit named.
    refuse(
        note.room_epoch != verifier.room_epoch || note.room_epoch < before.previous_room_epoch,
        Error::RoomBehind,
    )?;
    let room = history.at(note.room_epoch).ok_or(Error::RoomBehind)?;
    refuse(
        room.state != note.room_state || session.room_id != facts.group.room_id(),
        Error::BadCommit,
    )?;

    let helper = !session.parent.is_zero();
    let parent = if helper {
        verifier
            .sessions
            .main_session(&session.parent, note.room_epoch)
    } else {
        Parent::NotAMainSession
    };
    refuse(
        helper && parent == Parent::NotAMainSession,
        Error::BadCommit,
    )?;
    // 5.2.3: who the opener is follows from the main session's state at this place. A verifier that does not
    // know it judges nothing of the helper session until it does.
    refuse(parent == Parent::Unknown, Error::RoomBehind)?;
    let allowed = Allowed {
        history,
        room,
        session,
        parent,
    };
    let founding = facts.epoch == 0;
    let committer = &facts.committer;
    let by_human = room.is_human(committer);
    let by_opener = helper && !by_human && allowed.is_opener(committer);

    let mut leaves = before.leaves.clone();
    for gone in &facts.removes {
        refuse(!leaves.remove(gone), Error::BadCommit)?;
    }
    if facts.external {
        // 5.2.7, 8.4: a join from outside needs the recovery signature and a joiner in H(r).
        refuse(!by_human || founding, Error::BadCommit)?;
        verifier.recovery.verify_join(&JoinClaim {
            group: &facts.group,
            epoch: facts.epoch,
            joiner: committer,
            note,
            commit: judged.commit,
            base_group_info: judged.base_group_info,
            recovery_signature_key: &room.room.recovery_signature_key,
            recovery_auth: judged.recovery_auth,
        })?;
        refuse(!leaves.insert(*committer), Error::BadCommit)?;
    } else {
        refuse(judged.recovery_auth.is_some(), Error::BadCommit)?;
        refuse(!before.leaves.contains(committer), Error::BadCommit)?;
        // 5.2.2, 5.2.3: a human device in H(r) commits; in a helper session also its opener.
        refuse(!by_human && !by_opener, Error::BadCommit)?;
    }

    for added in &facts.adds {
        let human = room.is_human(added);
        let fits = if by_opener {
            // 5.2.4: the opener adds devices that are not human devices; in the founding Commit also H(r).
            let helper_device =
                !human && !room.is_agent(added) && !history.is_revoked(added, room.epoch);
            helper_device || (founding && human)
        } else if helper {
            // A human device adds human devices, and after a takeover the main session's agent leaf.
            human || allowed.is_opener(added)
        } else {
            human || allowed.allows(added)
        };
        refuse(!fits || !leaves.insert(*added), Error::BadCommit)?;
    }
    for gone in &facts.removes {
        let human = room.is_human(gone);
        if by_opener {
            // 5.2.4: the opener removes no human device.
            refuse(human, Error::BadCommit)?;
        } else if helper && parent == Parent::Seat(None) && !facts.external {
            // 5.2.3: while the main session has no agent leaf, only leaves the room no longer allows go;
            // and the leaf of a human device that the same Commit adds again (3.7).
            let again = human && facts.adds.contains(gone);
            refuse(allowed.allows(gone) && !again, Error::BadCommit)?;
        }
        // 5.2.3: the opener is a leaf for as long as it is the main session's agent leaf.
        let opener = parent == Parent::Seat(Some(*gone)) && room.is_agent(gone);
        refuse(helper && opener, Error::BadCommit)?;
    }
    if !helper {
        // 5.2.8, 5.3.1: the leaf of an agent device goes only after the room Commit that took the device
        // out of `agents`, for a takeover or an empty seat. While the room holds the device its leaf stays:
        // otherwise a Remove and a later Add would put another device in the seat of one still enrolled.
        let unseats_enrolled = facts.removes.iter().any(|gone| room.is_agent(gone));
        refuse(unseats_enrolled, Error::BadCommit)?;
    }

    // 5.2.8: a leaf the room state does not allow makes the group stale, and so does a helper session's
    // missing opener. Only the Commit that removes every such leaf and adds that opener is taken, and a join
    // by 8.4, which leaves the group as stale as it was for that one Commit. The repair is that and nothing
    // beside it: it removes exactly the leaves the room does not allow and adds no human device.
    let stale_before = staleness(history, room, session, parent, &before.leaves);
    if stale_before.is_stale() && !facts.external && !founding {
        let removed: BTreeSet<DeviceId> = facts.removes.iter().copied().collect();
        let unfit: BTreeSet<DeviceId> = stale_before.disallowed.iter().copied().collect();
        let adds_human = facts.adds.iter().any(|added| room.is_human(added));
        refuse(removed != unfit || adds_human, Error::StaleSession)?;
    }
    let stale = staleness(history, room, session, parent, &leaves);
    if stale.is_stale() && !facts.external {
        let unfit = &stale.disallowed;
        let brought = unfit.iter().any(|leaf| !before.leaves.contains(leaf));
        return Err(if brought {
            Error::BadCommit
        } else {
            Error::StaleSession
        });
    }

    if helper {
        refuse(
            allowed.others(&leaves).count() > MAX_HELPER_DEVICES,
            Error::TooMany,
        )?;
    } else {
        // 5.2.2: an agent device is the agent leaf of at most one live main session.
        for added in facts.adds.iter().filter(|added| !room.is_human(added)) {
            let elsewhere = verifier
                .sessions
                .main_session_of(added)
                .is_some_and(|other| other != session.session_id);
            refuse(elsewhere, Error::BadCommit)?;
        }
    }

    if founding {
        // 5.2.5: the first Commit adds every device of H(r) but the founder; a human device founds a main
        // session with its agent device, the opener a helper session.
        refuse(!facts.removes.is_empty(), Error::BadCommit)?;
        refuse(
            before.leaves.len() != 1 || !room.humans.iter().all(|human| leaves.contains(human)),
            Error::BadCommit,
        )?;
        if helper {
            refuse(!by_opener, Error::BadCommit)?;
            refuse(
                verifier.sessions.live_helpers(&session.parent) >= MAX_LIVE_HELPERS,
                Error::TooMany,
            )?;
        } else {
            refuse(allowed.others(&leaves).count() != 1, Error::BadCommit)?;
        }
    }
    Ok(())
}

/// Judges a session Commit that is read from the hub's log, where the hub stored it, as
/// [`check_session_commit`] does. `room-behind` then means only that the Commit came too early: it names a
/// room epoch the verifier has not reached, or the verifier does not know the helper session's main session
/// yet. A stored Commit that names a room epoch behind its place, or below the group's previous Commit's, is
/// never taken, by no member: it is `bad-group` (14.7), as the hub should have refused it (5.2.8).
pub fn check_stored_session_commit(
    verifier: &Verifier<'_>,
    before: &SessionBefore,
    judged: &Judged<'_>,
) -> Result<(), Error> {
    check_session_commit(verifier, before, judged).map_err(|error| {
        let behind_its_place = judged.facts.note.as_ref().is_some_and(|note| {
            note.room_epoch < verifier.room_epoch || note.room_epoch < before.previous_room_epoch
        });
        if error == Error::RoomBehind && behind_its_place {
            Error::BadGroup
        } else {
            error
        }
    })
}

/// Judges the founding of a room (5.1.1, 8.1) from its first state: one leaf, the founder; recovery keys that
/// are no device's key; no agent that is a human device.
pub fn check_room_founding(first: &RoomState) -> Result<(), Error> {
    let room = &first.room;
    refuse(
        first.epoch != 0 || first.humans.len() != 1,
        Error::BadCommit,
    )?;
    refuse(room.agents.len() > MAX_AGENT_DEVICES, Error::TooMany)?;
    refuse(
        room.recovery_signature_key == room.recovery_hpke_key,
        Error::BadCommit,
    )?;
    for key in [room.recovery_signature_key, room.recovery_hpke_key] {
        let as_device = DeviceId::new(key);
        refuse(
            first.is_human(&as_device) || first.is_agent(&as_device),
            Error::BadCommit,
        )?;
    }
    refuse(
        room.agents.iter().any(|agent| first.is_human(agent)),
        Error::BadCommit,
    )
}

/// The leaves of a group as the rules name them: each leaf's index with its device. `bad-group` for a leaf
/// whose signature key is no device id.
pub(crate) fn leaves_of(
    members: impl Iterator<Item = Member>,
) -> Result<Vec<(LeafNodeIndex, DeviceId)>, Error> {
    members
        .map(|member| {
            DeviceId::from_slice(&member.signature_key)
                .map(|device| (member.index, device))
                .map_err(|_| Error::BadGroup)
        })
        .collect()
}

/// The leaves of a group's public state as [`leaves_of`] names them, each checked to be the profile's (section
/// 3): a basic credential that is the leaf's signature key, the profile's capabilities, no leaf extension.
/// `bad-group` otherwise. For a tree that came whole, in a GroupInfo or a Welcome: a leaf that a Commit adds
/// or renews is checked where the Commit is read.
pub(crate) fn profile_leaves(
    public: &PublicGroup,
) -> Result<Vec<(LeafNodeIndex, DeviceId)>, Error> {
    public
        .members()
        .map(|member| {
            public
                .leaf(member.index)
                .and_then(key_package::leaf_device)
                .map(|device| (member.index, device))
                .ok_or(Error::BadGroup)
        })
        .collect()
}

/// The room state that a room group's context and leaves make.
pub(crate) fn room_state_of(
    context: &GroupContext,
    leaves: &[(LeafNodeIndex, DeviceId)],
) -> Result<RoomState, Error> {
    let (_, kind) = profile::kind_of_context(context)?;
    let GroupKind::Room(room) = kind else {
        return Err(Error::BadFormat);
    };
    let humans: BTreeSet<DeviceId> = leaves.iter().map(|(_, device)| *device).collect();
    if humans.len() != leaves.len() {
        return Err(Error::BadFormat);
    }
    Ok(RoomState {
        epoch: context.epoch().as_u64(),
        state: profile::room_state_hash(context)?,
        humans,
        room,
    })
}

/// Parses a Commit as it travels: an `MLSMessage` holding a `PublicMessage` with a Commit. `bad-commit` for a
/// standalone proposal, an encrypted handshake message or anything else (section 3).
pub(crate) fn parse_commit(bytes: &[u8]) -> Result<ProtocolMessage, Error> {
    if bytes.len() > MAX_COMMIT_REQUEST_LEN {
        return Err(Error::TooLarge);
    }
    let message = MlsMessageIn::tls_deserialize_exact(bytes).map_err(|_| Error::BadCommit)?;
    let message = message
        .try_into_protocol_message()
        .map_err(|_| Error::BadCommit)?;
    let public = matches!(message, ProtocolMessage::PublicMessage(_));
    if !public || message.content_type() != ContentType::Commit {
        return Err(Error::BadCommit);
    }
    Ok(message)
}

/// Describes a Commit that OpenMLS verified and staged, for a member's group or an observer's alike: `leaves`
/// are the group's leaves before it. This is the one place where a Commit is read.
pub(crate) fn commit_facts(
    group: &GroupId,
    leaves: &[(LeafNodeIndex, DeviceId)],
    processed: &ProcessedMessage,
    staged: &StagedCommit,
) -> Result<CommitFacts, Error> {
    let device_at = |index: LeafNodeIndex| {
        leaves
            .iter()
            .find(|(at, _)| *at == index)
            .map(|(_, device)| *device)
            .ok_or(Error::BadCommit)
    };
    let mut forbidden = false;
    let path_leaf = staged.update_path_leaf_node();
    let path_device = path_leaf.and_then(key_package::leaf_device);
    forbidden |= path_leaf.is_some() && path_device.is_none();
    let (committer, external) = match processed.sender() {
        Sender::Member(index) => {
            let committer = device_at(*index)?;
            forbidden |= path_device.is_some_and(|device| device != committer);
            (committer, false)
        }
        Sender::NewMemberCommit => (path_device.ok_or(Error::BadCommit)?, true),
        _ => return Err(Error::BadCommit),
    };
    let note = codec::decode::<CommitNote>(processed.aad(), MAX_NOTE_LEN);
    let mut facts = CommitFacts {
        group: *group,
        epoch: processed.epoch().as_u64(),
        committer,
        external,
        adds: Vec::new(),
        removes: Vec::new(),
        context: ContextChange::None,
        has_path: path_leaf.is_some(),
        external_inits: 0,
        forbidden,
        newer_version: matches!(note, Err(Error::NewerVersion)),
        note: note.ok(),
    };
    for queued in staged.queued_proposals() {
        let by_value = matches!(queued.proposal_or_ref_type(), ProposalOrRefType::Proposal);
        facts.forbidden |= !by_value || queued.sender() != processed.sender();
        match queued.proposal() {
            Proposal::Add(add) => match key_package::info(add.key_package()) {
                Ok(info) => facts.adds.push(info.device),
                Err(_) => facts.forbidden = true,
            },
            Proposal::Remove(remove) => facts.removes.push(device_at(remove.removed())?),
            Proposal::GroupContextExtensions(change) => {
                let repeated = facts.context != ContextChange::None;
                facts.context = match profile::group_kind(group, change.extensions()) {
                    Ok(kind) if !repeated => ContextChange::To(kind),
                    _ => ContextChange::Malformed,
                };
            }
            Proposal::ExternalInit(_) => {
                facts.external_inits = facts.external_inits.saturating_add(1);
            }
            _ => facts.forbidden = true,
        }
    }
    Ok(facts)
}
