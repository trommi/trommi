// PenView.swift: the web app's hand-drawn marks, drawn natively. The SVG strings come from Resources/pen.json (made by
// dev/ios-pen.mjs from the web's pen) or from the Swift pen (a session's seeded scribble). A small SVG reader takes the
// subset the pen writes (path with M L H V Q T C S A Z, circle, g with translate/scale, classes and inline styles) and
// SwiftUI draws it with the theme's inks: the stroke follows the foreground colour, as `currentColor` does on the web.
import SwiftUI
import TrommiClient

// ---- reading ---------------------------------------------------------------------------------------------

struct SVGItem {
  var path: Path
  var classes: Set<String>
  var style: [String: String]
  var attrs: [String: String]
  var nonScaling: Bool
}
struct SVGDoc {
  var viewBox: CGRect
  var classes: Set<String>
  var rotate: Double
  var stretch: Bool
  var items: [SVGItem]
}

enum PenStore {
  static let marks: [String: String] = {
    guard let url = Bundle.module.url(forResource: "pen", withExtension: "json"), let d = try? Data(contentsOf: url),
          let o = try? JSONSerialization.jsonObject(with: d) as? [String: String] else { return [:] }
    return o
  }()
  private static var cache: [String: SVGDoc] = [:]
  private static let lock = NSLock()
  /** A parsed mark by its key in pen.json ("sketch:later", "draw:rocket", "crown", "desk:BOLT", …). */
  static func doc(_ key: String) -> SVGDoc? {
    lock.lock(); defer { lock.unlock() }
    if let d = cache[key] { return d }
    guard let s = marks[key] else { return nil }
    let d = SVGReader.parse(s)
    cache[key] = d
    return d
  }
  /** A session's mark: a named drawing from pen.json, else its seeded scribble (Pen.scribble). */
  static func mark(_ mark: String) -> SVGDoc {
    lock.lock()
    if let d = cache["mark:\(mark)"] { lock.unlock(); return d }
    lock.unlock()
    let d: SVGDoc
    if let name = Pen.drawingName(mark), let s = marks["draw:\(name)"] { d = SVGReader.parse(s) }
    else {
      let s = Pen.scribble(seed: mark)
      d = SVGDoc(viewBox: CGRect(x: 0, y: 0, width: 32, height: 32), classes: ["doodle"], rotate: s.rotate, stretch: false,
                 items: s.paths.map { SVGItem(path: SVGReader.path($0), classes: [], style: [:], attrs: [:], nonScaling: false) })
    }
    lock.lock(); cache["mark:\(mark)"] = d; lock.unlock()
    return d
  }
}

