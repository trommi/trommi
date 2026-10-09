//! The Scribble Board (section 10): the ids of boards and shapes, the register that points at a board's
//! snapshot, and the rule by which a device loads a board from a snapshot without reading every writer's chain
//! from its first envelope.
//!
//! A board's items are item envelopes on the timeline `desk/<board>` in the room group. What a stroke looks
//! like, and what the snapshot file holds, is the app's (`strokes.json`); this module checks only that what the
//! hub served is complete and is what the writers signed.

use crate::chain::{Head, HeadsWire, Outcome, Receipt};
use crate::envelope::{Subject, Timeline};
use crate::error::Error;
use crate::ids::{DeviceId, Hash32};
use crate::registers::BOARD_SNAPSHOT;
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

pub use crate::ids::BoardId;

/// A device loads a board's items from this many changes before the snapshot's `change` on.
pub const ITEMS_BEFORE_SNAPSHOT: u64 = 1000;

/// The id of one shape: `<sender>/<envelope number>/<index>`, the sender in base64url, the two numbers in
/// decimal without leading zeros. Erase, move and send away name shapes by it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct ShapeId {
    /// The device that drew the shape.
    pub sender: DeviceId,
    /// The number, in the sender's chain in the room group, of the envelope that carries it.
    pub seq: u64,
    /// Its place among the shapes of that envelope, from 0.
    pub index: u32,
}

/// A whole number as this format writes it: digits only, no sign, no leading zero.
fn decimal<T: std::str::FromStr>(text: &str) -> Result<T, Error> {
    let canonical = !text.is_empty()
        && text.bytes().all(|b| b.is_ascii_digit())
        && (text == "0" || !text.starts_with('0'));
    if !canonical {
        return Err(Error::BadFormat);
    }
    text.parse().map_err(|_| Error::BadFormat)
}

impl ShapeId {
    /// The shape id this text names; `bad-format` for anything but its one canonical form.
    pub fn parse(text: &str) -> Result<Self, Error> {
        let mut parts = text.split('/');
        let (Some(sender), Some(seq), Some(index), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(Error::BadFormat);
        };
        let seq: u64 = decimal(seq)?;
        if seq == 0 {
            return Err(Error::BadFormat);
        }
        Ok(Self {
            sender: DeviceId::from_base64url(sender)?,
            seq,
            index: decimal(index)?,
        })
    }
}

impl fmt::Display for ShapeId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}/{}/{}",
            self.sender.to_base64url(),
            self.seq,
            self.index
        )
    }
}

/// The name of the register that points at the snapshot of `board`: `board_snapshot/<board>`, the board in
/// base64url.
pub fn snapshot_name(board: &BoardId) -> String {
    format!("{BOARD_SNAPSHOT}{}", board.to_base64url())
}

/// The value of `board_snapshot/<board>` (section 10.2). The attachment holds the snapshot file's key and is
/// never printed.
#[derive(Clone, PartialEq, Eq)]
pub struct Snapshot {
    /// The attachment reference of the snapshot file (section 9.1.1), as JSON text. It holds the file's key.
    pub attachment: String,
    /// Per writer, the number and hash of its last envelope in the room group that the snapshot covers,
    /// ascending by writer.
    pub frontier: Vec<(DeviceId, Head)>,
    /// The hub's change number that the snapshot's writer had processed.
    pub change: u64,
}

impl fmt::Debug for Snapshot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Snapshot")
            .field("attachment", &"<redacted>")
            .field("frontier", &self.frontier)
            .field("change", &self.change)
            .finish()
    }
}

#[derive(Deserialize)]
struct SnapshotWire {
    attachment: serde_json::Map<String, serde_json::Value>,
    frontier: HeadsWire,
    change: u64,
}

impl Snapshot {
    /// The snapshot a register value names; `bad-format` unless the text is a JSON object with an `attachment`
    /// object, a `frontier` of the shape `{ "<writer>": [seq, envelope_hash] }` and a whole `change`.
    pub fn parse(value: &str) -> Result<Self, Error> {
        let wire: SnapshotWire = serde_json::from_str(value).map_err(|_| Error::BadFormat)?;
        Ok(Self {
            attachment: serde_json::to_string(&wire.attachment).map_err(|_| Error::BadFormat)?,
            frontier: wire.frontier.heads()?,
            change: wire.change,
        })
    }

