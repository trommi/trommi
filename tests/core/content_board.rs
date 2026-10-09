//! The Scribble Board's content (section 10): packed points, item bodies, the merge and the snapshot file,
//! against `spec/vectors/board.json` and `spec/strokes.json`, and under random input.

use serde_json::Value;
use trommi_core::board::ShapeId;
use trommi_core::board_items::*;
use trommi_core::chain::Head;
use trommi_core::crypto::Secret;
use trommi_core::files::FileRef;
use trommi_core::ids::{DeviceId, FileId, Hash32};
use trommi_core::Error;
use trommi_tests::content::{another_order, apply_all, history, shape, Dice, Item};
use trommi_tests::vectors::board::{frontier, writers, NAME};
use trommi_tests::vectors::{entropy, hex, read, unhex};

fn list<'a>(file: &'a Value, key: &str) -> &'a Vec<Value> {
    file[key].as_array().expect(key)
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().expect(key)
}

fn code<T: std::fmt::Debug>(result: Result<T, Error>) -> &'static str {
    result.expect_err("refused").code()
}

fn id(sender: DeviceId, seq: u64, index: u32) -> ShapeId {
    ShapeId { sender, seq, index }
}

fn stroke(x: i32, y: i32) -> Shape {
    let point = |x, y, t| Point {
        x,
        y,
        t,
        force: 128,
        azimuth: 0,
        altitude: 0,
    };
    Shape {
        kind: ShapeKind::Stroke(Stroke {
            pen: Pen::Pen,
            color: "ink".to_owned(),
            width: 64,
            ink: Ink::new(vec![point(x, y, 0), point(x + 16, y + 32, 9)], false, false).unwrap(),
            live: None,
        }),
        z: 0,
        group: None,
    }
}

fn first_point(board: &Board, id: &ShapeId) -> [i32; 2] {
    match &board.shape(id).expect("on the board").kind {
        ShapeKind::Stroke(stroke) => [stroke.ink.points()[0].x, stroke.ink.points()[0].y],
        other => panic!("no stroke: {other:?}"),
    }
}

fn changed(applied: Applied) -> Vec<ShapeId> {
    match applied {
        Applied::Changed(ids) => ids,
        Applied::Covered => panic!("covered"),
    }
}

fn history_of(file: &Value) -> Vec<Item> {
    list(file, "history")
        .iter()
        .map(|item| Item {
            sender: DeviceId::from_slice(&unhex(text(item, "sender")).unwrap()).unwrap(),
            seq: item["seq"].as_u64().unwrap(),
            payload: text(item, "payload").as_bytes().to_vec(),
        })
        .collect()
}

// ---- packed points ----

#[test]
fn points_of_the_vectors_unpack_and_pack() {
    let file = read(NAME).unwrap();
    for case in list(&file, "points") {
        let packed = unhex(text(case, "packed")).unwrap();
        let ink = Ink::unpack(&packed).unwrap();
        assert_eq!(ink.tilted(), case["tilted"].as_bool().unwrap());
        assert_eq!(ink.simulated(), case["simulated"].as_bool().unwrap());
        let points: Vec<Value> = ink
            .points()
            .iter()
            .map(|p| serde_json::json!([p.x, p.y, p.t, p.force, p.azimuth, p.altitude]))
            .collect();
        assert_eq!(&points, list(case, "points"));
        assert_eq!(ink.pack(), packed);
        assert_eq!(Ink::from_base64url(&ink.to_base64url()).unwrap(), ink);
    }
    for case in list(&file, "points_refused") {
        let packed = unhex(text(case, "packed")).unwrap();
        assert_eq!(
            code(Ink::unpack(&packed)),
            "bad-format",
            "{}",
            text(case, "why")
        );
    }
}

