// DeskScreen.swift: the Desk (app/web/public/desk.mjs, ui.mjs deskRow): one big greeting with its last word underlined
// by the pen, the duck for all and Blitz; the open questions as calm cards in their session's tones, the answers as
// tiles (thumbs for a plain yes/no, two named tiles, the advised one with "+N other ways", or Choose); a long press
// brings Later, Reverse, Duck it, What??, Shred, Copy. Below: what is with the agents, then the slim end list (Done rows
// to tick off, Later, what is done), "Show more" opens Off your mind.
import SwiftUI
import TrommiClient
import TrommiCore

let GREETINGS = ["Welcome back.", "There you are.", "The agents missed you.", "Desk’s all yours.", "Ring the bell.", "Decisions, decisions.", "Your call.", "Back at it.",
                 "Somebody knocked.", "Look who’s here.", "They’ve been waiting.", "The floor is yours.", "Pick a card.", "Over to you.", "Right on time.", "Pull up a chair.",
                 "Yes or no?", "The boss is in.", "What’ll it be?", "Ready when you are."]
let CALM = ["All quiet.", "Nothing needs you.", "Clear desk.", "Carry on.", "As you were.", "Go outside."]
let DICE = Double.random(in: 0..<1)

struct DeskScreen: View {
  @EnvironmentObject var model: BoardModel
  @Environment(\.horizontalSizeClass) private var hSize
  @State private var duckAsk = false
  var body: some View {
    let _ = model.version
    let v = model.view
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 12) {
        if let v = v, let d = model.desk, !v.units.isEmpty || model.room?.cursor ?? 0 > 0 {
          let _ = StartClock.desk(cards: v.fresh.count, restored: model.room?.restored ?? false)
          head(v)
          if !v.cut.isEmpty { CutSlip(units: v.cut) }
          let cards = v.deskCards()
          ForEach(runs(cards, d)) { run in
            VStack(spacing: 10) { ForEach(run.cards) { c in DeskRow(card: c, agent: d.byAgent[c.agent]) } }
          }
          if v.fresh.isEmpty && v.reads.isEmpty && !v.units.isEmpty {
            VStack(spacing: 10) {
              Sketch("desk", color: Ink.faint).frame(width: 64, height: 64)
              Text("As soon as an agent has a question, it shows up here.").font(Face.text(15)).foregroundStyle(Ink.muted).multilineTextAlignment(.center)
            }.frame(maxWidth: .infinity).padding(.vertical, 28)
          } else if !cards.isEmpty {
            Text("Hold a card: Later, Reverse, Duck it, What??, Shred, Copy. Tap its title: text and pictures.")
              .font(Face.text(13, .medium)).foregroundStyle(Ink.faint).multilineTextAlignment(.center).frame(maxWidth: .infinity).padding(.horizontal, 12)
          }
          WithAgents(view: v)
          EndList(view: v, full: false)
        } else {
          ProgressView().frame(maxWidth: .infinity).padding(.top, 80)
        }
      }
      .padding(.horizontal, 16).padding(.bottom, 90)
      .frame(maxWidth: 760).frame(maxWidth: .infinity)
    }
    .scrollDismissesKeyboard(.interactively)
    .refreshable { await model.refresh() }
    .background(Ink.bg)
    .background {
      // the Desk's keys on an iPad with a keyboard: B Blitz, O Off your mind, S settings
      ZStack {
        Button("") { model.path.append(.blitz) }.keyboardShortcut("b", modifiers: [])
        Button("") { model.path.append(.off) }.keyboardShortcut("o", modifiers: [])
        Button("") { model.path.append(.settings("agents")) }.keyboardShortcut(",", modifiers: .command)
      }.opacity(0).accessibilityHidden(true)
    }
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {

      ToolbarItem(placement: .principal) { DeskTitle() }
      ToolbarItem(placement: .topBarTrailing) { if hSize == .regular { NoteButton() } }
    }
    .overlay(alignment: .bottom) { if !model.selected.isEmpty { SelectionBar() } }
  }

  @ViewBuilder private func head(_ v: DeskModel.View) -> some View {
    if v.units.isEmpty { FirstAgent() }
    else {
      let n = v.fresh.count
      let unquiet = !v.cut.isEmpty ? (v.cut.count == 1 ? "One can’t hear you." : "Some can’t hear you.")
        : v.unheard > 0 ? (v.unheard == 1 ? "An answer waits." : "Answers wait.")
        : !v.landed.isEmpty ? (v.landed.count == 1 ? "Something got done." : "Things got done.") : ""
      let set = n == 0 ? CALM : GREETINGS
      let line = n == 0 && !unquiet.isEmpty ? unquiet : set[Int(DICE * Double(set.count))]
      VStack(alignment: .leading, spacing: 14) {
        Greeting(text: line).padding(.top, 18)
        if n > 0 {
          HStack(spacing: 12) {
            Spacer()
            let decisions = v.fresh.filter { $0.kind == "decision" }.map { $0.id }
            if !decisions.isEmpty {
              Button { duckAsk = true } label: {
                PenMark("sketch:duck", color: Ink.fg, duck: false).frame(width: 34, height: 28).padding(.horizontal, 14).padding(.vertical, 12)
              }
              .buttonStyle(PaperButton())
              .accessibilityLabel(decisions.count == 1 ? "I don’t give a duck: for the one open decision" : "I don’t give a duck: for all \(decisions.count) open decisions")
              .confirmationDialog(decisions.count == 1 ? "Answer it with “I don’t give a duck”?" : "Answer all \(decisions.count) with “I don’t give a duck”?", isPresented: $duckAsk, titleVisibility: .visible) {
                Button(decisions.count == 1 ? "Yes, duck it" : "Yes, duck them all") { model.duckAll(decisions) }
              }
            }
            Button { model.path.append(.blitz) } label: {
              HStack(spacing: 10) {
                PenMark("desk:BOLT").frame(width: 22, height: 22)
                Text(Words.walk).font(Face.text(18, .semibold)).foregroundStyle(Ink.fg)
                Text("\(n)").font(Face.text(16, .semibold)).foregroundStyle(Ink.bg).frame(minWidth: 30, minHeight: 30).background(Circle().fill(Ink.fg))
              }.padding(.leading, 16).padding(.trailing, 10).padding(.vertical, 9)
            }
            .buttonStyle(PaperButton())
            .accessibilityLabel("\(Words.walk): \(n == 1 ? "1 open question" : "\(n) open questions")")
          }
        }
      }.padding(.bottom, 6)
    }
  }
  struct Run: Identifiable { var id: String; var cards: [DeskCard] }
  private func runs(_ cards: [DeskCard], _ d: DeskModel) -> [Run] {
    var out = [Run]()
    for c in cards where d.byAgent[c.agent] != nil {
      if let last = out.last, last.cards.last?.agent == c.agent { out[out.count - 1].cards.append(c) }
      else { out.append(Run(id: "run-\(c.id)", cards: [c])) }
    }
    return out
  }
}

