// ScribbleScreen.swift: the Scribble Board (app/web/public/whiteboard.mjs), the desk's canvas, end-to-end encrypted:
// draw with the pen or the highlighter, write a sticky, erase, choose an area and send it to a session as a picture with
// its words ("what was sent leaves the canvas"). Pan with two fingers or the hand, pinch to zoom. The shapes are the
// web's (canvas.mjs): a stroke drawn here is the same stroke on the web.
import SwiftUI
import TrommiClient
import TrommiCore
#if canImport(UIKit)
import UIKit
#endif

let PEN_COLORS: [(String, String)] = [("ink", "Ink"), ("#e03131", "Red"), ("#f08c00", "Orange"), ("#2f9e44", "Green"), ("#1971c2", "Blue"), ("#9c36b5", "Violet")]
let HL_COLORS: [(String, String)] = [("#ffd43b", "Yellow"), ("#69db7c", "Green"), ("#ff8cc6", "Pink"), ("#66c2ff", "Blue"), ("#ffa94d", "Orange")]

func inkColor(_ c: String?, dark: Bool) -> Color {
  guard let c = c, c != "ink", c.hasPrefix("#"), let v = UInt32(c.dropFirst(), radix: 16) else { return dark ? Color(hex: 0xe9eeea) : Color(hex: 0x1b1f23) }
  return Color(hex: v)
}

