// ShareIntake: what a thing that comes in from outside becomes in the note. Two doors use it: the Share Extension
// (TrommiShare) and a drop onto the app (TrommiApp/NoteDrop.swift). Pictures and files become attachments, links and
// text become words in the note. Pure Foundation (the callers ask UniformTypeIdentifiers and hand over the answers),
// so `swift test` covers it on Linux.
import Foundation

public enum ShareIntake {
  /** What an item provider offers, as its caller read it from the provider's type identifiers. */
  public struct Offer: Equatable, Sendable {
    /** Conforms to public.image. */
    public var image: Bool
    /** Conforms to public.url (a file URL does too). */
    public var url: Bool
    /** Conforms to public.file-url. */
    public var fileURL: Bool
    /** Has a registered type that is data and not plain text (a movie, a PDF, an archive, …). */
    public var data: Bool
    /** Conforms to public.plain-text. */
    public var text: Bool
    public init(image: Bool = false, url: Bool = false, fileURL: Bool = false, data: Bool = false, text: Bool = false) {
      self.image = image; self.url = url; self.fileURL = fileURL; self.data = data; self.text = text
    }
  }

  /** How to load it. `.url` and `.text` end as words (see `words`), `.image` and `.file` as attachments. */
  public static func kind(_ o: Offer) -> ShareItem.Kind? {
    if o.image { return .image }
    // a web link also offers its title as text and sometimes a .webloc: the link is what he means
    if o.url && !o.fileURL { return .url }
    if o.data || o.fileURL { return .file }
    if o.text { return .text }
    return nil
  }

  /** A string that was shared or dropped: a lone http(s) address is a link, anything else text (cut at the limit); nil when empty. */
  public static func words(_ raw: String) -> ShareItem? {
    let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.isEmpty { return nil }
    if s.rangeOfCharacter(from: .whitespacesAndNewlines) == nil, let u = URL(string: s), let scheme = u.scheme?.lowercased(), scheme == "http" || scheme == "https", u.host != nil {
      return ShareItem(kind: .url, name: u.host ?? "link", type: "text/uri-list", text: s)
    }
    return ShareItem(kind: .text, name: "text", type: "text/plain", text: String(s.prefix(ShareInbox.maxTextChars)))
  }

  /** A file's name: the suggested one, else the file's own, with the extension (the file's, else the type's) exactly once. */
  public static func fileName(suggested: String?, file: String, ext: String, typeExt: String?) -> String {
    let e = ext.isEmpty ? (typeExt ?? "") : ext
    var name = (suggested?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 } ?? file
    if name.isEmpty { name = "file" }
    if !e.isEmpty && !name.lowercased().hasSuffix(".\(e.lowercased())") { name += ".\(e)" }
    return name
  }

  /** The note's words with new ones below them (an empty note becomes just the new words; nothing new changes nothing). */
  public static func appended(_ note: String, _ words: String) -> String {
    let w = words.trimmingCharacters(in: .whitespacesAndNewlines)
    if w.isEmpty { return note }
    return note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? w : note + "\n" + w
  }

  /** Words of several items, one per line, none twice. */
  public static func joined(_ items: [ShareItem]) -> String {
    var parts = [String]()
    for i in items where i.kind == .url || i.kind == .text {
      if let s = i.text?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty, !parts.contains(s) { parts.append(s) }
    }
    return parts.joined(separator: "\n")
  }
}
