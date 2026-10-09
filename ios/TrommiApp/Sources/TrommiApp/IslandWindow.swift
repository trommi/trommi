// IslandWindow.swift: the app's passing words (an answer with its Undo, a failure, a note) at the Dynamic Island: ONE
// place, no second toast (his word, 9 October). The pill in a window of its own above the app (window level alert +
// 1), framed exactly to the pill in screen coordinates: sheets and panels never cover it, it takes no touch outside
// itself. Its frame comes from the scene: the screen's width and the app window's safe area top (IslandPill); a
// phone without an island (safe area top below 51 pt) gets none and the toast host shows its glass pill instead.
import SwiftUI
import TrommiClient
#if canImport(UIKit)
import UIKit

final class IslandUIWindow: UIWindow {}

@MainActor final class IslandWindow {
  static let shared = IslandWindow()
  private var window: IslandUIWindow?
  private var host: UIHostingController<AnyView>?
  private var shownId: UUID?

  /** The island's pill on this device now, or nil (no island, no active scene). */
  func geometry() -> (pill: IslandPill, scene: UIWindowScene)? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    guard let scene = scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first,
          let main = scene.windows.first(where: { !($0 is IslandUIWindow) && !$0.isHidden }) else { return nil }
    guard let p = IslandPill.of(width: scene.screen.bounds.width, safeTop: main.safeAreaInsets.top) else { return nil }
    return (p, scene)
  }

  /** The grown island: from the island's top and centre, wider and one line taller (the words stand under the island). */
  static func grown(_ p: IslandPill, screen: CGFloat) -> CGRect {
    let w = min(screen - 24, 370)
    return CGRect(x: ((screen - w) / 2).rounded(), y: p.island.minY, width: w, height: p.island.height + 44)
  }

  /** Show (or update) the pill for this toast: every passing word of the app is said here, an undo with its arrow.
   *  Returns false when this device has no island. */
  @discardableResult func show(_ t: Toast, count: Int, model: BoardModel) -> Bool {
    guard let (p, scene) = geometry() else { return false }
    let frame = Self.grown(p, screen: scene.screen.bounds.width)
    let view = AnyView(IslandPillView(toast: t, count: count, pill: p, size: frame.size, close: { [weak self] in self?.hide(t.id) }).environmentObject(model))
    if let h = host, let w = window, w.windowScene === scene {
      h.rootView = view
    } else {
      let w = IslandUIWindow(windowScene: scene)
      w.windowLevel = .alert + 1
      w.backgroundColor = .clear
      let h = UIHostingController(rootView: view)
      h.view.backgroundColor = .clear
      // the window lies in the status bar's area: its safe area would push the pill down below the island (build 18:
      // a black capsule over the header). Screen coordinates, no safe area: the pill's top is the island's top.
      h.safeAreaRegions = []
      w.rootViewController = h
      window = w; host = h
    }
    window?.frame = frame
    window?.isHidden = false
    shownId = t.id
    return true
  }
  func hide(_ id: UUID? = nil) {
    if let id = id, id != shownId { return }
    window?.isHidden = true
    shownId = nil
  }
}

/** The pill itself: black, laid over the island and growing out of it, sideways and one line down. Under the island
 *  the words (an answer short: "→ <what he chose>"), at the right the undo arrow in its 5 s ring, the count of undos
 *  beside the island; a tap undoes (or lets a plain word go), a swipe up lets it go; VoiceOver reads it out. */
struct IslandPillView: View {
  @EnvironmentObject var model: BoardModel
  let toast: Toast
  let count: Int
  let pill: IslandPill
  let size: CGSize
  let close: () -> Void
  @State private var grown = false
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
    let w = Self.words(toast)
    let island = IslandPill.islandSize
    Button {
      let undo = toast.undo
      model.toast = nil
      close()
      if let u = undo { Task { await u() } }
    } label: {
      ZStack(alignment: .top) {
        RoundedRectangle(cornerRadius: grown ? 26 : island.height / 2, style: .continuous).fill(.black)
          .frame(width: grown ? size.width : island.width, height: grown ? size.height : island.height)
        VStack(spacing: 0) {
          // beside the island: how many undos are held
          HStack {
            Group { if count > 1 { Text("\(count)").font(.system(size: 14, weight: .bold, design: .rounded)).foregroundStyle(.white) } }
              .frame(width: max(0, (size.width - island.width) / 2))
            Spacer(minLength: 0)
          }
          .frame(height: island.height)
          HStack(spacing: 10) {
            if toast.alert { Image(systemName: "exclamationmark.circle.fill").font(.system(size: 15)).foregroundStyle(Color(hex: 0xff6b5e)) }
            (Text(w.head).font(Face.text(15, .semibold)).foregroundColor(toast.alert ? Color(hex: 0xff8a7f) : .white)
              + Text(w.line.isEmpty ? "" : "  \(w.line)").font(Face.text(14)).foregroundColor(.white.opacity(0.7)))
              .lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 0)
            if toast.undo != nil {
              ZStack {
                Circle().stroke(Color.white.opacity(0.25), lineWidth: 2.2)
                Circle().trim(from: 0, to: progress).stroke(Color.white, style: StrokeStyle(lineWidth: 2.2, lineCap: .round)).rotationEffect(.degrees(-90))
                Image(systemName: "arrow.uturn.backward").font(.system(size: 11, weight: .bold)).foregroundStyle(.white)
              }
              .frame(width: 26, height: 26)
            }
          }
          .padding(.leading, 18).padding(.trailing, 12)
          .frame(height: size.height - island.height - 6)
        }
        .frame(width: size.width, height: size.height, alignment: .top)
        .opacity(grown ? 1 : 0)
      }
      .frame(width: size.width, height: size.height, alignment: .top)
      .contentShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
    }
    .buttonStyle(.plain)
    .gesture(DragGesture(minimumDistance: 6).onEnded { v in if v.translation.height < -12 { model.toast = nil; close() } })
    .accessibilityLabel(toast.undo != nil ? (count > 1 ? "Undo: \(toast.head), \(count) actions" : "Undo: \(toast.head)") : [toast.head, toast.line].filter { !$0.isEmpty }.joined(separator: ". "))
    .onAppear {
      withAnimation(.spring(response: 0.38, dampingFraction: 0.82)) { grown = true }
      progress = 1
      withAnimation(.linear(duration: ToastHost.undoSeconds)) { progress = 0 }
    }
    .onChange(of: toast.id) { _, _ in
      progress = 1
      withAnimation(.linear(duration: ToastHost.undoSeconds)) { progress = 0 }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .ignoresSafeArea()
  }
}
#endif
