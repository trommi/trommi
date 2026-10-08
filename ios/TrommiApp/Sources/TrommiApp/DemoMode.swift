// DemoMode.swift: the demo as on the web (app/web/public/demo/demo.mjs): "Demo" on the sign-in screen and in Settings
// opens the web demo's made-up room on this phone (Resources/Demo/fixture.json, the times moved to now; its pictures and
// pages in Resources/Demo/files); nothing is sent, nothing kept. The yellow tag "Demo · All Screens · Leave" stays in
// the corner; All Screens lists every state of dev/interop/fixtures/screens.json (Resources/Demo/screens.json) and opens
// one, the same path the launch hook TROMMI_SCREEN=<id> takes. Refresh the copies after the web's demo changed:
//   cp app/web/public/demo/fixture.json dev/interop/fixtures/screens.json ios/TrommiApp/Sources/TrommiApp/Resources/Demo/
//   cp app/web/public/demo/files/* ios/TrommiApp/Sources/TrommiApp/Resources/Demo/files/
import SwiftUI
import TrommiClient
import TrommiCore

/** One state of the web demo (screens.json "states"). */
struct DemoScreen: Identifiable, Hashable {
  let id: String
  let screen: String
  let state: String
  let path: String
  let webState: String?
  let mock: String
}

enum DemoData {
  static func url(_ name: String) -> URL {
    Bundle.module.url(forResource: "Demo/\(name)", withExtension: nil) ?? (Bundle.module.resourceURL ?? Bundle.main.bundleURL).appendingPathComponent("Demo/\(name)")
  }
  static let screens: [DemoScreen] = {
    guard let d = try? Data(contentsOf: url("screens.json")), let j = JV.parse(Array(d)) else { return [] }
    return (j["states"].array ?? []).compactMap { s in
      guard let id = s["id"].string else { return nil }
      return DemoScreen(id: id, screen: s["screen"].string ?? "", state: s["state"].string ?? "", path: s["web"]["path"].string ?? "/", webState: s["web"]["state"].string, mock: s["web"]["mock"].string ?? "1")
    }
  }()
  /** A file the demo's cards and pages name (`url: /demo/files/<name>`). */
  static func file(_ ref: JV) throws -> Data {
    guard let name = ref["url"].string?.split(separator: "/").last.map(String.init), !name.isEmpty, !name.contains("..") else { throw ZError("not-found", "no such demo file") }
    return try Data(contentsOf: url("files/\(name)"))
  }
}

extension BoardModel {
  /** Open one state of the web demo (screens.json): its page as a route, and the moment its click makes where the app has one. */
  func openDemoScreen(_ id: String) {
    guard let s = DemoData.screens.first(where: { $0.id == id }) else { say("Demo", "No screen “\(id)”."); return }
    if !demo { startDemo() }
    deskPath = []; chatPath = []; selected = []; tab = .desk; toast = nil; deskId = nil; demoScreens = false
    let parts = s.path.split(separator: "?", maxSplits: 1).map(String.init)
    let segs = parts[0].split(separator: "/").map(String.init)
    let query = parts.count > 1 ? parts[1] : ""
    if query.hasPrefix("desk=") { deskId = String(query.dropFirst(5)) }
    func card(_ n: String) -> String? { Int(n).flatMap { n in desk?.cards.first { $0.number == n }?.id } }
    switch segs.first ?? "" {
    case "card":
      if let id = segs.count > 1 ? card(segs[1]) : nil {
        if segs.count > 3, segs[2] == "picture" { path = [.card(id), .picture(id, max(0, (Int(segs[3]) ?? 1) - 1))] } else { path = [.card(id)] }
      }
    case "s": if segs.count > 1 { path = [.session(segs[1])] }
    case "blitz": path = [.blitz]
    case "settings": path = [.settings(segs.count > 1 && segs[1] != "agents" ? segs[1] : "sessions")]
    case "assets": path = [.media]
    case "pages": path = [.pages]
    case "stacks": path = [.off]
    case "scribble-board": path = [.scribble]
    case "logout": path = [.settings("account")]
    default: break
    }
    // the moment demo.mjs clicks once the page is ready (demoState), where the app has the same
    let v = view
    switch s.webState {
    case "select": selected = Set((v?.fresh ?? []).prefix(2).map { $0.id })
    case "toast": if let c = v?.fresh.first { say("Answered", c.title, undo: {}) }
    case "menu", "drawer", "rail", "switch": break
    case "note": tab = .note
    case "pair", "invite", "invite-emoji", "invite-ended": if path.isEmpty { path = [.settings("")] }
    default: break
    }
  }
}

/** The yellow tag in the corner while the demo runs (the web's demo band): Demo · All Screens · Leave. */
struct DemoTag: View {
  @EnvironmentObject var model: BoardModel
  var body: some View {
    HStack(spacing: 5) {
      Text("Demo ·")
      Button("All Screens") { model.demoScreens = true }.underline()
      Text("·")
      Button("Leave") { model.leaveDemo() }.underline()
    }
    .buttonStyle(.plain)
    .font(Face.text(13, .bold)).foregroundStyle(Color(hex: 0x2d2406))
    .padding(.horizontal, 12).padding(.vertical, 6)
    .background(RoundedRectangle(cornerRadius: 11, style: .continuous).fill(Ink.yellow))
    .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous).strokeBorder(Color(hex: 0x2d2406), lineWidth: 1.6))
    .rotationEffect(.degrees(-1))
    .padding(.leading, 16).padding(.bottom, 70)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Demo")
  }
}

/** Every screen of the demo, as the web's /screens lists them: grouped by page, a tap opens it. */
struct AllScreensSheet: View {
  @EnvironmentObject var model: BoardModel
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    let groups = Dictionary(grouping: DemoData.screens, by: { $0.screen })
    let order = DemoData.screens.reduce(into: [String]()) { if !$0.contains($1.screen) { $0.append($1.screen) } }
    NavigationStack {
      List {
        ForEach(order, id: \.self) { name in
          Section(name) {
            ForEach(groups[name] ?? []) { s in
              Button { dismiss(); model.openDemoScreen(s.id) } label: {
                VStack(alignment: .leading, spacing: 2) {
                  Text(s.state).font(Face.text(16, .medium)).foregroundStyle(Ink.fg)
                  if s.mock != "1" { Text("Shown with the demo room as it is (web: \(s.mock))").font(Face.text(12)).foregroundStyle(Ink.muted) }
                }
              }
              .listRowBackground(Ink.surface)
            }
          }
        }
      }
      .scrollContentBackground(.hidden)
      .background(Ink.bg.ignoresSafeArea())
      .navigationTitle("All Screens").navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) { Button("Leave Demo", role: .destructive) { dismiss(); model.leaveDemo() } }
        ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
      }
    }
  }
}
