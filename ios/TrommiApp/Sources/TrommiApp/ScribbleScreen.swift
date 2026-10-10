// ScribbleScreen.swift: the Scribble Board (app/web/public/whiteboard.mjs), natively with PencilKit: a PKCanvasView,
// the finger draws on the iPhone, the Apple Pencil on the iPad. The strokes are the protocol's (shared/ink.mjs,
// README "Scribble strokes"), mapped 1:1 both ways: a PKStroke's control points (location quantised to 1/16, timeOffset
// in ms, force / 4.1666667, azimuth, altitude) are a stroke's packed points; its ink (pen, marker) and colour token;
// its width. A finger's force is simulated from its speed (flag bit 1). The vector eraser sends `erase`; choosing an
// area sends it to a session as a picture with its words, and what was sent leaves the board.
//
// Which board: the one of the desk in view (TrommiClient deskBoard, ALL_BOARD; README "Scribble Board"). On "All desks"
// every desk's board stands on it as a small card to open (BoardDesks: a row at the top on the iPhone, a column at the
// left on a wide window); on a desk's board a quiet way back to All desks.
import SwiftUI
import TrommiClient
#if canImport(PencilKit) && canImport(UIKit)
import PencilKit
import UIKit

/** Board units -> canvas points: the board is endless, the canvas a big square around its middle. */
let BOARD_ORIGIN: CGFloat = 20_000
let BOARD_SIZE: CGFloat = 40_000

func paletteColor(_ token: String?, tool: String) -> UIColor {
  UIColor { t in
    let dark = t.userInterfaceStyle == .dark
    let c = UIColor(rgb: Palette.color(token, tool: tool, dark: dark))
    return tool == "marker" ? c.withAlphaComponent(dark ? Palette.MARKER_OPACITY.dark : Palette.MARKER_OPACITY.light) : c
  }
}

enum PKMap {
  /** A stroke shape -> a PKStroke (board units shifted onto the canvas). */
  static func stroke(_ s: CanvasShape) -> PKStroke? {
    guard s.isStroke, let ink = s.ink, ink.count > 0 else { return nil }
    let marker = s.tool == "marker"
    let pkInk = PKInk(marker ? .marker : .pen, color: paletteColor(s.color, tool: s.tool))
    var points = [PKStrokePoint]()
    for i in 0..<ink.count {
      let f = i < ink.f.count ? ink.f[i] : 0.25
      let d = marker ? s.width : s.width * InkWire.thickness(f)
      points.append(PKStrokePoint(location: CGPoint(x: ink.pts[2 * i] + BOARD_ORIGIN, y: ink.pts[2 * i + 1] + BOARD_ORIGIN),
                                  timeOffset: (i < ink.t.count ? ink.t[i] : 0) / 1000,
                                  size: CGSize(width: d, height: d), opacity: 1,
                                  force: CGFloat(f * InkWire.PK_MAX_FORCE),
                                  azimuth: CGFloat(ink.az?[i] ?? 0), altitude: CGFloat(ink.al?[i] ?? .pi / 2)))
    }
    var st = PKStroke(ink: pkInk, path: PKStrokePath(controlPoints: points, creationDate: Date()))
    st.randomSeed = seed(s.id)
    return st
  }
  static func seed(_ id: String) -> UInt32 { var h: UInt32 = 2166136261; for u in id.utf8 { h = (h ^ UInt32(u)) &* 16777619 }; return h }

