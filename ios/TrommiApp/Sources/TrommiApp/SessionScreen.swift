// SessionScreen.swift: the conversation with one session (app/web/public/session.mjs), the app's core screen. The
// newest at the bottom and the view stays there while new words come in (or says "new ↓" when he has scrolled up);
// earlier pages load as he scrolls up, without the view jumping. A question where it was asked is its Desk row (answer
// it right there) or one line of what became of it; the agent's words with its light markdown, details and files; his
// own words on his side, a note as the yellow slip; the session's running work at the end. The composer: a field that
// grows, pictures and files, Send; above it whether the session hears.
import SwiftUI
import PhotosUI
#if canImport(UIKit)
import UIKit
import AVFoundation
#endif
import UniformTypeIdentifiers
import TrommiClient
import TrommiCore

let GROUP_GAP: UInt64 = 5 * 60_000
let WORKING_WINDOW: UInt64 = 10 * 60_000
let MAX_FILES = 12

struct SessionScreen: View {
  @EnvironmentObject var model: BoardModel
  let agentId: String
  @State private var onlyQuestions = false
  @Environment(\.horizontalSizeClass) private var hSize
  /** The view is at the newest message: it then follows what comes in, the keyboard and the composer's height. Only
   *  his own scrolling takes it away from there (read when a scroll ends), never a change of the content's height. */
  @State private var atBottom = true
  @State private var userScrolling = false
  /** He has scrolled here: only then do earlier pages load by themselves (the top row also appears for a moment while
   *  a chat opens, and the load then moved the view away from the newest message, build 20). */
  @State private var touched = false
  @State private var unseen = 0
  @State private var lastCount = 0
  @State private var loadingOlder = false
  @State private var topId: String?
  @State private var renaming = false
  @State private var name = ""
  @State private var drawings = false
  @State private var deleteAsk = false
  @State private var filesOpen = false
  var body: some View {
    let _ = RenderCount.body("SessionScreen")
    let _ = model.version
    if let d = model.desk, let a = d.byAgent[agentId] {
      let all = d.messagesOf(agent: agentId)
      let v = model.view
      let fresh = v?.fresh.filter { $0.agent == agentId } ?? []
      let freshIds = Set(fresh.map { $0.id } + (v?.reads.filter { $0.agent == agentId }.map { $0.id } ?? []))
      let msgs = onlyQuestions ? all.filter { $0.from == "event" && $0.kind == "asked" && freshIds.contains($0.cardId ?? "") } : all
      let askAt = Dictionary(all.filter { $0.from == "event" && $0.kind == "asked" && $0.cardId != nil }.map { ($0.cardId!, $0.id) }, uniquingKeysWith: { $1 })
      let older = d.hasOlder(agent: agentId)
      let tasks = d.tasks.filter { $0.agent == agentId }
      let permissions = v?.fresh.filter { $0.agent == agentId && $0.kind == "permission" } ?? []
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 0) {
            if older && !onlyQuestions {
              Button { loadOlder(proxy, first: msgs.first?.id) } label: {
                HStack(spacing: 8) { if loadingOlder { ProgressView().controlSize(.small) }; Text("Earlier messages").font(Face.text(14, .semibold)) }
                  .foregroundStyle(Ink.accent).frame(maxWidth: .infinity).padding(.vertical, 14)
              }
              .onAppear { if touched { loadOlder(proxy, first: msgs.first?.id) } }
            }
            if msgs.isEmpty && !older { EmptyChat(agent: a) }
            ForEach(Array(msgs.enumerated()), id: \.element.id) { i, m in
              let prev = i > 0 ? msgs[i - 1] : nil
              if prev == nil ? !older : !sameDay(prev!.ts, m.ts) { DayLine(ts: m.ts) }
              row(m, prev: prev, askAt: askAt, freshIds: freshIds, agent: a)
                .id(m.id)
            }
            ForEach(permissions) { c in DeskRow(card: c, agent: a, inSession: true).padding(.vertical, 6) }
            SessionStatus(agent: a, tasks: tasks, messages: all)
            Color.clear.frame(height: 1).id("bottom")
          }
          .padding(.horizontal, 14).padding(.top, 6)
          .frame(maxWidth: 760).frame(maxWidth: .infinity)
        }
        .defaultScrollAnchor(.bottom)
        // where he is, read whenever a scroll begins or ends (his finger, the run-out, our own scroll to the end)
        .onScrollPhaseChange { _, new, context in
          userScrolling = new == .tracking || new == .interacting || new == .decelerating
          if userScrolling { touched = true }
          if new == .animating { return }   // (on its way, e.g. to a new message: where it lands is read when it ends)
          let g = context.geometry
          atBottom = g.contentOffset.y + g.containerSize.height - g.contentInsets.bottom >= g.contentSize.height - 80
          if atBottom { unseen = 0 }
        }
        // at the newest message it stays there: when the content grows (a message, a picture that loads, rows measured
        // late), and when the keyboard or a taller composer takes room at the bottom
        .onScrollGeometryChange(for: [CGFloat].self, of: { g in [g.contentSize.height.rounded(), g.containerSize.height.rounded(), g.contentInsets.bottom.rounded()] }) { _, _ in
          if atBottom && !userScrolling { proxy.scrollTo("bottom", anchor: .bottom) }
        }
        .scrollDismissesKeyboard(.interactively)
        // a tap in the conversation puts the keyboard away (Messages)
        .simultaneousGesture(TapGesture().onEnded { hideKeyboard() })
        .refreshable { await model.refresh() }
        .onChange(of: all.count) { old, new in
          if new > old {
            if atBottom || all.last?.from == "user" { withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo("bottom", anchor: .bottom) } }
            else { unseen += new - old }
          }
        }
        .overlay(alignment: .bottom) {
          if unseen > 0 && !atBottom {
            Button { atBottom = true; withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }; unseen = 0 } label: {
              HStack(spacing: 6) { Text(unseen == 1 ? "1 new" : "\(unseen) new").font(Face.text(14, .semibold)); Image(systemName: "arrow.down") }
                .foregroundStyle(Ink.fg).padding(.horizontal, 14).padding(.vertical, 8).glass(Capsule(), interactive: true)
            }.padding(.bottom, 8)
          }
        }
        .bottomBar {
          // the composer stays at the bottom (Messages, WhatsApp): a tap in it brings the keyboard; no tab bar in a chat
          VStack(spacing: 0) {
            SessionLinkNote(agent: a, messages: all)
            Composer(placeholder: composeWords(a), agent: a.id, onSent: { atBottom = true; withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } })
          }
        }
        // the top row: back, the session's name as a glass pill (its menu), "⋯"; no bar, a soft edge above and below
        .pushedPills { header(a, d) } trailing: { more(a, d, freshCount: fresh.count) }
        .onAppear { lastCount = all.count; atBottom = true; proxy.scrollTo("bottom", anchor: .bottom); model.markRead(a) }
        .onChange(of: model.version) { _, _ in model.markRead(a) }
        // what a catch-up brought as headers only (the app was away, the hub restarted): filled while the chat is open
        .task(id: model.version) { try? await Task.sleep(nanoseconds: 150_000_000); await model.loadNewer(agent: a.id) }
      }
      .background(Ink.bg.ignoresSafeArea())
      .alert("Rename Session", isPresented: $renaming) {
        TextField("Name", text: $name)
        Button("Save") { model.editSession(a, ["name": .str(String(name.prefix(60)))]) }
        Button("Cancel", role: .cancel) {}
      }
      .sheet(isPresented: $drawings) { DrawingPicker(agent: a) }
      .sheet(isPresented: $filesOpen) { SessionFiles(agentId: a.id) }
      .confirmationDialog("Delete \(a.name)?", isPresented: $deleteAsk, titleVisibility: .visible) {
        Button("Delete", role: .destructive) { model.deleteSession(a) }
      } message: { Text("Its connector is removed from the room and the session moves to the archive. Open questions are shredded.") }
    } else {
      Text("This session is not on the board.").font(Face.text(16)).foregroundStyle(Ink.muted).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
  }

  private func sameDay(_ a: UInt64, _ b: UInt64) -> Bool {
    Calendar.current.isDate(Date(timeIntervalSince1970: Double(a) / 1000), inSameDayAs: Date(timeIntervalSince1970: Double(b) / 1000))
  }
  private func loadOlder(_ proxy: ScrollViewProxy, first: String?) {
    guard !loadingOlder else { return }
    loadingOlder = true
    atBottom = false   // (the view stays with the message that was at the top, not with the newest)
    Task {
      await model.loadOlder(agent: agentId)
      // keep the message that was at the top where it was
      if let f = first { proxy.scrollTo(f, anchor: .top) }
      loadingOlder = false
    }
  }

  @ViewBuilder private func row(_ m: Message, prev: Message?, askAt: [String: String], freshIds: Set<String>, agent: Agent) -> some View {
    if m.from == "event" && m.kind == "asked", let cid = m.cardId, let c = model.card(cid) {
      if askAt[cid] == m.id && freshIds.contains(cid) && c.status == "open" && c.withAgent == nil {
        DeskRow(card: c, agent: agent, inSession: true).padding(.vertical, 6)
      } else {
        QuestionLine(card: c, message: m, here: askAt[cid] == m.id).padding(.vertical, 3)
      }
    } else {
      let cont = prev.map { p in p.from == m.from && sameDay(p.ts, m.ts) && (m.from == "event" || (m.ts > p.ts ? m.ts - p.ts : 0) < GROUP_GAP) } ?? false
      if m.from == "event", ["decided", "done", "shredded"].contains(m.kind ?? ""), let cid = m.cardId, askAt[cid] != nil {
        EmptyView()   // (what became of a question is said by its line where it was asked)
      } else {
        MessageView(message: m, cont: cont).padding(.top, cont ? 2 : 10)
      }
    }
  }

  private func composeWords(_ a: Agent) -> String {
    let link = linkOf(a)
    if link?.state == "cut" { return "It cannot hear you right now. What you write waits for it" }
    if link?.state == "gone" { return "It is gone. What you write waits for it" }
    if link?.state == "asleep" || link?.state == "oncall" { return "Reaches the agent on its next step" }
    return "Message to the agent"
  }

  /** The title: the session's drawing and name ▾; a glass menu of the desk's other sessions to switch to (the crowned first, then by activity). */
  private func header(_ a: Agent, _ d: DeskModel) -> some View {
    let stopped = d.blockedOf(a), quiet = stopped == nil ? d.quietOf(a) : nil
    let working = a.online && d.tasks.contains { $0.agent == a.id && $0.state == "working" }
    let crown = d.crownOf(desk: model.deskId)
    let others = (model.view?.units ?? []).map { $0.agent }.sorted { x, y in
      if (x.id == crown?.id) != (y.id == crown?.id) { return x.id == crown?.id }
      return x.active > y.active
    }
    return Menu {
      ForEach(others) { o in
        Button {
          var p = model.path
          if !p.isEmpty { p[p.count - 1] = .session(o.id) } else { p = [.session(o.id)] }
          model.path = p
        } label: {
          Label { Text(model.unread(o) ? "\(o.name) ·" : o.name) } icon: { if o.id == a.id { Image(systemName: "checkmark") } else if o.id == crown?.id { Image(systemName: "crown") } }
        }
      }
    } label: {
      // one glass bubble, centred (his word, 8 October): the drawing, the name, ▾; how it hears is said below, by the
      // composer (SessionLinkNote), a stop by a red dot here
      HStack(spacing: 7) {
        ZStack { if working { WorkingRing(working: true, color: Tone.color(hue: a.hue, .mid)).frame(width: 30, height: 30) }; AgentMark(agent: a, size: 22) }
        Text(a.name).font(Face.display(17, .bold)).foregroundStyle(Ink.fg).lineLimit(1).truncationMode(.middle)
        if stopped != nil { Circle().fill(Ink.urgCritical).frame(width: 7, height: 7) }
        Image(systemName: "chevron.down").font(.system(size: 11, weight: .semibold)).foregroundStyle(Ink.muted)
      }
      .padding(.horizontal, 14).frame(height: 44)
      .glass(Capsule(), interactive: true)
      .contentShape(Capsule())
    }
    .accessibilityShowsLargeContentViewer { Label(a.name, systemImage: "bubble.left") }
    .accessibilityLabel(stopped.map { "\(a.name), stopped: \($0.1). Switch chat" } ?? "\(a.name): switch chat")
    .accessibilityHint(quiet ?? "")
  }
  private func more(_ a: Agent, _ d: DeskModel, freshCount: Int) -> some View {
    Menu {
      Toggle(isOn: $onlyQuestions) { Label(freshCount > 0 ? "Questions Only (\(freshCount))" : "Questions Only", systemImage: "questionmark.circle") }
      Button { filesOpen = true } label: { Label("Files", systemImage: "paperclip") }
      Button { name = a.label.isEmpty ? a.name : a.label; renaming = true } label: { Label("Rename…", systemImage: "pencil") }
      Button { drawings = true } label: { Label("Change Icon…", systemImage: "scribble") }
      Button { model.star(a, !a.starred) } label: { Label(a.starred ? "Remove Main Session" : "Make Main Session", systemImage: "crown") }
      let others = d.desks.filter { $0.id != d.deskOf(a) }
      if a.parent == nil && !others.isEmpty {
        Menu { ForEach(others) { desk in Button(desk.name) { model.editSession(a, ["desk": .str(desk.id)]) } } } label: { Label("Move to Desk…", systemImage: "rectangle.stack") }
      }
      Button { model.editSession(a, ["archived": .bool(!a.archived)]) } label: { Label(a.archived ? "Unarchive" : "Archive", systemImage: "archivebox") }.disabled(a.online && !a.archived)
      if !a.own { Divider(); Button(role: .destructive) { deleteAsk = true } label: { Label("Delete…", systemImage: "trash") } }
    } label: { Image(systemName: "ellipsis").font(.system(size: 18, weight: .semibold)).foregroundStyle(Ink.fg).pillCircle() }
    .accessibilityLabel("More")
    .accessibilityShowsLargeContentViewer { Label("More", systemImage: "ellipsis") }
  }
}

