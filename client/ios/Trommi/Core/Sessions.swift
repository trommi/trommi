// Sessions: what each is called, which ones are shown together, what they need
// from the human right now, and the changes the human can make to them.
// Follows normalize() in client/web/js/store.js and agents.js.
import Foundation

extension Agent {
    /// The human's own name for the session if there is one, else the name it gave itself.
    var displayName: String { label.isEmpty ? name : label }

    /// The seed of its scribbled mark: the picked one, else its id.
    var mark: String { icon.isEmpty ? id : icon }

    /// A stable colour per session: the same hue the web client picks (hueOf in agents.js).
    var hue: Int {
        let hues = [162, 28, 262, 205, 338, 96, 48, 232]
        var h: UInt32 = 0
        for unit in id.utf16 { h = h &* 31 &+ UInt32(unit) }
        return hues[Int(h % UInt32(hues.count))]
    }

    /// The marks offered when the human picks another one: the current one first,
    /// then a handful of fresh scribbles from the same family.
    var markChoices: [String] {
        var seen = Set<String>()
        return ([mark] + (1...11).map { "\(id):\($0)" }).filter { seen.insert($0).inserted }
    }

    /// The forty drawings a session can be given by name instead of a scribble from its id
    /// ("draw:star"; DRAWINGS in ui.js), in the order the web offers them.
    static let drawingChoices: [String] = Doodle.drawings.map(Doodle.drawingMark)

    /// The name of the drawing this session wears, if its mark is one: "star".
    var drawingName: String? {
        guard let name = Doodle.drawingName(of: mark), Doodle.drawings.contains(name) else { return nil }
        return name
    }

    /// What to send after the human edited name and mark. A name equal to the one the
    /// session gave itself (or emptied) clears the label; the session's own mark clears the icon.
    func edit(name: String, mark picked: String) -> SessionChanges {
        let clean = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return SessionChanges(label: clean == self.name ? "" : clean, icon: picked == id ? "" : picked)
    }

    /// "connected", or "disconnected, last seen 5 min ago".
    func stateLine(now: Double) -> String {
        if online { return "connected" }
        guard let ts = seen ?? joined else { return "disconnected" }
        return "disconnected, last seen \(Wording.ago(ts, now: now))"
    }

    /// The facts of the overview: where it runs, as what, and since when. An empty value is unknown.
    func facts(open: Int, now: Double) -> [SessionFact] {
        [
            SessionFact(term: "Model", value: model),
            SessionFact(term: "Machine", value: [host, platform].filter { !$0.isEmpty }.joined(separator: " · ")),
            SessionFact(term: "Folder", value: cwd),
            SessionFact(term: "Program", value: client),
            SessionFact(term: "Open questions", value: String(open)),
            SessionFact(term: "Connected since", value: online ? (connected.map { Wording.ago($0, now: now) } ?? "") : ""),
        ]
    }
}

struct SessionFact: Equatable, Identifiable {
    var term: String
    var value: String
    var id: String { term }
    var shown: String { value.isEmpty ? "unknown" : value }
}

/// Sessions the human laid together. Two or more that are still here; one alone is just a session.
struct SessionGroup: Equatable, Identifiable {
    var id: String
    var members: [Agent]
}

/// The badge at the end of a session row.
enum SessionBadge: Equatable, Sendable {
    /// Nothing to show.
    case quiet
    /// A raised hand: stopped, waiting for the human.
    case waiting(open: Int, offline: Bool)
    /// A calm ring with the number of open questions: at work.
    case running(open: Int)
    /// Disconnected with questions open: the number in grey.
    case open(Int)

    /// What the badge says in words (the tooltip of the web client, the VoiceOver label here).
    var title: String {
        switch self {
        case .quiet: return ""
        case .waiting(let open, let offline):
            return offline ? "Disconnected, was waiting for you: \(Wording.questions(open))" : "Waiting for you: \(Wording.questions(open))"
        case .running(let open): return open > 0 ? "Working, \(Wording.questions(open)) open" : "Working"
        case .open(let open): return "Disconnected, \(Wording.questions(open)) open"
        }
    }
}

/// One row of the session list: a session, or several laid together.
struct SessionUnit: Equatable, Identifiable {
    /// The session id, or the group id.
    var id: String
    var members: [Agent]
    var open: Int
    var tasks: [TaskLine]
    var online: Bool
    /// It has work in progress.
    var running: Bool
    /// Something of it cannot go on without the human.
    var stuck: Bool

    var isGroup: Bool { members.count > 1 }
    var name: String { members.map(\.displayName).joined(separator: " + ") }
    var starred: Bool { members.contains(where: \.starred) }
    /// What the members say they are working on.
    var taskLine: String { members.map(\.task).filter { !$0.isEmpty }.joined(separator: " · ") }

    var badge: SessionBadge {
        if open == 0 && !(online && running) { return .quiet }
        let hand = online ? (stuck || !running) : stuck
        if hand { return .waiting(open: open, offline: !online) }
        return online ? .running(open: open) : .open(open)
    }
}

extension BoardState {
    /// Groups of two or more sessions that are not archived, in the order of the session list.
    var groups: [SessionGroup] {
        var order: [String] = []
        var members: [String: [Agent]] = [:]
        for agent in sessions {
            guard let group = agent.group else { continue }
            if members[group] == nil { order.append(group) }
            members[group, default: []].append(agent)
        }
        return order.compactMap { id in
            guard let list = members[id], list.count > 1 else { return nil }
            return SessionGroup(id: id, members: list)
        }
    }