#[test]
fn the_sample_strokes_read_as_the_fixture_says() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../spec/strokes.json");
    let file: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let tau = std::f64::consts::TAU;
    let close = |a: f64, b: f64| (a - b).abs() < 1e-6;
    for sample in list(&file, "strokes") {
        let packed = text(&sample["entry"], "points");
        let ink = Ink::from_base64url(packed).unwrap();
        assert_eq!(ink.to_base64url(), packed, "{}", text(sample, "name"));
        let decoded = list(sample, "decoded");
        assert_eq!(ink.points().len(), decoded.len());
        for (point, expected) in ink.points().iter().zip(decoded) {
            assert_eq!(f64::from(point.x) / 16.0, expected["x"].as_f64().unwrap());
            assert_eq!(f64::from(point.y) / 16.0, expected["y"].as_f64().unwrap());
            assert_eq!(u64::from(point.t), expected["t"].as_u64().unwrap());
            let force = (f64::from(point.force) / 255.0 * 1000.0).round() / 1000.0;
            assert_eq!(force, expected["force"].as_f64().unwrap());
            assert_eq!(ink.tilted(), expected.get("azimuth").is_some());
            if ink.tilted() {
                let azimuth = f64::from(point.azimuth) / 256.0 * tau;
                let altitude = f64::from(point.altitude) / 255.0 * tau / 4.0;
                assert!(close(azimuth, expected["azimuth"].as_f64().unwrap()));
                assert!(close(altitude, expected["altitude"].as_f64().unwrap()));
            }
        }
    }
    let piece = text(&file["piece"]["entry"], "points");
    assert_eq!(Ink::from_base64url(piece).unwrap().to_base64url(), piece);
}

#[test]
fn ink_refuses_what_it_could_not_pack() {
    let point = |t| Point {
        x: 0,
        y: 0,
        t,
        force: 1,
        azimuth: 0,
        altitude: 0,
    };
    assert_eq!(code(Ink::new(vec![], false, false)), "bad-format");
    assert_eq!(
        code(Ink::new(vec![point(5), point(4)], false, false)),
        "bad-format"
    );
    let tilted = Point {
        azimuth: 1,
        ..point(0)
    };
    assert_eq!(code(Ink::new(vec![tilted], false, false)), "bad-format");
    assert!(Ink::new(vec![tilted], true, false).is_ok());
    assert!(Ink::new(vec![point(0); MAX_POINTS], false, true).is_ok());
    assert_eq!(
        code(Ink::new(vec![point(0); MAX_POINTS + 1], false, false)),
        "bad-format"
    );
    // The longest stroke there is reads its own text back: every point the widest step, with tilt.
    let widest = (0..MAX_POINTS)
        .map(|i| Point {
            x: if i % 2 == 0 { i32::MIN } else { 0 },
            y: if i % 2 == 0 { i32::MIN } else { 0 },
            t: 0,
            force: 1,
            azimuth: 2,
            altitude: 3,
        })
        .collect();
    let widest = Ink::new(widest, true, false).unwrap();
    assert_eq!(widest.pack().len(), 1 + MAX_POINTS * 14);
    assert_eq!(Ink::from_base64url(&widest.to_base64url()).unwrap(), widest);
    let mut packed = Ink::new(vec![point(0); MAX_POINTS], false, false)
        .unwrap()
        .pack();
    packed.extend([0, 0, 0, 1]);
    assert_eq!(code(Ink::unpack(&packed)), "bad-format");
}

// ---- item bodies ----

#[test]
fn items_of_the_vectors_decode_and_encode() {
    let file = read(NAME).unwrap();
    for case in list(&file, "items") {
        let payload = text(case, "payload");
        let body = ItemBody::decode(payload.as_bytes()).unwrap();
        assert_eq!(body.encode().unwrap().expose(), payload.as_bytes());
        let files: Vec<Value> = body
            .file_ids()
            .iter()
            .map(|f| hex(f.as_bytes()).into())
            .collect();
        assert_eq!(&files, list(case, "file_ids"));
    }
    for case in list(&file, "items_with_unknown_fields") {
        assert_eq!(
            ItemBody::decode(text(case, "payload").as_bytes()).unwrap(),
            ItemBody::decode(text(case, "same_as").as_bytes()).unwrap()
        );
    }
    for case in list(&file, "items_refused") {
        let result = ItemBody::decode(text(case, "payload").as_bytes());
        assert_eq!(code(result), text(case, "code"), "{}", text(case, "why"));
    }
    for item in history_of(&file) {
        let body = ItemBody::decode(&item.payload).unwrap();
        assert_eq!(body.encode().unwrap().expose(), item.payload);
    }
}

