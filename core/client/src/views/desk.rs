//! The Desk: its head (the greeting, the goals, the sessions that are cut off) and the stack of what waits for the
//! person as rows, each with the answers it offers. A shell draws the rows one after the other and decides nothing.
//!
//! The rules are the web's of before (`desk.mjs` `deskHead`, `deskList`, `runs`; `ui.mjs` `deskRow`, `tiles`):
//! - the rows are the walk: the Desk's stack less what is with its agent, and the open approval requests, of the
//!   team in view, in the core's order (`Model::desk_order`); what the order does not name yet stands last;
//! - a card not read on this device yet and a card of a newer Trommi stand as something to read, with nothing to
//!   answer;
//! - a row offers its answers itself when they are two (a yes and a no as thumbs, two named ways as tiles), or
//!   when its agent advises exactly one way; else one tile opens the card.

use super::board::{is_loading, key_of, reads_as_info, Board, DEFAULT_TEAM};
use super::sidebar::units_of;
use super::links::plain;
use super::words::{say, GREETINGS, CALM};
use super::{DeskRowView, DeskView, FromView, GoalsView, MediaView, SlipView, Text, TileView, TilesView};
use crate::model::types::{Card, PermissionRequest};
use serde_json::Value;

pub const NEEDS_NEWER: &str = "This needs a newer version of Trommi. Update Trommi to see it.";

pub fn desk(b: &Board) -> DeskView {
    desk_with(b, &super::off::of_board(b))
}

/// The Desk, with what has left it as the core's `off_mind` says (made once per render).
pub fn desk_with(b: &Board, off: &crate::off_mind::OffMind) -> DeskView {
    let m = b.model;
    // (home holds every team's sessions; else the team in view's)
    let units = if b.lens.desk_all { super::sidebar::units_all(b) } else { units_of(b) };
    let agent_of = |session: &Option<String>, device: &str| b.by_key.get(key_of(session, device)).copied();

    // ---- the rows ----
    // What waits on the team in view: the stack's cards that are not with their agent, and the open requests.
    let mut waiting: Vec<&str> = m
        .stack
        .iter()
        .filter_map(|id| m.cards.get(id))
        .filter(|c| c.object_state == "open" && !c.catching_up && c.in_revision.is_none() && b.on_desk(agent_of(&c.session_id, &c.agent_device_id)))
        .map(|c| c.object_id.as_str())
        .chain(
            m.open_permission_ids
                .iter()
                .filter_map(|id| m.permissions.get(id))
                .filter(|p| p.permission_state == "pending" && !p.catching_up && b.on_desk(agent_of(&p.session_id, &p.agent_device_id)))
                .map(|p| p.object_id.as_str()),
        )
        .collect();
    // (in the core's order; a card it does not name yet, between two projections, stands last until it does)
    let mut walk: Vec<&str> = Vec::with_capacity(waiting.len());
    for id in &m.desk_order {
        if let Some(at) = waiting.iter().position(|w| w == id) {
            walk.push(waiting.remove(at));
        }
    }
    walk.append(&mut waiting);
    let walk_len = walk.len() as u32;
    let mut rows: Vec<DeskRowView> = walk
        .iter()
        .filter_map(|id| match (m.cards.get(*id), m.permissions.get(*id)) {
            (Some(c), _) => Some(card_row(b, c, agent_of(&c.session_id, &c.agent_device_id))),
            (None, Some(p)) => Some(request_row(b, p, agent_of(&p.session_id, &p.agent_device_id))),
            _ => None,
        })
        // (a row whose session the list does not show has no place among the runs)
        .filter(|r| r.from.is_some())
        .collect();
    let mut at = 0;
    while at < rows.len() {
        let sender = rows[at].from.as_ref().map(|f| f.session_id.clone());
        let n = rows[at..].iter().take_while(|r| r.from.as_ref().map(|f| &f.session_id) == sender.as_ref()).count();
        rows[at].run = n as u32;
        at += n;
    }

    // ---- the head ----
    let questions = b.all_fresh.iter().filter(|f| b.on_desk(f.agent)).count() as u32;
    let cut: Vec<SlipView> = units
        .iter()
        .filter_map(|u| u.link.as_ref().filter(|l| l.state == "cut").map(|l| (u, l)))
        .map(|(u, l)| {
            let a = &b.agents[u.agent];
            let at = l.word.as_ref().and_then(|w| w.args.get("at")).cloned().unwrap_or_default();
            let since = if at.is_empty() { String::new() } else { format!(" since {at}") };
            SlipView {
                session_id: a.row.key.clone(),
                text: say(
                    "desk.slip.cut",
                    format!("{} is cut off{since}: it cannot hear you and cannot write to you.", a.row.name),
                    &[("name", &a.row.name), ("at", &at)],
                ),
                fix: l.fix.clone().unwrap_or_default(),
            }
        })
        .collect();
    let unheard: u32 = units.iter().map(|u| u.unheard).sum();
    let reading = b.lens.reading;
    let progress = b.lens.reading_progress.filter(|(_, total)| *total > 0).map(|(done, total)| {
        let (d, t) = (grouped(done), grouped(total));
        say("desk.reading", format!("Reading your history: {d} of {t}"), &[("done", &d), ("total", &t)])
    });
    let (mode, hello) = if units.is_empty() {
        if reading {
            ("reading", Some(say("desk.hello.catching_up", "Catching up…", &[])))
        } else {
            ("invite", None)
        }
    } else {
        // (still reading the room: no "all quiet" while questions may yet come in)
        let unquiet = match (cut.len(), unheard) {
            (1, _) => Some(say("desk.hello.cut_one", "One can’t hear you.", &[("n", "1")])),
            (n, _) if n > 1 => Some(say("desk.hello.cut_some", "Some can’t hear you.", &[])),
            (_, 1) => Some(say("desk.hello.unheard_one", "An answer waits.", &[("n", "1")])),
            (_, n) if n > 1 => Some(say("desk.hello.unheard_some", "Answers wait.", &[])),
            _ => None,
        };
        let hello = if questions == 0 && reading {
            say("desk.hello.catching_up", "Catching up…", &[])
        } else if let Some(u) = unquiet.filter(|_| questions == 0) {
            u
        } else {
            // (calm while no question waits, with only something to read open too: the owner, 13 October 2026,
            // card b4a26358 item 3, the iPhone's rule; the web greeted as for a question)
            greeting(questions == 0, b.lens.dice)
        };
        ("desk", Some(hello))
    };
    // (goals are a team's: home shows none)
    let goals = (!units.is_empty() && !b.lens.desk_all).then(|| {
        let team = b.team.clone().unwrap_or_else(|| DEFAULT_TEAM.into());
        let text = b.teams.iter().find(|d| d.id == team).map(|d| d.goals.as_str()).unwrap_or("");
        let lines: Vec<String> = if text.is_empty() { Vec::new() } else { text.split('\n').map(String::from).collect() };
        let n = lines.len().to_string();
        let foldable = lines.len() > 1;
        let folded = foldable && b.lens.goals_folded.contains(&team);
        let show_all = foldable.then(|| say("desk.goals.show_all", format!("Show all {n} goals"), &[("n", &n)]));
        GoalsView {
            toggle: if folded { show_all.clone() } else { foldable.then(|| say("desk.goals.fold", "Show the first goal only", &[])) },
            team_id: team,
            foldable,
            show_all,
            folded,
            lines,
        }
    });
    // (a team's knowledge, as its goals: home shows none)
    let knowledge = (!units.is_empty() && !b.lens.desk_all).then(|| super::knowledge::chip(b));
    // Nothing is open at all (what is with an agent counts as open): the list's place says so.
    let any_open = walk_len > 0
        || m.cards.values().any(|c| {
            let agent = agent_of(&c.session_id, &c.agent_device_id);
            // (an info its agent still works on is with the agent from the start, never on the Desk's stack)
            let works = c.field("working") == Value::Bool(true) && c.snoozed_until.is_none() && !agent.is_some_and(|i| b.agents[i].row.archived);
            c.object_state == "open" && !c.catching_up && b.on_desk(agent) && (m.stack.contains(&c.object_id) || works)
        });
    let empty = (!any_open).then(|| {
        if reading {
            say("desk.empty.reading", "Catching up: reading your sessions on this device. Their open questions show here as they are read.", &[])
        } else {
            say("desk.empty", "Questions land here.", &[])
        }
    });
    let n = walk_len.to_string();
    let mut view = DeskView {
        stack: rows.iter().map(|r| r.id.clone()).collect(),
        empty,
        mode: mode.into(),
        hello,
        reading: progress.filter(|_| reading),
        goals,
        knowledge,
        rows,
        waiting: questions,
        blitz: (walk_len > 0 && !units.is_empty()).then(|| {
            if walk_len == 1 {
                say("desk.blitz.one", "Blitz: 1 open card", &[("n", "1")])
            } else {
                say("desk.blitz", format!("Blitz: {n} open cards"), &[("n", &n)])
            }
        }),
        slip: cut,
        ..Default::default()
    };
    // (beside Blitz, as on the web: where Blitz shows)
    view.duck = view.blitz.as_ref().and_then(|_| duck_all(&view.rows));
    super::off::fill_desk(b, off, &mut view);
    view
}

