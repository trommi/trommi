// The state the server sends over /events, decoded defensively: unknown fields
// are ignored, missing ones get the same defaults the web client uses
// (client/web/js/store.js, normalize) and the server uses when loading old files.
import Foundation

enum Urgency: String, CaseIterable, Sendable, Codable {
    case low, normal, high, critical

    /// Higher is more urgent. Same numbers as URGENCY_RANK in store.js.
    var rank: Int {
        switch self {
        case .low: return 0
        case .normal: return 1
        case .high: return 2
        case .critical: return 3
        }
    }

    /// Same wording as URGENCY_LABEL in client/web/js/ui.js.
    var label: String {
        switch self {
        case .low: return "Whenever"
        case .normal: return "Normal"
        case .high: return "Urgent"
        case .critical: return "Blocking"
        }
    }
}

enum CardKind: String, Sendable { case decision, permission }
enum CardStatus: String, Sendable { case open, decided, done }
enum TaskState: String, Sendable { case decision, working, done }
enum Sender: String, Sendable { case user, agent, event }
enum AttachmentKind: String, Sendable { case image, video, audio, file, scribble }

struct CardOption: Equatable, Sendable, Identifiable {
    var key: String
    var label: String
    var detail: String
    var id: String { key }
}

struct Attachment: Equatable, Sendable, Identifiable {
    var name: String
    var url: String
    var kind: AttachmentKind
    var size: Int?
    var id: String { url }
}

/// One session on the board. `name` is what the session calls itself; the human
/// may give it a `label` and another `icon` (the seed of its scribbled mark).
struct Agent: Equatable, Sendable, Identifiable {
    var id: String
    var name: String
    var cwd: String = ""
    var online: Bool = false
    /// The human's own name for the session; empty when none was given.
    var label: String = ""
    /// The seed of the mark the human picked; empty means the id.
    var icon: String = ""
    var model: String = ""
    var host: String = ""
    var platform: String = ""
    /// The program on the other end of the channel, e.g. "claude-code 2.1.0".
    var client: String = ""
    var task: String = ""
    /// VIP: its questions lead the inbox.
    var starred: Bool = false
    /// Put away by the human; hidden, and its questions wait with it.
    var archived: Bool = false
    /// Sessions that share a group id are shown together.
    var group: String?
    var joined: Double?
    var connected: Double?
    var seen: Double?
}

/// A page or file the agent published under a link (publish_asset).
struct AssetRef: Equatable, Sendable {
    var id: String
    var type: String
    var title: String
    var note: String
    /// "/a/<id>#<key>" on the board's own address; empty once the asset is gone.
    var url: String
    var gone: Bool
}

/// A question this card replaced when the agent merged several into one (merge_cards).
struct MergedCard: Equatable, Sendable, Identifiable {
    var id: String
    var number: Int
    var title: String
}

/// One block of a question handed in as one structured text (docs/question-contract.md):
/// a plain paragraph, or a paragraph that is an option.
struct CardSection: Equatable, Sendable {
    /// The option's key; nil for a plain paragraph.
    var key: String?
    /// The option's short label; empty for a plain paragraph.
    var label: String
    /// Markdown; may be empty for an option that needs no explanation.
    var text: String
    var recommended: Bool
    /// Index into the card's attachments; nil when no picture belongs to this block.
    var picture: Int?

    var isOption: Bool { key != nil }
}

/// What the human ticked and wrote on an open card without sending it. The hub keeps it,
/// so "Later" loses nothing and another device shows the same ticks.
struct CardDraft: Equatable, Sendable {
    var keys: [String] = []
    /// As typed, not trimmed.
    var note: String = ""
    /// Option key to what was written on that option.
    var notes: [String: String] = [:]
    /// When the hub stored it; a different stamp is a different draft.
    var ts: Double = 0

    var isEmpty: Bool { keys.isEmpty && note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && notes.isEmpty }
}

