// Written by tests/bindings/views.mjs from core/client/src/views/mod.rs: do not edit. The view model the core sends (Effect::Render)
// and the parts of it a shell sends back (Event::Focus). A field marked ? is left out when it is empty or none.

/** A sentence of the core: `key` names it, `args` fill it, `en` is it in English. */
export interface Text {
  key: string
  args?: Record<string, string>
  en: string
}

/** Where the app stands, for the whole window. */
export type Phase = 'starting' | 'signed_out' | 'opening' | 'live' | 'offline' | 'stopped'

/** What the person looks at. Sent by the shell as `Event::Focus`. */
export interface Focus {
  screen: Screen
  /** The window (or app) is in front and visible. */
  visible: boolean
  /** The team in view: a team's id; none when none was chosen, or one that is gone: the first team. */
  team?: string
  /** The Scribble Board shown beside the screen (the Desk's): `desk/<32 hex>`, or a team's id or "all" for that
   *  team's board. `Screen::Scribble` shows its own. The core reads it and sends `ViewModel.board`. */
  board?: string
  /** The Desk in view is home, every team's (the bell at the top), not the team in view's (a team's head).
   *  This device's: the shell keeps it. */
  desk_all: boolean
  /** The teams unfolded in the wide sidebar, their chats under their stack (`TeamStackView.open`). This device's:
   *  the shell keeps them. */
  open_teams?: string[]
  /** The words searched for among every team's chats (the phone's Search tab, `SidebarView.found`); none or empty:
   *  no search. */
  chats_query?: string
  /** The calm chat (the iPhone and the web send it): a session's page folds a run of card events into one row of
   *  chips (`kind` "events"), leaves the helper list out and says "and 2 more" beside the working line. A shell
   *  that draws the full talk (Linux) leaves it false. */
  calm: boolean
}

export type Screen =
  | { screen: 'desk' }
  | { screen: 'session'; session_id: string }
  | { screen: 'card'; card_id: string }
  | { screen: 'notes' }
  /** The page Off your mind, the complete list, with the search's words (empty: all). */
  | { screen: 'off'; query: string }
  | { screen: 'scribble'; board_id: string }
  /** The gallery of every Artifact the agents published, with its filter: "" every one, "media" the pictures,
   *  videos and files, "pages" the pages. */
  | { screen: 'artifacts'; kind?: string }
  /** The page Knowledge of the team in view, with the search's words and its filter ("" every entry, "pinned"). */
  | { screen: 'knowledge'; query?: string; filter?: string }
  /** Settings: its list (`page` ""), or one of its pages ("agents", "teams", "devices", "account", "theme",
   *  "data", "security"). */
  | { screen: 'settings'; page?: string }

/** Everything the shell draws. Serialised, this is what the conformance scripts compare. */
export interface ViewModel {
  /** Counts the deltas folded in; a delta whose `base` is not this is out of order (a shell bug). */
  rev: number
  phase: Phase
  /** One line on where the app stands when it is not plainly live ("Catching up", "Offline: retry in 30 s"). */
  status?: Text
  sidebar: SidebarView
  desk: DeskView
  sessions?: Record<string, SessionView>
  cards?: Record<string, CardView>
  /** The page Off your mind, while it is in view (`Screen::Off`). */
  off?: OffListView
  notes: NotesView
  settings: SettingsView
  /** Signing in, joining, the emoji to compare, the Emergency Kit to keep, self-join asks. */
  account: AccountView
  /** Files the views name (attachments, pictures), by id: uploading, ready, failed. Their bytes, when loaded,
   *  came as `Effect::FileReady` under the same id. */
  files?: Record<string, FileView>
  /** The Scribble Board in view (`Focus.board`, `Screen::Scribble`); none when no board is shown. */
  board?: BoardView
  /** The gallery of Artifacts, while it is in view (`Screen::Artifacts`, and on the Desk, whose foot shows the newest), the newest first. */
  artifacts?: ArtifactView[]
  /** The gallery's filter and its words, while `Screen::Artifacts` is in view (`artifacts` then holds what the
   *  filter lets through); none else. */
  gallery?: GalleryView
  /** Every team's Scribble Board small, in the menu's order, while a page shows them (Settings, the boards of All
   *  teams); none else. */
  thumbs?: ThumbView[]
  /** The page Knowledge of the team in view, while it is in view (`Screen::Knowledge`); none else. */
  knowledge?: KnowledgeView
  toasts?: Toast[]
}

/** One change of the view model, from `base` to `base + 1`. */
export interface ViewDelta {
  base: number
  parts: ViewPart[]
}

export type ViewPart =
  /** Everything, replacing what the shell had (the first render, after a restart of the core). */
  | { part: 'whole'; model: ViewModel }
  | { part: 'phase'; phase: Phase; status: Text | null }
  | { part: 'sidebar'; view: SidebarView }
  | { part: 'desk'; view: DeskView }
  | { part: 'session'; id: string; view: SessionView | null }
  | { part: 'card'; id: string; view: CardView | null }
  /** The page Off your mind; none when it is left. */
  | { part: 'off'; view: OffListView | null }
  | { part: 'notes'; view: NotesView }
  | { part: 'settings'; view: SettingsView }
  | { part: 'account'; view: AccountView }
  | { part: 'file'; id: string; view: FileView | null }
  /** The Scribble Board in view, whole; none when it is left. */
  | { part: 'board'; view: BoardView | null }
  /** The gallery of Artifacts, whole; none when it is left. */
  | { part: 'artifacts'; view: ArtifactView[] | null }
  /** The gallery's filter and words, whole; none when it is left. */
  | { part: 'gallery'; view: GalleryView | null }
  /** The teams' boards small, whole; none when no page shows them. */
  | { part: 'thumbs'; view: ThumbView[] | null }
  /** The page Knowledge, whole; none when it is left. */
  | { part: 'knowledge'; view: KnowledgeView | null }
  | { part: 'toasts'; toasts: Toast[] }

/** Edits of a long list, by position: at `at`, `gone` rows leave and `rows` come (the Desk's stack ops today). */
export interface RowEdit<T> {
  at: number
  gone: number
  rows: T[]
}

export type Rows<T> =
  | { rows: 'whole'; items: T[] }
  | { rows: 'edits'; edits: RowEdit<T>[] }

/** The sidebar (the phone: the menu's teams, the list of chats, the tab pill's numbers): the teams, and one row per
 *  session of the team in view, in the order they are drawn. */
export interface SidebarView {
  /** The teams, in the menu's order. A room without teams has one: "Personal". */
  teams: TeamTab[]
  /** Home in the menu, above the teams: the Desk of every team ("All teams", `Focus.desk_all`), with what waits on
   *  all of them; `selected` while it is the Desk in view. Its `id` is empty. */
  home: TeamTab
  /** The sessions of the team in view, one row each, in drawing order: a main, then its helpers. */
  sessions: SessionRowView[]
  /** The number on the app icon and the tab: the open questions of the Desk in view, the team's or on home every
   *  team's (no infos, nothing that is with its agent). Never drawn red. */
  badge: number
  /** The team in view: its id. */
  team: string
  /** Where the person is, for the head and the team switch: the team's name. */
  place: Text
  /** The open questions of the Desk in view, the team's or on home every team's (its lamp is lit while there are
   *  some). */
  waiting: number
  /** How many of them knock. */
  knocking: number
  /** How many rows of the team in view are stopped (the red hand). */
  stopped: number
  /** How many of them are at work. */
  working: number
  /** How many of his answers the sessions of the team in view have not picked up. */
  unheard: number
  /** Every team as a stack, in the menu's order (the wide sidebar): folded, its head over a fan of its sessions'
   *  card edges; open, its chats under it. The phone draws `sessions` instead. */
  stacks?: TeamStackView[]
  /** The Desk in view is every team's (home, `Focus.desk_all`): no team's head is marked. */
  desk_all: boolean
  /** Under a search (`Focus.chats_query`): every team with a chat whose name or teaser has the words, with those
   *  chats, in the menu's order. */
  found?: ChatGroupView[]
  /** Under a search that finds no chat: so it says. */
  found_none?: Text
}

/** A team in the search's list of chats: its name as a plain section title over the chats found. */
export interface ChatGroupView {
  id: string
  name: Text
  /** Its chats that have the words, one row each, in drawing order. */
  rows: SessionRowView[]
}

