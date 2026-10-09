// CardScreen.swift: a card's own page (app/web/public/card.mjs): the knock, the title, who asks and when, the text and
// what it carries; the answers as big tiles (a note on each with the pen; several ticks and "Send the answer" where the
// card allows more than one), "or" I don't give a duck, What?? and the reverse card; once answered what was said and
// Take back; whether the session has it. Under it the card's own talk: what happened to it and the messages about it,
// with a field to write.
import SwiftUI
import TrommiClient
import TrommiCore

struct CardScreen: View {
  @EnvironmentObject var model: BoardModel
  let cardId: String
  var walk = false
  @State private var picked = Set<String>()
  @State private var notes: [String: String] = [:]
  @State private var noting: String? = nil
  @State private var note = ""
  @State private var loadedDraft = false
  @State private var picture: Int? = nil
  var body: some View {
    let _ = model.version
    if let c = model.card(cardId), let d = model.desk {
      let a = d.byAgent[c.agent]
      ScrollViewReader { proxy in
        ScrollView {
          VStack(alignment: .leading, spacing: 18) {
            lead(c, a, d)
            // the pictures that belong to no option stay in the strip; an option's own picture is on its tile
            let loose = looseAttachments(c)
            if !loose.isEmpty { Attachments(list: loose, onPicture: { i in picture = gallery(c).firstIndex { $0.key == nil && $0.nth == i } }) }
            answers(c, a)
            if !c.versions.isEmpty { versions(c) }
            CardLink(card: c)
            CardThread(card: c)
          }
          .padding(.horizontal, 18).padding(.top, 8).padding(.bottom, 24)
          .frame(maxWidth: 760).frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom) {
          if c.kind != "permission" {
            Composer(placeholder: askWords(c, a), agent: c.agent, cardId: c.id)
          }
        }
      }
      .background(Ink.bg.ignoresSafeArea())
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Menu {
            if let a = a { Button { model.path.append(.session(a.id)) } label: { Label("Open Session", systemImage: "bubble.left.and.bubble.right") } }
            Button { model.copyCard(c) } label: { Label("Copy", systemImage: "doc.on.doc") }
            if c.status == "open" && c.kind != "permission" {
              Button { model.snooze(c) } label: { Label(Words.later, systemImage: "zzz") }
              Button(role: .destructive) { model.shred(c, note: note) } label: { Label(Words.shred, systemImage: "trash") }
            }
          } label: { Image(systemName: "ellipsis").accessibilityLabel("More") }
        }
      }
      .onAppear { if !loadedDraft { loadDraft(c); loadedDraft = true } }
      .background { CardKeys(card: c) }
      .fullScreenCover(item: Binding(get: { picture.map { PicAt(at: $0) } }, set: { picture = $0?.at })) { p in
        let g = gallery(c)
        PicturesView(list: g.map { $0.ref }, start: p.at, options: g.map { e in e.key.flatMap { k in c.options.first { $0.key == k } }.map { o in pictureOption(c, o) } })
      }
    } else {
      VStack(spacing: 10) { Text("This question is not on the board any more.").font(Face.text(16)).foregroundStyle(Ink.muted) }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }
  }
  struct PicAt: Identifiable { let at: Int; var id: Int { at } }

  /** Option key -> its picture (OptionPictures: a section names it, file names, or one each), while the card is open. */
  private func optionPictures(_ c: DeskCard) -> [String: Int] {
    c.status == "open" && c.withAgent == nil ? OptionPictures.of(attachments: c.attachments, options: c.options, sections: c.sections) : [:]
  }
  /** The attachments without the pictures that sit on an option's tile. */
  private func looseAttachments(_ c: DeskCard) -> [JV] {
    let imgs = OptionPictures.images(c.attachments)
    let taken = Set(optionPictures(c).values.map { imgs[$0] })
    return c.attachments.filter { !taken.contains($0) }
  }
  /** The pictures large, in this order: each option's picture (the options' order), then the loose ones. `nth`: the
   *  loose picture's place in the strip. */
  private struct GalleryItem { var ref: JV; var key: String?; var nth: Int }
  private func gallery(_ c: DeskCard) -> [GalleryItem] {
    let imgs = OptionPictures.images(c.attachments), pics = optionPictures(c)
    var out = c.options.compactMap { o in pics[o.key].map { GalleryItem(ref: imgs[$0], key: o.key, nth: -1) } }
    let loose = looseAttachments(c).filter { kindOf($0) == "image" }
    out += loose.enumerated().map { GalleryItem(ref: $1, key: nil, nth: $0) }
    return out
  }
  private func pictureOption(_ c: DeskCard, _ o: Option) -> PictureOption {
    PictureOption(label: o.label, on: picked.contains(o.key), multiple: c.multiple) {
      if c.multiple { if picked.contains(o.key) { picked.remove(o.key) } else { picked.insert(o.key) }; saveDraft(c) }
      else { model.decide(c, keys: [o.key], note: note, notes: notes) }
    }
  }

  /** The question as it was before the agent revised it (card.mjs: "version n, as it was"). */
  private func versions(_ c: DeskCard) -> some View {
    DisclosureGroup("Earlier versions (\(c.versions.count))") {
      VStack(alignment: .leading, spacing: 14) {
        ForEach(c.versions.reversed(), id: \.objectVersion) { v in
          VStack(alignment: .leading, spacing: 6) {
            Text("Version \(v.objectVersion) · \(agoText(v.sentAt))").font(Face.text(12, .semibold)).foregroundStyle(Ink.faint)
            Text(v.content?["title"].string ?? "").font(Face.display(18, .bold))
            if let b = v.content?["body"].string, !b.isEmpty { RichText(text: b, size: 15, color: Ink.muted) }
            ForEach(Array((v.content?["options"].array ?? []).map(Option.init).enumerated()), id: \.offset) { _, o in
              Text("· \(o.label)").font(Face.text(15)).foregroundStyle(Ink.muted)
            }
            if let n = v.content?["change_note"].string, !n.isEmpty { Text(n).font(Face.text(14)).italic().foregroundStyle(Ink.muted) }
          }
          .padding(12).frame(maxWidth: .infinity, alignment: .leading)
          .background(RoundedRectangle(cornerRadius: 12).strokeBorder(Ink.lineStrong, style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
        }
      }.padding(.top, 8)
    }
    .font(Face.text(15, .medium)).tint(Ink.fg)
  }

  private func loadDraft(_ c: DeskCard) {
    guard let d = c.draft else { return }
    picked = Set((d["keys"].array ?? []).compactMap { $0.string })
    note = d["note"].string ?? ""
    for (k, v) in d["notes"].object ?? [:] { if let s = v.string { notes[k] = s } }
  }
  private func saveDraft(_ c: DeskCard) { model.setDraft(c, keys: Array(picked), note: note, notes: notes) }

  private func askWords(_ c: DeskCard, _ a: Agent?) -> String {
    let link = linkOf(a), n = a?.name
    if link?.state == "cut" { return "\(n ?? "The agent") cannot hear you right now. What you write waits for it…" }
    if link?.state == "gone" { return "\(n ?? "The agent") is gone. What you write waits for it…" }
    if link?.state == "asleep" || link?.state == "oncall" { return "Reaches \(n ?? "the agent") on its next step…" }
    return n.map { "Ask \($0) something, or say what is missing…" } ?? "Ask something, or say what is missing…"
  }

  @ViewBuilder private func lead(_ c: DeskCard, _ a: Agent?, _ d: DeskModel) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      if c.isKnock && c.status == "open", let w = c.knockWord {
        HStack(spacing: 6) { Sketch("knock", color: Ink.surface).frame(width: 15, height: 15); Text(w.uppercased()).font(Face.text(11, .bold)).kerning(1) }
          .foregroundStyle(Ink.surface).padding(.horizontal, 8).padding(.vertical, 4).background(RoundedRectangle(cornerRadius: 6).fill(Ink.urgency(c.urgency)))
      }
      Text(c.title).font(Face.display(30, .heavy)).foregroundStyle(Ink.fg).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
      HStack(spacing: 6) {
        if let a = a {
          Button { model.path.append(.session(a.id)) } label: {
            HStack(spacing: 5) { AgentMark(agent: a, size: 18, crown: false); Text(a.name).font(Face.text(14, .medium)).foregroundStyle(Tone.color(hue: a.hue, .pen)) }
          }.buttonStyle(.plain)
          Text("·").foregroundStyle(Ink.faint)
        }
        Text(agoText(c.revised ?? c.created)).font(Face.text(14)).foregroundStyle(Ink.muted)
        if let v = model.view, let at = (v.fresh.firstIndex { $0.id == c.id }) {
          Text("·").foregroundStyle(Ink.faint)
          Text("\(at + 1) of \(v.fresh.count)").font(Face.text(14)).foregroundStyle(Ink.muted)
        }
        if c.revised != nil { Text("· revised").font(Face.text(14)).foregroundStyle(Ink.muted) }
      }
      // merged by the agent (merge_cards): this one went into another, or replaces others
      if let into = c.mergedInto, let other = d.byCard[into] {
        Button { model.path.append(.card(into)) } label: { Text("Merged into Nr. \(other.number): \(other.title)").font(Face.text(15, .medium)).foregroundStyle(Ink.accent).multilineTextAlignment(.leading) }.buttonStyle(.plain)
      }
      if !c.mergedFrom.isEmpty {
        VStack(alignment: .leading, spacing: 4) {
          Text(c.mergedFrom.count == 1 ? "Replaces 1 question" : "Replaces \(c.mergedFrom.count) questions").font(Face.text(13, .semibold)).foregroundStyle(Ink.muted)
          ForEach(c.mergedFrom, id: \.self) { id in
            if let o = d.byCard[id] { Button { model.path.append(.card(id)) } label: { Text("Nr. \(o.number) · \(o.title)").font(Face.text(14)).foregroundStyle(Ink.accent).lineLimit(1) }.buttonStyle(.plain) }
          }
        }
      }
      if !c.urgencyReason.isEmpty && c.status == "open" { Text(c.urgencyReason).font(Face.text(15, .medium)).foregroundStyle(Ink.urgency(c.urgency)) }
      let text = c.sections.map { $0.filter { $0["key"].isNull }.compactMap { $0["text"].string }.joined(separator: "\n\n") } ?? c.body
      if !text.isEmpty { RichText(text: text) }
      if let h = c.html { RichText(text: "```html\n\(h)\n```") }
    }
  }

  // ---- the answers --------------------------------------------------------------------------------------

  @ViewBuilder private func answers(_ c: DeskCard, _ a: Agent?) -> some View {
    let hue = a?.hue ?? 162
    VStack(alignment: .leading, spacing: 10) {
      if c.status != "open" {
        done(c, a)
      } else if c.unsupported {
        UnsupportedLine(what: "card")
      } else if c.withAgent != nil {
        still(Words.revising, "It is with its session and comes back reworked.")
        Button(Words.takeBack) { model.takeBack(c) }.buttonStyle(QuietWay())
      } else if c.kind == "info" {
        Button { model.closeInfo(c) } label: {
          HStack(spacing: 10) { Sketch("tick", color: Ink.surface).frame(width: 22, height: 22); Text(Words.ack).font(Face.text(18, .semibold)) }.frame(maxWidth: .infinity, minHeight: 60)
        }.buttonStyle(TileStyle(lead: true, hue: hue))
        otherWays(c, hue)
      } else {
        ForEach(c.options, id: \.key) { o in option(c, o, hue) }
        if c.multiple {
          Button { model.decide(c, keys: Array(picked), note: note, notes: notes) } label: {
            Text("Send the answer").font(Face.text(17, .semibold)).frame(maxWidth: .infinity, minHeight: 54)
          }.buttonStyle(TileStyle(lead: true, hue: hue)).disabled(picked.isEmpty)
        }
        if let secs = c.sections?.filter({ !$0["key"].isNull }), secs.contains(where: { beyond($0) }) {
          DisclosureGroup("Options in detail") {
            VStack(alignment: .leading, spacing: 12) {
              ForEach(Array(secs.enumerated()), id: \.offset) { _, s in
                VStack(alignment: .leading, spacing: 4) {
                  Text(s["label"].string ?? "").font(Face.display(17, .bold)) + Text(s["recommended"].truthy ? "  recommended" : "").font(Face.text(13)).foregroundColor(Ink.urgHigh)
                  if beyond(s) { RichText(text: s["text"].string ?? "", size: 15) }
                }
              }
            }.padding(.top, 8)
          }.font(Face.text(15, .medium)).tint(Ink.fg)
        }
        if c.kind == "decision" {
          HStack(spacing: 10) { Rectangle().fill(Ink.lineStrong).frame(height: 1); Text("OR").font(Face.text(13, .semibold)).kerning(1.4).foregroundStyle(Ink.muted); Rectangle().fill(Ink.lineStrong).frame(height: 1) }
            .padding(.vertical, 4)
          Button { model.trust(c, note: note) } label: { EmptyView() }
            .buttonStyle(SideWay(kind: .duck) { on in
              // the duck is yellow at rest too; held, the button turns the palest yellow and all ink goes dark
              HStack(spacing: 14) {
                PenMark(doc: PenStore.doc("sketch:duck"), inks: PenInks(stroke: Ink.fg, duck: true, water: on ? Ink.duckInk : Ink.fg)).frame(width: 52, height: 44)
                Text(Words.trust).font(Face.text(18, .semibold)); Spacer()
              }.padding(.horizontal, 16)
            })
            .accessibilityLabel("\(Words.trust): your call\(c.advisedLabels.isEmpty ? "" : " · agent takes \(c.advisedLabels)")")
          otherWays(c, hue)
        }
      }
    }
  }
  private func beyond(_ s: JV) -> Bool {
    if s["html"].string != nil { return true }
    let norm: (String) -> String = { $0.lowercased().replacingOccurrences(of: #"[\s*_.:,;!?\-–—]+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces) }
    return !norm(s["text"].string ?? "").replacingOccurrences(of: norm(s["label"].string ?? ""), with: "").trimmingCharacters(in: .whitespaces).isEmpty
  }
  private func otherWays(_ c: DeskCard, _ hue: Int) -> some View {
    HStack(spacing: 10) {
      Button { model.what(c) } label: { EmptyView() }
        .buttonStyle(SideWay(kind: .what) { on in PenMark("sketch:what", color: on ? .white : Ink.fg, width: 2.2).frame(width: 90, height: 32) })
        .accessibilityLabel("What??")
      Button { model.handBack(c, text: note) } label: { EmptyView() }
        .buttonStyle(SideWay(kind: .reverse) { on in Sketch("reverse", color: on ? .white : Ink.fg).frame(width: 34, height: 34) })
        .accessibilityLabel("Reverse: back to the agent for rework, with the comments")
    }
  }
  @ViewBuilder private func option(_ c: DeskCard, _ o: Option, _ hue: Int) -> some View {
    let advised = c.recommended.contains(o.key)
    let on = picked.contains(o.key)
    let pic = optionPictures(c)[o.key].map { OptionPictures.images(c.attachments)[$0] }
    VStack(alignment: .leading, spacing: 6) {
     VStack(spacing: 0) {
      // the option's own picture, on its tile: picture and answer are one (a tap: large, with Choose under it)
      if let pic = pic {
        Button { picture = gallery(c).firstIndex { $0.key == o.key } } label: {
          AttachmentImage(ref: pic, contentMode: .fit).frame(maxWidth: .infinity, maxHeight: 220)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .padding([.horizontal, .top], 10)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Picture of \(o.label), open it large")
      }
      Button {
        if c.multiple { if on { picked.remove(o.key) } else { picked.insert(o.key) }; saveDraft(c) }
        else { model.decide(c, keys: [o.key], note: note, notes: notes) }
      } label: {
        HStack(alignment: .top, spacing: 12) {
          if c.multiple {
            PenMark(on ? "desk:BOX_TICK" : "desk:BOX", color: Ink.fg).frame(width: 26, height: 26)
          }
          VStack(alignment: .leading, spacing: 4) {
            Text(o.label).font(Face.display(19, .bold)).foregroundStyle(Ink.fg).multilineTextAlignment(.leading)
              .background(alignment: .bottomTrailing) { if advised { PenUnderline().stroke(Ink.urgHigh.opacity(0.75), style: StrokeStyle(lineWidth: 2.4, lineCap: .round)).frame(width: 60, height: 7).offset(y: 6) } }
            if let det = o.detail, !det.isEmpty { Text(det).font(Face.text(15)).foregroundStyle(Ink.muted).multilineTextAlignment(.leading) }
            if o.final { HStack(spacing: 4) { Sketch("tick", color: Ink.accent).frame(width: 13, height: 13); Text("settles it").font(Face.text(12, .medium)).foregroundStyle(Ink.accent) } }
          }
          Spacer(minLength: 4)
          if c.kind == "decision" {
            Button { noting = noting == o.key ? nil : o.key } label: { Sketch("pen", color: notes[o.key]?.isEmpty == false ? Ink.accent : Ink.muted).frame(width: 18, height: 18).padding(4) }
              .buttonStyle(.plain).accessibilityLabel("A note on \(o.label)")
          }
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
      }
      .buttonStyle(PressStyle())
      .accessibilityLabel("\(o.label)\(advised ? ", recommended by the agent" : "")\(o.final ? " (settles it)" : "")")
     }
     // ticked (several can hold): the same flat look as a chosen answer, the accent's wash and one accent line
     .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(on ? Ink.accentSoft : Ink.surface))
     .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
     .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(on ? Ink.accent : advised ? Ink.fg : Tone.color(hue: hue, .edge), lineWidth: on ? 1.5 : advised ? 2 : 1))
      if noting == o.key || notes[o.key]?.isEmpty == false {
        HStack(spacing: 8) {
          Sketch("pen", color: Ink.muted).frame(width: 16, height: 16)
          TextField("A note on \(o.label)", text: Binding(get: { notes[o.key] ?? "" }, set: { notes[o.key] = $0 }))
            .font(Face.text(15)).onSubmit { saveDraft(c) }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 10).fill(Ink.surface))
        .onChange(of: notes[o.key] ?? "") { _, _ in saveDraftSoon(c) }
      }
    }
  }
  @State private var draftTimer: Task<Void, Never>?
  private func saveDraftSoon(_ c: DeskCard) {
    draftTimer?.cancel()
    draftTimer = Task { try? await Task.sleep(nanoseconds: 900_000_000); if !Task.isCancelled { saveDraft(c) } }
  }
  private func still(_ label: String, _ detail: String = "", picked: Bool = false) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(label).font(Face.display(19, .bold)).foregroundStyle(Ink.fg)
      if !detail.isEmpty { Text(detail).font(Face.text(15)).foregroundStyle(Ink.muted) }
    }
    .padding(16).frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(picked ? Ink.accentSoft : Ink.surface))
    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(picked ? Ink.accent : Ink.lineStrong, lineWidth: picked ? 1.5 : 1))
  }
  @ViewBuilder private func done(_ c: DeskCard, _ a: Agent?) -> some View {
    let pickedLabels = c.options.filter { c.choices.contains($0.key) }.map { $0.label }.joined(separator: ", ")
    if c.landed || c.archived {
      HStack(spacing: 8) { Sketch("tick", color: Ink.accent).frame(width: 20, height: 20); (Text("Done").font(Face.text(16, .semibold)) + Text(c.summary.isEmpty ? "" : " · \(c.summary)").font(Face.text(16))).foregroundStyle(Ink.fg) }
      let yours = c.kind == "info" ? "" : c.trusted ? "\(Words.trust)\(c.advisedLabels.isEmpty ? "" : ": \(c.advisedLabels)")" : pickedLabels
      if !yours.isEmpty { still(yours, c.note.isEmpty ? "Your answer" : "Your answer · your note: \(c.note)", picked: true) }
      if c.landed {
        HStack(spacing: 10) {
          Button { model.archive(c.id) } label: { HStack { Sketch("archive", color: Ink.fg).frame(width: 22, height: 22); Text("Archive").font(Face.text(16, .semibold)) }.frame(maxWidth: .infinity, minHeight: 56) }
            .buttonStyle(TileStyle(lead: false, hue: a?.hue ?? 162))
          Button { model.what(c) } label: { PenMark("sketch:what", color: Ink.fg).frame(width: 70, height: 24).frame(maxWidth: .infinity, minHeight: 56) }
            .buttonStyle(TileStyle(lead: false, hue: a?.hue ?? 162))
        }
      } else {
        Text("Archived: it lies in Off your mind.").font(Face.text(14)).foregroundStyle(Ink.muted)
        Button("Back to Desk") { model.archive(c.id, false) }.buttonStyle(QuietWay())
      }
    } else {
      let said = c.status == "shredded" ? "Shredded" : c.kind == "info" ? "Read" : c.trusted ? "\(Words.trust)\(c.advisedLabels.isEmpty ? "" : ": \(c.advisedLabels)")" : pickedLabels.isEmpty ? "Withdrawn by the agent" : pickedLabels
      if c.status != "shredded" && c.kind != "info" && !c.trusted && !pickedLabels.isEmpty {
        // as the desktop: every option stays in its place, the chosen one in the accent's wash, the others dimmed
        ForEach(c.options, id: \.key) { o in
          let on = c.choices.contains(o.key)
          let noteOn = c.optionNotes[o.key] ?? ""
          answered(o.label, [on && !c.note.isEmpty ? "Your note: \(c.note)" : "", noteOn.isEmpty ? "" : "Your note: \(noteOn)"].filter { !$0.isEmpty }.joined(separator: " · "), on: on)
        }
      } else {
        still(said, c.note.isEmpty ? "" : "Your note: \(c.note)", picked: true)
        ForEach(c.options.filter { c.optionNotes[$0.key]?.isEmpty == false }, id: \.key) { o in still(o.label, "Your note: \(c.optionNotes[o.key]!)") }
      }
      MarksLine(marks: model.board?.cards[c.id]?.answer?.marks ?? [])
      if c.settled { still("✓ \(Words.settled)", "\(a?.name ?? "The agent") marked this answer as final: nothing follows from it.") }
      if let w = model.board?.cards[c.id]?.withdrawReason, !w.isEmpty { still("Why it was withdrawn", w) }
      else if !c.summary.isEmpty { still("Done by the agent", c.summary) }
      if c.status == "shredded" || !c.choices.isEmpty || c.trusted || (c.kind == "info" && c.read != nil) {
        // a quiet text action, no pill
        Button { model.reopen(c.id) } label: { Text(Words.takeBack).font(Face.text(15, .medium)).underline().foregroundStyle(Ink.muted).frame(minHeight: 44).contentShape(Rectangle()) }
          .buttonStyle(.plain)
      }
    }
  }
  /** An option of an answered card (card.css .tc-opt.is-still, .is-picked): the chosen one flat in the accent's light
   *  wash with ONE accent line, the accent's word and a tick; the others dimmed. Never pressed in (no shade inside, no
   *  second line, not smaller: his word, 9 October). */
  private func answered(_ label: String, _ detail: String, on: Bool) -> some View {
    HStack(alignment: .top, spacing: 10) {
      VStack(alignment: .leading, spacing: 4) {
        Text(label).font(Face.display(19, .bold)).foregroundStyle(on ? Ink.accent : Ink.fg)
        if !detail.isEmpty { Text(detail).font(Face.text(15)).foregroundStyle(Ink.muted) }
      }
      Spacer(minLength: 4)
      if on { Sketch("tick", color: Ink.accent).frame(width: 20, height: 20) }
    }
    .padding(16).frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(on ? Ink.accentSoft : Ink.surface))
    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(on ? Ink.accent : Ink.line, lineWidth: on ? 1.5 : 1))
    .opacity(on ? 1 : 0.45)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(on ? "\(label), your answer" : "\(label), not chosen")
  }
}

