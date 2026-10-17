//! The view model: what every screen shows, decided once. A shell draws it and nothing else.
//!
//! The core sends it as [`ViewDelta`]s inside `Effect::Render`. A shell keeps one [`ViewModel`] and folds each delta
//! into it with [`ViewModel::apply`] (or its own copy of the same rule, which the conformance scripts check).
//!
//! **Units.** A delta replaces whole units: the phase, the sidebar, the Desk, one session, one card, the notes,
//! the settings, the toasts. A unit is keyed where there are many (sessions and cards by id); `None` removes one.
//! A list that can be long (the Desk's stack, a session's talk) may later travel as [`Rows`] edits instead of
//! whole; folding gives the same model either way.
//!
//! **Texts.** Every word a screen shows that depends on state is a [`Text`]: a key, its arguments, and the
//! English sentence. Shells show `en` today; a translation later looks the key up. A shell never builds such a
//! sentence itself. Fixed labels (a button's "Send") stay the shell's.
//!
//! W4 fills the screen types; their fields here are the contract's first cut.
//!
//! **Who makes it.** [`board::Board`] reads the board model once per render (the session list, the teams, what
//! waits where), and each screen's module makes its unit from it: [`sidebar`], [`desk`], [`session`] and [`card`] (the pages in view;
//! its conversation's rows come from [`talk`]), [`notes`] and [`settings`]. The rules are the web app's of
//! before (`app/web/public/app.mjs` `boardModel`), now here and nowhere else; [`words`] holds every sentence.
//! What this device alone chooses (the team in view, the zone) comes in as a [`Lens`].

pub mod board;
pub mod card;
pub mod demo;
pub mod files_seen;
pub mod desk;
pub mod knowledge;
pub mod links;
pub mod notes;
pub mod off;
pub mod session;
pub mod settings;
pub mod sidebar;
pub mod talk;
#[cfg(test)]
mod testroom;
pub mod words;

pub use board::{render, render_with_files, Board, Lens, MoreOf};

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A sentence of the core: `key` names it, `args` fill it, `en` is it in English.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Text {
    pub key: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub args: BTreeMap<String, String>,
    pub en: String,
}

impl Text {
    pub fn new(key: &str, en: &str) -> Self {
        Self {
            key: key.into(),
            args: BTreeMap::new(),
            en: en.into(),
        }
    }
}

/// Where the app stands, for the whole window.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// Before `Start`, or while the stored room is read.
    #[default]
    Starting,
    /// No room on this device: the sign-in and join screens.
    SignedOut,
    /// A room is open; the Desk is being read for the first time on this device.
    Opening,
    /// Open and current, the live stream runs.
    Live,
    /// Open, showing what it has; the hub cannot be reached right now.
    Offline,
    /// The device was removed, or another owner took its state. Nothing more is done.
    Stopped,
}

/// What the person looks at. Sent by the shell as `Event::Focus`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Focus {
    pub screen: Screen,
    /// The window (or app) is in front and visible.
    #[serde(default = "yes")]
    pub visible: bool,
    /// The team in view: a team's id; none when none was chosen, or one that is gone: the first team.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team: Option<String>,
    /// The Scribble Board shown beside the screen (the Desk's): `desk/<32 hex>`, or a team's id or "all" for that
    /// team's board. `Screen::Scribble` shows its own. The core reads it and sends `ViewModel.board`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub board: Option<String>,
    /// The Desk in view is home, every team's (the bell at the top), not the team in view's (a team's head).
    /// This device's: the shell keeps it.
    #[serde(default)]
    pub desk_all: bool,
    /// The teams unfolded in the wide sidebar, their chats under their stack (`TeamStackView.open`). This device's:
    /// the shell keeps them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub open_teams: Vec<String>,
    /// The words searched for among every team's chats (the phone's Search tab, `SidebarView.found`); none or empty:
    /// no search.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chats_query: Option<String>,
    /// The calm chat (the iPhone and the web send it): a session's page folds a run of card events into one row of
    /// chips (`kind` "events"), leaves the helper list out and says "and 2 more" beside the working line. A shell
    /// that draws the full talk (Linux) leaves it false.
    #[serde(default)]
    pub calm: bool,
}

fn yes() -> bool {
    true
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "screen", rename_all = "snake_case")]
pub enum Screen {
    #[default]
    Desk,
    Session {
        session_id: String,
    },
    Card {
        card_id: String,
    },
    Notes,
    /// The page Off your mind, the complete list, with the search's words (empty: all).
    Off {
        #[serde(default)]
        query: String,
    },
    Scribble {
        board_id: String,
    },
    /// The gallery of every Artifact the agents published, with its filter: "" every one, "media" the pictures,
    /// videos and files, "pages" the pages.
    Artifacts {
        #[serde(default, skip_serializing_if = "String::is_empty")]
        kind: String,
    },
    /// The page Knowledge of the team in view, with the search's words and its filter ("" every entry, "pinned").
    Knowledge {
        #[serde(default, skip_serializing_if = "String::is_empty")]
        query: String,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        filter: String,
    },
    /// Settings: its list (`page` ""), or one of its pages ("agents", "teams", "devices", "account", "theme",
    /// "data", "security").
    Settings {
        #[serde(default, skip_serializing_if = "String::is_empty")]
        page: String,
    },
}

/// Everything the shell draws. Serialised, this is what the conformance scripts compare.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ViewModel {
    /// Counts the deltas folded in; a delta whose `base` is not this is out of order (a shell bug).
    pub rev: u64,
    pub phase: Phase,
    /// One line on where the app stands when it is not plainly live ("Catching up", "Offline: retry in 30 s").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<Text>,
    pub sidebar: SidebarView,
    pub desk: DeskView,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub sessions: BTreeMap<String, SessionView>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub cards: BTreeMap<String, CardView>,
    /// The page Off your mind, while it is in view (`Screen::Off`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub off: Option<OffListView>,
    pub notes: NotesView,
    pub settings: SettingsView,
    /// Signing in, joining, the emoji to compare, the Emergency Kit to keep, self-join asks.
    pub account: AccountView,
    /// Files the views name (attachments, pictures), by id: uploading, ready, failed. Their bytes, when loaded,
    /// came as `Effect::FileReady` under the same id.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub files: BTreeMap<String, FileView>,
    /// The Scribble Board in view (`Focus.board`, `Screen::Scribble`); none when no board is shown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub board: Option<BoardView>,
    /// The gallery of Artifacts, while it is in view (`Screen::Artifacts`, and on the Desk, whose foot shows the newest), the newest first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifacts: Option<Vec<ArtifactView>>,
    /// The gallery's filter and its words, while `Screen::Artifacts` is in view (`artifacts` then holds what the
    /// filter lets through); none else.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gallery: Option<GalleryView>,
    /// Every team's Scribble Board small, in the menu's order, while a page shows them (Settings, the boards of All
    /// teams); none else.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbs: Option<Vec<ThumbView>>,
    /// The page Knowledge of the team in view, while it is in view (`Screen::Knowledge`); none else.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub knowledge: Option<KnowledgeView>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub toasts: Vec<Toast>,
}

/// One change of the view model, from `base` to `base + 1`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ViewDelta {
    pub base: u64,
    pub parts: Vec<ViewPart>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "part", rename_all = "snake_case")]
// (a unit travels whole and is cloned into the model once: boxing each would only move the copy)
#[allow(clippy::large_enum_variant)]
pub enum ViewPart {
    /// Everything, replacing what the shell had (the first render, after a restart of the core).
    Whole {
        model: Box<ViewModel>,
    },
    Phase {
        phase: Phase,
        status: Option<Text>,
    },
    Sidebar {
        view: SidebarView,
    },
    Desk {
        view: DeskView,
    },
    Session {
        id: String,
        view: Option<SessionView>,
    },
    Card {
        id: String,
        view: Option<Box<CardView>>,
    },
    /// The page Off your mind; none when it is left.
    Off {
        view: Option<OffListView>,
    },
    Notes {
        view: NotesView,
    },
    Settings {
        view: SettingsView,
    },
    Account {
        view: AccountView,
    },
    File {
        id: String,
        view: Option<FileView>,
    },
    /// The Scribble Board in view, whole; none when it is left.
    Board {
        view: Option<BoardView>,
    },
    /// The gallery of Artifacts, whole; none when it is left.
    Artifacts {
        view: Option<Vec<ArtifactView>>,
    },
    /// The gallery's filter and words, whole; none when it is left.
    Gallery {
        view: Option<GalleryView>,
    },
    /// The teams' boards small, whole; none when no page shows them.
    Thumbs {
        view: Option<Vec<ThumbView>>,
    },
    /// The page Knowledge, whole; none when it is left.
    Knowledge {
        view: Option<KnowledgeView>,
    },
    Toasts {
        toasts: Vec<Toast>,
    },
}

/// Edits of a long list, by position: at `at`, `gone` rows leave and `rows` come (the Desk's stack ops today).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RowEdit<T> {
    pub at: u32,
    pub gone: u32,
    pub rows: Vec<T>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "rows", rename_all = "snake_case")]
pub enum Rows<T> {
    Whole { items: Vec<T> },
    Edits { edits: Vec<RowEdit<T>> },
}

impl<T: Clone> Rows<T> {
    /// Applies these rows to `list`. An edit past the end is cut to the end (never a panic in a shell's fold).
    pub fn fold_into(&self, list: &mut Vec<T>) {
        match self {
            Rows::Whole { items } => *list = items.clone(),
            Rows::Edits { edits } => {
                for e in edits {
                    let at = (e.at as usize).min(list.len());
                    let end = (at + e.gone as usize).min(list.len());
                    list.splice(at..end, e.rows.iter().cloned());
                }
            }
        }
    }
}

