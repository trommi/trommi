//! A room written by hand for the tests of stored content: groups with their epochs, leaves and roles, a
//! receiver that stores what it accepts, and senders that sign whatever a test asks for.

use std::collections::{BTreeMap, BTreeSet};

use trommi_core::chain::{
    self, receive, ChainRecords, Chains, EpochEnd, GroupFacts, Head, Mode, Outcome, OwnChain,
    Receipt, Role, Served,
};
use trommi_core::codec::{self, Encode, Writer};
use trommi_core::crypto::{Entropy, Secret, SeededEntropy, SigningKey};
use trommi_core::envelope::{
    Draft, Envelope, Header, ObjectState, ObjectType, Sealed, Slot, Subject, Timeline,
};
use trommi_core::ids::{DeviceId, GroupId, Hash32, RoomId, SessionId};
use trommi_core::objects::{Object, Objects, Transition};
use trommi_core::Error;

use crate::seal;

/// The room.
pub const ROOM: RoomId = RoomId::new([1; 32]);
/// Its main session.
pub const SESSION: SessionId = SessionId::new([2; 16]);
/// The helper session under it.
pub const HELPER_SESSION: SessionId = SessionId::new([3; 16]);
/// The receiver's clock in most tests.
pub const NOW: u64 = 1_700_000_000_000;

/// The room group.
pub fn room() -> GroupId {
    GroupId::room(ROOM)
}

/// The main session's group.
pub fn session() -> GroupId {
    GroupId::session(ROOM, SESSION)
}

/// The helper session's group.
pub fn helper_session() -> GroupId {
    GroupId::session(ROOM, HELPER_SESSION)
}

/// The same bytes on every run, a stream per `seed`.
pub fn seeded(seed: u64) -> SeededEntropy {
    let mut bytes = [0u8; 32];
    for (to, from) in bytes.iter_mut().zip(seed.to_be_bytes()) {
        *to = from;
    }
    SeededEntropy::new(bytes)
}

/// A source that gives nothing.
pub struct NoEntropy;

impl Entropy for NoEntropy {
    fn fill(&mut self, _: &mut [u8]) -> Result<(), Error> {
        Err(Error::Entropy)
    }
}

/// The signature key of test device `n`.
pub fn signer(n: u8) -> SigningKey {
    SigningKey::from_seed(Secret::new([n; 32]))
}

/// The id of test device `n`.
pub fn device(n: u8) -> DeviceId {
    DeviceId::new(signer(n).public())
}

/// The content key of test epoch `epoch`.
pub fn key(epoch: u64) -> Secret<32> {
    let mut bytes = [0x4B; 32];
    for (to, from) in bytes.iter_mut().zip(epoch.to_be_bytes()) {
        *to = from;
    }
    Secret::new(bytes)
}

/// A payload: a JSON object with one text field.
pub fn payload(text: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({ "schema_version": 2, "text": text }))
        .expect("a payload")
}

/// The payload of a version that follows `previous`.
pub fn version_payload(previous: &Hash32, extra: serde_json::Value) -> Vec<u8> {
    let mut object = extra;
    object["previous_version_hash"] = previous.to_base64url().into();
    serde_json::to_vec(&object).expect("a payload")
}

/// Chains that stand at `heads` and in which each epoch of `counts` has already taken that many numbers: a
/// state written down instead of filled by receiving.
pub fn chains_of(heads: &[(DeviceId, Head)], counts: &[(u64, u64)]) -> Chains {
    struct HeadEntry(DeviceId, Head);
    impl Encode for HeadEntry {
        fn write(&self, writer: &mut Writer) -> Result<(), Error> {
            writer.fixed(self.0.as_bytes());
            writer.value(&self.1)
        }
    }
    struct Count(u64, u64);
    impl Encode for Count {
        fn write(&self, writer: &mut Writer) -> Result<(), Error> {
            writer.u64(self.0);
            writer.u64(self.1);
            Ok(())
        }
    }
    let heads: Vec<HeadEntry> = heads.iter().map(|(d, h)| HeadEntry(*d, *h)).collect();
    let counts: Vec<Count> = counts.iter().map(|(e, n)| Count(*e, *n)).collect();
    let mut writer = Writer::new();
    writer.u64(0);
    writer.vector(&heads).expect("the heads");
    writer.vector(&counts).expect("the counts");
    // No chain began at a frontier.
    writer.vector::<Count>(&[]).expect("the starts");
    Chains::from_bytes(&writer.into_bytes()).expect("a chain state")
}

