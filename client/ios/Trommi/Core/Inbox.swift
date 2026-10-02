// The inbox: every open question of every session, grouped by who is asking,
// and one "Later" group at the very bottom for what the human put off.
// Follows mountInbox() in client/web/js/inbox.js and the later list in store.js.
import Foundation

/// Questions the human put off, oldest first: with "Later" (they wait for the human), or by
/// handing them to their session ("Explain", "Back to agent": they wait for the agent and come
/// back by themselves with its reply). Kept on this device, as the web keeps it per browser,
/// so a restart does not refill the list that was worked down. An entry goes when its card is
/// no longer open, when the agent made it more urgent since, or when the session has replied.
struct LaterList: Equatable, Sendable, Codable {
    struct Entry: Equatable, Sendable, Codable {
        var id: String
        /// The urgency rank at the moment it was put off.
        var rank: Int
        /// When it was handed to its session, in milliseconds; 0 for a plain "Later".
        var asked: Double = 0

        var handed: Bool { asked > 0 }

        init(id: String, rank: Int, asked: Double = 0) {
            self.id = id
            self.rank = rank
            self.asked = asked
        }

        /// Lists stored by the version before "Back to agent" have no `asked`.
        init(from decoder: Decoder) throws {
            let box = try decoder.container(keyedBy: CodingKeys.self)
            id = try box.decode(String.self, forKey: .id)
            rank = try box.decode(Int.self, forKey: .rank)
            asked = (try? box.decodeIfPresent(Double.self, forKey: .asked)) ?? 0
        }
    }

    var entries: [Entry] = []

    var ids: [String] { entries.map(\.id) }

    /// Of those, the ones handed to their session.
    var handed: [String] { entries.filter(\.handed).map(\.id) }

    func contains(_ cardID: String) -> Bool { entries.contains { $0.id == cardID } }

    func isHanded(_ cardID: String) -> Bool { entries.contains { $0.id == cardID && $0.handed } }

    /// Put a card off: it moves to the end of the list. `asked`: the moment it was handed to
    /// its session; nil for a plain "Later", of which the agent hears nothing.
    mutating func putOff(_ card: Card, asked: Double? = nil) {
        entries.removeAll { $0.id == card.id }
        entries.append(Entry(id: card.id, rank: card.urgency.rank, asked: asked ?? 0))
    }

    mutating func fetchBack(_ cardID: String) {
        entries.removeAll { $0.id == cardID }
    }

    /// Drops what no longer applies. Returns true when something went.
    @discardableResult
    mutating func prune(cards: [Card], messages: [Message] = []) -> Bool {
        var open: [String: Card] = [:]
        for card in cards where card.status == .open { open[card.id] = card }
        let kept = entries.filter { entry in
            guard let card = open[entry.id] else { return false }
            guard card.urgency.rank <= entry.rank else { return false }
            // Handed to its session: it returns once the session has said something about it since.
            if entry.handed, messages.contains(where: { $0.cardID == entry.id && $0.from == .agent && $0.ts > entry.asked }) { return false }
            return true
        }
        guard kept.count != entries.count else { return false }
        entries = kept
        return true
    }

    /// What is stored between launches.
    func encoded() -> Data { (try? JSONEncoder().encode(self)) ?? Data() }

    static func decoded(_ data: Data?) -> LaterList {
        guard let data, let list = try? JSONDecoder().decode(LaterList.self, from: data) else { return LaterList() }
        return list
    }
}

struct InboxGroup: Equatable, Identifiable {
    var agent: Agent
    var cards: [Card]
    var id: String { agent.id }
    /// "3 questions" beside the sender's name.
    var countLabel: String { Wording.questions(cards.count) }
}

/// A question in the "Later" group: it no longer stands under its sender, so the row names it.
struct LaterRow: Equatable, Identifiable {
    var card: Card
    var sender: Agent?
    var id: String { card.id }
}

/// An answered question at the foot of the inbox, with the way to take the answer back.
struct AnsweredRow: Equatable, Identifiable {
    var card: Card
    var sender: Agent?
    var id: String { card.id }
    /// The labels of what was chosen.
    var answer: String { card.choiceLabel ?? "" }
    /// The agent has closed the card since; the answer can still be taken back.
    var closed: Bool { card.status == .done }
}

