// Shell.swift: the frame around every board screen (sidebar.mjs, app.mjs): on the iPhone the system tab bar (Chat ·
// Desk · Note as icons, Note as a sheet) and the place pill (the menu) at the top left; on the iPad the sessions as a
// sidebar column beside the stack. The passing toast with its Undo, the calm line when the hub asks for a newer app.
import SwiftUI
import TrommiClient
import TrommiCore

struct BoardShell: View {
  @EnvironmentObject var model: BoardModel
  @Environment(\.horizontalSizeClass) private var hSize
  @State private var columns = NavigationSplitViewVisibility.all
  @State private var noteOpen = false
  private var hasNote: Bool { !(model.desk?.notes.filter { $0.held.isNull && (!$0.text.isEmpty || !$0.attachments.isEmpty) }.isEmpty ?? true) }
  /** Chat always opens on its list (a chat has no tab bar: opened into one, there was no way back to the bar). */
  private func openTab(_ t: BoardModel.Tab) {
    if t == .chat { model.chatPath = [] }
    model.tab = t
  }

  var body: some View {
    let _ = RenderCount.body("BoardShell")
    Group {
      if hSize == .regular {
        NavigationSplitView(columnVisibility: $columns) {
          Sidebar(inDrawer: false)
            .navigationSplitViewColumnWidth(min: 260, ideal: 300, max: 360)
            .toolbar(.hidden, for: .navigationBar)
        } detail: {
          stack
        }
      } else {
        // iPhone (his picks, 8 October): the system tab bar (Liquid Glass on iOS 26; insets, keyboard, Dynamic Type and
        // VoiceOver as every app): Chat · Desk · Note as icons. Note does not switch the page: it opens the note as a
        // sheet over the page (medium, the tab bar stays reachable). A pushed screen hides the bar where it has its own
        // controls at the bottom; the place pill at the top left is the menu, the ⋯ at the top right the screen's actions.
        TabView(selection: Binding(get: { model.tab }, set: { t in
          // Note is no page: the system tab bar has already switched to it, so the selection goes there and straight
          // back (a set that leaves the value as it was is not seen, and the bar stayed on an empty page, build 18)
          if t == .note {
            let back = model.tab == .note ? .desk : model.tab
            model.tab = .note
            DispatchQueue.main.async { model.tab = back; noteOpen = true }
          } else { noteOpen = false; if t == model.tab { withAnimation(.snappy) { model.path = [] } } else { openTab(t) } }
        })) {
          Tab(value: BoardModel.Tab.chat) {
            // the bar only on the list: a chat has its composer at the bottom (decided on the stack itself, where it
            // is not overridden: a pushed page's own .hidden lost against the stack's, build 18)
            chats.toolbar(model.chatPath.isEmpty ? .automatic : .hidden, for: .tabBar).modifier(NotePanel(open: $noteOpen))
          } label: { PenImage.of("sketch:bubble", size: 24).accessibilityLabel("Chat") }
          Tab(value: BoardModel.Tab.desk) {
            stack.toolbar(model.selected.isEmpty && model.deskPath.isEmpty ? .automatic : .hidden, for: .tabBar).modifier(NotePanel(open: $noteOpen))
          } label: { PenImage.of("sketch:desk", size: 24).accessibilityLabel("Desk") }
          .badge(model.view?.fresh.count ?? 0)
          Tab(value: BoardModel.Tab.note) {
            // shown only for the moment before the selection goes back (or if it does not): the note itself, not black
            NavigationStack { NoteScreen(onDone: { model.tab = .desk }) }
          } label: { PenImage.of("sketch:page", size: 24, dot: hasNote).accessibilityLabel(hasNote ? "Note, written" : "Note") }
        }
        .modifier(TabBarLook())
      }
    }
    .overlay(alignment: hSize == .regular ? .bottom : .top) { ToastHost(top: hSize != .regular).ignoresSafeArea(edges: hSize == .regular ? [] : .top) }
    .safeAreaInset(edge: .top, spacing: 0) { UpdateBanner() }
    .overlay { UpdateRequired() }
    .background(Ink.bg.ignoresSafeArea())
    .modifier(StatusBarUnderIsland())
  }
  private var stack: some View {
    NavigationStack(path: $model.deskPath) {
      DeskScreen().toolbarBackground(.hidden, for: .navigationBar).navigationDestination(for: Route.self) { r in Self.destination(r).toolbarBackground(.hidden, for: .navigationBar).modifier(BarFor(route: r)) }
    }
  }
  private var chats: some View {
    NavigationStack(path: $model.chatPath) {
      ChatsScreen().toolbarBackground(.hidden, for: .navigationBar).navigationDestination(for: Route.self) { r in Self.destination(r).toolbarBackground(.hidden, for: .navigationBar).modifier(BarFor(route: r)) }
    }
  }
  @ViewBuilder static func destination(_ r: Route) -> some View {
          switch r {
          case .card(let id): CardScreen(cardId: id)
          case .session(let id): SessionScreen(agentId: id)
          case .blitz: BlitzScreen()
          case .off: OffScreen()
          case .settings(let tab): SettingsScreen(tab: tab)
          case .media: MediaScreen(pages: false)
          case .pages: MediaScreen(pages: true)
          case .picture(let id, let at): PictureScreen(cardId: id, start: at)
          case .scribble: ScribbleScreen()
          }
  }
}