/// Chains without an envelope in which `epoch` has already taken `count` numbers.
pub fn chains_with_count(epoch: u64, count: u64) -> Chains {
    chains_of(&[], &[(epoch, count)])
}

/// What device `n` signs as its first envelope in `group`: `draft`'s header over a sealed body one byte
/// beyond the largest padded size, 65 553 bytes with its tag.
pub fn oversize(n: u8, group: GroupId, draft: &Draft) -> Sealed {
    let slot = World::new().slot(n, group, 0);
    seal::seal_plaintext(
        draft.header(&slot).expect("a header"),
        &vec![0; 65_537],
        &key(0),
        [7; 12],
        &signer(n),
    )
    .expect("the envelope is sealed")
}

/// One epoch of a group.
#[derive(Default, Clone)]
pub struct FakeEpoch {
    /// The leaves and their roles.
    pub leaves: BTreeMap<DeviceId, Role>,
    /// The Commit that ended it, if one did.
    pub end: Option<EpochEnd>,
    /// Whether the receiver lacks its content key.
    pub no_key: bool,
}

/// One group.
#[derive(Default, Clone)]
pub struct FakeGroup {
    /// Its epochs from 0.
    pub epochs: Vec<FakeEpoch>,
    /// The Cuts of removed leaves.
    pub cuts: BTreeMap<DeviceId, Head>,
    /// Whether it is stale.
    pub stale: bool,
}

/// Group facts written by hand, and the receiver's table of accepted envelopes.
#[derive(Default, Clone)]
pub struct Fake {
    /// The groups.
    pub groups: BTreeMap<GroupId, FakeGroup>,
    /// The human devices of the newest room state.
    pub humans_now: BTreeSet<DeviceId>,
    /// The hash of every accepted envelope.
    pub accepted: BTreeMap<(GroupId, DeviceId, u64), Hash32>,
    /// Whether this is the hub, which holds no key.
    pub hub: bool,
}

impl Fake {
    /// Devices 1 and 2 are human, 3 is the agent of the main session, which has opened a helper session
    /// with helper device 4. Every group stands in epoch 0.
    pub fn new() -> Self {
        let mut fake = Self::default();
        let humans = [(device(1), Role::Human), (device(2), Role::Human)];
        fake.humans_now = humans.iter().map(|(d, _)| *d).collect();
        fake.add_group(room(), &humans);
        fake.add_group(session(), &[humans[0], humans[1], (device(3), Role::Agent)]);
        fake.add_group(
            helper_session(),
            &[
                humans[0],
                humans[1],
                (device(3), Role::Opener),
                (device(4), Role::Helper),
            ],
        );
        fake
    }

    /// A group in its epoch 0 with these leaves.
    pub fn add_group(&mut self, group: GroupId, leaves: &[(DeviceId, Role)]) {
        let epoch = FakeEpoch {
            leaves: leaves.iter().copied().collect(),
            ..FakeEpoch::default()
        };
        self.groups.insert(
            group,
            FakeGroup {
                epochs: vec![epoch],
                ..FakeGroup::default()
            },
        );
    }

    /// The group, to change it.
    pub fn group(&mut self, group: &GroupId) -> &mut FakeGroup {
        self.groups.get_mut(group).expect("a known group")
    }

    /// A Commit in `group`, processed at `processed_at` with the note's `time`: the next epoch begins with
    /// the leaves `change` makes of the current ones.
    pub fn commit(
        &mut self,
        group: &GroupId,
        processed_at: u64,
        time: u64,
        change: impl FnOnce(&mut BTreeMap<DeviceId, Role>),
    ) {
        let epochs = &mut self.group(group).epochs;
        let last = epochs.last_mut().expect("an epoch");
        last.end = Some(EpochEnd { processed_at, time });
        let mut leaves = last.leaves.clone();
        change(&mut leaves);
        epochs.push(FakeEpoch {
            leaves,
            ..FakeEpoch::default()
        });
    }

