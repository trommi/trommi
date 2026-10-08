// Canvas.swift: the canvas on the wire (shared/canvas.mjs): points as base64url (1/8 px, int32 start, int16 deltas),
// pressure, shapes (pen, highlighter, text, sticky, voice, image), and the reducer: adding once per id, erasing wins,
// moving adds offsets, pieces of a stroke continue it; every stroke id is derived by the receiver (R1:
// <sender>/<sequence>/<index>), agents erase and move only their own. The same canvas whatever the delivery order.
import Foundation
import TrommiCore

public enum CanvasWire {
  static let Q = 8.0
  /** World points [x0, y0, x1, y1, …] -> base64url (a jump wider than an int16 delta is split into steps). */
  public static func encodePoints(_ pts: [Double], pressure pr: [Double]? = nil) -> (points: String, pressure: String?) {
    let n = pts.count / 2
    if n == 0 { return ("", nil) }
    func q(_ v: Double) -> Int { Int((v * Q).rounded()) }
    var xs = [q(pts[0])], ys = [q(pts[1])], ps: [Double]? = pr.map { [$0[0]] }
    for i in 1..<n {
      let x = q(pts[2 * i]), y = q(pts[2 * i + 1]), lx = xs.last!, ly = ys.last!
      let steps = max(1, Int(ceil(Double(max(abs(x - lx), abs(y - ly))) / 32767)))
      for k in 1...steps {
        xs.append(Int((Double(lx) + Double(x - lx) * Double(k) / Double(steps)).rounded())); ys.append(Int((Double(ly) + Double(y - ly) * Double(k) / Double(steps)).rounded()))
        if ps != nil { ps!.append(pr![i]) }
      }
    }
    var b = be32(UInt32(bitPattern: Int32(xs[0]))) + be32(UInt32(bitPattern: Int32(ys[0])))
    for i in 1..<xs.count {
      let dx = Int16(xs[i] - xs[i - 1]), dy = Int16(ys[i] - ys[i - 1])
      b += [UInt8(UInt16(bitPattern: dx) >> 8), UInt8(UInt16(bitPattern: dx) & 0xff), UInt8(UInt16(bitPattern: dy) >> 8), UInt8(UInt16(bitPattern: dy) & 0xff)]
    }
    return (b64u(b), ps.map { b64u($0.map { UInt8(max(0, min(255, ($0 * 255).rounded()))) }) })
  }
  /** base64url -> world points; malformed input gives []. */
  public static func decodePoints(_ text: String?) -> [Double] {
    guard let t = text, let b = try? unb64u(t), b.count >= 8, (b.count - 8) % 4 == 0 else { return [] }
    func i32(_ o: Int) -> Int { Int(Int32(bitPattern: UInt32(b[o]) << 24 | UInt32(b[o + 1]) << 16 | UInt32(b[o + 2]) << 8 | UInt32(b[o + 3]))) }
    func i16(_ o: Int) -> Int { Int(Int16(bitPattern: UInt16(b[o]) << 8 | UInt16(b[o + 1]))) }
    var x = i32(0), y = i32(4)
    var out = [Double(x) / Q, Double(y) / Q]
    var o = 8
    while o < b.count { x += i16(o); y += i16(o + 2); out.append(Double(x) / Q); out.append(Double(y) / Q); o += 4 }
    return out
  }
  public static func decodePressure(_ text: String?, _ n: Int) -> [Double]? {
    guard let t = text, let b = try? unb64u(t), b.count == n else { return nil }
    return b.map { (Double($0) / 255 * 100).rounded() / 100 }
  }
}

public struct CanvasShape: Identifiable, Equatable {
  public var id: String
  public var by: String
  public var tool: String            // pen | hl | text | voice | sticky | image
  public var pts: [Double]
  public var pr: [Double]?
  public var color: String?
  public var size: Double
  public var z: Double
  public var group: String?
  public var text: String?
  public var wrap: Double?
  public var attachment: JV?
  public var nw: Double = 0, nh: Double = 0
  public var mime: String?
  public var name: String?
}

public final class CanvasState {
  static let TOOLS: Set<String> = ["pen", "hl", "text", "voice", "sticky", "image"]
  static let WORDS: Set<String> = ["text", "voice", "sticky"]
  public private(set) var shapes: [String: CanvasShape] = [:]
  public private(set) var erased = Set<String>()
  public private(set) var frontier: [String: (seq: UInt64, hash: String?)] = [:]
  public private(set) var lastEnvelopeNumber = 0
  public private(set) var applied = 0
  public init() {}
  public func covered(_ sender: String, _ seq: UInt64) -> Bool { (frontier[sender]?.seq ?? 0) >= seq }

