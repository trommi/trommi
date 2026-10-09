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
    // "Demo · Leave" as one clear yellow pill (his word, 8 October); All Screens beside it, quieter
    HStack(spacing: 8) {
      Button { model.leaveDemo() } label: {
        HStack(spacing: 6) {
          Text("Demo").font(Face.text(15, .bold))
          Text("·").font(Face.text(15, .bold))
          Text("Leave").font(Face.text(15, .bold)).underline()
          Image(systemName: "xmark").font(.system(size: 11, weight: .bold))
        }
        .foregroundStyle(Color(hex: 0x2d2406))
        .padding(.horizontal, 16).frame(minHeight: 36)
        .background(Capsule().fill(Ink.yellow))
        .overlay(Capsule().strokeBorder(Color(hex: 0x2d2406), lineWidth: 1.6))
      }
      .accessibilityLabel("Leave Demo")
      Button("All Screens") { model.demoScreens = true }
        .font(Face.text(14, .semibold)).foregroundStyle(Ink.fg)
        .padding(.horizontal, 12).frame(minHeight: 36)
        .glass(Capsule(), interactive: true)
    }
    .buttonStyle(.plain)
    .frame(maxWidth: .infinity)
    .padding(.vertical, 4)
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

/**
 * A crowded demo room for the chat list (TROMMI_CHATLIST=1 at launch): three desks, "Trommi App" with its crowned session
 * and 23 helpers (four at work, four offline), "Website" with a crown and two helpers, "Privat" with two sessions.
 * Built from the web demo's fixture; nothing is sent, nothing kept.
 */
enum ChatListDemo {
  static func fixture(_ data: Data) -> Data {
    guard var f = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return data }
    let now = (f["made_at"] as? Double) ?? Double(nowMs())
    var sessions = (f["sessions"] as? [[String: Any]]) ?? []
    var human = (f["human"] as? [String: Any]) ?? [:]
    var desks = (human["desks"] as? [String: Any]) ?? [:]
    var settings = (human["session_settings"] as? [String: Any]) ?? [:]
    func dev(_ s: String) -> String {
      var x: UInt64 = 1469598103934665603
      for b in s.utf8 { x = (x ^ UInt64(b)) &* 1099511628211 }
      var h = ""
      while h.count < 64 { x = x &* 6364136223846793005 &+ 1442695040888963407; h += String(format: "%016llx", x) }
      return String(h.prefix(64))
    }
    func edit(_ id: String, _ change: (inout [String: Any], inout [String: Any]) -> Void) {
      guard let i = sessions.firstIndex(where: { $0["agent_session_id"] as? String == id }) else { return }
      var p = (sessions[i]["profile"] as? [String: Any]) ?? [:]
      var s = sessions[i]
      change(&s, &p)
      s["profile"] = p
      sessions[i] = s
      if let d = s["agent_device_id"] as? String, let st = s["settings"] { settings[d] = st }
    }
    func rename(_ id: String, _ name: String, desk: String, task: String? = nil) {
      edit(id) { s, p in
        p["agent_name"] = name; if let t = task { p["task"] = t }
        s["device_name"] = name
        var st = (s["settings"] as? [String: Any]) ?? [:]; st["desk"] = desk; s["settings"] = st
      }
    }
    func add(_ id: String, _ name: String, icon: String, parent: String?, desk: String, task: String, online: Bool = true, working: String? = nil, ago: Double = 60) {
      let d = dev(id)
      let st: [String: Any] = ["name": "", "desk": desk, "archived": false, "group": NSNull(), "icon": NSNull()]
      let line: [String: Any] = working.map { ["id": "\(id)-1", "label": $0, "state": "working", "detail": "", "object_id": NSNull(), "updated_at": now - 60_000] }
        ?? ["id": "\(id)-0", "label": task, "state": "done", "detail": "", "object_id": NSNull(), "updated_at": now - ago * 60_000]
      let profile: [String: Any] = ["model": "claude-opus-5-5", "task": task, "icon": icon, "agent_name": name, "parent_session": parent ?? NSNull(), "is_main": false]
      sessions.append(["agent_device_id": d, "agent_session_id": id, "device_name": name, "is_active": true, "is_online": online,
                       "profile": profile, "status_lines": [line], "settings": st])
      settings[d] = st
    }
    desks["main"] = ["name": "Trommi App", "created_at": now - 9e8] as [String: Any]
    desks["web"] = ["name": "Website", "created_at": now - 5e8, "crown": ["agent_device_id": dev("web-lead")]] as [String: Any]
    desks["test"] = ["name": "Privat", "created_at": now - 4e8] as [String: Any]
    rename("trommi", "Trommi CTO", desk: "main", task: "Chat-Liste: Hierarchie neu")
    rename("trommi-ui", "Design-Review", desk: "main")
    rename("trommi-docs", "Docs", desk: "main")
    rename("crypto", "Krypto-Audit", desk: "main")
    rename("test-alpha", "Steuer 2026", desk: "test", task: "Belege sortieren")
    rename("test-beta", "Umzug", desk: "test", task: "Kartons und Termine")
    edit("trommi-docs") { s, _ in s["is_online"] = true }
    edit("crypto") { s, p in p["parent_session"] = "trommi"; s["status_lines"] = [Any]() }
    // the crowned session's helpers (Design-Review, Docs and Krypto-Audit are three of them): Design-Review and three
    // more at work, four offline, the rest idle
    let helpers: [(String, String, String?, Bool)] = [
      ("Tempo", "draw:bolt", "Scroll-Ruckler im Desk", true), ("Server", "", "Deploy auf trommi-hub", true), ("QA", "draw:spiral", "E2E über den Share-Flow", true),
      ("Karte", "", nil, true), ("Web UI", "draw:blob", nil, true), ("Übernahme", "draw:zigzag", nil, true), ("Connector", "", nil, true),
      ("Design", "", nil, true), ("iOS", "", nil, true), ("Schlüssel", "draw:waves", nil, true), ("iPhone", "draw:phone", nil, true), ("Push", "draw:bell", nil, true),
      ("Share", "draw:arrow", nil, true), ("Fuzz", "draw:bug", nil, true), ("Release", "draw:rocket", nil, true), ("Perf", "draw:flame", nil, true),
      ("Hub", "draw:database", nil, false), ("Notiz", "draw:leaf", nil, false), ("Tests", "draw:flask", nil, false), ("Onboarding", "draw:kite", nil, false)]
    for (i, h) in helpers.enumerated() {
      add("h-\(i)", h.0, icon: h.1, parent: "trommi", desk: "main", task: h.2 ?? "\(h.0): fertig", online: h.3, working: h.2, ago: Double(30 + i * 40))
    }
    add("web-lead", "Website", icon: "draw:browser", parent: nil, desk: "web", task: "trommi.com: die Startseite")
    add("web-blog", "Blog", icon: "draw:book", parent: "web-lead", desk: "web", task: "Launch-Artikel", working: "Launch-Artikel: zweiter Entwurf")
    add("web-seo", "SEO", icon: "draw:eye", parent: "web-lead", desk: "web", task: "Meta-Tags")
    human["desks"] = desks; human["session_settings"] = settings
    f["sessions"] = sessions; f["human"] = human
    return (try? JSONSerialization.data(withJSONObject: f)) ?? data
  }
}
