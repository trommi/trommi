//! The board as the views read it, worked out once per render from the board model: the sessions with their team
//! and crown, the teams, the team in view, the open questions and where they wait, the answers a session has not
//! picked up. Every screen's unit is made from this, so that the sidebar, the Desk, a session and a card never
//! disagree. The rules are the web app's `boardModel` of before (app/web/public/app.mjs).
//!
//! What is decided elsewhere in this crate is taken, not derived again: the session list with each session's link,
//! red hand and status lines (`sessions.rs`, `status.rs`), the Desk's stack and its order (`desk.rs`, the model's
//! `stack`, `open_permission_ids`, `desk_order`).

use super::words::earliest;
use crate::model::types::{Card, PermissionRequest};
use crate::model::Model;
use crate::helpers::Helper;
use crate::sessions::{teams_in_order, session_list_and_helpers, SessionRow};
use serde_json::Value;
use std::cell::{Cell, OnceCell};
use std::collections::HashMap;

/// The team a room without teams shows in its menu.
pub const DEFAULT_TEAM: &str = "main";
/// An answer its session has not picked up for this long is worth a word.
pub const UNHEARD_MS: u64 = 2 * 60_000;

/// What this device alone chooses and knows: none of it is the room's.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Lens {
    /// The team in view: a team's id, or none (none chosen, or one that is gone: the first team).
    pub team: Option<String>,
    /// Minutes east of UTC (`Config.utc_offset_min`): a time of day in a sentence is the person's.
    pub utc_offset_min: i32,
    /// The room is still being read on this device (a sign-in, the past read again).
    pub reading: bool,
    /// How far the reading of the room's past is: done, of how many.
    pub reading_progress: Option<(u64, u64)>,
    /// Picks the Desk's greeting, once per run of the app (from `Config.seed`).
    pub dice: u32,
    /// The page Off your mind: a page of settled cards is being read from the hub, and the hub holds more below
    /// the ones read (`app::past`).
    pub off_reading: bool,
    pub off_hub_more: bool,
    /// The session in view (its key) whose newest page of history has not come from the hub yet (`app::past`):
    /// its page shows no welcome meanwhile.
    pub talk_waits: Option<String>,
    /// The session whose page is in view (its key, or its short id of the address): its unit is made.
    pub session: Option<String>,
    /// The card whose page is in view: its unit is made.
    pub card: Option<String>,
    /// The page Off your mind is in view, with the search's words: its unit is made.
    pub off: Option<String>,
    /// The gallery of Artifacts is in view.
    pub artifacts: bool,
    /// A page shows every team's board small (Settings, the boards of All teams): they are read, `ViewModel.thumbs`.
    pub thumbs: bool,
    /// Only the board of the team in view small (the Desk's board tile); else every team's (Settings).
    pub thumbs_desk: bool,
    /// The teams whose goals are folded to their first line on this device (web localStorage
    /// `trommi-goals-folded`, iOS @AppStorage of the same name). The shell keeps it until the cache does (W3/W5).
    pub goals_folded: Vec<String>,
    /// The Desk is home: every team's questions, not the team in view's (`Focus.desk_all`).
    pub desk_all: bool,
    /// The teams unfolded in the wide sidebar (`Focus.open_teams`).
    pub open_teams: Vec<String>,
    /// The words searched for among every team's chats (`Focus.chats_query`), trimmed; none when empty.
    pub chats_query: Option<String>,
    /// What this device has shown of each session's words: the newest envelope number of its agent's words when
    /// its chat was last in view, by session key (the cache's `seen`). None until it is read: nothing counts as
    /// unread meanwhile.
    pub seen: Option<std::collections::BTreeMap<String, u64>>,
    /// The gallery is in view, with its filter (`Screen::Artifacts.kind`): "", "media" or "pages".
    pub gallery: Option<String>,
    /// The page Knowledge is in view, with its search and filter: its unit is made.
    pub knowledge: Option<super::knowledge::Ask>,
    /// How many pages of a session's talk show ([`TALK_PAGE`] rows each), for that session (its key or short id);
    /// none, or another session: one page.
    pub talk_window: Option<(String, u32)>,
    /// How many pages of the complete list Off your mind show ([`OFF_PAGE`] rows each), for that search's words.
    pub off_window: Option<(String, u32)>,
    /// How many pages of a card's comments show ([`COMMENTS_PAGE`] rows each), for that card (its id).
    pub comments_window: Option<(String, u32)>,
    /// The calm chat (`Focus.calm`).
    pub calm: bool,
}