// ---- one message --------------------------------------------------------------------------------------------

struct DayLine: View {
  let ts: UInt64
  var body: some View {
    let d = Date(timeIntervalSince1970: Double(ts) / 1000)
    let label: String = {
      if Calendar.current.isDateInToday(d) { return "Today" }
      if Calendar.current.isDateInYesterday(d) { return "Yesterday" }
      let f = DateFormatter(); f.locale = Locale(identifier: "en_GB"); f.dateFormat = "EEEE d MMMM"; return f.string(from: d)
    }()
    HStack(spacing: 10) {
      Rectangle().fill(Ink.line).frame(height: 1)
      Text(label).font(Face.text(12, .semibold)).foregroundStyle(Ink.faint).fixedSize()
      Rectangle().fill(Ink.line).frame(height: 1)
    }.padding(.vertical, 14)
  }
}
func clockOf(_ ts: UInt64) -> String { let f = DateFormatter(); f.dateFormat = "HH:mm"; return f.string(from: Date(timeIntervalSince1970: Double(ts) / 1000)) }

let EVENT_LABEL = ["asked": "New question", "info": "To read", "decided": "Answered", "done": "Done", "reopened": "Taken back", "revised": "Question revised", "trusted": Words.trust,
                   "snoozed": Words.later, "handed": "With the agent", "shredded": "Shredded", "read": "Read"]

