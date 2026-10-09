//! The terminal mirror: what the human types into Claude Code's terminal and the agent's final answer of a turn, put
//! into the session's board chat (README "The terminal mirror"). The plugin's hooks UserPromptSubmit and Stop run
//! `trommi-connector prompt` and `trommi-connector stop`; each hands one line to the connector of its own Claude Code
//! process through that connector's bell and ends at once. Here: what a hook takes from its input, what is never
//! mirrored, the levels, and the connector's queue (the turn's trail between the two: trail.rs). A text is never
//! logged and never written to disk by this module.
use crate::util::now_ms;
use crate::util::{hex, sha256};
use regex::Regex;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::Mutex;

/// The most a mirrored text weighs, in bytes of UTF-8 (an envelope's body is at most 64 KiB, a bell line too).
pub const MAX_BYTES: usize = 24_000;
pub const CUT_NOTE: &str = "\n\n… (cut here: the terminal has the rest)";
/// After a reply into the session's chat in the same turn, a final text shorter than this is terminal chatter.
pub const CHATTER_CHARS: usize = 200;
/// A hook waits this long for its connector, then gives up (the terminal never waits for the board).
pub const HOOK_MS: u64 = 2_000;
/// A text that could not be sent for this long is dropped.
pub const KEEP_MS: u64 = 600_000;
const QUEUE_MAX: usize = 50;
/// What stands in a mirrored prompt for a pasted picture the connector could not take along.
pub const PICTURE_MARK: &str = "(picture, only in the terminal)";
/// The most one pasted picture weighs, and the most pictures of one prompt that are taken along.
pub const PICTURE_MAX: u64 = 20 * 1024 * 1024;
pub const PICTURES_MAX: usize = 8;
/// The hooks of one event run twice when the plugin is installed in two scopes: the same prompt again within this
/// time is that, not the human typing the same words twice.
pub const TWICE_MS: u64 = 3_000;

/// How much of the terminal goes to the board (TROMMI_TERMINAL_MIRROR; read by the hooks and by the connector).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    /// `off` (or `0`, `false`, `no`): nothing.
    Off,
    /// `answers`: what the human types and the agent's final text of a turn.
    Answers,
    /// `steps` (the default, also for anything else): and the turn's trail: the agent's words between its steps and
    /// one line per step with the tool, its own description, a safe subject, its state and its time (trail.rs).
    Steps,
    /// `full`: and each step's input and an excerpt of its output, cut and redacted.
    Full,
}
pub fn level_of(v: &str) -> Level {
    match v.trim().to_lowercase().as_str() {
        "0" | "off" | "false" | "no" => Level::Off,
        "answers" => Level::Answers,
        "full" => Level::Full,
        _ => Level::Steps,
    }
}
pub fn level() -> Level {
    level_of(&std::env::var("TROMMI_TERMINAL_MIRROR").unwrap_or_default())
}
pub fn enabled() -> bool {
    level() > Level::Off
}

