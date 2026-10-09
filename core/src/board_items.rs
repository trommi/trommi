//! What stands on a Scribble Board (section 10): the bodies of board items, the packed points of a stroke, the
//! board that the items add up to, and the snapshot file.
//!
//! A board item is an item envelope on the timeline `desk/<board>` in the room group; its payload is one
//! [`ItemBody`]. This module reads and writes those payloads and merges them into a [`Board`]. It verifies no
//! envelope: the caller hands in only items that passed the receiver checks of section 9.0.5, with the sender
//! and the envelope number from the signed header. A shape's id is made from those two and the shape's place in
//! its item, never read from a body, so no writer can take or forge another writer's id.
//!
//! **Numbers.** Every position, length and offset is a whole number of quanta, 1/16 board unit ([`QUANTUM`]),
//! held in an `i32`. Positions are taken modulo 2^32 quanta: adding an offset wraps, so sums are exact and do not
//! depend on the order of the additions. In JSON the same values stand in board units (`12.5`), and only
//! multiples of 1/16 that fit are accepted. There is no floating point arithmetic on any path that two devices
//! must agree on.
//!
//! **Merging.** Adding happens once per id, erasing wins for good, moves add up. Each of the three commutes with
//! the others, so two devices that applied the same items hold the same board, whatever order the items of
//! different writers arrived in. The items of one writer come in the order of its chain; [`Board::apply`]
//! skips what a writer's applied number already covers.

use crate::board::ShapeId;
use crate::chain::{Head, HeadsWire};
use crate::crypto::SecretBytes;
use crate::envelope::MAX_PAYLOAD_LEN;
use crate::error::Error;
use crate::files::FileRef;
use crate::ids::{self, DeviceId};
use serde::de::{self, Deserializer, Visitor};
use serde::ser::{SerializeSeq, Serializer};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::io;
use zeroize::Zeroizing;

/// How many quanta one board unit has. One board unit is one CSS pixel at 100 % zoom and one point in
/// PencilKit; x grows to the right, y down.
pub const QUANTUM: i32 = 16;
/// The `schema_version` of every body this module writes.
pub const SCHEMA_VERSION: u64 = 2;
/// The version a snapshot file names.
pub const SNAPSHOT_VERSION: u64 = 3;
/// The most bytes of a snapshot file's JSON: the largest file of section 11.1.
pub const MAX_SNAPSHOT_LEN: usize = 64 * 1024 * 1024;
/// The most points of one stroke, and of one piece of a stroke in progress.
pub const MAX_POINTS: usize = 10_000;
/// The most shapes one item adds.
pub const MAX_SHAPES: usize = 1_000;
/// The most shape ids one erase, move or send away names.
pub const MAX_SHAPE_IDS: usize = 2_000;
/// The most bytes of a note's text.
pub const MAX_TEXT_LEN: usize = 20_000;
/// The most bytes of a colour's name.
pub const MAX_COLOR_LEN: usize = 40;
/// The most bytes of a group's name.
pub const MAX_GROUP_LEN: usize = 80;
/// The most bytes of a file's name and of its media type.
pub const MAX_FILE_NAME_LEN: usize = 255;
/// The largest width of a stroke and the largest text size, in quanta: 1 000 board units.
pub const MAX_WIDTH: i32 = 1_000 * QUANTUM;

const FLAG_TILT: u8 = 1;
const FLAG_SIMULATED: u8 = 2;

// ---- the points of a stroke ----

/// One point of a stroke: a control point of a uniform cubic B-spline with clamped ends, as PencilKit's are.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Point {
    /// To the right, in quanta.
    pub x: i32,
    /// Downwards, in quanta.
    pub y: i32,
    /// Milliseconds since the stroke began.
    pub t: u32,
    /// The force: 0 to 255 stand for 0 to 1.
    pub force: u8,
    /// The pen's azimuth: 0 to 255 stand for 0 to 2π·255/256. Zero in a stroke without tilt.
    pub azimuth: u8,
    /// The pen's altitude: 0 to 255 stand for 0 (flat) to π/2 (upright). Zero in a stroke without tilt.
    pub altitude: u8,
}

/// The points of a stroke, or of one piece of a stroke in progress.
///
/// Packed, a byte of flags (bit 0: every point carries azimuth and altitude; bit 1: the force was simulated, the
/// input had no pressure; any other bit is refused) is followed, per point, by: x and y as zigzag LEB128 of the
/// difference to the point before, modulo 2^32 (the first point: to zero); the time as LEB128 of the
/// milliseconds since the point before (the first point: since the stroke began); the force as one byte; with
/// bit 0, azimuth and altitude as one byte each. Every number is at most 2^32 − 1 and written in the fewest
/// bytes, so a list of points has exactly one packed form.
#[derive(Clone, PartialEq, Eq)]
pub struct Ink {
    tilted: bool,
    simulated: bool,
    points: Vec<Point>,
}

impl fmt::Debug for Ink {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Ink({} points)", self.points.len())
    }
}

