// The one place that holds the board: it keeps the event stream alive, shows
// answers at once and takes them back if the server refuses, offers undo, and
// remembers what was put off with "Later". The rules themselves live in Core
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

/// "Answered: Postgres – Undo", for ten seconds after an answer.
struct UndoOffer: Identifiable, Equatable {
    let id = UUID()
    var cardID: String
    var title: String
    var label: String
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

    /// How long "Undo" stays on screen, as in the web client.
    static let undoSeconds: Double = 10

    private(set) var phase: Phase = .onboarding
    /// The board as the human should see it: the server's state plus answers still on their way.
    private(set) var state: BoardState = .empty
    /// What was put off with "Later".
    private(set) var later = LaterList()
    /// False until the first state arrived.
    private(set) var loaded = false
    private(set) var connection: Connection = .connecting
    private(set) var undo: UndoOffer?
    private(set) var isDemo = false
    private(set) var serverAddress = ""
    /// A sentence for the banner at the top: something was not saved.
    var notice: String?
    /// Shown on the first screen, e.g. after the server refused the stored token.
    var onboardingMessage: String?
    /// A link the human tapped; the root view shows it in the in-app browser.
    var browser: BrowserRequest?

    @ObservationIgnored private(set) var client: (any BoardClient)?
    @ObservationIgnored private var store = BoardStore()
    @ObservationIgnored private var stream: Task<Void, Never>?
    @ObservationIgnored private var undoTimer: Task<Void, Never>?
    @ObservationIgnored private let hooks: AppHooks
    @ObservationIgnored private let clock: () -> Double

    init(hooks: AppHooks = AppHooks(), clock: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }) {
        self.hooks = hooks
        self.clock = clock
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
        undo = nil
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
        undoTimer?.cancel()
        if !isDemo { hooks.clearLogin() }
        client = nil
        hooks.clientChanged(nil)
        store.reset()
        state = .empty
        undo = nil
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
    func decide(_ card: Card, _ option: CardOption, note: String = "") async -> String? {
        guard let client else { return "No connection to the server." }
        guard store.begin(cardID: card.id, key: option.key, note: note) else { return nil }
        refresh()
        hooks.feedback(.decided)
        do {
            try await client.decide(cardID: card.id, key: option.key, note: note)
        } catch {
            store.settle(cardID: card.id)
            refresh()
            hooks.feedback(.failed)
            let reason = "Not saved: \(readable(error))"
            notice = reason
            return reason
        }
        if card.kind == .decision { offerUndo(card, option) }
        // The server's own state normally arrives before this line. Keep our
        // version a little longer in case it is late, then let the server win.
        let cardID = card.id
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            self?.store.settle(cardID: cardID)
            self?.refresh()
        }
        return nil
    }

    private func offerUndo(_ card: Card, _ option: CardOption) {
        undoTimer?.cancel()
        let offer = UndoOffer(cardID: card.id, title: card.title, label: option.label)
        undo = offer
        undoTimer = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(AppModel.undoSeconds * 1_000_000_000))
            if !Task.isCancelled, self?.undo?.id == offer.id { self?.undo = nil }
        }
    }

    func dismissUndo() {
        undoTimer?.cancel()
        undo = nil
    }

    /// Takes an answer back; the question returns to the stack. Returns the reason if it did not work.
    @discardableResult
    func reopen(_ cardID: String) async -> String? {
        guard let client else { return "No connection to the server." }
        if undo?.cardID == cardID { dismissUndo() }
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

    // MARK: later

    /// Put a question off: it leaves its sender's group for "Later" at the end of the inbox.
    func putOff(_ card: Card) {
        store.later.putOff(card)
        persistLater()
        refresh()
        hooks.feedback(.tap)
    }

    func fetchBack(_ cardID: String) {
        store.later.fetchBack(cardID)
        persistLater()
        refresh()
        hooks.feedback(.tap)
    }

    private func persistLater() {
        guard !isDemo else { return }
        hooks.saveLater(store.later.encoded())
    }

    // MARK: chat

    /// Sends a chat message; throws a readable reason and leaves the text with the caller.
    func send(_ text: String, to agent: String) async throws {
        guard let client else { throw ClientError.unreachable("") }
        try await client.sendMessage(text, agent: agent)
    }

    func transcribe(_ audio: Data) async throws -> String {
        guard let client else { throw ClientError.unreachable("") }
        return try await client.transcribe(audio: audio, contentType: "audio/mp4")
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
