// TrommiApp: Trommi for iOS. The same board as the web app (app.trommi.com), native: the Desk with the open questions,
// a card's page, the conversation with each session, the sessions in the sidebar (the place pill's menu on the iPhone), Blitz, Off
// your mind, notes, files, settings with the devices and pairing. Sign in as on the web: scan the QR code of "Pair a
// device", or email and password. Everything below the views is TrommiClient (Board.swift is the web's model, Room the
// sync engine with the live stream), the same code `trommi-swift` runs and the parity checks hold against the JS core.
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif
import TrommiClient
import TrommiCoreLive
import os

/** Cold start to the first rendered Desk (os log "trommi", category "timing"). */
enum StartClock {
  static let t0 = ProcessInfo.processInfo.systemUptime
  static var said = false
  static let log = Logger(subsystem: "com.trommi.ios", category: "timing")
  @MainActor static func desk(cards: Int, restored: Bool) {
    if said { return }
    said = true
    let ms = Int((ProcessInfo.processInfo.systemUptime - t0) * 1000)
    log.notice("trommi cold start: first desk in \(ms, privacy: .public) ms, \(cards, privacy: .public) cards, \(restored ? "from the cache" : "from the network", privacy: .public)")
    NSLog("trommi cold start: first desk in %d ms, %d cards, %@", ms, cards, restored ? "from the cache" : "from the network")
    PerfLog.line("cold start: first desk in \(ms) ms, \(cards) cards, \(restored ? "cache" : "network")")
  }
}

@main
struct TrommiApp: App {
  @StateObject private var model = BoardModel()
  @Environment(\.scenePhase) private var scenePhase
  #if canImport(UIKit)
  @UIApplicationDelegateAdaptor(PushDelegate.self) private var push   // Push.swift
  #endif
  // The core is installed before anything asks for it: the protocol is trommi-core, reached through Core.tools.
  init() { _ = StartClock.t0; Core.tools = LiveCore(); Face.registerFonts() }
  var body: some Scene {
    WindowGroup {
      RootView().environmentObject(model)
        .preferredColorScheme(model.theme.scheme)
        .tint(Ink.accent)
      #if canImport(UIKit)
        .onAppear { push.model = model; push.ask() }
        .onChange(of: model.phase) { _, p in if p == .board { push.ask() } }
      #endif
        .onChange(of: scenePhase) { _, p in model.scene(active: p == .active) }
        .onAppear { PerfScript.runIfAsked(model) }
        // universal links of app.trommi.com (Links.swift)
        .onOpenURL { model.open(url: $0) }
    }
  }
}

/** A passing line at the bottom: what was done, and its Undo. */
struct Toast: Identifiable, Equatable {
  let id = UUID()
  var head: String
  var line: String = ""
  var alert = false
  var undo: (() async -> Void)? = nil
  static func == (a: Toast, b: Toast) -> Bool { a.id == b.id }
}

/** Where the board navigates (one stack on the iPhone; the detail column on the iPad). */
enum Route: Hashable {
  case card(String)                 // card id
  case session(String)              // agent (board) id
  case blitz
  case off
  case settings(String)             // agents | devices | account
  case media
  case pages
  case picture(String, Int)         // card id, picture index
  case scribble
}

@MainActor
final class BoardModel: ObservableObject {
  /** The screens before the board, as the web app's sign-in (app/web/public/auth.mjs: welcome, scan, join, log in). */
  enum Phase: Equatable { case start, create, email, forgot, scan, asking, checkCode(String), pairFailed(String), board }
  /** The hub of app.trommi.com (app.mjs): accounts are made and logged in to there. A pairing link names its own hub. */
  static let hubURL = "https://hub.trommi.com"