  /** An entry of a strokes item -> a shape (nil: not one this version can show). */
  public static func shapeOf(_ e: JV, id: String, by: String) -> CanvasShape? {
    guard let tool = e["style"]["tool"].string, TOOLS.contains(tool) else { return nil }
    let pts = CanvasWire.decodePoints(e["points"].string)
    if pts.isEmpty || (tool == "image" && pts.count < 4) { return nil }
    var s = CanvasShape(id: id, by: by, tool: tool, pts: pts, pr: tool == "pen" ? CanvasWire.decodePressure(e["pressure"].string, pts.count / 2) : nil,
                  color: e["style"]["color"].string.map { String($0.prefix(40)) }, size: e["style"]["size"].double ?? (tool == "hl" ? 18 : 4), z: e["z"].double ?? 0,
                  group: e["group"].string.map { String($0.prefix(80)) })
    if WORDS.contains(tool) { s.text = String((e["text"].string ?? "").prefix(20000)); s.wrap = e["wrap"].double }
    if tool == "image" {
      guard e["attachment"]["attachment_id"].string != nil else { return nil }
      s.attachment = e["attachment"]; s.nw = e["nw"].double ?? 0; s.nh = e["nh"].double ?? 0; s.mime = e["mime"].string; s.name = e["name"].string
    }
    return s
  }
  /** A shape -> an entry (for a strokes item). */
  public static func entryOf(_ s: CanvasShape) -> JV {
    let enc = CanvasWire.encodePoints(s.pts, pressure: s.pr)
    var style: [String: JV] = ["tool": .str(s.tool)]
    if let c = s.color { style["color"] = .str(c) }
    style["size"] = .num(s.size)
    var e: [String: JV] = ["points": .str(enc.points), "style": .obj(style)]
    if let p = enc.pressure { e["pressure"] = .str(p) }
    if s.z != 0 { e["z"] = .num(s.z) }
    if let g = s.group { e["group"] = .str(g) }
    if WORDS.contains(s.tool) { e["text"] = .str(s.text ?? ""); if let w = s.wrap { e["wrap"] = .num(w) } }
    if s.tool == "image" { e["attachment"] = s.attachment ?? .null; e["nw"] = .num(s.nw); e["nh"] = .num(s.nh); if let m = s.mime { e["mime"] = .str(m) }; if let n = s.name { e["name"] = .str(n) } }
    return .obj(e)
  }

  /** Apply one canvas item; the ids it changed, or nil when it was skipped (covered by the frontier). */
  @discardableResult public func apply(sender: String, seq: UInt64, hash: String?, envelopeNumber: Int?, content: JV, senderRole: String = "human") -> Set<String>? {
    if seq < 1 || covered(sender, seq) { return nil }
    frontier[sender] = (seq, hash)
    if let n = envelopeNumber { lastEnvelopeNumber = max(lastEnvelopeNumber, n) }
    applied += 1
    var changed = Set<String>()
    let own: (String) -> Bool = { $0.hasPrefix("\(sender)/") }
    let may: (String) -> Bool = { senderRole != "agent" || own($0) }
    switch content["content_type"].string {
    case "strokes":
      for (i, e) in (content["strokes"].array ?? []).enumerated() {
        if let cont = e["continues"].string {
          guard own(cont), var head = shapes[cont], head.tool == "pen" || head.tool == "hl" else { continue }
          let more = CanvasWire.decodePoints(e["points"].string)
          if more.isEmpty { continue }
          if head.pr != nil { head.pr! += CanvasWire.decodePressure(e["pressure"].string, more.count / 2) ?? Array(repeating: 0.5, count: more.count / 2) }
          head.pts += more
          shapes[cont] = head
          changed.insert(cont)
          continue
        }
        let id = "\(sender)/\(seq)/\(i)"
        if erased.contains(id) || shapes[id] != nil { continue }
        if let s = CanvasState.shapeOf(e, id: id, by: sender) { shapes[id] = s; changed.insert(id) }
      }
    case "erase", "send_away":
      for id in (content["stroke_ids"].array ?? []).compactMap({ $0.string }) where may(id) {
        erased.insert(id)
        if shapes.removeValue(forKey: id) != nil { changed.insert(id) }
      }
    case "move":
      let off = (content["offset"].array ?? []).map { $0.double ?? 0 }
      let dx = off.count > 0 ? off[0] : 0, dy = off.count > 1 ? off[1] : 0
      if dx != 0 || dy != 0 {
        for id in (content["stroke_ids"].array ?? []).compactMap({ $0.string }) where may(id) {
          guard var s = shapes[id] else { continue }
          for k in stride(from: 0, to: s.pts.count, by: 2) { s.pts[k] += dx; s.pts[k + 1] += dy }
          shapes[id] = s
          changed.insert(id)
        }
      }
    default: break
    }
    return changed
  }

  /** Start from a snapshot (the gzip'd JSON a device wrote: register canvas_snapshot/<timeline>). */
  public func load(snapshot j: JV) {
    shapes = [:]; erased = []; frontier = [:]
    for e in j["shapes"].array ?? [] {
      if let id = e["id"].string, let by = e["by"].string, let s = CanvasState.shapeOf(e, id: id, by: by) { shapes[id] = s }
    }
    for (k, v) in j["frontier"].object ?? [:] { if let seq = v[0].int { frontier[k] = (UInt64(seq), v[1].string) } }
    lastEnvelopeNumber = j["last_envelope_number"].int ?? 0
    applied = 0
  }
  /** The snapshot's content: every shape, the frontier, the newest envelope number. */
  public func snapshot() -> JV {
    .obj(["v": 1, "shapes": .arr(shapes.values.map { s in CanvasState.entryOf(s).with("id", .str(s.id)).with("by", .str(s.by)) }),
          "frontier": .obj(frontier.mapValues { .arr([.n($0.seq), $0.hash.map { .str($0) } ?? .null]) }), "last_envelope_number": .n(lastEnvelopeNumber)])
  }
}

/** The canvas timeline of a desk: desk/ and 32 hex; another desk id is folded into 16 bytes (whiteboard.mjs deskCanvas). */
public func deskCanvas(_ desk: String?) -> String {
  let id = (desk?.isEmpty == false ? desk! : "main")
  if id.utf8.count == 32, id.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) { return "desk/\(id)" }
  let bytes = Array(id.utf8)
  var out = [UInt8](repeating: 0, count: 16)
  for (i, v) in bytes.enumerated() { out[i % 16] ^= v }
  out[15] ^= UInt8(bytes.count & 0xff)
  return "desk/\(hex(out))"
}