/** Draws shapes (world units) in a frame given the view's offset and scale. */
enum ShapeDraw {
  static func path(_ pts: [Double], _ t: @escaping (CGPoint) -> CGPoint) -> Path {
    var p = Path()
    let n = pts.count / 2
    guard n > 0 else { return p }
    let pt = { (i: Int) in t(CGPoint(x: pts[2 * i], y: pts[2 * i + 1])) }
    p.move(to: pt(0))
    if n == 1 { p.addLine(to: pt(0)); return p }
    for i in 1..<(n - 1) {
      let a = pt(i), b = pt(i + 1)
      p.addQuadCurve(to: CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2), control: a)
    }
    p.addLine(to: pt(n - 1))
    return p
  }
  static func draw(_ s: CanvasShape, in ctx: inout GraphicsContext, offset: CGPoint, scale: CGFloat, dark: Bool, selected: Bool = false) {
    let t: (CGPoint) -> CGPoint = { CGPoint(x: $0.x * scale + offset.x, y: $0.y * scale + offset.y) }
    switch s.tool {
    case "pen", "hl":
      let p = path(s.pts, t)
      let avg = s.pr.map { $0.isEmpty ? 0.5 : $0.reduce(0, +) / Double($0.count) } ?? 0.5
      let w = CGFloat(s.size) * scale * (s.tool == "pen" && s.pr != nil ? CGFloat(0.6 + avg * 0.8) : 1)
      var c = inkColor(s.color, dark: dark)
      if s.tool == "hl" { c = c.opacity(dark ? 0.45 : 0.4) }
      if selected { ctx.stroke(p, with: .color(Ink.accent.opacity(0.35)), style: StrokeStyle(lineWidth: w + 8, lineCap: .round, lineJoin: .round)) }
      ctx.stroke(p, with: .color(c), style: StrokeStyle(lineWidth: max(0.5, w), lineCap: s.tool == "hl" ? .butt : .round, lineJoin: .round))
    case "sticky":
      let o = t(CGPoint(x: s.pts[0], y: s.pts[1]))
      let w = CGFloat(s.wrap ?? 240) * scale
      let text = Text(s.text ?? "").font(Face.text(CGFloat(s.size > 0 ? s.size : 17) * scale)).foregroundStyle(Color(hex: dark ? 0x231c06 : 0x3b300d))
      let r = ctx.resolve(text)
      let size = r.measure(in: CGSize(width: w - 32 * scale, height: .infinity))
      let rect = CGRect(x: o.x, y: o.y, width: w, height: max(104 * scale, size.height + 30 * scale))
      ctx.fill(Path(rect), with: .color(Color(hex: dark ? 0xd9c35f : 0xfbe7a1)))
      if selected { ctx.stroke(Path(rect), with: .color(Ink.accent), lineWidth: 2) }
      ctx.fill(Path(CGRect(x: o.x + w / 2 - 34 * scale, y: o.y - 10 * scale, width: 68 * scale, height: 20 * scale)), with: .color(Color(hex: 0xe6d27a).opacity(0.62)))
      ctx.draw(r, in: CGRect(x: o.x + 16 * scale, y: o.y + 16 * scale, width: w - 32 * scale, height: size.height))
    case "text", "voice":
      let o = t(CGPoint(x: s.pts[0], y: s.pts[1]))
      let text = Text(s.text ?? "").font(Face.text(CGFloat(s.size > 0 ? s.size : 20) * scale)).foregroundStyle(inkColor(s.color, dark: dark))
      let r = ctx.resolve(text)
      let w = CGFloat(s.wrap ?? 460) * scale
      let size = r.measure(in: CGSize(width: w, height: .infinity))
      if selected { ctx.stroke(Path(CGRect(origin: o, size: size).insetBy(dx: -4, dy: -4)), with: .color(Ink.accent), lineWidth: 2) }
      ctx.draw(r, in: CGRect(origin: o, size: CGSize(width: w, height: size.height)))
    case "image":
      let a = t(CGPoint(x: s.pts[0], y: s.pts[1])), b = t(CGPoint(x: s.pts[2], y: s.pts[3]))
      let rect = CGRect(x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y)
      if selected { ctx.stroke(Path(rect.insetBy(dx: -3, dy: -3)), with: .color(Ink.accent), lineWidth: 2) }
    default: break
    }
  }
  /** The world box of a shape (for hit tests and the selection). */
  static func box(_ s: CanvasShape) -> CGRect {
    if s.tool == "image" && s.pts.count >= 4 { return CGRect(x: s.pts[0], y: s.pts[1], width: s.pts[2] - s.pts[0], height: s.pts[3] - s.pts[1]) }
    if s.tool == "sticky" { return CGRect(x: s.pts[0], y: s.pts[1], width: s.wrap ?? 240, height: 140) }
    if s.tool == "text" || s.tool == "voice" { return CGRect(x: s.pts[0], y: s.pts[1], width: min(s.wrap ?? 460, Double((s.text ?? "").count) * (s.size > 0 ? s.size : 20) * 0.55 + 10), height: (s.size > 0 ? s.size : 20) * 1.4) }
    var minX = Double.infinity, minY = Double.infinity, maxX = -Double.infinity, maxY = -Double.infinity
    for k in stride(from: 0, to: s.pts.count - 1, by: 2) { minX = min(minX, s.pts[k]); maxX = max(maxX, s.pts[k]); minY = min(minY, s.pts[k + 1]); maxY = max(maxY, s.pts[k + 1]) }
    let pad = s.size / 2
    return CGRect(x: minX - pad, y: minY - pad, width: maxX - minX + 2 * pad, height: maxY - minY + 2 * pad)
  }
  static func hits(_ s: CanvasShape, _ p: CGPoint, tolerance: Double) -> Bool {
    if s.tool != "pen" && s.tool != "hl" { return box(s).insetBy(dx: -tolerance, dy: -tolerance).contains(p) }
    for k in stride(from: 0, to: s.pts.count - 1, by: 2) where hypot(s.pts[k] - p.x, s.pts[k + 1] - p.y) < tolerance + s.size / 2 { return true }
    return false
  }
}

struct ScribbleScreen: View {
  @EnvironmentObject var model: BoardModel
  @Environment(\.colorScheme) private var scheme
  enum Tool: String { case hand, pen, hl, eraser, sticky, select }
  @State private var canvas = CanvasState()
  @State private var loaded = false
  @State private var tick = 0
  @State private var tool: Tool = .pen
  @State private var color = "ink"
  @State private var hlColor = "#ffd43b"
  @State private var size: Double = 4
  @State private var offset = CGPoint(x: 40, y: 80)
  @State private var scale: CGFloat = 1
  @State private var baseScale: CGFloat = 1
  @State private var baseOffset = CGPoint.zero
  @State private var live: [Double] = []
  @State private var pending: [CanvasShape] = []
  @State private var gone = Set<String>()
  @State private var erasing = Set<String>()
  @State private var selection = Set<String>()
  @State private var selRect: CGRect?
  @State private var stickyAt: CGPoint?
  @State private var stickyText = ""
  @State private var sendWords = ""
  @State private var sending = false
  @State private var error: String?
  private var timeline: String { deskCanvas(model.view?.all == true ? model.desk?.desks.first?.id : model.view?.deskId) }
  private var me: String { model.room.map { hex($0.device.id) } ?? "" }