/** A team in the wide sidebar: its head (a click opens its Desk) over its sessions, folded to a stack or open. */
export interface TeamStackView {
  id: string
  name: Text
  /** The team in view and its Desk is the Desk (not on home, `desk_all`). */
  selected: boolean
  /** Open on this device (`Focus.open_teams`): its chats stand under its head; folded, they lie as its stack. */
  open: boolean
  /** The open questions of the team's sessions. */
  waiting: number
  /** One of them knocks. */
  knocks: boolean
  /** What the head says to a screen reader: "3 agents, 2 questions open". */
  says: Text
  /** A card edge per session (at most [`STACK_EDGES`]), in the rows' order. What knocks is said by the head's
   *  number, not by an edge. */
  edges?: StackEdgeView[]
  /** Its picture, as a group's: up to three of its sessions' own marks, overlapping, the crowned one first, then in
   *  the rows' order; none for a team without sessions (a quiet placeholder). */
  faces?: StackEdgeView[]
  /** Its sessions, one row each, in drawing order (connected first); drawn while open. */
  sessions?: SessionRowView[]
}

/** A session in a team's stack: its card edge, or its face in the team's picture. */
export interface StackEdgeView {
  /** The session's key (its row's id). */
  id: string
  /** What draws it (its row's mark): the edge takes its colour. */
  mark: string
}

export interface TeamTab {
  id: string
  name: Text
  /** The open questions of the team's sessions. */
  waiting: number
  /** It is the Desk in view: the team in view, unless home (`desk_all`) is. */
  selected: boolean
  /** One of them knocks. */
  knocks: boolean
}

/** One session in the sidebar. */
export interface SessionRowView {
  /** The session's key in the model (`Screen::Session`, the actions' `session_id`, `ViewModel.sessions`). */
  id: string
  name: Text
  /** "live", "oncall", "asleep", "cut", "gone" (core/client/src/status.rs). */
  link: string
  /** The red hand. */
  blocked: boolean
  /** How many of his answers it has not picked up for two minutes. */
  unheard: number
  /** Its short id on the board: its address (`/chat/<slug>`). */
  slug: string
  /** What draws it: always a face, "draw:<face>" (`faces::mark`: the icon the person or the agent chose, else the face
   *  its name fits, else the one its id picks). */
  mark: string
  /** The team it stands on. */
  team_id: string
  online: boolean
  /** Connected and at work (a status line of it shows "working"). */
  working: boolean
  /** A main session: one that says so. */
  main: boolean
  /** The crowned session of its team (the one a note goes to). */
  crowned: boolean
  /** Its helpers (its agent's subagents), small under its name: "3 helpers" with a dot each; none without. */
  helpers?: HelperDotsView
  /** Its open questions: what waits for the person on the Desk (no infos, nothing that is with its agent). */
  open: number
  /** One of them knocks. */
  knocks: boolean
  /** Why it is stopped, in words. */
  hand?: HandView
  /** The small line under its name: its link when it does not hear at once, else the answers it has not picked up. */
  cap?: CapView
  /** Not connected: it stands under "Disconnected". */
  away: boolean
  /** The part of the list a row may be dragged within (its team, connected or not). */
  group: string
  /** What its badge says to a screen reader ("Working, 2 questions open"); none without a badge. */
  says?: Text
  /** What was said last in its conversation (his words with "You: "), or the question it put to him last: the
   *  Chat list's teaser; none while this device holds nothing said there. */
  last?: LastSaidView
  /** Its agent said something this device has not shown yet (the chat was not open since): the Chat list's dot. */
  unread: boolean
  /** The one quiet sign of a calm chat row: "stopped" (the red hand), "waiting" (a question waits for him),
   *  "unread" (new words), or "" for none. */
  signal: string
}

/** What a conversation said last, for its row in the Chat list. */
export interface LastSaidView {
  /** Its first words as one plain line (200 characters at most): "You: …" for his own. */
  text: string
  at_ms: number
  /** When, as a chat list says it: "14:05" today, "Yesterday", a weekday within the week, "3 Oct", "03.10.25". */
  when: Text
}

/** A session's helpers in its sidebar row: how many, and a dot each. */
export interface HelperDotsView {
  /** "1 helper", "3 helpers". */
  says: Text
  /** One dot per helper, in order: filled while that helper works. */
  working: boolean[]
}

/** A session's helpers on its page: a short list, name and state, no way into a chat of their own. */
export interface HelperListView {
  /** "3 helpers". */
  head: Text
  /** "1 working · their cards come with this session". */
  sub: Text
  rows: HelperRowView[]
}

/** One helper of a session's page. */
export interface HelperRowView {
  name: string
  working: boolean
  /** "Working · 1 open question", "1 open question", "Done". */
  says: Text
}

/** Why a session is stopped: the red hand. */
export interface HandView {
  /** "cut", "offline", "permission", "blocking". */
  why: string
  text: Text
  since?: number
}

/** The small line under a session's name. */
export interface CapView {
  /** "oncall", "asleep", "cut", "gone", or "unheard" (it hears at once and has answers to pick up). */
  kind: string
  /** Two or three words: "cut off · 14:05", "1 answer waits". */
  word: Text
  /** The tooltip: "Cut off since 14:05". */
  short: Text
  /** The whole sentence about the session, for a screen reader; none for "unheard". */
  line?: Text
}

/** A session's link in words: whether it hears the person, and what to do when it does not. */
export interface LinkWords {
  /** "live", "oncall", "asleep", "cut", "gone". */
  state: string
  /** Since when it is cut off or gone; for "oncall" and "asleep" its last step. */
  since?: number
  /** Two or three words under its name ("not listening · 12 min"); none while it hears at once. */
  word?: Text
  /** The same as a short sentence ("Not listening for 12 min"). */
  short?: Text
  /** The whole sentence about the session. */
  line: Text
  /** The way out. */
  fix?: FixView
}

/** What to do about a link: a sentence, and a line to type (empty when there is none). */
export interface FixView {
  say: Text
  code: string
}

/** The Desk of the team in view: its head, and the stack of what waits for the person as rows. */
export interface DeskView {
  /** Card and request ids, in the Desk's order: the ids of `rows`. */
  stack: string[]
  /** Off your mind, of the team in view (`off.rs`, from the core's `off_mind`): the cards with their agents,
   *  starred ones too, the one that moved last first (the complete list's top part). */
  off_your_mind: string[]
  /** The put-off cards, the last put off first. */
  later: string[]
  /** The cards closed last (done, withdrawn, shredded), the newest first: the core's window of them
   *  (`off_mind::RECENT` for the whole room), not every closed card; the complete list has them all. */
  done: string[]
  /** The two stacks docked at the Desk's foot; none while a stack is empty. A card has one home: a starred card
   *  is in `starred` only, also while it is being worked on. */
  starred?: DockView
  running?: DockView
  /** The section Off your mind under the Desk: its first rows and how many; none while nothing is put off or
   *  closed. */
  off?: OffHintView
  /** What stands in the list's place when nothing is open at all ("Questions land here."). */
  empty?: Text
  /** "invite" (no session stands here yet: invite the first agent), "reading" (none yet, and the room is still
   *  being read), "team". */
  mode: string
  /** The one big line at the top; none for "invite". */
  hello?: Text
  /** How far the reading of the room's past is ("Reading your history: 12,400 of 27,000"), while it is read. */
  reading?: Text
  /** The team's goals; none on All teams. */
  goals?: GoalsView
  /** The chip that opens the team's page Knowledge; none on All teams, as the goals. */
  knowledge?: KnowledgeChipView
  /** What waits, in the Desk's order: the questions and what is only to read. */
  rows?: DeskRowView[]
  /** The open questions (no infos): the number in the window's title. */
  waiting: number
  /** What Blitz walks through and the duck closes ("Blitz: 3 open cards"); none when nothing waits. */
  blitz?: Text
  /** The duck for all beside Blitz: what one press leaves to the agents (a decision) or reads (an info) at once,
   *  after one question; none when nothing of that waits. */
  duck?: DuckAllView
  /** The sessions that are cut off, above the questions: one line each, with the step in its terminal. */
  slip?: SlipView[]
  /** Under the questions, calm tiles, in this order: "work" (Working / Done: what runs and what is done, it opens
   *  Off your mind), "artifacts" (what the agents published), "board" (the team's Scribble Board), "knowledge"
   *  (the team's Knowledge; not on All teams).
   *  Empty while the Desk is not in view. */
  tiles?: DeskTileView[]
}