/// Appends `value` as LEB128.
fn put_var(out: &mut Vec<u8>, mut value: u32) {
    while value >= 0x80 {
        out.push((value & 0x7f) as u8 | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

/// Reads one LEB128 number of at most 32 bits in its shortest form.
fn take_var(bytes: &mut impl Iterator<Item = u8>) -> Result<u32, Error> {
    let mut value = 0u64;
    for shift in [0u32, 7, 14, 21, 28] {
        let byte = bytes.next().ok_or(Error::BadFormat)?;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            // A last group of zero bits behind others is a longer spelling of a shorter number.
            if byte == 0 && shift > 0 {
                return Err(Error::BadFormat);
            }
            return u32::try_from(value).map_err(|_| Error::BadFormat);
        }
    }
    Err(Error::BadFormat)
}

/// A difference as an unsigned number: 0, −1, 1, −2 … become 0, 1, 2, 3 …
fn zigzag(value: i32) -> u32 {
    (value.cast_unsigned() << 1) ^ (value >> 31).cast_unsigned()
}

/// The inverse of [`zigzag`].
fn unzigzag(value: u32) -> i32 {
    (value >> 1).cast_signed() ^ (value & 1).cast_signed().wrapping_neg()
}

impl Ink {
    /// The points of a stroke. `tilted`: every point carries the pen's azimuth and altitude. `simulated`: the
    /// input had no pressure and the force was made up from its speed. `bad-format` without a point, with more
    /// than [`MAX_POINTS`], with a time that runs backwards, or with an angle in a stroke that has no tilt.
    pub fn new(points: Vec<Point>, tilted: bool, simulated: bool) -> Result<Self, Error> {
        if points.is_empty() || points.len() > MAX_POINTS {
            return Err(Error::BadFormat);
        }
        let mut before = 0u32;
        for point in &points {
            if point.t < before || (!tilted && (point.azimuth != 0 || point.altitude != 0)) {
                return Err(Error::BadFormat);
            }
            before = point.t;
        }
        Ok(Self {
            tilted,
            simulated,
            points,
        })
    }

    /// The points.
    pub fn points(&self) -> &[Point] {
        &self.points
    }

    /// Whether every point carries azimuth and altitude.
    pub fn tilted(&self) -> bool {
        self.tilted
    }

    /// Whether the force was simulated.
    pub fn simulated(&self) -> bool {
        self.simulated
    }

    /// The packed bytes.
    pub fn pack(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.points.len().saturating_mul(6).saturating_add(1));
        let tilt = if self.tilted { FLAG_TILT } else { 0 };
        let simulated = if self.simulated { FLAG_SIMULATED } else { 0 };
        out.push(tilt | simulated);
        let (mut x, mut y, mut t) = (0i32, 0i32, 0u32);
        for point in &self.points {
            put_var(&mut out, zigzag(point.x.wrapping_sub(x)));
            put_var(&mut out, zigzag(point.y.wrapping_sub(y)));
            // `new` made sure that the time never runs backwards.
            put_var(&mut out, point.t.saturating_sub(t));
            out.push(point.force);
            if self.tilted {
                out.push(point.azimuth);
                out.push(point.altitude);
            }
            (x, y, t) = (point.x, point.y, point.t);
        }
        out
    }

    /// The points these packed bytes hold; `bad-format` for anything that [`Ink::pack`] would not have written.
    pub fn unpack(packed: &[u8]) -> Result<Self, Error> {
        let mut bytes = packed.iter().copied().peekable();
        let flags = bytes.next().ok_or(Error::BadFormat)?;
        if flags & !(FLAG_TILT | FLAG_SIMULATED) != 0 {
            return Err(Error::BadFormat);
        }
        let tilted = flags & FLAG_TILT != 0;
        let mut points = Vec::new();
        let (mut x, mut y, mut t) = (0i32, 0i32, 0u32);
        while bytes.peek().is_some() {
            if points.len() >= MAX_POINTS {
                return Err(Error::BadFormat);
            }
            x = x.wrapping_add(unzigzag(take_var(&mut bytes)?));
            y = y.wrapping_add(unzigzag(take_var(&mut bytes)?));
            t = t
                .checked_add(take_var(&mut bytes)?)
                .ok_or(Error::BadFormat)?;
            let force = bytes.next().ok_or(Error::BadFormat)?;
            let (azimuth, altitude) = if tilted {
                (
                    bytes.next().ok_or(Error::BadFormat)?,
                    bytes.next().ok_or(Error::BadFormat)?,
                )
            } else {
                (0, 0)
            };
            points.push(Point {
                x,
                y,
                t,
                force,
                azimuth,
                altitude,
            });
        }
        Self::new(points, tilted, flags & FLAG_SIMULATED != 0)
    }

    /// The packed bytes as a body's JSON carries them: base64url.
    pub fn to_base64url(&self) -> String {
        ids::base64url_encode(&self.pack())
    }

    /// The points this text holds; `bad-format` for anything but canonical base64url of a packed form.
    pub fn from_base64url(text: &str) -> Result<Self, Error> {
        // A point has at most eighteen packed bytes, which are twenty-four of text.
        if text.len() > MAX_POINTS.saturating_mul(24).saturating_add(2) {
            return Err(Error::BadFormat);
        }
        Self::unpack(&ids::base64url_decode(text)?)
    }

    fn shift(&mut self, offset: [i32; 2]) {
        let [dx, dy] = offset;
        for point in &mut self.points {
            point.x = point.x.wrapping_add(dx);
            point.y = point.y.wrapping_add(dy);
        }
    }
}

// ---- shapes ----

/// What drew a stroke. The eraser is no pen: it removes whole shapes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pen {
    /// The pen: as thick as the force at each point.
    Pen,
    /// The marker: one thickness, drawn under the pen's ink.
    Marker,
}

