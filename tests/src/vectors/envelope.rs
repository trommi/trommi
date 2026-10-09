//! `spec/vectors/envelope.json`: a session's story as stored content, one envelope of every kind in full and
//! pruned form with its parts, bytes that are no envelope, void records, and what each of the receiver's checks
//! refuses (section 9).

use std::collections::BTreeMap;

use serde_json::{json, Value};
use trommi_core::chain::{
    hub_take, receive, EpochEnd, Head, Mode, Outcome, Role, Served, LIVE_GRACE_MS,
    MAX_ENVELOPES_PER_EPOCH,
};
use trommi_core::codec;
use trommi_core::crypto::{self, Entropy, Secret, SigningKey};
use trommi_core::envelope::{Content, Draft, Envelope, ObjectType, Slot, Urgency};
use trommi_core::ids::{DeviceId, GroupId, Hash32, RoomId, SessionId};
use trommi_core::objects::Objects;
use trommi_core::Error;

use super::{entropy, hex, unhex};
use crate::content::{story, Told, STORY_KEY, STORY_START};
use crate::room::{chains_of, session, Fake, FakeEpoch, FakeGroup, ROOM, SESSION};
use crate::seal;

/// The name of the file.
pub const NAME: &str = "envelope";

/// Bytes made from the story's first envelope that no reader takes: the change, where it shows (`decode` or
/// `verify`) and the code.
pub fn refused(first: &Told) -> Vec<(Vec<u8>, &'static str, &'static str, &'static str)> {
    let with = |at: usize, byte: u8| {
        let mut bytes = first.bytes.clone();
        if let Some(place) = bytes.get_mut(at) {
            *place = byte;
        }
        bytes
    };
    let mut longer = first.bytes.clone();
    longer.push(0);
    let shorter = first.bytes[..first.bytes.len() - 1].to_vec();
    let mut signed_otherwise = first.bytes.clone();
    if let Some(last) = signed_otherwise.last_mut() {
        *last ^= 1;
    }
    vec![
        (Vec::new(), "decode", "bad-format", "no bytes"),
        (with(0, 3), "decode", "bad-format", "form 3"),
        (
            with(0, 2),
            "decode",
            "bad-format",
            "a full envelope marked pruned",
        ),
        (with(1, 1), "decode", "bad-format", "header version 1"),
        (with(1, 3), "decode", "newer-version", "header version 3"),
        (with(2, 0), "decode", "bad-format", "kind 0"),
        (with(3, 2), "decode", "bad-format", "an unknown flag"),
        (longer, "decode", "bad-format", "a byte behind the envelope"),
        (shorter, "decode", "bad-format", "a byte missing"),
        (
            with(3, 0),
            "verify",
            "bad-signature",
            "the push flag cleared",
        ),
        (
            with(2, 9),
            "verify",
            "bad-signature",
            "the kind changed to a reserved one",
        ),
        (
            signed_otherwise,
            "verify",
            "bad-signature",
            "another signature",
        ),
    ]
}

/// One epoch of a case's group: its leaves with their roles, and the Commit that ended it, if one did.
pub type Epoch = (Vec<(DeviceId, Role)>, Option<EpochEnd>);

/// What a verifier holds of the one group a case plays in, the session group of the file: enough to run a
/// check on one envelope. A device answers such questions from its MLS state; here they are written down.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verifier {
    /// Who checks: the hub taking a new envelope, or a device in the hub's order.
    pub hub: bool,
    /// The verifier's clock.
    pub now: u64,
    /// The group's epochs from 0: the leaves with their roles, and the Commit that ended each but the last.
    pub epochs: Vec<Epoch>,
    /// The Cuts of removed leaves.
    pub cuts: Vec<(DeviceId, Head)>,
    /// Whether the group is stale.
    pub stale: bool,
    /// The last accepted envelope of each sender.
    pub heads: Vec<(DeviceId, Head)>,
    /// How many envelopes took a number in the newest epoch.
    pub count: u64,
    /// At the hub: the device whose token carried the request.
    pub signed_in: Option<DeviceId>,
    /// At a device: the `void_code` the hub served the envelope with, if it served it as a void record.
    pub void_code: Option<Error>,
}

