//! Joining by link on the device (section 12.1), both sides, and signing in to the hub (12.3).
//!
//! **The inviter** opens an invite, accepts one Request, and commits the new device only through
//! [`Device::invite_confirm`], which takes the code and request hash the person confirmed and recomputes both
//! (12.1.4). The Commit goes into the outbox in the same write that finishes the invite, so a confirmation is
//! acted on once. What follows the Commit (the key handover, the Adds into the live session groups, an agent's
//! main session or its takeover) is listed by [`Device::invite_steps`] from the state of the groups, until it
//! is done.
//!
//! **The new device** makes its Request with a fresh KeyPackage whose private part is stored before the
//! Request is handed out, checks the Reveal, and then lets itself be taken in only as the Offer said: a human
//! device by a Welcome into that room, committed by the inviter, for the Request's KeyPackage (12.1.5); an
//! agent device by following the room group from the state the Offer names, where the Commit that enrols it
//! must be the inviter's (12.1.6).
//!
//! An invite's secret and nonce are stored with the invite and nowhere else.

use super::facts::Facts;
use super::{Device, Processed};
use crate::chain::GroupFacts;
use crate::codec::{Reader, Writer};
use crate::crypto::{SecretBytes, SigningKey};
use crate::error::Error;
use crate::hub_auth::{self, HubAddress, SignedHubAuth, CHALLENGE_LEN};
use crate::ids::{DeviceId, GroupId, Hash32, InviteId, SessionId};
use crate::invite::{
    self, CheckCode, InviteLink, InviteTerms, Inviter, Joiner, Role, SignedOffer, SignedRequest,
    SignedReveal, CONFIRM_MS, INVITE_LIFE_MS,
};
use crate::mls::group;
use crate::mls::key_package;
use crate::mls::profile::Cut;
use crate::store::{self, table, Batch, Storage};
use std::collections::BTreeSet;

/// How many invites a device holds open at once (section 16).
pub const MAX_OPEN_INVITES: usize = 16;

const SUB_INVITER: u8 = 0;
const SUB_FOLLOW_UP: u8 = 1;
const SUB_JOINER: u8 = 2;

/// Where an invite stands, beside what [`Inviter`] holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    Open = 1,
    Accepted = 2,
    Burned = 3,
    Done = 4,
}

fn damaged(what: &'static str) -> Error {
    Error::Storage(format!("{what} does not decode"))
}

fn inviter_key(invite: &InviteId) -> Vec<u8> {
    store::key(table::INVITE, &[&[SUB_INVITER], invite.as_bytes()])
}

fn follow_up_key(invite: &InviteId) -> Vec<u8> {
    store::key(table::INVITE, &[&[SUB_FOLLOW_UP], invite.as_bytes()])
}

fn joiner_key() -> Vec<u8> {
    store::key(table::INVITE, &[&[SUB_JOINER]])
}

/// A stored invite of the inviting device: its stage, the end of its Offer, and the invite itself.
fn read_inviter(stored: &[u8]) -> Result<(Stage, u64, Inviter), Error> {
    let mut reader = Reader::new(stored);
    let stage = match reader.u8()? {
        1 => Stage::Open,
        2 => Stage::Accepted,
        3 => Stage::Burned,
        4 => Stage::Done,
        _ => return Err(Error::BadFormat),
    };
    let expires_at = reader.u64()?;
    let inviter = Inviter::from_stored(reader.take(reader.remaining())?)?;
    Ok((stage, expires_at, inviter))
}

/// What is left to do for a device that was committed by link.
#[derive(Debug, Clone, PartialEq, Eq)]
struct FollowUp {
    role: Role,
    new_device: DeviceId,
    /// Zeros, or the session an agent device takes over.
    session_id: SessionId,
    /// The KeyPackage of the confirmed Request.
    key_package: Vec<u8>,
    /// Whether the key handover was sent.
    handed_over: bool,
}

impl FollowUp {
    fn encode(&self) -> Result<Vec<u8>, Error> {
        let mut writer = Writer::new();
        writer.u8(self.role as u8);
        writer.fixed(self.new_device.as_bytes());
        writer.fixed(self.session_id.as_bytes());
        writer.u8(u8::from(self.handed_over));
        writer.opaque(&self.key_package)?;
        Ok(writer.into_bytes())
    }

