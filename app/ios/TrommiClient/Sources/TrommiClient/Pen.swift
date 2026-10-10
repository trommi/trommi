// Pen.swift: the pen of the web app (app/web/public/ui.mjs "pen"), the part that depends on a seed: a session's
// scribble from its id, and the colours of the marks. The same seed gives the same strokes as on the web, byte for byte
// in the path data. Named drawings, sketches and the other fixed marks come pre-drawn (TrommiApp Resources/pen.json,
// written by dev/ios-pen.mjs from the same code).
import Foundation

public enum Pen {
  /** The small seeded generator of ui.mjs (FNV-1a seed, then a 32-bit mix per draw). */
  public static func seeded(_ text: String) -> () -> Double {
    var h: UInt32 = 2166136261
    for unit in text.utf16 { h = (h ^ UInt32(unit)) &* 16777619 }
    // (JS iterates code points and takes charCodeAt(0): the first UTF-16 unit of each; the same for the ids used here)
    return {
      h = (h ^ (h >> 15)) &* 2246822507
      h = (h ^ (h >> 13)) &* 3266489909
      h ^= h >> 16
      return Double(h) / 4294967296
    }
  }
  static func f1(_ v: Double) -> String { String(format: "%.1f", v).replacingOccurrences(of: "-0.0", with: "0.0") }

  /** A smooth line through points, the way a pen moves: quadratic curves between midpoints. */
  public static func penPath(_ points: [(Double, Double)], closed: Bool = false) -> String {
    let p = closed ? points + [points[0], points[1]] : points
    var d = "M\(f1(p[0].0)) \(f1(p[0].1))"
    if p.count > 2 {
      for i in 1..<(p.count - 1) {
        let mx = (p[i].0 + p[i + 1].0) / 2, my = (p[i].1 + p[i + 1].1) / 2
        d += " Q\(f1(p[i].0)) \(f1(p[i].1)) \(f1(mx)) \(f1(my))"
      }
    }
    if !closed, let l = p.last { d += " L\(f1(l.0)) \(f1(l.1))" }
    return d
  }

  public static let kinds = ["burst", "spiral", "blob", "flower", "waves", "knot", "bolt", "hatch"]
  /** The forty-odd names a session's drawing can have, in the picker's order (the hue turns with the place). */
  public static let drawings = kinds + ["star", "zigzag", "eight", "arrow", "leaf", "eye", "key", "anchor", "kite", "comb", "ladder", "heart", "moon", "cloud", "drop", "flag", "house", "tree",
                                        "fish", "bird", "cup", "bell", "cross", "triangle", "square", "diamond", "grid", "mountain", "umbrella", "crown", "flame", "boat", "browser", "terminal",
                                        "database", "phone", "brush", "flask", "lock", "book", "rocket", "mic", "bug", "branch"]

  /** The eight scribble kinds, as path data in a 32 box. */
  static func doodle(_ k: Int, _ r: () -> Double) -> [String] {
    let PI = Double.pi
    switch k {
    case 0:
      let n = 6 + Int(floor(r() * 4)), turn = r() * PI
      return (0..<n).map { i in
        let a = turn + (Double(i) / Double(n)) * PI * 2 + (r() - 0.5) * 0.25, len = 7 + r() * 6, from = 1.5 + r() * 2
        return "M\(f1(16 + cos(a) * from)) \(f1(16 + sin(a) * from)) L\(f1(16 + cos(a) * len)) \(f1(16 + sin(a) * len))"
      }
    case 1:
      let turns = 2.2 + r() * 1.2, start = r() * 6
      return [penPath((0..<34).map { i in
        let t = Double(i) / 33, a = start + t * turns * PI * 2, rad = 1.5 + t * 11 + (r() - 0.5) * 1.1
        return (16 + cos(a) * rad, 16 + sin(a) * rad)
      })]
    case 2:
      return [0, 1].map { pass in penPath((0..<9).map { i in
        let a = (Double(i) / 9) * PI * 2 + Double(pass) * 0.4, rad = 9.5 + (r() - 0.5) * 4 - Double(pass) * 1.5
        return (16 + cos(a) * rad, 16 + sin(a) * rad * 0.9)
      }, closed: true) }
    case 3:
      let n = 4 + Int(floor(r() * 3)), turn = r() * PI
      return (0..<n).map { i in
        let a = turn + (Double(i) / Double(n)) * PI * 2, w = 0.42 + r() * 0.12, len = 10.5 + r() * 2.5
        let tip = (16 + cos(a) * len, 16 + sin(a) * len)
        let l = (16 + cos(a - w) * len * 0.72, 16 + sin(a - w) * len * 0.72)
        let rr = (16 + cos(a + w) * len * 0.72, 16 + sin(a + w) * len * 0.72)
        return penPath([(16, 16), l, tip, rr, (16, 16)])
      }
    case 4:
      return [9.0, 16, 23].map { y in penPath((0..<7).map { i in (4 + Double(i) * 4, y + (i % 2 == 1 ? -2.6 : 2.6) + (r() - 0.5) * 1.6) }) }
    case 5:
      let a = 2 + floor(r() * 2), b = 3.0, phase = r() * 3
      return [penPath((0..<40).map { i in
        let t = (Double(i) / 39) * PI * 2
        return (16 + sin(a * t + phase) * 11 + (r() - 0.5) * 0.8, 16 + sin(b * t) * 10 + (r() - 0.5) * 0.8)
      })]
    case 6:
      return [penPath((0..<6).map { i in (8 + Double(i % 2) * 12 + (r() - 0.5) * 5, 4 + Double(i) * 4.8) }), penPath([(6 + r() * 3, 27), (26 - r() * 3, 27.5)])]
    default:
      return (0..<6).map { i in "M\(f1(5 + Double(i) * 3.6 + r())) \(f1(25 + r() * 2)) L\(f1(11 + Double(i) * 3.6 + r())) \(f1(6 + r() * 2))" }
    }
  }

  /** A session's scribble for a seed (its id): path data in a 32 box and the tilt in degrees. Named marks come from pen.json. */
  public static func scribble(seed: String) -> (paths: [String], rotate: Double) {
    let r = seeded(seed)
    if let name = drawingName(seed), let k = kinds.firstIndex(of: name) {
      let ds = doodle(k, r)
      return (ds, ((r() - 0.5) * 16).rounded())
    }
    let ds = doodle(Int(floor(r() * Double(kinds.count))), r)
    return (ds, ((r() - 0.5) * 16).rounded())
  }
  /** "draw:rocket" -> "rocket", or nil for a seeded scribble. */
  public static func drawingName(_ mark: String) -> String? {
    guard mark.hasPrefix("draw:") else { return nil }
    let n = String(mark.dropFirst(5))
    return drawings.contains(n) ? n : nil
  }
  static let HUES = [162, 28, 262, 205, 338, 96, 48, 232]
  static func hueOf(_ id: String) -> Int {
    var h: UInt32 = 0
    for u in id.utf16 { h = h &* 31 &+ UInt32(u) }
    return HUES[Int(h % UInt32(HUES.count))]
  }
  public static func drawingHue(_ name: String?) -> Int? {
    guard let n = name, let at = drawings.firstIndex(of: n) else { return nil }
    return Int((162 + Double(at) * 137.508).truncatingRemainder(dividingBy: 360).rounded())
  }
  /** The colour of a session's mark (hsl(hue 62% 30%) on light, hsl(hue 70% 76%) on dark). */
  public static func hueFor(id: String, mark: String) -> Int { drawingHue(drawingName(mark)) ?? hueOf(id) }
}
