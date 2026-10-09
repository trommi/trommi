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
const TWICE_MS: u64 = 3_000;

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
    since: u64,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_typed_prompt_is_mirrored_as_it_is() {
        assert_eq!(
            terminal_input("  wie läufts?\n").as_deref(),
            Some("wie läufts?")
        );
        assert_eq!(
            terminal_input("/home/me/x.rs is broken").as_deref(),
            Some("/home/me/x.rs is broken")
        );
        assert_eq!(
            terminal_input("<div> is not closed in index.html").as_deref(),
            Some("<div> is not closed in index.html")
        );
        assert_eq!(
            terminal_input("# Plan\n\n- **one**\n- two").as_deref(),
            Some("# Plan\n\n- **one**\n- two")
        );
    }

    #[test]
    fn pasted_text_stays_and_its_marker_lines_go() {
        let p = "<pasted_content id=\"92bd\">\nline one\nline two\n</pasted_content id=\"92bd\">\n\n what about this?";
        assert_eq!(
            terminal_input(p).as_deref(),
            Some("line one\nline two\n\n what about this?")
        );
    }

    #[test]
    fn what_claude_code_submits_by_itself_is_not_his_input() {
        let monitor = "<task-notification>\n<task-id>bfx52ap4v</task-id>\n<summary>Monitor event: \"Trommi board events\"</summary>\n<event>Trommi · The human wrote on the board: \"Oh shit\" · call inbox</event>\n</task-notification>";
        for p in [
            monitor,
            "<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<summary>Agent \"Design\" finished</summary>\n</task-notification>",
            "<channel source=\"trommi\" kind=\"chat\">\nPlease check the logs first.\n</channel>",
            "<channel source=\"board\" kind=\"decision\" card_id=\"ab\" choice=\"live\">\nDecision on \"x\": live\n</channel>",
            "Another Claude session sent a message:\n<agent-message from=\"afdd\">\n[Subagent hand-back] The text below …\n</agent-message>",
            "<system-reminder>\nsomething\n</system-reminder>",
            "<local-command-stdout>Reconnected to trommi.</local-command-stdout>",
            "<command-name>/mcp</command-name>\n<command-message>mcp</command-message>",
            "<bash-input> git status</bash-input>",
            "Trommi · The human answered \"Jetzt live?\": \"Ja, live\" · call inbox",
            "Trommi · Design · The human wrote on the board: \"so\" [2 pictures] · call inbox\n",
            "Your claude.ai usage limit has reset. Continue the task you were working on when the limit was reached.",
            "/clear",
            "/mcp",
            "/trommi:clip card 12",
            "   ",
            "",
        ] {
            assert_eq!(terminal_input(p), None, "{p}");
        }
    }

    #[test]
    fn a_pasted_picture_goes_along_or_leaves_a_neutral_mark() {
        let dir = std::env::temp_dir().join(format!(
            "trommi-pictures-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let images = dir.join("images");
        std::fs::create_dir_all(&images).unwrap();
        let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
        std::fs::write(images.join("1.png"), png).unwrap();
        std::fs::write(images.join("2.jpg"), [0xff, 0xd8, 0xff, 0xe0, 0, 0]).unwrap();
        std::fs::write(images.join("3.png"), b"not a picture at all").unwrap();
        std::fs::write(images.join("5.png"), b"").unwrap();
        std::os::unix::fs::symlink(images.join("1.png"), images.join("6.png")).unwrap();
        let d = images.to_str().unwrap();
        let file = |n: &str| images.join(n).to_str().unwrap().to_string();
        // as Claude Code 2.1.286 submits a pasted picture: the mark in the text, the session's scratchpad beside
        let ups = json!({ "hook_event_name": "UserPromptSubmit", "prompt_id": "cf77", "scratchpad_dir": dir.join("scratchpad").to_str().unwrap(), "prompt": "[Image #1] what is in this picture?" });
        assert_eq!(pictures_dir(&ups).as_deref(), Some(d));
        assert_eq!(
            hook_request("prompt", &ups, &[7]).unwrap()["pictures_dir"],
            json!(d)
        );
        assert!(hook_request(
            "prompt",
            &json!({ "prompt": "no picture", "scratchpad_dir": "/tmp/x/scratchpad" }),
            &[7]
        )
        .unwrap()
        .get("pictures_dir")
        .is_none());
        assert_eq!(
            pictures_dir(&json!({ "prompt": "[Image #1]" })),
            None,
            "no scratchpad_dir: no place to look"
        );
        assert_eq!(
            pictures_dir(
                &json!({ "prompt": "[Image #1]", "scratchpad_dir": "relative/scratchpad" })
            ),
            None
        );
        // found: the mark goes, the file comes
        assert_eq!(
            pictures("[Image #1] what is in this picture?", Some(d), 0),
            ("what is in this picture?".to_string(), vec![file("1.png")])
        );
        assert_eq!(
            pictures("[Image #1]", Some(d), 0),
            (String::new(), vec![file("1.png")])
        );
        assert_eq!(
            pictures(
                "compare [Image #1] with [Image #2]\nand [Image #1] again",
                Some(d),
                0
            ),
            (
                "compare with\nand again".to_string(),
                vec![file("1.png"), file("2.jpg")]
            )
        );
        // not found: no raw mark, a neutral one (no folder, no file, not a picture, empty, a link, an older file)
        assert_eq!(
            pictures("[Image #1]", None, 0),
            (PICTURE_MARK.to_string(), vec![])
        );
        assert_eq!(
            pictures("[Image #1] look", Some("relative/images"), 0),
            (format!("{PICTURE_MARK} look"), vec![])
        );
        for n in [3, 4, 5, 6] {
            assert_eq!(
                pictures(&format!("see [Image #{n}]"), Some(d), 0),
                (format!("see {PICTURE_MARK}"), vec![]),
                "{n}"
            );
        }
        assert_eq!(
            pictures("[Image #1]", Some(d), now_ms() + 60_000),
            (PICTURE_MARK.to_string(), vec![]),
            "a file from before this connector started is another picture"
        );
        assert_eq!(
            pictures("[Image #1] and [Image #4]", Some(d), 0),
            (format!("and {PICTURE_MARK}"), vec![file("1.png")])
        );
        assert_eq!(
            pictures("plain words  with two spaces", Some(d), 0),
            ("plain words  with two spaces".to_string(), vec![]),
            "a text without a mark stays as it is"
        );
        // the queue: the picture rides with his message, also when he typed nothing beside it
        let m = Mirror::default();
        {
            // (this connector started before the files were written)
            let since = m.since;
            assert!(since + 5_000 > now_ms());
        }
        let m = Mirror {
            since: 0,
            ..Mirror::default()
        };
        let a = m.accept(&json!({ "op": "terminal", "kind": "input", "text": "[Image #1]", "prompt_id": "p1", "pictures_dir": d }), false);
        assert_eq!(
            (a["queued"].clone(), a["pictures"].clone()),
            (json!(true), json!(1))
        );
        let i = m.next().unwrap();
        assert_eq!(
            (i.kind, i.text.as_str(), i.pictures),
            ("input", "", vec![file("1.png")])
        );
        assert_eq!(m.accept(&json!({ "op": "terminal", "kind": "input", "text": "[Image #9] hm", "prompt_id": "p2", "pictures_dir": d }), false)["pictures"], json!(0));
        assert_eq!(m.next().unwrap().text, format!("{PICTURE_MARK} hm"));
        assert_eq!(m.accept(&json!({ "op": "terminal", "kind": "answer", "text": "I see [Image #1].", "prompt_id": "p2", "pictures_dir": d }), false)["queued"], json!(true));
        let i = m.next().unwrap();
        assert_eq!(
            (i.text.as_str(), i.pictures.len()),
            ("I see [Image #1].", 0),
            "only his prompt has pictures"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_levels() {
        for (v, l) in [
            ("", Level::Steps),
            ("steps", Level::Steps),
            ("on", Level::Steps),
            ("1", Level::Steps),
            ("off", Level::Off),
            (" OFF ", Level::Off),
            ("0", Level::Off),
            ("false", Level::Off),
            ("no", Level::Off),
            ("answers", Level::Answers),
            ("Full", Level::Full),
        ] {
            assert_eq!(level_of(v), l, "{v}");
        }
        assert!(
            Level::Off < Level::Answers
                && Level::Answers < Level::Steps
                && Level::Steps < Level::Full
        );
    }

    #[test]
    fn a_long_text_is_cut_at_a_character() {
        let long = "ä".repeat(20_000);
        let c = capped(&long);
        assert!(c.len() <= MAX_BYTES && c.ends_with(CUT_NOTE) && c.starts_with("ää"));
        assert_eq!(capped("short"), "short");
    }

    #[test]
    fn the_hook_reads_claude_codes_input() {
        // as Claude Code 2.1.286 sends them
        let ups = json!({ "session_id": "a3f1", "transcript_path": "/home/me/.claude/projects/p/a3f1.jsonl", "cwd": "/home/me/p", "prompt_id": "c771", "permission_mode": "default", "hook_event_name": "UserPromptSubmit", "prompt": "Reply with exactly: **ok** done" });
        let r = hook_request("prompt", &ups, &[7, 8]).unwrap();
        assert_eq!(
            r,
            json!({ "op": "terminal", "kind": "input", "text": "Reply with exactly: **ok** done", "prompt_id": "c771", "ancestors": [7, 8] })
        );
        let stop = json!({ "session_id": "a3f1", "transcript_path": "/nowhere.jsonl", "cwd": "/home/me/p", "prompt_id": "c771", "permission_mode": "default", "hook_event_name": "Stop", "stop_hook_active": false, "last_assistant_message": "**ok** done\n", "background_tasks": [], "session_crons": [] });
        let r = hook_request("stop", &stop, &[7]).unwrap();
        assert_eq!(
            (r["kind"].as_str(), r["text"].as_str()),
            (Some("answer"), Some("**ok** done"))
        );
        // a prompt that is not his typing still starts a turn, without a text
        let r = hook_request(
            "prompt",
            &json!({ "prompt": "/clear", "prompt_id": "p2" }),
            &[7],
        )
        .unwrap();
        assert_eq!(
            (r["kind"].as_str(), r["text"].is_null()),
            (Some("input"), true)
        );
        // inside a subagent, and broken input: nothing
        assert!(hook_request("stop", &json!({ "agent_id": "def456", "agent_type": "Explore", "last_assistant_message": "Found 3 issues" }), &[7]).is_none());
        assert!(hook_request(
            "prompt",
            &json!({ "agent_id": "def456", "prompt": "hello" }),
            &[7]
        )
        .is_none());
        assert!(hook_request("prompt", &Value::Null, &[7]).is_none());
        assert!(hook_request("other", &ups, &[7]).is_none());
    }

    #[test]
    fn a_line_for_the_bell_stays_under_its_limit() {
        let ups = json!({ "prompt": "\u{1}".repeat(MAX_BYTES), "prompt_id": "p" });
        let r = hook_request("prompt", &ups, &[1]).unwrap();
        assert!(r.to_string().len() <= 60_000 && r["text"].as_str().unwrap().ends_with(CUT_NOTE));
    }

    #[test]
    fn the_final_answer_comes_from_the_transcript_when_the_input_has_none() {
        let lines = [
            json!({ "type": "user", "message": { "role": "user", "content": "first question" } }),
            json!({ "type": "assistant", "message": { "id": "m1", "content": [{ "type": "text", "text": "an old answer" }] } }),
            json!({ "type": "user", "message": { "role": "user", "content": [{ "type": "text", "text": "second question" }] } }),
            json!({ "type": "assistant", "message": { "id": "m2", "content": [{ "type": "thinking", "thinking": "secret thoughts" }] } }),
            json!({ "type": "assistant", "message": { "id": "m2", "content": [{ "type": "text", "text": "Let me look." }] } }),
            json!({ "type": "assistant", "message": { "id": "m2", "content": [{ "type": "tool_use", "id": "t1", "name": "Bash", "input": { "command": "ls" } }] } }),
            json!({ "type": "user", "message": { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": "a b" }] } }),
            json!({ "type": "assistant", "isSidechain": true, "message": { "id": "s1", "content": [{ "type": "text", "text": "a subagent's line" }] } }),
            json!({ "type": "assistant", "message": { "id": "m3", "content": [{ "type": "thinking", "thinking": "more thoughts" }] } }),
            json!({ "type": "assistant", "message": { "id": "m3", "content": [{ "type": "text", "text": "Two files: **a** and b." }] } }),
            json!({ "type": "assistant", "message": { "id": "m3", "content": [{ "type": "text", "text": "Nothing else." }] } }),
            json!({ "type": "system", "subtype": "stop_hook_summary" }),
        ];
        let jsonl = lines
            .iter()
            .map(|l| l.to_string())
            .collect::<Vec<_>>()
            .join("\n")
            + "\nnot json\n";
        assert_eq!(
            transcript_answer(&jsonl).as_deref(),
            Some("Two files: **a** and b.\n\nNothing else.")
        );
        assert_eq!(
            transcript_answer(
                &lines[..3]
                    .iter()
                    .map(|l| l.to_string())
                    .collect::<Vec<_>>()
                    .join("\n")
            ),
            None,
            "the turn has no answer yet"
        );
        let dir = std::env::temp_dir().join(format!("trommi-mirror-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("t.jsonl");
        std::fs::write(&f, &jsonl).unwrap();
        let got = final_answer(
            &json!({ "hook_event_name": "Stop", "transcript_path": f.display().to_string() }),
        );
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(
            got.as_deref(),
            Some("Two files: **a** and b.\n\nNothing else.")
        );
        assert_eq!(
            final_answer(&json!({ "last_assistant_message": "  " })),
            None
        );
        assert_eq!(
            final_answer(&json!({ "transcript_path": "/nowhere/at/all.jsonl" })),
            None
        );
    }

    #[test]
    fn an_answer_already_sent_with_reply_is_not_said_twice() {
        let long = "The deploy is through: three services restarted, the migration ran in 41 seconds and the smoke tests are green. ".repeat(3);
        let replies = vec![folded(&long)];
        assert!(
            !already_said(&long, &[]),
            "no reply in the turn: always mirrored"
        );
        assert!(!already_said("ok", &[]));
        assert!(
            already_said(&format!("  {}\n", long.replace(". ", ".\n")), &replies),
            "the same text, white space aside"
        );
        assert!(already_said(&long[..230], &replies), "part of the reply");
        assert!(
            already_said(&format!("{long}\n\nAnything else?"), &replies),
            "the reply and a line more"
        );
        assert!(
            already_said("Sent to the board.", &replies),
            "short chatter after a reply"
        );
        let other = "Something entirely different that the board has not seen yet, long enough to count as a real answer of its own. ".repeat(3);
        assert!(
            !already_said(&other, &replies),
            "a different, long answer is mirrored"
        );
    }

    #[test]
    fn the_queue_keeps_the_order_and_knows_a_turn() {
        let m = Mirror::default();
        let input = |t: &str, id: &str| json!({ "op": "terminal", "kind": "input", "text": t, "prompt_id": id });
        let answer = |t: &str, id: &str| json!({ "op": "terminal", "kind": "answer", "text": t, "prompt_id": id });
        assert_eq!(
            m.accept(&input("how is it going?", "p1"), false)["queued"],
            json!(true)
        );
        assert_eq!(
            m.accept(&answer("All green.", "p1"), false)["queued"],
            json!(true)
        );
        assert_eq!(
            m.accept(&answer("All green.", "p1"), false)["why"],
            json!("said before"),
            "a hook that runs twice"
        );
        assert_eq!(
            m.accept(&input("how is it going?", "p1"), false)["why"],
            json!("said before")
        );
        assert_eq!(
            m.accept(&input("how is it going?", "p2"), false)["queued"],
            json!(true),
            "the same words in a new prompt are a new message"
        );
        let got: Vec<(&str, String)> = std::iter::from_fn(|| m.next())
            .map(|i| (i.kind, i.text))
            .collect();
        assert_eq!(
            got,
            vec![
                ("input", "how is it going?".to_string()),
                ("answer", "All green.".to_string()),
                ("input", "how is it going?".to_string())
            ]
        );
        // a reply in the turn: short chatter after it is left out; the next turn starts clean
        m.replied("Deployed, all green.");
        assert_eq!(
            m.accept(&answer("Sent.", "p2"), false)["why"],
            json!("already said with reply")
        );
        assert_eq!(
            m.accept(&answer("Sent!", "p3"), false)["queued"],
            json!(true),
            "the replies of the turn before are forgotten"
        );
        m.replied("Deployed, all green.");
        assert_eq!(
            m.accept(
                &json!({ "op": "terminal", "kind": "input", "text": null, "prompt_id": "p4" }),
                false
            )["why"],
            json!("nothing to mirror")
        );
        assert_eq!(
            m.accept(&answer("Done.", "p4"), false)["queued"],
            json!(true),
            "a prompt starts a turn, also one that is not mirrored"
        );
        assert_eq!(
            m.accept(
                &json!({ "op": "terminal", "kind": "tool", "text": "x" }),
                false
            )["ok"],
            json!(false)
        );
        // a prompt typed into the running turn (the same prompt_id) is his message too, and the turn keeps its replies
        m.replied("Deployed, all green.");
        assert_eq!(
            m.accept(&input("and the tests?", "p5"), true)["queued"],
            json!(true)
        );
        assert_eq!(
            m.accept(&answer("Sent.", "p5"), false)["why"],
            json!("already said with reply")
        );
        // the same words typed again into one turn, later, are said again; a hook run twice is not
        {
            let mut st = m.st.lock().unwrap();
            for r in st.recent.iter_mut() {
                r.1 -= TWICE_MS + 1;
            }
        }
        assert_eq!(
            m.accept(&input("and the tests?", "p5"), true)["queued"],
            json!(true)
        );
        assert_eq!(
            m.accept(&input("and the tests?", "p5"), true)["why"],
            json!("said before")
        );
        assert_eq!(
            m.accept(&answer("All green.", "p1"), false)["why"],
            json!("said before"),
            "an answer once per turn, whenever"
        );
        assert_eq!(m.next().map(|i| i.text).as_deref(), Some("Sent!"));
        assert_eq!(m.next().map(|i| i.text).as_deref(), Some("Done."));
        assert_eq!(m.drop_all(), 2);
        assert_eq!(m.waiting(), 0);
    }
}