/** One tile under the Desk's questions. */
export interface DeskTileView {
  /** "work", "artifacts", "board" or "knowledge". */
  key: string
  /** Its name: "Working / Done", "Artifacts", "Scribble Board", "Knowledge". */
  title: Text
  /** What it holds in a few words: "2 running · 10 done", "14 artifacts", "27 elements", "7 entries"; "Nothing
   *  yet" when empty. */
  line: Text
  /** How many (artifacts, elements on the board, entries); none where the line says it ("work"). */
  count?: number
  /** Where a click goes: `Screen::Off`, `Screen::Artifacts`, `Screen::Scribble`. */
  opens: Screen
  /** What it shows small, in order: the running cards (ids of `DeskView.off.running`) for "work", the newest
   *  artifacts (ids of `ViewModel.artifacts`, at most four) for "artifacts"; empty for "board". */
  items?: string[]
  /** "board": the team whose board it shows small (a `ThumbView.team_id`); "knowledge": its team. None on All teams. */
  team_id?: string
}

/** The duck for all: the cards it clears (`Action::Batch` with way "sweep") and its words (the web's `duckAll`). */
export interface DuckAllView {
  /** The cards it clears, in the Desk's order: the open decisions (left to their agents) and what is only to
   *  read (closed as read); never a request, nothing not read on this device yet. */
  card_ids: string[]
  /** The button's name: "I don’t give a duck: for all 3 open cards". */
  tip: Text
  /** Its short name where its question follows at once (the iPhone's ⋯ menu): "IDGAD". */
  short: Text
  /** How many of which, for a screen reader: "2 decisions go to the agents, 1 card to read is closed". */
  what: Text
  /** The one question it asks: "Duck all 3?"; only cards to read: "Close all 2 as read?". */
  ask: Text
  /** The yes: "Yes, duck them all", "Yes, all read". */
  yes: Text
  /** The quiet way out: "Cancel". */
  no: Text
}

/** The gallery's filter (`Screen::Artifacts.kind`) and what its page says. */
export interface GalleryView {
  /** The filter in force: "", "media" or "pages". */
  kind: string
  /** The filter's choices, in order ("All", "Media", "Pages"); none while there is no Artifact at all. */
  kinds?: GalleryKindView[]
  /** The line under the page's title. */
  lead: Text
  /** What the page says when the filter lets nothing through ("No pages yet."); none when it shows something. */
  none?: Text
}

/** One choice of the gallery's filter. */
export interface GalleryKindView {
  /** "", "media" or "pages": what `Screen::Artifacts.kind` takes. */
  key: string
  label: Text
  /** How many it lets through. */
  count: number
  /** It is the one in force. */
  on: boolean
}

/** One of the two stacks docked at the Desk's foot (the owner's pick of 13 October 2026: two small tabs, the
 *  titles shown only when a stack is fanned out). */
export interface DockView {
  /** "star" or "run". */
  key: string
  /** How many cards it holds: the number on its tab (`rows.len()`). */
  count: number
  /** What the tab says to a screen reader ("3 starred", "1 running"). */
  says: Text
  /** Its cards in order, fanned out: the first is the top card, the one the tab shows. */
  rows: DockRowView[]
  /** The way on to the complete list at the end of the fan ("All running and done"); the running stack only. */
  all?: Text
}

/** A small card of a docked stack. */
export interface DockRowView {
  /** The card (`Screen::Card`). */
  id: string
  title: string
  from: FromView
  /** The quiet line under the title: "Fernly · running" (a starred card being worked on), "Fernly", "Fernly ·
   *  Reworking the copy" (its status line), "Fernly · on it". */
  line: Text
  /** It is being worked on (the drawing's ring turns). */
  running: boolean
  /** When it last moved (its status line's update, else when it went to its agent); when it was starred, for a
   *  starred card. */
  at_ms: number
}

/** The section Off your mind under the Desk: a short hinted list that opens the complete list (`Screen::Off`). */
export interface OffHintView {
  /** The cards being worked on, the one that moved last first (at most three): on the iPhone they stand here, at
   *  the head of the section, instead of a docked stack over the Desk. A starred card is not among them (it lies
   *  in the starred stack). */
  running?: DockRowView[]
  /** "2 more running": how many run beyond those shown, leading to the complete list; none while all are shown. */
  running_more?: Text
  /** The first rows, put off first, then the closed ones, the newest first (at most three; the shell fades them). */
  rows: OffRowView[]
  /** "2 put off · 14 done". */
  says: Text
  put_off: number
  /** Every closed card of the team in view, counted (not only the ones named). */
  closed: number
  /** All of it in one quiet line under the questions (the iPhone's calm Desk): "2 running · 1 put off · 14 done". */
  line: Text
  /** Where a tap on the hint or its line goes: the complete list. */
  opens: Screen
}

/** A put-off or closed card, one small quiet row. */
export interface OffRowView {
  id: string
  /** "later", "done" or "trash". */
  place: string
  /** Its mark: "snooze" (put off), "shred" (shredded: the title struck through), "withdraw" (withdrawn by its
   *  agent), "tick" (done). */
  mark: string
  title: string
  starred: boolean
  /** When it closed (ms); 0 for a put-off card and when no time is known (show none, never the epoch). */
  at_ms: number
  /** A put-off card: until when ("until Tue 07:00", the person's zone). */
  until?: Text
  /** What it is, to a screen reader: "Later", "Done", "Shredded", "Withdrawn". */
  says: Text
}

/** The page Off your mind: every card off the Desk of the team in view. What runs as live cards, the one that moved
 *  last first; then what is put off, the last put off first; then what is closed, the newest first. Each card in its
 *  place by time, none lifted. Kept to the search's words. */
export interface OffListView {
  /** The search's words as given (`Screen::Off`). */
  query: string
  /** The cards with their agents. */
  works?: OffWorkView[]
  /** The put-off cards, then the closed ones. */
  rest?: OffRowView[]
  /** In the list's place when nothing is shown: "Nothing yet.", "Nothing here has these words.". */
  none?: Text
  /** The line under `rest` when this device holds more of it than the window shows: `rest` is the first
   *  [`board::OFF_PAGE`] rows, a page more for each time the person asked (`Lens::off_window`). */
  more?: MoreView
  /** Older closed cards are on the hub and not on this device yet (history on demand): the line under the list
   *  that fetches the next page. Always none until the engine pages the Done list. */
  older?: Text
  /** A page of older cards is being fetched: the shell shows its quiet "Loading …" line at the end. */
  loading: boolean
  /** The list in its groups, in this order and only those with rows: "Running" (`works`), "Put off" and "Done"
   *  (both from `rest`). Each names its rows; its count is every row of it the search keeps, not only the window. */
  groups?: OffGroupView[]
}

/** One group of the complete list Off your mind. */
export interface OffGroupView {
  /** "running", "later" or "done". */
  key: string
  /** Its heading: "Running", "Put off", "Done". */
  says: Text
  /** How many cards are in it (the search's words kept), shown beside the heading. */
  count: number
  /** The ids of its rows as shown, in order: of `works` for "running", of `rest` for the others. */
  ids: string[]
}

/** More of a long list than its window shows: the line that asks for the next page (an action moves the window,
 *  `Lens::show_more`; where this device does not hold it yet, the engine reads it from the hub). */
export interface MoreView {
  /** Rows this device holds beyond the window. */
  left: number
  /** The hub holds more beyond those (not read on this device yet). */
  hub: boolean
  /** "Earlier messages", "Show more". */
  says: Text
  /** How many pages the window shows after the person asks: the number the action sets. */
  pages: number
}

/** A card with its agent, on the page Off your mind. */
export interface OffWorkView {
  id: string
  title: string
  starred: boolean
  from: FromView
  /** Its status line's words, else "on it". */
  label: Text
  /** When it last moved (ms): the shell's "5 min". */
  at_ms: number
  /** The whole row to a screen reader: "Fix the login, Fernly is on it". */
  says: Text
}

/** The chip on a team's Desk that opens its page Knowledge. */
export interface KnowledgeChipView {
  team_id: string
  /** "Knowledge". */
  label: Text
  /** How many entries the team holds. */
  count: number
  /** The chip in a sentence ("Team knowledge: 12 entries"), for a screen reader and a tooltip. */
  says: Text
}