  /** A PKStroke drawn here -> a stroke shape (the transform baked in, colour back to its token). */
  static func shape(_ st: PKStroke, simulateForce: Bool) -> CanvasShape {
    let marker = st.ink.inkType == .marker
    let tool = marker ? "marker" : "pen"
    var ink = TrommiClient.Ink()
    let pts = Array(st.path)
    let tilt = pts.contains { $0.altitude < .pi / 2 - 0.01 || $0.azimuth != 0 }
    if tilt { ink.az = []; ink.al = [] }
    var prevF: Double? = nil
    for (i, p) in pts.enumerated() {
      let at = p.location.applying(st.transform)
      ink.pts += [Double(at.x - BOARD_ORIGIN), Double(at.y - BOARD_ORIGIN)]
      ink.t.append(Double(p.timeOffset) * 1000)
      if simulateForce {
        let speed: Double = i == 0 ? 0 : {
          let q = pts[i - 1].location.applying(st.transform)
          let dt = max(1, (p.timeOffset - pts[i - 1].timeOffset) * 1000)
          return Double(hypot(at.x - q.x, at.y - q.y)) / dt
        }()
        let f = InkWire.forceFromSpeed(prevF, speed); prevF = f; ink.f.append(f)
      } else {
        ink.f.append(min(1, Double(p.force) / InkWire.PK_MAX_FORCE))
      }
      if tilt { ink.az!.append(Double(p.azimuth)); ink.al!.append(Double(p.altitude)) }
    }
    ink.sim = simulateForce
    // the width: the marker's size; the pen's size over its thickness at that force (the first point stands for all)
    let size = Double(pts.first?.size.width ?? 4) * Double(sqrt(abs(st.transform.a * st.transform.d - st.transform.b * st.transform.c)))
    let width = marker ? size : size / InkWire.thickness(ink.f.first ?? 0.25)
    var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
    st.ink.color.resolvedColor(with: UITraitCollection(userInterfaceStyle: .light)).getRed(&r, green: &g, blue: &b, alpha: &a)
    let token = Palette.nearest(r: Double(r), g: Double(g), b: Double(b), tool: tool)
    return .stroke(ink, tool: tool, color: token, width: max(0.5, min(1000, width.isFinite ? width : 4)))
  }
}

/** The PencilKit canvas: what it shows comes from the board; what is drawn or erased on it goes out. */
struct PadCanvas: UIViewRepresentable {
  @Binding var tool: ScribbleScreen.Tool
  @Binding var penColor: String
  @Binding var markerColor: String
  @Binding var width: Double
  let shapes: [CanvasShape]
  let onDraw: (CanvasShape) -> Void
  let onErase: ([String]) -> Void
  @Binding var view: (offset: CGPoint, zoom: CGFloat)

  func makeCoordinator() -> Coordinator { Coordinator(self) }
  func makeUIView(context: Context) -> PKCanvasView {
    let c = PKCanvasView()
    c.drawingPolicy = .anyInput
    c.backgroundColor = .clear
    c.isOpaque = false
    c.contentSize = CGSize(width: BOARD_SIZE, height: BOARD_SIZE)
    c.minimumZoomScale = 0.2
    c.maximumZoomScale = 6
    c.showsHorizontalScrollIndicator = false
    c.showsVerticalScrollIndicator = false
    c.delegate = context.coordinator
    c.contentOffset = CGPoint(x: BOARD_ORIGIN - 40, y: BOARD_ORIGIN - 80)
    context.coordinator.canvas = c
    return c
  }
  func updateUIView(_ c: PKCanvasView, context: Context) {
    context.coordinator.parent = self
    switch tool {
    case .pen: c.tool = PKInkingTool(.pen, color: paletteColor(penColor, tool: "pen"), width: width)
    case .marker: c.tool = PKInkingTool(.marker, color: paletteColor(markerColor, tool: "marker"), width: max(width * 4, 10))
    case .eraser: c.tool = PKEraserTool(.vector)
    default: break
    }
    c.drawingGestureRecognizer.isEnabled = tool == .pen || tool == .marker || tool == .eraser
    context.coordinator.sync(shapes)
  }

  final class Coordinator: NSObject, PKCanvasViewDelegate {
    var parent: PadCanvas
    weak var canvas: PKCanvasView?
    /** PKStroke seed -> stroke id, for what the board holds. */
    var known: [UInt32: String] = [:]
    var applying = false
    init(_ p: PadCanvas) { parent = p }

