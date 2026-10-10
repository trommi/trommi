//! A hub in memory: the ordering rules of `spec/hub-api.md` and the checks of `spec/v2.md` 14.1, 14.2, with no
//! network and no token. One change counter for the room, one Commit per group and epoch, the ordered log,
//! KeyPackage claims, the Welcomes, the sealed keys and links, and a recovery as a transaction of its own. With
//! `checks` off it orders and stores but verifies nothing, so that a test can see what the devices themselves
//! refuse.

use std::collections::{BTreeMap, BTreeSet};
use trommi_core::device::Accepted;
use trommi_core::ids::{DeviceId, GroupId, SessionId};
use trommi_core::mls::key_package::verify_key_package_of;
use trommi_core::mls::observer::{Context, Observer, PostedCommit};
use trommi_core::mls::profile::GroupKind;
use trommi_core::mls::profile::{MAX_HUMAN_DEVICES, MAX_HUMAN_DEVICES_IN_RECOVERY};
use trommi_core::mls::rules::{CommitFacts, ContextChange, Parent, RoomHistory, SessionFacts};
use trommi_core::recovery::{check_posted_row, PostedRow, PublicRules, RecoveryLink, SealedKey};
use trommi_core::store::{OutboxEntry, OutboxKind};
use trommi_core::Error;

/// One entry of the ordered log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogItem {
    pub change: u64,
    pub group: GroupId,
    /// A Commit; otherwise an application message.
    pub commit: bool,
    /// The epoch a Commit builds on, or a message was sent in.
    pub epoch: u64,
    pub bytes: Vec<u8>,
    pub recovery_auth: Option<Vec<u8>>,
    /// The device that posted it.
    pub from: DeviceId,
}

/// A Welcome waiting for its device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredWelcome {
    pub group: GroupId,
    pub bytes: Vec<u8>,
    pub change: u64,
}

#[derive(Default)]
struct Pool {
    single_use: Vec<Vec<u8>>,
    last_resort: Option<Vec<u8>>,
}

#[path = "hub_content.rs"]
pub mod content;

/// The hub.
pub struct Hub {
    /// Stored content: the envelopes it took, and what it follows of the groups to check them.
    pub content: content::Content,
    /// Whether the hub verifies what is posted (14.1). Off: it only orders and stores.
    pub checks: bool,
    /// The hub's clock, set by the test.
    pub clock: u64,
    /// The recovery that runs, if one does: the room is locked, and what it posts is staged.
    recovery: Option<OpenRecovery>,
    room: Option<Observer>,
    sessions: BTreeMap<GroupId, Observer>,
    archived: BTreeSet<GroupId>,
    epochs: BTreeMap<GroupId, u64>,
    change: u64,
    pub log: Vec<LogItem>,
    pub welcomes: Vec<StoredWelcome>,
    /// Application messages that were only passed on.
    pub relayed: Vec<(GroupId, Vec<u8>)>,
    pub group_infos: BTreeMap<(GroupId, u64), Vec<u8>>,
    pub sealed_keys: Vec<(GroupId, u64, Vec<u8>)>,
    /// Every `RecoveryLink`, and the account's sealed copies as last posted.
    pub links: Vec<Vec<u8>>,
    pub account: Vec<u8>,
    pools: BTreeMap<DeviceId, Pool>,
    answers: BTreeMap<Vec<Vec<u8>>, Result<Accepted, Error>>,
}

/// How long a recovery may run (8.7).
pub const RECOVERY_FOR_MS: u64 = 10 * 60 * 1000;

/// What a refusal puts back: the public state and everything stored for the room.
struct Snapshot {
    room: Option<Observer>,
    sessions: BTreeMap<GroupId, Observer>,
    archived: BTreeSet<GroupId>,
    epochs: BTreeMap<GroupId, u64>,
    change: u64,
    log: usize,
    welcomes: usize,
    group_infos: BTreeMap<(GroupId, u64), Vec<u8>>,
    sealed_keys: Vec<(GroupId, u64, Vec<u8>)>,
    links: Vec<Vec<u8>>,
    account: Vec<u8>,
}