/** A question where it was asked, when it is not waiting here: one quiet line of what became of it. */
struct QuestionLine: View {
  @EnvironmentObject var model: BoardModel
  let card: DeskCard
  let message: Message
  let here: Bool
  var body: some View {
    let picked = card.options.filter { card.choices.contains($0.key) }.map { $0.label }.joined(separator: ", ")
    let (kind, text): (String, String) = !here ? ("asked", "")
      : card.status == "decided" || card.settled ? (card.trusted ? "trusted" : "decided", picked.isEmpty ? (card.trusted ? (card.advisedLabels.isEmpty ? "your call" : card.advisedLabels) : "") : picked)
      : card.status == "shredded" ? ("shredded", "")
      : card.status != "open" ? ("done", card.summary)
      : card.withAgent != nil ? ("handed", "") : card.snoozedUntil != nil ? ("snoozed", "") : ("asked", "")
    EventRow(kind: kind, about: card.title.isEmpty ? message.text : card.title, text: text == card.title ? "" : text, ts: message.ts, number: card.number) {
      model.path.append(.card(card.id))
    }
  }
}
struct EventRow: View {
  let kind: String
  let about: String
  let text: String
  let ts: UInt64
  var number: Int? = nil
  var open: (() -> Void)? = nil
  var body: some View {
    Button { open?() } label: {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Image(systemName: icon(kind)).font(.system(size: 13, weight: .medium)).foregroundStyle(tint(kind)).frame(width: 18)
        VStack(alignment: .leading, spacing: 2) {
          HStack(spacing: 6) {
            Text((EVENT_LABEL[kind] ?? "Board").uppercased()).font(Face.text(11, .bold)).kerning(1).foregroundStyle(Ink.muted)
            Text(about).font(Face.text(14)).foregroundStyle(Ink.muted).lineLimit(1)
          }
          if !text.isEmpty { Text(text).font(Face.text(15, .medium)).foregroundStyle(Ink.fg).lineLimit(2) }
        }
        Spacer(minLength: 4)
        Text(clockOf(ts)).font(Face.text(11)).foregroundStyle(Ink.faint)
      }
      .padding(.vertical, 4).contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(open == nil)
  }
  private func icon(_ k: String) -> String {
    switch k {
    case "decided", "trusted": return "checkmark.circle"
    case "done", "read": return "checkmark.seal"
    case "shredded": return "trash"
    case "reopened": return "arrow.uturn.backward"
    case "revised": return "pencil.circle"
    case "snoozed": return "zzz"
    case "handed": return "gearshape"
    case "info": return "doc.text"
    default: return "questionmark.circle"
    }
  }
  private func tint(_ k: String) -> Color { k == "asked" ? Ink.urgHigh : k == "decided" || k == "done" || k == "read" ? Ink.accent : Ink.muted }
}

