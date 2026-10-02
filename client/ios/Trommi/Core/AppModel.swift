// The one place that holds the board: it keeps the event stream alive, shows
// answers at once and takes them back if the server refuses, says what just
// happened to a question with the way back ("Back"), keeps what was ticked but
// not sent, and remembers what was put off with "Later" or handed to its agent. The rules themselves live in Core
// (BoardStore, LaterList, BoardState); this class only connects them to the
// server and to the views. It needs neither SwiftUI nor UIKit, so it builds and
// is tested with the rest of Core; what only the device can do (Keychain,
// haptics, preferences, the app bundle) comes in through AppHooks.
import Foundation
import Observation

/// A short buzz: something was answered, failed, or moved.
enum Feedback: Sendable { case decided, failed, tap }

/// What the model needs from the device. The app fills these in (App/Runtime.swift);
/// tests pass closures that record what happened.
struct AppHooks {
    var feedback: @MainActor (Feedback) -> Void = { _ in }
    /// The stored login: read at launch, written after a successful sign-in, cleared on sign-out.
    var loadLogin: @MainActor () -> StoredLogin? = { nil }
    var saveLogin: @MainActor (StoredLogin) -> Void = { _ in }
    var clearLogin: @MainActor () -> Void = {}
    /// The later list between launches.
    var loadLater: @MainActor () -> Data? = { nil }
    var saveLater: @MainActor (Data) -> Void = { _ in }
    /// demo-state.json from the app bundle.
    var demoData: @MainActor () -> Data? = { nil }
    /// The client changed (nil: signed out). Whoever loads pictures and plays audio follows it.
    var clientChanged: @MainActor ((any BoardClient)?) -> Void = { _ in }
}

/// A link from a message, to be shown in the in-app browser.
struct BrowserRequest: Identifiable {
    let id = UUID()
    let url: URL
}

/// What just happened to a question that left the view, and the way back: "Answered: Yes",
/// "Moved to Later", "Asked to explain", "With the agent". One note at a time, for a few
/// seconds; "Back" undoes it (back.js on the web).
struct BackNote: Identifiable, Equatable {
    enum Undo: Equatable, Sendable {
        /// Take the answer back on the server; the question returns open.
        case reopen
        /// Fetch the question back from "Later".
        case fetchBack
    }

    let id = UUID()
    var cardID: String
    /// What happened, a few words.
    var head: String
    /// The question it happened to, or a word about what comes next.
    var title: String
    var undo: Undo
}

enum Connection: Equatable {
    case connecting, online, offline

    /// CONN_TEXT in client/web/js/app.js.
    var text: String {
        switch self {
        case .connecting: return "Connecting"
        case .online: return "Connected"
        case .offline: return "Disconnected"
        }
    }
}

@MainActor
@Observable
final class AppModel {
    enum Phase: Equatable { case onboarding, board }

    /// How long the note with "Back" stays on screen (BACK_MS in back.js).
    static let backSeconds: Double = 4

    private(set) var phase: Phase = .onboarding
    /// The board as the human should see it: the server's state plus answers still on their way.
    private(set) var state: BoardState = .empty
    /// What was put off with "Later".
    private(set) var later = LaterList()
    /// False until the first state arrived.
    private(set) var loaded = false
    private(set) var connection: Connection = .connecting
    /// What just happened to a question, with the way back; nil when there is nothing to take back.
    private(set) var back: BackNote?
    /// Why the last answer to a card was not taken, by card id: shown on the card until it is answered again.
    private(set) var refusals: [String: String] = [:]
    /// Where a link the app was opened with leads, once the board knows the question; the view opens it and clears this.
    private(set) var linkTarget: LinkTarget?
    private(set) var isDemo = false
    private(set) var serverAddress = ""
    /// A sentence for the banner at the top: something was not saved.
    var notice: String?
    /// Shown on the first screen, e.g. after the server refused the stored token.
    var onboardingMessage: String?
    /// A link the human tapped; the root view hands it to the in-app browser and clears it.
    var browser: BrowserRequest?