/// A recovery that runs: who opened it, when, and the state from before, which every other reader sees.
struct OpenRecovery {
    by: DeviceId,
    opened: u64,
    before: Snapshot,
    /// The parts it posted that were accepted: their answers go when the recovery is dropped.
    answered: Vec<Vec<Vec<u8>>>,
}

struct Sessions<'a> {
    sessions: &'a BTreeMap<GroupId, Observer>,
    archived: &'a BTreeSet<GroupId>,
}

impl Sessions<'_> {
    fn live(&self) -> impl Iterator<Item = &Observer> {
        self.sessions
            .iter()
            .filter(|(group, _)| !self.archived.contains(group))
            .map(|(_, observer)| observer)
    }
}

impl SessionFacts for Sessions<'_> {
    fn main_session(&self, session: &SessionId, room_epoch: u64) -> Parent {
        self.live()
            .find(|observer| observer.session().is_some_and(|s| s.session_id == *session))
            .map_or(Parent::NotAMainSession, |observer| {
                observer.seat_at(room_epoch)
            })
    }

    fn main_session_of(&self, agent: &DeviceId) -> Option<SessionId> {
        self.live()
            .filter(|observer| observer.seat_at(u64::MAX) == Parent::Seat(Some(*agent)))
            .find_map(|observer| observer.session().map(|session| session.session_id))
    }

    fn live_helpers(&self, parent: &SessionId) -> usize {
        self.live()
            .filter(|observer| observer.session().is_some_and(|s| s.parent == *parent))
            .count()
    }
}

fn part(entry: &OutboxEntry, at: usize) -> &[u8] {
    entry.parts.get(at).map_or(&[], Vec::as_slice)
}

fn optional(bytes: &[u8]) -> Option<&[u8]> {
    Some(bytes).filter(|bytes| !bytes.is_empty())
}

impl Hub {
    /// A hub without a room.
    pub fn new(checks: bool) -> Self {
        Self {
            content: content::Content::default(),
            checks,
            clock: 0,
            recovery: None,
            room: None,
            sessions: BTreeMap::new(),
            archived: BTreeSet::new(),
            epochs: BTreeMap::new(),
            change: 0,
            log: Vec::new(),
            welcomes: Vec::new(),
            relayed: Vec::new(),
            group_infos: BTreeMap::new(),
            sealed_keys: Vec::new(),
            links: Vec::new(),
            account: Vec::new(),
            pools: BTreeMap::new(),
            answers: BTreeMap::new(),
        }
    }

    /// What every reader but a running recovery sees: the state from before it, while one runs.
    fn published(&self) -> Option<&Snapshot> {
        self.recovery.as_ref().map(|open| &open.before)
    }

    /// The room's change counter.
    pub fn change(&self) -> u64 {
        self.published().map_or(self.change, |before| before.change)
    }

    /// The current epoch of a group.
    pub fn epoch(&self, group: &GroupId) -> Option<u64> {
        let epochs = self
            .published()
            .map_or(&self.epochs, |before| &before.epochs);
        epochs.get(group).copied()
    }

    /// The roles of the room as the hub followed them.
    pub fn history(&self) -> Option<&RoomHistory> {
        let room = match self.published() {
            Some(before) => before.room.as_ref(),
            None => self.room.as_ref(),
        };
        room.and_then(Observer::history)
    }

    /// The hub's follower of a group.
    pub fn observer(&self, group: &GroupId) -> Option<&Observer> {
        let (room, sessions) = match self.published() {
            Some(before) => (before.room.as_ref(), &before.sessions),
            None => (self.room.as_ref(), &self.sessions),
        };
        if group.is_room() {
            room
        } else {
            sessions.get(group)
        }
    }