fn role_name(role: Role) -> &'static str {
    match role {
        Role::Human => "human",
        Role::Agent => "agent",
        Role::Opener => "opener",
        Role::Helper => "helper",
    }
}

fn head_json(head: &Head) -> Value {
    json!([head.seq, hex(head.hash.as_bytes())])
}

fn heads_json(heads: &[(DeviceId, Head)]) -> Value {
    Value::Object(
        heads
            .iter()
            .map(|(device, head)| (hex(device.as_bytes()), head_json(head)))
            .collect(),
    )
}

/// The codes this file names, back from their text.
fn code(text: &str) -> Option<Error> {
    [
        Error::Forbidden,
        Error::WrongEpoch,
        Error::StaleSession,
        Error::EpochFull,
        Error::TooLarge,
    ]
    .into_iter()
    .find(|error| error.code() == text)
}

fn device_of(text: &str) -> Option<DeviceId> {
    DeviceId::from_slice(&unhex(text)?).ok()
}

fn head_of(value: &Value) -> Option<Head> {
    Some(Head {
        seq: value.get(0)?.as_u64()?,
        hash: Hash32::from_slice(&unhex(value.get(1)?.as_str()?)?).ok()?,
    })
}

fn heads_of(value: &Value) -> Option<Vec<(DeviceId, Head)>> {
    value
        .as_object()?
        .iter()
        .map(|(device, head)| Some((device_of(device)?, head_of(head)?)))
        .collect()
}

impl Verifier {
    /// As the file states it.
    pub fn to_json(&self) -> Value {
        let epochs: Vec<Value> = self
            .epochs
            .iter()
            .map(|(leaves, end)| {
                let leaves: serde_json::Map<String, Value> = leaves
                    .iter()
                    .map(|(device, role)| (hex(device.as_bytes()), role_name(*role).into()))
                    .collect();
                json!({
                    "leaves": leaves,
                    "ended": end.map(|end| json!({ "processed_at": end.processed_at, "time": end.time })),
                })
            })
            .collect();
        json!({
            "who": if self.hub { "hub" } else { "device" },
            "now": self.now,
            "epochs": epochs,
            "cuts": heads_json(&self.cuts),
            "stale": self.stale,
            "heads": heads_json(&self.heads),
            "count": self.count,
            "signed_in": self.signed_in.map(|device| hex(device.as_bytes())),
            "void_code": self.void_code.as_ref().map(Error::code),
        })
    }

    /// Read back from the file; `None` if it is not what [`Verifier::to_json`] writes.
    pub fn from_json(value: &Value) -> Option<Self> {
        let mut epochs = Vec::new();
        for epoch in value["epochs"].as_array()? {
            let mut leaves = Vec::new();
            for (device, role) in epoch["leaves"].as_object()? {
                let role = [Role::Human, Role::Agent, Role::Opener, Role::Helper]
                    .into_iter()
                    .find(|known| Some(role_name(*known)) == role.as_str())?;
                leaves.push((device_of(device)?, role));
            }
            let end = match &epoch["ended"] {
                Value::Null => None,
                end => Some(EpochEnd {
                    processed_at: end["processed_at"].as_u64()?,
                    time: end["time"].as_u64()?,
                }),
            };
            epochs.push((leaves, end));
        }
        Some(Self {
            hub: value["who"].as_str()? == "hub",
            now: value["now"].as_u64()?,
            epochs,
            cuts: heads_of(&value["cuts"])?,
            stale: value["stale"].as_bool()?,
            heads: heads_of(&value["heads"])?,
            count: value["count"].as_u64()?,
            signed_in: match &value["signed_in"] {
                Value::Null => None,
                device => Some(device_of(device.as_str()?)?),
            },
            void_code: match &value["void_code"] {
                Value::Null => None,
                text => Some(code(text.as_str()?)?),
            },
        })
    }