/** One big line in the display face, its last word underlined with the pen. */
struct Greeting: View {
  let text: String
  var body: some View {
    let words = text.split(separator: " ").map(String.init)
    let head = words.dropLast().joined(separator: " ")
    (Text(head.isEmpty ? "" : head + " ").font(Face.display(36, .heavy)).foregroundStyle(Ink.fg)
      + Text(words.last ?? "").font(Face.display(36, .heavy)).foregroundStyle(Ink.fg))
      .overlay(alignment: .bottomTrailing) {
        // the pen's line under the last word
        GeometryReader { _ in EmptyView() }
      }
      .background(alignment: .bottomTrailing) {
        PenUnderline().stroke(Ink.accent, style: StrokeStyle(lineWidth: 2.2, lineCap: .round)).frame(width: underlineWidth(words.last ?? ""), height: 8).offset(y: 6)
      }
      .accessibilityAddTraits(.isHeader)
  }
  private func underlineWidth(_ w: String) -> CGFloat { CGFloat(w.count) * 17 }
}

/** A drawn paper button (the Desk's tools): the pen's box with a shadow line under it. */
struct PaperButton: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .background(PenBox(r: 14).fill(Ink.surface))
      .overlay(PenBox(r: 14).stroke(Ink.fg, lineWidth: 2))
      .background(PenBox(r: 14).fill(Ink.lineStrong).offset(y: 4))
      .scaleEffect(configuration.isPressed ? 0.97 : 1)
      .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
}