/// The sidebar (the phone: the menu's teams, the list of chats, the tab pill's numbers): the teams, and one row per
/// session of the team in view, in the order they are drawn.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SidebarView {
    /// The teams, in the menu's order. A room without teams has one: "Personal".
    pub teams: Vec<TeamTab>,
    /// Home in the menu, above the teams: the Desk of every team ("All teams", `Focus.desk_all`), with what waits on
    /// all of them; `selected` while it is the Desk in view. Its `id` is empty.
    #[serde(default)]
    pub home: TeamTab,
    /// The sessions of the team in view, one row each, in drawing order: a main, then its helpers.
    pub sessions: Vec<SessionRowView>,
    /// The number on the app icon and the tab: the open questions of the Desk in view, the team's or on home every
    /// team's (no infos, nothing that is with its agent). Never drawn red.
    pub badge: u32,
    /// The team in view: its id.
    #[serde(default)]
    pub team: String,
    /// Where the person is, for the head and the team switch: the team's name.
    #[serde(default)]
    pub place: Text,
    /// The open questions of the Desk in view, the team's or on home every team's (its lamp is lit while there are
    /// some).
    #[serde(default)]
    pub waiting: u32,
    /// How many of them knock.
    #[serde(default)]
    pub knocking: u32,
    /// How many rows of the team in view are stopped (the red hand).
    #[serde(default)]
    pub stopped: u32,
    /// How many of them are at work.
    #[serde(default)]
    pub working: u32,
    /// How many of his answers the sessions of the team in view have not picked up.
    #[serde(default)]
    pub unheard: u32,
    /// Every team as a stack, in the menu's order (the wide sidebar): folded, its head over a fan of its sessions'
    /// card edges; open, its chats under it. The phone draws `sessions` instead.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stacks: Vec<TeamStackView>,
    /// The Desk in view is every team's (home, `Focus.desk_all`): no team's head is marked.
    #[serde(default)]
    pub desk_all: bool,
    /// Under a search (`Focus.chats_query`): every team with a chat whose name or teaser has the words, with those
    /// chats, in the menu's order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub found: Vec<ChatGroupView>,
    /// Under a search that finds no chat: so it says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub found_none: Option<Text>,
}

/// A team in the search's list of chats: its name as a plain section title over the chats found.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatGroupView {
    pub id: String,
    pub name: Text,
    /// Its chats that have the words, one row each, in drawing order.
    pub rows: Vec<SessionRowView>,
}

/// A team in the wide sidebar: its head (a click opens its Desk) over its sessions, folded to a stack or open.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TeamStackView {
    pub id: String,
    pub name: Text,
    /// The team in view and its Desk is the Desk (not on home, `desk_all`).
    pub selected: bool,
    /// Open on this device (`Focus.open_teams`): its chats stand under its head; folded, they lie as its stack.
    #[serde(default)]
    pub open: bool,
    /// The open questions of the team's sessions.
    pub waiting: u32,
    /// One of them knocks.
    #[serde(default)]
    pub knocks: bool,
    /// What the head says to a screen reader: "3 agents, 2 questions open".
    pub says: Text,
    /// A card edge per session (at most [`STACK_EDGES`]), in the rows' order. What knocks is said by the head's
    /// number, not by an edge.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub edges: Vec<StackEdgeView>,
    /// Its picture, as a group's: up to three of its sessions' own marks, overlapping, the crowned one first, then in
    /// the rows' order; none for a team without sessions (a quiet placeholder).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub faces: Vec<StackEdgeView>,
    /// Its sessions, one row each, in drawing order (connected first); drawn while open.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sessions: Vec<SessionRowView>,
}

/// So many sessions have a card edge of their own in a folded team's stack.
pub const STACK_EDGES: usize = 6;

/// A session in a team's stack: its card edge, or its face in the team's picture.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StackEdgeView {
    /// The session's key (its row's id).
    pub id: String,
    /// What draws it (its row's mark): the edge takes its colour.
    pub mark: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TeamTab {
    pub id: String,
    pub name: Text,
    /// The open questions of the team's sessions.
    pub waiting: u32,
    /// It is the Desk in view: the team in view, unless home (`desk_all`) is.
    pub selected: bool,
    /// One of them knocks.
    #[serde(default)]
    pub knocks: bool,
}

/// One session in the sidebar.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionRowView {
    /// The session's key in the model (`Screen::Session`, the actions' `session_id`, `ViewModel.sessions`).
    pub id: String,
    pub name: Text,
    /// "live", "oncall", "asleep", "cut", "gone" (core/client/src/status.rs).
    pub link: String,
    /// The red hand.
    pub blocked: bool,
    /// How many of his answers it has not picked up for two minutes.
    pub unheard: u32,
    /// Its short id on the board: its address (`/chat/<slug>`).
    #[serde(default)]
    pub slug: String,
    /// What draws it: always a face, "draw:<face>" (`faces::mark`: the icon the person or the agent chose, else the face
    /// its name fits, else the one its id picks).
    #[serde(default)]
    pub mark: String,
    /// The team it stands on.
    #[serde(default)]
    pub team_id: String,
    #[serde(default)]
    pub online: bool,
    /// Connected and at work (a status line of it shows "working").
    #[serde(default)]
    pub working: bool,
    /// A main session: one that says so.
    #[serde(default)]
    pub main: bool,
    /// The crowned session of its team (the one a note goes to).
    #[serde(default)]
    pub crowned: bool,
    /// Its helpers (its agent's subagents), small under its name: "3 helpers" with a dot each; none without.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helpers: Option<HelperDotsView>,
    /// Its open questions: what waits for the person on the Desk (no infos, nothing that is with its agent).
    #[serde(default)]
    pub open: u32,
    /// One of them knocks.
    #[serde(default)]
    pub knocks: bool,
    /// Why it is stopped, in words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hand: Option<HandView>,
    /// The small line under its name: its link when it does not hear at once, else the answers it has not picked up.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cap: Option<CapView>,
    /// Not connected: it stands under "Disconnected".
    #[serde(default)]
    pub away: bool,
    /// The part of the list a row may be dragged within (its team, connected or not).
    #[serde(default)]
    pub group: String,
    /// What its badge says to a screen reader ("Working, 2 questions open"); none without a badge.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub says: Option<Text>,
    /// What was said last in its conversation (his words with "You: "), or the question it put to him last: the
    /// Chat list's teaser; none while this device holds nothing said there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last: Option<LastSaidView>,
    /// Its agent said something this device has not shown yet (the chat was not open since): the Chat list's dot.
    #[serde(default)]
    pub unread: bool,
    /// The one quiet sign of a calm chat row: "stopped" (the red hand), "waiting" (a question waits for him),
    /// "unread" (new words), or "" for none.
    #[serde(default)]
    pub signal: String,
}

/// What a conversation said last, for its row in the Chat list.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LastSaidView {
    /// Its first words as one plain line (200 characters at most): "You: …" for his own.
    pub text: String,
    pub at_ms: u64,
    /// When, as a chat list says it: "14:05" today, "Yesterday", a weekday within the week, "3 Oct", "03.10.25".
    pub when: Text,
}

/// A session's helpers in its sidebar row: how many, and a dot each.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelperDotsView {
    /// "1 helper", "3 helpers".
    pub says: Text,
    /// One dot per helper, in order: filled while that helper works.
    pub working: Vec<bool>,
}

/// A session's helpers on its page: a short list, name and state, no way into a chat of their own.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelperListView {
    /// "3 helpers".
    pub head: Text,
    /// "1 working · their cards come with this session".
    pub sub: Text,
    pub rows: Vec<HelperRowView>,
}

/// One helper of a session's page.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelperRowView {
    pub name: String,
    pub working: bool,
    /// "Working · 1 open question", "1 open question", "Done".
    pub says: Text,
}

/// Why a session is stopped: the red hand.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HandView {
    /// "cut", "offline", "permission", "blocking".
    pub why: String,
    pub text: Text,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<u64>,
}

/// The small line under a session's name.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapView {
    /// "oncall", "asleep", "cut", "gone", or "unheard" (it hears at once and has answers to pick up).
    pub kind: String,
    /// Two or three words: "cut off · 14:05", "1 answer waits".
    pub word: Text,
    /// The tooltip: "Cut off since 14:05".
    pub short: Text,
    /// The whole sentence about the session, for a screen reader; none for "unheard".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<Text>,
}

/// A session's link in words: whether it hears the person, and what to do when it does not.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkWords {
    /// "live", "oncall", "asleep", "cut", "gone".
    pub state: String,
    /// Since when it is cut off or gone; for "oncall" and "asleep" its last step.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<u64>,
    /// Two or three words under its name ("not listening · 12 min"); none while it hears at once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub word: Option<Text>,
    /// The same as a short sentence ("Not listening for 12 min").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub short: Option<Text>,
    /// The whole sentence about the session.
    pub line: Text,
    /// The way out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fix: Option<FixView>,
}

/// What to do about a link: a sentence, and a line to type (empty when there is none).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FixView {
    pub say: Text,
    pub code: String,
}

/// The Desk of the team in view: its head, and the stack of what waits for the person as rows.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeskView {
    /// Card and request ids, in the Desk's order: the ids of `rows`.
    pub stack: Vec<String>,
    /// Off your mind, of the team in view (`off.rs`, from the core's `off_mind`): the cards with their agents,
    /// starred ones too, the one that moved last first (the complete list's top part).
    pub off_your_mind: Vec<String>,
    /// The put-off cards, the last put off first.
    pub later: Vec<String>,
    /// The cards closed last (done, withdrawn, shredded), the newest first: the core's window of them
    /// (`off_mind::RECENT` for the whole room), not every closed card; the complete list has them all.
    pub done: Vec<String>,
    /// The two stacks docked at the Desk's foot; none while a stack is empty. A card has one home: a starred card
    /// is in `starred` only, also while it is being worked on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub starred: Option<DockView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub running: Option<DockView>,
    /// The section Off your mind under the Desk: its first rows and how many; none while nothing is put off or
    /// closed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub off: Option<OffHintView>,
    /// What stands in the list's place when nothing is open at all ("Questions land here.").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub empty: Option<Text>,
    /// "invite" (no session stands here yet: invite the first agent), "reading" (none yet, and the room is still
    /// being read), "team".
    #[serde(default)]
    pub mode: String,
    /// The one big line at the top; none for "invite".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hello: Option<Text>,
    /// How far the reading of the room's past is ("Reading your history: 12,400 of 27,000"), while it is read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reading: Option<Text>,
    /// The team's goals; none on All teams.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goals: Option<GoalsView>,
    /// The chip that opens the team's page Knowledge; none on All teams, as the goals.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub knowledge: Option<KnowledgeChipView>,
    /// What waits, in the Desk's order: the questions and what is only to read.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rows: Vec<DeskRowView>,
    /// The open questions (no infos): the number in the window's title.
    #[serde(default)]
    pub waiting: u32,
    /// What Blitz walks through and the duck closes ("Blitz: 3 open cards"); none when nothing waits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blitz: Option<Text>,
    /// The duck for all beside Blitz: what one press leaves to the agents (a decision) or reads (an info) at once,
    /// after one question; none when nothing of that waits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duck: Option<DuckAllView>,
    /// The sessions that are cut off, above the questions: one line each, with the step in its terminal.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub slip: Vec<SlipView>,
    /// Under the questions, calm tiles, in this order: "work" (Working / Done: what runs and what is done, it opens
    /// Off your mind), "artifacts" (what the agents published), "board" (the team's Scribble Board), "knowledge"
    /// (the team's Knowledge; not on All teams).
    /// Empty while the Desk is not in view.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tiles: Vec<DeskTileView>,
}

