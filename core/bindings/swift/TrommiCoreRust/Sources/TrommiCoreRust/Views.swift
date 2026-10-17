// Written by tests/bindings/views.mjs from core/client/src/views/mod.rs: do not edit. The view model the core sends (Effect::Render)
// and the parts of it a shell sends back (Event::Focus), as Codable types: a field the core may leave out decodes to
// its default. Every type is inside `CoreView` (`CoreView.DeskView`), so none meets a name of SwiftUI or of an app.
import Foundation

public enum CoreView {
  /// A sentence of the core: `key` names it, `args` fill it, `en` is it in English.
  public struct Text: Codable, Hashable, Sendable {
    public var key: String
    public var args: [String: String]
    public var en: String

    public init(key: String = "", args: [String: String] = [:], en: String = "") {
      self.key = key
      self.args = args
      self.en = en
    }

    enum CodingKeys: String, CodingKey {
      case key = "key"
      case args = "args"
      case en = "en"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.key = try c.decode(String.self, forKey: .key)
      self.args = try c.decodeIfPresent([String: String].self, forKey: .args) ?? [:]
      self.en = try c.decode(String.self, forKey: .en)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(key, forKey: .key)
      if !args.isEmpty { try c.encode(args, forKey: .args) }
      try c.encode(en, forKey: .en)
    }
  }

  /// Where the app stands, for the whole window.
  public enum Phase: String, Codable, Hashable, Sendable {
    /// Before `Start`, or while the stored room is read.
    case starting = "starting"
    /// No room on this device: the sign-in and join screens.
    case signedOut = "signed_out"
    /// A room is open; the Desk is being read for the first time on this device.
    case opening = "opening"
    /// Open and current, the live stream runs.
    case live = "live"
    /// Open, showing what it has; the hub cannot be reached right now.
    case offline = "offline"
    /// The device was removed, or another owner took its state. Nothing more is done.
    case stopped = "stopped"

    public init() { self = .starting }
  }

  /// What the person looks at. Sent by the shell as `Event::Focus`.
  public struct Focus: Codable, Hashable, Sendable {
    public var screen: Screen
    /// The window (or app) is in front and visible.
    public var visible: Bool
    /// The team in view: a team's id; none when none was chosen, or one that is gone: the first team.
    public var team: String?
    /// The Scribble Board shown beside the screen (the Desk's): `desk/<32 hex>`, or a team's id or "all" for that
    /// team's board. `Screen::Scribble` shows its own. The core reads it and sends `ViewModel.board`.
    public var board: String?
    /// The Desk in view is home, every team's (the bell at the top), not the team in view's (a team's head).
    /// This device's: the shell keeps it.
    public var deskAll: Bool
    /// The teams unfolded in the wide sidebar, their chats under their stack (`TeamStackView.open`). This device's:
    /// the shell keeps them.
    public var openTeams: [String]
    /// The words searched for among every team's chats (the phone's Search tab, `SidebarView.found`); none or empty:
    /// no search.
    public var chatsQuery: String?
    /// The calm chat (the iPhone and the web send it): a session's page folds a run of card events into one row of
    /// chips (`kind` "events"), leaves the helper list out and says "and 2 more" beside the working line. A shell
    /// that draws the full talk (Linux) leaves it false.
    public var calm: Bool

    public init(screen: Screen = .desk, visible: Bool = true, team: String? = nil, board: String? = nil, deskAll: Bool = false, openTeams: [String] = [], chatsQuery: String? = nil, calm: Bool = false) {
      self.screen = screen
      self.visible = visible
      self.team = team
      self.board = board
      self.deskAll = deskAll
      self.openTeams = openTeams
      self.chatsQuery = chatsQuery
      self.calm = calm
    }

    enum CodingKeys: String, CodingKey {
      case screen = "screen"
      case visible = "visible"
      case team = "team"
      case board = "board"
      case deskAll = "desk_all"
      case openTeams = "open_teams"
      case chatsQuery = "chats_query"
      case calm = "calm"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.screen = try c.decode(Screen.self, forKey: .screen)
      self.visible = try c.decodeIfPresent(Bool.self, forKey: .visible) ?? true
      self.team = try c.decodeIfPresent(String.self, forKey: .team)
      self.board = try c.decodeIfPresent(String.self, forKey: .board)
      self.deskAll = try c.decodeIfPresent(Bool.self, forKey: .deskAll) ?? false
      self.openTeams = try c.decodeIfPresent([String].self, forKey: .openTeams) ?? []
      self.chatsQuery = try c.decodeIfPresent(String.self, forKey: .chatsQuery)
      self.calm = try c.decodeIfPresent(Bool.self, forKey: .calm) ?? false
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(screen, forKey: .screen)
      try c.encode(visible, forKey: .visible)
      try c.encodeIfPresent(team, forKey: .team)
      try c.encodeIfPresent(board, forKey: .board)
      try c.encode(deskAll, forKey: .deskAll)
      if !openTeams.isEmpty { try c.encode(openTeams, forKey: .openTeams) }
      try c.encodeIfPresent(chatsQuery, forKey: .chatsQuery)
      try c.encode(calm, forKey: .calm)
    }
  }

  public enum Screen: Codable, Hashable, Sendable {
    case desk
    case session(sessionId: String)
    case card(cardId: String)
    case notes
    /// The page Off your mind, the complete list, with the search's words (empty: all).
    case off(query: String)
    case scribble(boardId: String)
    /// The gallery of every Artifact the agents published, with its filter: "" every one, "media" the pictures,
    /// videos and files, "pages" the pages.
    case artifacts(kind: String)
    /// The page Knowledge of the team in view, with the search's words and its filter ("" every entry, "pinned").
    case knowledge(query: String, filter: String)
    /// Settings: its list (`page` ""), or one of its pages ("agents", "teams", "devices", "account", "theme",
    /// "data", "security").
    case settings(page: String)

    public init() { self = .desk }

    enum CodingKeys: String, CodingKey {
      case screen = "screen"
      case sessionId = "session_id"
      case cardId = "card_id"
      case query = "query"
      case boardId = "board_id"
      case kind = "kind"
      case filter = "filter"
      case page = "page"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      switch try c.decode(String.self, forKey: .screen) {
      case "desk": self = .desk
      case "session": self = .session(sessionId: try c.decode(String.self, forKey: .sessionId))
      case "card": self = .card(cardId: try c.decode(String.self, forKey: .cardId))
      case "notes": self = .notes
      case "off": self = .off(query: try c.decodeIfPresent(String.self, forKey: .query) ?? "")
      case "scribble": self = .scribble(boardId: try c.decode(String.self, forKey: .boardId))
      case "artifacts": self = .artifacts(kind: try c.decodeIfPresent(String.self, forKey: .kind) ?? "")
      case "knowledge": self = .knowledge(query: try c.decodeIfPresent(String.self, forKey: .query) ?? "", filter: try c.decodeIfPresent(String.self, forKey: .filter) ?? "")
      case "settings": self = .settings(page: try c.decodeIfPresent(String.self, forKey: .page) ?? "")
      case let other: throw DecodingError.dataCorruptedError(forKey: .screen, in: c, debugDescription: "Screen: no variant \(other)")
      }
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      switch self {
      case .desk:
        try c.encode("desk", forKey: .screen)
      case .session(let sessionId):
        try c.encode("session", forKey: .screen)
        try c.encode(sessionId, forKey: .sessionId)
      case .card(let cardId):
        try c.encode("card", forKey: .screen)
        try c.encode(cardId, forKey: .cardId)
      case .notes:
        try c.encode("notes", forKey: .screen)
      case .off(let query):
        try c.encode("off", forKey: .screen)
        try c.encode(query, forKey: .query)
      case .scribble(let boardId):
        try c.encode("scribble", forKey: .screen)
        try c.encode(boardId, forKey: .boardId)
      case .artifacts(let kind):
        try c.encode("artifacts", forKey: .screen)
        try c.encode(kind, forKey: .kind)
      case .knowledge(let query, let filter):
        try c.encode("knowledge", forKey: .screen)
        try c.encode(query, forKey: .query)
        try c.encode(filter, forKey: .filter)
      case .settings(let page):
        try c.encode("settings", forKey: .screen)
        try c.encode(page, forKey: .page)
      }
    }
  }

  /// Everything the shell draws. Serialised, this is what the conformance scripts compare.
  public struct ViewModel: Codable, Hashable, Sendable {
    /// Counts the deltas folded in; a delta whose `base` is not this is out of order (a shell bug).
    public var rev: UInt64
    public var phase: Phase
    /// One line on where the app stands when it is not plainly live ("Catching up", "Offline: retry in 30 s").
    public var status: Text?
    public var sidebar: SidebarView
    public var desk: DeskView
    public var sessions: [String: SessionView]
    public var cards: [String: CardView]
    /// The page Off your mind, while it is in view (`Screen::Off`).
    public var off: OffListView?
    public var notes: NotesView
    public var settings: SettingsView
    /// Signing in, joining, the emoji to compare, the Emergency Kit to keep, self-join asks.
    public var account: AccountView
    /// Files the views name (attachments, pictures), by id: uploading, ready, failed. Their bytes, when loaded,
    /// came as `Effect::FileReady` under the same id.
    public var files: [String: FileView]
    /// The Scribble Board in view (`Focus.board`, `Screen::Scribble`); none when no board is shown.
    public var board: BoardView?
    /// The gallery of Artifacts, while it is in view (`Screen::Artifacts`, and on the Desk, whose foot shows the newest), the newest first.
    public var artifacts: [ArtifactView]?
    /// The gallery's filter and its words, while `Screen::Artifacts` is in view (`artifacts` then holds what the
    /// filter lets through); none else.
    public var gallery: GalleryView?
    /// Every team's Scribble Board small, in the menu's order, while a page shows them (Settings, the boards of All
    /// teams); none else.
    public var thumbs: [ThumbView]?
    /// The page Knowledge of the team in view, while it is in view (`Screen::Knowledge`); none else.
    public var knowledge: KnowledgeView?
    public var toasts: [Toast]

    public init(rev: UInt64 = 0, phase: Phase = .starting, status: Text? = nil, sidebar: SidebarView = SidebarView(), desk: DeskView = DeskView(), sessions: [String: SessionView] = [:], cards: [String: CardView] = [:], off: OffListView? = nil, notes: NotesView = NotesView(), settings: SettingsView = SettingsView(), account: AccountView = AccountView(), files: [String: FileView] = [:], board: BoardView? = nil, artifacts: [ArtifactView]? = nil, gallery: GalleryView? = nil, thumbs: [ThumbView]? = nil, knowledge: KnowledgeView? = nil, toasts: [Toast] = []) {
      self.rev = rev
      self.phase = phase
      self.status = status
      self.sidebar = sidebar
      self.desk = desk
      self.sessions = sessions
      self.cards = cards
      self.off = off
      self.notes = notes
      self.settings = settings
      self.account = account
      self.files = files
      self.board = board
      self.artifacts = artifacts
      self.gallery = gallery
      self.thumbs = thumbs
      self.knowledge = knowledge
      self.toasts = toasts
    }

    enum CodingKeys: String, CodingKey {
      case rev = "rev"
      case phase = "phase"
      case status = "status"
      case sidebar = "sidebar"
      case desk = "desk"
      case sessions = "sessions"
      case cards = "cards"
      case off = "off"
      case notes = "notes"
      case settings = "settings"
      case account = "account"
      case files = "files"
      case board = "board"
      case artifacts = "artifacts"
      case gallery = "gallery"
      case thumbs = "thumbs"
      case knowledge = "knowledge"
      case toasts = "toasts"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.rev = try c.decode(UInt64.self, forKey: .rev)
      self.phase = try c.decode(Phase.self, forKey: .phase)
      self.status = try c.decodeIfPresent(Text.self, forKey: .status)
      self.sidebar = try c.decode(SidebarView.self, forKey: .sidebar)
      self.desk = try c.decode(DeskView.self, forKey: .desk)
      self.sessions = try c.decodeIfPresent([String: SessionView].self, forKey: .sessions) ?? [:]
      self.cards = try c.decodeIfPresent([String: CardView].self, forKey: .cards) ?? [:]
      self.off = try c.decodeIfPresent(OffListView.self, forKey: .off)
      self.notes = try c.decode(NotesView.self, forKey: .notes)
      self.settings = try c.decode(SettingsView.self, forKey: .settings)
      self.account = try c.decode(AccountView.self, forKey: .account)
      self.files = try c.decodeIfPresent([String: FileView].self, forKey: .files) ?? [:]
      self.board = try c.decodeIfPresent(BoardView.self, forKey: .board)
      self.artifacts = try c.decodeIfPresent([ArtifactView].self, forKey: .artifacts)
      self.gallery = try c.decodeIfPresent(GalleryView.self, forKey: .gallery)
      self.thumbs = try c.decodeIfPresent([ThumbView].self, forKey: .thumbs)
      self.knowledge = try c.decodeIfPresent(KnowledgeView.self, forKey: .knowledge)
      self.toasts = try c.decodeIfPresent([Toast].self, forKey: .toasts) ?? []
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(rev, forKey: .rev)
      try c.encode(phase, forKey: .phase)
      try c.encodeIfPresent(status, forKey: .status)
      try c.encode(sidebar, forKey: .sidebar)
      try c.encode(desk, forKey: .desk)
      if !sessions.isEmpty { try c.encode(sessions, forKey: .sessions) }
      if !cards.isEmpty { try c.encode(cards, forKey: .cards) }
      try c.encodeIfPresent(off, forKey: .off)
      try c.encode(notes, forKey: .notes)
      try c.encode(settings, forKey: .settings)
      try c.encode(account, forKey: .account)
      if !files.isEmpty { try c.encode(files, forKey: .files) }
      try c.encodeIfPresent(board, forKey: .board)
      try c.encodeIfPresent(artifacts, forKey: .artifacts)
      try c.encodeIfPresent(gallery, forKey: .gallery)
      try c.encodeIfPresent(thumbs, forKey: .thumbs)
      try c.encodeIfPresent(knowledge, forKey: .knowledge)
      if !toasts.isEmpty { try c.encode(toasts, forKey: .toasts) }
    }
  }

  /// One change of the view model, from `base` to `base + 1`.
  public struct ViewDelta: Codable, Hashable, Sendable {
    public var base: UInt64
    public var parts: [ViewPart]

    public init(base: UInt64, parts: [ViewPart]) {
      self.base = base
      self.parts = parts
    }

    enum CodingKeys: String, CodingKey {
      case base = "base"
      case parts = "parts"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.base = try c.decode(UInt64.self, forKey: .base)
      self.parts = try c.decode([ViewPart].self, forKey: .parts)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(base, forKey: .base)
      try c.encode(parts, forKey: .parts)
    }
  }

  public enum ViewPart: Codable, Hashable, Sendable {
    /// Everything, replacing what the shell had (the first render, after a restart of the core).
    case whole(model: ViewModel)
    case phase(phase: Phase, status: Text?)
    case sidebar(view: SidebarView)
    case desk(view: DeskView)
    case session(id: String, view: SessionView?)
    case card(id: String, view: CardView?)
    /// The page Off your mind; none when it is left.
    case off(view: OffListView?)
    case notes(view: NotesView)
    case settings(view: SettingsView)
    case account(view: AccountView)
    case file(id: String, view: FileView?)
    /// The Scribble Board in view, whole; none when it is left.
    case board(view: BoardView?)
    /// The gallery of Artifacts, whole; none when it is left.
    case artifacts(view: [ArtifactView]?)
    /// The gallery's filter and words, whole; none when it is left.
    case gallery(view: GalleryView?)
    /// The teams' boards small, whole; none when no page shows them.
    case thumbs(view: [ThumbView]?)
    /// The page Knowledge, whole; none when it is left.
    case knowledge(view: KnowledgeView?)
    case toasts(toasts: [Toast])

    enum CodingKeys: String, CodingKey {
      case part = "part"
      case model = "model"
      case phase = "phase"
      case status = "status"
      case view = "view"
      case id = "id"
      case toasts = "toasts"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      switch try c.decode(String.self, forKey: .part) {
      case "whole": self = .whole(model: try c.decode(ViewModel.self, forKey: .model))
      case "phase": self = .phase(phase: try c.decode(Phase.self, forKey: .phase), status: try c.decodeIfPresent(Text.self, forKey: .status))
      case "sidebar": self = .sidebar(view: try c.decode(SidebarView.self, forKey: .view))
      case "desk": self = .desk(view: try c.decode(DeskView.self, forKey: .view))
      case "session": self = .session(id: try c.decode(String.self, forKey: .id), view: try c.decodeIfPresent(SessionView.self, forKey: .view))
      case "card": self = .card(id: try c.decode(String.self, forKey: .id), view: try c.decodeIfPresent(CardView.self, forKey: .view))
      case "off": self = .off(view: try c.decodeIfPresent(OffListView.self, forKey: .view))
      case "notes": self = .notes(view: try c.decode(NotesView.self, forKey: .view))
      case "settings": self = .settings(view: try c.decode(SettingsView.self, forKey: .view))
      case "account": self = .account(view: try c.decode(AccountView.self, forKey: .view))
      case "file": self = .file(id: try c.decode(String.self, forKey: .id), view: try c.decodeIfPresent(FileView.self, forKey: .view))
      case "board": self = .board(view: try c.decodeIfPresent(BoardView.self, forKey: .view))
      case "artifacts": self = .artifacts(view: try c.decodeIfPresent([ArtifactView].self, forKey: .view))
      case "gallery": self = .gallery(view: try c.decodeIfPresent(GalleryView.self, forKey: .view))
      case "thumbs": self = .thumbs(view: try c.decodeIfPresent([ThumbView].self, forKey: .view))
      case "knowledge": self = .knowledge(view: try c.decodeIfPresent(KnowledgeView.self, forKey: .view))
      case "toasts": self = .toasts(toasts: try c.decode([Toast].self, forKey: .toasts))
      case let other: throw DecodingError.dataCorruptedError(forKey: .part, in: c, debugDescription: "ViewPart: no variant \(other)")
      }
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      switch self {
      case .whole(let model):
        try c.encode("whole", forKey: .part)
        try c.encode(model, forKey: .model)
      case .phase(let phase, let status):
        try c.encode("phase", forKey: .part)
        try c.encode(phase, forKey: .phase)
        try c.encode(status, forKey: .status)
      case .sidebar(let view):
        try c.encode("sidebar", forKey: .part)
        try c.encode(view, forKey: .view)
      case .desk(let view):
        try c.encode("desk", forKey: .part)
        try c.encode(view, forKey: .view)
      case .session(let id, let view):
        try c.encode("session", forKey: .part)
        try c.encode(id, forKey: .id)
        try c.encode(view, forKey: .view)
      case .card(let id, let view):
        try c.encode("card", forKey: .part)
        try c.encode(id, forKey: .id)
        try c.encode(view, forKey: .view)
      case .off(let view):
        try c.encode("off", forKey: .part)
        try c.encode(view, forKey: .view)
      case .notes(let view):
        try c.encode("notes", forKey: .part)
        try c.encode(view, forKey: .view)
      case .settings(let view):
        try c.encode("settings", forKey: .part)
        try c.encode(view, forKey: .view)
      case .account(let view):
        try c.encode("account", forKey: .part)
        try c.encode(view, forKey: .view)
      case .file(let id, let view):
        try c.encode("file", forKey: .part)
        try c.encode(id, forKey: .id)
        try c.encode(view, forKey: .view)
      case .board(let view):
        try c.encode("board", forKey: .part)
        try c.encode(view, forKey: .view)
      case .artifacts(let view):
        try c.encode("artifacts", forKey: .part)
        try c.encode(view, forKey: .view)
      case .gallery(let view):
        try c.encode("gallery", forKey: .part)
        try c.encode(view, forKey: .view)
      case .thumbs(let view):
        try c.encode("thumbs", forKey: .part)
        try c.encode(view, forKey: .view)
      case .knowledge(let view):
        try c.encode("knowledge", forKey: .part)
        try c.encode(view, forKey: .view)
      case .toasts(let toasts):
        try c.encode("toasts", forKey: .part)
        try c.encode(toasts, forKey: .toasts)
      }
    }
  }

  /// Edits of a long list, by position: at `at`, `gone` rows leave and `rows` come (the Desk's stack ops today).
  public struct RowEdit<T: Codable & Hashable & Sendable>: Codable, Hashable, Sendable {
    public var at: UInt32
    public var gone: UInt32
    public var rows: [T]

    public init(at: UInt32, gone: UInt32, rows: [T]) {
      self.at = at
      self.gone = gone
      self.rows = rows
    }

    enum CodingKeys: String, CodingKey {
      case at = "at"
      case gone = "gone"
      case rows = "rows"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.at = try c.decode(UInt32.self, forKey: .at)
      self.gone = try c.decode(UInt32.self, forKey: .gone)
      self.rows = try c.decode([T].self, forKey: .rows)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(at, forKey: .at)
      try c.encode(gone, forKey: .gone)
      try c.encode(rows, forKey: .rows)
    }
  }

  public enum Rows<T: Codable & Hashable & Sendable>: Codable, Hashable, Sendable {
    case whole(items: [T])
    case edits(edits: [RowEdit<T>])

    enum CodingKeys: String, CodingKey {
      case rows = "rows"
      case items = "items"
      case edits = "edits"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      switch try c.decode(String.self, forKey: .rows) {
      case "whole": self = .whole(items: try c.decode([T].self, forKey: .items))
      case "edits": self = .edits(edits: try c.decode([RowEdit<T>].self, forKey: .edits))
      case let other: throw DecodingError.dataCorruptedError(forKey: .rows, in: c, debugDescription: "Rows: no variant \(other)")
      }
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      switch self {
      case .whole(let items):
        try c.encode("whole", forKey: .rows)
        try c.encode(items, forKey: .items)
      case .edits(let edits):
        try c.encode("edits", forKey: .rows)
        try c.encode(edits, forKey: .edits)
      }
    }
  }

  /// The sidebar (the phone: the menu's teams, the list of chats, the tab pill's numbers): the teams, and one row per
  /// session of the team in view, in the order they are drawn.
  public struct SidebarView: Codable, Hashable, Sendable {
    /// The teams, in the menu's order. A room without teams has one: "Personal".
    public var teams: [TeamTab]
    /// Home in the menu, above the teams: the Desk of every team ("All teams", `Focus.desk_all`), with what waits on
    /// all of them; `selected` while it is the Desk in view. Its `id` is empty.
    public var home: TeamTab
    /// The sessions of the team in view, one row each, in drawing order: a main, then its helpers.
    public var sessions: [SessionRowView]
    /// The number on the app icon and the tab: the open questions of the Desk in view, the team's or on home every
    /// team's (no infos, nothing that is with its agent). Never drawn red.
    public var badge: UInt32
    /// The team in view: its id.
    public var team: String
    /// Where the person is, for the head and the team switch: the team's name.
    public var place: Text
    /// The open questions of the Desk in view, the team's or on home every team's (its lamp is lit while there are
    /// some).
    public var waiting: UInt32
    /// How many of them knock.
    public var knocking: UInt32
    /// How many rows of the team in view are stopped (the red hand).
    public var stopped: UInt32
    /// How many of them are at work.
    public var working: UInt32
    /// How many of his answers the sessions of the team in view have not picked up.
    public var unheard: UInt32
    /// Every team as a stack, in the menu's order (the wide sidebar): folded, its head over a fan of its sessions'
    /// card edges; open, its chats under it. The phone draws `sessions` instead.
    public var stacks: [TeamStackView]
    /// The Desk in view is every team's (home, `Focus.desk_all`): no team's head is marked.
    public var deskAll: Bool
    /// Under a search (`Focus.chats_query`): every team with a chat whose name or teaser has the words, with those
    /// chats, in the menu's order.
    public var found: [ChatGroupView]
    /// Under a search that finds no chat: so it says.
    public var foundNone: Text?

    public init(teams: [TeamTab] = [], home: TeamTab = TeamTab(), sessions: [SessionRowView] = [], badge: UInt32 = 0, team: String = "", place: Text = Text(), waiting: UInt32 = 0, knocking: UInt32 = 0, stopped: UInt32 = 0, working: UInt32 = 0, unheard: UInt32 = 0, stacks: [TeamStackView] = [], deskAll: Bool = false, found: [ChatGroupView] = [], foundNone: Text? = nil) {
      self.teams = teams
      self.home = home
      self.sessions = sessions
      self.badge = badge
      self.team = team
      self.place = place
      self.waiting = waiting
      self.knocking = knocking
      self.stopped = stopped
      self.working = working
      self.unheard = unheard
      self.stacks = stacks
      self.deskAll = deskAll
      self.found = found
      self.foundNone = foundNone
    }

    enum CodingKeys: String, CodingKey {
      case teams = "teams"
      case home = "home"
      case sessions = "sessions"
      case badge = "badge"
      case team = "team"
      case place = "place"
      case waiting = "waiting"
      case knocking = "knocking"
      case stopped = "stopped"
      case working = "working"
      case unheard = "unheard"
      case stacks = "stacks"
      case deskAll = "desk_all"
      case found = "found"
      case foundNone = "found_none"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.teams = try c.decode([TeamTab].self, forKey: .teams)
      self.home = try c.decodeIfPresent(TeamTab.self, forKey: .home) ?? TeamTab()
      self.sessions = try c.decode([SessionRowView].self, forKey: .sessions)
      self.badge = try c.decode(UInt32.self, forKey: .badge)
      self.team = try c.decodeIfPresent(String.self, forKey: .team) ?? ""
      self.place = try c.decodeIfPresent(Text.self, forKey: .place) ?? Text()
      self.waiting = try c.decodeIfPresent(UInt32.self, forKey: .waiting) ?? 0
      self.knocking = try c.decodeIfPresent(UInt32.self, forKey: .knocking) ?? 0
      self.stopped = try c.decodeIfPresent(UInt32.self, forKey: .stopped) ?? 0
      self.working = try c.decodeIfPresent(UInt32.self, forKey: .working) ?? 0
      self.unheard = try c.decodeIfPresent(UInt32.self, forKey: .unheard) ?? 0
      self.stacks = try c.decodeIfPresent([TeamStackView].self, forKey: .stacks) ?? []
      self.deskAll = try c.decodeIfPresent(Bool.self, forKey: .deskAll) ?? false
      self.found = try c.decodeIfPresent([ChatGroupView].self, forKey: .found) ?? []
      self.foundNone = try c.decodeIfPresent(Text.self, forKey: .foundNone)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(teams, forKey: .teams)
      try c.encode(home, forKey: .home)
      try c.encode(sessions, forKey: .sessions)
      try c.encode(badge, forKey: .badge)
      try c.encode(team, forKey: .team)
      try c.encode(place, forKey: .place)
      try c.encode(waiting, forKey: .waiting)
      try c.encode(knocking, forKey: .knocking)
      try c.encode(stopped, forKey: .stopped)
      try c.encode(working, forKey: .working)
      try c.encode(unheard, forKey: .unheard)
      if !stacks.isEmpty { try c.encode(stacks, forKey: .stacks) }
      try c.encode(deskAll, forKey: .deskAll)
      if !found.isEmpty { try c.encode(found, forKey: .found) }
      try c.encodeIfPresent(foundNone, forKey: .foundNone)
    }
  }

  /// A team in the search's list of chats: its name as a plain section title over the chats found.
  public struct ChatGroupView: Codable, Hashable, Sendable {
    public var id: String
    public var name: Text
    /// Its chats that have the words, one row each, in drawing order.
    public var rows: [SessionRowView]

    public init(id: String = "", name: Text = Text(), rows: [SessionRowView] = []) {
      self.id = id
      self.name = name
      self.rows = rows
    }

    enum CodingKeys: String, CodingKey {
      case id = "id"
      case name = "name"
      case rows = "rows"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.id = try c.decode(String.self, forKey: .id)
      self.name = try c.decode(Text.self, forKey: .name)
      self.rows = try c.decode([SessionRowView].self, forKey: .rows)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(id, forKey: .id)
      try c.encode(name, forKey: .name)
      try c.encode(rows, forKey: .rows)
    }
  }

  /// A team in the wide sidebar: its head (a click opens its Desk) over its sessions, folded to a stack or open.
  public struct TeamStackView: Codable, Hashable, Sendable {
    public var id: String
    public var name: Text
    /// The team in view and its Desk is the Desk (not on home, `desk_all`).
    public var selected: Bool
    /// Open on this device (`Focus.open_teams`): its chats stand under its head; folded, they lie as its stack.
    public var open: Bool
    /// The open questions of the team's sessions.
    public var waiting: UInt32
    /// One of them knocks.
    public var knocks: Bool
    /// What the head says to a screen reader: "3 agents, 2 questions open".
    public var says: Text
    /// A card edge per session (at most [`STACK_EDGES`]), in the rows' order. What knocks is said by the head's
    /// number, not by an edge.
    public var edges: [StackEdgeView]
    /// Its picture, as a group's: up to three of its sessions' own marks, overlapping, the crowned one first, then in
    /// the rows' order; none for a team without sessions (a quiet placeholder).
    public var faces: [StackEdgeView]
    /// Its sessions, one row each, in drawing order (connected first); drawn while open.
    public var sessions: [SessionRowView]