    /** The board's strokes into the drawing (only when they changed). */
    func sync(_ shapes: [CanvasShape]) {
      guard let c = canvas else { return }
      let want = shapes.filter { $0.isStroke }
      let ids = Set(want.map { $0.id })
      let have = Set(known.values)
      if ids == have && c.drawing.strokes.count == known.count { return }
      applying = true
      var strokes = [PKStroke]()
      known = [:]
      for s in want.sorted(by: { ($0.z, $0.id) < ($1.z, $1.id) }) {
        if let st = PKMap.stroke(s) { strokes.append(st); known[st.randomSeed] = s.id }
      }
      c.drawing = PKDrawing(strokes: strokes)
      applying = false
    }
    func canvasViewDrawingDidChange(_ c: PKCanvasView) {
      if applying { return }
      let seeds = Set(c.drawing.strokes.map { $0.randomSeed })
      // gone: the eraser took them
      let gone = known.filter { !seeds.contains($0.key) }
      if !gone.isEmpty { for k in gone.keys { known.removeValue(forKey: k) }; parent.onErase(Array(gone.values)) }
      // new: drawn here (a pencil carries force; a finger's is simulated from its speed)
      for st in c.drawing.strokes where known[st.randomSeed] == nil {
        let forces = Set(st.path.map { $0.force })
        let s = PKMap.shape(st, simulateForce: forces.count <= 1)
        known[st.randomSeed] = "pending-\(st.randomSeed)"
        parent.onDraw(s)
      }
    }
    func scrollViewDidScroll(_ s: UIScrollView) { report(s) }
    func scrollViewDidZoom(_ s: UIScrollView) { report(s) }
    func report(_ s: UIScrollView) { DispatchQueue.main.async { self.parent.view = (s.contentOffset, s.zoomScale) } }
  }
}
#endif

struct ScribbleScreen: View {
  @EnvironmentObject var model: BoardModel
  @Environment(\.colorScheme) private var scheme
  enum Tool: String { case view, pen, marker, eraser, sticky, select }
  /** The MVP shows the board only (his decision, 8 October): pan and zoom, no drawing; true brings the tools back. */
  static let draws = false
  @State private var canvas = CanvasState()
  @State private var loaded = false
  /** The room's `boardsReset` this board was loaded at: when it moves on, the board loads again. */
  @State private var loadedAt = 0
  @State private var tool: Tool = ScribbleScreen.draws ? .pen : .view
  @State private var penColor = "ink"
  @State private var markerColor = "yellow"
  @State private var width: Double = 4
  @State private var view: (offset: CGPoint, zoom: CGFloat) = (CGPoint(x: BOARD_ORIGIN - 40, y: BOARD_ORIGIN - 80), 1)
  @State private var pending: [CanvasShape] = []
  @State private var gone = Set<String>()
  @State private var selection = Set<String>()
  @State private var selRect: CGRect?
  @State private var stickyAt: CGPoint?
  @State private var stickyText = ""
  @State private var sending = false
  @State private var error: String?
  @State private var tick = 0
  /** The board of the desk in view: All desks' own, a desk's, the board of 'main' in a room without desks. */
  private var timeline: String { model.view?.board ?? MAIN_BOARD }
  private var me: String { model.room?.deviceIdHex ?? "" }

  var body: some View {
    let _ = model.version
    let _ = tick
    let shapes = canvas.shapes.values.filter { !gone.contains($0.id) }
    ZStack {
      (scheme == .dark ? Color(hex: 0x111715) : Color(hex: 0xfffdf6)).ignoresSafeArea()
      #if canImport(PencilKit) && canImport(UIKit)
      PadCanvas(tool: $tool, penColor: $penColor, markerColor: $markerColor, width: $width, shapes: shapes + pending.filter { $0.isStroke },
                onDraw: { s in draw(s) }, onErase: { ids in erase(Set(ids.filter { !$0.hasPrefix("pending-") })) }, view: $view)
        .ignoresSafeArea(edges: .bottom)
      #endif
      // notes and pictures over the strokes, where they lie on the board
      notesLayer(shapes + pending.filter { !$0.isStroke }).allowsHitTesting(false)
      if tool == .select || tool == .sticky { gestureLayer }
      if !loaded { ProgressView() }
      BoardDesks()
      VStack {
        Spacer()
        if ScribbleScreen.draws {
          if !selection.isEmpty { selectionBar }
          toolbar
        }
      }
    }
    .navigationTitle("Scribble").navigationBarTitleDisplayMode(.inline)
    .task(id: timeline) { await load() }
    .onChange(of: model.version) { _, _ in takeNew() }
    .alert("New Sticky Note", isPresented: Binding(get: { stickyAt != nil }, set: { if !$0 { stickyAt = nil } })) {
      TextField("Write on it", text: $stickyText)
      Button("Add") { if let p = stickyAt { addSticky(at: p) } }
      Button("Cancel", role: .cancel) {}
    }
    .alert("Not sent", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) { Button("OK") {} } message: { Text(error ?? "") }
  }

