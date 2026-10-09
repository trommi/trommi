//! `spec/vectors/board.json`: the packed points of a stroke, the bodies of board items, a board's history with
//! the snapshot it adds up to, and what each of the three refuses (section 10).

use serde_json::{json, Value};
use trommi_core::board_items::{Board, Ink, ItemBody, Note, NoteKind, Shape, ShapeKind};
use trommi_core::chain::Head;
use trommi_core::ids::{DeviceId, Hash32};
use trommi_core::Error;

use super::{entropy, hex};
use crate::content::{apply_all, history, ink, shape, Dice};

/// The name of the file.
pub const NAME: &str = "board";

fn text(bytes: &[u8]) -> Result<String, Error> {
    String::from_utf8(bytes.to_vec()).map_err(|_| Error::Internal("vector text"))
}

/// Packed bytes that are no points, each with the reason.
pub fn refused_points() -> Vec<(&'static str, &'static str)> {
    vec![
        ("", "no flags"),
        ("00", "no point"),
        ("0402020000", "an unknown flag"),
        ("00800002000a", "x written longer than needed"),
        ("00ffffffff1f0200", "x beyond 32 bits"),
        ("00808080808000020000", "a number of six bytes"),
        ("0002", "a point that ends after x"),
        ("00020200", "a point without force"),
        (
            "010202000a40",
            "a point without altitude in a stroke with tilt",
        ),
        (
            "000202ffffffff0f000202ffffffff0f00",
            "a time beyond 32 bits",
        ),
    ]
}

/// The writers of every example: three devices.
pub fn writers() -> [DeviceId; 3] {
    [
        DeviceId::new([0x11; 32]),
        DeviceId::new([0x22; 32]),
        DeviceId::new([0x33; 32]),
    ]
}

fn stroke_entry() -> Value {
    json!({ "tool": "pen", "color": "ink", "width": 64, "points": "AYCAAYBgAICAww" })
}

fn picture_entry() -> Value {
    json!({ "tool": "image", "rect": [0, 0, 160, 160], "attachment": {
        "file_id": "AAAAAAAAAAAAAAAAAAAAAA", "file_key": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "sha256": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "file_name": "a.png",
        "media_type": "image/png", "total_size": 3 } })
}

fn strokes(entry: Value) -> String {
    json!({ "schema_version": 2, "content_type": "strokes", "strokes": [entry] }).to_string()
}

fn with(mut entry: Value, key: &str, value: Value) -> Value {
    entry[key] = value;
    entry
}

fn without(mut entry: Value, key: &str) -> Value {
    if let Some(fields) = entry.as_object_mut() {
        fields.remove(key);
    }
    entry
}

