// Canvas.swift: the Scribble Board on the wire (shared/ink.mjs, shared/palette.mjs, shared/scribble.mjs), modelled on
// PencilKit so a PKStroke maps onto a stroke 1:1. Packed points (x, y in 1/16 board unit, t in ms, force, azimuth and
// altitude; zigzag LEB128 deltas), the transform baked in, the clamped cubic B-spline a stroke is drawn along, the
// force curve; colour tokens; the shapes (stroke, note, picture) and the reducer: adding once per id, erasing wins,
// moving adds offsets, pieces continue a stroke; every stroke id is derived by the receiver (R1:
// <sender>/<sequence>/<index>), agents erase and move only their own. The same board whatever the delivery order.
import Foundation

// ---- ink: one stroke's points ---------------------------------------------------------------------------

/** One stroke's points in memory (board units; t in ms since the stroke began; force 0..1; angles in radians). */
public struct Ink: Equatable {
  public var pts: [Double] = []
  public var t: [Double] = []
  public var f: [Double] = []
  public var az: [Double]? = nil
  public var al: [Double]? = nil
  public var sim = false
  public init(pts: [Double] = [], t: [Double] = [], f: [Double] = [], az: [Double]? = nil, al: [Double]? = nil, sim: Bool = false) {
    self.pts = pts; self.t = t; self.f = f; self.az = az; self.al = al; self.sim = sim
  }
  public var count: Int { pts.count / 2 }
}

public enum InkWire {
  public static let Q = 16.0
  public static let STROKE_TOOLS: Set<String> = ["pen", "marker"]
  public static let MAX_POINTS = 50_000
  /** UITouch.maximumPossibleForce of an Apple Pencil: PKStrokePoint.force = f · PK_MAX_FORCE. */
  public static let PK_MAX_FORCE = 4.166666666666667
  static let TAU = Double.pi * 2, HALF_PI = Double.pi / 2
  static func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double { max(lo, min(hi, v)) }
  static func fin(_ v: Double?) -> Double { (v?.isFinite ?? false) ? v! : 0 }
  /** JavaScript's Math.round: halves go up. */
  static func jsRound(_ v: Double) -> Double { (v + 0.5).rounded(.down) }

  static func putVar(_ out: inout [UInt8], _ v0: Double) {
    var v = v0
    while v >= 128 { out.append(UInt8(v.truncatingRemainder(dividingBy: 128) + 128)); v = (v / 128).rounded(.down) }
    out.append(UInt8(v))
  }
  static func zig(_ v: Double) -> Double { v >= 0 ? 2 * v : -2 * v - 1 }
  static func unzig(_ v: Double) -> Double { v.truncatingRemainder(dividingBy: 2) != 0 ? -(v + 1) / 2 : v / 2 }

  /** An ink -> the packed points (base64url). A point's time never runs backwards. */
  public static func pack(_ ink: Ink) -> String {
    let n = ink.count
    let tilt = ink.az != nil && ink.al != nil && ink.az!.count >= n && ink.al!.count >= n
    var out: [UInt8] = [UInt8((tilt ? 1 : 0) | (ink.sim ? 2 : 0))]
    var lx = 0.0, ly = 0.0, lt = 0.0
    for i in 0..<n {
      let x = jsRound(fin(ink.pts[2 * i]) * Q), y = jsRound(fin(ink.pts[2 * i + 1]) * Q)
      let t = max(i > 0 ? lt : 0, jsRound(fin(i < ink.t.count ? ink.t[i] : lt)))
      putVar(&out, zig(x - lx)); putVar(&out, zig(y - ly)); putVar(&out, t - lt)
      out.append(UInt8(jsRound(clamp(i < ink.f.count ? fin(ink.f[i]) : 0.5, 0, 1) * 255)))
      if tilt {
        let az = (fin(ink.az![i]).truncatingRemainder(dividingBy: TAU) + TAU).truncatingRemainder(dividingBy: TAU)
        out.append(UInt8(Int(jsRound((az / TAU) * 256)) % 256))
        out.append(UInt8(jsRound((clamp(fin(ink.al![i]), 0, HALF_PI) / HALF_PI) * 255)))
      }
      lx = x; ly = y; lt = t
    }
    return b64u(out)
  }

