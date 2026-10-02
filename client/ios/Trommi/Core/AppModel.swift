// The one place that holds the board: it keeps the event stream alive, shows
// answers at once and takes them back if the server refuses, and offers undo.
import SwiftUI

@MainActor
@Observable
final class AppModel {
    enum Phase { case onboarding, board }

    enum Connection {
        case connecting, online, offline

        /// CONN_TEXT in public/js/app.js.
        var text: String {
            switch self {
            case .connecting: return "Verbindet"
            case .online: return "Verbunden"
            case .offline: return "Getrennt"
            }
        }
    }

    struct UndoOffer: Identifiable, Equatable {
        let id = UUID()
        var cardID: String
        var number: Int
        var label: String
    }

    /// How long "Rückgängig" stays on screen, as in the web inbox.
    static let undoSeconds: Double = 10

    private(set) var phase: Phase = .onboarding
    /// The board as the human should see it: the server's state plus answers still on their way.
    private(set) var state: BoardState = .empty
    /// False until the first state arrived.
    private(set) var loaded = false
    private(set) var connection: Connection = .connecting
    private(set) var undo: UndoOffer?
    private(set) var isDemo = false
    private(set) var serverAddress = ""
    /// A sentence for the banner at the top: something was not taken over.
    var notice: String?
    /// Shown on the first screen, e.g. after the server refused the stored token.
    var onboardingMessage: String?

    let images = ImageStore()
    let speaker = Speaker()

    @ObservationIgnored private(set) var client: (any BoardClient)?
    @ObservationIgnored private var server: BoardState = .empty
    @ObservationIgnored private var pending: [PendingDecision] = []
    @ObservationIgnored private var stream: Task<Void, Never>?
    @ObservationIgnored private var undoTimer: Task<Void, Never>?

    /// Several agents share the board: cards then say who is asking.
    var severalAgents: Bool { state.agents.count > 1 }

    // MARK: start and stop

    /// What the app does at launch: the stub for UI tests, else the stored server, else the first screen.
    static func launch() -> AppModel {
        let model = AppModel()
        if UserDefaults.standard.bool(forKey: "trommiStub") {
            model.startDemo(failing: UserDefaults.standard.string(forKey: "trommiStubFail"))
        } else if let stored = Keychain.load(), let link = stored.link {
            model.start(LiveBoardClient(link: link, cookie: stored.cookie), address: link.display, first: nil)
        }
        return model
    }

    /// The first screen calls this once the link proved to work.
    func signIn(_ link: ServerLink) async throws {
        let (client, first) = try await LiveBoardClient.connect(link)
        Keychain.save(StoredLogin(link: link, cookie: client.cookie))
        isDemo = false
        start(client, address: link.display, first: first)
    }

    /// The demo board: the fixture of the tests, held in memory.
    func startDemo(failing: String? = nil) {
        guard let url = Bundle.main.url(forResource: "demo-state", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let stub = try? StubBoardClient(demoJSON: data) else {
            onboardingMessage = "Die Demodaten fehlen in dieser App."
            return
        }
        if let failing, !failing.isEmpty { stub.failNext(failing) }
        isDemo = true
        start(stub, address: "Demo", first: nil)
    }

    private func start(_ client: any BoardClient, address: String, first: BoardState?) {
        stream?.cancel()
        self.client = client
        images.client = client
        speaker.client = client
        serverAddress = address
        pending = []
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
        speaker.stop()
        if !isDemo { Keychain.clear() }
        client = nil
        images.client = nil
        speaker.client = nil
        server = .empty
        state = .empty
        pending = []
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
                    for try await state in client.events() {
                        attempt = 0
                        self?.receive(state)
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
        server = next
        loaded = true
        connection = .online
        refresh()
    }

    private func refresh() {
        let shown = server.applying(pending, now: Date().timeIntervalSince1970 * 1000)
        if shown != state { state = shown }
    }

    // MARK: answering

    func isPending(_ cardID: String) -> Bool { pending.contains { $0.cardID == cardID } }

    /// Answers a card. The answer shows at once; if the server refuses it, the
    /// card comes back and the reason is returned (and shown as a notice).
    @discardableResult
    func decide(_ card: Card, _ option: CardOption, note: String = "") async -> String? {
        guard let client else { return "Keine Verbindung zum Server." }
        guard !isPending(card.id) else { return nil }
        pending.append(PendingDecision(cardID: card.id, key: option.key, note: note))
        refresh()
        Haptics.decided()
        do {
            try await client.decide(cardID: card.id, key: option.key, note: note)
        } catch {
            pending.removeAll { $0.cardID == card.id }
            refresh()
            Haptics.failed()
            let reason = "Nicht übernommen: \(readable(error))"
            notice = reason
            return reason
        }
        if card.kind == .decision { offerUndo(card, option) }
        // The server's own state normally arrives before this line. Keep our
        // version a little longer in case it is late, then let the server win.
        let cardID = card.id
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            self?.pending.removeAll { $0.cardID == cardID }
            self?.refresh()
        }
        return nil
    }

    private func offerUndo(_ card: Card, _ option: CardOption) {
        undoTimer?.cancel()
        let offer = UndoOffer(cardID: card.id, number: card.number, label: option.label)
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

    /// Takes an answer back; the card returns to the stack. Returns the reason if it did not work.
    @discardableResult
    func reopen(_ cardID: String) async -> String? {
        guard let client else { return "Keine Verbindung zum Server." }
        if undo?.cardID == cardID { dismissUndo() }
        do {
            try await client.reopen(cardID: cardID)
        } catch {
            Haptics.failed()
            let reason = "Nicht zurückgenommen: \(readable(error))"
            notice = reason
            return reason
        }
        pending.removeAll { $0.cardID == cardID }
        refresh()
        Haptics.tap()
        return nil
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
}