/** The tab bar's look: it shrinks while he scrolls down (iOS 26). */
struct TabBarLook: ViewModifier {
  func body(content: Content) -> some View {
    if #available(iOS 26.0, *) { content.tabBarMinimizeBehavior(.onScrollDown).tint(Ink.fg) } else { content.tint(Ink.fg) }
  }
}
/** A pushed screen hides the tab bar (its own controls at the bottom); a chat too, its composer stays at the bottom
 *  (Messages, WhatsApp). Back to the list, the bar returns. */
struct BarFor: ViewModifier {
  let route: Route
  func body(content: Content) -> some View { content.toolbar(.hidden, for: .tabBar) }
}

/**
 * The place pill at the top left of the iPhone's pages: the desk's drawing and name with a small chevron. It is the
 * menu (a system glass menu that grows out of the pill): Settings, the desks, the sessions, the places.
 */
struct MenuPill: View {
  @EnvironmentObject var model: BoardModel
  @State private var askDesk = false
  @State private var deskName = ""
  var body: some View {
    let _ = RenderCount.body("MenuPill")
    let _ = model.version
    let d = model.desk, v = model.view
    Menu {
      if model.demo {
        Section { Button { model.leaveDemo() } label: { Label("Leave Demo", systemImage: "xmark.circle") } }
      }
      Section("Desks") {
        if (d?.desks.count ?? 0) > 1 {
          Button { model.deskId = ALL_DESKS; model.deskPath = []; model.tab = .desk } label: {
            Label { Text((v?.allFreshCount ?? 0) > 0 ? "All Desks · \(v!.allFreshCount)" : "All Desks") } icon: { Image(systemName: v?.all == true ? "checkmark" : "square.stack") }
          }
        }
        ForEach(d?.desks ?? []) { desk in
          deskItem(desk.id, desk.name, on: v?.all != true && v?.deskId == desk.id, waiting: d?.view(desk: desk.id).fresh.count ?? 0)
        }
        Button { deskName = ""; askDesk = true } label: { Label("New Desk…", systemImage: "plus") }
      }
      Section {
        Button { go(.scribble) } label: { Label("Scribble", systemImage: "scribble.variable") }
        Button { go(.media) } label: { Label("Artifacts", systemImage: "photo.on.rectangle") }
      }
      Section {
        // the push bell (Settings · Devices keeps the same): everything, only knocking, off
        Picker(selection: Binding(get: { Push.level }, set: { l in Task { await Push.setLevel(l) } })) {
          Label("Everything", systemImage: "bell").tag("all")
          Label("Only Knocking", systemImage: "bell.badge").tag("knocking")
          Label("Off", systemImage: "bell.slash").tag("off")
        } label: { Label("Notifications", systemImage: Push.level == "off" ? "bell.slash" : Push.level == "knocking" ? "bell.badge" : "bell") }
        .pickerStyle(.menu)
        Button { go(.settings("agents")) } label: { Label("Settings", systemImage: "gearshape") }
        Button { if model.demo { model.demoScreens = true } else { model.startDemo() } } label: { Label(model.demo ? "Demo: All Screens" : "Demo", systemImage: "play.rectangle") }
      }
    } label: {
      HStack(spacing: 7) {
        PenMark("sketch:desk", color: Ink.fg).frame(width: 22, height: 22)
          .overlay(alignment: .topLeading) { if (v?.fresh.count ?? 0) > 0 { Circle().fill(Ink.yellow).frame(width: 7, height: 7).offset(x: 3, y: 1) } }
        Text(v?.deskName ?? "Desk").font(Face.display(17, .bold)).foregroundStyle(Ink.fg).lineLimit(1)
        Image(systemName: "chevron.down").font(.system(size: 11, weight: .semibold)).foregroundStyle(Ink.muted)
        if !model.live { Circle().fill(Ink.lead).frame(width: 7, height: 7).accessibilityLabel("Not connected") }
      }
      // a Liquid Glass pill, as the other chrome pills (the agents and Blitz at the top right)
      .padding(.horizontal, 14).frame(height: 44)
      .glass(Capsule(), interactive: true)
    }
    .accessibilityLabel("\(v?.deskName ?? "Desk"), Menu")
    .alert("New Desk", isPresented: $askDesk) {
      TextField("Name", text: $deskName)
      Button("Cancel", role: .cancel) {}
      Button("Create") { let n = deskName.trimmingCharacters(in: .whitespaces); if !n.isEmpty { model.newDesk(name: n) } }
    }
  }
  private func deskItem(_ id: String, _ name: String, on: Bool, waiting: Int) -> some View {
    Button { model.deskId = id; model.deskPath = []; model.tab = .desk } label: {
      // the desk's drawing as on the web (a menu takes pictures only: drawn once into an image); the tick on the current one
      Label { Text(waiting > 0 ? "    \(name) · \(waiting)" : "    \(name)") } icon: { if on { Image(systemName: "checkmark") } else { PenImage.desk(waiting: waiting > 0) } }
    }
  }
  private func go(_ r: Route) { model.tab = .desk; model.deskPath = [r] }
}