/// The duck for all over the Desk's rows: a decision goes to its agent, a card to read is closed; a request, and a
/// card not read here yet, are never touched (the web's `duckAll`, the iPhone's `DeskTools`).
fn duck_all(rows: &[DeskRowView]) -> Option<super::DuckAllView> {
    let mine = |kind: &str| rows.iter().filter(|r| r.kind == kind && !r.loading && !r.newer).count();
    let (asks, reads) = (mine("decision"), mine("info"));
    let n = asks + reads;
    if n == 0 {
        return None;
    }
    let card_ids = rows.iter().filter(|r| matches!(r.kind.as_str(), "decision" | "info") && !r.loading && !r.newer).map(|r| r.id.clone()).collect();
    let (ns, a, r) = (n.to_string(), asks.to_string(), reads.to_string());
    let args: &[(&str, &str)] = &[("n", &ns), ("decisions", &a), ("reads", &r)];
    let goes = if asks == 1 { "1 decision goes".to_string() } else { format!("{asks} decisions go") };
    let closed = if reads == 1 { "1 card to read is".to_string() } else { format!("{reads} cards to read are") };
    let (ask, yes) = match (asks > 0, n == 1) {
        (true, true) => (say("desk.duck.ask.one", "Duck it?", args), say("desk.duck.yes.one", "Yes, duck it", args)),
        (true, false) => (say("desk.duck.ask", format!("Duck all {n}?"), args), say("desk.duck.yes", "Yes, duck them all", args)),
        (false, true) => (say("desk.duck.ask.read_one", "Close it as read?", args), say("desk.duck.yes.read_one", "Yes, read", args)),
        (false, false) => (say("desk.duck.ask.read", format!("Close all {n} as read?"), args), say("desk.duck.yes.read", "Yes, all read", args)),
    };
    let what = if reads == 0 {
        say("desk.duck.what.go", format!("{goes} to the agents"), args)
    } else if asks == 0 {
        say("desk.duck.what.read", format!("{closed} closed"), args)
    } else {
        say("desk.duck.what", format!("{goes} to the agents, {closed} closed"), args)
    };
    let tip = match (reads == 0, asks == 0, n == 1) {
        (true, _, true) => say("desk.duck.tip.one", "I don’t give a duck: for the one open decision", args),
        (true, _, false) => say("desk.duck.tip", format!("I don’t give a duck: for all {n} open decisions"), args),
        (false, true, true) => say("desk.duck.tip.read_one", "I don’t give a duck: close the one card to read", args),
        (false, true, false) => say("desk.duck.tip.read", format!("I don’t give a duck: close all {n} cards to read"), args),
        _ => say("desk.duck.tip.all", format!("I don’t give a duck: for all {n} open cards"), args),
    };
    let short = say("desk.duck.short", "IDGAD", &[]);
    Some(super::DuckAllView { card_ids, tip, short, what, ask, yes, no: say("desk.duck.no", "Cancel", &[]) })
}

/// The tiles under the Desk's questions (`DeskView.tiles`): what runs and is done (from `desk.off`), what the agents
/// published (`all`, the newest first), the team's Scribble Board (`team`: none on All teams), and the team's
/// Knowledge (from `desk.knowledge`; not on All teams). The board's
/// line and count come with its small picture ([`board_tile`]).
pub fn desk_tiles(desk: &DeskView, all: &[super::ArtifactView], team: Option<&str>) -> Vec<super::DeskTileView> {
    let none = || say("desk.tile.none", "Nothing yet", &[]);
    let work = super::DeskTileView {
        key: "work".into(),
        title: say("desk.tile.work", "Working / Done", &[]),
        line: desk.off.as_ref().map(|o| o.line.clone()).filter(|l| !l.en.is_empty()).unwrap_or_else(none),
        count: None,
        opens: super::Screen::Off { query: String::new() },
        items: desk.off.as_ref().map(|o| o.running.iter().map(|r| r.id.clone()).collect()).unwrap_or_default(),
        team_id: None,
    };
    let n = all.len();
    let artifacts = super::DeskTileView {
        key: "artifacts".into(),
        title: say("desk.tile.artifacts", "Artifacts", &[]),
        line: match n {
            0 => none(),
            1 => say("desk.tile.artifacts.one", "1 artifact", &[]),
            _ => { let s = n.to_string(); say("desk.tile.artifacts.many", format!("{s} artifacts"), &[("n", &s)]) }
        },
        count: Some(n as u32),
        opens: super::Screen::Artifacts { kind: String::new() },
        items: all.iter().take(4).map(|a| a.id.clone()).collect(),
        team_id: None,
    };
    let board = super::DeskTileView {
        key: "board".into(),
        title: say("desk.tile.board", "Scribble Board", &[]),
        line: say("desk.tile.board.open", "Draw and think together", &[]),
        count: None,
        opens: super::Screen::Scribble { board_id: team.map(crate::scribble::team_board).unwrap_or_default() },
        items: Vec::new(),
        team_id: team.map(String::from),
    };
    let knowledge = desk.knowledge.as_ref().map(|k| {
        let n = k.count;
        super::DeskTileView {
            key: "knowledge".into(),
            title: k.label.clone(),
            line: match n {
                0 => none(),
                1 => say("desk.tile.knowledge.one", "1 entry", &[]),
                _ => { let s = n.to_string(); say("desk.tile.knowledge.many", format!("{s} entries"), &[("n", &s)]) }
            },
            count: Some(n),
            opens: super::Screen::Knowledge { query: String::new(), filter: String::new() },
            items: Vec::new(),
            team_id: Some(k.team_id.clone()),
        }
    });
    [Some(work), Some(artifacts), Some(board), knowledge].into_iter().flatten().collect()
}