/// A finished stroke.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stroke {
    /// What drew it.
    pub pen: Pen,
    /// The colour's name in the app's palette.
    pub color: String,
    /// The width in quanta, 1 to [`MAX_WIDTH`].
    pub width: i32,
    /// Its points.
    pub ink: Ink,
    /// The id under which pieces of this stroke were relayed while it was drawn (7.2), so that a receiver
    /// replaces what it showed of them.
    pub live: Option<[u8; 16]>,
}

/// Which kind of note.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoteKind {
    /// Typed text straight on the board.
    Text,
    /// A sticky note.
    Sticky,
    /// A voice note: what was said, as text.
    Voice,
}

/// A note on the board.
#[derive(Clone, PartialEq, Eq)]
pub struct Note {
    /// Which kind.
    pub kind: NoteKind,
    /// Its top left corner, in quanta.
    pub at: [i32; 2],
    /// The text, at most [`MAX_TEXT_LEN`] bytes.
    pub text: String,
    /// The text size in quanta, 1 to [`MAX_WIDTH`].
    pub size: i32,
    /// The colour's name in the app's palette.
    pub color: String,
    /// The width at which the text wraps, in quanta; none: it does not wrap.
    pub wrap: Option<i32>,
}

impl fmt::Debug for Note {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Note({:?}, {} bytes)", self.kind, self.text.len())
    }
}

/// A picture on the board: a reference to a stored file (9.1.1). The file is fetched when it comes into view.
#[derive(PartialEq, Eq)]
pub struct Picture {
    /// Two opposite corners, `[x0, y0, x1, y1]`, in quanta.
    pub rect: [i32; 4],
    /// What opens the file.
    pub file: FileRef,
    /// The file's name.
    pub file_name: String,
    /// Its media type.
    pub media_type: String,
    /// The size of the picture's bytes before encryption.
    pub total_size: u64,
    /// The picture's own width in pixels, if known.
    pub width: Option<u32>,
    /// The picture's own height in pixels, if known.
    pub height: Option<u32>,
}

impl fmt::Debug for Picture {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Picture({:?})", self.file.file_id)
    }
}

/// What a shape is.
#[derive(Debug, PartialEq, Eq)]
pub enum ShapeKind {
    /// A stroke.
    Stroke(Stroke),
    /// A note.
    Note(Note),
    /// A picture.
    Picture(Picture),
}

/// One shape of the board.
#[derive(Debug, PartialEq, Eq)]
pub struct Shape {
    /// What it is.
    pub kind: ShapeKind,
    /// Its layer: a higher one is drawn over a lower one.
    pub z: i32,
    /// The name of the group it was made in (shapes of one group are picked together), if any.
    pub group: Option<String>,
}

impl Shape {
    fn check(&self) -> Result<(), Error> {
        let text_ok = |text: &str, max: usize| !text.is_empty() && text.len() <= max;
        let ok = match &self.kind {
            ShapeKind::Stroke(stroke) => {
                text_ok(&stroke.color, MAX_COLOR_LEN) && (1..=MAX_WIDTH).contains(&stroke.width)
            }
            ShapeKind::Note(note) => {
                note.text.len() <= MAX_TEXT_LEN
                    && text_ok(&note.color, MAX_COLOR_LEN)
                    && (1..=MAX_WIDTH).contains(&note.size)
                    && note.wrap.is_none_or(|wrap| wrap > 0)
            }
            ShapeKind::Picture(picture) => {
                text_ok(&picture.file_name, MAX_FILE_NAME_LEN)
                    && text_ok(&picture.media_type, MAX_FILE_NAME_LEN)
            }
        };
        let group_ok = self
            .group
            .as_deref()
            .is_none_or(|group| text_ok(group, MAX_GROUP_LEN));
        if ok && group_ok {
            Ok(())
        } else {
            Err(Error::BadFormat)
        }
    }

    fn shift(&mut self, offset: [i32; 2]) {
        let [dx, dy] = offset;
        match &mut self.kind {
            ShapeKind::Stroke(stroke) => stroke.ink.shift(offset),
            ShapeKind::Note(note) => {
                let [x, y] = note.at;
                note.at = [x.wrapping_add(dx), y.wrapping_add(dy)];
            }
            ShapeKind::Picture(picture) => {
                let [x0, y0, x1, y1] = picture.rect;
                picture.rect = [
                    x0.wrapping_add(dx),
                    y0.wrapping_add(dy),
                    x1.wrapping_add(dx),
                    y1.wrapping_add(dy),
                ];
            }
        }
    }
}

// ---- JSON ----

/// A number of quanta as JSON shows it: board units, a multiple of 1/16.
#[derive(Clone, Copy)]
pub(crate) struct Units(pub(crate) i32);

impl Serialize for Units {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if self.0 % QUANTUM == 0 {
            serializer.serialize_i32(self.0 / QUANTUM)
        } else {
            // Exact: an i32 divided by a power of two is a double, and at most fourteen digits long.
            serializer.serialize_f64(f64::from(self.0) / f64::from(QUANTUM))
        }
    }
}

