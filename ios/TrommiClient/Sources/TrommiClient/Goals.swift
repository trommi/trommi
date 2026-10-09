// Goals.swift: a desk's goals handed to the agents of the sessions on it (README "Desk goals for the agent"; a port of
// shared/client.ts goalsWanted and syncGoals, shared/model.ts cleanGoals).
//
// A desk's goals are a human register (desk/<id>, sealed under the room key): no agent can read them. So every human
// device hands them to each session on that desk: the register goals/<session> = { desk_id, desk_name, goals, epoch },
// written under THAT session's key, kept equal to the desk's goals whenever they, the session's desk or the session's
// key epoch change (a new agent of the session cannot read what was sealed before it came). No goals: null.
// Room.syncGoals writes what GoalsSync.toWrite names; this file is the part without a hub.
import Foundation

public enum GoalsSync {
  /** The caps are the Desk's (Desk.swift): one constant for both. */
  public static let lines = GOALS_LINES, lineMax = GOALS_LINE_MAX

  /** What String.prototype.trim takes off: white space and line ends as JavaScript counts them. */
  static func jsSpace(_ u: Unicode.Scalar) -> Bool {
    switch u.value {
    case 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000...0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff: return true
    default: return false
    }
  }
  static func jsTrim(_ s: Substring) -> Substring {
    var u = s.unicodeScalars
    while let f = u.first, jsSpace(f) { u.removeFirst() }
    while let l = u.last, jsSpace(l) { u.removeLast() }
    return Substring(u)
  }
  /**
   * A desk's goals as they are handed over (shared/model.ts cleanGoals): each line trimmed and cut to 200 UTF-16
   * units, blank lines out, at most GOALS_LINES (20) lines. Not the Desk's own cleanGoals (Desk.swift), which keeps a line's
   * indent: every human device must work out the same value here, or two of them would write in turns.
   */
  public static func clean(_ text: String) -> String {
    var out = [String]()
    // (unicode scalars: "\r\n" is one Character, and a line ends at "\n" with or without the "\r" before it)
    for raw in text.unicodeScalars.split(separator: "\n", omittingEmptySubsequences: false) {
      var line = "", n = 0
      for c in jsTrim(Substring(raw)) { n += c.utf16.count; if n > lineMax { break }; line.append(c) }
      if line.isEmpty { continue }
      out.append(line)
      if out.count == lines { break }
    }
    return out.joined(separator: "\n")
  }

  /** The desks in the order of the app's desk menu: its first is where a session without a desk of its own stands. */
  static func desks(_ board: Board) -> [(id: String, name: String, goals: String)] {
    var d = board.human.desks.compactMap { (id, v) -> (id: String, name: String, goals: String, order: Double?, created: Double)? in
      guard v.truthy else { return nil }
      let name = String(jsTrim(Substring(v["name"].string ?? "")))
      return (id, name.isEmpty ? "Desk" : name, v["goals"].string.map(clean) ?? "", v["order"].double.flatMap { $0.isFinite ? $0 : nil }, v["created_at"].double ?? 0)
    }
    let ordered = d.contains { $0.order != nil }
    d.sort { a, b in
      if ordered {
        let x = a.order ?? .infinity, y = b.order ?? .infinity
        if x != y { return x < y }
        return a.created != b.created ? a.created < b.created : a.id < b.id
      }
      if (a.id == "main") != (b.id == "main") { return a.id == "main" }
      return a.created != b.created ? a.created < b.created : a.id < b.id
    }
    return d.map { ($0.id, $0.name, $0.goals) }
  }

  /**
   * What goals/<session> should say for each active main session with an agent whose key this device holds
   * (`holdsKey`): the value, or null when its desk has no goals. The desk is worked out as the app does: the
   * session's `desk` when that desk exists, else the first desk of the menu's order. Helpers' sessions (made by an
   * agent) get none: their connector is their main's and reads the main's.
   */
  public static func wanted(_ board: Board, holdsKey: (String) -> Bool) -> [(sessionId: String, value: JV)] {
    let desks = desks(board)
    var out = [(sessionId: String, value: JV)]()
    for s in board.sessions.values.sorted(by: { $0.sessionId < $1.sessionId }) {
      if !s.isActive || s.createdByAgent || s.agentDeviceIds.isEmpty || !holdsKey(s.sessionId) { continue }
      let named = board.human.sessionSettings[s.sessionId]?["desk"].string
      guard let desk = desks.first(where: { $0.id == named }) ?? desks.first, !desk.goals.isEmpty else { out.append((s.sessionId, .null)); continue }
      out.append((s.sessionId, .obj(["desk_id": .str(desk.id), "desk_name": .str(desk.name), "goals": .str(desk.goals), "epoch": .n(s.sessionKeyEpoch)])))
    }
    return out
  }

  /**
   * The registers to write now: those of `wanted` that differ from what the board holds. `said`: what this device
   * last wrote per session in this run; a value it already wrote is not written again when another device put
   * something else in its place (two devices that disagree never write in turns).
   */
  public static func toWrite(_ board: Board, holdsKey: (String) -> Bool, said: [String: JV] = [:]) -> [(sessionId: String, value: JV)] {
    wanted(board, holdsKey: holdsKey).filter { w in
      let have = board.human.raw["goals/\(w.sessionId)"]?.value ?? .null
      return have != w.value && said[w.sessionId] != w.value
    }
  }
}