#[test]
fn a_writer_cannot_encode_what_a_reader_refuses() {
    let a = writers()[0];
    let refused = |body: ItemBody| assert_eq!(code(body.encode()), "bad-format");
    refused(ItemBody::Strokes(vec![]));
    refused(ItemBody::Erase(vec![]));
    refused(ItemBody::Erase(vec![id(a, 1, 0), id(a, 1, 0)]));
    refused(ItemBody::Erase(vec![id(a, 0, 0)]));
    refused(ItemBody::Move {
        shapes: (0..=MAX_SHAPE_IDS as u32).map(|i| id(a, 1, i)).collect(),
        offset: [1, 1],
    });
    let with = |change: fn(&mut Shape)| {
        let mut shape = stroke(0, 0);
        change(&mut shape);
        ItemBody::Strokes(vec![shape])
    };
    refused(with(|s| s.group = Some(String::new())));
    refused(with(|s| s.group = Some("g".repeat(MAX_GROUP_LEN + 1))));
    refused(with(|s| {
        if let ShapeKind::Stroke(stroke) = &mut s.kind {
            stroke.width = 0
        }
    }));
    refused(with(|s| {
        if let ShapeKind::Stroke(stroke) = &mut s.kind {
            stroke.width = MAX_WIDTH + 1
        }
    }));
    refused(with(|s| {
        if let ShapeKind::Stroke(stroke) = &mut s.kind {
            stroke.color = "c".repeat(41)
        }
    }));
    let note = |text: String, size, wrap| {
        ItemBody::Strokes(vec![Shape {
            kind: ShapeKind::Note(Note {
                kind: NoteKind::Text,
                at: [0, 0],
                text,
                size,
                color: "ink".into(),
                wrap,
            }),
            z: 0,
            group: None,
        }])
    };
    assert!(note("x".repeat(MAX_TEXT_LEN), 16, Some(1)).encode().is_ok());
    refused(note("x".repeat(MAX_TEXT_LEN + 1), 16, None));
    refused(note("x".into(), 0, None));
    refused(note("x".into(), 16, Some(0)));
    refused(ItemBody::Strokes(
        (0..=MAX_SHAPES).map(|_| stroke(0, 0)).collect(),
    ));

    // Three notes of the largest text do not fit one payload; a payload a byte too long is not read.
    let big = ItemBody::Strokes(vec![
        Shape {
            kind: ShapeKind::Note(Note {
                kind: NoteKind::Text,
                at: [0, 0],
                text: "x".repeat(MAX_TEXT_LEN),
                size: 16,
                color: "ink".into(),
                wrap: None,
            }),
            z: 0,
            group: None,
        },
        Shape {
            kind: ShapeKind::Note(Note {
                kind: NoteKind::Text,
                at: [0, 0],
                text: "y".repeat(MAX_TEXT_LEN),
                size: 16,
                color: "ink".into(),
                wrap: None,
            }),
            z: 0,
            group: None,
        },
        Shape {
            kind: ShapeKind::Note(Note {
                kind: NoteKind::Text,
                at: [0, 0],
                text: "z".repeat(MAX_TEXT_LEN),
                size: 16,
                color: "ink".into(),
                wrap: None,
            }),
            z: 0,
            group: None,
        },
    ]);
    assert_eq!(code(big.encode()), "too-large");
    let mut long = ItemBody::Erase(vec![id(a, 1, 0)])
        .encode()
        .unwrap()
        .expose()
        .to_vec();
    long.resize(trommi_core::envelope::MAX_PAYLOAD_LEN + 1, b' ');
    assert_eq!(code(ItemBody::decode(&long)), "too-large");
}

