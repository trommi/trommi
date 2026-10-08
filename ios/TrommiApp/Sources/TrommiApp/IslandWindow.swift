// IslandWindow.swift: the undo pill at the Dynamic Island, in a window of its own above the app (window level alert +
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

  /** Show (or update) the pill for this undo toast. Returns false when this device has no island. */
  @discardableResult func show(_ t: Toast, count: Int, model: BoardModel) -> Bool {
    guard t.undo != nil, let (p, scene) = geometry() else { return false }
    let view = AnyView(IslandPillView(toast: t, count: count, pill: p, close: { [weak self] in self?.hide(t.id) }).environmentObject(model))
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
    window?.frame = p.pill
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

/** The pill itself: black, laid over the island, growing sideways out of it; the count left, the arrow in its 5 s
 *  ring right; a tap undoes, a swipe up lets it go; VoiceOver reads it out. */
struct IslandPillView: View {
  @EnvironmentObject var model: BoardModel
  let toast: Toast
  let count: Int
  let pill: IslandPill
  let close: () -> Void
  @State private var grown = false
  @State private var progress: CGFloat = 1
  var body: some View {
    Button {
      let undo = toast.undo
      model.toast = nil
      close()
      if let u = undo { Task { await u() } }
    } label: {
      ZStack {
        Capsule().fill(.black)
        HStack(spacing: 0) {
          Group { if count > 1 { Text("\(count)").font(.system(size: 14, weight: .bold, design: .rounded)).foregroundStyle(.white) } }
            .frame(width: pill.leftWing.width)
          Spacer(minLength: 0)
          ZStack {
            Circle().stroke(Color.white.opacity(0.25), lineWidth: 2.2)
            Circle().trim(from: 0, to: progress).stroke(Color.white, style: StrokeStyle(lineWidth: 2.2, lineCap: .round)).rotationEffect(.degrees(-90))
            Image(systemName: "arrow.uturn.backward").font(.system(size: 10, weight: .bold)).foregroundStyle(.white)
          }
          .frame(width: 22, height: 22).frame(width: pill.rightWing.width)
          .opacity(grown ? 1 : 0)
        }
      }
      .frame(width: pill.pill.width, height: pill.pill.height)
      .scaleEffect(x: grown ? 1 : IslandPill.islandSize.width / pill.pill.width, y: 1)
      .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .gesture(DragGesture(minimumDistance: 6).onEnded { v in if v.translation.height < -12 { model.toast = nil; close() } })
    .accessibilityLabel(count > 1 ? "Undo: \(toast.head), \(count) actions" : "Undo: \(toast.head)")
    .onAppear {
      withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) { grown = true }
      progress = 1
      withAnimation(.linear(duration: ToastHost.undoSeconds)) { progress = 0 }
    }
    .onChange(of: toast.id) { _, _ in
      progress = 1
      withAnimation(.linear(duration: ToastHost.undoSeconds)) { progress = 0 }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .ignoresSafeArea()
  }
}
#endif
