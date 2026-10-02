// A question as a row and as a whole card: which two tiles stand at its edge,
// what its corner says about urgency, and which option the agent advises.
// Follows questionRow() in client/web/js/inbox.js and fill() in focus.js.
import Foundation

/// The hand-drawn icons of client/web/js/ui.js (SKETCH).
enum SketchKind: String, CaseIterable, Sendable {
    case yes, no, hand, later, back, choose, other, whenever
    /// The composer of a question: dictate, send, hand the card back, attach, ask to explain.
    case mic, send, reverse, clip, explain
    /// Lists and the bar: put away, a pile that unfolds, onward, the inbox, the sessions, help, the pad.
    case archive, unfold, go, tray, heads, question, page
}

/// What stands out in the head of a row. A normal question gets nothing.
enum UrgencyMark: Equatable, Sendable {
    /// A tab flush with the corner: "Blocking", "Blocking · Permission" or "Urgent".
    case tab(String, Urgency)
    /// A small scribbled hourglass: nothing waits on this.
    case whenever
    /// A normal question: nothing stands out.
    case plain
}

/// One answer as a tile.
struct AnswerTile: Equatable, Sendable, Identifiable {
    var option: CardOption
    var sketch: SketchKind
    /// nil for a bare yes/no: the thumb says it.
    var label: String?
    /// The option the agent leads with; filled, and on the right.
    var isLead: Bool
    /// The agent recommends this one; it is circled by hand.
    var advised: Bool
    var id: String { option.key }

    /// What VoiceOver says for the tile.
    var spoken: String { advised ? "\(option.label), recommended by the agent" : option.label }
}

/// What stands at the trailing edge of a row.
enum RowActions: Equatable, Sendable {
    /// A two-way question: thumb down on the left, thumb up on the right.
    case answer([AnswerTile])
    /// Anything else: one wide "Choose". `inline`: it unfolds the row in place with its options;
    /// a card with too much for a row opens as a page of its own instead. `count`: "4 options".
    case choose(inline: Bool, count: String)
}

/// One block of a question on its page: a paragraph, or a paragraph that is an option.
enum CardBlock: Equatable, Identifiable, Sendable {
    case paragraph(index: Int, text: String)
    case option(index: Int, option: CardOption, text: String, advised: Bool, picture: Attachment?)

    var id: Int {
        switch self {
        case .paragraph(let index, _), .option(let index, _, _, _, _): return index
        }
    }
}

/// How the answers stand on the whole card.
enum AnswerMode: Equatable, Sendable {
    /// Two options side by side as tiles: no left, yes right. One tap answers.
    case pair
    /// More options, one below the other. One tap answers.
    case stack
    /// Several may be right: the options are switches, and "Send" sends what is switched on.
    case several
}

extension Card {
    /// Answerable in the list: a yes/no kind of question. Two options with labels
    /// short enough for a tile, at most about three lines of text, and nothing
    /// attached beyond pictures, which the row shows. Same rule as quick() in
    /// inbox.js, which counts UTF-16 units like JavaScript's length.
    var isQuick: Bool {
        if multiple { return false }
        if kind == .permission { return true }
        return options.count == 2
            && options.allSatisfy { Card.fitsTile($0.label) }
            && attachments.allSatisfy { $0.kind == .image }
            && body.utf16.count <= 240
    }

    /// The one rule for a word under a thumb (fitsTile in inbox.js). A tile has room for two
    /// short lines; a label stands there only if it fits them whole, broken between words or
    /// after a hyphen, never inside a word. A label that needs more is answered through "Choose".
    static func fitsTile(_ label: String) -> Bool {
        let line = 14
        // A hyphen inside a word is a place to break: "follow-up" is "follow-" and "up".
        var text = ""
        let units = Array(label.trimmingCharacters(in: .whitespacesAndNewlines))
        for (i, ch) in units.enumerated() {
            text.append(ch)
            if ch == "-", i + 1 < units.count, !units[i + 1].isWhitespace { text.append(" ") }
        }
        var lines = 1, used = 0
        for word in text.split(whereSeparator: \.isWhitespace) {
            let length = word.utf16.count
            if length > line { return false }
            if used > 0, used + 1 + length > line {
                lines += 1
                used = length
            } else {
                used += (used > 0 ? 1 : 0) + length
            }
        }
        return lines <= 2
    }

