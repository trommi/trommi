//! What the tests of stored content and live messages share: dice on a random source, and random strokes,
//! shapes, board items and whole histories of a board made with them.

use std::collections::BTreeMap;
use trommi_core::board::ShapeId;
use trommi_core::board_items::{
    Board, Ink, ItemBody, Note, NoteKind, Pen, Picture, Point, Shape, ShapeKind, Stroke,
};
use trommi_core::chain::{
    ChainRecords, Chains, EpochEnd, GroupFacts, Head, Outcome, Receipt, Role,
};
use trommi_core::crypto::{Entropy, Secret};
use trommi_core::files::FileRef;
use trommi_core::ids::{DeviceId, FileId, GroupId, Hash32, RoomId};
use trommi_core::objects::Objects;
use trommi_core::Error;

/// Random choices from a random source.
pub struct Dice<E: Entropy>(pub E);

impl<E: Entropy> Dice<E> {
    /// `N` random bytes.
    pub fn bytes<const N: usize>(&mut self) -> Result<[u8; N], Error> {
        let mut bytes = [0u8; N];
        self.0.fill(&mut bytes)?;
        Ok(bytes)
    }

    /// A number below `limit`.
    pub fn below(&mut self, limit: u64) -> Result<u64, Error> {
        Ok(u64::from_le_bytes(self.bytes()?) % limit)
    }

    /// A number from `low` to `high`, both included.
    pub fn between(&mut self, low: i32, high: i32) -> Result<i32, Error> {
        let span = u64::try_from(i64::from(high) - i64::from(low) + 1).expect("low <= high");
        Ok((i64::from(low) + self.below(span)? as i64) as i32)
    }

    /// Yes, once in `n` times.
    pub fn one_in(&mut self, n: u64) -> Result<bool, Error> {
        Ok(self.below(n)? == 0)
    }
}

/// Random points: mostly small steps, now and then a jump across the whole range, so that the wrap is met.
pub fn ink<E: Entropy>(dice: &mut Dice<E>) -> Result<Ink, Error> {
    let tilted = dice.one_in(2)?;
    let (mut x, mut y, mut t) = (
        dice.between(-80_000, 80_000)?,
        dice.between(-80_000, 80_000)?,
        0u32,
    );
    let mut points = Vec::new();
    for _ in 0..dice.between(1, 12)? {
        if dice.one_in(9)? {
            x = i32::from_le_bytes(dice.bytes()?);
            y = i32::from_le_bytes(dice.bytes()?);
        } else {
            x = x.wrapping_add(dice.between(-300, 300)?);
            y = y.wrapping_add(dice.between(-300, 300)?);
        }
        t += dice.below(40)? as u32;
        points.push(Point {
            x,
            y,
            t,
            force: dice.below(256)? as u8,
            azimuth: if tilted { dice.below(256)? as u8 } else { 0 },
            altitude: if tilted { dice.below(256)? as u8 } else { 0 },
        });
    }
    Ink::new(points, tilted, dice.one_in(3)?)
}