/** The page Knowledge of a team (`Screen::Knowledge`, core/client/src/views/knowledge.rs): its entries, pinned first
 *  then the one changed last, as the search and the filter let them through. */
export interface KnowledgeView {
  team_id: string
  /** The team's name. */
  team: Text
  /** "Knowledge". */
  title: Text
  /** How many entries the team holds, all of them. */
  count: number
  /** The same in words ("12 entries"). */
  summary: Text
  /** The line under the title. */
  lead: Text
  /** The search's words in force, trimmed; "" for none. */
  query: string
  /** The filter in force: "" every entry, "pinned" the pinned ones. */
  filter: string
  /** The filter's choices, in order: All, Pinned. */
  filters: KnowledgeFilterView[]
  /** The search field's hint. */
  search: Text
  /** What the search and the filter let through, in order. */
  rows: KnowledgeRowView[]
  /** What the page says when it lists nothing; none when it lists something. */
  none?: Text
  /** The team holds as many entries as it may: no new one (`words.full` says so). */
  full: boolean
  /** A title's and a text's limits, in characters. */
  title_max: number
  text_max: number
  /** The page's other words: its buttons, the editor's hints, the question before a delete. */
  words: KnowledgeWordsView
}

/** One choice of the page's filter. */
export interface KnowledgeFilterView {
  /** "" or "pinned": what `Screen::Knowledge.filter` takes. */
  key: string
  label: Text
  count: number
  on: boolean
}

/** One entry on the page. */
export interface KnowledgeRowView {
  /** Its id: what `Action::KnowledgeSave`, `KnowledgePin` and `KnowledgeDelete` take. */
  id: string
  title: string
  text: string
  pinned: boolean
  /** Who brought it and when ("proposed by Claude: Web · Yesterday", "added by you · Today"). */
  by: Text
  /** When it last changed. */
  at_ms: number
}

/** The words of the page Knowledge beside its entries. */
export interface KnowledgeWordsView {
  add: Text
  edit: Text
  delete: Text
  pin: Text
  unpin: Text
  save: Text
  cancel: Text
  title_hint: Text
  text_hint: Text
  delete_ask: Text
  full: Text
}

/** A team's goals: a note of the person's, at most twenty lines. */
export interface GoalsView {
  team_id: string
  /** The lines; empty when there are none (the shell shows its faint "Goals…"). */
  lines: string[]
  /** Two lines or more: one toggle folds them to the first line. Whether they are folded is this device's. */
  foldable: boolean
  /** What the toggle says while they are folded ("Show all 4 goals"). */
  show_all?: Text
  /** Folded to the first line on this device (`Lens::goals_folded`; the owner's pick of 13 October 2026: one
   *  toggle, folded shows the first line). Only while `foldable`. */
  folded: boolean
  /** What the toggle says: "Show all 4 goals" while folded, "Show the first goal only" while open; none while not
   *  foldable. */
  toggle?: Text
}

/** A session that is cut off, as the Desk says it. */
export interface SlipView {
  session_id: string
  text: Text
  fix: FixView
}

/** One row of the Desk: a question, a request for approval, or something to read. */
export interface DeskRowView {
  id: string
  /** "decision", "info" (to read: also a card not read here yet, and one of a newer Trommi), "request". */
  kind: string
  /** Its body is not read on this device yet: a quiet placeholder. */
  loading: boolean
  /** A card of a newer Trommi: its title where readable, nothing to answer. */
  newer: boolean
  title: string
  /** One or two lines under the title: its teaser, else its body as plain words. */
  words: string
  /** Small words before them: "replaces 2 questions", "revised", "Back from Later", why it is urgent. */
  notes?: Text[]
  /** "low", "normal", "high", "critical". */
  urgency: string
  /** The sign before the title: "block" (blocking, or an approval), "knock" (urgent), "whenever" (low), "". */
  sign: string
  /** What the sign says ("Knock! Blocking"). */
  sign_says?: Text
  starred: boolean
  /** When it was asked. */
  created_ms: number
  /** Who asked; none for a session the list does not show. */
  from?: FromView
  /** On the first row of a run (rows of one session that follow each other): how many rows it has. Else 0. */
  run: number
  /** Its pictures and videos, for the small fan beside the title: the first three. */
  media?: MediaView[]
  /** What the fan says ("Look at 4 pictures and videos"). */
  media_says?: Text
  /** The answers the row itself offers. */
  tiles: TilesView
  /** The ways to put it aside that apply, in order: "later", "reverse", "duck", "shred". */
  ways: string[]
}

/** Who a card comes from. */
export interface FromView {
  session_id: string
  name: string
  /** What draws the session (`SessionRowView::mark`). */
  mark: string
  /** Where it stands, for the line above a card's title ("Team › Session"): its team while there are two or
   *  more, itself. */
  path: string[]
  /** The helper (its agent's subagent) it comes from, for a chip beside the path: "Helper Icons". */
  helper?: Text
}

export interface MediaView {
  /** The file (`ViewModel.files`, `Action::OpenFile`). */
  file_id: string
  /** "image" or "video". */
  kind: string
}

/** The answers a row offers without opening the card. */
export interface TilesView {
  /** "none" (not read on this device yet: nothing to answer), "read" (What?? and Got it), "pair" (two answers, the lead last), "advised" (the advised answer, and
   *  "+N other ways" that opens the card), "choose" (one tile that opens the card). */
  kind: string
  /** The answers of "pair" and "advised", in drawing order. */
  tiles?: TileView[]
  /** "advised": how many other ways there are. */
  others: number
  /** "advised": "3 other ways: open the card"; "choose": "Choose: 4 options, several". */
  says?: Text
}

export interface TileView {
  /** The option's key (`Action::Answer`; "allow" and "deny" of a request: `Action::Verdict`). */
  key: string
  /** The words on the tile; empty for a tile that shows its drawing alone. */
  label: string
  /** Its drawing: "yes" (the lead: thumb up, or the filled tile) or "no". */
  thumb: string
  /** A real yes or no (thumbs); else two named tiles. */
  thumbs: boolean
  lead: boolean
  /** Its agent advises it. */
  advised: boolean
  /** Its words need the small type. */
  small: boolean
  /** `label` is the option's short name (its full one fits no tile). */
  short: boolean
  /** Choosing it settles the card (its agent marked it final). */
  settles: boolean
  /** The tooltip ("Recommended", "Settles it", or the option's full name); none without one. */
  tip?: Text
  /** What it says to a screen reader ("Ship it (settles it)"). */
  says: Text
}

/** One session's page: its heading, its conversation, the status lines of its running work, and what stands above
 *  the field to write in. Made for the session in view (`Lens::session`). */
export interface SessionView {
  id: string
  name: Text
  /** "live", "oncall", "asleep", "cut", "gone"; "" for an archived or removed session. */
  link: string
  blocked: boolean
  /** Talk rows, newest last. */
  talk: TalkRow[]
  /** The lines that show, the one its agent set last first: the chat's foot draws the first in one line beside the
   *  working dots, and `status_more` for the rest, which a tap opens. */
  status_lines: StatusLineView[]
  /** "+N": how many lines stand behind the first; none with one line or none. */
  status_more?: Text
  /** Every card of the session, the newest first (its page "Questions"). */
  questions?: CardRefView[]
  /** Every file of the session's cards, answers, Chats and Artifacts (ids of `ViewModel.files`), the newest
   *  first (its page "Files"). */
  files?: string[]
  /** The hub holds older messages than this device has (history on demand: asking for more reads them). */
  has_more: boolean
  /** The line above the first row when more stands before it ("Earlier messages"): what this device holds before
   *  the window, and whether the hub holds older still. `talk` is a window of the newest [`board::TALK_PAGE`] rows,
   *  a page more for each time the person asked (`Lens::talk_window`); none when it shows everything there is. */
  earlier?: MoreView
  /** Its short id on the board (`/chat/<slug>`). */
  slug: string
  /** What draws it (`SessionRowView::mark`). */
  mark: string
  team_id: string
  main: boolean
  crowned: boolean
  online: boolean
  /** Where it stands: its team (while there are two or more), itself. */
  path?: string[]
  /** The model it runs on, as the heading says it ("Opus 5.5"); "" when it named none. */
  model_label: string
  /** The model's id, for the tooltip. */
  model: string
  /** The dot beside the name. */
  dot: DotView
  /** Why it is stopped (the red hand). */
  hand?: HandView
  /** The quiet hint ("quiet for 24 min"): connected, working, and nothing from it for a while. None while stopped. */
  quiet?: Text
  /** Above the field: why it does not hear and the step in its terminal, or that his last message waits. */
  note?: LinkNoteView
  /** What the field says while it is empty. */
  compose: Text
  /** "<name> is working": his word was the last, a short while ago. */
  answering?: Text
  /** Its questions that wait for the person (decisions and approvals, never a card to read), as their Desk rows,
   *  in the order they came: what its page "Questions" lists as open. */
  waiting?: DeskRowView[]
  /** How many of them (`waiting`), and the way to the first of them. */
  open: number
  /** "3 open". */
  open_word?: Text
  /** "3 open questions: go to the first one". */
  open_says?: Text
  /** The talk row of the first of them, where it was asked. */
  first_open?: string
  /** An empty conversation: the card of the agent that joined, and three ways to start. */
  empty?: EmptyTalkView
  /** Its agent's account and how much of it is used (the heading's rings: the week and the 5-hour window). None
   *  without a plan or an e-mail. */
  usage?: UsageView
  /** Its helpers (its agent's subagents), above the status lines; none without. */
  helpers?: HelperListView
  /** In the Archive: the More menu offers "Back from the Archive" (`ArchiveSession` with `on: false`). */
  archived: boolean
  /** The tabs of its side panel (a click on its name opens it), in order: "details" always, then "questions",
   *  "helpers" and "files" where it has some. */
  tabs?: PanelTabView[]
}

