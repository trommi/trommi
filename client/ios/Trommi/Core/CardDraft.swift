// What the human has ticked and written on an open question without sending it:
// the ticks, the note, and a note on single options. The hub keeps it on the
// card (card.draft, POST /draft), so "Later" loses nothing and another device
// shows the same. This is the copy a view edits; see docs/question-contract.md.
import Foundation

struct DraftEditor: Equatable, Sendable {
    /// The ticked options.
    var keys: Set<String> = []
    /// The general note, as typed.
    var note = ""
    /// What was written on single options, chosen or not.
    var notes: [String: String] = [:]
    /// The stamp of the hub's draft this copy was last taken from; 0 when from none.
    private(set) var adopted: Double = 0

    init() {}

    /// The card as it is shown first: its draft is the initial state.
    init(card: Card) {
        take(card.draft)
    }

    private mutating func take(_ draft: CardDraft?) {
        keys = Set(draft?.keys ?? [])
        note = draft?.note ?? ""
        notes = draft?.notes ?? [:]
        adopted = draft?.ts ?? 0
    }

    /// A new state arrived. The hub's draft is adopted when its stamp differs from the one
    /// this copy came from and the human is not typing in the card; whatever names options
    /// that no longer exist (the agent revised the card) is dropped either way.
    /// Returns true when something changed.
    @discardableResult
    mutating func sync(card: Card, typing: Bool) -> Bool {
        let before = self
        let stamp = card.draft?.ts ?? 0
        if stamp != adopted, !typing { take(card.draft) }
        let known = Set(card.options.map(\.key))
        keys.formIntersection(known)
        notes = notes.filter { known.contains($0.key) }
        return self != before
    }

    /// Tick or untick an option. On a card that takes one answer a tick replaces the one before.
    mutating func toggle(_ key: String, multiple: Bool) {
        if keys.contains(key) {
            keys.remove(key)
        } else if multiple {
            keys.insert(key)
        } else {
            keys = [key]
        }
    }

    mutating func setNote(_ text: String, on key: String) {
        if text.isEmpty { notes[key] = nil } else { notes[key] = text }
    }

    /// The ticked options in the order of the card's options.
    func picked(of card: Card) -> [CardOption] { card.options.filter { keys.contains($0.key) } }

    /// The notes that say something, trimmed, as they are sent with an answer.
    var writtenNotes: [String: String] { Answer.clean(notes) }

    var isEmpty: Bool { keys.isEmpty && note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && writtenNotes.isEmpty }

    /// The same content as the hub's draft: nothing to send.
    func matches(_ draft: CardDraft?, card: Card) -> Bool {
        guard let draft else { return isEmpty }
        return draft.keys == picked(of: card).map(\.key) && draft.note == note && draft.notes == writtenNotes
    }

    /// The JSON body of POST /draft: always the whole draft; an empty one clears it.
    static func body(cardID: String, keys: [String], note: String, notes: [String: String]) -> [String: Any] {
        ["card_id": cardID, "keys": keys, "note": note, "notes": Answer.clean(notes)]
    }
}