    @ObservationIgnored private(set) var client: (any BoardClient)?
    @ObservationIgnored private var store = BoardStore()
    @ObservationIgnored private var stream: Task<Void, Never>?
    @ObservationIgnored private var backTimer: Task<Void, Never>?
    /// Answers on their way to the server, by card id: "Back" waits for one before it takes it back.
    @ObservationIgnored private var inflight: [String: Task<Void, Error>] = [:]
    /// Drafts waiting to be sent, by card id.
    @ObservationIgnored private var draftTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var pendingLink: DeepLink?
    @ObservationIgnored private let hooks: AppHooks
    @ObservationIgnored private let clock: () -> Double
    /// How long a changed draft waits for the next change before it is sent.
    @ObservationIgnored private let draftDelay: Double

    init(hooks: AppHooks = AppHooks(), draftDelay: Double = 0.6, clock: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }) {
        self.hooks = hooks
        self.clock = clock
        self.draftDelay = draftDelay
    }

    private var nowMillis: Double { clock() }

    // MARK: start and stop

    /// What the app does at launch: the stored server if there is one, else the first screen stays.
    func resume() {
        guard let stored = hooks.loadLogin(), let link = stored.link else { return }
        start(LiveBoardClient(link: link, cookie: stored.cookie), address: link.display, first: nil, demo: false)
    }

    /// The first screen calls this once the link proved to work.
    func signIn(_ link: ServerLink) async throws {
        let (client, first) = try await LiveBoardClient.connect(link)
        hooks.saveLogin(StoredLogin(link: link, cookie: client.cookie))
        start(client, address: link.display, first: first, demo: false)
    }

    /// The demo board: the fixture of the tests, held in memory.
    func startDemo(failing: String? = nil) {
        guard let data = hooks.demoData(), let stub = try? StubBoardClient(demoJSON: data) else {
            onboardingMessage = "The demo data is missing from this app."
            return
        }
        if let failing, !failing.isEmpty { stub.failNext(failing) }
        start(stub, address: "Demo", first: nil, demo: true)
    }

    /// Any client: the demo, a server, or a board in memory under test.
    func start(_ client: any BoardClient, address: String, first: BoardState?, demo: Bool) {
        stream?.cancel()
        self.client = client
        hooks.clientChanged(client)
        serverAddress = address
        isDemo = demo
        // The demo starts with nothing put off, and leaves the real list alone.
        store = BoardStore(later: demo ? LaterList() : LaterList.decoded(hooks.loadLater()))
        later = store.later
        dismissBack()
        dropDrafts()
        refusals = [:]
        notice = nil
        onboardingMessage = nil
        loaded = false
        connection = .connecting
        if let first { receive(first) }
        phase = .board
        listen(to: client)
    }

    func signOut(message: String? = nil) {
        stream?.cancel()
        stream = nil
        dismissBack()
        dropDrafts()
        if !isDemo { hooks.clearLogin() }
        client = nil
        hooks.clientChanged(nil)
        store.reset()
        state = .empty
        refusals = [:]
        linkTarget = nil
        pendingLink = nil
        loaded = false
        isDemo = false
        onboardingMessage = message
        phase = .onboarding
    }

    // MARK: the event stream

    private func listen(to client: any BoardClient) {
        stream?.cancel()
        stream = Task { [weak self] in
            var attempt = 0
            while !Task.isCancelled {
                do {
                    for try await next in client.events() {
                        attempt = 0
                        self?.receive(next)
                    }
                } catch {
                    if (error as? ClientError) == .unauthorized {
                        self?.signOut(message: ClientError.unauthorized.message)
                        return
                    }
                }
                if Task.isCancelled { return }
                self?.connection = .offline
                attempt += 1
                try? await Task.sleep(nanoseconds: UInt64(Backoff.delay(attempt: attempt) * 1_000_000_000))
                if Task.isCancelled { return }
                self?.connection = .connecting
            }
        }
    }

    /// Coming back to the foreground: a stream that died silently in the background is replaced.
    func reconnect() {
        guard phase == .board, let client else { return }
        if connection != .online { connection = .connecting }
        listen(to: client)
    }

    private func receive(_ next: BoardState) {
        let pruned = store.receive(next)
        loaded = true
        connection = .online
        if pruned { persistLater() }
        refresh()
        resolveLink()
    }

    private func refresh() {
        let shown = store.shown(now: nowMillis)
        if shown != state { state = shown }
        if store.later != later { later = store.later }
    }

    // MARK: answering

    func isPending(_ cardID: String) -> Bool { store.isPending(cardID) }

    /// Answers a question. The answer shows at once; if the server refuses it, the
    /// question comes back and the reason is returned (and shown as a notice).
    @discardableResult
    func decide(_ card: Card, _ option: CardOption, note: String = "", notes: [String: String] = [:]) async -> String? {
        await decide(card, [option], note: note, notes: notes)
    }

    /// Answers a question with the given options: one, or several where the card takes several.
    /// `notes`: what the human wrote on single options, chosen or not. The row leaves at once and
    /// a note offers the way back; the request travels behind it. An answer to a wording the agent
    /// has changed meanwhile is refused (409): the card is back as it is now, with the reason on it.
    @discardableResult
    func decide(_ card: Card, _ options: [CardOption], note: String = "", notes: [String: String] = [:]) async -> String? {
        guard let client else { return "No connection to the server." }
        guard let first = options.first else { return "Not saved: \(BoardError.noAnswer.message)" }
        let answer: Answer = card.multiple ? .several(options.map(\.key)) : .one(first.key)
        guard store.begin(cardID: card.id, answer: answer, note: note, notes: notes) else { return nil }
        refusals[card.id] = nil
        // The answer replaces whatever was ticked but not sent; a draft still waiting to go out is dropped.
        draftTasks.removeValue(forKey: card.id)?.cancel()
        refresh()
        hooks.feedback(.decided)
        if card.kind == .decision {
            say(BackNote(cardID: card.id, head: "Answered: \(options.map(\.label).joined(separator: ", "))", title: card.title, undo: .reopen))
        }
        let cardID = card.id, revised = card.revised
        let sending = Task { try await client.decide(cardID: cardID, answer: answer, note: note, notes: notes, revised: revised) }
        inflight[cardID] = sending
        do {
            try await sending.value
        } catch {
            inflight[cardID] = nil
            store.settle(cardID: cardID)
            refresh()
            hooks.feedback(.failed)
            if back?.cardID == cardID { dismissBack() }
            let reason = "Not saved: \(readable(error))"
            refusals[cardID] = reason
            notice = reason
            return reason
        }
        inflight[cardID] = nil
        // The server's own state normally arrives before this line. Keep our
        // version a little longer in case it is late, then let the server win.
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            self?.store.settle(cardID: cardID)
            self?.refresh()
        }
        return nil
    }

    /// The human has read why an answer was not taken.
    func clearRefusal(_ cardID: String) { refusals[cardID] = nil }

    // MARK: back

    /// Show a note about what just happened; it replaces the one before and goes by itself.
    private func say(_ note: BackNote) {
        backTimer?.cancel()
        back = note
        backTimer = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(AppModel.backSeconds * 1_000_000_000))
            if !Task.isCancelled, self?.back?.id == note.id { self?.back = nil }
        }
    }

    func dismissBack() {
        backTimer?.cancel()
        backTimer = nil
        back = nil
    }

    /// "Back": undo what the note says. Returns the id of the question that is back, or nil
    /// when it did not work (the reason is shown as a notice) or there was nothing to take back.
    @discardableResult
    func takeBack() async -> String? {
        guard let note = back else { return nil }
        dismissBack()
        switch note.undo {
        case .fetchBack:
            fetchBack(note.cardID)
            return note.cardID
        case .reopen:
            // The answer may still be on its way; it has to arrive before it can be taken back.
            // If it does not arrive, there is nothing to take back: the card returned by itself.
            if let sending = inflight[note.cardID], (try? await sending.value) == nil { return nil }
            return await reopen(note.cardID) == nil ? note.cardID : nil
        }
    }

    /// Takes an answer back; the question returns to the stack, open, with what was ticked and
    /// written as its draft. Returns the reason if it did not work.
    @discardableResult
    func reopen(_ cardID: String) async -> String? {
        guard let client else { return "No connection to the server." }
        if back?.cardID == cardID { dismissBack() }
        do {
            try await client.reopen(cardID: cardID)
        } catch {
            hooks.feedback(.failed)
            let reason = "Not taken back: \(readable(error))"
            notice = reason
            return reason
        }
        store.settle(cardID: cardID)
        refresh()
        hooks.feedback(.tap)
        return nil
    }

    // MARK: drafts

    /// What the human ticked and wrote on an open question, kept on the server so that "Later"
    /// loses nothing and another device shows the same. Sent a moment after the last change;
    /// a change that follows sooner replaces the one that was waiting.
    func saveDraft(_ card: Card, _ draft: DraftEditor) {
        guard let client, card.kind == .decision, card.status == .open, !store.isPending(card.id) else { return }
        draftTasks[card.id]?.cancel()
        if draft.matches(state.card(card.id)?.draft, card: card) {
            draftTasks[card.id] = nil
            return
        }
        let cardID = card.id, keys = draft.picked(of: card).map(\.key), note = draft.note, notes = draft.writtenNotes
        let delay = draftDelay
        draftTasks[cardID] = Task { [weak self] in
            if delay > 0 { try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
            if Task.isCancelled { return }
            // A draft that does not arrive is not worth a banner: the ticks are still on screen,
            // and the next change sends the whole draft again.
            try? await client.saveDraft(cardID: cardID, keys: keys, note: note, notes: notes)
            if !Task.isCancelled { self?.draftTasks[cardID] = nil }
        }
    }

    /// True while a changed draft has not gone out yet.
    func hasUnsentDraft(_ cardID: String) -> Bool { draftTasks[cardID] != nil }

    private func dropDrafts() {
        for task in draftTasks.values { task.cancel() }
        draftTasks = [:]
    }

    // MARK: later, and handing a question to its agent

    /// Put a question off: it leaves its sender's group for "Later" at the end of the inbox.
    /// The agent hears nothing of it. `asked`: it was handed to its session instead and
    /// comes back by itself with the reply.
    func putOff(_ card: Card, asked: Bool = false) {
        store.later.putOff(card, asked: asked ? nowMillis : nil)
        persistLater()
        refresh()
        hooks.feedback(.tap)
    }

    /// "Later": put the question off and say so, with the way back.
    func later(_ card: Card) {
        putOff(card)
        say(BackNote(cardID: card.id, head: "Moved to Later", title: card.title, undo: .fetchBack))
    }

    func fetchBack(_ cardID: String) {
        store.later.fetchBack(cardID)
        persistLater()
        refresh()
        hooks.feedback(.tap)
    }

    /// "Explain": one tap asks the session to say more about the question. The card waits
    /// with the agent and comes back with the reply. Returns the reason if it was not sent.
    @discardableResult
    func explain(_ card: Card) async -> String? {
        do {
            try await send(Wording.explainText, to: card.agent, about: card.id)
        } catch {
            hooks.feedback(.failed)
            return "Not asked: \(readable(error))"
        }
        putOff(card, asked: true)
        say(BackNote(cardID: card.id, head: "Asked to explain", title: "It comes back with the answer.", undo: .fetchBack))
        return nil
    }

    /// "Back to agent": hand the card to its session. What stands in the composer is sent
    /// first; then the card leaves, and returns only with the session's reply.
    @discardableResult
    func handBack(_ card: Card, text: String = "") async -> String? {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !words.isEmpty {
            do {
                try await send(words, to: card.agent, about: card.id)
            } catch {
                hooks.feedback(.failed)
                return "Not handed over: \(readable(error))"
            }
        }
        putOff(card, asked: true)
        say(BackNote(cardID: card.id, head: "With the agent", title: "It comes back with the reply.", undo: .fetchBack))
        return nil
    }

    private func persistLater() {
        guard !isDemo else { return }
        hooks.saveLater(store.later.encoded())
    }

    // MARK: chat

    /// Sends a chat message; throws a readable reason and leaves the text with the caller.
    /// `about`: the open question the human asks back about instead of answering it.
    func send(_ text: String, to agent: String, about cardID: String? = nil) async throws {
        guard let client else { throw ClientError.unreachable("") }
        try await client.sendMessage(text, agent: agent, about: cardID)
    }

    func transcribe(_ audio: Data) async throws -> String {
        guard let client else { throw ClientError.unreachable("") }
        return try await client.transcribe(audio: audio, contentType: "audio/mp4")
    }

    // MARK: links to a question

    /// The app was opened with an address (trommi://open?q=102, or a board address with ?q=).
    /// Before the first state has arrived the link is remembered and resolved once the question is known.
    @discardableResult
    func handle(url: URL) -> Bool {
        guard let link = DeepLink.parse(url) else { return false }
        pendingLink = link
        resolveLink()
        return true
    }

    private func resolveLink() {
        guard loaded, let link = pendingLink else { return }
        pendingLink = nil
        if let target = state.target(of: link) {
            linkTarget = target
        } else {
            notice = "This question does not exist on this board."
        }
    }

    /// The view has opened what the link named.
    func consumeLink() { linkTarget = nil }

    /// The address of a question, by its number, for sharing; nil on the demo board.
    func link(to card: Card) -> URL? { client?.media?.link.questionURL(number: card.number) }

    /// The central pad. It exists on the web under /pad; until the app has one of its own it
    /// opens in the in-app browser, signed in through the link.
    func openPad() {
        guard let url = client?.media?.link.padURL else {
            notice = "The pad lives on the server; the demo has none."
            return
        }
        browser = BrowserRequest(url: url)
    }

    // MARK: sessions

    /// One change to a session. The server sends the new state; nothing is shown ahead of it.
    /// Returns the reason if it did not work (also shown as a notice).
    @discardableResult
    private func change(_ work: (any BoardClient) async throws -> Void) async -> String? {
        guard let client else { return "No connection to the server." }
        do {
            try await work(client)
            return nil
        } catch {
            hooks.feedback(.failed)
            let reason = "Not saved: \(readable(error))"
            notice = reason
            return reason
        }
    }

    /// The human's own name and mark for a session.
    @discardableResult
    func rename(_ agent: Agent, name: String, mark: String) async -> String? {
        let changes = agent.edit(name: name, mark: mark)
        return await change { try await $0.editSession(agent: agent.id, changes: changes) }
    }

    @discardableResult
    func star(_ agent: Agent, _ starred: Bool) async -> String? {
        await change { try await $0.star(agent: agent.id, starred: starred) }
    }

    /// Put a disconnected session away, or fetch it back.
    @discardableResult
    func archive(_ agent: Agent, _ archived: Bool) async -> String? {
        await change { try await $0.editSession(agent: agent.id, changes: SessionChanges(archived: archived)) }
    }

    /// Lay one session together with another; they are then shown as one.
    @discardableResult
    func pair(_ agentID: String, with targetID: String) async -> String? {
        let fresh = BoardState.newGroupID(now: nowMillis, random: UInt32.random(in: 0..<UInt32.max))
        return await apply(state.pairing(agentID, with: targetID, newGroup: fresh))
    }

    /// Take a session out of its group.
    @discardableResult
    func unpair(_ agentID: String) async -> String? {
        await apply(state.unpairing(agentID))
    }

    private func apply(_ changes: [(agent: String, group: String?)]) async -> String? {
        for step in changes {
            let group: SessionChanges.Group = step.group.map { SessionChanges.Group.set($0) } ?? SessionChanges.Group.remove
            let agentID = step.agent
            if let reason = await change({ try await $0.editSession(agent: agentID, changes: SessionChanges(group: group)) }) { return reason }
        }
        return nil
    }

    // MARK: links

    /// A link from a message opens in the in-app browser. Links the server wrote
    /// under its own localhost address lead to the board from here.
    func open(link: String) {
        let url = client?.media?.link.destination(of: link) ?? URL(string: link)
        guard let url, let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            notice = "This link cannot be opened here."
            return
        }
        browser = BrowserRequest(url: url)
    }
}
