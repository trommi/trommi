// ChatList.swift: the Chat page's list (his pick, 9 October). The hierarchy: on All desks each desk is a section head
// (its drawing, its name, how many are at work); a top session is the prominent row (drawing with the crown, name, one
// line of what it does); its helpers lie under it folded into one stack, as in the web's sidebar (sidebar.mjs row,
// TrommiClient UnitStack): their drawings stacked (seven at most, the stopped ones first), how many they are, how many
// wait on him or are at work; the main's row says what waits in the whole stack. A tap on the stack unfolds the helpers
// (the ones at work, or with something waiting on him, first); which stacks are open is this phone's own and kept.
// No hairlines; the end of the list clears the floating tab bar.
// TROMMI_CHATLIST=1 at launch opens this page on a crowded demo room (DemoMode.swift ChatListDemo) for screenshots.
import SwiftUI
import TrommiClient
import TrommiCore

struct ChatsScreen: View {
  @EnvironmentObject var model: BoardModel
  /** The mains whose stack is unfolded, one id per line, kept on this phone (the web's localStorage "trommi-crowns-open"). */
  @AppStorage("trommi-stacks-open") private var openRaw = ""
  private var openStacks: Set<String> { Set(openRaw.split(separator: "\n").map(String.init)) }
  private func toggle(_ id: String) {
    var open = openStacks
    if open.contains(id) { open.remove(id) } else { open.insert(id) }
    openRaw = open.sorted().joined(separator: "\n")
  }

  private struct DeskGroup: Identifiable { let id: String; let name: String?; let tops: [DeskUnit]; let working: Int }

