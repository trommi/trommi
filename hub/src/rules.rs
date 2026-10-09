//! Trommi's rules on top of MLS (spec/v2.md sections 4 and 5), as pure functions over what a Commit does and what
//! the room's public state says. No database, no clock: the delivery service feeds them and stores the outcome.
//!
//! Seam for the merge with `trommi-core`: devices run the same checks before they merge a Commit. When the core
//! exports them, this module is replaced by it (the unit tests below then run against the core's functions).

use std::collections::BTreeSet;

use crate::error::{refuse, Res};
use crate::observer::{By, CommitFacts, Device};
use crate::wire::{CommitNote, TrommiRoom};

/// What a signature key is to the room now (4.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Standing {
    Human,
    Agent,
    /// once a human or agent device, no longer: never returns (4.2)
    Revoked,
    /// a key that never was any of the three: it can only be a helper device
    Helper,
}

/// The room's public state at its current epoch, as far as the rules need it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomView {
    pub epoch: u64,
    pub state: [u8; 32],
    pub humans: BTreeSet<Device>,
    pub agents: BTreeSet<Device>,
    pub revoked: BTreeSet<Device>,
}

impl RoomView {
    pub fn standing(&self, d: &Device) -> Standing {
        if self.humans.contains(d) {
            Standing::Human
        } else if self.agents.contains(d) {
            Standing::Agent
        } else if self.revoked.contains(d) {
            Standing::Revoked
        } else {
            Standing::Helper
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionKind {
    Main,
    /// with the agent leaf of its main session now, if that has one: the helper session's opener
    Helper {
        opener: Option<Device>,
    },
}

pub const MAX_HELPER_DEVICES: usize = 7;

fn bad(message: impl Into<String>) -> crate::error::Refused {
    refuse("bad-commit", message)
}

/// 3.3: the note every Commit carries, against the room state the hub holds. `room_epoch` must be the current
/// room epoch (5.2.1), in the room group the epoch the Commit builds on.
pub fn check_note(
    note: &CommitNote,
    room_epoch: u64,
    room_state: &[u8; 32],
    facts: &CommitFacts,
) -> Res<()> {
    if note.room_epoch < room_epoch {
        return Err(refuse(
            "room-behind",
            "the Commit names an older room epoch: process the room group first",
        ));
    }
    if note.room_epoch > room_epoch || &note.room_state != room_state {
        return Err(bad("the Commit's note does not name the room's state"));
    }
    if note.join != matches!(facts.by, By::External(_)) {
        return Err(bad("the note's join mark does not fit the Commit"));
    }
    let mut removed: Vec<Device> = facts.removes.clone();
    removed.sort();
    let cut: Vec<Device> = note.cuts.iter().map(|c| c.device).collect();
    // A join from outside may drop its own old leaf; that needs no Cut (the same device goes on).
    if matches!(facts.by, By::External(_)) {
        if !cut.is_empty() {
            return Err(bad("a join from outside carries no Cut"));
        }
    } else if removed != cut {
        return Err(bad("one Cut for every removed device, ascending"));
    }
    Ok(())
}

/// The leaves of a session group that the room's state does not allow: a revoked key; in a main session a key
/// that is neither human nor agent; in a helper session an agent leaf that is not its main session's agent leaf.
/// A group with any such leaf is stale (5.2.8).
pub fn offending_leaves(kind: SessionKind, room: &RoomView, leaves: &[Device]) -> Vec<Device> {
    leaves
        .iter()
        .filter(|d| match (room.standing(d), kind) {
            (Standing::Human, _) => false,
            (Standing::Revoked, _) => true,
            (Standing::Agent, SessionKind::Main) => false,
            (Standing::Agent, SessionKind::Helper { opener }) => opener.as_ref() != Some(*d),
            (Standing::Helper, SessionKind::Main) => true,
            (Standing::Helper, SessionKind::Helper { .. }) => false,
        })
        .copied()
        .collect()
}

/// 5.2.8: a session group is stale while it holds a leaf the room's state does not allow, and a helper session
/// also while it lacks the opener its main session has now (a takeover that is not finished there).
pub fn is_stale(kind: SessionKind, room: &RoomView, leaves: &[Device]) -> bool {
    let lacks_opener =
        matches!(kind, SessionKind::Helper { opener: Some(o) } if !leaves.contains(&o));
    lacks_opener || !offending_leaves(kind, room, leaves).is_empty()
}

/// 5.2.2 and 5.2.3: what the leaves of a session group may be after a Commit.
pub fn check_session_leaves(kind: SessionKind, room: &RoomView, leaves: &[Device]) -> Res<()> {
    if is_stale(kind, room, leaves) {
        return Err(refuse(
            "stale-session",
            "the group holds a leaf the room's state does not allow, or lacks its opener",
        ));
    }
    let agents = leaves
        .iter()
        .filter(|d| room.standing(d) == Standing::Agent)
        .count();
    let helpers = leaves
        .iter()
        .filter(|d| room.standing(d) == Standing::Helper)
        .count();
    match kind {
        SessionKind::Main if agents > 1 => Err(bad("a main session has one agent device")),
        SessionKind::Helper { .. } if helpers > MAX_HELPER_DEVICES => {
            Err(bad("a helper session has at most 7 helper devices"))
        }
        _ => Ok(()),
    }
}

/// 5.2.2 to 5.2.5: who may commit what in a session group. `founding`: the first Commit of the group, which must
/// leave no human device out. `was_stale`: the group was stale before this Commit. `recovery`: a Commit of a
/// recovery (8.7), which removes the other human devices from every live session group.
pub fn check_session_commit(
    kind: SessionKind,
    room: &RoomView,
    facts: &CommitFacts,
    founding: bool,
    was_stale: bool,
    recovery: bool,
) -> Res<()> {
    let leaves = &facts.after.leaves;
    match &facts.by {
        By::External(joiner) => {
            // 8.4: only a human device of the room joins from outside (its recovery signature is checked by the
            // caller). It may enter a stale group, which stays stale until its Removes.
            if founding {
                return Err(bad("a founding Commit is the founder's"));
            }
            if room.standing(joiner) != Standing::Human {
                return Err(bad(
                    "only a human device of the room joins a session from outside",
                ));
            }
            if facts.before.leaves.contains(joiner) {
                return Err(bad("the joiner is a leaf already"));
            }
            return Ok(());
        }
        By::Member(committer) => {
            match (room.standing(committer), kind) {
                (Standing::Human, _) => {
                    for add in &facts.adds {
                        let fits = match (room.standing(&add.device), kind) {
                            (Standing::Human, _) => true,
                            (Standing::Agent, SessionKind::Main) => true,
                            // the takeover's last step: the new opener is the main session's agent leaf
                            (Standing::Agent, SessionKind::Helper { opener }) => {
                                opener == Some(add.device)
                            }
                            _ => false,
                        };
                        if !fits {
                            return Err(bad("a human device adds human devices and the session's agent device only"));
                        }
                    }
                    // 5.2.3: while the main session has no agent leaf, human devices only add human devices and
                    // remove the leaves the room's state does not allow
                    if kind == (SessionKind::Helper { opener: None }) && !recovery {
                        let offending = offending_leaves(kind, room, &facts.before.leaves);
                        if facts.removes.iter().any(|d| !offending.contains(d)) {
                            return Err(bad("a waiting helper session loses only the leaves the room's state does not allow"));
                        }
                    }
                }
                (Standing::Agent, SessionKind::Helper { opener })
                    if opener.as_ref() == Some(committer) =>
                {
                    // 5.2.4: the opener adds devices that are not human devices and removes leaves that are not human
                    // devices; in the founding Commit also the Adds of every human device.
                    if was_stale {
                        return Err(refuse(
                            "stale-session",
                            "only a human device repairs a stale group",
                        ));
                    }
                    for add in &facts.adds {
                        match room.standing(&add.device) {
                            Standing::Helper => {}
                            Standing::Human if founding => {}
                            _ => return Err(bad("an opener adds helper devices only")),
                        }
                    }
                    if facts
                        .removes
                        .iter()
                        .any(|d| room.standing(d) == Standing::Human)
                    {
                        return Err(bad("an opener removes no human device"));
                    }
                }
                _ => return Err(bad("this device commits nothing in this group")),
            }
        }
    }
    if founding {
        if !facts.removes.is_empty() {
            return Err(bad("a founding Commit removes nobody"));
        }
        // 5.2.5: the first Commit of a main session adds its agent device
        let agents = leaves
            .iter()
            .filter(|d| room.standing(d) == Standing::Agent)
            .count();
        if kind == SessionKind::Main && agents != 1 {
            return Err(bad("a main session is founded with its agent device"));
        }
        if let Some(missing) = room.humans.iter().find(|h| !leaves.contains(h)) {
            return Err(bad(format!(
                "the founding Commit leaves out human device {}",
                crate::util::short(missing)
            )));
        }
    }
    check_session_leaves(kind, room, leaves)
}

/// What a room Commit changes besides the tree, read from `TrommiRoom` before and after.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RoomChange {
    pub humans_added: Vec<Device>,
    pub humans_removed: Vec<Device>,
    pub agents_added: Vec<Device>,
    pub agents_removed: Vec<Device>,
    pub recovery_keys_replaced: bool,
    pub joined_from_outside: Option<Device>,
}

/// 5.1.2 to 5.1.4 and 4.2: a Commit in the room group. `humans` is the limit in force (32, or 33 during a
/// recovery). Whether an Add or a new agent key is the outcome of an invite (12.1.7), and whether the recovery
/// keys may change in this request (8.6), is the caller's to check from the returned change.
pub fn check_room_commit(
    room: &RoomView,
    facts: &CommitFacts,
    humans: usize,
    agents: usize,
) -> Res<RoomChange> {
    let (Some(before), Some(after)) = (&facts.before.room, &facts.after.room) else {
        return Err(bad("the room group keeps its TrommiRoom"));
    };
    let mut change = RoomChange::default();
    match &facts.by {
        // every leaf of the room group is a human device
        By::Member(_) => {}
        By::External(joiner) => {
            if facts.before.leaves.contains(joiner) || room.standing(joiner) != Standing::Helper {
                return Err(bad(
                    "a join from outside brings a key the room has not seen",
                ));
            }
            change.joined_from_outside = Some(*joiner);
            change.humans_added.push(*joiner);
        }
    }
    if facts.adds.len() > 1 {
        return Err(bad("one new human device per Commit"));
    }
    for add in &facts.adds {
        change.humans_added.push(add.device);
    }
    change.humans_removed = facts.removes.clone();
    if before != after && !facts.changes_extensions {
        return Err(bad("the room's statement changed without a proposal"));
    }
    let (old, new): (BTreeSet<Device>, BTreeSet<Device>) = (agent_set(before), agent_set(after));
    change.agents_added = new.difference(&old).copied().collect();
    change.agents_removed = old.difference(&new).copied().collect();
    change.recovery_keys_replaced = before.recovery_signature_key != after.recovery_signature_key
        || before.recovery_hpke_key != after.recovery_hpke_key;
    if change.recovery_keys_replaced
        && (before.recovery_signature_key == after.recovery_signature_key
            || before.recovery_hpke_key == after.recovery_hpke_key)
    {
        return Err(bad("both recovery keys are replaced together"));
    }
    // 4.2: a key has one role for ever, and a revoked key never returns.
    for d in change.humans_added.iter().chain(change.agents_added.iter()) {
        if room.standing(d) != Standing::Helper {
            return Err(bad("a key that already has or had a role in the room"));
        }
    }
    let leaves: BTreeSet<Device> = facts.after.leaves.iter().copied().collect();
    if leaves.intersection(&new).next().is_some() {
        return Err(bad("a human device is not an agent device"));
    }
    // 8.1: neither recovery key equals a device's key
    for key in [&after.recovery_signature_key, &after.recovery_hpke_key] {
        if leaves.iter().any(|d| d[..] == key[..]) || new.iter().any(|d| d[..] == key[..]) {
            return Err(bad("a recovery key that is a device's key"));
        }
    }
    if leaves.len() > humans {
        return Err(refuse(
            "too-many",
            "the room holds its limit of human devices",
        ));
    }
    if new.len() > agents {
        return Err(refuse(
            "too-many",
            "the room holds its limit of agent devices",
        ));
    }
    Ok(change)
}

fn agent_set(room: &TrommiRoom) -> BTreeSet<Device> {
    room.agents.iter().copied().collect()
}