/// Rows of a session's talk in one page of its window (the web's PAGE).
pub const TALK_PAGE: usize = 40;
/// Rows of the complete list Off your mind in one page of its window.
pub const OFF_PAGE: usize = 100;
/// Rows of a card's comments in one page of its window (the web's newest ten, "Load earlier (N)" ten more each).
pub const COMMENTS_PAGE: usize = 10;

/// What the person asks to see more of.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "list", rename_all = "snake_case")]
pub enum MoreOf {
    /// The talk of a session (its key, or its short id).
    Talk { session: String },
    /// The complete list Off your mind, under these search words.
    Off { query: String },
    /// The comments under a card (its id).
    Comments { card: String },
}

impl Lens {
    /// THE HOOK for the action "show more" (W3 wires it; where the older part is not on this device, the engine's
    /// past reading follows the same action): the window of that list grows by one page. The page a `MoreView`
    /// names (`pages`) is what this sets.
    pub fn show_more(&mut self, of: MoreOf) {
        let grow = |w: &mut Option<(String, u32)>, key: String| {
            let now = match w {
                Some((k, n)) if *k == key => *n,
                _ => 1,
            };
            *w = Some((key, now.max(1) + 1));
        };
        match of {
            MoreOf::Talk { session } => grow(&mut self.talk_window, session),
            MoreOf::Off { query } => grow(&mut self.off_window, query),
            MoreOf::Comments { card } => grow(&mut self.comments_window, card),
        }
    }
    /// How many pages of this list show.
    pub fn pages(window: &Option<(String, u32)>, key: &str) -> u32 {
        match window {
            Some((k, n)) if k == key => (*n).max(1),
            _ => 1,
        }
    }
}

/// A team of the room.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DeskFacts {
    pub id: String,
    pub name: String,
    pub goals: String,
    /// The team's own crown, when its register names one (`Some(Null)`: nobody on this team).
    pub crown: Option<Value>,
}

/// A session of the list, with what the views add to the core's row.
#[derive(Clone, Debug)]
pub struct Agent {
    pub row: SessionRow,
    /// The team it stands on: its own when that team is there, else the first; none in a room without teams.
    pub team: Option<String>,
    /// The crowned session of its team (one per team, never one for all).
    pub crowned: bool,
    /// It stands on the team in view (archived or not).
    pub on_team: bool,
    /// Its device says platform "codex".
    pub codex: bool,
    /// Its connector said a last word before its stream closed.
    pub said_goodbye: bool,
}

/// An open question: a card or an approval request that waits for the person on the Desk now (no info, nothing
/// that is with its agent).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fresh {
    pub id: String,
    /// Its session among [`Board::agents`]; none for a session the list does not show.
    pub agent: Option<usize>,
    /// Urgent, blocking, or an approval request.
    pub knocks: bool,
    pub permission: bool,
}