    /// The current GroupInfo of a group.
    pub fn group_info(&self, group: &GroupId) -> Option<&Vec<u8>> {
        self.group_info_at(group, self.epoch(group)?)
    }

    /// The state a posted part is judged against: the staged one while a recovery runs.
    fn staged_epoch(&self, group: &GroupId) -> Option<u64> {
        self.epochs.get(group).copied()
    }

    fn staged_history(&self) -> Option<&RoomHistory> {
        self.room.as_ref().and_then(Observer::history)
    }

    fn staged_observer(&self, group: &GroupId) -> Option<&Observer> {
        if group.is_room() {
            self.room.as_ref()
        } else {
            self.sessions.get(group)
        }
    }

    /// The log after `change`, in order. While a recovery runs, what it posted is not in it: every reader
    /// sees the state from before.
    pub fn log_after(&self, change: u64) -> Vec<LogItem> {
        let published = self
            .recovery
            .as_ref()
            .map_or(u64::MAX, |open| open.before.change);
        self.log
            .iter()
            .filter(|item| item.change > change && item.change <= published)
            .cloned()
            .collect()
    }

    /// The GroupInfo the hub holds for `group` at `epoch`.
    pub fn group_info_at(&self, group: &GroupId, epoch: u64) -> Option<&Vec<u8>> {
        let held = self
            .published()
            .map_or(&self.group_infos, |before| &before.group_infos);
        held.get(&(*group, epoch))
    }

    /// Every Commit of `group` with its change number and its `RecoveryAuth`, in order.
    pub fn commits_of(&self, group: &GroupId) -> Vec<(u64, Vec<u8>, Option<Vec<u8>>)> {
        self.log_after(0)
            .into_iter()
            .filter(|item| item.commit && item.group == *group)
            .map(|item| (item.change, item.bytes, item.recovery_auth))
            .collect()
    }

    /// The live session groups, main sessions before helper sessions.
    pub fn live_sessions(&self) -> Vec<GroupId> {
        let (sessions, archived) = match self.published() {
            Some(before) => (&before.sessions, &before.archived),
            None => (&self.sessions, &self.archived),
        };
        let mut live: Vec<(bool, GroupId)> = sessions
            .iter()
            .filter(|(group, _)| !archived.contains(group))
            .map(|(group, observer)| {
                let helper = observer.session().is_some_and(|s| !s.parent.is_zero());
                (helper, *group)
            })
            .collect();
        live.sort();
        live.into_iter().map(|(_, group)| group).collect()
    }

    /// Every `SealedKey` the hub holds.
    pub fn rows(&self) -> Vec<Vec<u8>> {
        let held = self
            .published()
            .map_or(&self.sealed_keys, |before| &before.sealed_keys);
        held.iter().map(|(_, _, row)| row.clone()).collect()
    }

    fn snapshot(&self) -> Result<Snapshot, Error> {
        Ok(Snapshot {
            room: self.room.as_ref().map(Observer::fork).transpose()?,
            sessions: self
                .sessions
                .iter()
                .map(|(group, observer)| Ok((*group, observer.fork()?)))
                .collect::<Result<_, Error>>()?,
            archived: self.archived.clone(),
            epochs: self.epochs.clone(),
            change: self.change,
            log: self.log.len(),
            welcomes: self.welcomes.len(),
            group_infos: self.group_infos.clone(),
            sealed_keys: self.sealed_keys.clone(),
            links: self.links.clone(),
            account: self.account.clone(),
        })
    }

    fn restore(&mut self, before: Snapshot) {
        self.room = before.room;
        self.sessions = before.sessions;
        self.archived = before.archived;
        self.epochs = before.epochs;
        self.change = before.change;
        self.log.truncate(before.log);
        self.welcomes.truncate(before.welcomes);
        self.group_infos = before.group_infos;
        self.sealed_keys = before.sealed_keys;
        self.links = before.links;
        self.account = before.account;
    }

