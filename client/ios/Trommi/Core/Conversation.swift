// One session's conversation as a list of items to draw: messages, the open
// questions where they were asked, one-line markers for what happened on the
// board, and day breaks. Plus the two lists a filter lays over it: the
// questions only (open ones and the answered), and the files.
// Follows createPane() in client/web/js/chat.js and history.js.
import Foundation

/// What the conversation view shows.
enum ConversationFilter: String, CaseIterable, Identifiable, Sendable {
    case all, questions, files

    var id: String { rawValue }

    var title: String {
        switch self {
        case .all: return "Conversation"
        case .questions: return "Questions only"
        case .files: return "Files"
        }
    }
}

enum ConversationItem: Equatable, Identifiable {
    /// "Today", "Yesterday" or "Friday, 2 October".
    case day(id: String, label: String)
    case user(Message)
    /// `continued`: the message before came from the agent too, moments ago; no header again.
    case agent(Message, continued: Bool)
    /// An open question, answerable right where it was asked.
    case question(Message, Card)
    /// A one-line marker: a question that is no longer open, an answer, a change of urgency.
    case event(Message, card: Card?)

    var id: String {
        switch self {
        case .day(let id, _): return id
        case .user(let m), .agent(let m, _), .question(let m, _), .event(let m, _): return m.id
        }
    }
}

/// A question that is no longer open, as one line of the "Answered" list.
struct HistoryRow: Equatable, Identifiable {
    var card: Card
    var id: String { card.id }

    /// The answer: the chosen option's label, or "No answer" when the agent withdrew the question.
    var pick: String { card.choiceLabel ?? "No answer" }
    var answered: Bool { card.choice != nil }
    /// What became of it.
    var outcome: String { card.status == .done ? (card.summary.isEmpty ? "done" : card.summary) : "in progress" }
    var when: Double { card.decided ?? card.created }
    /// Only a question the human answered can be answered again.
    var canAnswerAgain: Bool { card.kind == .decision && card.choice != nil }
    /// "Question 7 · Urgent"
    var footnote: String {
        let level = card.kind == .permission ? "Permission" : card.urgency.label
        return "Question \(card.number) · \(level)"
    }
}

/// One line of the "Files" list.
struct FileItem: Equatable, Identifiable {
    enum Kind: String, Sendable {
        case image, video, audio, file, scribble, link

        var label: String {
            switch self {
            case .image: return "Picture"
            case .video: return "Video"
            case .audio: return "Audio"
            case .file: return "File"
            case .scribble: return "Your scribble"
            case .link: return "Link"
            }
        }
    }

    var ts: Double
    /// The title of the question it was attached to, if any.
    var origin: String?
    var kind: Kind
    var name: String
    var url: String
    var id: String { url }

    /// Shown as a picture, with a thumbnail, and opened in the viewer.
    var isPicture: Bool { kind == .image || kind == .scribble }

    /// The attachment behind the line; nil for a link.
    var attachment: Attachment? {
        guard kind != .link else { return nil }
        return Attachment(name: name, url: url, kind: AttachmentKind(rawValue: kind.rawValue) ?? .file, size: nil)
    }
}

enum ConversationText {
    static let emptyTitle = "What should the agent start with?"
    static let emptyBody = "Tell it what to work on. When it needs something from you, it puts a question in front of you."
    static let starters = ["Where do we stand?", "What do you need from me?", "Sum up what you did last."]
    static let working = "Agent is working"
    static let noFiles = "This session has not sent any files yet."
    // Asking back about a question instead of answering it (focus.js).
    static let askBack = "Ask back"
    static let askPlaceholder = "Ask the agent about this question"
    static let askWaiting = "Sent. The reply will show up here; the question stays open."

    static func placeholder(_ name: String?) -> String { name.map { "Message to \($0)" } ?? "Message to the agent" }

    /// "Today", "Yesterday", else weekday, day and month.
    static func dayLabel(_ ts: Double, now: Double, calendar: Calendar) -> String {
        let day = Date(timeIntervalSince1970: ts / 1000)
        let today = Date(timeIntervalSince1970: now / 1000)
        if calendar.isDate(day, inSameDayAs: today) { return "Today" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: today), calendar.isDate(day, inSameDayAs: yesterday) { return "Yesterday" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_GB")
        f.calendar = calendar
        f.timeZone = calendar.timeZone
        f.dateFormat = "EEEE, d MMMM"
        return f.string(from: day)
    }
}

extension BoardState {
    /// Messages of one side that follow each other within five minutes are one group (GROUP_GAP in chat.js).
    private static let groupGap: Double = 5 * 60_000
    /// A message from the human younger than this, with no answer yet, shows "Agent is working".
    private static let workingWindow: Double = 10 * 60_000

    /// The conversation of one session, ready to draw.
    func conversationItems(of agentID: String, now: Double, calendar: Calendar = .current) -> [ConversationItem] {
        var items: [ConversationItem] = []
        var last: Message?
        for message in conversation(of: agentID) {
            let day = Date(timeIntervalSince1970: message.ts / 1000)
            if last == nil || !calendar.isDate(day, inSameDayAs: Date(timeIntervalSince1970: (last?.ts ?? 0) / 1000)) {
                items.append(.day(id: "day-\(message.id)", label: ConversationText.dayLabel(message.ts, now: now, calendar: calendar)))
                last = nil
            }
            switch message.from {
            case .user:
                items.append(.user(message))
            case .agent:
                let continued = last?.from == .agent && message.ts - (last?.ts ?? 0) < BoardState.groupGap
                items.append(.agent(message, continued: continued))
            case .event:
                let card = self.card(message.cardID)
                if message.kind == "asked", let card, card.status == .open {
                    items.append(.question(message, card))
                } else {
                    items.append(.event(message, card: card))
                }
            }
            last = message
        }
        return items
    }