#[test]
fn a_picture_names_its_file_and_prints_no_key() {
    let picture = |byte: u8| Shape {
        kind: ShapeKind::Picture(Picture {
            rect: [0, 0, 160, 160],
            file: FileRef {
                file_id: FileId::new([byte; 16]),
                file_key: Secret::new([0xAB; 32]),
                sha256: Hash32::new([3; 32]),
            },
            file_name: "geheim.png".to_owned(),
            media_type: "image/png".to_owned(),
            total_size: 9,
            width: Some(10),
            height: None,
        }),
        z: 1,
        group: None,
    };
    let body = ItemBody::Strokes(vec![picture(1), stroke(0, 0), picture(2), picture(1)]);
    assert_eq!(
        body.file_ids(),
        vec![FileId::new([1; 16]), FileId::new([2; 16])]
    );
    let payload = body.encode().unwrap();
    assert_eq!(ItemBody::decode(payload.expose()).unwrap(), body);

    let mut board = Board::new();
    board.apply(writers()[0], 1, body).unwrap();
    let printed = format!("{board:?} {payload:?}");
    let key = trommi_core::ids::base64url_encode(&[0xAB; 32]);
    assert!(!printed.contains(&key) && !printed.contains("abab") && !printed.contains("171, 171"));
    assert!(!printed.contains("geheim"));
    let note = Note {
        kind: NoteKind::Sticky,
        at: [0, 0],
        text: "vertraulich".into(),
        size: 16,
        color: "ink".into(),
        wrap: None,
    };
    assert!(!format!("{note:?}").contains("vertraulich"));
}

// ---- the merge ----

#[test]
fn adding_erasing_and_moving() {
    let [a, b, _] = writers();
    let mut board = Board::new();
    let added = board
        .apply(a, 3, ItemBody::Strokes(vec![stroke(0, 0), stroke(160, 0)]))
        .unwrap();
    assert_eq!(changed(added), vec![id(a, 3, 0), id(a, 3, 1)]);
    assert_eq!(board.applied(&a), 3);

    // The same number again, and an older one, change nothing.
    assert_eq!(
        board
            .apply(a, 3, ItemBody::Strokes(vec![stroke(9, 9)]))
            .unwrap(),
        Applied::Covered
    );
    assert_eq!(
        board
            .apply(a, 2, ItemBody::Erase(vec![id(a, 3, 0)]))
            .unwrap(),
        Applied::Covered
    );
    assert_eq!(
        code(board.apply(a, 0, ItemBody::Erase(vec![id(a, 3, 0)]))),
        "bad-format"
    );
    assert_eq!(board.shapes().count(), 2);

    // Moves add up, and wrap around the range instead of overflowing.
    let moved = board
        .apply(
            b,
            1,
            ItemBody::Move {
                shapes: vec![id(a, 3, 0), id(a, 9, 0)],
                offset: [10, -4],
            },
        )
        .unwrap();
    assert_eq!(changed(moved), vec![id(a, 3, 0)]);
    board
        .apply(
            a,
            4,
            ItemBody::Move {
                shapes: vec![id(a, 3, 0)],
                offset: [i32::MAX, i32::MAX],
            },
        )
        .unwrap();
    board
        .apply(
            b,
            2,
            ItemBody::Move {
                shapes: vec![id(a, 3, 0)],
                offset: [1, 5],
            },
        )
        .unwrap();
    assert_eq!(first_point(&board, &id(a, 3, 0)), [i32::MIN + 10, i32::MIN]);
    assert_eq!(first_point(&board, &id(a, 3, 1)), [160, 0]);

    // The move that came before its shape counts when the shape comes.
    board
        .apply(a, 9, ItemBody::Strokes(vec![stroke(0, 0)]))
        .unwrap();
    assert_eq!(first_point(&board, &id(a, 9, 0)), [10, -4]);

    // Erase wins: over a shape that is there, over a later move, and over a shape still to come.
    let erased = board
        .apply(
            b,
            3,
            ItemBody::Erase(vec![id(a, 3, 0), id(a, 12, 1), id(a, 5, 0)]),
        )
        .unwrap();
    assert_eq!(changed(erased), vec![id(a, 3, 0)]);
    assert_eq!(
        changed(
            board
                .apply(
                    b,
                    4,
                    ItemBody::Move {
                        shapes: vec![id(a, 3, 0), id(a, 12, 1)],
                        offset: [1, 1]
                    }
                )
                .unwrap()
        ),
        vec![]
    );
    let later = board
        .apply(a, 12, ItemBody::Strokes(vec![stroke(0, 0), stroke(0, 0)]))
        .unwrap();
    assert_eq!(changed(later), vec![id(a, 12, 0)]);
    assert!(board.shape(&id(a, 12, 1)).is_none() && board.shape(&id(a, 3, 0)).is_none());

    // Sent away is gone like erased.
    assert_eq!(
        changed(
            board
                .apply(a, 13, ItemBody::SendAway(vec![id(a, 12, 0)]))
                .unwrap()
        ),
        vec![id(a, 12, 0)]
    );
    let left: Vec<ShapeId> = board.shapes().map(|(id, _)| *id).collect();
    assert_eq!(left, vec![id(a, 3, 1), id(a, 9, 0)]);
}