struct MessageView: View {
  @EnvironmentObject var model: BoardModel
  let message: Message
  var cont = false
  var inCard = false
  @State private var picture: Int? = nil
  var body: some View {
    let _ = RenderCount.body("MessageView")
    let m = message
    Group {
      if m.from == "event" {
        let c = m.cardId.flatMap { model.card($0) }
        EventRow(kind: m.kind ?? "asked", about: c?.title ?? m.text, text: eventText(m, c), ts: m.ts, number: c?.number, open: inCard || c == nil ? nil : { model.path.append(.card(c!.id)) })
      } else if m.itemState != "loaded" && m.itemState != "pruned" {
        HStack { if m.from == "user" { Spacer(minLength: 40) }; UnsupportedLine(what: "message").frame(maxWidth: 420); if m.from != "user" { Spacer(minLength: 40) } }
      } else if m.from == "user", let deed = Self.deed(m) {
        // a hand-back, a take-back, What??: what he DID, not what he said. The words that went to the session with it
        // are the machine's (Words.handBackText …): a quiet centred line stands for them. What he wrote himself with a
        // hand-back stays his bubble under the line.
        VStack(spacing: 6) {
          deedLine(deed, m)
          if !Self.bare(m) { userMessage(m) }
        }
      } else if m.from == "user" {
        userMessage(m)
      } else {
        agentMessage(m)
      }
    }
  }
  /** A message of his that is a deed on a card, by its marker in the content (present_card, hand_back, explain), in
   *  the words of the web's card talk; nil for a plain message. */
  static func deed(_ m: Message) -> (word: String, icon: String)? {
    if m.present { return ("You took it back", "arrow.uturn.forward") }
    if m.handback { return ("You handed it back", "arrow.uturn.backward") }
    if m.explain { return ("You asked for an explanation", "questionmark") }
    return nil
  }
  /** Nothing of his own in it: only the words the app sends along for the session. */
  static func bare(_ m: Message) -> Bool {
    let t = m.text.trimmingCharacters(in: .whitespacesAndNewlines)
    let own = !(t.isEmpty || m.present || (m.handback && t == Words.handBackText) || (m.explain && t == Words.explainText))
    return !own && m.attachments.isEmpty && m.marks.isEmpty && m.copiedCards.isEmpty
  }
  /** The quiet line of a deed: centred, no bubble, the time behind it; outside the card's page it names the card and
   *  opens it. */
  private func deedLine(_ deed: (word: String, icon: String), _ m: Message) -> some View {
    let c = inCard ? nil : m.cardId.flatMap { model.card($0) }
    return Button { if let c = c { model.path.append(.card(c.id)) } } label: {
      HStack(spacing: 6) {
        Image(systemName: deed.icon).font(.system(size: 10, weight: .semibold))
        Text(deed.word).font(Face.text(12, .semibold))
        if let c = c { Text(c.title).font(Face.text(12)).lineLimit(1).truncationMode(.tail) }
        if m.pending { Image(systemName: "clock").font(.system(size: 10)) } else { Text(clockOf(m.ts)).font(Face.text(11)).foregroundStyle(Ink.faint) }
      }
      .foregroundStyle(Ink.muted)
      .frame(maxWidth: .infinity, alignment: .center)
      .padding(.vertical, 4).padding(.horizontal, 24)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(c == nil)
    .accessibilityElement(children: .combine)
  }
  private func eventText(_ m: Message, _ c: DeskCard?) -> String {
    switch m.kind {
    case "decided": return ([m.labels.joined(separator: ", ")] + m.optionNotes.map { "\($0.0): \($0.1)" } + [m.details ?? ""]).filter { !$0.isEmpty }.joined(separator: " · ")
    case "asked", "info": return c?.title == m.text ? "" : m.text
    default: return m.text == c?.title ? "" : m.text
    }
  }
  private func about(_ m: Message) -> some View {
    Group {
      if !inCard, let cid = m.cardId, let c = model.card(cid) {
        Button { model.path.append(.card(cid)) } label: {
          HStack(spacing: 6) { Text("ABOUT").font(Face.text(10, .bold)).kerning(1).foregroundStyle(Ink.faint); Text(c.title).font(Face.text(13)).foregroundStyle(Ink.muted).lineLimit(1) }
        }.buttonStyle(.plain)
      }
    }
  }
  @ViewBuilder private func userMessage(_ m: Message) -> some View {
    HStack(alignment: .bottom, spacing: 6) {
      Spacer(minLength: 44)
      VStack(alignment: .trailing, spacing: 4) {
        about(m)
        if !m.attachments.isEmpty && m.noteWritten == nil { Attachments(list: m.attachments, onPicture: { picture = $0 }) }
        CopiedCards(ids: m.copiedCards)
        MarksLine(marks: m.marks)
        if m.noteWritten != nil {
          VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) { PenMark("sidebar:NOTE_ICON").frame(width: 17, height: 17); Text("Note").font(Face.text(12, .bold)); if let w = m.noteWritten!, w > 0 { Text("written \(clockOf(w))").font(Face.text(12)) } }
              .foregroundStyle(Ink.noteInk.opacity(0.8))
            Text(m.text).font(Face.text(16)).foregroundStyle(Ink.noteInk)
            // its pictures and files on the slip (a tap: full screen)
            if !m.attachments.isEmpty { Attachments(list: m.attachments, onPicture: { picture = $0 }) }
          }
          .padding(14).frame(maxWidth: 320, alignment: .leading)
          .background(Rectangle().fill(Ink.noteYellow).rotationEffect(.degrees(-0.8)).shadow(color: .black.opacity(0.12), radius: 3, y: 2))
          .overlay(alignment: .top) { Rectangle().fill(Color.white.opacity(0.55)).frame(width: 46, height: 14).rotationEffect(.degrees(-3)).offset(y: -7) }
        } else if !m.text.isEmpty {
          Text(m.text).font(Face.text(16)).foregroundStyle(Ink.fg).textSelection(.enabled)
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(UnevenRoundedRectangle(topLeadingRadius: 18, bottomLeadingRadius: 18, bottomTrailingRadius: cont ? 18 : 6, topTrailingRadius: 18, style: .continuous).fill(Ink.accentSoft))
        }
      }
      VStack {
        if m.pending { Image(systemName: "clock").font(.system(size: 10)).foregroundStyle(Ink.faint) }
        else { Text(clockOf(m.ts)).font(Face.text(10)).foregroundStyle(Ink.faint) }
      }.frame(width: 30)
    }
    .contextMenu { if !m.text.isEmpty { Button { copyText(m.text) } label: { Label("Copy", systemImage: "doc.on.doc") } } }
    .fullScreenCover(item: Binding(get: { picture.map { PicIndex(at: $0) } }, set: { picture = $0?.at })) { p in PicturesView(list: m.attachments.filter { kindOf($0) == "image" }, start: p.at) }
  }
  @ViewBuilder private func agentMessage(_ m: Message) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      if !cont {
        HStack(spacing: 6) {
          if let a = model.desk?.byAgent[m.agent] { AgentMark(agent: a, size: 18, crown: false) }
          Text(model.desk?.byAgent[m.agent]?.name ?? "Agent").font(Face.text(13, .semibold)).foregroundStyle(Ink.muted)
          Text(clockOf(m.ts)).font(Face.text(11)).foregroundStyle(Ink.faint)
        }
      }
      about(m)
      if let p = m.published, let pub = model.board?.published[p] {
        PublishedCard(published: pub)
      } else if m.itemState == "pruned" {
        Text(m.text).font(Face.text(15)).italic().foregroundStyle(Ink.faint)
      } else if !m.text.isEmpty || m.html != nil {
        RichText(text: m.text + (m.html.map { "\n\n```html\n\($0)\n```" } ?? ""))
      }
      if !m.attachments.isEmpty { Attachments(list: m.attachments, onPicture: { picture = $0 }) }
      CopiedCards(ids: m.copiedCards)
      MarksLine(marks: m.marks)
      if let det = m.details, !det.isEmpty {
        DisclosureGroup { RichText(text: det, size: 15, color: Ink.muted).padding(.top, 4) } label: { Text("Details").font(Face.text(14, .semibold)).foregroundStyle(Ink.muted) }.tint(Ink.muted)
      }
    }
    .padding(.trailing, 24)
    .frame(maxWidth: .infinity, alignment: .leading)
    .contextMenu { if !m.text.isEmpty { Button { copyText(m.text) } label: { Label("Copy", systemImage: "doc.on.doc") } } }
    .fullScreenCover(item: Binding(get: { picture.map { PicIndex(at: $0) } }, set: { picture = $0?.at })) { p in PicturesView(list: m.attachments.filter { kindOf($0) == "image" }, start: p.at) }
  }
}
struct PicIndex: Identifiable { let at: Int; var id: Int { at } }