    /// Runs the check on `envelope` through the core: the hub's on a new envelope, or a device's on one the
    /// hub served, in the hub's order. `Err` is a refusal that takes no number; `Ok` what became of an envelope
    /// that took one.
    pub fn check(&self, envelope: &[u8]) -> Result<Outcome, Error> {
        let group = session();
        let newest = self.epochs.len().saturating_sub(1) as u64;
        let fake = Fake {
            groups: BTreeMap::from([(
                group,
                FakeGroup {
                    epochs: self
                        .epochs
                        .iter()
                        .map(|(leaves, end)| FakeEpoch {
                            leaves: leaves.iter().copied().collect(),
                            end: *end,
                            no_key: false,
                        })
                        .collect(),
                    cuts: self.cuts.iter().copied().collect(),
                    stale: self.stale,
                },
            )]),
            hub: self.hub,
            ..Fake::default()
        };
        let chains = chains_of(&self.heads, &[(newest, self.count)]);
        let objects = Objects::new();
        let receipt = match (&self.signed_in, self.hub) {
            (Some(signed_in), true) => hub_take(
                &fake, &fake, &chains, &objects, signed_in, envelope, self.now,
            )?,
            _ => receive(
                &fake,
                &fake,
                &chains,
                &objects,
                &DeviceId::ZERO,
                envelope,
                &self.void_code.clone().map_or(Served::Stored, Served::Void),
                Mode::InOrder,
                self.now,
            )?,
        };
        Ok(receipt.outcome().clone())
    }
}

/// What a check made of an envelope, as the file states it: the code of a refusal that takes no number;
/// `chained: <code>` for an envelope that took its number and is not applied (at the hub: a void record);
/// `void: <code>` and `void: <code>, finding: <finding>` for a void record a device was served; `taken`.
pub fn result_text(result: &Result<Outcome, Error>) -> String {
    match result {
        Err(error) => error.code().to_owned(),
        Ok(Outcome::Refused(code)) => format!("chained: {}", code.code()),
        Ok(Outcome::Void {
            code,
            finding: None,
        }) => format!("void: {}", code.code()),
        Ok(Outcome::Void {
            code,
            finding: Some(finding),
        }) => format!("void: {}, finding: {}", code.code(), finding.code()),
        Ok(Outcome::Taken { .. }) => "taken".to_owned(),
        Ok(Outcome::Reserved) => "reserved".to_owned(),
    }
}

/// One case of the checks: what is checked, by whom, and what comes of it.
pub struct Case {
    /// The check of section 9.0.5 the case is about; 0 for what the hub checks beside them.
    pub check: u8,
    /// The case in a few words.
    pub why: &'static str,
    /// The envelope.
    pub envelope: Vec<u8>,
    /// Who checks it against what.
    pub verifier: Verifier,
}

/// The content key of the cases' group in `epoch`.
fn case_key(epoch: u64) -> Secret<32> {
    crate::room::key(epoch)
}