    /// Opens a recovery for the device `by` (8.7): from now on the room takes nothing else for ten minutes,
    /// and what the recovery posts is staged until its finish.
    pub fn open_recovery(&mut self, by: &DeviceId) -> Result<(), Error> {
        self.expire();
        if self.recovery.is_some() {
            return Err(Error::Overloaded);
        }
        self.recovery = Some(OpenRecovery {
            by: *by,
            opened: self.clock,
            before: self.snapshot()?,
            answered: Vec::new(),
        });
        Ok(())
    }

    /// Drops the recovery that runs, with everything it posted.
    pub fn drop_recovery(&mut self) {
        if let Some(open) = self.recovery.take() {
            for request in &open.answered {
                self.answers.remove(request);
            }
            self.restore(open.before);
        }
    }

    /// Whether a recovery runs.
    pub fn recovery_runs(&self) -> bool {
        self.recovery.is_some()
    }

    /// Drops a recovery whose ten minutes have passed.
    fn expire(&mut self) {
        let over = self
            .recovery
            .as_ref()
            .is_some_and(|open| self.clock.saturating_sub(open.opened) > RECOVERY_FOR_MS);
        if over {
            self.drop_recovery();
        }
    }

    /// Archives a session group: nothing more is taken for it (5.2.10). While a recovery runs the room takes
    /// no archiving either (8.7): nothing happens.
    pub fn archive(&mut self, group: &GroupId) {
        if self.recovery.is_none() {
            self.archived.insert(*group);
        }
    }

    /// Hands out one KeyPackage per device, all or nothing: a single-use one, or the last-resort one when none
    /// is left (14.2).
    pub fn claim(&mut self, devices: &[DeviceId]) -> Result<Vec<Vec<u8>>, Error> {
        let has = |pool: &Pool| !pool.single_use.is_empty() || pool.last_resort.is_some();
        if !devices
            .iter()
            .all(|device| self.pools.get(device).is_some_and(has))
        {
            return Err(Error::NotFound);
        }
        let mut claimed = Vec::new();
        for device in devices {
            let pool = self.pools.get_mut(device).ok_or(Error::NotFound)?;
            match pool.single_use.pop() {
                Some(package) => claimed.push(package),
                None => claimed.push(pool.last_resort.clone().ok_or(Error::NotFound)?),
            }
        }
        Ok(claimed)
    }

    /// How many unused single-use KeyPackages of `device` the hub holds.
    pub fn unused(&self, device: &DeviceId) -> usize {
        self.pools
            .get(device)
            .map_or(0, |pool| pool.single_use.len())
    }

    /// Drops every single-use KeyPackage of `device`, as if they had all been claimed.
    pub fn exhaust(&mut self, device: &DeviceId) {
        if let Some(pool) = self.pools.get_mut(device) {
            pool.single_use.clear();
        }
    }

    /// Takes one outbox entry of `from`. A repeated post of the same bytes gets the first answer again.
    pub fn post(&mut self, from: &DeviceId, entry: &OutboxEntry) -> Result<Accepted, Error> {
        // The same request: the same sender, kind, group and bytes.
        let mut request = entry.parts.clone();
        request.push(vec![entry.kind as u8]);
        request.push(from.as_bytes().to_vec());
        request.push(
            entry
                .group
                .map_or(Vec::new(), |group| group.as_bytes().to_vec()),
        );
        if let Some(answer) = self.answers.get(&request) {
            return answer.clone();
        }
        self.expire();
        let staged = matches!(
            entry.kind,
            OutboxKind::RecoveryCommit | OutboxKind::RecoveryFinish
        );
        // 8.7: while a recovery runs the room takes nothing else, and its parts only from its device.
        match &self.recovery {
            Some(open) if !staged || open.by != *from => return Err(Error::Overloaded),
            None if staged => return Err(Error::Gone),
            _ => {}
        }
        let answer = self.take(from, entry);
        self.follow_content();
        if staged {
            // A refused part ends the recovery. An accepted one is answered again like the first time, as long
            // as the recovery stands; the finish for good, since it is published.
            match (&answer, &mut self.recovery) {
                (Err(_), _) => self.drop_recovery(),
                (Ok(_), Some(open)) => open.answered.push(request.clone()),
                (Ok(_), None) => {}
            }
            if answer.is_ok() {
                self.answers.insert(request, answer.clone());
            }
            return answer;
        }
        // A refusal that names a state of the moment is not remembered: the same bytes may fit later.
        let passing = matches!(
            answer,
            Err(Error::EpochTaken | Error::WrongEpoch | Error::RoomBehind | Error::StaleSession)
        );
        if !passing {
            self.answers.insert(request, answer.clone());
        }
        answer
    }

