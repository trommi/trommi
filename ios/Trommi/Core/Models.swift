// The state the server sends over /events, decoded defensively: unknown fields
// are ignored, missing ones get the same defaults the web client uses
// (public/js/store.js, normalize) and the server uses when loading old files.
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

    /// Same wording as URGENCY_LABEL in public/js/ui.js.
    var label: String {
        switch self {
        case .low: return "Hat Zeit"
        case .normal: return "Normal"
        case .high: return "Dringend"
        case .critical: return "Blockiert"
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

struct Agent: Equatable, Sendable, Identifiable {
    var id: String
    var name: String
    var cwd: String
    var online: Bool
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
}

struct Message: Equatable, Sendable, Identifiable {
    var id: String
    var agent: String
    var from: Sender
    /// Only for events: asked, decided, done, urgency, reopened.
    var kind: String
    var cardID: String?
    var text: String
    var details: String
    var attachments: [Attachment]
    var ts: Double
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
    }
}

extension Message: Decodable {
    init(from decoder: Decoder) throws {
        let f = Fields(decoder)
        text = f.string("text")
        ts = f.double("ts") ?? 0
        from = Sender(rawValue: f.string("from")) ?? .agent
        id = f.optionalString("id") ?? "\(from.rawValue)-\(Int(ts))-\(text.hashValue)"
        agent = f.string("agent")
        kind = f.string("kind")
        cardID = f.optionalString("card_id")
        details = f.string("details")
        attachments = f.array("attachments")
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
        if agents.isEmpty { agents = [Agent(id: "main", name: "Agent", cwd: "", online: true)] }
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
        self.queue = BoardState.repairedQueue(f.has("queue") ? f.array("queue", of: QueueID.self).map(\.value) : nil, cards: cards)
    }
}

/// A queue entry is a card id; tolerate numbers.
private struct QueueID: Decodable {
    var value: String
    init(from decoder: Decoder) throws {
        let box = try decoder.singleValueContainer()
        if let s = try? box.decode(String.self) { value = s } else { value = String(try box.decode(Int.self)) }
    }
}