  var body: some View {
    let _ = model.version
    let dark = scheme == .dark
    let shapes = canvas.shapes.values.filter { !gone.contains($0.id) && !erasing.contains($0.id) }.sorted { ($0.z, $0.id) < ($1.z, $1.id) } + pending
    ZStack {
      (dark ? Color(hex: 0x111715) : Color(hex: 0xfffdf6)).ignoresSafeArea()
      boardCanvas(shapes, dark: dark)
        .overlay { pictures(shapes) }
      .gesture(drawGesture)
      .simultaneousGesture(zoomGesture)
      .onTapGesture(coordinateSpace: .local) { p in if tool == .sticky { stickyAt = world(p); stickyText = "" } }
      if !loaded { ProgressView() }
      VStack {
        Spacer()
        if !selection.isEmpty { selectionBar }
        toolbar
      }
      .padding(.bottom, 8)
    }
    .navigationTitle("Scribble Board").navigationBarTitleDisplayMode(.inline)
    .task(id: timeline) { await load() }
    .onChange(of: model.version) { _, _ in takeNew() }
    .alert("A sticky", isPresented: Binding(get: { stickyAt != nil }, set: { if !$0 { stickyAt = nil } })) {
      TextField("Write on it", text: $stickyText)
      Button("Stick it") { if let p = stickyAt { addSticky(at: p) } }
      Button("Cancel", role: .cancel) {}
    }
    .alert("Not sent", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) { Button("OK") {} } message: { Text(error ?? "") }
  }


  private func boardCanvas(_ shapes: [CanvasShape], dark: Bool) -> some View {
      Canvas { ctx, area in
      // the faint ruled paper
      let step = 32 * scale
      if step > 8 {
        var y = offset.y.truncatingRemainder(dividingBy: step)
        while y < area.height { ctx.stroke(Path { $0.move(to: CGPoint(x: 0, y: y)); $0.addLine(to: CGPoint(x: area.width, y: y)) }, with: .color(Color(hex: 0x6a8fb5).opacity(0.12)), lineWidth: 1); y += step }
      }
      for s in shapes { ShapeDraw.draw(s, in: &ctx, offset: offset, scale: scale, dark: dark, selected: selection.contains(s.id)) }
      if live.count >= 2 {
        let s = CanvasShape(id: "live", by: me, tool: tool == .hl ? "hl" : "pen", pts: live, color: tool == .hl ? hlColor : color, size: tool == .hl ? max(size * 4, 10) : size)
        ShapeDraw.draw(s, in: &ctx, offset: offset, scale: scale, dark: dark)
      }
      if let r = selRect { ctx.stroke(Path(r), with: .color(Ink.accent), style: StrokeStyle(lineWidth: 1.5, dash: [6, 4])) }
    }
  }
  private func pictures(_ shapes: [CanvasShape]) -> some View {
        GeometryReader { _ in
      ForEach(shapes.filter { $0.tool == "image" }, id: \.id) { s in
        if let a = s.attachment {
          let b = ShapeDraw.box(s)
          AttachmentImage(ref: a, contentMode: .fit)
            .frame(width: max(1, b.width * scale), height: max(1, b.height * scale))
            .position(x: offset.x + (b.midX) * scale, y: offset.y + (b.midY) * scale)
            .allowsHitTesting(false)
        }
      }
    }
  }
  private func world(_ p: CGPoint) -> CGPoint { CGPoint(x: (p.x - offset.x) / scale, y: (p.y - offset.y) / scale) }