pub struct Board<'a> {
    pub model: &'a Model,
    pub lens: &'a Lens,
    pub now: u64,
    /// Every session of the list, in its order (archived ones too).
    pub agents: Vec<Agent>,
    /// By session key (a helper session of before: its main's, `sessions::LegacyHelper`).
    pub by_key: HashMap<String, usize>,
    /// The helper sessions of before whose main has an entry: their key to the helper's name (for their cards and
    /// their Chat, archived ones too).
    pub legacy: std::collections::BTreeMap<String, String>,
    /// Of them, the ones off the Desk (archived): no helper of the session's list.
    pub legacy_archived: std::collections::BTreeSet<String>,
    /// By the board's id of a session (`SessionRow::id`).
    pub by_id: HashMap<String, usize>,
    /// The teams in the menu's order; empty in a room without teams.
    pub teams: Vec<DeskFacts>,
    /// The team in view: an id of `teams`, or none in a room without teams.
    pub team: Option<String>,
    /// The open questions of the whole board, in the stack's order, the approval requests last.
    pub all_fresh: Vec<Fresh>,
    /// How many of his answers each session has not picked up for [`UNHEARD_MS`], by index of `agents`.
    pub unheard: HashMap<usize, u32>,
    wake: Cell<Option<u64>>,
    helpers: OnceCell<HashMap<usize, Vec<Helper>>>,
    numbers: OnceCell<HashMap<String, u32>>,
    assets: OnceCell<super::links::Assets>,
}

/// A card that reads as an info: one that is, one of a newer Trommi, and one whose body is not read here yet (a
/// quiet placeholder: nothing to answer and no knock until it is read).
// (the owner, 13 October 2026, card 0b89a1c7: what is not read here yet waits quietly everywhere: no question, no
//  knock, no red hand (status.rs), no answers on its row)
pub fn reads_as_info(c: &Card) -> bool {
    c.field("card_type").as_str() == Some("info") || c.is_unsupported() || is_loading(c)
}

/// Open, and its body is not read on this device yet.
pub fn is_loading(c: &Card) -> bool {
    !c.is_unsupported() && matches!(c.content_state.as_str(), "undecryptable" | "header")
}

/// The session a card or request belongs to: its session, else its agent device.
pub fn key_of<'c>(session: &'c Option<String>, agent: &'c str) -> &'c str {
    session.as_deref().unwrap_or(agent)
}

fn request_is_read(p: &PermissionRequest) -> bool {
    p.content_state.is_empty() || p.content_state == "ok"
}

impl<'a> Board<'a> {
    pub fn new(model: &'a Model, lens: &'a Lens, now: u64) -> Self {
        let teams: Vec<DeskFacts> = teams_in_order(model)
            .into_iter()
            .map(|(id, name)| {
                let v = model.human.get(&format!("desk/{id}")).map(|r| &r.value);
                DeskFacts {
                    goals: v.and_then(|v| v.get("goals")).and_then(Value::as_str).map(clean_goals).unwrap_or_default(),
                    crown: v.and_then(|v| v.get("crown")).cloned(),
                    id,
                    name,
                }
            })
            .collect();
        let has = |id: &str| teams.iter().any(|d| d.id == id);
        // (one team at a time: the one chosen, else the first; none chosen yet, as on a fresh sign-in, or one that
        //  is gone: the first)
        let team: Option<String> = teams.first().map(|first| match lens.team.as_deref() {
            Some(d) if has(d) => d.to_string(),
            _ => first.id.clone(),
        });
        let (rows, legacy_rows) = session_list_and_helpers(model, lens.reading);
        let agents: Vec<Agent> = rows
            .into_iter()
            .map(|row| {
                let own = teams.first().map(|first| if has(&row.team) { row.team.clone() } else { first.id.clone() });
                // The crown: a team's own (its register `desk/<id>`, `crown`) decides on that team; a team without
                // one keeps the room's single crown, if that session stands on it.
                let crowned = match own.as_ref().and_then(|d| teams.iter().find(|x| &x.id == d)).and_then(|d| d.crown.as_ref()) {
                    None => row.starred,
                    Some(c) => match c.get("session_id").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                        Some(s) => row.session_id.as_deref() == Some(s),
                        None => {
                            let dev = c.get("agent_device_id").and_then(Value::as_str).filter(|s| !s.is_empty());
                            dev.is_some() && dev == row.agent_device_id.as_deref()
                        }
                    },
                };
                let session = model.sessions.get(&row.key);
                Agent {
                    on_team: teams.is_empty() || own == team,
                    codex: row
                        .agent_device_id
                        .as_deref()
                        .and_then(|d| model.members.get(d))
                        .is_some_and(|d| d.platform.as_str() == Some("codex")),
                    said_goodbye: session.and_then(|s| s.link.as_ref()).is_some_and(|l| l.exit.is_some()),
                    team: own,
                    crowned,
                    row,
                }
            })
            .collect();
        let mut by_key: HashMap<String, usize> = agents.iter().enumerate().map(|(i, a)| (a.row.key.clone(), i)).collect();
        // (a helper session of before has no entry: its cards count under its main)
        let mut legacy = std::collections::BTreeMap::new();
        let mut legacy_archived = std::collections::BTreeSet::new();
        for h in legacy_rows {
            if let Some(&i) = by_key.get(&h.main) {
                if h.archived {
                    legacy_archived.insert(h.key.clone());
                }
                legacy.insert(h.key.clone(), h.name);
                by_key.insert(h.key, i);
            }
        }
        let by_id: HashMap<String, usize> = agents.iter().enumerate().map(|(i, a)| (a.row.id.clone(), i)).collect();