    public init(id: String = "", name: Text = Text(), selected: Bool = false, open: Bool = false, waiting: UInt32 = 0, knocks: Bool = false, says: Text = Text(), edges: [StackEdgeView] = [], faces: [StackEdgeView] = [], sessions: [SessionRowView] = []) {
      self.id = id
      self.name = name
      self.selected = selected
      self.open = open
      self.waiting = waiting
      self.knocks = knocks
      self.says = says
      self.edges = edges
      self.faces = faces
      self.sessions = sessions
    }

    enum CodingKeys: String, CodingKey {
      case id = "id"
      case name = "name"
      case selected = "selected"
      case open = "open"
      case waiting = "waiting"
      case knocks = "knocks"
      case says = "says"
      case edges = "edges"
      case faces = "faces"
      case sessions = "sessions"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.id = try c.decode(String.self, forKey: .id)
      self.name = try c.decode(Text.self, forKey: .name)
      self.selected = try c.decode(Bool.self, forKey: .selected)
      self.open = try c.decodeIfPresent(Bool.self, forKey: .open) ?? false
      self.waiting = try c.decode(UInt32.self, forKey: .waiting)
      self.knocks = try c.decodeIfPresent(Bool.self, forKey: .knocks) ?? false
      self.says = try c.decode(Text.self, forKey: .says)
      self.edges = try c.decodeIfPresent([StackEdgeView].self, forKey: .edges) ?? []
      self.faces = try c.decodeIfPresent([StackEdgeView].self, forKey: .faces) ?? []
      self.sessions = try c.decodeIfPresent([SessionRowView].self, forKey: .sessions) ?? []
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(id, forKey: .id)
      try c.encode(name, forKey: .name)
      try c.encode(selected, forKey: .selected)
      try c.encode(open, forKey: .open)
      try c.encode(waiting, forKey: .waiting)
      try c.encode(knocks, forKey: .knocks)
      try c.encode(says, forKey: .says)
      if !edges.isEmpty { try c.encode(edges, forKey: .edges) }
      if !faces.isEmpty { try c.encode(faces, forKey: .faces) }
      if !sessions.isEmpty { try c.encode(sessions, forKey: .sessions) }
    }
  }

  /// A session in a team's stack: its card edge, or its face in the team's picture.
  public struct StackEdgeView: Codable, Hashable, Sendable {
    /// The session's key (its row's id).
    public var id: String
    /// What draws it (its row's mark): the edge takes its colour.
    public var mark: String

    public init(id: String = "", mark: String = "") {
      self.id = id
      self.mark = mark
    }

    enum CodingKeys: String, CodingKey {
      case id = "id"
      case mark = "mark"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.id = try c.decode(String.self, forKey: .id)
      self.mark = try c.decode(String.self, forKey: .mark)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(id, forKey: .id)
      try c.encode(mark, forKey: .mark)
    }
  }

  public struct TeamTab: Codable, Hashable, Sendable {
    public var id: String
    public var name: Text
    /// The open questions of the team's sessions.
    public var waiting: UInt32
    /// It is the Desk in view: the team in view, unless home (`desk_all`) is.
    public var selected: Bool
    /// One of them knocks.
    public var knocks: Bool

    public init(id: String = "", name: Text = Text(), waiting: UInt32 = 0, selected: Bool = false, knocks: Bool = false) {
      self.id = id
      self.name = name
      self.waiting = waiting
      self.selected = selected
      self.knocks = knocks
    }

    enum CodingKeys: String, CodingKey {
      case id = "id"
      case name = "name"
      case waiting = "waiting"
      case selected = "selected"
      case knocks = "knocks"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.id = try c.decode(String.self, forKey: .id)
      self.name = try c.decode(Text.self, forKey: .name)
      self.waiting = try c.decode(UInt32.self, forKey: .waiting)
      self.selected = try c.decode(Bool.self, forKey: .selected)
      self.knocks = try c.decodeIfPresent(Bool.self, forKey: .knocks) ?? false
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(id, forKey: .id)
      try c.encode(name, forKey: .name)
      try c.encode(waiting, forKey: .waiting)
      try c.encode(selected, forKey: .selected)
      try c.encode(knocks, forKey: .knocks)
    }
  }

  /// One session in the sidebar.
  public struct SessionRowView: Codable, Hashable, Sendable {
    /// The session's key in the model (`Screen::Session`, the actions' `session_id`, `ViewModel.sessions`).
    public var id: String
    public var name: Text
    /// "live", "oncall", "asleep", "cut", "gone" (core/client/src/status.rs).
    public var link: String
    /// The red hand.
    public var blocked: Bool
    /// How many of his answers it has not picked up for two minutes.
    public var unheard: UInt32
    /// Its short id on the board: its address (`/chat/<slug>`).
    public var slug: String
    /// What draws it: always a face, "draw:<face>" (`faces::mark`: the icon the person or the agent chose, else the face
    /// its name fits, else the one its id picks).
    public var mark: String
    /// The team it stands on.
    public var teamId: String
    public var online: Bool
    /// Connected and at work (a status line of it shows "working").
    public var working: Bool
    /// A main session: one that says so.
    public var main: Bool
    /// The crowned session of its team (the one a note goes to).
    public var crowned: Bool
    /// Its helpers (its agent's subagents), small under its name: "3 helpers" with a dot each; none without.
    public var helpers: HelperDotsView?
    /// Its open questions: what waits for the person on the Desk (no infos, nothing that is with its agent).
    public var open: UInt32
    /// One of them knocks.
    public var knocks: Bool
    /// Why it is stopped, in words.
    public var hand: HandView?
    /// The small line under its name: its link when it does not hear at once, else the answers it has not picked up.
    public var cap: CapView?
    /// Not connected: it stands under "Disconnected".
    public var away: Bool
    /// The part of the list a row may be dragged within (its team, connected or not).
    public var group: String
    /// What its badge says to a screen reader ("Working, 2 questions open"); none without a badge.
    public var says: Text?
    /// What was said last in its conversation (his words with "You: "), or the question it put to him last: the
    /// Chat list's teaser; none while this device holds nothing said there.
    public var last: LastSaidView?
    /// Its agent said something this device has not shown yet (the chat was not open since): the Chat list's dot.
    public var unread: Bool
    /// The one quiet sign of a calm chat row: "stopped" (the red hand), "waiting" (a question waits for him),
    /// "unread" (new words), or "" for none.
    public var signal: String

    public init(id: String = "", name: Text = Text(), link: String = "", blocked: Bool = false, unheard: UInt32 = 0, slug: String = "", mark: String = "", teamId: String = "", online: Bool = false, working: Bool = false, main: Bool = false, crowned: Bool = false, helpers: HelperDotsView? = nil, open: UInt32 = 0, knocks: Bool = false, hand: HandView? = nil, cap: CapView? = nil, away: Bool = false, group: String = "", says: Text? = nil, last: LastSaidView? = nil, unread: Bool = false, signal: String = "") {
      self.id = id
      self.name = name
      self.link = link
      self.blocked = blocked
      self.unheard = unheard
      self.slug = slug
      self.mark = mark
      self.teamId = teamId
      self.online = online
      self.working = working
      self.main = main
      self.crowned = crowned
      self.helpers = helpers
      self.open = open
      self.knocks = knocks
      self.hand = hand
      self.cap = cap
      self.away = away
      self.group = group
      self.says = says
      self.last = last
      self.unread = unread
      self.signal = signal
    }

    enum CodingKeys: String, CodingKey {
      case id = "id"
      case name = "name"
      case link = "link"
      case blocked = "blocked"
      case unheard = "unheard"
      case slug = "slug"
      case mark = "mark"
      case teamId = "team_id"
      case online = "online"
      case working = "working"
      case main = "main"
      case crowned = "crowned"
      case helpers = "helpers"
      case open = "open"
      case knocks = "knocks"
      case hand = "hand"
      case cap = "cap"
      case away = "away"
      case group = "group"
      case says = "says"
      case last = "last"
      case unread = "unread"
      case signal = "signal"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.id = try c.decode(String.self, forKey: .id)
      self.name = try c.decode(Text.self, forKey: .name)
      self.link = try c.decode(String.self, forKey: .link)
      self.blocked = try c.decode(Bool.self, forKey: .blocked)
      self.unheard = try c.decode(UInt32.self, forKey: .unheard)
      self.slug = try c.decodeIfPresent(String.self, forKey: .slug) ?? ""
      self.mark = try c.decodeIfPresent(String.self, forKey: .mark) ?? ""
      self.teamId = try c.decodeIfPresent(String.self, forKey: .teamId) ?? ""
      self.online = try c.decodeIfPresent(Bool.self, forKey: .online) ?? false
      self.working = try c.decodeIfPresent(Bool.self, forKey: .working) ?? false
      self.main = try c.decodeIfPresent(Bool.self, forKey: .main) ?? false
      self.crowned = try c.decodeIfPresent(Bool.self, forKey: .crowned) ?? false
      self.helpers = try c.decodeIfPresent(HelperDotsView.self, forKey: .helpers)
      self.open = try c.decodeIfPresent(UInt32.self, forKey: .open) ?? 0
      self.knocks = try c.decodeIfPresent(Bool.self, forKey: .knocks) ?? false
      self.hand = try c.decodeIfPresent(HandView.self, forKey: .hand)
      self.cap = try c.decodeIfPresent(CapView.self, forKey: .cap)
      self.away = try c.decodeIfPresent(Bool.self, forKey: .away) ?? false
      self.group = try c.decodeIfPresent(String.self, forKey: .group) ?? ""
      self.says = try c.decodeIfPresent(Text.self, forKey: .says)
      self.last = try c.decodeIfPresent(LastSaidView.self, forKey: .last)
      self.unread = try c.decodeIfPresent(Bool.self, forKey: .unread) ?? false
      self.signal = try c.decodeIfPresent(String.self, forKey: .signal) ?? ""
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(id, forKey: .id)
      try c.encode(name, forKey: .name)
      try c.encode(link, forKey: .link)
      try c.encode(blocked, forKey: .blocked)
      try c.encode(unheard, forKey: .unheard)
      try c.encode(slug, forKey: .slug)
      try c.encode(mark, forKey: .mark)
      try c.encode(teamId, forKey: .teamId)
      try c.encode(online, forKey: .online)
      try c.encode(working, forKey: .working)
      try c.encode(main, forKey: .main)
      try c.encode(crowned, forKey: .crowned)
      try c.encodeIfPresent(helpers, forKey: .helpers)
      try c.encode(open, forKey: .open)
      try c.encode(knocks, forKey: .knocks)
      try c.encodeIfPresent(hand, forKey: .hand)
      try c.encodeIfPresent(cap, forKey: .cap)
      try c.encode(away, forKey: .away)
      try c.encode(group, forKey: .group)
      try c.encodeIfPresent(says, forKey: .says)
      try c.encodeIfPresent(last, forKey: .last)
      try c.encode(unread, forKey: .unread)
      try c.encode(signal, forKey: .signal)
    }
  }

  /// What a conversation said last, for its row in the Chat list.
  public struct LastSaidView: Codable, Hashable, Sendable {
    /// Its first words as one plain line (200 characters at most): "You: …" for his own.
    public var text: String
    public var atMs: UInt64
    /// When, as a chat list says it: "14:05" today, "Yesterday", a weekday within the week, "3 Oct", "03.10.25".
    public var when: Text

    public init(text: String = "", atMs: UInt64 = 0, when: Text = Text()) {
      self.text = text
      self.atMs = atMs
      self.when = when
    }

    enum CodingKeys: String, CodingKey {
      case text = "text"
      case atMs = "at_ms"
      case when = "when"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.text = try c.decode(String.self, forKey: .text)
      self.atMs = try c.decode(UInt64.self, forKey: .atMs)
      self.when = try c.decode(Text.self, forKey: .when)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(text, forKey: .text)
      try c.encode(atMs, forKey: .atMs)
      try c.encode(when, forKey: .when)
    }
  }

  /// A session's helpers in its sidebar row: how many, and a dot each.
  public struct HelperDotsView: Codable, Hashable, Sendable {
    /// "1 helper", "3 helpers".
    public var says: Text
    /// One dot per helper, in order: filled while that helper works.
    public var working: [Bool]

    public init(says: Text = Text(), working: [Bool] = []) {
      self.says = says
      self.working = working
    }

    enum CodingKeys: String, CodingKey {
      case says = "says"
      case working = "working"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.says = try c.decode(Text.self, forKey: .says)
      self.working = try c.decode([Bool].self, forKey: .working)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(says, forKey: .says)
      try c.encode(working, forKey: .working)
    }
  }

  /// A session's helpers on its page: a short list, name and state, no way into a chat of their own.
  public struct HelperListView: Codable, Hashable, Sendable {
    /// "3 helpers".
    public var head: Text
    /// "1 working · their cards come with this session".
    public var sub: Text
    public var rows: [HelperRowView]

    public init(head: Text = Text(), sub: Text = Text(), rows: [HelperRowView] = []) {
      self.head = head
      self.sub = sub
      self.rows = rows
    }

    enum CodingKeys: String, CodingKey {
      case head = "head"
      case sub = "sub"
      case rows = "rows"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.head = try c.decode(Text.self, forKey: .head)
      self.sub = try c.decode(Text.self, forKey: .sub)
      self.rows = try c.decode([HelperRowView].self, forKey: .rows)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(head, forKey: .head)
      try c.encode(sub, forKey: .sub)
      try c.encode(rows, forKey: .rows)
    }
  }

  /// One helper of a session's page.
  public struct HelperRowView: Codable, Hashable, Sendable {
    public var name: String
    public var working: Bool
    /// "Working · 1 open question", "1 open question", "Done".
    public var says: Text

    public init(name: String = "", working: Bool = false, says: Text = Text()) {
      self.name = name
      self.working = working
      self.says = says
    }

    enum CodingKeys: String, CodingKey {
      case name = "name"
      case working = "working"
      case says = "says"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.name = try c.decode(String.self, forKey: .name)
      self.working = try c.decode(Bool.self, forKey: .working)
      self.says = try c.decode(Text.self, forKey: .says)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(name, forKey: .name)
      try c.encode(working, forKey: .working)
      try c.encode(says, forKey: .says)
    }
  }

  /// Why a session is stopped: the red hand.
  public struct HandView: Codable, Hashable, Sendable {
    /// "cut", "offline", "permission", "blocking".
    public var why: String
    public var text: Text
    public var since: UInt64?

    public init(why: String = "", text: Text = Text(), since: UInt64? = nil) {
      self.why = why
      self.text = text
      self.since = since
    }

    enum CodingKeys: String, CodingKey {
      case why = "why"
      case text = "text"
      case since = "since"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.why = try c.decode(String.self, forKey: .why)
      self.text = try c.decode(Text.self, forKey: .text)
      self.since = try c.decodeIfPresent(UInt64.self, forKey: .since)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(why, forKey: .why)
      try c.encode(text, forKey: .text)
      try c.encodeIfPresent(since, forKey: .since)
    }
  }

  /// The small line under a session's name.
  public struct CapView: Codable, Hashable, Sendable {
    /// "oncall", "asleep", "cut", "gone", or "unheard" (it hears at once and has answers to pick up).
    public var kind: String
    /// Two or three words: "cut off · 14:05", "1 answer waits".
    public var word: Text
    /// The tooltip: "Cut off since 14:05".
    public var short: Text
    /// The whole sentence about the session, for a screen reader; none for "unheard".
    public var line: Text?

    public init(kind: String = "", word: Text = Text(), short: Text = Text(), line: Text? = nil) {
      self.kind = kind
      self.word = word
      self.short = short
      self.line = line
    }

    enum CodingKeys: String, CodingKey {
      case kind = "kind"
      case word = "word"
      case short = "short"
      case line = "line"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.kind = try c.decode(String.self, forKey: .kind)
      self.word = try c.decode(Text.self, forKey: .word)
      self.short = try c.decode(Text.self, forKey: .short)
      self.line = try c.decodeIfPresent(Text.self, forKey: .line)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(kind, forKey: .kind)
      try c.encode(word, forKey: .word)
      try c.encode(short, forKey: .short)
      try c.encodeIfPresent(line, forKey: .line)
    }
  }

  /// A session's link in words: whether it hears the person, and what to do when it does not.
  public struct LinkWords: Codable, Hashable, Sendable {
    /// "live", "oncall", "asleep", "cut", "gone".
    public var state: String
    /// Since when it is cut off or gone; for "oncall" and "asleep" its last step.
    public var since: UInt64?
    /// Two or three words under its name ("not listening · 12 min"); none while it hears at once.
    public var word: Text?
    /// The same as a short sentence ("Not listening for 12 min").
    public var short: Text?
    /// The whole sentence about the session.
    public var line: Text
    /// The way out.
    public var fix: FixView?

    public init(state: String = "", since: UInt64? = nil, word: Text? = nil, short: Text? = nil, line: Text = Text(), fix: FixView? = nil) {
      self.state = state
      self.since = since
      self.word = word
      self.short = short
      self.line = line
      self.fix = fix
    }

    enum CodingKeys: String, CodingKey {
      case state = "state"
      case since = "since"
      case word = "word"
      case short = "short"
      case line = "line"
      case fix = "fix"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.state = try c.decode(String.self, forKey: .state)
      self.since = try c.decodeIfPresent(UInt64.self, forKey: .since)
      self.word = try c.decodeIfPresent(Text.self, forKey: .word)
      self.short = try c.decodeIfPresent(Text.self, forKey: .short)
      self.line = try c.decode(Text.self, forKey: .line)
      self.fix = try c.decodeIfPresent(FixView.self, forKey: .fix)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(state, forKey: .state)
      try c.encodeIfPresent(since, forKey: .since)
      try c.encodeIfPresent(word, forKey: .word)
      try c.encodeIfPresent(short, forKey: .short)
      try c.encode(line, forKey: .line)
      try c.encodeIfPresent(fix, forKey: .fix)
    }
  }

  /// What to do about a link: a sentence, and a line to type (empty when there is none).
  public struct FixView: Codable, Hashable, Sendable {
    public var say: Text
    public var code: String

    public init(say: Text = Text(), code: String = "") {
      self.say = say
      self.code = code
    }

    enum CodingKeys: String, CodingKey {
      case say = "say"
      case code = "code"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.say = try c.decode(Text.self, forKey: .say)
      self.code = try c.decode(String.self, forKey: .code)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(say, forKey: .say)
      try c.encode(code, forKey: .code)
    }
  }

  /// The Desk of the team in view: its head, and the stack of what waits for the person as rows.
  public struct DeskView: Codable, Hashable, Sendable {
    /// Card and request ids, in the Desk's order: the ids of `rows`.
    public var stack: [String]
    /// Off your mind, of the team in view (`off.rs`, from the core's `off_mind`): the cards with their agents,
    /// starred ones too, the one that moved last first (the complete list's top part).
    public var offYourMind: [String]
    /// The put-off cards, the last put off first.
    public var later: [String]
    /// The cards closed last (done, withdrawn, shredded), the newest first: the core's window of them
    /// (`off_mind::RECENT` for the whole room), not every closed card; the complete list has them all.
    public var done: [String]
    /// The two stacks docked at the Desk's foot; none while a stack is empty. A card has one home: a starred card
    /// is in `starred` only, also while it is being worked on.
    public var starred: DockView?
    public var running: DockView?
    /// The section Off your mind under the Desk: its first rows and how many; none while nothing is put off or
    /// closed.
    public var off: OffHintView?
    /// What stands in the list's place when nothing is open at all ("Questions land here.").
    public var empty: Text?
    /// "invite" (no session stands here yet: invite the first agent), "reading" (none yet, and the room is still
    /// being read), "team".
    public var mode: String
    /// The one big line at the top; none for "invite".
    public var hello: Text?
    /// How far the reading of the room's past is ("Reading your history: 12,400 of 27,000"), while it is read.
    public var reading: Text?
    /// The team's goals; none on All teams.
    public var goals: GoalsView?
    /// The chip that opens the team's page Knowledge; none on All teams, as the goals.
    public var knowledge: KnowledgeChipView?
    /// What waits, in the Desk's order: the questions and what is only to read.
    public var rows: [DeskRowView]
    /// The open questions (no infos): the number in the window's title.
    public var waiting: UInt32
    /// What Blitz walks through and the duck closes ("Blitz: 3 open cards"); none when nothing waits.
    public var blitz: Text?
    /// The duck for all beside Blitz: what one press leaves to the agents (a decision) or reads (an info) at once,
    /// after one question; none when nothing of that waits.
    public var duck: DuckAllView?
    /// The sessions that are cut off, above the questions: one line each, with the step in its terminal.
    public var slip: [SlipView]
    /// Under the questions, calm tiles, in this order: "work" (Working / Done: what runs and what is done, it opens
    /// Off your mind), "artifacts" (what the agents published), "board" (the team's Scribble Board), "knowledge"
    /// (the team's Knowledge; not on All teams).
    /// Empty while the Desk is not in view.
    public var tiles: [DeskTileView]

    public init(stack: [String] = [], offYourMind: [String] = [], later: [String] = [], done: [String] = [], starred: DockView? = nil, running: DockView? = nil, off: OffHintView? = nil, empty: Text? = nil, mode: String = "", hello: Text? = nil, reading: Text? = nil, goals: GoalsView? = nil, knowledge: KnowledgeChipView? = nil, rows: [DeskRowView] = [], waiting: UInt32 = 0, blitz: Text? = nil, duck: DuckAllView? = nil, slip: [SlipView] = [], tiles: [DeskTileView] = []) {
      self.stack = stack
      self.offYourMind = offYourMind
      self.later = later
      self.done = done
      self.starred = starred
      self.running = running
      self.off = off
      self.empty = empty
      self.mode = mode
      self.hello = hello
      self.reading = reading
      self.goals = goals
      self.knowledge = knowledge
      self.rows = rows
      self.waiting = waiting
      self.blitz = blitz
      self.duck = duck
      self.slip = slip
      self.tiles = tiles
    }

    enum CodingKeys: String, CodingKey {
      case stack = "stack"
      case offYourMind = "off_your_mind"
      case later = "later"
      case done = "done"
      case starred = "starred"
      case running = "running"
      case off = "off"
      case empty = "empty"
      case mode = "mode"
      case hello = "hello"
      case reading = "reading"
      case goals = "goals"
      case knowledge = "knowledge"
      case rows = "rows"
      case waiting = "waiting"
      case blitz = "blitz"
      case duck = "duck"
      case slip = "slip"
      case tiles = "tiles"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.stack = try c.decode([String].self, forKey: .stack)
      self.offYourMind = try c.decode([String].self, forKey: .offYourMind)
      self.later = try c.decode([String].self, forKey: .later)
      self.done = try c.decode([String].self, forKey: .done)
      self.starred = try c.decodeIfPresent(DockView.self, forKey: .starred)
      self.running = try c.decodeIfPresent(DockView.self, forKey: .running)
      self.off = try c.decodeIfPresent(OffHintView.self, forKey: .off)
      self.empty = try c.decodeIfPresent(Text.self, forKey: .empty)
      self.mode = try c.decodeIfPresent(String.self, forKey: .mode) ?? ""
      self.hello = try c.decodeIfPresent(Text.self, forKey: .hello)
      self.reading = try c.decodeIfPresent(Text.self, forKey: .reading)
      self.goals = try c.decodeIfPresent(GoalsView.self, forKey: .goals)
      self.knowledge = try c.decodeIfPresent(KnowledgeChipView.self, forKey: .knowledge)
      self.rows = try c.decodeIfPresent([DeskRowView].self, forKey: .rows) ?? []
      self.waiting = try c.decodeIfPresent(UInt32.self, forKey: .waiting) ?? 0
      self.blitz = try c.decodeIfPresent(Text.self, forKey: .blitz)
      self.duck = try c.decodeIfPresent(DuckAllView.self, forKey: .duck)
      self.slip = try c.decodeIfPresent([SlipView].self, forKey: .slip) ?? []
      self.tiles = try c.decodeIfPresent([DeskTileView].self, forKey: .tiles) ?? []
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(stack, forKey: .stack)
      try c.encode(offYourMind, forKey: .offYourMind)
      try c.encode(later, forKey: .later)
      try c.encode(done, forKey: .done)
      try c.encodeIfPresent(starred, forKey: .starred)
      try c.encodeIfPresent(running, forKey: .running)
      try c.encodeIfPresent(off, forKey: .off)
      try c.encodeIfPresent(empty, forKey: .empty)
      try c.encode(mode, forKey: .mode)
      try c.encodeIfPresent(hello, forKey: .hello)
      try c.encodeIfPresent(reading, forKey: .reading)
      try c.encodeIfPresent(goals, forKey: .goals)
      try c.encodeIfPresent(knowledge, forKey: .knowledge)
      if !rows.isEmpty { try c.encode(rows, forKey: .rows) }
      try c.encode(waiting, forKey: .waiting)
      try c.encodeIfPresent(blitz, forKey: .blitz)
      try c.encodeIfPresent(duck, forKey: .duck)
      if !slip.isEmpty { try c.encode(slip, forKey: .slip) }
      if !tiles.isEmpty { try c.encode(tiles, forKey: .tiles) }
    }
  }

  /// One tile under the Desk's questions.
  public struct DeskTileView: Codable, Hashable, Sendable {
    /// "work", "artifacts", "board" or "knowledge".
    public var key: String
    /// Its name: "Working / Done", "Artifacts", "Scribble Board", "Knowledge".
    public var title: Text
    /// What it holds in a few words: "2 running · 10 done", "14 artifacts", "27 elements", "7 entries"; "Nothing
    /// yet" when empty.
    public var line: Text
    /// How many (artifacts, elements on the board, entries); none where the line says it ("work").
    public var count: UInt32?
    /// Where a click goes: `Screen::Off`, `Screen::Artifacts`, `Screen::Scribble`.
    public var opens: Screen
    /// What it shows small, in order: the running cards (ids of `DeskView.off.running`) for "work", the newest
    /// artifacts (ids of `ViewModel.artifacts`, at most four) for "artifacts"; empty for "board".
    public var items: [String]
    /// "board": the team whose board it shows small (a `ThumbView.team_id`); "knowledge": its team. None on All teams.
    public var teamId: String?

    public init(key: String = "", title: Text = Text(), line: Text = Text(), count: UInt32? = nil, opens: Screen = .desk, items: [String] = [], teamId: String? = nil) {
      self.key = key
      self.title = title
      self.line = line
      self.count = count
      self.opens = opens
      self.items = items
      self.teamId = teamId
    }

    enum CodingKeys: String, CodingKey {
      case key = "key"
      case title = "title"
      case line = "line"
      case count = "count"
      case opens = "opens"
      case items = "items"
      case teamId = "team_id"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.key = try c.decode(String.self, forKey: .key)
      self.title = try c.decode(Text.self, forKey: .title)
      self.line = try c.decode(Text.self, forKey: .line)
      self.count = try c.decodeIfPresent(UInt32.self, forKey: .count)
      self.opens = try c.decode(Screen.self, forKey: .opens)
      self.items = try c.decodeIfPresent([String].self, forKey: .items) ?? []
      self.teamId = try c.decodeIfPresent(String.self, forKey: .teamId)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(key, forKey: .key)
      try c.encode(title, forKey: .title)
      try c.encode(line, forKey: .line)
      try c.encodeIfPresent(count, forKey: .count)
      try c.encode(opens, forKey: .opens)
      if !items.isEmpty { try c.encode(items, forKey: .items) }
      try c.encodeIfPresent(teamId, forKey: .teamId)
    }
  }

  /// The duck for all: the cards it clears (`Action::Batch` with way "sweep") and its words (the web's `duckAll`).
  public struct DuckAllView: Codable, Hashable, Sendable {
    /// The cards it clears, in the Desk's order: the open decisions (left to their agents) and what is only to
    /// read (closed as read); never a request, nothing not read on this device yet.
    public var cardIds: [String]
    /// The button's name: "I don’t give a duck: for all 3 open cards".
    public var tip: Text
    /// Its short name where its question follows at once (the iPhone's ⋯ menu): "IDGAD".
    public var short: Text
    /// How many of which, for a screen reader: "2 decisions go to the agents, 1 card to read is closed".
    public var what: Text
    /// The one question it asks: "Duck all 3?"; only cards to read: "Close all 2 as read?".
    public var ask: Text
    /// The yes: "Yes, duck them all", "Yes, all read".
    public var yes: Text
    /// The quiet way out: "Cancel".
    public var no: Text

    public init(cardIds: [String] = [], tip: Text = Text(), short: Text = Text(), what: Text = Text(), ask: Text = Text(), yes: Text = Text(), no: Text = Text()) {
      self.cardIds = cardIds
      self.tip = tip
      self.short = short
      self.what = what
      self.ask = ask
      self.yes = yes
      self.no = no
    }