/// Payloads that are no board item, each with its code and the reason.
pub fn refused_items() -> Vec<(String, &'static str, &'static str)> {
    let a = writers()[0].to_base64url();
    let note =
        json!({ "tool": "sticky", "at": [16, -40], "text": "x", "size": 320, "color": "yellow" });
    let picture = picture_entry();
    let ids = |list: Value| {
        json!({ "schema_version": 2, "content_type": "erase", "shape_ids": list }).to_string()
    };
    let moved = |offset: Value| {
        json!({ "schema_version": 2, "content_type": "move", "shape_ids": [format!("{a}/1/0")], "offset": offset })
            .to_string()
    };
    let bad = "bad-format";
    vec![
        ("strokes".to_owned(), bad, "no JSON"),
        (json!([1]).to_string(), bad, "no object"),
        (json!({ "content_type": "strokes", "strokes": [stroke_entry()] }).to_string(), bad, "no schema_version"),
        (json!({ "schema_version": 1, "content_type": "strokes", "strokes": [stroke_entry()] }).to_string(), bad, "schema_version 1"),
        (json!({ "schema_version": "2", "content_type": "strokes", "strokes": [stroke_entry()] }).to_string(), bad, "schema_version as text"),
        (json!({ "schema_version": 3, "content_type": "strokes", "strokes": [stroke_entry()] }).to_string(), "newer-version", "schema_version 3"),
        (json!({ "schema_version": 2, "content_type": "tiles", "strokes": [stroke_entry()] }).to_string(), bad, "an unknown content_type"),
        (json!({ "schema_version": 2, "content_type": "strokes" }).to_string(), bad, "strokes without shapes"),
        (json!({ "schema_version": 2, "content_type": "strokes", "strokes": [] }).to_string(), bad, "an empty list of shapes"),
        (json!({ "schema_version": 2, "content_type": "strokes", "strokes": [stroke_entry()], "shape_ids": [format!("{a}/1/0")] }).to_string(), bad, "strokes with shape ids"),
        (strokes(with(stroke_entry(), "tool", json!("eraser"))), bad, "an unknown tool"),
        (strokes(with(stroke_entry(), "id", json!(format!("{a}/1/0")))), bad, "a shape that names its own id"),
        (strokes(with(stroke_entry(), "at", json!([0, 0]))), bad, "a stroke with a note's field"),
        (strokes(without(stroke_entry(), "color")), bad, "a stroke without colour"),
        (strokes(with(stroke_entry(), "color", json!(""))), bad, "an empty colour"),
        (strokes(with(stroke_entry(), "width", json!(0))), bad, "width 0"),
        (strokes(with(stroke_entry(), "width", json!(16001))), bad, "a width above 16 000"),
        (strokes(with(stroke_entry(), "width", json!(4.5))), bad, "a width with a fraction"),
        (strokes(with(stroke_entry(), "width", json!("4"))), bad, "a width as text"),
        (strokes(with(stroke_entry(), "points", json!(""))), bad, "no points"),
        (strokes(with(stroke_entry(), "points", json!("AYCAAYBgAICA"))), bad, "points with a point cut short"),
        (strokes(with(stroke_entry(), "points", json!("AYCAAYBgAICAwx"))), bad, "points whose base64url has bits left over"),
        (strokes(with(stroke_entry(), "points", json!("AYCAAYBgAICAww=="))), bad, "points with base64 padding"),
        (strokes(with(stroke_entry(), "live", json!("AAAA"))), bad, "a live id of 3 bytes"),
        (strokes(with(stroke_entry(), "z", json!(1.5))), bad, "a layer that is no whole number"),
        (strokes(with(stroke_entry(), "group", json!(""))), bad, "an empty group"),
        (strokes(without(note.clone(), "text")), bad, "a note without text"),
        (strokes(with(note.clone(), "size", json!(0))), bad, "a note of size 0"),
        (strokes(with(note.clone(), "wrap", json!(0))), bad, "a note that wraps at 0"),
        (strokes(with(note.clone(), "at", json!([1]))), bad, "a note at one number"),
        (strokes(with(note.clone(), "at", json!([1, 2147483648u32]))), bad, "a position beyond the range"),
        (strokes(with(note, "points", json!("AYCAAYBgAICAww"))), bad, "a note with points"),
        (strokes(without(picture.clone(), "attachment")), bad, "a picture without attachment"),
        (strokes(with(picture.clone(), "attachment", json!({ "file_id": "AAAAAAAAAAAAAAAAAAAAAA", "file_key": "AAAA",
            "sha256": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "file_name": "a.png", "media_type": "image/png", "total_size": 3 }))), bad, "a file key of 3 bytes"),
        (strokes(with(picture, "color", json!("ink"))), bad, "a picture with a colour"),
        (ids(json!([])), bad, "no shape id"),
        (ids(json!([format!("{a}/1/0"), format!("{a}/1/0")])), bad, "a shape id twice"),
        (ids(json!([format!("{a}/0/0")])), bad, "envelope number 0"),
        (ids(json!([format!("{a}/01/0")])), bad, "a number with a leading zero"),
        (ids(json!([format!("{a}/1/0/0")])), bad, "an id of four parts"),
        (ids(json!([format!("{a}/1")])), bad, "an id of two parts"),
        (ids(json!(["AAAA/1/0"])), bad, "a sender of 3 bytes"),
        (ids(json!([format!("{a}/1/4294967296")])), bad, "an index beyond 32 bits"),
        (json!({ "schema_version": 2, "content_type": "erase", "shape_ids": [format!("{a}/1/0")], "offset": [1, 1] }).to_string(), bad, "an erase with an offset"),
        (json!({ "schema_version": 2, "content_type": "move", "shape_ids": [format!("{a}/1/0")] }).to_string(), bad, "a move without offset"),
        (moved(json!([1, 2, 3])), bad, "an offset of three numbers"),
        (moved(json!([-2147483649i64, 0])), bad, "an offset beyond the range"),
        (moved(json!([0.5, 0])), bad, "an offset with a fraction"),
        // Spelled out, because a JSON library would write these numbers another way.
        (strokes(stroke_entry()).replace("\"width\":64", "\"width\":64.0"), bad, "a whole number written with a fraction"),
        (strokes(stroke_entry()).replace("\"width\":64", "\"width\":6.4e1"), bad, "a whole number written with an exponent"),
        (strokes(stroke_entry()).replace("\"width\":64", "\"width\":64,\"z\":1e-400"), bad, "a layer too small to tell from 0"),
        (strokes(stroke_entry()).replace("\"width\":64", "\"width\":64,\"wrap\":null"), bad, "a stroke with a note's field set to null"),
        (strokes(stroke_entry()).replace("\"width\":64", "\"width\":64,\"group\":null"), bad, "a field of its own set to null"),
        (ids(json!([format!("{a}/1/0")])).replace("\"shape_ids\"", "\"strokes\":null,\"shape_ids\""), bad, "an erase with strokes set to null"),
        (strokes(picture_entry()).replace("\"file_key\":\"A", "\"file_key\":\"\\u0041"), bad, "a file key written with an escape"),
    ]
}

