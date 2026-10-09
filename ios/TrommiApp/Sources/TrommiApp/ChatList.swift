// ChatList.swift: the Chat page's list, calm as Messages' and WhatsApp's (his word, 9 October). One row per session:
// its drawing in a round tinted field (the crown as a small badge on it, a green dot while it works), its name and the
// time of what was said last on one line, under it two lines at most of what was said last (TrommiClient ChatTeaser),
// and at the right only what needs him: how many questions wait, the raised hand when it is stopped, a dot for unread
// words. A main's helpers are not rows at rest: their drawings (four at most, the stopped ones first, UnitStack) and
// "+N" stand at the end of the teaser's line; a tap there unfolds them, a second tap folds them; which are open is this
// phone's own and kept. Unfolded, the helpers are compact rows (a small field, name and time, one line of teaser, the
// dot or count at the end) that start at the main row's leading edge, not set in, and lie together on one quiet
// rounded surface in the main session's tone, directly under its row (HelperGroup). The main's row counts its helpers
// in. On All desks each desk is a quiet section head. Hairlines set in to where the text starts.
// TROMMI_CHATLIST=1 at launch opens this page on a crowded demo room (DemoMode.swift ChatListDemo) for screenshots.
import SwiftUI
import TrommiClient

struct ChatsScreen: View {
  @EnvironmentObject var model: BoardModel
  /** The mains whose helpers are unfolded, one id per line, kept on this phone. */
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
            .padding(.top, g.id == groups.first?.id ? 6 : 20).padding(.bottom, 4)
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

  /** At work, or something waits on him there. */
  private func lively(_ u: DeskUnit) -> Bool { (u.online && u.running) || u.open > 0 || u.blocked != nil || model.unread(u.agent) }

  /** A desk as a quiet section head: its name, and small at the right how many are at work there. */
  private func deskHead(_ name: String, working: Int) -> some View {
    HStack(spacing: 8) {
      Text(name).font(Face.text(13, .semibold, relativeTo: .footnote)).kerning(0.3).foregroundStyle(Ink.muted).lineLimit(1)
      Spacer(minLength: 8)
      if working > 0 { Text("\(working) at work").font(Face.text(12, relativeTo: .caption)).foregroundStyle(Ink.faint).lineLimit(1) }
    }
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isHeader)
  }

  @ViewBuilder private func block(_ u: DeskUnit, byId: [String: DeskUnit]) -> some View {
    let subs = u.subs.compactMap { byId[$0] }
    if subs.isEmpty { ChatRow(unit: u, shown: u) } else {
      let stack = UnitStack(main: u, subs: subs, unread: { model.unread($0) })
      let folded = !openStacks.contains(u.id)
      ChatRow(unit: u, shown: stack.whole, stack: stack, folded: folded, news: stack.waiting > 0) { withAnimation(.snappy) { toggle(u.id) } }
      if !folded { HelperGroup(main: u, subs: unfolded(subs)) }
    }
  }
  /** Unfolded helpers: at work first, then with something waiting on him, the connected, the rest; each by what happened last. */
  private func unfolded(_ subs: [DeskUnit]) -> [DeskUnit] {
    func rank(_ s: DeskUnit) -> Int { s.online && s.running ? 0 : lively(s) ? 1 : s.online ? 2 : 3 }
    return subs.sorted { a, b in rank(a) != rank(b) ? rank(a) < rank(b) : a.agent.active > b.agent.active }
  }
}

/**
 * One session in the Chat list. unit: the session (a tap opens its chat). shown: what the row says waits and works:
 * the session itself, or a main with its helpers counted in. stack: a main's helpers, drawn at the end of the teaser;
 * unfold: the tap on them. small: a helper under its unfolded main (a smaller field, one line of teaser), a line of
 * HelperGroup's surface and not a list row of its own.
 */
/**
 * A main's unfolded helpers: compact rows on one quiet rounded surface in the main session's tone at low strength (the
 * tone's wash, light and dark; no border, no stripe), directly under the main's row. The surface reaches 8 pt past the
 * list's margins, so a helper's small field starts at the main row's leading edge and its dot stands under the main's.
 * Hairlines between the rows only, set in to where the text starts.
 */
struct HelperGroup: View {
  let main: DeskUnit
  let subs: [DeskUnit]
  var body: some View {
    VStack(spacing: 0) {
      ForEach(Array(subs.enumerated()), id: \.element.id) { i, s in
        if i > 0 { Rectangle().fill(Ink.line).frame(height: 1).padding(.leading, 36 + 12) }
        ChatRow(unit: s, shown: s, small: true)
      }
    }
    .padding(.horizontal, 8).padding(.vertical, 2)
    .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Tone.color(hue: main.agent.hue, .wash).opacity(0.55)))
    .listRowInsets(EdgeInsets(top: 0, leading: 12, bottom: 10, trailing: 12))
    .listRowBackground(Color.clear)
    .listRowSeparator(.hidden)
  }
}

struct ChatRow: View {
  @EnvironmentObject var model: BoardModel
  @Environment(\.dynamicTypeSize) private var type
  let unit: DeskUnit
  let shown: DeskUnit
  var stack: UnitStack? = nil
  var folded = true
  /** One of the helpers has something for him (unread words count too). */
  var news = false
  var small = false
  var unfold: (() -> Void)? = nil

