// IslandWindow.swift: the app's passing words (an answer with its Undo, a failure, a note) at the Dynamic Island: ONE
// place, no second toast (his word, 9 October). It imitates the system's expanded island: a black shape that starts as
// the island's own capsule and springs open to 11 pt from the screen's edges, corners concentric with the display, one
// row of content under the sensor row; it falls back into the island when the word goes. While it is open the status
// bar is hidden (BoardShell reads `covering`), so no clock or battery stands inside the black.
// The shape lives in a window of its own above the app (window level alert + 1), framed exactly to the grown shape in
// screen coordinates: sheets and panels never cover it, it takes no touch outside itself, and being smaller than the
// screen it does not take the status bar's appearance from the app. A phone without an island (safe area top below
// 51 pt) gets none and the toast host shows its glass capsule instead.
import SwiftUI
import TrommiClient
#if canImport(UIKit)
import UIKit

final class IslandUIWindow: UIWindow {}

/** What the shape shows now; `open` is the grown state (false: the island's own capsule). */
@MainActor final class IslandState: ObservableObject {
  @Published var toast: Toast?
  @Published var count = 1
  @Published var open = false
}

@MainActor final class IslandWindow: ObservableObject {
  static let shared = IslandWindow()
  /** The shape is open over the status bar's place: the app hides its status bar meanwhile. */
  @Published private(set) var covering = false
  private let state = IslandState()
  private var window: IslandUIWindow?
  /** How long the fall back into the island takes before the window goes. */
  private static let fall: Double = 0.42

  /** The island's shapes on this device now, or nil (no island, no active scene). */
  func geometry() -> (pill: IslandPill, scene: UIWindowScene)? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    guard let scene = scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first,
          let main = scene.windows.first(where: { !($0 is IslandUIWindow) && !$0.isHidden }) else { return nil }
    guard let p = IslandPill.of(width: scene.screen.bounds.width, safeTop: main.safeAreaInsets.top) else { return nil }
    return (p, scene)
  }

  /** Show this toast in the shape: it grows out of the island, or, when it is open already, the new word takes the
   *  old one's place inside the same shape. Returns false when this device has no island. */
  @discardableResult func show(_ t: Toast, count: Int, model: BoardModel) -> Bool {
    guard let (p, scene) = geometry() else { return false }
    if window == nil || window?.windowScene !== scene {
      let w = IslandUIWindow(windowScene: scene)
      w.windowLevel = .alert + 1
      w.backgroundColor = .clear
      let h = UIHostingController(rootView: AnyView(IslandShape(state: state, pill: p, close: { [weak self] in self?.hide() }).environmentObject(model)))
      h.view.backgroundColor = .clear
      // the window lies in the status bar's area: its safe area would push the shape down below the island (build 18:
      // a black capsule over the header). Screen coordinates, no safe area: the shape's top is its own top.
      h.safeAreaRegions = []
      w.rootViewController = h
      window = w
    }
    window?.frame = p.grown
    state.toast = t
    state.count = count
    let fresh = window?.isHidden ?? true
    window?.isHidden = false
    // (a fresh window draws the island's capsule first, then grows: one turn of the run loop between the two)
    if fresh { DispatchQueue.main.async { [weak self] in self?.open() } } else { open() }
    return true
  }
  private func open() {
    guard state.toast != nil else { return }
    withAnimation(.spring(response: 0.42, dampingFraction: 0.78)) { state.open = true; covering = true }
  }
  /** The word goes: the shape falls back into the island, then the window goes. A toast shown meanwhile keeps it. */
  func hide(_ id: UUID? = nil) {
    if let id = id, id != state.toast?.id { return }
    guard let gone = state.toast?.id else { return }
    withAnimation(.spring(response: 0.36, dampingFraction: 0.9)) { state.open = false; covering = false }
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.fall) { [weak self] in
      guard let self = self, self.state.toast?.id == gone, !self.state.open else { return }
      self.window?.isHidden = true
      self.state.toast = nil
    }
  }
}

/** The shape itself: black, the island's capsule that springs open to the grown shape and back. In the row under the
 *  sensors the words at the left (an answer short: "→ <what he chose>"), at the right the round undo button in its
 *  5 s ring (the count of undos held beside it); nothing stands in the sensor row. A tap undoes (or lets a plain word
 *  go), a swipe up lets it go; VoiceOver reads it out. */
