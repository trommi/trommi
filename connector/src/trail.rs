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
/// The most turns a `Trail` keeps: closed ones beyond this leave, oldest first.
pub const TURNS_KEPT: usize = 8;

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
        if (spaced && !name.starts_with('-')) || value == "…" || value.starts_with('…') {
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
    while head < lines.len() && used + lines[head].len() < head_max {
        used += lines[head].len() + 1;
        head += 1;
    }
    used = 0;
    while tail > head && used + lines[tail - 1].len() < tail_max {
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

/// One turn's trail as the connector holds it: its head, its items, and what of them is not sent yet.
pub struct Turn {
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
    /// The turns held, oldest first: the open ones and at most TURNS_KEPT in all once the closed ones left.
    pub turns: Vec<Turn>,
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
