//! The bodies of the live messages (sections 7.2 and 7.3) against `spec/vectors/trail.json`, inside the
//! message that carries them, and under random input.

use serde_json::Value;
use trommi_core::board_items::Ink;
use trommi_core::codec;
use trommi_core::ids::{BoardId, TurnId};
use trommi_core::mls::message::{TrommiMessage, MAX_MESSAGE_LEN};
use trommi_core::trail::*;
use trommi_core::Error;
use trommi_tests::content::Dice;
use trommi_tests::vectors::trail::NAME;
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

#[test]
fn steps_of_the_vectors_decode_and_encode() {
    let file = read(NAME).unwrap();
    for case in list(&file, "steps") {
        let step = WorkStep::decode(text(case, "step").as_bytes()).unwrap();
        assert_eq!(step.text, text(case, "text"));
        assert_eq!(step.tool.as_deref(), case["tool"].as_str());
        assert_eq!(step.encode().unwrap(), text(case, "step").as_bytes());
    }
    for case in list(&file, "steps_with_unknown_fields") {
        assert_eq!(
            WorkStep::decode(text(case, "step").as_bytes()).unwrap(),
            WorkStep::decode(text(case, "same_as").as_bytes()).unwrap()
        );
    }
    for case in list(&file, "steps_refused") {
        let result = WorkStep::decode(text(case, "step").as_bytes());
        assert_eq!(code(result), text(case, "code"), "{}", text(case, "why"));
    }
}

#[test]
fn pieces_of_the_vectors_decode_and_encode() {
    let file = read(NAME).unwrap();
    for case in list(&file, "pieces") {
        let piece = StrokePiece::decode(text(case, "piece").as_bytes()).unwrap();
        assert_eq!(hex(&piece.stroke), text(case, "stroke"));
        assert_eq!(u64::from(piece.number), case["number"].as_u64().unwrap());
        assert_eq!(i64::from(piece.width), case["width"].as_i64().unwrap());
        assert_eq!(
            piece.ink,
            Ink::unpack(&unhex(text(case, "packed")).unwrap()).unwrap()
        );
        assert_eq!(piece.encode().unwrap(), text(case, "piece").as_bytes());
    }
    for case in list(&file, "pieces_refused") {
        let result = StrokePiece::decode(text(case, "piece").as_bytes());
        assert_eq!(code(result), text(case, "code"), "{}", text(case, "why"));
    }
}

#[test]
fn limits_hold_on_both_sides_and_the_largest_body_fits_its_message() {
    let step = |text: String, tool: Option<String>| WorkStep { text, tool };
    assert_eq!(
        code(step("x".repeat(MAX_STEP_TEXT_LEN + 1), None).encode()),
        "bad-format"
    );
    assert_eq!(
        code(step("x".into(), Some(String::new())).encode()),
        "bad-format"
    );
    assert_eq!(
        code(step("x".into(), Some("t".repeat(MAX_TOOL_LEN + 1))).encode()),
        "bad-format"
    );
    // A text within its limit whose JSON is longer than a body may be: every byte needs six.
    assert_eq!(
        code(step("\u{1}".repeat(MAX_STEP_TEXT_LEN), None).encode()),
        "too-large"
    );
    let mut long = step("x".into(), None).encode().unwrap();
    long.resize(MAX_BODY_LEN + 1, b' ');
    assert_eq!(code(WorkStep::decode(&long)), "too-large");
    assert_eq!(code(StrokePiece::decode(&long)), "too-large");

    let largest = step(
        "x".repeat(MAX_STEP_TEXT_LEN),
        Some("t".repeat(MAX_TOOL_LEN)),
    );
    let message = TrommiMessage::WorkTrail {
        turn: TurnId::new([1; 16]),
        number: 1,
        time: 1,
        step: largest.encode().unwrap(),
    };
    let bytes = codec::encode(&message).unwrap();
    assert!(bytes.len() < MAX_MESSAGE_LEN - 2048);
    let TrommiMessage::WorkTrail { step: carried, .. } =
        codec::decode::<TrommiMessage>(&bytes, MAX_MESSAGE_LEN).unwrap()
    else {
        panic!("another message");
    };
    assert_eq!(WorkStep::decode(&carried).unwrap(), largest);

    let file = read(NAME).unwrap();
    let piece = text(&list(&file, "pieces")[0], "piece").as_bytes().to_vec();
    let message = TrommiMessage::StrokePiece {
        board: BoardId::ALL_DESKS,
        piece: piece.clone(),
    };
    let bytes = codec::encode(&message).unwrap();
    let TrommiMessage::StrokePiece { piece: carried, .. } =
        codec::decode::<TrommiMessage>(&bytes, MAX_MESSAGE_LEN).unwrap()
    else {
        panic!("another message");
    };
    assert_eq!(carried, piece);

    let printed = format!("{:?}", step("vertraulich".into(), None));
    assert!(!printed.contains("vertraulich"));
}

#[test]
fn no_bytes_make_a_reader_panic_and_what_is_read_is_written_the_same() {
    let mut dice = Dice(entropy("content trail fuzz").unwrap());
    let file = read(NAME).unwrap();
    let seeds: Vec<Vec<u8>> = [
        ("steps", "step"),
        ("steps_refused", "step"),
        ("pieces", "piece"),
        ("pieces_refused", "piece"),
    ]
    .iter()
    .flat_map(|(key, field)| {
        list(&file, key)
            .iter()
            .map(|case| text(case, field).as_bytes().to_vec())
    })
    .collect();
    for round in 0..40_000u32 {
        let mut bytes = if round % 8 == 0 {
            (0..dice.below(120).unwrap())
                .map(|_| dice.below(256).unwrap() as u8)
                .collect()
        } else {
            seeds[dice.below(seeds.len() as u64).unwrap() as usize].clone()
        };
        for _ in 0..dice.below(4).unwrap() {
            if bytes.is_empty() {
                break;
            }
            let at = dice.below(bytes.len() as u64).unwrap() as usize;
            match dice.below(3).unwrap() {
                0 => bytes[at] = dice.below(256).unwrap() as u8,
                1 => {
                    bytes.remove(at);
                }
                _ => bytes.insert(
                    at,
                    b"0123456789-[]{}\",:.e"[dice.below(20).unwrap() as usize],
                ),
            }
        }
        if let Ok(step) = WorkStep::decode(&bytes) {
            assert_eq!(WorkStep::decode(&step.encode().unwrap()).unwrap(), step);
        }
        if let Ok(piece) = StrokePiece::decode(&bytes) {
            assert_eq!(
                StrokePiece::decode(&piece.encode().unwrap()).unwrap(),
                piece
            );
        }
    }
}