    fn decode(stored: &[u8]) -> Result<Self, Error> {
        let mut reader = Reader::new(stored);
        let role = match reader.u8()? {
            1 => Role::Human,
            2 => Role::Agent,
            _ => return Err(Error::BadFormat),
        };
        let new_device = reader.value()?;
        let session_id = reader.value()?;
        let handed_over = match reader.u8()? {
            0 => false,
            1 => true,
            _ => return Err(Error::BadFormat),
        };
        let key_package = reader.opaque()?.to_vec();
        reader.finish()?;
        Ok(Self {
            role,
            new_device,
            session_id,
            key_package,
            handed_over,
        })
    }
}

/// The new device's side of an invite, from its Request on.
struct Joining {
    /// Whether the Reveal was checked.
    revealed: bool,
    /// The reference of the Request's KeyPackage.
    key_package: Hash32,
    joiner: Joiner,
}

impl Joining {
    fn encode(&self) -> Result<Vec<u8>, Error> {
        let mut writer = Writer::new();
        writer.u8(u8::from(self.revealed));
        writer.fixed(self.key_package.as_bytes());
        writer.fixed(&self.joiner.to_stored()?);
        Ok(writer.into_bytes())
    }

    fn decode(stored: &[u8]) -> Result<Self, Error> {
        let mut reader = Reader::new(stored);
        let revealed = match reader.u8()? {
            0 => false,
            1 => true,
            _ => return Err(Error::BadFormat),
        };
        let key_package = reader.value()?;
        let joiner = Joiner::from_stored(reader.take(reader.remaining())?)?;
        Ok(Self {
            revealed,
            key_package,
            joiner,
        })
    }
}

/// Checks one stored entry of the table of invites when the device is opened.
pub(super) fn check_entry(rest: &[u8], value: &[u8]) -> Result<(), Error> {
    match rest.first() {
        Some(&SUB_INVITER) => read_inviter(value).map(|_| ()),
        Some(&SUB_FOLLOW_UP) => FollowUp::decode(value).map(|_| ()),
        Some(&SUB_JOINER) => Joining::decode(value).map(|_| ()),
        _ => Err(Error::BadFormat),
    }
}

/// The one place that hands a Request to [`Inviter::accept`], which verifies the KeyPackage it carries as 4.5
/// asks and reads the new device from it.
fn accept_request(
    inviter: &mut Inviter,
    key: &SigningKey,
    request: &SignedRequest,
    now_ms: u64,
) -> Result<invite::Accepted, Error> {
    inviter.accept(key, request, now_ms)
}

/// An invite as its inviter opened it.
#[derive(Debug)]
pub struct InviteOpened {
    /// The invite, as the hub knows it.
    pub invite_id: InviteId,
    /// The link to hand to the new device. It holds the invite's secret.
    pub link: SecretBytes,
    /// The last moment a Request is accepted.
    pub expires_at: u64,
    /// The Offer to publish.
    pub signed_offer: SignedOffer,
}

/// What the inviter publishes and shows once it accepted a Request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InviteAccepted {
    /// The new device: the signature key of the Request's KeyPackage.
    pub new_device: DeviceId,
    /// The code to show.
    pub code: CheckCode,
    /// The Reveal to publish.
    pub signed_reveal: SignedReveal,
    /// The hash of the accepted Request: with the code, what the person's confirmation names.
    pub request_hash: Hash32,
}

/// A confirmed invite whose Commit is in the outbox.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InviteConfirmed {
    /// The new device.
    pub new_device: DeviceId,
    /// What it was invited as.
    pub role: Role,
    /// For an agent device, the session it takes over.
    pub session_id: Option<SessionId>,
    /// The outbox entry of the Commit: the Add in the room group, or the change of `agents`.
    pub outbox_id: u64,
}