/** The finger on an option: a little darker and a hair smaller (0.97), flat; never a shade inside. */
struct PressStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .background(Ink.fg.opacity(configuration.isPressed ? 0.07 : 0))
      .scaleEffect(configuration.isPressed ? 0.97 : 1).animation(.easeOut(duration: 0.1), value: configuration.isPressed)
  }
}
struct QuietWay: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.font(Face.text(16, .semibold)).foregroundStyle(Ink.accent).padding(.horizontal, 16).padding(.vertical, 10)
      .background(Capsule().strokeBorder(Ink.accent.opacity(0.5)))
      .opacity(configuration.isPressed ? 0.6 : 1)
  }
}

/** Under the answers: whether the session can hear, whether it has his answer, and the step in its terminal (card.mjs cardLink). */
struct CardLink: View {
  @EnvironmentObject var model: BoardModel
  let card: DeskCard
  var body: some View {
    let a = model.desk?.byAgent[card.agent]
    if let link = linkOf(a), card.status != "shredded", card.status != "done", !card.settled {
      let h = model.desk?.heardOf(card)
      let n = a?.name ?? "The agent"
      let state = link.state != "live" ? link : nil
      if h == nil {
        if let s = state, s.state != "oncall" { LinkNote(link: s) }
      } else if h!.heard == nil {
        if let s = state { LinkNote(link: s, receipt: "Your answer waits for \(n).") }
      } else {
        let mins = max(1, Int((Double(h!.waiting) / 60000).rounded()))
        let receipt = h!.heard == true ? "\(n) has your answer." : h!.late ? "\(n) has not picked up your answer, sent \(mins) min ago." : "Your answer is on its way to \(n)."
        if let s = state { LinkNote(link: s, receipt: receipt) }
        // heard and all is well: no box of its own, the pressed-in answer says it (his word, 8 October)
        else if h!.heard != true { LinkNote(link: nil, receipt: receipt, sign: "letter", late: h!.late) }
      }
    }
  }
}
struct LinkNote: View {
  let link: LinkWords?
  var receipt = ""
  var sign: String? = nil
  var late = false
  var body: some View {
    let tone: Color = link.map { $0.state == "cut" || $0.state == "asleep" ? Ink.urgHigh : Ink.muted } ?? (late ? Ink.urgHigh : sign == "tick" ? Ink.accent : Ink.muted)
    HStack(alignment: .top, spacing: 10) {
      Sketch(sign ?? link?.sign ?? "ear", color: tone).frame(width: 20, height: 20)
      VStack(alignment: .leading, spacing: 4) {
        if !receipt.isEmpty { Text(receipt).font(Face.text(15, .medium)).foregroundStyle(Ink.fg) }
        if let l = link, l.state != "live" { Text(l.line).font(Face.text(14)).foregroundStyle(Ink.muted) }
        if let say = link?.fixSay, let code = link?.fixCode { VStack(alignment: .leading, spacing: 4) { Text(say).font(Face.text(13)).foregroundStyle(Ink.muted); CodeChip(text: code) } }
        else if late { VStack(alignment: .leading, spacing: 4) { Text("Look at its terminal: type anything to wake it, or reconnect it with").font(Face.text(13)).foregroundStyle(Ink.muted); CodeChip(text: "/mcp → trommi → Reconnect") } }
      }
    }
    .padding(12).frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 12).fill(Ink.surface.opacity(0.7)))
    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Ink.lineStrong))
  }
}