/// One tile under the Desk's questions.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeskTileView {
    /// "work", "artifacts", "board" or "knowledge".
    pub key: String,
    /// Its name: "Working / Done", "Artifacts", "Scribble Board", "Knowledge".
    pub title: Text,
    /// What it holds in a few words: "2 running · 10 done", "14 artifacts", "27 elements", "7 entries"; "Nothing
    /// yet" when empty.
    pub line: Text,
    /// How many (artifacts, elements on the board, entries); none where the line says it ("work").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<u32>,
    /// Where a click goes: `Screen::Off`, `Screen::Artifacts`, `Screen::Scribble`.
    pub opens: Screen,
    /// What it shows small, in order: the running cards (ids of `DeskView.off.running`) for "work", the newest
    /// artifacts (ids of `ViewModel.artifacts`, at most four) for "artifacts"; empty for "board".
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<String>,
    /// "board": the team whose board it shows small (a `ThumbView.team_id`); "knowledge": its team. None on All teams.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
}

/// The duck for all: the cards it clears (`Action::Batch` with way "sweep") and its words (the web's `duckAll`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DuckAllView {
    /// The cards it clears, in the Desk's order: the open decisions (left to their agents) and what is only to
    /// read (closed as read); never a request, nothing not read on this device yet.
    pub card_ids: Vec<String>,
    /// The button's name: "I don’t give a duck: for all 3 open cards".
    pub tip: Text,
    /// Its short name where its question follows at once (the iPhone's ⋯ menu): "IDGAD".
    #[serde(default)]
    pub short: Text,
    /// How many of which, for a screen reader: "2 decisions go to the agents, 1 card to read is closed".
    pub what: Text,
    /// The one question it asks: "Duck all 3?"; only cards to read: "Close all 2 as read?".
    pub ask: Text,
    /// The yes: "Yes, duck them all", "Yes, all read".
    pub yes: Text,
    /// The quiet way out: "Cancel".
    pub no: Text,
}

/// The gallery's filter (`Screen::Artifacts.kind`) and what its page says.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GalleryView {
    /// The filter in force: "", "media" or "pages".
    #[serde(default)]
    pub kind: String,
    /// The filter's choices, in order ("All", "Media", "Pages"); none while there is no Artifact at all.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub kinds: Vec<GalleryKindView>,
    /// The line under the page's title.
    pub lead: Text,
    /// What the page says when the filter lets nothing through ("No pages yet."); none when it shows something.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub none: Option<Text>,
}

/// One choice of the gallery's filter.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GalleryKindView {
    /// "", "media" or "pages": what `Screen::Artifacts.kind` takes.
    #[serde(default)]
    pub key: String,
    pub label: Text,
    /// How many it lets through.
    #[serde(default)]
    pub count: u32,
    /// It is the one in force.
    #[serde(default)]
    pub on: bool,
}

/// One of the two stacks docked at the Desk's foot (the owner's pick of 13 October 2026: two small tabs, the
/// titles shown only when a stack is fanned out).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DockView {
    /// "star" or "run".
    pub key: String,
    /// How many cards it holds: the number on its tab (`rows.len()`).
    pub count: u32,
    /// What the tab says to a screen reader ("3 starred", "1 running").
    pub says: Text,
    /// Its cards in order, fanned out: the first is the top card, the one the tab shows.
    pub rows: Vec<DockRowView>,
    /// The way on to the complete list at the end of the fan ("All running and done"); the running stack only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub all: Option<Text>,
}

/// A small card of a docked stack.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DockRowView {
    /// The card (`Screen::Card`).
    pub id: String,
    pub title: String,
    pub from: FromView,
    /// The quiet line under the title: "Fernly · running" (a starred card being worked on), "Fernly", "Fernly ·
    /// Reworking the copy" (its status line), "Fernly · on it".
    pub line: Text,
    /// It is being worked on (the drawing's ring turns).
    pub running: bool,
    /// When it last moved (its status line's update, else when it went to its agent); when it was starred, for a
    /// starred card.
    pub at_ms: u64,
}

/// The section Off your mind under the Desk: a short hinted list that opens the complete list (`Screen::Off`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OffHintView {
    /// The cards being worked on, the one that moved last first (at most three): on the iPhone they stand here, at
    /// the head of the section, instead of a docked stack over the Desk. A starred card is not among them (it lies
    /// in the starred stack).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub running: Vec<DockRowView>,
    /// "2 more running": how many run beyond those shown, leading to the complete list; none while all are shown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub running_more: Option<Text>,
    /// The first rows, put off first, then the closed ones, the newest first (at most three; the shell fades them).
    pub rows: Vec<OffRowView>,
    /// "2 put off · 14 done".
    pub says: Text,
    pub put_off: u32,
    /// Every closed card of the team in view, counted (not only the ones named).
    pub closed: u32,
    /// All of it in one quiet line under the questions (the iPhone's calm Desk): "2 running · 1 put off · 14 done".
    #[serde(default)]
    pub line: Text,
    /// Where a tap on the hint or its line goes: the complete list.
    #[serde(default)]
    pub opens: Screen,
}

/// A put-off or closed card, one small quiet row.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OffRowView {
    pub id: String,
    /// "later", "done" or "trash".
    pub place: String,
    /// Its mark: "snooze" (put off), "shred" (shredded: the title struck through), "withdraw" (withdrawn by its
    /// agent), "tick" (done).
    pub mark: String,
    pub title: String,
    #[serde(default)]
    pub starred: bool,
    /// When it closed (ms); 0 for a put-off card and when no time is known (show none, never the epoch).
    #[serde(default)]
    pub at_ms: u64,
    /// A put-off card: until when ("until Tue 07:00", the person's zone).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<Text>,
    /// What it is, to a screen reader: "Later", "Done", "Shredded", "Withdrawn".
    pub says: Text,
}

/// The page Off your mind: every card off the Desk of the team in view. What runs as live cards, the one that moved
/// last first; then what is put off, the last put off first; then what is closed, the newest first. Each card in its
/// place by time, none lifted. Kept to the search's words.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OffListView {
    /// The search's words as given (`Screen::Off`).
    #[serde(default)]
    pub query: String,
    /// The cards with their agents.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub works: Vec<OffWorkView>,
    /// The put-off cards, then the closed ones.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rest: Vec<OffRowView>,
    /// In the list's place when nothing is shown: "Nothing yet.", "Nothing here has these words.".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub none: Option<Text>,
    /// The line under `rest` when this device holds more of it than the window shows: `rest` is the first
    /// [`board::OFF_PAGE`] rows, a page more for each time the person asked (`Lens::off_window`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub more: Option<MoreView>,
    /// Older closed cards are on the hub and not on this device yet (history on demand): the line under the list
    /// that fetches the next page. Always none until the engine pages the Done list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub older: Option<Text>,
    /// A page of older cards is being fetched: the shell shows its quiet "Loading …" line at the end.
    #[serde(default)]
    pub loading: bool,
    /// The list in its groups, in this order and only those with rows: "Running" (`works`), "Put off" and "Done"
    /// (both from `rest`). Each names its rows; its count is every row of it the search keeps, not only the window.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub groups: Vec<OffGroupView>,
}

/// One group of the complete list Off your mind.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OffGroupView {
    /// "running", "later" or "done".
    pub key: String,
    /// Its heading: "Running", "Put off", "Done".
    pub says: Text,
    /// How many cards are in it (the search's words kept), shown beside the heading.
    pub count: u32,
    /// The ids of its rows as shown, in order: of `works` for "running", of `rest` for the others.
    pub ids: Vec<String>,
}

/// More of a long list than its window shows: the line that asks for the next page (an action moves the window,
/// `Lens::show_more`; where this device does not hold it yet, the engine reads it from the hub).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MoreView {
    /// Rows this device holds beyond the window.
    pub left: u32,
    /// The hub holds more beyond those (not read on this device yet).
    #[serde(default)]
    pub hub: bool,
    /// "Earlier messages", "Show more".
    pub says: Text,
    /// How many pages the window shows after the person asks: the number the action sets.
    pub pages: u32,
}

/// A card with its agent, on the page Off your mind.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OffWorkView {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub starred: bool,
    pub from: FromView,
    /// Its status line's words, else "on it".
    pub label: Text,
    /// When it last moved (ms): the shell's "5 min".
    pub at_ms: u64,
    /// The whole row to a screen reader: "Fix the login, Fernly is on it".
    pub says: Text,
}

/// The chip on a team's Desk that opens its page Knowledge.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct KnowledgeChipView {
    pub team_id: String,
    /// "Knowledge".
    pub label: Text,
    /// How many entries the team holds.
    #[serde(default)]
    pub count: u32,
    /// The chip in a sentence ("Team knowledge: 12 entries"), for a screen reader and a tooltip.
    pub says: Text,
}

/// The page Knowledge of a team (`Screen::Knowledge`, core/client/src/views/knowledge.rs): its entries, pinned first
/// then the one changed last, as the search and the filter let them through.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct KnowledgeView {
    pub team_id: String,
    /// The team's name.
    pub team: Text,
    /// "Knowledge".
    pub title: Text,
    /// How many entries the team holds, all of them.
    #[serde(default)]
    pub count: u32,
    /// The same in words ("12 entries").
    pub summary: Text,
    /// The line under the title.
    pub lead: Text,
    /// The search's words in force, trimmed; "" for none.
    #[serde(default)]
    pub query: String,
    /// The filter in force: "" every entry, "pinned" the pinned ones.
    #[serde(default)]
    pub filter: String,
    /// The filter's choices, in order: All, Pinned.
    #[serde(default)]
    pub filters: Vec<KnowledgeFilterView>,
    /// The search field's hint.
    pub search: Text,
    /// What the search and the filter let through, in order.
    #[serde(default)]
    pub rows: Vec<KnowledgeRowView>,
    /// What the page says when it lists nothing; none when it lists something.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub none: Option<Text>,
    /// The team holds as many entries as it may: no new one (`words.full` says so).
    #[serde(default)]
    pub full: bool,
    /// A title's and a text's limits, in characters.
    #[serde(default)]
    pub title_max: u32,
    #[serde(default)]
    pub text_max: u32,
    /// The page's other words: its buttons, the editor's hints, the question before a delete.
    pub words: KnowledgeWordsView,
}

