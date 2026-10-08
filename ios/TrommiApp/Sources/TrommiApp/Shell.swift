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
  /** Chat opens into the chat he used last (the crowned one first). */
  private func openTab(_ t: BoardModel.Tab) {
    if t == .chat, model.chatPath.isEmpty, let id = model.lastChat.flatMap({ model.agent($0)?.id }) ?? model.desk?.crownOf(desk: model.deskId)?.id { model.chatPath = [.session(id)] }
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
          if t == .note { noteOpen = true } else { noteOpen = false; if t == model.tab { withAnimation(.snappy) { model.path = [] } } else { openTab(t) } }
        })) {
          Tab(value: BoardModel.Tab.chat) { chats } label: { Image(systemName: "bubble.left.and.bubble.right").accessibilityLabel("Chat") }
          Tab(value: BoardModel.Tab.desk) {
            stack.toolbar(model.selected.isEmpty ? .automatic : .hidden, for: .tabBar)
          } label: { PenImage.of("sketch:desk", size: 24).accessibilityLabel("Desk") }
          .badge(model.view?.fresh.count ?? 0)
          Tab(value: BoardModel.Tab.note) { Color.clear } label: { Image(systemName: hasNote ? "note.text" : "note").accessibilityLabel(hasNote ? "Note, written" : "Note") }
        }
        .modifier(TabBarLook())
        .sheet(isPresented: $noteOpen) {
          NavigationStack { NoteScreen(onDone: { noteOpen = false }) }
            .presentationDetents([.medium, .large])
            .presentationBackgroundInteraction(.enabled(upThrough: .medium))
            .presentationDragIndicator(.visible)
        }
      }
    }
    .overlay(alignment: hSize == .regular ? .bottom : .top) { ToastHost(top: hSize != .regular).ignoresSafeArea(edges: hSize == .regular ? [] : .top) }
    .safeAreaInset(edge: .top, spacing: 0) { UpdateBanner() }
    .overlay { UpdateRequired() }
    .background(Ink.bg.ignoresSafeArea())
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
/** A pushed screen hides the tab bar (its own controls at the bottom), except a chat: there it stays beside the pencil
 *  until he writes (SessionScreen hides it while the composer is open). */