    fn take(&mut self, from: &DeviceId, entry: &OutboxEntry) -> Result<Accepted, Error> {
        match entry.kind {
            OutboxKind::KeyPackages => {
                let pool = self.pools.entry(*from).or_default();
                for (at, package) in entry.parts.iter().enumerate() {
                    if package.is_empty() {
                        continue;
                    }
                    let info = verify_key_package_of(package, from)?;
                    if at == 0 {
                        if !info.last_resort {
                            return Err(Error::BadKeyPackage);
                        }
                        pool.last_resort = Some(package.clone());
                    } else if info.last_resort {
                        return Err(Error::BadKeyPackage);
                    } else {
                        pool.single_use.push(package.clone());
                    }
                }
                Ok(Accepted::default())
            }
            OutboxKind::Message | OutboxKind::RelayMessage => {
                let group = entry.group.ok_or(Error::BadFormat)?;
                if self.archived.contains(&group) {
                    return Err(Error::Gone);
                }
                if self.staged_epoch(&group) != Some(entry.epoch) {
                    return Err(Error::WrongEpoch);
                }
                if self.checks {
                    let leaves = self
                        .staged_observer(&group)
                        .ok_or(Error::NotFound)?
                        .leaves()?;
                    if !leaves.contains(from) {
                        return Err(Error::NotMember);
                    }
                    if !self.staged_stale_leaves(&group)?.is_empty() {
                        return Err(Error::StaleSession);
                    }
                }
                if entry.kind == OutboxKind::RelayMessage {
                    self.relayed.push((group, part(entry, 0).to_vec()));
                    return Ok(Accepted::default());
                }
                Ok(self.append(group, false, entry.epoch, part(entry, 0), None, from))
            }
            OutboxKind::RoomFounding => {
                let group = entry.group.ok_or(Error::BadFormat)?;
                if self.epochs.keys().any(GroupId::is_room) {
                    return Err(Error::RoomExists);
                }
                if self.checks {
                    let (observer, founder) =
                        Observer::found_room(part(entry, 0), part(entry, 1), &PublicRules)?;
                    if founder != *from || observer.group() != group {
                        return Err(Error::WrongSender);
                    }
                    self.room = Some(observer);
                }
                self.epochs.insert(group, 0);
                self.group_infos.insert((group, 0), part(entry, 0).to_vec());
                self.sealed_keys.push((group, 0, part(entry, 1).to_vec()));
                self.change += 1;
                Ok(Accepted {
                    change: Some(self.change),
                })
            }
            OutboxKind::GroupFounding => {
                let group = entry.group.ok_or(Error::BadFormat)?;
                if self.epochs.contains_key(&group) {
                    return Err(Error::RoomExists);
                }
                let posted = PostedCommit {
                    commit: part(entry, 2),
                    group_info: part(entry, 3),
                    welcome: optional(part(entry, 4)),
                    sealed_key: part(entry, 5),
                    recovery_auth: None,
                    base_group_info: None,
                };
                if self.checks {
                    let room = self.room.as_ref().ok_or(Error::NoRoom)?;
                    let context = Context {
                        room: room.history(),
                        sessions: &Sessions {
                            sessions: &self.sessions,
                            archived: &self.archived,
                        },
                        recovery: &PublicRules,
                        max_human_devices: MAX_HUMAN_DEVICES,
                    };
                    let (observer, facts) =
                        Observer::found_session(part(entry, 0), part(entry, 1), &posted, &context)?;
                    if facts.committer != *from || observer.group() != group {
                        return Err(Error::WrongSender);
                    }
                    self.sessions.insert(group, observer);
                }
                self.group_infos.insert((group, 0), part(entry, 0).to_vec());
                self.sealed_keys.push((group, 0, part(entry, 1).to_vec()));
                self.epochs.insert(group, 0);
                Ok(self.accept_commit(group, 0, &posted, from))
            }
            OutboxKind::Commit
            | OutboxKind::ExternalCommit
            | OutboxKind::RecoveryCode
            | OutboxKind::RecoveryCommit => {
                let group = entry.group.ok_or(Error::BadFormat)?;
                let external = match entry.kind {
                    OutboxKind::ExternalCommit => true,
                    OutboxKind::RecoveryCommit => !part(entry, 4).is_empty(),
                    _ => false,
                };
                let replaces = entry.kind == OutboxKind::RecoveryCode;
                let current = self.staged_epoch(&group).ok_or(Error::NotFound)?;
                // Where each part lies, by the kind of request.
                let (welcome, sealed_key, recovery_auth) = match entry.kind {
                    OutboxKind::ExternalCommit => (None, 2, Some(3)),
                    OutboxKind::RecoveryCode => (None, 2, None),
                    OutboxKind::RecoveryCommit => (Some(2), 3, Some(4)),
                    _ => (Some(2), 3, None),
                };
                let base = self.group_infos.get(&(group, current)).cloned();
                let posted = PostedCommit {
                    commit: part(entry, 0),
                    group_info: part(entry, 1),
                    welcome: welcome.and_then(|at| optional(part(entry, at))),
                    sealed_key: part(entry, sealed_key),
                    recovery_auth: recovery_auth
                        .and_then(|at| optional(part(entry, at)))
                        .filter(|_| external),
                    base_group_info: base.as_deref(),
                };
                if self.archived.contains(&group) {
                    return Err(Error::Gone);
                }
                if entry.epoch != current {
                    return Err(Error::EpochTaken);
                }
                if self.checks {
                    // A refusal after the Commit was followed puts the group's public state back.
                    let before = self
                        .staged_observer(&group)
                        .map(Observer::fork)
                        .transpose()?;
                    let checked = self
                        .check(&group, &posted, from)
                        .and_then(|facts| self.check_replacement(&facts, entry, replaces));
                    if let Err(refusal) = checked {
                        match before {
                            Some(before) if group.is_room() => self.room = Some(before),
                            Some(before) => {
                                self.sessions.insert(group, before);
                            }
                            None => {}
                        }
                        return Err(refusal);
                    }
                }
                if replaces {
                    self.links.push(part(entry, 3).to_vec());
                    self.account = part(entry, 4).to_vec();
                }
                Ok(self.accept_commit(group, current, &posted, from))
            }
            OutboxKind::RecoveryFinish => {
                let open = self.recovery.as_ref().ok_or(Error::Gone)?;
                if self.checks {
                    let by = open.by;
                    let before = open
                        .before
                        .room
                        .as_ref()
                        .and_then(Observer::history)
                        .ok_or(Error::NoRoom)?
                        .newest()
                        .room
                        .recovery_hpke_key;
                    let now = self.staged_history().ok_or(Error::NoRoom)?.newest().clone();
                    // 8.7: the room group was joined and cleaned, and the code replaced with its link.
                    let link = RecoveryLink::from_bytes(part(entry, 0))?;
                    let replaced = now.room.recovery_hpke_key != before
                        && link.new_recovery_hpke_key == now.room.recovery_hpke_key
                        && Some(link.room_id)
                            == self.room.as_ref().map(|room| room.group().room_id());
                    if !replaced || now.humans.len() != 1 || !now.is_human(&by) {
                        return Err(Error::Incomplete);
                    }
                    // Every live session group was joined, and none is stale.
                    let live: Vec<GroupId> = self
                        .sessions
                        .keys()
                        .filter(|group| !self.archived.contains(group))
                        .copied()
                        .collect();
                    for group in live {
                        let leaves = self
                            .staged_observer(&group)
                            .ok_or(Error::NotFound)?
                            .leaves()?;
                        if !leaves.contains(&by) {
                            return Err(Error::Incomplete);
                        }
                        if !self.staged_stale_leaves(&group)?.is_empty() {
                            return Err(Error::StaleSession);
                        }
                    }
                }
                self.links.push(part(entry, 0).to_vec());
                self.account = part(entry, 1).to_vec();
                self.recovery = None;
                Ok(Accepted {
                    change: Some(self.change),
                })
            }
            OutboxKind::SealedKey => {
                let row = SealedKey::from_bytes(part(entry, 0))?;
                if self.checks {
                    let room = self.room.as_ref().ok_or(Error::NoRoom)?;
                    let room_id = room.group().room_id();
                    let posted = PostedRow {
                        poster: from,
                        room_id: &room_id,
                        room: room.history().ok_or(Error::NoRoom)?.newest(),
                        group_info: self
                            .group_infos
                            .get(&(row.context.group, row.context.epoch))
                            .map(Vec::as_slice),
                    };
                    check_posted_row(part(entry, 0), &posted)?;
                    // 5.2.8, 5.2.10: nothing is taken for an archived group, nor for a stale one but the
                    // Commit that cleans it, which brings its own row.
                    if self.archived.contains(&row.context.group) {
                        return Err(Error::Gone);
                    }
                    if !self.staged_stale_leaves(&row.context.group)?.is_empty() {
                        return Err(Error::StaleSession);
                    }
                }
                // One row per group, epoch and writer.
                let place = (row.context.group, row.context.epoch);
                self.sealed_keys.retain(|(group, epoch, held)| {
                    (*group, *epoch) != place
                        || SealedKey::from_bytes(held)
                            .map_or(true, |held| held.writer != row.writer)
                });
                self.sealed_keys
                    .push((place.0, place.1, part(entry, 0).to_vec()));
                Ok(Accepted::default())
            }
            OutboxKind::Envelope => self.take_envelope(from, entry),
        }
    }