/// One choice of the page's filter.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct KnowledgeFilterView {
    /// "" or "pinned": what `Screen::Knowledge.filter` takes.
    #[serde(default)]
    pub key: String,
    pub label: Text,
    #[serde(default)]
    pub count: u32,
    #[serde(default)]
    pub on: bool,
}

/// One entry on the page.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct KnowledgeRowView {
    /// Its id: what `Action::KnowledgeSave`, `KnowledgePin` and `KnowledgeDelete` take.
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub pinned: bool,
    /// Who brought it and when ("proposed by Claude: Web · Yesterday", "added by you · Today").
    pub by: Text,
    /// When it last changed.
    #[serde(default)]
    pub at_ms: u64,
}

/// The words of the page Knowledge beside its entries.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct KnowledgeWordsView {
    pub add: Text,
    pub edit: Text,
    pub delete: Text,
    pub pin: Text,
    pub unpin: Text,
    pub save: Text,
    pub cancel: Text,
    pub title_hint: Text,
    pub text_hint: Text,
    pub delete_ask: Text,
    pub full: Text,
}

/// A team's goals: a note of the person's, at most twenty lines.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GoalsView {
    pub team_id: String,
    /// The lines; empty when there are none (the shell shows its faint "Goals…").
    pub lines: Vec<String>,
    /// Two lines or more: one toggle folds them to the first line. Whether they are folded is this device's.
    pub foldable: bool,
    /// What the toggle says while they are folded ("Show all 4 goals").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_all: Option<Text>,
    /// Folded to the first line on this device (`Lens::goals_folded`; the owner's pick of 13 October 2026: one
    /// toggle, folded shows the first line). Only while `foldable`.
    #[serde(default)]
    pub folded: bool,
    /// What the toggle says: "Show all 4 goals" while folded, "Show the first goal only" while open; none while not
    /// foldable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub toggle: Option<Text>,
}

/// A session that is cut off, as the Desk says it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SlipView {
    pub session_id: String,
    pub text: Text,
    pub fix: FixView,
}

/// One row of the Desk: a question, a request for approval, or something to read.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeskRowView {
    pub id: String,
    /// "decision", "info" (to read: also a card not read here yet, and one of a newer Trommi), "request".
    pub kind: String,
    /// Its body is not read on this device yet: a quiet placeholder.
    #[serde(default)]
    pub loading: bool,
    /// A card of a newer Trommi: its title where readable, nothing to answer.
    #[serde(default)]
    pub newer: bool,
    pub title: String,
    /// One or two lines under the title: its teaser, else its body as plain words.
    #[serde(default)]
    pub words: String,
    /// Small words before them: "replaces 2 questions", "revised", "Back from Later", why it is urgent.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<Text>,
    /// "low", "normal", "high", "critical".
    pub urgency: String,
    /// The sign before the title: "block" (blocking, or an approval), "knock" (urgent), "whenever" (low), "".
    #[serde(default)]
    pub sign: String,
    /// What the sign says ("Knock! Blocking").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sign_says: Option<Text>,
    #[serde(default)]
    pub starred: bool,
    /// When it was asked.
    pub created_ms: u64,
    /// Who asked; none for a session the list does not show.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<FromView>,
    /// On the first row of a run (rows of one session that follow each other): how many rows it has. Else 0.
    #[serde(default)]
    pub run: u32,
    /// Its pictures and videos, for the small fan beside the title: the first three.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub media: Vec<MediaView>,
    /// What the fan says ("Look at 4 pictures and videos").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_says: Option<Text>,
    /// The answers the row itself offers.
    pub tiles: TilesView,
    /// The ways to put it aside that apply, in order: "later", "reverse", "duck", "shred".
    pub ways: Vec<String>,
}

/// Who a card comes from.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FromView {
    pub session_id: String,
    pub name: String,
    /// What draws the session (`SessionRowView::mark`).
    pub mark: String,
    /// Where it stands, for the line above a card's title ("Team › Session"): its team while there are two or
    /// more, itself.
    pub path: Vec<String>,
    /// The helper (its agent's subagent) it comes from, for a chip beside the path: "Helper Icons".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helper: Option<Text>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MediaView {
    /// The file (`ViewModel.files`, `Action::OpenFile`).
    pub file_id: String,
    /// "image" or "video".
    pub kind: String,
}

/// The answers a row offers without opening the card.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TilesView {
    /// "none" (not read on this device yet: nothing to answer), "read" (What?? and Got it), "pair" (two answers, the lead last), "advised" (the advised answer, and
    /// "+N other ways" that opens the card), "choose" (one tile that opens the card).
    pub kind: String,
    /// The answers of "pair" and "advised", in drawing order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tiles: Vec<TileView>,
    /// "advised": how many other ways there are.
    #[serde(default)]
    pub others: u32,
    /// "advised": "3 other ways: open the card"; "choose": "Choose: 4 options, several".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub says: Option<Text>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TileView {
    /// The option's key (`Action::Answer`; "allow" and "deny" of a request: `Action::Verdict`).
    pub key: String,
    /// The words on the tile; empty for a tile that shows its drawing alone.
    pub label: String,
    /// Its drawing: "yes" (the lead: thumb up, or the filled tile) or "no".
    pub thumb: String,
    /// A real yes or no (thumbs); else two named tiles.
    pub thumbs: bool,
    pub lead: bool,
    /// Its agent advises it.
    pub advised: bool,
    /// Its words need the small type.
    pub small: bool,
    /// `label` is the option's short name (its full one fits no tile).
    pub short: bool,
    /// Choosing it settles the card (its agent marked it final).
    pub settles: bool,
    /// The tooltip ("Recommended", "Settles it", or the option's full name); none without one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tip: Option<Text>,
    /// What it says to a screen reader ("Ship it (settles it)").
    pub says: Text,
}

/// One session's page: its heading, its conversation, the status lines of its running work, and what stands above
/// the field to write in. Made for the session in view (`Lens::session`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionView {
    pub id: String,
    pub name: Text,
    /// "live", "oncall", "asleep", "cut", "gone"; "" for an archived or removed session.
    pub link: String,
    pub blocked: bool,
    /// Talk rows, newest last.
    pub talk: Vec<TalkRow>,
    /// The lines that show, the one its agent set last first: the chat's foot draws the first in one line beside the
    /// working dots, and `status_more` for the rest, which a tap opens.
    pub status_lines: Vec<StatusLineView>,
    /// "+N": how many lines stand behind the first; none with one line or none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_more: Option<Text>,
    /// Every card of the session, the newest first (its page "Questions").
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub questions: Vec<CardRefView>,
    /// Every file of the session's cards, answers, Chats and Artifacts (ids of `ViewModel.files`), the newest
    /// first (its page "Files").
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
    /// The hub holds older messages than this device has (history on demand: asking for more reads them).
    pub has_more: bool,
    /// The line above the first row when more stands before it ("Earlier messages"): what this device holds before
    /// the window, and whether the hub holds older still. `talk` is a window of the newest [`board::TALK_PAGE`] rows,
    /// a page more for each time the person asked (`Lens::talk_window`); none when it shows everything there is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub earlier: Option<MoreView>,
    /// Its short id on the board (`/chat/<slug>`).
    #[serde(default)]
    pub slug: String,
    /// What draws it (`SessionRowView::mark`).
    #[serde(default)]
    pub mark: String,
    #[serde(default)]
    pub team_id: String,
    #[serde(default)]
    pub main: bool,
    #[serde(default)]
    pub crowned: bool,
    #[serde(default)]
    pub online: bool,
    /// Where it stands: its team (while there are two or more), itself.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub path: Vec<String>,
    /// The model it runs on, as the heading says it ("Opus 5.5"); "" when it named none.
    #[serde(default)]
    pub model_label: String,
    /// The model's id, for the tooltip.
    #[serde(default)]
    pub model: String,
    /// The dot beside the name.
    #[serde(default)]
    pub dot: DotView,
    /// Why it is stopped (the red hand).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hand: Option<HandView>,
    /// The quiet hint ("quiet for 24 min"): connected, working, and nothing from it for a while. None while stopped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quiet: Option<Text>,
    /// Above the field: why it does not hear and the step in its terminal, or that his last message waits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<LinkNoteView>,
    /// What the field says while it is empty.
    #[serde(default)]
    pub compose: Text,
    /// "<name> is working": his word was the last, a short while ago.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answering: Option<Text>,
    /// Its questions that wait for the person (decisions and approvals, never a card to read), as their Desk rows,
    /// in the order they came: what its page "Questions" lists as open.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub waiting: Vec<DeskRowView>,
    /// How many of them (`waiting`), and the way to the first of them.
    #[serde(default)]
    pub open: u32,
    /// "3 open".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_word: Option<Text>,
    /// "3 open questions: go to the first one".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_says: Option<Text>,
    /// The talk row of the first of them, where it was asked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_open: Option<String>,
    /// An empty conversation: the card of the agent that joined, and three ways to start.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub empty: Option<EmptyTalkView>,
    /// Its agent's account and how much of it is used (the heading's rings: the week and the 5-hour window). None
    /// without a plan or an e-mail.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<UsageView>,
    /// Its helpers (its agent's subagents), above the status lines; none without.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helpers: Option<HelperListView>,
    /// In the Archive: the More menu offers "Back from the Archive" (`ArchiveSession` with `on: false`).
    #[serde(default)]
    pub archived: bool,
    /// The tabs of its side panel (a click on its name opens it), in order: "details" always, then "questions",
    /// "helpers" and "files" where it has some.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tabs: Vec<PanelTabView>,
}

/// A tab of a session's side panel.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelTabView {
    /// "details", "questions", "helpers", "files".
    pub key: String,
    pub label: Text,
    /// What it counts beside its label (the questions that wait, the helpers, the files); 0: no number.
    #[serde(default)]
    pub count: u32,
}

/// The dot beside a session's name.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DotView {
    /// Connected (green).
    pub on: bool,
    /// How it hears when it does not hear at once: "oncall", "asleep", "cut", "gone"; else "".
    pub link: String,
    /// The tooltip: "connected", "disconnected", or the link's words.
    pub word: Text,
    /// For a screen reader: the word, and what it is at.
    pub says: Text,
}