struct BarFor: ViewModifier {
  let route: Route
  func body(content: Content) -> some View {
    if case .session = route { content } else { content.toolbar(.hidden, for: .tabBar) }
  }
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
      .padding(.horizontal, 6)
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

/** The Chat page's list (Messages, WhatsApp): the desk's sessions, the crowned one first, then by what happened last. */
struct ChatsScreen: View {
  @EnvironmentObject var model: BoardModel
  /** The parents whose helpers are unfolded (folded at first, as the desktop sidebar). */
  @State private var open = Set<String>()
  var body: some View {
    let _ = RenderCount.body("ChatsScreen")
    let _ = model.version
    let v = model.view
    let d = model.desk
    let units = v?.units ?? []
    let byId = Dictionary(units.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    // grouped by desk on All Desks (the desks' order), one group otherwise
    let groups: [(id: String, name: String?)] = v?.all == true ? (d?.desks ?? []).map { ($0.id, Optional($0.name)) } : [(v?.deskId ?? "", nil)]
    List {
      ForEach(groups, id: \.id) { g in
        let crown = d?.crownOf(desk: g.name == nil ? model.deskId : g.id)
        let tops = units.filter { $0.parent == nil && (g.name == nil || (d?.deskOf($0.agent) ?? groups.first?.id) == g.id) }.sorted { a, b in
          if (a.agent.id == crown?.id) != (b.agent.id == crown?.id) { return a.agent.id == crown?.id }
          return a.agent.active > b.agent.active
        }
        if !tops.isEmpty {
          Section {
            ForEach(tops) { u in
              row(u, crowned: u.agent.id == crown?.id, helpers: u.subs.count)
              if open.contains(u.id) {
                ForEach(u.subs, id: \.self) { s in if let su = byId[s] { row(su, crowned: false, helpers: 0) } }
              }
            }
          } header: {
            if let n = g.name {
              HStack(spacing: 8) { PenMark("sketch:desk", color: Ink.muted).frame(width: 18, height: 18); Text(n).font(Face.text(13, .semibold)).foregroundStyle(Ink.muted) }
            }
          }
        }
      }
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .background(Ink.bg)
    .navigationTitle("Chats")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar { ToolbarItem(placement: .topBarLeading) { MenuPill() } }
    .refreshable { await model.refresh() }
  }
  private func row(_ u: DeskUnit, crowned: Bool, helpers: Int) -> some View {
    HStack(spacing: 0) {
      Button { model.chatPath = [.session(u.id)] } label: { ChatRow(unit: u, crowned: crowned, unread: model.unread(u.agent)) }
        .buttonStyle(.plain)
      if helpers > 0 {
        Button { withAnimation(.snappy) { if open.contains(u.id) { open.remove(u.id) } else { open.insert(u.id) } } } label: {
          Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Ink.muted)
            .rotationEffect(.degrees(open.contains(u.id) ? 90 : 0)).frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(open.contains(u.id) ? "Hide \(helpers) helpers" : "Show \(helpers) helpers")
      }
    }
    .listRowBackground(Color.clear)
    .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 8))
  }
}
struct ChatRow: View {
  @EnvironmentObject var model: BoardModel
  let unit: DeskUnit
  let crowned: Bool
  let unread: Bool
  var body: some View {
    let a = unit.agent
    // one line: the drawing and the name; on the right only a green dot (breathing while it works, steady for news)
    HStack(spacing: 12) {
      AgentMark(agent: a, size: 30).opacity(unit.online ? 1 : 0.6)
      Text(a.name).font(Face.text(17, .medium)).foregroundStyle(unit.online ? Ink.fg : Ink.muted).lineLimit(1)
      Spacer(minLength: 6)
      if unit.online && unit.running { PulseDot() }
      else if unread { Circle().fill(Ink.stDone).frame(width: 8, height: 8).accessibilityLabel("New message") }
    }
    .padding(.leading, unit.parent != nil ? 24 : 0)
    .frame(minHeight: 40)
    .contentShape(Rectangle())
  }
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

/**
 * The passing word. iPhone: one glass pill at the top right, just below the ⋯ button: an Undo is the undo arrow in a
 * ring that runs down in 5 s (a second Undo while it runs counts up: "3"), any other word a short line; swipe it away;
 * it never covers more than itself; VoiceOver reads it out. iPad: the bar at the bottom.
 */
struct ToastHost: View {
  @EnvironmentObject var model: BoardModel
  var top = false
  @State private var drag: CGSize = .zero
  @State private var count = 1
  @State private var lastUndoAt: Date? = nil
  @State private var progress: CGFloat = 1
  static let undoSeconds: Double = 5
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
  @ViewBuilder private func phone(_ t: Toast) -> some View {
    Group {
      if let undo = t.undo {
        // the Dynamic Island's pill: it grows out of the island, black, the undo arrow in its 5 s ring; a tap undoes
        Button { model.toast = nil; count = 1; Task { await undo() } } label: {
          HStack(spacing: 10) {
            ZStack {
              Circle().stroke(Color.white.opacity(0.22), lineWidth: 2.5)
              Circle().trim(from: 0, to: progress).stroke(Color.white, style: StrokeStyle(lineWidth: 2.5, lineCap: .round)).rotationEffect(.degrees(-90))
              Image(systemName: "arrow.uturn.backward").font(.system(size: 13, weight: .bold)).foregroundStyle(.white)
            }.frame(width: 28, height: 28)
            Text(count > 1 ? "Undo \(count)" : "Undo").font(Face.text(15, .semibold)).foregroundStyle(.white)
            Text(t.head).font(Face.text(13)).foregroundStyle(.white.opacity(0.65)).lineLimit(1)
          }
          .padding(.leading, 8).padding(.trailing, 16).frame(height: 40)
          .frame(maxWidth: 300)
          .background(Capsule().fill(.black))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Undo: \(t.head)")
        .frame(maxWidth: .infinity)
        .padding(.top, 8)
        .transition(.scale(scale: 0.35, anchor: .top).combined(with: .opacity))
      } else {
        HStack(spacing: 8) {
          if t.alert { Image(systemName: "exclamationmark.circle").foregroundStyle(Ink.urgCritical) }
          VStack(alignment: .leading, spacing: 1) {
            Text(t.head).font(Face.text(14, .semibold)).foregroundStyle(t.alert ? Ink.urgCritical : Ink.fg).lineLimit(1)
            if !t.line.isEmpty { Text(t.line).font(Face.text(12)).foregroundStyle(Ink.muted).lineLimit(2) }
          }
        }
        .padding(.horizontal, 14).padding(.vertical, 9)
        .frame(maxWidth: 280, alignment: .leading)
        .glass(Capsule())
        .onTapGesture { withAnimation { model.toast = nil } }
      }
    }
    .padding(.trailing, t.undo == nil ? 14 : 0).padding(.top, t.undo == nil ? 100 : 0)
    .frame(maxWidth: .infinity, alignment: t.undo == nil ? .trailing : .center)
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


