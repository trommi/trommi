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
    private var dictations: [String: AsyncThrowingStream<DictationEvent, Error>.Continuation] = [:]
    private var heard: [String: Int] = [:]
    private var nextDictation = 0
    /// What the board in memory "hears", whatever is said.
    static let dictated = "This is a dictated sentence."
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

    /// The next call of this kind ("decide", "reopen", "message", "session", "star", "draft") fails once, to exercise the rollback.
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
            // As the hub answers: 409 with its own sentence when the question was reworded meanwhile.
            if (error as? BoardError) == .revised { throw ClientError.stale(BoardError.revised.message) }
            throw ClientError.server(readable(error))
        }
        let now = state
        let all = Array(listeners.values)
        lock.unlock()
        for listener in all { listener.yield(now) }
    }

    func sendMessage(_ text: String, agent: String, about cardID: String?) async throws {
        try change("message") { try $0.addUserMessage(text, agent: agent, about: cardID, now: $1) }
    }

    func decide(cardID: String, answer: Answer, note: String, notes: [String: String], revised: Double?) async throws {
        try change("decide") { try $0.decide(cardID: cardID, answer: answer, note: note, notes: notes, seen: .some(revised), now: $1) }
    }

    func saveDraft(cardID: String, keys: [String], note: String, notes: [String: String]) async throws {
        try change("draft") { try $0.setDraft(cardID: cardID, keys: keys, note: note, notes: notes, now: $1) }
    }

    /// What an agent does through its tools, for tests and the demo: reword a question.
    /// `revised` gets the clock's time, and a draft loses what names options that are gone.
    func revise(cardID: String, title: String? = nil, body: String? = nil, options: [CardOption]? = nil) throws {
        try change("revise") { state, now in
            guard let i = state.cards.firstIndex(where: { $0.id == cardID }) else { throw BoardError.unknownCard }
            guard state.cards[i].status == .open else { throw BoardError.alreadyDecided }
            if let title { state.cards[i].title = title }
            if let body { state.cards[i].body = body }
            if let options {
                state.cards[i].options = options
                let known = Set(options.map(\.key))
                state.cards[i].recommended.removeAll { !known.contains($0) }
                state.cards[i].sections = nil
                if var draft = state.cards[i].draft {
                    draft.keys.removeAll { !known.contains($0) }
                    draft.notes = draft.notes.filter { known.contains($0.key) }
                    state.cards[i].draft = draft.isEmpty ? nil : draft
                }
            }
            state.cards[i].revised = now
            state.cards[i].revisions += 1
            let card = state.cards[i]
            state.messages.append(Message(id: "local-\(state.messages.count)-revised-\(card.id)", agent: card.agent, from: .event, kind: "revised",
                                          cardID: card.id, text: card.title, details: "", attachments: [], ts: now))
        }
    }

    /// An agent's reply, optionally about a card.
    func reply(_ text: String, agent: String, about cardID: String? = nil) throws {
        try change("reply") { state, now in
            state.messages.append(Message(id: "local-\(state.messages.count)-reply", agent: agent, from: .agent, kind: "",
                                          cardID: cardID, text: text, details: "", attachments: [], ts: now))
        }
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

    // The dictation of the board in memory: it is ready at once, "hears" its one sentence
    // word by word as sound arrives, and says it whole when stopped.

    func liveDictation() -> AsyncThrowingStream<DictationEvent, Error> {
        AsyncThrowingStream { continuation in
            lock.lock()
            if let at = failures.firstIndex(of: "dictation") {
                failures.remove(at: at)
                lock.unlock()
                return continuation.finish(throwing: ClientError.server("Speech is not set up (TINFOIL_API_KEY or data/tinfoil.key is missing)"))
            }
            nextDictation += 1
            let id = "stub-\(nextDictation)"
            dictations[id] = continuation
            heard[id] = 0
            lock.unlock()
            continuation.onTermination = { [weak self] _ in
                guard let self else { return }
                self.lock.lock()
                self.dictations[id] = nil
                self.heard[id] = nil
                self.lock.unlock()
            }
            continuation.yield(.ready(id: id, rate: PCM.rate, maxSeconds: 180))
        }
    }

    func sendDictationAudio(id: String, pcm: Data) async throws {
        guard pcm.count % 2 == 0 else { throw ClientError.server("audio must be whole 16-bit samples") }
        try hear(id)
    }

    func stopDictation(id: String) async throws {
        endDictation(id)
    }

    /// One more word of the sentence for every piece of sound.
    private func hear(_ id: String) throws {
        let words = StubBoardClient.dictated.split(separator: " ")
        lock.lock()
        guard let stream = dictations[id], let at = heard[id] else {
            lock.unlock()
            throw ClientError.server("This dictation has ended")
        }
        if at < words.count { heard[id] = at + 1 }
        lock.unlock()
        if at < words.count { stream.yield(.delta((at == 0 ? "" : " ") + words[at])) }
    }

    private func endDictation(_ id: String) {
        lock.lock()
        let stream = dictations.removeValue(forKey: id)
        let any = (heard.removeValue(forKey: id) ?? 0) > 0
        lock.unlock()
        stream?.yield(.final(text: any ? StubBoardClient.dictated : "", polished: any, reason: "stop"))
        stream?.finish()
    }
}

extension BoardState {
    /// The same board with every time shifted so that the newest one is `latest`.
    func rebased(latest: Double) -> BoardState {
        let times = cards.map(\.created) + cards.compactMap(\.decided) + messages.map(\.ts) + tasks.map(\.updated)
            + agents.compactMap(\.connected) + agents.compactMap(\.seen) + cards.compactMap(\.revised)
        guard let newest = times.max() else { return self }
        let shift = latest - newest
        var copy = self
        for i in copy.cards.indices {
            copy.cards[i].created += shift
            if let decided = copy.cards[i].decided { copy.cards[i].decided = decided + shift }
            if let revised = copy.cards[i].revised { copy.cards[i].revised = revised + shift }
            if copy.cards[i].draft != nil { copy.cards[i].draft?.ts += shift }
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