    fn epoch(&self, group: &GroupId, epoch: u64) -> Option<&FakeEpoch> {
        self.groups
            .get(group)?
            .epochs
            .get(usize::try_from(epoch).ok()?)
    }
}

impl GroupFacts for Fake {
    fn room(&self) -> RoomId {
        ROOM
    }

    fn processed_epoch(&self, group: &GroupId) -> Result<Option<u64>, Error> {
        Ok(self.groups.get(group).map(|g| g.epochs.len() as u64 - 1))
    }

    fn leaf_role(
        &self,
        group: &GroupId,
        epoch: u64,
        device: &DeviceId,
    ) -> Result<Option<Role>, Error> {
        Ok(self
            .epoch(group, epoch)
            .and_then(|e| e.leaves.get(device).copied()))
    }

    fn seat(&self, group: &GroupId, epoch: u64) -> Result<Option<DeviceId>, Error> {
        Ok(self.epoch(group, epoch).and_then(|e| {
            e.leaves
                .iter()
                .find(|(_, role)| matches!(role, Role::Agent | Role::Opener))
                .map(|(device, _)| *device)
        }))
    }

    fn cut(&self, group: &GroupId, device: &DeviceId) -> Result<Option<Head>, Error> {
        Ok(self
            .groups
            .get(group)
            .and_then(|g| g.cuts.get(device).copied()))
    }

    fn epoch_end(&self, group: &GroupId, epoch: u64) -> Result<Option<EpochEnd>, Error> {
        Ok(self.epoch(group, epoch).and_then(|e| e.end))
    }

    fn is_stale(&self, group: &GroupId) -> Result<bool, Error> {
        Ok(self.groups.get(group).is_some_and(|g| g.stale))
    }

    fn is_human_now(&self, device: &DeviceId) -> Result<bool, Error> {
        Ok(self.humans_now.contains(device))
    }

    fn content_key(&self, group: &GroupId, epoch: u64) -> Result<Option<Secret<32>>, Error> {
        Ok(self
            .epoch(group, epoch)
            .filter(|e| !e.no_key && !self.hub)
            .map(|_| key(epoch)))
    }
}

impl ChainRecords for Fake {
    fn accepted_hash(
        &self,
        group: &GroupId,
        sender: &DeviceId,
        seq: u64,
    ) -> Result<Option<Hash32>, Error> {
        Ok(self.accepted.get(&(*group, *sender, seq)).copied())
    }
}

/// One receiver (device 1 unless said otherwise) with its state, and every sender's last signed envelope.
pub struct World {
    /// The receiver's group facts and table.
    pub fake: Fake,
    /// The receiver.
    pub me: DeviceId,
    /// Its chains per group.
    pub chains: BTreeMap<GroupId, Chains>,
    /// Its objects per group.
    pub objects: BTreeMap<GroupId, Objects>,
    /// Per group and test device: the last envelope it signed. A test sets one back to sign a number twice.
    pub own: BTreeMap<(GroupId, u8), Head>,
    /// Where nonces come from.
    pub entropy: SeededEntropy,
    /// The clock.
    pub now: u64,
}

impl Default for World {
    fn default() -> Self {
        Self::new()
    }
}

impl World {
    /// The room of [`Fake::new`], received by device 1.
    pub fn new() -> Self {
        Self {
            fake: Fake::new(),
            me: device(1),
            chains: BTreeMap::new(),
            objects: BTreeMap::new(),
            own: BTreeMap::new(),
            entropy: seeded(1),
            now: NOW,
        }
    }

    /// The receiver's chains of `group`.
    pub fn chains(&self, group: &GroupId) -> Chains {
        self.chains.get(group).cloned().unwrap_or_default()
    }

    /// The receiver's objects of `group`.
    pub fn objects(&self, group: &GroupId) -> Objects {
        self.objects.get(group).cloned().unwrap_or_default()
    }