    enum CodingKeys: String, CodingKey {
      case cardIds = "card_ids"
      case tip = "tip"
      case short = "short"
      case what = "what"
      case ask = "ask"
      case yes = "yes"
      case no = "no"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.cardIds = try c.decode([String].self, forKey: .cardIds)
      self.tip = try c.decode(Text.self, forKey: .tip)
      self.short = try c.decodeIfPresent(Text.self, forKey: .short) ?? Text()
      self.what = try c.decode(Text.self, forKey: .what)
      self.ask = try c.decode(Text.self, forKey: .ask)
      self.yes = try c.decode(Text.self, forKey: .yes)
      self.no = try c.decode(Text.self, forKey: .no)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(cardIds, forKey: .cardIds)
      try c.encode(tip, forKey: .tip)
      try c.encode(short, forKey: .short)
      try c.encode(what, forKey: .what)
      try c.encode(ask, forKey: .ask)
      try c.encode(yes, forKey: .yes)
      try c.encode(no, forKey: .no)
    }
  }

  /// The gallery's filter (`Screen::Artifacts.kind`) and what its page says.
  public struct GalleryView: Codable, Hashable, Sendable {
    /// The filter in force: "", "media" or "pages".
    public var kind: String
    /// The filter's choices, in order ("All", "Media", "Pages"); none while there is no Artifact at all.
    public var kinds: [GalleryKindView]
    /// The line under the page's title.
    public var lead: Text
    /// What the page says when the filter lets nothing through ("No pages yet."); none when it shows something.
    public var none: Text?

    public init(kind: String = "", kinds: [GalleryKindView] = [], lead: Text = Text(), none: Text? = nil) {
      self.kind = kind
      self.kinds = kinds
      self.lead = lead
      self.none = none
    }

    enum CodingKeys: String, CodingKey {
      case kind = "kind"
      case kinds = "kinds"
      case lead = "lead"
      case none = "none"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? ""
      self.kinds = try c.decodeIfPresent([GalleryKindView].self, forKey: .kinds) ?? []
      self.lead = try c.decode(Text.self, forKey: .lead)
      self.none = try c.decodeIfPresent(Text.self, forKey: .none)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(kind, forKey: .kind)
      if !kinds.isEmpty { try c.encode(kinds, forKey: .kinds) }
      try c.encode(lead, forKey: .lead)
      try c.encodeIfPresent(none, forKey: .none)
    }
  }

  /// One choice of the gallery's filter.
  public struct GalleryKindView: Codable, Hashable, Sendable {
    /// "", "media" or "pages": what `Screen::Artifacts.kind` takes.
    public var key: String
    public var label: Text
    /// How many it lets through.
    public var count: UInt32
    /// It is the one in force.
    public var on: Bool

    public init(key: String = "", label: Text = Text(), count: UInt32 = 0, on: Bool = false) {
      self.key = key
      self.label = label
      self.count = count
      self.on = on
    }

    enum CodingKeys: String, CodingKey {
      case key = "key"
      case label = "label"
      case count = "count"
      case on = "on"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.key = try c.decodeIfPresent(String.self, forKey: .key) ?? ""
      self.label = try c.decode(Text.self, forKey: .label)
      self.count = try c.decodeIfPresent(UInt32.self, forKey: .count) ?? 0
      self.on = try c.decodeIfPresent(Bool.self, forKey: .on) ?? false
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(key, forKey: .key)
      try c.encode(label, forKey: .label)
      try c.encode(count, forKey: .count)
      try c.encode(on, forKey: .on)
    }
  }

  /// One of the two stacks docked at the Desk's foot (the owner's pick of 13 October 2026: two small tabs, the
  /// titles shown only when a stack is fanned out).
  public struct DockView: Codable, Hashable, Sendable {
    /// "star" or "run".
    public var key: String
    /// How many cards it holds: the number on its tab (`rows.len()`).
    public var count: UInt32
    /// What the tab says to a screen reader ("3 starred", "1 running").
    public var says: Text
    /// Its cards in order, fanned out: the first is the top card, the one the tab shows.
    public var rows: [DockRowView]
    /// The way on to the complete list at the end of the fan ("All running and done"); the running stack only.
    public var all: Text?

    public init(key: String = "", count: UInt32 = 0, says: Text = Text(), rows: [DockRowView] = [], all: Text? = nil) {
      self.key = key
      self.count = count
      self.says = says
      self.rows = rows
      self.all = all
    }

    enum CodingKeys: String, CodingKey {
      case key = "key"
      case count = "count"
      case says = "says"
      case rows = "rows"
      case all = "all"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.key = try c.decode(String.self, forKey: .key)
      self.count = try c.decode(UInt32.self, forKey: .count)
      self.says = try c.decode(Text.self, forKey: .says)
      self.rows = try c.decode([DockRowView].self, forKey: .rows)
      self.all = try c.decodeIfPresent(Text.self, forKey: .all)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(key, forKey: .key)
      try c.encode(count, forKey: .count)
      try c.encode(says, forKey: .says)
      try c.encode(rows, forKey: .rows)
      try c.encodeIfPresent(all, forKey: .all)
    }
  }

  /// A small card of a docked stack.
  public struct DockRowView: Codable, Hashable, Sendable {
    /// The card (`Screen::Card`).
    public var id: String
    public var title: String
    public var from: FromView
    /// The quiet line under the title: "Fernly · running" (a starred card being worked on), "Fernly", "Fernly ·
    /// Reworking the copy" (its status line), "Fernly · on it".
    public var line: Text
    /// It is being worked on (the drawing's ring turns).
    public var running: Bool
    /// When it last moved (its status line's update, else when it went to its agent); when it was starred, for a
    /// starred card.
    public var atMs: UInt64

    public init(id: String = "", title: String = "", from: FromView = FromView(), line: Text = Text(), running: Bool = false, atMs: UInt64 = 0) {
      self.id = id
      self.title = title
      self.from = from
      self.line = line
      self.running = running
      self.atMs = atMs
    }

    enum CodingKeys: String, CodingKey {
      case id = "id"
      case title = "title"
      case from = "from"
      case line = "line"
      case running = "running"
      case atMs = "at_ms"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.id = try c.decode(String.self, forKey: .id)
      self.title = try c.decode(String.self, forKey: .title)
      self.from = try c.decode(FromView.self, forKey: .from)
      self.line = try c.decode(Text.self, forKey: .line)
      self.running = try c.decode(Bool.self, forKey: .running)
      self.atMs = try c.decode(UInt64.self, forKey: .atMs)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(id, forKey: .id)
      try c.encode(title, forKey: .title)
      try c.encode(from, forKey: .from)
      try c.encode(line, forKey: .line)
      try c.encode(running, forKey: .running)
      try c.encode(atMs, forKey: .atMs)
    }
  }

  /// The section Off your mind under the Desk: a short hinted list that opens the complete list (`Screen::Off`).
  public struct OffHintView: Codable, Hashable, Sendable {
    /// The cards being worked on, the one that moved last first (at most three): on the iPhone they stand here, at
    /// the head of the section, instead of a docked stack over the Desk. A starred card is not among them (it lies
    /// in the starred stack).
    public var running: [DockRowView]
    /// "2 more running": how many run beyond those shown, leading to the complete list; none while all are shown.
    public var runningMore: Text?
    /// The first rows, put off first, then the closed ones, the newest first (at most three; the shell fades them).
    public var rows: [OffRowView]
    /// "2 put off · 14 done".
    public var says: Text
    public var putOff: UInt32
    /// Every closed card of the team in view, counted (not only the ones named).
    public var closed: UInt32
    /// All of it in one quiet line under the questions (the iPhone's calm Desk): "2 running · 1 put off · 14 done".
    public var line: Text
    /// Where a tap on the hint or its line goes: the complete list.
    public var opens: Screen

    public init(running: [DockRowView] = [], runningMore: Text? = nil, rows: [OffRowView] = [], says: Text = Text(), putOff: UInt32 = 0, closed: UInt32 = 0, line: Text = Text(), opens: Screen = .desk) {
      self.running = running
      self.runningMore = runningMore
      self.rows = rows
      self.says = says
      self.putOff = putOff
      self.closed = closed
      self.line = line
      self.opens = opens
    }

    enum CodingKeys: String, CodingKey {
      case running = "running"
      case runningMore = "running_more"
      case rows = "rows"
      case says = "says"
      case putOff = "put_off"
      case closed = "closed"
      case line = "line"
      case opens = "opens"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.running = try c.decodeIfPresent([DockRowView].self, forKey: .running) ?? []
      self.runningMore = try c.decodeIfPresent(Text.self, forKey: .runningMore)
      self.rows = try c.decode([OffRowView].self, forKey: .rows)
      self.says = try c.decode(Text.self, forKey: .says)
      self.putOff = try c.decode(UInt32.self, forKey: .putOff)
      self.closed = try c.decode(UInt32.self, forKey: .closed)
      self.line = try c.decodeIfPresent(Text.self, forKey: .line) ?? Text()
      self.opens = try c.decodeIfPresent(Screen.self, forKey: .opens) ?? .desk
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      if !running.isEmpty { try c.encode(running, forKey: .running) }
      try c.encodeIfPresent(runningMore, forKey: .runningMore)
      try c.encode(rows, forKey: .rows)
      try c.encode(says, forKey: .says)
      try c.encode(putOff, forKey: .putOff)
      try c.encode(closed, forKey: .closed)
      try c.encode(line, forKey: .line)
      try c.encode(opens, forKey: .opens)
    }
  }

  /// A put-off or closed card, one small quiet row.
  public struct OffRowView: Codable, Hashable, Sendable {
    public var id: String
    /// "later", "done" or "trash".
    public var place: String
    /// Its mark: "snooze" (put off), "shred" (shredded: the title struck through), "withdraw" (withdrawn by its
    /// agent), "tick" (done).
    public var mark: String
    public var title: String
    public var starred: Bool
    /// When it closed (ms); 0 for a put-off card and when no time is known (show none, never the epoch).
    public var atMs: UInt64
    /// A put-off card: until when ("until Tue 07:00", the person's zone).
    public var until: Text?
    /// What it is, to a screen reader: "Later", "Done", "Shredded", "Withdrawn".
    public var says: Text

    public init(id: String = "", place: String = "", mark: String = "", title: String = "", starred: Bool = false, atMs: UInt64 = 0, until: Text? = nil, says: Text = Text()) {
      self.id = id
      self.place = place
      self.mark = mark
      self.title = title
      self.starred = starred
      self.atMs = atMs
      self.until = until
      self.says = says
    }

    enum CodingKeys: String, CodingKey {
      case id = "id"
      case place = "place"
      case mark = "mark"
      case title = "title"
      case starred = "starred"
      case atMs = "at_ms"
      case until = "until"
      case says = "says"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.id = try c.decode(String.self, forKey: .id)
      self.place = try c.decode(String.self, forKey: .place)
      self.mark = try c.decode(String.self, forKey: .mark)
      self.title = try c.decode(String.self, forKey: .title)
      self.starred = try c.decodeIfPresent(Bool.self, forKey: .starred) ?? false
      self.atMs = try c.decodeIfPresent(UInt64.self, forKey: .atMs) ?? 0
      self.until = try c.decodeIfPresent(Text.self, forKey: .until)
      self.says = try c.decode(Text.self, forKey: .says)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(id, forKey: .id)
      try c.encode(place, forKey: .place)
      try c.encode(mark, forKey: .mark)
      try c.encode(title, forKey: .title)
      try c.encode(starred, forKey: .starred)
      try c.encode(atMs, forKey: .atMs)
      try c.encodeIfPresent(until, forKey: .until)
      try c.encode(says, forKey: .says)
    }
  }

  /// The page Off your mind: every card off the Desk of the team in view. What runs as live cards, the one that moved
  /// last first; then what is put off, the last put off first; then what is closed, the newest first. Each card in its
  /// place by time, none lifted. Kept to the search's words.
  public struct OffListView: Codable, Hashable, Sendable {
    /// The search's words as given (`Screen::Off`).
    public var query: String
    /// The cards with their agents.
    public var works: [OffWorkView]
    /// The put-off cards, then the closed ones.
    public var rest: [OffRowView]
    /// In the list's place when nothing is shown: "Nothing yet.", "Nothing here has these words.".
    public var none: Text?
    /// The line under `rest` when this device holds more of it than the window shows: `rest` is the first
    /// [`board::OFF_PAGE`] rows, a page more for each time the person asked (`Lens::off_window`).
    public var more: MoreView?
    /// Older closed cards are on the hub and not on this device yet (history on demand): the line under the list
    /// that fetches the next page. Always none until the engine pages the Done list.
    public var older: Text?
    /// A page of older cards is being fetched: the shell shows its quiet "Loading …" line at the end.
    public var loading: Bool
    /// The list in its groups, in this order and only those with rows: "Running" (`works`), "Put off" and "Done"
    /// (both from `rest`). Each names its rows; its count is every row of it the search keeps, not only the window.
    public var groups: [OffGroupView]

    public init(query: String = "", works: [OffWorkView] = [], rest: [OffRowView] = [], none: Text? = nil, more: MoreView? = nil, older: Text? = nil, loading: Bool = false, groups: [OffGroupView] = []) {
      self.query = query
      self.works = works
      self.rest = rest
      self.none = none
      self.more = more
      self.older = older
      self.loading = loading
      self.groups = groups
    }

    enum CodingKeys: String, CodingKey {
      case query = "query"
      case works = "works"
      case rest = "rest"
      case none = "none"
      case more = "more"
      case older = "older"
      case loading = "loading"
      case groups = "groups"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.query = try c.decodeIfPresent(String.self, forKey: .query) ?? ""
      self.works = try c.decodeIfPresent([OffWorkView].self, forKey: .works) ?? []
      self.rest = try c.decodeIfPresent([OffRowView].self, forKey: .rest) ?? []
      self.none = try c.decodeIfPresent(Text.self, forKey: .none)
      self.more = try c.decodeIfPresent(MoreView.self, forKey: .more)
      self.older = try c.decodeIfPresent(Text.self, forKey: .older)
      self.loading = try c.decodeIfPresent(Bool.self, forKey: .loading) ?? false
      self.groups = try c.decodeIfPresent([OffGroupView].self, forKey: .groups) ?? []
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(query, forKey: .query)
      if !works.isEmpty { try c.encode(works, forKey: .works) }
      if !rest.isEmpty { try c.encode(rest, forKey: .rest) }
      try c.encodeIfPresent(none, forKey: .none)
      try c.encodeIfPresent(more, forKey: .more)
      try c.encodeIfPresent(older, forKey: .older)
      try c.encode(loading, forKey: .loading)
      if !groups.isEmpty { try c.encode(groups, forKey: .groups) }
    }
  }

  /// One group of the complete list Off your mind.
  public struct OffGroupView: Codable, Hashable, Sendable {
    /// "running", "later" or "done".
    public var key: String
    /// Its heading: "Running", "Put off", "Done".
    public var says: Text
    /// How many cards are in it (the search's words kept), shown beside the heading.
    public var count: UInt32
    /// The ids of its rows as shown, in order: of `works` for "running", of `rest` for the others.
    public var ids: [String]

    public init(key: String = "", says: Text = Text(), count: UInt32 = 0, ids: [String] = []) {
      self.key = key
      self.says = says
      self.count = count
      self.ids = ids
    }

    enum CodingKeys: String, CodingKey {
      case key = "key"
      case says = "says"
      case count = "count"
      case ids = "ids"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.key = try c.decode(String.self, forKey: .key)
      self.says = try c.decode(Text.self, forKey: .says)
      self.count = try c.decode(UInt32.self, forKey: .count)
      self.ids = try c.decode([String].self, forKey: .ids)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(key, forKey: .key)
      try c.encode(says, forKey: .says)
      try c.encode(count, forKey: .count)
      try c.encode(ids, forKey: .ids)
    }
  }

  /// More of a long list than its window shows: the line that asks for the next page (an action moves the window,
  /// `Lens::show_more`; where this device does not hold it yet, the engine reads it from the hub).
  public struct MoreView: Codable, Hashable, Sendable {
    /// Rows this device holds beyond the window.
    public var left: UInt32
    /// The hub holds more beyond those (not read on this device yet).
    public var hub: Bool
    /// "Earlier messages", "Show more".
    public var says: Text
    /// How many pages the window shows after the person asks: the number the action sets.
    public var pages: UInt32

    public init(left: UInt32 = 0, hub: Bool = false, says: Text = Text(), pages: UInt32 = 0) {
      self.left = left
      self.hub = hub
      self.says = says
      self.pages = pages
    }

    enum CodingKeys: String, CodingKey {
      case left = "left"
      case hub = "hub"
      case says = "says"
      case pages = "pages"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.left = try c.decode(UInt32.self, forKey: .left)
      self.hub = try c.decodeIfPresent(Bool.self, forKey: .hub) ?? false
      self.says = try c.decode(Text.self, forKey: .says)
      self.pages = try c.decode(UInt32.self, forKey: .pages)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(left, forKey: .left)
      try c.encode(hub, forKey: .hub)
      try c.encode(says, forKey: .says)
      try c.encode(pages, forKey: .pages)
    }
  }

  /// A card with its agent, on the page Off your mind.
  public struct OffWorkView: Codable, Hashable, Sendable {
    public var id: String
    public var title: String
    public var starred: Bool
    public var from: FromView
    /// Its status line's words, else "on it".
    public var label: Text
    /// When it last moved (ms): the shell's "5 min".
    public var atMs: UInt64
    /// The whole row to a screen reader: "Fix the login, Fernly is on it".
    public var says: Text

    public init(id: String = "", title: String = "", starred: Bool = false, from: FromView = FromView(), label: Text = Text(), atMs: UInt64 = 0, says: Text = Text()) {
      self.id = id
      self.title = title
      self.starred = starred
      self.from = from
      self.label = label
      self.atMs = atMs
      self.says = says
    }

    enum CodingKeys: String, CodingKey {
      case id = "id"
      case title = "title"
      case starred = "starred"
      case from = "from"
      case label = "label"
      case atMs = "at_ms"
      case says = "says"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.id = try c.decode(String.self, forKey: .id)
      self.title = try c.decode(String.self, forKey: .title)
      self.starred = try c.decodeIfPresent(Bool.self, forKey: .starred) ?? false
      self.from = try c.decode(FromView.self, forKey: .from)
      self.label = try c.decode(Text.self, forKey: .label)
      self.atMs = try c.decode(UInt64.self, forKey: .atMs)
      self.says = try c.decode(Text.self, forKey: .says)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(id, forKey: .id)
      try c.encode(title, forKey: .title)
      try c.encode(starred, forKey: .starred)
      try c.encode(from, forKey: .from)
      try c.encode(label, forKey: .label)
      try c.encode(atMs, forKey: .atMs)
      try c.encode(says, forKey: .says)
    }
  }

  /// The chip on a team's Desk that opens its page Knowledge.
  public struct KnowledgeChipView: Codable, Hashable, Sendable {
    public var teamId: String
    /// "Knowledge".
    public var label: Text
    /// How many entries the team holds.
    public var count: UInt32
    /// The chip in a sentence ("Team knowledge: 12 entries"), for a screen reader and a tooltip.
    public var says: Text

    public init(teamId: String = "", label: Text = Text(), count: UInt32 = 0, says: Text = Text()) {
      self.teamId = teamId
      self.label = label
      self.count = count
      self.says = says
    }

    enum CodingKeys: String, CodingKey {
      case teamId = "team_id"
      case label = "label"
      case count = "count"
      case says = "says"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.teamId = try c.decode(String.self, forKey: .teamId)
      self.label = try c.decode(Text.self, forKey: .label)
      self.count = try c.decodeIfPresent(UInt32.self, forKey: .count) ?? 0
      self.says = try c.decode(Text.self, forKey: .says)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(teamId, forKey: .teamId)
      try c.encode(label, forKey: .label)
      try c.encode(count, forKey: .count)
      try c.encode(says, forKey: .says)
    }
  }

  /// The page Knowledge of a team (`Screen::Knowledge`, core/client/src/views/knowledge.rs): its entries, pinned first
  /// then the one changed last, as the search and the filter let them through.
  public struct KnowledgeView: Codable, Hashable, Sendable {
    public var teamId: String
    /// The team's name.
    public var team: Text
    /// "Knowledge".
    public var title: Text
    /// How many entries the team holds, all of them.
    public var count: UInt32
    /// The same in words ("12 entries").
    public var summary: Text
    /// The line under the title.
    public var lead: Text
    /// The search's words in force, trimmed; "" for none.
    public var query: String
    /// The filter in force: "" every entry, "pinned" the pinned ones.
    public var filter: String
    /// The filter's choices, in order: All, Pinned.
    public var filters: [KnowledgeFilterView]
    /// The search field's hint.
    public var search: Text
    /// What the search and the filter let through, in order.
    public var rows: [KnowledgeRowView]
    /// What the page says when it lists nothing; none when it lists something.
    public var none: Text?
    /// The team holds as many entries as it may: no new one (`words.full` says so).
    public var full: Bool
    /// A title's and a text's limits, in characters.
    public var titleMax: UInt32
    public var textMax: UInt32
    /// The page's other words: its buttons, the editor's hints, the question before a delete.
    public var words: KnowledgeWordsView

    public init(teamId: String = "", team: Text = Text(), title: Text = Text(), count: UInt32 = 0, summary: Text = Text(), lead: Text = Text(), query: String = "", filter: String = "", filters: [KnowledgeFilterView] = [], search: Text = Text(), rows: [KnowledgeRowView] = [], none: Text? = nil, full: Bool = false, titleMax: UInt32 = 0, textMax: UInt32 = 0, words: KnowledgeWordsView = KnowledgeWordsView()) {
      self.teamId = teamId
      self.team = team
      self.title = title
      self.count = count
      self.summary = summary
      self.lead = lead
      self.query = query
      self.filter = filter
      self.filters = filters
      self.search = search
      self.rows = rows
      self.none = none
      self.full = full
      self.titleMax = titleMax
      self.textMax = textMax
      self.words = words
    }

    enum CodingKeys: String, CodingKey {
      case teamId = "team_id"
      case team = "team"
      case title = "title"
      case count = "count"
      case summary = "summary"
      case lead = "lead"
      case query = "query"
      case filter = "filter"
      case filters = "filters"
      case search = "search"
      case rows = "rows"
      case none = "none"
      case full = "full"
      case titleMax = "title_max"
      case textMax = "text_max"
      case words = "words"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.teamId = try c.decode(String.self, forKey: .teamId)
      self.team = try c.decode(Text.self, forKey: .team)
      self.title = try c.decode(Text.self, forKey: .title)
      self.count = try c.decodeIfPresent(UInt32.self, forKey: .count) ?? 0
      self.summary = try c.decode(Text.self, forKey: .summary)
      self.lead = try c.decode(Text.self, forKey: .lead)
      self.query = try c.decodeIfPresent(String.self, forKey: .query) ?? ""
      self.filter = try c.decodeIfPresent(String.self, forKey: .filter) ?? ""
      self.filters = try c.decodeIfPresent([KnowledgeFilterView].self, forKey: .filters) ?? []
      self.search = try c.decode(Text.self, forKey: .search)
      self.rows = try c.decodeIfPresent([KnowledgeRowView].self, forKey: .rows) ?? []
      self.none = try c.decodeIfPresent(Text.self, forKey: .none)
      self.full = try c.decodeIfPresent(Bool.self, forKey: .full) ?? false
      self.titleMax = try c.decodeIfPresent(UInt32.self, forKey: .titleMax) ?? 0
      self.textMax = try c.decodeIfPresent(UInt32.self, forKey: .textMax) ?? 0
      self.words = try c.decode(KnowledgeWordsView.self, forKey: .words)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(teamId, forKey: .teamId)
      try c.encode(team, forKey: .team)
      try c.encode(title, forKey: .title)
      try c.encode(count, forKey: .count)
      try c.encode(summary, forKey: .summary)
      try c.encode(lead, forKey: .lead)
      try c.encode(query, forKey: .query)
      try c.encode(filter, forKey: .filter)
      try c.encode(filters, forKey: .filters)
      try c.encode(search, forKey: .search)
      try c.encode(rows, forKey: .rows)
      try c.encodeIfPresent(none, forKey: .none)
      try c.encode(full, forKey: .full)
      try c.encode(titleMax, forKey: .titleMax)
      try c.encode(textMax, forKey: .textMax)
      try c.encode(words, forKey: .words)
    }
  }

  /// One choice of the page's filter.
  public struct KnowledgeFilterView: Codable, Hashable, Sendable {
    /// "" or "pinned": what `Screen::Knowledge.filter` takes.
    public var key: String
    public var label: Text
    public var count: UInt32
    public var on: Bool

    public init(key: String = "", label: Text = Text(), count: UInt32 = 0, on: Bool = false) {
      self.key = key
      self.label = label
      self.count = count
      self.on = on
    }

    enum CodingKeys: String, CodingKey {
      case key = "key"
      case label = "label"
      case count = "count"
      case on = "on"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.key = try c.decodeIfPresent(String.self, forKey: .key) ?? ""
      self.label = try c.decode(Text.self, forKey: .label)
      self.count = try c.decodeIfPresent(UInt32.self, forKey: .count) ?? 0
      self.on = try c.decodeIfPresent(Bool.self, forKey: .on) ?? false
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(key, forKey: .key)
      try c.encode(label, forKey: .label)
      try c.encode(count, forKey: .count)
      try c.encode(on, forKey: .on)
    }
  }

  /// One entry on the page.
  public struct KnowledgeRowView: Codable, Hashable, Sendable {
    /// Its id: what `Action::KnowledgeSave`, `KnowledgePin` and `KnowledgeDelete` take.
    public var id: String
    public var title: String
    public var text: String
    public var pinned: Bool
    /// Who brought it and when ("proposed by Claude: Web · Yesterday", "added by you · Today").
    public var by: Text
    /// When it last changed.
    public var atMs: UInt64

    public init(id: String = "", title: String = "", text: String = "", pinned: Bool = false, by: Text = Text(), atMs: UInt64 = 0) {
      self.id = id
      self.title = title
      self.text = text
      self.pinned = pinned
      self.by = by
      self.atMs = atMs
    }

    enum CodingKeys: String, CodingKey {
      case id = "id"
      case title = "title"
      case text = "text"
      case pinned = "pinned"
      case by = "by"
      case atMs = "at_ms"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.id = try c.decode(String.self, forKey: .id)
      self.title = try c.decode(String.self, forKey: .title)
      self.text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
      self.pinned = try c.decodeIfPresent(Bool.self, forKey: .pinned) ?? false
      self.by = try c.decode(Text.self, forKey: .by)
      self.atMs = try c.decodeIfPresent(UInt64.self, forKey: .atMs) ?? 0
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(id, forKey: .id)
      try c.encode(title, forKey: .title)
      try c.encode(text, forKey: .text)
      try c.encode(pinned, forKey: .pinned)
      try c.encode(by, forKey: .by)
      try c.encode(atMs, forKey: .atMs)
    }
  }

  /// The words of the page Knowledge beside its entries.
  public struct KnowledgeWordsView: Codable, Hashable, Sendable {
    public var add: Text
    public var edit: Text
    public var delete: Text
    public var pin: Text
    public var unpin: Text
    public var save: Text
    public var cancel: Text
    public var titleHint: Text
    public var textHint: Text
    public var deleteAsk: Text
    public var full: Text

    public init(add: Text = Text(), edit: Text = Text(), delete: Text = Text(), pin: Text = Text(), unpin: Text = Text(), save: Text = Text(), cancel: Text = Text(), titleHint: Text = Text(), textHint: Text = Text(), deleteAsk: Text = Text(), full: Text = Text()) {
      self.add = add
      self.edit = edit
      self.delete = delete
      self.pin = pin
      self.unpin = unpin
      self.save = save
      self.cancel = cancel
      self.titleHint = titleHint
      self.textHint = textHint
      self.deleteAsk = deleteAsk
      self.full = full
    }

    enum CodingKeys: String, CodingKey {
      case add = "add"
      case edit = "edit"
      case delete = "delete"
      case pin = "pin"
      case unpin = "unpin"
      case save = "save"
      case cancel = "cancel"
      case titleHint = "title_hint"
      case textHint = "text_hint"
      case deleteAsk = "delete_ask"
      case full = "full"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.add = try c.decode(Text.self, forKey: .add)
      self.edit = try c.decode(Text.self, forKey: .edit)
      self.delete = try c.decode(Text.self, forKey: .delete)
      self.pin = try c.decode(Text.self, forKey: .pin)
      self.unpin = try c.decode(Text.self, forKey: .unpin)
      self.save = try c.decode(Text.self, forKey: .save)
      self.cancel = try c.decode(Text.self, forKey: .cancel)
      self.titleHint = try c.decode(Text.self, forKey: .titleHint)
      self.textHint = try c.decode(Text.self, forKey: .textHint)
      self.deleteAsk = try c.decode(Text.self, forKey: .deleteAsk)
      self.full = try c.decode(Text.self, forKey: .full)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(add, forKey: .add)
      try c.encode(edit, forKey: .edit)
      try c.encode(delete, forKey: .delete)
      try c.encode(pin, forKey: .pin)
      try c.encode(unpin, forKey: .unpin)
      try c.encode(save, forKey: .save)
      try c.encode(cancel, forKey: .cancel)
      try c.encode(titleHint, forKey: .titleHint)
      try c.encode(textHint, forKey: .textHint)
      try c.encode(deleteAsk, forKey: .deleteAsk)
      try c.encode(full, forKey: .full)
    }
  }