/// The board tile once the team's board is read small (`ViewModel.thumbs`): how many elements it holds.
pub fn board_tile(desk: &mut DeskView, thumbs: Option<&[super::ThumbView]>) {
    let Some(tile) = desk.tiles.iter_mut().find(|t| t.key == "board") else { return };
    let Some(thumb) = thumbs.unwrap_or_default().iter().find(|t| Some(&t.team_id) == tile.team_id.as_ref()) else { return };
    if thumb.state == "loading" {
        return;
    }
    let n = thumb.count;
    tile.count = Some(n as u32);
    tile.line = match n {
        0 => say("desk.tile.board.empty", "Empty", &[]),
        1 => say("desk.tile.board.one", "1 element", &[]),
        _ => { let s = n.to_string(); say("desk.tile.board.many", format!("{s} elements"), &[("n", &s)]) }
    };
}

/// One of the greetings, the same for a whole run of the app; a calm one when no question waits.
pub fn greeting(calm: bool, dice: u32) -> Text {
    let set: &[&str] = if calm { &CALM } else { &GREETINGS };
    let at = ((dice as u64 * set.len() as u64) >> 32) as usize;
    let key = format!("desk.hello.{}.{at}", if calm { "calm" } else { "greeting" });
    say(&key, set[at], &[])
}