/** A new account's Desk: invite the first agent. */
struct FirstAgent: View {
  @EnvironmentObject var model: BoardModel
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Sketch("heads", color: Ink.fg).frame(width: 64, height: 64)
      Text("Invite your first agent").font(Face.display(28, .heavy))
      Text("You get one command for any computer with Claude Code: run it in the project folder, then start Claude Code there with plain claude. Its questions land here.")
        .font(Face.text(16)).foregroundStyle(Ink.muted)
      Button { model.path.append(.settings("agents")) } label: {
        HStack { PenMark("ui:PLUS", color: Ink.accentFg).frame(width: 20, height: 20); Text("Invite an agent").font(Face.text(17, .semibold)) }
          .foregroundStyle(Ink.accentFg).padding(.horizontal, 18).padding(.vertical, 12).background(Capsule().fill(Ink.accent))
      }
    }.padding(.top, 30)
  }
}

/** The slip above the questions: the sessions that are cut off, each with the step in its terminal. */
struct CutSlip: View {
  @EnvironmentObject var model: BoardModel
  let units: [DeskUnit]
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ForEach(units) { u in
        Button { model.path.append(.session(u.id)) } label: {
          VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 8) {
              Sketch("ear-off", color: Ink.urgHigh).frame(width: 20, height: 20)
              (Text(u.agent.name).font(Face.text(15, .semibold)) + Text(" is cut off\(u.link?.since != nil ? " since \(clockText(u.link!.since!))" : ""): it cannot hear you and cannot write to you.").font(Face.text(15)))
                .foregroundStyle(Ink.fg).multilineTextAlignment(.leading)
            }
            if let fix = u.link?.fixCode { HStack(spacing: 6) { Text(u.link?.fixSay ?? "").font(Face.text(13)).foregroundStyle(Ink.muted); CodeChip(text: fix) }.padding(.leading, 28) }
          }
        }.buttonStyle(.plain)
      }
    }
    .padding(14)
    .background(RoundedRectangle(cornerRadius: 14).fill(Ink.urgHighSoft))
  }
}
struct CodeChip: View {
  let text: String
  @State private var copied = false
  var body: some View {
    Button { copyText(text); copied = true } label: {
      Text(copied ? "Copied" : text).font(Face.mono(13, .medium)).foregroundStyle(Ink.fg).padding(.horizontal, 8).padding(.vertical, 4)
        .background(RoundedRectangle(cornerRadius: 6).fill(Ink.sunken))
    }.buttonStyle(.plain)
  }
}
func copyText(_ s: String) {
  #if canImport(UIKit)
  UIPasteboard.general.string = s
  #endif
}

// ---- one open question ------------------------------------------------------------------------------------

func fits(_ label: String, _ width: Int, _ lines: Int) -> Bool {
  var n = 1, used = 0
  for word in label.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "-", with: "- ").split(whereSeparator: { $0.isWhitespace }) {
    if word.count > width { return false }
    if used > 0 && used + 1 + word.count > width { n += 1; used = word.count } else { used += (used > 0 ? 1 : 0) + word.count }
  }
  return n <= lines
}
let BARE: Set<String> = ["yes", "no", "ok", "okay", "allow", "deny", "ja", "nein"]