/// A small snapshot file that is in order, to derive the refused ones from.
fn small_snapshot() -> Value {
    let [a, b, _] = writers().map(|writer| writer.to_base64url());
    let hash = Hash32::new([7; 32]).to_base64url();
    json!({
        "v": 3,
        "shapes": [
            with(stroke_entry(), "id", json!(format!("{a}/2/0"))),
            with(stroke_entry(), "id", json!(format!("{a}/2/1"))),
        ],
        "frontier": { a.clone(): [4, hash.clone()], b.clone(): [1, hash] },
        "gone": [format!("{a}/5/0")],
        "moved": [[format!("{b}/2/0"), 24, -32]],
    })
}

/// Files that are no snapshot, each with its code and the reason.
pub fn refused_snapshots() -> Vec<(String, &'static str, &'static str)> {
    let [a, b, _] = writers().map(|writer| writer.to_base64url());
    let hash = Hash32::new([7; 32]).to_base64url();
    let good = small_snapshot;
    let set = |path: &[&str], value: Value| {
        let mut file = good();
        let mut at = &mut file;
        for key in path {
            at = match key.parse::<usize>() {
                Ok(index) => &mut at[index],
                Err(_) => &mut at[*key],
            };
        }
        *at = value;
        file.to_string()
    };
    let bad = "bad-format";
    vec![
        (set(&["v"], json!(2)), bad, "version 2"),
        (set(&["v"], json!(4)), "newer-version", "version 4"),
        (
            without(good(), "gone").to_string(),
            bad,
            "no list of erased shapes",
        ),
        (without(good(), "frontier").to_string(), bad, "no frontier"),
        (
            set(&["shapes", "0", "id"], json!(format!("{a}/5/0"))),
            bad,
            "a shape beyond the frontier",
        ),
        (
            set(
                &["shapes", "0", "id"],
                json!(format!("{}/1/0", writers()[2].to_base64url())),
            ),
            bad,
            "a shape of a writer the frontier does not name",
        ),
        (
            set(&["shapes", "1", "id"], json!(format!("{a}/2/0"))),
            bad,
            "a shape twice",
        ),
        (
            set(&["shapes", "1", "id"], json!(format!("{a}/1/0"))),
            bad,
            "shapes out of order",
        ),
        (
            set(&["shapes", "0"], stroke_entry()),
            bad,
            "a shape without id",
        ),
        (
            set(&["shapes", "0", "tool"], json!("eraser")),
            bad,
            "a shape of an unknown tool",
        ),
        (
            set(&["frontier", &a], json!([0, hash])),
            bad,
            "a frontier at number 0",
        ),
        (
            set(&["frontier", &a], json!([4, "AAAA"])),
            bad,
            "a frontier hash of 3 bytes",
        ),
        (
            good()
                .to_string()
                .replace(&format!("\"{b}\":[1,"), &format!("\"{a}\":[1,")),
            bad,
            "a writer twice in the frontier",
        ),
        (
            set(&["gone", "0"], json!(format!("{a}/4/0"))),
            bad,
            "an erased shape that the frontier covers",
        ),
        (
            set(&["gone"], json!([format!("{a}/6/0"), format!("{a}/5/0")])),
            bad,
            "erased shapes out of order",
        ),
        (
            set(&["moved", "0"], json!([format!("{b}/1/0"), 1, 1])),
            bad,
            "a move kept for a shape that the frontier covers",
        ),
        (
            set(&["moved", "0"], json!([format!("{b}/2/0"), 0, 0])),
            bad,
            "a move by nothing",
        ),
        (
            set(&["moved", "0"], json!([format!("{a}/5/0"), 1, 1])),
            bad,
            "a move kept for an erased shape",
        ),
        (
            set(&["moved", "0"], json!([format!("{b}/2/0"), 0.5, 1])),
            bad,
            "a move with a fraction",
        ),
    ]
}

