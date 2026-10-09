// Shell.swift: the frame around every board screen (sidebar.mjs, app.mjs): on the iPhone the glass pill at the bottom (Chat ·
// Desk · Note as drawings, Note as a full yellow page over the list) and the place pill (the menu) at the top left; on the iPad the sessions as a
// sidebar column beside the stack. The passing toast with its Undo, the calm line when the hub asks for a newer app.
import SwiftUI
import TrommiClient
import TrommiCore
#if canImport(UIKit)
import UIKit
#endif

struct BoardShell: View {
  @EnvironmentObject var model: BoardModel
  @Environment(\.horizontalSizeClass) private var hSize
  @State private var columns = NavigationSplitViewVisibility.all
  @State private var keyboard = false
  private var hasNote: Bool { !(model.desk?.notes.filter { $0.held.isNull && (!$0.text.isEmpty || !$0.attachments.isEmpty) }.isEmpty ?? true) }

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
        // iPhone: Chat · Desk · Note as drawings in one glass pill at the bottom (TabPill). Our own bar, not the system
        // tab bar (his words on build 20, 9 October): its selection is a grey capsule that reads as pressed in, it
        // cannot light Note while the note is open (Note is no page), and it draws custom images small. Here the lit
        // item is a raised lens, and it is on Note while the note lies over the page he came from; closed, it is back
        // on that page. The bar shows on the two lists only: a pushed screen has its own controls at the bottom, and
        // the keyboard takes its place. Both pages stay alive, so each keeps its scroll position.
        let page = model.tabs.page
        let showBar = !keyboard && model.selected.isEmpty && (page == .chat ? model.chatPath.isEmpty : model.deskPath.isEmpty)
        ZStack {
          stack.opacity(page == .desk ? 1 : 0).allowsHitTesting(page == .desk).accessibilityHidden(page != .desk)
          chats.opacity(page == .chat ? 1 : 0).allowsHitTesting(page == .chat).accessibilityHidden(page != .chat)
        }
        .modifier(NotePanel(open: Binding(get: { model.tabs.noteOpen }, set: { if !$0 { model.tabs.closeNote() } })))
        // a bar, not a plain inset: the lists' soft scroll edge reaches up to it
        .safeAreaBar(edge: .bottom, spacing: 0) {
          if showBar {
            TabPill(waiting: model.view?.fresh.count ?? 0, hasNote: hasNote, leaveDemo: model.demo ? { model.leaveDemo() } : nil) { t in
              let was = model.tabs.page
              // the page he is on, tapped again: back to its root. Chat always opens on its list (a chat has no bar)
              if model.tabs.tap(t) { withAnimation(.snappy) { model.path = [] } } else if t == .chat && was != .chat { model.chatPath = [] }
            }
          }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in keyboard = true }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in keyboard = false }
      }
    }
    .overlay { ToastHost() }
    .safeAreaInset(edge: .top, spacing: 0) { UpdateBanner() }
    .overlay { UpdateRequired() }
    .background(Ink.bg.ignoresSafeArea())
    // anything dropped onto the app goes onto the note (NoteDrop.swift): the note opens and shows it arrive
    .modifier(NoteDropTarget { if hSize == .regular { NotificationCenter.default.post(name: .trommiNoteOpen, object: nil) } else { model.tab = .note } })
  }
  private var stack: some View {
    NavigationStack(path: $model.deskPath) {
      DeskScreen().toolbarBackground(.hidden, for: .navigationBar).navigationDestination(for: Route.self) { r in Self.destination(r).toolbarBackground(.hidden, for: .navigationBar) }
    }
  }
  private var chats: some View {
    NavigationStack(path: $model.chatPath) {
      ChatsScreen().toolbarBackground(.hidden, for: .navigationBar).navigationDestination(for: Route.self) { r in Self.destination(r).toolbarBackground(.hidden, for: .navigationBar) }
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

/**
 * The iPhone's bar: Chat · Desk · Note in one clear glass pill. The drawings at a system tab icon's size and weight
 * (about 26 pt, the line 2.4 pt: an SF Symbol's medium to semibold); the three fill their 24-unit box differently, so
 * each has its own scale and the line is the same on all. The page he is on: full ink on a raised lens (brighter than
 * the pill, a soft shadow below it, nothing sunk in); the others a little muted.
 */
struct TabPill: View {
  /** The lit item is read from the model here, not handed in: the pill then follows every change of it by itself
   *  (build 21: handed in through the bar's closure it stayed on Desk while the note was open). */
  @EnvironmentObject var model: BoardModel
  let waiting: Int
  let hasNote: Bool
  /** The demo runs: its yellow mark stands at the pill's left as the way out (his word, 9 October: nothing of the
   *  demo floats over the top row any more). The tabs are narrower then, so both fit a 375 pt screen. */
  var leaveDemo: (() -> Void)? = nil
  let tap: (BoardModel.Tab) -> Void
  private var wide: CGFloat { leaveDemo == nil ? 84 : 66 }
  var body: some View {
    let on = model.tabs.lit
    HStack(spacing: 8) {
      if let leave = leaveDemo {
        Button(action: leave) {
          HStack(spacing: 6) {
            Image(systemName: "rectangle.portrait.and.arrow.right").font(.system(size: 15, weight: .bold))
            Text("Leave demo").font(Face.text(14, .bold)).lineLimit(1).fixedSize()
          }
          .foregroundStyle(Color(hex: 0x2d2406))
          .padding(.horizontal, 13).frame(height: 58)
          .background(Capsule().fill(Ink.yellow))
          .overlay(Capsule().strokeBorder(Color(hex: 0x2d2406), lineWidth: 1.6))
          .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Leave Demo")
      }
      HStack(spacing: 0) {
        item(.chat, on, "sketch:bubble", 39, 24, "Chat")
        item(.desk, on, "sketch:desk", 34, 24, waiting > 0 ? "Desk, \(waiting) waiting" : "Desk")
        // the web's corner note (sidebar.mjs NOTE_ICON): one note drawing on both
        item(.note, on, "sidebar:NOTE_ICON", 38, 52, hasNote ? "Note, written" : "Note")
      }
      // the lens: one capsule that is always there, moved to the lit item (no view that comes and goes, no matched
      // geometry: nothing that can be left behind on the item before)
      .background(alignment: .leading) {
        Capsule().fill(Ink.tabLens).shadow(color: .black.opacity(0.18), radius: 7, y: 2)
          .overlay(Capsule().strokeBorder(Ink.fg.opacity(0.08), lineWidth: 0.5))
          .frame(width: wide, height: 50)
          .offset(x: CGFloat(ShellTabs.index(on)) * wide)
          .allowsHitTesting(false)
      }
      .padding(4)
      .glass(Capsule())
      .accessibilityElement(children: .contain).accessibilityAddTraits(.isTabBar)
    }
    .bottomChrome()
    .animation(.snappy, value: on)
    // where the system's tab bar lies: the lower edge 23 pt over the screen's bottom edge (it stood 36 pt over it)
    .padding(.top, 6).padding(.bottom, bottomSink(23))
  }
  /** One item: its drawing `side` pt wide in a view box of `box` units, the line 2.4 pt on all. */
  private func item(_ t: BoardModel.Tab, _ on: BoardModel.Tab, _ key: String, _ side: CGFloat, _ box: CGFloat, _ label: String) -> some View {
    let sel = on == t
    return Button { tap(t) } label: {
      // the note keeps its own inks (yellow paper, the page's ink), so it is muted as a whole
      PenMark(key, color: Ink.fg.opacity(sel || t == .note ? 1 : 0.6), width: 2.4 * box / side).frame(width: side, height: side)
        .opacity(t == .note && !sel ? 0.6 : 1)
        .frame(width: wide, height: 50)
        .overlay {
          if t == .desk && waiting > 0 {
            Text("\(waiting)").font(Face.text(11, .bold)).foregroundStyle(Ink.bg).padding(.horizontal, 5).frame(minWidth: 18, minHeight: 18).background(Capsule().fill(Ink.fg)).offset(x: 18, y: -13)
          }
          if t == .note && hasNote { Circle().fill(Ink.fg).frame(width: 7, height: 7).offset(x: -17, y: -15) }
        }
        .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label).accessibilityAddTraits(sel ? .isSelected : [])
  }
}

/** The pills at the top of the iPhone's root pages (his word, 9 October): the place pill at the left, the page's own
 *  buttons at the right, each a clear glass capsule floating on the content. No navigation bar, no band, no hairline.
 *  The pills are a safeAreaBar, so the system's soft scroll edge runs under them and the status bar: the content fades
 *  out towards the top instead of colliding with the clock and the pills (his word on build 21); the same soft edge
 *  at the bottom, above the tab pill. */
extension View {
  func topPills<T: View>(@ViewBuilder _ trailing: () -> T) -> some View {
    self.toolbar(.hidden, for: .navigationBar)
      .safeAreaBar(edge: .top, spacing: 0) {
        HStack(spacing: 10) { MenuPill(); Spacer(minLength: 8); trailing() }.padding(.horizontal, 16).padding(.top, 4).padding(.bottom, 6)
      }
      .scrollEdgeEffectStyle(.soft, for: [.top, .bottom])
  }
  /** The same row on a pushed screen (a chat, a card's page): the back circle at the left, the screen's own pill in the
   *  middle (centred between the two circles), its "⋯" at the right; the row's measures are topPills'. No navigation
   *  bar, so no band and no hairline: the content scrolls under the row and the status bar and fades out softly. The
   *  swipe from the left edge still goes back (PopGesture: UIKit turns it off with the bar). */
  func pushedPills<C: View, T: View>(@ViewBuilder center: () -> C, @ViewBuilder trailing: () -> T) -> some View {
    self.toolbar(.hidden, for: .navigationBar)
      .safeAreaBar(edge: .top, spacing: 0) {
        HStack(spacing: 10) { BackPill(); Spacer(minLength: 0); trailing() }
          .overlay { center().padding(.horizontal, 54) }
          .padding(.horizontal, 16).padding(.top, 4).padding(.bottom, 6)
      }
      .scrollEdgeEffectStyle(.soft, for: [.top, .bottom])
      .background { PopGesture().frame(width: 0, height: 0).accessibilityHidden(true) }
  }
  /** A round glass button of the top row (44 pt, as the place pill is tall). */
  func pillCircle() -> some View {
    self.frame(width: 44, height: 44).glass(Circle(), interactive: true).contentShape(Circle())
  }
}

/** Back, as a round glass button at the left of a pushed screen's row. */
struct BackPill: View {
  @EnvironmentObject var model: BoardModel
  var body: some View {
    Button { if !model.path.isEmpty { model.path.removeLast() } } label: {
      Image(systemName: "chevron.left").font(.system(size: 18, weight: .semibold)).foregroundStyle(Ink.fg).pillCircle()
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Back")
    .accessibilityShowsLargeContentViewer { Label("Back", systemImage: "chevron.left") }
  }
}

/**
 * The swipe from the left edge goes back although the navigation bar is hidden: the navigation controller's own
 * recogniser is switched on and asked by PopGate, which lets it begin only when there is a screen to go back to (at
 * the root it must not begin: the stack would hang).
 */
struct PopGesture: UIViewControllerRepresentable {
  func makeUIViewController(context: Context) -> Holder { Holder() }
  func updateUIViewController(_ c: Holder, context: Context) {}
  final class Holder: UIViewController {
    override func viewDidAppear(_ animated: Bool) {
      super.viewDidAppear(animated)
      guard let g = navigationController?.interactivePopGestureRecognizer else { return }
      g.delegate = PopGate.shared
      g.isEnabled = true
    }
  }
}
final class PopGate: NSObject, UIGestureRecognizerDelegate {
  static let shared = PopGate()
  func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
    var r: UIResponder? = g.view
    while let x = r { if let nav = x as? UINavigationController { return nav.viewControllers.count > 1 }; r = x.next }
    return false
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
      if model.demo {
        Section("Demo") {
          Button { model.demoScreens = true } label: { Label("All Screens", systemImage: "rectangle.grid.2x2") }
          Button { model.leaveDemo() } label: { Label("Leave Demo", systemImage: "rectangle.portrait.and.arrow.right") }
        }
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
        if !model.demo { Button { model.startDemo() } label: { Label("Demo", systemImage: "play.rectangle") } }
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

/**
 * The passing word, on every device ONE ordinary toast of the app: a clear glass capsule at the bottom, centred, just
 * above whatever stands there (the tab pill, a composer, the selection bar, the keyboard under them: BottomChrome),
 * else above the home indicator. It never covers the status bar or the buttons at the top. The words at the left; an
 * Undo is the round button at the right, the undo arrow in a ring that runs down in 5 s (a second Undo while it runs
 * counts up: "3"). A second toast takes the first one's place in the same capsule. It slides in from below and fades;
 * a tap on the words or a swipe down lets it go; VoiceOver announces it and reads the button as "Undo: …".
 * (The Dynamic Island is the system's, for Live Activities: the app does not imitate it. His word, 9 October.)
 */
struct ToastHost: View {
  @EnvironmentObject var model: BoardModel
  @ObservedObject private var chrome = BottomChrome.shared
  @State private var drag: CGFloat = 0
  @State private var count = 1
  @State private var lastUndoAt: Date? = nil
  @State private var progress: CGFloat = 1
  static let undoSeconds: Double = 5
  var body: some View {
    GeometryReader { g in
      // this view ends at the safe area's bottom (the home indicator, or the keyboard); a control above that lifts it
      let floor = g.frame(in: .global).maxY
      let lift = max(0, floor - (chrome.top ?? floor))
      VStack(spacing: 0) {
        Spacer(minLength: 0)
        if let t = model.toast {
          capsule(t)
            .task(id: t.id) {
              #if canImport(UIKit)
              AccessibilityNotification.Announcement(t.undo != nil ? "\(t.head). Undo available." : [t.head, t.line].filter { !$0.isEmpty }.joined(separator: ". ")).post()
              #endif
              // (a demo screen keeps its toast a minute: the screenshot of the state)
              let secs = ProcessInfo.processInfo.environment["TROMMI_SCREEN"] != nil ? 60 : t.undo != nil ? Self.undoSeconds : 3.5
              progress = 1
              withAnimation(.linear(duration: secs)) { progress = 0 }
              try? await Task.sleep(nanoseconds: UInt64(secs * 1_000_000_000))
              if model.toast?.id == t.id { model.toast = nil; count = 1; lastUndoAt = nil }
            }
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
      }
      .frame(maxWidth: .infinity)
      .padding(.bottom, lift + 8)
      .animation(.spring(response: 0.35, dampingFraction: 0.85), value: model.toast)
      .animation(.snappy, value: lift)
    }
    .onChange(of: model.toast) { old, new in
      guard let n = new, n.undo != nil else { return }
      if let o = old, o.undo != nil, o.id != n.id, let at = lastUndoAt, Date().timeIntervalSince(at) < Self.undoSeconds { count += 1 } else { count = 1 }
      lastUndoAt = Date()
    }
  }
  private func capsule(_ t: Toast) -> some View {
    HStack(spacing: 10) {
      HStack(spacing: 8) {
        if t.alert { Image(systemName: "exclamationmark.circle").foregroundStyle(Ink.urgCritical) }
        (Text(t.head).font(Face.text(15, .semibold)).foregroundColor(t.alert ? Ink.urgCritical : Ink.fg)
          + Text(t.line.isEmpty ? "" : "  \(t.line)").font(Face.text(14)).foregroundColor(Ink.muted))
          .lineLimit(1).truncationMode(.tail)
      }
      .frame(minHeight: 44)
      .contentShape(Rectangle())
      .onTapGesture { model.toast = nil; count = 1 }
      .accessibilityElement(children: .combine)
      if let undo = t.undo {
        Spacer(minLength: 2)
        if count > 1 { Text("\(count)").font(Face.text(14, .semibold)).foregroundStyle(Ink.muted).accessibilityHidden(true) }
        Button { model.toast = nil; count = 1; Task { await undo() } } label: {
          ZStack {
            Circle().fill(Ink.fg.opacity(0.08))
            Circle().trim(from: 0, to: progress).stroke(Ink.fg, style: StrokeStyle(lineWidth: 2, lineCap: .round)).rotationEffect(.degrees(-90)).padding(1)
            Image(systemName: "arrow.uturn.backward").font(.system(size: 14, weight: .bold)).foregroundStyle(Ink.fg)
          }
          .frame(width: 34, height: 34).frame(width: 44, height: 44).contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(count > 1 ? "Undo: \(t.head), \(count) actions" : "Undo: \(t.head)")
      }
    }
    .padding(.leading, 18).padding(.trailing, t.undo != nil ? 3 : 18)
    .glass(Capsule())
    .frame(maxWidth: 380)
    .padding(.horizontal, 16)
    .offset(y: max(0, drag))
    .gesture(DragGesture(minimumDistance: 6).onChanged { drag = $0.translation.height }.onEnded { v in
      withAnimation(.snappy) { if v.translation.height > 24 { model.toast = nil; count = 1 }; drag = 0 }
    })
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
 * The note on the iPhone: a full page of yellow paper over the list he came from, edge to edge, up under the status
 * bar and on behind the tab pill (his word, 9 October: "doch Full screen, dann schöner"; before it was a half-height
 * panel over the dimmed page). It lies inside the shell's content, so the tab pill stays and is lit on Note; a tap on
 * Note or another tab, or a drag down on the handle, leaves it. The draft stays (NoteScreen keeps it on the note object).
 *
 * With the keyboard up the whole note stays above it (build 20: the paperclip · bin · send row was half behind the
 * keyboard). Two causes: the panel had a fixed height (55 % of what the keyboard left, at least 320 pt) that the
 * note's content did not fit into, so its last row was cut off; and the content's bottom lay about 14 pt below the
 * keyboard's top edge (the keyboard inset of the content is not the keyboard's frame). Now the note takes all the room,
 * its words give way (NoteScreen), and what the keyboard's own frame still covers of it (`under`) is kept free at the
 * bottom.
 */
struct NotePanel: ViewModifier {
  @Binding var open: Bool
  @State private var drag: CGFloat = 0
  /** The keyboard's top edge on the screen while it shows (its own frame, not the safe area made from it). */
  @State private var keyboardTop: CGFloat? = nil
  func body(content: Content) -> some View {
    content.overlay {
      if open {
        GeometryReader { geo in
          // what the keyboard covers of the content although the safe area says it is free, and a little air
          let under = keyboardTop.map { max(0, geo.frame(in: .global).maxY - $0) + 6 } ?? 0
          VStack(spacing: 0) {
            Capsule().fill(Ink.noteInk.opacity(0.35)).frame(width: 38, height: 5).padding(.top, 8).padding(.bottom, 9)
              .frame(maxWidth: .infinity).contentShape(Rectangle())
              .gesture(DragGesture().onChanged { drag = max(0, $0.translation.height) }.onEnded { v in
                withAnimation(.snappy) { if v.translation.height > 80 || v.predictedEndTranslation.height > 200 { hideKeyboard(); open = false }; drag = 0 }
              })
              .accessibilityLabel("Close the note").accessibilityAddTraits(.isButton)
              .accessibilityAction { open = false }
            NoteScreen(onDone: { withAnimation(.snappy) { open = false } })
          }
          .padding(.bottom, under)
          .frame(width: geo.size.width, height: geo.size.height, alignment: .top)
          .background(Ink.noteYellow.ignoresSafeArea())
          .offset(y: drag)
        }
        .transition(.move(edge: .bottom))
      }
    }
    .animation(.snappy, value: open)
    .animation(.snappy, value: keyboardTop)
    // every way the note closes (sent, thrown away, a tab, the handle) puts the keyboard away: the bar comes back
    .onChange(of: open) { _, now in if !now { hideKeyboard() } }
    #if canImport(UIKit)
    .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { n in
      guard let f = n.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
      keyboardTop = NotePanel.keyboardTop(frame: f, screen: UIScreen.main.bounds.height)
    }
    .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in keyboardTop = nil }
    #endif
  }
  /** The top edge of a keyboard that is on the screen; nil when it is away (its frame below the screen, or empty). */
  static func keyboardTop(frame f: CGRect, screen: CGFloat) -> CGFloat? {
    f.height < 1 || f.minY >= screen - 1 ? nil : f.minY
  }
}