/// `text` cut to MAX_BYTES at a character, with a note that it was cut.
pub fn capped(text: &str) -> String {
    cut_to(text, MAX_BYTES)
}
fn cut_to(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max.saturating_sub(CUT_NOTE.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{CUT_NOTE}", text[..end].trim_end())
}
/// White space folded: what two texts are compared by.
pub fn folded(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// What the human typed, as it goes to the board, or None for a prompt that is not his typing: empty, a slash
/// command, and everything Claude Code submits by itself (a monitor line or a finished background task as
/// <task-notification>, a board event as <channel …>, another session's or a subagent's message, a reminder, the
/// record of a local command, the notice that a usage limit was reset). The marker lines Claude Code puts around
/// pasted text are taken out, the pasted text stays.
pub fn terminal_input(prompt: &str) -> Option<String> {
    let t = prompt.trim();
    if t.is_empty() {
        return None;
    }
    // a slash command (/clear, /mcp, /plugin:skill args), not a path (/home/me/x)
    if Regex::new(r"^/[A-Za-z][\w:.-]*(\s|$)").unwrap().is_match(t) {
        return None;
    }
    // a harness block at the start: <task-notification>, <channel …>, <system-reminder>, <local-command-stdout>, <bash-input>, …
    if Regex::new(r"^<(channel|event|tick|[a-z]+[-_][a-z_-]+)[\s>]")
        .unwrap()
        .is_match(t)
        && !t.starts_with("<pasted_content")
    {
        return None;
    }
    if [
        "<task-notification>",
        "<channel source=",
        "<agent-message ",
        "<teammate-message ",
        "<system-reminder>",
    ]
    .iter()
    .any(|m| t.contains(m))
    {
        return None;
    }
    if t.starts_with("Another Claude session sent a message:")
        || t.starts_with("Your claude.ai usage limit has reset.")
    {
        return None;
    }
    // the monitor's line (line.rs), however it arrives
    if Regex::new(r"(?m)^\s*Trommi · .* · call inbox\s*$")
        .unwrap()
        .is_match(t)
    {
        return None;
    }
    let own = Regex::new(r#"(?m)^</?pasted_content id="[^"\n]*">[ \t]*\n?"#)
        .unwrap()
        .replace_all(t, "");
    let own = own.trim();
    if own.is_empty() {
        return None;
    }
    Some(capped(own))
}

/// Where Claude Code keeps the pictures pasted into this session's prompts: `images/` beside the session's
/// `scratchpad_dir` (seen with 2.1.286: a picture pasted as "[Image #3]" is the file `images/3.png` there, written
/// when it is pasted; no hook input carries the picture or its path). None when the prompt names no picture.
pub fn pictures_dir(input: &Value) -> Option<String> {
    let prompt = input.get("prompt").and_then(|v| v.as_str())?;
    if !prompt.contains("[Image #") {
        return None;
    }
    let pad = std::path::Path::new(input.get("scratchpad_dir").and_then(|v| v.as_str())?);
    if !pad.is_absolute() {
        return None;
    }
    Some(pad.parent()?.join("images").to_str()?.to_string())
}
fn is_picture(head: &[u8]) -> bool {
    head.starts_with(b"\x89PNG\r\n\x1a\n")
        || head.starts_with(&[0xff, 0xd8, 0xff])
        || head.starts_with(b"GIF8")
        || (head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP")
}
/// The file of the pasted picture number `n` in `dir`, when it is one this session pasted: a plain file (no link)
/// named `<n>.png|jpg|jpeg|gif|webp` that starts like a picture, weighs at most PICTURE_MAX and was written at or
/// after `since` (the numbers start again with every Claude Code process, and older files stay: a file from before
/// is another picture).
fn picture_file(dir: &std::path::Path, n: &str, since: u64) -> Option<String> {
    let mut best: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
    for ext in ["png", "jpg", "jpeg", "gif", "webp"] {
        let f = dir.join(format!("{n}.{ext}"));
        let Ok(m) = std::fs::symlink_metadata(&f) else {
            continue;
        };
        let Ok(at) = m.modified() else { continue };
        let ms = at
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64);
        if !m.is_file() || m.len() == 0 || m.len() > PICTURE_MAX || ms + 1_000 < since {
            continue;
        }
        let mut head = [0u8; 12];
        let read = std::fs::File::open(&f)
            .and_then(|mut h| std::io::Read::read(&mut h, &mut head))
            .unwrap_or(0);
        if is_picture(&head[..read]) && best.as_ref().is_none_or(|(b, _)| at > *b) {
            best = Some((at, f));
        }
    }
    best.and_then(|(_, f)| f.to_str().map(String::from))
}
/// A prompt's pasted pictures: Claude Code puts "[Image #n]" into the text where one was pasted. Returns the text
/// without the marks of the pictures found in `dir` and those pictures' files, in the text's order; a picture that
/// is not found (no `dir`, no such file, one from before `since`, more than PICTURES_MAX) leaves PICTURE_MARK in
/// its place, never the raw mark.
pub fn pictures(text: &str, dir: Option<&str>, since: u64) -> (String, Vec<String>) {
    let mark = Regex::new(r"\[Image #(\d{1,6})\]").unwrap();
    if !mark.is_match(text) {
        return (text.to_string(), vec![]);
    }
    let mut files: Vec<String> = vec![];
    let out = mark.replace_all(text, |m: &regex::Captures| {
        let found = dir
            .filter(|d| std::path::Path::new(d).is_absolute())
            .and_then(|d| picture_file(std::path::Path::new(d), &m[1], since));
        match found {
            Some(f) if files.contains(&f) => String::new(),
            Some(f) if files.len() < PICTURES_MAX => {
                files.push(f);
                String::new()
            }
            _ => PICTURE_MARK.to_string(),
        }
    });
    // (what a taken mark leaves: a space at a line's start or end, two in a row)
    let lines: Vec<String> = out
        .lines()
        .map(|l| {
            l.split(' ')
                .filter(|w| !w.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect();
    (
        if files.is_empty() {
            out.trim().to_string()
        } else {
            lines.join("\n").trim().to_string()
        },
        files,
    )
}

/// The text of the agent's last message in a transcript (Claude Code's JSONL): the text blocks of the assistant
/// records after the last thing the human or the harness said, of the last message among them; no thinking, no tool
/// calls, no subagent's lines. Only for a Stop input without `last_assistant_message`.
pub fn transcript_answer(jsonl: &str) -> Option<String> {
    let mut last_id: Option<String> = None;
    let mut parts: Vec<String> = vec![];
    for line in jsonl.lines() {
        let Ok(r) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if r.get("isSidechain") == Some(&Value::Bool(true)) {
            continue;
        }
        let content = r.get("message").and_then(|m| m.get("content"));
        match r.get("type").and_then(|v| v.as_str()) {
            Some("user") => {
                // a new turn starts with words, not with a tool's result
                let result = content.and_then(|c| c.as_array()).is_some_and(|a| {
                    a.iter()
                        .any(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result"))
                });
                if !result {
                    last_id = None;
                    parts.clear();
                }
            }
            Some("assistant") => {
                let id = r
                    .get("message")
                    .and_then(|m| m.get("id"))
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let texts: Vec<String> = match content {
                    Some(Value::String(s)) => vec![s.clone()],
                    Some(Value::Array(a)) => a
                        .iter()
                        .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                        .filter_map(|b| b.get("text").and_then(|t| t.as_str()).map(String::from))
                        .collect(),
                    _ => vec![],
                };
                if id != last_id || id.is_none() {
                    parts.clear();
                    last_id = id;
                }
                parts.extend(texts);
            }
            _ => {}
        }
    }
    let text = parts.join("\n\n");
    let text = text.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

/// The agent's final answer of a turn from a Stop hook's input: `last_assistant_message`, else read from
/// `transcript_path`. None inside a subagent (`agent_id`) and for a turn that ended without words.
pub fn final_answer(input: &Value) -> Option<String> {
    if input.get("agent_id").is_some_and(|v| !v.is_null()) {
        return None;
    }
    let said = match input.get("last_assistant_message") {
        Some(Value::String(s)) => Some(s.clone()),
        _ => input
            .get("transcript_path")
            .and_then(|v| v.as_str())
            .and_then(read_transcript)
            .and_then(|t| transcript_answer(&t)),
    }?;
    let said = said.trim();
    if said.is_empty() {
        None
    } else {
        Some(capped(said))
    }
}
fn read_transcript(path: &str) -> Option<String> {
    let p = match path.strip_prefix("~/") {
        Some(rest) => std::path::PathBuf::from(std::env::var("HOME").ok()?).join(rest),
        None => std::path::PathBuf::from(path),
    };
    // (the end is enough: one turn's last message)
    let bytes = std::fs::read(p).ok()?;
    let from = bytes.len().saturating_sub(2 * 1024 * 1024);
    Some(String::from_utf8_lossy(&bytes[from..]).into_owned())
}

/// The line a hook hands its connector, or None when this hook has nothing to say. `kind`: "prompt" or "stop".
/// A prompt that is not mirrored still goes as a line without text: it starts a turn (the replies of the turn before
/// are forgotten).
pub fn hook_request(kind: &str, input: &Value, ancestors: &[u32]) -> Option<Value> {
    // (agent_id: the hook fired inside a subagent; its turns are not the terminal's conversation)
    if !input.is_object() || !enabled() || input.get("agent_id").is_some_and(|v| !v.is_null()) {
        return None;
    }
    let prompt_id = input
        .get("prompt_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let (what, mut text) = match kind {
        "prompt" => (
            "input",
            input
                .get("prompt")
                .and_then(|v| v.as_str())
                .and_then(terminal_input),
        ),
        "stop" => ("answer", final_answer(input)),
        _ => return None,
    };
    let pictures = if kind == "prompt" && text.is_some() {
        pictures_dir(input)
    } else {
        None
    };
    // What comes beside the text is bounded, so that cutting the text always gets the line under its limit.
    let prompt_id: String = prompt_id.chars().take(200).collect();
    let pictures = pictures.filter(|dir| dir.len() <= 4096);
    loop {
        let mut r = json!({ "op": "terminal", "kind": what, "text": text, "prompt_id": prompt_id, "ancestors": ancestors });
        if let Some(d) = &pictures {
            r["pictures_dir"] = json!(d);
        }
        // (a door reads at most 64 KiB; a text full of characters JSON escapes can pass it)
        let size = r.to_string().len();
        if size <= 60_000 {
            return Some(r);
        }
        let t = text.take().unwrap_or_default();
        if t.is_empty() {
            return None;
        }
        text = Some(cut_to(&t, t.len() / 2));
    }
}

/// Whether the agent's final text of a turn is left out because it already wrote into the session's chat with
/// `reply` in that turn: the text is one of those replies, or part of one, or holds one (white space aside), or it is
/// shorter than CHATTER_CHARS ("Sent.", "Done, see the board."). A turn without such a reply is always mirrored.
pub fn already_said(answer: &str, replies: &[String]) -> bool {
    if replies.is_empty() {
        return false;
    }
    let a = folded(answer);
    if a.chars().count() < CHATTER_CHARS {
        return true;
    }
    replies
        .iter()
        .any(|r| !r.is_empty() && (r.contains(&a) || a.contains(r.as_str())))
}

pub struct Item {
    /// "input", "answer", or "work": an envelope of the turn's trail (trail.rs).
    pub kind: &'static str,
    pub text: String,
    pub at: u64,
    pub work: Option<crate::trail::Envelope>,
    /// An input's pasted pictures: files to send with it as attachments.
    pub pictures: Vec<String>,
}
struct State {
    replies: Vec<String>,
    queue: VecDeque<Item>,
    recent: VecDeque<(String, u64)>,
}
/// The connector's side: what waits to be sent, in the order the terminal said it, and the replies of the turn.
pub struct Mirror {
    st: Mutex<State>,
    /// One sender at a time, so the order holds.
    pub sending: tokio::sync::Mutex<()>,
    /// When this connector started: a pasted picture written before that is not this session's.
    pub since: u64,
}
impl Default for Mirror {
    fn default() -> Self {
        Mirror {
            st: Mutex::new(State {
                replies: vec![],
                queue: VecDeque::new(),
                recent: VecDeque::new(),
            }),
            sending: tokio::sync::Mutex::new(()),
            since: now_ms(),
        }
    }
}
impl Mirror {
    /// The agent wrote into its session's chat with `reply` (no card, no child session).
    pub fn replied(&self, text: &str) {
        let mut st = self.st.lock().unwrap();
        st.replies.push(folded(text));
        if st.replies.len() > 40 {
            st.replies.remove(0);
        }
    }
    /// A hook's line: `{ ok, queued }`, and `why` when nothing was queued. Never an error the hook would show.
    /// `same_turn`: a prompt typed while a turn runs, which Claude Code takes into that turn (trail.rs `prompt`).
    pub fn accept(&self, req: &Value, same_turn: bool) -> Value {
        if !enabled() {
            return json!({ "ok": true, "queued": false, "why": "off" });
        }
        let kind = match req.get("kind").and_then(|v| v.as_str()) {
            Some("input") => "input",
            Some("answer") => "answer",
            _ => return json!({ "ok": false, "error": "unknown request" }),
        };
        let said = req
            .get("text")
            .and_then(|v| v.as_str())
            .map(|t| capped(t.trim()))
            .filter(|t| !t.is_empty());
        let mut st = self.st.lock().unwrap();
        // a prompt starts a turn and a stop ends one: either way the replies so far belong to the turn that is over
        // (not a prompt that comes into the running turn)
        let replies = if kind == "input" && same_turn {
            vec![]
        } else {
            std::mem::take(&mut st.replies)
        };
        let Some(said) = said else {
            return json!({ "ok": true, "queued": false, "why": "nothing to mirror" });
        };
        let (text, pictures) = if kind == "input" {
            pictures(
                &said,
                req.get("pictures_dir").and_then(|v| v.as_str()),
                self.since,
            )
        } else {
            (said.clone(), vec![])
        };
        if kind == "answer" && already_said(&text, &replies) {
            return json!({ "ok": true, "queued": false, "why": "already said with reply" });
        }
        // the same line twice (the plugin installed in two scopes runs each hook twice)
        // (an answer once per turn; a prompt may be typed twice into one turn, which has one prompt_id)
        let (mark, now) = (
            format!(
                "{kind}|{}|{}",
                req.get("prompt_id").and_then(|v| v.as_str()).unwrap_or(""),
                hex(&sha256(said.as_bytes()))
            ),
            now_ms(),
        );
        if st
            .recent
            .iter()
            .any(|(m, at)| *m == mark && (kind == "answer" || now.saturating_sub(*at) < TWICE_MS))
        {
            return json!({ "ok": true, "queued": false, "why": "said before" });
        }
        st.recent.push_back((mark, now));
        if st.recent.len() > 16 {
            st.recent.pop_front();
        }
        if st.queue.len() >= QUEUE_MAX {
            st.queue.pop_front();
        }
        let n = pictures.len();
        st.queue.push_back(Item {
            kind,
            text,
            at: now,
            work: None,
            pictures,
        });
        json!({ "ok": true, "queued": true, "pictures": n })
    }
    /// An envelope of a trail, behind what waits already.
    pub fn push_work(&self, e: crate::trail::Envelope) {
        let mut st = self.st.lock().unwrap();
        if st.queue.len() >= QUEUE_MAX {
            st.queue.pop_front();
        }
        st.queue.push_back(Item {
            kind: "work",
            text: String::new(),
            at: now_ms(),
            work: Some(e),
            pictures: vec![],
        });
    }
    /// The next text to send; what waited longer than KEEP_MS is dropped.
    pub fn next(&self) -> Option<Item> {
        let mut st = self.st.lock().unwrap();
        while let Some(i) = st.queue.pop_front() {
            if now_ms().saturating_sub(i.at) <= KEEP_MS {
                return Some(i);
            }
        }
        None
    }
    pub fn back(&self, item: Item) {
        self.st.lock().unwrap().queue.push_front(item);
    }
    pub fn waiting(&self) -> usize {
        self.st.lock().unwrap().queue.len()
    }
    /// Everything that waits is given up; how many.
    pub fn drop_all(&self) -> usize {
        let mut st = self.st.lock().unwrap();
        let n = st.queue.len();
        st.queue.clear();
        n
    }
}
