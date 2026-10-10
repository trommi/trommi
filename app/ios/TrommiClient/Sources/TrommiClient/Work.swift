// Work.swift: a turn's trail as a client shows it (README "The trail"; a port of shared/work.ts).
//
// An agent's connector mirrors what the agent does in its terminal between the human's prompt and the final answer
// as messages with `terminal: "work"` in the session's chat: each carries `work`, what changed in the trail of one
// turn since the envelope before. Envelopes are never edited: a step that ends is named again by a later envelope.
// Work.fold puts the envelopes of one turn together into the one block the app draws (Desk.swift itemsOf makes one
// Message of them; WorkTrail.swift draws it). Where the block stands in the chat is Work.anchor's: at the turn's
// first envelope, or behind what he typed into the terminal while the turn ran.
//
// Nothing in an envelope is trusted beyond its shape: an agent wrote it. Texts are cut, unknown kinds and states are
// left out, and a block lists at most 400 items.
import Foundation

/** One line of a trail: a step (a tool call), the agent's words between two steps, or a helper (a subagent). */
public struct WorkLine: Equatable, Identifiable {
  public var id: String
  /** "step" | "text" | "helper" */
  public var kind: String
  public var tool: String? = nil
  public var title: String? = nil
  public var subject: String? = nil
  /** "running" | "ok" | "failed" | "interrupted"; nil when no envelope said one. */
  public var state: String? = nil
  public var at: Double? = nil
  public var ms: Double? = nil
  public var steps: Double? = nil
  /** A failed shell command's exit code (1 to 255). */
  public var exit: Int? = nil
  public var text: String? = nil
  /** Only at the level `full`: what went in and an excerpt of what came out. */
  public var input: String? = nil
  public var output: String? = nil
  public init(id: String, kind: String) { self.id = id; self.kind = kind }
}

/** The envelopes of one turn, folded. */
public struct WorkBlock: Equatable {
  public var turn = ""
  /** The highest `seq` folded in: a block changed when this did. */
  public var seq: Double = 0
  /** "running" | "done" | "interrupted" | "failed" */
  public var state = "running"
  public var started: Double? = nil
  public var ended: Double? = nil
  /** Steps beyond the trail's limit: counted, not listed. */
  public var more: Double = 0
  public var items: [WorkLine] = []
  public init() {}
}

public enum Work {
  public static let itemsMax = 400
  static let workStates: Set<String> = ["running", "done", "interrupted", "failed"]
  static let stepStates: Set<String> = ["running", "ok", "failed", "interrupted"]
  static let kinds: Set<String> = ["step", "text", "helper"]

  /** Whether a message's content is an envelope of a trail. */
  public static func isWork(_ content: JV?) -> Bool {
    guard let c = content, c["terminal"].string == "work" else { return false }
    let w = c["work"]
    return !(w["turn"].string ?? "").isEmpty && w["items"].array != nil
  }

  /** A number as an envelope may say one: finite and not below zero. */
  static func num(_ v: JV) -> Double? {
    guard let d = v.double, d.isFinite, d >= 0 else { return nil }
    return d
  }
  /** The first `max` UTF-16 units of a text (as the web cuts), never half a character. */
  static func cut(_ s: String, _ max: Int) -> String {
    if s.utf16.count <= max { return s }
    var out = "", n = 0
    for c in s { n += c.utf16.count; if n > max { break }; out.append(c) }
    return out
  }

  /**
   * The envelopes of ONE turn as one block. They are applied in the order of `seq`, whatever order they are given in;
   * an item (by `id`) stands where it first came and takes the fields of every later envelope that names it; the
   * turn's state and times are those of the last envelope that says them.
   */
  public static func fold(_ envelopes: [JV]) -> WorkBlock {
    var out = WorkBlock()
    var at = [String: Int]()   // an item's id (as sent) -> its place in out.items
    // (in the order of seq; envelopes of the same seq keep the order they were given in, as a stable sort does)
    let list = envelopes.enumerated().filter { $0.element.object != nil }
      .sorted { a, b in let x = num(a.element["seq"]) ?? 0, y = num(b.element["seq"]) ?? 0; return x != y ? x < y : a.offset < b.offset }
      .map { $0.element }
    for w in list {
      if let t = w["turn"].string { out.turn = cut(t, 64) }
      out.seq = max(out.seq, num(w["seq"]) ?? 0)
      if let s = w["state"].string, workStates.contains(s) { out.state = s }
      out.started = num(w["started_at"]) ?? out.started
      out.ended = num(w["ended_at"]) ?? out.ended
      out.more = num(w["more"]) ?? out.more
      for x in w["items"].array ?? [] {
        guard x.object != nil, let id = x["id"].string, let kind = x["kind"].string, kinds.contains(kind) else { continue }
        let i: Int
        if let had = at[id] { i = had }
        else {
          if out.items.count >= itemsMax { continue }
          out.items.append(WorkLine(id: cut(id, 80), kind: kind))
          i = out.items.count - 1
          at[id] = i
        }
        if kind != out.items[i].kind { continue }
        if let v = x["tool"].string { out.items[i].tool = cut(v, 80) }
        if let v = x["title"].string { out.items[i].title = cut(v, 200) }
        if let v = x["subject"].string { out.items[i].subject = cut(v, 300) }
        if let v = x["text"].string { out.items[i].text = cut(v, 30000) }
        if let v = x["input"].string { out.items[i].input = cut(v, 4000) }
        if let v = x["output"].string { out.items[i].output = cut(v, 8000) }
        if let s = x["state"].string, stepStates.contains(s) { out.items[i].state = s }
        if let n = num(x["at"]) { out.items[i].at = n }
        if let n = num(x["ms"]) { out.items[i].ms = n }
        if let n = num(x["steps"]) { out.items[i].steps = n }
        if kind == "step", let e = num(x["exit"]), e == e.rounded(), e > 0, e < 256 { out.items[i].exit = Int(e) }
      }
    }
    return out
  }