/// What is to do next for a device that was committed by link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InviteStep {
    /// Nothing yet: a Commit of this device waits for the hub or the log.
    Wait,
    /// The Commit that lets the device in was dropped for another one that took its epoch: build it again
    /// with [`Device::invite_recommit`].
    Commit,
    /// Send the key handover (7.1, 5.3.2) with [`Device::invite_handover`]; or, for a takeover without
    /// history, drop the step with [`Device::invite_forget`].
    Handover {
        /// The group it is sent in.
        group: GroupId,
        /// The device it is for.
        device: DeviceId,
    },
    /// Add the human device to this live session group (5.2.7): claim one KeyPackage of it at the hub and
    /// call [`Device::add_to_session`].
    AddToSession {
        /// The session group.
        group: GroupId,
        /// The device to add.
        device: DeviceId,
    },
    /// Found the agent device's main session (12.1.6) with [`Device::found_session`]: this KeyPackage, the
    /// one of the confirmed Request, and one of every other human device.
    FoundSession {
        /// The agent device.
        agent: DeviceId,
        /// Its KeyPackage.
        key_package: Vec<u8>,
    },
    /// Take the session over (5.3.1) with [`Device::clean_session`]: these Cuts, and this device with this
    /// KeyPackage as the replacement. The helper sessions of that session follow by the same call, each
    /// with a KeyPackage claimed at the hub.
    TakeOver {
        /// The main session's group.
        group: GroupId,
        /// The leaves to remove, each with its Cut.
        cuts: Vec<Cut>,
        /// The agent device that takes over.
        agent: DeviceId,
        /// Its KeyPackage.
        key_package: Vec<u8>,
    },
}

/// A Request as the new device made it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JoinRequest {
    /// The invite, by which the hub takes the Request.
    pub invite_id: InviteId,
    /// The Request to send.
    pub signed_request: SignedRequest,
    /// What this device is invited as.
    pub role: Role,
    /// The inviting device.
    pub inviter: DeviceId,
    /// The last moment the Request is accepted.
    pub expires_at: u64,
}

impl<S: Storage> Device<S> {
    fn inviter(&self, invite: &InviteId) -> Result<(Stage, u64, Inviter), Error> {
        let stored = self.stored(&inviter_key(invite)).ok_or(Error::NotFound)?;
        read_inviter(stored).map_err(|_| damaged("an invite"))
    }

    fn put_inviter(
        &mut self,
        batch: &mut Batch,
        stage: Stage,
        inviter: &Inviter,
    ) -> Result<(), Error> {
        let mut writer = Writer::new();
        writer.u8(stage as u8);
        writer.u64(inviter.offer().expires_at);
        writer.fixed(inviter.to_stored()?.expose());
        self.put_stored(
            batch,
            inviter_key(&inviter.offer().invite_id),
            writer.into_bytes(),
        );
        Ok(())
    }

    fn follow_ups(&self) -> Result<Vec<(InviteId, FollowUp)>, Error> {
        let prefix = store::key(table::INVITE, &[&[SUB_FOLLOW_UP]]);
        self.stored_under(&prefix)
            .into_iter()
            .map(|(key, value)| {
                let invite = InviteId::from_slice(key.get(prefix.len()..).unwrap_or_default())?;
                Ok((invite, FollowUp::decode(&value)?))
            })
            .collect::<Result<Vec<_>, Error>>()
            .map_err(|_| damaged("an invite's record"))
    }

    fn follow_up(&self, invite: &InviteId) -> Result<FollowUp, Error> {
        let stored = self.stored(&follow_up_key(invite)).ok_or(Error::NotFound)?;
        FollowUp::decode(stored).map_err(|_| damaged("an invite's record"))
    }

    fn joining_by_link(&self) -> Result<Option<Joining>, Error> {
        self.stored(&joiner_key())
            .map(|stored| Joining::decode(stored).map_err(|_| damaged("a join by link")))
            .transpose()
    }

    // ---- the inviter ----