enum SVGReader {
  static func attrs(_ tag: String) -> [String: String] {
    var out = [String: String]()
    let re = try! NSRegularExpression(pattern: #"([a-zA-Z_:-]+)="([^"]*)""#)
    let ns = tag as NSString
    for m in re.matches(in: tag, range: NSRange(location: 0, length: ns.length)) { out[ns.substring(with: m.range(at: 1))] = ns.substring(with: m.range(at: 2)) }
    return out
  }
  static func style(_ s: String?) -> [String: String] {
    var out = [String: String]()
    for part in (s ?? "").split(separator: ";") {
      let kv = part.split(separator: ":", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
      if kv.count == 2 { out[kv[0]] = kv[1] }
    }
    return out
  }
  static func parse(_ svg: String) -> SVGDoc {
    var doc = SVGDoc(viewBox: CGRect(x: 0, y: 0, width: 24, height: 24), classes: [], rotate: 0, stretch: false, items: [])
    let tagRe = try! NSRegularExpression(pattern: #"<(/?)([a-z]+)([^>]*?)(/?)>"#)
    let ns = svg as NSString
    var groups: [(classes: Set<String>, transform: CGAffineTransform, style: [String: String], attrs: [String: String])] = []
    for m in tagRe.matches(in: svg, range: NSRange(location: 0, length: ns.length)) {
      let closing = ns.substring(with: m.range(at: 1)) == "/", name = ns.substring(with: m.range(at: 2)), rest = ns.substring(with: m.range(at: 3))
      let selfClosing = ns.substring(with: m.range(at: 4)) == "/"
      if closing { if name == "g" && !groups.isEmpty { groups.removeLast() }; continue }
      let a = attrs(rest)
      let cls = Set((a["class"] ?? "").split(separator: " ").map(String.init))
      switch name {
      case "svg":
        if let vb = a["viewBox"]?.split(separator: " ").compactMap({ Double($0) }), vb.count == 4 { doc.viewBox = CGRect(x: vb[0], y: vb[1], width: vb[2], height: vb[3]) }
        doc.classes = cls
        let st = style(a["style"])
        if let r = st["rotate"], let v = Double(r.replacingOccurrences(of: "deg", with: "")) { doc.rotate = v }
        doc.stretch = a["preserveAspectRatio"] == "none"
      case "g":
        if !selfClosing {
          let parent = groups.last
          let t = transform(a["transform"]).concatenating(parent?.transform ?? .identity)
          groups.append((cls.union(parent?.classes ?? []), t, (parent?.style ?? [:]).merging(style(a["style"])) { $1 }, (parent?.attrs ?? [:]).merging(a) { $1 }))
        }
      case "path", "circle":
        var p: Path
        if name == "path" { p = path(a["d"] ?? "") }
        else {
          let cx = Double(a["cx"] ?? "0") ?? 0, cy = Double(a["cy"] ?? "0") ?? 0, r = Double(a["r"] ?? "0") ?? 0
          p = Path(ellipseIn: CGRect(x: cx - r, y: cy - r, width: 2 * r, height: 2 * r))
        }
        let g = groups.last
        if let t = g?.transform, t != .identity { p = p.applying(t) }
        var at = g?.attrs ?? [:]
        at.removeValue(forKey: "class"); at.removeValue(forKey: "transform"); at.removeValue(forKey: "style")
        for (k, v) in a { at[k] = v }
        doc.items.append(SVGItem(path: p, classes: cls.union(g?.classes ?? []), style: (g?.style ?? [:]).merging(style(a["style"])) { $1 }, attrs: at,
                                 nonScaling: a["vector-effect"] == "non-scaling-stroke"))
      default: break
      }
    }
    return doc
  }
  static func transform(_ t: String?) -> CGAffineTransform {
    guard let t = t else { return .identity }
    var out = CGAffineTransform.identity
    let re = try! NSRegularExpression(pattern: #"(translate|scale|rotate)\(([^)]*)\)"#)
    let ns = t as NSString
    for m in re.matches(in: t, range: NSRange(location: 0, length: ns.length)) {
      let f = ns.substring(with: m.range(at: 1))
      let v = ns.substring(with: m.range(at: 2)).split(whereSeparator: { $0 == " " || $0 == "," }).compactMap { Double($0) }
      let step: CGAffineTransform
      switch f {
      case "translate": step = CGAffineTransform(translationX: v.first ?? 0, y: v.count > 1 ? v[1] : 0)
      case "scale": step = CGAffineTransform(scaleX: v.first ?? 1, y: v.count > 1 ? v[1] : (v.first ?? 1))
      default: step = CGAffineTransform(rotationAngle: (v.first ?? 0) * .pi / 180)
      }
      out = step.concatenating(out)
    }
    return out
  }

  /** SVG path data to a Path (absolute and relative commands, smooth curves, arcs). */
  static func path(_ d: String) -> Path {
    var p = Path()
    var tokens = [String]()
    var cur = ""
    func flush() { if !cur.isEmpty { tokens.append(cur); cur = "" } }
    var lastWasE = false
    for ch in d {
      if ch.isLetter && ch != "e" && ch != "E" { flush(); tokens.append(String(ch)); lastWasE = false }
      else if ch == "," || ch == " " || ch == "\n" || ch == "\t" { flush(); lastWasE = false }
      else if ch == "-" && !cur.isEmpty && !lastWasE { flush(); cur = "-" }
      else if ch == "." && cur.contains(".") && !cur.contains("e") { flush(); cur = "." }
      else { cur.append(ch); lastWasE = ch == "e" || ch == "E" }
    }
    flush()
    var i = 0, cmd: Character = "M"
    var pt = CGPoint.zero, start = CGPoint.zero, lastCtrl: CGPoint? = nil, lastQ: CGPoint? = nil
    func num() -> CGFloat { defer { i += 1 }; return i < tokens.count ? CGFloat(Double(tokens[i]) ?? 0) : 0 }
    func hasNum() -> Bool { i < tokens.count && Double(tokens[i]) != nil }
    while i < tokens.count {
      if let c = tokens[i].first, tokens[i].count == 1, c.isLetter { cmd = c; i += 1 }
      let rel = cmd.isLowercase
      let o = rel ? pt : .zero
      switch cmd.uppercased().first! {
      case "M":
        pt = CGPoint(x: o.x + num(), y: o.y + num()); p.move(to: pt); start = pt; lastCtrl = nil; lastQ = nil
        cmd = rel ? "l" : "L"
      case "L": pt = CGPoint(x: o.x + num(), y: o.y + num()); p.addLine(to: pt); lastCtrl = nil; lastQ = nil
      case "H": pt = CGPoint(x: (rel ? pt.x : 0) + num(), y: pt.y); p.addLine(to: pt); lastCtrl = nil; lastQ = nil
      case "V": pt = CGPoint(x: pt.x, y: (rel ? pt.y : 0) + num()); p.addLine(to: pt); lastCtrl = nil; lastQ = nil
      case "Q":
        let c = CGPoint(x: o.x + num(), y: o.y + num()), e = CGPoint(x: o.x + num(), y: o.y + num())
        p.addQuadCurve(to: e, control: c); pt = e; lastQ = c; lastCtrl = nil
      case "T":
        let c = lastQ.map { CGPoint(x: 2 * pt.x - $0.x, y: 2 * pt.y - $0.y) } ?? pt
        let e = CGPoint(x: o.x + num(), y: o.y + num())
        p.addQuadCurve(to: e, control: c); pt = e; lastQ = c; lastCtrl = nil
      case "C":
        let c1 = CGPoint(x: o.x + num(), y: o.y + num()), c2 = CGPoint(x: o.x + num(), y: o.y + num()), e = CGPoint(x: o.x + num(), y: o.y + num())
        p.addCurve(to: e, control1: c1, control2: c2); pt = e; lastCtrl = c2; lastQ = nil
      case "S":
        let c1 = lastCtrl.map { CGPoint(x: 2 * pt.x - $0.x, y: 2 * pt.y - $0.y) } ?? pt
        let c2 = CGPoint(x: o.x + num(), y: o.y + num()), e = CGPoint(x: o.x + num(), y: o.y + num())
        p.addCurve(to: e, control1: c1, control2: c2); pt = e; lastCtrl = c2; lastQ = nil
      case "A":
        let rx = num(), ry = num(), rot = num(), large = num() != 0, sweep = num() != 0
        let e = CGPoint(x: o.x + num(), y: o.y + num())
        arc(&p, from: pt, to: e, rx: rx, ry: ry, rotation: rot, large: large, sweep: sweep); pt = e; lastCtrl = nil; lastQ = nil
      case "Z": p.closeSubpath(); pt = start; lastCtrl = nil; lastQ = nil
      default: i += 1
      }
      if cmd.uppercased() == "Z" && hasNum() { i += 1 }   // (a number after Z is not SVG: skipped, never looped on)
    }
    return p
  }
  /** An SVG arc as cubic curves (endpoint to centre parametrisation, SVG 1.1 F.6.5). */
  static func arc(_ p: inout Path, from p0: CGPoint, to p1: CGPoint, rx rx0: CGFloat, ry ry0: CGFloat, rotation: CGFloat, large: Bool, sweep: Bool) {
    if p0 == p1 { return }
    var rx = abs(rx0), ry = abs(ry0)
    if rx == 0 || ry == 0 { p.addLine(to: p1); return }
    let phi = rotation * .pi / 180, cp = cos(phi), sp = sin(phi)
    let dx = (p0.x - p1.x) / 2, dy = (p0.y - p1.y) / 2
    let x1 = cp * dx + sp * dy, y1 = -sp * dx + cp * dy
    let lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
    if lam > 1 { rx *= sqrt(lam); ry *= sqrt(lam) }
    let num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1, den = rx * rx * y1 * y1 + ry * ry * x1 * x1
    var co = sqrt(max(0, num / den)); if large == sweep { co = -co }
    let cx1 = co * rx * y1 / ry, cy1 = -co * ry * x1 / rx
    let cx = cp * cx1 - sp * cy1 + (p0.x + p1.x) / 2, cy = sp * cx1 + cp * cy1 + (p0.y + p1.y) / 2
    func ang(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat { atan2(ux * vy - uy * vx, ux * vx + uy * vy) }
    let t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry)
    var dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry)
    if !sweep && dt > 0 { dt -= 2 * .pi } else if sweep && dt < 0 { dt += 2 * .pi }
    let n = Int(ceil(abs(dt) / (.pi / 2)))
    let step = dt / CGFloat(n)
    var t = t1
    for _ in 0..<n {
      let k = 4 / 3 * tan(step / 4)
      func pnt(_ a: CGFloat) -> CGPoint { CGPoint(x: cx + rx * cos(a) * cp - ry * sin(a) * sp, y: cy + rx * cos(a) * sp + ry * sin(a) * cp) }
      func der(_ a: CGFloat) -> CGPoint { CGPoint(x: -rx * sin(a) * cp - ry * cos(a) * sp, y: -rx * sin(a) * sp + ry * cos(a) * cp) }
      let a = pnt(t), b = pnt(t + step), da = der(t), db = der(t + step)
      p.addCurve(to: b, control1: CGPoint(x: a.x + k * da.x, y: a.y + k * da.y), control2: CGPoint(x: b.x - k * db.x, y: b.y - k * db.y))
      t += step
    }
  }
}

// ---- drawing -----------------------------------------------------------------------------------------------

/** How a mark is inked beyond its stroke: the parts the web colours by class. */
struct PenInks {
  var stroke: Color = Ink.fg
  var width: CGFloat? = nil                 // stroke width in view-box units (default: the class's)
  var surface: Color = Ink.surface          // paper parts (the duck's body, the tag)
  var blocked = false                       // the raised hand on red
  var duck = false                          // the duck in yellow
  /** The water the yellow duck swims on (default: the stroke colour, the button's own ink). */
  var water: Color? = nil
}

/** One mark of the pen, by its pen.json key, sized by its frame. */
struct PenMark: View {
  let doc: SVGDoc?
  var inks = PenInks()
  init(_ key: String, color: Color = Ink.fg, width: CGFloat? = nil, blocked: Bool = false, duck: Bool = false) {
    doc = PenStore.doc(key)
    inks = PenInks(stroke: color, width: width, blocked: blocked, duck: duck)
  }
  init(doc: SVGDoc?, inks: PenInks) { self.doc = doc; self.inks = inks }
  var body: some View {
    Canvas { ctx, size in if let d = doc { PenDraw.draw(d, in: &ctx, size: size, inks: inks) } }
      .rotationEffect(.degrees(doc?.rotate ?? 0))
      .aspectRatio(doc.map { $0.viewBox.width / max(1, $0.viewBox.height) } ?? 1, contentMode: .fit)
      .accessibilityHidden(true)
  }
}

enum PenDraw {
  static func baseWidth(_ d: SVGDoc) -> CGFloat {
    if d.classes.contains("doodle") { return 2.1 }
    if d.classes.contains("gear") || d.classes.contains("asset-glyph") { return 1.5 }
    if d.classes.contains("brand-mark") { return 1.8 }
    return 1.7
  }
  static func draw(_ d: SVGDoc, in ctx: inout GraphicsContext, size: CGSize, inks: PenInks) {
    let t0 = PerfLog.on ? DispatchTime.now().uptimeNanoseconds : 0
    defer { if PerfLog.on { RenderCount.penDraws += 1; RenderCount.penNs += DispatchTime.now().uptimeNanoseconds - t0 } }
    let vb = d.viewBox
    let sx = size.width / vb.width, sy = size.height / vb.height
    let s = d.stretch ? 1 : min(sx, sy)
    let tx = d.stretch ? -vb.minX * sx : (size.width - vb.width * s) / 2 - vb.minX * s
    let ty = d.stretch ? -vb.minY * sy : (size.height - vb.height * s) / 2 - vb.minY * s
    let t = d.stretch ? CGAffineTransform(a: sx, b: 0, c: 0, d: sy, tx: tx, ty: ty) : CGAffineTransform(a: s, b: 0, c: 0, d: s, tx: tx, ty: ty)
    let unit = d.stretch ? (sx + sy) / 2 : s
    let base = inks.width ?? baseWidth(d)
    let docCls = d.classes
    for it in d.items {
      let p = it.path.applying(t)
      let c = it.classes.union(docCls)
      // a drawing with a coloured fill (the yellow duck, the yellow note) keeps dark ink in dark mode too; only a drawing
      // standing on the page's ground takes the page's ink (as the web: --duck-ink, the note's ink)
      let onColour = inks.duck
      var stroke: Color? = onColour ? Ink.duckInk : inks.stroke
      var fill: Color? = nil
      var width = base
      if let w = it.attrs["stroke-width"].flatMap(Double.init) { width = CGFloat(w) }
      var opacity = it.attrs["opacity"].flatMap(Double.init) ?? 1
      // the classes the web colours (app.css, desk.css, card.css)
      if c.contains("crown-wash") { stroke = nil; fill = Ink.crownWash }
      if c.contains("crown-pen") { stroke = Ink.goldPen; width = 1.7 }
      if c.contains("hand-loop") { width = 1.5; if inks.blocked { fill = Ink.urgCritical; stroke = Ink.urgCritical } }
      if c.contains("hand-pen") { width = inks.blocked ? 1.7 : 1.45; if inks.blocked { stroke = Ink.surface } }
      if c.contains("ring-loop") { width = inks.width ?? 1.25 }
      if c.contains("tag-paper") { fill = inks.surface }
      if c.contains("tag-z") { stroke = Ink.fg }
      if docCls.contains("blitz-bolt") { fill = Ink.yellow }
      if c.contains("end-check") { stroke = Ink.stampDone; width = 2.2 }
      if c.contains("note-fill") { fill = Ink.noteYellow; stroke = nil }
      // the note's outline stands on the ground (the page's ink, as the web), its lines on the yellow paper (dark ink)
      if c.contains("note-ink") { stroke = Ink.fg; width = inks.width ?? 1.55 }
      // (drawn heavier, as a bar item: the written lines a little finer than the outline, they lie close together)
      if c.contains("note-lines") { stroke = Ink.noteInk; width = inks.width.map { $0 * 0.7 } ?? 1.55 }
      if c.contains("clamp-plate") { fill = Color.dyn(0xc9ccc6, 0x59605b) }
      if c.contains("brand-mark-ring") { stroke = Ink.accent }
      if it.attrs["fill"] != nil && it.attrs["fill"] != "none" { fill = stroke }
      // inline styles of the duck and friends
      if let f = it.style["fill"] {
        if f.contains("--surface") { fill = inks.duck ? Ink.duckYellow : inks.surface }
        else if f.contains("--duck-bill") { fill = inks.duck ? Color(hex: 0xf28a2e) : inks.stroke.opacity(0.22) }
        else if f == "currentColor" { fill = onColour ? Ink.duckInk : inks.stroke }
        else if f == "none" { fill = nil }
      }
      if let st = it.style["stroke"] {
        if st.contains("--duck-glint") { stroke = inks.duck ? .white : inks.surface }
        else if st.contains("--duck-water") { stroke = inks.duck ? (inks.water ?? inks.stroke) : inks.stroke }
      }
      if let w = it.style["stroke-width"].flatMap({ Double($0.replacingOccurrences(of: "px", with: "")) }) { width = CGFloat(w) }
      if let o = it.style["opacity"].flatMap(Double.init) { opacity = o }
      let lw = it.nonScaling ? width : width * unit
      var dash: [CGFloat] = []
      var phase: CGFloat = 0
      if let da = it.attrs["stroke-dasharray"] {
        let parts = da.split(separator: " ").compactMap { Double($0) }.map { CGFloat($0) }
        // dashes in pathLength units (100): measured against the drawn length
        let len: CGFloat? = it.attrs["pathLength"].flatMap { Double($0) }.map { CGFloat($0) }
        let real = length(of: p)
        let k = len.map { real / $0 } ?? 1
        dash = parts.map { $0 * k }
        phase = CGFloat(it.attrs["stroke-dashoffset"].flatMap(Double.init) ?? 0) * k
      }
      var g = ctx
      g.opacity = opacity
      if let f = fill { g.fill(p, with: .color(f)) }
      if let s = stroke {
        g.stroke(p, with: .color(s), style: StrokeStyle(lineWidth: lw, lineCap: .round, lineJoin: .round, dash: dash, dashPhase: phase))
      }
    }
  }
  /** A path's drawn length (flattened). */
  static func length(of p: Path) -> CGFloat {
    var total: CGFloat = 0
    var last = CGPoint.zero, start = CGPoint.zero
    p.forEach { el in
      switch el {
      case .move(let to): last = to; start = to
      case .line(let to): total += hypot(to.x - last.x, to.y - last.y); last = to
      case .quadCurve(let to, let c):
        var prev = last
        for i in 1...12 { let t = CGFloat(i) / 12, u = 1 - t; let q = CGPoint(x: u * u * last.x + 2 * u * t * c.x + t * t * to.x, y: u * u * last.y + 2 * u * t * c.y + t * t * to.y); total += hypot(q.x - prev.x, q.y - prev.y); prev = q }
        last = to
      case .curve(let to, let c1, let c2):
        var prev = last
        for i in 1...16 {
          let t = CGFloat(i) / 16, u = 1 - t
          let q = CGPoint(x: u * u * u * last.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * to.x, y: u * u * u * last.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * to.y)
          total += hypot(q.x - prev.x, q.y - prev.y); prev = q
        }
        last = to
      case .closeSubpath: total += hypot(start.x - last.x, start.y - last.y); last = start
      }
    }
    return total
  }
}

// ---- the marks the screens use ---------------------------------------------------------------------------

/** A sketch icon of the pen ("later", "tick", "duck", …) in the current ink. */
struct Sketch: View {
  let name: String
  var color: Color = Ink.fg
  var width: CGFloat? = nil
  init(_ name: String, color: Color = Ink.fg, width: CGFloat? = nil) { self.name = name; self.color = color; self.width = width }
  var body: some View { PenMark("sketch:\(name)", color: color, width: width) }
}

/** A session's mark: its drawing in its colour, the crown when it is the desk's crowned session. */
struct AgentMark: View {
  let agent: Agent
  var size: CGFloat = 26
  var crown = true
  var body: some View {
    ZStack(alignment: .topLeading) {
      PenMark(doc: PenStore.mark(agent.mark), inks: PenInks(stroke: Tone.mark(agent.hue)))
        .frame(width: size, height: size)
        .opacity(agent.online || agent.own ? 1 : 0.75)
      if crown && agent.starred {
        PenMark("crown").frame(width: size * 0.62, height: size * 0.45).offset(x: -size * 0.12, y: -size * 0.3)
      }
    }
    .frame(width: size, height: size)
  }
}

/** The pen's underline under a word (the --under-ink stroke), the accent green. */
struct PenUnderline: Shape {
  func path(in r: CGRect) -> Path {
    var p = SVGReader.path("M0.0 4.0 Q9.0 3.2 14.5 3.9 Q20.0 4.6 26.5 4.0 Q33.0 3.4 39.5 4.0 Q46.0 4.5 52.0 3.9 Q58.0 3.3 65.0 3.6 L72.0 4.0")
    p = p.applying(CGAffineTransform(scaleX: r.width / 72, y: r.height / 7).translatedBy(x: r.minX, y: r.minY))
    return p
  }
}

/** The working ring: a loop and, while the session works, a stroke that goes round it. */
struct WorkingRing: View {
  var working: Bool
  var color: Color = Ink.muted
  @State private var turn = false
  var body: some View {
    ZStack {
      PenMark("ring", color: color.opacity(working ? 0.38 : 1))
      if working {
        PenMark("ring-drop", color: color)
          .rotationEffect(.degrees(turn ? 360 : 0))
          .animation(.linear(duration: 1.9).repeatForever(autoreverses: false), value: turn)
          .onAppear { turn = true }
      }
    }
  }
}

/** A drawn mark as a picture, for places that take only images (a system menu): drawn once per ink and size. */
@MainActor enum PenImage {
  private static var cache: [String: Image] = [:]
  static func of(_ key: String, size: CGFloat = 22, dot: Bool = false) -> Image {
    let k = "\(key)|\(size)|\(dot)"
    if let i = cache[k] { return i }
    let r = ImageRenderer(content: PenMark(key, color: .black).frame(width: size, height: size)
      .overlay(alignment: .topLeading) { if dot { Circle().fill(.black).frame(width: 6, height: 6) } })
    r.scale = 3
    #if canImport(UIKit)
    let img = r.uiImage.map { Image(uiImage: $0.withRenderingMode(.alwaysTemplate)) } ?? Image(systemName: "square")
    #else
    let img = Image(systemName: "square")
    #endif
    cache[k] = img
    return img
  }
  static func desk(waiting: Bool) -> Image { of("sketch:desk", dot: waiting) }
}