  /**
   * Where a turn's block stands in its chat (shared/work.ts workAnchor). `envelopes`: the places (envelope numbers)
   * of the turn's envelopes; `typed`: the places of the messages he typed into the terminal (`terminal: "input"`) in
   * the same chat. The block stands at the turn's first envelope. But what he types while a turn runs goes into that
   * turn, and the turn's trail goes on behind it: then the block stands behind his last such message, at the first
   * envelope after it, with all its steps. So his words never stand under the work they were typed into, and the
   * block is drawn once. nil without an envelope.
   */
  public static func anchor(_ envelopes: [Double], typed: [Double]) -> Double? {
    let at = envelopes.filter { $0.isFinite }.sorted()
    guard let first = at.first, let last = at.last else { return nil }
    var cut = -Double.infinity
    for t in typed where t > first && t < last && t > cut { cut = t }
    return at.first { $0 > cut } ?? first
  }

  // ---- what a block says (app/web/public/session.mjs span, workBlock, workLine) ----------------------------------

  /** A time as a trail says it: "0.3 s", "12 s", "2 min", "1 h 5 min". */
  public static func span(_ ms: Double) -> String {
    guard ms >= 0 else { return "" }
    let ms = min(ms, 1e12)   // (an agent wrote the number: never one a whole number cannot hold)
    if ms < 950 { return String(format: "%.1f s", locale: Locale(identifier: "en_US_POSIX"), max(ms, 100) / 1000) }
    let sec = Int((ms / 1000).rounded())
    if sec < 60 { return "\(sec) s" }
    let min = Int((Double(sec) / 60).rounded())
    return min < 60 ? "\(min) min" : "\(min / 60) h\(min % 60 != 0 ? " \(min % 60) min" : "")"
  }
  public static func count(_ n: Int, _ one: String) -> String { "\(n) \(one)\(n == 1 ? "" : "s")" }
}

extension WorkLine {
  /** A line's state as it is drawn: one without a state still runs. */
  public var shown: String { state ?? "running" }
  /** What a step's or a helper's line is called: the tool, "Helper Explore". */
  public var name: String { kind == "helper" ? "Helper \(tool ?? "")".trimmingCharacters(in: .whitespaces) : tool ?? "Step" }
  /** What it is about: the call's own description and its subject. */
  public var what: String { [title, subject].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ") }
  /** A step with an input or an output (the level `full`) opens to show them. */
  public var opens: Bool { kind != "text" && !((input ?? "").isEmpty && (output ?? "").isEmpty) }
  /** A failed shell command's "exit code 1"; nil for every other line. */
  public var exitSays: String? { kind == "step" && shown == "failed" ? exit.map { "exit code \($0)" } : nil }
  /** How a state is said aloud. */
  public var says: String { exitSays ?? ["running": "running", "ok": "done", "failed": "ended with an error", "interrupted": "interrupted"][shown] ?? shown }
}

extension WorkBlock {
  /** `more` as a whole number (an agent wrote it: capped). */
  public var moreCount: Int { Int(min(more, 1e9)) }
  /** Steps (those beyond the limit counted in), helpers, and the lines that failed. */
  public var stepCount: Int { items.filter { $0.kind == "step" }.count + moreCount }
  public var helperCount: Int { items.filter { $0.kind == "helper" }.count }
  public var failedCount: Int { items.filter { $0.state == "failed" }.count }
  /** How long the turn took, once it has ended: "52 s". */
  public var took: String { if let e = ended, let s = started { return Work.span(e - s) }; return "" }
  /** The folded line's first words: "Working", "Worked 52 s", "Interrupted after 40 s", "Stopped by an error after 3 s". */
  public var head: String {
    let t = took
    switch state {
    case "running": return "Working"
    case "done": return "Worked" + (t.isEmpty ? "" : " \(t)")
    case "interrupted": return "Interrupted" + (t.isEmpty ? "" : " after \(t)")
    default: return "Stopped by an error" + (t.isEmpty ? "" : " after \(t)")
    }
  }
  /** "8 steps · 1 helper · 1 with an error"; "" for a block with nothing to count. */
  public var summary: String {
    let s = stepCount, h = helperCount, f = failedCount
    return [s > 0 ? Work.count(s, "step") : "", h > 0 ? Work.count(h, "helper") : "", f > 0 ? "\(f) with \(f == 1 ? "an error" : "errors")" : ""].filter { !$0.isEmpty }.joined(separator: " · ")
  }
  /** While the turn runs: the step it is at ("Bash · Run the tests"); nil when it has ended or nothing runs. */
  public var now: String? {
    guard state == "running", let x = items.last(where: { $0.kind != "text" && $0.shown == "running" }) else { return nil }
    let about = (x.title ?? "").isEmpty ? (x.subject ?? "") : x.title!
    let line = [x.kind == "helper" ? x.name : (x.tool ?? ""), about].filter { !$0.isEmpty }.joined(separator: " · ")
    return line.isEmpty ? nil : line
  }
  /** The whole folded line, as one text: "Worked 52 s · 8 steps · 1 helper · 1 with an error". */
  public var line: String { [head, summary, now ?? ""].filter { !$0.isEmpty }.joined(separator: " · ") }
  /** "and 25 more steps, not listed"; nil when every step is listed. */
  public var rest: String? { moreCount > 0 ? "and \(Work.count(moreCount, "more step")), not listed" : nil }
}
