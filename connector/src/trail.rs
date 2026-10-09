//! The trail of a terminal turn: what the agent did between the human's prompt and its final answer, put into the
//! session's chat as one block that fills while the turn runs (README "The terminal mirror", "The trail"). The
//! plugin's hooks PreToolUse, PostToolUse, PostToolUseFailure, MessageDisplay, SubagentStart, SubagentStop, SessionEnd
//! and StopFailure run `trommi-connector trail`; each hands one line to the connector of its Claude Code process
//! through that connector's bell and ends at once. Here: what a hook takes from its input at each level
//! (`hook_request`: the safe subject of a step, and with `full` its input and output, cut and redacted), and the
//! connector's side (`Trail`): the steps of a turn, coalesced into few envelopes. Nothing here is logged or written
//! to disk.
use crate::mirror::{capped, folded, Level};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::{BTreeSet, HashMap};

/// A step's title (the call's own description) and its subject (a path, a pattern, a query), in characters.
pub const TITLE_MAX: usize = 120;
pub const SUBJECT_MAX: usize = 200;
/// With `full`: a step's input and the excerpt of its output, in bytes.
pub const INPUT_MAX: usize = 2_000;
pub const OUTPUT_MAX: usize = 4_000;
/// The most items (steps, texts, helpers) a turn's trail lists; further steps are only counted (`more`).
pub const ITEMS_MAX: usize = 200;
/// The most one envelope of a trail weighs (an envelope's body is at most 64 KiB), and how often one is sent.
pub const ENVELOPE_MAX: usize = 40_000;
pub const FLUSH_MS: u64 = 1_500;
const TURNS_KEPT: usize = 8;

// ---- what a step may say -----------------------------------------------------------------------------------------

fn one_line(s: &str, max: usize) -> String {
    let f = folded(s);
    if f.chars().count() > max {
        format!(
            "{}…",
            f.chars().take(max - 1).collect::<String>().trim_end()
        )
    } else {
        f
    }
}
/// The board's own tools (the plugin's server, or a server "trommi"): what they do stands on the board already.
pub fn is_board_tool(name: &str) -> bool {
    name.starts_with("mcp__plugin_trommi_trommi__") || name.starts_with("mcp__trommi__")
}
/// A tool's name as the trail shows it: `mcp__github__create_issue` is "github: create_issue".
pub fn tool_label(name: &str) -> String {
    match name.strip_prefix("mcp__") {
        Some(rest) => one_line(&rest.replacen("__", ": ", 1), 60),
        None => one_line(name, 60),
    }
}
fn str_of<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("")
}
fn path_of(p: &str, cwd: &str) -> String {
    let rel = if !cwd.is_empty() {
        p.strip_prefix(cwd)
            .and_then(|r| r.strip_prefix('/'))
            .unwrap_or(p)
    } else {
        p
    };
    one_line(rel, SUBJECT_MAX)
}
/// A URL without what can carry a credential: no user, no query, no fragment.
fn url_of(u: &str) -> String {
    let u = u.split(['?', '#']).next().unwrap_or("");
    let u = match u.split_once("://") {
        Some((scheme, rest)) => match rest.split_once('/') {
            Some((host, path)) => format!(
                "{scheme}://{}/{path}",
                host.rsplit('@').next().unwrap_or(host)
            ),
            None => format!("{scheme}://{}", rest.rsplit('@').next().unwrap_or(rest)),
        },
        None => u.to_string(),
    };
    one_line(&u, SUBJECT_MAX)
}
/// The one safe line that says what a step is about, at the level `steps`: a file's path, a search's pattern or
/// query, a fetched address without its query, a helper's kind, a skill's name. Never a command line, never a file's
/// content, never any other tool's arguments (a Bash step has its description alone).
pub fn subject(tool: &str, input: &Value, cwd: &str) -> String {
    match tool {
        "Read" | "Edit" | "Write" | "MultiEdit" => path_of(str_of(input, "file_path"), cwd),
        "NotebookEdit" | "NotebookRead" => path_of(str_of(input, "notebook_path"), cwd),
        "Glob" | "Grep" => {
            let (pattern, path) = (
                one_line(str_of(input, "pattern"), SUBJECT_MAX),
                path_of(str_of(input, "path"), cwd),
            );
            if path.is_empty() {
                pattern
            } else {
                one_line(&format!("{pattern} in {path}"), SUBJECT_MAX)
            }
        }
        "WebSearch" | "ToolSearch" => one_line(str_of(input, "query"), SUBJECT_MAX),
        "WebFetch" => url_of(str_of(input, "url")),
        "Agent" | "Task" => one_line(str_of(input, "subagent_type"), SUBJECT_MAX),
        "Skill" => one_line(str_of(input, "skill"), SUBJECT_MAX),
        _ => String::new(),
    }
}