    /// The register value: `{ attachment, frontier, change }` as JSON text. `bad-format` if `attachment` is not
    /// a JSON object.
    pub fn value(&self) -> Result<String, Error> {
        let attachment: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(&self.attachment).map_err(|_| Error::BadFormat)?;
        let frontier: serde_json::Map<String, serde_json::Value> = self
            .frontier
            .iter()
            .map(|(writer, head)| {
                (
                    writer.to_base64url(),
                    serde_json::json!([head.seq, head.hash.to_base64url()]),
                )
            })
            .collect();
        if frontier.len() != self.frontier.len() || self.frontier.iter().any(|(_, h)| h.seq == 0) {
            return Err(Error::BadFormat);
        }
        serde_json::to_string(&serde_json::json!({
            "attachment": attachment,
            "frontier": frontier,
            "change": self.change,
        }))
        .map_err(|_| Error::Internal("snapshot value"))
    }

    /// The change number from which a device asks the hub for the board's items.
    pub fn items_after_change(&self) -> u64 {
        self.change.saturating_sub(ITEMS_BEFORE_SNAPSHOT)
    }

    /// Where the snapshot stands in the chain of `writer`: [`Head::START`] for a writer it does not name.
    pub fn frontier_of(&self, writer: &DeviceId) -> Head {
        self.frontier
            .iter()
            .find(|(named, _)| named == writer)
            .map_or(Head::START, |(_, head)| *head)
    }
}

/// One envelope of a writer's chain after the frontier, as far as loading a board looks at it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Link {
    /// Its number.
    pub seq: u64,
    /// The `prev` of its header.
    pub prev: Hash32,
    /// Its `envelope_hash`.
    pub hash: Hash32,
    /// The board it adds an item to, if it is an item of a board that counts: taken, not a void record and
    /// not refused.
    pub board: Option<BoardId>,
}

impl Link {
    /// The link of an envelope that the receiver's checks accepted into its chain
    /// ([`crate::chain::receive`]), full or pruned.
    pub fn of(receipt: &Receipt) -> Self {
        let header = &receipt.envelope.header;
        let board = match (&receipt.outcome, &header.subject) {
            (Outcome::Taken { .. }, Subject::Item(Timeline::Board(board))) => Some(*board),
            _ => None,
        };
        Self {
            seq: header.seq,
            prev: header.prev,
            hash: receipt.hash,
            board,
        }
    }
}

/// An item the hub served for the board.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ServedItem {
    /// Its sender.
    pub sender: DeviceId,
    /// Its number in the sender's chain.
    pub seq: u64,
    /// Its `envelope_hash`.
    pub hash: Hash32,
}

/// A board that loaded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Loaded {
    /// The frontier now applied: per writer the last envelope of its verified chain, ascending by writer. The
    /// next snapshot must stand at or beyond it.
    pub frontier: Vec<(DeviceId, Head)>,
    /// The served items (by their index in `served`) that lie after the snapshot's frontier and were found
    /// in their writer's chain: the device adds them to the shapes of the snapshot.
    pub fresh: Vec<usize>,
    /// The served items at or before the snapshot's frontier: the snapshot stands for them.
    pub covered: Vec<usize>,
}