    /// Opens an invite (12.1.2): for a human device, or for an agent device, which founds a new main session
    /// or with `session_id` takes that one over. `app` is the app's origin for the link, `hub` the hub the
    /// room lives on. Only a human device invites (`forbidden`); at most [`MAX_OPEN_INVITES`] are open at
    /// once (`too-many`); `not-found` for a session to take over that is no live main session this device
    /// holds. The invite lives ten minutes from `now_ms`.
    pub fn invite_open(
        &mut self,
        role: Role,
        session_id: Option<&SessionId>,
        app: &str,
        hub: &HubAddress,
        now_ms: u64,
    ) -> Result<InviteOpened, Error> {
        self.transact(|this, batch| {
            this.begin(now_ms);
            let room_group = this.room_group()?;
            let room = this.history()?.newest().clone();
            if let Some(session) = session_id {
                let main = this
                    .memory
                    .groups
                    .get(&GroupId::session(room_group.room_id(), *session))
                    .filter(|meta| !meta.removed && !meta.archived)
                    .and_then(|meta| meta.session)
                    .is_some_and(|session| session.parent.is_zero());
                if !main {
                    return Err(Error::NotFound);
                }
            }
            // Invites that ran out go, with what was left to do for them; the others are counted.
            let prefix = store::key(table::INVITE, &[&[SUB_INVITER]]);
            let mut open = 0usize;
            for (key, value) in this.stored_under(&prefix) {
                let (stage, expires_at, _) =
                    read_inviter(&value).map_err(|_| damaged("an invite"))?;
                let answered_until = expires_at.saturating_add(CONFIRM_MS);
                let counts = match stage {
                    Stage::Open => now_ms <= expires_at,
                    Stage::Accepted => now_ms <= answered_until,
                    Stage::Burned | Stage::Done => false,
                };
                if counts {
                    open = open.saturating_add(1);
                } else if now_ms > answered_until.saturating_add(INVITE_LIFE_MS) {
                    this.delete_stored(batch, key);
                }
            }
            if open >= MAX_OPEN_INVITES {
                return Err(Error::TooMany);
            }
            let terms = InviteTerms {
                app: app.to_owned(),
                hub: hub.clone(),
                room_id: room_group.room_id(),
                role,
                session_id: session_id.copied().unwrap_or(SessionId::ZERO),
                room_epoch: room.epoch,
                room_state: room.state,
            };
            let inviter = this
                .provider
                .with_entropy(|entropy| Inviter::open(&this.key, terms, now_ms, entropy))?;
            this.put_inviter(batch, Stage::Open, &inviter)?;
            Ok(InviteOpened {
                invite_id: inviter.offer().invite_id,
                link: inviter.link().to_text(),
                expires_at: inviter.offer().expires_at,
                signed_offer: inviter.signed_offer().clone(),
            })
        })
    }

    /// Accepts a Request for the invite (12.1.3): the first one with the link's MAC that matches the invite
    /// and is signed by the key of the KeyPackage it carries, which is verified as 4.5 asks. The invite is
    /// then used, and what to publish and to show is returned; asked again with the same Request, the same
    /// is returned. `not-found` for an invite this device does not hold; `invite-burned`, `invite-used`,
    /// `invite-expired`, `bad-format`, `bad-key-package`, `bad-invite`, `bad-signature` as
    /// [`Inviter::accept`] and the KeyPackage's check say. A refused Request leaves the invite as it was.
    pub fn invite_accept(
        &mut self,
        invite_id: &InviteId,
        request: &SignedRequest,
        now_ms: u64,
    ) -> Result<InviteAccepted, Error> {
        self.transact(|this, batch| {
            this.begin(now_ms);
            let (_, _, mut inviter) = this.inviter(invite_id)?;
            let again = inviter.accepted(&this.key)?.filter(|accepted| {
                invite::request_hash(request).ok() == Some(accepted.request_hash)
            });
            let accepted = match again {
                Some(accepted) => accepted,
                None => {
                    let accepted = accept_request(&mut inviter, &this.key, request, now_ms)?;
                    this.put_inviter(batch, Stage::Accepted, &inviter)?;
                    accepted
                }
            };
            Ok(InviteAccepted {
                new_device: accepted.new_device,
                code: accepted.code,
                signed_reveal: accepted.reveal,
                request_hash: accepted.request_hash,
            })
        })
    }