struct Card: Equatable, Sendable, Identifiable {
    var id: String
    var agent: String
    var number: Int
    var kind: CardKind
    var status: CardStatus
    var urgency: Urgency
    var urgencyReason: String
    var title: String
    var body: String
    var options: [CardOption]
    var attachments: [Attachment]
    var choice: String?
    var note: String
    var summary: String
    /// Milliseconds since 1970, as the server writes them.
    var created: Double
    var decided: Double?
    /// The keys of the options the agent would pick itself: one, or several on a card
    /// that takes several answers; empty when it has no preference.
    var recommended: [String] = []
    /// The human may tick several options and sends them together.
    var multiple: Bool = false
    /// Every chosen key in the order of the options; `choice` is the first of them.
    var choices: [String] = []
    /// When the agent last reworded the question; nil when it stands as it was asked.
    /// An answer names the wording it was given to, and the hub refuses one given to an older wording.
    var revised: Double? = nil
    var revisions: Int = 0
    /// The questions this one replaced; empty for a card that was asked as it is.
    var mergedFrom: [MergedCard] = []
    /// On a card that was merged away: the card that replaced it.
    var mergedInto: String? = nil
    /// The question as blocks tied to its options; nil for a card filed as body plus options.
    var sections: [CardSection]? = nil
    /// What the human wrote on single options when answering, by option key.
    var optionNotes: [String: String] = [:]
    /// What the human attached to the note of the answer.
    var noteAttachments: [Attachment] = []
    /// Ticked and written but not sent; nil when there is none. Only on open questions.
    var draft: CardDraft? = nil
}

struct Message: Equatable, Sendable, Identifiable {
    var id: String
    var agent: String
    var from: Sender
    /// Only for events: asked, decided, done, urgency, reopened.
    var kind: String
    /// The card an event is about. On a chat message: the question the human asked back
    /// about, or the agent answers to.
    var cardID: String?
    var text: String
    /// Longer material the agent chose to show, collapsed under the message.
    var details: String
    var attachments: [Attachment]
    var ts: Double
    var asset: AssetRef? = nil
}

struct TaskLine: Equatable, Sendable, Identifiable {
    var agent: String
    var taskID: String
    var label: String
    var state: TaskState
    var detail: String
    var cardID: String?
    var updated: Double
    var id: String { agent + "/" + taskID }
}

struct BoardState: Equatable, Sendable {
    /// Every session the server knows, archived ones included; views use `sessions`.
    var agents: [Agent] = []
    var messages: [Message] = []
    var cards: [Card] = []
    var tasks: [TaskLine] = []
    /// Ids of the open cards, most urgent first.
    var queue: [String] = []
    var speech: Bool = false

    static let empty = BoardState()

    static func decode(_ data: Data) throws -> BoardState {
        try JSONDecoder().decode(BoardState.self, from: data)
    }

    static func decode(_ json: String) throws -> BoardState {
        try decode(Data(json.utf8))
    }
}

// MARK: - Decoding

private struct AnyKey: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init(_ string: String) { stringValue = string }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

/// An array element that never fails the whole array: a broken entry is dropped.
private struct Lossy<T: Decodable>: Decodable {
    var value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

private struct Fields {
    let box: KeyedDecodingContainer<AnyKey>?

    init(_ decoder: Decoder) { box = try? decoder.container(keyedBy: AnyKey.self) }

    func has(_ key: String) -> Bool { box?.contains(AnyKey(key)) ?? false }

    /// A string, or a number or boolean written out; nil when missing or null.
    func optionalString(_ key: String) -> String? {
        guard let box else { return nil }
        let k = AnyKey(key)
        if let s = try? box.decode(String.self, forKey: k) { return s }
        if let i = try? box.decode(Int.self, forKey: k) { return String(i) }
        if let d = try? box.decode(Double.self, forKey: k) { return String(d) }
        if let b = try? box.decode(Bool.self, forKey: k) { return String(b) }
        return nil
    }

    func string(_ key: String, _ fallback: String = "") -> String { optionalString(key) ?? fallback }

    func double(_ key: String) -> Double? {
        guard let box else { return nil }
        let k = AnyKey(key)
        if let d = try? box.decode(Double.self, forKey: k) { return d }
        if let s = try? box.decode(String.self, forKey: k) { return Double(s) }
        return nil
    }

    func int(_ key: String) -> Int? {
        guard let d = double(key), d.isFinite, abs(d) < 1e15 else { return nil }
        return Int(d)
    }

    func bool(_ key: String) -> Bool {
        guard let box else { return false }
        let k = AnyKey(key)
        if let b = try? box.decode(Bool.self, forKey: k) { return b }
        if let i = try? box.decode(Int.self, forKey: k) { return i != 0 }
        return false
    }

    /// One string or a list of strings; empty when missing or null.
    func strings(_ key: String) -> [String] {
        if let one = optionalString(key) { return [one] }
        return array(key, of: QueueID.self).map(\.value)
    }

    /// A nested object, nil when missing, null or unreadable.
    func object<T: Decodable>(_ key: String, of type: T.Type = T.self) -> T? {
        guard let box else { return nil }
        return (try? box.decode(Lossy<T>.self, forKey: AnyKey(key)))?.value
    }

    /// An object from keys to texts; entries that are not text are dropped.
    func texts(_ key: String) -> [String: String] {
        guard let box, let raw = try? box.decode([String: Lossy<String>].self, forKey: AnyKey(key)) else { return [:] }
        return raw.compactMapValues(\.value)
    }

