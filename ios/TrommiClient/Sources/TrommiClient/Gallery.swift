// Gallery: the rules of a card's pictures, videos and files (card.mjs cardMedia, card.css .tc-stage), without a view.
// ONE stage of a fixed size per card, the same for every picture and video, so nothing moves when another one is shown
// or a picture comes late. A picture is fitted in and centred, never larger than itself; a tall one stands at its
// width, its top first, and is scrolled inside the stage. Under the stage ONE strip: pictures, videos, then the files.
import Foundation

public enum Gallery {
  /** More than a quarter taller than wide: not fitted into the stage but scrolled inside it (card.mjs TALL). */
  public static let tall = 1.25
  /** A phone's screenshot and slimmer (card.mjs SLIM): kept narrow, at most `slimWidth` wide. */
  public static let slim = 1.8
  public static let slimWidth = 420.0
  /** From this content width on the stage is 16:10, below it 4:3 (card.css: the narrow column). */
  public static let wide = 600.0

  /**
   * The stage for a content `width`: 16:10 on a wide layout, 4:3 on the phone; never taller than a share of the
   * `viewport` (52 % on the phone, 70 % wide), so the answers stay in reach. A viewport of 0 is not known: no cap.
   */
  public static func stage(width: Double, viewport: Double = 0) -> (width: Double, height: Double) {
    guard width > 0 else { return (0, 0) }
    let isWide = width >= wide
    var h = isWide ? width * 10 / 16 : width * 3 / 4
    if viewport > 0 { h = min(h, viewport * (isWide ? 0.7 : 0.52)) }
    return (width, h.rounded())
  }

  public static func isTall(width: Double, height: Double) -> Bool { width > 0 && height > 0 && height / width > tall }
  public static func isSlim(width: Double, height: Double) -> Bool { width > 0 && height > 0 && height / width >= slim }

  /**
   * A picture's size on the stage. Fitted in (contain), at most at its own size. A tall one: as wide as it is, at most
   * the stage (a slim one at most `slimWidth`), its height following, so it may be taller than the stage (`scrolls`).
   */
  public static func fitted(width w: Double, height h: Double, stage: (width: Double, height: Double)) -> (width: Double, height: Double, scrolls: Bool) {
    guard w > 0, h > 0, stage.width > 0, stage.height > 0 else { return (0, 0, false) }
    if isTall(width: w, height: h) {
      let fw = min(w, stage.width, isSlim(width: w, height: h) ? slimWidth : .infinity)
      let fh = fw * h / w
      return (fw, fh, fh > stage.height)
    }
    let k = min(1, stage.width / w, stage.height / h)
    return (w * k, h * k, false)
  }

  public static func kind(_ a: JV) -> String {
    let t = a["media_type"].string ?? ""
    return t.hasPrefix("image/") ? "image" : t.hasPrefix("video/") ? "video" : "file"
  }
  /** What stands on the stage, in the strip's order: the pictures, then the videos. */
  public static func media(_ attachments: [JV]) -> [JV] { attachments.filter { kind($0) == "image" } + attachments.filter { kind($0) == "video" } }
  /** What is neither picture nor video (a table, a log, a sound, a page): the strip's file tiles, after the media. */
  public static func files(_ attachments: [JV]) -> [JV] { attachments.filter { kind($0) == "file" } }
  /** A picture's size as its reference says it; nil when the card does not know it. */
  public static func size(_ a: JV) -> (width: Double, height: Double)? {
    guard let w = a["width"].double, let h = a["height"].double, w > 0, h > 0 else { return nil }
    return (w, h)
  }
  /** The words the agent gave a picture; never the file's name. */
  public static func caption(_ a: JV) -> String {
    let t = a["caption"].string ?? a["title"].string ?? ""
    return t == (a["file_name"].string ?? "") ? "" : t
  }
  /** "2 / 5" among the pictures and videos; nothing to count with one. */
  public static func counter(at: Int, of n: Int) -> String { n > 1 ? "\(min(max(at, 0), n - 1) + 1) / \(n)" : "" }

  /** The page a picture was made from (app.mjs att): another attachment of the card, or an address. */
  public struct Page: Equatable {
    public var name: String
    /** The page as an attachment of the same card. */
    public var file: JV?
    /** The page as an address to open. */
    public var url: String?
  }
  public static func page(_ a: JV, among list: [JV]) -> Page? {
    guard let p = a["page"].string ?? a["page"]["url"].string, !p.isEmpty else { return nil }
    if p.hasPrefix("attachment:") {
      let id = String(p.dropFirst(11))
      guard let f = list.first(where: { $0["attachment_id"].string == id }) else { return nil }
      return Page(name: f["file_name"].string ?? "page.html", file: f, url: nil)
    }
    // a path of the agent's machine never reached the room: there is nothing to open
    if p.range(of: #"^(?:/(?:home|Users|tmp|var|private|root|mnt)/|file:|[A-Za-z]:\\)"#, options: .regularExpression) != nil { return nil }
    let path = p.components(separatedBy: CharacterSet(charactersIn: "?#"))[0]
    let last = path.split(separator: "/").last.map(String.init) ?? ""
    let name = last.removingPercentEncoding ?? last
    return Page(name: name.isEmpty ? "page" : name, file: nil, url: p)
  }
}