/// A random shape of any kind.
pub fn shape<E: Entropy>(dice: &mut Dice<E>) -> Result<Shape, Error> {
    let colors = ["ink", "blue", "yellow", "red"];
    let color = colors[dice.below(4)? as usize].to_owned();
    let kind = match dice.below(5)? {
        0..=2 => ShapeKind::Stroke(Stroke {
            pen: if dice.one_in(3)? {
                Pen::Marker
            } else {
                Pen::Pen
            },
            color,
            width: dice.between(1, 400)?,
            ink: ink(dice)?,
            live: if dice.one_in(2)? {
                Some(dice.bytes()?)
            } else {
                None
            },
        }),
        3 => ShapeKind::Note(Note {
            kind: [NoteKind::Text, NoteKind::Sticky, NoteKind::Voice][dice.below(3)? as usize],
            at: [dice.between(-9_000, 9_000)?, dice.between(-9_000, 9_000)?],
            text: ["", "Ship it", "größer \"denken\"\n• zwei"][dice.below(3)? as usize].to_owned(),
            size: dice.between(160, 640)?,
            color,
            wrap: if dice.one_in(2)? {
                Some(dice.between(800, 6_400)?)
            } else {
                None
            },
        }),
        _ => ShapeKind::Picture(Picture {
            rect: [
                dice.between(-9_000, 9_000)?,
                dice.between(-9_000, 9_000)?,
                dice.between(-9_000, 9_000)?,
                dice.between(-9_000, 9_000)?,
            ],
            file: FileRef {
                file_id: FileId::new(dice.bytes()?),
                file_key: Secret::new(dice.bytes()?),
                sha256: Hash32::new(dice.bytes()?),
            },
            file_name: "sketch.png".to_owned(),
            media_type: "image/png".to_owned(),
            total_size: dice.below(5_000_000)?,
            width: if dice.one_in(2)? {
                Some(dice.below(4_000)? as u32)
            } else {
                None
            },
            height: if dice.one_in(2)? {
                Some(dice.below(4_000)? as u32)
            } else {
                None
            },
        }),
    };
    Ok(Shape {
        kind,
        z: if dice.one_in(3)? {
            dice.between(-5, 5)?
        } else {
            0
        },
        group: if dice.one_in(4)? {
            Some("g1".to_owned())
        } else {
            None
        },
    })
}

/// One board item as a receiver gets it: who signed it under which number, and its payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    /// The writer.
    pub sender: DeviceId,
    /// The envelope's number in the writer's chain.
    pub seq: u64,
    /// The payload.
    pub payload: Vec<u8>,
}

/// A random history of one board: `len` items by `writers`, each writer's numbers ascending with holes (its
/// chain carries other things too). Erases and moves name shapes that exist, shapes that were erased, shapes
/// of numbers still to come and shapes that never come.
pub fn history<E: Entropy>(
    dice: &mut Dice<E>,
    writers: &[DeviceId],
    len: usize,
) -> Result<Vec<Item>, Error> {
    let mut last = vec![0u64; writers.len()];
    let mut items = Vec::new();
    for _ in 0..len {
        let who = dice.below(writers.len() as u64)? as usize;
        last[who] += 1 + dice.below(3)?;
        let mut targets = Vec::new();
        for _ in 0..dice.between(1, 4)? {
            let of = dice.below(writers.len() as u64)? as usize;
            let id = ShapeId {
                sender: writers[of],
                seq: 1 + dice.below(last[of] + 3)?,
                index: dice.below(3)? as u32,
            };
            if !targets.contains(&id) {
                targets.push(id);
            }
        }
        let body = match dice.below(10)? {
            0..=4 => {
                let mut shapes = Vec::new();
                for _ in 0..dice.between(1, 3)? {
                    shapes.push(shape(dice)?);
                }
                ItemBody::Strokes(shapes)
            }
            5 | 6 => ItemBody::Erase(targets),
            7 => ItemBody::SendAway(targets),
            _ => ItemBody::Move {
                shapes: targets,
                offset: if dice.one_in(6)? {
                    [i32::MAX, i32::MIN]
                } else {
                    [dice.between(-400, 400)?, dice.between(-400, 400)?]
                },
            },
        };
        items.push(Item {
            sender: writers[who],
            seq: last[who],
            payload: body.encode()?.expose().to_vec(),
        });
    }
    Ok(items)
}

/// The same items in another order of arrival: every writer's own items keep their order, as its chain makes
/// sure; between writers the order is random.
pub fn another_order<E: Entropy>(dice: &mut Dice<E>, items: &[Item]) -> Result<Vec<Item>, Error> {
    let mut writers: Vec<DeviceId> = Vec::new();
    for item in items {
        if !writers.contains(&item.sender) {
            writers.push(item.sender);
        }
    }
    let mut queues: Vec<std::collections::VecDeque<&Item>> = writers
        .iter()
        .map(|writer| items.iter().filter(|item| item.sender == *writer).collect())
        .collect();
    let mut order = Vec::new();
    while order.len() < items.len() {
        let from = dice.below(queues.len() as u64)? as usize;
        if let Some(item) = queues[from].pop_front() {
            order.push(item.clone());
        }
    }
    Ok(order)
}