    /// What was asked back about a question and what the agent replied: the chat
    /// messages that name the card, oldest first.
    func thread(of cardID: String) -> [Message] {
        messages.enumerated()
            .filter { $0.element.cardID == cardID && $0.element.from != .event }
            .sorted { a, b in a.element.ts != b.element.ts ? a.element.ts < b.element.ts : a.offset < b.offset }
            .map(\.element)
    }

    /// The human asked last and the agent has not replied yet.
    func threadAwaitsReply(_ cardID: String) -> Bool { thread(of: cardID).last?.from == .user }

    /// The question a chat message is about, if it names one that still exists.
    func question(about message: Message) -> Card? {
        guard message.from != .event else { return nil }
        return card(message.cardID)
    }

    /// The human wrote last, moments ago, and nothing came back yet.
    func agentIsWorking(_ agentID: String, now: Double) -> Bool {
        guard let last = messages.last(where: { $0.agent == agentID && $0.from != .event }) else { return false }
        return last.from == .user && now - last.ts < BoardState.workingWindow
    }

    /// The answered questions of one session: what the agent is still working on first,
    /// then what is done; within each the latest answer first.
    func history(of agentID: String) -> [HistoryRow] {
        cards.filter { $0.agent == agentID && $0.status != .open }
            .sorted { a, b in
                if (a.status == .done) != (b.status == .done) { return b.status == .done }
                return (a.decided ?? a.created) > (b.decided ?? b.created)
            }
            .map { HistoryRow(card: $0) }
    }

    /// "2 in progress · 5 done" beside the heading "Answered".
    func historyCountLabel(of agentID: String) -> String {
        let past = history(of: agentID)
        let busy = past.filter { $0.card.status == .decided }.count
        return [busy > 0 ? "\(busy) in progress" : "", past.count - busy > 0 ? "\(past.count - busy) done" : ""]
            .filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// Everything a session ever sent, newest first: attachments of its messages and
    /// questions, and the links in what the agent wrote (published pages arrive as links).
    func files(of agentID: String) -> [FileItem] {
        var items: [FileItem] = []
        func add(_ list: [Attachment], ts: Double, origin: String?) {
            for a in list {
                let kind = FileItem.Kind(rawValue: a.kind.rawValue) ?? .file
                items.append(FileItem(ts: ts, origin: origin, kind: kind, name: a.name.isEmpty ? "Scribble" : a.name, url: a.url))
            }
        }
        for message in messages where message.agent == agentID {
            add(message.attachments, ts: message.ts, origin: nil)
            guard message.from == .agent else { continue }
            for url in Links.find(in: message.text) {
                items.append(FileItem(ts: message.ts, origin: nil, kind: .link, name: Links.withoutScheme(url), url: url))
            }
        }
        for card in cards where card.agent == agentID { add(card.attachments, ts: card.created, origin: card.title) }
        var seen = Set<String>()
        return items.enumerated()
            .sorted { a, b in a.element.ts != b.element.ts ? a.element.ts > b.element.ts : a.offset < b.offset }
            .map(\.element)
            .filter { seen.insert($0.url).inserted }
    }
}

/// Links in plain text, and where they lead from a phone.
enum Links {
    /// Every http(s) link in the text, without trailing punctuation (LINK in history.js).
    static func find(in text: String) -> [String] {
        var out: [String] = []
        var rest = Substring(text)
        while let start = rest.range(of: "http://") ?? rest.range(of: "https://") {
            // Take the earlier of the two schemes.
            var from = start.lowerBound
            if let secure = rest.range(of: "https://"), secure.lowerBound < from { from = secure.lowerBound }
            let tail = rest[from...]
            let end = tail.firstIndex { $0.isWhitespace || "<>)]".contains($0) } ?? tail.endIndex
            var link = String(tail[..<end])
            while let lastChar = link.last, ".,;:!?".contains(lastChar) { link.removeLast() }
            if link.count > (link.hasPrefix("https://") ? 8 : 7) { out.append(link) }
            rest = rest[end...]
        }
        return out
    }

    static func withoutScheme(_ link: String) -> String {
        for scheme in ["https://", "http://"] where link.hasPrefix(scheme) { return String(link.dropFirst(scheme.count)) }
        return link
    }
}

extension ServerLink {
    /// Where a link from a message leads when opened on this device. The server
    /// writes asset links under its own "localhost" address; from a phone that is
    /// the board's address. Returns nil for anything that is not http(s).
    func destination(of link: String) -> URL? {
        guard var parts = URLComponents(string: link), let scheme = parts.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = parts.host?.lowercased(), !host.isEmpty else { return nil }
        let local = host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]"
        let base = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        let samePort = parts.port == base?.port || (parts.port == nil && base?.port == nil)
        if local, samePort, let base, base.host?.lowercased() != host {
            parts.scheme = base.scheme
            parts.host = base.host
            parts.port = base.port
        }
        return parts.url
    }

    /// The address of a published asset: "/a/<id>#<key>" on this server.
    func assetURL(_ asset: AssetRef) -> URL? {
        guard !asset.gone, asset.url.hasPrefix("/a/") else { return nil }
        return URL(string: origin + asset.url)
    }
}