    /// The place of the next envelope of device `n` in `group`.
    pub fn slot(&self, n: u8, group: GroupId, epoch: u64) -> Slot {
        let last = self.own.get(&(group, n)).copied().unwrap_or(Head::START);
        Slot {
            group,
            epoch,
            sender: device(n),
            seq: last.seq + 1,
            prev: last.hash,
            time: self.now,
        }
    }

    /// Device `n` signs its next envelope in `group` in `epoch`, whatever the rules say about it.
    pub fn sign_in_epoch(&mut self, n: u8, group: GroupId, epoch: u64, draft: &Draft) -> Sealed {
        let slot = self.slot(n, group, epoch);
        let sealed = seal::seal_at(draft, &slot, &key(epoch), &signer(n), &mut self.entropy)
            .expect("the envelope is sealed");
        self.own.insert(
            (group, n),
            Head {
                seq: slot.seq,
                hash: sealed.hash,
            },
        );
        sealed
    }

    /// Device `n` seals its next envelope in `group` as a device does: against the receiver's facts, chains
    /// and objects, by the rules. A refusal uses up no number.
    pub fn seal_next(&mut self, n: u8, group: GroupId, draft: &Draft) -> Result<Sealed, Error> {
        let last = self.own.get(&(group, n)).copied().unwrap_or(Head::START);
        let mut own = OwnChain::from_bytes(&codec::encode(&last)?)?;
        let outgoing = chain::seal_next(
            &self.fake,
            &self.chains(&group),
            &self.objects(&group),
            &mut own,
            draft,
            group,
            &signer(n),
            self.now,
            &mut self.entropy,
        )?;
        self.own.insert((group, n), own.head());
        Ok(Sealed {
            envelope: outgoing.envelope,
            hash: outgoing.hash,
        })
    }

    /// What device `n` would sign next in `group`, with its header changed by `change` and signed as
    /// changed: a header no honest writer makes. The body stays sealed under the header before the change.
    pub fn forge(
        &mut self,
        n: u8,
        group: GroupId,
        draft: &Draft,
        change: impl FnOnce(&mut Header),
    ) -> Envelope {
        let mut envelope = self.sign(n, group, draft).envelope;
        change(&mut envelope.header);
        let hash = seal::sign(&mut envelope, &signer(n)).expect("the envelope is signed");
        self.own.insert(
            (group, n),
            Head {
                seq: envelope.header.seq,
                hash,
            },
        );
        envelope
    }

    /// Device `n` signs its next envelope in `group`, in the group's newest epoch.
    pub fn sign(&mut self, n: u8, group: GroupId, draft: &Draft) -> Sealed {
        let epoch = self
            .fake
            .processed_epoch(&group)
            .expect("facts")
            .expect("a known group");
        self.sign_in_epoch(n, group, epoch, draft)
    }

    /// The receiver's checks on `bytes`; what passes check 6 is applied and recorded.
    pub fn take_as(&mut self, bytes: &[u8], served: &Served, mode: Mode) -> Result<Receipt, Error> {
        let group = Envelope::decode(bytes)
            .map(|e| e.header.group)
            .unwrap_or(room());
        let receipt = receive(
            &self.fake,
            &self.fake,
            &self.chains(&group),
            &self.objects(&group),
            &self.me,
            bytes,
            served,
            mode,
            self.now,
        )?;
        self.record(&receipt);
        Ok(receipt)
    }

    /// This world as the hub: a new envelope posted by signed-in device `n`; what takes a number is recorded.
    pub fn hub_take(&mut self, n: u8, envelope: &Envelope) -> Result<Receipt, Error> {
        let group = envelope.header.group;
        let receipt = chain::hub_take(
            &self.fake,
            &self.fake,
            &self.chains(&group),
            &self.objects(&group),
            &device(n),
            &envelope.encode()?,
            self.now,
        )?;
        self.record(&receipt);
        Ok(receipt)
    }

    /// Stores what a receipt changes.
    pub fn record(&mut self, receipt: &Receipt) {
        let group = receipt.envelope().header.group;
        self.chains
            .entry(group)
            .or_default()
            .apply(receipt.advance())
            .expect("the step applies");
        if let Outcome::Taken {
            transition: Some(transition),
            ..
        } = receipt.outcome()
        {
            self.objects
                .entry(group)
                .or_default()
                .apply(transition)
                .expect("the transition applies");
        }
        self.fake.accepted.insert(
            (group, receipt.advance().sender, receipt.advance().head.seq),
            receipt.hash(),
        );
    }

