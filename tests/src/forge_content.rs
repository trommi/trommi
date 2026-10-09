//! A writer of envelopes that is no `Device`: it holds a signature key and says about its group whatever the
//! test wants, so that it can sign what an honest device never signs (a second envelope under one number, a
//! header its body was not sealed with, an envelope of an epoch that ended).

use trommi_core::chain::{self, Chains, EpochEnd, GroupFacts, Head, OwnChain, Role};
use trommi_core::crypto::{self, Secret, SigningKey, SystemEntropy};
use trommi_core::envelope::{Draft, Envelope};
use trommi_core::ids::{DeviceId, GroupId, RoomId};
use trommi_core::objects::Objects;
use trommi_core::store::{OutboxEntry, OutboxKind};
use trommi_core::Error;

/// What the writer claims of its group.
pub struct Claim {
    /// The group.
    pub group: GroupId,
    /// The epoch it writes in.
    pub epoch: u64,
    /// The role it gives itself.
    pub role: Role,
    /// The session's agent device or opener, as it claims.
    pub seat: Option<DeviceId>,
    /// The content key it seals with.
    pub key: Secret<32>,
}

impl GroupFacts for Claim {
    fn room(&self) -> RoomId {
        self.group.room_id()
    }

    fn processed_epoch(&self, _: &GroupId) -> Result<Option<u64>, Error> {
        Ok(Some(self.epoch))
    }

    fn leaf_role(&self, _: &GroupId, _: u64, _: &DeviceId) -> Result<Option<Role>, Error> {
        Ok(Some(self.role))
    }

    fn seat(&self, _: &GroupId, _: u64) -> Result<Option<DeviceId>, Error> {
        Ok(self.seat)
    }

    fn cut(&self, _: &GroupId, _: &DeviceId) -> Result<Option<Head>, Error> {
        Ok(None)
    }

    fn epoch_end(&self, _: &GroupId, _: u64) -> Result<Option<EpochEnd>, Error> {
        Ok(None)
    }

    fn is_stale(&self, _: &GroupId) -> Result<bool, Error> {
        Ok(false)
    }

    fn is_human_now(&self, _: &DeviceId) -> Result<bool, Error> {
        Ok(true)
    }

    fn content_key(&self, _: &GroupId, _: u64) -> Result<Option<Secret<32>>, Error> {
        Ok(Some(self.key.duplicate()))
    }
}

/// A signature key with its chain in one group.
pub struct Pen {
    /// The key.
    pub key: SigningKey,
    /// The chain it signs along.
    pub chain: OwnChain,
}

impl Pen {
    /// A pen for `key`, before its first envelope.
    pub fn new(key: &SigningKey) -> Self {
        Self {
            key: SigningKey::from_seed(key.seed().duplicate()),
            chain: OwnChain::new(),
        }
    }

    /// The same key at the same place of its chain: what it signs next has the number of the other's next.
    pub fn fork(&self) -> Self {
        Self {
            key: SigningKey::from_seed(self.key.seed().duplicate()),
            chain: OwnChain::from_bytes(&self.chain.to_bytes().expect("a chain"))
                .expect("the same chain"),
        }
    }

    /// The device id of the key.
    pub fn id(&self) -> DeviceId {
        DeviceId::new(self.key.public())
    }

    /// Signs the next envelope of the chain under `claim`, judged against `objects`.
    pub fn sign(&mut self, claim: &Claim, draft: &Draft, objects: &Objects, time: u64) -> Envelope {
        chain::seal_next(
            claim,
            &Chains::new(),
            objects,
            &mut self.chain,
            draft,
            claim.group,
            &self.key,
            time,
            &mut SystemEntropy,
        )
        .expect("the envelope seals")
        .envelope
    }

    /// Signs `envelope` as it stands now, after a test changed it, and goes on from it.
    pub fn resign(&mut self, envelope: &mut Envelope) {
        let hash = envelope.hash().expect("a hash");
        envelope.signature = crypto::sign_with_label(&self.key, "TrommiEnvelope", hash.as_bytes())
            .expect("a signature")
            .try_into()
            .expect("64 bytes");
        let head = Head {
            seq: envelope.header.seq,
            hash,
        };
        self.chain = OwnChain::from_bytes(&trommi_core::codec::encode(&head).expect("a head"))
            .expect("a chain");
    }
}

/// The request that posts `envelope`, as a device's outbox would hold it.
pub fn posting(envelope: &Envelope) -> OutboxEntry {
    OutboxEntry {
        id: 0,
        kind: OutboxKind::Envelope,
        group: Some(envelope.header.group),
        epoch: envelope.header.epoch,
        parts: vec![envelope.encode().expect("an envelope")],
    }
}
