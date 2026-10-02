// The stack of open questions and the changes the app applies to the state
// locally. The rules mirror server.mjs (queueOf, decide, reopen, POST /session,
// POST /star), so what the app shows while it waits is what the server sends.
import Foundation

// MARK: - Queue

extension BoardState {
    /// The stack order of server.mjs queueOf: approvals first, then by urgency, then oldest first.
    /// What an archived session asked stays open but is not in the stack.
    static func queueOf(_ cards: [Card], agents: [Agent] = []) -> [String] {
        func rank(_ c: Card) -> Int { c.kind == .permission ? Urgency.allCases.count : c.urgency.rank }
        let shelved = Set(agents.filter(\.archived).map(\.id))
        return cards.filter { $0.status == .open && !shelved.contains($0.agent) }
            .sorted { a, b in
                if rank(a) != rank(b) { return rank(a) > rank(b) }
                if a.created != b.created { return a.created < b.created }
                return a.number < b.number
            }
            .map(\.id)
    }

    /// The server's queue if it sent one, without ids that are not open cards and
    /// with open cards it forgot appended; computed here if it sent none.
    static func repairedQueue(_ given: [String]?, cards: [Card], agents: [Agent] = []) -> [String] {
        let computed = queueOf(cards, agents: agents)
        guard let given else { return computed }
        let open = Set(computed)
        var seen = Set<String>()
        let kept = given.filter { open.contains($0) && seen.insert($0).inserted }
        return kept + computed.filter { !seen.contains($0) }
    }

    func card(_ id: String?) -> Card? {
        guard let id else { return nil }
        return cards.first { $0.id == id }
    }

    func agent(_ id: String) -> Agent? { agents.first { $0.id == id } }

    /// Open cards in the order of the stack.
    var openCards: [Card] { queue.compactMap { card($0) } }

    func conversation(of agentID: String) -> [Message] { messages.filter { $0.agent == agentID } }
}

// MARK: - Wording

enum Wording {
    /// EVENT_LABEL in chat.js.
    static func eventLabel(_ kind: String) -> String {
        switch kind {
        case "asked": return "New question"
        case "decided": return "Answered"
        case "done": return "Done"
        case "urgency": return "Urgency"
        case "reopened": return "Taken back"
        default: return "Board"
        }
    }

    /// ago() in ui.js. Timestamps are milliseconds.
    static func ago(_ ts: Double, now: Double, timeZone: TimeZone = .current) -> String {
        let minutes = Int(((now - ts) / 60000).rounded())
        if minutes < 1 { return "just now" }
        if minutes < 60 { return "\(minutes) min ago" }
        if minutes < 1440 { return "\(Int((Double(minutes) / 60).rounded())) h ago" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_GB")
        f.timeZone = timeZone
        f.dateFormat = "d MMM"
        return f.string(from: Date(timeIntervalSince1970: ts / 1000))
    }

    /// clock() in ui.js: "14:05".
    static func clock(_ ts: Double, timeZone: TimeZone = .current) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_GB")
        f.timeZone = timeZone
        f.dateFormat = "HH:mm"
        return f.string(from: Date(timeIntervalSince1970: ts / 1000))
    }

    static func questions(_ n: Int) -> String { n == 1 ? "1 question" : "\(n) questions" }
    static func items(_ n: Int) -> String { n == 1 ? "1 item" : "\(n) items" }
    static func sessions(_ n: Int) -> String { n == 1 ? "1 session" : "\(n) sessions" }
}

// MARK: - Errors

/// What the server answers when a change is not possible.
enum BoardError: Error, Equatable {
    case unknownCard
    case alreadyDecided
    case unknownOption
    case notADecision
    case alreadyOpen
    case withdrawn
    case emptyMessage
    case unknownAgent
    case onlineNotArchived
    case oneAnswerOnly
    case noAnswer