    /// 8.6: a room Commit that replaces the recovery keys comes only as the one request with its
    /// `RecoveryLink`, or inside a recovery, whose finish brings the link; and that request replaces them.
    fn check_replacement(
        &self,
        facts: &CommitFacts,
        entry: &OutboxEntry,
        replaces: bool,
    ) -> Result<(), Error> {
        let new_key = match &facts.context {
            ContextChange::To(GroupKind::Room(room)) => Some(room.recovery_hpke_key),
            _ => None,
        };
        // The observer followed the Commit: the state before it is the one before the newest.
        let history = self.staged_history().ok_or(Error::NoRoom)?;
        let before = facts
            .group
            .is_room()
            .then(|| history.at(facts.epoch))
            .flatten()
            .map(|state| state.room.recovery_hpke_key);
        let changed = new_key.is_some() && new_key != before;
        if replaces {
            let link = RecoveryLink::from_bytes(part(entry, 3)).map_err(|_| Error::Incomplete)?;
            let fits = changed
                && Some(link.new_recovery_hpke_key) == new_key
                && link.room_id == facts.group.room_id();
            return if fits { Ok(()) } else { Err(Error::Incomplete) };
        }
        if changed && entry.kind != OutboxKind::RecoveryCommit {
            return Err(Error::Incomplete);
        }
        Ok(())
    }

