//! A hub in memory: the ordering rules of `spec/hub-api.md` and the checks of `spec/v2.md` 14.1, 14.2, with no
//! network and no token. One change counter for the room, one Commit per group and epoch, the ordered log,
//! KeyPackage claims, the Welcomes. With `checks` off it orders and stores but verifies nothing, so that a
//! test can see what the devices themselves refuse.

use crate::TestRecovery;
use std::collections::{BTreeMap, BTreeSet};
use trommi_core::device::Accepted;
use trommi_core::ids::{DeviceId, GroupId, SessionId};
use trommi_core::mls::key_package::verify_key_package_of;
use trommi_core::mls::observer::{Context, Observer, PostedCommit};
use trommi_core::mls::profile::{MAX_HUMAN_DEVICES, MAX_HUMAN_DEVICES_IN_RECOVERY};
use trommi_core::mls::rules::{Parent, RoomHistory, SessionFacts};
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

/// The hub.
pub struct Hub {
    /// Whether the hub verifies what is posted (14.1). Off: it only orders and stores.
    pub checks: bool,
    /// Whether a recovery runs: the room may then hold 33 human devices.
    pub recovery_open: bool,
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
    pools: BTreeMap<DeviceId, Pool>,
    answers: BTreeMap<Vec<Vec<u8>>, Result<Accepted, Error>>,
    pub recovery: TestRecovery,
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
            checks,
            recovery_open: false,
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
            pools: BTreeMap::new(),
            answers: BTreeMap::new(),
            recovery: TestRecovery::default(),
        }
    }

    /// The room's change counter.
    pub fn change(&self) -> u64 {
        self.change
    }

    /// The current epoch of a group.
    pub fn epoch(&self, group: &GroupId) -> Option<u64> {
        self.epochs.get(group).copied()
    }

    /// The roles of the room as the hub followed them.
    pub fn history(&self) -> Option<&RoomHistory> {
        self.room.as_ref().and_then(Observer::history)
    }

    /// The hub's follower of a group.
    pub fn observer(&self, group: &GroupId) -> Option<&Observer> {
        if group.is_room() {
            self.room.as_ref()
        } else {
            self.sessions.get(group)
        }
    }

    /// The current GroupInfo of a group.
    pub fn group_info(&self, group: &GroupId) -> Option<&Vec<u8>> {
        self.group_infos.get(&(*group, self.epoch(group)?))
    }

    /// The log after `change`, in order.
    pub fn log_after(&self, change: u64) -> Vec<LogItem> {
        self.log
            .iter()
            .filter(|item| item.change > change)
            .cloned()
            .collect()
    }

    /// Archives a session group: nothing more is taken for it (5.2.10).
    pub fn archive(&mut self, group: &GroupId) {
        self.archived.insert(*group);
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
        let mut request = entry.parts.clone();
        request.push(vec![entry.kind as u8]);
        if let Some(answer) = self.answers.get(&request) {
            return answer.clone();
        }
        let answer = self.take(from, entry);
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
                if self.epoch(&group) != Some(entry.epoch) {
                    return Err(Error::WrongEpoch);
                }
                if self.checks {
                    let leaves = self.observer(&group).ok_or(Error::NotFound)?.leaves()?;
                    if !leaves.contains(from) {
                        return Err(Error::NotMember);
                    }
                    if !self.stale_leaves(&group)?.is_empty() {
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
                        Observer::found_room(part(entry, 0), part(entry, 1), &self.recovery)?;
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
                };
                if self.checks {
                    let room = self.room.as_ref().ok_or(Error::NoRoom)?;
                    let context = Context {
                        room: room.history(),
                        sessions: &Sessions {
                            sessions: &self.sessions,
                            archived: &self.archived,
                        },
                        recovery: &self.recovery,
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
            OutboxKind::Commit | OutboxKind::ExternalCommit | OutboxKind::RecoveryCode => {
                let group = entry.group.ok_or(Error::BadFormat)?;
                let external = entry.kind == OutboxKind::ExternalCommit;
                let posted = PostedCommit {
                    commit: part(entry, 0),
                    group_info: part(entry, 1),
                    welcome: if external {
                        None
                    } else {
                        optional(part(entry, 2))
                    },
                    sealed_key: part(entry, if external { 2 } else { 3 }),
                    recovery_auth: if external {
                        optional(part(entry, 3))
                    } else {
                        None
                    },
                };
                if self.archived.contains(&group) {
                    return Err(Error::Gone);
                }
                let current = self.epoch(&group).ok_or(Error::NotFound)?;
                if entry.epoch != current {
                    return Err(Error::EpochTaken);
                }
                if self.checks {
                    self.check(&group, &posted, from)?;
                }
                Ok(self.accept_commit(group, current, &posted, from))
            }
            OutboxKind::Envelope | OutboxKind::SealedKey => Err(Error::Internal("not built here")),
        }
    }

    /// 14.1 for a Commit being posted.
    fn check(
        &mut self,
        group: &GroupId,
        posted: &PostedCommit<'_>,
        from: &DeviceId,
    ) -> Result<(), Error> {
        let max_human_devices = if self.recovery_open {
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
                recovery: &self.recovery,
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
                recovery: &self.recovery,
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
        Ok(())
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
        let (Some(observer), Some(history)) = (self.sessions.get(group), self.history()) else {
            return Ok(Vec::new());
        };
        observer.disallowed_leaves(
            history,
            history.newest(),
            &Sessions {
                sessions: &self.sessions,
                archived: &self.archived,
            },
        )
    }
}