impl<'de> Deserialize<'de> for Units {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let units = f64::deserialize(deserializer)?;
        // Exact as well: a multiplication by a power of two.
        let quanta = units * f64::from(QUANTUM);
        let fits =
            quanta.fract() == 0.0 && quanta >= f64::from(i32::MIN) && quanta <= f64::from(i32::MAX);
        if !fits {
            return Err(de::Error::custom("not a multiple of 1/16 in range"));
        }
        // No rounding and no saturation: the value is whole and within the type.
        Ok(Self(quanta as i32))
    }
}

/// A file key as a body's JSON carries it, wiped when dropped.
struct KeyText(Zeroizing<String>);

impl<'de> Deserialize<'de> for KeyText {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Text;
        impl Visitor<'_> for Text {
            type Value = KeyText;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a file key")
            }
            fn visit_str<E: de::Error>(self, text: &str) -> Result<KeyText, E> {
                Ok(KeyText(Zeroizing::new(text.to_owned())))
            }
        }
        deserializer.deserialize_str(Text)
    }
}

/// Writes a file's key straight from its secret bytes into the output.
fn write_key<S: Serializer>(file: &&FileRef, serializer: S) -> Result<S::Ok, S::Error> {
    let text = file.file_key_base64url();
    let text = std::str::from_utf8(text.expose()).map_err(serde::ser::Error::custom)?;
    serializer.serialize_str(text)
}

#[derive(Serialize)]
struct AttachmentOut<'a> {
    file_id: String,
    #[serde(serialize_with = "write_key")]
    file_key: &'a FileRef,
    sha256: String,
    file_name: &'a str,
    media_type: &'a str,
    total_size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    height: Option<u32>,
}

#[derive(Deserialize)]
struct AttachmentIn {
    file_id: String,
    file_key: KeyText,
    sha256: String,
    file_name: String,
    media_type: String,
    total_size: u64,
    width: Option<u32>,
    height: Option<u32>,
}

fn is_zero(value: &i32) -> bool {
    *value == 0
}

/// One shape as JSON carries it; which fields stand depends on `tool`.
#[derive(Serialize)]
struct EntryOut<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    tool: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    color: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    width: Option<Units>,
    #[serde(skip_serializing_if = "Option::is_none")]
    points: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    live: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    at: Option<[Units; 2]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<Units>,
    #[serde(skip_serializing_if = "Option::is_none")]
    wrap: Option<Units>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rect: Option<[Units; 4]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attachment: Option<AttachmentOut<'a>>,
    #[serde(skip_serializing_if = "is_zero")]
    z: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    group: Option<&'a str>,
}

#[derive(Deserialize)]
struct EntryIn {
    id: Option<String>,
    tool: String,
    color: Option<String>,
    width: Option<Units>,
    points: Option<String>,
    live: Option<String>,
    at: Option<[Units; 2]>,
    text: Option<String>,
    size: Option<Units>,
    wrap: Option<Units>,
    rect: Option<[Units; 4]>,
    attachment: Option<AttachmentIn>,
    #[serde(default)]
    z: i32,
    group: Option<String>,
}

impl<'a> EntryOut<'a> {
    fn new(shape: &'a Shape, id: Option<&ShapeId>) -> Self {
        let mut entry = Self {
            id: id.map(ShapeId::to_string),
            tool: "",
            color: None,
            width: None,
            points: None,
            live: None,
            at: None,
            text: None,
            size: None,
            wrap: None,
            rect: None,
            attachment: None,
            z: shape.z,
            group: shape.group.as_deref(),
        };
        match &shape.kind {
            ShapeKind::Stroke(stroke) => {
                entry.tool = match stroke.pen {
                    Pen::Pen => "pen",
                    Pen::Marker => "marker",
                };
                entry.color = Some(&stroke.color);
                entry.width = Some(Units(stroke.width));
                entry.points = Some(stroke.ink.to_base64url());
                entry.live = stroke.live.map(|live| ids::base64url_encode(&live));
            }
            ShapeKind::Note(note) => {
                entry.tool = match note.kind {
                    NoteKind::Text => "text",
                    NoteKind::Sticky => "sticky",
                    NoteKind::Voice => "voice",
                };
                entry.at = Some(note.at.map(Units));
                entry.text = Some(&note.text);
                entry.size = Some(Units(note.size));
                entry.color = Some(&note.color);
                entry.wrap = note.wrap.map(Units);
            }
            ShapeKind::Picture(picture) => {
                entry.tool = "image";
                entry.rect = Some(picture.rect.map(Units));
                entry.attachment = Some(AttachmentOut {
                    file_id: picture.file.file_id.to_base64url(),
                    file_key: &picture.file,
                    sha256: picture.file.sha256.to_base64url(),
                    file_name: &picture.file_name,
                    media_type: &picture.media_type,
                    total_size: picture.total_size,
                    width: picture.width,
                    height: picture.height,
                });
            }
        }
        entry
    }
}

/// The 16 bytes of a live stroke's id from base64url.
fn live_id(text: &str) -> Result<[u8; 16], Error> {
    ids::base64url_decode(text)?
        .try_into()
        .map_err(|_| Error::BadFormat)
}

