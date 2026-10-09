//! The hub's side of stored content (9.0.8, 9.0.11): it runs the checks every device runs, without the body,
//! through `chain::hub_take`, keeps what it takes under the room's change counter, stores what it refuses
//! after check 6 as a void record, and serves all of it. A test plays a hostile hub by changing what it hands
//! on from what is served here.

use super::Hub;
use std::collections::BTreeMap;
use trommi_core::chain::{self, Chains, EpochEnd, GroupFacts, Head, Outcome, Role};
use trommi_core::codec;
use trommi_core::crypto::Secret;
use trommi_core::device::Accepted;
use trommi_core::envelope::{Envelope, Header};
use trommi_core::ids::{DeviceId, GroupId, Hash32, RoomId};
use trommi_core::mls::profile::CommitNote;
use trommi_core::mls::rules::Parent;
use trommi_core::objects::{self, Objects};
use trommi_core::store::OutboxEntry;
use trommi_core::Error;

/// One envelope as the hub keeps and serves it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredEnvelope {
    /// The change number it was taken under.
    pub change: u64,
    /// Its header.
    pub header: Header,
    /// Its `envelope_hash`.
    pub hash: Hash32,
    /// The envelope: in full, or pruned for a void record.
    pub bytes: Vec<u8>,
    /// The code of a void record.
    pub void_code: Option<Error>,
    /// Whether it lies beyond its sender's Cut: served on the chain route only.
    pub cut: bool,
}

impl StoredEnvelope {
    /// The pruned form, as the chain route serves it.
    pub fn pruned(&self) -> Vec<u8> {
        Envelope::decode(&self.bytes)
            .and_then(|envelope| envelope.prune())
            .and_then(|pruned| pruned.encode())
            .expect("a stored envelope prunes")
    }
}

/// One entry of the room's changes, as `GET /v2/changes` serves them in order.
#[derive(Debug, Clone)]
pub enum Change {
    /// A Commit or an application message of a group's log.
    Log(crate::hub::LogItem),
    /// An envelope.
    Envelope(Box<StoredEnvelope>),
}

impl Change {
    /// Its change number.
    pub fn change(&self) -> u64 {
        match self {
            Self::Log(item) => item.change,
            Self::Envelope(stored) => stored.change,
        }
    }
}

#[derive(Debug, Clone, Default)]
struct Epoch {
    leaves: BTreeMap<DeviceId, Role>,
    seat: Option<DeviceId>,
    end: Option<EpochEnd>,
}

/// What the hub keeps for stored content.
#[derive(Default)]
pub struct Content {
    epochs: BTreeMap<(GroupId, u64), Epoch>,
    cuts: BTreeMap<(GroupId, DeviceId), Head>,
    chains: BTreeMap<GroupId, Chains>,
    objects: BTreeMap<GroupId, Objects>,
    /// Every envelope the hub took, in the order of its change numbers.
    pub envelopes: Vec<StoredEnvelope>,
    /// How much of the log was read for Cuts.
    log_read: usize,
}

/// The `CommitNote` of a Commit as it travels: the `authenticated_data` of its `PublicMessage`.
fn commit_note(bytes: &[u8]) -> Option<CommitNote> {
    fn vector(bytes: &[u8]) -> Option<(&[u8], &[u8])> {
        let first = *bytes.first()?;
        let width = 1usize << (first >> 6);
        let mut len = usize::from(first & 0x3F);
        for byte in bytes.get(1..width)? {
            len = (len << 8) | usize::from(*byte);
        }
        let rest = bytes.get(width..)?;
        (rest.len() >= len).then(|| rest.split_at(len))
    }
    // The version and the wire format, then the group id, the epoch and the sender.
    let (_, rest) = vector(bytes.get(4..)?)?;
    let rest = rest.get(8..)?;
    let rest = match *rest.first()? {
        1 => rest.get(5..)?,
        _ => rest.get(1..)?,
    };
    let (note, _) = vector(rest)?;
    codec::decode(note, note.len()).ok()
}

struct Facts<'a>(&'a Hub);

