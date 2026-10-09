//! `spec/vectors/envelope.json`: a session's story as stored content, one envelope of every kind in full and
//! pruned form, and bytes that are no envelope (section 9).

use serde_json::{json, Value};
use trommi_core::envelope::Envelope;
use trommi_core::Error;

use super::{entropy, hex};
use crate::content::{story, Told, STORY_KEY};

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

/// Makes the file.
pub fn generate() -> Result<Value, Error> {
    let story = story(&mut entropy(NAME)?)?;
    let mut envelopes = Vec::new();
    for told in &story.told {
        let envelope = Envelope::decode(&told.bytes)?;
        envelopes.push(json!({
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
        }));
    }
    let first = story.told.first().ok_or(Error::Internal("empty story"))?;
    Ok(json!({
        "about": "Stored content (spec/v2.md section 9): a main session with one human and one agent device in epoch 0, and what they wrote, in the hub's order. Each envelope in full and in pruned form (hex), with its envelope_hash, its number and prev in the sender's chain, and the payload its body opens to under content_key. refused: changes of the first envelope with where they show (decode: the bytes are no envelope; verify: the signature fails) and the code.",
        "group_id": hex(story.group.as_bytes()),
        "content_key": hex(&STORY_KEY),
        "human": hex(story.human.as_bytes()),
        "agent": hex(story.agent.as_bytes()),
        "envelopes": envelopes,
        "refused": refused(first).iter().map(|(bytes, at, code, why)| json!({
            "bytes": hex(bytes), "at": at, "code": code, "why": why,
        })).collect::<Vec<_>>(),
    }))
}