  /** The packed points -> an ink, or nil (malformed, a newer format, too many). */
  public static func unpack(_ text: String?) -> Ink? {
    guard let text = text, let b = try? unb64u(text), !b.isEmpty, b[0] & ~3 == 0 else { return nil }
    let tilt = b[0] & 1 == 1
    var ink = Ink(az: tilt ? [] : nil, al: tilt ? [] : nil, sim: b[0] & 2 == 2)
    var o = 1
    var x = 0.0, y = 0.0, t = 0.0
    func v() -> Double? {
      var r = 0.0, m = 1.0
      for _ in 0..<8 {
        guard o < b.count else { return nil }
        let c = b[o]; o += 1
        r += Double(c & 127) * m
        if c < 128 { return r }
        m *= 128
      }
      return nil
    }
    while o < b.count {
      if ink.t.count >= MAX_POINTS { return nil }
      guard let dx = v(), let dy = v(), let dt = v() else { return nil }
      x += unzig(dx); y += unzig(dy); t += dt
      if o + (tilt ? 3 : 1) > b.count { return nil }
      ink.pts.append(x / Q); ink.pts.append(y / Q); ink.t.append(t)
      ink.f.append(jsRound(Double(b[o]) / 255 * 1000) / 1000); o += 1
      if tilt { ink.az!.append(Double(b[o]) / 256 * TAU); ink.al!.append(Double(b[o + 1]) / 255 * HALF_PI); o += 2 }
    }
    return ink.t.isEmpty ? nil : ink
  }

  /** A transform [a, b, c, d, tx, ty] baked into an ink (points moved, azimuth turned); the width's scale. */
  public static func bake(_ ink: Ink, _ m: [Double]?) -> (ink: Ink, scale: Double) {
    guard let m = m, m.count == 6, m.allSatisfy({ $0.isFinite }) else { return (ink, 1) }
    let a = m[0], b = m[1], c = m[2], d = m[3], tx = m[4], ty = m[5]
    var out = ink
    for i in stride(from: 0, to: out.pts.count, by: 2) {
      let x = ink.pts[i], y = ink.pts[i + 1]
      out.pts[i] = a * x + c * y + tx; out.pts[i + 1] = b * x + d * y + ty
    }
    let turn = atan2(b, a)
    if let az = ink.az, turn != 0 { out.az = az.map { (($0 + turn).truncatingRemainder(dividingBy: TAU) + TAU).truncatingRemainder(dividingBy: TAU) } }
    let s = sqrt(abs(a * d - b * c))
    return (out, s == 0 ? 1 : s)
  }
  /** How thick the pen is at a force, as a factor of its width (0.25 is 1). */
  public static func thickness(_ f: Double) -> Double { 0.3 + 1.4 * sqrt(clamp(fin(f), 0, 1)) }
  /** A force for an input without pressure (a finger), from its speed in points per ms. */
  public static func forceFromSpeed(_ prev: Double?, _ speed: Double) -> Double {
    let target = clamp(0.36 - 0.075 * fin(speed), 0.07, 0.36)
    guard let p = prev else { return 0.2 }
    return p + (target - p) * 0.3
  }

  /** The stroke's line as samples [x, y, r, …] along the clamped uniform cubic B-spline of its points. */
  public static func sample(_ pts: [Double], _ f: [Double], tool: String = "pen", width: Double = 4, step: Double = 1) -> [Double] {
    let n = pts.count / 2
    if n == 0 { return [] }
    let half = width / 2
    func rAt(_ i: Int) -> Double { tool == "marker" ? half : half * thickness(i < f.count ? f[i] : 0.25) }
    if n == 1 { return [pts[0], pts[1], rAt(0)] }
    func P(_ j: Int) -> Int { min(n - 1, max(0, j - 2)) }
    var out = [pts[0], pts[1], rAt(0)]
    for s in 0...n {
      let i0 = P(s), i1 = P(s + 1), i2 = P(s + 2), i3 = P(s + 3)
      let x0 = pts[2 * i0], y0 = pts[2 * i0 + 1], x1 = pts[2 * i1], y1 = pts[2 * i1 + 1], x2 = pts[2 * i2], y2 = pts[2 * i2 + 1], x3 = pts[2 * i3], y3 = pts[2 * i3 + 1]
      let r0 = rAt(i0), r1 = rAt(i1), r2 = rAt(i2), r3 = rAt(i3)
      let len = hypot(x1 - x0, y1 - y0) + hypot(x2 - x1, y2 - y1) + hypot(x3 - x2, y3 - y2)
      let steps = max(1, min(64, Int(ceil(len / 3 / step))))
      for k in 1...steps {
        let t = Double(k) / Double(steps), t2 = t * t, t3 = t2 * t, u = 1 - t
        let b0 = (u * u * u) / 6, b1 = (3 * t3 - 6 * t2 + 4) / 6, b2 = (-3 * t3 + 3 * t2 + 3 * t + 1) / 6, b3 = t3 / 6
        let x = b0 * x0 + b1 * x1 + b2 * x2 + b3 * x3, y = b0 * y0 + b1 * y1 + b2 * y2 + b3 * y3
        let m = out.count
        if abs(x - out[m - 3]) + abs(y - out[m - 2]) < step * 0.25 && !(s == n && k == steps) { continue }
        out += [x, y, b0 * r0 + b1 * r1 + b2 * r2 + b3 * r3]
      }
    }
    return out
  }
}