impl EntryIn {
    /// The shape this entry is. A field that its tool does not carry is refused, like any field of the wrong
    /// form; a field that no tool carries is ignored (9.1.2).
    fn shape(self) -> Result<Shape, Error> {
        let pen = match self.tool.as_str() {
            "pen" => Some(Pen::Pen),
            "marker" => Some(Pen::Marker),
            _ => None,
        };
        let note = match self.tool.as_str() {
            "text" => Some(NoteKind::Text),
            "sticky" => Some(NoteKind::Sticky),
            "voice" => Some(NoteKind::Voice),
            _ => None,
        };
        let kind = if let Some(pen) = pen {
            let nothing_else = self.at.is_none()
                && self.text.is_none()
                && self.size.is_none()
                && self.wrap.is_none()
                && self.rect.is_none()
                && self.attachment.is_none();
            let (Some(color), Some(width), Some(points), true) =
                (self.color, self.width, self.points, nothing_else)
            else {
                return Err(Error::BadFormat);
            };
            ShapeKind::Stroke(Stroke {
                pen,
                color,
                width: width.0,
                ink: Ink::from_base64url(&points)?,
                live: self.live.as_deref().map(live_id).transpose()?,
            })
        } else if let Some(kind) = note {
            let nothing_else = self.width.is_none()
                && self.points.is_none()
                && self.live.is_none()
                && self.rect.is_none()
                && self.attachment.is_none();
            let (Some([x, y]), Some(text), Some(size), Some(color), true) =
                (self.at, self.text, self.size, self.color, nothing_else)
            else {
                return Err(Error::BadFormat);
            };
            ShapeKind::Note(Note {
                kind,
                at: [x.0, y.0],
                text,
                size: size.0,
                color,
                wrap: self.wrap.map(|wrap| wrap.0),
            })
        } else if self.tool == "image" {
            let nothing_else = self.color.is_none()
                && self.width.is_none()
                && self.points.is_none()
                && self.live.is_none()
                && self.at.is_none()
                && self.text.is_none()
                && self.size.is_none()
                && self.wrap.is_none();
            let (Some(rect), Some(attachment), true) = (self.rect, self.attachment, nothing_else)
            else {
                return Err(Error::BadFormat);
            };
            ShapeKind::Picture(Picture {
                rect: rect.map(|side| side.0),
                file: FileRef::from_base64url(
                    &attachment.file_id,
                    &attachment.file_key.0,
                    &attachment.sha256,
                )?,
                file_name: attachment.file_name,
                media_type: attachment.media_type,
                total_size: attachment.total_size,
                width: attachment.width,
                height: attachment.height,
            })
        } else {
            return Err(Error::BadFormat);
        };
        let shape = Shape {
            kind,
            z: self.z,
            group: self.group,
        };
        shape.check()?;
        Ok(shape)
    }
}

/// Counts the bytes written into it.
struct Count(usize);

impl io::Write for Count {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0 = self.0.saturating_add(bytes.len());
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// `value` as JSON of at most `max` bytes, in one allocation that is wiped when dropped: a body may hold file
/// keys, and a buffer that grew would leave copies of them behind.
fn to_json(value: &impl Serialize, max: usize) -> Result<SecretBytes, Error> {
    let mut count = Count(0);
    serde_json::to_writer(&mut count, value).map_err(|_| Error::Internal("board json"))?;
    if count.0 > max {
        return Err(Error::TooLarge);
    }
    let mut bytes = Zeroizing::new(Vec::with_capacity(count.0));
    serde_json::to_writer(&mut *bytes, value).map_err(|_| Error::Internal("board json"))?;
    Ok(SecretBytes::new(std::mem::take(&mut *bytes)))
}

/// Shapes as a JSON list, each with its id or without, written one after the other.
struct Shapes<'a>(Vec<(Option<&'a ShapeId>, &'a Shape)>);

impl Serialize for Shapes<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut list = serializer.serialize_seq(Some(self.0.len()))?;
        for (id, shape) in &self.0 {
            list.serialize_element(&EntryOut::new(shape, *id))?;
        }
        list.end()
    }
}

// ---- item bodies ----

/// The body of one board item (9.1): its `content_type` and what belongs to it.
#[derive(Debug, PartialEq, Eq)]
pub enum ItemBody {
    /// `strokes`: new shapes. The shape at place `i` gets the id `<sender>/<envelope number>/<i>`.
    Strokes(Vec<Shape>),
    /// `erase`: these shapes are gone for good.
    Erase(Vec<ShapeId>),
    /// `send_away`: these shapes are gone because they were sent to a session.
    SendAway(Vec<ShapeId>),
    /// `move`: these shapes moved by an offset, in quanta.
    Move {
        /// The shapes.
        shapes: Vec<ShapeId>,
        /// To the right and downwards.
        offset: [i32; 2],
    },
}

#[derive(Serialize)]
struct BodyOut<'a> {
    schema_version: u64,
    content_type: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    strokes: Option<Shapes<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    shape_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    offset: Option<[Units; 2]>,
}

/// Only the version of a body, read before anything else.
#[derive(Deserialize)]
struct VersionIn {
    schema_version: u64,
}

#[derive(Deserialize)]
struct BodyIn {
    content_type: String,
    strokes: Option<Vec<EntryIn>>,
    shape_ids: Option<Vec<String>>,
    offset: Option<[Units; 2]>,
}

/// The ids a body names: at least one, at most [`MAX_SHAPE_IDS`], none twice.
fn check_ids(shapes: &[ShapeId]) -> Result<(), Error> {
    let distinct: BTreeSet<&ShapeId> = shapes.iter().collect();
    if shapes.is_empty() || shapes.len() > MAX_SHAPE_IDS || distinct.len() != shapes.len() {
        return Err(Error::BadFormat);
    }
    Ok(())
}

