//! Recovery at the edge (section 8): what the hub serves a device that comes with the recovery code, as plain
//! records, and the two calls that need the code but no device.
//!
//! The code is 32 bytes that the host holds only while it founds a room, joins with the code, recovers or
//! replaces the code; a device keeps nothing of it but the key that authenticates the room's sealed keys.

use crate::records::{room_id, SignedHubAuth};
use crate::{CoreError, ErrorCode};
use trommi_core::crypto::Secret;
use trommi_core::hub_auth::{self, HubAddress, CHALLENGE_LEN};
use trommi_core::recovery::{self as core, RecoveryKeys};

/// The keys of the recovery code `code`, 32 bytes.
pub(crate) fn keys(code: &[u8]) -> Result<RecoveryKeys, CoreError> {
    Ok(RecoveryKeys::from_code(Secret::<32>::from_slice(code)?)?)
}

record! {
    /// One Commit of a group's log, as the hub serves it.
    pub struct ServedCommit {
        /// The room's change number of the Commit.
        pub change: u64,
        /// The Commit.
        pub commit: Vec<u8>,
        /// The RecoveryAuth stored beside a join from outside.
        pub recovery_auth: Option<Vec<u8>>,
    }
}

record! {
    /// One group as the hub serves it to a device that verifies it from its founding. Nothing in it is trusted.
    pub struct ServedGroup {
        /// The founding GroupInfo (epoch 0).
        pub founding: Vec<u8>,
        /// Every Commit since, in the hub's order.
        pub commits: Vec<ServedCommit>,
        /// The GroupInfo the hub offers as current.
        pub current: Vec<u8>,
    }
}

record! {
    /// A room as the hub serves it to a device that joins with the code. Nothing in it is trusted.
    pub struct ServedRoom {
        /// The room, 32 bytes.
        pub room: Vec<u8>,
        /// The room group.
        pub group: ServedGroup,
        /// The GroupInfo of the anchor's epoch ([`recovery_anchor`] names the epoch).
        pub anchor: Vec<u8>,
        /// Every SealedKey of the room.
        pub rows: Vec<Vec<u8>>,
        /// Every RecoveryLink of the room.
        pub links: Vec<Vec<u8>>,
        /// Every live session group, main sessions before helper sessions.
        pub sessions: Vec<ServedGroup>,
    }
}

/// A served group as the core reads it, borrowed from the record.
fn group<'a>(
    served: &'a ServedGroup,
    commits: &'a [core::ServedCommit<'a>],
) -> core::ServedGroup<'a> {
    core::ServedGroup {
        founding: &served.founding,
        commits,
        current: &served.current,
    }
}

fn commits(served: &ServedGroup) -> Vec<core::ServedCommit<'_>> {
    served
        .commits
        .iter()
        .map(|commit| core::ServedCommit {
            change: commit.change,
            commit: &commit.commit,
            recovery_auth: commit.recovery_auth.as_deref(),
        })
        .collect()
}