/// A count with a comma between the thousands, as the Desk writes it: 12,400.
fn grouped(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// Who a card or a request comes from: its session, and for a card of a helper that helper ("Helper Icons").
pub(super) fn from_of(b: &Board, agent: Option<usize>, card: Option<&Card>) -> Option<FromView> {
    let a = &b.agents[agent?];
    Some(FromView {
        session_id: a.row.key.clone(),
        name: a.row.name.clone(),
        mark: a.row.mark(),
        path: a.row.path.clone(),
        helper: card.and_then(|c| b.helper_of(c)).map(|h| say("from.helper", format!("Helper {h}"), &[("name", &h)])),
    })
}

pub(super) fn text_of(v: &Value) -> String {
    v.as_str().unwrap_or("").to_string()
}

/// The sign before a title and its words: what knocks, and what may wait.
fn sign_of(permission: bool, info: bool, urgency: &str) -> (String, Option<Text>) {
    if permission {
        ("block".into(), Some(say("row.knock.permission", "Knock! Permission", &[])))
    } else if urgency == "critical" {
        ("block".into(), Some(say("row.knock.blocking", "Knock! Blocking", &[])))
    } else if urgency == "high" {
        ("knock".into(), Some(say("row.knock", "Knock", &[])))
    } else if !info && urgency == "low" {
        ("whenever".into(), Some(say("row.whenever", "Whenever", &[])))
    } else {
        (String::new(), None)
    }
}

/// A card's title as every screen shows it: "Loading …" while its body is not read on this device, a line for a
/// card of a newer Trommi that names none.
pub fn shown_title(c: &Card) -> String {
    let title = text_of(&c.field("title"));
    if is_loading(c) {
        "Loading …".to_string()
    } else if c.is_unsupported() && title.is_empty() {
        "A card from a newer Trommi".into()
    } else {
        title
    }
}

pub(super) fn card_row(b: &Board, c: &Card, agent: Option<usize>) -> DeskRowView {
    let loading = is_loading(c);
    let newer = c.is_unsupported();
    let info = reads_as_info(c);
    let urgency = if loading { "normal".to_string() } else if c.urgency.is_empty() { "normal".into() } else { c.urgency.clone() };
    let title = shown_title(c);
    let teaser = if loading {
        "Still being decrypted on this device.".to_string()
    } else if newer {
        NEEDS_NEWER.into()
    } else {
        text_of(&c.field("teaser"))
    };
    let words = if teaser.is_empty() { plain(&text_of(&c.field("body")), b.assets()) } else { teaser.clone() };
    let mut notes = Vec::new();
    if !loading {
        let merged = c.field("merged_from_object_ids").as_array().map_or(0, Vec::len);
        if merged == 1 {
            notes.push(say("row.replaces.one", "replaces 1 question", &[("n", "1")]));
        } else if merged > 1 {
            let n = merged.to_string();
            notes.push(say("row.replaces", format!("replaces {n} questions"), &[("n", &n)]));
        }
        if c.history.len() > 1 {
            notes.push(say("row.revised", "revised", &[]));
        }
    }
    if c.unsnoozed.is_some() && c.snoozed_until.is_none() {
        notes.push(say("row.back_from_later", "Back from Later", &[]));
    }
    let reason = text_of(&c.field("urgency_reason"));
    if teaser.is_empty() && !reason.is_empty() && !loading {
        notes.push(say("row.urgency_reason", reason.as_str(), &[]));
    }
    let (sign, sign_says) = sign_of(false, info, &urgency);
    // (pictures first, then videos; a page that belongs to a picture is no file of its own)
    let attachments: Vec<Value> = if loading || newer { Vec::new() } else { c.field("attachments").as_array().cloned().unwrap_or_default() };
    let pages: Vec<&str> = attachments.iter().filter_map(|a| a.get("page").and_then(Value::as_str)).filter_map(|p| p.strip_prefix("attachment:")).collect();
    let kind_of = |a: &Value| {
        let t = a.get("media_type").and_then(Value::as_str).unwrap_or("");
        if t.starts_with("image/") { "image" } else if t.starts_with("video/") { "video" } else { "" }
    };
    let own: Vec<&Value> = attachments.iter().filter(|a| !pages.contains(&a.get("attachment_id").and_then(Value::as_str).unwrap_or(""))).collect();
    let media: Vec<MediaView> = ["image", "video"]
        .iter()
        .flat_map(|k| own.iter().filter(move |a| kind_of(a) == *k).map(move |a| MediaView {
            file_id: a.get("attachment_id").and_then(Value::as_str).unwrap_or("").to_string(),
            kind: k.to_string(),
        }))
        .collect();
    // (the fan's pictures are files the person may open: the App lets them be fetched)
    for a in own.iter().filter(|a| media.iter().any(|m| Some(m.file_id.as_str()) == a.get("attachment_id").and_then(Value::as_str))) {
        super::files_seen::saw(a);
    }
    let media_says = match media.len() {
        0 => None,
        1 => Some(say("row.media.one", "Look at the picture", &[("n", "1")])),
        n => Some(say("row.media", format!("Look at {n} pictures and videos"), &[("n", &n.to_string())])),
    };
    let starred = b.model.human.get(&format!("star/{}", c.object_id)).is_some_and(|r| !r.value.is_null() && r.value != Value::Bool(false));
    let options: Vec<Opt> = if info { Vec::new() } else { options_of(&c.field("options")) };
    let advised: Vec<String> = match c.field("recommended") {
        Value::String(s) => vec![s],
        Value::Array(a) => a.iter().filter_map(Value::as_str).map(String::from).collect(),
        _ => Vec::new(),
    };
    let multiple = c.field("allows_multiple") == Value::Bool(true);
    DeskRowView {
        id: c.object_id.clone(),
        kind: if info { "info" } else { "decision" }.into(),
        loading,
        newer,
        title,
        words,
        notes,
        urgency,
        sign,
        sign_says,
        starred,
        created_ms: c.created_at,
        from: from_of(b, agent, Some(c)),
        run: 0,
        media_says,
        media: media.into_iter().take(3).collect(),
        // (not read here yet: nothing to answer, not even "Got it", until it is read)
        tiles: if loading { no_tiles() } else if info { read_tiles() } else { tiles(&options, &advised, multiple, false) },
        ways: if loading { vec![] } else if info { vec!["later", "reverse", "shred"] } else { vec!["later", "reverse", "duck", "shred"] }.into_iter().map(String::from).collect(),
    }
}

pub(super) fn request_row(b: &Board, p: &PermissionRequest, agent: Option<usize>) -> DeskRowView {
    let from = from_of(b, agent, None);
    // (not read here yet: what it asks to run is unknown, so it is not offered to allow; it waits quietly)
    if !(p.content_state.is_empty() || p.content_state == "ok") {
        return DeskRowView {
            id: p.object_id.clone(),
            kind: "info".into(),
            loading: true,
            title: "Loading …".into(),
            words: "Still being decrypted on this device.".into(),
            urgency: "normal".into(),
            created_ms: p.sent_at,
            from,
            tiles: no_tiles(),
            ways: Vec::new(),
            ..Default::default()
        };
    }
    let (sign, sign_says) = sign_of(true, false, "critical");
    let options = vec![Opt { key: "allow".into(), label: "Allow".into(), ..Default::default() }, Opt { key: "deny".into(), label: "Deny".into(), ..Default::default() }];
    DeskRowView {
        id: p.object_id.clone(),
        kind: "request".into(),
        title: format!("Approval: {}", p.tool_name),
        words: plain(&format!("{}\n\n{}", p.description, p.input_preview), b.assets()),
        urgency: "critical".into(),
        sign,
        sign_says,
        created_ms: p.sent_at,
        from,
        tiles: tiles(&options, &[], false, true),
        ways: vec!["later".into()],
        ..Default::default()
    }
}

/// An option of a card as a row reads it.
#[derive(Clone, Debug, Default)]
pub struct Opt {
    pub key: String,
    pub label: String,
    /// Its short name, when it has one of at most 18 characters.
    pub short: String,
    pub settles: bool,
}

pub(crate) fn options_of(v: &Value) -> Vec<Opt> {
    v.as_array()
        .into_iter()
        .flatten()
        .map(|o| {
            let short = o.get("short").and_then(Value::as_str).unwrap_or("").trim().to_string();
            Opt {
                key: text_of(o.get("key").unwrap_or(&Value::Null)),
                label: text_of(o.get("label").unwrap_or(&Value::Null)),
                short: if short.encode_utf16().count() <= 18 { short } else { String::new() },
                settles: o.get("final") == Some(&Value::Bool(true)),
            }
        })
        .collect()
}

/// Whether a label stands in a tile `width` characters wide on at most `lines` lines (a hyphen may break a word).
fn fits(label: &str, width: usize, lines: usize) -> bool {
    let mut broken = String::new();
    let mut chars = label.trim().chars().peekable();
    while let Some(c) = chars.next() {
        broken.push(c);
        if c == '-' && chars.peek().is_some_and(|n| !n.is_whitespace()) {
            broken.push(' ');
        }
    }
    let (mut n, mut used) = (1, 0);
    for word in broken.split_whitespace() {
        let len = word.encode_utf16().count();
        if len > width {
            return false;
        }
        if used > 0 && used + 1 + len > width {
            n += 1;
            used = len;
        } else {
            used += usize::from(used > 0) + len;
        }
    }
    n <= lines
}

/// A plain yes or no.
fn bare(label: &str) -> bool {
    matches!(label.trim().to_lowercase().as_str(), "yes" | "no" | "ok" | "okay" | "allow" | "deny" | "ja" | "nein")
}

fn no_tiles() -> TilesView {
    TilesView {
        kind: "none".into(),
        ..Default::default()
    }
}

fn read_tiles() -> TilesView {
    TilesView {
        kind: "read".into(),
        ..Default::default()
    }
}

/// The answers a row offers for these options. `advised`: the keys its agent advises. `request`: an approval
/// request (Allow and Deny, thumbs, "allow" leads).
pub fn tiles(options: &[Opt], advised: &[String], multiple: bool, request: bool) -> TilesView {
    let all_bare = options.iter().all(|o| bare(&o.label));
    // (how the labels stand under the thumbs: in the usual type, in the small one, or not at all)
    let size = if all_bare {
        "none"
    } else if options.iter().all(|o| fits(&o.label, 14, 2)) {
        "usual"
    } else if options.iter().all(|o| fits(&o.label, 17, 3)) {
        "small"
    } else {
        "none"
    };
    let all_short = options.iter().all(|o| !o.short.is_empty());
    let quick = !multiple && (request || options.len() == 2);
    if quick && (all_bare || size != "none" || all_short) {
        // Thumbs only for a real yes or no (bare words, or a request): the option its agent leads with (its first,
        // or "allow") is the up. Two named options are two tiles with their words; the advised one is the filled
        // one. The lead always stands last (at the right).
        let thumbs = all_bare || request;
        let worded = !all_bare && size == "none";
        let is_lead = |i: usize, o: &Opt| if request { o.key == "allow" } else if thumbs { i == 0 } else { advised.contains(&o.key) };
        let mut order: Vec<(usize, &Opt)> = options.iter().enumerate().collect();
        order.sort_by_key(|(i, o)| is_lead(*i, o));
        let tiles = order
            .into_iter()
            .map(|(i, o)| {
                let lead = is_lead(i, o);
                let is_advised = advised.contains(&o.key);
                let unlabelled = size == "none" && !all_bare;
                TileView {
                    key: o.key.clone(),
                    label: if worded { o.short.clone() } else if unlabelled { String::new() } else { o.label.clone() },
                    thumb: if lead { "yes" } else { "no" }.into(),
                    thumbs,
                    lead,
                    advised: is_advised,
                    small: size == "small",
                    short: worded,
                    settles: o.settles,
                    tip: if is_advised {
                        Some(say("tile.recommended", "Recommended", &[]))
                    } else if o.settles {
                        Some(say("tile.settles", "Settles it", &[]))
                    } else if unlabelled {
                        Some(say("tile.label", o.label.as_str(), &[]))
                    } else {
                        None
                    },
                    says: if o.settles {
                        say("tile.says.settles", format!("{} (settles it)", o.label), &[("label", &o.label)])
                    } else {
                        say("tile.says", o.label.as_str(), &[("label", &o.label)])
                    },
                }
            })
            .collect();
        return TilesView {
            kind: "pair".into(),
            tiles,
            ..Default::default()
        };
    }
    // More than two ways, one of them advised: that one is the lead tile, one press takes it; "+N other ways"
    // opens the card.
    let one = (!request && !multiple && advised.len() == 1).then(|| options.iter().find(|o| o.key == advised[0])).flatten();
    if let Some(o) = one {
        let others = options.len() as u32 - 1;
        let n = others.to_string();
        return TilesView {
            kind: "advised".into(),
            tiles: vec![TileView {
                key: o.key.clone(),
                label: o.label.clone(),
                thumb: "yes".into(),
                thumbs: false,
                lead: true,
                advised: true,
                small: false,
                short: false,
                settles: o.settles,
                tip: Some(say("tile.label", o.label.as_str(), &[])),
                says: if o.settles {
                    say("tile.says.advised_settles", format!("{}, advised (settles it)", o.label), &[("label", &o.label)])
                } else {
                    say("tile.says.advised", format!("{}, advised", o.label), &[("label", &o.label)])
                },
            }],
            others,
            says: Some(say("tile.others", format!("{n} other ways: open the card"), &[("n", &n)])),
        };
    }
    let n = options.len().to_string();
    TilesView {
        kind: "choose".into(),
        says: Some(if multiple {
            say("tile.choose.several", format!("Choose: {n} options, several"), &[("n", &n)])
        } else {
            say("tile.choose", format!("Choose: {n} options"), &[("n", &n)])
        }),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn three_tiles_under_the_questions() {
        use super::{board_tile, desk_tiles as tiles};
        use crate::views::{ArtifactView, DeskView, OffHintView, Screen, ThumbView};
        let mut desk = DeskView::default();
        let t = tiles(&desk, &[], None);
        assert_eq!(t.iter().map(|t| (t.key.as_str(), t.title.en.as_str(), t.line.en.as_str())).collect::<Vec<_>>(), [
            ("work", "Working / Done", "Nothing yet"),
            ("artifacts", "Artifacts", "Nothing yet"),
            ("board", "Scribble Board", "Draw and think together"),
        ]);
        assert_eq!((t[0].opens.clone(), t[1].opens.clone()), (Screen::Off { query: String::new() }, Screen::Artifacts { kind: String::new() }));
        desk.off = Some(OffHintView { line: crate::views::words::say("x", "2 running \u{b7} 10 done", &[]), ..Default::default() });
        let all: Vec<ArtifactView> = (0..6).map(|i| ArtifactView { id: format!("a{i}"), ..Default::default() }).collect();
        desk.tiles = tiles(&desk, &all, Some("main"));
        assert_eq!(desk.tiles[0].line.en, "2 running \u{b7} 10 done");
        assert_eq!((desk.tiles[1].line.en.as_str(), desk.tiles[1].count, desk.tiles[1].items.len()), ("6 artifacts", Some(6), 4), "the newest four shown");
        assert_eq!((desk.tiles[2].team_id.as_deref(), &desk.tiles[2].opens), (Some("main"), &Screen::Scribble { board_id: crate::scribble::team_board("main") }));
        // the board's count once it is read small; another team's picture changes nothing
        board_tile(&mut desk, Some(&[ThumbView { team_id: "lab".into(), state: "ready".into(), count: 3, ..Default::default() }]));
        assert_eq!(desk.tiles[2].count, None);
        board_tile(&mut desk, Some(&[ThumbView { team_id: "main".into(), state: "ready".into(), count: 27, ..Default::default() }]));
        assert_eq!((desk.tiles[2].line.en.as_str(), desk.tiles[2].count), ("27 elements", Some(27)));
        // a team's Knowledge is the fourth, counted
        desk.knowledge = Some(crate::views::KnowledgeChipView { team_id: "main".into(), label: crate::views::words::say("knowledge.chip", "Knowledge", &[]), count: 7, ..Default::default() });
        let t = tiles(&desk, &all, Some("main"));
        assert_eq!((t.len(), t[3].key.as_str(), t[3].title.en.as_str(), t[3].line.en.as_str(), t[3].count), (4, "knowledge", "Knowledge", "7 entries", Some(7)));
        assert_eq!(t[3].opens, Screen::Knowledge { query: String::new(), filter: String::new() });
    }

    use super::*;
    use crate::views::testroom::{dev, Room, MIN, NOW};
    use crate::views::Lens;
    use serde_json::json;

    fn view_with(r: &Room, lens: &Lens) -> DeskView {
        let m = r.model(NOW);
        desk(&Board::new(&m, lens, NOW))
    }
    fn view(r: &Room, team: Option<&str>) -> DeskView {
        view_with(r, &Lens { team: team.map(String::from), ..Default::default() })
    }
    fn opt(key: &str, label: &str) -> Opt {
        Opt { key: key.into(), label: label.into(), ..Default::default() }
    }
    fn shown(t: &TilesView) -> Vec<(&str, &str, &str)> {
        t.tiles.iter().map(|x| (x.key.as_str(), x.label.as_str(), x.thumb.as_str())).collect()
    }
    fn en(t: &Option<Text>) -> &str {
        t.as_ref().map(|t| t.en.as_str()).unwrap_or("")
    }

    /// A card that arrives in an archived session stays off the Desk (web and iPhone: the core's stack); a main whose
    /// agent connects again is no longer archived, and its card stands there.
    #[test]
    fn a_card_of_an_archived_session_stays_off_the_desk() {
        let mut r = Room::default();
        r.session("main", None, false);
        r.session("helper", Some("main"), false);
        r.settings.insert(dev("main"), json!({ "archived": true }));
        r.settings.insert(dev("helper"), json!({ "archived": true }));
        r.card("m1", "main", "decision", "normal")["session_id"] = json!(dev("main"));
        r.card("h1", "helper", "decision", "normal")["session_id"] = json!(dev("helper"));
        assert!(view(&r, None).stack.is_empty());
        r.sessions[0]["is_online"] = json!(true);
        r.sessions[0]["offline_since"] = Value::Null;
        assert_eq!(view(&r, None).stack, ["m1"]);
    }

    /// The web's `tiles` (app/web/public/ui.mjs), case by case.
    #[test]
    fn a_yes_or_no_is_two_thumbs_the_first_option_up_and_last() {
        let t = tiles(&[opt("y", "Yes"), opt("n", "No")], &["n".into()], false, false);
        assert_eq!((t.kind.as_str(), shown(&t)), ("pair", vec![("n", "No", "no"), ("y", "Yes", "yes")]));
        assert!(t.tiles.iter().all(|x| x.thumbs && !x.small && !x.short));
        // (the advised one is marked, whichever thumb it is)
        assert_eq!(t.tiles.iter().map(|x| (x.advised, x.lead, en(&x.tip))).collect::<Vec<_>>(), [(true, false, "Recommended"), (false, true, "")]);
        // an approval request: allow is the up, whatever the order
        let t = tiles(&[opt("deny", "Deny"), opt("allow", "Allow")], &[], false, true);
        assert_eq!(shown(&t), [("deny", "Deny", "no"), ("allow", "Allow", "yes")]);
    }

    #[test]
    fn two_named_ways_are_two_tiles_the_advised_one_leads() {
        let t = tiles(&[opt("split", "Split"), opt("centered", "Centered")], &["split".into()], false, false);
        assert_eq!(shown(&t), [("centered", "Centered", "no"), ("split", "Split", "yes")]);
        assert!(t.tiles.iter().all(|x| !x.thumbs));
        // (none advised: none leads, the order given)
        let t = tiles(&[opt("a", "Alpha"), opt("b", "Beta")], &[], false, false);
        assert_eq!(shown(&t), [("a", "Alpha", "no"), ("b", "Beta", "no")]);
        // words that need three lines of 17 stand in the small type
        let t = tiles(&[opt("a", "Keep the old importer running"), opt("b", "On step 3")], &[], false, false);
        assert!(t.kind == "pair" && t.tiles.iter().all(|x| x.small));
        // a choice that settles the card says so
        let mut last = opt("b", "Drop it");
        last.settles = true;
        let t = tiles(&[opt("a", "Keep it"), last], &[], false, false);
        assert_eq!((en(&t.tiles[1].tip), t.tiles[1].says.en.as_str(), t.tiles[0].says.en.as_str()), ("Settles it", "Drop it (settles it)", "Keep it"));
    }

    #[test]
    fn labels_that_fit_no_tile_need_short_names_or_the_card() {
        let long = |key: &str, short: &str| Opt { key: key.into(), label: format!("{key}: a label that is far too long for any tile to hold"), short: short.into(), settles: false };
        let t = tiles(&[long("a", "Keep"), long("b", "Drop")], &[], false, false);
        assert_eq!((t.kind.as_str(), shown(&t)), ("pair", vec![("a", "Keep", "no"), ("b", "Drop", "no")]));
        assert!(t.tiles.iter().all(|x| x.short && en(&x.tip).starts_with(&x.key)));
        // (one without a short name: the card)
        let t = tiles(&[long("a", "Keep"), long("b", "")], &[], false, false);
        assert_eq!((t.kind.as_str(), en(&t.says)), ("choose", "Choose: 2 options"));
        // (a word longer than the tile is wide fits nowhere; a hyphen may break one)
        assert!(!fits("Internationalisation", 17, 3) && fits("Server-side-rendering", 14, 2) && !fits("one two three four five six", 5, 2));
    }

    #[test]
    fn more_than_two_ways_the_advised_one_or_the_card() {
        let three = [opt("a", "Outline"), opt("b", "Filled"), opt("c", "Duotone")];
        let t = tiles(&three, &["b".into()], false, false);
        assert_eq!((t.kind.as_str(), shown(&t), t.others, en(&t.says)), ("advised", vec![("b", "Filled", "yes")], 2, "2 other ways: open the card"));
        assert_eq!(t.tiles[0].says.en, "Filled, advised");
        // (two advised, none advised, an advised key that is no option, several may be ticked: the card)
        for (advised, multiple, says) in [(vec!["a", "b"], false, "Choose: 3 options"), (vec![], false, "Choose: 3 options"), (vec!["zz"], false, "Choose: 3 options"), (vec!["b"], true, "Choose: 3 options, several")] {
            let advised: Vec<String> = advised.into_iter().map(String::from).collect();
            let t = tiles(&three, &advised, multiple, false);
            assert_eq!((t.kind.as_str(), en(&t.says), t.tiles.len()), ("choose", says, 0));
        }
        // (two ways of which several may be ticked are no pair)
        assert_eq!(tiles(&[opt("y", "Yes"), opt("n", "No")], &[], true, false).kind, "choose");
    }

    #[test]
    fn the_rows_are_the_walk_of_the_desk_in_view() {
        let mut r = Room { teams: json!({ "main": { "name": "Work", "created_at": 1 }, "lab": { "name": "Lab", "created_at": 2 } }), ..Default::default() };
        r.session("a", None, true);
        r.session("b-lab", None, true);
        r.on_team("b-lab", "lab");
        r.card("q-old", "a", "decision", "normal")["first_envelope_number"] = json!(1);
        r.card("q-new", "a", "decision", "normal");
        r.card("q-read", "a", "info", "normal");
        r.card("q-block", "a", "decision", "critical");
        r.card("q-back", "a", "decision", "normal")["in_revision"] = json!({ "by": "me", "envelope_number": 500 });
        r.card("q-lab", "b-lab", "decision", "high");
        r.request("p1", "a", "ok");
        let v = view(&r, Some("main"));
        // (what blocks first, then what is to read, then the questions, the oldest first: the core's order)
        assert_eq!(v.stack, ["q-block", "p1", "q-read", "q-old", "q-new"]);
        assert_eq!(v.rows.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), v.stack);
        assert_eq!((v.waiting, en(&v.blitz)), (4, "Blitz: 5 open cards"));
        assert_eq!(v.rows.iter().map(|x| x.run).collect::<Vec<_>>(), [5, 0, 0, 0, 0]);
        assert!(v.rows.iter().all(|x| x.from.as_ref().is_some_and(|f| f.path == ["Work", "a"])));
        // one team at a time: the other team's question stands on its own team only ("all" is no team: the first)
        assert_eq!(view(&r, Some("lab")).stack, ["q-lab"]);
        assert_eq!(view(&r, Some("all")).stack, v.stack);
        assert_eq!(view(&r, None).stack, v.stack);
        // home: every team's questions on one Desk, in the core's order, and no team's goals
        let home = view_with(&r, &Lens { team: Some("main".into()), desk_all: true, ..Default::default() });
        assert!(home.stack.contains(&"q-lab".to_string()) && home.stack.len() == v.stack.len() + 1);
        assert_eq!(home.waiting, v.waiting + 1);
        assert!(home.goals.is_none());
    }

    #[test]
    fn a_row_says_what_knocks_and_what_it_went_through() {
        let mut r = Room::default();
        r.session("a", None, true);
        let c = r.card("q1", "a", "decision", "critical");
        c["options"] = json!([{ "key": "y", "label": "Yes" }, { "key": "n", "label": "No" }]);
        c["body"] = json!("**Disk** at `91%`.\n\n```sh\ndf -h\n```\nAdd # space?");
        c["urgency_reason"] = json!("the backfill stops in an hour");
        c["merged_from_object_ids"] = json!(["x", "y"]);
        c["versions"] = json!([{ "object_version": 1, "envelope_number": 1, "object_state": "open" }, { "object_version": 2, "envelope_number": 2, "object_state": "open" }]);
        c["attachments"] = json!([
            { "attachment_id": "v1", "media_type": "video/mp4" }, { "attachment_id": "p1", "media_type": "image/png", "page": "attachment:h1" },
            { "attachment_id": "h1", "media_type": "text/html" }, { "attachment_id": "p2", "media_type": "image/png" },
            { "attachment_id": "p3", "media_type": "image/jpeg" }, { "attachment_id": "doc", "media_type": "application/pdf" },
        ]);
        r.card("q2", "a", "decision", "high")["teaser"] = json!("A teaser.");
        r.cards[1]["urgency_reason"] = json!("not shown beside a teaser");
        r.card("q3", "a", "decision", "low");
        r.card("q4", "a", "info", "low");
        r.stars = json!({ "q3": { "at": 5 } });
        let v = view(&r, None);
        let row = |id: &str| v.rows.iter().find(|x| x.id == id).unwrap();
        let q1 = row("q1");
        assert_eq!((q1.sign.as_str(), en(&q1.sign_says), q1.words.as_str()), ("block", "Knock! Blocking", "Disk at 91%. Add space?"));
        assert_eq!(q1.notes.iter().map(|n| n.en.as_str()).collect::<Vec<_>>(), ["replaces 2 questions", "revised", "the backfill stops in an hour"]);
        // (pictures before videos, three at most; the page of a picture and a document are none)
        assert_eq!(q1.media.iter().map(|x| (x.file_id.as_str(), x.kind.as_str())).collect::<Vec<_>>(), [("p1", "image"), ("p2", "image"), ("p3", "image")]);
        assert_eq!(en(&q1.media_says), "Look at 4 pictures and videos");
        assert_eq!((q1.tiles.kind.as_str(), q1.ways.join(" ")), ("pair", "later reverse duck shred".into()));
        let q2 = row("q2");
        assert_eq!((q2.sign.as_str(), en(&q2.sign_says), q2.words.as_str(), q2.notes.len()), ("knock", "Knock", "A teaser.", 0));
        assert_eq!((row("q3").sign.as_str(), en(&row("q3").sign_says), row("q3").starred, q1.starred), ("whenever", "Whenever", true, false));
        // (something to read: no sign for a low one, What?? and Got it, no duck)
        let q4 = row("q4");
        assert_eq!((q4.kind.as_str(), q4.sign.as_str(), q4.tiles.kind.as_str(), q4.ways.join(" ")), ("info", "", "read", "later reverse shred".into()));
    }

    #[test]
    fn what_is_not_read_here_yet_waits_quietly() {
        let mut r = Room::default();
        r.session("a", None, true);
        let c = r.card("q-loading", "a", "decision", "high");
        c["content_state"] = json!("undecryptable");
        c["options"] = json!([{ "key": "y", "label": "Yes" }, { "key": "n", "label": "No" }]);
        let c = r.card("q-newer", "a", "decision", "normal");
        c["unsupported"] = json!("schema");
        c["title"] = json!("");
        r.request("p-unread", "a", "header");
        r.request("p-read", "a", "ok");
        let v = view(&r, None);
        let row = |id: &str| v.rows.iter().find(|x| x.id == id).unwrap();
        let l = row("q-loading");
        assert_eq!((l.kind.as_str(), l.loading, l.title.as_str(), l.words.as_str(), l.sign.as_str(), l.urgency.as_str(), l.tiles.kind.as_str()), ("info", true, "Loading …", "Still being decrypted on this device.", "", "normal", "none"));
        assert!(l.ways.is_empty() && row("p-unread").ways.is_empty() && row("p-unread").tiles.kind == "none");
        let n = row("q-newer");
        assert_eq!((n.kind.as_str(), n.newer, n.title.as_str(), n.words.as_str(), n.tiles.kind.as_str()), ("info", true, "A card from a newer Trommi", NEEDS_NEWER, "read"));
        let p = row("p-unread");
        assert_eq!((p.kind.as_str(), p.loading, p.title.as_str(), p.sign.as_str()), ("info", true, "Loading …", ""));
        let p = row("p-read");
        assert_eq!((p.kind.as_str(), p.title.as_str(), p.sign.as_str(), en(&p.sign_says), p.ways.join(" ")), ("request", "Approval: Bash", "block", "Knock! Permission", "later".into()));
        assert_eq!(shown(&p.tiles), [("deny", "Deny", "no"), ("allow", "Allow", "yes")]);
        assert_eq!(v.waiting, 1, "only the request that is read is a question");
    }

    #[test]
    fn the_head_greets_and_says_what_is_not_quiet() {
        let empty = Room::default();
        let v = view(&empty, None);
        assert_eq!((v.mode.as_str(), v.hello.is_none(), en(&v.empty), v.goals.is_none()), ("invite", true, "Questions land here.", true));
        let v = view_with(&empty, &Lens { reading: true, reading_progress: Some((12_400, 27_000)), ..Default::default() });
        assert_eq!((v.mode.as_str(), en(&v.hello), en(&v.reading)), ("reading", "Catching up…", "Reading your history: 12,400 of 27,000"));
        assert_eq!(en(&v.empty), "Catching up: reading your sessions on this device. Their open questions show here as they are read.");

        let mut r = Room::default();
        r.session("a", None, true)["heard_up_to"] = json!(40);
        // nothing waits: a calm line, the same for the whole run
        let calm = |dice: u32| en(&view_with(&r, &Lens { dice, ..Default::default() }).hello).to_string();
        assert_eq!((calm(0), calm(u32::MAX), calm(u32::MAX / 2 + 1)), ("All quiet.".into(), "Go outside.".into(), "Carry on.".into()));
        assert_eq!(view(&r, None).blitz, None);
        // still reading: no "all quiet" while questions may yet come in
        assert_eq!(en(&view_with(&r, &Lens { reading: true, ..Default::default() }).hello), "Catching up…");
        // an answer its session has not picked up
        r.answered("late", "a", NOW - 5 * MIN, 50);
        assert_eq!(en(&view(&r, None).hello), "An answer waits.");
        r.answered("late2", "a", NOW - 5 * MIN, 51);
        assert_eq!(en(&view(&r, None).hello), "Answers wait.");
        // a session that is cut off says more, and has its line above the questions
        r.session("b", None, false)["link"] = json!({ "hears": "live", "attached": true, "exit": { "reason": "stdin", "claude": "alive" } });
        let v = view(&r, None);
        assert_eq!(en(&v.hello), "One can’t hear you.");
        assert_eq!(v.slip.iter().map(|s| (s.session_id.clone(), s.text.en.as_str(), s.fix.say.en.as_str(), s.fix.code.as_str())).collect::<Vec<_>>(), [(dev("b"), "b is cut off since 13:27: it cannot hear you and cannot write to you.", "In its terminal:", "/mcp → trommi → Reconnect")]);
        // something to read is no question: Blitz walks it, the greeting stays calm
        r.card("q-read", "a", "info", "normal");
        let v = view(&r, None);
        assert_eq!((en(&v.hello), v.waiting, en(&v.blitz), v.empty.is_none()), ("One can’t hear you.", 0, "Blitz: 1 open card", true));
        let mut calm_room = Room::default();
        calm_room.session("a", None, true);
        calm_room.card("q-read", "a", "info", "normal");
        let v = view(&calm_room, None);
        assert_eq!((en(&v.hello), en(&v.blitz)), ("All quiet.", "Blitz: 1 open card"));
        // a question waits: one of the greetings
        r.card("q1", "a", "decision", "normal");
        assert_eq!(en(&view(&r, None).hello), "Welcome back.");
        assert_eq!(en(&view_with(&r, &Lens { dice: u32::MAX, ..Default::default() }).hello), "Ready when you are.");
    }

    #[test]
    fn the_empty_words_only_when_nothing_is_open_at_all() {
        let mut r = Room::default();
        r.session("a", None, true);
        assert_eq!(en(&view(&r, None).empty), "Questions land here.");
        // (a card that is with its agent is open, though no row)
        r.card("q-back", "a", "decision", "normal")["in_revision"] = json!({ "by": "me", "envelope_number": 500 });
        let v = view(&r, None);
        assert_eq!((v.empty.is_none(), v.rows.len()), (true, 0));
        let mut r = Room::default();
        r.session("a", None, true);
        r.card("q-works", "a", "info", "normal")["working"] = json!(true);
        assert!(view(&r, None).empty.is_none());
        // (what is put off is not open here)
        let mut r = Room::default();
        r.session("a", None, true);
        r.card("q-later", "a", "decision", "normal");
        r.snoozes = json!({ "q-later": { "until": NOW + 60 * MIN } });
        assert_eq!(en(&view(&r, None).empty), "Questions land here.");
    }

    /// A count of one is a count too: the shell draws the number from `args.n` (the Linux shell's empty bubble).
    #[test]
    fn a_count_of_one_names_its_number() {
        let mut r = Room::default();
        r.session("a", None, true);
        r.card("q", "a", "decision", "normal");
        let blitz = view(&r, None).blitz.unwrap();
        assert_eq!((blitz.key.as_str(), blitz.args.get("n").map(String::as_str)), ("desk.blitz.one", Some("1")));
    }

    #[test]
    fn the_goals_fold_with_two_lines_or_more() {
        let mut r = Room { teams: json!({ "main": { "name": "Work", "goals": "  \nShip it   \r\nTest it\n\n" } }), ..Default::default() };
        r.session("a", None, true);
        let g = view(&r, None).goals.unwrap();
        assert_eq!((g.team_id.as_str(), g.lines.clone(), g.foldable, en(&g.show_all)), ("main", vec!["Ship it".to_string(), "Test it".into()], true, "Show all 2 goals"));
        assert_eq!((g.folded, en(&g.toggle)), (false, "Show the first goal only"));
        // folded on this device: the toggle shows them all again
        let lens = Lens { goals_folded: vec!["main".into()], ..Default::default() };
        let g = view_with(&r, &lens).goals.unwrap();
        assert_eq!((g.folded, en(&g.toggle)), (true, "Show all 2 goals"));
        r.teams = json!({ "main": { "name": "Work", "goals": "One goal" } });
        let g = view_with(&r, &lens).goals.unwrap();
        assert_eq!((g.lines.len(), g.foldable, g.show_all, g.folded, g.toggle), (1, false, None, false, None));
        r.teams = json!({ "main": { "name": "Work" } });
        assert_eq!(view(&r, None).goals.unwrap().lines.len(), 0);
        // (a room without teams keeps its goals on the first team it will have)
        let mut r = Room::default();
        r.session("a", None, true);
        assert_eq!(view(&r, None).goals.unwrap().team_id, "main");
    }

    #[test]
    fn the_duck_for_all_leaves_the_decisions_to_the_agents_and_reads_the_rest() {
        let mut r = Room::default();
        r.session("a", None, true);
        let v = view(&r, None);
        assert!(v.duck.is_none(), "nothing waits: no duck");
        r.card("q1", "a", "decision", "normal");
        r.request("p-read", "a", "ok");
        let v = view(&r, None);
        let d = v.duck.clone().unwrap();
        assert_eq!(d.card_ids, ["q1"], "a request is never ducked");
        assert_eq!((d.ask.en.as_str(), d.yes.en.as_str(), d.tip.en.as_str(), d.what.en.as_str(), d.no.en.as_str()),
            ("Duck it?", "Yes, duck it", "I don’t give a duck: for the one open decision", "1 decision goes to the agents", "Cancel"));
        assert_eq!((d.short.en.as_str(), d.short.key.as_str()), ("IDGAD", "desk.duck.short"), "the short name, the question follows");
        r.card("i1", "a", "info", "normal");
        r.card("i2", "a", "info", "normal");
        let c = r.card("q-loading", "a", "decision", "normal");
        c["content_state"] = json!("header");
        let d = view(&r, None).duck.unwrap();
        assert_eq!(d.card_ids.len(), 3, "not what is not read here yet: {:?}", d.card_ids);
        assert_eq!((d.ask.en.as_str(), d.yes.en.as_str(), d.tip.en.as_str(), d.what.en.as_str()),
            ("Duck all 3?", "Yes, duck them all", "I don’t give a duck: for all 3 open cards", "1 decision goes to the agents, 2 cards to read are closed"));
        assert_eq!(d.ask.args.get("n").map(String::as_str), Some("3"));
        // only cards to read
        let mut r = Room::default();
        r.session("a", None, true);
        r.card("i1", "a", "info", "normal");
        r.card("i2", "a", "info", "normal");
        let d = view(&r, None).duck.unwrap();
        assert_eq!((d.ask.en.as_str(), d.yes.en.as_str(), d.what.en.as_str()), ("Close all 2 as read?", "Yes, all read", "2 cards to read are closed"));
    }
}