/// The loading rule of section 10.3, as a check of what the hub served.
///
/// `applied` is the frontier of the snapshot this device applied last for the board (empty the first time),
/// `snapshot` the newest snapshot (the current value of the register by 9.3.2), `served` the board's items the
/// hub gave from [`Snapshot::items_after_change`] on, and `chains` per writer its envelopes after the snapshot's
/// frontier in ascending order, each verified by the receiver's checks 1 to 5 before it is handed in here
/// ([`Link::of`]). A writer without a chain here is taken to have written nothing since.
///
/// Refuses with: `replay` if the snapshot's frontier lies before the applied one for some writer, and
/// `equivocation` if it names another envelope under the same number; `gap` or `chain-break` if a writer's chain
/// after the frontier does not link; `withheld` if an envelope of a chain names this board and was not served, or
/// a served item lies beyond what its writer's chain shows; `hash-mismatch` if a served item is not the envelope
/// its writer's chain has under that number; `equivocation` if a served item at the frontier's number has
/// another hash than the frontier; `forbidden` if a served item is, by its writer's chain, no item of this
/// board that counts; `bad-format` for a writer or an item given twice.
pub fn verify_load(
    board: &BoardId,
    applied: &[(DeviceId, Head)],
    snapshot: &Snapshot,
    served: &[ServedItem],
    chains: &[(DeviceId, Vec<Link>)],
) -> Result<Loaded, Error> {
    for (writer, was) in applied {
        let now = snapshot.frontier_of(writer);
        if now.seq < was.seq {
            return Err(Error::Replay);
        }
        if now.seq == was.seq && now.hash != was.hash {
            return Err(Error::Equivocation);
        }
    }

    let mut frontier: BTreeMap<DeviceId, Head> = snapshot.frontier.iter().copied().collect();
    let mut links: BTreeMap<(DeviceId, u64), &Link> = BTreeMap::new();
    let mut writers = BTreeSet::new();
    for (writer, chain) in chains {
        if !writers.insert(*writer) {
            return Err(Error::BadFormat);
        }
        let mut last = snapshot.frontier_of(writer);
        for link in chain {
            if last.seq.checked_add(1) != Some(link.seq) {
                return Err(Error::Gap);
            }
            if link.prev != last.hash {
                return Err(Error::ChainBreak);
            }
            last = Head {
                seq: link.seq,
                hash: link.hash,
            };
            links.insert((*writer, link.seq), link);
        }
        if last.seq > 0 {
            frontier.insert(*writer, last);
        }
    }

    let mut fresh = Vec::new();
    let mut covered = Vec::new();
    let mut seen = BTreeSet::new();
    for (index, item) in served.iter().enumerate() {
        if !seen.insert((item.sender, item.seq)) {
            return Err(Error::BadFormat);
        }
        let start = snapshot.frontier_of(&item.sender);
        if item.seq < start.seq {
            covered.push(index);
        } else if item.seq == start.seq {
            if item.hash != start.hash {
                return Err(Error::Equivocation);
            }
            covered.push(index);
        } else {
            let link = links.get(&(item.sender, item.seq)).ok_or(Error::Withheld)?;
            if link.hash != item.hash {
                return Err(Error::HashMismatch);
            }
            if link.board != Some(*board) {
                return Err(Error::Forbidden);
            }
            fresh.push(index);
        }
    }
    let missing = links.iter().any(|((writer, seq), link)| {
        link.board == Some(*board) && !seen.contains(&(*writer, *seq))
    });
    if missing {
        return Err(Error::Withheld);
    }
    Ok(Loaded {
        frontier: frontier.into_iter().collect(),
        fresh,
        covered,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chain::testing::*;
    use crate::chain::{Chains, Mode, Served};
    use crate::envelope::testing::{device, payload};
    use crate::envelope::{Draft, Envelope};
    use crate::registers::{may_write, name_owner, NameOwner};

    #[test]
    fn the_board_of_all_desks_has_its_fixed_id() {
        assert_eq!(
            BoardId::ALL_DESKS.to_string(),
            "616c6c2d6465736b7300000000000009"
        );
        let name = snapshot_name(&BoardId::ALL_DESKS);
        assert_eq!(
            name,
            format!("board_snapshot/{}", BoardId::ALL_DESKS.to_base64url())
        );
        assert_eq!(name_owner(&name, true), Some(NameOwner::RoomHumans));
        assert!(may_write(
            &name,
            true,
            crate::chain::Role::Human,
            &device(1)
        ));
        assert!(!may_write(
            &name,
            false,
            crate::chain::Role::Agent,
            &device(3)
        ));
    }

    #[test]
    fn a_shape_id_has_one_text() {
        let id = ShapeId {
            sender: device(1),
            seq: 17,
            index: 3,
        };
        let text = id.to_string();
        assert_eq!(text, format!("{}/17/3", device(1).to_base64url()));
        assert_eq!(ShapeId::parse(&text).unwrap(), id);
        let largest = ShapeId {
            sender: device(2),
            seq: u64::MAX,
            index: u32::MAX,
        };
        assert_eq!(ShapeId::parse(&largest.to_string()).unwrap(), largest);
        let zero = ShapeId {
            sender: device(2),
            seq: 1,
            index: 0,
        };
        assert_eq!(ShapeId::parse(&zero.to_string()).unwrap(), zero);

        let sender = device(1).to_base64url();
        let refused = [
            String::new(),
            sender.clone(),
            format!("{sender}/17"),
            format!("{sender}/17/3/0"),
            format!("{sender}/17/3/"),
            format!("/{sender}/17/3"),
            format!("{sender}/0/3"),
            format!("{sender}/017/3"),
            format!("{sender}/17/03"),
            format!("{sender}/+17/3"),
            format!("{sender}/-1/3"),
            format!("{sender}/17/ 3"),
            format!("{sender}/1e3/3"),
            format!("{sender}//3"),
            format!("{sender}/17/"),
            format!("{sender}/18446744073709551616/3"),
            format!("{sender}/17/4294967296"),
            format!("{sender}=/17/3"),
            "short/17/3".to_string(),
            format!("{}/17/3", device(1)),
        ];
        for text in refused {
            assert_eq!(ShapeId::parse(&text), Err(Error::BadFormat), "{text}");
        }
    }

    fn head(seq: u64, byte: u8) -> Head {
        Head {
            seq,
            hash: Hash32::new([byte; 32]),
        }
    }

    #[test]
    fn a_snapshot_value_round_trips_and_is_read_strictly() {
        let snapshot = Snapshot {
            attachment: r#"{"file_id":"AAAA","file_key":"BBBB","total_size":12}"#.into(),
            frontier: {
                let mut frontier = vec![(device(1), head(4, 1)), (device(2), head(9, 2))];
                frontier.sort_by_key(|(writer, _)| *writer);
                frontier
            },
            change: 5000,
        };
        let value = snapshot.value().unwrap();
        assert_eq!(Snapshot::parse(&value).unwrap(), snapshot);
        assert!(!format!("{snapshot:?}").contains("BBBB"));
        assert_eq!(snapshot.items_after_change(), 4000);
        assert_eq!(snapshot.frontier_of(&device(2)), head(9, 2));
        assert_eq!(snapshot.frontier_of(&device(3)), Head::START);
        let early = Snapshot {
            change: 999,
            frontier: Vec::new(),
            ..snapshot.clone()
        };
        assert_eq!(early.items_after_change(), 0);
        assert_eq!(Snapshot::parse(&early.value().unwrap()).unwrap(), early);
        // The value fits a register payload.
        let register = crate::registers::Value {
            name: snapshot_name(&BoardId::ALL_DESKS),
            value: Some(value),
            lamport: 1,
        };
        assert!(register.payload().is_ok());

        let writer = device(1).to_base64url();
        let hash = Hash32::new([1; 32]).to_base64url();
        let refused = [
            "{}".to_string(),
            "[]".to_string(),
            r#"{"attachment":{},"frontier":{}}"#.to_string(),
            r#"{"attachment":{},"change":1}"#.to_string(),
            r#"{"frontier":{},"change":1}"#.to_string(),
            r#"{"attachment":"x","frontier":{},"change":1}"#.to_string(),
            r#"{"attachment":{},"frontier":[],"change":1}"#.to_string(),
            r#"{"attachment":{},"frontier":{},"change":-1}"#.to_string(),
            r#"{"attachment":{},"frontier":{},"change":"1"}"#.to_string(),
            format!(r#"{{"attachment":{{}},"frontier":{{"{writer}":[0,"{hash}"]}},"change":1}}"#),
            format!(r#"{{"attachment":{{}},"frontier":{{"{writer}":["{hash}"]}},"change":1}}"#),
            format!(r#"{{"attachment":{{}},"frontier":{{"x":[1,"{hash}"]}},"change":1}}"#),
            format!(
                r#"{{"attachment":{{}},"frontier":{{"{writer}":[1,"{hash}"],"{writer}":[2,"{hash}"]}},"change":1}}"#
            ),
            format!(r#"{{"attachment":{{}},"frontier":{{"{writer}":[1,"{hash}x"]}},"change":1}}"#),
        ];
        for text in refused {
            assert_eq!(Snapshot::parse(&text), Err(Error::BadFormat), "{text}");
        }
        let good =
            format!(r#"{{"attachment":{{}},"frontier":{{"{writer}":[1,"{hash}"]}},"change":1}}"#);
        assert_eq!(
            Snapshot::parse(&good).unwrap().frontier,
            [(device(1), head(1, 1))]
        );
        // A writer's side: an attachment that is no object, a head of number 0.
        let bad = Snapshot {
            attachment: "[]".into(),
            ..snapshot.clone()
        };
        assert_eq!(bad.value(), Err(Error::BadFormat));
        let bad = Snapshot {
            frontier: vec![(device(1), Head::START)],
            ..snapshot
        };
        assert_eq!(bad.value(), Err(Error::BadFormat));
    }

    const BOARD: BoardId = BoardId::new([7; 16]);
    const OTHER_BOARD: BoardId = BoardId::new([8; 16]);

    /// A board with two writers. Device 1 wrote three items before the snapshot and two after it, with an
    /// item of another board and a register between; device 2 wrote one item after the snapshot.
    struct Scene {
        snapshot: Snapshot,
        served: Vec<ServedItem>,
        chains: Vec<(DeviceId, Vec<Link>)>,
    }

    fn item(receipt: &Receipt) -> ServedItem {
        ServedItem {
            sender: receipt.envelope.header.sender,
            seq: receipt.envelope.header.seq,
            hash: receipt.hash,
        }
    }

    fn scene() -> Scene {
        let mut world = World::new();
        let stroke = |board| Draft::board_item(board, &payload("stroke"));
        let before: Vec<Receipt> = (0..3)
            .map(|_| world.post(1, room(), &stroke(BOARD)))
            .collect();
        let snapshot = Snapshot {
            attachment: "{}".into(),
            frontier: world.chains(&room()).heads(),
            change: 2000,
        };
        let after = [
            world.post(1, room(), &stroke(BOARD)),
            world.post(1, room(), &stroke(OTHER_BOARD)),
            world.post(
                1,
                room(),
                &Draft::register(crate::ids::RegisterId::new([1; 16]), &payload("r")),
            ),
            world.post(1, room(), &stroke(BOARD)),
        ];
        let by_two = world.post(2, room(), &stroke(BOARD));
        Scene {
            snapshot,
            // The hub serves from 1 000 changes before the snapshot: one covered item comes along.
            served: vec![
                item(&before[2]),
                item(&after[0]),
                item(&after[3]),
                item(&by_two),
            ],
            chains: vec![
                (device(1), after.iter().map(Link::of).collect()),
                (device(2), vec![Link::of(&by_two)]),
            ],
        }
    }

    impl Scene {
        fn load(&self) -> Result<Loaded, Error> {
            verify_load(&BOARD, &[], &self.snapshot, &self.served, &self.chains)
        }
    }

    #[test]
    fn a_board_loads_when_every_chain_links_and_every_item_was_served() {
        let scene = scene();
        let loaded = scene.load().unwrap();
        assert_eq!(loaded.fresh, [1, 2, 3]);
        assert_eq!(loaded.covered, [0]);
        let mut frontier = vec![
            (
                device(1),
                Head {
                    seq: 7,
                    hash: scene.chains[0].1[3].hash,
                },
            ),
            (
                device(2),
                Head {
                    seq: 1,
                    hash: scene.chains[1].1[0].hash,
                },
            ),
        ];
        frontier.sort_by_key(|(writer, _)| *writer);
        assert_eq!(loaded.frontier, frontier);
        // The links say which envelopes are items of which board.
        let boards: Vec<_> = scene.chains[0].1.iter().map(|link| link.board).collect();
        assert_eq!(boards, [Some(BOARD), Some(OTHER_BOARD), None, Some(BOARD)]);

        // An empty board, and a snapshot with nothing after it.
        let empty = Snapshot {
            attachment: "{}".into(),
            frontier: Vec::new(),
            change: 0,
        };
        let loaded = verify_load(&BOARD, &[], &empty, &[], &[]).unwrap();
        assert_eq!((loaded.frontier.len(), loaded.fresh.len()), (0, 0));
        let loaded = verify_load(&BOARD, &[], &scene.snapshot, &scene.served[..1], &[]).unwrap();
        assert_eq!(loaded.frontier, scene.snapshot.frontier);
        assert_eq!(loaded.covered, [0]);
    }

    #[test]
    fn an_item_the_hub_did_not_serve_is_withheld() {
        let mut scene = scene();
        scene.served.remove(2);
        assert_eq!(scene.load(), Err(Error::Withheld));
        // The other writer's only item.
        let mut scene = self::scene();
        scene.served.pop();
        assert_eq!(scene.load(), Err(Error::Withheld));
        // An item served beyond what its writer's chain shows.
        let mut scene = self::scene();
        scene.chains[0].1.pop();
        assert_eq!(scene.load(), Err(Error::Withheld));
        let mut scene = self::scene();
        scene.chains.pop();
        assert_eq!(scene.load(), Err(Error::Withheld));
        // An envelope of another board, or a register, need not be served here.
        let scene = self::scene();
        assert!(scene.load().is_ok());
    }

    #[test]
    fn a_chain_that_does_not_link_is_refused() {
        // An envelope missing in the middle, and at the start.
        let mut scene = scene();
        scene.chains[0].1.remove(1);
        assert_eq!(scene.load(), Err(Error::Gap));
        let mut scene = self::scene();
        scene.chains[0].1.remove(0);
        assert_eq!(scene.load(), Err(Error::Gap));
        // Out of order.
        let mut scene = self::scene();
        scene.chains[0].1.swap(1, 2);
        assert_eq!(scene.load(), Err(Error::Gap));
        // A `prev` that is not the hash before: in the middle, and against the frontier.
        let mut scene = self::scene();
        scene.chains[0].1[2].prev = Hash32::new([9; 32]);
        assert_eq!(scene.load(), Err(Error::ChainBreak));
        let mut scene = self::scene();
        scene.snapshot.frontier = vec![(device(1), head(3, 9))];
        assert_eq!(scene.load(), Err(Error::ChainBreak));
        // The second writer's chain starts at number 1 with zeros before it.
        let mut scene = self::scene();
        scene.chains[1].1[0].prev = Hash32::new([9; 32]);
        assert_eq!(scene.load(), Err(Error::ChainBreak));
        let mut scene = self::scene();
        scene.chains[1].1[0].seq = 2;
        assert_eq!(scene.load(), Err(Error::Gap));
        // A writer given twice.
        let mut scene = self::scene();
        scene.chains.push((device(2), Vec::new()));
        assert_eq!(scene.load(), Err(Error::BadFormat));
    }

    #[test]
    fn a_served_item_must_be_the_one_its_chain_has() {
        let mut scene = scene();
        scene.served[1].hash = Hash32::new([9; 32]);
        assert_eq!(scene.load(), Err(Error::HashMismatch));
        // At the frontier's number with another hash than the frontier.
        let mut scene = self::scene();
        scene.served[0].hash = Hash32::new([9; 32]);
        assert_eq!(scene.load(), Err(Error::Equivocation));
        // The same item twice.
        let mut scene = self::scene();
        scene.served.push(scene.served[1]);
        assert_eq!(scene.load(), Err(Error::BadFormat));
        // Served as an item of this board what its chain shows as something else: an item of another board, a
        // register, a void record.
        for index in [1, 2] {
            let mut scene = self::scene();
            let link = scene.chains[0].1[index];
            scene.served.push(ServedItem {
                sender: device(1),
                seq: link.seq,
                hash: link.hash,
            });
            assert_eq!(scene.load(), Err(Error::Forbidden));
        }
        // An item before the frontier cannot be checked and stands as covered.
        let mut scene = self::scene();
        scene.served.push(ServedItem {
            sender: device(1),
            seq: 1,
            hash: Hash32::new([9; 32]),
        });
        assert_eq!(scene.load().unwrap().covered, [0, 4]);
    }

    #[test]
    fn a_snapshot_must_stand_at_or_beyond_the_frontier_applied() {
        let scene = scene();
        let load = |applied: &[(DeviceId, Head)]| {
            verify_load(
                &BOARD,
                applied,
                &scene.snapshot,
                &scene.served,
                &scene.chains,
            )
            .map(|loaded| loaded.frontier)
        };
        let at = scene.snapshot.frontier.clone();
        assert!(load(&at).is_ok());
        let (writer, snapshot_head) = at[0];
        // The device had applied less.
        assert!(load(&[(writer, head(2, 5))]).is_ok());
        // It had applied more: this snapshot is an older one.
        assert_eq!(load(&[(writer, head(4, 5))]), Err(Error::Replay));
        // It had applied another envelope under the same number.
        assert_eq!(load(&[(writer, head(3, 5))]), Err(Error::Equivocation));
        assert_eq!(snapshot_head.seq, 3);
        // A writer the device had applied and the snapshot does not name.
        assert_eq!(load(&[(device(2), head(1, 5))]), Err(Error::Replay));
        // What loads becomes the frontier to hold the next snapshot against.
        let next = load(&at).unwrap();
        let older = Snapshot {
            frontier: at.clone(),
            ..scene.snapshot.clone()
        };
        assert_eq!(
            verify_load(&BOARD, &next, &older, &[], &[]).err(),
            Some(Error::Replay)
        );
    }

    #[test]
    fn a_void_record_in_a_chain_is_no_item() {
        let mut world = World::new();
        let stroke = Draft::board_item(BOARD, &payload("stroke"));
        let first = world.post(1, room(), &stroke);
        let voided = world.sign(1, room(), &stroke);
        let record = world
            .take_as(
                &voided.envelope.prune().unwrap().encode().unwrap(),
                &Served::Void(Error::WrongEpoch),
                Mode::InOrder,
            )
            .unwrap();
        let last = world.post(1, room(), &stroke);
        let links: Vec<Link> = [&first, &record, &last].into_iter().map(Link::of).collect();
        assert_eq!(links[1].board, None);
        let snapshot = Snapshot {
            attachment: "{}".into(),
            frontier: Vec::new(),
            change: 0,
        };
        // The void record carries the chain and need not be served; served as an item it is refused.
        let served = vec![item(&first), item(&last)];
        let chains = vec![(device(1), links)];
        assert!(verify_load(&BOARD, &[], &snapshot, &served, &chains).is_ok());
        let served = vec![item(&first), item(&record), item(&last)];
        assert_eq!(
            verify_load(&BOARD, &[], &snapshot, &served, &chains),
            Err(Error::Forbidden)
        );
    }

    #[test]
    fn the_chains_after_a_frontier_come_through_the_receivers_checks() {
        // A writer and a reader that starts from the snapshot's frontier and reads the rest pruned.
        let mut writer = World::new();
        let stroke = Draft::board_item(BOARD, &payload("stroke"));
        writer.post(1, room(), &stroke);
        writer.post(1, room(), &stroke);
        let snapshot = Snapshot {
            attachment: "{}".into(),
            frontier: writer.chains(&room()).heads(),
            change: 0,
        };
        let later: Vec<Envelope> = (0..2)
            .map(|_| writer.sign(1, room(), &stroke).envelope)
            .collect();

        let mut reader = World::new();
        reader.me = device(2);
        reader
            .chains
            .insert(room(), Chains::from_frontier(&snapshot.frontier));
        let receipts: Vec<Receipt> = later
            .iter()
            .map(|envelope| {
                reader
                    .take_as(
                        &envelope.prune().unwrap().encode().unwrap(),
                        &Served::Stored,
                        Mode::ReadingBack,
                    )
                    .unwrap()
            })
            .collect();
        let chains = vec![(device(1), receipts.iter().map(Link::of).collect())];
        let served: Vec<ServedItem> = receipts.iter().map(item).collect();
        let loaded = verify_load(&BOARD, &[], &snapshot, &served, &chains).unwrap();
        assert_eq!(loaded.fresh, [0, 1]);
        assert_eq!(loaded.frontier, reader.chains(&room()).heads());
    }
}