/// The cases of the checks: one per code that a check can end in, and the void records.
pub fn cases(entropy: &mut dyn Entropy) -> Result<(Vec<Case>, [DeviceId; 3]), Error> {
    let human = SigningKey::generate(entropy)?;
    let agent = SigningKey::generate(entropy)?;
    let stranger = SigningKey::generate(entropy)?;
    let id = |key: &SigningKey| DeviceId::new(key.public());
    let (human_id, agent_id) = (id(&human), id(&agent));
    let now = STORY_START;
    let leaves = vec![(human_id, Role::Human), (agent_id, Role::Agent)];
    let device = Verifier {
        hub: false,
        now,
        epochs: vec![(leaves.clone(), None)],
        cuts: Vec::new(),
        stale: false,
        heads: Vec::new(),
        count: 0,
        signed_in: None,
        void_code: None,
    };
    let hub = |signed_in: DeviceId| Verifier {
        hub: true,
        signed_in: Some(signed_in),
        ..device.clone()
    };
    let slot = |group: GroupId, epoch: u64, sender: DeviceId, last: Head| Slot {
        group,
        epoch,
        sender,
        seq: last.seq + 1,
        prev: last.hash,
        time: now,
    };
    let chat = |text: &str| {
        let payload = format!(r#"{{"schema_version":2,"content_type":"message","text":"{text}"}}"#);
        Draft::session_chat(SESSION, agent_id, payload.as_bytes())
    };
    let mut sealed = |draft: &Draft, slot: &Slot, signer: &SigningKey| {
        seal::seal_at(draft, slot, &case_key(slot.epoch), signer, entropy)
    };

    // The human device's first three envelopes in epoch 0, and a second one under number 1.
    let one = sealed(
        &chat("one"),
        &slot(session(), 0, human_id, Head::START),
        &human,
    )?;
    let head_one = Head {
        seq: 1,
        hash: one.hash,
    };
    let two = sealed(
        &chat("two"),
        &slot(session(), 0, human_id, head_one),
        &human,
    )?;
    let other_one = sealed(
        &chat("one, again"),
        &slot(session(), 0, human_id, Head::START),
        &human,
    )?;
    let bytes = |envelope: &Envelope| envelope.encode();
    let mut cases = Vec::new();
    let mut case = |check: u8, why: &'static str, envelope: Vec<u8>, verifier: Verifier| {
        cases.push(Case {
            check,
            why,
            envelope,
            verifier,
        });
    };

    case(
        0,
        "the first envelope of a chain",
        bytes(&one.envelope)?,
        device.clone(),
    );

    let elsewhere = GroupId::session(RoomId::new([9; 32]), SESSION);
    let foreign = sealed(
        &chat("one"),
        &slot(elsewhere, 0, human_id, Head::START),
        &human,
    )?;
    case(
        1,
        "a group of another room",
        bytes(&foreign.envelope)?,
        device.clone(),
    );

    let ahead = sealed(
        &chat("one"),
        &slot(session(), 1, human_id, Head::START),
        &human,
    )?;
    case(
        2,
        "an epoch the verifier has not processed",
        bytes(&ahead.envelope)?,
        device.clone(),
    );
    let unknown = GroupId::session(ROOM, SessionId::new([8; 16]));
    let of_unknown = sealed(
        &chat("one"),
        &slot(unknown, 0, human_id, Head::START),
        &human,
    )?;
    case(
        2,
        "a group the verifier does not know",
        bytes(&of_unknown.envelope)?,
        device.clone(),
    );

    let from_outside = sealed(
        &chat("one"),
        &slot(session(), 0, id(&stranger), Head::START),
        &stranger,
    )?;
    case(
        3,
        "a sender that was no leaf in the epoch",
        bytes(&from_outside.envelope)?,
        device.clone(),
    );

    // The human device was removed; the remover had accepted its first envelope.
    let removed = Verifier {
        epochs: vec![
            (
                leaves.clone(),
                Some(EpochEnd {
                    processed_at: now,
                    time: now,
                }),
            ),
            (vec![(agent_id, Role::Agent)], None),
        ],
        cuts: vec![(human_id, head_one)],
        ..device.clone()
    };
    case(
        4,
        "beyond the Cut of a removed sender",
        bytes(&two.envelope)?,
        Verifier {
            heads: vec![(human_id, head_one)],
            ..removed.clone()
        },
    );
    case(
        4,
        "another envelope under the Cut's number",
        bytes(&other_one.envelope)?,
        removed.clone(),
    );

    let mut forged = one.envelope.clone();
    forged.signature[0] ^= 1;
    case(
        5,
        "a signature that does not verify",
        bytes(&forged)?,
        device.clone(),
    );
    let mut resigned = one.envelope.clone();
    seal::sign(&mut resigned, &agent)?;
    case(
        5,
        "signed by another device than the sender named",
        bytes(&resigned)?,
        device.clone(),
    );

    let at_one = Verifier {
        heads: vec![(human_id, head_one)],
        count: 1,
        ..device.clone()
    };
    case(
        6,
        "an envelope already accepted",
        bytes(&one.envelope)?,
        at_one.clone(),
    );
    case(
        6,
        "another envelope under an accepted number",
        bytes(&other_one.envelope)?,
        at_one.clone(),
    );
    case(
        6,
        "a number beyond the next",
        bytes(&two.envelope)?,
        device.clone(),
    );
    case(
        6,
        "the next number, linked to another envelope than the last accepted",
        bytes(&two.envelope)?,
        Verifier {
            heads: vec![(
                human_id,
                Head {
                    seq: 1,
                    hash: other_one.hash,
                },
            )],
            count: 1,
            ..device.clone()
        },
    );
    case(
        6,
        "the next envelope of the chain",
        bytes(&two.envelope)?,
        at_one,
    );

    // A card version by a human device: 9.2 gives cards to the session's agent and helper devices.
    let zero = Hash32::ZERO.to_base64url();
    let card = format!(
        r#"{{"schema_version":2,"card_type":"info","title":"Mine","object_version":1,"previous_version_hash":"{zero}"}}"#
    );
    let card = Draft::first_version(ObjectType::Card, Urgency::Normal, card.as_bytes())?;
    let forbidden = sealed(&card, &slot(session(), 0, human_id, Head::START), &human)?;
    case(
        7,
        "a card version by a human device",
        bytes(&forbidden.envelope)?,
        device.clone(),
    );

    // The epoch ended; an envelope of it comes more than two minutes after its Commit was processed.
    let ended = |processed_at: u64| Verifier {
        epochs: vec![
            (
                leaves.clone(),
                Some(EpochEnd {
                    processed_at,
                    time: processed_at,
                }),
            ),
            (leaves.clone(), None),
        ],
        ..device.clone()
    };
    case(
        8,
        "an older epoch, two minutes after its Commit",
        bytes(&one.envelope)?,
        ended(now - LIVE_GRACE_MS),
    );
    case(
        8,
        "an older epoch, more than two minutes after its Commit",
        bytes(&one.envelope)?,
        ended(now - LIVE_GRACE_MS - 1),
    );

    // What the hub checks beside the eight.
    case(
        0,
        "posted by another device than the one that signed it",
        bytes(&one.envelope)?,
        hub(agent_id),
    );
    case(
        0,
        "a new envelope in pruned form",
        bytes(&one.envelope.prune()?)?,
        hub(human_id),
    );
    case(
        0,
        "a stale session",
        bytes(&one.envelope)?,
        Verifier {
            stale: true,
            ..hub(human_id)
        },
    );
    case(
        0,
        "the 2^24 envelopes of an epoch are used up",
        bytes(&one.envelope)?,
        Verifier {
            count: MAX_ENVELOPES_PER_EPOCH,
            ..hub(human_id)
        },
    );
    let oversize = seal::seal_plaintext(
        chat("one").header(&slot(session(), 0, human_id, Head::START))?,
        &vec![0; 65_537],
        &case_key(0),
        crypto::random(entropy)?,
        &human,
    )?;
    case(
        0,
        "a sealed body beyond the largest padded size",
        bytes(&oversize.envelope)?,
        hub(human_id),
    );
    case(
        0,
        "the same body, served to a device as stored: its header counts and its body does not open",
        bytes(&oversize.envelope)?,
        device.clone(),
    );

    // Void records as a device is served them: pruned, with the hub's code.
    let void = |code: Error| Verifier {
        void_code: Some(code),
        ..device.clone()
    };
    case(
        0,
        "a void record whose reason the device checks again",
        bytes(&forbidden.envelope.prune()?)?,
        void(Error::Forbidden),
    );
    case(
        0,
        "a void record marked forbidden of an envelope 9.2 allows",
        bytes(&one.envelope.prune()?)?,
        void(Error::Forbidden),
    );
    case(
        0,
        "a void record whose reason cannot be checked again",
        bytes(&oversize.envelope.prune()?)?,
        void(Error::TooLarge),
    );
    Ok((cases, [human_id, agent_id, id(&stranger)]))
}