    /// True when the key is there and holds a list.
    func isArray(_ key: String) -> Bool {
        guard let box else { return false }
        return (try? box.nestedUnkeyedContainer(forKey: AnyKey(key))) != nil
    }

    func array<T: Decodable>(_ key: String, of type: T.Type = T.self) -> [T] {
        guard let box, let raw = try? box.decode([Lossy<T>].self, forKey: AnyKey(key)) else { return [] }
        return raw.compactMap(\.value)
    }
}

extension CardOption: Decodable {
    init(from decoder: Decoder) throws {
        let f = Fields(decoder)
        guard let key = f.optionalString("key") else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "option without key"))
        }
        self.key = key
        label = f.string("label", key)
        detail = f.string("detail")
    }
}

extension Attachment: Decodable {
    init(from decoder: Decoder) throws {
        let f = Fields(decoder)
        guard let url = f.optionalString("url"), !url.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "attachment without url"))
        }
        self.url = url
        name = f.string("name", url.split(separator: "/").last.map(String.init) ?? url)
        // Older servers only say image yes/no; newer ones name the kind.
        kind = AttachmentKind(rawValue: f.string("kind")) ?? (f.bool("image") ? .image : .file)
        size = f.int("size")
    }
}

extension Agent: Decodable {
    init(from decoder: Decoder) throws {
        let f = Fields(decoder)
        guard let id = f.optionalString("id"), !id.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "agent without id"))
        }
        self.id = id
        name = f.string("name", id)
        cwd = f.string("cwd")
        online = f.bool("online")
        label = f.string("label").trimmingCharacters(in: .whitespacesAndNewlines)
        icon = f.string("icon")
        model = f.string("model")
        host = f.string("host")
        platform = f.string("platform")
        client = f.string("client")
        task = f.string("task")
        starred = f.bool("starred")
        archived = f.bool("archived")
        let g = f.string("group").trimmingCharacters(in: .whitespacesAndNewlines)
        group = g.isEmpty ? nil : g
        joined = f.double("joined")
        connected = f.double("connected")
        seen = f.double("seen")
    }
}

extension AssetRef: Decodable {
    init(from decoder: Decoder) throws {
        let f = Fields(decoder)
        guard let id = f.optionalString("id"), !id.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "asset without id"))
        }
        self.id = id
        type = f.string("type", "file")
        title = f.string("title")
        note = f.string("note")
        url = f.string("url")
        gone = f.bool("gone") || url.isEmpty
    }
}

extension MergedCard: Decodable {
    init(from decoder: Decoder) throws {
        let f = Fields(decoder)
        guard let id = f.optionalString("id"), !id.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "merged card without id"))
        }
        self.id = id
        number = f.int("number") ?? 0
        title = f.string("title")
    }
}

extension CardSection: Decodable {
    init(from decoder: Decoder) throws {
        let f = Fields(decoder)
        guard f.box != nil else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "section is not an object"))
        }
        key = f.optionalString("key")
        text = f.string("text")
        label = f.string("label", key ?? "")
        recommended = f.bool("recommended")
        picture = f.int("picture")
        // A plain block is never empty; one that is says nothing and is dropped.
        if key == nil, text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "empty plain section"))
        }
    }
}

extension CardDraft: Decodable {
    init(from decoder: Decoder) throws {
        let f = Fields(decoder)
        guard f.box != nil else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "draft is not an object"))
        }
        keys = f.array("keys", of: QueueID.self).map(\.value)
        note = f.string("note")
        notes = f.texts("notes")
        ts = f.double("ts") ?? 0
    }
}