fn parse_ids(texts: Option<Vec<String>>) -> Result<Vec<ShapeId>, Error> {
    let texts = texts.ok_or(Error::BadFormat)?;
    if texts.len() > MAX_SHAPE_IDS {
        return Err(Error::BadFormat);
    }
    let shapes = texts
        .iter()
        .map(|text| ShapeId::parse(text))
        .collect::<Result<Vec<_>, _>>()?;
    check_ids(&shapes)?;
    Ok(shapes)
}

impl ItemBody {
    fn check(&self) -> Result<(), Error> {
        match self {
            Self::Strokes(shapes) => {
                if shapes.is_empty() || shapes.len() > MAX_SHAPES {
                    return Err(Error::BadFormat);
                }
                shapes.iter().try_for_each(Shape::check)
            }
            Self::Erase(shapes) | Self::SendAway(shapes) | Self::Move { shapes, .. } => {
                check_ids(shapes)
            }
        }
    }

    /// The payload of the item: JSON. `bad-format` if a value is outside what this module reads back,
    /// `too-large` above [`MAX_PAYLOAD_LEN`] bytes. The bytes may hold file keys.
    pub fn encode(&self) -> Result<SecretBytes, Error> {
        self.check()?;
        let ids = |shapes: &[ShapeId]| Some(shapes.iter().map(ShapeId::to_string).collect());
        let (content_type, strokes, shape_ids, offset) = match self {
            Self::Strokes(shapes) => ("strokes", Some(shapes.as_slice()), None, None),
            Self::Erase(shapes) => ("erase", None, ids(shapes), None),
            Self::SendAway(shapes) => ("send_away", None, ids(shapes), None),
            Self::Move { shapes, offset } => ("move", None, ids(shapes), Some(offset.map(Units))),
        };
        let body = BodyOut {
            schema_version: SCHEMA_VERSION,
            content_type,
            strokes: strokes
                .map(|shapes| Shapes(shapes.iter().map(|shape| (None, shape)).collect())),
            shape_ids,
            offset,
        };
        to_json(&body, MAX_PAYLOAD_LEN)
    }

    /// The body a payload holds. `too-large` above [`MAX_PAYLOAD_LEN`] bytes; `newer-version` for a
    /// `schema_version` above 2 (tell the board with [`Board::skip_unread`]); `bad-format` for everything else
    /// that [`ItemBody::encode`] would not have written, except fields this version does not know, which are
    /// ignored.
    pub fn decode(payload: &[u8]) -> Result<Self, Error> {
        if payload.len() > MAX_PAYLOAD_LEN {
            return Err(Error::TooLarge);
        }
        let version: VersionIn = serde_json::from_slice(payload).map_err(|_| Error::BadFormat)?;
        match version.schema_version {
            SCHEMA_VERSION => {}
            newer if newer > SCHEMA_VERSION => return Err(Error::NewerVersion),
            _ => return Err(Error::BadFormat),
        }
        let body: BodyIn = serde_json::from_slice(payload).map_err(|_| Error::BadFormat)?;
        let item = match (body.content_type.as_str(), body.strokes, body.offset) {
            ("strokes", Some(entries), None) if body.shape_ids.is_none() => {
                if entries.len() > MAX_SHAPES {
                    return Err(Error::BadFormat);
                }
                let shapes = entries
                    .into_iter()
                    .map(|entry| match entry.id {
                        // An id is derived, never read: only a snapshot names it.
                        None => entry.shape(),
                        Some(_) => Err(Error::BadFormat),
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                Self::Strokes(shapes)
            }
            ("erase", None, None) => Self::Erase(parse_ids(body.shape_ids)?),
            ("send_away", None, None) => Self::SendAway(parse_ids(body.shape_ids)?),
            ("move", None, Some([dx, dy])) => Self::Move {
                shapes: parse_ids(body.shape_ids)?,
                offset: [dx.0, dy.0],
            },
            _ => return Err(Error::BadFormat),
        };
        item.check()?;
        Ok(item)
    }

    /// The files this body names, for the envelope's `file_ids`: in the order of the shapes, none twice.
    pub fn file_ids(&self) -> Vec<ids::FileId> {
        let mut files = Vec::new();
        if let Self::Strokes(shapes) = self {
            for shape in shapes {
                if let ShapeKind::Picture(picture) = &shape.kind {
                    if !files.contains(&picture.file.file_id) {
                        files.push(picture.file.file_id);
                    }
                }
            }
        }
        files
    }
}

// ---- the board ----

/// `id`, if it stands behind the id before it in a list that is written in ascending order.
fn ascending(before: &mut Option<ShapeId>, id: ShapeId) -> Result<ShapeId, Error> {
    if before.replace(id).is_some_and(|before| before >= id) {
        return Err(Error::BadFormat);
    }
    Ok(id)
}

/// What [`Board::apply`] did with an item.
#[derive(Debug, PartialEq, Eq)]
pub enum Applied {
    /// The writer's applied number already covers the item: nothing changed.
    Covered,
    /// The item was merged. These shapes appeared, moved or went, in ascending order; a shape that is not on
    /// the board (erased before, or not yet there) is not listed.
    Changed(Vec<ShapeId>),
}

/// Why a device could not read a board item that its writer's chain holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unread {
    /// The body has a `schema_version` above this core's: "needs a newer Trommi".
    Newer,
    /// The device does not hold the content key of the item's epoch.
    NoKey,
}

/// One Scribble Board: what its items add up to.
///
/// Besides the shapes it holds, per writer, the number of that writer's last envelope it has taken into
/// account, and what was said about shapes beyond that number: an erase or a move can arrive before the item
/// that adds the shape, and must still count when that item comes. What is said about a number already covered
/// needs no memory: no shape can come under it any more.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Board {
    shapes: BTreeMap<ShapeId, Shape>,
    applied: BTreeMap<DeviceId, u64>,
    gone_ahead: BTreeSet<ShapeId>,
    moved_ahead: BTreeMap<ShapeId, [i32; 2]>,
    newer_skipped: bool,
    key_missing: bool,
}