  @Published var phase: Phase = .start
  @Published var error: String?
  /** A form of the sign-in screens is at work (Creating…, Logging in…, Setting…): it keeps its fields and waits. */
  @Published var signing = false
  /** Said once on the start screen after a log out. */
  @Published var loggedOut = false
  /** The Emergency Kit's page is up (KitScreen.swift); its words live here only, until "Open Trommi". */
  @Published var kit: KitGate?
  private var kitWriting = false
  /** A state of the sign-in screens opened from the demo's list (the web's ?onboard=<state>): drawn, nothing sent. */
  @Published var demoOnboard: String?
  /** The kit's page as the demo draws it (made-up words; his own page, if one is up, rests under the demo). */
  @Published var demoKit: KitGate?
  /** From a drawn sign-in state back to the demo's room. */
  func backToDemo() { demoOnboard = nil; demoKit = nil; signing = false; error = nil; loggedOut = false; phase = .board }
  var busy = false
  @Published var lastEmail = ""
  /** Bumps after every change of the board (the views read `desk` again). */
  @Published private(set) var version = 0
  @Published var toast: Toast?
  /** The Desk page's stack and the Chat page's stack (the iPhone's pages keep their own; the iPad uses the desk's). */
  @Published var deskPath: [Route] = []
  @Published var chatPath: [Route] = []
  /** The stack of the page in front. */
  var path: [Route] {
    get { tabs.page == .chat ? chatPath : deskPath }
    set { if tabs.page == .chat { chatPath = newValue } else { deskPath = newValue } }
  }
  /** What he read of each session: the newest agent envelope he saw there (kept on this device). */
  private var readMarks: [String: Int] = (UserDefaults.standard.dictionary(forKey: "trommi-read") as? [String: Int]) ?? [:]
  func newestFromAgent(_ a: Agent) -> Int {
    // (what it SAID: the envelopes of a turn's trail are no words to read, DeskModel.newestWord)
    desk?.newestWord(sessionId: a.deviceId) ?? 0
  }
  func unread(_ a: Agent) -> Bool { let n = newestFromAgent(a); return n > 0 && n > (readMarks[a.id] ?? 0) }
  /** The first time: everything up to now counts as read (no badge of 37 old chats). */
  private func baselineReads() {
    guard UserDefaults.standard.dictionary(forKey: "trommi-read") == nil, let d = desk, !d.agents.isEmpty else { return }
    for a in d.agents { readMarks[a.id] = newestFromAgent(a) }
    UserDefaults.standard.set(readMarks, forKey: "trommi-read")
  }
  func markRead(_ a: Agent) {
    let n = newestFromAgent(a)
    if n > (readMarks[a.id] ?? 0) { readMarks[a.id] = n; UserDefaults.standard.set(readMarks, forKey: "trommi-read") }
  }
  /** Open a session's chat: on the iPhone in the Chat page, on the iPad in the stack. */
  func openChat(_ id: String) {
    #if canImport(UIKit)
    if UIDevice.current.userInterfaceIdiom == .phone { tab = .chat; chatPath = [.session(id)]; return }
    #endif
    deskPath = [.session(id)]
  }
  /** The iPhone's pages (the capsule at the bottom). */
  typealias Tab = ShellTab
  /** Which item of the bar is lit and which page lies in front (ShellTabs, TrommiClient: the note is no page, it
   *  lies over the page he came from). Every way to the note goes through it, so the bar is lit on Note for all. */
  @Published var tabs = ShellTabs()
  /** The lit item. Set to .note it opens the note over the page in front; set to a page it goes there. */
  var tab: Tab {
    get { tabs.lit }
    set { tabs.select(newValue) }
  }
  /** TROMMI_PERF: bumps to scroll the Desk down and up (Perf.swift). */
  @Published var perfScroll = 0

  /** The duck for all is asking (the Desk's one confirmation; the demo's state "duck" opens it). */
  @Published var duckAsk = false
  @Published var live = false
  @Published var upgrade: UpgradeNotice?
  /** The hub's word on this version: nothing, an update available (a quiet line), or required (the calm full screen). */
  @Published var verdict: HubVersionInfo.Verdict = .current
  /** How many things of a newer Trommi this version met (shown as placeholders; one quiet line says it). */
  @Published var newer = 0
  private var versionChecked = false
  /** The demo (DemoMode.swift): the web demo's made-up room on this phone, no room, nothing sent; the list of its screens. */
  @Published var demo = false
  @Published var demoScreens = false
  /** The card he copied last ("Copy" on a card): the composer offers to attach it to a message (copied_cards). */
  @Published var copiedCard: String?
  func copyCard(_ c: DeskCard) {
    copiedCard = c.id
    let picked = c.options.filter { c.choices.contains($0.key) }.map { $0.label }.joined(separator: ", ")
    #if canImport(UIKit)
    UIPasteboard.general.string = "Nr. \(c.number) · \(c.title)\(picked.isEmpty ? "" : " → \(picked)")"
    #endif
    say("Copied", "Nr. \(c.number) · \(c.title): attach it in any conversation")
  }
  /** His own room and desk while the demo runs (back when he leaves it). */
  private var beforeDemo: (room: Room?, deskId: String?)?
  @Published var deskId: String? = UserDefaults.standard.string(forKey: "trommi-desk") {
    didSet { UserDefaults.standard.set(deskId, forKey: "trommi-desk") }
  }
  @Published var theme: ThemeMode = ThemeMode(rawValue: UserDefaults.standard.string(forKey: "trommi-theme") ?? "system") ?? .system {
    didSet { UserDefaults.standard.set(theme.rawValue, forKey: "trommi-theme") }
  }
  private(set) var room: Room?
  private(set) var desk: DeskModel?
  private var joinTask: Task<Void, Never>?
  private var liveTask: Task<Void, Never>?
  private var pendingUpdate = false
  private var lastFingerprint = 0
  private var active = true

  init() {
    // TROMMI_SCREEN=<id> (demo/data/screens.json): the demo on that screen, no room, no network, nothing stored
    let env = ProcessInfo.processInfo.environment
    // TROMMI_CHATLIST=1: the chat list on a crowded demo room (DemoMode.swift ChatListDemo), All desks, for screenshots
    if let style = env["TROMMI_CHATLIST"], !style.isEmpty {
      if let t = env["TROMMI_THEME"].flatMap(ThemeMode.init(rawValue:)) { _theme = Published(initialValue: t) }
      startDemo(keep: false)
      deskId = ALL_DESKS; tab = .chat; chatPath = []
      return
    }
    if let screen = env["TROMMI_SCREEN"], !screen.isEmpty {
      if let t = env["TROMMI_THEME"].flatMap(ThemeMode.init(rawValue:)) { _theme = Published(initialValue: t) }
      _deskId = Published(initialValue: nil)
      startDemo(keep: false)
      openDemoScreen(screen)
      return
    }
    if let id = Store.rooms(base: Store.defaultBase()).first, let r = try? Room.open(roomId: id) {
      attach(r)
      phase = .board
    }
  }

