// Shell.swift: the frame around every board screen (sidebar.mjs, app.mjs): on the iPhone one navigation stack with the
// bar at the bottom (Menu · Desk · Waiting, Liquid Glass); on the iPad the sessions as a sidebar column beside it. The
// desk switcher, the jump menu (desks, sessions, places), the passing toast with its Undo, the calm line when the hub
// asks for a newer app.
import SwiftUI
import TrommiClient
import TrommiCore

struct BoardShell: View {
  @EnvironmentObject var model: BoardModel
  @Environment(\.horizontalSizeClass) private var hSize
  @State private var columns = NavigationSplitViewVisibility.all

  var body: some View {
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
        // iPhone (his pick "both", 8 October): the bottom bar, Menu · Desk · Waiting; no sidebar
        ZStack(alignment: .bottom) {
          stack.safeAreaInset(edge: .bottom) { Color.clear.frame(height: 64) }
          if model.panel != nil {
            Color.black.opacity(0.28).ignoresSafeArea()
              .onTapGesture { withAnimation(.snappy) { model.panel = nil } }
              .transition(.opacity)
            BarPanel().padding(.horizontal, 12).padding(.bottom, 84).transition(.move(edge: .bottom).combined(with: .opacity))
          }
          BottomBar().padding(.horizontal, 16).padding(.bottom, 4)
        }
      }
    }
    .overlay(alignment: .bottom) { ToastHost() }
    .overlay(alignment: .top) { UpdateBanner() }
    .overlay { UpdateRequired() }
    .background(Ink.bg.ignoresSafeArea())
  }
  private var stack: some View {
    NavigationStack(path: $model.path) {
      DeskScreen()
        .navigationDestination(for: Route.self) { r in
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
  }
}

/** The bar at the bottom of the iPhone: Menu (desks, sessions, places), Desk (back to it), Waiting (what waits, the count; red when one knocks). */
struct BottomBar: View {
  @EnvironmentObject var model: BoardModel
  var body: some View {
    let _ = model.version
    let v = model.view
    let n = v?.fresh.count ?? 0
    let knocks = (v?.knocking ?? 0) > 0
    HStack(spacing: 0) {
      item("Menu", on: model.panel == .menu) { PenMark("draw:grid", color: Ink.fg).frame(width: 24, height: 24) } action: { toggle(.menu) }
      item("Desk", on: model.panel == nil && model.path.isEmpty) { PenMark("sketch:desk", color: Ink.fg).frame(width: 26, height: 26) } action: {
        withAnimation(.snappy) { model.panel = nil; model.path = [] }
      }
      item("Waiting", on: model.panel == .waiting) {
        Sketch("tray", color: Ink.fg).frame(width: 26, height: 26)
          .overlay(alignment: .topTrailing) {
            if n > 0 {
              Text("\(n)").font(Face.text(11, .bold)).foregroundStyle(.white).padding(.horizontal, 5).frame(minWidth: 18, minHeight: 18)
                .background(Capsule().fill(knocks ? Ink.urgCritical : Ink.fg)).offset(x: 12, y: -8)
            }
          }
      } action: { toggle(.waiting) }
    }
    .padding(6)
    .glass(Capsule(), interactive: true)
    .accessibilityElement(children: .contain)
  }
  private func toggle(_ p: BoardModel.Panel) { withAnimation(.snappy) { model.panel = model.panel == p ? nil : p } }
  private func item<I: View>(_ word: String, on: Bool, @ViewBuilder icon: () -> I, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      VStack(spacing: 2) { icon(); Text(word).font(Face.text(12, .medium)).foregroundStyle(Ink.fg) }
        .frame(maxWidth: .infinity, minHeight: 52)
        .background(Capsule().fill(on ? Ink.fg.opacity(0.08) : .clear))
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(word)
  }
}

/** The panel over the bar: the jump menu, or what waits for him. */
struct BarPanel: View {
  @EnvironmentObject var model: BoardModel
  @State private var newDesk = ""
  @State private var making = false
  var body: some View {
    let _ = model.version
    ScrollView {
      VStack(alignment: .leading, spacing: 2) {
        if model.panel == .menu { menu } else { waiting }
      }.padding(.vertical, 12)
    }
    .frame(maxHeight: 560)
    .fixedSize(horizontal: false, vertical: true)
    .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(Ink.surface))
    .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Ink.fg.opacity(0.85), lineWidth: 1.5))
    .shadow(color: .black.opacity(0.18), radius: 18, y: 6)
  }
  private func heading(_ t: String) -> some View {
    Text(t).font(Face.text(13, .semibold)).kerning(1.4).foregroundStyle(Ink.muted).padding(.horizontal, 20).padding(.top, 8).padding(.bottom, 4)
  }
  private func row<I: View>(@ViewBuilder _ icon: () -> I, _ title: String, count: Int? = nil, on: Bool = false, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack(spacing: 14) {
        icon().frame(width: 30, height: 30)
        Text(title).font(Face.text(17, .medium)).foregroundStyle(Ink.fg).lineLimit(2).multilineTextAlignment(.leading)
        Spacer(minLength: 6)
        if let c = count, c > 0 { Text("\(c)").font(Face.text(15, .medium)).foregroundStyle(Ink.muted) }
      }
      .padding(.horizontal, 14).padding(.vertical, 10)
      .background(RoundedRectangle(cornerRadius: 12).fill(on ? Ink.sunken : .clear))
      .contentShape(Rectangle())
    }.buttonStyle(.plain).padding(.horizontal, 8)
  }
  private func go(_ r: Route) { withAnimation(.snappy) { model.panel = nil; model.path = [r] } }
  @ViewBuilder private var menu: some View {
    let d = model.desk
    let v = model.view
    heading("DESKS")
    if (d?.desks.count ?? 0) > 1 {
      row({ PenMark("sketch:desk", color: Ink.fg) }, "All desks", count: v?.allFreshCount, on: v?.all == true) { model.deskId = ALL_DESKS; model.panel = nil; model.path = [] }
    }
    ForEach(d?.desks ?? []) { desk in
      row({ PenMark("sketch:desk", color: Ink.fg) }, desk.name, count: d?.view(desk: desk.id).fresh.count, on: v?.all != true && v?.deskId == desk.id) {
        model.deskId = desk.id; model.panel = nil; model.path = []
      }
      .contextMenu {
        if (d?.desks.count ?? 0) > 1 { Button("Remove desk", role: .destructive) { model.removeDesk(desk.id) } }
      }
    }
    if making {
      HStack {
        TextField("Name of the new desk", text: $newDesk).font(Face.text(16)).textFieldStyle(.roundedBorder).onSubmit(make)
        Button("Make", action: make).font(Face.text(15, .semibold))
      }.padding(.horizontal, 20).padding(.vertical, 6)
    } else {
      row({ PenMark("ui:PLUS", color: Ink.muted) }, "New desk") { making = true }
    }
    heading("SESSIONS")
    ForEach((v?.units ?? []).filter { $0.parent == nil }) { u in
      row({ AgentMark(agent: u.agent, size: 28).opacity(u.online ? 1 : 0.6) }, u.agent.name, count: u.open) { go(.session(u.id)) }
      ForEach(u.subs, id: \.self) { sid in
        if let su = v?.units.first(where: { $0.id == sid }) { row({ AgentMark(agent: su.agent, size: 24) }, su.agent.name, count: su.open) { go(.session(su.id)) }.padding(.leading, 18) }
      }
    }
    heading("PLACES")
    row({ Image(systemName: "checklist").foregroundStyle(Ink.fg) }, "Off your mind") { go(.off) }
    row({ Image(systemName: "scribble.variable").foregroundStyle(Ink.fg) }, "Scribble Board") { go(.scribble) }
    row({ Image(systemName: "photo.on.rectangle").foregroundStyle(Ink.fg) }, "Media") { go(.media) }
    row({ Image(systemName: "doc.richtext").foregroundStyle(Ink.fg) }, "Pages") { go(.pages) }
    row({ PenMark("sketch:key", color: Ink.fg) }, "Settings") { go(.settings("agents")) }
  }
  private func make() {
    let n = newDesk.trimmingCharacters(in: .whitespaces)
    if !n.isEmpty { model.newDesk(name: n) }
    newDesk = ""; making = false; model.panel = nil
  }
  @ViewBuilder private var waiting: some View {
    let v = model.view
    let list = v?.deskCards() ?? []
    heading("WAITING FOR YOU")
    if list.isEmpty { Text("Nothing waits for you.").font(Face.text(16)).foregroundStyle(Ink.muted).padding(.horizontal, 20).padding(.vertical, 10) }
    ForEach(list) { c in
      let a = model.desk?.byAgent[c.agent]
      row({
        if c.urgency == "critical" { PenMark("hand", color: Ink.surface, blocked: true) }
        else if let a = a { AgentMark(agent: a, size: 26) } else { Sketch("knock", color: Ink.urgHigh) }
      }, c.title) { go(.card(c.id)) }
    }
  }
}