/// The note above a field: a receipt, the sentence about the session, the way out.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkNoteView {
    /// "cut", "gone", "asleep", "oncall" (the link's state), or "unheard", "sent", "heard" (a receipt alone).
    pub tone: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt: Option<Text>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<Text>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fix: Option<FixView>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EmptyTalkView {
    /// Where it runs, quietly under its name ("Opus 5.5"); "" when it said nothing.
    pub meta: String,
    pub text: Text,
    /// A tap sends one.
    pub starters: Vec<Text>,
}

/// One row of a conversation. `kind` says what it is; the fields it needs are filled.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TalkRow {
    pub id: String,
    pub from_me: bool,
    pub text: String,
    pub time_ms: u64,
    /// His message: its session picked it up (false also when its connector writes no receipts).
    pub heard: bool,
    /// Not confirmed by the hub yet (an echo).
    pub pending: bool,
    /// File ids (`ViewModel.files`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
    /// "user" (his bubble), "agent" (the agent's words, light markdown), "note" (his note, taped on), "event" (one
    /// quiet line: `event`), "ask" (an open question where it was asked: `row`), "work" (a turn's trail: `work`),
    /// "artifact" (something the session published: `published`), "newer" (written by a newer Trommi).
    #[serde(default)]
    pub kind: String,
    /// Its place in the hub's order (an envelope number); 0 for what has none yet.
    #[serde(default)]
    pub number: u64,
    /// The line above it when a new day begins there ("Today", "Yesterday", "Tuesday 13 October").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub day: Option<Text>,
    /// It goes on a run of the same side: no head, close to the row before.
    #[serde(default)]
    pub cont: bool,
    /// Typed into the session's terminal (his words, sent for him by the agent's connector), or the agent's answer there.
    #[serde(default)]
    pub terminal: bool,
    /// The card it is about.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card: Option<CardRefView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event: Option<EventView>,
    /// What he did with a card along with these words (handed back, took back, What??): a quiet line above them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deed: Option<EventView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row: Option<Box<DeskRowView>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work: Option<WorkView>,
    /// The Artifact it announces (its object id).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published: Option<String>,
    /// The agent's details, folded under its words.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub details: String,
    /// The agent's layout under its words (drawn in the sandboxed frame).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub html: String,
    /// The cards it carries, a chip each.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub chips: Vec<CardRefView>,
    /// `kind` "events" (a phone's chat): the card events of a run, a chip each, in order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub events: Vec<EventChipView>,
    /// A selection of the Scribble Board (its one file is the picture).
    #[serde(default)]
    pub scribble: bool,
    /// A note: when it was written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub written_ms: Option<u64>,
    /// On a card's page, the agent's words that answer his What??: that row's id (drawn as one block with it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answers: Option<String>,
    /// On a card's page, his What?? that has no answer yet: "Waiting for the explanation."
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waits: Option<Text>,
    /// The helper (its agent's subagent) that wrote it, beside the agent's name; none for the agent's own words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helper: Option<String>,
}

/// A card as a row of a conversation names it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CardRefView {
    pub id: String,
    /// Its number ("Nr. 12"); 0 when this device does not hold it.
    pub number: u32,
    pub title: String,
}

/// One card event of a run on a phone (`TalkRow.events`): a small chip that opens its card.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventChipView {
    /// The talk row it was.
    pub id: String,
    /// The event's kind (`EventView.kind`): its sign.
    pub kind: String,
    /// What the chip says: the card's title, else what happened.
    pub text: String,
    /// For a screen reader: what happened ("Trommi revised it: Release notes").
    pub says: Text,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card: Option<CardRefView>,
}

/// One quiet line for something that happened to a card.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventView {
    /// "asked", "info", "revised", "decided", "trusted", "read", "shredded", "reopened", "done", "handed", "snoozed",
    /// "took_back", "handed_back", "explain".
    pub kind: String,
    /// "New question", "Answered", …
    pub label: Text,
    /// The card's title, when the words do not say it already.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub about: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub text: String,
    /// What became of the question is said where it was asked: this line only repeats it.
    #[serde(default)]
    pub echo: bool,
    /// On a card's page: "revised", the version it brought ("Version 3"); "decided", the version he answered when it
    /// was not the newest ("You chose in version 2").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u32>,
    /// "revised" on a card's page: it came after his hand-back ("Version 3, as you asked").
    #[serde(default)]
    pub asked: bool,
    /// "decided", "trusted", "shredded": what he wrote along, one line each (“his note”, On Label: “a note”).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub said: Vec<Text>,
    /// "decided", "trusted", "shredded": the files he sent along (`ViewModel.files`), shown under the deed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
}

/// A turn's trail: what the agent did between his prompt and its answer, as one block.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkView {
    pub turn: String,
    /// "running", "done", "interrupted", "failed".
    pub state: String,
    /// "Working", "Worked 2 min", "Interrupted after 12 s", "Stopped by an error after 1 h 5 min".
    pub head: Text,
    /// "7 steps · 1 helper · 2 with errors"; none without any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sum: Option<Text>,
    /// While it runs: the step it is at ("Bash · run the tests").
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub now: String,
    pub lines: Vec<WorkLineView>,
    /// "and 12 more steps, not listed".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rest: Option<Text>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkLineView {
    pub id: String,
    /// "step", "helper", or "text" (the agent's words between two steps: `text`).
    pub kind: String,
    /// "running", "ok", "failed", "interrupted"; "" for words.
    #[serde(default)]
    pub state: String,
    /// What its sign says ("done", "exit code 2").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub says: Option<Text>,
    /// The bold word: the tool, "Helper <name>", or "Step".
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub tool: String,
    /// What it is about ("title · subject").
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub what: String,
    /// "3 steps" (a helper), "exit code 2" (a failed command).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<Text>,
    /// How long it took ("0.3 s", "2 min").
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub took: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub text: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub input: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub output: String,
}

/// A status line of a session's running work, as its page shows it (core/client/README.md "Status lines"): only
/// the lines that show are here.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatusLineView {
    pub id: String,
    pub label: String,
    /// The helper (its agent's subagent) whose line it is, drawn before its label; none for the agent's own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helper: Option<String>,
    pub detail: String,
    /// "working", "decision", "later", "done" (for ten minutes), "stale" (greyed and still, for a day).
    pub state: String,
    /// "working", "waits on you", "put off", "done", "no news for a while".
    #[serde(default)]
    pub says: Text,
    /// When its agent last set it.
    #[serde(default)]
    pub updated_ms: u64,
    /// The card it stands for: the one it names, else the card with its session whose line it is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card: Option<CardRefView>,
}

/// One card's page (a question, something to read, a request for approval): who it comes from, its words, its
/// answers or what was said, its history, and the comments under it. Made for the card in view (`Lens::card`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CardView {
    pub id: String,
    pub session_id: Option<String>,
    /// "decision", "info", "request", "note".
    pub kind: String,
    /// "open", "answered", "closed".
    pub state: String,
    /// 0 low, 1 normal, 2 high, 3 critical.
    pub urgency: u8,
    pub title: String,
    /// Its whole text (markdown).
    pub body: String,
    /// Its options, in the tiles' order (the advised last).
    pub options: Vec<OptionView>,
    /// "You chose: Ship it", when he answered (for a screen reader; drawn from `answer`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub you_chose: Option<Text>,
    /// How many versions stood before this one.
    pub history: u32,
    pub starred: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snoozed_until: Option<u64>,
    /// File ids (`ViewModel.files`): every attachment that is no page of a picture.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
    /// Its number, for its address (`/card/<number>`); 0 when unknown.
    #[serde(default)]
    pub number: u32,
    /// "Nr. 12".
    #[serde(default)]
    pub nr: Text,
    /// Where it stands: "catching" (settled elsewhere, its outcome on the way), "open", "decided", "shredded", "done".
    #[serde(default)]
    pub status: String,
    /// Who it comes from, above its title: "Team › Main › Helper" (`FromView::path`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<FromView>,
    /// "Knock! Blocking", while it is open and knocks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub knock: Option<Text>,
    /// The strip above the title while its session works on it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work: Option<CardWorkView>,
    /// When it was asked, or last revised.
    #[serde(default)]
    pub asked_ms: u64,
    /// Its place among what waits on the Desk in view ("3 of 7"), with its neighbours.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub place: Option<PlaceView>,
    /// Small words of the quiet line: "replaces 2 questions", "revised", "3 messages below".
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<Text>,
    /// The text that stands on the card (markdown): its paragraphs; code and tables stand in the comments.
    #[serde(default)]
    pub text: String,
    /// The comments hold more of the text ("More in the comments ↓").
    #[serde(default)]
    pub more: bool,
    /// The agent's layout under the text (drawn in the sandboxed frame).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub html: String,
    /// The options' own paragraphs, in the tiles' order; empty when none says more than its label.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sections: Vec<SectionView>,
    /// Several options may be ticked.
    #[serde(default)]
    pub multiple: bool,
    /// The answers' column: what can be done, or what was said.
    #[serde(default)]
    pub answer: AnswerView,
    /// Under the answers: whether its session hears, and whether it has his answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<LinkNoteView>,
    /// What the field under the card says while it is empty.
    #[serde(default)]
    pub ask: Text,
    /// His unsent words (the draft kept with the card).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub draft: String,
    /// The versions that stood before this one, oldest first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub versions: Vec<VersionView>,
    /// What the star says ("Star", "Starred").
    #[serde(default)]
    pub star_says: Text,
    /// What the card does not hold, before the comments: the whole text or its layout, the links of its options,
    /// that he put it off.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub lead: Vec<LeadView>,
    /// The comments and what happened to the card, oldest first: the window's rows (`earlier`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub talk: Vec<TalkRow>,
    /// The hub holds older comments than `talk` has.
    #[serde(default)]
    pub has_more: bool,
    /// The cards it replaces.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub merged_from: Vec<CardRefView>,
    /// The card that replaced it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merged_into: Option<CardRefView>,
    /// Its pictures, in order (the stage and the small ones under it), each with the option it shows.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pictures: Vec<PictureView>,
    /// The line above the comments when more stand before them ("Load earlier (N)", "Earlier comments"): `talk`
    /// is a window of the newest [`board::COMMENTS_PAGE`] rows, a page more for each time the person asked
    /// (`Lens::comments_window`, `MoreOf::Comments`); none when it shows everything there is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub earlier: Option<MoreView>,
    /// Once it is settled (not open, not catching up): the way on that the page offers right after the person
    /// answered here (the shell shows it then): the next open question of the team in view, or that there is none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<AfterView>,
}