impl GroupFacts for Facts<'_> {
    fn room(&self) -> RoomId {
        self.0
            .epochs
            .keys()
            .next()
            .map_or(RoomId::ZERO, GroupId::room_id)
    }

    fn processed_epoch(&self, group: &GroupId) -> Result<Option<u64>, Error> {
        Ok(self.0.epoch(group))
    }

    fn leaf_role(
        &self,
        group: &GroupId,
        epoch: u64,
        device: &DeviceId,
    ) -> Result<Option<Role>, Error> {
        Ok(self
            .0
            .content
            .epochs
            .get(&(*group, epoch))
            .and_then(|facts| facts.leaves.get(device).copied()))
    }

    fn seat(&self, group: &GroupId, epoch: u64) -> Result<Option<DeviceId>, Error> {
        Ok(self
            .0
            .content
            .epochs
            .get(&(*group, epoch))
            .and_then(|facts| facts.seat))
    }

    fn cut(&self, group: &GroupId, device: &DeviceId) -> Result<Option<Head>, Error> {
        Ok(self.0.content.cuts.get(&(*group, *device)).copied())
    }

    fn epoch_end(&self, group: &GroupId, epoch: u64) -> Result<Option<EpochEnd>, Error> {
        Ok(self
            .0
            .content
            .epochs
            .get(&(*group, epoch))
            .and_then(|facts| facts.end))
    }

    fn is_stale(&self, group: &GroupId) -> Result<bool, Error> {
        if group.is_room() {
            return Ok(false);
        }
        Ok(!self.0.stale_leaves(group)?.is_empty())
    }

    fn is_human_now(&self, device: &DeviceId) -> Result<bool, Error> {
        Ok(self
            .0
            .history()
            .is_some_and(|history| history.newest().is_human(device)))
    }

    fn content_key(&self, _: &GroupId, _: u64) -> Result<Option<Secret<32>>, Error> {
        Ok(None)
    }
}

impl chain::ChainRecords for Facts<'_> {
    fn accepted_hash(
        &self,
        group: &GroupId,
        sender: &DeviceId,
        seq: u64,
    ) -> Result<Option<Hash32>, Error> {
        Ok(self
            .0
            .content
            .envelopes
            .iter()
            .find(|stored| {
                !stored.cut
                    && stored.header.group == *group
                    && stored.header.sender == *sender
                    && stored.header.seq == seq
            })
            .map(|stored| stored.hash))
    }
}

impl Hub {
    /// Follows the groups for stored content: the leaves and roles of every epoch that began, when the one
    /// before it ended, and the Cuts of the Commits taken since the last call.
    pub(super) fn follow_content(&mut self) {
        let Some(room) = self.history().map(|history| history.newest().clone()) else {
            return;
        };
        let groups: Vec<(GroupId, u64)> = self.epochs.iter().map(|(g, e)| (*g, *e)).collect();
        for (group, epoch) in groups {
            if self.content.epochs.contains_key(&(group, epoch)) {
                continue;
            }
            let Some(observer) = self.observer(&group) else {
                continue;
            };
            let Ok(leaves) = observer.leaves() else {
                continue;
            };
            let session = observer.session().copied();
            let parent_seat = session.filter(|s| !s.parent.is_zero()).and_then(|s| {
                match self
                    .observer(&GroupId::session(group.room_id(), s.parent))
                    .map(|parent| parent.seat_at(u64::MAX))
                {
                    Some(Parent::Seat(seat)) => seat,
                    _ => None,
                }
            });
            let mut facts = Epoch::default();
            for leaf in leaves {
                let role = match session {
                    None => Role::Human,
                    Some(_) if room.is_human(&leaf) => Role::Human,
                    Some(session) if session.parent.is_zero() => Role::Agent,
                    Some(_) if parent_seat == Some(leaf) => Role::Opener,
                    Some(_) => Role::Helper,
                };
                if matches!(role, Role::Agent | Role::Opener) {
                    facts.seat = Some(leaf);
                }
                facts.leaves.insert(leaf, role);
            }
            self.content.epochs.insert((group, epoch), facts);
        }
        let news: Vec<crate::hub::LogItem> = self
            .log
            .get(self.content.log_read..)
            .unwrap_or_default()
            .iter()
            .filter(|item| item.commit)
            .cloned()
            .collect();
        self.content.log_read = self.log.len();
        for item in news {
            let note = commit_note(&item.bytes);
            if let Some(ended) = self.content.epochs.get_mut(&(item.group, item.epoch)) {
                ended.end = Some(EpochEnd {
                    processed_at: self.clock,
                    time: note.as_ref().map_or(0, |note| note.time),
                });
            }
            for cut in note.map(|note| note.cuts).unwrap_or_default() {
                if self.content.cuts.contains_key(&(item.group, cut.device)) {
                    continue;
                }
                let head = Head {
                    seq: cut.seq,
                    hash: cut.hash,
                };
                self.content.cuts.insert((item.group, cut.device), head);
                let chains = self.content.chains.entry(item.group).or_default().clone();
                let effect =
                    chain::cut_chain(&Facts(self), &chains, &item.group, &cut.device, &head)
                        .expect("the Cut applies");
                self.content
                    .chains
                    .entry(item.group)
                    .or_default()
                    .apply_cut(&effect);
                if let Some(from) = effect.drop_from {
                    for stored in &mut self.content.envelopes {
                        if stored.header.group == item.group
                            && stored.header.sender == cut.device
                            && stored.header.seq >= from
                        {
                            stored.cut = true;
                        }
                    }
                    let kept: Vec<(Header, Hash32)> = self
                        .content
                        .envelopes
                        .iter()
                        .filter(|stored| {
                            stored.header.group == item.group
                                && !stored.cut
                                && stored.void_code.is_none()
                        })
                        .map(|stored| (stored.header.clone(), stored.hash))
                        .collect();
                    let objects =
                        objects::replay(&Facts(self), kept.iter().map(|(h, hash)| (h, hash)))
                            .expect("the objects replay");
                    self.content.objects.insert(item.group, objects);
                }
            }
        }
    }