struct IslandShape: View {
  @EnvironmentObject var model: BoardModel
  @ObservedObject var state: IslandState
  let pill: IslandPill
  let close: () -> Void
  @State private var progress: CGFloat = 1
  /** The words: an undo says what was done, short (the part after the arrow of "title → choice"); else head and line. */
  static func words(_ t: Toast) -> (head: String, line: String) {
    if t.undo != nil {
      if let r = t.line.range(of: "→") { return ("→ " + t.line[r.upperBound...].trimmingCharacters(in: .whitespaces), "") }
      return (t.head, "")
    }
    return (t.head, t.line)
  }
  var body: some View {
    let open = state.open
    let size = pill.grown.size
    let island = pill.island
    // the island's capsule in this window's coordinates (the window is the grown shape's frame)
    let w = open ? size.width : island.width, h = open ? size.height : island.height
    let y = open ? 0 : island.minY - pill.grown.minY
    ZStack(alignment: .top) {
      RoundedRectangle(cornerRadius: open ? IslandPill.grownRadius : island.height / 2, style: .continuous).fill(.black)
        .frame(width: w, height: h)
        .offset(y: y)
      if let t = state.toast {
        row(t)
          .frame(width: size.width, height: pill.content.height)
          .offset(y: pill.content.minY)
          .opacity(open ? 1 : 0)
          .scaleEffect(open ? 1 : 0.7, anchor: .top)
          .id(t.id)
          .transition(.opacity)
      }
    }
    .frame(width: size.width, height: size.height, alignment: .top)
    .contentShape(RoundedRectangle(cornerRadius: IslandPill.grownRadius, style: .continuous))
    .onTapGesture { act() }
    .gesture(DragGesture(minimumDistance: 6).onEnded { v in if v.translation.height < -12 { model.toast = nil; close() } })
    .accessibilityElement(children: .ignore)
    .accessibilityAddTraits(.isButton)
    .accessibilityLabel(label)
    .onChange(of: state.toast?.id, initial: true) { _, id in
      guard id != nil else { return }
      progress = 1
      withAnimation(.linear(duration: ToastHost.undoSeconds)) { progress = 0 }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .ignoresSafeArea()
  }
  private var label: String {
    guard let t = state.toast else { return "" }
    if t.undo != nil { return state.count > 1 ? "Undo: \(t.head), \(state.count) actions" : "Undo: \(t.head)" }
    return [t.head, t.line].filter { !$0.isEmpty }.joined(separator: ". ")
  }
  private func act() {
    let undo = state.toast?.undo
    model.toast = nil
    close()
    if let u = undo { Task { await u() } }
  }
  /** The row under the sensors: the words at the left, the round undo button at the right, centred in the row. */
  private func row(_ t: Toast) -> some View {
    let w = Self.words(t)
    return HStack(spacing: 10) {
      if t.alert { Image(systemName: "exclamationmark.circle.fill").font(.system(size: 16)).foregroundStyle(Color(hex: 0xff6b5e)) }
      (Text(w.head).font(Face.text(16, .semibold)).foregroundColor(t.alert ? Color(hex: 0xff8a7f) : .white)
        + Text(w.line.isEmpty ? "" : "  \(w.line)").font(Face.text(15)).foregroundColor(.white.opacity(0.65)))
        .lineLimit(1).truncationMode(.tail)
      Spacer(minLength: 0)
      if t.undo != nil {
        if state.count > 1 { Text("\(state.count)").font(.system(size: 15, weight: .semibold, design: .rounded)).foregroundStyle(.white.opacity(0.7)) }
        ZStack {
          Circle().fill(Color.white.opacity(0.16))
          Circle().trim(from: 0, to: progress).stroke(Color.white, style: StrokeStyle(lineWidth: 2, lineCap: .round)).rotationEffect(.degrees(-90)).padding(1)
          Image(systemName: "arrow.uturn.backward").font(.system(size: 13, weight: .bold)).foregroundStyle(.white)
        }
        .frame(width: 32, height: 32)
      }
    }
    // (the shape's corners are 44 pt round: the words start and the button ends clear of them)
    .padding(.leading, 26).padding(.trailing, 18)
    // the row's own middle lies a little high in the round foot of the shape: 3 pt up reads as centred
    .padding(.bottom, 6)
  }
}
#endif
