// The inbox: every open question of every session, grouped by who is asking,
// and one "Later" group at the very bottom for what the human put off.
// Follows mountInbox() in client/web/js/inbox.js and the later list in store.js.
import Foundation

/// Questions the human put off with "Later", oldest first. Kept on this device,
/// so a restart does not refill the list that was worked down. An entry goes
/// when its card is no longer open, or when the agent made it more urgent since.
struct LaterList: Equatable, Sendable, Codable {
    struct Entry: Equatable, Sendable, Codable {
        var id: String
        /// The urgency rank at the moment it was put off.
        var rank: Int
    }

    var entries: [Entry] = []

    var ids: [String] { entries.map(\.id) }

    func contains(_ cardID: String) -> Bool { entries.contains { $0.id == cardID } }

    /// Put a card off: it moves to the end of the list.
    mutating func putOff(_ card: Card) {
        entries.removeAll { $0.id == card.id }
        entries.append(Entry(id: card.id, rank: card.urgency.rank))
    }

    mutating func fetchBack(_ cardID: String) {
        entries.removeAll { $0.id == cardID }
    }

    /// Drops what no longer applies. Returns true when something went.
    @discardableResult
    mutating func prune(cards: [Card]) -> Bool {
        var open: [String: Card] = [:]
        for card in cards where card.status == .open { open[card.id] = card }
        let kept = entries.filter { entry in
            guard let card = open[entry.id] else { return false }
            return card.urgency.rank <= entry.rank
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

/// Everything the inbox screen shows, derived from the state and the later list.
struct InboxModel: Equatable {
    /// Still to be worked down, in the order of the stack; what was put off is not counted.
    var fresh: [Card]
    var groups: [InboxGroup]
    var later: [LaterRow]
    /// Limited to one session: no big heading, no sender names.
    var session: String?

    var isEmpty: Bool { fresh.isEmpty && later.isEmpty }

    /// The circled number in front of the line; nil when nothing is new.
    var circled: Int? { fresh.isEmpty ? nil : fresh.count }

    /// The line under the title, after the circled number.
    var line: String {
        if fresh.count == 1 { return "question needs you." }
        if fresh.count > 1 { return "questions need you." }
        return later.isEmpty ? "Nothing needs you." : "Nothing new. What you put off is below."
    }

    /// The whole sentence, for VoiceOver and tests.
    var sentence: String { circled.map { "\($0) \(line)" } ?? line }

    var emptyText: String {
        session == nil ? "As soon as an agent has a question, it shows up here." : "This session has no question for you right now."
    }

    /// "Go through them" walks every open question, one after the other.
    var offersWalk: Bool { session == nil && fresh.count > 1 }

    var laterCountLabel: String { "\(later.count) put off" }
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
        let off = later.ids.compactMap { id in open.first { $0.id == id } }
        let offIDs = Set(off.map(\.id))
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

        let rows = off.map { card in LaterRow(card: card, sender: session == nil ? agent(card.agent) : nil) }
        return InboxModel(fresh: fresh, groups: groups, later: rows, session: session)
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
        return later.prune(cards: state.cards)
    }

    /// The board as the human should see it right now.
    func shown(now: Double) -> BoardState { server.applying(pending, now: now) }

    func isPending(_ cardID: String) -> Bool { pending.contains { $0.cardID == cardID } }

    /// An answer goes out: it shows at once. False when one is already on its way for this card.
    mutating func begin(cardID: String, answer: Answer, note: String) -> Bool {
        guard !isPending(cardID) else { return false }
        pending.append(PendingDecision(cardID: cardID, answer: answer, note: note))
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
