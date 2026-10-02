// The whole-card view: which question is in front, and where "back" and
// "next" lead. Opened on one card ("Choose" on a row) it is the window of that
// card alone and closes on the answer. Opened without one ("Go through them")
// it walks every open question: an answer brings the next one in, what was put
// off with "Later" comes last. Follows sync() and go() in client/web/js/focus.js.
import Foundation

struct FocusWalk: Equatable {
    /// Opened on one card: no back and next, and it closes once that card is no longer open.
    private(set) var single: Bool
    /// The open questions in the order they are walked.
    private(set) var order: [String] = []
    /// The question in front; nil when none is left.
    private(set) var current: String?
    /// How many questions were answered in this round.
    private(set) var answered = 0
    /// Opened on a question that is no longer open (from its line in a conversation):
    /// it is shown alone with what became of it, and stays until the human closes it.
    private(set) var looksBack = false

    /// `start`: the card to open alone, or nil to walk from the most urgent one.
    init(start: String?, queue: [String], later: [String]) {
        let order = FocusWalk.ordered(queue, later: later)
        self.order = order
        single = start != nil
        current = start ?? order.first
        looksBack = start.map { !order.contains($0) } ?? false
    }

    /// The server's order, most urgent first; what the human put off comes after everything else.
    static func ordered(_ queue: [String], later: [String]) -> [String] {
        var seen = Set<String>()
        let unique = queue.filter { seen.insert($0).inserted }
        let off = later.filter { unique.contains($0) }
        return unique.filter { !off.contains($0) } + off
    }

    /// The stack changed. Returns false when this window has nothing left to show
    /// and should close: the one card it was opened on is gone.
    @discardableResult
    mutating func sync(queue: [String], later: [String]) -> Bool {
        let before = order
        let at = current.flatMap { before.firstIndex(of: $0) }
        order = FocusWalk.ordered(queue, later: later)
        if let current, order.contains(current) {
            // "Answer again" on a card that was looked back at: it is an open question again.
            looksBack = false
            return true
        }
        if looksBack { return true }
        if single { current = nil; return false }
        // The card in front left the stack: the one that slid into its place is next, else the last one.
        if order.isEmpty { current = nil } else { current = order[min(max(at ?? 0, 0), order.count - 1)] }
        return true
    }

    /// The human answered the card in front.
    mutating func noteAnswered() { answered += 1 }

    /// An answer was taken back: the card is in front again.
    mutating func noteUndone(_ cardID: String) {
        answered = max(0, answered - 1)
        if order.contains(cardID), !single { current = cardID }
    }

    var index: Int? { current.flatMap { order.firstIndex(of: $0) } }
    var canGoBack: Bool { !single && (index ?? 0) > 0 }
    var canGoForward: Bool { !single && index.map { $0 < order.count - 1 } ?? false }

    /// Move without answering. Returns false at either end.
    @discardableResult
    mutating func go(_ delta: Int) -> Bool {
        guard !single, let index, order.indices.contains(index + delta) else { return false }
        current = order[index + delta]
        return true
    }

    var isDone: Bool { current == nil }

    /// "2 of 7" in the title bar; "Question" for a single card.
    var position: String {
        if single { return current == nil ? "All answered" : "Question" }
        guard let index else { return "All answered" }
        return "\(index + 1) of \(order.count)"
    }

    /// The text of the last page.
    var doneText: String {
        let first = answered == 0 ? "No open questions." : answered == 1 ? "One question answered in this round." : "\(answered) questions answered in this round."
        return first + " New ones show up here as soon as an agent wants to know something."
    }
}