// ---- palette ------------------------------------------------------------------------------------------------

public enum Palette {
  /** token -> pen [light, dark], marker [light, dark] (sRGB hex), as shared/palette.mjs. */
  public static let tokens: [String: (pen: (UInt32, UInt32), marker: (UInt32, UInt32)?)] = [
    "ink": ((0x1b1f23, 0xe9eeea), nil),
    "red": ((0xe03131, 0xff6b6b), (0xff8787, 0xff8787)),
    "orange": ((0xf08c00, 0xffa94d), (0xffa94d, 0xffa94d)),
    "yellow": ((0xe8b400, 0xffd43b), (0xffd43b, 0xffd43b)),
    "green": ((0x2f9e44, 0x51cf66), (0x69db7c, 0x69db7c)),
    "blue": ((0x1971c2, 0x4dabf7), (0x66c2ff, 0x66c2ff)),
    "violet": ((0x9c36b5, 0xcc5de8), (0xb197fc, 0xb197fc)),
    "pink": ((0xd6336c, 0xf783ac), (0xff8cc6, 0xff8cc6)),
  ]
  public static let PEN_COLORS = ["ink", "red", "orange", "green", "blue", "violet"]
  public static let MARKER_COLORS = ["yellow", "green", "pink", "blue", "orange"]
  public static let MARKER_OPACITY = (light: 0.5, dark: 0.38)
  /** A token's colour for a tool on light or dark paper (an unknown token: the tool's first colour). */
  public static func color(_ token: String?, tool: String = "pen", dark: Bool = false) -> UInt32 {
    let marker = tool == "marker"
    let fallback = tokens[marker ? MARKER_COLORS[0] : PEN_COLORS[0]]!
    let e = token.flatMap { tokens[$0] }
    let pair: (UInt32, UInt32) = marker ? (e?.marker ?? fallback.marker!) : (e?.pen ?? fallback.pen)
    return dark ? pair.1 : pair.0
  }
  public static func isToken(_ t: String?) -> Bool { t.map { tokens[$0] != nil } ?? false }
  /** The nearest token to an sRGB colour (a PencilKit ink colour back to the palette). */
  public static func nearest(r: Double, g: Double, b: Double, tool: String) -> String {
    let list = tool == "marker" ? MARKER_COLORS : PEN_COLORS
    var best = list[0], bd = Double.infinity
    for t in list {
      for dark in [false, true] {
        let c = color(t, tool: tool, dark: dark)
        let dr = Double((c >> 16) & 0xff) / 255 - r, dg = Double((c >> 8) & 0xff) / 255 - g, db = Double(c & 0xff) / 255 - b
        let d = dr * dr + dg * dg + db * db
        if d < bd { bd = d; best = t }
      }
    }
    return best
  }
}

// ---- shapes -----------------------------------------------------------------------------------------------------