  /** Screen point <-> board units. */
  private func board(_ p: CGPoint) -> CGPoint { CGPoint(x: (p.x + view.offset.x) / view.zoom - BOARD_ORIGIN, y: (p.y + view.offset.y) / view.zoom - BOARD_ORIGIN) }
  private func screen(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: (CGFloat(x) + BOARD_ORIGIN) * view.zoom - view.offset.x, y: (CGFloat(y) + BOARD_ORIGIN) * view.zoom - view.offset.y) }

  private func notesLayer(_ shapes: [CanvasShape]) -> some View {
    let z = view.zoom
    return ZStack(alignment: .topLeading) {
      ForEach(shapes.filter { !$0.isStroke }, id: \.id) { s in
        let o = screen(s.pts[0], s.pts[1])
        Group {
          if s.tool == "image", let a = s.attachment, s.pts.count >= 4 {
            AttachmentImage(ref: a, contentMode: .fit).frame(width: max(1, CGFloat(s.pts[2] - s.pts[0]) * z), height: max(1, CGFloat(s.pts[3] - s.pts[1]) * z))
          } else if s.tool == "sticky" {
            Text(s.text ?? "").font(Face.text(CGFloat(s.size > 0 ? s.size : 17) * z)).foregroundStyle(Color(hex: scheme == .dark ? 0x231c06 : 0x3b300d))
              .padding(16 * z).frame(width: CGFloat(s.wrap ?? 240) * z, alignment: .topLeading).frame(minHeight: 104 * z, alignment: .topLeading)
              .background(Rectangle().fill(Color(hex: scheme == .dark ? 0xd9c35f : 0xfbe7a1)).rotationEffect(.degrees(-1)))
          } else {
            Text(s.text ?? "").font(Face.text(CGFloat(s.size > 0 ? s.size : 20) * z)).foregroundStyle(Color(UIColor(rgb: Palette.color(s.color, dark: scheme == .dark))))
              .frame(maxWidth: CGFloat(s.wrap ?? 460) * z, alignment: .leading)
          }
        }
        .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(selection.contains(s.id) ? Ink.accent : .clear, lineWidth: 2))
        .offset(x: o.x, y: o.y)
      }
      if let r = selRect { Rectangle().stroke(Ink.accent, style: StrokeStyle(lineWidth: 1.5, dash: [6, 4])).frame(width: r.width, height: r.height).offset(x: r.minX, y: r.minY) }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }

  private var gestureLayer: some View {
    Color.white.opacity(0.001)
      .gesture(DragGesture(minimumDistance: 0)
        .onChanged { v in
          if tool == .select { selRect = CGRect(x: min(v.startLocation.x, v.location.x), y: min(v.startLocation.y, v.location.y), width: abs(v.location.x - v.startLocation.x), height: abs(v.location.y - v.startLocation.y)) }
        }
        .onEnded { v in
          if tool == .sticky { stickyAt = board(v.location); stickyText = ""; return }
          if let r = selRect {
            let a = board(r.origin), b = board(CGPoint(x: r.maxX, y: r.maxY))
            let wr = CGRect(x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y)
            selection = Set(canvas.shapes.values.filter { wr.intersects(box($0)) }.map { $0.id })
          }
          selRect = nil
        })
  }
  private func box(_ s: CanvasShape) -> CGRect { boardBox(s) }

  private var toolbar: some View {
    HStack(spacing: 4) {
      toolButton(.pen, "pencil.tip")
      toolButton(.marker, "highlighter")
      toolButton(.eraser, "eraser")
      toolButton(.sticky, "note.text")
      toolButton(.select, "lasso")
      Divider().frame(height: 24)
      Menu {
        if tool == .marker { ForEach(Palette.MARKER_COLORS, id: \.self) { c in Button(c.capitalized) { markerColor = c } } }
        else { ForEach(Palette.PEN_COLORS, id: \.self) { c in Button(c.capitalized) { penColor = c } } }
        Divider()
        ForEach([2.0, 4, 7, 12], id: \.self) { s in Button("Width \(Int(s))") { width = s } }
      } label: {
        Circle().fill(Color(UIColor(rgb: Palette.color(tool == .marker ? markerColor : penColor, tool: tool == .marker ? "marker" : "pen", dark: scheme == .dark))))
          .frame(width: 22, height: 22).overlay(Circle().strokeBorder(Ink.lineStrong)).frame(width: 44, height: 44)
      }
    }
    .padding(.horizontal, 8).padding(.vertical, 2)
    .glass(Capsule(), interactive: true)
  }
  private func toolButton(_ t: Tool, _ icon: String) -> some View {
    Button { tool = t; if t != .select { selection = [] } } label: {
      Image(systemName: icon).font(.system(size: 17, weight: .medium)).foregroundStyle(tool == t ? Ink.accentFg : Ink.fg).frame(width: 44, height: 44)
        .background(Circle().fill(tool == t ? Ink.accent : .clear))
    }.buttonStyle(.plain)
  }
  private var selectionBar: some View {
    HStack(spacing: 12) {
      Text("\(selection.count) chosen").font(Face.text(14, .semibold))
      Menu {
        ForEach(model.desk?.agents.filter { !$0.archived && !$0.removed } ?? []) { a in Button(a.name) { send(to: a) } }
      } label: { Label("Send to…", systemImage: "paperplane").font(Face.text(15, .semibold)) }
      .disabled(sending)
      Button(role: .destructive) { erase(selection); selection = [] } label: { Image(systemName: "trash") }
      Button { selection = [] } label: { Image(systemName: "xmark") }
    }
    .padding(.horizontal, 14).padding(.vertical, 10)
    .glass(Capsule(), interactive: true)
    .padding(.bottom, 6)
  }

  // ---- reading ---------------------------------------------------------------------------------------------

  private func load() async {
    guard let room = model.room else { return }
    // another board (the desk in view changed): nothing of the one before stays
    let tl = timeline
    loaded = false
    loadedAt = room.boardsReset
    canvas = CanvasState(); pending = []; gone = []; selection = []; selRect = nil
    tick += 1
    do {
      let st = try await room.loadCanvas(tl)
      guard tl == timeline, !Task.isCancelled else { return }
      canvas = st
    } catch { guard tl == timeline, !Task.isCancelled else { return }; self.error = model.describe(error) }
    loaded = true
    tick += 1
  }
  private func takeNew() {
    guard let room = model.room, loaded else { return }
    // (the board was built anew after a Cut: loaded again from its snapshot, by the core)
    if room.boardsReset != loadedAt { Task { await load() }; return }
    let changed = room.applyCanvasItems(canvas, timelineKeyOf("scribble", timeline))
    if !changed.isEmpty {
      // an own stroke came back from the hub: its pending copy goes
      pending.removeAll { p in canvas.shapes.values.contains { $0.by == me && $0.tool == p.tool && $0.pts.count == p.pts.count && $0.pts.first == p.pts.first } }
      tick += 1
    }
  }

  // ---- writing ---------------------------------------------------------------------------------------------

  private func draw(_ s0: CanvasShape) {
    guard let room = model.room else { return }
    var s = s0
    s.id = "pending-\(UUID().uuidString)"; s.by = me
    pending.append(s)
    let entry = CanvasState.entryOf(s)
    Task {
      do { try await room.sendCanvas(timeline, .obj(["content_type": "strokes", "strokes": [entry]])) }
      catch { pending.removeAll { $0.id == s.id }; self.error = model.describe(error); tick += 1 }
    }
  }
  private func addSticky(at p: CGPoint) {
    let text = stickyText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    draw(CanvasShape(id: "", by: me, tool: "sticky", pts: [Double(p.x), Double(p.y)], color: "ink", text: text, size: 17, wrap: 240))
  }
  private func erase(_ ids: Set<String>) {
    guard !ids.isEmpty, let room = model.room else { return }
    gone.formUnion(ids)
    Task { try? await room.sendCanvas(timeline, .obj(["content_type": "erase", "stroke_ids": .arr(ids.sorted().map { .str($0) })])) }
  }
  /** The chosen shapes as a picture (and their words) to a session; they leave the board. */
  private func send(to a: Agent) {
    #if canImport(PencilKit) && canImport(UIKit)
    guard let room = model.room, let sid = model.desk?.sessionKey(of: a.id) else { return }
    let chosen = canvas.shapes.values.filter { selection.contains($0.id) }
    guard !chosen.isEmpty else { return }
    var rect = chosen.map(box).reduce(CGRect.null) { $0.union($1) }.insetBy(dx: -16, dy: -16)
    rect = rect.offsetBy(dx: BOARD_ORIGIN, dy: BOARD_ORIGIN)
    let drawing = PKDrawing(strokes: chosen.compactMap(PKMap.stroke))
    var img = UIImage()
    UITraitCollection(userInterfaceStyle: .light).performAsCurrent { img = drawing.image(from: rect, scale: 2) }
    let r = UIGraphicsImageRenderer(size: rect.size)
    let flat = r.image { ctx in
      UIColor(rgb: 0xfffdf6).setFill(); ctx.fill(CGRect(origin: .zero, size: rect.size))
      img.draw(in: CGRect(origin: .zero, size: rect.size))
    }
    guard let png = flat.pngData() else { return }
    let words = chosen.compactMap { $0.text }.joined(separator: "\n")
    let ids = chosen.map { $0.id }
    sending = true
    Task {
      do {
        let ref = try await room.uploadAttachment(Array(png), fileName: "scribble.png", mediaType: "image/png", width: Int(rect.width * 2), height: Int(rect.height * 2))
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

/** A shape's box in board units (a note's height is a guess: its words are laid out by the view). */
func boardBox(_ s: CanvasShape) -> CGRect {
  if s.tool == "image" && s.pts.count >= 4 { return CGRect(x: s.pts[0], y: s.pts[1], width: s.pts[2] - s.pts[0], height: s.pts[3] - s.pts[1]) }
  if !s.isStroke { return CGRect(x: s.pts[0], y: s.pts[1], width: s.wrap ?? 240, height: 120) }
  var minX = Double.infinity, minY = Double.infinity, maxX = -Double.infinity, maxY = -Double.infinity
  for k in stride(from: 0, to: s.pts.count - 1, by: 2) { minX = min(minX, s.pts[k]); maxX = max(maxX, s.pts[k]); minY = min(minY, s.pts[k + 1]); maxY = max(maxY, s.pts[k + 1]) }
  return CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY).insetBy(dx: -s.width / 2, dy: -s.width / 2)
}

/**
 * The boards beside the one in view (app/web/public/whiteboard.mjs whiteboardDesks). On "All desks": a card per desk
 * (its board small, its name, how much is on it), a tap opens that desk's board by bringing the desk into view. On a
 * desk: the quiet way back to All desks. A room with one desk or none has one board and nothing here.
 */
struct BoardDesks: View {
  @EnvironmentObject var model: BoardModel
  @Environment(\.horizontalSizeClass) private var hSize
  /** The desks' boards, by desk id: opened like the pad's own (snapshot + tail), then fed by what the room brings. */
  @State private var boards: [String: CanvasState] = [:]
  @State private var tick = 0
  @State private var loadedAt = 0

  var body: some View {
    let _ = tick
    let desks = model.desk?.desks ?? []
    if desks.count > 1, let v = model.view {
      Group {
        if v.all { cards(desks) } else { back(v.deskName) }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
  }

  private func cards(_ desks: [DeskDesc]) -> some View {
    let wide = hSize == .regular
    let list = ForEach(Array(desks.enumerated()), id: \.element.id) { i, d in
      BoardCard(name: d.name, shapes: boards[d.id].map { Array($0.shapes.values) }, turn: i % 3 == 2 ? -0.4 : i % 2 == 1 ? 1 : -1.2) { model.deskId = d.id }
        .frame(width: wide ? 148 : 112)
    }
    return Group {
      if wide { ScrollView(.vertical, showsIndicators: false) { VStack(spacing: 14) { list }.padding(.init(top: 6, leading: 14, bottom: 10, trailing: 8)) }.frame(width: 172).padding(.bottom, 120) }
      else { ScrollView(.horizontal, showsIndicators: false) { HStack(alignment: .top, spacing: 10) { list }.padding(.init(top: 8, leading: 14, bottom: 10, trailing: 14)) } }
    }
    .accessibilityElement(children: .contain).accessibilityLabel("The desks' Scribble Boards")
    .task(id: desks.map { $0.id }.joined(separator: ",")) { await load(desks) }
    .onChange(of: model.version) { _, _ in takeNew() }
  }

  private func back(_ name: String) -> some View {
    HStack(spacing: 10) {
      Button { model.deskId = ALL_DESKS } label: {
        HStack(spacing: 4) { Sketch("back", color: Ink.muted).frame(width: 18, height: 18); Text("All desks").font(Face.text(13, .medium)) }
          .foregroundStyle(Ink.muted).padding(.leading, 6).padding(.trailing, 10).frame(minHeight: 32)
          .background(Capsule().fill(Ink.surface.opacity(0.82)))
          .frame(minHeight: 44).contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("All desks").accessibilityHint("Its Scribble Board and every desk's")
      HStack(spacing: 4) { Sketch("desk", color: Ink.muted).frame(width: 18, height: 18); Text(name).font(Face.text(13, .semibold)).lineLimit(1) }
        .foregroundStyle(Ink.muted).accessibilityElement(children: .combine).accessibilityLabel("Scribble Board of \(name)")
    }
    .padding(.leading, 12).padding(.top, 2)
  }

  private func load(_ desks: [DeskDesc]) async {
    guard let room = model.room else { return }
    if boards.isEmpty { loadedAt = room.boardsReset }
    boards = boards.filter { b in desks.contains { $0.id == b.key } }
    for d in desks where boards[d.id] == nil {
      guard let st = try? await room.loadCanvas(deskBoard(d.id)), !Task.isCancelled else { continue }
      boards[d.id] = st
      tick += 1
    }
  }
  private func takeNew() {
    guard let room = model.room else { return }
    // (the boards were built anew after a Cut: each loads again, by the core)
    if room.boardsReset != loadedAt { loadedAt = room.boardsReset; boards = [:]; Task { await load(model.desk?.desks ?? []) }; return }
    var changed = false
    for (id, st) in boards where !room.applyCanvasItems(st, timelineKeyOf("scribble", deskBoard(id))).isEmpty { changed = true }
    if changed { tick += 1 }
  }
}

/** One desk's board as a small hand-drawn card: the board small, the desk's name, how many elements are on it. */
struct BoardCard: View {
  let name: String
  /** What is on the board; nil while it is being read. */
  let shapes: [CanvasShape]?
  var turn: Double = -1.2
  let open: () -> Void
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    Button(action: open) {
      VStack(alignment: .leading, spacing: 5) {
        BoardThumb(shapes: shapes ?? [], dark: scheme == .dark)
          .aspectRatio(264.0 / 156.0, contentMode: .fit)
          .background(scheme == .dark ? Color(hex: 0x111715) : Color(hex: 0xfffdf6))
          .clipShape(PenBox(r: 6)).overlay(PenBox(r: 6).stroke(Ink.line, lineWidth: 1))
        HStack(spacing: 5) {
          Sketch("desk").frame(width: 16, height: 16)
          Text(name).font(Face.text(13, .semibold)).foregroundStyle(Ink.fg).lineLimit(1).truncationMode(.tail)
          Spacer(minLength: 0)
          Text(count).font(Face.text(11, .medium)).monospacedDigit().foregroundStyle(Ink.muted).fixedSize()
        }
        .padding(.horizontal, 3)
      }
      .padding(.init(top: 5, leading: 5, bottom: 6, trailing: 5))
      .background(PenBox(r: 10).fill(Ink.surface))
      .background(PenBox(r: 10).fill(Ink.fg.opacity(0.14)).offset(x: 2, y: 3))
      .overlay(PenBox(r: 10).stroke(Ink.fg.opacity(0.78), lineWidth: 1.6))
      .rotationEffect(.degrees(turn))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(name): open its Scribble Board")
    .accessibilityValue(shapes.map { $0.isEmpty ? "empty" : "\($0.count) element\($0.count == 1 ? "" : "s")" } ?? "")
    .accessibilityAddTraits(.isButton)
  }
  private var count: String { shapes.map { $0.isEmpty ? "empty" : String($0.count) } ?? "" }
}

/** A board small: everything on it fitted into the card's window (strokes as lines, notes and pictures as slips). */
struct BoardThumb: View {
  let shapes: [CanvasShape]
  let dark: Bool
  var body: some View {
    Canvas { ctx, size in
      let all = shapes.map(boardBox).filter { !$0.isNull && $0.minX.isFinite && $0.minY.isFinite && $0.width.isFinite && $0.height.isFinite }.reduce(CGRect.null) { $0.union($1) }
      guard !all.isNull else { return }
      let pad: CGFloat = 7
      let k = min((size.width - 2 * pad) / max(all.width, 1), (size.height - 2 * pad) / max(all.height, 1), 1)
      let ox = (size.width - all.width * k) / 2 - all.minX * k, oy = (size.height - all.height * k) / 2 - all.minY * k
      func at(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: CGFloat(x) * k + ox, y: CGFloat(y) * k + oy) }
      func slip(_ s: CanvasShape) -> CGRect { let b = boardBox(s); return CGRect(x: b.minX * k + ox, y: b.minY * k + oy, width: max(2, b.width * k), height: max(2, b.height * k)) }
      for s in shapes.sorted(by: { ($0.z, $0.id) < ($1.z, $1.id) }) {
        if s.isStroke {
          guard s.pts.count >= 2 else { continue }
          var p = Path()
          p.move(to: at(s.pts[0], s.pts[1]))
          for i in stride(from: 2, to: s.pts.count - 1, by: 2) { p.addLine(to: at(s.pts[i], s.pts[i + 1])) }
          if s.pts.count == 2 { p.addLine(to: at(s.pts[0], s.pts[1])) }
          let marker = s.tool == "marker"
          let c = Color(hex: Palette.color(s.color, tool: s.tool, dark: dark), alpha: marker ? (dark ? Palette.MARKER_OPACITY.dark : Palette.MARKER_OPACITY.light) : 1)
          ctx.stroke(p, with: .color(c), style: StrokeStyle(lineWidth: max(0.9, CGFloat(s.width) * k), lineCap: .round, lineJoin: .round))
        } else if s.tool == "sticky" {
          ctx.fill(Path(slip(s)), with: .color(Color(hex: dark ? 0xd9c35f : 0xfbe7a1)))
        } else if s.tool == "image" {
          let r = slip(s)
          ctx.fill(Path(r), with: .color(Ink.sunken)); ctx.stroke(Path(r), with: .color(Ink.lineStrong), lineWidth: 0.8)
        } else {
          // words: a line of them, as long as they are (to their wrap at most)
          let w = min(CGFloat(s.wrap ?? 460), CGFloat((s.text ?? "").count) * CGFloat(s.size) * 0.5), h = CGFloat(s.size)
          let o = at(s.pts[0], s.pts[1])
          ctx.fill(Path(roundedRect: CGRect(x: o.x, y: o.y, width: max(3, w * k), height: max(1.2, h * k * 0.5)), cornerRadius: 1), with: .color(Color(hex: Palette.color(s.color, dark: dark), alpha: 0.55)))
        }
      }
    }
    .accessibilityHidden(true)
  }
}