    /// "Choose" unfolds a card in its row. A card with more than fits there comfortably opens
    /// as a page instead: a long text, code, several pictures, anything to play or download,
    /// many options (needsWindow in inbox.js).
    var needsWindow: Bool {
        body.utf16.count > 480 || body.contains("```") || options.count > 6
            || images.count > 1 || attachments.contains { $0.kind != .image }
    }

    /// "4 options" under the word "Choose"; "4 options, several allowed" where several may be ticked.
    var optionCountLabel: String {
        multiple ? "\(options.count) options, several allowed" : "\(options.count) options"
    }

    /// Many short options stand as small tags instead of one tile each (TAGS_FROM, TAG_CHARS in focus.js).
    var optionsAsTags: Bool {
        kind == .decision && options.count >= 7
            && options.allSatisfy { $0.label.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count <= 18 }
    }

    /// "Nr. 12": a card's number, as it is written wherever a card is named.
    var numberLabel: String { "Nr. \(number)" }

    /// What the card says of itself: "replaces 3 questions · revised" (cardNote in ui.js).
    var selfNote: String {
        [mergedFrom.isEmpty ? "" : "replaces \(mergedFrom.count) questions", revised == nil ? "" : "revised"]
            .filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// The question as blocks when the agent handed it in as one structured text; nil for a
    /// card with body and options, which is drawn as before.
    var blocks: [CardBlock]? {
        guard let sections else { return nil }
        return sections.enumerated().map { index, block in
            guard let key = block.key, let option = options.first(where: { $0.key == key }) else {
                return .paragraph(index: index, text: block.text)
            }
            let picture = block.picture.flatMap { attachments.indices.contains($0) ? attachments[$0] : nil }
            return .option(index: index, option: option, text: block.text, advised: block.recommended || advises(option), picture: picture)
        }
    }

    /// Attachments no block points at: they belong to the card as a whole.
    var looseAttachments: [Attachment] {
        guard let sections else { return attachments }
        let tied = Set(sections.compactMap(\.picture))
        return attachments.enumerated().filter { !tied.contains($0.offset) }.map(\.element)
    }

    /// The sketch on the row of an answered question: a thumb for a yes or no, else the drawing of a choice.
    var answeredSketch: SketchKind {
        guard options.count == 2, !multiple else { return .choose }
        return choice == options.first?.key ? .yes : .no
    }

    /// The option the agent leads with is the "yes": its first one, or "allow" on a permission.
    func isYes(_ option: CardOption) -> Bool {
        kind == .permission ? option.key == "allow" : option.key == options.first?.key
    }

    /// Every option's label is a bare yes, no or ok: the tiles need no words.
    var isBare: Bool {
        !options.isEmpty && options.allSatisfy { AnswerWords.isBare($0.label) }
    }

    /// The agent recommends this option.
    func advises(_ option: CardOption) -> Bool { recommended.contains(option.key) }

    /// The options with the "yes" last, otherwise in the agent's order.
    private var noThenYes: [CardOption] { options.filter { !isYes($0) } + options.filter { isYes($0) } }

    /// The tiles of the row in a list: thumb down on the left, thumb up on the right, on
    /// every card. The option's own word stands under its thumb only when the pair says
    /// more than yes and no (or allow and deny).
    var rowActions: RowActions {
        guard isQuick else { return .choose(inline: !needsWindow, count: optionCountLabel) }
        let bare = !options.isEmpty && options.allSatisfy { AnswerWords.isBare($0.label, orVerdict: true) }
        return .answer(noThenYes.map { option in
            let lead = isYes(option)
            return AnswerTile(option: option, sketch: lead ? .yes : .no, label: bare ? nil : option.label, isLead: lead, advised: advises(option))
        })
    }

    var answerMode: AnswerMode {
        if multiple && kind == .decision { return .several }
        return options.count == 2 ? .pair : .stack
    }

    /// The answers on the whole card. Exactly two options are a pair of tiles like
    /// in the row; more are a stack in the agent's order, without thumbs.
    var cardTiles: [AnswerTile] {
        let pair = answerMode == .pair
        let bare = pair && kind == .decision && isBare
        func label(_ o: CardOption) -> String {
            guard kind == .permission else { return o.label }
            return o.key == "allow" ? "Allow" : o.key == "deny" ? "Deny" : o.label
        }
        return (pair ? noThenYes : options).map { option in
            let lead = pair && isYes(option)
            let sketch: SketchKind = !pair ? .other : lead ? .yes : (AnswerWords.isNegative(option.label) || option.key == "deny") ? .no : .other
            return AnswerTile(option: option, sketch: sketch, label: bare ? nil : label(option), isLead: lead, advised: advises(option))
        }
    }

    /// The words on the "Send" tile of a card that takes several answers.
    static func sendDetail(_ picked: Int) -> String { picked == 0 ? "Choose one or more" : "\(picked) chosen" }

    var urgencyMark: UrgencyMark {
        if kind == .permission { return .tab("Blocking · Permission", .critical) }
        switch urgency {
        case .critical: return .tab("Blocking", .critical)
        case .high: return .tab("Urgent", .high)
        case .low: return .whenever
        case .normal: return .plain
        }
    }

    /// The word for the urgency on the whole card and for VoiceOver; empty for a normal question.
    var urgencyWord: String {
        if kind == .permission { return "Permission" }
        switch urgency {
        case .critical: return "Blocking"
        case .high: return "Urgent"
        case .low: return "Whenever"
        case .normal: return ""
        }
    }

    /// The grey text under the title in a row: reason and body without markdown.
    var excerpt: String {
        [selfNote, urgencyReason, Card.plain(body)].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// The label of the chosen option, or of all of them where several were chosen; nil without an answer.
    var choiceLabel: String? {
        guard let choice else { return nil }
        let keys = choices.isEmpty ? [choice] : choices
        return keys.map { key in options.first { $0.key == key }?.label ?? key }.joined(separator: ", ")
    }

    var images: [Attachment] { attachments.filter { $0.kind == .image } }

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

    /// "Approval: Bash" names the tool after the colon (focus.js).
    var permissionTool: String {
        guard let colon = title.firstIndex(of: ":"), title.distance(from: title.startIndex, to: colon) <= 24 else { return title }
        let name = title[title.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        return name.isEmpty ? "Tool" : name
    }
}

/// Which of two answers is the "no", and which pairs need no words at all.
/// Agents write in the human's language, so English and German both count
/// (NEGATIVE and BARE in inbox.js).
enum AnswerWords {
    private static let bare: Set<String> = ["yes", "no", "ok", "okay", "ja", "nein"]
    private static let verdicts: Set<String> = ["allow", "deny"]
    /// Words that must end at a word boundary ("no" but not "nobody").
    private static let whole = ["no", "not"]
    private static let prefixes = [
        "don't", "do not", "never", "later", "deny", "decline", "reject", "skip", "leave", "keep", "cancel", "only ", "stay",
        "nein", "nicht", "noch nicht", "später", "ablehnen", "lassen", "weglassen", "behalten", "nur ", "abbrechen",
    ]

    /// `orVerdict`: in a row, "Allow" and "Deny" need no word under their thumbs either.
    static func isBare(_ label: String, orVerdict: Bool = false) -> Bool {
        let word = label.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return bare.contains(word) || (orVerdict && verdicts.contains(word))
    }

    static func isNegative(_ label: String) -> Bool {
        let text = label.lowercased()
        for word in whole where text.hasPrefix(word) {
            let after = text.dropFirst(word.count).first
            if after == nil || !(after!.isLetter || after!.isNumber || after! == "_") { return true }
        }
        if prefixes.contains(where: { text.hasPrefix($0) }) { return true }
        // "bei X bleiben": stay with what is there.
        if text.hasPrefix("bei "), let end = text.range(of: " bleiben"), end.lowerBound >= text.index(text.startIndex, offsetBy: 4) { return true }
        return false
    }
}