/// A picture of a card, and the option it belongs to (the web's `pictureKeys`, `picturesOf`): a section that names
/// it decides; else its file name names one option (by key or label, the longest key winning, two equal ones
/// naming none); else, with as many pictures as options and three or more, they pair in order.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PictureView {
    /// The file (`ViewModel.files`).
    pub file_id: String,
    pub name: String,
    /// Its caption, when it says more than its name.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub title: String,
    /// The line under it in the full-screen viewer: its caption, else the label of the option it shows, else its
    /// name.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub caption: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u64>,
    /// The page that belongs to it (an attachment id), shown beside it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<String>,
    /// The option it shows: pointing at that option puts it on the stage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// Every option a section shows it for (several may share one picture); else its `key`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keys: Vec<String>,
}

/// The way on after an answer on a card's page.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AfterView {
    /// The next open question: the next in the Desk's order after this card's place, else the first that waits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next: Option<CardRefView>,
    /// "Next question", or "That was the last open question."
    pub says: Text,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OptionView {
    pub key: String,
    pub label: String,
    pub recommended: bool,
    /// He chose it (the answer that stands), or ticked it (his draft, while several may be ticked).
    pub chosen: bool,
    /// Its line of detail, as plain words.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub detail: String,
    /// Choosing it settles the card (its agent marked it final).
    #[serde(default)]
    pub settles: bool,
    /// His note on it: unsent (his draft) while the card is open, else as he sent it.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
    /// The tooltip ("Recommended · Settles it").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tip: Option<Text>,
}

/// An option's own paragraph (a card written as sections).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SectionView {
    pub key: String,
    pub label: String,
    pub recommended: bool,
    /// What it says beyond its label (markdown); "" when nothing.
    pub text: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub html: String,
}

/// The strip above a card's title while its session works on it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CardWorkView {
    pub session_id: String,
    /// What draws the session.
    pub mark: String,
    /// "Fernly Website is working on it".
    pub says: Text,
    /// Its status line ("Launch checklist · 14 of 19 done"), else "Reworking the card".
    pub words: Text,
    /// When that was said.
    pub at_ms: u64,
}

/// A card's place among what waits on the Desk in view.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlaceView {
    pub at: u32,
    pub of: u32,
    /// "3 of 7".
    pub says: Text,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prev: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
}

/// The answers' column of a card's page.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnswerView {
    /// "options" (the card's options answer; a decision also offers the duck, What?? and the reverse card), "read"
    /// (Got it, What??, the reverse card), "request" (Allow, Deny), "said" (what was said, and the way back),
    /// "revising" (handed back), "working" (an info still worked on), "catching", "loading", "newer".
    pub mode: String,
    /// The one still tile: what was said ("Ship it", "Read", "Shredded"), "In revision", "Being worked on".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<Text>,
    /// Under it: "Your note: …", or what the mode means.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<Text>,
    /// The foot: "You chose", "You handed it back".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub did: Option<Text>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at_ms: Option<u64>,
    /// The way back, when there is one: "reopen" (his answer is taken back: `Action::DecideAgain`), "takeback" (his hand-back is).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub back: String,
    /// His notes on single options, as sent.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub option_notes: Vec<NotedView>,
    /// "<name> marked this answer as final: nothing follows from it.", when his answer settled the card.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settled: Option<Text>,
    /// What its agent said when it closed the card ("Done by the agent").
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub summary: String,
    /// Its agent closed it after his answer: What?? asks about what it did.
    #[serde(default)]
    pub finished: bool,
    /// What the options say to a screen reader ("Your answer. One tap answers."), or the mode's one quiet sentence.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub says: Option<Text>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotedView {
    pub label: String,
    pub note: Text,
}

/// A version of a card that stood before.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct VersionView {
    pub n: u32,
    pub at_ms: u64,
    pub title: String,
    /// What its agent said changed with the version after it; "" without a word.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
    /// The version as it was, read only ("See version 2", "Open version 2 as it was"): its text as the card shows it
    /// (markdown), and its options. Empty while its body is not on this device (`loaded`).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<OptionView>,
    /// Its body is on this device (history on demand: an old version may be read from the hub when asked for).
    #[serde(default)]
    pub loaded: bool,
    /// Its pictures as they were, in order (`CardView.pictures`' rule, with that version's options).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pictures: Vec<PictureView>,
    /// Its other files (`ViewModel.files`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
}

/// What the card itself does not hold, at the head of its comments (the web's `cardThread` lead), in this order.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeadView {
    /// "whole": the whole text, when the card holds only part of it (`CardView.more`), with the agent's layout;
    /// "with": only the agent's layout, when the card holds all the words; "links": the links written into its
    /// options (a tile says them in plain words); "later": he put it off and it waits on Later.
    pub kind: String,
    /// "The whole text", "With the text", "Links of the options", "You put it off: it waits on “Later”".
    pub label: Text,
    /// "whole": the text (markdown, Artifact links by their titles).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub text: String,
    /// "whole", "with": the agent's layout (`CardView.html`).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub html: String,
    /// "links": each link with the option it is in.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub links: Vec<OptionLinkView>,
    /// "later": when he put it off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at_ms: Option<u64>,
}

/// A link an agent wrote into an option's label or detail.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OptionLinkView {
    pub key: String,
    /// The option's label without the link; its key when nothing else is left.
    pub label: String,
    pub url: String,
    /// The address as it is shown: without "https://" and "www.".
    pub short: String,
}

/// The person's notes (the room's, the same on every team) and the one in the corner (`notes.rs`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotesView {
    /// The ids of the notes that show, the last written first (the ids of `rows`). A sent note held for the toast's
    /// Undo shows nowhere.
    pub notes: Vec<String>,
    /// Those notes, in the same order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rows: Vec<NoteView>,
    /// The note in the corner: the first of them; none when there is none (the corner then makes a new one).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub corner: Option<String>,
    /// The corner's note holds words or files (the tab's note is drawn written).
    #[serde(default)]
    pub written: bool,
    /// What the corner's sticky says ("Your note: open it", "New note").
    #[serde(default)]
    pub says: Text,
    /// The crowned session it goes to; none when no session wears the crown here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<NoteToView>,
    /// What the send says ("Send to Fernly").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub send_says: Option<Text>,
    /// In the send's place without a crown: "Give a session the crown to send" (opens Settings · Agents).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub no_crown: Option<Text>,
}

/// One note.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteView {
    pub id: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<NoteFileView>,
    pub created_ms: u64,
    pub updated_ms: u64,
    /// This device's version is not confirmed by the hub yet.
    #[serde(default)]
    pub pending: bool,
}

/// A file of a note: a picture as a small thumbnail, any other file by its name.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteFileView {
    /// The attachment (`ViewModel.files`, `Action::OpenFile`).
    pub file_id: String,
    pub name: String,
    pub media_type: String,
    pub picture: bool,
}

/// A crowned session a note can go to.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteToView {
    pub session_id: String,
    /// Its name; "Main Session" while it has none.
    pub name: String,
    /// What draws it (`SessionRowView::mark`).
    pub mark: String,
    #[serde(default)]
    pub team_id: String,
    /// Its team's name ("Personal" for one without).
    #[serde(default)]
    pub team: String,
}

/// Settings: what the list's rows say, and the person's devices (`settings.rs`). What only this device knows (the
/// theme, the Push level) is the shell's.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SettingsView {
    /// Hub counts and sizes, read only by an authenticated device of this account.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<DataView>,
    /// The account's e-mail, for the row Account; none until the account is read (W3).
    pub account: Option<String>,
    /// The person's devices that are in, in the order they joined (the agents are under Agents).
    pub devices: Vec<DeviceRow>,
    /// The person's removed devices, in the order they joined (the row "Removed" and its page).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub removed: Vec<DeviceRow>,
    /// The devices that never finished signing in: offered for removal together.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unfinished: Vec<String>,
    /// "Remove the 2 devices that never finished signing in".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remove_unfinished: Option<Text>,
    /// The row Agents: "2 agents · 5 sessions"; none without one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agents: Option<Text>,
    /// The page Agents: each program on a computer with its sessions, the most sessions first (the web's
    /// `agentsOf`, `agentsMain`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agent_list: Vec<AgentView>,
    /// The line under the page's title: "2 agents on 1 computer · 5 sessions"; none without an agent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agents_lead: Option<Text>,
    /// The row Teams: "3 teams"; none in a room without teams.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub teams: Option<Text>,
    /// The row Devices: "2 devices".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub devices_says: Option<Text>,
    /// The room's key epoch (the version line at the list's foot).
    #[serde(default)]
    pub key_epoch: u64,
    /// The room's id (hex) and its hub, for the page that proves the room.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub room: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hub: Option<String>,
    /// What each team holds, for the confirm of its delete (its board counted once read on this device).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub team_counts: Vec<TeamCountsView>,
    /// The teams being deleted, with how far.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deleting: Vec<TeamDeleteView>,
    /// Push on this device, where the platform has push.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub push: Option<PushView>,
    /// The account's ways in, once read (`AccountAction::ReadAccount`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub login: Option<LoginView>,
}

/// Settings → Data: presentation belongs to the core, never the native HTTP executor.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DataView {
    pub state: String,
    pub rows: Vec<DataRow>,
    pub says: Option<Text>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DataRow {
    pub id: String,
    pub label: Text,
    pub value: Text,
}

/// What a team holds: what its delete takes away.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TeamCountsView {
    pub team_id: String,
    pub sessions: u64,
    pub helpers: u64,
    pub archived: u64,
    pub open_cards: u64,
    pub done_cards: u64,
    /// Agent devices that leave the room with it.
    pub agents: u64,
    /// Shapes on its board, pictures and notes among them; none while the board is not read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub board: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pictures: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<u64>,
    pub files: u64,
    pub artifacts: u64,
    pub goals: u64,
    /// Entries of its knowledge.
    #[serde(default)]
    pub knowledge: u64,
}

/// An Artifact in the gallery: what an agent published.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactView {
    pub id: String,
    pub title: String,
    /// "page", "image", "document", …: what the agent named it; "" when it named nothing.
    #[serde(default)]
    pub kind: String,
    /// The session that published it (its key), and its name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub session: String,
    pub sent_at: u64,
    /// Its files (ids of `ViewModel.files`), in its order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
}