/** The cards a message carries (copied_cards): a chip each, Nr. and title; a tap opens the card. */
struct CopiedCards: View {
  @EnvironmentObject var model: BoardModel
  let ids: [String]
  var body: some View {
    if !ids.isEmpty {
      VStack(alignment: .trailing, spacing: 4) {
        ForEach(ids, id: \.self) { id in
          let c = model.card(id)
          Button { if c != nil { model.path.append(.card(id)) } } label: {
            HStack(spacing: 6) {
              Text(c.map { "Nr. \($0.number)" } ?? "Card").font(Face.text(13, .bold))
              Text(c?.title ?? "not on the board any more").font(Face.text(13)).lineLimit(1)
            }
            .foregroundStyle(Ink.fg).padding(.horizontal, 10).padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 8).fill(Ink.surface)).overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Ink.lineStrong))
          }.buttonStyle(.plain).disabled(c == nil)
        }
      }
    }
  }
}

/** Marks pinned to places on pictures (a message's or an answer's `marks`): how many, and their words. */
struct MarksLine: View {
  let marks: [JV]
  var body: some View {
    if !marks.isEmpty {
      let words = marks.compactMap { $0["label"].string ?? $0["text"].string }.filter { !$0.isEmpty }
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Sketch("pen", color: Ink.muted).frame(width: 14, height: 14)
        Text(marks.count == 1 ? "1 mark on the picture" : "\(marks.count) marks on the pictures").font(Face.text(13, .medium)).foregroundStyle(Ink.muted)
        if !words.isEmpty { Text("· " + words.joined(separator: " · ")).font(Face.text(13)).foregroundStyle(Ink.fg).lineLimit(3) }
      }
    }
  }
}

/** Something the session published: its picture or sign, what it is; a tap opens it, the round button copies its link. */
struct PublishedCard: View {
  @EnvironmentObject var model: BoardModel
  let published: PublishedObject
  @State private var opened: OpenedFile?
  var body: some View {
    let a = published.attachments.first ?? .null
    let type = kindOf(a)
    let title = published.title.isEmpty ? (a["file_name"].string ?? "Untitled") : published.title
    let live = model.room?.liveShare(a["attachment_id"].string ?? "")
    HStack(spacing: 8) {
      Button { open(a) } label: {
        HStack(spacing: 12) {
          Group {
            if type == "image" { AttachmentImage(ref: a).frame(width: 64, height: 48).clipShape(RoundedRectangle(cornerRadius: 8)) }
            else { PenMark("glyph:\(type)", color: Ink.fg).frame(width: 30, height: 30).frame(width: 64, height: 48).background(RoundedRectangle(cornerRadius: 8).fill(Ink.sunken)) }
          }
          VStack(alignment: .leading, spacing: 2) {
            Text(["html": "PAGE", "image": "PICTURE", "video": "VIDEO", "audio": "AUDIO", "file": "FILE"][type] ?? "FILE").font(Face.text(10, .bold)).kerning(1).foregroundStyle(Ink.faint)
            Text(title).font(Face.text(15, .semibold)).foregroundStyle(Ink.fg).lineLimit(2)
            if let n = published.note, !n.isEmpty { Text(n).font(Face.text(13)).foregroundStyle(Ink.muted).lineLimit(2) }
            if let live { Text(sharedWord(live)).font(Face.text(12, .semibold)).foregroundStyle(Ink.accent) }
          }
          Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      CopyLinkButton(ref: a, title: title)
    }
    .padding(8).background(RoundedRectangle(cornerRadius: 12).fill(Ink.surface)).overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Ink.lineStrong))
    .contextMenu {
      Button { model.copyLink(a, title: title) } label: { Label("Copy Link", systemImage: "link") }
      if live != nil { Button(role: .destructive) { model.stopSharing(a, title: title) } label: { Label("Stop Sharing", systemImage: "xmark.circle") } }
    }
    .sheet(item: $opened) { f in FileSheet(file: f) }
  }
  private func open(_ a: JV) {
    Task { do { let d = try await model.attachment(a); opened = OpenedFile(name: a["file_name"].string ?? published.title, type: a["media_type"].string ?? "", data: d, ref: a) } catch { model.fail("Not opened", error) } }
  }
}

// ---- Copy link: the link for people outside the room ---------------------------------------------------------------
//
// Copying the link IS the consent (his word, 9 October): no sheet, no choice of days. The first tap makes a link that
// holds 30 days and copies it; while it holds, a tap copies the same link (Room.shareLink). While it holds the button is
// filled in the accent; Stop Sharing is in the card's menu (hold it) and in the opened artifact's bar.