  /// A team's goals: a note of the person's, at most twenty lines.
  public struct GoalsView: Codable, Hashable, Sendable {
    public var teamId: String
    /// The lines; empty when there are none (the shell shows its faint "Goals…").
    public var lines: [String]
    /// Two lines or more: one toggle folds them to the first line. Whether they are folded is this device's.
    public var foldable: Bool
    /// What the toggle says while they are folded ("Show all 4 goals").
    public var showAll: Text?
    /// Folded to the first line on this device (`Lens::goals_folded`; the owner's pick of 13 October 2026: one
    /// toggle, folded shows the first line). Only while `foldable`.
    public var folded: Bool
    /// What the toggle says: "Show all 4 goals" while folded, "Show the first goal only" while open; none while not
    /// foldable.
    public var toggle: Text?

    public init(teamId: String = "", lines: [String] = [], foldable: Bool = false, showAll: Text? = nil, folded: Bool = false, toggle: Text? = nil) {
      self.teamId = teamId
      self.lines = lines
      self.foldable = foldable
      self.showAll = showAll
      self.folded = folded
      self.toggle = toggle
    }

    enum CodingKeys: String, CodingKey {
      case teamId = "team_id"
      case lines = "lines"
      case foldable = "foldable"
      case showAll = "show_all"
      case folded = "folded"
      case toggle = "toggle"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.teamId = try c.decode(String.self, forKey: .teamId)
      self.lines = try c.decode([String].self, forKey: .lines)
      self.foldable = try c.decode(Bool.self, forKey: .foldable)
      self.showAll = try c.decodeIfPresent(Text.self, forKey: .showAll)
      self.folded = try c.decodeIfPresent(Bool.self, forKey: .folded) ?? false
      self.toggle = try c.decodeIfPresent(Text.self, forKey: .toggle)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(teamId, forKey: .teamId)
      try c.encode(lines, forKey: .lines)
      try c.encode(foldable, forKey: .foldable)
      try c.encodeIfPresent(showAll, forKey: .showAll)
      try c.encode(folded, forKey: .folded)
      try c.encodeIfPresent(toggle, forKey: .toggle)
    }
  }

  /// A session that is cut off, as the Desk says it.
  public struct SlipView: Codable, Hashable, Sendable {
    public var sessionId: String
    public var text: Text
    public var fix: FixView

    public init(sessionId: String = "", text: Text = Text(), fix: FixView = FixView()) {
      self.sessionId = sessionId
      self.text = text
      self.fix = fix
    }

    enum CodingKeys: String, CodingKey {
      case sessionId = "session_id"
      case text = "text"
      case fix = "fix"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.sessionId = try c.decode(String.self, forKey: .sessionId)
      self.text = try c.decode(Text.self, forKey: .text)
      self.fix = try c.decode(FixView.self, forKey: .fix)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(sessionId, forKey: .sessionId)
      try c.encode(text, forKey: .text)
      try c.encode(fix, forKey: .fix)
    }
  }

  /// One row of the Desk: a question, a request for approval, or something to read.
  public struct DeskRowView: Codable, Hashable, Sendable {
    public var id: String
    /// "decision", "info" (to read: also a card not read here yet, and one of a newer Trommi), "request".
    public var kind: String
    /// Its body is not read on this device yet: a quiet placeholder.
    public var loading: Bool
    /// A card of a newer Trommi: its title where readable, nothing to answer.
    public var newer: Bool
    public var title: String
    /// One or two lines under the title: its teaser, else its body as plain words.
    public var words: String
    /// Small words before them: "replaces 2 questions", "revised", "Back from Later", why it is urgent.
    public var notes: [Text]
    /// "low", "normal", "high", "critical".
    public var urgency: String
    /// The sign before the title: "block" (blocking, or an approval), "knock" (urgent), "whenever" (low), "".
    public var sign: String
    /// What the sign says ("Knock! Blocking").
    public var signSays: Text?
    public var starred: Bool
    /// When it was asked.
    public var createdMs: UInt64
    /// Who asked; none for a session the list does not show.
    public var from: FromView?
    /// On the first row of a run (rows of one session that follow each other): how many rows it has. Else 0.
    public var run: UInt32
    /// Its pictures and videos, for the small fan beside the title: the first three.
    public var media: [MediaView]
    /// What the fan says ("Look at 4 pictures and videos").
    public var mediaSays: Text?
    /// The answers the row itself offers.
    public var tiles: TilesView
    /// The ways to put it aside that apply, in order: "later", "reverse", "duck", "shred".
    public var ways: [String]

    public init(id: String = "", kind: String = "", loading: Bool = false, newer: Bool = false, title: String = "", words: String = "", notes: [Text] = [], urgency: String = "", sign: String = "", signSays: Text? = nil, starred: Bool = false, createdMs: UInt64 = 0, from: FromView? = nil, run: UInt32 = 0, media: [MediaView] = [], mediaSays: Text? = nil, tiles: TilesView = TilesView(), ways: [String] = []) {
      self.id = id
      self.kind = kind
      self.loading = loading
      self.newer = newer
      self.title = title
      self.words = words
      self.notes = notes
      self.urgency = urgency
      self.sign = sign
      self.signSays = signSays
      self.starred = starred
      self.createdMs = createdMs
      self.from = from
      self.run = run
      self.media = media
      self.mediaSays = mediaSays
      self.tiles = tiles
      self.ways = ways
    }

    enum CodingKeys: String, CodingKey {
      case id = "id"
      case kind = "kind"
      case loading = "loading"
      case newer = "newer"
      case title = "title"
      case words = "words"
      case notes = "notes"
      case urgency = "urgency"
      case sign = "sign"
      case signSays = "sign_says"
      case starred = "starred"
      case createdMs = "created_ms"
      case from = "from"
      case run = "run"
      case media = "media"
      case mediaSays = "media_says"
      case tiles = "tiles"
      case ways = "ways"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.id = try c.decode(String.self, forKey: .id)
      self.kind = try c.decode(String.self, forKey: .kind)
      self.loading = try c.decodeIfPresent(Bool.self, forKey: .loading) ?? false
      self.newer = try c.decodeIfPresent(Bool.self, forKey: .newer) ?? false
      self.title = try c.decode(String.self, forKey: .title)
      self.words = try c.decodeIfPresent(String.self, forKey: .words) ?? ""
      self.notes = try c.decodeIfPresent([Text].self, forKey: .notes) ?? []
      self.urgency = try c.decode(String.self, forKey: .urgency)
      self.sign = try c.decodeIfPresent(String.self, forKey: .sign) ?? ""
      self.signSays = try c.decodeIfPresent(Text.self, forKey: .signSays)
      self.starred = try c.decodeIfPresent(Bool.self, forKey: .starred) ?? false
      self.createdMs = try c.decode(UInt64.self, forKey: .createdMs)
      self.from = try c.decodeIfPresent(FromView.self, forKey: .from)
      self.run = try c.decodeIfPresent(UInt32.self, forKey: .run) ?? 0
      self.media = try c.decodeIfPresent([MediaView].self, forKey: .media) ?? []
      self.mediaSays = try c.decodeIfPresent(Text.self, forKey: .mediaSays)
      self.tiles = try c.decode(TilesView.self, forKey: .tiles)
      self.ways = try c.decode([String].self, forKey: .ways)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(id, forKey: .id)
      try c.encode(kind, forKey: .kind)
      try c.encode(loading, forKey: .loading)
      try c.encode(newer, forKey: .newer)
      try c.encode(title, forKey: .title)
      try c.encode(words, forKey: .words)
      if !notes.isEmpty { try c.encode(notes, forKey: .notes) }
      try c.encode(urgency, forKey: .urgency)
      try c.encode(sign, forKey: .sign)
      try c.encodeIfPresent(signSays, forKey: .signSays)
      try c.encode(starred, forKey: .starred)
      try c.encode(createdMs, forKey: .createdMs)
      try c.encodeIfPresent(from, forKey: .from)
      try c.encode(run, forKey: .run)
      if !media.isEmpty { try c.encode(media, forKey: .media) }
      try c.encodeIfPresent(mediaSays, forKey: .mediaSays)
      try c.encode(tiles, forKey: .tiles)
      try c.encode(ways, forKey: .ways)
    }
  }

  /// Who a card comes from.
  public struct FromView: Codable, Hashable, Sendable {
    public var sessionId: String
    public var name: String
    /// What draws the session (`SessionRowView::mark`).
    public var mark: String
    /// Where it stands, for the line above a card's title ("Team › Session"): its team while there are two or
    /// more, itself.
    public var path: [String]
    /// The helper (its agent's subagent) it comes from, for a chip beside the path: "Helper Icons".
    public var helper: Text?

    public init(sessionId: String = "", name: String = "", mark: String = "", path: [String] = [], helper: Text? = nil) {
      self.sessionId = sessionId
      self.name = name
      self.mark = mark
      self.path = path
      self.helper = helper
    }

    enum CodingKeys: String, CodingKey {
      case sessionId = "session_id"
      case name = "name"
      case mark = "mark"
      case path = "path"
      case helper = "helper"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.sessionId = try c.decode(String.self, forKey: .sessionId)
      self.name = try c.decode(String.self, forKey: .name)
      self.mark = try c.decode(String.self, forKey: .mark)
      self.path = try c.decode([String].self, forKey: .path)
      self.helper = try c.decodeIfPresent(Text.self, forKey: .helper)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(sessionId, forKey: .sessionId)
      try c.encode(name, forKey: .name)
      try c.encode(mark, forKey: .mark)
      try c.encode(path, forKey: .path)
      try c.encodeIfPresent(helper, forKey: .helper)
    }
  }

  public struct MediaView: Codable, Hashable, Sendable {
    /// The file (`ViewModel.files`, `Action::OpenFile`).
    public var fileId: String
    /// "image" or "video".
    public var kind: String

    public init(fileId: String = "", kind: String = "") {
      self.fileId = fileId
      self.kind = kind
    }

    enum CodingKeys: String, CodingKey {
      case fileId = "file_id"
      case kind = "kind"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.fileId = try c.decode(String.self, forKey: .fileId)
      self.kind = try c.decode(String.self, forKey: .kind)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(fileId, forKey: .fileId)
      try c.encode(kind, forKey: .kind)
    }
  }

  /// The answers a row offers without opening the card.
  public struct TilesView: Codable, Hashable, Sendable {
    /// "none" (not read on this device yet: nothing to answer), "read" (What?? and Got it), "pair" (two answers, the lead last), "advised" (the advised answer, and
    /// "+N other ways" that opens the card), "choose" (one tile that opens the card).
    public var kind: String
    /// The answers of "pair" and "advised", in drawing order.
    public var tiles: [TileView]
    /// "advised": how many other ways there are.
    public var others: UInt32
    /// "advised": "3 other ways: open the card"; "choose": "Choose: 4 options, several".
    public var says: Text?

    public init(kind: String = "", tiles: [TileView] = [], others: UInt32 = 0, says: Text? = nil) {
      self.kind = kind
      self.tiles = tiles
      self.others = others
      self.says = says
    }

    enum CodingKeys: String, CodingKey {
      case kind = "kind"
      case tiles = "tiles"
      case others = "others"
      case says = "says"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.kind = try c.decode(String.self, forKey: .kind)
      self.tiles = try c.decodeIfPresent([TileView].self, forKey: .tiles) ?? []
      self.others = try c.decodeIfPresent(UInt32.self, forKey: .others) ?? 0
      self.says = try c.decodeIfPresent(Text.self, forKey: .says)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(kind, forKey: .kind)
      if !tiles.isEmpty { try c.encode(tiles, forKey: .tiles) }
      try c.encode(others, forKey: .others)
      try c.encodeIfPresent(says, forKey: .says)
    }
  }

  public struct TileView: Codable, Hashable, Sendable {
    /// The option's key (`Action::Answer`; "allow" and "deny" of a request: `Action::Verdict`).
    public var key: String
    /// The words on the tile; empty for a tile that shows its drawing alone.
    public var label: String
    /// Its drawing: "yes" (the lead: thumb up, or the filled tile) or "no".
    public var thumb: String
    /// A real yes or no (thumbs); else two named tiles.
    public var thumbs: Bool
    public var lead: Bool
    /// Its agent advises it.
    public var advised: Bool
    /// Its words need the small type.
    public var small: Bool
    /// `label` is the option's short name (its full one fits no tile).
    public var short: Bool
    /// Choosing it settles the card (its agent marked it final).
    public var settles: Bool
    /// The tooltip ("Recommended", "Settles it", or the option's full name); none without one.
    public var tip: Text?
    /// What it says to a screen reader ("Ship it (settles it)").
    public var says: Text

    public init(key: String = "", label: String = "", thumb: String = "", thumbs: Bool = false, lead: Bool = false, advised: Bool = false, small: Bool = false, short: Bool = false, settles: Bool = false, tip: Text? = nil, says: Text = Text()) {
      self.key = key
      self.label = label
      self.thumb = thumb
      self.thumbs = thumbs
      self.lead = lead
      self.advised = advised
      self.small = small
      self.short = short
      self.settles = settles
      self.tip = tip
      self.says = says
    }

    enum CodingKeys: String, CodingKey {
      case key = "key"
      case label = "label"
      case thumb = "thumb"
      case thumbs = "thumbs"
      case lead = "lead"
      case advised = "advised"
      case small = "small"
      case short = "short"
      case settles = "settles"
      case tip = "tip"
      case says = "says"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.key = try c.decode(String.self, forKey: .key)
      self.label = try c.decode(String.self, forKey: .label)
      self.thumb = try c.decode(String.self, forKey: .thumb)
      self.thumbs = try c.decode(Bool.self, forKey: .thumbs)
      self.lead = try c.decode(Bool.self, forKey: .lead)
      self.advised = try c.decode(Bool.self, forKey: .advised)
      self.small = try c.decode(Bool.self, forKey: .small)
      self.short = try c.decode(Bool.self, forKey: .short)
      self.settles = try c.decode(Bool.self, forKey: .settles)
      self.tip = try c.decodeIfPresent(Text.self, forKey: .tip)
      self.says = try c.decode(Text.self, forKey: .says)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(key, forKey: .key)
      try c.encode(label, forKey: .label)
      try c.encode(thumb, forKey: .thumb)
      try c.encode(thumbs, forKey: .thumbs)
      try c.encode(lead, forKey: .lead)
      try c.encode(advised, forKey: .advised)
      try c.encode(small, forKey: .small)
      try c.encode(short, forKey: .short)
      try c.encode(settles, forKey: .settles)
      try c.encodeIfPresent(tip, forKey: .tip)
      try c.encode(says, forKey: .says)
    }
  }

  /// One session's page: its heading, its conversation, the status lines of its running work, and what stands above
  /// the field to write in. Made for the session in view (`Lens::session`).
  public struct SessionView: Codable, Hashable, Sendable {
    public var id: String
    public var name: Text
    /// "live", "oncall", "asleep", "cut", "gone"; "" for an archived or removed session.
    public var link: String
    public var blocked: Bool
    /// Talk rows, newest last.
    public var talk: [TalkRow]
    /// The lines that show, the one its agent set last first: the chat's foot draws the first in one line beside the
    /// working dots, and `status_more` for the rest, which a tap opens.
    public var statusLines: [StatusLineView]
    /// "+N": how many lines stand behind the first; none with one line or none.
    public var statusMore: Text?
    /// Every card of the session, the newest first (its page "Questions").
    public var questions: [CardRefView]
    /// Every file of the session's cards, answers, Chats and Artifacts (ids of `ViewModel.files`), the newest
    /// first (its page "Files").
    public var files: [String]
    /// The hub holds older messages than this device has (history on demand: asking for more reads them).
    public var hasMore: Bool
    /// The line above the first row when more stands before it ("Earlier messages"): what this device holds before
    /// the window, and whether the hub holds older still. `talk` is a window of the newest [`board::TALK_PAGE`] rows,
    /// a page more for each time the person asked (`Lens::talk_window`); none when it shows everything there is.
    public var earlier: MoreView?
    /// Its short id on the board (`/chat/<slug>`).
    public var slug: String
    /// What draws it (`SessionRowView::mark`).
    public var mark: String
    public var teamId: String
    public var main: Bool
    public var crowned: Bool
    public var online: Bool
    /// Where it stands: its team (while there are two or more), itself.
    public var path: [String]
    /// The model it runs on, as the heading says it ("Opus 5.5"); "" when it named none.
    public var modelLabel: String
    /// The model's id, for the tooltip.
    public var model: String
    /// The dot beside the name.
    public var dot: DotView
    /// Why it is stopped (the red hand).
    public var hand: HandView?
    /// The quiet hint ("quiet for 24 min"): connected, working, and nothing from it for a while. None while stopped.
    public var quiet: Text?
    /// Above the field: why it does not hear and the step in its terminal, or that his last message waits.
    public var note: LinkNoteView?
    /// What the field says while it is empty.
    public var compose: Text
    /// "<name> is working": his word was the last, a short while ago.
    public var answering: Text?
    /// Its questions that wait for the person (decisions and approvals, never a card to read), as their Desk rows,
    /// in the order they came: what its page "Questions" lists as open.
    public var waiting: [DeskRowView]
    /// How many of them (`waiting`), and the way to the first of them.
    public var open: UInt32
    /// "3 open".
    public var openWord: Text?
    /// "3 open questions: go to the first one".
    public var openSays: Text?
    /// The talk row of the first of them, where it was asked.
    public var firstOpen: String?
    /// An empty conversation: the card of the agent that joined, and three ways to start.
    public var empty: EmptyTalkView?
    /// Its agent's account and how much of it is used (the heading's rings: the week and the 5-hour window). None
    /// without a plan or an e-mail.
    public var usage: UsageView?
    /// Its helpers (its agent's subagents), above the status lines; none without.
    public var helpers: HelperListView?
    /// In the Archive: the More menu offers "Back from the Archive" (`ArchiveSession` with `on: false`).
    public var archived: Bool
    /// The tabs of its side panel (a click on its name opens it), in order: "details" always, then "questions",
    /// "helpers" and "files" where it has some.
    public var tabs: [PanelTabView]

    public init(id: String = "", name: Text = Text(), link: String = "", blocked: Bool = false, talk: [TalkRow] = [], statusLines: [StatusLineView] = [], statusMore: Text? = nil, questions: [CardRefView] = [], files: [String] = [], hasMore: Bool = false, earlier: MoreView? = nil, slug: String = "", mark: String = "", teamId: String = "", main: Bool = false, crowned: Bool = false, online: Bool = false, path: [String] = [], modelLabel: String = "", model: String = "", dot: DotView = DotView(), hand: HandView? = nil, quiet: Text? = nil, note: LinkNoteView? = nil, compose: Text = Text(), answering: Text? = nil, waiting: [DeskRowView] = [], open: UInt32 = 0, openWord: Text? = nil, openSays: Text? = nil, firstOpen: String? = nil, empty: EmptyTalkView? = nil, usage: UsageView? = nil, helpers: HelperListView? = nil, archived: Bool = false, tabs: [PanelTabView] = []) {
      self.id = id
      self.name = name
      self.link = link
      self.blocked = blocked
      self.talk = talk
      self.statusLines = statusLines
      self.statusMore = statusMore
      self.questions = questions
      self.files = files
      self.hasMore = hasMore
      self.earlier = earlier
      self.slug = slug
      self.mark = mark
      self.teamId = teamId
      self.main = main
      self.crowned = crowned
      self.online = online
      self.path = path
      self.modelLabel = modelLabel
      self.model = model
      self.dot = dot
      self.hand = hand
      self.quiet = quiet
      self.note = note
      self.compose = compose
      self.answering = answering
      self.waiting = waiting
      self.open = open
      self.openWord = openWord
      self.openSays = openSays
      self.firstOpen = firstOpen
      self.empty = empty
      self.usage = usage
      self.helpers = helpers
      self.archived = archived
      self.tabs = tabs
    }

    enum CodingKeys: String, CodingKey {
      case id = "id"
      case name = "name"
      case link = "link"
      case blocked = "blocked"
      case talk = "talk"
      case statusLines = "status_lines"
      case statusMore = "status_more"
      case questions = "questions"
      case files = "files"
      case hasMore = "has_more"
      case earlier = "earlier"
      case slug = "slug"
      case mark = "mark"
      case teamId = "team_id"
      case main = "main"
      case crowned = "crowned"
      case online = "online"
      case path = "path"
      case modelLabel = "model_label"
      case model = "model"
      case dot = "dot"
      case hand = "hand"
      case quiet = "quiet"
      case note = "note"
      case compose = "compose"
      case answering = "answering"
      case waiting = "waiting"
      case open = "open"
      case openWord = "open_word"
      case openSays = "open_says"
      case firstOpen = "first_open"
      case empty = "empty"
      case usage = "usage"
      case helpers = "helpers"
      case archived = "archived"
      case tabs = "tabs"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.id = try c.decode(String.self, forKey: .id)
      self.name = try c.decode(Text.self, forKey: .name)
      self.link = try c.decode(String.self, forKey: .link)
      self.blocked = try c.decode(Bool.self, forKey: .blocked)
      self.talk = try c.decode([TalkRow].self, forKey: .talk)
      self.statusLines = try c.decode([StatusLineView].self, forKey: .statusLines)
      self.statusMore = try c.decodeIfPresent(Text.self, forKey: .statusMore)
      self.questions = try c.decodeIfPresent([CardRefView].self, forKey: .questions) ?? []
      self.files = try c.decodeIfPresent([String].self, forKey: .files) ?? []
      self.hasMore = try c.decode(Bool.self, forKey: .hasMore)
      self.earlier = try c.decodeIfPresent(MoreView.self, forKey: .earlier)
      self.slug = try c.decodeIfPresent(String.self, forKey: .slug) ?? ""
      self.mark = try c.decodeIfPresent(String.self, forKey: .mark) ?? ""
      self.teamId = try c.decodeIfPresent(String.self, forKey: .teamId) ?? ""
      self.main = try c.decodeIfPresent(Bool.self, forKey: .main) ?? false
      self.crowned = try c.decodeIfPresent(Bool.self, forKey: .crowned) ?? false
      self.online = try c.decodeIfPresent(Bool.self, forKey: .online) ?? false
      self.path = try c.decodeIfPresent([String].self, forKey: .path) ?? []
      self.modelLabel = try c.decodeIfPresent(String.self, forKey: .modelLabel) ?? ""
      self.model = try c.decodeIfPresent(String.self, forKey: .model) ?? ""
      self.dot = try c.decodeIfPresent(DotView.self, forKey: .dot) ?? DotView()
      self.hand = try c.decodeIfPresent(HandView.self, forKey: .hand)
      self.quiet = try c.decodeIfPresent(Text.self, forKey: .quiet)
      self.note = try c.decodeIfPresent(LinkNoteView.self, forKey: .note)
      self.compose = try c.decodeIfPresent(Text.self, forKey: .compose) ?? Text()
      self.answering = try c.decodeIfPresent(Text.self, forKey: .answering)
      self.waiting = try c.decodeIfPresent([DeskRowView].self, forKey: .waiting) ?? []
      self.open = try c.decodeIfPresent(UInt32.self, forKey: .open) ?? 0
      self.openWord = try c.decodeIfPresent(Text.self, forKey: .openWord)
      self.openSays = try c.decodeIfPresent(Text.self, forKey: .openSays)
      self.firstOpen = try c.decodeIfPresent(String.self, forKey: .firstOpen)
      self.empty = try c.decodeIfPresent(EmptyTalkView.self, forKey: .empty)
      self.usage = try c.decodeIfPresent(UsageView.self, forKey: .usage)
      self.helpers = try c.decodeIfPresent(HelperListView.self, forKey: .helpers)
      self.archived = try c.decodeIfPresent(Bool.self, forKey: .archived) ?? false
      self.tabs = try c.decodeIfPresent([PanelTabView].self, forKey: .tabs) ?? []
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(id, forKey: .id)
      try c.encode(name, forKey: .name)
      try c.encode(link, forKey: .link)
      try c.encode(blocked, forKey: .blocked)
      try c.encode(talk, forKey: .talk)
      try c.encode(statusLines, forKey: .statusLines)
      try c.encodeIfPresent(statusMore, forKey: .statusMore)
      if !questions.isEmpty { try c.encode(questions, forKey: .questions) }
      if !files.isEmpty { try c.encode(files, forKey: .files) }
      try c.encode(hasMore, forKey: .hasMore)
      try c.encodeIfPresent(earlier, forKey: .earlier)
      try c.encode(slug, forKey: .slug)
      try c.encode(mark, forKey: .mark)
      try c.encode(teamId, forKey: .teamId)
      try c.encode(main, forKey: .main)
      try c.encode(crowned, forKey: .crowned)
      try c.encode(online, forKey: .online)
      if !path.isEmpty { try c.encode(path, forKey: .path) }
      try c.encode(modelLabel, forKey: .modelLabel)
      try c.encode(model, forKey: .model)
      try c.encode(dot, forKey: .dot)
      try c.encodeIfPresent(hand, forKey: .hand)
      try c.encodeIfPresent(quiet, forKey: .quiet)
      try c.encodeIfPresent(note, forKey: .note)
      try c.encode(compose, forKey: .compose)
      try c.encodeIfPresent(answering, forKey: .answering)
      if !waiting.isEmpty { try c.encode(waiting, forKey: .waiting) }
      try c.encode(open, forKey: .open)
      try c.encodeIfPresent(openWord, forKey: .openWord)
      try c.encodeIfPresent(openSays, forKey: .openSays)
      try c.encodeIfPresent(firstOpen, forKey: .firstOpen)
      try c.encodeIfPresent(empty, forKey: .empty)
      try c.encodeIfPresent(usage, forKey: .usage)
      try c.encodeIfPresent(helpers, forKey: .helpers)
      try c.encode(archived, forKey: .archived)
      if !tabs.isEmpty { try c.encode(tabs, forKey: .tabs) }
    }
  }

  /// A tab of a session's side panel.
  public struct PanelTabView: Codable, Hashable, Sendable {
    /// "details", "questions", "helpers", "files".
    public var key: String
    public var label: Text
    /// What it counts beside its label (the questions that wait, the helpers, the files); 0: no number.
    public var count: UInt32

    public init(key: String = "", label: Text = Text(), count: UInt32 = 0) {
      self.key = key
      self.label = label
      self.count = count
    }

    enum CodingKeys: String, CodingKey {
      case key = "key"
      case label = "label"
      case count = "count"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.key = try c.decode(String.self, forKey: .key)
      self.label = try c.decode(Text.self, forKey: .label)
      self.count = try c.decodeIfPresent(UInt32.self, forKey: .count) ?? 0
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(key, forKey: .key)
      try c.encode(label, forKey: .label)
      try c.encode(count, forKey: .count)
    }
  }

  /// The dot beside a session's name.
  public struct DotView: Codable, Hashable, Sendable {
    /// Connected (green).
    public var on: Bool
    /// How it hears when it does not hear at once: "oncall", "asleep", "cut", "gone"; else "".
    public var link: String
    /// The tooltip: "connected", "disconnected", or the link's words.
    public var word: Text
    /// For a screen reader: the word, and what it is at.
    public var says: Text

    public init(on: Bool = false, link: String = "", word: Text = Text(), says: Text = Text()) {
      self.on = on
      self.link = link
      self.word = word
      self.says = says
    }

    enum CodingKeys: String, CodingKey {
      case on = "on"
      case link = "link"
      case word = "word"
      case says = "says"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.on = try c.decode(Bool.self, forKey: .on)
      self.link = try c.decode(String.self, forKey: .link)
      self.word = try c.decode(Text.self, forKey: .word)
      self.says = try c.decode(Text.self, forKey: .says)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(on, forKey: .on)
      try c.encode(link, forKey: .link)
      try c.encode(word, forKey: .word)
      try c.encode(says, forKey: .says)
    }
  }

  /// The note above a field: a receipt, the sentence about the session, the way out.
  public struct LinkNoteView: Codable, Hashable, Sendable {
    /// "cut", "gone", "asleep", "oncall" (the link's state), or "unheard", "sent", "heard" (a receipt alone).
    public var tone: String
    public var receipt: Text?
    public var line: Text?
    public var fix: FixView?

    public init(tone: String = "", receipt: Text? = nil, line: Text? = nil, fix: FixView? = nil) {
      self.tone = tone
      self.receipt = receipt
      self.line = line
      self.fix = fix
    }

    enum CodingKeys: String, CodingKey {
      case tone = "tone"
      case receipt = "receipt"
      case line = "line"
      case fix = "fix"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.tone = try c.decode(String.self, forKey: .tone)
      self.receipt = try c.decodeIfPresent(Text.self, forKey: .receipt)
      self.line = try c.decodeIfPresent(Text.self, forKey: .line)
      self.fix = try c.decodeIfPresent(FixView.self, forKey: .fix)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(tone, forKey: .tone)
      try c.encodeIfPresent(receipt, forKey: .receipt)
      try c.encodeIfPresent(line, forKey: .line)
      try c.encodeIfPresent(fix, forKey: .fix)
    }
  }