  private func attach(_ r: Room) {
    room = r
    desk = DeskModel(board: r.board)
    r.onChange = { [weak self] _ in self?.changed() }
    ShareImport.shared.attach(self)   // the Share Extension's inbox (ShareImport.swift)
    // the board from the encrypted cache first (no network), then live: the catch-up starts where the cache stopped
    Task { @MainActor in
      if await r.restore() { desk?.update(); checkKit(); version &+= 1 }
      startLive()
    }
  }
  /** A change of the board: the projection again, at most every 80 ms (a catch-up brings thousands). */
  private func changed() {
    if pendingUpdate { return }
    pendingUpdate = true
    Task { @MainActor in
      try? await Task.sleep(nanoseconds: 80_000_000)
      pendingUpdate = false
      // a batch that changed nothing visible (a refresh with no news): no render at all
      if let r = room {
        let f = r.board.fingerprint
        if f == lastFingerprint && r.live == live && r.board.newerCount == newer { PerfLog.line("skip: nothing visible changed"); return }
        lastFingerprint = f
      }
      PerfLog.time("desk.update") { desk?.update() }
      if let r = room {
        if live != r.live { live = r.live }
        if upgrade == nil, let u = r.upgrade { upgrade = u; verdict = .updateRequired(minimum: u.minimumVersion, message: u.message) }
        if r.board.newerCount != newer {
          PerfLog.line("newer: \(r.board.newerCount) \(r.board.newerWhat.joined(separator: ", "))")
          NSLog("trommi newer: %d %@", r.board.newerCount, r.board.newerWhat.joined(separator: ", "))
          newer = r.board.newerCount
        }
        baselineReads()
        checkKit()
        ShareImport.shared.boardChanged()
      }
      // what the Notification Service Extension and the Live Activity may know (NotifyBridge.swift); a link that waited
      NotifyBridge.shared.boardChanged(self)
      openPendingLink()
      let t0 = DispatchTime.now().uptimeNanoseconds
      version &+= 1
      if PerfLog.on { DispatchQueue.main.async { PerfLog.line(String(format: "render after version bump ≈ %.1f ms", Double(DispatchTime.now().uptimeNanoseconds - t0) / 1e6)); RenderCount.flush("render") } }
    }
  }

  // ---- live, refresh ------------------------------------------------------------------------------------

  /** The one entry point for "read what is new" (push, pull to refresh, the app coming to the front). */
  func refresh() async {
    guard let room = room else { return }
    busy = true
    defer { busy = false }
    if !versionChecked, let info = try? await room.hub.versionInfo() {
      versionChecked = true
      verdict = info.verdict(kind: "ios", version: HubClient.appVersion)
    }
    do {
      let report = try await PerfLog.time("refresh sync") { try await room.sync() }
      if let w = report.warnings.first { error = w }
      if liveTask == nil && active { startLive() }
    } catch { self.error = describe(error) }
  }
  func scene(active: Bool) {
    self.active = active
    // what was shared meanwhile (ShareImport.swift): after the catch-up, so the note and the sessions are current
    if active { startLive(); Task { await refresh(); ShareImport.shared.run() } }
    else { liveTask?.cancel(); liveTask = nil; live = false; room?.saveCache(snapshot: true); NotifyBridge.shared.writeNow(self) }
  }
  private func startLive() {
    #if canImport(Darwin)
    guard liveTask == nil, let r = room else { return }
    liveTask = Task { @MainActor [weak self] in
      await r.runLive()
      self?.liveTask = nil
    }
    #endif
  }

  // ---- sign in -----------------------------------------------------------------------------------------

  func go(_ p: Phase) { error = nil; signing = false; if p != .start { loggedOut = false }; phase = p }

  /** The states of these screens are only drawn in the demo: nothing is made, sent or asked. */
  private func drawnOnly() -> Bool {
    if demo { error = "Nothing is sent from the demo." }
    return demo
  }
  /** A new device is in: it names itself (never asked; Settings → Devices renames it), the board opens. */
  private func entered(_ r: Room) async {
    try? await r.sendDeviceRegister(name: UIDeviceName.model, platform: "ios")
    attach(r)
    signing = false
    phase = .board
    await refresh()
    checkKit()
  }

  /** A scanned or pasted text: a pairing link carries "#v2." and parses as one (the core checks it). It asks at once. */
  func gotLink(_ text: String) -> Bool {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard t.contains("#v2."), (try? Core.tools.parseInviteLink(t)) != nil else { return false }
    if drawnOnly() { return true }
    pair(link: t)
    return true
  }

  /** Pair with a signed-in device: own keys, then six emoji to compare there; that device adds this one. */
  func pair(link: String) {
    error = nil
    phase = .asking
    joinTask = Task {
      do {
        let r = try await Room.join(link: link) { ev in
          if case .checkCode(let code) = ev { Task { @MainActor in if self.phase == .asking { self.phase = .checkCode(code) } } }
        }
        await entered(r)
      } catch is CancellationError {
      } catch {
        if Task.isCancelled { return }
        let why: String
        switch (error as? TrommiError)?.code {
        case "invite-used": why = "This code was used already."
        case "invite-expired": why = "This code has run out."
        case "code-mismatch": why = "The emoji did not match there."
        default: why = accountError(error)
        }
        phase = .pairFailed(why)
      }
    }
  }
  func cancelPairing() { joinTask?.cancel(); joinTask = nil; go(.scan) }