/// The piles at the foot of the inbox. They lie side by side, each small, and fan open on a tap;
/// one is open at a time.
enum InboxPile: String, CaseIterable, Identifiable, Sendable {
    /// Put off with "Later": they wait for the human.
    case later
    /// Handed to their session: they come back with its reply.
    case handed
    case answered

    var id: String { rawValue }

    var title: String {
        switch self {
        case .later: return "Later"
        case .handed: return "With the agent"
        case .answered: return "Answered"
        }
    }

    var sketch: SketchKind {
        switch self {
        case .later: return .later
        case .handed: return .explain
        case .answered: return .yes
        }
    }
}

/// Everything the inbox screen shows, derived from the state and the later list.
struct InboxModel: Equatable {
    /// So many of the latest answers are listed (ANSWERED_MAX in inbox.js).
    static let answeredMax = 40

    /// Still to be worked down, in the order of the stack; what was put off is not counted.
    var fresh: [Card]
    var groups: [InboxGroup]
    /// Put off with "Later", in the order they were put off.
    var later: [LaterRow]
    /// Handed to their session ("Explain", "Back to agent").
    var handed: [LaterRow] = []
    /// What was answered, the latest first. Only in the inbox of the whole board.
    var answered: [AnsweredRow] = []
    /// Limited to one session: no big heading, no sender names.
    var session: String?

    var isEmpty: Bool { fresh.isEmpty && later.isEmpty && handed.isEmpty }

    /// The circled number in front of the line; nil when nothing is new.
    var circled: Int? { fresh.isEmpty ? nil : fresh.count }

    /// The line under the title, after the circled number.
    var line: String {
        if fresh.count == 1 { return "question needs you." }
        if fresh.count > 1 { return "questions need you." }
        return later.isEmpty && handed.isEmpty ? "Nothing needs you." : "Nothing new. What you put off is below."
    }

    /// The whole sentence, for VoiceOver and tests.
    var sentence: String { circled.map { "\($0) \(line)" } ?? line }

    var emptyText: String {
        session == nil ? "As soon as an agent has a question, it shows up here." : "This session has no question for you right now."
    }

    /// The count and its sentence are the way into the walk: every open question, one after
    /// the other. Also when there is only one.
    var offersWalk: Bool { session == nil && !fresh.isEmpty }

    var laterCountLabel: String { "\(later.count) put off" }
    var handedCountLabel: String { "\(handed.count) asked" }

    /// "3 today", "3 today · 12 in all" or "12".
    func answeredCountLabel(now: Double, calendar: Calendar = .current) -> String {
        let today = Date(timeIntervalSince1970: now / 1000)
        let n = answered.filter { calendar.isDate(Date(timeIntervalSince1970: ($0.card.decided ?? 0) / 1000), inSameDayAs: today) }.count
        if n == answered.count { return "\(n) today" }
        return n > 0 ? "\(n) today · \(answered.count) in all" : "\(answered.count)"
    }

    /// The piles that have something in them, in the order they lie at the foot of the list.
    var piles: [InboxPile] {
        [later.isEmpty ? nil : InboxPile.later, handed.isEmpty ? nil : .handed, answered.isEmpty ? nil : .answered].compactMap { $0 }
    }

    func count(of pile: InboxPile, now: Double, calendar: Calendar = .current) -> String {
        switch pile {
        case .later: return laterCountLabel
        case .handed: return handedCountLabel
        case .answered: return answeredCountLabel(now: now, calendar: calendar)
        }
    }

    /// The top card of a folded pile: the title, and under it a word more.
    func top(of pile: InboxPile) -> (title: String, tail: String)? {
        func tail(_ row: LaterRow) -> String { [row.sender?.displayName, row.card.numberLabel].compactMap { $0 }.joined(separator: " · ") }
        switch pile {
        case .later: return later.first.map { ($0.card.title, tail($0)) }
        case .handed: return handed.first.map { ($0.card.title, tail($0)) }
        case .answered: return answered.first.map { ($0.card.title, $0.answer) }
        }
    }
}