// ---- the sidebar ------------------------------------------------------------------------------------------

struct Sidebar: View {
  @EnvironmentObject var model: BoardModel
  let inDrawer: Bool
  @State private var switching = false
  @State private var menu = false
  @State private var newDesk = false
  @State private var deskName = ""
  var body: some View {
    let _ = model.version
    let v = model.view
    VStack(spacing: 0) {
      deskHead(v)
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 2) {
          if switching { deskList(v) }
          if let v = v {
            let top = v.units.filter { $0.parent == nil }
            let here = top.filter { $0.online || $0.subs.contains { s in v.units.first { $0.id == s }?.online == true } }
            let away = top.filter { u in !here.contains { $0.id == u.id } }
            ForEach(here) { u in rows(u, v) }
            Button { model.path = [.settings("agents")] } label: {
              HStack(spacing: 12) { PenMark("ui:PLUS").frame(width: 22, height: 22).padding(.leading, 6); Text("New Agent…").font(Face.text(16, .medium)) }
                .foregroundStyle(here.isEmpty ? Ink.accent : Ink.muted).padding(.vertical, 10).padding(.horizontal, 12)
            }
            if !away.isEmpty {
              HStack(spacing: 10) {
                Text("DISCONNECTED").font(Face.text(12, .semibold)).kerning(1.2).foregroundStyle(Ink.muted)
                DashedRule().frame(height: 1)
              }.padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 4)
              ForEach(away) { u in rows(u, v) }
            }
          }
        }.padding(.vertical, 8)
      }
      Divider().overlay(Ink.line)
      trommiMenu
    }
    .background(Ink.bg)
  }

  @ViewBuilder private func rows(_ u: DeskUnit, _ v: DeskModel.View) -> some View {
    SessionRow(unit: u, view: v)
    ForEach(u.subs, id: \.self) { s in if let su = v.units.first(where: { $0.id == s }) { SessionRow(unit: su, view: v).padding(.leading, 18) } }
  }

  private func deskHead(_ v: DeskModel.View?) -> some View {
    Button { withAnimation(.snappy) { switching.toggle() } } label: {
      HStack(spacing: 12) {
        PenMark("sketch:desk", color: Ink.fg).frame(width: 34, height: 34)
          .overlay(alignment: .topLeading) { if (v?.fresh.count ?? 0) > 0 { Circle().fill(Ink.yellow).frame(width: 8, height: 8).offset(x: 4, y: 2) } }
        Text(v?.deskName ?? "Desk").font(Face.display(26, .heavy)).foregroundStyle(Ink.fg).lineLimit(1).minimumScaleFactor(0.6)
        Spacer(minLength: 4)
        PenMark("sketch:unfold", color: Ink.muted).frame(width: 18, height: 18).rotationEffect(.degrees(switching ? 180 : 0))
      }
      .padding(.horizontal, 14).padding(.vertical, 12)
      .background(PenBox(r: 14).stroke(Ink.fg, lineWidth: 2))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .padding(.horizontal, 10).padding(.top, 10).padding(.bottom, 6)
    .accessibilityLabel("Desk: \(v?.deskName ?? "Desk"). Choose the desk")
  }

  @ViewBuilder private func deskList(_ v: DeskModel.View?) -> some View {
    let desks = model.desk?.desks ?? []
    VStack(alignment: .leading, spacing: 2) {
      if desks.count > 1 { deskItem(id: ALL_DESKS, name: "All Desks", on: v?.all == true, waits: false) }
      ForEach(desks) { d in
        let waits = model.desk?.view(desk: d.id).fresh.isEmpty == false
        deskItem(id: d.id, name: d.name, on: v?.all != true && v?.deskId == d.id, waits: waits)
          .contextMenu {
            Button("Rename…") { deskName = d.name; renaming = d.id }
            if desks.count > 1 { Button("Delete Desk", role: .destructive) { model.removeDesk(d.id) } }
          }
      }
      if newDesk || renaming != nil {
        HStack {
          TextField(renaming != nil ? "Name of the desk" : "Name of the new desk", text: $deskName).font(Face.text(16)).textFieldStyle(.roundedBorder)
            .onSubmit(makeDesk)
          Button(renaming != nil ? "Save" : "Make", action: makeDesk).font(Face.text(15, .semibold))
        }.padding(.horizontal, 14).padding(.vertical, 6)
      } else {
        Button { newDesk = true; deskName = "" } label: {
          HStack(spacing: 10) { PenMark("ui:PLUS").frame(width: 18, height: 18); Text("New Desk…").font(Face.text(15)) }.foregroundStyle(Ink.muted).padding(.horizontal, 18).padding(.vertical, 8)
        }
      }
      DashedRule().frame(height: 1).padding(.horizontal, 14).padding(.vertical, 8)
    }
  }
  @State private var renaming: String? = nil
  private func makeDesk() {
    if let r = renaming { model.renameDesk(r, deskName) } else if !deskName.trimmingCharacters(in: .whitespaces).isEmpty { model.newDesk(name: deskName) }
    newDesk = false; renaming = nil; deskName = ""
  }
  private func deskItem(id: String, name: String, on: Bool, waits: Bool) -> some View {
    Button {
      model.deskId = id
      withAnimation(.snappy) { switching = false }
    } label: {
      HStack(spacing: 10) {
        PenMark("sketch:desk", color: on ? Ink.fg : Ink.muted).frame(width: 22, height: 22)
        Text(name).font(Face.text(16, on ? .semibold : .regular)).foregroundStyle(on ? Ink.fg : Ink.muted)
        if waits { Circle().fill(Ink.urgHigh).frame(width: 7, height: 7) }
        Spacer()
        if on { PenMark("sketch:tick", color: Ink.accent).frame(width: 18, height: 18) }
      }.padding(.horizontal, 18).padding(.vertical, 9).contentShape(Rectangle())
    }.buttonStyle(.plain)
  }

  private var trommiMenu: some View {
    Menu {
      Button { go(.settings("agents")) } label: { Label("Settings", systemImage: "key") }
      Button { go(.scribble) } label: { Label("Scribble", systemImage: "scribble.variable") }
      Button { go(.media) } label: { Label("Artifacts", systemImage: "photo.on.rectangle") }
      Button { if model.demo { model.demoScreens = true } else { model.startDemo() } } label: { Label(model.demo ? "Demo: All Screens" : "Demo", systemImage: "play.rectangle") }
      Picker("Theme", selection: $model.theme) { ForEach(ThemeMode.allCases) { Text($0.word).tag($0) } }
      Button { go(.settings("account")) } label: { Label("Log Out…", systemImage: "rectangle.portrait.and.arrow.right") }
    } label: {
      HStack(spacing: 12) {
        PenMark("ui:BELL", color: Ink.fg).frame(width: 30, height: 30)
        Text("Trommi").font(Face.display(22, .heavy)).foregroundStyle(Ink.fg)
        Spacer()
        PenMark("sketch:unfold", color: Ink.muted).frame(width: 16, height: 16).rotationEffect(.degrees(180))
      }.padding(.horizontal, 20).padding(.vertical, 14).contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }
  private func go(_ r: Route) { model.path = [r] }
}

/** One session in the sidebar: its mark (drawing itself while it works), its name, how it hears, what waits. */
struct SessionRow: View {
  @EnvironmentObject var model: BoardModel
  let unit: DeskUnit
  let view: DeskModel.View
  var body: some View {
    let a = unit.agent
    let current = model.path.last == .session(a.id)
    Button {
      model.openChat(a.id)
    } label: {
      HStack(spacing: 12) {
        AgentMark(agent: a, size: 30).opacity(unit.online ? 1 : 0.6)
        VStack(alignment: .leading, spacing: 1) {
          Text(a.name).font(Face.text(17, .medium)).foregroundStyle(unit.online ? Ink.fg : Ink.muted).lineLimit(1)
          if let l = unit.link, l.state != "live" {
            HStack(spacing: 4) { PenMark("sketch:\(l.sign)", color: Ink.muted).frame(width: 14, height: 14); Text(l.word).font(Face.text(13)).foregroundStyle(Ink.muted) }
          } else if unit.unheard > 0 {
            HStack(spacing: 4) { Sketch("letter", color: Ink.urgHigh).frame(width: 14, height: 14); Text(unit.unheard == 1 ? "1 answer waits" : "\(unit.unheard) answers wait").font(Face.text(13)).foregroundStyle(Ink.urgHigh) }
          } else if unit.online && unit.running {
            Text(a.task.isEmpty ? "working" : a.task).font(Face.text(13)).foregroundStyle(Ink.muted).lineLimit(1)
          }
        }
        Spacer(minLength: 4)
        Badge(unit: unit)
      }
      .padding(.horizontal, 14).padding(.vertical, 8)
      .background(RoundedRectangle(cornerRadius: 12).fill(current ? Ink.accentSoft : .clear))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .padding(.horizontal, 6)
  }
}

/** What waits on a session: a tally of its open questions, the raised hand when it is stopped. */
struct Badge: View {
  let unit: DeskUnit
  var body: some View {
    if let b = unit.blocked {
      PenMark("hand", color: Ink.surface, blocked: true).frame(width: 26, height: 26).accessibilityLabel("Stopped: \(b.text)")
    } else if unit.open > 0 {
      if unit.open > 5 { Text("\(unit.open)").font(Face.text(17, .medium)).foregroundStyle(Ink.muted) }
      else { Tally(n: unit.open).stroke(Ink.muted, style: StrokeStyle(lineWidth: 1.8, lineCap: .round)).frame(width: CGFloat(unit.open > 4 ? 22 : unit.open * 5 + 1), height: 16).accessibilityLabel("\(unit.open) open") }
    }
  }
}
struct Tally: Shape {
  let n: Int
  func path(in r: CGRect) -> Path {
    let ds = ["M3.9 2.2Q2.6 7.6 2.5 13.9", "M8.6 1.6Q8.4 8.4 7.3 13.2", "M13.7 2.6Q12.5 7.2 12.6 14.2", "M18.6 1.9Q18.3 8.6 17.2 13.5"]
    var p = Path()
    for d in ds.prefix(min(n, 4)) { p.addPath(SVGReader.path(d)) }
    if n > 4 { p.addPath(SVGReader.path("M.9 11.8Q10.5 7.6 21.1 3.5")) }
    let w: CGFloat = n > 4 ? 22 : CGFloat(n * 5 + 1)
    return p.applying(CGAffineTransform(scaleX: r.width / w, y: r.height / 16).translatedBy(x: r.minX, y: r.minY))
  }
}
struct DashedRule: View {
  var color: Color = Ink.lineStrong
  var body: some View { GeometryReader { g in Path { p in p.move(to: CGPoint(x: 0, y: 0.5)); p.addLine(to: CGPoint(x: g.size.width, y: 0.5)) }.stroke(color, style: StrokeStyle(lineWidth: 1, dash: [4, 4])) } }
}

// ---- toast, update line --------------------------------------------------------------------------------------

/** While the island's shape is open over the status bar's place the status bar is hidden, as under the system's own
 *  expanded island: no clock or battery inside the black. */
struct StatusBarUnderIsland: ViewModifier {
  #if canImport(UIKit)
  @ObservedObject private var island = IslandWindow.shared
  func body(content: Content) -> some View { content.statusBarHidden(island.covering) }
  #else
  func body(content: Content) -> some View { content }
  #endif
}

/**
 * The passing word. iPhone with a Dynamic Island: the island itself says it (IslandWindow.swift) and nothing is drawn
 * here. iPhone without one: one clear glass capsule under the status bar, the words at the left, an Undo as the undo
 * arrow in a ring that runs down in 5 s at the right (a second Undo while it runs counts up: "3"); swipe it away; it
 * never covers more than itself; VoiceOver reads it out. iPad: the bar at the bottom.
 */
struct ToastHost: View {
  @EnvironmentObject var model: BoardModel
  var top = false
  @State private var drag: CGSize = .zero
  @State private var count = 1
  @State private var lastUndoAt: Date? = nil
  @State private var progress: CGFloat = 1
  static let undoSeconds: Double = 5
  private var safeTop: CGFloat {
    #if canImport(UIKit)
    return UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first?.safeAreaInsets.top ?? 47
    #else
    return 20
    #endif
  }
  var body: some View {
    VStack {
      if let t = model.toast {
        Group { if top { phone(t) } else { wide(t) } }
        .task(id: t.id) {
          #if canImport(UIKit)
          AccessibilityNotification.Announcement(t.undo != nil ? "\(t.head). Undo available." : [t.head, t.line].filter { !$0.isEmpty }.joined(separator: ". ")).post()
          #endif
          // (a demo screen keeps its toast a minute: the screenshot of the state)
          let secs = ProcessInfo.processInfo.environment["TROMMI_SCREEN"] != nil ? 60 : t.undo != nil ? Self.undoSeconds : 3.5
          progress = 1
          withAnimation(.linear(duration: secs)) { progress = 0 }
          try? await Task.sleep(nanoseconds: UInt64(secs * 1_000_000_000))
          withAnimation { if model.toast?.id == t.id { model.toast = nil; count = 1; lastUndoAt = nil } }
        }
      }
    }
    .animation(.spring(response: 0.35, dampingFraction: 0.85), value: model.toast)
    .onChange(of: model.toast) { old, new in
      #if canImport(UIKit)
      // every toast is said by the island's pill (one place); only a phone without an island shows the glass toast
      defer { if top { if let n = new { IslandWindow.shared.show(n, count: count, model: model) } else { IslandWindow.shared.hide() } } }
      #endif
      guard let n = new, n.undo != nil else { return }
      if let o = old, o.undo != nil, o.id != n.id, let at = lastUndoAt, Date().timeIntervalSince(at) < Self.undoSeconds { count += 1 } else { count = 1 }
      lastUndoAt = Date()
    }
  }
  private func dismissGesture() -> some Gesture {
    DragGesture(minimumDistance: 6).onChanged { drag = $0.translation }.onEnded { v in
      withAnimation(.snappy) {
        if v.translation.height < -24 || abs(v.translation.width) > 40 { model.toast = nil; count = 1 }
        drag = .zero
      }
    }
  }
  private func ring(_ white: Bool, size: CGFloat) -> some View {
    let ink: Color = white ? .white : Ink.fg
    return ZStack {
      Circle().stroke(ink.opacity(0.25), lineWidth: 2.2)
      Circle().trim(from: 0, to: progress).stroke(ink, style: StrokeStyle(lineWidth: 2.2, lineCap: .round)).rotationEffect(.degrees(-90))
      Image(systemName: "arrow.uturn.backward").font(.system(size: size * 0.46, weight: .bold)).foregroundStyle(ink)
    }.frame(width: size, height: size)
  }
  @ViewBuilder private func phone(_ t: Toast) -> some View {
    // on a phone with a Dynamic Island every toast is the island's pill, in its own window (IslandWindow.swift)
    if onIsland { Color.clear.frame(width: 0, height: 0) }
    else { phoneFallback(t) }
  }
  private var onIsland: Bool {
    #if canImport(UIKit)
    return IslandWindow.shared.geometry() != nil
    #else
    return false
    #endif
  }
  /** No island: one clear glass capsule under the status bar, the words left, the undo arrow in its ring right. */
  private func phoneFallback(_ t: Toast) -> some View {
    HStack(spacing: 10) {
      if t.alert { Image(systemName: "exclamationmark.circle").foregroundStyle(Ink.urgCritical) }
      (Text(t.head).font(Face.text(15, .semibold)).foregroundColor(t.alert ? Ink.urgCritical : Ink.fg)
        + Text(t.line.isEmpty ? "" : "  \(t.line)").font(Face.text(14)).foregroundColor(Ink.muted))
        .lineLimit(1).truncationMode(.tail)
      if t.undo != nil {
        Spacer(minLength: 4)
        if count > 1 { Text("\(count)").font(Face.text(14, .semibold)).foregroundStyle(Ink.muted) }
        ring(false, size: 28)
      }
    }
    .padding(.leading, 18).padding(.trailing, t.undo != nil ? 8 : 18).frame(minHeight: 44)
    .glass(Capsule(), interactive: true)
    .contentShape(Capsule())
    .onTapGesture {
      let undo = t.undo
      withAnimation { model.toast = nil; count = 1 }
      if let u = undo { Task { await u() } }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityAddTraits(.isButton)
    .accessibilityLabel(t.undo != nil ? "Undo: \(t.head)" : [t.head, t.line].filter { !$0.isEmpty }.joined(separator: ". "))
    .frame(maxWidth: 360)
    .padding(.horizontal, 16).padding(.top, safeTop + 6)
    .frame(maxWidth: .infinity, alignment: .center)
    .offset(x: drag.width, y: min(0, drag.height))
    .gesture(dismissGesture())
    .transition(.move(edge: .top).combined(with: .opacity))
  }
  private func wide(_ t: Toast) -> some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        Text(t.head).font(Face.text(15, .semibold)).foregroundStyle(t.alert ? Ink.urgCritical : Ink.fg)
        if !t.line.isEmpty { Text(t.line).font(Face.text(14)).foregroundStyle(Ink.muted).lineLimit(2) }
      }
      Spacer(minLength: 8)
      if let undo = t.undo {
        Button("Undo") { model.toast = nil; Task { await undo() } }.font(Face.text(15, .semibold)).foregroundStyle(Ink.accent)
      }
    }
    .padding(.horizontal, 16).padding(.vertical, 12)
    .glass(RoundedRectangle(cornerRadius: 22, style: .continuous))
    .frame(maxWidth: 560)
    .padding(.horizontal, 14).padding(.bottom, 8)
    .offset(y: max(0, drag.height))
    .gesture(DragGesture().onChanged { drag = $0.translation }.onEnded { v in withAnimation(.snappy) { if v.translation.height > 30 { model.toast = nil }; drag = .zero } })
    .transition(.move(edge: .bottom).combined(with: .opacity))
    .onTapGesture { withAnimation { model.toast = nil } }
  }
}