    /// 14.1 for a Commit being posted.
    fn check(
        &mut self,
        group: &GroupId,
        posted: &PostedCommit<'_>,
        from: &DeviceId,
    ) -> Result<CommitFacts, Error> {
        let max_human_devices = if self.recovery.is_some() {
            MAX_HUMAN_DEVICES_IN_RECOVERY
        } else {
            MAX_HUMAN_DEVICES
        };
        let facts = if group.is_room() {
            let context = Context {
                room: None,
                sessions: &Sessions {
                    sessions: &self.sessions,
                    archived: &self.archived,
                },
                recovery: &PublicRules,
                max_human_devices,
            };
            self.room
                .as_mut()
                .ok_or(Error::NoRoom)?
                .check_posted_commit(posted, &context)?
        } else {
            // The group checked is taken out of the map while the others answer for the room's sessions.
            let mut observer = self.sessions.remove(group).ok_or(Error::NotFound)?;
            let context = Context {
                room: self.room.as_ref().and_then(Observer::history),
                sessions: &Sessions {
                    sessions: &self.sessions,
                    archived: &self.archived,
                },
                recovery: &PublicRules,
                max_human_devices,
            };
            let result = observer.check_posted_commit(posted, &context);
            self.sessions.insert(*group, observer);
            result?
        };
        // A member's Commit is taken only from the device that made it. On a mismatch the observer has
        // followed already: this hub is for tests, where that case is not posted.
        if !facts.external && facts.committer != *from {
            return Err(Error::WrongSender);
        }
        Ok(facts)
    }

