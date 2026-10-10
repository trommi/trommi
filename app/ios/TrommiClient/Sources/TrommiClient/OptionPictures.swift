// OptionPictures: which picture of a card belongs to which option (card.mjs pictureKeys), so the option's tile can carry
// its picture. Plain to see only: a section names its picture (its position among the attachments); or every picture
// names one option in its file name (<anything>-<key>.png); or there are as many pictures as options, three or more.
// Nothing is guessed otherwise.
import Foundation

public enum OptionPictures {
  /** The pictures among the attachments (media type image), in their order. */
  public static func images(_ attachments: [JV]) -> [JV] { attachments.filter { ($0["media_type"].string ?? "").hasPrefix("image/") } }

  /**
   * Option key -> the index of its picture among `images(attachments)`. A section's picture may belong to several
   * options (each names it); a picture found by name or by count belongs to one.
   */
  public static func of(attachments: [JV], options: [Option], sections: [JV]?) -> [String: Int] {
    let imgs = images(attachments)
    var out = [String: Int]()
    // a section names its picture: a position among all the attachments
    for s in sections ?? [] {
      guard let key = s["key"].string, let p = s["picture"].int, p >= 0, p < attachments.count, out[key] == nil else { continue }
      if let at = imgs.firstIndex(where: { $0 == attachments[p] }) { out[key] = at }
    }
    if !out.isEmpty || imgs.count < 2 || options.count < 2 { return out }
    // every picture that names an option in its file name (the longest key wins; two equally long: unclear)
    func slug(_ s: String) -> String {
      s.lowercased().replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }
    var unclear = false
    var byName = [String: Int]()
    for (i, img) in imgs.enumerated() {
      let base = (img["file_name"].string ?? img["name"].string ?? "").replacingOccurrences(of: "\\.[A-Za-z0-9]+$", with: "", options: .regularExpression)
      let name = "-\(slug(base))-"
      let hits = options.filter { o in [slug(o.key), slug(o.label)].contains { !$0.isEmpty && name.contains("-\($0)-") } }
        .sorted { slug($0.key).count > slug($1.key).count }
      guard let first = hits.first else { continue }
      if hits.count > 1 && slug(hits[1].key).count == slug(first.key).count { unclear = true; continue }
      if byName[first.key] == nil { byName[first.key] = i }
    }
    if !unclear && byName.count >= 2 { return byName }
    // as many pictures as options, three or more: one each, in order
    if imgs.count == options.count && options.count >= 3 { return Dictionary(uniqueKeysWithValues: options.enumerated().map { ($1.key, $0) }) }
    return [:]
  }
}