func sharedWord(_ s: SharedLink) -> String { let n = s.daysLeft(); return "Shared · \(n) \(n == 1 ? "day" : "days")" }
extension BoardModel {
  func copyLink(_ ref: JV, title: String) {
    guard let room = acting() else { return }
    Task {
      do { let s = try await room.shareLink(ref); copyText(s.link); objectWillChange.send(); say("Link copied", "Valid for \(s.daysLeft()) \(s.daysLeft() == 1 ? "day" : "days")") }
      catch { fail("Not shared", error) }
    }
  }
  func stopSharing(_ ref: JV, title: String) {
    guard let room = acting(), let id = ref["attachment_id"].string else { return }
    Task {
      do { try await room.stopSharing(id); objectWillChange.send(); say("Sharing stopped", "The link to “\(title)” opens nothing any more") }
      catch { objectWillChange.send(); fail("Not stopped", error) }
    }
  }
}
/** The round link button on an artifact: the pen's link, filled in the accent while its link holds. */
struct CopyLinkButton: View {
  @EnvironmentObject var model: BoardModel
  let ref: JV
  let title: String
  var body: some View {
    let live = model.room?.liveShare(ref["attachment_id"].string ?? "")
    Button { model.copyLink(ref, title: title) } label: {
      Sketch("link", color: live != nil ? Ink.accentFg : Ink.fg).frame(width: 20, height: 20).frame(width: 40, height: 40)
        .background(Circle().fill(live != nil ? Ink.accent : Ink.sunken))
        .frame(width: 44, height: 44).contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(live.map { "\(sharedWord($0)). Copy link to \(title)" } ?? "Copy link to \(title)")
    .accessibilityHint("Anyone with the link can open it, for \(ShareStore.days) days")
  }
}

/** The session's running work at the end of the conversation, and that it is answering. */
struct SessionStatus: View {
  @EnvironmentObject var model: BoardModel
  let agent: Agent
  let tasks: [Task1]
  let messages: [Message]
  var body: some View {
    let now = nowMs()
    let last = messages.last { $0.from != "event" }
    let answering = last?.from == "user" && now - min(now, last!.ts) < WORKING_WINDOW && agent.online
    let lines = tasks.filter { $0.state != "done" || now - min(now, $0.updated) < WORKING_WINDOW }
    if answering || !lines.isEmpty {
      VStack(alignment: .leading, spacing: 8) {
        if answering {
          HStack(spacing: 8) { AgentMark(agent: agent, size: 16, crown: false); Text("\(agent.name) is working").font(Face.text(14)).foregroundStyle(Ink.muted); TypingDots() }
        }
        ForEach(lines, id: \.id) { t in
          Button { if let cid = t.cardId { model.path.append(.card(cid)) } } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
              Group {
                if t.state == "working" { WorkingRing(working: true, color: Ink.accent) }
                else if t.state == "decision" { Sketch("knock", color: Ink.urgHigh) }
                else { Sketch("tick", color: Ink.accent) }
              }.frame(width: 18, height: 18).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 3 }
              Text(t.label).font(Face.text(16, .semibold)).foregroundStyle(Ink.fg)
              if let d = t.detail, !d.isEmpty { Text(d).font(Face.text(15)).foregroundStyle(Ink.muted).lineLimit(2) }
              Spacer(minLength: 4)
              if t.updated > 0 { Text(agoText(t.updated)).font(Face.text(12)).foregroundStyle(Ink.faint) }
            }
          }.buttonStyle(.plain).disabled(t.cardId == nil)
        }
      }.padding(.vertical, 12)
    }
  }
}
struct TypingDots: View {
  @State private var phase = 0.0
  var body: some View {
    HStack(spacing: 4) {
      ForEach(0..<3) { i in Circle().fill(Ink.accent).frame(width: 5, height: 5).offset(y: sin(phase + Double(i) * 0.9) * 2.5) }
    }
    .onAppear { withAnimation(.linear(duration: 1.3).repeatForever(autoreverses: false)) { phase = .pi * 2 } }
  }
}

/** Above the field: why the session does not hear, or that his last message was not picked up. */
struct SessionLinkNote: View {
  let agent: Agent
  let messages: [Message]
  var body: some View {
    let link = linkOf(agent)
    let mine = messages.last { $0.from == "user" && $0.seq < Double(Int.max) }
    let waits = mine.map { m in agent.heardUpTo != nil && m.seq > Double(agent.heardUpTo!) && nowMs() - min(nowMs(), m.ts) >= UNHEARD_MS } ?? false
    let receipt = waits ? "\(agent.name) has not picked up your last message." : ""
    if let l = link, ["cut", "gone", "asleep"].contains(l.state) { LinkNote(link: l, receipt: receipt).padding(.horizontal, 12).padding(.top, 8) }
    else if waits { LinkNote(link: nil, receipt: receipt, sign: "letter", late: true).padding(.horizontal, 12).padding(.top, 8) }
  }
}

/** A new conversation: what to start with. */
struct EmptyChat: View {
  let agent: Agent
  @EnvironmentObject var model: BoardModel
  var body: some View {
    VStack(spacing: 14) {
      AgentMark(agent: agent, size: 56)
      Text("What should the agent start with?").font(Face.display(24, .heavy)).multilineTextAlignment(.center)
      Text("Tell it what to work on. When it needs something from you, it puts a question in front of you.").font(Face.text(15)).foregroundStyle(Ink.muted).multilineTextAlignment(.center)
      ForEach(["Where do we stand?", "What do you need from me?", "Sum up what you did last."], id: \.self) { s in
        Button { Task { try? await model.send(agent: agent.id, text: s) } } label: {
          Text(s).font(Face.text(15, .medium)).foregroundStyle(Ink.fg).padding(.horizontal, 14).padding(.vertical, 9).background(Capsule().strokeBorder(Ink.lineStrong))
        }.buttonStyle(.plain)
      }
    }.frame(maxWidth: .infinity).padding(.vertical, 50)
  }
}

// ---- the composer -----------------------------------------------------------------------------------------------

struct Pending: Identifiable {
  let id = UUID(); var name: String; var type: String; var data: Data; var width: Int?; var height: Int?
  #if canImport(UIKit)
  /** What the composer shows of it: the picture small, a video's first frame; nil for any other file (and until it is made). */
  var thumb: UIImage? = nil
  static func preview(_ data: Data, type: String, name: String) async -> UIImage? {
    if type.hasPrefix("image/") {
      // ImageIO's thumbnail (Thumb): every format the system reads, upright, standard range; UIKit as the fallback
      if let t = Thumb.image(data, maxPixel: 660) { return t }
      guard let img = UIImage(data: data), img.size.width > 0, img.size.height > 0 else { return nil }
      return img.preparingForDisplay() ?? img
    }
    if type.hasPrefix("video/") {
      // (the frame is read from a file: written to the app's temporary folder for that moment, then removed)
      let ext = (name as NSString).pathExtension
      let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).\(ext.isEmpty ? "mov" : ext)")
      guard (try? data.write(to: url, options: .completeFileProtection)) != nil else { return nil }
      defer { try? FileManager.default.removeItem(at: url) }
      let gen = AVAssetImageGenerator(asset: AVURLAsset(url: url))
      gen.appliesPreferredTrackTransform = true
      gen.maximumSize = CGSize(width: 660, height: 420)
      guard let cg = try? await gen.image(at: .zero).image else { return nil }
      return UIImage(cgImage: cg)
    }
    return nil
  }
  #endif
}

/**
 * What is attached to the message being written, inside the composer's field above the text line (Messages): a row of
 * previews to swipe through. A picture as itself (its shape kept, 140 pt tall at most), a video as its first frame with
 * a play sign, any other file as a small tile with its kind and name; each with a round × at its top right corner.
 */