  var body: some View {
    let _ = model.version
    let a = unit.agent
    let side: CGFloat = small ? 36 : 50
    let teaser = ChatTeaser.of(model.desk?.messagesOf(agent: unit.id) ?? [], task: a.task)
    let when = teaser.ts.map { ChatTeaser.stamp($0) } ?? ""
    let working = shown.online && shown.running
    let row = HStack(spacing: 12) {
      Button { model.chatPath = [.session(unit.id)] } label: {
        HStack(spacing: 12) {
          picture(a, side: side, working: working)
          VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
              Text(a.name).font(Face.text(small ? 16 : 17, .semibold)).foregroundStyle(unit.online ? Ink.fg : Ink.muted).lineLimit(1)
              Spacer(minLength: 4)
              Text(when).font(Face.text(13, relativeTo: .footnote)).foregroundStyle(Ink.faint).lineLimit(1).layoutPriority(1)
            }
            Text(teaser.text.isEmpty ? " " : teaser.text).font(Face.text(15, relativeTo: .subheadline)).foregroundStyle(Ink.muted)
              .lineLimit(small || type > .xxLarge ? 1 : 2).multilineTextAlignment(.leading)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(label(a, teaser, when, working))
      if let s = stack, let unfold { helpers(s, unfold) }
      needs
    }
    if small { row.frame(minHeight: 52) } else {
      row
        .frame(minHeight: 76)
        .listRowInsets(EdgeInsets(top: 2, leading: 20, bottom: 2, trailing: 20))
        .listRowBackground(Color.clear)
        .listRowSeparatorTint(Ink.line)
        // (unfolded, its helpers' surface follows at once: no line between the row and it)
        .listRowSeparator(.hidden, edges: stack != nil && !folded ? .all : .top)
        // the hairline starts where the text starts, as in iOS lists
        .alignmentGuide(.listRowSeparatorLeading) { _ in side + 12 }
    }
  }

  /** The session's drawing as its picture: a round field in its tone; the crown and the working dot as small badges on it. */
  private func picture(_ a: Agent, side: CGFloat, working: Bool) -> some View {
    AgentMark(agent: a, size: side * 0.58, crown: false)
      .frame(width: side, height: side)
      .background(Circle().fill(Tone.color(hue: a.hue, .wash)))
      .opacity(unit.online ? 1 : 0.6)
      .overlay(alignment: .topLeading) {
        if a.starred { PenMark("crown").frame(width: side * 0.4, height: side * 0.29).rotationEffect(.degrees(-14)).offset(x: -3, y: -4) }
      }
      .overlay(alignment: .bottomTrailing) {
        if working { Circle().fill(Ink.stDone).frame(width: 11, height: 11).overlay(Circle().stroke(Ink.bg, lineWidth: 2)).offset(x: -1, y: -1) }
      }
      .accessibilityHidden(true)
  }

  /** A main's helpers at the end of its teaser: four small drawings at most (a stopped one marked), "+N" for the rest,
   *  a small chevron; a tap unfolds them under the row. */
  private func helpers(_ s: UnitStack, _ unfold: @escaping () -> Void) -> some View {
    let cut = s.inline(4)
    return Button(action: unfold) {
      HStack(spacing: 3) {
        HStack(spacing: -6) {
          ForEach(Array(cut.shown.enumerated()), id: \.element.id) { i, h in
            AgentMark(agent: h.agent, size: 15, crown: false)
              .opacity(h.online ? 0.9 : 0.5)
              .padding(1.5).background(Circle().fill(Ink.bg))
              .overlay(alignment: .topTrailing) {
                if h.blocked != nil { Circle().fill(Ink.urgCritical).frame(width: 6, height: 6).overlay(Circle().stroke(Ink.bg, lineWidth: 1)) }
              }
              .zIndex(Double(4 - i))
          }
        }
        if cut.more > 0 { Text("+\(cut.more)").font(Face.text(12, .medium, relativeTo: .caption)).foregroundStyle(Ink.muted).lineLimit(1).fixedSize() }
        Image(systemName: "chevron.down").font(.system(size: 9, weight: .bold)).foregroundStyle(Ink.faint).rotationEffect(.degrees(folded ? 0 : 180))
      }
      .frame(minHeight: 44, alignment: .bottom).padding(.bottom, 4)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(s.count == 1 ? "1 helper" : "\(s.count) helpers")
    .accessibilityHint(folded ? "Unfolds them" : "Folds them")
  }

  /** At the right, only what needs him: the raised hand when it is stopped, how many questions wait, a dot for unread words. */
  @ViewBuilder private var needs: some View {
    if shown.blocked != nil { Badge(unit: shown) }
    else if shown.open > 0 {
      Text("\(shown.open)").font(Face.text(13, .bold, relativeTo: .footnote)).foregroundStyle(Ink.bg).monospacedDigit()
        .padding(.horizontal, 6).frame(minWidth: 22, minHeight: 22).background(Capsule().fill(Ink.fg))
        .accessibilityLabel(shown.open == 1 ? "1 question waits" : "\(shown.open) questions wait")
    } else if model.unread(unit.agent) || news {
      Circle().fill(Ink.accent).frame(width: 10, height: 10).accessibilityLabel("New message")
    }
  }

  private func label(_ a: Agent, _ t: ChatTeaser, _ when: String, _ working: Bool) -> String {
    [a.name + (a.starred ? ", main session" : ""), working ? "working" : unit.online ? "" : "not connected", t.text, when].filter { !$0.isEmpty }.joined(separator: ". ")
  }
}
