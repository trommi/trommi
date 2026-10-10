// ChatTeaser.swift: what one row of the Chat list says of a conversation, as Messages and WhatsApp do: the first words
// of what was said last (his own with "You: "), and when. The list shows nothing else of a session at rest.
import Foundation

public struct ChatTeaser: Equatable {
  /** The first words of the last thing said; the session's task when nothing was said yet. */
  public var text: String
  /** When that was said; nil when nothing was said yet. */
  public var ts: UInt64?

  /**
   * The last thing said in a conversation: his words or the agent's, or a question the agent put to him (its title).
   * What only became of a question (answered, done, read, shredded) is not what was said last.
   */
  public static func of(_ messages: [Message], task: String = "") -> ChatTeaser {
    for m in messages.reversed() {
      if m.from == "event" && !["asked", "info"].contains(m.kind ?? "") { continue }
      if m.from == "work" { continue }   // (a turn's trail: what the agent did, nothing it said)
      var words = plain(m.text)
      if words.isEmpty && !m.attachments.isEmpty { words = m.attachments.count == 1 ? "Attachment" : "\(m.attachments.count) attachments" }
      if words.isEmpty { continue }
      return ChatTeaser(text: m.from == "user" ? "You: \(words)" : words, ts: m.ts)
    }
    return ChatTeaser(text: plain(task), ts: nil)
  }

  /** A message's first words as one plain line: markdown's signs taken off, line breaks as spaces, 200 characters at most. */
  public static func plain(_ s: String) -> String {
    var out = ""
    for raw in s.split(whereSeparator: { $0.isNewline }) {
      var line = raw.trimmingCharacters(in: .whitespaces)
      if line.hasPrefix("```") { continue }
      while let f = line.first, "#>☞".contains(f) { line = String(line.dropFirst()).trimmingCharacters(in: .whitespaces) }
      if line.hasPrefix("- ") || line.hasPrefix("* ") { line = String(line.dropFirst(2)) }
      line = line.replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "__", with: "").replacingOccurrences(of: "`", with: "")
      if line.isEmpty { continue }
      out += out.isEmpty ? line : " " + line
      if out.count >= 200 { break }
    }
    return String(out.prefix(200))
  }

  /** When, as a chat list says it: today the time, yesterday "Yesterday", within the last week the weekday, else the date. */
  public static func stamp(_ ts: UInt64, now: Date = Date(), calendar: Calendar = .current, locale: Locale = Locale(identifier: "en_GB")) -> String {
    let d = Date(timeIntervalSince1970: Double(ts) / 1000)
    let f = DateFormatter(); f.locale = locale; f.calendar = calendar; f.timeZone = calendar.timeZone
    let day = calendar.startOfDay(for: d), today = calendar.startOfDay(for: now)
    let days = calendar.dateComponents([.day], from: day, to: today).day ?? 0
    if days <= 0 { f.dateFormat = "HH:mm" }
    else if days == 1 { return "Yesterday" }
    else if days < 7 { f.dateFormat = "EEEE" }
    else if calendar.component(.year, from: d) == calendar.component(.year, from: now) { f.dateFormat = "d MMM" }
    else { f.dateFormat = "dd.MM.yy" }
    return f.string(from: d)
  }
}

extension UnitStack {
  /** The helpers at the end of the main's teaser: the first `max` of the stack's drawings, and how many more there are. */
  public func inline(_ max: Int = 4) -> (shown: [DeskUnit], more: Int) {
    let shown = Array(lie.prefix(max))
    return (shown, count - shown.count)
  }
}