/// Push on this device.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PushView {
    /// "off", "all", "knocking".
    pub level: String,
    /// A change of the level is on its way.
    #[serde(default)]
    pub busy: bool,
}

/// A team's delete in progress: units done of the total.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TeamDeleteView {
    pub team_id: String,
    pub done: u64,
    pub total: u64,
}

/// The account's ways in, for the page Account: what can be changed and how it is proved.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoginView {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// The account's id as printed on the kit (a UUID).
    pub account: String,
    pub has_password: bool,
    /// The kit is salted with the e-mail ("email") or with the id ("id").
    pub kit_form: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub passkeys: Vec<PasskeyView>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PasskeyView {
    /// base64url: what `RemovePasskey` names.
    pub credential_id: String,
    pub created_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<u64>,
}

/// An agent: a program on one computer ("Claude Code on MacBook Pro"), with its sessions.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentView {
    /// "Claude Code · MacBook Pro": what Remove names (the action's `key`).
    pub key: String,
    /// "Claude Code", "Codex", "Agent".
    pub program: String,
    /// The computer's name; "" when it named none.
    #[serde(default)]
    pub host: String,
    /// "Claude Code on MacBook Pro", "Codex on an unnamed computer".
    pub name: Text,
    /// One of its sessions is connected.
    #[serde(default)]
    pub online: bool,
    /// "connected", or "away · last seen" (the shell writes the time of `seen_ms` after it).
    pub state: Text,
    /// When one of its sessions last did something.
    #[serde(default)]
    pub seen_ms: u64,
    /// "2 sessions, 1 helper".
    pub count: Text,
    /// Every session of it, its helpers too.
    #[serde(default)]
    pub total: u32,
    /// Its main sessions (a helper whose main is its own counts under that main), in the list's order.
    pub sessions: Vec<AgentSessionView>,
    /// The agent devices Remove takes out of the room (never this device, never a person's).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub devices: Vec<String>,
    /// What Remove does, said before it; none when there is nothing to remove.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remove: Option<Text>,
    /// Its account and how much of it is used (the connector's `account`); none without a plan or an e-mail.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<UsageView>,
}

/// A main session of an agent on the page Agents.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentSessionView {
    /// Its key (`Screen::Session`).
    pub id: String,
    pub slug: String,
    pub name: Text,
    /// What draws it (`SessionRowView::mark`).
    #[serde(default)]
    pub mark: String,
    /// "Work team".
    pub team: Text,
    /// Its folder on the computer; "" when unknown.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub folder: String,
    #[serde(default)]
    pub helpers: u32,
    /// "+2 helpers"; none without one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helpers_says: Option<Text>,
    #[serde(default)]
    pub online: bool,
    /// "connected", "away".
    pub state: Text,
}

/// An agent's account: its plan, e-mail and meters.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UsageView {
    /// "Claude Max", "ChatGPT Pro Lite"; "" without a plan.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub plan: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub email: String,
    /// The 5-hour window and the week, those it said; a window that started again since is left out.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub meters: Vec<MeterView>,
    /// "1,200 credits", "2 full resets" (Codex).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub facts: Vec<Text>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MeterView {
    /// "five_hour", "weekly".
    pub key: String,
    /// "5 h", "week".
    pub label: String,
    /// "5-hour window", "This week".
    pub long: String,
    /// Percent used, 0 to 100.
    pub used: u32,
    /// At 80 % or more.
    #[serde(default)]
    pub hot: bool,
    /// When it starts again (the shell writes the time).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reset_ms: Option<u64>,
}

/// One device of the person.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceRow {
    pub id: String,
    /// Its name; "Device" while it has named itself nothing.
    pub name: String,
    pub this_device: bool,
    /// "human" or "agent".
    #[serde(default)]
    pub role: String,
    /// In the room (not removed).
    #[serde(default)]
    pub active: bool,
    /// The green dot: in, and connected (this device always is).
    #[serde(default)]
    pub online: bool,
    /// "this_device", "unfinished" (never finished signing in), "online", "away", "removed".
    #[serde(default)]
    pub state: String,
    /// The state in words ("this device", "never finished signing in").
    #[serde(default)]
    pub says: Text,
    /// The key fingerprint from the signed member list: it must look the same on every device.
    #[serde(default)]
    pub fingerprint: String,
    /// Its drawing: "phone", "laptop", "terminal".
    #[serde(default)]
    pub icon: String,
    /// When it joined, if known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added_ms: Option<u64>,
    /// Last contact with the hub, when known. It confers no membership authority.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_seen_ms: Option<u64>,
    /// Core-formatted last-seen text for an offline device.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seen: Option<Text>,
}

/// The account's flows as a screen shows them. `step` names the screen; the fields it needs are filled.
/// `Debug` leaves out the invite link and the Kit words: they open the account.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountView {
    /// "none", "sign_in", "found", "join", "compare_emoji", "keep_kit", "invite", "recover", "working".
    pub step: String,
    /// The invite in progress (for `ConfirmEmoji`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invite_id: Option<String>,
    /// An invite link to show as text or QR code.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
    /// Copyable instructions for this invite, chosen by the core. Contains the invite secret like `link`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connect_prompt: Option<String>,
    /// The corresponding Claude Code command. Contains the invite secret; never log it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connect_command: Option<String>,
    /// The six emoji to compare, with their words.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub emoji: Vec<EmojiView>,
    /// The Emergency Kit words to keep, shown once.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub kit: Vec<String>,
    /// Self-join asks waiting for "Allow" or "Deny" (for `AnswerAsk`), and those allowed whose session is still
    /// joining (`joining`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub asks: Vec<AskView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub problem: Option<Text>,
    /// The invite this device made and shows (not a self-join's): what it is for, until when, who came; it stays
    /// `joined` once its newcomer is in, until `DropInvite` or the next invite.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invite: Option<InviteView>,
    /// The account's Emergency Kit was never saved (downloaded, printed or shown, then `KitKept`): the screens show
    /// the kit's page first. The room register `kit` of every human device of the person says it.
    #[serde(default)]
    pub kit_due: bool,
    /// What the kit's sheet names, once the account was read: its e-mail, its id (as printed), and the address its
    /// QR code holds (`https://<app>/#k1.<hub, base64url>.<id, 32 hex>`: the recovery screen with both filled in; no
    /// word of the kit).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kit_email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kit_account: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kit_address: Option<String>,
    /// A word on the start screen about how this device came to be signed out: "Logged out." after the person's
    /// own sign-out, or that another device removed it. Gone with the next step.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notice: Option<Text>,
    /// A sign-in that was cut off before all its sessions were joined (the app was closed or reloaded meanwhile):
    /// the device is in the room and the app runs on, and these words ask for the way in again (`SignIn`, its
    /// passkey or its kit), which finishes the joins. None otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume: Option<Text>,
}

impl std::fmt::Debug for AccountView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AccountView")
            .field("step", &self.step)
            .field("invite_id", &self.invite_id)
            .field("link", &self.link.as_ref().map(|_| "<redacted>"))
            .field("connect_prompt", &self.connect_prompt.as_ref().map(|_| "<redacted>"))
            .field("connect_command", &self.connect_command.as_ref().map(|_| "<redacted>"))
            .field("emoji", &self.emoji)
            .field("kit", &format_args!("<{} words redacted>", self.kit.len()))
            .field("asks", &self.asks)
            .field("problem", &self.problem)
            .field("invite", &self.invite)
            .field("kit_due", &self.kit_due)
            .field("notice", &self.notice)
            .finish()
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EmojiView {
    pub emoji: String,
    pub word: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AskView {
    pub nonce: String,
    /// What the vouching agent says it is: account, name, host (its word, shown as such).
    pub says: Text,
    /// The asking session's key (its main, which vouches).
    #[serde(default)]
    pub session_id: String,
    /// The name the new session gets.
    #[serde(default)]
    pub name: String,
    /// The computer and the folder it asks from (the agent's word); "" when it named none.
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub folder: String,
    /// "Claude" or "Codex".
    #[serde(default)]
    pub kind: String,
    /// Who vouches: the asking session's name.
    #[serde(default)]
    pub vouched_by: String,
    /// Allowed: its link is out and the new session is not in yet (no Allow or Deny any more).
    #[serde(default)]
    pub joining: bool,
}

/// An invite this device made, as its page shows it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct InviteView {
    pub invite_id: String,
    #[serde(default)]
    pub title: Text,
    #[serde(default)]
    pub notice: Text,
    #[serde(default)]
    pub computer: bool,
    /// "human" (a device of the person) or "agent".
    pub role: String,
    /// "open" (waits for the newcomer), "confirm_code" (the emoji to compare), "adding", "joined".
    pub state: String,
    /// When the link ends unused (ms).
    #[serde(default)]
    pub expires_ms: u64,
    /// The newcomer's name once it is known ("" before): the device's own, or the agent's session.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub newcomer: String,
}

/// A team's Scribble Board small: its shapes as `BoardView` has them, without a stroke's times, force and tilt.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThumbView {
    pub team_id: String,
    /// `desk/<32 hex>`.
    pub board_id: String,
    /// "loading" while it is read on this device, else as `BoardView.state`.
    pub state: String,
    /// How many shapes it holds (once read).
    #[serde(default)]
    pub count: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shapes: Vec<BoardShape>,
}

/// A Scribble Board (spec/v1.md 10): what its items add up to on this device, ready to draw.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoardView {
    /// `desk/<32 hex>`.
    pub board_id: String,
    /// "loading" (its snapshot and the items after it are read), "ready", "newer_version" (an item needs a newer
    /// Trommi: what it did is not shown), "withheld" (an item could not be read on this device).
    pub state: String,
    /// Every shape in drawing order: by layer (`z`), then as they were made; strokes others are still drawing last.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shapes: Vec<BoardShape>,
}