struct DeskRow: View {
  @EnvironmentObject var model: BoardModel
  let card: DeskCard
  let agent: Agent?
  var inSession = false
  var body: some View {
    let hue = agent?.hue ?? 162
    VStack(alignment: .leading, spacing: 8) {
      // who asks, the knock
      HStack(spacing: 7) {
        if let a = agent {
          Button { if model.selected.contains(card.id) { model.selected.remove(card.id) } else { model.selected.insert(card.id) } } label: {
            ZStack {
              AgentMark(agent: a, size: 20).opacity(model.selected.contains(card.id) ? 0 : 1)
              if model.selected.contains(card.id) { Image(systemName: "checkmark.circle.fill").font(.system(size: 20)).foregroundStyle(Tone.color(hue: hue, .pen)) }
            }
          }
          .buttonStyle(.plain)
          .accessibilityLabel(model.selected.contains(card.id) ? "Selected: \(card.title)" : "Select: \(card.title)")
          Text(a.name).font(Face.text(14, .medium)).foregroundStyle(Tone.color(hue: hue, .pen)).lineLimit(1)
        }
        if card.kind == "info" && !card.isKnock { Sketch("page", color: Ink.muted).frame(width: 16, height: 16) }
        else if card.urgency == "low" { Sketch("whenever", color: Ink.muted).frame(width: 16, height: 16) }
        Spacer(minLength: 4)
        if !card.isKnock || card.urgency != "critical" {
          Button { model.snooze(card) } label: { PenMark("ui:LATER_TAG", color: Tone.color(hue: hue, .pen)).frame(width: 18, height: 36) }
            .accessibilityLabel("\(Words.later): put this question off")
        }
      }
      Button { model.path.append(.card(card.id)) } label: {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          if card.isKnock {
            if card.urgency == "critical" { PenMark("hand", color: Ink.surface, blocked: true).frame(width: 24, height: 24).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 4 } }
            else { Sketch("knock", color: Ink.urgHigh).frame(width: 20, height: 20).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 3 } }
          }
          Text(card.title.isEmpty ? "(no title)" : card.title).font(Face.display(21, .bold)).foregroundStyle(Ink.fg).lineLimit(3).multilineTextAlignment(.leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityHint(card.knockWord ?? "")
      if card.unsupported {
        UnsupportedLine(what: "card")
      } else {
        Tiles(card: card, hue: hue)
      }
    }
    .padding(14)
    .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Tone.color(hue: hue, .wash)))
    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(model.selected.contains(card.id) ? Tone.color(hue: hue, .pen) : .clear, lineWidth: 2))
    .contextMenu { RowMenu(card: card) }
  }
}

/** The ways out of a row, held (desk.mjs rowSheet): Later, Reverse, Duck it, What??, Shred, Copy, Open. */
struct RowMenu: View {
  @EnvironmentObject var model: BoardModel
  let card: DeskCard
  var body: some View {
    Button { model.path.append(.card(card.id)) } label: { Label("Open", systemImage: "doc.text") }
    Button { model.snooze(card) } label: { Label(Words.later, systemImage: "zzz") }
    if card.kind != "permission" { Button { model.handBack(card) } label: { Label(Words.revise, systemImage: "arrow.uturn.backward") } }
    if card.kind == "decision" { Button { model.trust(card) } label: { Label(Words.duck, systemImage: "hand.wave") } }
    if card.kind != "permission" { Button { model.what(card) } label: { Label("What?? — explain this to me", systemImage: "questionmark.bubble") } }
    Button { copyText("Nr. \(card.number) · \(card.title)") } label: { Label("Copy", systemImage: "doc.on.doc") }
    if card.kind != "permission" { Button(role: .destructive) { model.shred(card) } label: { Label(Words.shred, systemImage: "trash") } }
  }
}

/** A calm stand-in for something only a newer Trommi can show. */
struct UnsupportedLine: View {
  var what = "item"
  var body: some View {
    HStack(spacing: 8) {
      Sketch("wake", color: Ink.muted).frame(width: 16, height: 16)
      Text("This needs a newer version of Trommi. Update to see it.").font(Face.text(14)).foregroundStyle(Ink.muted)
    }
    .padding(10).frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 10).strokeBorder(Ink.lineStrong, style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
  }
}