public struct CanvasShape: Identifiable, Equatable {
  public var id: String
  public var by: String
  public var tool: String              // pen | marker | text | voice | sticky | image
  /** A stroke: its points (transform baked in); a note: [x, y]; a picture: [x0, y0, x1, y1]. */
  public var pts: [Double]
  public var ink: Ink?                 // a stroke's full points (t, force, angles)
  public var color: String?
  public var width: Double
  public var z: Double
  public var group: String?
  public var text: String?
  public var size: Double = 20
  public var wrap: Double?
  public var attachment: JV?
  public var nw: Double = 0, nh: Double = 0
  public var mime: String?
  public var name: String?
  public var isStroke: Bool { InkWire.STROKE_TOOLS.contains(tool) }
  public init(id: String, by: String, tool: String, pts: [Double], ink: Ink? = nil, color: String? = nil, width: Double = 4, z: Double = 0, group: String? = nil,
              text: String? = nil, size: Double = 20, wrap: Double? = nil, attachment: JV? = nil) {
    self.id = id; self.by = by; self.tool = tool; self.pts = pts; self.ink = ink; self.color = color; self.width = width; self.z = z; self.group = group
    self.text = text; self.size = size; self.wrap = wrap; self.attachment = attachment
  }
  /** A stroke shape from an ink. */
  public static func stroke(_ ink: Ink, tool: String, color: String, width: Double, id: String = "", by: String = "") -> CanvasShape {
    CanvasShape(id: id, by: by, tool: tool, pts: ink.pts, ink: ink, color: color, width: width)
  }
}

public final class CanvasState {
  static let WORDS: Set<String> = ["text", "voice", "sticky"]
  static let WIDTH = ["pen": 4.0, "marker": 18.0]
  public private(set) var shapes: [String: CanvasShape] = [:]
  public private(set) var erased = Set<String>()
  /** Moves of shapes that have not arrived yet (10.7): added to the shape when its item comes. */
  private var early: [String: (dx: Double, dy: Double)] = [:]
  public private(set) var frontier: [String: (seq: UInt64, hash: String?)] = [:]
  public private(set) var lastEnvelopeNumber = 0
  public private(set) var applied = 0
  /**
   * The board as the core last reduced it (`CoreTools.boardReduce`): the snapshot file's JSON (10.8, the wire's
   * form) and the frontier it stands for. What is shown is made from this alone (`show`); this class judges no
   * item itself.
   */
  public internal(set) var reduced: Bytes?
  public internal(set) var reducedFrontier: [WriterHead] = []
  /** The hub's change number up to which the board's items were read into `reduced`. */
  public internal(set) var heldChange: UInt64 = 0
  public init() {}
  public func covered(_ sender: String, _ seq: UInt64) -> Bool { (frontier[sender]?.seq ?? 0) >= seq }

  /**
   * Shows the board the core made: its snapshot file (wire form) turned into the model's shapes by
   * `Records.boardSnapshot`, which converts and judges nothing. The ids whose shape changed.
   */
  @discardableResult public func show(reduced file: Bytes, frontier: [WriterHead]) throws -> Set<String> {
    guard let wire = JV.parse(file), let model = Records.boardSnapshot(wire) else { throw TrommiError("bad-format", "the core's board does not read") }
    let before = shapes
    load(snapshot: model)
    reduced = file
    reducedFrontier = frontier
    var changed = Set<String>()
    for (id, s) in shapes where before[id] != s { changed.insert(id) }
    for id in before.keys where shapes[id] == nil { changed.insert(id) }
    return changed
  }

  static func nums(_ v: JV, _ n: Int) -> [Double]? {
    guard let a = v.array, a.count == n else { return nil }
    let d = a.compactMap { $0.double }
    return d.count == n && d.allSatisfy { $0.isFinite } ? d : nil
  }
  static func r2(_ v: Double) -> Double { InkWire.jsRound(v * 100) / 100 }