        let mut all_fresh = Vec::new();
        for c in model.stack.iter().filter_map(|id| model.cards.get(id)) {
            if c.object_state != "open" || c.catching_up || c.in_revision.is_some() || reads_as_info(c) {
                continue;
            }
            all_fresh.push(Fresh {
                id: c.object_id.clone(),
                agent: by_key.get(key_of(&c.session_id, &c.agent_device_id)).copied(),
                knocks: matches!(c.urgency.as_str(), "high" | "critical"),
                permission: false,
            });
        }
        // (a request not read here yet says nothing of what it asks to run: it waits quietly, as a card does)
        for p in model.open_permission_ids.iter().filter_map(|id| model.permissions.get(id)) {
            if p.permission_state != "pending" || p.catching_up || !request_is_read(p) {
                continue;
            }
            all_fresh.push(Fresh {
                id: p.object_id.clone(),
                agent: by_key.get(key_of(&p.session_id, &p.agent_device_id)).copied(),
                knocks: true,
                permission: true,
            });
        }

        let mut board = Board {
            model,
            lens,
            now,
            agents,
            by_key,
            legacy,
            legacy_archived,
            by_id,
            teams,
            team,
            all_fresh,
            unheard: HashMap::new(),
            wake: Cell::new(None),
            helpers: OnceCell::new(),
            numbers: OnceCell::new(),
            assets: OnceCell::new(),
        };
        board.unheard = board.count_unheard();
        board
    }

    /// Whether what belongs to this session shows on the team in view. A session the list does not show counts as
    /// standing on the first team.
    pub fn in_view(&self, agent: Option<usize>) -> bool {
        match agent {
            Some(i) => self.agents[i].on_team,
            None => self.teams.is_empty() || self.team.as_deref() == self.teams.first().map(|d| d.id.as_str()),
        }
    }

    /// Whether what belongs to this session stands on the Desk in view: home holds every team's, else the team in
    /// view's.
    pub fn on_desk(&self, agent: Option<usize>) -> bool {
        self.lens.desk_all || self.in_view(agent)
    }

    /// The team a card of this session counts on, in a room with teams.
    pub fn team_of(&self, agent: Option<usize>) -> Option<&str> {
        match agent {
            Some(i) => self.agents[i].team.as_deref(),
            None => self.teams.first().map(|d| d.id.as_str()),
        }
    }

    /// A card's or a request's number ("Nr. 12"): the order they were first filed in, from 1, never reused, the
    /// same on every device (the web's `numberOf`). 0 for one this device does not hold.
    pub fn number_of(&self, id: &str) -> u32 {
        let all = self.numbers.get_or_init(|| {
            let m = self.model;
            let mut filed: Vec<(u64, &str)> = m.cards.values().map(|c| (c.first_envelope_number, c.object_id.as_str())).collect();
            filed.extend(m.permissions.values().map(|p| (p.envelope_number, p.object_id.as_str())));
            // (a stable sort: of two filed in the same envelope, a card stands before a request)
            filed.sort_by_key(|(n, _)| *n);
            filed.into_iter().enumerate().map(|(i, (_, id))| (id.to_string(), i as u32 + 1)).collect()
        });
        all.get(id).copied().unwrap_or(0)
    }

    /// The helper a card comes from (`helpers.rs`).
    pub fn helper_of(&self, c: &Card) -> Option<String> {
        crate::helpers::of_card(c, &self.legacy)
    }

    /// A session's helpers, in the order they first showed (`helpers.rs`): none for one without.
    pub fn helpers(&self, agent: usize) -> &[Helper] {
        let all = self.helpers.get_or_init(|| {
            let m = self.model;
            let fresh: std::collections::HashSet<&str> = self.all_fresh.iter().map(|f| f.id.as_str()).collect();
            let mut cards: HashMap<usize, Vec<crate::helpers::HelperCard>> = HashMap::new();
            for c in m.cards.values().filter(|c| c.object_state != "closed" && !c.session_id.as_ref().is_some_and(|s| self.legacy_archived.contains(s))) {
                let Some(name) = self.helper_of(c) else { continue };
                let Some(&i) = self.by_key.get(key_of(&c.session_id, &c.agent_device_id)) else { continue };
                cards.entry(i).or_default().push((c, Some(name), fresh.contains(c.object_id.as_str())));
            }
            let mut out = HashMap::new();
            for (i, a) in self.agents.iter().enumerate() {
                let lines = m.sessions.get(&a.row.key).map(|s| s.status_lines.as_slice()).unwrap_or(&[]);
                let now = self.now;
                let shown = |t: &crate::model::types::StatusLine| -> Option<&str> {
                    let state = a.row.lines.get(&t.id)?.as_str();
                    let age = now.saturating_sub(t.updated_at);
                    match state {
                        "working" | "decision" | "later" => Some(state),
                        "done" if age < super::session::WORKING_WINDOW_MS => {
                            self.wake_at(Some(t.updated_at + super::session::WORKING_WINDOW_MS));
                            Some(state)
                        }
                        _ => None,
                    }
                };
                let list = crate::helpers::helpers_of(lines, shown, cards.remove(&i).unwrap_or_default());
                if !list.is_empty() {
                    out.insert(i, list);
                }
            }
            out
        });
        all.get(&agent).map(Vec::as_slice).unwrap_or(&[])
    }

    /// The board's Artifacts, for naming the links to them.
    pub fn assets(&self) -> &super::links::Assets {
        self.assets.get_or_init(|| super::links::Assets::of(self.model))
    }

    /// Where a card stands: "catching" (settled elsewhere, its outcome on the way), "open", "shredded", "decided"
    /// (his answer stands), "done" (closed by its agent, withdrawn, merged).
    pub fn status_of(c: &Card) -> &'static str {
        if c.catching_up {
            "catching"
        } else if c.object_state == "open" {
            "open"
        } else if c.closed_how.as_deref() == Some("shredded") {
            "shredded"
        } else if c.closed_how.as_deref() == Some("answered") && c.object_state == "answered" {
            "decided"
        } else {
            "done"
        }
    }

    /// Whether a session runs (connected, or cut off: it still works on what it was given).
    pub fn runs(&self, agent: usize) -> bool {
        let r = &self.agents[agent].row;
        r.online || r.link.as_ref().is_some_and(|l| l.state == "cut")
    }

    /// The open questions of the team in view.
    pub fn fresh(&self) -> impl Iterator<Item = &Fresh> {
        self.all_fresh.iter().filter(|f| self.in_view(f.agent))
    }

    /// The screen is to be made again at `at` by the clock alone (a count of minutes, an answer that turns late).
    pub fn wake_at(&self, at: Option<u64>) {
        self.wake.set(earliest(self.wake.get(), at));
    }

    /// When any unit made from this board so far changes by the clock alone.
    pub fn wake(&self) -> Option<u64> {
        self.wake.get()
    }

    /// Whether the card's session has the person's last word on it (his answer, or the hand back): none when there
    /// is nothing to hear. `heard`: none when its connector writes no receipts.
    pub fn heard_of(&self, c: &Card) -> Option<Heard> {
        if c.catching_up {
            return None;
        }
        let a = c.answer.as_ref();
        let open = c.object_state == "open";
        let decided = c.closed_how.as_deref() == Some("answered") && c.object_state == "answered";
        // (when he said it: the hand back's message, or his answer)
        let at = if open {
            let r = c.in_revision.as_ref()?;
            self.model
                .timelines
                .get(&c.timeline_key)
                .and_then(|t| t.items.get(&crate::model::types::ItemKey::Number(r.envelope_number)))
                .and_then(|i| i.get("sent_at"))
                .and_then(Value::as_u64)
                .unwrap_or(c.updated_at)
        } else if decided {
            a?.answered_at
        } else {
            return None;
        };
        if at == 0 || a.is_some_and(|a| a.pending) {
            return None;
        }
        let said = if open { c.in_revision.as_ref().map(|r| r.envelope_number) } else { a.and_then(|a| a.envelope_number) };
        let mark = self.model.sessions.get(key_of(&c.session_id, &c.agent_device_id)).and_then(|s| s.heard_up_to);
        let heard = match (said, mark) {
            (Some(said), Some(mark)) => Some(said <= mark),
            _ => None,
        };
        let waiting = if heard == Some(true) { 0 } else { self.now.saturating_sub(at) };
        Some(Heard {
            heard,
            waiting,
            late: heard == Some(false) && waiting >= UNHEARD_MS,
            late_at: (heard == Some(false) && waiting < UNHEARD_MS).then_some(at + UNHEARD_MS),
        })
    }

    fn count_unheard(&self) -> HashMap<usize, u32> {
        let mut out: HashMap<usize, u32> = HashMap::new();
        for c in self.model.cards.values() {
            // (only a card with his word on it can wait to be heard: one handed back, or decided; the rest, most of a
            //  large room, are passed over before any lookup)
            let decided = c.object_state == "answered" && c.closed_how.as_deref() == Some("answered");
            if c.catching_up || !(decided || (c.object_state == "open" && c.in_revision.is_some())) {
                continue;
            }
            // (every team's: the wide sidebar shows them all; the Desk's and the tab's sums keep to the team in view)
            let agent = self.by_key.get(key_of(&c.session_id, &c.agent_device_id)).copied();
            let Some(h) = self.heard_of(c) else { continue };
            self.wake_at(h.late_at);
            if let (true, Some(i)) = (h.late, agent) {
                *out.entry(i).or_default() += 1;
            }
        }
        out
    }
}