/** A tab of a session's side panel. */
export interface PanelTabView {
  /** "details", "questions", "helpers", "files". */
  key: string
  label: Text
  /** What it counts beside its label (the questions that wait, the helpers, the files); 0: no number. */
  count: number
}

/** The dot beside a session's name. */
export interface DotView {
  /** Connected (green). */
  on: boolean
  /** How it hears when it does not hear at once: "oncall", "asleep", "cut", "gone"; else "". */
  link: string
  /** The tooltip: "connected", "disconnected", or the link's words. */
  word: Text
  /** For a screen reader: the word, and what it is at. */
  says: Text
}

/** The note above a field: a receipt, the sentence about the session, the way out. */
export interface LinkNoteView {
  /** "cut", "gone", "asleep", "oncall" (the link's state), or "unheard", "sent", "heard" (a receipt alone). */
  tone: string
  receipt?: Text
  line?: Text
  fix?: FixView
}

export interface EmptyTalkView {
  /** Where it runs, quietly under its name ("Opus 5.5"); "" when it said nothing. */
  meta: string
  text: Text
  /** A tap sends one. */
  starters: Text[]
}

/** One row of a conversation. `kind` says what it is; the fields it needs are filled. */
export interface TalkRow {
  id: string
  from_me: boolean
  text: string
  time_ms: number
  /** His message: its session picked it up (false also when its connector writes no receipts). */
  heard: boolean
  /** Not confirmed by the hub yet (an echo). */
  pending: boolean
  /** File ids (`ViewModel.files`). */
  files?: string[]
  /** "user" (his bubble), "agent" (the agent's words, light markdown), "note" (his note, taped on), "event" (one
   *  quiet line: `event`), "ask" (an open question where it was asked: `row`), "work" (a turn's trail: `work`),
   *  "artifact" (something the session published: `published`), "newer" (written by a newer Trommi). */
  kind: string
  /** Its place in the hub's order (an envelope number); 0 for what has none yet. */
  number: number
  /** The line above it when a new day begins there ("Today", "Yesterday", "Tuesday 13 October"). */
  day?: Text
  /** It goes on a run of the same side: no head, close to the row before. */
  cont: boolean
  /** Typed into the session's terminal (his words, sent for him by the agent's connector), or the agent's answer there. */
  terminal: boolean
  /** The card it is about. */
  card?: CardRefView
  event?: EventView
  /** What he did with a card along with these words (handed back, took back, What??): a quiet line above them. */
  deed?: EventView
  row?: DeskRowView
  work?: WorkView
  /** The Artifact it announces (its object id). */
  published?: string
  /** The agent's details, folded under its words. */
  details?: string
  /** The agent's layout under its words (drawn in the sandboxed frame). */
  html?: string
  /** The cards it carries, a chip each. */
  chips?: CardRefView[]
  /** `kind` "events" (a phone's chat): the card events of a run, a chip each, in order. */
  events?: EventChipView[]
  /** A selection of the Scribble Board (its one file is the picture). */
  scribble: boolean
  /** A note: when it was written. */
  written_ms?: number
  /** On a card's page, the agent's words that answer his What??: that row's id (drawn as one block with it). */
  answers?: string
  /** On a card's page, his What?? that has no answer yet: "Waiting for the explanation." */
  waits?: Text
  /** The helper (its agent's subagent) that wrote it, beside the agent's name; none for the agent's own words. */
  helper?: string
}

/** A card as a row of a conversation names it. */
export interface CardRefView {
  id: string
  /** Its number ("Nr. 12"); 0 when this device does not hold it. */
  number: number
  title: string
}

/** One card event of a run on a phone (`TalkRow.events`): a small chip that opens its card. */
export interface EventChipView {
  /** The talk row it was. */
  id: string
  /** The event's kind (`EventView.kind`): its sign. */
  kind: string
  /** What the chip says: the card's title, else what happened. */
  text: string
  /** For a screen reader: what happened ("Trommi revised it: Release notes"). */
  says: Text
  card?: CardRefView
}

/** One quiet line for something that happened to a card. */
export interface EventView {
  /** "asked", "info", "revised", "decided", "trusted", "read", "shredded", "reopened", "done", "handed", "snoozed",
   *  "took_back", "handed_back", "explain". */
  kind: string
  /** "New question", "Answered", … */
  label: Text
  /** The card's title, when the words do not say it already. */
  about?: string
  text?: string
  /** What became of the question is said where it was asked: this line only repeats it. */
  echo: boolean
  /** On a card's page: "revised", the version it brought ("Version 3"); "decided", the version he answered when it
   *  was not the newest ("You chose in version 2"). */
  version?: number
  /** "revised" on a card's page: it came after his hand-back ("Version 3, as you asked"). */
  asked: boolean
  /** "decided", "trusted", "shredded": what he wrote along, one line each (“his note”, On Label: “a note”). */
  said?: Text[]
  /** "decided", "trusted", "shredded": the files he sent along (`ViewModel.files`), shown under the deed. */
  files?: string[]
}

/** A turn's trail: what the agent did between his prompt and its answer, as one block. */
export interface WorkView {
  turn: string
  /** "running", "done", "interrupted", "failed". */
  state: string
  /** "Working", "Worked 2 min", "Interrupted after 12 s", "Stopped by an error after 1 h 5 min". */
  head: Text
  /** "7 steps · 1 helper · 2 with errors"; none without any. */
  sum?: Text
  /** While it runs: the step it is at ("Bash · run the tests"). */
  now?: string
  lines: WorkLineView[]
  /** "and 12 more steps, not listed". */
  rest?: Text
}

export interface WorkLineView {
  id: string
  /** "step", "helper", or "text" (the agent's words between two steps: `text`). */
  kind: string
  /** "running", "ok", "failed", "interrupted"; "" for words. */
  state: string
  /** What its sign says ("done", "exit code 2"). */
  says?: Text
  /** The bold word: the tool, "Helper <name>", or "Step". */
  tool?: string
  /** What it is about ("title · subject"). */
  what?: string
  /** "3 steps" (a helper), "exit code 2" (a failed command). */
  count?: Text
  /** How long it took ("0.3 s", "2 min"). */
  took?: string
  text?: string
  input?: string
  output?: string
}

/** A status line of a session's running work, as its page shows it (core/client/README.md "Status lines"): only
 *  the lines that show are here. */
export interface StatusLineView {
  id: string
  label: string
  /** The helper (its agent's subagent) whose line it is, drawn before its label; none for the agent's own. */
  helper?: string
  detail: string
  /** "working", "decision", "later", "done" (for ten minutes), "stale" (greyed and still, for a day). */
  state: string
  /** "working", "waits on you", "put off", "done", "no news for a while". */
  says: Text
  /** When its agent last set it. */
  updated_ms: number
  /** The card it stands for: the one it names, else the card with its session whose line it is. */
  card?: CardRefView
}

