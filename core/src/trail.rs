//! The bodies of the two live messages (sections 7.2 and 7.3): one step of an agent's work trail, and one piece
//! of a stroke still being drawn. Both travel as the `step` or `piece` of a `TrommiMessage`
//! ([`crate::mls::message`]) inside an MLS application message and are never stored content. This module reads
//! and writes those two fields; sending, and who may send which in which group, is the device's.
//!
//! Both are JSON. A reader ignores fields it does not know and refuses a known field of the wrong form.

use crate::board_items::{Ink, Pen, Units, MAX_COLOR_LEN, MAX_WIDTH};
use crate::error::Error;
use crate::ids;
use serde::{Deserialize, Serialize};
use std::fmt;

/// The most bytes of a step or a piece as JSON, so that its message stays below the 48 KiB of section 7.0.
pub const MAX_BODY_LEN: usize = 40_000;
/// The most bytes of a step's text.
pub const MAX_STEP_TEXT_LEN: usize = 30_000;
/// The most bytes of a tool's name.
pub const MAX_TOOL_LEN: usize = 80;

fn to_json(value: &impl Serialize) -> Result<Vec<u8>, Error> {
    let bytes = serde_json::to_vec(value).map_err(|_| Error::Internal("trail json"))?;
    if bytes.len() > MAX_BODY_LEN {
        return Err(Error::TooLarge);
    }
    Ok(bytes)
}

fn from_json<'a, T: Deserialize<'a>>(bytes: &'a [u8]) -> Result<T, Error> {
    if bytes.len() > MAX_BODY_LEN {
        return Err(Error::TooLarge);
    }
    serde_json::from_slice(bytes).map_err(|_| Error::BadFormat)
}

/// One step of an agent's running turn (7.3): `{ text, tool? }`.
#[derive(Clone, PartialEq, Eq)]
pub struct WorkStep {
    /// What the agent did or said, at most [`MAX_STEP_TEXT_LEN`] bytes.
    pub text: String,
    /// The tool it used, if the step is a tool's: 1 to [`MAX_TOOL_LEN`] bytes.
    pub tool: Option<String>,
}

impl fmt::Debug for WorkStep {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "WorkStep({} bytes)", self.text.len())
    }
}

#[derive(Serialize)]
struct StepOut<'a> {
    text: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool: Option<&'a str>,
}

#[derive(Deserialize)]
struct StepIn {
    text: String,
    tool: Option<String>,
}

impl WorkStep {
    fn check(&self) -> Result<(), Error> {
        let tool_ok = self
            .tool
            .as_deref()
            .is_none_or(|tool| !tool.is_empty() && tool.len() <= MAX_TOOL_LEN);
        if self.text.len() > MAX_STEP_TEXT_LEN || !tool_ok {
            return Err(Error::BadFormat);
        }
        Ok(())
    }

    /// The `step` of a work trail message. `bad-format` for a text or tool name beyond its limit, `too-large`
    /// above [`MAX_BODY_LEN`] bytes.
    pub fn encode(&self) -> Result<Vec<u8>, Error> {
        self.check()?;
        to_json(&StepOut {
            text: &self.text,
            tool: self.tool.as_deref(),
        })
    }

    /// The step a work trail message carries; `too-large` above [`MAX_BODY_LEN`] bytes, `bad-format` for
    /// anything else that [`WorkStep::encode`] would not have written, unknown fields aside.
    pub fn decode(step: &[u8]) -> Result<Self, Error> {
        let StepIn { text, tool } = from_json(step)?;
        let step = Self { text, tool };
        step.check()?;
        Ok(step)
    }
}

/// One piece of a stroke still being drawn (7.2): the points added since the piece before, and how the stroke
/// looks, so that a receiver that missed a piece can still draw the rest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StrokePiece {
    /// The stroke in progress: 16 random bytes its drawer chose. The finished stroke names it in `live`.
    pub stroke: [u8; 16],
    /// The piece's number within the stroke, from 1: a receiver sees which it missed.
    pub number: u32,
    /// What draws it.
    pub pen: Pen,
    /// The colour's name in the app's palette.
    pub color: String,
    /// The width in quanta, 1 to [`MAX_WIDTH`].
    pub width: i32,
    /// The new points. The first stands where it is on the board, and its time counts from the stroke's
    /// beginning, in every piece.
    pub ink: Ink,
}

#[derive(Serialize)]
struct PieceOut<'a> {
    stroke: String,
    number: u32,
    tool: &'static str,
    color: &'a str,
    width: Units,
    points: String,
}

#[derive(Deserialize)]
struct PieceIn {
    stroke: String,
    number: u32,
    tool: String,
    color: String,
    width: Units,
    points: String,
}

impl StrokePiece {
    fn check(&self) -> Result<(), Error> {
        let ok = self.number > 0
            && !self.color.is_empty()
            && self.color.len() <= MAX_COLOR_LEN
            && (1..=MAX_WIDTH).contains(&self.width);
        if ok {
            Ok(())
        } else {
            Err(Error::BadFormat)
        }
    }

    /// The `piece` of a stroke piece message. `bad-format` for number 0 or a colour or width outside its
    /// limits, `too-large` above [`MAX_BODY_LEN`] bytes.
    pub fn encode(&self) -> Result<Vec<u8>, Error> {
        self.check()?;
        to_json(&PieceOut {
            stroke: ids::base64url_encode(&self.stroke),
            number: self.number,
            tool: match self.pen {
                Pen::Pen => "pen",
                Pen::Marker => "marker",
            },
            color: &self.color,
            width: Units(self.width),
            points: self.ink.to_base64url(),
        })
    }

    /// The piece a stroke piece message carries; `too-large` above [`MAX_BODY_LEN`] bytes, `bad-format` for
    /// anything else that [`StrokePiece::encode`] would not have written, unknown fields aside.
    pub fn decode(piece: &[u8]) -> Result<Self, Error> {
        let wire: PieceIn = from_json(piece)?;
        let piece = Self {
            stroke: ids::base64url_decode(&wire.stroke)?
                .try_into()
                .map_err(|_| Error::BadFormat)?,
            number: wire.number,
            pen: match wire.tool.as_str() {
                "pen" => Pen::Pen,
                "marker" => Pen::Marker,
                _ => return Err(Error::BadFormat),
            },
            color: wire.color,
            width: wire.width.0,
            ink: Ink::from_base64url(&wire.points)?,
        };
        piece.check()?;
        Ok(piece)
    }
}