impl Board {
    /// An empty board.
    pub fn new() -> Self {
        Self::default()
    }

    /// The shapes on the board, ascending by id.
    pub fn shapes(&self) -> impl Iterator<Item = (&ShapeId, &Shape)> {
        self.shapes.iter()
    }

    /// One shape, if it is on the board.
    pub fn shape(&self, id: &ShapeId) -> Option<&Shape> {
        self.shapes.get(id)
    }

    /// The number of `sender`'s last envelope this board has taken into account; 0 if none.
    pub fn applied(&self, sender: &DeviceId) -> u64 {
        self.applied.get(sender).copied().unwrap_or(0)
    }

    fn covers(&self, id: &ShapeId) -> bool {
        id.seq <= self.applied(&id.sender)
    }

    /// Moves a writer's applied number up to `seq` and forgets what was kept for shapes it now covers.
    fn advance(&mut self, sender: DeviceId, seq: u64) {
        self.applied.insert(sender, seq);
        let first = ShapeId {
            sender,
            seq: 0,
            index: 0,
        };
        let last = ShapeId {
            sender,
            seq,
            index: u32::MAX,
        };
        let covered: Vec<ShapeId> = self.gone_ahead.range(first..=last).copied().collect();
        for id in covered {
            self.gone_ahead.remove(&id);
        }
        let covered: Vec<ShapeId> = self
            .moved_ahead
            .range(first..=last)
            .map(|(id, _)| *id)
            .collect();
        for id in covered {
            self.moved_ahead.remove(&id);
        }
    }

    /// Merges the body of the board item that `sender` signed under envelope number `seq`. The caller hands in
    /// only items that passed the receiver checks, each writer's in the order of its chain, and both values
    /// from the signed header. `bad-format` for number 0 or a body outside this module's limits.
    pub fn apply(&mut self, sender: DeviceId, seq: u64, body: ItemBody) -> Result<Applied, Error> {
        if seq == 0 {
            return Err(Error::BadFormat);
        }
        body.check()?;
        if seq <= self.applied(&sender) {
            return Ok(Applied::Covered);
        }
        let mut changed = BTreeSet::new();
        match body {
            ItemBody::Strokes(shapes) => {
                for (index, mut shape) in (0u32..).zip(shapes) {
                    let id = ShapeId { sender, seq, index };
                    let offset = self.moved_ahead.remove(&id);
                    if self.gone_ahead.remove(&id) {
                        continue;
                    }
                    if let Some(offset) = offset {
                        shape.shift(offset);
                    }
                    self.shapes.insert(id, shape);
                    changed.insert(id);
                }
            }
            ItemBody::Erase(shapes) | ItemBody::SendAway(shapes) => {
                for id in shapes {
                    if self.covers(&id) || (id.sender == sender && id.seq <= seq) {
                        if self.shapes.remove(&id).is_some() {
                            changed.insert(id);
                        }
                    } else {
                        self.moved_ahead.remove(&id);
                        self.gone_ahead.insert(id);
                    }
                }
            }
            ItemBody::Move { shapes, offset } => {
                let [dx, dy] = offset;
                for id in shapes {
                    if self.covers(&id) || (id.sender == sender && id.seq <= seq) {
                        if let Some(shape) = self.shapes.get_mut(&id) {
                            shape.shift(offset);
                            changed.insert(id);
                        }
                    } else if !self.gone_ahead.contains(&id) {
                        let [x, y] = self.moved_ahead.remove(&id).unwrap_or([0, 0]);
                        let sum = [x.wrapping_add(dx), y.wrapping_add(dy)];
                        if sum != [0, 0] {
                            self.moved_ahead.insert(id, sum);
                        }
                    }
                }
            }
        }
        self.advance(sender, seq);
        Ok(Applied::Changed(changed.into_iter().collect()))
    }

    /// Notes that this device could not read the board item `sender` signed under number `seq`, though the
    /// item took its place in the writer's chain. Nothing of it is shown, and from now on this board writes no
    /// snapshot: it would lack what that item did. To take the item in later (its key arrived), the device
    /// builds the board again.
    pub fn skip_unread(&mut self, sender: DeviceId, seq: u64, why: Unread) {
        if seq > self.applied(&sender) {
            self.advance(sender, seq);
            match why {
                Unread::Newer => self.newer_skipped = true,
                Unread::NoKey => self.key_missing = true,
            }
        }
    }

    /// Why this board is not all of the board, if an item was skipped; a newer version before a missing key.
    pub fn unread(&self) -> Option<Unread> {
        if self.newer_skipped {
            Some(Unread::Newer)
        } else if self.key_missing {
            Some(Unread::NoKey)
        } else {
            None
        }
    }