  /** An entry -> a shape (nil: not one this version can show). */
  public static func shapeOf(_ e: JV, id: String, by: String) -> CanvasShape? {
    guard let tool = e["tool"].string else { return nil }
    let z = e["z"].double ?? 0, group = e["group"].string.map { String($0.prefix(80)) }
    if InkWire.STROKE_TOOLS.contains(tool) {
      guard let got = InkWire.unpack(e["points"].string) else { return nil }
      let (ink, scale) = InkWire.bake(got, e["transform"].array?.compactMap { $0.double })
      let w0 = e["width"].double ?? WIDTH[tool]!
      let w = (w0 > 0 && w0 <= 1000 ? w0 : WIDTH[tool]!) * scale
      return CanvasShape(id: id, by: by, tool: tool, pts: ink.pts, ink: ink, color: e["color"].string.map { String($0.prefix(40)) }, width: w, z: z, group: group)
    }
    if WORDS.contains(tool) {
      guard let at = nums(e["at"], 2) else { return nil }
      return CanvasShape(id: id, by: by, tool: tool, pts: at, color: e["color"].string, z: z, group: group, text: String((e["text"].string ?? "").prefix(20000)),
                         size: e["size"].double ?? 20, wrap: e["wrap"].double)
    }
    if tool == "image" {
      guard let rect = nums(e["rect"], 4), e["attachment"]["attachment_id"].string != nil else { return nil }
      var s = CanvasShape(id: id, by: by, tool: tool, pts: rect, z: z, group: group, attachment: e["attachment"])
      s.nw = e["nw"].double ?? 0; s.nh = e["nh"].double ?? 0; s.mime = e["mime"].string; s.name = e["name"].string
      return s
    }
    return nil
  }
  /** A shape -> an entry (for a strokes item). */
  public static func entryOf(_ s: CanvasShape) -> JV {
    var e: [String: JV] = ["tool": .str(s.tool)]
    if s.isStroke {
      e["color"] = .str(s.color ?? (s.tool == "marker" ? "yellow" : "ink"))
      e["width"] = .num(r2(s.width))
      e["points"] = .str(InkWire.pack(s.ink ?? Ink(pts: s.pts)))
    } else if WORDS.contains(s.tool) {
      e["at"] = [.num(r2(s.pts[0])), .num(r2(s.pts[1]))]
      e["text"] = .str(s.text ?? ""); e["size"] = .num(s.size); e["color"] = .str(s.color ?? "ink")
      if let w = s.wrap { e["wrap"] = .num(w) }
    } else if s.tool == "image" {
      e["rect"] = .arr(s.pts.prefix(4).map { .num(r2($0)) }); e["attachment"] = s.attachment ?? .null
      if s.nw > 0 { e["nw"] = .num(s.nw) }; if s.nh > 0 { e["nh"] = .num(s.nh) }
      if let m = s.mime { e["mime"] = .str(m) }; if let n = s.name { e["name"] = .str(n) }
    }
    if s.z != 0 { e["z"] = .num(s.z) }
    if let g = s.group { e["group"] = .str(g) }
    return .obj(e)
  }

  /**
   * Start from a snapshot: the entries with id and by, the frontier; and of a snapshot file of spec/v2.md 10.8
   * (as `Records.boardSnapshot` hands it over) `gone`, the ids erased beyond their writer's frontier, and `moved`,
   * the summed moves of shapes still to come.
   */
  func load(snapshot j: JV) {
    shapes = [:]; erased = []; frontier = [:]; early = [:]
    for id in j["gone"].array ?? [] { if let id = id.string { erased.insert(id) } }
    for m in j["moved"].array ?? [] { if let id = m[0].string, let dx = m[1].double, let dy = m[2].double { early[id] = (dx, dy) } }
    for e in j["shapes"].array ?? [] {
      if let id = e["id"].string, let by = e["by"].string, let s = CanvasState.shapeOf(e, id: id, by: by) { shapes[id] = s }
    }
    for (k, v) in j["frontier"].object ?? [:] { if let seq = v[0].int, seq >= 0 { frontier[k] = (UInt64(seq), v[1].string) } }
    lastEnvelopeNumber = j["last_envelope_number"].int ?? 0
    applied = 0
  }
}

// ---- which board: one per desk, and one for "All desks" (shared/scribble.ts, README "Scribble Board") ----

/** The Scribble Board of a desk, its scribble timeline id: a desk id of 32 hex is taken as it is; any other ('main', a
 *  menu desk's 8 hex) is folded into 16 bytes (its UTF-8 XORed by position, byte i onto i mod 16, then the length
 *  XORed onto the last byte). No desk (a room without desks): the board of 'main'. */
public func deskBoard(_ desk: String?) -> String {
  let id = (desk ?? "").isEmpty ? "main" : desk!
  let bytes = Array(id.utf8)
  if bytes.count == 32 && bytes.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }) { return "desk/\(id)" }
  var out = Bytes(repeating: 0, count: 16)
  for (i, v) in bytes.enumerated() { out[i % 16] ^= v }
  out[15] ^= UInt8(truncatingIfNeeded: bytes.count)
  return "desk/\(hex(out))"
}
/** The board of the 'main' desk, and of a room without desks. */
public let MAIN_BOARD = "desk/6d61696e000000000000000000000004"
/** The board of "All desks": a board of its own, never a desk's. */
public let ALL_BOARD = "desk/616c6c2d6465736b7300000000000009"
