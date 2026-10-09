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
        if !crate::envelope::is_json_object(value.as_bytes()) {
            return Err(Error::BadFormat);
        }
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
/// `applied` is the frontier this device applied last for the board ([`Loaded::frontier`] of its last load;
/// empty the first time), `cuts` the Cut in the room group of every removed device that the frontiers or
/// `chains` name ([`crate::chain::GroupFacts::cut`]), `snapshot` the newest snapshot (the current value of the
/// register by 9.3.2), `served` the board's items the hub gave from [`Snapshot::items_after_change`] on, and
/// `chains` per writer its envelopes in ascending order, each verified by the receiver's checks 1 to 5 before
/// it is handed in here ([`Link::of`]).
///
/// A writer's chain starts after the last envelope of it that this device holds: after its head in `applied`
/// (taken back to its Cut), and only for a writer the device holds nothing of, after the snapshot's frontier,
/// the one shortcut of 9.0.6. So where the snapshot's frontier lies beyond the applied head, the chain is the
/// bridge between the two: it must reach the frontier's number (`withheld`) with the frontier's envelope
/// (`equivocation`). Without the bridge a writer that signed two chains, one seen by this device and one by
/// the snapshot's writer, would go unseen below the new frontier. A writer whose chain is already where the
/// frontier is and that has no chain here is taken to have written nothing since.
///
/// Refuses with: `replay` if the snapshot's frontier lies before the applied one for some writer, and
/// `equivocation` if it names another envelope under the same number; `removed-sender` if the frontier lies
/// beyond a removed writer's Cut (the snapshot holds shapes that are to vanish: a device loads an older one or
/// reads the chains) or a chain goes on beyond it, and `equivocation` if the frontier or a chain has another
/// envelope at the Cut's number, or a served item contradicts the applied frontier or a Cut; `gap` or
/// `chain-break` if a writer's chain does not link from where it starts; `withheld` if a chain ends before the
/// snapshot's frontier or the bridge to it is missing, if an envelope of a chain after the frontier names this
/// board and was not served, or a served item lies beyond what its writer's chain shows; `hash-mismatch` if a
/// served item is not the envelope its writer's chain has under that number; `equivocation` if a chain or a
/// served item at the frontier's number has another hash than the frontier; `forbidden` if a served item is, by its writer's chain, no item of this
/// board that counts; `bad-format` for a writer or an item given twice.
pub fn verify_load(
    board: &BoardId,
    applied: &[(DeviceId, Head)],
    cuts: &[(DeviceId, Head)],
    snapshot: &Snapshot,
    served: &[ServedItem],
    chains: &[(DeviceId, Vec<Link>)],
) -> Result<Loaded, Error> {
    let cut_of = |writer: &DeviceId| {
        cuts.iter()
            .find(|(cut, _)| cut == writer)
            .map(|(_, head)| head)
    };
    for (writer, was) in applied {
        // A Cut that came after the frontier was applied takes the frontier back to it.
        let was = cut_of(writer)
            .filter(|cut| cut.seq < was.seq)
            .unwrap_or(was);
        let now = snapshot.frontier_of(writer);
        if now.seq < was.seq {
            return Err(Error::Replay);
        }
        if now.seq == was.seq && now.hash != was.hash {
            return Err(Error::Equivocation);
        }
    }
    for (writer, cut) in cuts {
        let now = snapshot.frontier_of(writer);
        if now.seq > cut.seq {
            return Err(Error::RemovedSender);
        }
        if now.seq == cut.seq && now.hash != cut.hash {
            return Err(Error::Equivocation);
        }
    }
    // What the device knows of a writer's chain under one number: the applied frontier and the Cut.
    let known: BTreeMap<(DeviceId, u64), Hash32> = applied
        .iter()
        .chain(cuts)
        .map(|(writer, head)| ((*writer, head.seq), head.hash))
        .collect();

    // Where this device's own verified chain of each writer stands: at its applied head, taken back to a Cut.
    let held: BTreeMap<DeviceId, Head> = applied
        .iter()
        .map(|(writer, was)| {
            let was = cut_of(writer)
                .filter(|cut| cut.seq < was.seq)
                .unwrap_or(was);
            (*writer, *was)
        })
        .filter(|(_, was)| was.seq > 0)
        .collect();

    let mut frontier: BTreeMap<DeviceId, Head> = snapshot.frontier.iter().copied().collect();
    // The envelopes after the snapshot's frontier, and those of a bridge up to it.
    let mut links: BTreeMap<(DeviceId, u64), &Link> = BTreeMap::new();
    let mut bridge: BTreeMap<(DeviceId, u64), Hash32> = BTreeMap::new();
    let mut writers = BTreeSet::new();
    for (writer, chain) in chains {
        if !writers.insert(*writer) {
            return Err(Error::BadFormat);
        }
        let covers = snapshot.frontier_of(writer);
        let mut last = held.get(writer).copied().unwrap_or(covers);
        for link in chain {
            if last.seq.checked_add(1) != Some(link.seq) {
                return Err(Error::Gap);
            }
            if link.prev != last.hash {
                return Err(Error::ChainBreak);
            }
            let cut = cut_of(writer);
            if cut.is_some_and(|cut| link.seq > cut.seq) {
                return Err(Error::RemovedSender);
            }
            if cut.is_some_and(|cut| link.seq == cut.seq && link.hash != cut.hash) {
                return Err(Error::Equivocation);
            }
            last = Head {
                seq: link.seq,
                hash: link.hash,
            };
            if link.seq > covers.seq {
                links.insert((*writer, link.seq), link);
            } else {
                if link.seq == covers.seq && link.hash != covers.hash {
                    return Err(Error::Equivocation);
                }
                bridge.insert((*writer, link.seq), link.hash);
            }
        }
        if last.seq < covers.seq {
            return Err(Error::Withheld);
        }
        if last.seq > 0 {
            frontier.insert(*writer, last);
        }
    }
    // A writer the device holds less of than the snapshot covers, and no bridge was served.
    let unbridged = held.iter().any(|(writer, was)| {
        !writers.contains(writer) && was.seq < snapshot.frontier_of(writer).seq
    });
    if unbridged {
        return Err(Error::Withheld);
    }

    let mut fresh = Vec::new();
    let mut covered = Vec::new();
    let mut seen = BTreeSet::new();
    for (index, item) in served.iter().enumerate() {
        if !seen.insert((item.sender, item.seq)) {
            return Err(Error::BadFormat);
        }
        let start = snapshot.frontier_of(&item.sender);
        if known
            .get(&(item.sender, item.seq))
            .is_some_and(|hash| *hash != item.hash)
        {
            return Err(Error::Equivocation);
        }
        if item.seq < start.seq {
            if bridge
                .get(&(item.sender, item.seq))
                .is_some_and(|hash| *hash != item.hash)
            {
                return Err(Error::HashMismatch);
            }
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