    /// The person compared the six emoji (12.1.4). `matches` false: the invite is burned, and none comes
    /// back. True: `code` and `request_hash` are what this device showed them for; both are computed again
    /// from the accepted Request, and only if they are the same (`code-not-confirmed` otherwise) is the new
    /// device committed: the Add of its KeyPackage in the room group for a human device, the change of
    /// `agents` for an agent device (with a takeover: the session's present agent device goes out of
    /// `agents` in the same Commit, 5.3.1). The Commit is put in the outbox in the write that finishes the
    /// invite; [`Device::invite_steps`] says what follows.
    ///
    /// Also refused: `invite-expired` more than five minutes after the Request was accepted; `invite-burned`,
    /// `invite-used`, `bad-invite` (no Request stands accepted); and whatever the Commit meets (`busy` while
    /// another Commit of this device in the room group waits, `too-many`, `bad-commit` for a key that is or
    /// was a device of the room). A refusal leaves the invite as it was.
    pub fn invite_confirm(
        &mut self,
        invite_id: &InviteId,
        code: &CheckCode,
        request_hash: &Hash32,
        matches: bool,
        now_ms: u64,
    ) -> Result<Option<InviteConfirmed>, Error> {
        self.transact(|this, batch| {
            this.begin(now_ms);
            let (_, _, mut inviter) = this.inviter(invite_id)?;
            if !matches {
                inviter.burn();
                this.put_inviter(batch, Stage::Burned, &inviter)?;
                return Ok(None);
            }
            let confirmed = inviter.confirm(code, request_hash, now_ms)?;
            inviter.check_confirmed(&confirmed)?;
            let follow_up = FollowUp {
                role: confirmed.role(),
                new_device: *confirmed.new_device(),
                session_id: *confirmed.session_id(),
                key_package: confirmed.key_package().to_vec(),
                handed_over: false,
            };
            let outbox_id = this.commit_invited(batch, &follow_up, now_ms)?;
            inviter.finish()?;
            this.put_inviter(batch, Stage::Done, &inviter)?;
            this.put_stored(batch, follow_up_key(invite_id), follow_up.encode()?);
            Ok(Some(InviteConfirmed {
                new_device: follow_up.new_device,
                role: follow_up.role,
                session_id: Some(follow_up.session_id).filter(|session| !session.is_zero()),
                outbox_id,
            }))
        })
    }

    /// The Commit that lets a device in as the outcome of its confirmed invite.
    fn commit_invited(
        &mut self,
        batch: &mut Batch,
        invited: &FollowUp,
        now_ms: u64,
    ) -> Result<u64, Error> {
        let device = invited.new_device;
        match invited.role {
            Role::Human => self.add_human(batch, &device, &invited.key_package, now_ms),
            Role::Agent => {
                key_package::verify_key_package_of(&invited.key_package, &device)?;
                let history = self.history()?;
                let room = history.newest();
                if room.is_human(&device)
                    || room.is_agent(&device)
                    || history.is_revoked(&device, room.epoch)
                {
                    return Err(Error::BadCommit);
                }
                // 5.3.1 (a): a takeover begins by taking the session's present agent device out.
                let replaced: Vec<DeviceId> = self
                    .seat_now(&invited.session_id)
                    .filter(|seat| room.is_agent(seat))
                    .into_iter()
                    .collect();
                self.set_agents(batch, &[device], &replaced, now_ms)
            }
        }
    }

    /// The agent leaf of the main session `session` as this device holds it.
    fn seat_now(&self, session: &SessionId) -> Option<DeviceId> {
        let room = self.memory.record.room?;
        let group = GroupId::session(room, *session);
        let epoch = self.newest_epoch(&group)?;
        Facts(self).seat(&group, epoch).ok().flatten()
    }

    /// Builds the Commit of a confirmed invite again, after another Commit took its epoch
    /// ([`InviteStep::Commit`]).
    pub fn invite_recommit(&mut self, invite_id: &InviteId, now_ms: u64) -> Result<u64, Error> {
        self.transact(|this, batch| {
            this.begin(now_ms);
            let follow_up = this.follow_up(invite_id)?;
            if this.next_step(&follow_up)? != Some(InviteStep::Commit) {
                return Err(Error::Busy);
            }
            this.commit_invited(batch, &follow_up, now_ms)
        })
    }

    /// What is to do next for every device this one committed by link, until all of it is done. The steps
    /// are read from the state of the groups: a step that was taken is not named again.
    pub fn invite_steps(&self) -> Result<Vec<(InviteId, InviteStep)>, Error> {
        self.owner()?;
        let mut steps = Vec::new();
        for (invite, follow_up) in self.follow_ups()? {
            if let Some(step) = self.next_step(&follow_up)? {
                steps.push((invite, step));
            }
        }
        Ok(steps)
    }