/** The answers of a row (ui.mjs tiles). */
struct Tiles: View {
  @EnvironmentObject var model: BoardModel
  let card: DeskCard
  let hue: Int
  var body: some View {
    let cols = [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]
    if card.kind == "info" {
      LazyVGrid(columns: cols, spacing: 8) {
        tile(lead: false, label: nil, drawing: "what", wide: true) { model.what(card) }.accessibilityLabel("What?? — explain this to me")
        tile(lead: true, label: Words.ack, drawing: "tick") { model.closeInfo(card) }
      }
    } else {
      let bare = card.options.allSatisfy { BARE.contains($0.label.trimmingCharacters(in: .whitespaces).lowercased()) }
      let size = bare ? "none" : card.options.allSatisfy({ fits($0.label, 14, 2) }) ? "usual" : card.options.allSatisfy({ fits($0.label, 17, 3) }) ? "small" : "none"
      let short = card.options.allSatisfy { ($0.raw["short"].string ?? "").trimmingCharacters(in: .whitespaces).count <= 18 && !($0.raw["short"].string ?? "").isEmpty }
      let quick = !card.multiple && (card.kind == "permission" || card.options.count == 2)
      if quick && (bare || size != "none" || short) {
        let thumbs = bare || card.kind == "permission"
        let isYes: (Option) -> Bool = { o in card.kind == "permission" ? o.key == "allow" : thumbs ? o.key == card.options.first?.key : card.recommended.contains(o.key) }
        let ordered = thumbs ? card.options.sorted { (isYes($0) ? 1 : 0) < (isYes($1) ? 1 : 0) } : card.options
        let worded = !bare && size == "none"
        LazyVGrid(columns: cols, spacing: 8) {
          ForEach(ordered, id: \.key) { o in
            let lead = isYes(o)
            let label = worded ? (o.raw["short"].string ?? o.label) : size == "none" && !bare ? nil : o.label
            tile(lead: lead, label: label, drawing: thumbs ? (lead ? "yes" : "no") : nil, advised: card.recommended.contains(o.key), final: o.final) {
              model.decide(card, keys: [o.key])
            }
            .accessibilityLabel(o.final ? "\(o.label) (settles it)" : o.label)
          }
        }
      } else if card.kind == "decision" && !card.multiple && card.recommended.count == 1, let adv = card.options.first(where: { $0.key == card.recommended[0] }) {
        let others = card.options.count - 1
        LazyVGrid(columns: cols, spacing: 8) {
          Button { model.path.append(.card(card.id)) } label: {
            HStack(spacing: 6) { Text("+\(others)").font(Face.display(20, .heavy)); Text("other ways").font(Face.text(15, .medium)) }
              .foregroundStyle(Ink.fg).frame(maxWidth: .infinity, minHeight: 58)
          }
          .buttonStyle(TileStyle(lead: false, hue: hue, urgency: card.urgency))
          .accessibilityLabel("\(others) other ways: open the card")
          tile(lead: true, label: adv.label, drawing: nil, advised: true, final: adv.final) { model.decide(card, keys: [adv.key]) }
            .accessibilityLabel("\(adv.label), advised\(adv.final ? " (settles it)" : "")")
        }
      } else {
        Button { model.path.append(.card(card.id)) } label: {
          HStack(spacing: 10) { Sketch("choose", color: Ink.surface).frame(width: 22, height: 22); Text("Choose").font(Face.text(17, .semibold)) }
            .frame(maxWidth: .infinity, minHeight: 58)
        }
        .buttonStyle(TileStyle(lead: true, hue: hue, urgency: card.urgency))
        .accessibilityLabel("Choose: \(card.options.count) options\(card.multiple ? ", several" : "")")
      }
    }
  }
  private func tile(lead: Bool, label: String?, drawing: String?, wide: Bool = false, advised: Bool = false, final: Bool = false, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      VStack(spacing: 4) {
        if let d = drawing {
          if d == "what" { PenMark("sketch:what", color: lead ? Ink.surface : Ink.fg, width: 2.2).frame(width: 64, height: 22) }
          else { Sketch(d, color: lead ? Ink.surface : Tone.color(hue: hue, .pen)).frame(width: 24, height: 24) }
        }
        if let l = label {
          Text(l).font(Face.text(15, .semibold)).multilineTextAlignment(.center).lineLimit(3).minimumScaleFactor(0.85)
            .padding(.horizontal, 6)
            .background(alignment: .bottom) { if advised && !lead { PenUnderline().stroke(Ink.urgHigh.opacity(0.7), lineWidth: 2).frame(height: 6).offset(y: 4) } }
        }
      }
      .frame(maxWidth: .infinity, minHeight: 58)
      .overlay(alignment: .topTrailing) { if final { Sketch("tick", color: lead ? Ink.surface : Ink.accent, width: 2.2).frame(width: 13, height: 13).padding(6) } }
    }
    .buttonStyle(TileStyle(lead: lead, hue: hue, urgency: card.urgency))
  }
}

struct TileStyle: ButtonStyle {
  let lead: Bool
  let hue: Int
  var urgency = "normal"
  func makeBody(configuration: Configuration) -> some View {
    let knock = urgency == "high" || urgency == "critical"
    let fill = lead ? (knock ? Ink.urgency(urgency) : Tone.color(hue: hue, .pen)) : Ink.surface
    configuration.label
      .foregroundStyle(lead ? Ink.surface : Ink.fg)
      .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(fill))
      .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(lead ? .clear : Tone.color(hue: hue, .edge), lineWidth: 1))
      .scaleEffect(configuration.isPressed ? 0.96 : 1)
      .animation(.easeOut(duration: 0.1), value: configuration.isPressed)
  }
}