/// One shape of a board, in board units (a point is two numbers). The fields its tool does not use are left out.
///
/// - stroke (`pen`, `marker`): `pts` its points, `t` their times (ms since it began), `f` their force (0 to 1),
///   `az` and `al` the pen's azimuth and altitude in radians (none without tilt), `sim` a force made up from the
///   speed, `color`, `width`;
/// - note (`text`, `sticky`, `voice`): `pts` its top left corner, `text`, `size`, `color`, `wrap` (none: no wrap);
/// - picture (`image`): `pts` two opposite corners, `attachment` its file's id (`ViewModel.files`, `OpenFile`),
///   `nw` and `nh` its own size in pixels (0: not known), `mime`, `name`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct BoardShape {
    /// `<sender hex>/<envelope number>/<index>`, or `live:<sender hex>/<stroke hex>` for a stroke still drawn.
    pub id: String,
    /// The device that drew it (hex).
    pub by: String,
    pub tool: String,
    #[serde(default)]
    pub z: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    pub pts: Vec<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub t: Vec<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub f: Vec<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub az: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub al: Option<Vec<f64>>,
    #[serde(default)]
    pub sim: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wrap: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nw: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nh: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// A stroke someone else is still drawing (its pieces, spec 7.2): its finished form replaces it.
    #[serde(default)]
    pub live: bool,
    /// Drawn on this device and not yet back from the hub: `<local_id>/<index>` of the `BoardItem` that made it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local: Option<String>,
}

// (its numbers are never NaN: whole quanta and bytes, divided)
impl Eq for BoardShape {}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileView {
    pub name: String,
    pub media_type: String,
    pub size: u64,
    /// "uploading", "ready", "failed", "missing".
    pub state: String,
    /// The attachment's id once the hub has it (an upload's local id maps to it here).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment_id: Option<String>,
    /// 0..=100 while it moves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub percent: Option<u8>,
    /// Its bytes were handed over (`Effect::FileReady`).
    pub loaded: bool,
    /// The Share links this device made for it (`Action::Share`), kept in memory only.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shares: Vec<FileShareView>,
}

/// A Share link of a file: the whole link (its key behind the `#`), for the person to copy.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileShareView {
    pub share_id: String,
    pub link: String,
    pub expires_ms: u64,
}

/// A passing line at the window's foot: what was done, and the way back. The engine and the actions make them; the
/// shell draws them and drops one when its time is up or it is pressed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Toast {
    pub id: String,
    /// The bold words ("Note sent to Fernly", "Not saved").
    pub text: Text,
    /// An action the toast offers ("Undo", "Retry"), sent back as that action.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<crate::actions::Action>,
    /// The quieter words after them ("the board did not take it").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<Text>,
    /// The action's word on its button ("Undo", "Retry"); none: "Undo".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<Text>,
    /// Something went wrong: said at once to a screen reader (the web's role "alert"), drawn as a problem.
    #[serde(default)]
    pub alert: bool,
    /// How long it stands (ms), as the ring on its Undo runs down; none: the shell's own time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ms: Option<u64>,
    /// A way to a page ("Open"): the screen, and the link's words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub go: Option<ToastGo>,
}

/// A toast's way to a page.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToastGo {
    pub screen: Screen,
    pub label: Text,
}

/// Why a delta could not be folded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutOfOrder {
    pub expected: u64,
    pub got: u64,
}

impl ViewModel {
    /// Folds one delta in. Every shell does exactly this (in its own language, or by calling the core).
    pub fn apply(&mut self, delta: &ViewDelta) -> Result<(), OutOfOrder> {
        let whole = delta
            .parts
            .iter()
            .any(|p| matches!(p, ViewPart::Whole { .. }));
        if !whole && delta.base != self.rev {
            return Err(OutOfOrder {
                expected: self.rev,
                got: delta.base,
            });
        }
        for part in &delta.parts {
            match part {
                ViewPart::Whole { model } => *self = (**model).clone(),
                ViewPart::Phase { phase, status } => {
                    self.phase = *phase;
                    self.status = status.clone();
                }
                ViewPart::Sidebar { view } => self.sidebar = view.clone(),
                ViewPart::Desk { view } => self.desk = view.clone(),
                ViewPart::Session { id, view } => match view {
                    Some(v) => {
                        self.sessions.insert(id.clone(), v.clone());
                    }
                    None => {
                        self.sessions.remove(id);
                    }
                },
                ViewPart::Card { id, view } => match view {
                    Some(v) => {
                        self.cards.insert(id.clone(), (**v).clone());
                    }
                    None => {
                        self.cards.remove(id);
                    }
                },
                ViewPart::Off { view } => self.off = view.clone(),
                ViewPart::Notes { view } => self.notes = view.clone(),
                ViewPart::Settings { view } => self.settings = view.clone(),
                ViewPart::Account { view } => self.account = view.clone(),
                ViewPart::File { id, view } => match view {
                    Some(v) => {
                        self.files.insert(id.clone(), v.clone());
                    }
                    None => {
                        self.files.remove(id);
                    }
                },
                ViewPart::Board { view } => self.board = view.clone(),
                ViewPart::Artifacts { view } => self.artifacts = view.clone(),
                ViewPart::Gallery { view } => self.gallery = view.clone(),
                ViewPart::Thumbs { view } => self.thumbs = view.clone(),
                ViewPart::Knowledge { view } => self.knowledge = view.clone(),
                ViewPart::Toasts { toasts } => self.toasts = toasts.clone(),
            }
        }
        self.rev = delta.base + 1;
        Ok(())
    }

    /// The delta that turns `self` (as the shell has it) into `next`, unit by unit. The core keeps the last model
    /// it sent and renders with this: a unit that did not change is not sent.
    pub fn diff(&self, next: &ViewModel) -> Option<ViewDelta> {
        let mut parts = Vec::new();
        if self.phase != next.phase || self.status != next.status {
            parts.push(ViewPart::Phase {
                phase: next.phase,
                status: next.status.clone(),
            });
        }
        if self.sidebar != next.sidebar {
            parts.push(ViewPart::Sidebar {
                view: next.sidebar.clone(),
            });
        }
        if self.desk != next.desk {
            parts.push(ViewPart::Desk {
                view: next.desk.clone(),
            });
        }
        for id in self
            .sessions
            .keys()
            .filter(|k| !next.sessions.contains_key(*k))
        {
            parts.push(ViewPart::Session {
                id: id.clone(),
                view: None,
            });
        }
        for (id, v) in &next.sessions {
            if self.sessions.get(id) != Some(v) {
                parts.push(ViewPart::Session {
                    id: id.clone(),
                    view: Some(v.clone()),
                });
            }
        }
        for id in self.cards.keys().filter(|k| !next.cards.contains_key(*k)) {
            parts.push(ViewPart::Card {
                id: id.clone(),
                view: None,
            });
        }
        for (id, v) in &next.cards {
            if self.cards.get(id) != Some(v) {
                parts.push(ViewPart::Card {
                    id: id.clone(),
                    view: Some(Box::new(v.clone())),
                });
            }
        }
        if self.off != next.off {
            parts.push(ViewPart::Off {
                view: next.off.clone(),
            });
        }
        if self.notes != next.notes {
            parts.push(ViewPart::Notes {
                view: next.notes.clone(),
            });
        }
        if self.settings != next.settings {
            parts.push(ViewPart::Settings {
                view: next.settings.clone(),
            });
        }
        if self.account != next.account {
            parts.push(ViewPart::Account {
                view: next.account.clone(),
            });
        }
        for id in self.files.keys().filter(|k| !next.files.contains_key(*k)) {
            parts.push(ViewPart::File {
                id: id.clone(),
                view: None,
            });
        }
        for (id, v) in &next.files {
            if self.files.get(id) != Some(v) {
                parts.push(ViewPart::File {
                    id: id.clone(),
                    view: Some(v.clone()),
                });
            }
        }
        if self.board != next.board {
            parts.push(ViewPart::Board {
                view: next.board.clone(),
            });
        }
        if self.artifacts != next.artifacts {
            parts.push(ViewPart::Artifacts {
                view: next.artifacts.clone(),
            });
        }
        if self.gallery != next.gallery {
            parts.push(ViewPart::Gallery {
                view: next.gallery.clone(),
            });
        }
        if self.thumbs != next.thumbs {
            parts.push(ViewPart::Thumbs {
                view: next.thumbs.clone(),
            });
        }
        if self.knowledge != next.knowledge {
            parts.push(ViewPart::Knowledge {
                view: next.knowledge.clone(),
            });
        }
        if self.toasts != next.toasts {
            parts.push(ViewPart::Toasts {
                toasts: next.toasts.clone(),
            });
        }
        (!parts.is_empty()).then_some(ViewDelta {
            base: self.rev,
            parts,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_diff_folds_to_the_next_model() {
        let a = ViewModel::default();
        let mut b = a.clone();
        b.phase = Phase::Live;
        b.desk.stack = vec!["c1".into(), "c2".into()];
        b.cards.insert(
            "c1".into(),
            CardView {
                id: "c1".into(),
                ..Default::default()
            },
        );
        let delta = a.diff(&b).unwrap();
        let mut shell = a.clone();
        shell.apply(&delta).unwrap();
        b.rev = 1;
        assert_eq!(shell, b);
        assert_eq!(
            shell.apply(&delta),
            Err(OutOfOrder {
                expected: 1,
                got: 0
            })
        );
        assert!(b.diff(&b).is_none());
    }

    #[test]
    fn a_settings_page_and_a_gallery_filter_travel_only_when_set() {
        let plain = |s: &Screen| serde_json::to_value(s).unwrap();
        assert_eq!(plain(&Screen::Settings { page: String::new() }), serde_json::json!({ "screen": "settings" }));
        assert_eq!(plain(&Screen::Settings { page: "devices".into() }), serde_json::json!({ "screen": "settings", "page": "devices" }));
        assert_eq!(plain(&Screen::Artifacts { kind: "pages".into() }), serde_json::json!({ "screen": "artifacts", "kind": "pages" }));
        let read: Screen = serde_json::from_value(serde_json::json!({ "screen": "artifacts" })).unwrap();
        assert_eq!(read, Screen::Artifacts { kind: String::new() });
        let read: Screen = serde_json::from_value(serde_json::json!({ "screen": "settings", "page": "account" })).unwrap();
        assert_eq!(read, Screen::Settings { page: "account".into() });
    }

    #[test]
    fn row_edits_fold_like_the_desk_ops() {
        let mut list = vec![1, 2, 3];
        Rows::Edits {
            edits: vec![
                RowEdit {
                    at: 1,
                    gone: 1,
                    rows: vec![7, 8],
                },
                RowEdit {
                    at: 9,
                    gone: 9,
                    rows: vec![9],
                },
            ],
        }
        .fold_into(&mut list);
        assert_eq!(list, vec![1, 7, 8, 3, 9]);
    }
}
