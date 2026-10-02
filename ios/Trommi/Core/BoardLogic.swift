// Everything the views derive from the state, and the changes the app applies
// to it locally. The rules mirror server.mjs (queueOf, decide, reopen) and the
// web client (inbox.js, agents.js), so both clients order and label alike.
import Foundation

// MARK: - Queue

extension BoardState {
    /// The stack order of server.mjs queueOf: approvals first, then by urgency, then oldest first.
    static func queueOf(_ cards: [Card]) -> [String] {
        func rank(_ c: Card) -> Int { c.kind == .permission ? Urgency.allCases.count : c.urgency.rank }
        return cards.filter { $0.status == .open }
            .sorted { a, b in
                if rank(a) != rank(b) { return rank(a) > rank(b) }
                if a.created != b.created { return a.created < b.created }
                return a.number < b.number
            }
            .map(\.id)
    }

    /// The server's queue if it sent one, without ids that are not open cards and
    /// with open cards it forgot appended; computed here if it sent none.
    static func repairedQueue(_ given: [String]?, cards: [Card]) -> [String] {
        let computed = queueOf(cards)
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

// MARK: - Inbox

struct InboxGroup: Equatable, Identifiable {
    var agent: Agent
    var cards: [Card]
    var id: String { agent.id }
}

extension BoardState {
    /// One group per sender; the sender with the most urgent question comes first.
    /// Senders of equal urgency keep the order of the agent list.
    var inboxGroups: [InboxGroup] {
        let open = openCards
        return agents.enumerated()
            .map { (offset: $0.offset, group: InboxGroup(agent: $0.element, cards: open.filter { [id = $0.element.id] in $0.agent == id })) }
            .filter { !$0.group.cards.isEmpty }
            .sorted { a, b in
                let ra = a.group.cards.map(\.urgency.rank).max() ?? 1
                let rb = b.group.cards.map(\.urgency.rank).max() ?? 1
                return ra != rb ? ra > rb : a.offset < b.offset
            }
            .map(\.group)
    }

    /// "3 Fragen warten auf dich." under the inbox title.
    var inboxLine: String {
        switch queue.count {
        case 0: return "Nichts wartet auf dich."
        case 1: return "1 Frage wartet auf dich."
        default: return "\(queue.count) Fragen warten auf dich."
        }
    }
}

extension Card {
    /// Answerable in the list: a yes/no kind of question. Two options with labels
    /// short enough for a button, at most about three lines of text, nothing
    /// attached that the human should look at first. Same rule as quick() in inbox.js,
    /// which counts UTF-16 units like JavaScript's length.
    var isQuick: Bool {
        if kind == .permission { return true }
        return options.count == 2
            && options.allSatisfy { $0.label.utf16.count <= 18 }
            && attachments.isEmpty
            && body.utf16.count <= 240
    }

    /// The buttons of a row or a card. Approvals put "Ablehnen" first and "Erlauben" last.
    var orderedOptions: [CardOption] {
        guard kind == .permission else { return options }
        return options.filter { $0.key != "allow" } + options.filter { $0.key == "allow" }
    }

    /// The option the agent leads with: the first one, or "Erlauben" on an approval.
    var leadKey: String? { kind == .permission ? "allow" : options.first?.key }

    /// The second half of the corner tab: "Nr. 5 | Blockiert".
    var tabLabel: String { kind == .permission ? "Freigabe" : urgency.label }

    /// The grey line under the title in the inbox: reason and body without markdown.
    var excerpt: String {
        [urgencyReason, Card.plain(body)].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// The label of the chosen option, if any.
    var choiceLabel: String? {
        guard let choice else { return nil }
        return options.first { $0.key == choice }?.label ?? choice
    }

    /// Body text with code blocks dropped and markdown signs removed, on one line.
    static func plain(_ text: String) -> String {
        var out = ""
        var rest = Substring(text)
        // Fenced blocks: everything between a pair of ``` goes, an unclosed fence stays.
        while let open = rest.range(of: "```"), let close = rest[open.upperBound...].range(of: "```") {
            out += rest[..<open.lowerBound]
            out += " "
            rest = rest[close.upperBound...]
        }
        out += rest
        out.removeAll { $0 == "*" || $0 == "`" || $0 == "#" }
        return out.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }
}

// MARK: - Sessions

struct AgentSummary: Equatable {
    var open: Int
    var tasks: [TaskLine]
    /// The light of the whole agent: red while a question is open, else the most pressing status line.
    var light: TaskState?
    var lastMessage: Message?
    /// "wartet auf dich", "arbeitet", "fertig", "verbunden" or "getrennt".
    var subtitle: String
}

extension TaskState {
    var order: Int {
        switch self {
        case .decision: return 0
        case .working: return 1
        case .done: return 2
        }
    }

    /// STATE_WORD in agents.js.
    var word: String {
        switch self {
        case .decision: return "wartet auf dich"
        case .working: return "arbeitet"
        case .done: return "fertig"
        }
    }
}

extension BoardState {
    func summary(of agent: Agent) -> AgentSummary {
        let open = openCards.filter { $0.agent == agent.id }.count
        let tasks = self.tasks.filter { $0.agent == agent.id }
        let light: TaskState? = open > 0 ? .decision : tasks.map(\.state).min { $0.order < $1.order }
        let last = messages.last { $0.agent == agent.id && $0.from == .agent }
        let subtitle = agent.online ? (light?.word ?? "verbunden") : "getrennt"
        return AgentSummary(open: open, tasks: tasks, light: light, lastMessage: last, subtitle: subtitle)
    }
}

extension Agent {
    /// The letter in the avatar.
    var initial: String {
        let first = name.unicodeScalars.first { s in
            (s.value >= 48 && s.value <= 57) || (s.value >= 65 && s.value <= 90) || (s.value >= 97 && s.value <= 122)
        }
        return first.map { String($0).uppercased() } ?? "?"
    }

    /// A stable colour per agent: the same hue the web client picks (hueOf in agents.js).
    var hue: Int {
        let hues = [162, 28, 262, 205, 338, 96, 48, 232]
        var h: UInt32 = 0
        for unit in id.utf16 { h = h &* 31 &+ UInt32(unit) }
        return hues[Int(h % UInt32(hues.count))]
    }
}

// MARK: - Labels

enum Wording {
    /// EVENT_LABEL in chat.js.
    static func eventLabel(_ kind: String) -> String {
        switch kind {
        case "asked": return "Neue Frage"
        case "decided": return "Entschieden"
        case "done": return "Erledigt"
        case "urgency": return "Dringlichkeit"
        case "reopened": return "Zurückgenommen"
        default: return "Board"
        }
    }

    /// ago() in ui.js. Timestamps are milliseconds.
    static func ago(_ ts: Double, now: Double) -> String {
        let minutes = Int(((now - ts) / 60000).rounded())
        if minutes < 1 { return "gerade eben" }
        if minutes < 60 { return "vor \(minutes) Min." }
        if minutes < 1440 { return "vor \(Int((Double(minutes) / 60).rounded())) Std." }
        let f = DateFormatter()
        f.locale = Locale(identifier: "de_DE")
        f.dateFormat = "d. MMM"
        return f.string(from: Date(timeIntervalSince1970: ts / 1000))
    }

    static func questions(_ n: Int) -> String { n == 1 ? "1 Frage" : "\(n) Fragen" }
    static func attachments(_ n: Int) -> String { n == 1 ? "1 Anhang" : "\(n) Anhänge" }
    static func openDecisions(_ n: Int) -> String {
        n == 0 ? "alles entschieden" : n == 1 ? "1 Entscheidung offen" : "\(n) Entscheidungen offen"
    }
}

// MARK: - Local changes

/// What the server answers when a change is not possible, in the app's words.
enum BoardError: Error, Equatable {
    case unknownCard
    case alreadyDecided
    case unknownOption
    case notADecision
    case alreadyOpen
    case withdrawn
    case emptyMessage
    case unknownAgent

    var message: String {
        switch self {
        case .unknownCard: return "Diese Karte gibt es nicht mehr."
        case .alreadyDecided: return "Die Karte wurde schon entschieden."
        case .unknownOption: return "Diese Option gibt es nicht."
        case .notADecision: return "Nur Entscheidungen lassen sich zurücknehmen."
        case .alreadyOpen: return "Die Karte ist schon offen."
        case .withdrawn: return "Der Agent hat die Karte zurückgezogen."
        case .emptyMessage: return "Die Nachricht ist leer."
        case .unknownAgent: return "Diesen Agenten gibt es nicht."
        }
    }

    /// The server reports errors in English ({"error": "card already decided"}); say them in German.
    static func translate(_ serverText: String) -> String {
        let known: [(String, BoardError)] = [
            ("unknown card", .unknownCard), ("card already decided", .alreadyDecided),
            ("unknown option", .unknownOption), ("only decisions can be reopened", .notADecision),
            ("card is already open", .alreadyOpen), ("the agent withdrew this card", .withdrawn),
            ("empty message", .emptyMessage), ("no agent ", .unknownAgent),
        ]
        for (text, error) in known where serverText.hasPrefix(text) { return error.message }
        if serverText == "forbidden" { return "Der Server hat die Anfrage abgelehnt." }
        if serverText.hasPrefix("agent is required") { return "Wähle zuerst einen Agenten aus." }
        return serverText
    }
}

/// An answer the human gave that the server has not confirmed yet.
struct PendingDecision: Equatable, Sendable {
    var cardID: String
    var key: String
    var note: String
}

extension BoardState {
    /// What decide() in server.mjs does to the state.
    mutating func decide(cardID: String, key: String, note: String, now: Double) throws {
        guard let i = cards.firstIndex(where: { $0.id == cardID }) else { throw BoardError.unknownCard }
        guard cards[i].status == .open else { throw BoardError.alreadyDecided }
        guard let option = cards[i].options.first(where: { $0.key == key }) else { throw BoardError.unknownOption }
        cards[i].choice = key
        cards[i].note = note.trimmingCharacters(in: .whitespacesAndNewlines)
        cards[i].decided = now
        // A permission verdict needs no follow-up from the agent, so it is done at once.
        cards[i].status = cards[i].kind == .permission ? .done : .decided
        let card = cards[i]
        if card.kind == .decision {
            messages.append(Message(id: "local-\(card.id)-decided-\(Int(now))", agent: card.agent, from: .event, kind: "decided",
                                    cardID: card.id, text: option.label, details: "", attachments: [], ts: now))
        }
        for t in tasks.indices where tasks[t].agent == card.agent && tasks[t].cardID == card.id && tasks[t].state == .decision {
            tasks[t].state = .working
            tasks[t].cardID = nil
            tasks[t].updated = now
        }
        queue = BoardState.queueOf(cards)
    }

    /// What reopen() in server.mjs does to the state.
    mutating func reopen(cardID: String, now: Double) throws {
        guard let i = cards.firstIndex(where: { $0.id == cardID }) else { throw BoardError.unknownCard }
        guard cards[i].kind == .decision else { throw BoardError.notADecision }
        guard cards[i].status != .open else { throw BoardError.alreadyOpen }
        guard cards[i].choice != nil else { throw BoardError.withdrawn }
        cards[i].status = .open
        cards[i].choice = nil
        cards[i].note = ""
        cards[i].summary = ""
        cards[i].decided = nil
        let card = cards[i]
        messages.append(Message(id: "local-\(card.id)-reopened-\(Int(now))", agent: card.agent, from: .event, kind: "reopened",
                                cardID: card.id, text: card.title, details: "", attachments: [], ts: now))
        queue = BoardState.queueOf(cards)
    }

    /// What POST /message does to the state.
    mutating func addUserMessage(_ text: String, agent: String, now: Double) throws {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { throw BoardError.emptyMessage }
        guard agents.contains(where: { $0.id == agent }) else { throw BoardError.unknownAgent }
        messages.append(Message(id: "local-msg-\(messages.count)-\(Int(now))", agent: agent, from: .user, kind: "",
                                cardID: nil, text: clean, details: "", attachments: [], ts: now))
    }

    /// The state as the human should see it while answers are on their way:
    /// every pending answer whose card is still open is shown as given. Answers
    /// the server already knows about, or can no longer take, change nothing.
    func applying(_ pending: [PendingDecision], now: Double) -> BoardState {
        guard !pending.isEmpty else { return self }
        var copy = self
        for p in pending { try? copy.decide(cardID: p.cardID, key: p.key, note: p.note, now: now) }
        return copy
    }
}

// MARK: - Focus flow

enum FocusOrder {
    /// Which card to show after `current` left the stack. `before` is the order
    /// the human was looking at, `after` the order now: the next card that is
    /// still open, else the previous one, else nothing.
    static func next(after current: String, before: [String], after now: [String]) -> String? {
        guard let at = before.firstIndex(of: current) else { return now.first }
        let open = Set(now)
        if let later = before[(at + 1)...].first(where: { open.contains($0) }) { return later }
        if let earlier = before[..<at].last(where: { open.contains($0) }) { return earlier }
        return now.first { $0 != current }
    }
}