/** The top bar's leading part on the iPhone: the drawer's handle (a dot when the connection is lost), the desk. */
struct DrawerButton: View {
  @EnvironmentObject var model: BoardModel
  @Environment(\.horizontalSizeClass) private var hSize
  var body: some View {
    if hSize != .regular {
      Button { withAnimation(.spring(response: 0.32, dampingFraction: 0.86)) { model.drawer = true } } label: {
        ZStack(alignment: .topTrailing) {
          PenMark("sidebar:HANDLE").frame(width: 24, height: 24)
          if !model.live { Circle().fill(Ink.lead).frame(width: 8, height: 8).offset(x: 3, y: -2) }
        }
      }
      .accessibilityLabel(model.live ? "Sessions and desks" : "Sessions and desks (not connected)")
    }
  }
}

/** The phone's drawer: the sidebar sliding in over a veil; it follows the finger both ways and snaps with its speed. */
struct Drawer: View {
  @EnvironmentObject var model: BoardModel
  var peek: CGFloat = 0
  @State private var drag: CGFloat = 0
  var body: some View {
    GeometryReader { geo in
      let w = min(geo.size.width * 0.84, 360)
      // how far it is out: 0 shut, w open
      let out = model.drawer ? max(0, w + min(0, drag)) : min(w, peek)
      ZStack(alignment: .leading) {
        if out > 0 {
          Color.black.opacity(0.32 * Double(out / w)).ignoresSafeArea()
            .onTapGesture { withAnimation(.spring(response: 0.3, dampingFraction: 0.9)) { model.drawer = false } }
          Sidebar(inDrawer: true)
            .frame(width: w)
            .background(Ink.bg.ignoresSafeArea())
            .shadow(color: .black.opacity(0.18 * Double(out / w)), radius: 16, x: 4)
            .offset(x: out - w)
            .gesture(DragGesture(minimumDistance: 10)
              .onChanged { v in drag = min(0, v.translation.width) }
              .onEnded { v in
                let close = v.translation.width < -w / 3 || v.predictedEndTranslation.width < -w / 2
                withAnimation(.spring(response: 0.3, dampingFraction: 0.9)) { if close { model.drawer = false }; drag = 0 }
              })
        }
      }
    }
    .allowsHitTesting(model.drawer || peek > 0)
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
            Button { model.drawer = false; model.path = [.settings("agents")] } label: {
              HStack(spacing: 12) { PenMark("ui:PLUS").frame(width: 22, height: 22).padding(.leading, 6); Text("New agent").font(Face.text(16, .medium)) }
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
      if desks.count > 1 { deskItem(id: ALL_DESKS, name: "All desks", on: v?.all == true, waits: false) }
      ForEach(desks) { d in
        let waits = model.desk?.view(desk: d.id).fresh.isEmpty == false
        deskItem(id: d.id, name: d.name, on: v?.all != true && v?.deskId == d.id, waits: waits)
          .contextMenu {
            Button("Rename") { deskName = d.name; renaming = d.id }
            if desks.count > 1 { Button("Remove desk", role: .destructive) { model.removeDesk(d.id) } }
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
          HStack(spacing: 10) { PenMark("ui:PLUS").frame(width: 18, height: 18); Text("New desk").font(Face.text(15)) }.foregroundStyle(Ink.muted).padding(.horizontal, 18).padding(.vertical, 8)
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
      Button { go(.off) } label: { Label("Off your mind", systemImage: "checklist") }
      Button { go(.scribble) } label: { Label("Scribble Board", systemImage: "scribble.variable") }
      Button { go(.media) } label: { Label("Media", systemImage: "photo.on.rectangle") }
      Button { go(.pages) } label: { Label("Pages", systemImage: "doc.richtext") }
      Link(destination: URL(string: "https://app.trommi.com/help.html")!) { Label("Help", systemImage: "questionmark.circle") }
      Picker("Theme", selection: $model.theme) { ForEach(ThemeMode.allCases) { Text($0.word).tag($0) } }
      Button { go(.settings("account")) } label: { Label("Log out…", systemImage: "rectangle.portrait.and.arrow.right") }
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
  private func go(_ r: Route) { model.drawer = false; model.path = [r] }
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
      model.drawer = false
      model.path = [.session(a.id)]
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

struct ToastHost: View {
  @EnvironmentObject var model: BoardModel
  var body: some View {
    VStack {
      if let t = model.toast {
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
        .padding(.horizontal, 14).padding(.bottom, 8)
        .transition(.move(edge: .bottom).combined(with: .opacity))
        .onTapGesture { withAnimation { model.toast = nil } }
        .task(id: t.id) {
          try? await Task.sleep(nanoseconds: t.undo != nil ? 6_000_000_000 : 3_500_000_000)
          withAnimation { if model.toast?.id == t.id { model.toast = nil } }
        }
      }
    }
    .animation(.spring(response: 0.35, dampingFraction: 0.85), value: model.toast)
  }
}

/** A quiet line when a newer Trommi is out or this one met things it cannot show (the work goes on). */
struct UpdateBanner: View {
  @EnvironmentObject var model: BoardModel
  @State private var hidden = false
  var body: some View {
    let line: String? = {
      if case .updateAvailable = model.verdict { return "Update available" }
      if model.newer > 0 { return "Some things here need a newer Trommi" }
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
      .padding(.top, 2)
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