  /** The form says it works (its button's word) before the slow step (Argon2id) holds the main thread. */
  private func began(_ email: String) async {
    lastEmail = email
    error = nil
    signing = true
    try? await Task.sleep(nanoseconds: 60_000_000)
  }

  /**
   * Create account (shared/account.ts createAccount): this device founds the account and its Emergency Kit is made at
   * once; the kit's page comes next and stays until "Open Trommi" (KitScreen.swift). The mark covers the moment before
   * the register `kit` is out, should the app end between the account and its page.
   */
  func create(email: String, password: String) async {
    if drawnOnly() { return }
    await began(email)
    UserDefaults.standard.set(true, forKey: Self.kitMark)
    do {
      let made = try await Room.createAccount(hubURL: Self.hubURL, email: email, password: password)
      kit = KitGate(email: made.kit.email, words: made.kit.words, accountId: made.kit.accountId)
      await entered(made.room)
    } catch {
      UserDefaults.standard.removeObject(forKey: Self.kitMark)
      signing = false
      self.error = accountError(error)
    }
  }

  /**
   * Create account with a passkey (Passkeys.swift): the system makes one, this device founds the account with it
   * and its Emergency Kit. `email` is optional: empty for an account without one.
   */
  func createWithPasskey(email: String) async {
    if drawnOnly() { return }
    await began(email)
    UserDefaults.standard.set(true, forKey: Self.kitMark)
    do {
      let made = try await Room.createAccountWithPasskey(hubURL: Self.hubURL, email: email, make: { try await Passkeys.make($0) })
      kit = KitGate(email: made.kit.email, words: made.kit.words, accountId: made.kit.accountId)
      await entered(made.room)
    } catch {
      UserDefaults.standard.removeObject(forKey: Self.kitMark)
      signing = false
      self.error = accountError(error)
    }
  }

  /** Log in with password: `account` is the one field, the email or the account id. This device adds itself to the account. */
  func login(account: String, password: String) async {
    if drawnOnly() { return }
    await began(account)
    do {
      // The one place the sign-in's outcome is handled: a later "check your email" step of the hub lands here.
      switch try await Room.signInWithPassword(hubURL: Self.hubURL, account: account, password: password) {
      case .joined(let r): await entered(r)
      }
    } catch {
      signing = false
      self.error = accountError(error)
    }
  }

  /** Log in with a passkey (Passkeys.swift): the system asks for one, its key opens the account, this device adds itself. */
  func loginWithPasskey() async {
    if drawnOnly() { return }
    error = nil
    signing = true
    do {
      switch try await Room.signInWithPasskey(hubURL: Self.hubURL, assert: { try await Passkeys.assert(challenge: $0) }) {
      case .joined(let r): await entered(r)
      }
    } catch {
      signing = false
      self.error = accountError(error)
    }
  }

  /**
   * Forgot password: the Emergency Kit's words open the account, this device adds itself and sets the new password.
   * `account` is the one field, the email or the account id; `password` nil (an account named by its id has no
   * password): the words log this device in and nothing else.
   */
  func forgot(account: String, words: String, password: String?) async {
    if drawnOnly() { return }
    await began(account)
    do {
      await entered(try await Room.resetPassword(hubURL: Self.hubURL, account: account, words: words, newPassword: password))
    } catch {
      signing = false
      self.error = accountError(error)
    }
  }

  /**
   * Every device is lost (spec/v2.md 8.7; he confirmed it on the reset screen): the Emergency Kit's words open the
   * account, this device removes every other device of his and sets the new password (or, for an account without
   * an email, a new passkey), and a new Emergency Kit is made. Its page comes next and stays until "Open Trommi",
   * as after "Create account" (the mark, as there, covers the moment before the register `kit` is out).
   */
  func recoverAll(account: String, words: String, password: String?) async {
    if drawnOnly() { return }
    await began(account)
    UserDefaults.standard.set(true, forKey: Self.kitMark)
    do {
      let passkey: ((PasskeyRequest) async throws -> PasskeyMade)? = Passkeys.available ? { try await Passkeys.make($0) } : nil
      let done = try await Room.recoverAccount(hubURL: Self.hubURL, account: account, words: words, newPassword: password, makePasskey: passkey) { _ in true }
      kit = KitGate(email: done.kit.email, words: done.kit.words, accountId: done.kit.accountId)
      await entered(done.room)
      say("Recovered", done.removed == 1 ? "1 other device was removed." : "\(done.removed) other devices were removed.")
    } catch {
      UserDefaults.standard.removeObject(forKey: Self.kitMark)
      signing = false
      self.error = accountError(error)
    }
  }

  // ---- the Emergency Kit's page (auth.mjs kitGate) -------------------------------------------------------------

  /** Set before the account is asked for, cleared once the register `kit` is out: nothing but "a kit is due". */
  private static let kitMark = "trommi-kit-pending"