  public struct EmptyTalkView: Codable, Hashable, Sendable {
    /// Where it runs, quietly under its name ("Opus 5.5"); "" when it said nothing.
    public var meta: String
    public var text: Text
    /// A tap sends one.
    public var starters: [Text]

    public init(meta: String = "", text: Text = Text(), starters: [Text] = []) {
      self.meta = meta
      self.text = text
      self.starters = starters
    }

    enum CodingKeys: String, CodingKey {
      case meta = "meta"
      case text = "text"
      case starters = "starters"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.meta = try c.decode(String.self, forKey: .meta)
      self.text = try c.decode(Text.self, forKey: .text)
      self.starters = try c.decode([Text].self, forKey: .starters)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(meta, forKey: .meta)
      try c.encode(text, forKey: .text)
      try c.encode(starters, forKey: .starters)
    }
  }

  /// One row of a conversation. `kind` says what it is; the fields it needs are filled.
  public struct TalkRow: Codable, Hashable, Sendable {
    public var id: String
    public var fromMe: Bool
    public var text: String
    public var timeMs: UInt64
    /// His message: its session picked it up (false also when its connector writes no receipts).
    public var heard: Bool
    /// Not confirmed by the hub yet (an echo).
    public var pending: Bool
    /// File ids (`ViewModel.files`).
    public var files: [String]
    /// "user" (his bubble), "agent" (the agent's words, light markdown), "note" (his note, taped on), "event" (one
    /// quiet line: `event`), "ask" (an open question where it was asked: `row`), "work" (a turn's trail: `work`),
    /// "artifact" (something the session published: `published`), "newer" (written by a newer Trommi).
    public var kind: String
    /// Its place in the hub's order (an envelope number); 0 for what has none yet.
    public var number: UInt64
    /// The line above it when a new day begins there ("Today", "Yesterday", "Tuesday 13 October").
    public var day: Text?
    /// It goes on a run of the same side: no head, close to the row before.
    public var cont: Bool
    /// Typed into the session's terminal (his words, sent for him by the agent's connector), or the agent's answer there.
    public var terminal: Bool
    /// The card it is about.
    public var card: CardRefView?
    public var event: EventView?
    /// What he did with a card along with these words (handed back, took back, What??): a quiet line above them.
    public var deed: EventView?
    public var row: DeskRowView?
    public var work: WorkView?
    /// The Artifact it announces (its object id).
    public var published: String?
    /// The agent's details, folded under its words.
    public var details: String
    /// The agent's layout under its words (drawn in the sandboxed frame).
    public var html: String
    /// The cards it carries, a chip each.
    public var chips: [CardRefView]
    /// `kind` "events" (a phone's chat): the card events of a run, a chip each, in order.
    public var events: [EventChipView]
    /// A selection of the Scribble Board (its one file is the picture).
    public var scribble: Bool
    /// A note: when it was written.
    public var writtenMs: UInt64?
    /// On a card's page, the agent's words that answer his What??: that row's id (drawn as one block with it).
    public var answers: String?
    /// On a card's page, his What?? that has no answer yet: "Waiting for the explanation."
    public var waits: Text?
    /// The helper (its agent's subagent) that wrote it, beside the agent's name; none for the agent's own words.
    public var helper: String?

    public init(id: String = "", fromMe: Bool = false, text: String = "", timeMs: UInt64 = 0, heard: Bool = false, pending: Bool = false, files: [String] = [], kind: String = "", number: UInt64 = 0, day: Text? = nil, cont: Bool = false, terminal: Bool = false, card: CardRefView? = nil, event: EventView? = nil, deed: EventView? = nil, row: DeskRowView? = nil, work: WorkView? = nil, published: String? = nil, details: String = "", html: String = "", chips: [CardRefView] = [], events: [EventChipView] = [], scribble: Bool = false, writtenMs: UInt64? = nil, answers: String? = nil, waits: Text? = nil, helper: String? = nil) {
      self.id = id
      self.fromMe = fromMe
      self.text = text
      self.timeMs = timeMs
      self.heard = heard
      self.pending = pending
      self.files = files
      self.kind = kind
      self.number = number
      self.day = day
      self.cont = cont
      self.terminal = terminal
      self.card = card
      self.event = event
      self.deed = deed
      self.row = row
      self.work = work
      self.published = published
      self.details = details
      self.html = html
      self.chips = chips
      self.events = events
      self.scribble = scribble
      self.writtenMs = writtenMs
      self.answers = answers
      self.waits = waits
      self.helper = helper
    }

    enum CodingKeys: String, CodingKey {
      case id = "id"
      case fromMe = "from_me"
      case text = "text"
      case timeMs = "time_ms"
      case heard = "heard"
      case pending = "pending"
      case files = "files"
      case kind = "kind"
      case number = "number"
      case day = "day"
      case cont = "cont"
      case terminal = "terminal"
      case card = "card"
      case event = "event"
      case deed = "deed"
      case row = "row"
      case work = "work"
      case published = "published"
      case details = "details"
      case html = "html"
      case chips = "chips"
      case events = "events"
      case scribble = "scribble"
      case writtenMs = "written_ms"
      case answers = "answers"
      case waits = "waits"
      case helper = "helper"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.id = try c.decode(String.self, forKey: .id)
      self.fromMe = try c.decode(Bool.self, forKey: .fromMe)
      self.text = try c.decode(String.self, forKey: .text)
      self.timeMs = try c.decode(UInt64.self, forKey: .timeMs)
      self.heard = try c.decode(Bool.self, forKey: .heard)
      self.pending = try c.decode(Bool.self, forKey: .pending)
      self.files = try c.decodeIfPresent([String].self, forKey: .files) ?? []
      self.kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? ""
      self.number = try c.decodeIfPresent(UInt64.self, forKey: .number) ?? 0
      self.day = try c.decodeIfPresent(Text.self, forKey: .day)
      self.cont = try c.decodeIfPresent(Bool.self, forKey: .cont) ?? false
      self.terminal = try c.decodeIfPresent(Bool.self, forKey: .terminal) ?? false
      self.card = try c.decodeIfPresent(CardRefView.self, forKey: .card)
      self.event = try c.decodeIfPresent(EventView.self, forKey: .event)
      self.deed = try c.decodeIfPresent(EventView.self, forKey: .deed)
      self.row = try c.decodeIfPresent(DeskRowView.self, forKey: .row)
      self.work = try c.decodeIfPresent(WorkView.self, forKey: .work)
      self.published = try c.decodeIfPresent(String.self, forKey: .published)
      self.details = try c.decodeIfPresent(String.self, forKey: .details) ?? ""
      self.html = try c.decodeIfPresent(String.self, forKey: .html) ?? ""
      self.chips = try c.decodeIfPresent([CardRefView].self, forKey: .chips) ?? []
      self.events = try c.decodeIfPresent([EventChipView].self, forKey: .events) ?? []
      self.scribble = try c.decodeIfPresent(Bool.self, forKey: .scribble) ?? false
      self.writtenMs = try c.decodeIfPresent(UInt64.self, forKey: .writtenMs)
      self.answers = try c.decodeIfPresent(String.self, forKey: .answers)
      self.waits = try c.decodeIfPresent(Text.self, forKey: .waits)
      self.helper = try c.decodeIfPresent(String.self, forKey: .helper)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(id, forKey: .id)
      try c.encode(fromMe, forKey: .fromMe)
      try c.encode(text, forKey: .text)
      try c.encode(timeMs, forKey: .timeMs)
      try c.encode(heard, forKey: .heard)
      try c.encode(pending, forKey: .pending)
      if !files.isEmpty { try c.encode(files, forKey: .files) }
      try c.encode(kind, forKey: .kind)
      try c.encode(number, forKey: .number)
      try c.encodeIfPresent(day, forKey: .day)
      try c.encode(cont, forKey: .cont)
      try c.encode(terminal, forKey: .terminal)
      try c.encodeIfPresent(card, forKey: .card)
      try c.encodeIfPresent(event, forKey: .event)
      try c.encodeIfPresent(deed, forKey: .deed)
      try c.encodeIfPresent(row, forKey: .row)
      try c.encodeIfPresent(work, forKey: .work)
      try c.encodeIfPresent(published, forKey: .published)
      if !details.isEmpty { try c.encode(details, forKey: .details) }
      if !html.isEmpty { try c.encode(html, forKey: .html) }
      if !chips.isEmpty { try c.encode(chips, forKey: .chips) }
      if !events.isEmpty { try c.encode(events, forKey: .events) }
      try c.encode(scribble, forKey: .scribble)
      try c.encodeIfPresent(writtenMs, forKey: .writtenMs)
      try c.encodeIfPresent(answers, forKey: .answers)
      try c.encodeIfPresent(waits, forKey: .waits)
      try c.encodeIfPresent(helper, forKey: .helper)
    }
  }

  /// A card as a row of a conversation names it.
  public struct CardRefView: Codable, Hashable, Sendable {
    public var id: String
    /// Its number ("Nr. 12"); 0 when this device does not hold it.
    public var number: UInt32
    public var title: String

    public init(id: String = "", number: UInt32 = 0, title: String = "") {
      self.id = id
      self.number = number
      self.title = title
    }

    enum CodingKeys: String, CodingKey {
      case id = "id"
      case number = "number"
      case title = "title"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.id = try c.decode(String.self, forKey: .id)
      self.number = try c.decode(UInt32.self, forKey: .number)
      self.title = try c.decode(String.self, forKey: .title)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(id, forKey: .id)
      try c.encode(number, forKey: .number)
      try c.encode(title, forKey: .title)
    }
  }

  /// One card event of a run on a phone (`TalkRow.events`): a small chip that opens its card.
  public struct EventChipView: Codable, Hashable, Sendable {
    /// The talk row it was.
    public var id: String
    /// The event's kind (`EventView.kind`): its sign.
    public var kind: String
    /// What the chip says: the card's title, else what happened.
    public var text: String
    /// For a screen reader: what happened ("Trommi revised it: Release notes").
    public var says: Text
    public var card: CardRefView?

    public init(id: String = "", kind: String = "", text: String = "", says: Text = Text(), card: CardRefView? = nil) {
      self.id = id
      self.kind = kind
      self.text = text
      self.says = says
      self.card = card
    }

    enum CodingKeys: String, CodingKey {
      case id = "id"
      case kind = "kind"
      case text = "text"
      case says = "says"
      case card = "card"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.id = try c.decode(String.self, forKey: .id)
      self.kind = try c.decode(String.self, forKey: .kind)
      self.text = try c.decode(String.self, forKey: .text)
      self.says = try c.decode(Text.self, forKey: .says)
      self.card = try c.decodeIfPresent(CardRefView.self, forKey: .card)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(id, forKey: .id)
      try c.encode(kind, forKey: .kind)
      try c.encode(text, forKey: .text)
      try c.encode(says, forKey: .says)
      try c.encodeIfPresent(card, forKey: .card)
    }
  }

  /// One quiet line for something that happened to a card.
  public struct EventView: Codable, Hashable, Sendable {
    /// "asked", "info", "revised", "decided", "trusted", "read", "shredded", "reopened", "done", "handed", "snoozed",
    /// "took_back", "handed_back", "explain".
    public var kind: String
    /// "New question", "Answered", …
    public var label: Text
    /// The card's title, when the words do not say it already.
    public var about: String
    public var text: String
    /// What became of the question is said where it was asked: this line only repeats it.
    public var echo: Bool
    /// On a card's page: "revised", the version it brought ("Version 3"); "decided", the version he answered when it
    /// was not the newest ("You chose in version 2").
    public var version: UInt32?
    /// "revised" on a card's page: it came after his hand-back ("Version 3, as you asked").
    public var asked: Bool
    /// "decided", "trusted", "shredded": what he wrote along, one line each (“his note”, On Label: “a note”).
    public var said: [Text]
    /// "decided", "trusted", "shredded": the files he sent along (`ViewModel.files`), shown under the deed.
    public var files: [String]

    public init(kind: String = "", label: Text = Text(), about: String = "", text: String = "", echo: Bool = false, version: UInt32? = nil, asked: Bool = false, said: [Text] = [], files: [String] = []) {
      self.kind = kind
      self.label = label
      self.about = about
      self.text = text
      self.echo = echo
      self.version = version
      self.asked = asked
      self.said = said
      self.files = files
    }

    enum CodingKeys: String, CodingKey {
      case kind = "kind"
      case label = "label"
      case about = "about"
      case text = "text"
      case echo = "echo"
      case version = "version"
      case asked = "asked"
      case said = "said"
      case files = "files"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.kind = try c.decode(String.self, forKey: .kind)
      self.label = try c.decode(Text.self, forKey: .label)
      self.about = try c.decodeIfPresent(String.self, forKey: .about) ?? ""
      self.text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
      self.echo = try c.decodeIfPresent(Bool.self, forKey: .echo) ?? false
      self.version = try c.decodeIfPresent(UInt32.self, forKey: .version)
      self.asked = try c.decodeIfPresent(Bool.self, forKey: .asked) ?? false
      self.said = try c.decodeIfPresent([Text].self, forKey: .said) ?? []
      self.files = try c.decodeIfPresent([String].self, forKey: .files) ?? []
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(kind, forKey: .kind)
      try c.encode(label, forKey: .label)
      if !about.isEmpty { try c.encode(about, forKey: .about) }
      if !text.isEmpty { try c.encode(text, forKey: .text) }
      try c.encode(echo, forKey: .echo)
      try c.encodeIfPresent(version, forKey: .version)
      try c.encode(asked, forKey: .asked)
      if !said.isEmpty { try c.encode(said, forKey: .said) }
      if !files.isEmpty { try c.encode(files, forKey: .files) }
    }
  }

  /// A turn's trail: what the agent did between his prompt and its answer, as one block.
  public struct WorkView: Codable, Hashable, Sendable {
    public var turn: String
    /// "running", "done", "interrupted", "failed".
    public var state: String
    /// "Working", "Worked 2 min", "Interrupted after 12 s", "Stopped by an error after 1 h 5 min".
    public var head: Text
    /// "7 steps · 1 helper · 2 with errors"; none without any.
    public var sum: Text?
    /// While it runs: the step it is at ("Bash · run the tests").
    public var now: String
    public var lines: [WorkLineView]
    /// "and 12 more steps, not listed".
    public var rest: Text?

    public init(turn: String = "", state: String = "", head: Text = Text(), sum: Text? = nil, now: String = "", lines: [WorkLineView] = [], rest: Text? = nil) {
      self.turn = turn
      self.state = state
      self.head = head
      self.sum = sum
      self.now = now
      self.lines = lines
      self.rest = rest
    }

    enum CodingKeys: String, CodingKey {
      case turn = "turn"
      case state = "state"
      case head = "head"
      case sum = "sum"
      case now = "now"
      case lines = "lines"
      case rest = "rest"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.turn = try c.decode(String.self, forKey: .turn)
      self.state = try c.decode(String.self, forKey: .state)
      self.head = try c.decode(Text.self, forKey: .head)
      self.sum = try c.decodeIfPresent(Text.self, forKey: .sum)
      self.now = try c.decodeIfPresent(String.self, forKey: .now) ?? ""
      self.lines = try c.decode([WorkLineView].self, forKey: .lines)
      self.rest = try c.decodeIfPresent(Text.self, forKey: .rest)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(turn, forKey: .turn)
      try c.encode(state, forKey: .state)
      try c.encode(head, forKey: .head)
      try c.encodeIfPresent(sum, forKey: .sum)
      if !now.isEmpty { try c.encode(now, forKey: .now) }
      try c.encode(lines, forKey: .lines)
      try c.encodeIfPresent(rest, forKey: .rest)
    }
  }

  public struct WorkLineView: Codable, Hashable, Sendable {
    public var id: String
    /// "step", "helper", or "text" (the agent's words between two steps: `text`).
    public var kind: String
    /// "running", "ok", "failed", "interrupted"; "" for words.
    public var state: String
    /// What its sign says ("done", "exit code 2").
    public var says: Text?
    /// The bold word: the tool, "Helper <name>", or "Step".
    public var tool: String
    /// What it is about ("title · subject").
    public var what: String
    /// "3 steps" (a helper), "exit code 2" (a failed command).
    public var count: Text?
    /// How long it took ("0.3 s", "2 min").
    public var took: String
    public var text: String
    public var input: String
    public var output: String

    public init(id: String = "", kind: String = "", state: String = "", says: Text? = nil, tool: String = "", what: String = "", count: Text? = nil, took: String = "", text: String = "", input: String = "", output: String = "") {
      self.id = id
      self.kind = kind
      self.state = state
      self.says = says
      self.tool = tool
      self.what = what
      self.count = count
      self.took = took
      self.text = text
      self.input = input
      self.output = output
    }

    enum CodingKeys: String, CodingKey {
      case id = "id"
      case kind = "kind"
      case state = "state"
      case says = "says"
      case tool = "tool"
      case what = "what"
      case count = "count"
      case took = "took"
      case text = "text"
      case input = "input"
      case output = "output"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.id = try c.decode(String.self, forKey: .id)
      self.kind = try c.decode(String.self, forKey: .kind)
      self.state = try c.decodeIfPresent(String.self, forKey: .state) ?? ""
      self.says = try c.decodeIfPresent(Text.self, forKey: .says)
      self.tool = try c.decodeIfPresent(String.self, forKey: .tool) ?? ""
      self.what = try c.decodeIfPresent(String.self, forKey: .what) ?? ""
      self.count = try c.decodeIfPresent(Text.self, forKey: .count)
      self.took = try c.decodeIfPresent(String.self, forKey: .took) ?? ""
      self.text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
      self.input = try c.decodeIfPresent(String.self, forKey: .input) ?? ""
      self.output = try c.decodeIfPresent(String.self, forKey: .output) ?? ""
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(id, forKey: .id)
      try c.encode(kind, forKey: .kind)
      try c.encode(state, forKey: .state)
      try c.encodeIfPresent(says, forKey: .says)
      if !tool.isEmpty { try c.encode(tool, forKey: .tool) }
      if !what.isEmpty { try c.encode(what, forKey: .what) }
      try c.encodeIfPresent(count, forKey: .count)
      if !took.isEmpty { try c.encode(took, forKey: .took) }
      if !text.isEmpty { try c.encode(text, forKey: .text) }
      if !input.isEmpty { try c.encode(input, forKey: .input) }
      if !output.isEmpty { try c.encode(output, forKey: .output) }
    }
  }

  /// A status line of a session's running work, as its page shows it (core/client/README.md "Status lines"): only
  /// the lines that show are here.
  public struct StatusLineView: Codable, Hashable, Sendable {
    public var id: String
    public var label: String
    /// The helper (its agent's subagent) whose line it is, drawn before its label; none for the agent's own.
    public var helper: String?
    public var detail: String
    /// "working", "decision", "later", "done" (for ten minutes), "stale" (greyed and still, for a day).
    public var state: String
    /// "working", "waits on you", "put off", "done", "no news for a while".
    public var says: Text
    /// When its agent last set it.
    public var updatedMs: UInt64
    /// The card it stands for: the one it names, else the card with its session whose line it is.
    public var card: CardRefView?

    public init(id: String = "", label: String = "", helper: String? = nil, detail: String = "", state: String = "", says: Text = Text(), updatedMs: UInt64 = 0, card: CardRefView? = nil) {
      self.id = id
      self.label = label
      self.helper = helper
      self.detail = detail
      self.state = state
      self.says = says
      self.updatedMs = updatedMs
      self.card = card
    }

    enum CodingKeys: String, CodingKey {
      case id = "id"
      case label = "label"
      case helper = "helper"
      case detail = "detail"
      case state = "state"
      case says = "says"
      case updatedMs = "updated_ms"
      case card = "card"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.id = try c.decode(String.self, forKey: .id)
      self.label = try c.decode(String.self, forKey: .label)
      self.helper = try c.decodeIfPresent(String.self, forKey: .helper)
      self.detail = try c.decode(String.self, forKey: .detail)
      self.state = try c.decode(String.self, forKey: .state)
      self.says = try c.decodeIfPresent(Text.self, forKey: .says) ?? Text()
      self.updatedMs = try c.decodeIfPresent(UInt64.self, forKey: .updatedMs) ?? 0
      self.card = try c.decodeIfPresent(CardRefView.self, forKey: .card)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(id, forKey: .id)
      try c.encode(label, forKey: .label)
      try c.encodeIfPresent(helper, forKey: .helper)
      try c.encode(detail, forKey: .detail)
      try c.encode(state, forKey: .state)
      try c.encode(says, forKey: .says)
      try c.encode(updatedMs, forKey: .updatedMs)
      try c.encodeIfPresent(card, forKey: .card)
    }
  }

  /// One card's page (a question, something to read, a request for approval): who it comes from, its words, its
  /// answers or what was said, its history, and the comments under it. Made for the card in view (`Lens::card`).
  public struct CardView: Codable, Hashable, Sendable {
    public var id: String
    public var sessionId: String?
    /// "decision", "info", "request", "note".
    public var kind: String
    /// "open", "answered", "closed".
    public var state: String
    /// 0 low, 1 normal, 2 high, 3 critical.
    public var urgency: UInt8
    public var title: String
    /// Its whole text (markdown).
    public var body: String
    /// Its options, in the tiles' order (the advised last).
    public var options: [OptionView]
    /// "You chose: Ship it", when he answered (for a screen reader; drawn from `answer`).
    public var youChose: Text?
    /// How many versions stood before this one.
    public var history: UInt32
    public var starred: Bool
    public var snoozedUntil: UInt64?
    /// File ids (`ViewModel.files`): every attachment that is no page of a picture.
    public var files: [String]
    /// Its number, for its address (`/card/<number>`); 0 when unknown.
    public var number: UInt32
    /// "Nr. 12".
    public var nr: Text
    /// Where it stands: "catching" (settled elsewhere, its outcome on the way), "open", "decided", "shredded", "done".
    public var status: String
    /// Who it comes from, above its title: "Team › Main › Helper" (`FromView::path`).
    public var from: FromView?
    /// "Knock! Blocking", while it is open and knocks.
    public var knock: Text?
    /// The strip above the title while its session works on it.
    public var work: CardWorkView?
    /// When it was asked, or last revised.
    public var askedMs: UInt64
    /// Its place among what waits on the Desk in view ("3 of 7"), with its neighbours.
    public var place: PlaceView?
    /// Small words of the quiet line: "replaces 2 questions", "revised", "3 messages below".
    public var notes: [Text]
    /// The text that stands on the card (markdown): its paragraphs; code and tables stand in the comments.
    public var text: String
    /// The comments hold more of the text ("More in the comments ↓").
    public var more: Bool
    /// The agent's layout under the text (drawn in the sandboxed frame).
    public var html: String
    /// The options' own paragraphs, in the tiles' order; empty when none says more than its label.
    public var sections: [SectionView]
    /// Several options may be ticked.
    public var multiple: Bool
    /// The answers' column: what can be done, or what was said.
    public var answer: AnswerView
    /// Under the answers: whether its session hears, and whether it has his answer.
    public var note: LinkNoteView?
    /// What the field under the card says while it is empty.
    public var ask: Text
    /// His unsent words (the draft kept with the card).
    public var draft: String
    /// The versions that stood before this one, oldest first.
    public var versions: [VersionView]
    /// What the star says ("Star", "Starred").
    public var starSays: Text
    /// What the card does not hold, before the comments: the whole text or its layout, the links of its options,
    /// that he put it off.
    public var lead: [LeadView]
    /// The comments and what happened to the card, oldest first: the window's rows (`earlier`).
    public var talk: [TalkRow]
    /// The hub holds older comments than `talk` has.
    public var hasMore: Bool
    /// The cards it replaces.
    public var mergedFrom: [CardRefView]
    /// The card that replaced it.
    public var mergedInto: CardRefView?
    /// Its pictures, in order (the stage and the small ones under it), each with the option it shows.
    public var pictures: [PictureView]
    /// The line above the comments when more stand before them ("Load earlier (N)", "Earlier comments"): `talk`
    /// is a window of the newest [`board::COMMENTS_PAGE`] rows, a page more for each time the person asked
    /// (`Lens::comments_window`, `MoreOf::Comments`); none when it shows everything there is.
    public var earlier: MoreView?
    /// Once it is settled (not open, not catching up): the way on that the page offers right after the person
    /// answered here (the shell shows it then): the next open question of the team in view, or that there is none.
    public var after: AfterView?

    public init(id: String = "", sessionId: String? = nil, kind: String = "", state: String = "", urgency: UInt8 = 0, title: String = "", body: String = "", options: [OptionView] = [], youChose: Text? = nil, history: UInt32 = 0, starred: Bool = false, snoozedUntil: UInt64? = nil, files: [String] = [], number: UInt32 = 0, nr: Text = Text(), status: String = "", from: FromView? = nil, knock: Text? = nil, work: CardWorkView? = nil, askedMs: UInt64 = 0, place: PlaceView? = nil, notes: [Text] = [], text: String = "", more: Bool = false, html: String = "", sections: [SectionView] = [], multiple: Bool = false, answer: AnswerView = AnswerView(), note: LinkNoteView? = nil, ask: Text = Text(), draft: String = "", versions: [VersionView] = [], starSays: Text = Text(), lead: [LeadView] = [], talk: [TalkRow] = [], hasMore: Bool = false, mergedFrom: [CardRefView] = [], mergedInto: CardRefView? = nil, pictures: [PictureView] = [], earlier: MoreView? = nil, after: AfterView? = nil) {
      self.id = id
      self.sessionId = sessionId
      self.kind = kind
      self.state = state
      self.urgency = urgency
      self.title = title
      self.body = body
      self.options = options
      self.youChose = youChose
      self.history = history
      self.starred = starred
      self.snoozedUntil = snoozedUntil
      self.files = files
      self.number = number
      self.nr = nr
      self.status = status
      self.from = from
      self.knock = knock
      self.work = work
      self.askedMs = askedMs
      self.place = place
      self.notes = notes
      self.text = text
      self.more = more
      self.html = html
      self.sections = sections
      self.multiple = multiple
      self.answer = answer
      self.note = note
      self.ask = ask
      self.draft = draft
      self.versions = versions
      self.starSays = starSays
      self.lead = lead
      self.talk = talk
      self.hasMore = hasMore
      self.mergedFrom = mergedFrom
      self.mergedInto = mergedInto
      self.pictures = pictures
      self.earlier = earlier
      self.after = after
    }