/** A quiet line when a newer Trommi is out or this one met things it cannot show (the work goes on). */
struct UpdateBanner: View {
  @EnvironmentObject var model: BoardModel
  @State private var hidden = false
  var body: some View {
    let line: String? = {
      if case .updateAvailable = model.verdict { return "Update available" }
      // (the retired memo objects of the old Scribble Board are no news of a newer Trommi: no line for them alone)
      if model.newer > 0, (model.room?.board.newerWhat ?? []).contains(where: { $0 != "object_type memo" }) { return "Some things here need a newer Trommi" }
      return nil
    }()
    if let l = line, !hidden {
      Button { hidden = true } label: {
        HStack(spacing: 8) {
          Sketch("wake", color: Ink.noteInk).frame(width: 16, height: 16)
          Text(l).font(Face.text(14, .semibold)).foregroundStyle(Ink.noteInk)
          Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).foregroundStyle(Ink.noteInk.opacity(0.6))
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .background(Capsule().fill(Ink.yellow))
      }
      .buttonStyle(.plain)
      .padding(.vertical, 4)
    }
  }
}

/** The hub serves this version no more (426, upgrade_required): one calm screen. Nothing is lost; reading stops, writing too. */
struct UpdateRequired: View {
  @EnvironmentObject var model: BoardModel
  var body: some View {
    if case .updateRequired(let minimum, let message) = model.verdict {
      VStack(spacing: 18) {
        PenMark("ui:BELL", color: Ink.fg).frame(width: 64, height: 64)
        Text("Bitte aktualisieren").font(Face.display(32, .heavy)).foregroundStyle(Ink.fg)
        Text(message).font(Face.text(17)).foregroundStyle(Ink.muted).multilineTextAlignment(.center)
        if let m = minimum { Text("Trommi \(m) or newer · this is \(HubClient.appVersion)").font(Face.mono(13)).foregroundStyle(Ink.faint) }
        Text("Nothing is lost: your room, your keys and every question stay on this device and on the hub.").font(Face.text(14)).foregroundStyle(Ink.muted).multilineTextAlignment(.center)
      }
      .padding(32).frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Ink.bg.ignoresSafeArea())
      .transition(.opacity)
    }
  }
}