/** A card's own talk: what happened to it and the messages about it (BoardState.messagesOfCard). */
struct CardThread: View {
  @EnvironmentObject var model: BoardModel
  let card: DeskCard
  var body: some View {
    let msgs = model.desk?.messagesOfCard(card.id) ?? []
    let older = model.board?.timelines[timelineKeyOf("chat", "card/\(card.id)")]?.items.values.contains { $0.itemState == "header" } ?? false
    VStack(alignment: .leading, spacing: 10) {
      if !msgs.isEmpty || older {
        EndDivider(title: "The talk")
        if older {
          Button("Show Earlier Messages") { Task { await model.loadOlder(card: card.id) } }.font(Face.text(14, .semibold)).foregroundStyle(Ink.accent)
        }
        ForEach(msgs) { m in MessageView(message: m, inCard: true) }
      }
    }
    .task(id: card.id) { if older { await model.loadOlder(card: card.id) } }
  }
}

/** The keys of a card's page on an iPad with a keyboard (ui.mjs SHORT): 1–9 an option, R duck, E What??, L Later, B reverse. */
struct CardKeys: View {
  @EnvironmentObject var model: BoardModel
  let card: DeskCard
  var body: some View {
    ZStack {
      if card.status == "open" && card.kind == "decision" && !card.multiple {
        ForEach(Array(card.options.prefix(9).enumerated()), id: \.offset) { i, o in
          Button("") { model.decide(card, keys: [o.key]) }.keyboardShortcut(KeyEquivalent(Character(String(i + 1))), modifiers: [])
        }
        Button("") { model.trust(card) }.keyboardShortcut("r", modifiers: [])
      }
      if card.status == "open" && card.kind != "permission" {
        Button("") { model.what(card) }.keyboardShortcut("e", modifiers: [])
        Button("") { model.snooze(card) }.keyboardShortcut("l", modifiers: [])
        Button("") { model.handBack(card) }.keyboardShortcut("b", modifiers: [])
      }
      if card.status == "open" && card.kind == "info" { Button("") { model.closeInfo(card) }.keyboardShortcut(.return, modifiers: []) }
    }
    .opacity(0).accessibilityHidden(true)
  }
}