#[test]
fn every_order_of_arrival_gives_the_same_board() {
    let mut dice = Dice(entropy("content board orders").unwrap());
    for round in 0..60 {
        let history = history(&mut dice, &writers(), 10 + round).unwrap();
        let mut board = Board::new();
        apply_all(&mut board, &history).unwrap();
        for _ in 0..12 {
            let order = another_order(&mut dice, &history).unwrap();
            let mut other = Board::new();
            apply_all(&mut other, &order).unwrap();
            assert_eq!(other, board, "round {round}");
            // Handing everything in a second time changes nothing.
            apply_all(&mut other, &history).unwrap();
            assert_eq!(other, board);
        }
    }
}

#[test]
fn the_history_of_the_vectors_gives_its_snapshot_in_any_order() {
    let file = read(NAME).unwrap();
    let history = history_of(&file);
    let mut dice = Dice(entropy("content board vector orders").unwrap());
    for _ in 0..20 {
        let mut board = Board::new();
        apply_all(&mut board, &another_order(&mut dice, &history).unwrap()).unwrap();
        let heads = frontier(&board);
        let named: Vec<Value> = heads
            .iter()
            .map(|(w, head)| {
                serde_json::json!([hex(w.as_bytes()), head.seq, hex(head.hash.as_bytes())])
            })
            .collect();
        assert_eq!(&named, list(&file, "frontier"));
        assert_eq!(
            board.snapshot(&heads).unwrap().expose(),
            text(&file, "snapshot").as_bytes()
        );
    }
}

// ---- the snapshot ----

/// The frontier a snapshot file names, read on its own; none if the file has none that is well formed.
fn named_frontier(file: &[u8]) -> Option<Vec<(DeviceId, Head)>> {
    let file: Value = serde_json::from_slice(file).ok()?;
    trommi_core::chain::parse_heads(&file.get("frontier")?.to_string()).ok()
}

/// What a board shows, as text: the snapshot at a frontier that covers every writer far ahead.
fn shown(board: &Board) -> Vec<u8> {
    let far: Vec<(DeviceId, Head)> = writers()
        .iter()
        .map(|w| {
            (
                *w,
                Head {
                    seq: u64::MAX,
                    hash: Hash32::ZERO,
                },
            )
        })
        .collect();
    board.snapshot(&far).unwrap().expose().to_vec()
}