/**
 * The note as a panel over the page, ABOVE the tab bar (his word, 8 October: a sheet covered the bar): inside the tab's
 * content, so its bottom is the bar's top and the keyboard lifts it as it lifts the content. The page stays visible,
 * dimmed; a tap beside it or a swipe down closes it; the draft stays (NoteScreen keeps it on the note object).
 */
struct NotePanel: ViewModifier {
  @Binding var open: Bool
  @State private var drag: CGFloat = 0
  func body(content: Content) -> some View {
    content.overlay {
      if open {
        GeometryReader { geo in
          ZStack(alignment: .bottom) {
            Color.black.opacity(0.28).ignoresSafeArea(edges: .top)
              .onTapGesture { withAnimation(.snappy) { open = false } }
              .transition(.opacity)
            VStack(spacing: 0) {
              Capsule().fill(Ink.noteInk.opacity(0.35)).frame(width: 38, height: 5).padding(.top, 8).padding(.bottom, 2)
                .frame(maxWidth: .infinity).contentShape(Rectangle())
                .gesture(DragGesture().onChanged { drag = max(0, $0.translation.height) }.onEnded { v in
                  withAnimation(.snappy) { if v.translation.height > 80 || v.predictedEndTranslation.height > 200 { open = false }; drag = 0 }
                })
                .accessibilityLabel("Close the note").accessibilityAddTraits(.isButton)
                .accessibilityAction { open = false }
              NavigationStack { NoteScreen(onDone: { withAnimation(.snappy) { open = false } }) }
            }
            .frame(height: max(320, geo.size.height * 0.55))
            .background(Ink.noteYellow)
            .clipShape(UnevenRoundedRectangle(topLeadingRadius: 22, topTrailingRadius: 22, style: .continuous))
            .shadow(color: .black.opacity(0.25), radius: 18, y: -2)
            .offset(y: drag)
            .transition(.move(edge: .bottom))
          }
        }
      }
    }
    .animation(.snappy, value: open)
  }
}