  /**
   * Is the account's kit still to be saved? Asked after every change of the board. The human register `kit` =
   * { pending: true } says so on every device of the person; while it does, the app opens on the kit's page. Saved on
   * another device meanwhile: this one opens too (only on the register's own word, never while its write is on the way).
   */
  private func checkKit() {
    guard !demo, let r = room, r.record.role == "human" else { return }
    let marked = UserDefaults.standard.bool(forKey: Self.kitMark)
    if kit == nil {
      guard marked || r.kitPending else { return }
      kit = KitGate(email: lastEmail, words: nil)
      if lastEmail.isEmpty { Task { if let st = try? await r.accountStatus(), kit != nil { kit?.email = st.email; kit?.accountId = st.accountId } } }
    } else if !marked && r.kitRegistered && !r.kitPending {
      kit = nil
      return
    }
    if marked && !r.kitPending && !kitWriting {
      kitWriting = true
      Task {
        if (try? await r.setKitPending(true)) != nil { UserDefaults.standard.removeObject(forKey: Self.kitMark) }
        kitWriting = false
      }
    }
  }
  /** After a relaunch the words are gone: the password makes a new kit, which replaces the unseen one. nil, or what to say. */
  func makeKit(password: String) async -> String? {
    if demo { return "Nothing is sent from the demo." }
    guard let r = room else { return "Not logged in." }
    try? await Task.sleep(nanoseconds: 60_000_000)
    do {
      let made = try await r.makeEmergencyKit(password: password)
      kit = KitGate(email: made.email, words: made.words, accountId: made.accountId)
      return nil
    } catch {
      return ((error as? TrommiError)?.code ?? "") == "wrong-login" ? "Wrong password." : accountError(error)
    }
  }
  /** The text of the kit's QR code for this account (Account.swift `kitQRText`: hub and account id, never the words). */
  func kitQR(_ accountId: String) -> String? { kitQRText(hubURL: room?.record.hubURL ?? Self.hubURL, accountId: accountId) }
  /** "Open Trommi": the kit was shown, saved or printed. The register is cleared for every device, the words are dropped. */
  func kitSaved() async -> Bool {
    if demo { backToDemo(); return true }
    guard let r = room else { return false }
    do {
      try await r.setKitPending(false)
      UserDefaults.standard.removeObject(forKey: Self.kitMark)
      kit = nil
      return true
    } catch { return false }
  }

  // ---- what the views read ---------------------------------------------------------------------------------

  var view: DeskModel.View? { desk?.view(desk: deskId) }
  /** The board on screen: the room's, or the demo's. */
  var board: Board? { desk?.board }
  /** The room for an action of his; in the demo nothing is sent, a toast says so. */
  func acting() -> Room? {
    if demo { say("Demo", "Nothing is sent from the demo.") }
    return room
  }

  // ---- the demo ------------------------------------------------------------------------------------------

  /** The web demo's room (Resources/Demo/fixture.json, its times moved to now): his own room rests meanwhile. */
  func startDemo(keep: Bool = true) {
    let chatList = !(ProcessInfo.processInfo.environment["TROMMI_CHATLIST"] ?? "").isEmpty
    guard let raw = try? Data(contentsOf: DemoData.url("fixture.json")), let b = try? DemoFixture.board(chatList ? ChatListDemo.fixture(raw) : raw) else { error = "The demo is missing in this build."; return }
    if keep && !demo { beforeDemo = (room, deskId) }
    liveTask?.cancel(); liveTask = nil
    room?.saveCache()
    room = nil
    desk = DeskModel(board: b)
    demo = true; live = true
    demoOnboard = nil; demoKit = nil; signing = false; error = nil; loggedOut = false
    deskPath = []; chatPath = []; tab = .desk; toast = nil
    if keep { deskId = nil }
    phase = .board
    version &+= 1
  }
  /** Back to his own room (or to the sign-in when there is none). */
  func leaveDemo() {
    guard demo else { return }
    demo = false; demoScreens = false
    demoOnboard = nil; demoKit = nil; signing = false; error = nil; loggedOut = false
    deskPath = []; chatPath = []; tab = .desk; toast = nil
    let was = beforeDemo
    beforeDemo = nil
    deskId = was?.deskId
    if let r = was?.room {
      room = r
      desk = DeskModel(board: r.board)
      live = r.live
      phase = .board
      startLive()
      Task { await refresh() }
    } else if let id = Store.rooms(base: Store.defaultBase()).first, let r = try? Room.open(roomId: id) {
      desk = nil
      attach(r)
      phase = .board
    } else {
      desk = nil
      phase = .start
    }
    version &+= 1
  }
  func card(_ id: String) -> DeskCard? { desk?.byCard[id] }
  func agent(_ id: String) -> Agent? { desk?.byAgent[id] }
  func say(_ head: String, _ line: String = "", undo: (() async -> Void)? = nil) { toast = Toast(head: head, line: line, undo: undo) }
  func fail(_ head: String, _ e: Error) { toast = Toast(head: head, line: describe(e), alert: true) }

  // ---- what a human does (the web's hubFacade and card WAYS) --------------------------------------------------