    fn accept_commit(
        &mut self,
        group: GroupId,
        epoch: u64,
        posted: &PostedCommit<'_>,
        from: &DeviceId,
    ) -> Accepted {
        self.epochs.insert(group, epoch + 1);
        self.group_infos
            .insert((group, epoch + 1), posted.group_info.to_vec());
        self.sealed_keys
            .push((group, epoch + 1, posted.sealed_key.to_vec()));
        let accepted = self.append(
            group,
            true,
            epoch,
            posted.commit,
            posted.recovery_auth,
            from,
        );
        if let Some(welcome) = posted.welcome {
            self.welcomes.push(StoredWelcome {
                group,
                bytes: welcome.to_vec(),
                change: self.change,
            });
        }
        accepted
    }

    fn append(
        &mut self,
        group: GroupId,
        commit: bool,
        epoch: u64,
        bytes: &[u8],
        recovery_auth: Option<&[u8]>,
        from: &DeviceId,
    ) -> Accepted {
        self.change += 1;
        self.log.push(LogItem {
            change: self.change,
            group,
            commit,
            epoch,
            bytes: bytes.to_vec(),
            recovery_auth: recovery_auth.map(<[u8]>::to_vec),
            from: *from,
        });
        Accepted {
            change: Some(self.change),
        }
    }

    /// The leaves of a session group that the hub's newest room state does not allow (5.2.8).
    pub fn stale_leaves(&self, group: &GroupId) -> Result<Vec<DeviceId>, Error> {
        match self.published() {
            Some(before) => Self::stale_in(
                before.room.as_ref(),
                &before.sessions,
                &before.archived,
                group,
            ),
            None => self.staged_stale_leaves(group),
        }
    }

    fn staged_stale_leaves(&self, group: &GroupId) -> Result<Vec<DeviceId>, Error> {
        Self::stale_in(self.room.as_ref(), &self.sessions, &self.archived, group)
    }

    fn stale_in(
        room: Option<&Observer>,
        sessions: &BTreeMap<GroupId, Observer>,
        archived: &BTreeSet<GroupId>,
        group: &GroupId,
    ) -> Result<Vec<DeviceId>, Error> {
        let history = room.and_then(Observer::history);
        let (Some(observer), Some(history)) = (sessions.get(group), history) else {
            return Ok(Vec::new());
        };
        observer.disallowed_leaves(history, history.newest(), &Sessions { sessions, archived })
    }
}