/** One card's page (a question, something to read, a request for approval): who it comes from, its words, its
 *  answers or what was said, its history, and the comments under it. Made for the card in view (`Lens::card`). */
export interface CardView {
  id: string
  session_id: string | null
  /** "decision", "info", "request", "note". */
  kind: string
  /** "open", "answered", "closed". */
  state: string
  /** 0 low, 1 normal, 2 high, 3 critical. */
  urgency: number
  title: string
  /** Its whole text (markdown). */
  body: string
  /** Its options, in the tiles' order (the advised last). */
  options: OptionView[]
  /** "You chose: Ship it", when he answered (for a screen reader; drawn from `answer`). */
  you_chose?: Text
  /** How many versions stood before this one. */
  history: number
  starred: boolean
  snoozed_until?: number
  /** File ids (`ViewModel.files`): every attachment that is no page of a picture. */
  files?: string[]
  /** Its number, for its address (`/card/<number>`); 0 when unknown. */
  number: number
  /** "Nr. 12". */
  nr: Text
  /** Where it stands: "catching" (settled elsewhere, its outcome on the way), "open", "decided", "shredded", "done". */
  status: string
  /** Who it comes from, above its title: "Team › Main › Helper" (`FromView::path`). */
  from?: FromView
  /** "Knock! Blocking", while it is open and knocks. */
  knock?: Text
  /** The strip above the title while its session works on it. */
  work?: CardWorkView
  /** When it was asked, or last revised. */
  asked_ms: number
  /** Its place among what waits on the Desk in view ("3 of 7"), with its neighbours. */
  place?: PlaceView
  /** Small words of the quiet line: "replaces 2 questions", "revised", "3 messages below". */
  notes?: Text[]
  /** The text that stands on the card (markdown): its paragraphs; code and tables stand in the comments. */
  text: string
  /** The comments hold more of the text ("More in the comments ↓"). */
  more: boolean
  /** The agent's layout under the text (drawn in the sandboxed frame). */
  html?: string
  /** The options' own paragraphs, in the tiles' order; empty when none says more than its label. */
  sections?: SectionView[]
  /** Several options may be ticked. */
  multiple: boolean
  /** The answers' column: what can be done, or what was said. */
  answer: AnswerView
  /** Under the answers: whether its session hears, and whether it has his answer. */
  note?: LinkNoteView
  /** What the field under the card says while it is empty. */
  ask: Text
  /** His unsent words (the draft kept with the card). */
  draft?: string
  /** The versions that stood before this one, oldest first. */
  versions?: VersionView[]
  /** What the star says ("Star", "Starred"). */
  star_says: Text
  /** What the card does not hold, before the comments: the whole text or its layout, the links of its options,
   *  that he put it off. */
  lead?: LeadView[]
  /** The comments and what happened to the card, oldest first: the window's rows (`earlier`). */
  talk?: TalkRow[]
  /** The hub holds older comments than `talk` has. */
  has_more: boolean
  /** The cards it replaces. */
  merged_from?: CardRefView[]
  /** The card that replaced it. */
  merged_into?: CardRefView
  /** Its pictures, in order (the stage and the small ones under it), each with the option it shows. */
  pictures?: PictureView[]
  /** The line above the comments when more stand before them ("Load earlier (N)", "Earlier comments"): `talk`
   *  is a window of the newest [`board::COMMENTS_PAGE`] rows, a page more for each time the person asked
   *  (`Lens::comments_window`, `MoreOf::Comments`); none when it shows everything there is. */
  earlier?: MoreView
  /** Once it is settled (not open, not catching up): the way on that the page offers right after the person
   *  answered here (the shell shows it then): the next open question of the team in view, or that there is none. */
  after?: AfterView
}

/** A picture of a card, and the option it belongs to (the web's `pictureKeys`, `picturesOf`): a section that names
 *  it decides; else its file name names one option (by key or label, the longest key winning, two equal ones
 *  naming none); else, with as many pictures as options and three or more, they pair in order. */
export interface PictureView {
  /** The file (`ViewModel.files`). */
  file_id: string
  name: string
  /** Its caption, when it says more than its name. */
  title?: string
  /** The line under it in the full-screen viewer: its caption, else the label of the option it shows, else its
   *  name. */
  caption?: string
  width?: number
  height?: number
  /** The page that belongs to it (an attachment id), shown beside it. */
  page?: string
  /** The option it shows: pointing at that option puts it on the stage. */
  key?: string
  /** Every option a section shows it for (several may share one picture); else its `key`. */
  keys?: string[]
}

/** The way on after an answer on a card's page. */
export interface AfterView {
  /** The next open question: the next in the Desk's order after this card's place, else the first that waits. */
  next?: CardRefView
  /** "Next question", or "That was the last open question." */
  says: Text
}

export interface OptionView {
  key: string
  label: string
  recommended: boolean
  /** He chose it (the answer that stands), or ticked it (his draft, while several may be ticked). */
  chosen: boolean
  /** Its line of detail, as plain words. */
  detail?: string
  /** Choosing it settles the card (its agent marked it final). */
  settles: boolean
  /** His note on it: unsent (his draft) while the card is open, else as he sent it. */
  note?: string
  /** The tooltip ("Recommended · Settles it"). */
  tip?: Text
}

/** An option's own paragraph (a card written as sections). */
export interface SectionView {
  key: string
  label: string
  recommended: boolean
  /** What it says beyond its label (markdown); "" when nothing. */
  text: string
  html?: string
}

/** The strip above a card's title while its session works on it. */
export interface CardWorkView {
  session_id: string
  /** What draws the session. */
  mark: string
  /** "Fernly Website is working on it". */
  says: Text
  /** Its status line ("Launch checklist · 14 of 19 done"), else "Reworking the card". */
  words: Text
  /** When that was said. */
  at_ms: number
}

/** A card's place among what waits on the Desk in view. */
export interface PlaceView {
  at: number
  of: number
  /** "3 of 7". */
  says: Text
  prev?: string
  next?: string
}

/** The answers' column of a card's page. */
export interface AnswerView {
  /** "options" (the card's options answer; a decision also offers the duck, What?? and the reverse card), "read"
   *  (Got it, What??, the reverse card), "request" (Allow, Deny), "said" (what was said, and the way back),
   *  "revising" (handed back), "working" (an info still worked on), "catching", "loading", "newer". */
  mode: string
  /** The one still tile: what was said ("Ship it", "Read", "Shredded"), "In revision", "Being worked on". */
  label?: Text
  /** Under it: "Your note: …", or what the mode means. */
  detail?: Text
  /** The foot: "You chose", "You handed it back". */
  did?: Text
  at_ms?: number
  /** The way back, when there is one: "reopen" (his answer is taken back: `Action::DecideAgain`), "takeback" (his hand-back is). */
  back?: string
  /** His notes on single options, as sent. */
  option_notes?: NotedView[]
  /** "<name> marked this answer as final: nothing follows from it.", when his answer settled the card. */
  settled?: Text
  /** What its agent said when it closed the card ("Done by the agent"). */
  summary?: string
  /** Its agent closed it after his answer: What?? asks about what it did. */
  finished: boolean
  /** What the options say to a screen reader ("Your answer. One tap answers."), or the mode's one quiet sentence. */
  says?: Text
}

export interface NotedView {
  label: string
  note: Text
}

/** A version of a card that stood before. */
export interface VersionView {
  n: number
  at_ms: number
  title: string
  /** What its agent said changed with the version after it; "" without a word. */
  note?: string
  /** The version as it was, read only ("See version 2", "Open version 2 as it was"): its text as the card shows it
   *  (markdown), and its options. Empty while its body is not on this device (`loaded`). */
  text?: string
  options?: OptionView[]
  /** Its body is on this device (history on demand: an old version may be read from the hub when asked for). */
  loaded: boolean
  /** Its pictures as they were, in order (`CardView.pictures`' rule, with that version's options). */
  pictures?: PictureView[]
  /** Its other files (`ViewModel.files`). */
  files?: string[]
}