extension BoardState {
    /// Sessions the human has not put away.
    var sessions: [Agent] { agents.filter { !$0.archived } }

    var archivedSessions: [Agent] { agents.filter(\.archived) }

    /// Several sessions share the board: rows outside a sender's group then say who is asking.
    var severalSessions: Bool { sessions.count > 1 }

    /// The inbox of the whole board, or of one session.
    func inbox(later: LaterList, session: String? = nil) -> InboxModel {
        let open = openCards.filter { session == nil || $0.agent == session }
        let off = later.entries.compactMap { entry in open.first { $0.id == entry.id }.map { (card: $0, handed: entry.handed) } }
        let offIDs = Set(off.map(\.card.id))
        let fresh = open.filter { !offIDs.contains($0.id) }
        let senders = sessions.filter { session == nil || $0.id == session }

        // One group per sender. Starred sessions come first, then whoever has the
        // most urgent question; otherwise the order of the session list.
        let groups = senders.enumerated()
            .map { (offset: $0.offset, group: InboxGroup(agent: $0.element, cards: fresh.filter { [id = $0.element.id] in $0.agent == id })) }
            .filter { !$0.group.cards.isEmpty }
            .sorted { a, b in
                if a.group.agent.starred != b.group.agent.starred { return a.group.agent.starred }
                let ra = a.group.cards.map(\.urgency.rank).max() ?? 1
                let rb = b.group.cards.map(\.urgency.rank).max() ?? 1
                return ra != rb ? ra > rb : a.offset < b.offset
            }
            .map(\.group)

        func row(_ card: Card) -> LaterRow { LaterRow(card: card, sender: session == nil ? agent(card.agent) : nil) }
        // What was answered: the latest first. A card the agent has closed since is still listed; the server lets it be reopened.
        let answered: [AnsweredRow] = session != nil ? [] : cards.enumerated()
            .filter { $0.element.status != .open && $0.element.kind == .decision && $0.element.choice != nil }
            .sorted { a, b in
                let da = a.element.decided ?? 0, db = b.element.decided ?? 0
                return da != db ? da > db : a.offset < b.offset
            }
            .prefix(InboxModel.answeredMax)
            .map { AnsweredRow(card: $0.element, sender: agent($0.element.agent)) }
        return InboxModel(fresh: fresh, groups: groups, later: off.filter { !$0.handed }.map { row($0.card) },
                          handed: off.filter(\.handed).map { row($0.card) }, answered: answered, session: session)
    }

    /// How many questions are still to be worked down: the number on the inbox tab.
    func freshCount(later: LaterList) -> Int {
        let off = Set(later.ids)
        return queue.filter { !off.contains($0) }.count
    }
}

// MARK: - The board as the app holds it

/// The server's state, the answers still on their way, and the later list.
/// Plain values, so the rules can be tested without the app around them.
struct BoardStore: Equatable {
    private(set) var server: BoardState = .empty
    private(set) var pending: [PendingDecision] = []
    var later = LaterList()

    init(later: LaterList = LaterList()) { self.later = later }

    /// A new state from the server. Returns true when the later list lost entries and must be stored again.
    @discardableResult
    mutating func receive(_ state: BoardState) -> Bool {
        server = state
        return later.prune(cards: state.cards, messages: state.messages)
    }

    /// The board as the human should see it right now.
    func shown(now: Double) -> BoardState { server.applying(pending, now: now) }

    func isPending(_ cardID: String) -> Bool { pending.contains { $0.cardID == cardID } }

    /// An answer goes out: it shows at once. False when one is already on its way for this card.
    mutating func begin(cardID: String, answer: Answer, note: String, notes: [String: String] = [:]) -> Bool {
        guard !isPending(cardID) else { return false }
        pending.append(PendingDecision(cardID: cardID, answer: answer, note: note, notes: notes))
        return true
    }

    /// The server refused the answer, or took it back: the card is as the server says again.
    mutating func settle(cardID: String) {
        pending.removeAll { $0.cardID == cardID }
    }

    mutating func reset() {
        server = .empty
        pending = []
    }
}