    enum CodingKeys: String, CodingKey {
      case id = "id"
      case sessionId = "session_id"
      case kind = "kind"
      case state = "state"
      case urgency = "urgency"
      case title = "title"
      case body = "body"
      case options = "options"
      case youChose = "you_chose"
      case history = "history"
      case starred = "starred"
      case snoozedUntil = "snoozed_until"
      case files = "files"
      case number = "number"
      case nr = "nr"
      case status = "status"
      case from = "from"
      case knock = "knock"
      case work = "work"
      case askedMs = "asked_ms"
      case place = "place"
      case notes = "notes"
      case text = "text"
      case more = "more"
      case html = "html"
      case sections = "sections"
      case multiple = "multiple"
      case answer = "answer"
      case note = "note"
      case ask = "ask"
      case draft = "draft"
      case versions = "versions"
      case starSays = "star_says"
      case lead = "lead"
      case talk = "talk"
      case hasMore = "has_more"
      case mergedFrom = "merged_from"
      case mergedInto = "merged_into"
      case pictures = "pictures"
      case earlier = "earlier"
      case after = "after"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.id = try c.decode(String.self, forKey: .id)
      self.sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId)
      self.kind = try c.decode(String.self, forKey: .kind)
      self.state = try c.decode(String.self, forKey: .state)
      self.urgency = try c.decode(UInt8.self, forKey: .urgency)
      self.title = try c.decode(String.self, forKey: .title)
      self.body = try c.decode(String.self, forKey: .body)
      self.options = try c.decode([OptionView].self, forKey: .options)
      self.youChose = try c.decodeIfPresent(Text.self, forKey: .youChose)
      self.history = try c.decode(UInt32.self, forKey: .history)
      self.starred = try c.decode(Bool.self, forKey: .starred)
      self.snoozedUntil = try c.decodeIfPresent(UInt64.self, forKey: .snoozedUntil)
      self.files = try c.decodeIfPresent([String].self, forKey: .files) ?? []
      self.number = try c.decodeIfPresent(UInt32.self, forKey: .number) ?? 0
      self.nr = try c.decodeIfPresent(Text.self, forKey: .nr) ?? Text()
      self.status = try c.decodeIfPresent(String.self, forKey: .status) ?? ""
      self.from = try c.decodeIfPresent(FromView.self, forKey: .from)
      self.knock = try c.decodeIfPresent(Text.self, forKey: .knock)
      self.work = try c.decodeIfPresent(CardWorkView.self, forKey: .work)
      self.askedMs = try c.decodeIfPresent(UInt64.self, forKey: .askedMs) ?? 0
      self.place = try c.decodeIfPresent(PlaceView.self, forKey: .place)
      self.notes = try c.decodeIfPresent([Text].self, forKey: .notes) ?? []
      self.text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
      self.more = try c.decodeIfPresent(Bool.self, forKey: .more) ?? false
      self.html = try c.decodeIfPresent(String.self, forKey: .html) ?? ""
      self.sections = try c.decodeIfPresent([SectionView].self, forKey: .sections) ?? []
      self.multiple = try c.decodeIfPresent(Bool.self, forKey: .multiple) ?? false
      self.answer = try c.decodeIfPresent(AnswerView.self, forKey: .answer) ?? AnswerView()
      self.note = try c.decodeIfPresent(LinkNoteView.self, forKey: .note)
      self.ask = try c.decodeIfPresent(Text.self, forKey: .ask) ?? Text()
      self.draft = try c.decodeIfPresent(String.self, forKey: .draft) ?? ""
      self.versions = try c.decodeIfPresent([VersionView].self, forKey: .versions) ?? []
      self.starSays = try c.decodeIfPresent(Text.self, forKey: .starSays) ?? Text()
      self.lead = try c.decodeIfPresent([LeadView].self, forKey: .lead) ?? []
      self.talk = try c.decodeIfPresent([TalkRow].self, forKey: .talk) ?? []
      self.hasMore = try c.decodeIfPresent(Bool.self, forKey: .hasMore) ?? false
      self.mergedFrom = try c.decodeIfPresent([CardRefView].self, forKey: .mergedFrom) ?? []
      self.mergedInto = try c.decodeIfPresent(CardRefView.self, forKey: .mergedInto)
      self.pictures = try c.decodeIfPresent([PictureView].self, forKey: .pictures) ?? []
      self.earlier = try c.decodeIfPresent(MoreView.self, forKey: .earlier)
      self.after = try c.decodeIfPresent(AfterView.self, forKey: .after)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(id, forKey: .id)
      try c.encode(sessionId, forKey: .sessionId)
      try c.encode(kind, forKey: .kind)
      try c.encode(state, forKey: .state)
      try c.encode(urgency, forKey: .urgency)
      try c.encode(title, forKey: .title)
      try c.encode(body, forKey: .body)
      try c.encode(options, forKey: .options)
      try c.encodeIfPresent(youChose, forKey: .youChose)
      try c.encode(history, forKey: .history)
      try c.encode(starred, forKey: .starred)
      try c.encodeIfPresent(snoozedUntil, forKey: .snoozedUntil)
      if !files.isEmpty { try c.encode(files, forKey: .files) }
      try c.encode(number, forKey: .number)
      try c.encode(nr, forKey: .nr)
      try c.encode(status, forKey: .status)
      try c.encodeIfPresent(from, forKey: .from)
      try c.encodeIfPresent(knock, forKey: .knock)
      try c.encodeIfPresent(work, forKey: .work)
      try c.encode(askedMs, forKey: .askedMs)
      try c.encodeIfPresent(place, forKey: .place)
      if !notes.isEmpty { try c.encode(notes, forKey: .notes) }
      try c.encode(text, forKey: .text)
      try c.encode(more, forKey: .more)
      if !html.isEmpty { try c.encode(html, forKey: .html) }
      if !sections.isEmpty { try c.encode(sections, forKey: .sections) }
      try c.encode(multiple, forKey: .multiple)
      try c.encode(answer, forKey: .answer)
      try c.encodeIfPresent(note, forKey: .note)
      try c.encode(ask, forKey: .ask)
      if !draft.isEmpty { try c.encode(draft, forKey: .draft) }
      if !versions.isEmpty { try c.encode(versions, forKey: .versions) }
      try c.encode(starSays, forKey: .starSays)
      if !lead.isEmpty { try c.encode(lead, forKey: .lead) }
      if !talk.isEmpty { try c.encode(talk, forKey: .talk) }
      try c.encode(hasMore, forKey: .hasMore)
      if !mergedFrom.isEmpty { try c.encode(mergedFrom, forKey: .mergedFrom) }
      try c.encodeIfPresent(mergedInto, forKey: .mergedInto)
      if !pictures.isEmpty { try c.encode(pictures, forKey: .pictures) }
      try c.encodeIfPresent(earlier, forKey: .earlier)
      try c.encodeIfPresent(after, forKey: .after)
    }
  }

  /// A picture of a card, and the option it belongs to (the web's `pictureKeys`, `picturesOf`): a section that names
  /// it decides; else its file name names one option (by key or label, the longest key winning, two equal ones
  /// naming none); else, with as many pictures as options and three or more, they pair in order.
  public struct PictureView: Codable, Hashable, Sendable {
    /// The file (`ViewModel.files`).
    public var fileId: String
    public var name: String
    /// Its caption, when it says more than its name.
    public var title: String
    /// The line under it in the full-screen viewer: its caption, else the label of the option it shows, else its
    /// name.
    public var caption: String
    public var width: UInt64?
    public var height: UInt64?
    /// The page that belongs to it (an attachment id), shown beside it.
    public var page: String?
    /// The option it shows: pointing at that option puts it on the stage.
    public var key: String?
    /// Every option a section shows it for (several may share one picture); else its `key`.
    public var keys: [String]

    public init(fileId: String = "", name: String = "", title: String = "", caption: String = "", width: UInt64? = nil, height: UInt64? = nil, page: String? = nil, key: String? = nil, keys: [String] = []) {
      self.fileId = fileId
      self.name = name
      self.title = title
      self.caption = caption
      self.width = width
      self.height = height
      self.page = page
      self.key = key
      self.keys = keys
    }

    enum CodingKeys: String, CodingKey {
      case fileId = "file_id"
      case name = "name"
      case title = "title"
      case caption = "caption"
      case width = "width"
      case height = "height"
      case page = "page"
      case key = "key"
      case keys = "keys"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.fileId = try c.decode(String.self, forKey: .fileId)
      self.name = try c.decode(String.self, forKey: .name)
      self.title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
      self.caption = try c.decodeIfPresent(String.self, forKey: .caption) ?? ""
      self.width = try c.decodeIfPresent(UInt64.self, forKey: .width)
      self.height = try c.decodeIfPresent(UInt64.self, forKey: .height)
      self.page = try c.decodeIfPresent(String.self, forKey: .page)
      self.key = try c.decodeIfPresent(String.self, forKey: .key)
      self.keys = try c.decodeIfPresent([String].self, forKey: .keys) ?? []
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(fileId, forKey: .fileId)
      try c.encode(name, forKey: .name)
      if !title.isEmpty { try c.encode(title, forKey: .title) }
      if !caption.isEmpty { try c.encode(caption, forKey: .caption) }
      try c.encodeIfPresent(width, forKey: .width)
      try c.encodeIfPresent(height, forKey: .height)
      try c.encodeIfPresent(page, forKey: .page)
      try c.encodeIfPresent(key, forKey: .key)
      if !keys.isEmpty { try c.encode(keys, forKey: .keys) }
    }
  }

  /// The way on after an answer on a card's page.
  public struct AfterView: Codable, Hashable, Sendable {
    /// The next open question: the next in the Desk's order after this card's place, else the first that waits.
    public var next: CardRefView?
    /// "Next question", or "That was the last open question."
    public var says: Text

    public init(next: CardRefView? = nil, says: Text = Text()) {
      self.next = next
      self.says = says
    }

    enum CodingKeys: String, CodingKey {
      case next = "next"
      case says = "says"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.next = try c.decodeIfPresent(CardRefView.self, forKey: .next)
      self.says = try c.decode(Text.self, forKey: .says)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encodeIfPresent(next, forKey: .next)
      try c.encode(says, forKey: .says)
    }
  }

  public struct OptionView: Codable, Hashable, Sendable {
    public var key: String
    public var label: String
    public var recommended: Bool
    /// He chose it (the answer that stands), or ticked it (his draft, while several may be ticked).
    public var chosen: Bool
    /// Its line of detail, as plain words.
    public var detail: String
    /// Choosing it settles the card (its agent marked it final).
    public var settles: Bool
    /// His note on it: unsent (his draft) while the card is open, else as he sent it.
    public var note: String
    /// The tooltip ("Recommended · Settles it").
    public var tip: Text?

    public init(key: String = "", label: String = "", recommended: Bool = false, chosen: Bool = false, detail: String = "", settles: Bool = false, note: String = "", tip: Text? = nil) {
      self.key = key
      self.label = label
      self.recommended = recommended
      self.chosen = chosen
      self.detail = detail
      self.settles = settles
      self.note = note
      self.tip = tip
    }

    enum CodingKeys: String, CodingKey {
      case key = "key"
      case label = "label"
      case recommended = "recommended"
      case chosen = "chosen"
      case detail = "detail"
      case settles = "settles"
      case note = "note"
      case tip = "tip"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.key = try c.decode(String.self, forKey: .key)
      self.label = try c.decode(String.self, forKey: .label)
      self.recommended = try c.decode(Bool.self, forKey: .recommended)
      self.chosen = try c.decode(Bool.self, forKey: .chosen)
      self.detail = try c.decodeIfPresent(String.self, forKey: .detail) ?? ""
      self.settles = try c.decodeIfPresent(Bool.self, forKey: .settles) ?? false
      self.note = try c.decodeIfPresent(String.self, forKey: .note) ?? ""
      self.tip = try c.decodeIfPresent(Text.self, forKey: .tip)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(key, forKey: .key)
      try c.encode(label, forKey: .label)
      try c.encode(recommended, forKey: .recommended)
      try c.encode(chosen, forKey: .chosen)
      if !detail.isEmpty { try c.encode(detail, forKey: .detail) }
      try c.encode(settles, forKey: .settles)
      if !note.isEmpty { try c.encode(note, forKey: .note) }
      try c.encodeIfPresent(tip, forKey: .tip)
    }
  }

  /// An option's own paragraph (a card written as sections).
  public struct SectionView: Codable, Hashable, Sendable {
    public var key: String
    public var label: String
    public var recommended: Bool
    /// What it says beyond its label (markdown); "" when nothing.
    public var text: String
    public var html: String

    public init(key: String = "", label: String = "", recommended: Bool = false, text: String = "", html: String = "") {
      self.key = key
      self.label = label
      self.recommended = recommended
      self.text = text
      self.html = html
    }

    enum CodingKeys: String, CodingKey {
      case key = "key"
      case label = "label"
      case recommended = "recommended"
      case text = "text"
      case html = "html"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.key = try c.decode(String.self, forKey: .key)
      self.label = try c.decode(String.self, forKey: .label)
      self.recommended = try c.decode(Bool.self, forKey: .recommended)
      self.text = try c.decode(String.self, forKey: .text)
      self.html = try c.decodeIfPresent(String.self, forKey: .html) ?? ""
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(key, forKey: .key)
      try c.encode(label, forKey: .label)
      try c.encode(recommended, forKey: .recommended)
      try c.encode(text, forKey: .text)
      if !html.isEmpty { try c.encode(html, forKey: .html) }
    }
  }

  /// The strip above a card's title while its session works on it.
  public struct CardWorkView: Codable, Hashable, Sendable {
    public var sessionId: String
    /// What draws the session.
    public var mark: String
    /// "Fernly Website is working on it".
    public var says: Text
    /// Its status line ("Launch checklist · 14 of 19 done"), else "Reworking the card".
    public var words: Text
    /// When that was said.
    public var atMs: UInt64

    public init(sessionId: String = "", mark: String = "", says: Text = Text(), words: Text = Text(), atMs: UInt64 = 0) {
      self.sessionId = sessionId
      self.mark = mark
      self.says = says
      self.words = words
      self.atMs = atMs
    }

    enum CodingKeys: String, CodingKey {
      case sessionId = "session_id"
      case mark = "mark"
      case says = "says"
      case words = "words"
      case atMs = "at_ms"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.sessionId = try c.decode(String.self, forKey: .sessionId)
      self.mark = try c.decode(String.self, forKey: .mark)
      self.says = try c.decode(Text.self, forKey: .says)
      self.words = try c.decode(Text.self, forKey: .words)
      self.atMs = try c.decode(UInt64.self, forKey: .atMs)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(sessionId, forKey: .sessionId)
      try c.encode(mark, forKey: .mark)
      try c.encode(says, forKey: .says)
      try c.encode(words, forKey: .words)
      try c.encode(atMs, forKey: .atMs)
    }
  }

  /// A card's place among what waits on the Desk in view.
  public struct PlaceView: Codable, Hashable, Sendable {
    public var at: UInt32
    public var of: UInt32
    /// "3 of 7".
    public var says: Text
    public var prev: String?
    public var next: String?

    public init(at: UInt32 = 0, of: UInt32 = 0, says: Text = Text(), prev: String? = nil, next: String? = nil) {
      self.at = at
      self.of = of
      self.says = says
      self.prev = prev
      self.next = next
    }

    enum CodingKeys: String, CodingKey {
      case at = "at"
      case of = "of"
      case says = "says"
      case prev = "prev"
      case next = "next"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.at = try c.decode(UInt32.self, forKey: .at)
      self.of = try c.decode(UInt32.self, forKey: .of)
      self.says = try c.decode(Text.self, forKey: .says)
      self.prev = try c.decodeIfPresent(String.self, forKey: .prev)
      self.next = try c.decodeIfPresent(String.self, forKey: .next)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(at, forKey: .at)
      try c.encode(of, forKey: .of)
      try c.encode(says, forKey: .says)
      try c.encodeIfPresent(prev, forKey: .prev)
      try c.encodeIfPresent(next, forKey: .next)
    }
  }

  /// The answers' column of a card's page.
  public struct AnswerView: Codable, Hashable, Sendable {
    /// "options" (the card's options answer; a decision also offers the duck, What?? and the reverse card), "read"
    /// (Got it, What??, the reverse card), "request" (Allow, Deny), "said" (what was said, and the way back),
    /// "revising" (handed back), "working" (an info still worked on), "catching", "loading", "newer".
    public var mode: String
    /// The one still tile: what was said ("Ship it", "Read", "Shredded"), "In revision", "Being worked on".
    public var label: Text?
    /// Under it: "Your note: …", or what the mode means.
    public var detail: Text?
    /// The foot: "You chose", "You handed it back".
    public var did: Text?
    public var atMs: UInt64?
    /// The way back, when there is one: "reopen" (his answer is taken back: `Action::DecideAgain`), "takeback" (his hand-back is).
    public var back: String
    /// His notes on single options, as sent.
    public var optionNotes: [NotedView]
    /// "<name> marked this answer as final: nothing follows from it.", when his answer settled the card.
    public var settled: Text?
    /// What its agent said when it closed the card ("Done by the agent").
    public var summary: String
    /// Its agent closed it after his answer: What?? asks about what it did.
    public var finished: Bool
    /// What the options say to a screen reader ("Your answer. One tap answers."), or the mode's one quiet sentence.
    public var says: Text?

    public init(mode: String = "", label: Text? = nil, detail: Text? = nil, did: Text? = nil, atMs: UInt64? = nil, back: String = "", optionNotes: [NotedView] = [], settled: Text? = nil, summary: String = "", finished: Bool = false, says: Text? = nil) {
      self.mode = mode
      self.label = label
      self.detail = detail
      self.did = did
      self.atMs = atMs
      self.back = back
      self.optionNotes = optionNotes
      self.settled = settled
      self.summary = summary
      self.finished = finished
      self.says = says
    }

    enum CodingKeys: String, CodingKey {
      case mode = "mode"
      case label = "label"
      case detail = "detail"
      case did = "did"
      case atMs = "at_ms"
      case back = "back"
      case optionNotes = "option_notes"
      case settled = "settled"
      case summary = "summary"
      case finished = "finished"
      case says = "says"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.mode = try c.decode(String.self, forKey: .mode)
      self.label = try c.decodeIfPresent(Text.self, forKey: .label)
      self.detail = try c.decodeIfPresent(Text.self, forKey: .detail)
      self.did = try c.decodeIfPresent(Text.self, forKey: .did)
      self.atMs = try c.decodeIfPresent(UInt64.self, forKey: .atMs)
      self.back = try c.decodeIfPresent(String.self, forKey: .back) ?? ""
      self.optionNotes = try c.decodeIfPresent([NotedView].self, forKey: .optionNotes) ?? []
      self.settled = try c.decodeIfPresent(Text.self, forKey: .settled)
      self.summary = try c.decodeIfPresent(String.self, forKey: .summary) ?? ""
      self.finished = try c.decodeIfPresent(Bool.self, forKey: .finished) ?? false
      self.says = try c.decodeIfPresent(Text.self, forKey: .says)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(mode, forKey: .mode)
      try c.encodeIfPresent(label, forKey: .label)
      try c.encodeIfPresent(detail, forKey: .detail)
      try c.encodeIfPresent(did, forKey: .did)
      try c.encodeIfPresent(atMs, forKey: .atMs)
      if !back.isEmpty { try c.encode(back, forKey: .back) }
      if !optionNotes.isEmpty { try c.encode(optionNotes, forKey: .optionNotes) }
      try c.encodeIfPresent(settled, forKey: .settled)
      if !summary.isEmpty { try c.encode(summary, forKey: .summary) }
      try c.encode(finished, forKey: .finished)
      try c.encodeIfPresent(says, forKey: .says)
    }
  }

  public struct NotedView: Codable, Hashable, Sendable {
    public var label: String
    public var note: Text

    public init(label: String = "", note: Text = Text()) {
      self.label = label
      self.note = note
    }

    enum CodingKeys: String, CodingKey {
      case label = "label"
      case note = "note"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.label = try c.decode(String.self, forKey: .label)
      self.note = try c.decode(Text.self, forKey: .note)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(label, forKey: .label)
      try c.encode(note, forKey: .note)
    }
  }

  /// A version of a card that stood before.
  public struct VersionView: Codable, Hashable, Sendable {
    public var n: UInt32
    public var atMs: UInt64
    public var title: String
    /// What its agent said changed with the version after it; "" without a word.
    public var note: String
    /// The version as it was, read only ("See version 2", "Open version 2 as it was"): its text as the card shows it
    /// (markdown), and its options. Empty while its body is not on this device (`loaded`).
    public var text: String
    public var options: [OptionView]
    /// Its body is on this device (history on demand: an old version may be read from the hub when asked for).
    public var loaded: Bool
    /// Its pictures as they were, in order (`CardView.pictures`' rule, with that version's options).
    public var pictures: [PictureView]
    /// Its other files (`ViewModel.files`).
    public var files: [String]

    public init(n: UInt32 = 0, atMs: UInt64 = 0, title: String = "", note: String = "", text: String = "", options: [OptionView] = [], loaded: Bool = false, pictures: [PictureView] = [], files: [String] = []) {
      self.n = n
      self.atMs = atMs
      self.title = title
      self.note = note
      self.text = text
      self.options = options
      self.loaded = loaded
      self.pictures = pictures
      self.files = files
    }

    enum CodingKeys: String, CodingKey {
      case n = "n"
      case atMs = "at_ms"
      case title = "title"
      case note = "note"
      case text = "text"
      case options = "options"
      case loaded = "loaded"
      case pictures = "pictures"
      case files = "files"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.n = try c.decode(UInt32.self, forKey: .n)
      self.atMs = try c.decode(UInt64.self, forKey: .atMs)
      self.title = try c.decode(String.self, forKey: .title)
      self.note = try c.decodeIfPresent(String.self, forKey: .note) ?? ""
      self.text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
      self.options = try c.decodeIfPresent([OptionView].self, forKey: .options) ?? []
      self.loaded = try c.decodeIfPresent(Bool.self, forKey: .loaded) ?? false
      self.pictures = try c.decodeIfPresent([PictureView].self, forKey: .pictures) ?? []
      self.files = try c.decodeIfPresent([String].self, forKey: .files) ?? []
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(n, forKey: .n)
      try c.encode(atMs, forKey: .atMs)
      try c.encode(title, forKey: .title)
      if !note.isEmpty { try c.encode(note, forKey: .note) }
      if !text.isEmpty { try c.encode(text, forKey: .text) }
      if !options.isEmpty { try c.encode(options, forKey: .options) }
      try c.encode(loaded, forKey: .loaded)
      if !pictures.isEmpty { try c.encode(pictures, forKey: .pictures) }
      if !files.isEmpty { try c.encode(files, forKey: .files) }
    }
  }

  /// What the card itself does not hold, at the head of its comments (the web's `cardThread` lead), in this order.
  public struct LeadView: Codable, Hashable, Sendable {
    /// "whole": the whole text, when the card holds only part of it (`CardView.more`), with the agent's layout;
    /// "with": only the agent's layout, when the card holds all the words; "links": the links written into its
    /// options (a tile says them in plain words); "later": he put it off and it waits on Later.
    public var kind: String
    /// "The whole text", "With the text", "Links of the options", "You put it off: it waits on “Later”".
    public var label: Text
    /// "whole": the text (markdown, Artifact links by their titles).
    public var text: String
    /// "whole", "with": the agent's layout (`CardView.html`).
    public var html: String
    /// "links": each link with the option it is in.
    public var links: [OptionLinkView]
    /// "later": when he put it off.
    public var atMs: UInt64?

    public init(kind: String = "", label: Text = Text(), text: String = "", html: String = "", links: [OptionLinkView] = [], atMs: UInt64? = nil) {
      self.kind = kind
      self.label = label
      self.text = text
      self.html = html
      self.links = links
      self.atMs = atMs
    }

    enum CodingKeys: String, CodingKey {
      case kind = "kind"
      case label = "label"
      case text = "text"
      case html = "html"
      case links = "links"
      case atMs = "at_ms"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.kind = try c.decode(String.self, forKey: .kind)
      self.label = try c.decode(Text.self, forKey: .label)
      self.text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
      self.html = try c.decodeIfPresent(String.self, forKey: .html) ?? ""
      self.links = try c.decodeIfPresent([OptionLinkView].self, forKey: .links) ?? []
      self.atMs = try c.decodeIfPresent(UInt64.self, forKey: .atMs)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(kind, forKey: .kind)
      try c.encode(label, forKey: .label)
      if !text.isEmpty { try c.encode(text, forKey: .text) }
      if !html.isEmpty { try c.encode(html, forKey: .html) }
      if !links.isEmpty { try c.encode(links, forKey: .links) }
      try c.encodeIfPresent(atMs, forKey: .atMs)
    }
  }

  /// A link an agent wrote into an option's label or detail.
  public struct OptionLinkView: Codable, Hashable, Sendable {
    public var key: String
    /// The option's label without the link; its key when nothing else is left.
    public var label: String
    public var url: String
    /// The address as it is shown: without "https://" and "www.".
    public var short: String

    public init(key: String = "", label: String = "", url: String = "", short: String = "") {
      self.key = key
      self.label = label
      self.url = url
      self.short = short
    }

    enum CodingKeys: String, CodingKey {
      case key = "key"
      case label = "label"
      case url = "url"
      case short = "short"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.key = try c.decode(String.self, forKey: .key)
      self.label = try c.decode(String.self, forKey: .label)
      self.url = try c.decode(String.self, forKey: .url)
      self.short = try c.decode(String.self, forKey: .short)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(key, forKey: .key)
      try c.encode(label, forKey: .label)
      try c.encode(url, forKey: .url)
      try c.encode(short, forKey: .short)
    }
  }

  /// The person's notes (the room's, the same on every team) and the one in the corner (`notes.rs`).
  public struct NotesView: Codable, Hashable, Sendable {
    /// The ids of the notes that show, the last written first (the ids of `rows`). A sent note held for the toast's
    /// Undo shows nowhere.
    public var notes: [String]
    /// Those notes, in the same order.
    public var rows: [NoteView]
    /// The note in the corner: the first of them; none when there is none (the corner then makes a new one).
    public var corner: String?
    /// The corner's note holds words or files (the tab's note is drawn written).
    public var written: Bool
    /// What the corner's sticky says ("Your note: open it", "New note").
    public var says: Text
    /// The crowned session it goes to; none when no session wears the crown here.
    public var to: NoteToView?
    /// What the send says ("Send to Fernly").
    public var sendSays: Text?
    /// In the send's place without a crown: "Give a session the crown to send" (opens Settings · Agents).
    public var noCrown: Text?

    public init(notes: [String] = [], rows: [NoteView] = [], corner: String? = nil, written: Bool = false, says: Text = Text(), to: NoteToView? = nil, sendSays: Text? = nil, noCrown: Text? = nil) {
      self.notes = notes
      self.rows = rows
      self.corner = corner
      self.written = written
      self.says = says
      self.to = to
      self.sendSays = sendSays
      self.noCrown = noCrown
    }

    enum CodingKeys: String, CodingKey {
      case notes = "notes"
      case rows = "rows"
      case corner = "corner"
      case written = "written"
      case says = "says"
      case to = "to"
      case sendSays = "send_says"
      case noCrown = "no_crown"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.notes = try c.decode([String].self, forKey: .notes)
      self.rows = try c.decodeIfPresent([NoteView].self, forKey: .rows) ?? []
      self.corner = try c.decodeIfPresent(String.self, forKey: .corner)
      self.written = try c.decodeIfPresent(Bool.self, forKey: .written) ?? false
      self.says = try c.decodeIfPresent(Text.self, forKey: .says) ?? Text()
      self.to = try c.decodeIfPresent(NoteToView.self, forKey: .to)
      self.sendSays = try c.decodeIfPresent(Text.self, forKey: .sendSays)
      self.noCrown = try c.decodeIfPresent(Text.self, forKey: .noCrown)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(notes, forKey: .notes)
      if !rows.isEmpty { try c.encode(rows, forKey: .rows) }
      try c.encodeIfPresent(corner, forKey: .corner)
      try c.encode(written, forKey: .written)
      try c.encode(says, forKey: .says)
      try c.encodeIfPresent(to, forKey: .to)
      try c.encodeIfPresent(sendSays, forKey: .sendSays)
      try c.encodeIfPresent(noCrown, forKey: .noCrown)
    }
  }

  /// One note.
  public struct NoteView: Codable, Hashable, Sendable {
    public var id: String
    public var text: String
    public var files: [NoteFileView]
    public var createdMs: UInt64
    public var updatedMs: UInt64
    /// This device's version is not confirmed by the hub yet.
    public var pending: Bool

    public init(id: String = "", text: String = "", files: [NoteFileView] = [], createdMs: UInt64 = 0, updatedMs: UInt64 = 0, pending: Bool = false) {
      self.id = id
      self.text = text
      self.files = files
      self.createdMs = createdMs
      self.updatedMs = updatedMs
      self.pending = pending
    }

    enum CodingKeys: String, CodingKey {
      case id = "id"
      case text = "text"
      case files = "files"
      case createdMs = "created_ms"
      case updatedMs = "updated_ms"
      case pending = "pending"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.id = try c.decode(String.self, forKey: .id)
      self.text = try c.decode(String.self, forKey: .text)
      self.files = try c.decodeIfPresent([NoteFileView].self, forKey: .files) ?? []
      self.createdMs = try c.decode(UInt64.self, forKey: .createdMs)
      self.updatedMs = try c.decode(UInt64.self, forKey: .updatedMs)
      self.pending = try c.decodeIfPresent(Bool.self, forKey: .pending) ?? false
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(id, forKey: .id)
      try c.encode(text, forKey: .text)
      if !files.isEmpty { try c.encode(files, forKey: .files) }
      try c.encode(createdMs, forKey: .createdMs)
      try c.encode(updatedMs, forKey: .updatedMs)
      try c.encode(pending, forKey: .pending)
    }
  }

  /// A file of a note: a picture as a small thumbnail, any other file by its name.
  public struct NoteFileView: Codable, Hashable, Sendable {
    /// The attachment (`ViewModel.files`, `Action::OpenFile`).
    public var fileId: String
    public var name: String
    public var mediaType: String
    public var picture: Bool

    public init(fileId: String = "", name: String = "", mediaType: String = "", picture: Bool = false) {
      self.fileId = fileId
      self.name = name
      self.mediaType = mediaType
      self.picture = picture
    }

    enum CodingKeys: String, CodingKey {
      case fileId = "file_id"
      case name = "name"
      case mediaType = "media_type"
      case picture = "picture"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.fileId = try c.decode(String.self, forKey: .fileId)
      self.name = try c.decode(String.self, forKey: .name)
      self.mediaType = try c.decode(String.self, forKey: .mediaType)
      self.picture = try c.decode(Bool.self, forKey: .picture)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(fileId, forKey: .fileId)
      try c.encode(name, forKey: .name)
      try c.encode(mediaType, forKey: .mediaType)
      try c.encode(picture, forKey: .picture)
    }
  }

  /// A crowned session a note can go to.
  public struct NoteToView: Codable, Hashable, Sendable {
    public var sessionId: String
    /// Its name; "Main Session" while it has none.
    public var name: String
    /// What draws it (`SessionRowView::mark`).
    public var mark: String
    public var teamId: String
    /// Its team's name ("Personal" for one without).
    public var team: String

    public init(sessionId: String = "", name: String = "", mark: String = "", teamId: String = "", team: String = "") {
      self.sessionId = sessionId
      self.name = name
      self.mark = mark
      self.teamId = teamId
      self.team = team
    }

    enum CodingKeys: String, CodingKey {
      case sessionId = "session_id"
      case name = "name"
      case mark = "mark"
      case teamId = "team_id"
      case team = "team"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.sessionId = try c.decode(String.self, forKey: .sessionId)
      self.name = try c.decode(String.self, forKey: .name)
      self.mark = try c.decode(String.self, forKey: .mark)
      self.teamId = try c.decodeIfPresent(String.self, forKey: .teamId) ?? ""
      self.team = try c.decodeIfPresent(String.self, forKey: .team) ?? ""
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(sessionId, forKey: .sessionId)
      try c.encode(name, forKey: .name)
      try c.encode(mark, forKey: .mark)
      try c.encode(teamId, forKey: .teamId)
      try c.encode(team, forKey: .team)
    }
  }

  /// Settings: what the list's rows say, and the person's devices (`settings.rs`). What only this device knows (the
  /// theme, the Push level) is the shell's.
  public struct SettingsView: Codable, Hashable, Sendable {
    /// Hub counts and sizes, read only by an authenticated device of this account.
    public var data: DataView?
    /// The account's e-mail, for the row Account; none until the account is read (W3).
    public var account: String?
    /// The person's devices that are in, in the order they joined (the agents are under Agents).
    public var devices: [DeviceRow]
    /// The person's removed devices, in the order they joined (the row "Removed" and its page).
    public var removed: [DeviceRow]
    /// The devices that never finished signing in: offered for removal together.
    public var unfinished: [String]
    /// "Remove the 2 devices that never finished signing in".
    public var removeUnfinished: Text?
    /// The row Agents: "2 agents · 5 sessions"; none without one.
    public var agents: Text?
    /// The page Agents: each program on a computer with its sessions, the most sessions first (the web's
    /// `agentsOf`, `agentsMain`).
    public var agentList: [AgentView]
    /// The line under the page's title: "2 agents on 1 computer · 5 sessions"; none without an agent.
    public var agentsLead: Text?
    /// The row Teams: "3 teams"; none in a room without teams.
    public var teams: Text?
    /// The row Devices: "2 devices".
    public var devicesSays: Text?
    /// The room's key epoch (the version line at the list's foot).
    public var keyEpoch: UInt64
    /// The room's id (hex) and its hub, for the page that proves the room.
    public var room: String?
    public var hub: String?
    /// What each team holds, for the confirm of its delete (its board counted once read on this device).
    public var teamCounts: [TeamCountsView]
    /// The teams being deleted, with how far.
    public var deleting: [TeamDeleteView]
    /// Push on this device, where the platform has push.
    public var push: PushView?
    /// The account's ways in, once read (`AccountAction::ReadAccount`).
    public var login: LoginView?

    public init(data: DataView? = nil, account: String? = nil, devices: [DeviceRow] = [], removed: [DeviceRow] = [], unfinished: [String] = [], removeUnfinished: Text? = nil, agents: Text? = nil, agentList: [AgentView] = [], agentsLead: Text? = nil, teams: Text? = nil, devicesSays: Text? = nil, keyEpoch: UInt64 = 0, room: String? = nil, hub: String? = nil, teamCounts: [TeamCountsView] = [], deleting: [TeamDeleteView] = [], push: PushView? = nil, login: LoginView? = nil) {
      self.data = data
      self.account = account
      self.devices = devices
      self.removed = removed
      self.unfinished = unfinished
      self.removeUnfinished = removeUnfinished
      self.agents = agents
      self.agentList = agentList
      self.agentsLead = agentsLead
      self.teams = teams
      self.devicesSays = devicesSays
      self.keyEpoch = keyEpoch
      self.room = room
      self.hub = hub
      self.teamCounts = teamCounts
      self.deleting = deleting
      self.push = push
      self.login = login
    }

    enum CodingKeys: String, CodingKey {
      case data = "data"
      case account = "account"
      case devices = "devices"
      case removed = "removed"
      case unfinished = "unfinished"
      case removeUnfinished = "remove_unfinished"
      case agents = "agents"
      case agentList = "agent_list"
      case agentsLead = "agents_lead"
      case teams = "teams"
      case devicesSays = "devices_says"
      case keyEpoch = "key_epoch"
      case room = "room"
      case hub = "hub"
      case teamCounts = "team_counts"
      case deleting = "deleting"
      case push = "push"
      case login = "login"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.data = try c.decodeIfPresent(DataView.self, forKey: .data)
      self.account = try c.decodeIfPresent(String.self, forKey: .account)
      self.devices = try c.decode([DeviceRow].self, forKey: .devices)
      self.removed = try c.decodeIfPresent([DeviceRow].self, forKey: .removed) ?? []
      self.unfinished = try c.decodeIfPresent([String].self, forKey: .unfinished) ?? []
      self.removeUnfinished = try c.decodeIfPresent(Text.self, forKey: .removeUnfinished)
      self.agents = try c.decodeIfPresent(Text.self, forKey: .agents)
      self.agentList = try c.decodeIfPresent([AgentView].self, forKey: .agentList) ?? []
      self.agentsLead = try c.decodeIfPresent(Text.self, forKey: .agentsLead)
      self.teams = try c.decodeIfPresent(Text.self, forKey: .teams)
      self.devicesSays = try c.decodeIfPresent(Text.self, forKey: .devicesSays)
      self.keyEpoch = try c.decodeIfPresent(UInt64.self, forKey: .keyEpoch) ?? 0
      self.room = try c.decodeIfPresent(String.self, forKey: .room)
      self.hub = try c.decodeIfPresent(String.self, forKey: .hub)
      self.teamCounts = try c.decodeIfPresent([TeamCountsView].self, forKey: .teamCounts) ?? []
      self.deleting = try c.decodeIfPresent([TeamDeleteView].self, forKey: .deleting) ?? []
      self.push = try c.decodeIfPresent(PushView.self, forKey: .push)
      self.login = try c.decodeIfPresent(LoginView.self, forKey: .login)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encodeIfPresent(data, forKey: .data)
      try c.encode(account, forKey: .account)
      try c.encode(devices, forKey: .devices)
      if !removed.isEmpty { try c.encode(removed, forKey: .removed) }
      if !unfinished.isEmpty { try c.encode(unfinished, forKey: .unfinished) }
      try c.encodeIfPresent(removeUnfinished, forKey: .removeUnfinished)
      try c.encodeIfPresent(agents, forKey: .agents)
      if !agentList.isEmpty { try c.encode(agentList, forKey: .agentList) }
      try c.encodeIfPresent(agentsLead, forKey: .agentsLead)
      try c.encodeIfPresent(teams, forKey: .teams)
      try c.encodeIfPresent(devicesSays, forKey: .devicesSays)
      try c.encode(keyEpoch, forKey: .keyEpoch)
      try c.encodeIfPresent(room, forKey: .room)
      try c.encodeIfPresent(hub, forKey: .hub)
      if !teamCounts.isEmpty { try c.encode(teamCounts, forKey: .teamCounts) }
      if !deleting.isEmpty { try c.encode(deleting, forKey: .deleting) }
      try c.encodeIfPresent(push, forKey: .push)
      try c.encodeIfPresent(login, forKey: .login)
    }
  }

  /// Settings → Data: presentation belongs to the core, never the native HTTP executor.
  public struct DataView: Codable, Hashable, Sendable {
    public var state: String
    public var rows: [DataRow]
    public var says: Text?

    public init(state: String = "", rows: [DataRow] = [], says: Text? = nil) {
      self.state = state
      self.rows = rows
      self.says = says
    }

    enum CodingKeys: String, CodingKey {
      case state = "state"
      case rows = "rows"
      case says = "says"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.state = try c.decode(String.self, forKey: .state)
      self.rows = try c.decode([DataRow].self, forKey: .rows)
      self.says = try c.decodeIfPresent(Text.self, forKey: .says)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(state, forKey: .state)
      try c.encode(rows, forKey: .rows)
      try c.encode(says, forKey: .says)
    }
  }

  public struct DataRow: Codable, Hashable, Sendable {
    public var id: String
    public var label: Text
    public var value: Text

    public init(id: String = "", label: Text = Text(), value: Text = Text()) {
      self.id = id
      self.label = label
      self.value = value
    }

    enum CodingKeys: String, CodingKey {
      case id = "id"
      case label = "label"
      case value = "value"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.id = try c.decode(String.self, forKey: .id)
      self.label = try c.decode(Text.self, forKey: .label)
      self.value = try c.decode(Text.self, forKey: .value)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(id, forKey: .id)
      try c.encode(label, forKey: .label)
      try c.encode(value, forKey: .value)
    }
  }

  /// What a team holds: what its delete takes away.
  public struct TeamCountsView: Codable, Hashable, Sendable {
    public var teamId: String
    public var sessions: UInt64
    public var helpers: UInt64
    public var archived: UInt64
    public var openCards: UInt64
    public var doneCards: UInt64
    /// Agent devices that leave the room with it.
    public var agents: UInt64
    /// Shapes on its board, pictures and notes among them; none while the board is not read.
    public var board: UInt64?
    public var pictures: UInt64?
    public var notes: UInt64?
    public var files: UInt64
    public var artifacts: UInt64
    public var goals: UInt64
    /// Entries of its knowledge.
    public var knowledge: UInt64

    public init(teamId: String = "", sessions: UInt64 = 0, helpers: UInt64 = 0, archived: UInt64 = 0, openCards: UInt64 = 0, doneCards: UInt64 = 0, agents: UInt64 = 0, board: UInt64? = nil, pictures: UInt64? = nil, notes: UInt64? = nil, files: UInt64 = 0, artifacts: UInt64 = 0, goals: UInt64 = 0, knowledge: UInt64 = 0) {
      self.teamId = teamId
      self.sessions = sessions
      self.helpers = helpers
      self.archived = archived
      self.openCards = openCards
      self.doneCards = doneCards
      self.agents = agents
      self.board = board
      self.pictures = pictures
      self.notes = notes
      self.files = files
      self.artifacts = artifacts
      self.goals = goals
      self.knowledge = knowledge
    }

    enum CodingKeys: String, CodingKey {
      case teamId = "team_id"
      case sessions = "sessions"
      case helpers = "helpers"
      case archived = "archived"
      case openCards = "open_cards"
      case doneCards = "done_cards"
      case agents = "agents"
      case board = "board"
      case pictures = "pictures"
      case notes = "notes"
      case files = "files"
      case artifacts = "artifacts"
      case goals = "goals"
      case knowledge = "knowledge"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.teamId = try c.decode(String.self, forKey: .teamId)
      self.sessions = try c.decode(UInt64.self, forKey: .sessions)
      self.helpers = try c.decode(UInt64.self, forKey: .helpers)
      self.archived = try c.decode(UInt64.self, forKey: .archived)
      self.openCards = try c.decode(UInt64.self, forKey: .openCards)
      self.doneCards = try c.decode(UInt64.self, forKey: .doneCards)
      self.agents = try c.decode(UInt64.self, forKey: .agents)
      self.board = try c.decodeIfPresent(UInt64.self, forKey: .board)
      self.pictures = try c.decodeIfPresent(UInt64.self, forKey: .pictures)
      self.notes = try c.decodeIfPresent(UInt64.self, forKey: .notes)
      self.files = try c.decode(UInt64.self, forKey: .files)
      self.artifacts = try c.decode(UInt64.self, forKey: .artifacts)
      self.goals = try c.decode(UInt64.self, forKey: .goals)
      self.knowledge = try c.decodeIfPresent(UInt64.self, forKey: .knowledge) ?? 0
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(teamId, forKey: .teamId)
      try c.encode(sessions, forKey: .sessions)
      try c.encode(helpers, forKey: .helpers)
      try c.encode(archived, forKey: .archived)
      try c.encode(openCards, forKey: .openCards)
      try c.encode(doneCards, forKey: .doneCards)
      try c.encode(agents, forKey: .agents)
      try c.encodeIfPresent(board, forKey: .board)
      try c.encodeIfPresent(pictures, forKey: .pictures)
      try c.encodeIfPresent(notes, forKey: .notes)
      try c.encode(files, forKey: .files)
      try c.encode(artifacts, forKey: .artifacts)
      try c.encode(goals, forKey: .goals)
      try c.encode(knowledge, forKey: .knowledge)
    }
  }

  /// An Artifact in the gallery: what an agent published.
  public struct ArtifactView: Codable, Hashable, Sendable {
    public var id: String
    public var title: String
    /// "page", "image", "document", …: what the agent named it; "" when it named nothing.
    public var kind: String
    /// The session that published it (its key), and its name.
    public var sessionId: String?
    public var session: String
    public var sentAt: UInt64
    /// Its files (ids of `ViewModel.files`), in its order.
    public var files: [String]

    public init(id: String = "", title: String = "", kind: String = "", sessionId: String? = nil, session: String = "", sentAt: UInt64 = 0, files: [String] = []) {
      self.id = id
      self.title = title
      self.kind = kind
      self.sessionId = sessionId
      self.session = session
      self.sentAt = sentAt
      self.files = files
    }

    enum CodingKeys: String, CodingKey {
      case id = "id"
      case title = "title"
      case kind = "kind"
      case sessionId = "session_id"
      case session = "session"
      case sentAt = "sent_at"
      case files = "files"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.id = try c.decode(String.self, forKey: .id)
      self.title = try c.decode(String.self, forKey: .title)
      self.kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? ""
      self.sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId)
      self.session = try c.decodeIfPresent(String.self, forKey: .session) ?? ""
      self.sentAt = try c.decode(UInt64.self, forKey: .sentAt)
      self.files = try c.decodeIfPresent([String].self, forKey: .files) ?? []
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(id, forKey: .id)
      try c.encode(title, forKey: .title)
      try c.encode(kind, forKey: .kind)
      try c.encodeIfPresent(sessionId, forKey: .sessionId)
      try c.encode(session, forKey: .session)
      try c.encode(sentAt, forKey: .sentAt)
      if !files.isEmpty { try c.encode(files, forKey: .files) }
    }
  }

  /// Push on this device.
  public struct PushView: Codable, Hashable, Sendable {
    /// "off", "all", "knocking".
    public var level: String
    /// A change of the level is on its way.
    public var busy: Bool

    public init(level: String = "", busy: Bool = false) {
      self.level = level
      self.busy = busy
    }

    enum CodingKeys: String, CodingKey {
      case level = "level"
      case busy = "busy"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.level = try c.decode(String.self, forKey: .level)
      self.busy = try c.decodeIfPresent(Bool.self, forKey: .busy) ?? false
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(level, forKey: .level)
      try c.encode(busy, forKey: .busy)
    }
  }

  /// A team's delete in progress: units done of the total.
  public struct TeamDeleteView: Codable, Hashable, Sendable {
    public var teamId: String
    public var done: UInt64
    public var total: UInt64

    public init(teamId: String = "", done: UInt64 = 0, total: UInt64 = 0) {
      self.teamId = teamId
      self.done = done
      self.total = total
    }

    enum CodingKeys: String, CodingKey {
      case teamId = "team_id"
      case done = "done"
      case total = "total"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.teamId = try c.decode(String.self, forKey: .teamId)
      self.done = try c.decode(UInt64.self, forKey: .done)
      self.total = try c.decode(UInt64.self, forKey: .total)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(teamId, forKey: .teamId)
      try c.encode(done, forKey: .done)
      try c.encode(total, forKey: .total)
    }
  }

  /// The account's ways in, for the page Account: what can be changed and how it is proved.
  public struct LoginView: Codable, Hashable, Sendable {
    public var email: String?
    /// The account's id as printed on the kit (a UUID).
    public var account: String
    public var hasPassword: Bool
    /// The kit is salted with the e-mail ("email") or with the id ("id").
    public var kitForm: String
    public var passkeys: [PasskeyView]

    public init(email: String? = nil, account: String = "", hasPassword: Bool = false, kitForm: String = "", passkeys: [PasskeyView] = []) {
      self.email = email
      self.account = account
      self.hasPassword = hasPassword
      self.kitForm = kitForm
      self.passkeys = passkeys
    }

    enum CodingKeys: String, CodingKey {
      case email = "email"
      case account = "account"
      case hasPassword = "has_password"
      case kitForm = "kit_form"
      case passkeys = "passkeys"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.email = try c.decodeIfPresent(String.self, forKey: .email)
      self.account = try c.decode(String.self, forKey: .account)
      self.hasPassword = try c.decode(Bool.self, forKey: .hasPassword)
      self.kitForm = try c.decode(String.self, forKey: .kitForm)
      self.passkeys = try c.decodeIfPresent([PasskeyView].self, forKey: .passkeys) ?? []
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encodeIfPresent(email, forKey: .email)
      try c.encode(account, forKey: .account)
      try c.encode(hasPassword, forKey: .hasPassword)
      try c.encode(kitForm, forKey: .kitForm)
      if !passkeys.isEmpty { try c.encode(passkeys, forKey: .passkeys) }
    }
  }

  public struct PasskeyView: Codable, Hashable, Sendable {
    /// base64url: what `RemovePasskey` names.
    public var credentialId: String
    public var createdAt: UInt64
    public var lastUsedAt: UInt64?

    public init(credentialId: String = "", createdAt: UInt64 = 0, lastUsedAt: UInt64? = nil) {
      self.credentialId = credentialId
      self.createdAt = createdAt
      self.lastUsedAt = lastUsedAt
    }

    enum CodingKeys: String, CodingKey {
      case credentialId = "credential_id"
      case createdAt = "created_at"
      case lastUsedAt = "last_used_at"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.credentialId = try c.decode(String.self, forKey: .credentialId)
      self.createdAt = try c.decode(UInt64.self, forKey: .createdAt)
      self.lastUsedAt = try c.decodeIfPresent(UInt64.self, forKey: .lastUsedAt)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(credentialId, forKey: .credentialId)
      try c.encode(createdAt, forKey: .createdAt)
      try c.encodeIfPresent(lastUsedAt, forKey: .lastUsedAt)
    }
  }

  /// An agent: a program on one computer ("Claude Code on MacBook Pro"), with its sessions.
  public struct AgentView: Codable, Hashable, Sendable {
    /// "Claude Code · MacBook Pro": what Remove names (the action's `key`).
    public var key: String
    /// "Claude Code", "Codex", "Agent".
    public var program: String
    /// The computer's name; "" when it named none.
    public var host: String
    /// "Claude Code on MacBook Pro", "Codex on an unnamed computer".
    public var name: Text
    /// One of its sessions is connected.
    public var online: Bool
    /// "connected", or "away · last seen" (the shell writes the time of `seen_ms` after it).
    public var state: Text
    /// When one of its sessions last did something.
    public var seenMs: UInt64
    /// "2 sessions, 1 helper".
    public var count: Text
    /// Every session of it, its helpers too.
    public var total: UInt32
    /// Its main sessions (a helper whose main is its own counts under that main), in the list's order.
    public var sessions: [AgentSessionView]
    /// The agent devices Remove takes out of the room (never this device, never a person's).
    public var devices: [String]
    /// What Remove does, said before it; none when there is nothing to remove.
    public var remove: Text?
    /// Its account and how much of it is used (the connector's `account`); none without a plan or an e-mail.
    public var usage: UsageView?

    public init(key: String = "", program: String = "", host: String = "", name: Text = Text(), online: Bool = false, state: Text = Text(), seenMs: UInt64 = 0, count: Text = Text(), total: UInt32 = 0, sessions: [AgentSessionView] = [], devices: [String] = [], remove: Text? = nil, usage: UsageView? = nil) {
      self.key = key
      self.program = program
      self.host = host
      self.name = name
      self.online = online
      self.state = state
      self.seenMs = seenMs
      self.count = count
      self.total = total
      self.sessions = sessions
      self.devices = devices
      self.remove = remove
      self.usage = usage
    }

    enum CodingKeys: String, CodingKey {
      case key = "key"
      case program = "program"
      case host = "host"
      case name = "name"
      case online = "online"
      case state = "state"
      case seenMs = "seen_ms"
      case count = "count"
      case total = "total"
      case sessions = "sessions"
      case devices = "devices"
      case remove = "remove"
      case usage = "usage"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.key = try c.decode(String.self, forKey: .key)
      self.program = try c.decode(String.self, forKey: .program)
      self.host = try c.decodeIfPresent(String.self, forKey: .host) ?? ""
      self.name = try c.decode(Text.self, forKey: .name)
      self.online = try c.decodeIfPresent(Bool.self, forKey: .online) ?? false
      self.state = try c.decode(Text.self, forKey: .state)
      self.seenMs = try c.decodeIfPresent(UInt64.self, forKey: .seenMs) ?? 0
      self.count = try c.decode(Text.self, forKey: .count)
      self.total = try c.decodeIfPresent(UInt32.self, forKey: .total) ?? 0
      self.sessions = try c.decode([AgentSessionView].self, forKey: .sessions)
      self.devices = try c.decodeIfPresent([String].self, forKey: .devices) ?? []
      self.remove = try c.decodeIfPresent(Text.self, forKey: .remove)
      self.usage = try c.decodeIfPresent(UsageView.self, forKey: .usage)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(key, forKey: .key)
      try c.encode(program, forKey: .program)
      try c.encode(host, forKey: .host)
      try c.encode(name, forKey: .name)
      try c.encode(online, forKey: .online)
      try c.encode(state, forKey: .state)
      try c.encode(seenMs, forKey: .seenMs)
      try c.encode(count, forKey: .count)
      try c.encode(total, forKey: .total)
      try c.encode(sessions, forKey: .sessions)
      if !devices.isEmpty { try c.encode(devices, forKey: .devices) }
      try c.encodeIfPresent(remove, forKey: .remove)
      try c.encodeIfPresent(usage, forKey: .usage)
    }
  }

  /// A main session of an agent on the page Agents.
  public struct AgentSessionView: Codable, Hashable, Sendable {
    /// Its key (`Screen::Session`).
    public var id: String
    public var slug: String
    public var name: Text
    /// What draws it (`SessionRowView::mark`).
    public var mark: String
    /// "Work team".
    public var team: Text
    /// Its folder on the computer; "" when unknown.
    public var folder: String
    public var helpers: UInt32
    /// "+2 helpers"; none without one.
    public var helpersSays: Text?
    public var online: Bool
    /// "connected", "away".
    public var state: Text

    public init(id: String = "", slug: String = "", name: Text = Text(), mark: String = "", team: Text = Text(), folder: String = "", helpers: UInt32 = 0, helpersSays: Text? = nil, online: Bool = false, state: Text = Text()) {
      self.id = id
      self.slug = slug
      self.name = name
      self.mark = mark
      self.team = team
      self.folder = folder
      self.helpers = helpers
      self.helpersSays = helpersSays
      self.online = online
      self.state = state
    }

    enum CodingKeys: String, CodingKey {
      case id = "id"
      case slug = "slug"
      case name = "name"
      case mark = "mark"
      case team = "team"
      case folder = "folder"
      case helpers = "helpers"
      case helpersSays = "helpers_says"
      case online = "online"
      case state = "state"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.id = try c.decode(String.self, forKey: .id)
      self.slug = try c.decode(String.self, forKey: .slug)
      self.name = try c.decode(Text.self, forKey: .name)
      self.mark = try c.decodeIfPresent(String.self, forKey: .mark) ?? ""
      self.team = try c.decode(Text.self, forKey: .team)
      self.folder = try c.decodeIfPresent(String.self, forKey: .folder) ?? ""
      self.helpers = try c.decodeIfPresent(UInt32.self, forKey: .helpers) ?? 0
      self.helpersSays = try c.decodeIfPresent(Text.self, forKey: .helpersSays)
      self.online = try c.decodeIfPresent(Bool.self, forKey: .online) ?? false
      self.state = try c.decode(Text.self, forKey: .state)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(id, forKey: .id)
      try c.encode(slug, forKey: .slug)
      try c.encode(name, forKey: .name)
      try c.encode(mark, forKey: .mark)
      try c.encode(team, forKey: .team)
      if !folder.isEmpty { try c.encode(folder, forKey: .folder) }
      try c.encode(helpers, forKey: .helpers)
      try c.encodeIfPresent(helpersSays, forKey: .helpersSays)
      try c.encode(online, forKey: .online)
      try c.encode(state, forKey: .state)
    }
  }

  /// An agent's account: its plan, e-mail and meters.
  public struct UsageView: Codable, Hashable, Sendable {
    /// "Claude Max", "ChatGPT Pro Lite"; "" without a plan.
    public var plan: String
    public var email: String
    /// The 5-hour window and the week, those it said; a window that started again since is left out.
    public var meters: [MeterView]
    /// "1,200 credits", "2 full resets" (Codex).
    public var facts: [Text]

    public init(plan: String = "", email: String = "", meters: [MeterView] = [], facts: [Text] = []) {
      self.plan = plan
      self.email = email
      self.meters = meters
      self.facts = facts
    }

    enum CodingKeys: String, CodingKey {
      case plan = "plan"
      case email = "email"
      case meters = "meters"
      case facts = "facts"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.plan = try c.decodeIfPresent(String.self, forKey: .plan) ?? ""
      self.email = try c.decodeIfPresent(String.self, forKey: .email) ?? ""
      self.meters = try c.decodeIfPresent([MeterView].self, forKey: .meters) ?? []
      self.facts = try c.decodeIfPresent([Text].self, forKey: .facts) ?? []
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      if !plan.isEmpty { try c.encode(plan, forKey: .plan) }
      if !email.isEmpty { try c.encode(email, forKey: .email) }
      if !meters.isEmpty { try c.encode(meters, forKey: .meters) }
      if !facts.isEmpty { try c.encode(facts, forKey: .facts) }
    }
  }

  public struct MeterView: Codable, Hashable, Sendable {
    /// "five_hour", "weekly".
    public var key: String
    /// "5 h", "week".
    public var label: String
    /// "5-hour window", "This week".
    public var long: String
    /// Percent used, 0 to 100.
    public var used: UInt32
    /// At 80 % or more.
    public var hot: Bool
    /// When it starts again (the shell writes the time).
    public var resetMs: UInt64?

    public init(key: String = "", label: String = "", long: String = "", used: UInt32 = 0, hot: Bool = false, resetMs: UInt64? = nil) {
      self.key = key
      self.label = label
      self.long = long
      self.used = used
      self.hot = hot
      self.resetMs = resetMs
    }

    enum CodingKeys: String, CodingKey {
      case key = "key"
      case label = "label"
      case long = "long"
      case used = "used"
      case hot = "hot"
      case resetMs = "reset_ms"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.key = try c.decode(String.self, forKey: .key)
      self.label = try c.decode(String.self, forKey: .label)
      self.long = try c.decode(String.self, forKey: .long)
      self.used = try c.decode(UInt32.self, forKey: .used)
      self.hot = try c.decodeIfPresent(Bool.self, forKey: .hot) ?? false
      self.resetMs = try c.decodeIfPresent(UInt64.self, forKey: .resetMs)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(key, forKey: .key)
      try c.encode(label, forKey: .label)
      try c.encode(long, forKey: .long)
      try c.encode(used, forKey: .used)
      try c.encode(hot, forKey: .hot)
      try c.encodeIfPresent(resetMs, forKey: .resetMs)
    }
  }

  /// One device of the person.
  public struct DeviceRow: Codable, Hashable, Sendable {
    public var id: String
    /// Its name; "Device" while it has named itself nothing.
    public var name: String
    public var thisDevice: Bool
    /// "human" or "agent".
    public var role: String
    /// In the room (not removed).
    public var active: Bool
    /// The green dot: in, and connected (this device always is).
    public var online: Bool
    /// "this_device", "unfinished" (never finished signing in), "online", "away", "removed".
    public var state: String
    /// The state in words ("this device", "never finished signing in").
    public var says: Text
    /// The key fingerprint from the signed member list: it must look the same on every device.
    public var fingerprint: String
    /// Its drawing: "phone", "laptop", "terminal".
    public var icon: String
    /// When it joined, if known.
    public var addedMs: UInt64?
    /// Last contact with the hub, when known. It confers no membership authority.
    public var lastSeenMs: UInt64?
    /// Core-formatted last-seen text for an offline device.
    public var seen: Text?

    public init(id: String = "", name: String = "", thisDevice: Bool = false, role: String = "", active: Bool = false, online: Bool = false, state: String = "", says: Text = Text(), fingerprint: String = "", icon: String = "", addedMs: UInt64? = nil, lastSeenMs: UInt64? = nil, seen: Text? = nil) {
      self.id = id
      self.name = name
      self.thisDevice = thisDevice
      self.role = role
      self.active = active
      self.online = online
      self.state = state
      self.says = says
      self.fingerprint = fingerprint
      self.icon = icon
      self.addedMs = addedMs
      self.lastSeenMs = lastSeenMs
      self.seen = seen
    }

    enum CodingKeys: String, CodingKey {
      case id = "id"
      case name = "name"
      case thisDevice = "this_device"
      case role = "role"
      case active = "active"
      case online = "online"
      case state = "state"
      case says = "says"
      case fingerprint = "fingerprint"
      case icon = "icon"
      case addedMs = "added_ms"
      case lastSeenMs = "last_seen_ms"
      case seen = "seen"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.id = try c.decode(String.self, forKey: .id)
      self.name = try c.decode(String.self, forKey: .name)
      self.thisDevice = try c.decode(Bool.self, forKey: .thisDevice)
      self.role = try c.decodeIfPresent(String.self, forKey: .role) ?? ""
      self.active = try c.decodeIfPresent(Bool.self, forKey: .active) ?? false
      self.online = try c.decodeIfPresent(Bool.self, forKey: .online) ?? false
      self.state = try c.decodeIfPresent(String.self, forKey: .state) ?? ""
      self.says = try c.decodeIfPresent(Text.self, forKey: .says) ?? Text()
      self.fingerprint = try c.decodeIfPresent(String.self, forKey: .fingerprint) ?? ""
      self.icon = try c.decodeIfPresent(String.self, forKey: .icon) ?? ""
      self.addedMs = try c.decodeIfPresent(UInt64.self, forKey: .addedMs)
      self.lastSeenMs = try c.decodeIfPresent(UInt64.self, forKey: .lastSeenMs)
      self.seen = try c.decodeIfPresent(Text.self, forKey: .seen)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(id, forKey: .id)
      try c.encode(name, forKey: .name)
      try c.encode(thisDevice, forKey: .thisDevice)
      try c.encode(role, forKey: .role)
      try c.encode(active, forKey: .active)
      try c.encode(online, forKey: .online)
      try c.encode(state, forKey: .state)
      try c.encode(says, forKey: .says)
      try c.encode(fingerprint, forKey: .fingerprint)
      try c.encode(icon, forKey: .icon)
      try c.encodeIfPresent(addedMs, forKey: .addedMs)
      try c.encodeIfPresent(lastSeenMs, forKey: .lastSeenMs)
      try c.encodeIfPresent(seen, forKey: .seen)
    }
  }

  /// The account's flows as a screen shows them. `step` names the screen; the fields it needs are filled.
  /// `Debug` leaves out the invite link and the Kit words: they open the account.
  public struct AccountView: Codable, Hashable, Sendable {
    /// "none", "sign_in", "found", "join", "compare_emoji", "keep_kit", "invite", "recover", "working".
    public var step: String
    /// The invite in progress (for `ConfirmEmoji`).
    public var inviteId: String?
    /// An invite link to show as text or QR code.
    public var link: String?
    /// Copyable instructions for this invite, chosen by the core. Contains the invite secret like `link`.
    public var connectPrompt: String?
    /// The corresponding Claude Code command. Contains the invite secret; never log it.
    public var connectCommand: String?
    /// The six emoji to compare, with their words.
    public var emoji: [EmojiView]
    /// The Emergency Kit words to keep, shown once.
    public var kit: [String]
    /// Self-join asks waiting for "Allow" or "Deny" (for `AnswerAsk`), and those allowed whose session is still
    /// joining (`joining`).
    public var asks: [AskView]
    public var problem: Text?
    /// The invite this device made and shows (not a self-join's): what it is for, until when, who came; it stays
    /// `joined` once its newcomer is in, until `DropInvite` or the next invite.
    public var invite: InviteView?
    /// The account's Emergency Kit was never saved (downloaded, printed or shown, then `KitKept`): the screens show
    /// the kit's page first. The room register `kit` of every human device of the person says it.
    public var kitDue: Bool
    /// What the kit's sheet names, once the account was read: its e-mail, its id (as printed), and the address its
    /// QR code holds (`https://<app>/#k1.<hub, base64url>.<id, 32 hex>`: the recovery screen with both filled in; no
    /// word of the kit).
    public var kitEmail: String?
    public var kitAccount: String?
    public var kitAddress: String?
    /// A word on the start screen about how this device came to be signed out: "Logged out." after the person's
    /// own sign-out, or that another device removed it. Gone with the next step.
    public var notice: Text?
    /// A sign-in that was cut off before all its sessions were joined (the app was closed or reloaded meanwhile):
    /// the device is in the room and the app runs on, and these words ask for the way in again (`SignIn`, its
    /// passkey or its kit), which finishes the joins. None otherwise.
    public var resume: Text?

    public init(step: String = "", inviteId: String? = nil, link: String? = nil, connectPrompt: String? = nil, connectCommand: String? = nil, emoji: [EmojiView] = [], kit: [String] = [], asks: [AskView] = [], problem: Text? = nil, invite: InviteView? = nil, kitDue: Bool = false, kitEmail: String? = nil, kitAccount: String? = nil, kitAddress: String? = nil, notice: Text? = nil, resume: Text? = nil) {
      self.step = step
      self.inviteId = inviteId
      self.link = link
      self.connectPrompt = connectPrompt
      self.connectCommand = connectCommand
      self.emoji = emoji
      self.kit = kit
      self.asks = asks
      self.problem = problem
      self.invite = invite
      self.kitDue = kitDue
      self.kitEmail = kitEmail
      self.kitAccount = kitAccount
      self.kitAddress = kitAddress
      self.notice = notice
      self.resume = resume
    }

    enum CodingKeys: String, CodingKey {
      case step = "step"
      case inviteId = "invite_id"
      case link = "link"
      case connectPrompt = "connect_prompt"
      case connectCommand = "connect_command"
      case emoji = "emoji"
      case kit = "kit"
      case asks = "asks"
      case problem = "problem"
      case invite = "invite"
      case kitDue = "kit_due"
      case kitEmail = "kit_email"
      case kitAccount = "kit_account"
      case kitAddress = "kit_address"
      case notice = "notice"
      case resume = "resume"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.step = try c.decode(String.self, forKey: .step)
      self.inviteId = try c.decodeIfPresent(String.self, forKey: .inviteId)
      self.link = try c.decodeIfPresent(String.self, forKey: .link)
      self.connectPrompt = try c.decodeIfPresent(String.self, forKey: .connectPrompt)
      self.connectCommand = try c.decodeIfPresent(String.self, forKey: .connectCommand)
      self.emoji = try c.decodeIfPresent([EmojiView].self, forKey: .emoji) ?? []
      self.kit = try c.decodeIfPresent([String].self, forKey: .kit) ?? []
      self.asks = try c.decodeIfPresent([AskView].self, forKey: .asks) ?? []
      self.problem = try c.decodeIfPresent(Text.self, forKey: .problem)
      self.invite = try c.decodeIfPresent(InviteView.self, forKey: .invite)
      self.kitDue = try c.decodeIfPresent(Bool.self, forKey: .kitDue) ?? false
      self.kitEmail = try c.decodeIfPresent(String.self, forKey: .kitEmail)
      self.kitAccount = try c.decodeIfPresent(String.self, forKey: .kitAccount)
      self.kitAddress = try c.decodeIfPresent(String.self, forKey: .kitAddress)
      self.notice = try c.decodeIfPresent(Text.self, forKey: .notice)
      self.resume = try c.decodeIfPresent(Text.self, forKey: .resume)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(step, forKey: .step)
      try c.encodeIfPresent(inviteId, forKey: .inviteId)
      try c.encodeIfPresent(link, forKey: .link)
      try c.encodeIfPresent(connectPrompt, forKey: .connectPrompt)
      try c.encodeIfPresent(connectCommand, forKey: .connectCommand)
      if !emoji.isEmpty { try c.encode(emoji, forKey: .emoji) }
      if !kit.isEmpty { try c.encode(kit, forKey: .kit) }
      if !asks.isEmpty { try c.encode(asks, forKey: .asks) }
      try c.encodeIfPresent(problem, forKey: .problem)
      try c.encodeIfPresent(invite, forKey: .invite)
      try c.encode(kitDue, forKey: .kitDue)
      try c.encodeIfPresent(kitEmail, forKey: .kitEmail)
      try c.encodeIfPresent(kitAccount, forKey: .kitAccount)
      try c.encodeIfPresent(kitAddress, forKey: .kitAddress)
      try c.encodeIfPresent(notice, forKey: .notice)
      try c.encodeIfPresent(resume, forKey: .resume)
    }
  }

  public struct EmojiView: Codable, Hashable, Sendable {
    public var emoji: String
    public var word: String

    public init(emoji: String = "", word: String = "") {
      self.emoji = emoji
      self.word = word
    }

    enum CodingKeys: String, CodingKey {
      case emoji = "emoji"
      case word = "word"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.emoji = try c.decode(String.self, forKey: .emoji)
      self.word = try c.decode(String.self, forKey: .word)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(emoji, forKey: .emoji)
      try c.encode(word, forKey: .word)
    }
  }

  public struct AskView: Codable, Hashable, Sendable {
    public var nonce: String
    /// What the vouching agent says it is: account, name, host (its word, shown as such).
    public var says: Text
    /// The asking session's key (its main, which vouches).
    public var sessionId: String
    /// The name the new session gets.
    public var name: String
    /// The computer and the folder it asks from (the agent's word); "" when it named none.
    public var host: String
    public var folder: String
    /// "Claude" or "Codex".
    public var kind: String
    /// Who vouches: the asking session's name.
    public var vouchedBy: String
    /// Allowed: its link is out and the new session is not in yet (no Allow or Deny any more).
    public var joining: Bool

    public init(nonce: String = "", says: Text = Text(), sessionId: String = "", name: String = "", host: String = "", folder: String = "", kind: String = "", vouchedBy: String = "", joining: Bool = false) {
      self.nonce = nonce
      self.says = says
      self.sessionId = sessionId
      self.name = name
      self.host = host
      self.folder = folder
      self.kind = kind
      self.vouchedBy = vouchedBy
      self.joining = joining
    }

    enum CodingKeys: String, CodingKey {
      case nonce = "nonce"
      case says = "says"
      case sessionId = "session_id"
      case name = "name"
      case host = "host"
      case folder = "folder"
      case kind = "kind"
      case vouchedBy = "vouched_by"
      case joining = "joining"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.nonce = try c.decode(String.self, forKey: .nonce)
      self.says = try c.decode(Text.self, forKey: .says)
      self.sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId) ?? ""
      self.name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
      self.host = try c.decodeIfPresent(String.self, forKey: .host) ?? ""
      self.folder = try c.decodeIfPresent(String.self, forKey: .folder) ?? ""
      self.kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? ""
      self.vouchedBy = try c.decodeIfPresent(String.self, forKey: .vouchedBy) ?? ""
      self.joining = try c.decodeIfPresent(Bool.self, forKey: .joining) ?? false
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(nonce, forKey: .nonce)
      try c.encode(says, forKey: .says)
      try c.encode(sessionId, forKey: .sessionId)
      try c.encode(name, forKey: .name)
      try c.encode(host, forKey: .host)
      try c.encode(folder, forKey: .folder)
      try c.encode(kind, forKey: .kind)
      try c.encode(vouchedBy, forKey: .vouchedBy)
      try c.encode(joining, forKey: .joining)
    }
  }

  /// An invite this device made, as its page shows it.
  public struct InviteView: Codable, Hashable, Sendable {
    public var inviteId: String
    public var title: Text
    public var notice: Text
    public var computer: Bool
    /// "human" (a device of the person) or "agent".
    public var role: String
    /// "open" (waits for the newcomer), "confirm_code" (the emoji to compare), "adding", "joined".
    public var state: String
    /// When the link ends unused (ms).
    public var expiresMs: UInt64
    /// The newcomer's name once it is known ("" before): the device's own, or the agent's session.
    public var newcomer: String

    public init(inviteId: String = "", title: Text = Text(), notice: Text = Text(), computer: Bool = false, role: String = "", state: String = "", expiresMs: UInt64 = 0, newcomer: String = "") {
      self.inviteId = inviteId
      self.title = title
      self.notice = notice
      self.computer = computer
      self.role = role
      self.state = state
      self.expiresMs = expiresMs
      self.newcomer = newcomer
    }

    enum CodingKeys: String, CodingKey {
      case inviteId = "invite_id"
      case title = "title"
      case notice = "notice"
      case computer = "computer"
      case role = "role"
      case state = "state"
      case expiresMs = "expires_ms"
      case newcomer = "newcomer"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.inviteId = try c.decode(String.self, forKey: .inviteId)
      self.title = try c.decodeIfPresent(Text.self, forKey: .title) ?? Text()
      self.notice = try c.decodeIfPresent(Text.self, forKey: .notice) ?? Text()
      self.computer = try c.decodeIfPresent(Bool.self, forKey: .computer) ?? false
      self.role = try c.decode(String.self, forKey: .role)
      self.state = try c.decode(String.self, forKey: .state)
      self.expiresMs = try c.decodeIfPresent(UInt64.self, forKey: .expiresMs) ?? 0
      self.newcomer = try c.decodeIfPresent(String.self, forKey: .newcomer) ?? ""
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(inviteId, forKey: .inviteId)
      try c.encode(title, forKey: .title)
      try c.encode(notice, forKey: .notice)
      try c.encode(computer, forKey: .computer)
      try c.encode(role, forKey: .role)
      try c.encode(state, forKey: .state)
      try c.encode(expiresMs, forKey: .expiresMs)
      if !newcomer.isEmpty { try c.encode(newcomer, forKey: .newcomer) }
    }
  }

  /// A team's Scribble Board small: its shapes as `BoardView` has them, without a stroke's times, force and tilt.
  public struct ThumbView: Codable, Hashable, Sendable {
    public var teamId: String
    /// `desk/<32 hex>`.
    public var boardId: String
    /// "loading" while it is read on this device, else as `BoardView.state`.
    public var state: String
    /// How many shapes it holds (once read).
    public var count: UInt64
    public var shapes: [BoardShape]

    public init(teamId: String = "", boardId: String = "", state: String = "", count: UInt64 = 0, shapes: [BoardShape] = []) {
      self.teamId = teamId
      self.boardId = boardId
      self.state = state
      self.count = count
      self.shapes = shapes
    }

    enum CodingKeys: String, CodingKey {
      case teamId = "team_id"
      case boardId = "board_id"
      case state = "state"
      case count = "count"
      case shapes = "shapes"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.teamId = try c.decode(String.self, forKey: .teamId)
      self.boardId = try c.decode(String.self, forKey: .boardId)
      self.state = try c.decode(String.self, forKey: .state)
      self.count = try c.decodeIfPresent(UInt64.self, forKey: .count) ?? 0
      self.shapes = try c.decodeIfPresent([BoardShape].self, forKey: .shapes) ?? []
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(teamId, forKey: .teamId)
      try c.encode(boardId, forKey: .boardId)
      try c.encode(state, forKey: .state)
      try c.encode(count, forKey: .count)
      if !shapes.isEmpty { try c.encode(shapes, forKey: .shapes) }
    }
  }

  /// A Scribble Board (spec/v1.md 10): what its items add up to on this device, ready to draw.
  public struct BoardView: Codable, Hashable, Sendable {
    /// `desk/<32 hex>`.
    public var boardId: String
    /// "loading" (its snapshot and the items after it are read), "ready", "newer_version" (an item needs a newer
    /// Trommi: what it did is not shown), "withheld" (an item could not be read on this device).
    public var state: String
    /// Every shape in drawing order: by layer (`z`), then as they were made; strokes others are still drawing last.
    public var shapes: [BoardShape]

    public init(boardId: String = "", state: String = "", shapes: [BoardShape] = []) {
      self.boardId = boardId
      self.state = state
      self.shapes = shapes
    }

    enum CodingKeys: String, CodingKey {
      case boardId = "board_id"
      case state = "state"
      case shapes = "shapes"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.boardId = try c.decode(String.self, forKey: .boardId)
      self.state = try c.decode(String.self, forKey: .state)
      self.shapes = try c.decodeIfPresent([BoardShape].self, forKey: .shapes) ?? []
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(boardId, forKey: .boardId)
      try c.encode(state, forKey: .state)
      if !shapes.isEmpty { try c.encode(shapes, forKey: .shapes) }
    }
  }

  /// One shape of a board, in board units (a point is two numbers). The fields its tool does not use are left out.
  /// 
  /// - stroke (`pen`, `marker`): `pts` its points, `t` their times (ms since it began), `f` their force (0 to 1),
  ///   `az` and `al` the pen's azimuth and altitude in radians (none without tilt), `sim` a force made up from the
  ///   speed, `color`, `width`;
  /// - note (`text`, `sticky`, `voice`): `pts` its top left corner, `text`, `size`, `color`, `wrap` (none: no wrap);
  /// - picture (`image`): `pts` two opposite corners, `attachment` its file's id (`ViewModel.files`, `OpenFile`),
  ///   `nw` and `nh` its own size in pixels (0: not known), `mime`, `name`.
  public struct BoardShape: Codable, Hashable, Sendable {
    /// `<sender hex>/<envelope number>/<index>`, or `live:<sender hex>/<stroke hex>` for a stroke still drawn.
    public var id: String
    /// The device that drew it (hex).
    public var by: String
    public var tool: String
    public var z: Int32
    public var group: String?
    public var pts: [Double]
    public var t: [UInt64]
    public var f: [Double]
    public var az: [Double]?
    public var al: [Double]?
    public var sim: Bool
    public var color: String?
    public var width: Double?
    public var text: String?
    public var size: Double?
    public var wrap: Double?
    public var attachment: String?
    public var nw: UInt32?
    public var nh: UInt32?
    public var mime: String?
    public var name: String?
    /// A stroke someone else is still drawing (its pieces, spec 7.2): its finished form replaces it.
    public var live: Bool
    /// Drawn on this device and not yet back from the hub: `<local_id>/<index>` of the `BoardItem` that made it.
    public var local: String?

    public init(id: String = "", by: String = "", tool: String = "", z: Int32 = 0, group: String? = nil, pts: [Double] = [], t: [UInt64] = [], f: [Double] = [], az: [Double]? = nil, al: [Double]? = nil, sim: Bool = false, color: String? = nil, width: Double? = nil, text: String? = nil, size: Double? = nil, wrap: Double? = nil, attachment: String? = nil, nw: UInt32? = nil, nh: UInt32? = nil, mime: String? = nil, name: String? = nil, live: Bool = false, local: String? = nil) {
      self.id = id
      self.by = by
      self.tool = tool
      self.z = z
      self.group = group
      self.pts = pts
      self.t = t
      self.f = f
      self.az = az
      self.al = al
      self.sim = sim
      self.color = color
      self.width = width
      self.text = text
      self.size = size
      self.wrap = wrap
      self.attachment = attachment
      self.nw = nw
      self.nh = nh
      self.mime = mime
      self.name = name
      self.live = live
      self.local = local
    }

    enum CodingKeys: String, CodingKey {
      case id = "id"
      case by = "by"
      case tool = "tool"
      case z = "z"
      case group = "group"
      case pts = "pts"
      case t = "t"
      case f = "f"
      case az = "az"
      case al = "al"
      case sim = "sim"
      case color = "color"
      case width = "width"
      case text = "text"
      case size = "size"
      case wrap = "wrap"
      case attachment = "attachment"
      case nw = "nw"
      case nh = "nh"
      case mime = "mime"
      case name = "name"
      case live = "live"
      case local = "local"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.id = try c.decode(String.self, forKey: .id)
      self.by = try c.decode(String.self, forKey: .by)
      self.tool = try c.decode(String.self, forKey: .tool)
      self.z = try c.decodeIfPresent(Int32.self, forKey: .z) ?? 0
      self.group = try c.decodeIfPresent(String.self, forKey: .group)
      self.pts = try c.decode([Double].self, forKey: .pts)
      self.t = try c.decodeIfPresent([UInt64].self, forKey: .t) ?? []
      self.f = try c.decodeIfPresent([Double].self, forKey: .f) ?? []
      self.az = try c.decodeIfPresent([Double].self, forKey: .az)
      self.al = try c.decodeIfPresent([Double].self, forKey: .al)
      self.sim = try c.decodeIfPresent(Bool.self, forKey: .sim) ?? false
      self.color = try c.decodeIfPresent(String.self, forKey: .color)
      self.width = try c.decodeIfPresent(Double.self, forKey: .width)
      self.text = try c.decodeIfPresent(String.self, forKey: .text)
      self.size = try c.decodeIfPresent(Double.self, forKey: .size)
      self.wrap = try c.decodeIfPresent(Double.self, forKey: .wrap)
      self.attachment = try c.decodeIfPresent(String.self, forKey: .attachment)
      self.nw = try c.decodeIfPresent(UInt32.self, forKey: .nw)
      self.nh = try c.decodeIfPresent(UInt32.self, forKey: .nh)
      self.mime = try c.decodeIfPresent(String.self, forKey: .mime)
      self.name = try c.decodeIfPresent(String.self, forKey: .name)
      self.live = try c.decodeIfPresent(Bool.self, forKey: .live) ?? false
      self.local = try c.decodeIfPresent(String.self, forKey: .local)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(id, forKey: .id)
      try c.encode(by, forKey: .by)
      try c.encode(tool, forKey: .tool)
      try c.encode(z, forKey: .z)
      try c.encodeIfPresent(group, forKey: .group)
      try c.encode(pts, forKey: .pts)
      if !t.isEmpty { try c.encode(t, forKey: .t) }
      if !f.isEmpty { try c.encode(f, forKey: .f) }
      try c.encodeIfPresent(az, forKey: .az)
      try c.encodeIfPresent(al, forKey: .al)
      try c.encode(sim, forKey: .sim)
      try c.encodeIfPresent(color, forKey: .color)
      try c.encodeIfPresent(width, forKey: .width)
      try c.encodeIfPresent(text, forKey: .text)
      try c.encodeIfPresent(size, forKey: .size)
      try c.encodeIfPresent(wrap, forKey: .wrap)
      try c.encodeIfPresent(attachment, forKey: .attachment)
      try c.encodeIfPresent(nw, forKey: .nw)
      try c.encodeIfPresent(nh, forKey: .nh)
      try c.encodeIfPresent(mime, forKey: .mime)
      try c.encodeIfPresent(name, forKey: .name)
      try c.encode(live, forKey: .live)
      try c.encodeIfPresent(local, forKey: .local)
    }
  }

  public struct FileView: Codable, Hashable, Sendable {
    public var name: String
    public var mediaType: String
    public var size: UInt64
    /// "uploading", "ready", "failed", "missing".
    public var state: String
    /// The attachment's id once the hub has it (an upload's local id maps to it here).
    public var attachmentId: String?
    /// 0..=100 while it moves.
    public var percent: UInt8?
    /// Its bytes were handed over (`Effect::FileReady`).
    public var loaded: Bool
    /// The Share links this device made for it (`Action::Share`), kept in memory only.
    public var shares: [FileShareView]

    public init(name: String = "", mediaType: String = "", size: UInt64 = 0, state: String = "", attachmentId: String? = nil, percent: UInt8? = nil, loaded: Bool = false, shares: [FileShareView] = []) {
      self.name = name
      self.mediaType = mediaType
      self.size = size
      self.state = state
      self.attachmentId = attachmentId
      self.percent = percent
      self.loaded = loaded
      self.shares = shares
    }

    enum CodingKeys: String, CodingKey {
      case name = "name"
      case mediaType = "media_type"
      case size = "size"
      case state = "state"
      case attachmentId = "attachment_id"
      case percent = "percent"
      case loaded = "loaded"
      case shares = "shares"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.name = try c.decode(String.self, forKey: .name)
      self.mediaType = try c.decode(String.self, forKey: .mediaType)
      self.size = try c.decode(UInt64.self, forKey: .size)
      self.state = try c.decode(String.self, forKey: .state)
      self.attachmentId = try c.decodeIfPresent(String.self, forKey: .attachmentId)
      self.percent = try c.decodeIfPresent(UInt8.self, forKey: .percent)
      self.loaded = try c.decode(Bool.self, forKey: .loaded)
      self.shares = try c.decodeIfPresent([FileShareView].self, forKey: .shares) ?? []
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(name, forKey: .name)
      try c.encode(mediaType, forKey: .mediaType)
      try c.encode(size, forKey: .size)
      try c.encode(state, forKey: .state)
      try c.encodeIfPresent(attachmentId, forKey: .attachmentId)
      try c.encodeIfPresent(percent, forKey: .percent)
      try c.encode(loaded, forKey: .loaded)
      if !shares.isEmpty { try c.encode(shares, forKey: .shares) }
    }
  }

  /// A Share link of a file: the whole link (its key behind the `#`), for the person to copy.
  public struct FileShareView: Codable, Hashable, Sendable {
    public var shareId: String
    public var link: String
    public var expiresMs: UInt64

    public init(shareId: String = "", link: String = "", expiresMs: UInt64 = 0) {
      self.shareId = shareId
      self.link = link
      self.expiresMs = expiresMs
    }

    enum CodingKeys: String, CodingKey {
      case shareId = "share_id"
      case link = "link"
      case expiresMs = "expires_ms"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.shareId = try c.decode(String.self, forKey: .shareId)
      self.link = try c.decode(String.self, forKey: .link)
      self.expiresMs = try c.decode(UInt64.self, forKey: .expiresMs)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(shareId, forKey: .shareId)
      try c.encode(link, forKey: .link)
      try c.encode(expiresMs, forKey: .expiresMs)
    }
  }

  /// A passing line at the window's foot: what was done, and the way back. The engine and the actions make them; the
  /// shell draws them and drops one when its time is up or it is pressed.
  public struct Toast: Codable, Hashable, Sendable {
    public var id: String
    /// The bold words ("Note sent to Fernly", "Not saved").
    public var text: Text
    /// An action the toast offers ("Undo", "Retry"), sent back as that action.
    public var action: CoreJSON?
    /// The quieter words after them ("the board did not take it").
    public var line: Text?
    /// The action's word on its button ("Undo", "Retry"); none: "Undo".
    public var label: Text?
    /// Something went wrong: said at once to a screen reader (the web's role "alert"), drawn as a problem.
    public var alert: Bool
    /// How long it stands (ms), as the ring on its Undo runs down; none: the shell's own time.
    public var ms: UInt64?
    /// A way to a page ("Open"): the screen, and the link's words.
    public var go: ToastGo?

    public init(id: String, text: Text, action: CoreJSON?, line: Text?, label: Text?, alert: Bool, ms: UInt64?, go: ToastGo?) {
      self.id = id
      self.text = text
      self.action = action
      self.line = line
      self.label = label
      self.alert = alert
      self.ms = ms
      self.go = go
    }

    enum CodingKeys: String, CodingKey {
      case id = "id"
      case text = "text"
      case action = "action"
      case line = "line"
      case label = "label"
      case alert = "alert"
      case ms = "ms"
      case go = "go"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.id = try c.decode(String.self, forKey: .id)
      self.text = try c.decode(Text.self, forKey: .text)
      self.action = try c.decodeIfPresent(CoreJSON.self, forKey: .action)
      self.line = try c.decodeIfPresent(Text.self, forKey: .line)
      self.label = try c.decodeIfPresent(Text.self, forKey: .label)
      self.alert = try c.decodeIfPresent(Bool.self, forKey: .alert) ?? false
      self.ms = try c.decodeIfPresent(UInt64.self, forKey: .ms)
      self.go = try c.decodeIfPresent(ToastGo.self, forKey: .go)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(id, forKey: .id)
      try c.encode(text, forKey: .text)
      try c.encodeIfPresent(action, forKey: .action)
      try c.encodeIfPresent(line, forKey: .line)
      try c.encodeIfPresent(label, forKey: .label)
      try c.encode(alert, forKey: .alert)
      try c.encodeIfPresent(ms, forKey: .ms)
      try c.encodeIfPresent(go, forKey: .go)
    }
  }

  /// A toast's way to a page.
  public struct ToastGo: Codable, Hashable, Sendable {
    public var screen: Screen
    public var label: Text

    public init(screen: Screen, label: Text) {
      self.screen = screen
      self.label = label
    }

    enum CodingKeys: String, CodingKey {
      case screen = "screen"
      case label = "label"
    }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      self.screen = try c.decode(Screen.self, forKey: .screen)
      self.label = try c.decode(Text.self, forKey: .label)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(screen, forKey: .screen)
      try c.encode(label, forKey: .label)
    }
  }

  /// A value the views carry as plain JSON, to be sent back as it came (a toast's action).
  public enum CoreJSON: Codable, Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([CoreJSON])
    case object([String: CoreJSON])

    public init(from decoder: any Decoder) throws {
      let c = try decoder.singleValueContainer()
      if c.decodeNil() { self = .null }
      else if let b = try? c.decode(Bool.self) { self = .bool(b) }
      else if let n = try? c.decode(Double.self) { self = .number(n) }
      else if let s = try? c.decode(String.self) { self = .string(s) }
      else if let a = try? c.decode([CoreJSON].self) { self = .array(a) }
      else { self = .object(try c.decode([String: CoreJSON].self)) }
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.singleValueContainer()
      switch self {
      case .null: try c.encodeNil()
      case .bool(let b): try c.encode(b)
      case .number(let n): try c.encode(n)
      case .string(let s): try c.encode(s)
      case .array(let a): try c.encode(a)
      case .object(let o): try c.encode(o)
      }
    }
  }
}