  private var drawGesture: some Gesture {
    DragGesture(minimumDistance: 0)
      .onChanged { v in
        switch tool {
        case .hand:
          if baseOffset == .zero { baseOffset = offset }
          offset = CGPoint(x: baseOffset.x + v.translation.width, y: baseOffset.y + v.translation.height)
        case .pen, .hl:
          let w = world(v.location)
          live += [Double(w.x), Double(w.y)]
        case .eraser:
          let w = world(v.location)
          for s in canvas.shapes.values where s.by == me || model.room?.board.members[me]?.deviceRole == "human" {
            if ShapeDraw.hits(s, w, tolerance: 10 / Double(scale)) { erasing.insert(s.id) }
          }
        case .select:
          selRect = CGRect(x: min(v.startLocation.x, v.location.x), y: min(v.startLocation.y, v.location.y), width: abs(v.location.x - v.startLocation.x), height: abs(v.location.y - v.startLocation.y))
        case .sticky: break
        }
      }
      .onEnded { _ in
        switch tool {
        case .hand: baseOffset = .zero
        case .pen, .hl: finishStroke()
        case .eraser: finishErase()
        case .select:
          if let r = selRect {
            let a = world(r.origin), b = world(CGPoint(x: r.maxX, y: r.maxY))
            let wr = CGRect(x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y)
            selection = Set(canvas.shapes.values.filter { wr.intersects(ShapeDraw.box($0)) }.map { $0.id })
          }
          selRect = nil
        case .sticky: break
        }
      }
  }
  private var zoomGesture: some Gesture {
    MagnificationGesture()
      .onChanged { m in
        let next = max(0.2, min(6, baseScale * m))
        scale = next
      }
      .onEnded { _ in baseScale = scale }
  }

  private var toolbar: some View {
    HStack(spacing: 4) {
      toolButton(.hand, Image(systemName: "hand.raised"))
      toolButton(.pen, Image(systemName: "pencil.tip"))
      toolButton(.hl, Image(systemName: "highlighter"))
      toolButton(.eraser, Image(systemName: "eraser"))
      toolButton(.sticky, Image(systemName: "note.text"))
      toolButton(.select, Image(systemName: "lasso"))
      Divider().frame(height: 24)
      Menu {
        if tool == .hl { ForEach(HL_COLORS, id: \.0) { c in Button(c.1) { hlColor = c.0 } } }
        else { ForEach(PEN_COLORS, id: \.0) { c in Button(c.1) { color = c.0 } } }
        Divider()
        ForEach([2.0, 4, 7, 12], id: \.self) { s in Button("Size \(Int(s))") { size = s } }
      } label: {
        Circle().fill(inkColor(tool == .hl ? hlColor : color, dark: scheme == .dark)).frame(width: 22, height: 22).overlay(Circle().strokeBorder(Ink.lineStrong)).frame(width: 40, height: 40)
      }
    }
    .padding(.horizontal, 8).padding(.vertical, 4)
    .glass(Capsule(), interactive: true)
  }
  private func toolButton(_ t: Tool, _ icon: Image) -> some View {
    Button { tool = t; if t != .select { selection = [] } } label: {
      icon.font(.system(size: 17, weight: .medium)).foregroundStyle(tool == t ? Ink.accentFg : Ink.fg).frame(width: 40, height: 40)
        .background(Circle().fill(tool == t ? Ink.accent : .clear))
    }.buttonStyle(.plain)
  }
  private var selectionBar: some View {
    HStack(spacing: 10) {
      Text("\(selection.count) chosen").font(Face.text(14, .semibold))
      Menu {
        ForEach(model.desk?.agents.filter { !$0.archived && !$0.removed } ?? []) { a in Button(a.name) { send(to: a) } }
      } label: { Label("Send to…", systemImage: "paperplane").font(Face.text(15, .semibold)) }
      .disabled(sending)
      Button(role: .destructive) { erase(selection) ; selection = [] } label: { Image(systemName: "trash") }
      Button { selection = [] } label: { Image(systemName: "xmark") }
    }
    .padding(.horizontal, 14).padding(.vertical, 10)
    .glass(Capsule(), interactive: true)
    .padding(.bottom, 6)
  }

  // ---- reading -------------------------------------------------------------------------------------------