    fn next_step(&self, invited: &FollowUp) -> Result<Option<InviteStep>, Error> {
        let Some(room_id) = self.memory.record.room else {
            return Ok(None);
        };
        let room_group = GroupId::room(room_id);
        let history = self.history()?;
        let room = history.newest();
        let device = invited.new_device;
        let waits = |group: &GroupId| {
            self.memory
                .groups
                .get(group)
                .is_some_and(|meta| meta.pending.is_some() || meta.founding)
        };
        let is_in = match invited.role {
            Role::Human => room.is_human(&device),
            Role::Agent => room.is_agent(&device),
        };
        if !is_in {
            // Out again for good: nothing is left to do for it.
            if history.is_revoked(&device, room.epoch) || !self.is_human() {
                return Ok(None);
            }
            return Ok(Some(if waits(&room_group) {
                InviteStep::Wait
            } else {
                InviteStep::Commit
            }));
        }
        match invited.role {
            Role::Human => {
                let handed =
                    invited.handed_over || self.memory.sent.contains(&(device, room_group));
                if !handed {
                    return Ok(Some(if waits(&room_group) {
                        InviteStep::Wait
                    } else {
                        InviteStep::Handover {
                            group: room_group,
                            device,
                        }
                    }));
                }
                let mut waiting = false;
                for (group, meta) in &self.memory.groups {
                    if meta.session.is_none() || meta.removed || meta.archived || meta.distrusted {
                        continue;
                    }
                    if self.leaves_now(group)?.contains(&device) {
                        continue;
                    }
                    if waits(group) {
                        waiting = true;
                    } else {
                        return Ok(Some(InviteStep::AddToSession {
                            group: *group,
                            device,
                        }));
                    }
                }
                Ok(waiting.then_some(InviteStep::Wait))
            }
            Role::Agent if invited.session_id.is_zero() => {
                let mut founding = false;
                for (group, meta) in &self.memory.groups {
                    let main = meta.session.is_some_and(|session| session.parent.is_zero());
                    if !main || meta.removed || meta.archived {
                        continue;
                    }
                    if meta.founding {
                        founding = true;
                    } else if self.leaves_now(group)?.contains(&device) {
                        return Ok(None);
                    }
                }
                Ok(Some(if founding {
                    InviteStep::Wait
                } else {
                    InviteStep::FoundSession {
                        agent: device,
                        key_package: invited.key_package.clone(),
                    }
                }))
            }
            Role::Agent => {
                let group = GroupId::session(room_id, invited.session_id);
                let Some(meta) = self.memory.groups.get(&group).filter(|meta| !meta.removed) else {
                    return Ok(None);
                };
                if self.leaves_now(&group)?.contains(&device) {
                    return Ok((!invited.handed_over
                        && !self.memory.sent.contains(&(device, group)))
                    .then_some(InviteStep::Handover { group, device }));
                }
                if waits(&group) {
                    return Ok(Some(InviteStep::Wait));
                }
                let chains = self.chains(&group)?;
                let leaves = self.leaves_now(&group)?;
                let cuts = self
                    .disallowed(meta, &leaves, &self.known())
                    .into_iter()
                    .map(|leaf| {
                        let head = chains.head(&leaf);
                        Cut {
                            device: leaf,
                            seq: head.seq,
                            hash: head.hash,
                        }
                    })
                    .collect();
                Ok(Some(InviteStep::TakeOver {
                    group,
                    cuts,
                    agent: device,
                    key_package: invited.key_package.clone(),
                }))
            }
        }
    }

    /// The leaves of `group` in the epoch this device stands in.
    fn leaves_now(&self, group: &GroupId) -> Result<BTreeSet<DeviceId>, Error> {
        let Some(epoch) = self.newest_epoch(group) else {
            return Ok(BTreeSet::new());
        };
        Ok(self
            .epoch_facts(group, epoch)?
            .map(|facts| facts.leaves.into_iter().map(|(leaf, _)| leaf).collect())
            .unwrap_or_default())
    }

    /// Sends the key handover that [`InviteStep::Handover`] names (7.1, 5.3.2), and notes that it was sent.
    /// Returns the outbox ids of its messages.
    pub fn invite_handover(&mut self, invite_id: &InviteId) -> Result<Vec<u64>, Error> {
        self.owner()?;
        let mut follow_up = self.follow_up(invite_id)?;
        let Some(InviteStep::Handover { group, device }) = self.next_step(&follow_up)? else {
            return Err(Error::Busy);
        };
        let sent = self.send_handover(&group, &device)?;
        follow_up.handed_over = true;
        self.transact(|this, batch| {
            this.begin(0);
            this.put_stored(batch, follow_up_key(invite_id), follow_up.encode()?);
            Ok(())
        })?;
        Ok(sent)
    }

    /// Drops what was left to do for an invite: a takeover without history sends no handover (5.3.2).
    pub fn invite_forget(&mut self, invite_id: &InviteId) -> Result<(), Error> {
        self.transact(|this, batch| {
            this.begin(0);
            this.follow_up(invite_id)?;
            this.delete_stored(batch, follow_up_key(invite_id));
            Ok(())
        })
    }