/** What the card itself does not hold, at the head of its comments (the web's `cardThread` lead), in this order. */
export interface LeadView {
  /** "whole": the whole text, when the card holds only part of it (`CardView.more`), with the agent's layout;
   *  "with": only the agent's layout, when the card holds all the words; "links": the links written into its
   *  options (a tile says them in plain words); "later": he put it off and it waits on Later. */
  kind: string
  /** "The whole text", "With the text", "Links of the options", "You put it off: it waits on “Later”". */
  label: Text
  /** "whole": the text (markdown, Artifact links by their titles). */
  text?: string
  /** "whole", "with": the agent's layout (`CardView.html`). */
  html?: string
  /** "links": each link with the option it is in. */
  links?: OptionLinkView[]
  /** "later": when he put it off. */
  at_ms?: number
}

/** A link an agent wrote into an option's label or detail. */
export interface OptionLinkView {
  key: string
  /** The option's label without the link; its key when nothing else is left. */
  label: string
  url: string
  /** The address as it is shown: without "https://" and "www.". */
  short: string
}

/** The person's notes (the room's, the same on every team) and the one in the corner (`notes.rs`). */
export interface NotesView {
  /** The ids of the notes that show, the last written first (the ids of `rows`). A sent note held for the toast's
   *  Undo shows nowhere. */
  notes: string[]
  /** Those notes, in the same order. */
  rows?: NoteView[]
  /** The note in the corner: the first of them; none when there is none (the corner then makes a new one). */
  corner?: string
  /** The corner's note holds words or files (the tab's note is drawn written). */
  written: boolean
  /** What the corner's sticky says ("Your note: open it", "New note"). */
  says: Text
  /** The crowned session it goes to; none when no session wears the crown here. */
  to?: NoteToView
  /** What the send says ("Send to Fernly"). */
  send_says?: Text
  /** In the send's place without a crown: "Give a session the crown to send" (opens Settings · Agents). */
  no_crown?: Text
}

/** One note. */
export interface NoteView {
  id: string
  text: string
  files?: NoteFileView[]
  created_ms: number
  updated_ms: number
  /** This device's version is not confirmed by the hub yet. */
  pending: boolean
}

/** A file of a note: a picture as a small thumbnail, any other file by its name. */
export interface NoteFileView {
  /** The attachment (`ViewModel.files`, `Action::OpenFile`). */
  file_id: string
  name: string
  media_type: string
  picture: boolean
}

/** A crowned session a note can go to. */
export interface NoteToView {
  session_id: string
  /** Its name; "Main Session" while it has none. */
  name: string
  /** What draws it (`SessionRowView::mark`). */
  mark: string
  team_id: string
  /** Its team's name ("Personal" for one without). */
  team: string
}

/** Settings: what the list's rows say, and the person's devices (`settings.rs`). What only this device knows (the
 *  theme, the Push level) is the shell's. */
export interface SettingsView {
  /** Hub counts and sizes, read only by an authenticated device of this account. */
  data?: DataView
  /** The account's e-mail, for the row Account; none until the account is read (W3). */
  account: string | null
  /** The person's devices that are in, in the order they joined (the agents are under Agents). */
  devices: DeviceRow[]
  /** The person's removed devices, in the order they joined (the row "Removed" and its page). */
  removed?: DeviceRow[]
  /** The devices that never finished signing in: offered for removal together. */
  unfinished?: string[]
  /** "Remove the 2 devices that never finished signing in". */
  remove_unfinished?: Text
  /** The row Agents: "2 agents · 5 sessions"; none without one. */
  agents?: Text
  /** The page Agents: each program on a computer with its sessions, the most sessions first (the web's
   *  `agentsOf`, `agentsMain`). */
  agent_list?: AgentView[]
  /** The line under the page's title: "2 agents on 1 computer · 5 sessions"; none without an agent. */
  agents_lead?: Text
  /** The row Teams: "3 teams"; none in a room without teams. */
  teams?: Text
  /** The row Devices: "2 devices". */
  devices_says?: Text
  /** The room's key epoch (the version line at the list's foot). */
  key_epoch: number
  /** The room's id (hex) and its hub, for the page that proves the room. */
  room?: string
  hub?: string
  /** What each team holds, for the confirm of its delete (its board counted once read on this device). */
  team_counts?: TeamCountsView[]
  /** The teams being deleted, with how far. */
  deleting?: TeamDeleteView[]
  /** Push on this device, where the platform has push. */
  push?: PushView
  /** The account's ways in, once read (`AccountAction::ReadAccount`). */
  login?: LoginView
}

/** Settings → Data: presentation belongs to the core, never the native HTTP executor. */
export interface DataView {
  state: string
  rows: DataRow[]
  says: Text | null
}

export interface DataRow {
  id: string
  label: Text
  value: Text
}

/** What a team holds: what its delete takes away. */
export interface TeamCountsView {
  team_id: string
  sessions: number
  helpers: number
  archived: number
  open_cards: number
  done_cards: number
  /** Agent devices that leave the room with it. */
  agents: number
  /** Shapes on its board, pictures and notes among them; none while the board is not read. */
  board?: number
  pictures?: number
  notes?: number
  files: number
  artifacts: number
  goals: number
  /** Entries of its knowledge. */
  knowledge: number
}

/** An Artifact in the gallery: what an agent published. */
export interface ArtifactView {
  id: string
  title: string
  /** "page", "image", "document", …: what the agent named it; "" when it named nothing. */
  kind: string
  /** The session that published it (its key), and its name. */
  session_id?: string
  session: string
  sent_at: number
  /** Its files (ids of `ViewModel.files`), in its order. */
  files?: string[]
}

/** Push on this device. */
export interface PushView {
  /** "off", "all", "knocking". */
  level: string
  /** A change of the level is on its way. */
  busy: boolean
}

/** A team's delete in progress: units done of the total. */
export interface TeamDeleteView {
  team_id: string
  done: number
  total: number
}

/** The account's ways in, for the page Account: what can be changed and how it is proved. */
export interface LoginView {
  email?: string
  /** The account's id as printed on the kit (a UUID). */
  account: string
  has_password: boolean
  /** The kit is salted with the e-mail ("email") or with the id ("id"). */
  kit_form: string
  passkeys?: PasskeyView[]
}

export interface PasskeyView {
  /** base64url: what `RemovePasskey` names. */
  credential_id: string
  created_at: number
  last_used_at?: number
}

/** An agent: a program on one computer ("Claude Code on MacBook Pro"), with its sessions. */
export interface AgentView {
  /** "Claude Code · MacBook Pro": what Remove names (the action's `key`). */
  key: string
  /** "Claude Code", "Codex", "Agent". */
  program: string
  /** The computer's name; "" when it named none. */
  host: string
  /** "Claude Code on MacBook Pro", "Codex on an unnamed computer". */
  name: Text
  /** One of its sessions is connected. */
  online: boolean
  /** "connected", or "away · last seen" (the shell writes the time of `seen_ms` after it). */
  state: Text
  /** When one of its sessions last did something. */
  seen_ms: number
  /** "2 sessions, 1 helper". */
  count: Text
  /** Every session of it, its helpers too. */
  total: number
  /** Its main sessions (a helper whose main is its own counts under that main), in the list's order. */
  sessions: AgentSessionView[]
  /** The agent devices Remove takes out of the room (never this device, never a person's). */
  devices?: string[]
  /** What Remove does, said before it; none when there is nothing to remove. */
  remove?: Text
  /** Its account and how much of it is used (the connector's `account`); none without a plan or an e-mail. */
  usage?: UsageView
}

/** A main session of an agent on the page Agents. */
export interface AgentSessionView {
  /** Its key (`Screen::Session`). */
  id: string
  slug: string
  name: Text
  /** What draws it (`SessionRowView::mark`). */
  mark: string
  /** "Work team". */
  team: Text
  /** Its folder on the computer; "" when unknown. */
  folder?: string
  helpers: number
  /** "+2 helpers"; none without one. */
  helpers_says?: Text
  online: boolean
  /** "connected", "away". */
  state: Text
}

/** An agent's account: its plan, e-mail and meters. */
export interface UsageView {
  /** "Claude Max", "ChatGPT Pro Lite"; "" without a plan. */
  plan?: string
  email?: string
  /** The 5-hour window and the week, those it said; a window that started again since is left out. */
  meters?: MeterView[]
  /** "1,200 credits", "2 full resets" (Codex). */
  facts?: Text[]
}

export interface MeterView {
  /** "five_hour", "weekly". */
  key: string
  /** "5 h", "week". */
  label: string
  /** "5-hour window", "This week". */
  long: string
  /** Percent used, 0 to 100. */
  used: number
  /** At 80 % or more. */
  hot: boolean
  /** When it starts again (the shell writes the time). */
  reset_ms?: number
}