    /// The snapshot file of the board as it is now (10.2): JSON, to be compressed and stored as a file by the
    /// caller. `frontier` names, per writer, the last envelope in the room group that the caller accepted, and
    /// so everything this board has taken into account; it is also what the register `board_snapshot/<board>`
    /// names. `bad-format` if it is behind the board for any writer, or names a writer twice or a number 0.
    /// `newer-version` or `no-key` if an item was skipped as unread; `too-large` above [`MAX_SNAPSHOT_LEN`] bytes. The bytes
    /// may hold file keys.
    pub fn snapshot(&self, frontier: &[(DeviceId, Head)]) -> Result<SecretBytes, Error> {
        match self.unread() {
            Some(Unread::Newer) => return Err(Error::NewerVersion),
            Some(Unread::NoKey) => return Err(Error::NoKey),
            None => {}
        }
        let heads: BTreeMap<DeviceId, Head> = frontier.iter().copied().collect();
        let covered = |id: &ShapeId| heads.get(&id.sender).is_some_and(|head| id.seq <= head.seq);
        let behind = self
            .applied
            .iter()
            .any(|(sender, seq)| heads.get(sender).is_none_or(|head| head.seq < *seq));
        if behind || heads.len() != frontier.len() || heads.values().any(|head| head.seq == 0) {
            return Err(Error::BadFormat);
        }
        let file = SnapshotOut {
            v: SNAPSHOT_VERSION,
            shapes: Shapes(
                self.shapes
                    .iter()
                    .map(|(id, shape)| (Some(id), shape))
                    .collect(),
            ),
            frontier: heads
                .iter()
                .map(|(sender, head)| (sender.to_base64url(), (head.seq, head.hash.to_base64url())))
                .collect(),
            gone: self
                .gone_ahead
                .iter()
                .filter(|id| !covered(id))
                .map(ShapeId::to_string)
                .collect(),
            moved: self
                .moved_ahead
                .iter()
                .filter(|(id, _)| !covered(id))
                .map(|(id, [dx, dy])| (id.to_string(), Units(*dx), Units(*dy)))
                .collect(),
        };
        to_json(&file, MAX_SNAPSHOT_LEN)
    }

    /// The board a snapshot file holds. `frontier` is what the register `board_snapshot/<board>` names beside
    /// the file, ascending by writer: the file must name the same. Items the frontier covers are skipped by
    /// [`Board::apply`] from then on. `newer-version` for a `v` above 3; `too-large` above
    /// [`MAX_SNAPSHOT_LEN`] bytes; `bad-format` for another frontier and for everything else that
    /// [`Board::snapshot`] would not have written: a shape beyond the frontier, an id twice or out of order,
    /// something kept for a shape the frontier covers.
    pub fn from_snapshot(file: &[u8], frontier: &[(DeviceId, Head)]) -> Result<Self, Error> {
        if file.len() > MAX_SNAPSHOT_LEN {
            return Err(Error::TooLarge);
        }
        let version: SnapshotVersionIn =
            serde_json::from_slice(file).map_err(|_| Error::BadFormat)?;
        match version.v {
            SNAPSHOT_VERSION => {}
            newer if newer > SNAPSHOT_VERSION => return Err(Error::NewerVersion),
            _ => return Err(Error::BadFormat),
        }
        let file: SnapshotIn = serde_json::from_slice(file).map_err(|_| Error::BadFormat)?;
        if file.frontier.heads()? != frontier {
            return Err(Error::BadFormat);
        }
        let mut board = Self::new();
        board.applied = frontier
            .iter()
            .map(|(sender, head)| (*sender, head.seq))
            .collect();

        let mut before = None;
        for mut entry in file.shapes {
            let id = ShapeId::parse(&entry.id.take().ok_or(Error::BadFormat)?)?;
            if !board.covers(&ascending(&mut before, id)?) {
                return Err(Error::BadFormat);
            }
            board.shapes.insert(id, entry.shape()?);
        }
        before = None;
        for text in &file.gone {
            let id = ascending(&mut before, ShapeId::parse(text)?)?;
            if board.covers(&id) {
                return Err(Error::BadFormat);
            }
            board.gone_ahead.insert(id);
        }
        before = None;
        for (text, dx, dy) in &file.moved {
            let id = ascending(&mut before, ShapeId::parse(text)?)?;
            let offset = [dx.0, dy.0];
            if board.covers(&id) || board.gone_ahead.contains(&id) || offset == [0, 0] {
                return Err(Error::BadFormat);
            }
            board.moved_ahead.insert(id, offset);
        }
        Ok(board)
    }
}

#[derive(Serialize)]
struct SnapshotOut<'a> {
    v: u64,
    shapes: Shapes<'a>,
    frontier: BTreeMap<String, (u64, String)>,
    gone: Vec<String>,
    moved: Vec<(String, Units, Units)>,
}

/// Only the version of a snapshot file, read before anything else.
#[derive(Deserialize)]
struct SnapshotVersionIn {
    v: u64,
}

#[derive(Deserialize)]
struct SnapshotIn {
    shapes: Vec<EntryIn>,
    frontier: HeadsWire,
    gone: Vec<String>,
    moved: Vec<(String, Units, Units)>,
}