/// What looks like a secret taken out of a text, for the level `full`. Exactly this, and no more (README):
/// private-key blocks; the value of the headers Authorization, Proxy-Authorization, X-Api-Key, X-Auth-Token, Cookie
/// and Set-Cookie to the end of the line; a `Bearer` or `Basic` token; the user and password in a URL; the value
/// after a name that holds token, secret, password, passwd, pwd, key or credential (`NAME=value`,
/// `"name": "value"`, `--name value`); tokens with a known prefix (sk-, pk-, rk-, ghp_ and its kin, github_pat_,
/// xox?-, AKIA, a JWT); any run of 40 or more letters, digits, `+`, `_`, `-`.
pub fn redact(s: &str) -> String {
    let pem = Regex::new(
        r"(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|\z)",
    )
    .unwrap();
    let header = Regex::new(r"(?im)\b((?:proxy-)?authorization|x-api-key|x-auth-token|(?:set-)?cookie)(\s*[:=]\s*)[^\r\n]*").unwrap();
    let scheme = Regex::new(r"(?i)\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}").unwrap();
    let userinfo = Regex::new(r"(?i)\b([a-z][a-z0-9+.-]*://)[^\s/@:]+(?::[^\s/@]*)?@").unwrap();
    let named = Regex::new(r#"(?i)((?:--?)?["']?[A-Za-z0-9_.-]*(?:token|secret|password|passwd|pwd|key|credential)[A-Za-z0-9_.-]*["']?(?:\s*[:=]\s*|\s+))("[^"\n]*"|'[^'\n]*'|[^\s,;}\])]+)"#).unwrap();
    let known = Regex::new(r"\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9]{16,}|\bgithub_pat_[A-Za-z0-9_]{16,}|\bxox[abprs]-[A-Za-z0-9_-]{8,}|\bAKIA[0-9A-Z]{12,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?").unwrap();
    let long = Regex::new(r"[A-Za-z0-9+_-]{40,}={0,2}").unwrap();
    let a = pem.replace_all(s, "-----BEGIN PRIVATE KEY----- … -----END PRIVATE KEY-----");
    let b = header.replace_all(&a, "${1}${2}…");
    let c = scheme.replace_all(&b, "Bearer …");
    let d = userinfo.replace_all(&c, "${1}…@");
    // (a name followed by a space counts only for a flag or a quoted name: `--token abc`, not "the key is under the mat")
    let e = named.replace_all(&d, |m: &regex::Captures| {
        let (name, value) = (&m[1], &m[2]);
        let spaced = !name.trim_end().ends_with([':', '=']);
        if spaced && !name.starts_with('-') {
            m[0].to_string()
        } else if value == "…" || value.starts_with('…') {
            m[0].to_string()
        } else {
            format!("{name}…")
        }
    });
    let f = known.replace_all(&e, "…");
    long.replace_all(&f, "…").into_owned()
}
fn floor_at(s: &str, mut i: usize) -> usize {
    i = i.min(s.len());
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}
fn ceil_at(s: &str, mut i: usize) -> usize {
    i = i.min(s.len());
    while !s.is_char_boundary(i) {
        i += 1;
    }
    i
}
/// The head and the tail of a text of at most about `max` bytes, with a line between that says what is left out.
pub fn excerpt(text: &str, max: usize) -> String {
    let t = text.trim_end();
    if t.len() <= max {
        return t.to_string();
    }
    let lines: Vec<&str> = t.lines().collect();
    let (head_max, tail_max) = (max * 6 / 10, max * 4 / 10);
    let (mut head, mut tail, mut used) = (0, lines.len(), 0);
    while head < lines.len() && used + lines[head].len() + 1 <= head_max {
        used += lines[head].len() + 1;
        head += 1;
    }
    used = 0;
    while tail > head && used + lines[tail - 1].len() + 1 <= tail_max {
        used += lines[tail - 1].len() + 1;
        tail -= 1;
    }
    if head == 0 && tail == lines.len() {
        // one long line, or a first and a last line too long each: by characters
        let (a, b) = (floor_at(t, head_max), ceil_at(t, t.len() - tail_max));
        return format!(
            "{}\n… ({} more characters) …\n{}",
            &t[..a],
            t[a..b].chars().count(),
            &t[b..]
        );
    }
    let left = tail - head;
    let mut out: Vec<String> = lines[..head].iter().map(|l| l.to_string()).collect();
    out.push(format!(
        "… ({left} more line{}) …",
        if left == 1 { "" } else { "s" }
    ));
    out.extend(lines[tail..].iter().map(|l| l.to_string()));
    out.join("\n")
}
fn lines_of(s: &str) -> usize {
    if s.is_empty() {
        0
    } else {
        s.lines().count()
    }
}
/// With `full`: what went into a step. Bash: the command line. Edit: the path and the lines taken out and put in.
/// Write: the path and the content's head. A helper: its prompt's head. Anything else: its arguments as JSON.
pub fn full_input(tool: &str, input: &Value) -> String {
    let text = match tool {
        "Bash" => str_of(input, "command").to_string(),
        "Edit" => {
            let (old, new) = (str_of(input, "old_string"), str_of(input, "new_string"));
            let mark = |sign: &str, s: &str| {
                s.lines()
                    .map(|l| format!("{sign} {l}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            format!(
                "{}  −{} +{} lines\n{}\n{}",
                str_of(input, "file_path"),
                lines_of(old),
                lines_of(new),
                mark("-", old),
                mark("+", new)
            )
        }
        "MultiEdit" => format!(
            "{}  {} edits",
            str_of(input, "file_path"),
            input
                .get("edits")
                .and_then(|e| e.as_array())
                .map_or(0, |a| a.len())
        ),
        "Write" => format!(
            "{}  {} lines\n{}",
            str_of(input, "file_path"),
            lines_of(str_of(input, "content")),
            str_of(input, "content")
        ),
        "Read" => {
            let range = match (
                input.get("offset").and_then(|v| v.as_u64()),
                input.get("limit").and_then(|v| v.as_u64()),
            ) {
                (Some(o), Some(l)) => format!("  lines {o}–{}", o + l),
                (Some(o), None) => format!("  from line {o}"),
                (None, Some(l)) => format!("  first {l} lines"),
                _ => String::new(),
            };
            format!("{}{range}", str_of(input, "file_path"))
        }
        "Agent" | "Task" => str_of(input, "prompt").to_string(),
        _ => match input {
            Value::Null => String::new(),
            Value::Object(o) if o.is_empty() => String::new(),
            v => serde_json::to_string_pretty(v).unwrap_or_default(),
        },
    };
    excerpt(&redact(&text), INPUT_MAX)
}
/// With `full`: what came out of a step, as text. A string as it is; Bash's stdout and stderr; a read file's
/// content; a text block list's text; anything else as JSON.
pub fn full_output(resp: &Value) -> String {
    let text = match resp {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Array(a)
            if a.iter()
                .all(|b| b.get("type").and_then(|t| t.as_str()) == Some("text")) =>
        {
            a.iter()
                .map(|b| str_of(b, "text"))
                .collect::<Vec<_>>()
                .join("\n")
        }
        Value::Object(o) if o.contains_key("stdout") || o.contains_key("stderr") => {
            let (out, err) = (
                str_of(resp, "stdout").trim_end(),
                str_of(resp, "stderr").trim_end(),
            );
            [out, err]
                .into_iter()
                .filter(|p| !p.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        }
        Value::Object(o)
            if o.get("file")
                .and_then(|f| f.get("content"))
                .is_some_and(|c| c.is_string()) =>
        {
            str_of(&o["file"], "content").to_string()
        }
        Value::Object(o) if o.get("content").is_some_and(|c| c.is_string()) => {
            str_of(resp, "content").to_string()
        }
        v => serde_json::to_string_pretty(v).unwrap_or_default(),
    };
    excerpt(&redact(&text), OUTPUT_MAX)
}

/// A shell command that ended with an exit code other than 0, which Claude Code reports as a failed call
/// (PostToolUseFailure, `error: "Exit code 1"` and then the output): the code alone, a number, says nothing secret.
pub fn exit_code(tool: &str, error: &str) -> Option<u64> {
    if tool != "Bash" {
        return None;
    }
    let rest = error.trim_start().strip_prefix("Exit code ")?;
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok().filter(|c| *c > 0 && *c < 256)
}

/// The line a trail hook hands its connector, or None when this hook has nothing to say (the level is below
/// `steps`, an event without what it needs, broken input).
pub fn hook_request(input: &Value, ancestors: &[u32], level: Level) -> Option<Value> {
    if !input.is_object() || level < Level::Steps {
        return None;
    }
    let full = level == Level::Full;
    let cwd = str_of(input, "cwd");
    let tool = str_of(input, "tool_name");
    let args = input.get("tool_input").unwrap_or(&Value::Null);
    let mut r = Map::new();
    let mut put = |k: &str, v: Value| {
        if !v.is_null() && v.as_str() != Some("") {
            r.insert(k.to_string(), v);
        }
    };
    let step = |put: &mut dyn FnMut(&str, Value)| -> Option<()> {
        let id = str_of(input, "tool_use_id");
        if id.is_empty() || tool.is_empty() {
            return None;
        }
        put("id", json!(id));
        put("tool", json!(tool_label(tool)));
        if is_board_tool(tool) {
            put("board", json!(true));
            put("session", json!(one_line(str_of(args, "session"), 40)));
        } else {
            put(
                "title",
                json!(one_line(str_of(args, "description"), TITLE_MAX)),
            );
            put("subject", json!(subject(tool, args, cwd)));
        }
        Some(())
    };
    let ev = match str_of(input, "hook_event_name") {
        "PreToolUse" => {
            step(&mut put)?;
            if full && !is_board_tool(tool) {
                put("input", json!(full_input(tool, args)));
            }
            "pre"
        }
        "PostToolUse" => {
            step(&mut put)?;
            if full && !is_board_tool(tool) {
                put(
                    "output",
                    json!(full_output(
                        input.get("tool_response").unwrap_or(&Value::Null)
                    )),
                );
            }
            "post"
        }
        "PostToolUseFailure" => {
            step(&mut put)?;
            if input.get("is_interrupt") == Some(&Value::Bool(true)) {
                put("interrupt", json!(true));
            }
            put(
                "exit",
                exit_code(tool, str_of(input, "error")).map_or(Value::Null, |c| json!(c)),
            );
            if full && !is_board_tool(tool) {
                put(
                    "output",
                    json!(excerpt(&redact(str_of(input, "error")), OUTPUT_MAX)),
                );
            }
            "fail"
        }
        "MessageDisplay" => {
            let id = str_of(input, "message_id");
            if id.is_empty() {
                return None;
            }
            put("msg", json!(id));
            put("text", json!(capped(str_of(input, "delta"))));
            put(
                "final",
                json!(input.get("final") == Some(&Value::Bool(true))),
            );
            "say"
        }
        "SubagentStart" => {
            put(
                "title",
                json!(one_line(str_of(input, "task_description"), TITLE_MAX)),
            );
            "agent_start"
        }
        "SubagentStop" => {
            if full {
                put(
                    "output",
                    json!(excerpt(
                        &redact(str_of(input, "last_assistant_message")),
                        OUTPUT_MAX
                    )),
                );
            }
            "agent_stop"
        }
        "SessionEnd" => "end",
        "StopFailure" => "error",
        _ => return None,
    };
    put(
        "ms",
        input
            .get("duration_ms")
            .filter(|v| v.is_u64())
            .cloned()
            .unwrap_or(Value::Null),
    );
    put("prompt", json!(one_line(str_of(input, "prompt_id"), 64)));
    put("agent", json!(one_line(str_of(input, "agent_id"), 64)));
    put(
        "agent_type",
        json!(one_line(str_of(input, "agent_type"), 60)),
    );
    if ["agent_start", "agent_stop"].contains(&ev) && !r.contains_key("agent") {
        return None;
    }
    r.insert("op".into(), json!("terminal"));
    r.insert("kind".into(), json!("trail"));
    r.insert("ev".into(), json!(ev));
    r.insert("ancestors".into(), json!(ancestors));
    Some(Value::Object(r))
}

// ---- the connector's side ----------------------------------------------------------------------------------------

struct Turn {
    id: String,
    /// A child session's name, or None for the session's own chat.
    target: Option<String>,
    /// Claude Code's `prompt_id`: every hook of one turn carries the same one (empty when a hook has none).
    prompt: String,
    started: u64,
    closed: bool,
    /// When it ended, where that is known: a turn broken off with Esc fires no hook, so its end has no time.
    ended: Option<u64>,
    state: &'static str,
    items: Vec<Map<String, Value>>,
    index: HashMap<String, usize>,
    dirty: BTreeSet<usize>,
    head_dirty: bool,
    seq: u64,
    more: u64,
    /// The agent's last words so far: a text item once something follows them, the final answer when nothing does.
    pending: Option<String>,
}
impl Turn {
    fn open(&self) -> bool {
        !self.closed
    }
    /// A step of a turn that was closed: it runs on (a Stop hook that sent the agent back to work, or a turn taken
    /// for broken off that was not).
    fn reopen(&mut self) {
        if self.closed {
            self.closed = false;
            self.ended = None;
            self.state = "running";
            self.head_dirty = true;
        }
    }
    fn add(&mut self, id: &str, item: Map<String, Value>) -> Option<usize> {
        if let Some(i) = self.index.get(id) {
            return Some(*i);
        }
        if self.items.len() >= ITEMS_MAX {
            self.more += 1;
            self.head_dirty = true;
            return None;
        }
        self.items.push(item);
        let i = self.items.len() - 1;
        self.index.insert(id.to_string(), i);
        self.dirty.insert(i);
        Some(i)
    }
    fn say(&mut self, n: &mut u64, now: u64) {
        if let Some(text) = self.pending.take() {
            *n += 1;
            let id = format!("say:{n}");
            self.add(
                &id,
                obj(json!({ "id": id, "kind": "text", "text": capped(&text), "at": now })),
            );
        }
    }
    fn close(&mut self, state: &'static str, ended: Option<u64>) {
        if self.open() {
            self.state = state;
            self.closed = true;
            self.ended = ended;
            self.head_dirty = true;
            // what was still running when the turn broke off did not finish
            if state != "done" {
                for i in 0..self.items.len() {
                    if self.items[i].get("kind").and_then(|k| k.as_str()) == Some("step")
                        && self.items[i].get("state").and_then(|s| s.as_str()) == Some("running")
                    {
                        self.items[i].insert("state".into(), json!("interrupted"));
                        self.dirty.insert(i);
                    }
                }
            }
        }
    }
}
fn obj(v: Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}
struct Helper {
    /// The board session this helper named on a board tool call (`session:`): its steps are that session's trail.
    session: Option<String>,
    /// The turn its line stands in.
    turn: String,
}

/// One envelope of a trail: the chat it goes into (a child session's name, or None) and the message's `work`.
pub struct Envelope {
    pub target: Option<String>,
    pub work: Value,
}

/// The trails of this Claude Code process: the open turn of the session, the open turn of each child session a
/// helper works for, and a few closed ones (a helper in the background ends after its turn).
#[derive(Default)]
pub struct Trail {
    turns: Vec<Turn>,
    main: Option<String>,
    children: HashMap<String, String>,
    helpers: HashMap<String, Helper>,
    says: HashMap<String, String>,
    /// The prompt no step followed yet: its `prompt_id` and when it came (the turn's start).
    prompted: Option<(String, u64)>,
    /// The `prompt_id`s of the last turns Stop ended: words that come after it open no turn.
    stopped: Vec<String>,
    /// The last turn's answer: the hook that brings the same words as the agent's last message may come after Stop.
    answered: Option<String>,
    n: u64,
}
impl Trail {
    fn turn(&mut self, id: &str) -> Option<&mut Turn> {
        self.turns.iter_mut().find(|t| t.id == id)
    }
    fn new_turn(&mut self, target: Option<String>, prompt: &str, started: u64) -> String {
        let id = crate::util::random_hex(8);
        self.turns.push(Turn {
            id: id.clone(),
            target,
            prompt: prompt.to_string(),
            started,
            closed: false,
            ended: None,
            state: "running",
            items: vec![],
            index: HashMap::new(),
            dirty: BTreeSet::new(),
            head_dirty: false,
            seq: 0,
            more: 0,
            pending: None,
        });
        id
    }
    fn open_main(&self) -> Option<String> {
        self.main
            .clone()
            .filter(|id| self.turns.iter().any(|t| &t.id == id && t.open()))
    }
    /// Whether two `prompt_id`s name different turns: only when both are known.
    fn other(a: &str, b: &str) -> bool {
        !a.is_empty() && !b.is_empty() && a != b
    }
    /// The open turn is over without a Stop: the human broke it off (Esc fires no hook; what follows carries
    /// another `prompt_id`). When is not known.
    fn break_off(&mut self, now: u64) {
        if let Some(id) = self.main.take() {
            let mut n = self.n;
            if let Some(t) = self.turn(&id) {
                t.say(&mut n, now);
                t.close("interrupted", None);
            }
            self.n = n;
        }
    }
    /// The session's turn a step or the agent's words with `prompt` (a `prompt_id`) belong to: the open one when it
    /// is that turn's (or when either has no id: then nothing tells two turns apart, and the trail goes on); else the
    /// open one was broken off, and the turn is the one that had this id before (it runs on) or a new one.
    fn main_turn(&mut self, prompt: &str, now: u64) -> String {
        if let Some(id) = self.open_main() {
            let t = self.turn(&id).unwrap();
            if !Self::other(&t.prompt, prompt) {
                if t.prompt.is_empty() {
                    t.prompt = prompt.to_string();
                }
                return id;
            }
            self.break_off(now);
        }
        self.stopped.retain(|p| p != prompt);
        if let Some(t) = self
            .turns
            .iter_mut()
            .rev()
            .find(|t| t.target.is_none() && !prompt.is_empty() && t.prompt == prompt)
        {
            t.reopen();
            let id = t.id.clone();
            self.main = Some(id.clone());
            return id;
        }
        let started = self
            .prompted
            .take()
            .filter(|(p, _)| !Self::other(p, prompt))
            .map_or(now, |(_, at)| at);
        let id = self.new_turn(None, prompt, started);
        self.main = Some(id.clone());
        id
    }
    /// The turn a helper's line stands in: the open one, else the one its `prompt_id` names (a helper in the
    /// background carries the id of the turn that started it, long after that turn ended), else a new one.
    fn helper_home(&mut self, prompt: &str, now: u64) -> String {
        if let Some(id) = self.open_main() {
            return id;
        }
        if let Some(t) = self
            .turns
            .iter()
            .rev()
            .find(|t| t.target.is_none() && !prompt.is_empty() && t.prompt == prompt)
        {
            return t.id.clone();
        }
        self.main_turn(prompt, now)
    }
    fn child_turn(&mut self, name: &str, now: u64) -> String {
        if let Some(id) = self
            .children
            .get(name)
            .cloned()
            .filter(|id| self.turns.iter().any(|t| &t.id == id && t.open()))
        {
            return id;
        }
        let id = self.new_turn(Some(name.to_string()), "", now);
        self.children.insert(name.to_string(), id.clone());
        id
    }
    /// A prompt was submitted (the human's, or one Claude Code submits by itself), with its `prompt_id`. Returns
    /// whether it came into the turn that is running: Claude Code takes what is typed while a turn runs into that
    /// turn (the hook fires at once, with the running turn's `prompt_id`; seen with 2.1.286), and the trail goes on.
    /// A prompt with another id while a turn is open says that turn was broken off: a turn that ends by itself
    /// fires Stop first, and Esc fires nothing. Without an id on either side nothing is called broken off.
    pub fn prompt(&mut self, prompt: &str, now: u64) -> bool {
        if let Some(id) = self.open_main() {
            if !Self::other(&self.turn(&id).unwrap().prompt, prompt) {
                return true;
            }
            self.break_off(now);
        }
        if !self
            .prompted
            .as_ref()
            .is_some_and(|(p, _)| !prompt.is_empty() && p == prompt)
        {
            self.prompted = Some((prompt.to_string(), now));
        }
        false
    }
    /// The turn ended with `answer` (Stop): its last words are the answer, which goes as a message of its own.
    pub fn answer(&mut self, prompt: &str, answer: Option<&str>, now: u64) {
        self.answered = answer.map(folded);
        if self
            .prompted
            .as_ref()
            .is_some_and(|(p, _)| !Self::other(p, prompt))
        {
            self.prompted = None;
        }
        if !prompt.is_empty() {
            self.stopped.retain(|p| p != prompt);
            self.stopped.push(prompt.to_string());
            if self.stopped.len() > 16 {
                self.stopped.remove(0);
            }
        }
        // (a Stop of another turn than the open one ends nothing here)
        let Some(id) = self.open_main().filter(|id| {
            !Self::other(
                &self.turns.iter().find(|t| &t.id == id).unwrap().prompt,
                prompt,
            )
        }) else {
            return;
        };
        self.main = None;
        let mut n = self.n;
        if let Some(t) = self.turn(&id) {
            if t.pending
                .as_deref()
                .is_some_and(|p| answer.is_some_and(|a| folded(p) == folded(a)))
            {
                t.pending = None;
            }
            t.say(&mut n, now);
            t.close("done", Some(now));
        }
        self.n = n;
    }
    /// A line of a trail hook.
    pub fn event(&mut self, req: &Value, now: u64) {
        let ev = str_of(req, "ev");
        let agent = str_of(req, "agent").to_string();
        let prompt = str_of(req, "prompt").to_string();
        let mut n = self.n;
        match ev {
            "say" => {
                // (a helper's words go to its caller, not onto the screen)
                if !agent.is_empty() {
                    return;
                }
                let msg = str_of(req, "msg").to_string();
                if self.says.len() > 50 {
                    self.says.clear();
                }
                let so_far = self.says.entry(msg.clone()).or_default();
                so_far.push_str(str_of(req, "text"));
                if req.get("final") != Some(&Value::Bool(true)) {
                    return;
                }
                let text = self.says.remove(&msg).unwrap_or_default();
                // (the hook that brings the answer's words may come after Stop: they open no turn)
                let late = self.stopped.contains(&prompt)
                    || (self.open_main().is_none()
                        && self.prompted.is_none()
                        && self.answered.as_deref() == Some(folded(&text).as_str()));
                if text.trim().is_empty() || late {
                    return;
                }
                let id = self.main_turn(&prompt, now);
                let t = self.turn(&id).unwrap();
                t.say(&mut n, now);
                t.pending = Some(text.trim().to_string());
            }
            "pre" | "post" | "fail" => {
                let id = str_of(req, "id").to_string();
                let board = req.get("board") == Some(&Value::Bool(true));
                let named = str_of(req, "session").to_string();
                let turn_id = if agent.is_empty() {
                    // (a step's end belongs where the step stands, also in a turn that is over: its hook runs async)
                    if ev == "pre" {
                        Some(self.main_turn(&prompt, now))
                    } else {
                        self.turns
                            .iter()
                            .rev()
                            .find(|t| t.target.is_none() && t.index.contains_key(&id))
                            .map(|t| t.id.clone())
                    }
                } else {
                    if !self.helpers.contains_key(&agent) {
                        let turn = self.helper_home(&prompt, now);
                        self.helpers.insert(
                            agent.clone(),
                            Helper {
                                session: None,
                                turn,
                            },
                        );
                    }
                    if board && !named.is_empty() {
                        self.helpers.get_mut(&agent).unwrap().session = Some(named);
                    }
                    match self.helpers[&agent].session.clone() {
                        Some(name) => Some(self.child_turn(&name, now)),
                        None => {
                            // a helper without a board session: its steps are counted on its line in its caller's turn
                            if ev == "pre" && !board {
                                let (turn, key) =
                                    (self.helpers[&agent].turn.clone(), format!("agent:{agent}"));
                                if let Some(t) = self.turn(&turn) {
                                    if let Some(i) = t.index.get(&key).copied() {
                                        let steps = t.items[i]
                                            .get("steps")
                                            .and_then(|v| v.as_u64())
                                            .unwrap_or(0)
                                            + 1;
                                        t.items[i].insert("steps".into(), json!(steps));
                                        t.dirty.insert(i);
                                    }
                                }
                            }
                            None
                        }
                    }
                };
                let Some(turn_id) = turn_id else { return };
                let t = self.turn(&turn_id).unwrap();
                // (the words before a step stand before it, also before a board call, which is no step)
                if ev == "pre" {
                    t.say(&mut n, now);
                }
                if board {
                    self.n = n;
                    return;
                }
                let mut item =
                    obj(json!({ "id": id, "kind": "step", "state": "running", "at": now }));
                for k in ["tool", "title", "subject", "input"] {
                    if let Some(v) = req.get(k) {
                        item.insert(k.into(), v.clone());
                    }
                }
                // (only a step's start makes its line: the end of one that was never listed changes nothing)
                let known = if ev == "pre" {
                    t.add(&id, item)
                } else {
                    t.index.get(&id).copied()
                };
                let Some(i) = known else {
                    self.n = n;
                    return;
                };
                if ev != "pre" {
                    let interrupted = req.get("interrupt") == Some(&Value::Bool(true));
                    let it = &mut t.items[i];
                    it.insert(
                        "state".into(),
                        json!(if ev == "post" {
                            "ok"
                        } else if interrupted {
                            "interrupted"
                        } else {
                            "failed"
                        }),
                    );
                    let ms = req.get("ms").and_then(|v| v.as_u64()).unwrap_or_else(|| {
                        now.saturating_sub(it.get("at").and_then(|v| v.as_u64()).unwrap_or(now))
                    });
                    it.insert("ms".into(), json!(ms));
                    if let Some(o) = req.get("output") {
                        it.insert("output".into(), o.clone());
                    }
                    if let Some(c) = req.get("exit").filter(|c| c.is_u64() && ev == "fail") {
                        it.insert("exit".into(), c.clone());
                    }
                    t.dirty.insert(i);
                    if interrupted && t.target.is_none() && t.open() {
                        t.say(&mut n, now);
                        t.close("interrupted", Some(now));
                        if self.main.as_deref() == Some(turn_id.as_str()) {
                            self.main = None;
                        }
                    }
                }
            }
            "agent_start" => {
                let turn = self.helper_home(&prompt, now);
                let key = format!("agent:{agent}");
                let mut item = obj(
                    json!({ "id": key, "kind": "helper", "state": "running", "at": now, "steps": 0 }),
                );
                item.insert(
                    "tool".into(),
                    json!(req
                        .get("agent_type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Helper")),
                );
                if let Some(v) = req.get("title") {
                    item.insert("title".into(), v.clone());
                }
                let t = self.turn(&turn).unwrap();
                t.say(&mut n, now);
                t.add(&key, item);
                self.helpers.insert(
                    agent,
                    Helper {
                        session: None,
                        turn,
                    },
                );
            }
            "agent_stop" => {
                if let Some(h) = self.helpers.remove(&agent) {
                    let key = format!("agent:{agent}");
                    if let Some(t) = self.turn(&h.turn) {
                        if let Some(i) = t.index.get(&key).copied() {
                            let it = &mut t.items[i];
                            it.insert("state".into(), json!("ok"));
                            it.insert(
                                "ms".into(),
                                json!(now.saturating_sub(
                                    it.get("at").and_then(|v| v.as_u64()).unwrap_or(now)
                                )),
                            );
                            if let Some(o) = req.get("output") {
                                it.insert("output".into(), o.clone());
                            }
                            t.dirty.insert(i);
                        }
                    }
                    if let Some(name) = h.session {
                        if let Some(id) = self.children.remove(&name) {
                            if let Some(t) = self.turn(&id) {
                                t.close("done", Some(now));
                            }
                        }
                    }
                }
            }
            "end" | "error" => {
                let state = if ev == "end" { "interrupted" } else { "failed" };
                let open: Vec<String> = self
                    .main
                    .take()
                    .into_iter()
                    .chain(if ev == "end" {
                        self.children.drain().map(|(_, id)| id).collect::<Vec<_>>()
                    } else {
                        vec![]
                    })
                    .collect();
                for id in open {
                    if let Some(t) = self.turn(&id) {
                        t.say(&mut n, now);
                        t.close(state, Some(now));
                    }
                }
            }
            _ => {}
        }
        self.n = n;
    }
    /// Whether something waits to be sent.
    pub fn dirty(&self) -> bool {
        self.turns
            .iter()
            .any(|t| !t.dirty.is_empty() || (t.head_dirty && (t.seq > 0 || !t.items.is_empty())))
    }
    /// What changed since the last call, as envelopes: per turn the new and the changed items, several envelopes
    /// when they weigh more than ENVELOPE_MAX. A turn in which nothing happened is never sent.
    pub fn flush(&mut self) -> Vec<Envelope> {
        let mut out = vec![];
        for t in self.turns.iter_mut() {
            if t.dirty.is_empty() && !(t.head_dirty && (t.seq > 0 || !t.items.is_empty())) {
                t.head_dirty = false;
                continue;
            }
            let changed: Vec<usize> = std::mem::take(&mut t.dirty).into_iter().collect();
            t.head_dirty = false;
            let mut groups: Vec<Vec<Value>> = vec![vec![]];
            let mut weight = 0;
            for i in changed {
                let v = Value::Object(t.items[i].clone());
                let w = v.to_string().len();
                if weight + w > ENVELOPE_MAX && !groups.last().unwrap().is_empty() {
                    groups.push(vec![]);
                    weight = 0;
                }
                weight += w;
                groups.last_mut().unwrap().push(v);
            }
            for items in groups {
                t.seq += 1;
                let mut w = obj(
                    json!({ "turn": t.id, "seq": t.seq, "state": t.state, "started_at": t.started, "items": items }),
                );
                if let Some(e) = t.ended {
                    w.insert("ended_at".into(), json!(e));
                }
                if t.more > 0 {
                    w.insert("more".into(), json!(t.more));
                }
                out.push(Envelope {
                    target: t.target.clone(),
                    work: Value::Object(w),
                });
            }
        }
        // closed turns leave, oldest first, but one a helper still works in stays
        while self.turns.len() > TURNS_KEPT {
            let keep: Vec<&String> = self.helpers.values().map(|h| &h.turn).collect();
            match self
                .turns
                .iter()
                .position(|t| !t.open() && !keep.contains(&&t.id))
            {
                Some(i) => {
                    self.turns.remove(i);
                }
                None => break,
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pre(id: &str, tool: &str, input: Value) -> Value {
        json!({ "hook_event_name": "PreToolUse", "cwd": "/home/me/p", "tool_name": tool, "tool_input": input, "tool_use_id": id, "session_id": "s", "prompt_id": "p" })
    }
    fn line(input: &Value, level: Level) -> Value {
        hook_request(input, &[7], level).unwrap()
    }
    fn has(v: &Value, what: &str) -> bool {
        v.to_string().contains(what)
    }

    #[test]
    fn the_hooks_read_claude_codes_inputs_at_the_level_steps() {
        // as Claude Code 2.1.286 sends them
        let bash = pre(
            "toolu_01",
            "Bash",
            json!({ "command": "curl -H 'Authorization: Bearer abcdefgh12345678' https://x.example/y", "description": "Fetch the\nstatus page" }),
        );
        let r = line(&bash, Level::Steps);
        assert_eq!(
            r,
            json!({ "op": "terminal", "kind": "trail", "ev": "pre", "ancestors": [7], "id": "toolu_01", "tool": "Bash", "title": "Fetch the status page", "prompt": "p" })
        );
        assert!(
            !has(&r, "curl") && !has(&r, "Bearer"),
            "no command line at the level steps"
        );
        let r = line(
            &pre(
                "t2",
                "Read",
                json!({ "file_path": "/home/me/p/src/main.rs", "limit": 20 }),
            ),
            Level::Steps,
        );
        assert_eq!(
            (r["tool"].as_str(), r["subject"].as_str(), r.get("title")),
            (Some("Read"), Some("src/main.rs"), None)
        );
        let r = line(
            &pre(
                "t3",
                "Edit",
                json!({ "file_path": "/etc/hosts", "old_string": "SECRET-OLD", "new_string": "SECRET-NEW" }),
            ),
            Level::Steps,
        );
        assert_eq!(r["subject"], json!("/etc/hosts"));
        assert!(!has(&r, "SECRET"), "no file content at the level steps");
        let r = line(
            &pre(
                "t4",
                "Write",
                json!({ "file_path": "/home/me/p/.env", "content": "TOKEN=abc" }),
            ),
            Level::Steps,
        );
        assert!(r["subject"] == json!(".env") && !has(&r, "abc"));
        assert_eq!(
            line(
                &pre(
                    "t5",
                    "Grep",
                    json!({ "pattern": "fn main", "path": "/home/me/p/src" })
                ),
                Level::Steps
            )["subject"],
            json!("fn main in src")
        );
        assert_eq!(
            line(
                &pre(
                    "t6",
                    "WebSearch",
                    json!({ "query": "rust regex lookahead" })
                ),
                Level::Steps
            )["subject"],
            json!("rust regex lookahead")
        );
        assert_eq!(
            line(
                &pre(
                    "t7",
                    "WebFetch",
                    json!({ "url": "https://me:pw@api.example.com/v1/items?token=SECRET#x", "prompt": "what" })
                ),
                Level::Steps
            )["subject"],
            json!("https://api.example.com/v1/items")
        );
        let r = line(
            &pre(
                "t8",
                "Agent",
                json!({ "description": "Count files", "prompt": "SECRET prompt", "subagent_type": "Explore" }),
            ),
            Level::Steps,
        );
        assert_eq!(
            (r["title"].as_str(), r["subject"].as_str()),
            (Some("Count files"), Some("Explore"))
        );
        assert!(!has(&r, "SECRET"));
        let r = line(
            &pre(
                "t9",
                "mcp__github__create_issue",
                json!({ "title": "SECRET", "body": "SECRET" }),
            ),
            Level::Steps,
        );
        assert!(
            r["tool"] == json!("github: create_issue")
                && r.get("subject").is_none()
                && !has(&r, "SECRET"),
            "another tool's arguments never"
        );
        // the board's own tools are no steps; a helper's session name is read from them
        let r = line(
            &pre(
                "t10",
                "mcp__plugin_trommi_trommi__reply",
                json!({ "text": "SECRET", "session": "Design" }),
            ),
            Level::Steps,
        );
        assert!(r["board"] == json!(true) && r["session"] == json!("Design") && !has(&r, "SECRET"));
        // results: the state and the time, nothing of the output
        let post = json!({ "hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_input": { "command": "ls", "description": "List" }, "tool_use_id": "toolu_01", "tool_response": { "stdout": "SECRET-OUT", "stderr": "", "interrupted": false }, "duration_ms": 6, "agent_id": "ad4d", "agent_type": "Explore" });
        let r = line(&post, Level::Steps);
        assert_eq!(
            r,
            json!({ "op": "terminal", "kind": "trail", "ev": "post", "ancestors": [7], "id": "toolu_01", "tool": "Bash", "title": "List", "ms": 6, "agent": "ad4d", "agent_type": "Explore" })
        );
        let fail = json!({ "hook_event_name": "PostToolUseFailure", "tool_name": "Bash", "tool_input": { "command": "ls /x" }, "tool_use_id": "t11", "error": "Exit code 2\nls: SECRET-ERR", "is_interrupt": true, "duration_ms": 29 });
        let r = line(&fail, Level::Steps);
        assert!(
            r["ev"] == json!("fail")
                && r["interrupt"] == json!(true)
                && r["ms"] == json!(29)
                && !has(&r, "SECRET")
        );
        // the agent's words between steps, a helper's start and end, the session's end, an API error
        let say = json!({ "hook_event_name": "MessageDisplay", "message_id": "m1", "turn_id": "u1", "index": 0, "final": true, "delta": "I will read the file." });
        assert_eq!(
            line(&say, Level::Steps),
            json!({ "op": "terminal", "kind": "trail", "ev": "say", "ancestors": [7], "msg": "m1", "text": "I will read the file.", "final": true })
        );
        let r = line(
            &json!({ "hook_event_name": "SubagentStart", "agent_id": "ad4d", "agent_type": "Explore", "task_description": "Count files" }),
            Level::Steps,
        );
        assert_eq!(
            (
                r["ev"].as_str(),
                r["agent"].as_str(),
                r["agent_type"].as_str(),
                r["title"].as_str()
            ),
            (
                Some("agent_start"),
                Some("ad4d"),
                Some("Explore"),
                Some("Count files")
            )
        );
        let stop = json!({ "hook_event_name": "SubagentStop", "agent_id": "ad4d", "agent_type": "Explore", "last_assistant_message": "SECRET report" });
        assert!(
            line(&stop, Level::Steps)["ev"] == json!("agent_stop")
                && !has(&line(&stop, Level::Steps), "SECRET")
        );
        assert_eq!(
            line(
                &json!({ "hook_event_name": "SessionEnd", "reason": "other" }),
                Level::Steps
            )["ev"],
            json!("end")
        );
        assert_eq!(
            line(
                &json!({ "hook_event_name": "StopFailure", "error_type": "rate_limit" }),
                Level::Steps
            )["ev"],
            json!("error")
        );
        // nothing below the level steps, and nothing from what is not understood
        for level in [Level::Off, Level::Answers] {
            assert!(hook_request(&bash, &[7], level).is_none());
        }
        assert!(
            hook_request(
                &json!({ "hook_event_name": "PreToolUse", "tool_name": "Bash" }),
                &[7],
                Level::Full
            )
            .is_none(),
            "no tool_use_id"
        );
        assert!(hook_request(
            &json!({ "hook_event_name": "PreCompact" }),
            &[7],
            Level::Full
        )
        .is_none());
        assert!(hook_request(
            &json!({ "hook_event_name": "SubagentStop" }),
            &[7],
            Level::Full
        )
        .is_none());
        assert!(hook_request(&Value::Null, &[7], Level::Full).is_none());
    }

    #[test]
    fn the_level_full_adds_inputs_and_outputs_cut_and_redacted() {
        let r = line(
            &pre(
                "t1",
                "Bash",
                json!({ "command": "curl -H 'Authorization: Bearer abcdefgh12345678' https://x.example/y", "description": "Fetch" }),
            ),
            Level::Full,
        );
        assert_eq!(r["input"], json!("curl -H 'Authorization: …"));
        let r = line(
            &pre(
                "t2",
                "Edit",
                json!({ "file_path": "/home/me/p/a.rs", "old_string": "let a = 1;\nlet b = 2;", "new_string": "let a = 3;" }),
            ),
            Level::Full,
        );
        assert_eq!(
            r["input"],
            json!("/home/me/p/a.rs  −2 +1 lines\n- let a = 1;\n- let b = 2;\n+ let a = 3;")
        );
        let r = line(
            &pre(
                "t3",
                "Write",
                json!({ "file_path": "/home/me/p/.env", "content": "API_TOKEN=abc123\nNAME=web\n" }),
            ),
            Level::Full,
        );
        assert_eq!(
            r["input"],
            json!("/home/me/p/.env  2 lines\nAPI_TOKEN=…\nNAME=web")
        );
        assert_eq!(
            line(
                &pre(
                    "t4",
                    "Read",
                    json!({ "file_path": "/a/b.rs", "offset": 10, "limit": 5 })
                ),
                Level::Full
            )["input"],
            json!("/a/b.rs  lines 10–15")
        );
        let long = (1..=2000)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let post = json!({ "hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_input": { "command": "seq" }, "tool_use_id": "t5", "tool_response": { "stdout": long, "stderr": "warn: password=hunter2", "interrupted": false } });
        let out = line(&post, Level::Full)["output"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(
            out.len() <= OUTPUT_MAX + 40
                && out.starts_with("line 1\nline 2\n")
                && out.ends_with("warn: password=…"),
            "{}",
            out.len()
        );
        assert!(regex::Regex::new(r"\n… \(\d+ more lines\) …\n")
            .unwrap()
            .is_match(&out));
        let read = json!({ "hook_event_name": "PostToolUse", "tool_name": "Read", "tool_input": { "file_path": "/a" }, "tool_use_id": "t6", "tool_response": { "type": "text", "file": { "filePath": "/a", "content": "hello file\n" } } });
        assert_eq!(line(&read, Level::Full)["output"], json!("hello file"));
        let fail = json!({ "hook_event_name": "PostToolUseFailure", "tool_name": "Bash", "tool_input": { "command": "ls /x" }, "tool_use_id": "t7", "error": "Exit code 2\nls: cannot access '/x'" });
        assert_eq!(
            line(&fail, Level::Full)["output"],
            json!("Exit code 2\nls: cannot access '/x'")
        );
        let stop = json!({ "hook_event_name": "SubagentStop", "agent_id": "ad4d", "last_assistant_message": "Found 5 files." });
        assert_eq!(line(&stop, Level::Full)["output"], json!("Found 5 files."));
        // a board tool's arguments are on the board already, never in the trail
        let r = line(
            &pre("t8", "mcp__trommi__reply", json!({ "text": "hello" })),
            Level::Full,
        );
        assert!(r.get("input").is_none() && r["board"] == json!(true));
        // one huge line
        let one = "x ".repeat(20_000);
        let e = excerpt(&one, 1000);
        assert!(
            e.len() < 1100 && e.contains("more characters) …"),
            "{}",
            e.len()
        );
        assert_eq!(excerpt("short\n", 1000), "short");
    }

    #[test]
    fn what_looks_like_a_secret_is_taken_out() {
        for (text, want) in [
            ("export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwx", "export GITHUB_TOKEN=…"),
            ("AWS_SECRET_ACCESS_KEY=\"wJalr/XUtn+FEMI\" next", "AWS_SECRET_ACCESS_KEY=… next"),
            ("DB_PASSWORD='p w' PORT=8080", "DB_PASSWORD=… PORT=8080"),
            ("{\"api_key\": \"abc\", \"name\": \"web\"}", "{\"api_key\": …, \"name\": \"web\"}"),
            ("password: hunter2", "password: …"),
            ("mytool --token abc123 --verbose", "mytool --token … --verbose"),
            ("mytool --api-key=abc123 run", "mytool --api-key=… run"),
            ("Authorization: Bearer abc.def.ghi\nAccept: */*", "Authorization: …\nAccept: */*"),
            ("curl -H \"X-Api-Key: 12345\" -H 'Cookie: sid=1; x=2' https://a.example", "curl -H \"X-Api-Key: …"),
            ("git clone https://me:hunter2@github.com/a/b.git", "git clone https://…@github.com/a/b.git"),
            ("token sk-abcdefgh12345678 and AKIAABCDEFGHIJKLMNOP", "token … and …"),
            ("sha 0123456789abcdef0123456789abcdef01234567 ok", "sha … ok"),
            ("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNz\nAAAA\n-----END OPENSSH PRIVATE KEY-----\nafter", "-----BEGIN PRIVATE KEY----- … -----END PRIVATE KEY-----\nafter"),
            ("-----BEGIN RSA PRIVATE KEY-----\nMIIE cut off", "-----BEGIN PRIVATE KEY----- … -----END PRIVATE KEY-----"),
        ] {
            assert_eq!(redact(text), want, "{text}");
        }
        // and what stays: paths, plain words, short values, ordinary assignments
        for text in [
            "/home/me/git/trommi/connector-rs/src/connector/trail.rs",
            "the key is under the mat",
            "PORT=8080 NODE_ENV=production",
            "let total = a + b;",
            "cargo test --release -- --nocapture",
        ] {
            assert_eq!(redact(text), text);
        }
    }

    fn ev(v: Value) -> Value {
        let mut o = v.as_object().cloned().unwrap();
        o.insert("op".into(), json!("terminal"));
        o.insert("kind".into(), json!("trail"));
        Value::Object(o)
    }
    /// A client's view: the envelopes of a turn folded, items by id in the order they first came.
    fn folded_turns(envs: &[Envelope]) -> Vec<(Option<String>, Value)> {
        let mut out: Vec<(Option<String>, Value)> = vec![];
        for e in envs {
            let w = &e.work;
            let at = match out.iter().position(|(_, t)| t["turn"] == w["turn"]) {
                Some(i) => i,
                None => {
                    out.push((
                        e.target.clone(),
                        json!({ "turn": w["turn"], "items": [], "seq": 0 }),
                    ));
                    out.len() - 1
                }
            };
            let t = &mut out[at].1;
            assert_eq!(
                w["seq"].as_u64().unwrap(),
                t["seq"].as_u64().unwrap() + 1,
                "the envelopes of a turn are numbered"
            );
            for k in ["seq", "state", "started_at", "ended_at", "more"] {
                if let Some(v) = w.get(k) {
                    t[k] = v.clone();
                }
            }
            for item in w["items"].as_array().unwrap() {
                let items = t["items"].as_array_mut().unwrap();
                match items.iter().position(|x| x["id"] == item["id"]) {
                    Some(i) => items[i] = item.clone(),
                    None => items.push(item.clone()),
                }
            }
        }
        out
    }
    fn brief(t: &Value) -> Vec<String> {
        t["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| {
                format!(
                    "{} {} {}",
                    i["kind"].as_str().unwrap(),
                    i.get("tool")
                        .or(i.get("text"))
                        .and_then(|v| v.as_str())
                        .unwrap_or(""),
                    i.get("state").and_then(|v| v.as_str()).unwrap_or("")
                )
                .trim()
                .to_string()
            })
            .collect()
    }

    #[test]
    fn a_turn_is_one_trail_in_few_envelopes() {
        let mut t = Trail::default();
        let mut sent: Vec<Envelope> = vec![];
        t.prompt("", 1_000);
        assert!(
            !t.dirty() && t.flush().is_empty(),
            "a prompt alone sends nothing"
        );
        t.event(
            &ev(json!({ "ev": "say", "msg": "m1", "text": "I will ", "final": false })),
            1_100,
        );
        t.event(
            &ev(json!({ "ev": "say", "msg": "m1", "text": "read the file.", "final": true })),
            1_200,
        );
        assert!(!t.dirty(), "the last words wait: they may be the answer");
        t.event(
            &ev(json!({ "ev": "pre", "id": "s1", "tool": "Read", "subject": "a.txt" })),
            1_300,
        );
        assert!(t.dirty());
        sent.extend(t.flush());
        assert_eq!(sent.len(), 1);
        assert_eq!(
            sent[0].work["items"],
            json!([{ "id": "say:1", "kind": "text", "text": "I will read the file.", "at": 1_300 }, { "id": "s1", "kind": "step", "state": "running", "at": 1_300, "tool": "Read", "subject": "a.txt" }])
        );
        assert_eq!(
            (
                sent[0].work["state"].as_str(),
                sent[0].work["started_at"].as_u64(),
                sent[0].work["seq"].as_u64(),
                sent[0].target.clone()
            ),
            (Some("running"), Some(1_000), Some(1), None)
        );
        // many steps between two flushes are one envelope
        t.event(
            &ev(json!({ "ev": "post", "id": "s1", "tool": "Read", "ms": 6 })),
            1_310,
        );
        for i in 0..40 {
            t.event(
                &ev(json!({ "ev": "pre", "id": format!("b{i}"), "tool": "Bash", "title": "Run" })),
                1_400 + i,
            );
            t.event(&ev(json!({ "ev": if i == 7 { "fail" } else { "post" }, "id": format!("b{i}"), "tool": "Bash", "ms": 20 })), 1_420 + i);
        }
        let more = t.flush();
        assert_eq!(more.len(), 1, "coalesced");
        assert_eq!(
            more[0].work["items"].as_array().unwrap().len(),
            41,
            "the changed step and the new ones, each once"
        );
        sent.extend(more);
        assert!(!t.dirty() && t.flush().is_empty());
        // the final answer is not a text of the trail
        t.event(
            &ev(json!({ "ev": "say", "msg": "m2", "text": "All  done.\n", "final": true })),
            2_000,
        );
        t.answer("", Some("All done."), 2_100);
        sent.extend(t.flush());
        let turns = folded_turns(&sent);
        assert_eq!(turns.len(), 1);
        let turn = &turns[0].1;
        assert_eq!(
            (
                turn["state"].as_str(),
                turn["ended_at"].as_u64(),
                turn["seq"].as_u64()
            ),
            (Some("done"), Some(2_100), Some(3))
        );
        let b = brief(turn);
        assert_eq!(b.len(), 42);
        assert_eq!(
            &b[..3],
            ["text I will read the file.", "step Read ok", "step Bash ok"]
        );
        assert_eq!(b[9], "step Bash failed");
        assert!(
            !sent.iter().any(|e| e.work.to_string().contains("All done")),
            "the answer goes as its own message"
        );
        // the answer's own words, brought late by their hook, open nothing
        t.event(
            &ev(json!({ "ev": "say", "msg": "m2b", "text": "All done.", "final": true })),
            2_150,
        );
        t.prompt("", 2_900);
        assert!(t.flush().is_empty());
        // a turn without a step sends nothing at all
        t.prompt("", 3_000);
        t.event(
            &ev(json!({ "ev": "say", "msg": "m3", "text": "Hello.", "final": true })),
            3_100,
        );
        t.answer("", Some("Hello."), 3_200);
        assert!(t.flush().is_empty());
        // words that are not the answer stand in the trail
        t.prompt("", 4_000);
        t.event(
            &ev(json!({ "ev": "say", "msg": "m4", "text": "Something else.", "final": true })),
            4_100,
        );
        t.answer("", Some("The answer."), 4_200);
        let last = t.flush();
        assert_eq!(brief(&folded_turns(&last)[0].1), ["text Something else."]);
    }

    #[test]
    fn a_turn_that_breaks_off_is_closed_as_interrupted() {
        // Esc fires no hook (Claude Code 2.1.286): the next prompt, which has another prompt_id, closes the turn.
        // When it broke off nobody knows: no ended_at.
        let mut t = Trail::default();
        assert!(!t.prompt("p1", 1_000));
        t.event(&ev(json!({ "ev": "pre", "id": "s1", "tool": "Bash", "title": "Sleep", "prompt": "p1" })), 1_100);
        let mut sent = t.flush();
        t.event(&ev(json!({ "ev": "say", "msg": "m1", "text": "Half a thought", "final": true, "prompt": "p1" })), 1_200);
        assert!(!t.prompt("p2", 5_000), "a prompt of another turn");
        sent.extend(t.flush());
        let turn = &folded_turns(&sent)[0].1;
        assert_eq!(
            (turn["state"].as_str(), turn.get("ended_at")),
            (Some("interrupted"), None)
        );
        assert_eq!(
            brief(turn),
            ["step Bash interrupted", "text Half a thought"]
        );
        // a step that says it was interrupted (is_interrupt) closes the turn at once, with the time
        t.event(
            &ev(json!({ "ev": "pre", "id": "s2", "tool": "Bash", "prompt": "p2" })),
            5_100,
        );
        t.event(&ev(json!({ "ev": "fail", "id": "s2", "tool": "Bash", "interrupt": true, "ms": 900, "prompt": "p2" })), 6_000);
        let turn = &folded_turns(&t.flush())[0].1;
        assert_eq!(
            (
                turn["state"].as_str(),
                turn["started_at"].as_u64(),
                turn["ended_at"].as_u64(),
                brief(turn)
            ),
            (
                Some("interrupted"),
                Some(5_000),
                Some(6_000),
                vec!["step Bash interrupted".to_string()]
            )
        );
        // the session ends, an API error ends the turn
        t.prompt("p3", 7_000);
        t.event(
            &ev(json!({ "ev": "pre", "id": "s3", "tool": "Read", "prompt": "p3" })),
            7_100,
        );
        t.event(&ev(json!({ "ev": "end" })), 7_200);
        assert_eq!(folded_turns(&t.flush())[0].1["state"], json!("interrupted"));
        t.prompt("p4", 8_000);
        t.event(
            &ev(json!({ "ev": "pre", "id": "s4", "tool": "Read", "prompt": "p4" })),
            8_100,
        );
        t.event(
            &ev(json!({ "ev": "post", "id": "s4", "tool": "Read", "prompt": "p4" })),
            8_150,
        );
        t.event(&ev(json!({ "ev": "error", "prompt": "p4" })), 8_200);
        let turn = &folded_turns(&t.flush())[0].1;
        assert_eq!(
            (turn["state"].as_str(), brief(turn)),
            (Some("failed"), vec!["step Read ok".to_string()])
        );
        // a session's end with nothing open sends nothing
        t.event(&ev(json!({ "ev": "end" })), 9_000);
        assert!(t.flush().is_empty());
        // a turn broken off while a queued prompt's turn starts without a UserPromptSubmit of its own: the first
        // step with another prompt_id closes it
        t.prompt("p5", 10_000);
        t.event(
            &ev(json!({ "ev": "pre", "id": "s5", "tool": "Read", "prompt": "p5" })),
            10_100,
        );
        t.event(
            &ev(json!({ "ev": "pre", "id": "s6", "tool": "Read", "prompt": "p6" })),
            11_000,
        );
        let turns = folded_turns(&t.flush());
        assert_eq!(turns.len(), 2);
        assert_eq!(
            (
                turns[0].1["state"].as_str(),
                turns[1].1["state"].as_str(),
                turns[1].1["started_at"].as_u64()
            ),
            (Some("interrupted"), Some("running"), Some(11_000))
        );
    }

    #[test]
    fn a_prompt_typed_while_a_turn_runs_does_not_end_its_trail() {
        // As Claude Code 2.1.286 fires them: the prompt typed during the first command comes at once, with the
        // running turn's prompt_id; the turn goes on to its Stop.
        let mut t = Trail::default();
        assert!(!t.prompt("p1", 1_000));
        t.event(&ev(json!({ "ev": "pre", "id": "s1", "tool": "Bash", "title": "First", "prompt": "p1" })), 1_100);
        let mut sent = t.flush();
        assert!(
            t.prompt("p1", 4_000),
            "the same prompt_id: it came into the running turn"
        );
        assert!(t.flush().is_empty(), "and changes nothing in the trail");
        t.event(
            &ev(json!({ "ev": "post", "id": "s1", "tool": "Bash", "ms": 7_000, "prompt": "p1" })),
            8_100,
        );
        t.event(&ev(json!({ "ev": "pre", "id": "s2", "tool": "Bash", "title": "Second", "prompt": "p1" })), 8_200);
        t.event(&ev(json!({ "ev": "fail", "id": "s2", "tool": "Bash", "ms": 17, "exit": 1, "prompt": "p1" })), 8_300);
        t.answer("p1", Some("Done."), 9_000);
        sent.extend(t.flush());
        let turns = folded_turns(&sent);
        assert_eq!(turns.len(), 1, "one turn, one trail");
        let turn = &turns[0].1;
        assert_eq!(
            (
                turn["state"].as_str(),
                turn["started_at"].as_u64(),
                turn["ended_at"].as_u64()
            ),
            (Some("done"), Some(1_000), Some(9_000))
        );
        assert_eq!(brief(turn), ["step Bash ok", "step Bash failed"]);
        assert_eq!(
            turn["items"][1]["exit"],
            json!(1),
            "a command's exit code stands on its step"
        );
        assert!(turn["items"][0].get("exit").is_none());
        // typed while the last words stream: the hook has the old turn's id, that turn stops, and the queued prompt
        // runs as a turn of its own with a new id and no UserPromptSubmit
        assert!(!t.prompt("p2", 10_000));
        t.event(
            &ev(json!({ "ev": "pre", "id": "s3", "tool": "Read", "prompt": "p2" })),
            10_100,
        );
        assert!(t.prompt("p2", 10_200));
        t.event(
            &ev(json!({ "ev": "post", "id": "s3", "tool": "Read", "prompt": "p2" })),
            10_300,
        );
        t.answer("p2", Some("An essay."), 11_000);
        t.event(&ev(json!({ "ev": "say", "msg": "m9", "text": "Late words of the turn that is over.", "final": true, "prompt": "p2" })), 11_050);
        t.event(
            &ev(json!({ "ev": "pre", "id": "s4", "tool": "Read", "prompt": "p3" })),
            11_100,
        );
        t.event(
            &ev(json!({ "ev": "post", "id": "s4", "tool": "Read", "prompt": "p3" })),
            11_200,
        );
        t.answer("p3", Some("Was that a typo?"), 12_000);
        let turns = folded_turns(&t.flush());
        assert_eq!(
            turns
                .iter()
                .map(|(_, w)| (
                    w["state"].as_str().unwrap(),
                    w["started_at"].as_u64().unwrap(),
                    brief(w)
                ))
                .collect::<Vec<_>>(),
            vec![
                ("done", 10_000, vec!["step Read ok".to_string()]),
                ("done", 11_100, vec!["step Read ok".to_string()])
            ]
        );
        // a step's end that comes after Stop (its hook is async) still lands on its step
        assert!(!t.prompt("p4", 20_000));
        t.event(
            &ev(json!({ "ev": "pre", "id": "s5", "tool": "Read", "prompt": "p4" })),
            20_100,
        );
        t.answer("p4", Some("Read."), 20_200);
        let mut sent = t.flush();
        t.event(
            &ev(json!({ "ev": "post", "id": "s5", "tool": "Read", "ms": 5, "prompt": "p4" })),
            20_210,
        );
        sent.extend(t.flush());
        let turn = &folded_turns(&sent)[0].1;
        assert_eq!(
            (turn["state"].as_str(), brief(turn)),
            (Some("done"), vec!["step Read ok".to_string()])
        );
        // a Stop hook that sends the agent back to work: the turn runs on under its id, and ends again
        t.event(
            &ev(json!({ "ev": "pre", "id": "s6", "tool": "Bash", "prompt": "p4" })),
            21_000,
        );
        sent.extend(t.flush());
        assert_eq!(folded_turns(&sent)[0].1["state"], json!("running"));
        t.event(
            &ev(json!({ "ev": "post", "id": "s6", "tool": "Bash", "prompt": "p4" })),
            21_100,
        );
        t.answer("p4", Some("Now really."), 21_200);
        sent.extend(t.flush());
        let turns = folded_turns(&sent);
        assert_eq!(
            (
                turns.len(),
                turns[0].1["state"].as_str(),
                turns[0].1["ended_at"].as_u64(),
                brief(&turns[0].1).len()
            ),
            (1, Some("done"), Some(21_200), 2)
        );
    }

    #[test]
    fn without_prompt_ids_no_turn_is_called_interrupted() {
        // hooks that carry no prompt_id: nothing tells a prompt into the running turn from one after Esc, so the
        // trail goes on and ends with the next Stop
        let mut t = Trail::default();
        assert!(!t.prompt("", 1_000));
        t.event(
            &ev(json!({ "ev": "pre", "id": "s1", "tool": "Bash" })),
            1_100,
        );
        t.event(
            &ev(json!({ "ev": "post", "id": "s1", "tool": "Bash" })),
            1_200,
        );
        assert!(t.prompt("", 2_000));
        t.event(
            &ev(json!({ "ev": "pre", "id": "s2", "tool": "Bash" })),
            2_100,
        );
        t.event(
            &ev(json!({ "ev": "post", "id": "s2", "tool": "Bash" })),
            2_200,
        );
        t.answer("", Some("Done."), 3_000);
        let turns = folded_turns(&t.flush());
        assert_eq!(
            (
                turns.len(),
                turns[0].1["state"].as_str(),
                brief(&turns[0].1).len()
            ),
            (1, Some("done"), 2)
        );
    }

    #[test]
    fn a_commands_exit_code_is_read_from_claude_codes_error() {
        assert_eq!(exit_code("Bash", "Exit code 1"), Some(1));
        assert_eq!(
            exit_code("Bash", "Exit code 127\nsh: nope: command not found"),
            Some(127)
        );
        for (tool, error) in [
            ("Bash", "Command timed out after 2m 0s"),
            ("Bash", "Exit code 0"),
            ("Bash", "Exit code x"),
            ("Bash", ""),
            ("Read", "Exit code 1"),
            ("Bash", "the Exit code 1"),
        ] {
            assert_eq!(exit_code(tool, error), None, "{tool} {error}");
        }
        // as Claude Code 2.1.286 sends a shell loop whose last test was false
        let fail = json!({ "hook_event_name": "PostToolUseFailure", "prompt_id": "a089", "tool_name": "Bash", "tool_input": { "command": "for f in a b; do [ \"$f\" = c ] && echo hit; done", "description": "Run the loop" }, "tool_use_id": "t1", "error": "Exit code 1", "is_interrupt": false, "duration_ms": 17 });
        assert_eq!(
            line(&fail, Level::Steps),
            json!({ "op": "terminal", "kind": "trail", "ev": "fail", "ancestors": [7], "id": "t1", "tool": "Bash", "title": "Run the loop", "exit": 1, "ms": 17, "prompt": "a089" })
        );
    }

    #[test]
    fn helpers_are_a_line_in_their_callers_trail_or_a_trail_of_their_own() {
        let mut t = Trail::default();
        t.prompt("", 1_000);
        t.event(&ev(json!({ "ev": "pre", "id": "s1", "tool": "Agent", "title": "Count files", "subject": "Explore" })), 1_100);
        t.event(
            &ev(json!({ "ev": "post", "id": "s1", "tool": "Agent", "ms": 3 })),
            1_110,
        );
        t.event(&ev(json!({ "ev": "agent_start", "agent": "a1", "agent_type": "Explore", "title": "Count files" })), 1_120);
        // a helper without a board session: counted
        for i in 0..3 {
            t.event(
                &ev(json!({ "ev": "pre", "id": format!("h{i}"), "tool": "Bash", "agent": "a1" })),
                1_200 + i,
            );
            t.event(
                &ev(json!({ "ev": "post", "id": format!("h{i}"), "tool": "Bash", "agent": "a1" })),
                1_210 + i,
            );
        }
        t.event(&ev(json!({ "ev": "say", "msg": "x", "text": "a helper's words", "final": true, "agent": "a1" })), 1_300);
        // a second helper names its board session: its steps are that session's trail
        t.event(&ev(json!({ "ev": "agent_start", "agent": "a2", "agent_type": "general-purpose", "title": "Design the page" })), 1_400);
        t.event(&ev(json!({ "ev": "pre", "id": "d0", "tool": "Read", "subject": "x.css", "agent": "a2" })), 1_410);
        t.event(&ev(json!({ "ev": "pre", "id": "d1", "tool": "plugin_trommi_trommi: set_status", "board": true, "session": "Design", "agent": "a2" })), 1_420);
        t.event(&ev(json!({ "ev": "pre", "id": "d2", "tool": "Edit", "subject": "x.css", "agent": "a2" })), 1_430);
        t.event(
            &ev(json!({ "ev": "post", "id": "d2", "tool": "Edit", "agent": "a2", "ms": 4 })),
            1_440,
        );
        // the turn ends while the helpers still run (in the background)
        t.answer("", Some("Started two helpers."), 1_500);
        let mut sent = t.flush();
        t.event(&ev(json!({ "ev": "agent_stop", "agent": "a1" })), 9_000);
        t.event(&ev(json!({ "ev": "agent_stop", "agent": "a2" })), 9_500);
        sent.extend(t.flush());
        let turns = folded_turns(&sent);
        assert_eq!(turns.len(), 2);
        let (main, child) = (&turns[0], &turns[1]);
        assert_eq!(
            (main.0.clone(), main.1["state"].as_str()),
            (None, Some("done"))
        );
        assert_eq!(
            brief(&main.1),
            [
                "step Agent ok",
                "helper Explore ok",
                "helper general-purpose ok"
            ]
        );
        assert_eq!(
            (
                main.1["items"][1]["steps"].as_u64(),
                main.1["items"][1]["ms"].as_u64(),
                main.1["items"][2]["steps"].as_u64()
            ),
            (Some(3), Some(7_880), Some(1))
        );
        assert_eq!(
            (
                child.0.as_deref(),
                child.1["state"].as_str(),
                child.1["ended_at"].as_u64()
            ),
            (Some("Design"), Some("done"), Some(9_500))
        );
        assert_eq!(brief(&child.1), ["step Edit ok"]);
        assert!(!sent
            .iter()
            .any(|e| e.work.to_string().contains("helper's words")
                || e.work.to_string().contains("set_status")));
    }

    #[test]
    fn a_trail_has_its_limits() {
        let mut t = Trail::default();
        t.prompt("", 1_000);
        for i in 0..(ITEMS_MAX + 25) {
            t.event(&ev(json!({ "ev": "pre", "id": format!("s{i}"), "tool": "Bash", "input": "x".repeat(1_500) })), 1_100);
            t.event(&ev(json!({ "ev": "post", "id": format!("s{i}"), "tool": "Bash", "output": "y".repeat(3_000) })), 1_200);
        }
        t.answer("", None, 2_000);
        let sent = t.flush();
        assert!(sent.len() > 10, "split by weight: {}", sent.len());
        for e in &sent {
            assert!(
                e.work.to_string().len() <= ENVELOPE_MAX + 500,
                "{}",
                e.work.to_string().len()
            );
        }
        let turn = &folded_turns(&sent)[0].1;
        assert_eq!(
            (
                turn["items"].as_array().unwrap().len(),
                turn["more"].as_u64()
            ),
            (ITEMS_MAX, Some(25))
        );
        // old turns leave
        for i in 0..20u64 {
            t.prompt("", 10_000 + i * 10);
            t.event(
                &ev(json!({ "ev": "pre", "id": format!("z{i}"), "tool": "Read" })),
                10_001 + i * 10,
            );
            t.answer("", None, 10_002 + i * 10);
            t.flush();
        }
        assert!(t.turns.len() <= TURNS_KEPT);
    }
}