#[test]
fn a_snapshot_and_the_items_after_it_give_the_board() {
    let mut dice = Dice(entropy("content board snapshots").unwrap());
    for round in 0..80 {
        let history = history(&mut dice, &writers(), 30).unwrap();
        let mut whole = Board::new();
        apply_all(&mut whole, &history).unwrap();

        // A device writes a snapshot after some of the items, in its own order of arrival; its chains may be
        // ahead of what the board took (they carry other things), never behind.
        let order = another_order(&mut dice, &history).unwrap();
        let cut = dice.below(order.len() as u64 + 1).unwrap() as usize;
        let mut writer = Board::new();
        apply_all(&mut writer, &order[..cut]).unwrap();
        let mut heads = Vec::new();
        for w in writers() {
            let next = order[cut..]
                .iter()
                .find(|item| item.sender == w)
                .map(|item| item.seq);
            let least = writer.applied(&w);
            let most = next.map_or(least + 2, |next| next - 1);
            let seq = least + dice.below(most - least + 1).unwrap();
            if seq > 0 {
                heads.push((
                    w,
                    Head {
                        seq,
                        hash: Hash32::new([round as u8; 32]),
                    },
                ));
            }
        }
        let file = writer.snapshot(&heads).unwrap();

        // Another device loads it and gets every item of the history, in yet another order.
        let mut loaded = Board::from_snapshot(file.expose(), &heads).unwrap();
        assert_eq!(loaded.snapshot(&heads).unwrap().expose(), file.expose());
        apply_all(&mut loaded, &another_order(&mut dice, &history).unwrap()).unwrap();
        assert_eq!(shown(&loaded), shown(&whole), "round {round}");
    }
}

#[test]
fn snapshots_of_the_vectors_load_or_are_refused() {
    let file = read(NAME).unwrap();
    for key in ["snapshot", "snapshot_small"] {
        let bytes = text(&file, key).as_bytes();
        let heads = named_frontier(bytes).unwrap();
        let board = Board::from_snapshot(bytes, &heads).unwrap();
        assert!(board.snapshot(&heads).unwrap().expose() == bytes, "{key}");

        // Loaded beside a register that names another frontier, the file is refused.
        let mut other = heads.clone();
        other[0].1.seq += 1;
        assert_eq!(code(Board::from_snapshot(bytes, &other)), "bad-format");
        assert_eq!(code(Board::from_snapshot(bytes, &heads[1..])), "bad-format");
    }
    for case in list(&file, "snapshots_refused") {
        let bytes = text(case, "file").as_bytes();
        // Whatever frontier the file names well, the register is taken to name the same.
        let heads = named_frontier(bytes).unwrap_or_default();
        let result = Board::from_snapshot(bytes, &heads);
        assert_eq!(code(result), text(case, "code"), "{}", text(case, "why"));
    }
}

#[test]
fn a_snapshot_is_refused_behind_the_board_and_after_an_unread_item() {
    let [a, b, _] = writers();
    let head = |seq| Head {
        seq,
        hash: Hash32::new([1; 32]),
    };
    let mut board = Board::new();
    board
        .apply(a, 4, ItemBody::Strokes(vec![stroke(0, 0)]))
        .unwrap();
    board
        .apply(b, 2, ItemBody::Erase(vec![id(a, 9, 0)]))
        .unwrap();
    assert!(board.snapshot(&[(a, head(4)), (b, head(2))]).is_ok());
    assert_eq!(
        code(board.snapshot(&[(a, head(3)), (b, head(2))])),
        "bad-format"
    );
    assert_eq!(code(board.snapshot(&[(a, head(4))])), "bad-format");
    assert_eq!(
        code(board.snapshot(&[(a, head(4)), (b, head(2)), (a, head(5))])),
        "bad-format"
    );
    assert_eq!(
        code(board.snapshot(&[(a, head(4)), (b, head(2)), (writers()[2], head(0))])),
        "bad-format"
    );

    // What was kept for a shape that the frontier covers is not written: the shape can no longer come.
    let ahead = String::from_utf8(
        board
            .snapshot(&[(a, head(8)), (b, head(2))])
            .unwrap()
            .expose()
            .to_vec(),
    )
    .unwrap();
    assert!(ahead.contains(&id(a, 9, 0).to_string()));
    let past = String::from_utf8(
        board
            .snapshot(&[(a, head(9)), (b, head(2))])
            .unwrap()
            .expose()
            .to_vec(),
    )
    .unwrap();
    assert!(!past.contains(&id(a, 9, 0).to_string()));

    // An item the device could not read is skipped once, and the board then writes no snapshot.
    assert_eq!(board.unread(), None);
    board.skip_unread(a, 4, Unread::Newer);
    assert_eq!(board.unread(), None);
    board.skip_unread(a, 6, Unread::NoKey);
    assert_eq!(board.unread(), Some(Unread::NoKey));
    assert_eq!(board.applied(&a), 6);
    assert_eq!(
        code(board.snapshot(&[(a, head(6)), (b, head(2))])),
        "no-key"
    );
    board.skip_unread(b, 3, Unread::Newer);
    assert_eq!(board.unread(), Some(Unread::Newer));
    assert_eq!(
        code(board.snapshot(&[(a, head(6)), (b, head(3))])),
        "newer-version"
    );
    assert_eq!(
        board
            .apply(a, 6, ItemBody::Strokes(vec![stroke(0, 0)]))
            .unwrap(),
        Applied::Covered
    );
}