/// The frontier at which the history's snapshot is taken: every writer at the last number the board applied.
pub fn frontier(board: &Board) -> Vec<(DeviceId, Head)> {
    writers()
        .iter()
        .filter(|writer| board.applied(writer) > 0)
        .map(|writer| {
            let seq = board.applied(writer);
            let mut hash = *writer.as_bytes();
            hash[0] = seq as u8;
            (
                *writer,
                Head {
                    seq,
                    hash: Hash32::new(hash),
                },
            )
        })
        .collect()
}

/// Makes the file.
pub fn generate() -> Result<Value, Error> {
    let mut dice = Dice(entropy(NAME)?);

    let mut points = Vec::new();
    for _ in 0..6 {
        let ink = ink(&mut dice)?;
        points.push(json!({
            "packed": hex(&ink.pack()),
            "tilted": ink.tilted(),
            "simulated": ink.simulated(),
            "points": ink.points().iter()
                .map(|p| json!([p.x, p.y, p.t, p.force, p.azimuth, p.altitude]))
                .collect::<Vec<_>>(),
        }));
    }
    // The largest step there is: from one end of the range to the other and back.
    let far = Ink::unpack(&[
        0, 0xff, 0xff, 0xff, 0xff, 0x0f, 0xfe, 0xff, 0xff, 0xff, 0x0f, 0, 0,
    ])?;
    points.push(json!({
        "packed": hex(&far.pack()), "tilted": false, "simulated": false,
        "points": far.points().iter().map(|p| json!([p.x, p.y, p.t, p.force, p.azimuth, p.altitude])).collect::<Vec<_>>(),
    }));

    let mut items = Vec::new();
    let [a, b, _] = writers();
    let id =
        |sender: DeviceId, seq: u64, index: u32| trommi_core::board::ShapeId { sender, seq, index };
    let mut bodies = vec![
        ItemBody::Erase(vec![
            id(a, 1, 0),
            id(b, 18_446_744_073_709_551_615, 4_294_967_295),
        ]),
        ItemBody::SendAway(vec![id(b, 7, 2)]),
        ItemBody::Move {
            shapes: vec![id(a, 3, 1)],
            offset: [-200, 1],
        },
        ItemBody::Move {
            shapes: vec![id(a, 3, 1)],
            offset: [i32::MAX, i32::MIN],
        },
        ItemBody::Strokes(vec![Shape {
            kind: ShapeKind::Note(Note {
                kind: NoteKind::Voice,
                at: [-33, 800],
                text: "Morgen: \"Kern\" fertig\n".to_owned(),
                size: 320,
                color: "ink".to_owned(),
                wrap: Some(4_000),
            }),
            z: -2,
            group: Some("g7".to_owned()),
        }]),
    ];
    for _ in 0..4 {
        bodies.push(ItemBody::Strokes(vec![
            shape(&mut dice)?,
            shape(&mut dice)?,
        ]));
    }
    for body in &bodies {
        items.push(json!({
            "payload": text(body.encode()?.expose())?,
            "file_ids": body.file_ids().iter().map(|file| hex(file.as_bytes())).collect::<Vec<_>>(),
        }));
    }

    let history = history(&mut dice, &writers(), 40)?;
    let mut board = Board::new();
    apply_all(&mut board, &history)?;
    let frontier = frontier(&board);
    let snapshot = text(board.snapshot(&frontier)?.expose())?;

    let small_heads = [4u64, 1].map(|seq| Head {
        seq,
        hash: Hash32::new([7; 32]),
    });
    let small_heads = [
        (writers()[0], small_heads[0]),
        (writers()[1], small_heads[1]),
    ];
    let small = Board::from_snapshot(small_snapshot().to_string().as_bytes(), &small_heads)?;
    let small = text(small.snapshot(&small_heads)?.expose())?;

    Ok(json!({
        "about": "The Scribble Board (spec/v2.md section 10). points: packed points of a stroke in hex and what they hold, [x, y, t, force, azimuth, altitude] per point, x and y in 1/16 board unit. points_refused: packed bytes no reader takes. items: payloads of board items; a reader that decodes and encodes one gets the same text; file_ids is what the envelope's header lists. items_with_unknown_fields: payloads that read like the one named in same_as. items_refused, snapshots_refused: with the code of the refusal. history: board items in one order of arrival (sender in hex, envelope number, payload); applied in any order that keeps each sender's own order they give the board whose snapshot file, taken at frontier, is snapshot.",
        "points": points,
        "points_refused": refused_points().iter().map(|(packed, why)| json!({ "packed": packed, "why": why })).collect::<Vec<_>>(),
        "items": items,
        "items_with_unknown_fields": [{
            "payload": json!({ "schema_version": 2, "content_type": "strokes", "later": [1, 2],
                "strokes": [with(with(stroke_entry(), "transform", json!([2, 0, 0, 2, 100, 50])), "nw", Value::Null)] }).to_string(),
            "same_as": strokes(stroke_entry()),
        }],
        "items_refused": refused_items().iter().map(|(payload, code, why)| json!({ "payload": payload, "code": code, "why": why })).collect::<Vec<_>>(),
        "history": history.iter().map(|item| json!({
            "sender": hex(item.sender.as_bytes()), "seq": item.seq, "payload": text(&item.payload).unwrap_or_default(),
        })).collect::<Vec<_>>(),
        "frontier": frontier.iter().map(|(writer, head)| json!([hex(writer.as_bytes()), head.seq, hex(head.hash.as_bytes())])).collect::<Vec<_>>(),
        "snapshot": snapshot,
        "snapshot_small": small,
        "snapshots_refused": refused_snapshots().iter().map(|(file, code, why)| json!({ "file": file, "code": code, "why": why })).collect::<Vec<_>>(),
    }))
}