  /** Run an action; a failure becomes an alert toast. */
  func act(_ head: String = "Not saved", _ op: @escaping () async throws -> Void) {
    Task { do { try await op() } catch { fail(head, error) } }
  }
  static func nextMorning(_ now: Date = Date()) -> UInt64 {
    var c = Calendar.current.dateComponents([.year, .month, .day], from: now)
    c.hour = 7; c.minute = 0
    var at = Calendar.current.date(from: c) ?? now
    if at <= now { at = Calendar.current.date(byAdding: .day, value: 1, to: at) ?? at }
    return UInt64(at.timeIntervalSince1970 * 1000)
  }

  func decide(_ c: DeskCard, keys: [String], note: String = "", notes: [String: String] = [:], attachments: [JV] = []) {
    guard let room = acting() else { return }
    act {
      if c.kind == "permission" { try await room.verdict(requestId: c.id, allow: keys.first == "allow"); return }
      try await room.answer(cardId: c.id, choices: c.options.filter { keys.contains($0.key) }.map { $0.key }, note: note.isEmpty ? nil : note,
                            optionNotes: notes.filter { !$0.value.isEmpty }, attachments: attachments)
      if c.draft != nil { try? await room.setDraft(cardId: c.id, nil) }
      let picked = c.options.filter { keys.contains($0.key) }.map { $0.label }.joined(separator: ", ")
      let settled = self.card(c.id)?.settled == true
      self.say(settled ? "Settled" : "Answered", picked.isEmpty ? c.title : "\(c.title) → \(picked)", undo: settled || c.kind == "permission" ? nil : { [weak self] in self?.reopen(c.id) })
    }
  }
  func trust(_ c: DeskCard, note: String = "") {
    guard let room = acting() else { return }
    act {
      try await room.trust(cardId: c.id, note: note.isEmpty ? nil : note)
      self.say(Words.trust, c.title, undo: { [weak self] in self?.reopen(c.id) })
    }
  }
  func closeInfo(_ c: DeskCard) {
    guard let room = acting() else { return }
    act { try await room.markRead(cardId: c.id); self.say("Read", c.title, undo: { [weak self] in self?.reopen(c.id) }) }
  }
  func shred(_ c: DeskCard, note: String = "") {
    guard let room = acting() else { return }
    act { try await room.shred(cardId: c.id, note: note.isEmpty ? nil : String(note.prefix(2000))); self.say("Shredded", c.title, undo: { [weak self] in self?.reopen(c.id) }) }
  }
  func snooze(_ c: DeskCard) {
    guard let room = acting() else { return }
    act { try await room.snooze(cardId: c.id, until: BoardModel.nextMorning()); self.say(Words.later, c.title, undo: { [weak self] in self?.wake(c.id) }) }
  }
  func wake(_ id: String) {
    guard let room = acting() else { return }
    act { try await room.snooze(cardId: id, until: nowMs()) }
  }
  /** Take an answer back; what was taken back becomes the draft again. */
  func reopen(_ id: String) {
    guard let room = room, let c = card(id) else { return }
    act {
      if c.status == "open" && c.snoozedUntil != nil { try await room.snooze(cardId: id, until: nowMs()); return }
      try await room.decideAgain(cardId: id)
      if c.kind == "decision" && (!c.choices.isEmpty || !c.note.isEmpty || !c.optionNotes.isEmpty) {
        try? await room.setDraft(cardId: id, .obj(["keys": .arr(c.choices.map { .str($0) }), "note": .str(c.note), "notes": .obj(c.optionNotes.mapValues { .str($0) }), "ts": .n(nowMs())]))
      }
      self.say("Back on the Desk", c.title)
    }
  }
  func takeBack(_ c: DeskCard) {
    guard let room = acting() else { return }
    act { try await room.sendMessage(cardId: c.id, text: Words.takeBackText,fields: ["present_card": true]) }
  }
  func handBack(_ c: DeskCard, text: String = "") {
    guard let room = acting() else { return }
    act {
      try await room.sendMessage(cardId: c.id, text: text.isEmpty ? Words.handBackText : text, fields: ["hand_back": true])
      self.say("Handed back", c.title, undo: { [weak self] in if let c = self?.card(c.id) { self?.takeBack(c) } })
    }
  }
  func what(_ c: DeskCard) {
    guard let room = acting() else { return }
    act {
      try await room.sendMessage(cardId: c.id, text: Words.explainText, fields: ["explain": true])
      self.say("Asked: \(Words.what)", c.title, undo: { [weak self] in if let c = self?.card(c.id) { self?.takeBack(c) } })
    }
  }
  func setDraft(_ c: DeskCard, keys: [String], note: String, notes: [String: String]) {
    guard let room = room, c.kind == "decision", c.status == "open" else { return }
    let empty = keys.isEmpty && note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && notes.values.allSatisfy { $0.isEmpty }
    Task { try? await room.setDraft(cardId: c.id, empty ? nil : .obj(["keys": .arr(keys.map { .str($0) }), "note": .str(note), "notes": .obj(notes.mapValues { .str($0) }), "ts": .n(nowMs())])) }
  }
  /** A message to a session (or about a card), with files. */
  func send(agent: String, text: String, cardId: String? = nil, attachments: [JV] = [], cards: [String] = []) async throws {
    if demo { throw TrommiError("demo", "nothing is sent from the demo") }
    guard let room = room, let key = desk?.sessionKey(of: agent) else { throw TrommiError("not-found", "unknown session") }
    var fields: [String: JV] = [:]
    if !attachments.isEmpty { fields["attachments"] = .arr(attachments) }
    // cards he copied elsewhere ("Copy" on a card) ride along by their ids (README: copied_cards)
    if !cards.isEmpty { fields["copied_cards"] = .arr(cards.map { .str($0) }) }
    try await room.sendMessage(sessionId: key, cardId: cardId, text: text, fields: fields)
  }
  func upload(_ data: Data, name: String, type: String, width: Int? = nil, height: Int? = nil) async throws -> JV {
    guard let room = room else { throw TrommiError("offline", "no room") }
    return try await room.uploadAttachment(Array(data), fileName: name, mediaType: type, width: width, height: height)
  }
  func attachment(_ ref: JV) async throws -> Data {
    if demo { return try DemoData.file(ref) }
    guard let room = room else { throw TrommiError("offline", "no room") }
    return Data(try await room.fetchAttachment(ref))
  }
  func loadOlder(agent: String) async {
    guard let room = room, let key = desk?.sessionKey(of: agent) else { return }
    do {
      try await room.loadOlder(timelineKeyOf("chat", "session/\(key)"), limit: 50)
      for id in room.board.sessions[key]?.cardIds ?? [] where room.board.timelines[timelineKeyOf("chat", "card/\(id)")]?.items.values.contains(where: { $0.itemState == "header" }) == true {
        try await room.loadOlder(timelineKeyOf("chat", "card/\(id)"), limit: 50)
      }
    } catch { fail("Not loaded", error) }
  }
  /** Messages that came as headers above what the chat shows (a catch-up after the app was away): their bodies. */
  func loadNewer(agent: String) async {
    guard let room = room, let key = desk?.sessionKey(of: agent) else { return }
    _ = try? await room.loadNewer(timelineKeyOf("chat", "session/\(key)"))
    for id in room.board.sessions[key]?.openCardIds ?? [] { _ = try? await room.loadNewer(timelineKeyOf("chat", "card/\(id)")) }
  }
  func loadOlder(card id: String) async {
    guard let room = acting() else { return }
    do { try await room.loadOlder(timelineKeyOf("chat", "card/\(id)"), limit: 50) } catch { fail("Not loaded", error) }
  }
  /** A session's settings (name, icon, desk, archived, parent, position). */
  func editSession(_ a: Agent, _ fields: [String: JV]) {
    guard let room = acting() else { return }
    act { try await room.editSession(a.deviceId, fields) }
  }
  /** The crown of the session's desk (one per desk; the room's single crown without desks). */
  func star(_ a: Agent, _ on: Bool) {
    guard let room = acting(), let d = desk else { return }
    act {
      let crown: JV = on ? .obj(["session_id": .s(a.sessionId), "agent_device_id": .s(a.agentDeviceId)]) : .null
      guard let deskId = d.deskOf(a) else { try await room.setCrown(crown); return }
      var v = room.board.human.desks[deskId]?.object ?? ["name": .str(d.desks.first { $0.id == deskId }?.name ?? "Desk"), "created_at": .n(nowMs())]
      v["crown"] = crown
      try await room.setDesk(deskId, .obj(v))
    }
  }
  /** The duck for all: every decision gets "I don't give a duck", every info is marked read; one toast, one Undo. */
  func duckAll(_ ids: [String], read: [String] = []) {
    guard let room = acting() else { return }
    act {
      for id in ids { try await room.trust(cardId: id) }
      for id in read { try await room.markRead(cardId: id) }
      let all = ids + read
      self.say(ids.isEmpty ? "Read" : "Left to the agents", all.count == 1 ? "1 card" : "\(all.count) cards", undo: { [weak self] in for id in all { self?.reopen(id) } })
    }
  }
  /**
   * Delete a session (agents.mjs /sessions/:id/delete): its connector is removed from the room (new keys), its open
   * questions are shredded and it goes to the archive.
   */
  func deleteSession(_ a: Agent) {
    guard let room = acting(), let d = desk else { return }
    act {
      for c in d.cards where c.agent == a.id && c.status == "open" && c.kind != "permission" { try? await room.shred(cardId: c.id) }
      try await room.editSession(a.deviceId, ["archived": true])
      if let dev = a.agentDeviceId, room.board.members[dev]?.isActive == true, !a.own { try await room.removeDevices([dev]) }
      self.say("Deleted", a.name)
      if self.path.last == .session(a.id) { self.path.removeLast() }
    }
  }
  /** Remove a device of the room (Devices): it leaves the room group and every session group; their keys move on. */
  func removeDevice(_ id: String, name: String) {
    guard let room = acting() else { return }
    act("Not removed") { try await room.removeDevices([id]); self.say("Removed", name) }
  }
  /** Log out of this device: it removes itself from the room; nothing of Trommi is left here. */
  func logOut() {
    guard let room = acting() else { return }
    act("Not logged out") {
      do { try await room.leaveRoom() } catch let e as HubError where e.status == 0 { room.forgetHere() }
      self.liveTask?.cancel(); self.liveTask = nil
      NotifyBridge.shared.signedOut()
      #if canImport(ActivityKit) && os(iOS)
      LiveActivities.endAll()
      #endif
      self.room = nil; self.desk = nil; self.path = []
      ShareImport.shared.signedOut()
      self.kit = nil
      UserDefaults.standard.removeObject(forKey: Self.kitMark)
      self.error = nil; self.loggedOut = true
      self.phase = .start
    }
  }
  /** Desks: register desk/<id>. */
  func newDesk(name: String) {
    guard let room = acting() else { return }
    act {
      if room.board.human.desks.isEmpty { try await room.setDesk("main", .obj(["name": "Desk", "created_at": .n(nowMs() - 1)])) }
      let id = (0..<4).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
      try await room.setDesk(id, .obj(["name": .str(String(name.trimmingCharacters(in: .whitespaces).prefix(40)).isEmpty ? "Desk" : String(name.prefix(40))), "created_at": .n(nowMs())]))
      self.deskId = id
    }
  }
  func renameDesk(_ id: String, _ name: String) {
    guard let room = acting() else { return }
    act { var v = room.board.human.desks[id]?.object ?? [:]; v["name"] = .str(String(name.prefix(40))); try await room.setDesk(id, .obj(v)) }
  }
  /** A desk's goals (DeskGoals; app.mjs hub.desk({ id, goals })): a field of its register, every other field kept.
   *  With no desk yet, the first one ("main") is made for them. */
  func setGoals(_ id: String, _ text: String) {
    guard let room = acting() else { return }
    let have = room.board.human.desks
    guard let did = have[id]?.object != nil ? id : have.isEmpty ? "main" : nil else { return }
    act { try await room.setDesk(did, deskRegister(have[did], goals: text)) }
  }
  func removeDesk(_ id: String) {
    guard let room = acting() else { return }
    act { try await room.setDesk(id, nil); if self.deskId == id { self.deskId = nil } }
  }

