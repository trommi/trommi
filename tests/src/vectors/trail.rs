//! `spec/vectors/trail.json`: the bodies of the two live messages, a work trail's step and a piece of a stroke
//! in progress, and what a reader refuses (sections 7.2 and 7.3).

use serde_json::{json, Value};
use trommi_core::board_items::Pen;
use trommi_core::trail::{StrokePiece, WorkStep};
use trommi_core::Error;

use super::{entropy, hex};
use crate::content::{ink, Dice};

/// The name of the file.
pub const NAME: &str = "trail";

fn text(bytes: Vec<u8>) -> Result<String, Error> {
    String::from_utf8(bytes).map_err(|_| Error::Internal("vector text"))
}

fn piece() -> Value {
    json!({ "stroke": "AAECAwQFBgcICQoLDA0ODw", "number": 2, "tool": "pen", "color": "ink", "width": 64,
        "points": "AYAsgDEwHyWSwAE_BBomkg" })
}

fn with(mut value: Value, key: &str, to: Value) -> String {
    value[key] = to;
    value.to_string()
}

/// Steps no reader takes, each with its code and the reason.
pub fn refused_steps() -> Vec<(String, &'static str, &'static str)> {
    let bad = "bad-format";
    vec![
        ("text".to_owned(), bad, "no JSON"),
        (json!("text").to_string(), bad, "no object"),
        (json!({ "tool": "Bash" }).to_string(), bad, "no text"),
        (
            json!({ "text": 1 }).to_string(),
            bad,
            "a text that is a number",
        ),
        (
            json!({ "text": "x", "tool": "" }).to_string(),
            bad,
            "an empty tool",
        ),
        (
            json!({ "text": "x", "tool": "t".repeat(81) }).to_string(),
            bad,
            "a tool of 81 bytes",
        ),
        (r#"{"text":"a","text":"b"}"#.to_owned(), bad, "text twice"),
        (
            json!({ "text": "x", "tool": null }).to_string(),
            bad,
            "a tool set to null",
        ),
    ]
}

/// Pieces no reader takes, each with its code and the reason.
pub fn refused_pieces() -> Vec<(String, &'static str, &'static str)> {
    let bad = "bad-format";
    vec![
        (
            with(piece(), "stroke", json!("AAECAwQFBgcICQoLDA0O")),
            bad,
            "a stroke id of 15 bytes",
        ),
        (with(piece(), "number", json!(0)), bad, "number 0"),
        (
            with(piece(), "number", json!(4_294_967_296u64)),
            bad,
            "a number beyond 32 bits",
        ),
        (
            with(piece(), "tool", json!("sticky")),
            bad,
            "a tool that draws no stroke",
        ),
        (with(piece(), "color", json!("")), bad, "an empty colour"),
        (with(piece(), "width", json!(0)), bad, "width 0"),
        (
            with(piece(), "width", json!(64.5)),
            bad,
            "a width with a fraction",
        ),
        (with(piece(), "points", json!("AA")), bad, "no point"),
        (with(piece(), "points", Value::Null), bad, "no points"),
    ]
}

/// Makes the file.
pub fn generate() -> Result<Value, Error> {
    let mut dice = Dice(entropy(NAME)?);
    let steps = [
        WorkStep {
            text: "Reading spec/v2.md".to_owned(),
            tool: Some("Read".to_owned()),
        },
        WorkStep {
            text: "Zwei Tests schlagen fehl:\n\t\"merge\" und „snapshot“".to_owned(),
            tool: None,
        },
        WorkStep {
            text: String::new(),
            tool: Some("Bash".to_owned()),
        },
    ];
    let mut pieces = Vec::new();
    for number in 1..=3u32 {
        let piece = StrokePiece {
            stroke: dice.bytes()?,
            number,
            pen: if number == 2 { Pen::Marker } else { Pen::Pen },
            color: "ink".to_owned(),
            width: 16 * number as i32 + 1,
            ink: ink(&mut dice)?,
        };
        pieces.push(json!({
            "piece": text(piece.encode()?)?,
            "stroke": hex(&piece.stroke),
            "number": piece.number,
            "width": piece.width,
            "packed": hex(&piece.ink.pack()),
        }));
    }
    let refused = |list: Vec<(String, &'static str, &'static str)>, key: &str| {
        list.into_iter()
            .map(|(body, code, why)| json!({ key: body, "code": code, "why": why }))
            .collect::<Vec<_>>()
    };
    Ok(json!({
        "about": "The bodies of the live messages (spec/v2.md sections 7.2 and 7.3). steps: the step of a work trail message and what it holds. pieces: the piece of a stroke piece message; stroke and packed in hex, width in 1/16 board unit. A reader that decodes and encodes one gets the same text. steps_refused, pieces_refused: with the code of the refusal.",
        "steps": steps.iter().map(|step| Ok(json!({
            "step": text(step.encode()?)?, "text": step.text, "tool": step.tool,
        }))).collect::<Result<Vec<_>, Error>>()?,
        "steps_with_unknown_fields": [{
            "step": json!({ "text": "x", "state": "running" }).to_string(),
            "same_as": json!({ "text": "x" }).to_string(),
        }],
        "steps_refused": refused(refused_steps(), "step"),
        "pieces": pieces,
        "pieces_refused": refused(refused_pieces(), "piece"),
    }))
}