    /// Takes a posted envelope (9.0.11). Refused after check 6, it is kept as a void record and the refusal
    /// is one with `voided: true` ([`Hub::voided`]).
    pub(super) fn take_envelope(
        &mut self,
        from: &DeviceId,
        entry: &OutboxEntry,
    ) -> Result<Accepted, Error> {
        self.follow_content();
        let bytes = entry.parts.first().ok_or(Error::BadFormat)?;
        let group = Envelope::decode(bytes)?.header.group;
        if self.archived.contains(&group) {
            return Err(Error::Gone);
        }
        let chains = self.content.chains.get(&group).cloned().unwrap_or_default();
        let objects = self
            .content
            .objects
            .get(&group)
            .cloned()
            .unwrap_or_default();
        let receipt = chain::hub_take(
            &Facts(self),
            &Facts(self),
            &chains,
            &objects,
            from,
            bytes,
            self.clock,
        )?;
        self.content
            .chains
            .entry(group)
            .or_default()
            .apply(receipt.advance())?;
        let envelope = receipt.envelope();
        let (stored, void_code) = match receipt.outcome() {
            Outcome::Taken { transition, .. } => {
                if let Some(transition) = transition {
                    self.content
                        .objects
                        .entry(group)
                        .or_default()
                        .apply(transition)?;
                }
                (bytes.clone(), None)
            }
            Outcome::Refused(code) => (envelope.prune()?.encode()?, Some(code.clone())),
            _ => return Err(Error::Internal("the hub's outcome")),
        };
        self.change += 1;
        self.content.envelopes.push(StoredEnvelope {
            change: self.change,
            header: envelope.header.clone(),
            hash: receipt.hash(),
            bytes: stored,
            void_code: void_code.clone(),
            cut: false,
        });
        match void_code {
            Some(code) => Err(code),
            None => Ok(Accepted {
                change: Some(self.change),
            }),
        }
    }

    /// Whether the refusal of this envelope entry came with `voided: true`: the hub keeps its number.
    pub fn voided(&self, entry: &OutboxEntry) -> bool {
        let hash = entry
            .parts
            .first()
            .and_then(|bytes| Envelope::decode(bytes).ok())
            .and_then(|envelope| envelope.hash().ok());
        self.content
            .envelopes
            .iter()
            .any(|stored| Some(stored.hash) == hash && stored.void_code.is_some())
    }

    /// Everything of the room above `change`, in order: the log's entries and the envelopes. An envelope
    /// beyond its sender's Cut is not served here.
    pub fn changes_after(&self, change: u64) -> Vec<Change> {
        let mut changes: Vec<Change> = self
            .log_after(change)
            .into_iter()
            .map(Change::Log)
            .chain(
                self.content
                    .envelopes
                    .iter()
                    .filter(|stored| stored.change > change && !stored.cut)
                    .cloned()
                    .map(|stored| Change::Envelope(Box::new(stored))),
            )
            .collect();
        changes.sort_by_key(Change::change);
        changes
    }

    /// The chain route: the envelopes of `sender` in `group` after number `after`, ascending.
    pub fn chain_of(&self, group: &GroupId, sender: &DeviceId, after: u64) -> Vec<StoredEnvelope> {
        let mut chain: Vec<StoredEnvelope> = self
            .content
            .envelopes
            .iter()
            .filter(|stored| {
                stored.header.group == *group
                    && stored.header.sender == *sender
                    && stored.header.seq > after
            })
            .cloned()
            .collect();
        chain.sort_by_key(|stored| stored.header.seq);
        chain
    }

    /// The state of the hub's objects in `group`.
    pub fn objects(&self, group: &GroupId) -> Objects {
        self.content.objects.get(group).cloned().unwrap_or_default()
    }
}