/// Runs `call` with a served group as the core reads it.
pub(crate) fn with_group<R>(
    served: &ServedGroup,
    call: impl FnOnce(&core::ServedGroup<'_>) -> Result<R, CoreError>,
) -> Result<R, CoreError> {
    let commits = commits(served);
    call(&group(served, &commits))
}

/// Runs `call` with a served room as the core reads it.
pub(crate) fn with_room<R>(
    served: &ServedRoom,
    call: impl FnOnce(&core::ServedRoom<'_>) -> Result<R, CoreError>,
) -> Result<R, CoreError> {
    let room_commits = commits(&served.group);
    let session_commits: Vec<_> = served.sessions.iter().map(commits).collect();
    let sessions: Vec<_> = served
        .sessions
        .iter()
        .zip(&session_commits)
        .map(|(session, commits)| group(session, commits))
        .collect();
    call(&core::ServedRoom {
        room: room_id(&served.room)?,
        group: group(&served.group, &room_commits),
        anchor: &served.anchor,
        rows: &served.rows,
        links: &served.links,
        sessions: &sessions,
    })
}

record! {
    /// A session group that did not verify from its founding and is not joined.
    pub struct UnverifiedSession {
        /// Its place among the sessions that were served, from 0.
        pub index: u32,
        /// Why it does not verify.
        pub code: ErrorCode,
    }
}

record! {
    /// What a join with the code, or a recovery, leaves behind.
    pub struct CodeJoin {
        /// The outbox entries to post, in order. The device's state changes only when the hub accepted the last.
        pub outbox: Vec<u64>,
        /// A recovery key whose link to the code it replaced the hub did not serve: the content of the older
        /// codes' time stays closed. The finding is `withheld`.
        pub missing_link: Option<Vec<u8>>,
        /// The live session groups that did not verify: they are not joined.
        pub unverified: Vec<UnverifiedSession>,
    }
}

impl From<trommi_core::device::CodeJoin> for CodeJoin {
    fn from(join: trommi_core::device::CodeJoin) -> Self {
        Self {
            outbox: join.outbox,
            missing_link: join.missing_link.map(|key| key.to_vec()),
            unverified: join
                .unverified
                .into_iter()
                .map(|(index, error)| UnverifiedSession {
                    index: u32::try_from(index).unwrap_or(u32::MAX),
                    code: CoreError::from(error).code(),
                })
                .collect(),
        }
    }
}

record! {
    /// One envelope of a chain as the hub's chain route serves it.
    pub struct ServedEnvelope {
        /// The envelope, in pruned or in full form.
        pub bytes: Vec<u8>,
        /// The hub's change number it was taken under.
        pub change: u64,
        /// The code of a void record.
        pub void_code: Option<ErrorCode>,
    }
}

/// Runs `call` with served envelopes as the core reads them.
pub(crate) fn with_chains<R>(
    chains: &[ServedEnvelope],
    call: impl FnOnce(&[trommi_core::device::ServedEnvelope<'_>]) -> Result<R, CoreError>,
) -> Result<R, CoreError> {
    let codes = chains
        .iter()
        .map(|envelope| crate::content::void_code(envelope.void_code))
        .collect::<Result<Vec<_>, _>>()?;
    let served: Vec<_> = chains
        .iter()
        .zip(&codes)
        .map(|(envelope, code)| trommi_core::device::ServedEnvelope {
            bytes: &envelope.bytes,
            change: envelope.change,
            void_code: code.as_ref(),
        })
        .collect();
    call(&served)
}

record! {
    /// What learning a group's past recorded.
    pub struct Learned {
        /// How many epochs were recorded; 0 when there was nothing to learn.
        pub epochs: u64,
    }
}

/// The Commits of a served history as the core reads them.
pub(crate) fn with_commits<R>(
    served: &[ServedCommit],
    call: impl FnOnce(&[core::ServedCommit<'_>]) -> Result<R, CoreError>,
) -> Result<R, CoreError> {
    let commits: Vec<_> = served
        .iter()
        .map(|commit| core::ServedCommit {
            change: commit.change,
            commit: &commit.commit,
            recovery_auth: commit.recovery_auth.as_deref(),
        })
        .collect();
    call(&commits)
}

record! {
    /// The leaves a recovery removes from one group. The caller fetches each one's chain there and hands the
    /// envelopes to `recover`, which verifies them and takes each Cut from the head it verified.
    pub struct Removals {
        /// The group.
        pub group: Vec<u8>,
        /// The devices whose leaves go.
        pub devices: Vec<Vec<u8>>,
    }
}

record! {
    /// A recovery, prepared: the new code and who is removed. The device keeps the rest until `recover`.
    secret pub struct RecoveryPlan {
        /// The new recovery code, 32 bytes: for the account's new sealed copies, and shown to the person.
        pub new_code: Vec<u8>,
        /// The leaves the recovery removes, per group, main sessions before helper sessions.
        pub removals: Vec<Removals>,
    }
}

/// The removals of a checked room, as records.
pub(crate) fn removals(checked: &core::CheckedRoom) -> Result<Vec<Removals>, CoreError> {
    Ok(core::removals(checked)?
        .into_iter()
        .map(|(group, devices)| Removals {
            group: group.as_bytes().to_vec(),
            devices: devices
                .iter()
                .map(|device| device.as_bytes().to_vec())
                .collect(),
        })
        .collect())
}

record! {
    /// The anchor of a join with the code: the newest epoch of the room group that a human device vouched for
    /// under this code.
    pub struct Anchor {
        /// The room group.
        pub group: Vec<u8>,
        /// The epoch whose GroupInfo the hub is asked for.
        pub epoch: u64,
        /// The hash that names that GroupInfo, 32 bytes.
        pub group_info: Vec<u8>,
    }
}

/// The anchor of a join with the code, from the room's SealedKeys as the hub lists them: `wrong-recovery` when
/// none of them is vouched for under this code, `equivocation` when two name different GroupInfos for the
/// newest epoch.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn recovery_anchor(
    recovery_code: Vec<u8>,
    room: Vec<u8>,
    rows: Vec<Vec<u8>>,
) -> Result<Anchor, CoreError> {
    let anchor = core::select_anchor(&keys(&recovery_code)?, &room_id(&room)?, &rows)?;
    Ok(Anchor {
        group: anchor.group.as_bytes().to_vec(),
        epoch: anchor.epoch,
        group_info: anchor.group_info.as_bytes().to_vec(),
    })
}

/// Signs the hub's sign-in challenge under the recovery code, for a device that is not yet a member: it may
/// read what a join with the code needs and post that join. `hub` is the hub's canonical address.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn recovery_sign_in(
    recovery_code: Vec<u8>,
    room: Vec<u8>,
    hub: String,
    challenge: Vec<u8>,
) -> Result<SignedHubAuth, CoreError> {
    let challenge: [u8; CHALLENGE_LEN] = challenge
        .as_slice()
        .try_into()
        .map_err(|_| CoreError::bad_format("the challenge is not 32 bytes"))?;
    let keys = keys(&recovery_code)?;
    let signed = hub_auth::sign(
        keys.signing_key(),
        room_id(&room)?,
        &HubAddress::parse(&hub)?,
        challenge,
    )?;
    Ok(SignedHubAuth {
        auth: signed.auth,
        signature: signed.signature,
    })
}