/// The parts of an envelope as the format names them.
fn parts(envelope: &Envelope, key: &Secret<32>) -> Result<Value, Error> {
    let header = codec::encode(&envelope.header)?;
    let Content::Full(ciphertext) = &envelope.content else {
        return Err(Error::Internal("a pruned envelope in the story"));
    };
    let padded = crypto::aead_open(key, &envelope.nonce, &header, ciphertext)?;
    let body = envelope.open(key)?;
    Ok(json!({
        "header": hex(&header),
        "nonce": hex(&envelope.nonce),
        "bind": hex(&seal::bind_bytes(body.bind())?),
        "padded_body": hex(&padded),
        "ciphertext_sha256": hex(crypto::sha256(ciphertext)?.as_bytes()),
        "signature": hex(&envelope.signature),
    }))
}

/// Makes the file.
pub fn generate() -> Result<Value, Error> {
    let mut entropy = entropy(NAME)?;
    let story = story(&mut entropy)?;
    let key = Secret::new(STORY_KEY);
    let mut envelopes = Vec::new();
    for told in &story.told {
        let envelope = Envelope::decode(&told.bytes)?;
        let mut entry = json!({
            "what": told.what,
            "sender": hex(told.sender.as_bytes()),
            "kind": envelope.header.subject.kind(),
            "seq": envelope.header.seq,
            "prev": hex(envelope.header.prev.as_bytes()),
            "time": told.time,
            "payload": String::from_utf8(told.payload.clone()).map_err(|_| Error::Internal("vector text"))?,
            "full": hex(&told.bytes),
            "pruned": hex(&envelope.prune()?.encode()?),
            "envelope_hash": hex(told.hash.as_bytes()),
        });
        if let (Some(entry), Value::Object(parts)) =
            (entry.as_object_mut(), parts(&envelope, &key)?)
        {
            entry.extend(parts);
        }
        envelopes.push(entry);
    }
    let first = story.told.first().ok_or(Error::Internal("empty story"))?;
    let (cases, [human, agent, stranger]) = cases(&mut entropy)?;
    let checks: Vec<Value> = cases
        .iter()
        .map(|case| {
            json!({
                "check": case.check,
                "why": case.why,
                "envelope": hex(&case.envelope),
                "verifier": case.verifier.to_json(),
                "result": result_text(&case.verifier.check(&case.envelope)),
            })
        })
        .collect();
    Ok(json!({
        "about": "Stored content (spec/v2.md section 9): a main session with one human and one agent device in epoch 0, and what they wrote, in the hub's order. Each envelope in full and in pruned form (hex), with its envelope_hash, its number and prev in the sender's chain, the payload its body opens to under content_key, and its parts: the encoded header (the AEAD's associated data), the nonce, the bind, the padded body (the AEAD's plaintext), the SHA-256 of the sealed body and the signature. refused: changes of the first envelope with where they show (decode: the bytes are no envelope; verify: the signature fails) and the code. checks: the receiver's checks of 9.0.5 and what the hub checks beside them (check 0), each on one envelope against a verifier written down: who checks (the hub taking a new envelope from signed_in, or a device in the hub's order), its clock, the epochs of the envelope's group with their leaves and the Commit that ended each, Cuts, whether the group is stale, the last accepted envelope per sender (heads), how many envelopes took a number in the newest epoch (count), and for a device the void_code the hub served the envelope with. result: the code of a refusal that takes no number; 'chained: <code>' for an envelope that takes its number and is not applied (at the hub: stored pruned as a void record); 'void: <code>' for a void record a device chains and does not apply, with 'finding: hub-voided-other' where it cannot check the reason again; 'taken'. The cases play in checks.group, whose content key in epoch e is 0x4B in every byte but the first eight, which are e as uint64.",
        "group_id": hex(story.group.as_bytes()),
        "content_key": hex(&STORY_KEY),
        "human": hex(story.human.as_bytes()),
        "agent": hex(story.agent.as_bytes()),
        "envelopes": envelopes,
        "refused": refused(first).iter().map(|(bytes, at, code, why)| json!({
            "bytes": hex(bytes), "at": at, "code": code, "why": why,
        })).collect::<Vec<_>>(),
        "checks": {
            "group": hex(session().as_bytes()),
            "human": hex(human.as_bytes()),
            "agent": hex(agent.as_bytes()),
            "stranger": hex(stranger.as_bytes()),
            "cases": checks,
        },
    }))
}