// ---- with the agents, the end list ---------------------------------------------------------------------------

struct WithAgents: View {
  @EnvironmentObject var model: BoardModel
  let view: DeskModel.View
  var body: some View {
    let d = model.desk!
    let working = d.tasks.filter { $0.state == "working" }
    let decidedHere = d.cards.filter { c in c.status == "decided" && d.stackOf(c) == "works" && view.here.contains { $0.id == c.agent } }
    let items = (view.revising.filter { d.stackOf($0) == "works" } + decidedHere.sorted { ($0.decided ?? 0) > ($1.decided ?? 0) }).compactMap { c -> (DeskCard, Agent, Task1?, UInt64)? in
      guard let a = d.byAgent[c.agent] else { return nil }
      let line = working.first { $0.cardId == c.id } ?? working.filter { $0.agent == c.agent && $0.cardId == nil }.max { $0.updated < $1.updated }
      return (c, a, line, (c.status == "open" ? c.withAgent : c.decided) ?? 0)
    }.sorted { ($0.2?.updated ?? $0.3) > ($1.2?.updated ?? $1.3) }
    if !items.isEmpty {
      VStack(alignment: .leading, spacing: 8) {
        EndDivider(title: "Off your mind")
        ForEach(items, id: \.0.id) { item in
          Button { model.path.append(.card(item.0.id)) } label: {
            HStack(spacing: 10) {
              AgentMark(agent: { var a = item.1; a.starred = false; return a }(), size: 22)
              VStack(alignment: .leading, spacing: 2) {
                Text(item.0.title).font(Face.display(16, .bold)).foregroundStyle(Ink.fg).lineLimit(1)
                TailWho(card: item.0, agent: item.1)
              }
              Spacer(minLength: 6)
              Text(agoText(item.3)).font(Face.text(12)).foregroundStyle(Ink.faint)
              PenMark("desk:GEAR", color: Ink.muted).frame(width: 20, height: 20).rotationEffect(.degrees(0))
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(RoundedRectangle(cornerRadius: 12).fill(Tone.color(hue: item.1.hue, .wash).opacity(0.7)))
          }.buttonStyle(.plain)
        }
      }.padding(.top, 10)
    }
  }
}

/** Who has the card: whether the session has his answer, and whether it can hear (desk.mjs tailWho). */
struct TailWho: View {
  @EnvironmentObject var model: BoardModel
  let card: DeskCard
  let agent: Agent
  var body: some View {
    let name = agent.name, doing = card.status == "open" ? "is reworking it" : "is on it"
    let final = card.settled || card.options.contains { $0.final && card.choices.contains($0.key) }
    let link = linkOf(agent), h = model.desk?.heardOf(card)
    let (sign, words, tint): (String, String, Color) = {
      if final { return ("ring", "with \(name)", Ink.muted) }
      guard let link = link, let h = h else { return ("ring", "\(name) \(doing)", Ink.muted) }
      if h.heard == true {
        return link.state == "cut" ? ("ear-off", "\(name) has it, but is cut off", Ink.urgHigh) : link.state == "gone" ? ("plug", "\(name) had it, and is gone", Ink.muted) : ("tick", "\(name) has it, \(doing)", Ink.accent)
      }
      if link.state == "cut" { return ("ear-off", "\(name) cannot hear you", Ink.urgHigh) }
      if link.state == "gone" { return ("plug", h.heard == false ? "\(name) is gone, has not picked it up" : "\(name) is gone", Ink.muted) }
      if link.state == "asleep" { return ("ear-later", "\(name) is not listening", Ink.urgHigh) }
      if h.heard == nil { return link.state == "oncall" ? ("ear-later", "\(name) hears it on its next step", Ink.muted) : ("ring", "\(name) \(doing)", Ink.muted) }
      if h.late { return ("letter", "\(name) has not picked it up", Ink.urgHigh) }
      return link.state == "oncall" ? ("ear-later", "\(name) hears it on its next step", Ink.muted) : ("letter", "\(name) gets it", Ink.muted)
    }()
    HStack(spacing: 5) {
      if sign == "ring" { WorkingRing(working: card.status != "decided" || !final, color: Ink.accent).frame(width: 13, height: 13) }
      else { Sketch(sign, color: tint).frame(width: 14, height: 14) }
      Text(words).font(Face.text(13)).foregroundStyle(Ink.muted).lineLimit(1)
    }
  }
}

struct EndDivider: View {
  let title: String
  var body: some View {
    HStack(spacing: 10) {
      PenMark(doc: SVGReader.parse("<svg viewBox=\"0 0 300 8\" preserveAspectRatio=\"none\"><path d=\"M2 4.6 Q60 2.6 120 4.2 T238 3.6 T298 4.4\"/></svg>"), inks: PenInks(stroke: Ink.lineStrong, width: 1.4))
        .frame(height: 8).frame(maxWidth: .infinity)
      Text(title.uppercased()).font(Face.text(12, .semibold)).kerning(1.2).foregroundStyle(Ink.muted).fixedSize()
      PenMark(doc: SVGReader.parse("<svg viewBox=\"0 0 300 8\" preserveAspectRatio=\"none\"><path d=\"M2 4.2 Q70 5.4 140 3.8 T298 4.6\"/></svg>"), inks: PenInks(stroke: Ink.lineStrong, width: 1.4))
        .frame(height: 8).frame(maxWidth: .infinity)
    }.padding(.vertical, 4)
  }
}

/** The end of the Desk's list (desk.mjs endList): Done rows to tick off, Later, what is done; five, then "Show more". */
struct EndList: View {
  @EnvironmentObject var model: BoardModel
  let view: DeskModel.View
  let full: Bool
  var query = ""
  var body: some View {
    let d = model.desk!
    let items = endItems(view, d)
    let terms = query.lowercased().split(separator: " ").map(String.init)
    let shown = terms.isEmpty ? items : items.filter { s in terms.allSatisfy { "\(s.card.title) \(d.byAgent[s.card.agent]?.name ?? "") \(s.said)".lowercased().contains($0) } }
    if !shown.isEmpty || full {
      VStack(alignment: .leading, spacing: 0) {
        if !full { EndDivider(title: "Off your mind").padding(.bottom, 4) }
        ForEach(full ? shown : Array(shown.prefix(5)), id: \.card.id) { s in endRow(s) }
        if full && shown.isEmpty { Text(terms.isEmpty ? "Nothing yet." : "Nothing here has these words.").font(Face.text(15)).foregroundStyle(Ink.muted).padding(.vertical, 20) }
        if !full && shown.count > 5 {
          Button("Show more") { model.path.append(.off) }.font(Face.text(15, .semibold)).foregroundStyle(Ink.accent).frame(maxWidth: .infinity).padding(.vertical, 12)
        }
      }.padding(.top, 8)
    }
  }
  struct Item { var card: DeskCard; var g: String; var at: UInt64; var said: String }
  func endItems(_ v: DeskModel.View, _ d: DeskModel) -> [Item] {
    let open = v.landed.map { Item(card: $0, g: "open", at: $0.finished ?? 0, said: $0.summary.isEmpty ? "Done" : $0.summary) }
    let mine: (DeskCard) -> Bool = { c in v.all || d.deskOf(d.byAgent[c.agent]) == v.deskId || d.desks.isEmpty }
    var rest = [Item]()
    for c in v.snoozed { rest.append(Item(card: c, g: "later", at: c.snoozedAt ?? 0, said: c.snoozedUntil.map { "Until \(untilText($0))" } ?? "")) }
    for c in d.cards where c.status != "open" && mine(c) && !c.landed {
      let place = d.stackOf(c)
      if place == "done" { rest.append(Item(card: c, g: "done", at: c.decided ?? 0, said: answerOf(c))) }
      else if place == "trash" { rest.append(Item(card: c, g: "trash", at: (c.status == "shredded" ? c.shredded : c.created) ?? 0, said: c.status == "shredded" ? "Shredded" : "Withdrawn\(c.summary.isEmpty ? "" : ": \(c.summary)")")) }
    }
    rest.sort { $0.at > $1.at }
    return open + rest.filter { $0.g == "later" } + rest.filter { $0.g != "later" }
  }
  private func answerOf(_ c: DeskCard) -> String {
    if c.kind == "info" { return "Read" }
    if c.trusted { return "\(Words.trust)\(c.advisedLabels.isEmpty ? "" : ": \(c.advisedLabels)")" }
    let picked = c.options.filter { c.choices.contains($0.key) }.map { $0.label }.joined(separator: ", ")
    return (picked.isEmpty ? c.choices.joined(separator: ", ") : picked) + (c.settled ? " · settled by your answer" : c.status == "done" ? " · done by the agent" : "")
  }
  private func untilText(_ t: UInt64) -> String { let f = DateFormatter(); f.locale = Locale(identifier: "en_GB"); f.dateFormat = "EEE HH:mm"; return f.string(from: Date(timeIntervalSince1970: Double(t) / 1000)) }
  @ViewBuilder private func endRow(_ s: Item) -> some View {
    HStack(spacing: 12) {
      Group {
        if s.g == "open" { Button { model.archive(s.card.id) } label: { PenMark("desk:BOX", color: Ink.fg).frame(width: 24, height: 24) }.accessibilityLabel("Tick it off: \(s.card.title)") }
        else if s.g == "later" { Sketch("snooze", color: Ink.stampLater).frame(width: 22, height: 22) }
        else if s.card.archived { Button { model.archive(s.card.id, false) } label: { PenMark("desk:BOX_TICK", color: Ink.fg).frame(width: 24, height: 24) }.accessibilityLabel("Untick: back to tick off") }
        else { PenMark("desk:BOX_TICK", color: Ink.faint).frame(width: 24, height: 24) }
      }.frame(width: 28)
      Button { model.path.append(.card(s.card.id)) } label: {
        VStack(alignment: .leading, spacing: 1) {
          Text(s.card.title).font(Face.text(15, .medium)).foregroundStyle(s.g == "open" || s.g == "later" ? Ink.fg : Ink.muted)
            .strikethrough(s.g == "done" || s.g == "trash", color: Ink.faint).lineLimit(1)
          if !s.said.isEmpty { Text(s.said).font(Face.text(13)).foregroundStyle(Ink.faint).lineLimit(1) }
        }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
      }.buttonStyle(.plain)
      Text(agoText(s.at)).font(Face.text(12)).foregroundStyle(Ink.faint)
    }
    .padding(.vertical, 9)
    .overlay(alignment: .bottom) { Rectangle().fill(Ink.line).frame(height: 1) }
  }
}

/** The bar for the chosen cards (desk.mjs sel-bar): Later, Duck it, Read (infos), Shred, and clear. */
struct SelectionBar: View {
  @EnvironmentObject var model: BoardModel
  var body: some View {
    let chosen = model.selected.compactMap { model.card($0) }
    HStack(spacing: 6) {
      Text("\(chosen.count)").font(Face.text(16, .semibold)).frame(minWidth: 30)
      way("later", PenMark("ui:LATER_TAG").frame(width: 12, height: 24), Words.later)
      if chosen.contains(where: { $0.kind == "decision" }) { way("duck", PenMark("sketch:duck").frame(width: 26, height: 22), Words.duck) }
      if chosen.contains(where: { $0.kind == "info" }) { way("read", Sketch("tick").frame(width: 20, height: 20), "Read") }
      way("shred", Sketch("bin").frame(width: 20, height: 20), Words.shred)
      Button { model.selected = [] } label: { Image(systemName: "xmark").font(.system(size: 14, weight: .bold)).frame(width: 36, height: 36) }
        .accessibilityLabel("Clear the selection")
    }
    .foregroundStyle(Ink.fg)
    .padding(.horizontal, 10).padding(.vertical, 6)
    .glass(Capsule(), interactive: true)
    .padding(.bottom, 10)
    .transition(.move(edge: .bottom).combined(with: .opacity))
  }
  private func way<V: View>(_ name: String, _ icon: V, _ word: String) -> some View {
    Button { model.batch(name) } label: { VStack(spacing: 2) { icon; Text(word).font(Face.text(11, .medium)) }.frame(minWidth: 54, minHeight: 44) }
      .buttonStyle(.plain)
  }
}


/** The desk's name in the top bar: its own view, read again on every change of the board (a toolbar keeps what it built). */
struct DeskTitle: View {
  @EnvironmentObject var model: BoardModel
  var body: some View {
    let _ = model.version
    HStack(spacing: 8) {
      PenMark("sketch:desk").frame(width: 24, height: 24)
      Text(model.view?.deskName ?? "Desk").font(Face.display(19, .bold)).foregroundStyle(Ink.fg)
    }
    .id(model.version)
  }
}