/// Applies items to a board in the order given.
pub fn apply_all<'a>(
    board: &mut Board,
    items: impl IntoIterator<Item = &'a Item>,
) -> Result<(), Error> {
    for item in items {
        board.apply(item.sender, item.seq, ItemBody::decode(&item.payload)?)?;
    }
    Ok(())
}

// ---- one party's view of one group, written by hand ----

/// The room of every hand-written view.
pub const ROOM: RoomId = RoomId::new([1; 32]);

/// What one device, or the hub, knows of one group in its epoch 0: the leaves with their roles, the content
/// key if it holds one, and what it accepted. It stands in for the MLS engine where a test is about stored
/// content alone.
pub struct View {
    /// The group.
    pub group: GroupId,
    /// The leaves and their roles.
    pub leaves: BTreeMap<DeviceId, Role>,
    /// The content key of epoch 0; the hub holds none.
    pub key: Option<[u8; 32]>,
    /// The hash of every accepted envelope.
    pub accepted: BTreeMap<(DeviceId, u64), Hash32>,
    /// The chains.
    pub chains: Chains,
    /// The objects.
    pub objects: Objects,
}

impl View {
    /// A view of `group` with these leaves.
    pub fn new(group: GroupId, leaves: &[(DeviceId, Role)], key: Option<[u8; 32]>) -> Self {
        Self {
            group,
            leaves: leaves.iter().copied().collect(),
            key,
            accepted: BTreeMap::new(),
            chains: Chains::new(),
            objects: Objects::new(),
        }
    }

    /// Stores what a receipt changes, as one write.
    pub fn store(&mut self, receipt: &Receipt) -> Result<(), Error> {
        self.chains.apply(receipt.advance())?;
        if let Outcome::Taken {
            transition: Some(transition),
            ..
        } = receipt.outcome()
        {
            self.objects.apply(transition)?;
        }
        self.accepted.insert(
            (receipt.advance().sender, receipt.advance().head.seq),
            receipt.hash(),
        );
        Ok(())
    }
}

impl GroupFacts for View {
    fn room(&self) -> RoomId {
        ROOM
    }

    fn processed_epoch(&self, group: &GroupId) -> Result<Option<u64>, Error> {
        Ok((*group == self.group).then_some(0))
    }

    fn leaf_role(&self, _: &GroupId, epoch: u64, device: &DeviceId) -> Result<Option<Role>, Error> {
        Ok(self.leaves.get(device).copied().filter(|_| epoch == 0))
    }

    fn seat(&self, _: &GroupId, _: u64) -> Result<Option<DeviceId>, Error> {
        Ok(self
            .leaves
            .iter()
            .find(|(_, role)| **role == Role::Agent)
            .map(|(device, _)| *device))
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

    fn is_human_now(&self, device: &DeviceId) -> Result<bool, Error> {
        Ok(self.leaves.get(device) == Some(&Role::Human))
    }

    fn content_key(&self, _: &GroupId, _: u64) -> Result<Option<Secret<32>>, Error> {
        Ok(self.key.map(Secret::new))
    }
}

impl ChainRecords for View {
    fn accepted_hash(
        &self,
        _: &GroupId,
        sender: &DeviceId,
        seq: u64,
    ) -> Result<Option<Hash32>, Error> {
        Ok(self.accepted.get(&(*sender, seq)).copied())
    }
}

// ---- a session's story: one envelope of every kind ----

use trommi_core::chain::{hub_take, receive, seal_next, Mode, OwnChain, Served};
use trommi_core::crypto::SigningKey;
use trommi_core::envelope::{
    AnswerBind, Draft, ObjectType, TakeBackBind, Urgency, Verdict, VerdictBind,
};
use trommi_core::ids::SessionId;
use trommi_core::registers::{self, OwnIds, Registers};

/// The clock of the story's first envelope; each later one is a second on.
pub const STORY_START: u64 = 1_800_000_000_000;
/// The content key of the story's group in its epoch 0.
pub const STORY_KEY: [u8; 32] = [7; 32];

/// One envelope of a story, as the hub stores it.
#[derive(Debug, Clone)]
pub struct Told {
    /// What it is, in a word or two.
    pub what: &'static str,
    /// Who signed it.
    pub sender: DeviceId,
    /// Its bytes.
    pub bytes: Vec<u8>,
    /// Its hash.
    pub hash: Hash32,
    /// Its payload.
    pub payload: Vec<u8>,
    /// The sender's clock.
    pub time: u64,
}

/// A main session with one human and one agent device, and what they wrote in the hub's order: a card with a
/// push, its answer, the take back, a second answer, a closing version, a permission request and its verdict,
/// Chat both ways and a register of each.
pub struct Story {
    /// The session group.
    pub group: GroupId,
    /// The human device.
    pub human: DeviceId,
    /// The agent device.
    pub agent: DeviceId,
    /// The envelopes.
    pub told: Vec<Told>,
}

impl Story {
    /// The leaves of the group.
    pub fn leaves(&self) -> [(DeviceId, Role); 2] {
        [(self.human, Role::Human), (self.agent, Role::Agent)]
    }