    var message: String {
        switch self {
        case .unknownCard: return "This question no longer exists."
        case .alreadyDecided: return "This question was already answered."
        case .unknownOption: return "This option does not exist."
        case .notADecision: return "Only questions can be taken back, not permissions."
        case .alreadyOpen: return "This question is already open."
        case .withdrawn: return "The agent withdrew this question."
        case .emptyMessage: return "The message is empty."
        case .unknownAgent: return "This session no longer exists."
        case .onlineNotArchived: return "A session that is connected cannot be archived."
        case .oneAnswerOnly: return "This question takes one answer."
        case .noAnswer: return "Choose at least one option."
        }
    }

    /// The server's own error texts ({"error": "card already decided"}), said the app's way where known.
    static func translate(_ serverText: String) -> String {
        let known: [(String, BoardError)] = [
            ("unknown card", .unknownCard), ("card already decided", .alreadyDecided),
            ("unknown option", .unknownOption), ("only decisions can be reopened", .notADecision),
            ("card is already open", .alreadyOpen), ("the agent withdrew this card", .withdrawn),
            ("empty message", .emptyMessage), ("no agent ", .unknownAgent),
            ("a session that is online cannot be archived", .onlineNotArchived),
            ("this card takes one answer", .oneAnswerOnly), ("keys must name at least one option", .noAnswer),
        ]
        for (text, error) in known where serverText.hasPrefix(text) { return error.message }
        if serverText == "forbidden" { return "The server refused the request." }
        if serverText.hasPrefix("agent is required") { return "Pick a session first." }
        return serverText
    }
}

// MARK: - Local changes

/// What the human answers: one option, or several on a card that takes several.
/// POST /decide sends `key` for the first and `keys` for the second.
enum Answer: Equatable, Sendable {
    case one(String)
    case several([String])

    var keys: [String] {
        switch self {
        case .one(let key): return [key]
        case .several(let keys): return keys
        }
    }

    /// The JSON body of POST /decide, as server.mjs reads it.
    func body(cardID: String, note: String) -> [String: Any] {
        switch self {
        case .one(let key): return ["card_id": cardID, "key": key, "note": note]
        case .several(let keys): return ["card_id": cardID, "keys": keys, "key": keys.first ?? "", "note": note]
        }
    }
}

/// An answer the human gave that the server has not confirmed yet.
struct PendingDecision: Equatable, Sendable {
    var cardID: String
    var answer: Answer
    var note: String
}

/// What POST /session can change. nil leaves a field alone.
struct SessionChanges: Equatable, Sendable {
    enum Group: Equatable, Sendable {
        case keep
        /// Take the session out of its group (JSON null).
        case remove
        case set(String)
    }

    var label: String?
    var icon: String?
    var archived: Bool?
    var group: Group = .keep

    /// The JSON body of POST /session, as server.mjs reads it.
    func body(agent: String) -> [String: Any] {
        var out: [String: Any] = ["agent": agent]
        if let label { out["label"] = label }
        if let icon { out["icon"] = icon }
        if let archived { out["archived"] = archived }
        switch group {
        case .keep: break
        case .remove: out["group"] = NSNull()
        case .set(let id): out["group"] = id
        }
        return out
    }
}

extension BoardState {
    /// One answer to a card: decide() with a single key.
    mutating func decide(cardID: String, key: String, note: String, now: Double) throws {
        try decide(cardID: cardID, answer: .one(key), note: note, now: now)
    }

    /// What decide() in server.mjs does to the state.
    mutating func decide(cardID: String, answer: Answer, note: String, now: Double) throws {
        guard let i = cards.firstIndex(where: { $0.id == cardID }) else { throw BoardError.unknownCard }
        guard cards[i].status == .open else { throw BoardError.alreadyDecided }
        if case .several = answer, !cards[i].multiple { throw BoardError.oneAnswerOnly }
        let given = Set(answer.keys)
        guard !given.isEmpty else { throw BoardError.noAnswer }
        guard given.allSatisfy({ key in cards[i].options.contains { $0.key == key } }) else { throw BoardError.unknownOption }
        // In the order of the options, whatever order they were ticked in.
        let chosen = cards[i].options.filter { given.contains($0.key) }
        cards[i].choices = chosen.map(\.key)
        // The first one, for clients and agents that know only one answer.
        cards[i].choice = chosen.first?.key
        cards[i].note = note.trimmingCharacters(in: .whitespacesAndNewlines)
        cards[i].decided = now
        // A permission verdict needs no follow-up from the agent, so it is done at once.
        cards[i].status = cards[i].kind == .permission ? .done : .decided
        let card = cards[i]
        if card.kind == .decision {
            messages.append(Message(id: "local-\(messages.count)-decided-\(card.id)", agent: card.agent, from: .event, kind: "decided",
                                    cardID: card.id, text: chosen.map(\.label).joined(separator: ", "), details: "", attachments: [], ts: now))
        }
        for t in tasks.indices where tasks[t].agent == card.agent && tasks[t].cardID == card.id && tasks[t].state == .decision {
            tasks[t].state = .working
            tasks[t].cardID = nil
            tasks[t].updated = now
        }
        queue = BoardState.queueOf(cards, agents: agents)
    }