    // ---- the new device ----

    /// Checks the Offer served for `link` and answers it (12.1.2) with a fresh KeyPackage of this device,
    /// whose private part is stored, with the Request, before the Request is returned. A device joins one
    /// room, once: `room-exists` for a device that holds one. `bad-format`, `newer-version` for the link;
    /// `bad-invite`, `bad-signature`, `invite-expired` for the Offer.
    pub fn join_request(
        &mut self,
        link: &str,
        signed_offer: &SignedOffer,
        now_ms: u64,
    ) -> Result<JoinRequest, Error> {
        self.transact(|this, batch| {
            this.begin(now_ms);
            if this.memory.record.room.is_some() {
                return Err(Error::RoomExists);
            }
            let link = InviteLink::parse(link)?;
            let key_package = this.make_key_package(batch, now_ms, false)?;
            let (joiner, signed_request) =
                Joiner::request(&link, signed_offer, &this.key, &key_package, now_ms)?;
            let offer = joiner.offer().clone();
            let joining = Joining {
                revealed: false,
                key_package: key_package::reference(&key_package)?,
                joiner,
            };
            this.put_stored(batch, joiner_key(), joining.encode()?);
            Ok(JoinRequest {
                invite_id: offer.invite_id,
                signed_request,
                role: offer.role,
                inviter: offer.inviter,
                expires_at: offer.expires_at,
            })
        })
    }

    /// Checks the Reveal (12.1.3) and returns the code to show. `not-found` without a Request of this
    /// device; `bad-format`, `bad-signature`, `bad-invite` as [`Joiner::reveal`] says.
    pub fn join_reveal(&mut self, signed_reveal: &SignedReveal) -> Result<CheckCode, Error> {
        self.transact(|this, batch| {
            this.begin(0);
            let mut joining = this.joining_by_link()?.ok_or(Error::NotFound)?;
            let code = joining.joiner.reveal(signed_reveal)?;
            joining.revealed = true;
            this.put_stored(batch, joiner_key(), joining.encode()?);
            Ok(code)
        })
    }

    /// An invited agent device starts following the room group (12.1.6, 4.4) from the GroupInfo of the
    /// Offer's `room_epoch`, which must hash to the Offer's `room_state` (`bad-format` otherwise). It takes
    /// itself for enrolled only by the inviter's Commit: when the log brings the Commit that puts it into
    /// `agents`, [`Device::process_log_entry`] refuses one made by anyone else (`bad-invite`). `not-found`
    /// without a checked Reveal of an invite for an agent device.
    pub fn join_observe(&mut self, group_info: &[u8]) -> Result<(), Error> {
        self.owner()?;
        let joining = self.joining_by_link()?.filter(|joining| joining.revealed);
        let offer = joining
            .as_ref()
            .map(|joining| joining.joiner.offer())
            .filter(|offer| offer.role == Role::Agent)
            .ok_or(Error::NotFound)?;
        let (room, state) = (offer.room_id, offer.room_state);
        if GroupId::room(room)
            != crate::mls::observer::Observer::follow_room(group_info, Some(&state))?.group()
        {
            return Err(Error::WrongRoom);
        }
        self.observe_room(group_info, Some(&state))
    }

    /// Joins the room group from the Welcome that answers this device's Request (12.1.5). What the Welcome
    /// must be is read from the stored invite, not given by the caller: for the room of the Offer, committed
    /// by its inviter, for the Request's KeyPackage (`bad-invite` otherwise). `not-found` without a Request
    /// of this device. Otherwise as [`Device::join_welcome`].
    pub fn join_invited(&mut self, welcome: &[u8], now_ms: u64) -> Result<super::Joined, Error> {
        self.owner()?;
        let joining = self.joining_by_link()?.ok_or(Error::NotFound)?;
        let offer = joining.joiner.offer();
        let expected = super::WelcomeExpectation {
            room: offer.room_id,
            committer: Some(offer.inviter),
        };
        self.join_welcome(welcome, &expected, now_ms)
    }