/**
 * The three side answers (I don't give a duck, What??, the reverse card): calm at rest, and held under the finger they
 * take the colour the web gives them under the pointer (card.css .tc-whatever, .tc-wtf, .tc-reverse :hover): the palest
 * yellow with dark ink, a violet with white, the wild card's four colours round an ink middle with white. A light tap
 * is felt as the colour comes.
 */
struct SideWay<L: View>: ButtonStyle {
  enum Kind { case duck, what, reverse }
  let kind: Kind
  @ViewBuilder let face: (Bool) -> L
  func makeBody(configuration: Configuration) -> some View { SideWayBody(kind: kind, on: configuration.isPressed, face: face) }
}
private struct SideWayBody<L: View>: View {
  let kind: SideWay<L>.Kind
  let on: Bool
  let face: (Bool) -> L
  @Environment(\.colorScheme) private var scheme
  private static var unoInk: Color { Color(hex: 0x14161a) }
  var body: some View {
    let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
    face(on)
      .foregroundStyle(on ? (kind == .duck ? Ink.duckInk : .white) : Ink.fg)
      .frame(maxWidth: .infinity, minHeight: 64)
      .background {
        ZStack {
          shape.fill(Ink.surface)
          shape.fill(Ink.accent.opacity(0.09))
          if on {
            switch kind {
            case .duck: shape.fill(Ink.duckPale)
            case .what: shape.fill(Color(hex: 0x7a5bc7))
            case .reverse:
              // four flat fields round a point a little off the middle, the card's ink ground in the middle
              AngularGradient(stops: [.init(color: Color(hex: 0xd9483b), location: 0), .init(color: Color(hex: 0xd9483b), location: 0.25),
                                      .init(color: Color(hex: 0xf3c52f), location: 0.25), .init(color: Color(hex: 0xf3c52f), location: 0.5),
                                      .init(color: Color(hex: 0x3f9f58), location: 0.5), .init(color: Color(hex: 0x3f9f58), location: 0.75),
                                      .init(color: Color(hex: 0x2f70c4), location: 0.75), .init(color: Color(hex: 0x2f70c4), location: 1)],
                              center: UnitPoint(x: 0.53, y: 0.47), angle: .degrees(-83))
                .clipShape(shape)
              Ellipse().fill(Self.unoInk).frame(width: 50, height: 54)
            }
          }
        }
      }
      .overlay(shape.strokeBorder(on ? (kind == .duck ? Ink.duckInk : kind == .what ? Color(hex: 0x7a5bc7).opacity(0.7) : Self.unoInk) : (scheme == .dark ? Ink.lineStrong : .clear), lineWidth: on ? 1.5 : 1))
      .contentShape(shape)
      .scaleEffect(on ? 0.97 : 1)
      .animation(.easeOut(duration: 0.12), value: on)
      .sensoryFeedback(.impact(weight: .light), trigger: on) { _, now in now }
  }
}