/** One device of the person. */
export interface DeviceRow {
  id: string
  /** Its name; "Device" while it has named itself nothing. */
  name: string
  this_device: boolean
  /** "human" or "agent". */
  role: string
  /** In the room (not removed). */
  active: boolean
  /** The green dot: in, and connected (this device always is). */
  online: boolean
  /** "this_device", "unfinished" (never finished signing in), "online", "away", "removed". */
  state: string
  /** The state in words ("this device", "never finished signing in"). */
  says: Text
  /** The key fingerprint from the signed member list: it must look the same on every device. */
  fingerprint: string
  /** Its drawing: "phone", "laptop", "terminal". */
  icon: string
  /** When it joined, if known. */
  added_ms?: number
  /** Last contact with the hub, when known. It confers no membership authority. */
  last_seen_ms?: number
  /** Core-formatted last-seen text for an offline device. */
  seen?: Text
}

/** The account's flows as a screen shows them. `step` names the screen; the fields it needs are filled.
 *  `Debug` leaves out the invite link and the Kit words: they open the account. */
export interface AccountView {
  /** "none", "sign_in", "found", "join", "compare_emoji", "keep_kit", "invite", "recover", "working". */
  step: string
  /** The invite in progress (for `ConfirmEmoji`). */
  invite_id?: string
  /** An invite link to show as text or QR code. */
  link?: string
  /** Copyable instructions for this invite, chosen by the core. Contains the invite secret like `link`. */
  connect_prompt?: string
  /** The corresponding Claude Code command. Contains the invite secret; never log it. */
  connect_command?: string
  /** The six emoji to compare, with their words. */
  emoji?: EmojiView[]
  /** The Emergency Kit words to keep, shown once. */
  kit?: string[]
  /** Self-join asks waiting for "Allow" or "Deny" (for `AnswerAsk`), and those allowed whose session is still
   *  joining (`joining`). */
  asks?: AskView[]
  problem?: Text
  /** The invite this device made and shows (not a self-join's): what it is for, until when, who came; it stays
   *  `joined` once its newcomer is in, until `DropInvite` or the next invite. */
  invite?: InviteView
  /** The account's Emergency Kit was never saved (downloaded, printed or shown, then `KitKept`): the screens show
   *  the kit's page first. The room register `kit` of every human device of the person says it. */
  kit_due: boolean
  /** What the kit's sheet names, once the account was read: its e-mail, its id (as printed), and the address its
   *  QR code holds (`https://<app>/#k1.<hub, base64url>.<id, 32 hex>`: the recovery screen with both filled in; no
   *  word of the kit). */
  kit_email?: string
  kit_account?: string
  kit_address?: string
  /** A word on the start screen about how this device came to be signed out: "Logged out." after the person's
   *  own sign-out, or that another device removed it. Gone with the next step. */
  notice?: Text
  /** A sign-in that was cut off before all its sessions were joined (the app was closed or reloaded meanwhile):
   *  the device is in the room and the app runs on, and these words ask for the way in again (`SignIn`, its
   *  passkey or its kit), which finishes the joins. None otherwise. */
  resume?: Text
}

export interface EmojiView {
  emoji: string
  word: string
}

export interface AskView {
  nonce: string
  /** What the vouching agent says it is: account, name, host (its word, shown as such). */
  says: Text
  /** The asking session's key (its main, which vouches). */
  session_id: string
  /** The name the new session gets. */
  name: string
  /** The computer and the folder it asks from (the agent's word); "" when it named none. */
  host: string
  folder: string
  /** "Claude" or "Codex". */
  kind: string
  /** Who vouches: the asking session's name. */
  vouched_by: string
  /** Allowed: its link is out and the new session is not in yet (no Allow or Deny any more). */
  joining: boolean
}

/** An invite this device made, as its page shows it. */
export interface InviteView {
  invite_id: string
  title: Text
  notice: Text
  computer: boolean
  /** "human" (a device of the person) or "agent". */
  role: string
  /** "open" (waits for the newcomer), "confirm_code" (the emoji to compare), "adding", "joined". */
  state: string
  /** When the link ends unused (ms). */
  expires_ms: number
  /** The newcomer's name once it is known ("" before): the device's own, or the agent's session. */
  newcomer?: string
}

/** A team's Scribble Board small: its shapes as `BoardView` has them, without a stroke's times, force and tilt. */
export interface ThumbView {
  team_id: string
  /** `desk/<32 hex>`. */
  board_id: string
  /** "loading" while it is read on this device, else as `BoardView.state`. */
  state: string
  /** How many shapes it holds (once read). */
  count: number
  shapes?: BoardShape[]
}

/** A Scribble Board (spec/v1.md 10): what its items add up to on this device, ready to draw. */
export interface BoardView {
  /** `desk/<32 hex>`. */
  board_id: string
  /** "loading" (its snapshot and the items after it are read), "ready", "newer_version" (an item needs a newer
   *  Trommi: what it did is not shown), "withheld" (an item could not be read on this device). */
  state: string
  /** Every shape in drawing order: by layer (`z`), then as they were made; strokes others are still drawing last. */
  shapes?: BoardShape[]
}

/** One shape of a board, in board units (a point is two numbers). The fields its tool does not use are left out.
 *  
 *  - stroke (`pen`, `marker`): `pts` its points, `t` their times (ms since it began), `f` their force (0 to 1),
 *    `az` and `al` the pen's azimuth and altitude in radians (none without tilt), `sim` a force made up from the
 *    speed, `color`, `width`;
 *  - note (`text`, `sticky`, `voice`): `pts` its top left corner, `text`, `size`, `color`, `wrap` (none: no wrap);
 *  - picture (`image`): `pts` two opposite corners, `attachment` its file's id (`ViewModel.files`, `OpenFile`),
 *    `nw` and `nh` its own size in pixels (0: not known), `mime`, `name`. */
export interface BoardShape {
  /** `<sender hex>/<envelope number>/<index>`, or `live:<sender hex>/<stroke hex>` for a stroke still drawn. */
  id: string
  /** The device that drew it (hex). */
  by: string
  tool: string
  z: number
  group?: string
  pts: number[]
  t?: number[]
  f?: number[]
  az?: number[]
  al?: number[]
  sim: boolean
  color?: string
  width?: number
  text?: string
  size?: number
  wrap?: number
  attachment?: string
  nw?: number
  nh?: number
  mime?: string
  name?: string
  /** A stroke someone else is still drawing (its pieces, spec 7.2): its finished form replaces it. */
  live: boolean
  /** Drawn on this device and not yet back from the hub: `<local_id>/<index>` of the `BoardItem` that made it. */
  local?: string
}

export interface FileView {
  name: string
  media_type: string
  size: number
  /** "uploading", "ready", "failed", "missing". */
  state: string
  /** The attachment's id once the hub has it (an upload's local id maps to it here). */
  attachment_id?: string
  /** 0..=100 while it moves. */
  percent?: number
  /** Its bytes were handed over (`Effect::FileReady`). */
  loaded: boolean
  /** The Share links this device made for it (`Action::Share`), kept in memory only. */
  shares?: FileShareView[]
}

/** A Share link of a file: the whole link (its key behind the `#`), for the person to copy. */
export interface FileShareView {
  share_id: string
  link: string
  expires_ms: number
}

/** A passing line at the window's foot: what was done, and the way back. The engine and the actions make them; the
 *  shell draws them and drops one when its time is up or it is pressed. */
export interface Toast {
  id: string
  /** The bold words ("Note sent to Fernly", "Not saved"). */
  text: Text
  /** An action the toast offers ("Undo", "Retry"), sent back as that action. */
  action?: unknown
  /** The quieter words after them ("the board did not take it"). */
  line?: Text
  /** The action's word on its button ("Undo", "Retry"); none: "Undo". */
  label?: Text
  /** Something went wrong: said at once to a screen reader (the web's role "alert"), drawn as a problem. */
  alert: boolean
  /** How long it stands (ms), as the ring on its Undo runs down; none: the shell's own time. */
  ms?: number
  /** A way to a page ("Open"): the screen, and the link's words. */
  go?: ToastGo
}

/** A toast's way to a page. */
export interface ToastGo {
  screen: Screen
  label: Text
}