    /// What reopen() in server.mjs does to the state.
    mutating func reopen(cardID: String, now: Double) throws {
        guard let i = cards.firstIndex(where: { $0.id == cardID }) else { throw BoardError.unknownCard }
        guard cards[i].kind == .decision else { throw BoardError.notADecision }
        guard cards[i].status != .open else { throw BoardError.alreadyOpen }
        guard cards[i].choice != nil else { throw BoardError.withdrawn }
        cards[i].status = .open
        cards[i].choice = nil
        cards[i].choices = []
        cards[i].note = ""
        cards[i].summary = ""
        cards[i].decided = nil
        let card = cards[i]
        messages.append(Message(id: "local-\(messages.count)-reopened-\(card.id)", agent: card.agent, from: .event, kind: "reopened",
                                cardID: card.id, text: card.title, details: "", attachments: [], ts: now))
        queue = BoardState.queueOf(cards, agents: agents)
    }

    /// What POST /message does to the state. `about`: the question the human asks back
    /// about instead of answering it; only an open card of this session counts, and it stays open.
    mutating func addUserMessage(_ text: String, agent: String, about: String? = nil, now: Double) throws {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { throw BoardError.emptyMessage }
        guard agents.contains(where: { $0.id == agent }) else { throw BoardError.unknownAgent }
        let card = cards.first { $0.id == about && $0.agent == agent && $0.status == .open }
        messages.append(Message(id: "local-\(messages.count)-message", agent: agent, from: .user, kind: "",
                                cardID: card?.id, text: clean, details: "", attachments: [], ts: now))
    }

    /// What POST /session does to the state.
    mutating func editSession(_ agentID: String, _ changes: SessionChanges) throws {
        guard let i = agents.firstIndex(where: { $0.id == agentID }) else { throw BoardError.unknownAgent }
        if changes.archived == true, agents[i].online { throw BoardError.onlineNotArchived }
        if let archived = changes.archived { agents[i].archived = archived }
        switch changes.group {
        case .keep: break
        case .remove: agents[i].group = nil
        case .set(let id):
            let clean = String(id.trimmingCharacters(in: .whitespacesAndNewlines).prefix(40))
            agents[i].group = clean.isEmpty ? nil : clean
        }
        if let label = changes.label { agents[i].label = String(label.trimmingCharacters(in: .whitespacesAndNewlines).prefix(60)) }
        if let icon = changes.icon { agents[i].icon = String(icon.prefix(80)) }
        queue = BoardState.queueOf(cards, agents: agents)
    }

    /// What POST /star does to the state.
    mutating func star(_ agentID: String, _ starred: Bool) throws {
        guard let i = agents.firstIndex(where: { $0.id == agentID }) else { throw BoardError.unknownAgent }
        agents[i].starred = starred
    }

    /// The state as the human should see it while answers are on their way:
    /// every pending answer whose card is still open is shown as given. Answers
    /// the server already knows about, or can no longer take, change nothing.
    func applying(_ pending: [PendingDecision], now: Double) -> BoardState {
        guard !pending.isEmpty else { return self }
        var copy = self
        for p in pending { try? copy.decide(cardID: p.cardID, answer: p.answer, note: p.note, now: now) }
        return copy
    }
}