  // ---- words ---------------------------------------------------------------------------------------------

  /** The web's wording for the account errors (auth.mjs accountError): one short line each. */
  func accountError(_ e: Error) -> String {
    let code = (e as? TrommiError)?.code ?? (e as? HubError)?.code ?? ""
    switch code {
    case "wrong-login": return "Wrong email or password."
    case "wrong-recovery": return "Wrong email or words."
    case "bad-recovery-words": return "Check the twelve words."
    // (the hub names the wait: shown as it is; spec/hub-api.md "Failed logins slow down whoever guesses wrong")
    case "rate-limited": return retryWait(of: e).map { "Too many tries. Wait \(waitText(seconds: $0))." } ?? "Too many tries. Wait a few minutes."
    case "overloaded": return retryWait(of: e).map { "Trommi is busy. Wait \(waitText(seconds: $0))." } ?? "Trommi is busy. Try again."
    case "needs-email": return "Enter your email to log in with a password."
    case "bad-account": return "That is not an email address or an account ID."
    case "not-built": return "This version can’t do that yet."
    case "too-many": return "Too many sign-ups with this email. Try tomorrow."
    case "weak-password": return "At least 12 characters."
    case "bad-email": return "That is not an email address."
    case "offline": return "Can’t reach Trommi. Check your connection."
    case "room-exists": return "This device is logged in already."
    case "account-exists": return "This account has a login already."
    case "account-changed": return "Changed on another device. Try again."
    case "no-prf": return "This passkey can’t unlock Trommi here."
    case "passkey-cancelled": return "No passkey used."
    case "passkey-failed": return "The passkey did not work. Try again."
    case "bad-passkey": return "That passkey was not accepted. Try again."
    default: return describe(e)
    }
  }
  func describe(_ e: Error) -> String {
    if let z = e as? TrommiError { return z.message.isEmpty ? z.code : z.message }
    if let h = e as? HubError { return h.code == "offline" ? "Trommi is not reachable. Check the connection." : h.message.isEmpty ? h.code : h.message }
    return "\(e)"
  }
}

