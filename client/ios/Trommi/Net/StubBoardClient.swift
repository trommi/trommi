// A board in memory that behaves like the server: it takes answers, messages
// and take-backs and sends the whole state after each. Used for the demo on
// the first screen and for the UI tests (launch argument -trommiStub 1).
import Foundation

final class StubBoardClient: BoardClient, @unchecked Sendable {
    private let lock = NSLock()
    private var state: BoardState
    private var listeners: [Int: AsyncThrowingStream<BoardState, Error>.Continuation] = [:]
    private var nextListener = 0
    private var failures: [String] = []
    private let clock: @Sendable () -> Double

    var media: MediaAccess? { nil }

    init(state: BoardState, clock: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 }) {
        self.state = state
        self.clock = clock
    }

    /// The demo board with its times moved so that the newest entry is a minute old.
    convenience init(demoJSON: Data) throws {
        let now = Date().timeIntervalSince1970 * 1000
        self.init(state: try BoardState.decode(demoJSON).rebased(latest: now - 60_000))
    }

    /// The next call of this kind ("decide", "reopen", "message", "session", "star") fails once, to exercise the rollback.
    func failNext(_ call: String) {
        lock.lock(); defer { lock.unlock() }
        failures.append(call)
    }

    var current: BoardState {
        lock.lock(); defer { lock.unlock() }
        return state
    }

    func events() -> AsyncThrowingStream<BoardState, Error> {
        AsyncThrowingStream { continuation in
            lock.lock()
            let id = nextListener
            nextListener += 1
            listeners[id] = continuation
            let now = state
            lock.unlock()
            continuation.yield(now)
            continuation.onTermination = { [weak self] _ in
                guard let self else { return }
                self.lock.lock()
                self.listeners[id] = nil
                self.lock.unlock()
            }
        }
    }

    private func change(_ call: String, _ body: (inout BoardState, Double) throws -> Void) throws {
        lock.lock()
        if let at = failures.firstIndex(of: call) {
            failures.remove(at: at)
            lock.unlock()
            throw ClientError.unreachable("")
        }
        do {
            try body(&state, clock())
        } catch {
            lock.unlock()
            throw ClientError.server(readable(error))
        }
        let now = state
        let all = Array(listeners.values)
        lock.unlock()
        for listener in all { listener.yield(now) }
    }

    func sendMessage(_ text: String, agent: String) async throws {
        try change("message") { try $0.addUserMessage(text, agent: agent, now: $1) }
    }

    func decide(cardID: String, key: String, note: String) async throws {
        try change("decide") { try $0.decide(cardID: cardID, key: key, note: note, now: $1) }
    }

    func reopen(cardID: String) async throws {
        try change("reopen") { try $0.reopen(cardID: cardID, now: $1) }
    }

    func editSession(agent: String, changes: SessionChanges) async throws {
        try change("session") { state, _ in try state.editSession(agent, changes) }
    }

    func star(agent: String, starred: Bool) async throws {
        try change("star") { state, _ in try state.star(agent, starred) }
    }

    func transcribe(audio: Data, contentType: String) async throws -> String {
        "This is a dictated sentence."
    }

    func data(path: String) async throws -> Data { throw ClientError.notFound }
}

extension BoardState {
    /// The same board with every time shifted so that the newest one is `latest`.
    func rebased(latest: Double) -> BoardState {
        let times = cards.map(\.created) + cards.compactMap(\.decided) + messages.map(\.ts) + tasks.map(\.updated)
            + agents.compactMap(\.connected) + agents.compactMap(\.seen)
        guard let newest = times.max() else { return self }
        let shift = latest - newest
        var copy = self
        for i in copy.cards.indices {
            copy.cards[i].created += shift
            if let decided = copy.cards[i].decided { copy.cards[i].decided = decided + shift }
        }
        for i in copy.messages.indices { copy.messages[i].ts += shift }
        for i in copy.tasks.indices { copy.tasks[i].updated += shift }
        for i in copy.agents.indices {
            if let joined = copy.agents[i].joined { copy.agents[i].joined = joined + shift }
            if let connected = copy.agents[i].connected { copy.agents[i].connected = connected + shift }
            if let seen = copy.agents[i].seen { copy.agents[i].seen = seen + shift }
        }
        return copy
    }
}