struct PendingFiles: View {
  @Binding var files: [Pending]
  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(alignment: .bottom, spacing: 8) {
        ForEach(files) { f in
          tile(f)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Ink.line, lineWidth: 0.5))
            .overlay(alignment: .topTrailing) {
              Button { withAnimation(.snappy) { files.removeAll { $0.id == f.id } } } label: {
                Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).foregroundStyle(.white)
                  .frame(width: 22, height: 22).background(Circle().fill(Color.black.opacity(0.55)))
                  .frame(width: 36, height: 36).contentShape(Rectangle())
              }
              .buttonStyle(.plain)
              .accessibilityLabel("Remove \(f.name)")
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(f.name)
        }
      }
      .padding(.horizontal, 10).padding(.top, 10)
    }
  }
  @ViewBuilder private func tile(_ f: Pending) -> some View {
    #if canImport(UIKit)
    if let t = f.thumb, t.size.width > 0, t.size.height > 0 {
      let shape = t.size.width / t.size.height
      let w = min(220, max(64, 140 * shape)), h = min(140, max(64, w / shape))
      Image(uiImage: t).resizable().scaledToFill().frame(width: w, height: h).clipped()
        .overlay {
          if f.type.hasPrefix("video/") {
            Image(systemName: "play.fill").font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
              .frame(width: 40, height: 40).background(Circle().fill(Color.black.opacity(0.5)))
          }
        }
    } else { fileTile(f) }
    #else
    fileTile(f)
    #endif
  }
  private func fileTile(_ f: Pending) -> some View {
    let ext = (f.name as NSString).pathExtension.uppercased()
    let icon = f.type.hasPrefix("image/") ? "photo" : f.type.hasPrefix("video/") ? "film" : f.type.hasPrefix("audio/") ? "waveform" : f.type == "application/pdf" ? "doc.richtext" : "doc"
    return VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 6) {
        Image(systemName: icon).font(.system(size: 18, weight: .medium)).foregroundStyle(Ink.fg)
        if !ext.isEmpty { Text(ext.prefix(5)).font(Face.text(11, .bold)).kerning(0.6).foregroundStyle(Ink.muted) }
      }
      Text(f.name).font(Face.text(13, .medium)).foregroundStyle(Ink.fg).lineLimit(2).multilineTextAlignment(.leading)
    }
    .padding(.leading, 10).padding(.trailing, 30).padding(.vertical, 10)
    .frame(width: 148, height: 76, alignment: .topLeading)
    .background(Ink.sunken)
  }
}

struct Composer: View {
  @EnvironmentObject var model: BoardModel
  let placeholder: String
  let agent: String
  var cardId: String? = nil
  var autofocus = false
  var onSent: (() -> Void)? = nil
  @State private var text = ""
  @State private var files: [Pending] = []
  @State private var importing = false
  @State private var pickingPhotos = false
  @State private var camera = false
  @State private var sending = false
  @State private var error: String?
  /** Cards attached to this message (copied_cards). */
  @State private var cards: [String] = []
  @FocusState private var focused: Bool
  /** The keyboard is up: the composer then sits 8 pt over it, else at the screen's bottom edge (bottomSink). */
  @State private var keyboard = false
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if let e = error { Text(e).font(Face.text(13)).foregroundStyle(Ink.urgCritical).padding(.horizontal, 6) }
      // a card copied elsewhere and not attached yet: offered, one tap attaches it (session.mjs composer)
      if let id = model.copiedCard, id != cardId, !cards.contains(id), let c = model.card(id) {
        HStack(spacing: 8) {
          Button { cards.append(id) } label: {
            HStack(spacing: 6) { Image(systemName: "plus").font(.system(size: 11, weight: .bold)); Text("Attach Nr. \(c.number) · \(c.title)").font(Face.text(13, .medium)).lineLimit(1) }
              .foregroundStyle(Ink.accent).padding(.horizontal, 10).padding(.vertical, 6).background(Capsule().strokeBorder(Ink.accent.opacity(0.5), style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
          }.buttonStyle(.plain)
          Button { model.copiedCard = nil } label: { Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).foregroundStyle(Ink.muted).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle()) }.buttonStyle(.plain).accessibilityLabel("Forget the copied card")
        }.padding(.horizontal, 6)
      }
      if !cards.isEmpty {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 6) {
            ForEach(cards, id: \.self) { id in
              HStack(spacing: 6) {
                Text("Nr. \(model.card(id)?.number ?? 0)").font(Face.text(13, .bold))
                Text(model.card(id)?.title ?? id).font(Face.text(13)).lineLimit(1).frame(maxWidth: 160)
                Button { cards.removeAll { $0 == id } } label: { Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).frame(minWidth: 32, minHeight: 44).contentShape(Rectangle()) }.buttonStyle(.plain).accessibilityLabel("Remove")
              }
              .padding(.horizontal, 10).padding(.vertical, 6).background(Capsule().fill(Ink.sunken))
            }
          }
        }
      }
      // as Messages on iOS 26: a round glass "+" for files, the field as a glass capsule with the send arrow inside;
      // what is attached lies in the field above the text line (PendingFiles), the field grows with it.
      // Messages' measures (his screenshots, 9 October): the "+" 40 pt, the field 40 pt tall on the same centre, 11 pt
      // between them, 27 pt from the left edge and 25 pt from the right; the lower edge 26 pt over the screen's bottom
      // edge (inside the home indicator's area), 8 pt over the keyboard
      HStack(alignment: .bottom, spacing: 11) {
        Menu {
          Button { pickingPhotos = true } label: { Label("Photo Library", systemImage: "photo.on.rectangle") }
          Button { importing = true } label: { Label("Choose File", systemImage: "doc") }
          #if canImport(UIKit)
          if UIImagePickerController.isSourceTypeAvailable(.camera) { Button { camera = true } label: { Label("Take Photo", systemImage: "camera") } }
          #endif
        } label: {
          Image(systemName: "plus").font(.system(size: 19, weight: .semibold)).foregroundStyle(Ink.fg).frame(width: 40, height: 40).glass(Circle(), interactive: true)
        }
        .accessibilityLabel("Attach")
        VStack(alignment: .leading, spacing: 0) {
          if !files.isEmpty { PendingFiles(files: $files) }
          HStack(alignment: .bottom, spacing: 4) {
            TextField(placeholder, text: $text, axis: .vertical)
              .font(Face.text(17))
              .lineLimit(1...7)
              .focused($focused)
              .padding(.leading, 16).padding(.vertical, 9)
            Button(action: send) {
              Group {
                if sending { ProgressView().tint(Ink.accentFg) }
                else { Image(systemName: "arrow.up").font(.system(size: 16, weight: .bold)) }
              }
              .foregroundStyle(Ink.accentFg).frame(width: 32, height: 32).background(Circle().fill(canSend ? Ink.accent : Ink.faint))
              .frame(width: 40, height: 40).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!canSend || sending)
            .accessibilityLabel("Send")
          }
        }
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .glass(RoundedRectangle(cornerRadius: 22, style: .continuous))
      }
    }
    .padding(.leading, 27).padding(.trailing, 25).padding(.top, 8).padding(.bottom, keyboard ? 8 : bottomSink(26))
    #if canImport(UIKit)
    .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in withAnimation(.easeOut(duration: 0.25)) { keyboard = true } }
    .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in withAnimation(.easeOut(duration: 0.25)) { keyboard = false } }
    #endif
    .onAppear { if autofocus { focused = true } }
    .sheet(isPresented: $pickingPhotos) { PhotoPicker(limit: MAX_FILES - files.count) { picked in Task { await take(picked) } }.ignoresSafeArea() }
    .sheet(isPresented: $camera) { CameraPicker { data in Task { await take([(data, .jpeg)]) } }.ignoresSafeArea() }
    .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { r in
      if case .success(let urls) = r {
        for u in urls.prefix(MAX_FILES - files.count) {
          let ok = u.startAccessingSecurityScopedResource(); defer { if ok { u.stopAccessingSecurityScopedResource() } }
          if let d = try? Data(contentsOf: u) {
            add(Pending(name: u.lastPathComponent, type: UTType(filenameExtension: u.pathExtension)?.preferredMIMEType ?? "application/octet-stream", data: d))
          }
        }
      }
    }
  }
  /** Attach it; its preview (a picture small, a video's first frame) follows as soon as it is made. */
  private func add(_ p: Pending) {
    withAnimation(.snappy) { files.append(p) }
    #if canImport(UIKit)
    Task { @MainActor in
      let t = await Pending.preview(p.data, type: p.type, name: p.name)
      if let t, let i = files.firstIndex(where: { $0.id == p.id }) { files[i].thumb = t }
    }
    #endif
  }
  private var canSend: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !files.isEmpty || !cards.isEmpty }
  private func take(_ items: [(data: Data, type: UTType?)]) async {
    for (d, type) in items.prefix(MAX_FILES - files.count) {
      var name = "file-\(files.count + 1)"
      var mime = type?.preferredMIMEType ?? "application/octet-stream"
      #if canImport(UIKit)
      if (type?.conforms(to: .image) ?? false), let img = UIImage(data: d) {
        // pictures go as JPEG (HEIC is not shown everywhere), at most 2400 px
        let s = min(1, 2400 / max(img.size.width, img.size.height))
        let size = CGSize(width: (img.size.width * s).rounded(), height: (img.size.height * s).rounded())
        let fmt = UIGraphicsImageRendererFormat(); fmt.scale = 1; fmt.preferredRange = .standard; fmt.opaque = true
        let small = UIGraphicsImageRenderer(size: size, format: fmt).image { _ in img.draw(in: CGRect(origin: .zero, size: size)) }
        if let j = small.jpegData(compressionQuality: 0.85) {
          add(Pending(name: "picture-\(files.count + 1).jpg", type: "image/jpeg", data: j, width: Int(size.width), height: Int(size.height)))
          continue
        }
      }
      #endif
      if type?.conforms(to: .movie) == true { name = "video-\(files.count + 1).\(type?.preferredFilenameExtension ?? "mov")"; mime = type?.preferredMIMEType ?? "video/quicktime" }
      add(Pending(name: name, type: mime, data: d))
    }
  }
  private func send() {
    let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
    let chosen = files, attached = cards
    guard !words.isEmpty || !chosen.isEmpty || !attached.isEmpty else { return }
    sending = true; error = nil
    text = ""; files = []; cards = []
    Task {
      do {
        var refs = [JV]()
        for f in chosen { refs.append(try await model.upload(f.data, name: f.name, type: f.type, width: f.width, height: f.height)) }
        try await model.send(agent: agent, text: words, cardId: cardId, attachments: refs, cards: attached)
        if attached.contains(model.copiedCard ?? "") { model.copiedCard = nil }; onSent?()
      } catch {
        // nothing is lost: the words come back into the field
        text = words; files = chosen; cards = attached
        self.error = "Not sent: \(model.describe(error))"
      }
      sending = false
    }
  }
}