    /// A fresh view of the group: the hub's without `key`, a device's with it.
    pub fn view(&self, key: bool) -> View {
        View::new(self.group, &self.leaves(), key.then_some(STORY_KEY))
    }
}

/// Tells the story with keys and nonces from `entropy`.
pub fn story<E: Entropy>(entropy: &mut E) -> Result<Story, Error> {
    let human = SigningKey::generate(entropy)?;
    let agent = SigningKey::generate(entropy)?;
    let (human_id, agent_id) = (DeviceId::new(human.public()), DeviceId::new(agent.public()));
    let session = SessionId::new([2; 16]);
    let group = GroupId::session(ROOM, session);
    let mut story = Story {
        group,
        human: human_id,
        agent: agent_id,
        told: Vec::new(),
    };
    // Both devices see every envelope at once: one view serves as the state either seals against.
    let mut view = story.view(true);
    let mut hub = story.view(false);
    let (mut human_chain, mut agent_chain) = (OwnChain::new(), OwnChain::new());
    let mut registers_seen = Registers::new();
    let (mut human_ids, mut agent_ids) = (OwnIds::new(), OwnIds::new());

    let mut tell = |what: &'static str,
                    by_agent: bool,
                    draft: Draft,
                    payload: &[u8],
                    view: &mut View,
                    entropy: &mut E|
     -> Result<Hash32, Error> {
        let time = STORY_START + 1000 * story.told.len() as u64;
        let (signer, chain, id) = if by_agent {
            (&agent, &mut agent_chain, agent_id)
        } else {
            (&human, &mut human_chain, human_id)
        };
        let sealed = seal_next(
            view,
            &view.chains,
            &view.objects,
            chain,
            &draft,
            group,
            signer,
            time,
            entropy,
        )?;
        let bytes = sealed.envelope.encode()?;
        let taken = hub_take(&hub, &hub, &hub.chains, &hub.objects, &id, &bytes, time)?;
        hub.store(&taken)?;
        let receipt = receive(
            view,
            view,
            &view.chains,
            &view.objects,
            &id,
            &bytes,
            &Served::Stored,
            Mode::InOrder,
            time,
        )?;
        view.store(&receipt)?;
        story.told.push(Told {
            what,
            sender: id,
            bytes,
            hash: sealed.hash,
            payload: payload.to_vec(),
            time,
        });
        Ok(sealed.hash)
    };

    let zero = Hash32::ZERO.to_base64url();
    let card = format!(
        r#"{{"schema_version":2,"card_type":"decision","title":"Ship?","options":[{{"key":"yes","label":"Yes"}},{{"key":"no","label":"No"}}],"object_version":1,"previous_version_hash":"{zero}"}}"#
    );
    let draft = Draft::first_version(ObjectType::Card, Urgency::High, card.as_bytes())?.with_push();
    let card_hash = tell(
        "card version 1",
        true,
        draft,
        card.as_bytes(),
        &mut view,
        entropy,
    )?;
    let (card_id, _) = view
        .objects
        .iter()
        .next()
        .ok_or(Error::Internal("no card"))?;
    let card_id = *card_id;

    let chat = br#"{"schema_version":2,"content_type":"message","text":"Looking at it"}"#;
    let draft = Draft::session_chat(session, agent_id, chat);
    tell("chat to the agent", false, draft, chat, &mut view, entropy)?;

    let answer = br#"{"schema_version":2,"answer_action":"answer","choices":["yes"]}"#;
    let bind = AnswerBind {
        object_id: card_id,
        version_hash: card_hash,
        choices: vec![b"yes".to_vec()],
    };
    let draft = Draft::answer(bind, false, Urgency::High, agent_id, answer);
    let answer_hash = tell("answer", false, draft, answer, &mut view, entropy)?;

    let back = br#"{"schema_version":2}"#;
    let bind = TakeBackBind {
        object_id: card_id,
        previous_hash: answer_hash,
        version_hash: card_hash,
    };
    let draft = Draft::take_back(bind, Urgency::High, agent_id, back);
    tell("take back", false, draft, back, &mut view, entropy)?;

    let answer =
        br#"{"schema_version":2,"answer_action":"answer","choices":["no"],"note":"Not yet"}"#;
    let bind = AnswerBind {
        object_id: card_id,
        version_hash: card_hash,
        choices: vec![b"no".to_vec()],
    };
    let draft = Draft::answer(bind, false, Urgency::High, agent_id, answer);
    tell("second answer", false, draft, answer, &mut view, entropy)?;

    let closing = format!(
        r#"{{"schema_version":2,"card_type":"decision","title":"Ship?","close_summary":"Later","object_version":2,"previous_version_hash":"{}"}}"#,
        card_hash.to_base64url()
    );
    let draft = Draft::later_version(
        card_id,
        ObjectType::Card,
        true,
        Urgency::High,
        card_hash,
        closing.as_bytes(),
    )?;
    tell(
        "closing version",
        true,
        draft,
        closing.as_bytes(),
        &mut view,
        entropy,
    )?;

    let request = br#"{"schema_version":2,"tool_name":"Bash","description":"Run the tests","input_preview":"cargo test"}"#;
    let expires_at = STORY_START + 600_000;
    let draft = Draft::request(Urgency::Normal, expires_at, request).with_push();
    let request_hash = tell(
        "permission request",
        true,
        draft,
        request,
        &mut view,
        entropy,
    )?;
    let request_id = view
        .objects
        .iter()
        .map(|(id, _)| *id)
        .find(|id| *id != card_id)
        .ok_or(Error::Internal("no request"))?;

    let verdict = br#"{"schema_version":2}"#;
    let bind = VerdictBind {
        request_id,
        request_hash,
        expires_at,
        verdict: Verdict::Allow,
    };
    let draft = Draft::verdict(bind, Urgency::Normal, agent_id, verdict);
    tell("verdict", false, draft, verdict, &mut view, entropy)?;

    let chat =
        br#"{"schema_version":2,"content_type":"message","text":"All green","terminal":"answer"}"#;
    let draft = Draft::session_chat(session, DeviceId::ZERO, chat);
    tell("chat from the agent", true, draft, chat, &mut view, entropy)?;

    for (by_agent, name, value) in [
        (
            true,
            "status_line/main",
            r#"{"label":"Build","state":"done"}"#,
        ),
        (
            false,
            "goals",
            r#"{"desk_id":"d","desk_name":"Desk","goals":"Ship"}"#,
        ),
    ] {
        let ids = if by_agent {
            &mut agent_ids
        } else {
            &mut human_ids
        };
        let draft = registers::write(&registers_seen, ids, name, Some(value), entropy)?;
        let payload = registers::Value {
            name: name.to_owned(),
            value: Some(value.to_owned()),
            lamport: registers::next_lamport(registers_seen.largest_lamport())?,
        }
        .payload()?;
        tell(
            if by_agent {
                "agent register"
            } else {
                "human register"
            },
            by_agent,
            draft,
            &payload,
            &mut view,
            entropy,
        )?;
        registers_seen.observe_lamport(registers::next_lamport(registers_seen.largest_lamport())?);
    }
    Ok(story)
}