    /// The group a session is shown in, if any.
    func group(of agentID: String) -> SessionGroup? {
        groups.first { $0.members.contains { $0.id == agentID } }
    }

    /// One row per session, or per group of sessions laid together, in the server's order.
    var sessionUnits: [SessionUnit] {
        let groups = self.groups
        var units: [SessionUnit] = []
        for agent in sessions {
            if let group = groups.first(where: { $0.members.contains { $0.id == agent.id } }) {
                if !units.contains(where: { $0.id == group.id }) { units.append(unit(id: group.id, members: group.members)) }
            } else {
                units.append(unit(id: agent.id, members: [agent]))
            }
        }
        return units
    }

    /// The unit with this id (a session id or a group id), or the unit a session belongs to.
    func sessionUnit(_ id: String) -> SessionUnit? {
        let units = sessionUnits
        return units.first { $0.id == id } ?? units.first { $0.members.contains { $0.id == id } }
    }

    /// What a session, or several together, need from the human right now (summary() in agents.js).
    func unit(id: String, members: [Agent]) -> SessionUnit {
        let ids = Set(members.map(\.id))
        let mine = openCards.filter { ids.contains($0.agent) }
        let tasks = self.tasks.filter { ids.contains($0.agent) }
        let online = members.contains(where: \.online)
        let running = members.contains { a in a.online && tasks.contains { $0.agent == a.id && $0.state == .working } }
        let stuck = mine.contains { $0.urgency == .critical || $0.kind == .permission }
        return SessionUnit(id: id, members: members, open: mine.count, tasks: tasks, online: online, running: running, stuck: stuck)
    }

    /// "2 of 3 sessions are connected."
    var connectedLine: String {
        let all = sessions
        return "\(all.filter(\.online).count) of \(all.count) sessions are connected."
    }

    /// Sessions that share a name get a second line that tells them apart: the folder,
    /// else the machine, else since when they are connected (tellApart in agents.js).
    func tellApart(timeZone: TimeZone = .current) -> [String: String] {
        var byName: [String: [Agent]] = [:]
        for agent in sessions { byName[agent.displayName, default: []].append(agent) }
        func folder(_ a: Agent) -> String { a.cwd.split(separator: "/").suffix(2).joined(separator: "/") }
        func since(_ a: Agent) -> String {
            guard let ts = a.online ? (a.connected ?? a.joined) : (a.seen ?? a.joined) else { return "" }
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_GB")
            f.timeZone = timeZone
            f.dateFormat = "HH:mm:ss"
            return "\(a.online ? "since" : "last seen") \(f.string(from: Date(timeIntervalSince1970: ts / 1000)))"
        }
        let ways: [(Agent) -> String] = [folder, { $0.host }, since]
        var lines: [String: String] = [:]
        for twins in byName.values where twins.count > 1 {
            let pick = ways.first { way in
                let values = twins.map(way)
                return Set(values).count == twins.count && values.allSatisfy { !$0.isEmpty }
            } ?? { $0.id }
            for agent in twins { lines[agent.id] = pick(agent) }
        }
        return lines
    }

    // MARK: laying sessions together

    /// Lay one session together with another (or with the group the other is in).
    /// Returns who gets which group; nil takes a session out of its group. `newGroup` is
    /// the id to use when the other session is in no group yet.
    func pairing(_ agentID: String, with targetID: String, newGroup: String) -> [(agent: String, group: String?)] {
        guard agentID != targetID, sessions.contains(where: { $0.id == agentID }), sessions.contains(where: { $0.id == targetID }) else { return [] }
        let own = group(of: agentID)
        let theirs = group(of: targetID)
        if let own, own.id == theirs?.id { return [] }
        var changes: [(agent: String, group: String?)] = []
        // Whoever the session leaves behind alone is on its own again.
        if let own {
            let left = own.members.filter { $0.id != agentID }
            if left.count == 1 { changes.append((left[0].id, nil)) }
        }
        let id = theirs?.id ?? newGroup
        changes.append((targetID, id))
        changes.append((agentID, id))
        return changes
    }

    /// Take a session out of its group. A group of two dissolves.
    func unpairing(_ agentID: String) -> [(agent: String, group: String?)] {
        guard let group = group(of: agentID) else { return [] }
        let leaving = group.members.count <= 2 ? group.members.map(\.id) : [agentID]
        return leaving.map { ($0, nil) }
    }

    /// A fresh group id, shaped like the web client's ("g" + time in base 36 + four random characters).
    static func newGroupID(now: Double, random: UInt32) -> String {
        "g" + String(Int(now), radix: 36) + String(random % 1_679_616, radix: 36)
    }
}

extension TaskState {
    /// What the light of a status line means, for VoiceOver.
    var word: String {
        switch self {
        case .decision: return "waiting for you"
        case .working: return "in progress"
        case .done: return "done"
        }
    }
}

extension TaskLine {
    /// "Deploy: waiting for the go-ahead" as on the overview of the web client.
    var line: String { detail.isEmpty ? label : "\(label): \(detail)" }
}