#if canImport(UIKit)
/** The system's photo picker (PHPicker: no access to the whole library, only what he picks). */
struct PhotoPicker: UIViewControllerRepresentable {
  let limit: Int
  let done: ([(data: Data, type: UTType?)]) -> Void
  func makeCoordinator() -> Coordinator { Coordinator(done: done) }
  func makeUIViewController(context: Context) -> PHPickerViewController {
    var cfg = PHPickerConfiguration()
    cfg.selectionLimit = max(1, limit)
    cfg.filter = .any(of: [.images, .videos])
    cfg.preferredAssetRepresentationMode = .compatible
    let p = PHPickerViewController(configuration: cfg)
    p.delegate = context.coordinator
    return p
  }
  func updateUIViewController(_ c: PHPickerViewController, context: Context) {}
  final class Coordinator: NSObject, PHPickerViewControllerDelegate {
    let done: ([(data: Data, type: UTType?)]) -> Void
    init(done: @escaping ([(data: Data, type: UTType?)]) -> Void) { self.done = done }
    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
      picker.dismiss(animated: true)
      let group = DispatchGroup()
      var out = [(data: Data, type: UTType?)](repeating: (Data(), nil), count: results.count)
      for (i, r) in results.enumerated() {
        let p = r.itemProvider
        guard let t = p.registeredTypeIdentifiers.compactMap({ UTType($0) }).first(where: { $0.conforms(to: .image) || $0.conforms(to: .movie) }) else { continue }
        group.enter()
        p.loadDataRepresentation(forTypeIdentifier: t.identifier) { d, _ in
          if let d = d { DispatchQueue.main.async { out[i] = (d, t) } }
          group.leave()
        }
      }
      group.notify(queue: .main) { self.done(out.filter { !$0.data.isEmpty }) }
    }
  }
}
#endif

/** A session's files (session.mjs files drawer): what it sent and was sent, and what its questions carry, newest first. */
struct SessionFiles: View {
  @EnvironmentObject var model: BoardModel
  let agentId: String
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    let msgs = model.desk?.messagesOf(agent: agentId) ?? []
    let cards = model.desk?.cards.filter { $0.agent == agentId } ?? []
    let all: [JV] = (msgs.reversed().flatMap { $0.attachments } + cards.reversed().flatMap { $0.attachments })
    let pics = all.filter { kindOf($0) == "image" }, others = all.filter { kindOf($0) != "image" }
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          if all.isEmpty { Text("No files yet.").font(Face.text(15)).foregroundStyle(Ink.muted) }
          if !pics.isEmpty {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 100), spacing: 6)], spacing: 6) {
              ForEach(Array(pics.enumerated()), id: \.offset) { _, a in AttachmentImage(ref: a).frame(height: 100).clipShape(RoundedRectangle(cornerRadius: 8)) }
            }
          }
          if !others.isEmpty { Attachments(list: others) }
        }.padding(16)
      }
      .navigationTitle("Files").navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
    }
  }
}