  private func load() async {
    guard let room = model.room else { return }
    loaded = false
    do { canvas = try await room.loadCanvas(timeline) } catch { self.error = model.describe(error) }
    loaded = true
    tick += 1
  }
  /** What came in since (the live stream): through the same reducer; an own stroke replaces its pending copy. */
  private func takeNew() {
    guard let room = model.room, loaded else { return }
    let changed = room.applyCanvasItems(canvas, timelineKeyOf("canvas", timeline))
    if !changed.isEmpty {
      pending.removeAll { p in canvas.shapes.values.contains { $0.by == me && $0.pts.count == p.pts.count && $0.pts.first == p.pts.first } }
      gone.subtract(changed.filter { canvas.shapes[$0] == nil })
      tick += 1
    }
  }

  // ---- writing -------------------------------------------------------------------------------------------

  private func finishStroke() {
    let pts = live
    live = []
    guard pts.count >= 4, let room = model.room else { return }
    let s = CanvasShape(id: "pending-\(UUID().uuidString)", by: me, tool: tool == .hl ? "hl" : "pen", pts: pts, color: tool == .hl ? hlColor : color, size: tool == .hl ? max(size * 4, 10) : size)
    pending.append(s)
    let entry = CanvasState.entryOf(s)
    Task {
      do { try await room.sendCanvas(timeline, .obj(["content_type": "strokes", "strokes": [entry]])) }
      catch { pending.removeAll { $0.id == s.id }; self.error = model.describe(error) }
    }
  }
  private func addSticky(at p: CGPoint) {
    let text = stickyText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, let room = model.room else { return }
    let s = CanvasShape(id: "pending-\(UUID().uuidString)", by: me, tool: "sticky", pts: [Double(p.x), Double(p.y)], color: "ink", size: 17, text: text, wrap: 240)
    pending.append(s)
    Task { do { try await room.sendCanvas(timeline, .obj(["content_type": "strokes", "strokes": [CanvasState.entryOf(s)]])) } catch { pending.removeAll { $0.id == s.id }; self.error = model.describe(error) } }
  }
  private func finishErase() { let ids = erasing; erasing = []; erase(ids) }
  private func erase(_ ids: Set<String>) {
    guard !ids.isEmpty, let room = model.room else { return }
    gone.formUnion(ids)
    Task { try? await room.sendCanvas(timeline, .obj(["content_type": "erase", "stroke_ids": .arr(ids.sorted().map { .str($0) })])) }
  }
  /** The chosen shapes as a picture (and their words) to a session; they leave the board. */
  private func send(to a: Agent) {
    #if canImport(UIKit)
    guard let room = model.room, let sid = model.desk?.sessionKey(of: a.id) else { return }
    let chosen = canvas.shapes.values.filter { selection.contains($0.id) }
    guard !chosen.isEmpty else { return }
    var box = chosen.map(ShapeDraw.box).reduce(CGRect.null) { $0.union($1) }
    box = box.insetBy(dx: -16, dy: -16)
    let dark = false
    let picture = Canvas { ctx, _ in
      ctx.fill(Path(CGRect(origin: .zero, size: box.size)), with: .color(Color(hex: 0xfffdf6)))
      for s in chosen.sorted(by: { $0.z < $1.z }) { ShapeDraw.draw(s, in: &ctx, offset: CGPoint(x: -box.minX, y: -box.minY), scale: 1, dark: dark) }
    }.frame(width: box.width, height: box.height)
    let r = ImageRenderer(content: picture)
    r.scale = 2
    guard let img = r.uiImage, let png = img.pngData() else { return }
    let words = chosen.compactMap { $0.text }.joined(separator: "\n")
    let ids = chosen.map { $0.id }
    sending = true
    Task {
      do {
        let ref = try await room.uploadAttachment(Array(png), fileName: "scribble.png", mediaType: "image/png", width: Int(img.size.width * img.scale), height: Int(img.size.height * img.scale))
        try await room.sendSelection(sessionId: sid, canvas: timeline, text: words, picture: ref, strokeIds: ids)
        gone.formUnion(ids)
        selection = []
        model.say("Sent to \(a.name)", words.isEmpty ? "A scribble" : String(words.prefix(80)))
      } catch { self.error = model.describe(error) }
      sending = false
    }
    #endif
  }
}