    /// A Welcome into the room group is taken only as the invite said (12.1.5): for the room of the Offer,
    /// committed by its inviter, for the KeyPackage of this device's Request, after the Reveal was checked
    /// (`bad-invite` otherwise). The invite is then done. Without an invite a device takes no such Welcome,
    /// except under the cargo feature `vectors`, where the scenario tests add devices without one.
    pub(super) fn invited(
        &mut self,
        batch: &mut Batch,
        room_group: &GroupId,
        added_by: &DeviceId,
        welcome: &[u8],
    ) -> Result<(), Error> {
        let Some(joining) = self.joining_by_link()? else {
            return if cfg!(feature = "vectors") {
                Ok(())
            } else {
                Err(Error::BadInvite)
            };
        };
        let offer = joining.joiner.offer();
        let for_request = group::welcome_recipients(welcome)?
            .iter()
            .any(|reference| reference.as_slice() == joining.key_package.as_bytes());
        if !joining.revealed
            || offer.role != Role::Human
            || GroupId::room(offer.room_id) != *room_group
            || offer.inviter != *added_by
            || !for_request
        {
            return Err(Error::BadInvite);
        }
        self.delete_stored(batch, joiner_key());
        Ok(())
    }

    /// A device that answered an invite follows the room group only as that invite says (12.1.6): after the
    /// Reveal was checked, as an agent device, from the state the Offer names (`bad-invite` otherwise).
    pub(super) fn observing_as_invited(
        &self,
        expected_state: Option<&Hash32>,
        history: Option<&crate::mls::rules::RoomHistory>,
    ) -> Result<(), Error> {
        // A state that holds this device in `agents` already brings an enrolment whose Commit the device
        // never saw: it takes none that way, except under the cargo feature `vectors`.
        let enrolled = history.is_some_and(|history| history.newest().is_agent(&self.id));
        let joining = self.joining_by_link()?;
        if enrolled && (joining.is_some() || !cfg!(feature = "vectors")) {
            return Err(Error::BadInvite);
        }
        let Some(joining) = joining else {
            return Ok(());
        };
        let offer = joining.joiner.offer();
        if !joining.revealed
            || offer.role != Role::Agent
            || expected_state != Some(&offer.room_state)
        {
            return Err(Error::BadInvite);
        }
        Ok(())
    }

    /// An invited agent device joins no session group before it saw its inviter enrol it: `room-behind`,
    /// the room group's log is processed first.
    pub(super) fn enrolment_verified(&self) -> Result<(), Error> {
        match self.joining_by_link()? {
            Some(joining) if joining.joiner.offer().role == Role::Agent => Err(Error::RoomBehind),
            _ => Ok(()),
        }
    }

    /// An invited agent device accepts its enrolment only from its inviter (12.1.6): a Commit of the room
    /// group that puts this device into `agents` and was made by another device is `bad-invite`, and the
    /// device does not follow it. With the inviter's Commit the invite is done.
    pub(super) fn enrolled_by_inviter(
        &mut self,
        batch: &mut Batch,
        processed: &Processed,
    ) -> Result<(), Error> {
        let Processed::Observed(facts) = processed else {
            return Ok(());
        };
        if !facts.group.is_room() {
            return Ok(());
        }
        let history = self.history()?;
        let now = history.newest();
        let before = now
            .epoch
            .checked_sub(1)
            .and_then(|epoch| history.at(epoch))
            .is_some_and(|state| state.is_agent(&self.id));
        if !now.is_agent(&self.id) || before {
            return Ok(());
        }
        // This Commit enrols this device. Without an invite it takes no enrolment, except under the cargo
        // feature `vectors`, where the scenario tests enrol devices without one.
        let Some(joining) = self.joining_by_link()? else {
            return if cfg!(feature = "vectors") {
                Ok(())
            } else {
                Err(Error::BadInvite)
            };
        };
        let offer = joining.joiner.offer();
        if !joining.revealed || offer.role != Role::Agent || facts.committer != offer.inviter {
            return Err(Error::BadInvite);
        }
        self.delete_stored(batch, joiner_key());
        Ok(())
    }

    // ---- signing in to the hub ----

    /// Answers the hub's `challenge` (12.3) with this device's key, for the room it belongs to at `hub`.
    /// `no-room` for a device without a room.
    pub fn hub_sign_in(
        &self,
        hub: &HubAddress,
        challenge: [u8; CHALLENGE_LEN],
    ) -> Result<SignedHubAuth, Error> {
        self.owner()?;
        let room = self.memory.record.room.ok_or(Error::NoRoom)?;
        hub_auth::sign(&self.key, room, hub, challenge)
    }
}