/**
 * The name this device gives itself, never asked for (the web's deviceLabel: "Safari on iPhone"): the model, "iPhone"
 * or "iPad". iOS hands apps nothing more personal without Apple's device-name entitlement. Settings → Devices renames it.
 */
enum UIDeviceName {
  static var model: String {
    #if canImport(UIKit)
    return UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
    #else
    return ProcessInfo.processInfo.hostName
    #endif
  }
}

struct RootView: View {
  @EnvironmentObject var model: BoardModel
  var body: some View {
    Group {
      if model.phase == .board {
        // while the account's Emergency Kit was never saved, the app opens on its page (KitScreen.swift)
        if let gate = model.demo ? model.demoKit : model.kit { KitScreen(gate: gate).id(model.demoOnboard) } else { BoardShell() }
      } else {
        Group {
          switch model.phase {
          case .start: StartView()
          case .create: CreateView()
          case .email: EmailView()
          case .forgot: ForgotView()
          case .scan: ScanView()
          case .asking: AskingView()
          case .checkCode(let code): CheckCodeView(code: code)
          case .pairFailed(let why): PairFailedView(why: why)
          case .board: EmptyView()
          }
        }
        .id(model.demoOnboard)
      }
    }
    .background(Ink.bg)
    // the demo's tag at the top of every screen, below the island: content starts under it, nothing covers it
    .safeAreaInset(edge: .top, spacing: 0) { if model.demo && model.phase == .board && model.demoKit == nil { DemoTag() } }
    .sheet(isPresented: $model.demoScreens) { AllScreensSheet() }
  }
}