/// Whether a session picked up the person's last word on a card.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Heard {
    pub heard: Option<bool>,
    /// How long his word has waited, 0 once it was heard.
    pub waiting: u64,
    /// Not heard for [`UNHEARD_MS`].
    pub late: bool,
    /// When it turns late, if it has not yet.
    pub late_at: Option<u64>,
}

pub const GOALS_LINES: usize = 20;
pub const GOALS_LINE_MAX: usize = 200;

/// A team's goals as they are kept: at most [`GOALS_LINES`] lines of at most [`GOALS_LINE_MAX`] characters (UTF-16
/// units, never half a character), no blank lines at either end, no trailing spaces.
pub fn clean_goals(text: &str) -> String {
    let unified = text.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<String> = unified
        .split('\n')
        .map(|l| {
            let l = l.trim_end();
            let mut units = 0;
            l.chars().take_while(|c| { units += c.len_utf16(); units <= GOALS_LINE_MAX }).collect()
        })
        .collect();
    let joined = lines.join("\n");
    joined.trim_matches('\n').split('\n').take(GOALS_LINES).collect::<Vec<_>>().join("\n")
}

/// Makes the board's units of `view` again from the model: the sidebar, the Desk, the pages in view, the notes and
/// the settings.
/// What the engine and the account own (`phase`, `status`, `account`, `files`, `toasts`) is left as it is. Returns
/// when to call again by the clock alone (a count of minutes, an answer that turns late), if ever. The App calls
/// this after each batch and at that moment, and sends what `ViewModel::diff` finds.
pub fn render(model: &Model, lens: &Lens, now: u64, view: &mut super::ViewModel) -> Option<u64> {
    render_with_files(model, lens, now, view).0
}