// ---- hostile input ----

#[test]
fn no_bytes_make_a_reader_panic_and_what_is_read_is_written_the_same() {
    let mut dice = Dice(entropy("content board fuzz").unwrap());
    let file = read(NAME).unwrap();
    let mut seeds: Vec<Vec<u8>> = list(&file, "items")
        .iter()
        .chain(list(&file, "items_refused"))
        .map(|case| text(case, "payload").as_bytes().to_vec())
        .collect();
    seeds.push(text(&file, "snapshot_small").as_bytes().to_vec());
    seeds.extend(
        list(&file, "snapshots_refused")
            .iter()
            .map(|case| text(case, "file").as_bytes().to_vec()),
    );
    seeds.extend(
        list(&file, "points")
            .iter()
            .map(|case| unhex(text(case, "packed")).unwrap()),
    );
    for _ in 0..8 {
        seeds.push(
            ItemBody::Strokes(vec![shape(&mut dice).unwrap()])
                .encode()
                .unwrap()
                .expose()
                .to_vec(),
        );
    }

    let check = |bytes: &[u8]| {
        if let Ok(ink) = Ink::unpack(bytes) {
            assert_eq!(ink.pack(), bytes);
        }
        if let Ok(body) = ItemBody::decode(bytes) {
            let again = body.encode().unwrap();
            assert_eq!(ItemBody::decode(again.expose()).unwrap(), body);
        }
        let heads = named_frontier(bytes).unwrap_or_default();
        if let Ok(board) = Board::from_snapshot(bytes, &heads) {
            let again = board.snapshot(&heads).unwrap();
            assert_eq!(Board::from_snapshot(again.expose(), &heads).unwrap(), board);
        }
    };
    for round in 0..40_000u32 {
        let mut bytes = if round % 8 == 0 {
            let len = dice.below(200).unwrap() as usize;
            let mut bytes = vec![0u8; len];
            for byte in &mut bytes {
                *byte = dice.below(256).unwrap() as u8;
            }
            bytes
        } else {
            seeds[dice.below(seeds.len() as u64).unwrap() as usize].clone()
        };
        for _ in 0..dice.below(4).unwrap() {
            if bytes.is_empty() {
                break;
            }
            let at = dice.below(bytes.len() as u64).unwrap() as usize;
            match dice.below(4).unwrap() {
                0 => bytes[at] = dice.below(256).unwrap() as u8,
                1 => bytes[at] ^= 1 << dice.below(8).unwrap(),
                2 => {
                    bytes.remove(at);
                }
                _ => bytes.insert(
                    at,
                    b"0123456789-[]{}\",:.e/"[dice.below(21).unwrap() as usize],
                ),
            }
        }
        check(&bytes);
    }
}