    /// The receiver's checks on a stored envelope that comes in the hub's order.
    pub fn take(&mut self, envelope: &Envelope) -> Result<Receipt, Error> {
        self.take_as(
            &envelope.encode().expect("the envelope encodes"),
            &Served::Stored,
            Mode::InOrder,
        )
    }

    /// Device `n` signs `draft` in `group` and the receiver takes it.
    pub fn post(&mut self, n: u8, group: GroupId, draft: &Draft) -> Receipt {
        let sealed = self.sign(n, group, draft);
        self.take(&sealed.envelope).expect("the envelope is taken")
    }
}

/// The core's own sealing of `draft` at `slot` by `signer`, reached the way a device reaches it: through
/// `chain::seal_next`, in a room made for the purpose in which the rules of 9.2 allow the item. The group
/// stands in the slot's epoch with the content key [`key`] of that epoch; the sender is a leaf with the role
/// its item needs, the device it addresses holds the session's seat, and the object it names stands as the
/// item needs it. So what is refused is refused by the sealing itself.
pub fn core_seal(
    draft: &Draft,
    slot: &Slot,
    signer: &SigningKey,
    entropy: &mut dyn Entropy,
) -> Result<Sealed, Error> {
    let sender = DeviceId::new(signer.public());
    assert_eq!(sender, slot.sender, "the slot is the signer's");
    let header = draft.header(slot)?;
    let human = match &header.subject {
        Subject::Version(fields) => fields.object_type == ObjectType::Note,
        Subject::Request(_) => false,
        Subject::Item(Timeline::SessionChat(_) | Timeline::CardChat(_)) => {
            header.recipient != DeviceId::ZERO
        }
        _ => true,
    };
    let mut leaves = vec![(sender, if human { Role::Human } else { Role::Agent })];
    if human && !slot.group.is_room() && header.recipient != DeviceId::ZERO {
        leaves.push((header.recipient, Role::Agent));
    }
    let mut fake = Fake::default();
    fake.add_group(slot.group, &leaves);
    for _ in 0..slot.epoch {
        fake.commit(&slot.group, slot.time, slot.time, |_| {});
    }

    let mut objects = Objects::new();
    let mut stand = |object_id, object: Object, note: bool| {
        objects.apply(&Transition {
            object_id,
            note_version: note.then_some(object.current),
            before: None,
            after: object,
            revision: 0,
        })
    };
    let object = |object_type, owner, state, current| Object {
        object_type,
        owner,
        state,
        current,
        answer: None,
    };
    match &header.subject {
        Subject::Version(fields) if !fields.object_ref.is_zero() => stand(
            fields.object_id,
            object(
                fields.object_type,
                sender,
                ObjectState::Open,
                fields.object_ref,
            ),
            fields.object_type == ObjectType::Note,
        )?,
        Subject::Answer(fields) | Subject::Verdict(fields) => stand(
            fields.object_id,
            object(
                fields.object_type,
                header.recipient,
                ObjectState::Open,
                fields.object_ref,
            ),
            false,
        )?,
        Subject::TakeBack(fields) => stand(
            fields.object_id,
            object(
                fields.object_type,
                header.recipient,
                ObjectState::Answered,
                fields.object_ref,
            ),
            false,
        )?,
        Subject::Item(Timeline::CardChat(card)) => stand(
            *card,
            object(ObjectType::Card, sender, ObjectState::Open, Hash32::ZERO),
            false,
        )?,
        _ => {}
    }

    let last = Head {
        seq: slot.seq - 1,
        hash: slot.prev,
    };
    let mut own = OwnChain::from_bytes(&codec::encode(&last)?)?;
    let outgoing = chain::seal_next(
        &fake,
        &Chains::new(),
        &objects,
        &mut own,
        draft,
        slot.group,
        signer,
        slot.time,
        entropy,
    )?;
    Ok(Sealed {
        envelope: outgoing.envelope,
        hash: outgoing.hash,
    })
}