/// [`render`], and the files the units show with their references (`views::files_seen`): what the App lets the
/// person open and share. `view.files` is the App's to fill from them.
pub fn render_with_files(model: &Model, lens: &Lens, now: u64, view: &mut super::ViewModel) -> (Option<u64>, std::collections::BTreeMap<String, serde_json::Map<String, serde_json::Value>>) {
    super::files_seen::begin();
    let wake = render_units(model, lens, now, view);
    (wake, super::files_seen::take())
}

fn render_units(model: &Model, lens: &Lens, now: u64, view: &mut super::ViewModel) -> Option<u64> {
    let b = Board::new(model, lens, now);
    view.sidebar = super::sidebar::sidebar(&b);
    let off = super::off::of_board(&b);
    view.desk = super::desk::desk_with(&b, &off);
    view.off = lens.off.as_deref().map(|q| super::off::off_list(&b, &off, q));
    view.artifacts = lens.artifacts.then(|| super::session::artifacts(&b));
    view.desk.tiles = if lens.artifacts && view.desk.mode != "invite" { super::desk::desk_tiles(&view.desk, view.artifacts.as_deref().unwrap_or_default(), b.team.as_deref().filter(|_| !lens.desk_all)) } else { Vec::new() };
    view.gallery = None;
    // (the gallery filters what it lists; the Desk's foot keeps every one)
    if let Some(kind) = lens.gallery.as_deref() {
        let (gallery, shown) = super::session::gallery(&b, kind, view.artifacts.take().unwrap_or_default());
        view.gallery = Some(gallery);
        view.artifacts = Some(shown);
    }
    view.knowledge = lens.knowledge.as_ref().map(|ask| super::knowledge::page(&b, ask));
    view.notes = super::notes::notes(&b);
    // (what the account read keeps: the e-mail is the account's, W3)
    // (what the App adds beside the model: the account read, the room, the teams' deletes)
    let mut kept = std::mem::take(&mut view.settings);
    view.settings = super::settings::settings(&b);
    view.settings.account = kept.account.take();
    view.settings.login = kept.login.take();
    view.settings.data = kept.data.take();
    view.settings.room = kept.room.take();
    view.settings.hub = kept.hub.take();
    view.settings.team_counts = std::mem::take(&mut kept.team_counts);
    view.settings.deleting = std::mem::take(&mut kept.deleting);
    view.settings.push = kept.push.take();
    // The pages in view: one session, one card. A page that is left is taken away.
    view.sessions.clear();
    if let Some(s) = lens.session.as_deref().and_then(|id| super::session::session(&b, id)) {
        view.sessions.insert(s.id.clone(), s);
    }
    view.cards.clear();
    if let Some(c) = lens.card.as_deref().and_then(|id| super::card::card(&b, id, &view.desk.stack)) {
        view.cards.insert(c.id.clone(), c);
    }
    // (and when a session's link, red hand or status line changes by the clock: status.rs `recheck_at`)
    let status = b.agents.iter().filter_map(|a| a.row.recheck_at).min();
    earliest(b.wake(), status)
}