extension Card: Decodable {
    init(from decoder: Decoder) throws {
        let f = Fields(decoder)
        guard let id = f.optionalString("id"), !id.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "card without id"))
        }
        self.id = id
        agent = f.string("agent")
        number = f.int("number") ?? 0
        kind = CardKind(rawValue: f.string("kind")) ?? .decision
        status = CardStatus(rawValue: f.string("status")) ?? .open
        // Approvals are always critical; anything unknown is normal.
        urgency = kind == .permission ? .critical : (Urgency(rawValue: f.string("urgency")) ?? .normal)
        urgencyReason = f.string("urgency_reason")
        title = f.string("title")
        body = f.string("body")
        options = f.array("options")
        attachments = f.array("attachments")
        choice = f.optionalString("choice")
        note = f.string("note")
        summary = f.string("summary")
        created = f.double("created") ?? 0
        decided = f.double("decided")
        // Advice only counts when it names one of the options. One key, or a list of them.
        let keys = Set(options.map(\.key))
        let advised = f.strings("recommended")
        recommended = advised.filter { keys.contains($0) }
        multiple = f.bool("multiple")
        let chosen = f.strings("choices")
        choices = chosen.isEmpty ? (choice.map { [$0] } ?? []) : chosen
        revised = f.double("revised").flatMap { $0 > 0 ? $0 : nil }
        revisions = f.int("revisions") ?? 0
        mergedFrom = f.array("merged_from")
        mergedInto = f.optionalString("merged_into")
        noteAttachments = f.array("note_attachments")
        optionNotes = f.texts("option_notes").filter { keys.contains($0.key) && !$0.value.isEmpty }
        // Sections only count when they are a list and say what the options say: every flagged
        // block is one of the options. Anything else falls back to body and options.
        if f.isArray("sections") {
            var blocks: [CardSection] = f.array("sections")
            for i in blocks.indices {
                if let picture = blocks[i].picture, !attachments.indices.contains(picture) { blocks[i].picture = nil }
            }
            let flagged = blocks.compactMap(\.key)
            sections = !blocks.isEmpty && flagged.allSatisfy(keys.contains) ? blocks : nil
        } else {
            sections = nil
        }
        // A draft belongs to an open question; what it says about options that are gone is dropped.
        if status == .open, kind == .decision, var kept: CardDraft = f.object("draft") {
            kept.keys = options.map(\.key).filter(kept.keys.contains)
            kept.notes = kept.notes.filter { keys.contains($0.key) && !$0.value.isEmpty }
            draft = kept.isEmpty ? nil : kept
        } else {
            draft = nil
        }
    }
}

extension Message: Decodable {
    init(from decoder: Decoder) throws {
        let f = Fields(decoder)
        guard f.box != nil else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "message is not an object"))
        }
        text = f.string("text")
        ts = f.double("ts") ?? 0
        from = Sender(rawValue: f.string("from")) ?? .agent
        id = f.optionalString("id") ?? "\(from.rawValue)-\(Int(ts))-\(text.hashValue)"
        agent = f.string("agent")
        kind = f.string("kind")
        cardID = f.optionalString("card_id")
        details = f.string("details")
        attachments = f.array("attachments")
        asset = f.object("asset")
    }
}

extension TaskLine: Decodable {
    init(from decoder: Decoder) throws {
        let f = Fields(decoder)
        guard let id = f.optionalString("id"), let state = TaskState(rawValue: f.string("state")) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "status line without id or state"))
        }
        taskID = id
        self.state = state
        agent = f.string("agent")
        label = f.string("label", id)
        detail = f.string("detail")
        cardID = f.optionalString("card_id")
        updated = f.double("updated") ?? 0
    }
}

extension BoardState: Decodable {
    init(from decoder: Decoder) throws {
        let f = Fields(decoder)
        guard f.box != nil else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "state is not an object"))
        }
        var agents: [Agent] = f.array("agents")
        // A state without agents comes from a server older than multi-agent boards.
        if agents.isEmpty { agents = [Agent(id: "main", name: "Agent", online: true)] }
        var seenAgents = Set<String>()
        agents = agents.filter { seenAgents.insert($0.id).inserted }
        let fallback = agents[0].id

        var cards: [Card] = f.array("cards")
        var seen = Set<String>()
        cards = cards.filter { seen.insert($0.id).inserted }
        for i in cards.indices {
            if cards[i].agent.isEmpty { cards[i].agent = fallback }
            if cards[i].number <= 0 { cards[i].number = i + 1 }
        }

        var messages: [Message] = f.array("messages")
        var seenMessages = Set<String>()
        for i in messages.indices {
            if messages[i].agent.isEmpty { messages[i].agent = fallback }
            // Ids must be unique for the list views; a duplicate gets its position appended.
            if !seenMessages.insert(messages[i].id).inserted {
                messages[i].id += "#\(i)"
                seenMessages.insert(messages[i].id)
            }
        }

        var tasks: [TaskLine] = f.array("tasks")
        for i in tasks.indices where tasks[i].agent.isEmpty { tasks[i].agent = fallback }

        self.agents = agents
        self.messages = messages
        self.cards = cards
        self.tasks = tasks
        self.speech = f.bool("speech")
        self.queue = BoardState.repairedQueue(f.has("queue") ? f.array("queue", of: QueueID.self).map(\.value) : nil, cards: cards, agents: agents)
    }
}

/// A card id or an option key in a list; tolerate numbers.
private struct QueueID: Decodable {
    var value: String
    init(from decoder: Decoder) throws {
        let box = try decoder.singleValueContainer()
        if let s = try? box.decode(String.self) { value = s } else { value = String(try box.decode(Int.self)) }
    }
}
