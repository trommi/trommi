//! What the tests of stored content and live messages share: dice on a random source, and random strokes,
//! shapes, board items and whole histories of a board made with them.

use trommi_core::board::ShapeId;
use trommi_core::board_items::{
    Board, Ink, ItemBody, Note, NoteKind, Pen, Picture, Point, Shape, ShapeKind, Stroke,
};
use trommi_core::crypto::{Entropy, Secret};
use trommi_core::files::FileRef;
use trommi_core::ids::{DeviceId, FileId, Hash32};
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