  var body: some View {
    let _ = RenderCount.body("ChatsScreen")
    let _ = model.version
    let v = model.view
    let units = v?.units ?? []
    let byId = Dictionary(units.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    let groups = makeGroups(v, model.desk, units, byId)
    List {
      ForEach(groups) { g in
        if let n = g.name {
          deskHead(n, working: g.working)
            .padding(.top, g.id == groups.first?.id ? 4 : 22).padding(.bottom, 2)
            .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
            .listRowBackground(Color.clear).listRowSeparator(.hidden)
        }
        ForEach(g.tops) { u in block(u, byId: byId) }
      }
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .environment(\.defaultMinListRowHeight, 1)
    // the last row ends clear of the floating tab bar
    .contentMargins(.bottom, 24, for: .scrollContent)
    .background(Ink.bg)
    .topPills { EmptyView() }
    .refreshable { await model.refresh() }
  }

  /** Grouped by desk on All Desks (the desks' order), one group otherwise; the crowned session first, then by what happened last. */
  private func makeGroups(_ v: DeskModel.View?, _ d: DeskModel?, _ units: [DeskUnit], _ byId: [String: DeskUnit]) -> [DeskGroup] {
    let list: [(String, String?)] = v?.all == true ? (d?.desks ?? []).map { ($0.id, Optional($0.name)) } : [(v?.deskId ?? "", nil)]
    return list.compactMap { id, name in
      let tops = units.filter { $0.parent == nil && (name == nil || (d?.deskOf($0.agent) ?? list.first?.0) == id) }.sorted { a, b in
        if a.agent.starred != b.agent.starred { return a.agent.starred }
        return a.agent.active > b.agent.active
      }
      if tops.isEmpty { return nil }
      let working = tops.reduce(0) { n, u in n + (u.online && u.running ? 1 : 0) + u.subs.filter { s in byId[s].map { $0.online && $0.running } ?? false }.count }
      return DeskGroup(id: id, name: name, tops: tops, working: working)
    }
  }

  /** At work, or something waits on him there: these helpers stay in view. */
  private func lively(_ u: DeskUnit) -> Bool { (u.online && u.running) || u.open > 0 || u.blocked != nil || model.unread(u.agent) }
  /** One line under the name: what it works on now, else its task. */
  private func line(_ u: DeskUnit) -> String {
    if u.online && u.running, let t = model.desk?.tasks.first(where: { $0.agent == u.id && $0.state == "working" }) { return t.label }
    return u.agent.task
  }

  private func deskHead(_ name: String, working: Int) -> some View {
    HStack(spacing: 10) {
      PenMark("sketch:desk", color: Ink.fg).frame(width: 22, height: 22)
      Text(name).font(Face.display(22, .bold)).foregroundStyle(Ink.fg).lineLimit(1)
      Spacer(minLength: 8)
      if working > 0 { Text("\(working) at work").font(Face.text(13, .medium)).foregroundStyle(Ink.muted) }
    }
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isHeader)
  }

  @ViewBuilder private func block(_ u: DeskUnit, byId: [String: DeskUnit]) -> some View {
    let subs = u.subs.compactMap { byId[$0] }
    if subs.isEmpty { topRow(u, shown: u) } else {
      let stack = UnitStack(main: u, subs: subs, unread: { model.unread($0) })
      let folded = !openStacks.contains(u.id)
      topRow(u, shown: stack.whole)
      stackRow(u, stack, folded: folded)
      if !folded { ForEach(unfolded(subs)) { s in helperRow(s) } }
    }
  }
  /** An unfolded stack's helpers: at work first, then with something waiting on him, the connected, the rest; each by what happened last. */
  private func unfolded(_ subs: [DeskUnit]) -> [DeskUnit] {
    func rank(_ s: DeskUnit) -> Int { s.online && s.running ? 0 : lively(s) ? 1 : s.online ? 2 : 3 }
    return subs.sorted { a, b in rank(a) != rank(b) ? rank(a) < rank(b) : a.agent.active > b.agent.active }
  }

  private func rowLook<V: View>(_ v: V, top: CGFloat, bottom: CGFloat) -> some View {
    v.listRowInsets(EdgeInsets(top: top, leading: 20, bottom: bottom, trailing: 20))
      .listRowBackground(Color.clear)
      .listRowSeparator(.hidden)
  }

  /** shown: what the row says waits and works: the session itself, or it with its helpers counted in (the web's "whole"). */
  private func topRow(_ u: DeskUnit, shown: DeskUnit) -> some View {
    let a = u.agent
    return rowLook(Button { model.chatPath = [.session(u.id)] } label: {
      HStack(spacing: 12) {
        AgentMark(agent: a, size: 40).opacity(u.online ? 1 : 0.6)
        VStack(alignment: .leading, spacing: 2) {
          Text(a.name).font(Face.text(17, .semibold)).foregroundStyle(u.online ? Ink.fg : Ink.muted).lineLimit(1)
          if !line(u).isEmpty { Text(line(u)).font(Face.text(14)).foregroundStyle(Ink.muted).lineLimit(1) }
        }
        Spacer(minLength: 6)
        trailing(shown)
      }
      .frame(minHeight: 56)
      .contentShape(Rectangle())
    }.buttonStyle(.plain), top: 8, bottom: 6)
  }

  private func helperRow(_ s: DeskUnit) -> some View {
    let a = s.agent
    let working = s.online && s.running
    return rowLook(Button { model.chatPath = [.session(s.id)] } label: {
      HStack(spacing: 10) {
        AgentMark(agent: a, size: 24, crown: false).opacity(s.online ? 1 : 0.55)
        VStack(alignment: .leading, spacing: 1) {
          Text(a.name).font(Face.text(15, .medium)).foregroundStyle(s.online ? Ink.fg : Ink.muted).lineLimit(1)
          if working { Text(line(s)).font(Face.text(13)).foregroundStyle(Ink.muted).lineLimit(1) }
        }
        Spacer(minLength: 6)
        trailing(s)
      }
      .padding(.leading, 52)
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }.buttonStyle(.plain), top: 1, bottom: 1)
  }

  /** On the right: what waits on him (tally, raised hand), else the breathing dot while it works, else a dot for news. */
  @ViewBuilder private func trailing(_ u: DeskUnit) -> some View {
    if u.blocked != nil || u.open > 0 { Badge(unit: u) }
    else if u.online && u.running { PulseDot() }
    else if model.unread(u.agent) { Circle().fill(Ink.stDone).frame(width: 8, height: 8).accessibilityLabel("New message") }
  }

  /** A main's helpers as one stack: their drawings lie stacked (a stopped one marked), how many they are, how many wait
   *  on him or are at work; a tap unfolds them. */
  private func stackRow(_ u: DeskUnit, _ stack: UnitStack, folded: Bool) -> some View {
    let words = stack.count == 1 ? "1 helper" : "\(stack.count) helpers"
    let state = stack.waiting > 0 ? "\(stack.waiting) waiting" : stack.working > 0 ? "\(stack.working) at work" : ""
    return rowLook(Button { withAnimation(.snappy) { toggle(u.id) } } label: {
      HStack(spacing: 10) {
        HStack(spacing: -9) {
          ForEach(Array(stack.lie.enumerated()), id: \.element.id) { i, s in
            AgentMark(agent: s.agent, size: 20, crown: false)
              .opacity(s.online ? 0.9 : 0.5)
              .padding(2).background(Circle().fill(Ink.bg))
              .overlay(alignment: .topTrailing) {
                if s.blocked != nil { Circle().fill(Ink.urgCritical).frame(width: 7, height: 7).overlay(Circle().stroke(Ink.bg, lineWidth: 1.5)) }
              }
              .zIndex(Double(UnitStack.edges - i))
          }
        }
        Text(words).font(Face.text(15, .medium)).foregroundStyle(Ink.muted).lineLimit(1).layoutPriority(1)
        Spacer(minLength: 6)
        if !state.isEmpty { Text(state).font(Face.text(13, .medium)).foregroundStyle(stack.waiting > 0 ? Ink.urgHigh : Ink.muted).lineLimit(1) }
        Image(systemName: "chevron.down").font(.system(size: 12, weight: .semibold)).foregroundStyle(Ink.faint)
          .rotationEffect(.degrees(folded ? 0 : 180))
      }
      .padding(.leading, 49)
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }.buttonStyle(.plain), top: 0, bottom: 4)
    .accessibilityLabel("\(u.agent.name): \(words)\(state.isEmpty ? "" : ", \(state)")")
    .accessibilityHint(folded ? "Unfolds them" : "Folds them")
  }
}
