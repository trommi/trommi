// MoreScreens.swift: Blitz (every open question, one after the other), Off your mind (one list: what is being worked
// on, then what is done; its search), Artifacts (Media and Pages: what the agents published and sent), a picture in full screen, the corner note (the yellow
// slip to the crowned session), the drawing a session wears.
import SwiftUI
import ShareInbox
import TrommiClient
import TrommiCore
import UniformTypeIdentifiers
#if canImport(UIKit)
import UIKit
#endif

// ---- Blitz --------------------------------------------------------------------------------------------------

struct BlitzScreen: View {
  @EnvironmentObject var model: BoardModel
  @State private var current: String?
  var body: some View {
    let _ = model.version
    let walk = (model.view?.deskCards() ?? []) + (model.view?.landed ?? [])
    let id = current.flatMap { c in walk.contains { $0.id == c } ? c : nil } ?? walk.first?.id
    Group {
      if let id = id {
        CardScreen(cardId: id, walk: true)
          .id(id)
          .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
              let at = walk.firstIndex { $0.id == id } ?? 0
              Button { if at + 1 < walk.count { current = walk[at + 1].id } } label: { HStack(spacing: 4) { Text("\(at + 1) of \(walk.count)").font(Face.text(14)); Image(systemName: "chevron.right") } }
                .disabled(at + 1 >= walk.count)
            }
          }
      } else {
        VStack(spacing: 14) {
          PenMark("desk:BOLT").frame(width: 48, height: 48)
          Text("All done.").font(Face.display(30, .heavy))
          Text("Nothing waits for you.").font(Face.text(16)).foregroundStyle(Ink.muted)
          Button("Back to Desk") { model.path = [] }.buttonStyle(QuietWay())
        }.frame(maxWidth: .infinity, maxHeight: .infinity).background(Ink.bg)
      }
    }
    .navigationTitle(Words.walk)
  }
}

// ---- Off your mind ------------------------------------------------------------------------------------------

struct OffScreen: View {
  @EnvironmentObject var model: BoardModel
  @State private var query = ""
  var body: some View {
    let _ = model.version
    ScrollView {
      VStack(alignment: .leading, spacing: 12) {
        HStack(spacing: 0) {
          Text("Off your ").font(Face.display(34, .heavy))
          Text("mind").font(Face.display(34, .heavy)).background(alignment: .bottom) { PenUnderline().stroke(Ink.accent, lineWidth: 2.2).frame(height: 8).offset(y: 6) }
        }.padding(.top, 10)
        if let v = model.view { OffList(view: v, full: true, query: query) }
      }
      // the last row scrolls clear of the floating tab bar
      .padding(.horizontal, 16).padding(.bottom, 120)
      .frame(maxWidth: 760).frame(maxWidth: .infinity)
    }
    .searchable(text: $query, prompt: "Search the list")
    .background(Ink.bg)
    .navigationBarTitleDisplayMode(.inline)
  }
}

/**
 * Off your mind as ONE list (his decision, 8 October): what the agents are still working on first (a small pulsing
 * green dot, no gear), then what is done (Done rows with the drawn archive box, Later, answered, shredded). One line per
 * row, the title only; a tap opens the card (OffRow: Archive strikes the title through, then archives). On the Desk five rows, then Show More (this list in full, with its search).
 */
struct OffList: View {
  @EnvironmentObject var model: BoardModel
  let view: DeskModel.View
  let full: Bool
  var query = ""
  struct Row: Identifiable { var card: DeskCard; var g: String; var id: String { card.id } }
  var body: some View {
    let d = model.desk!
    let rows = OffList.rows(view, d)
    let terms = query.lowercased().split(separator: " ").map(String.init)
    let shown = terms.isEmpty ? rows : rows.filter { r in terms.allSatisfy { "\(r.card.title) \(d.byAgent[r.card.agent]?.name ?? "")".lowercased().contains($0) } }
    if !shown.isEmpty || full {
      VStack(alignment: .leading, spacing: 0) {
        if !full { EndDivider(title: "Off your mind").padding(.bottom, 4) }
        ForEach(full ? shown : Array(shown.prefix(5))) { r in OffRow(card: r.card, g: r.g) }
        if full && shown.isEmpty { Text(terms.isEmpty ? "Nothing yet." : "Nothing here has these words.").font(Face.text(15)).foregroundStyle(Ink.muted).padding(.vertical, 20) }
        if !full && shown.count > 5 {
          Button("Show More") { model.path.append(.off) }.font(Face.text(15, .semibold)).foregroundStyle(Ink.accent).frame(maxWidth: .infinity).padding(.vertical, 12)
        }
      }.padding(.top, 8)
    }
  }
  /** Being worked on first (the newest move first), then the end list's order (EndList.endItems: Done rows, Later, the rest). */
  static func rows(_ v: DeskModel.View, _ d: DeskModel) -> [Row] {
    let working = d.tasks.filter { $0.state == "working" }
    let decidedHere = d.cards.filter { c in c.status == "decided" && d.stackOf(c) == "works" && v.here.contains { $0.id == c.agent } }
    let busy = (v.revising.filter { d.stackOf($0) == "works" } + decidedHere).map { c -> (DeskCard, UInt64) in
      let line = working.first { $0.cardId == c.id } ?? working.filter { $0.agent == c.agent && $0.cardId == nil }.max { $0.updated < $1.updated }
      return (c, line?.updated ?? (c.status == "open" ? c.withAgent : c.decided) ?? 0)
    }.sorted { $0.1 > $1.1 }.map { Row(card: $0.0, g: "works") }
    let seen = Set(busy.map { $0.id })
    let rest = EndList(view: v, full: true).endItems(v, d).filter { !seen.contains($0.card.id) }.map { Row(card: $0.card, g: $0.g) }
    return busy + rest
  }
}

/** One row of Off your mind: the title from the left edge; at the right the dot (being worked on), the drawn archive
 *  box (finished, not archived yet: his word, 9 October, "an Archive button instead of ticking, and it strikes the row
 *  through"), Later's Z, or the ticked box. Archive draws the pen's line across the title and dims the row, then
 *  archives the card as the tick did (the toast's Undo takes it back); what he archived stays struck through. */
struct OffRow: View {
  @EnvironmentObject var model: BoardModel
  let card: DeskCard
  let g: String
  /** Archive was pressed here: the line is drawn, the card is archived a moment later. */
  @State private var striking = false
  private static let strikeSeconds = 0.7
  var body: some View {
    let c = card
    let struck = striking || (c.archived && g != "open")
    HStack(spacing: 8) {
      Button { model.path.append(.card(c.id)) } label: {
        Text(c.title.isEmpty ? "(no title)" : c.title).font(Face.text(16, .medium))
          .foregroundStyle(g == "done" || g == "trash" ? Ink.muted : Ink.fg)
          .strikethrough(g == "trash", color: Ink.faint)
          .lineLimit(1).truncationMode(.tail)
          .overlay { StrikeLine().trim(from: 0, to: struck ? 1 : 0).stroke(striking ? Ink.fg : Ink.muted, style: StrokeStyle(lineWidth: 1.6, lineCap: .round)).accessibilityHidden(true) }
          .opacity(striking ? 0.5 : 1)
          .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(g == "works" ? "\(c.title), being worked on" : c.title)
      Group {
        if g == "works" { PulseDot() }
        else if g == "open" {
          Button { archive() } label: { Sketch("archive", color: Ink.fg).frame(width: 22, height: 22).frame(width: 44, height: 44).contentShape(Rectangle()) }
            .buttonStyle(.plain).disabled(striking).opacity(striking ? 0.5 : 1).accessibilityLabel("Archive: \(c.title)")
        }
        else if g == "later" { Sketch("snooze", color: Ink.stampLater).frame(width: 20, height: 20) }
        else { PenMark("desk:BOX_TICK", color: Ink.faint).frame(width: 22, height: 22) }
      }.frame(width: 44, height: 44)
    }
    .overlay(alignment: .bottom) { Rectangle().fill(Ink.line).frame(height: 1) }
    // (archived: the row is struck by its state from here on; taken back by Undo, the line goes)
    .onChange(of: c.archived) { _, _ in striking = false }
  }
  private func archive() {
    let id = card.id
    let still = UIAccessibility.isReduceMotionEnabled
    withAnimation(still ? nil : .easeOut(duration: 0.45)) { striking = true }
    Task { @MainActor in
      if !still { try? await Task.sleep(nanoseconds: UInt64(OffRow.strikeSeconds * 1_000_000_000)) }
      model.archive(id)
      // (not saved: the alert toast says so, and the line is taken off again)
      try? await Task.sleep(nanoseconds: 4_000_000_000)
      if striking { withAnimation(.easeOut(duration: 0.2)) { striking = false } }
    }
  }
}

/** The pen's line across a title: left to right, a little uneven, slightly rising. */
struct StrikeLine: Shape {
  func path(in r: CGRect) -> Path {
    var p = Path()
    let y = r.midY + 1
    p.move(to: CGPoint(x: r.minX - 1, y: y + 0.8))
    p.addCurve(to: CGPoint(x: r.maxX + 2, y: y - 0.8), control1: CGPoint(x: r.minX + r.width * 0.3, y: y - 1.4), control2: CGPoint(x: r.minX + r.width * 0.68, y: y + 1.5))
    return p
  }
}

/** The small green dot of something still being worked on: it breathes. */
struct PulseDot: View {
  @State private var on = false
  var body: some View {
    Circle().fill(Ink.stDone).frame(width: 8, height: 8)
      .background(Circle().fill(Ink.stDone.opacity(0.35)).frame(width: 16, height: 16).scaleEffect(on ? 1 : 0.4).opacity(on ? 0 : 1))
      .onAppear { withAnimation(.easeOut(duration: 1.4).repeatForever(autoreverses: false)) { on = true } }
      .accessibilityHidden(true)
  }
}

// ---- Artifacts ----------------------------------------------------------------------------------------------

/** Artifacts (Media and Pages in one, his decision 8 October): what the agents published, and the pictures they sent in
 *  their talk; a filter All · Media · Pages. Route .media opens it on All, .pages on Pages. */
struct MediaScreen: View {
  let pages: Bool
  var body: some View { ArtifactsScreen(start: pages ? .pages : .all) }
}
struct ArtifactsScreen: View {
  enum Filter: String, CaseIterable, Identifiable { case all = "All", media = "Media", pages = "Pages"; var id: String { rawValue } }
  @EnvironmentObject var model: BoardModel
  @State private var filter: Filter
  init(start: Filter = .all) { _filter = State(initialValue: start) }
  var body: some View {
    let _ = model.version
    let pubs = (model.board?.published.values.filter { $0.objectState != "closed" } ?? []).sorted { $0.envelopeNumber > $1.envelopeNumber }
    let isPage: (PublishedObject) -> Bool = { p in let k = kindOf(p.attachments.first ?? .null); return k == "html" || k == "file" }
    let items = pubs.filter { filter == .all || (filter == .pages) == isPage($0) }
    // the pictures the agents sent in their talk count as Media
    let sent: [JV] = filter == .pages ? [] : (model.desk?.agents ?? []).flatMap { a in (model.desk?.messagesOf(agent: a.id) ?? []).filter { $0.from == "agent" }.flatMap { $0.attachments.filter { kindOf($0) == "image" } } }
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        Text("Artifacts").font(Face.display(34, .heavy)).padding(.top, 10)
        Picker("Show", selection: $filter) { ForEach(Filter.allCases) { Text($0.rawValue).tag($0) } }.pickerStyle(.segmented)
        if items.isEmpty && sent.isEmpty {
          Text(filter == .pages ? "No pages yet: what the agents publish shows here." : filter == .media ? "No pictures yet." : "Nothing yet: what the agents publish and send shows here.")
            .font(Face.text(15)).foregroundStyle(Ink.muted)
        }
        ForEach(items, id: \.objectId) { p in PublishedCard(published: p) }
        if !sent.isEmpty {
          if filter == .all { Text("SENT IN THE TALK").font(Face.text(12, .semibold)).kerning(1.2).foregroundStyle(Ink.muted).padding(.top, 6) }
          LazyVGrid(columns: [GridItem(.adaptive(minimum: 104), spacing: 6)], spacing: 6) {
            ForEach(Array(sent.enumerated()), id: \.offset) { _, a in AttachmentImage(ref: a).frame(height: 104).clipShape(RoundedRectangle(cornerRadius: 8)) }
          }
        }
      }
      .padding(.horizontal, 16).padding(.bottom, 40)
      .frame(maxWidth: 760).frame(maxWidth: .infinity)
    }
    .background(Ink.bg)
    .navigationBarTitleDisplayMode(.inline)
  }
}

// ---- a picture in full screen -------------------------------------------------------------------------------------

struct PictureScreen: View {
  @EnvironmentObject var model: BoardModel
  let cardId: String
  let start: Int
  var body: some View {
    PicturesView(list: (model.card(cardId)?.attachments ?? []).filter { kindOf($0) == "image" }, start: start)
  }
}
/** Under a picture that belongs to an option (a card's page): the option's label and a glass button that chooses it. */
struct PictureOption {
  var label: String
  var on: Bool
  var multiple: Bool
  var choose: () -> Void
}
struct PicturesView: View {
  let list: [JV]
  let start: Int
  /** Per picture its option, where it has one (same order as `list`). */
  var options: [PictureOption?] = []
  @State private var at = 0
  /** Ticks flipped here (several answers allowed): the button shows them at once. */
  @State private var flipped = Set<Int>()
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    ZStack(alignment: .topTrailing) {
      Color.black.ignoresSafeArea()
      TabView(selection: $at) {
        ForEach(Array(list.enumerated()), id: \.offset) { i, a in
          ZoomableImage(ref: a).tag(i)
        }
      }
      .tabViewStyle(.page(indexDisplayMode: list.count > 1 ? .automatic : .never))
      Button { dismiss() } label: { Image(systemName: "xmark").font(.system(size: 16, weight: .bold)).foregroundStyle(.white).frame(width: 44, height: 44).glass(Circle(), interactive: true) }
        .padding(16)
    }
    .overlay(alignment: .bottom) {
      if at < options.count, let o = options[at] {
        // the option this picture belongs to, and choosing it right here
        let on = o.on != flipped.contains(at)
        Button {
          o.choose()
          if o.multiple { if flipped.contains(at) { flipped.remove(at) } else { flipped.insert(at) } } else { dismiss() }
        } label: {
          HStack(spacing: 10) {
            if o.multiple { Image(systemName: on ? "checkmark.square.fill" : "square").font(.system(size: 18, weight: .semibold)) }
            Text(o.label).font(Face.text(17, .semibold)).lineLimit(2).multilineTextAlignment(.leading)
            Spacer(minLength: 8)
            if !o.multiple { Text("Choose").font(Face.text(15, .semibold)).padding(.horizontal, 14).padding(.vertical, 8).background(Capsule().fill(Ink.accent)).foregroundStyle(Ink.accentFg) }
          }
          .foregroundStyle(.white)
          .padding(.leading, 18).padding(.trailing, 8).frame(minHeight: 56)
          .glass(Capsule(), interactive: true)
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 16).padding(.bottom, 40)
        .accessibilityLabel(o.multiple ? "\(o.label), \(on ? "ticked" : "not ticked")" : "Choose \(o.label)")
      }
    }
    .onAppear { at = start }
  }
}
struct ZoomableImage: View {
  let ref: JV
  @State private var scale: CGFloat = 1
  @State private var last: CGFloat = 1
  var body: some View {
    AttachmentImage(ref: ref, contentMode: .fit)
      .scaleEffect(scale)
      .gesture(MagnificationGesture().onChanged { scale = max(1, last * $0) }.onEnded { _ in last = scale })
      .onTapGesture(count: 2) { withAnimation { scale = scale > 1 ? 1 : 2.5; last = scale } }
  }
}

// ---- the corner note --------------------------------------------------------------------------------------------

/** The yellow slip in the corner: the note he writes to the desk's crowned session (notes.mjs). */
struct NoteButton: View {
  @EnvironmentObject var model: BoardModel
  @State private var open = false
  var body: some View {
    let _ = model.version
    let has = !(model.desk?.notes.filter { $0.held.isNull }.isEmpty ?? true)
    Button { open = true } label: { PenMark("sidebar:NOTE_ICON").frame(width: 30, height: 30).opacity(has ? 1 : 0.85) }
      .accessibilityLabel("Note")
      .sheet(isPresented: $open) { NoteSheet().presentationDetents([.medium, .large]) }
      // something was dropped onto the app (NoteDrop.swift): the note opens and shows it arrive
      .onReceive(NotificationCenter.default.publisher(for: .trommiNoteOpen)) { _ in open = true }
  }
}
/** The note as a sheet (the iPad's corner button). */
struct NoteSheet: View {
  @Environment(\.dismiss) private var dismiss
  var body: some View { NoteScreen(onDone: { dismiss() }).padding(.top, 10).background(Ink.noteYellow.ignoresSafeArea()) }
}

/**
 * The note (notes.mjs): the yellow slip to the desk's crowned session, a full page of yellow paper on the iPhone (the
 * tab pill stays, lit on Note), a sheet on the iPad. From the top: "To: …" on its own row, the words, the pictures,
 * the paperclip · bin · send row.
 * Words, pictures and files (encrypted like the composer's); kept as a note object while he writes (every device sees
 * it), sent with a three-second Undo, then gone from the desk.
 */
struct NoteScreen: View {
  @EnvironmentObject var model: BoardModel
  @Environment(\.horizontalSizeClass) private var hSize
  var onDone: (() -> Void)? = nil
  /** The capsule shows below it: the paper runs on under the glass, the last line stays above it. */
  @State private var text = ""
  @State private var noteId: String?
  @State private var files: [JV] = []          // uploaded attachment references
  @State private var loaded = false
  @State private var uploading = false
  @State private var pickingPhotos = false
  @State private var importing = false
  @State private var camera = false
  /** This note is the one on screen: it takes what is dropped onto the app (NoteDrop.swift). */
  @State private var shown = false
  /** A drop is being uploaded. */
  @State private var dropping = false
  /** Another session than the crowned one, picked with the "To" chip. */
  @State private var to: String? = nil
  @FocusState private var focused: Bool
  var body: some View {
    let _ = model.version
    // on All Desks the note goes to one desk's crowned session: the one he used last, or he picks (his decision, 8 October)
    let all = model.view?.all == true
    let crowns = deskCrowns
    let crown = all ? (crowns.first { $0.desk.id == lastNoteDesk } ?? crowns.first)?.agent : model.desk?.crownOf(desk: model.deskId)
    let target = to.flatMap { id in model.desk?.agents.first { $0.id == id } } ?? crown
    let empty = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && files.isEmpty
    VStack(alignment: .leading, spacing: 10) {
      // "To: …" on a row of its own: the words begin below it and never run under it (build 20: as a navigation bar
      // item the glass pill floated over the first lines)
      HStack { Spacer(minLength: 0); recipient(target) }
      TextEditor(text: $text)
        .font(Face.text(18)).foregroundStyle(Ink.noteInk)
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .focused($focused)
        // the words give way, never the row below: in a short panel (keyboard up, pictures attached) the text area
        // shrinks and scrolls, the pictures and the paperclip · bin · send row keep their place above the keyboard
        .frame(minHeight: 44)
        .layoutPriority(-1)
        .overlay(alignment: .topLeading) {
          if text.isEmpty { Text("Write a note…").font(Face.text(18)).foregroundStyle(Ink.noteInk.opacity(0.45)).padding(.top, 8).padding(.leading, 5).allowsHitTesting(false) }
        }
      if !files.isEmpty || uploading || dropping {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 8) {
            ForEach(Array(files.enumerated()), id: \.offset) { i, f in
              ZStack(alignment: .topTrailing) {
                if kindOf(f) == "image" { AttachmentImage(ref: f).frame(width: 72, height: 72).clipShape(RoundedRectangle(cornerRadius: 8)) }
                else { VStack { Sketch("clip", color: Ink.noteInk).frame(width: 18, height: 18); Text(f["file_name"].string ?? "file").font(Face.text(11)).lineLimit(2) }.frame(width: 72, height: 72).background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.5))) }
                Button { files.remove(at: i); keepSoon() } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Ink.noteInk) }.offset(x: 6, y: -6)
                  .accessibilityLabel("Remove")
              }
            }
            if uploading || dropping { ProgressView().frame(width: 72, height: 72) }
          }.padding(.top, 6)
        }
      }
      HStack(spacing: 6) {
        Menu {
          Button { camera = true } label: { Label("Take Photo", systemImage: "camera") }
          Button { pickingPhotos = true } label: { Label("Photo Library", systemImage: "photo.on.rectangle") }
          Button { importing = true } label: { Label("Choose File", systemImage: "doc") }
        } label: { Image(systemName: "paperclip").font(.system(size: 19, weight: .medium)).frame(width: 44, height: 44) }
        .accessibilityLabel("Attach")
        Button { bin() } label: { Image(systemName: "trash").font(.system(size: 17)).frame(width: 44, height: 44) }
          .accessibilityLabel("Delete Note").disabled(empty)
        Spacer()
        Group {
          if all && to == nil && crowns.count > 1 {
            Menu {
              ForEach(crowns, id: \.desk.id) { c in
                Button { lastNoteDesk = c.desk.id; send(c.agent) } label: {
                  Label { Text("\(c.desk.name) · \(c.agent.name)") } icon: { c.desk.id == lastNoteDesk ? Image(systemName: "checkmark") : PenImage.desk(waiting: false) }
                }
              }
            } label: { sendFace }
          } else {
            Button { send(target) } label: { sendFace }
          }
        }
        .disabled(target == nil || empty || uploading || dropping)
        .opacity(target == nil || empty || uploading || dropping ? 0.35 : 1)
        .accessibilityLabel(target.map { "Send to \($0.name)" } ?? "Send")
      }
      .foregroundStyle(Ink.noteInk)
      if target == nil { Text("Make a session the main session (its ⋯ menu): notes go to it.").font(Face.text(13)).foregroundStyle(Ink.noteInk.opacity(0.7)) }
    }
    .padding(.horizontal, 20).padding(.top, 6)
    .padding(.bottom, 12)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .background(Ink.noteYellow.ignoresSafeArea())
    .onAppear {
      if !loaded, let n = model.desk?.notes.filter({ $0.held.isNull }).sorted(by: { $0.updated > $1.updated }).first { text = n.text; noteId = n.id; files = n.attachments }
      loaded = true
      shown = true
    }
    .onChange(of: text) { _, _ in keepSoon() }
    .onDisappear { shown = false; dropping = false; keep() }
    // what was dropped onto the app (NoteDrop.swift): onto this note as it is on screen, words he has just typed kept
    .onReceive(NotificationCenter.default.publisher(for: .trommiNoteDropping)) { n in dropping = shown && (n.object as? Bool ?? false) }
    .onReceive(NotificationCenter.default.publisher(for: .trommiNoteAdd)) { n in
      guard shown, loaded, let a = n.object as? NoteAddition, !a.taken else { return }
      a.taken = true
      text = ShareIntake.appended(text, a.words)
      files.append(contentsOf: a.files)
      keepTask?.cancel(); keep()
    }
    // what the share sheet added to the note while this screen was open (ShareImport.swift)
    .onReceive(NotificationCenter.default.publisher(for: .trommiNoteImported)) { n in
      guard let id = n.userInfo?["id"] as? String, let t = n.userInfo?["text"] as? String, let f = n.userInfo?["files"] as? [JV] else { return }
      keepTask?.cancel(); noteId = id; text = t; files = f
    }
    .sheet(isPresented: $pickingPhotos) { PhotoPicker(limit: 12) { picked in Task { await add(picked) } }.ignoresSafeArea() }
    .sheet(isPresented: $camera) { CameraPicker { data in Task { await add([(data, .jpeg)]) } }.ignoresSafeArea() }
    .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { r in
      if case .success(let urls) = r {
        var got = [(data: Data, type: UTType?)]()
        for u in urls { let ok = u.startAccessingSecurityScopedResource(); defer { if ok { u.stopAccessingSecurityScopedResource() } }; if let d = try? Data(contentsOf: u) { got.append((d, UTType(filenameExtension: u.pathExtension))) } }
        Task { await add(got, names: urls.map { $0.lastPathComponent }) }
      }
    }
  }
  private var sendFace: some View {
    Image(systemName: "paperplane.fill").font(.system(size: 18, weight: .semibold)).foregroundStyle(Ink.noteYellow)
      .frame(width: 46, height: 46).background(Circle().fill(Ink.noteInk))
  }
  /** Every desk with a crowned session, in the desks' order. */
  private var deskCrowns: [(desk: DeskDesc, agent: Agent)] {
    (model.desk?.desks ?? []).compactMap { d in model.desk?.crownOf(desk: d.id).map { (d, $0) } }
  }
  private var lastNoteDesk: String? {
    get { UserDefaults.standard.string(forKey: "trommi-note-desk") }
    nonmutating set { UserDefaults.standard.set(newValue, forKey: "trommi-note-desk") }
  }
  /** "To: Claude ▾": the recipient, once; the crowned session unless he picks another. */
  private func recipient(_ target: Agent?) -> some View {
    let sessions = (model.view?.units ?? []).map { $0.agent }
    let all = model.view?.all == true
    return Menu {
      if all {
        Section("Main Session of a Desk") {
          ForEach(deskCrowns, id: \.desk.id) { c in
            Button { to = nil; lastNoteDesk = c.desk.id } label: {
              if to == nil && c.agent.id == target?.id { Label("\(c.desk.name) · \(c.agent.name)", systemImage: "checkmark") } else { Text("\(c.desk.name) · \(c.agent.name)") }
            }
          }
        }
      }
      Section(all ? "Another Session" : "") {
        ForEach(sessions) { a in
          Button { to = a.id } label: { if to == a.id || (!all && a.id == target?.id) { Label(a.name, systemImage: "checkmark") } else { Text(a.name) } }
        }
      }
    } label: {
      HStack(spacing: 4) {
        Text("To:").foregroundStyle(Ink.noteInk.opacity(0.7))
        Text(target?.name ?? "No Session").fontWeight(.semibold).foregroundStyle(Ink.noteInk).lineLimit(1)
        Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold)).foregroundStyle(Ink.noteInk.opacity(0.7))
      }
      .font(Face.text(15)).padding(.horizontal, 14).frame(minHeight: 40)
      .glass(Capsule(), interactive: true)
      .contentShape(Capsule())
    }
    .accessibilityLabel("Recipient: \(target?.name ?? "none")")
  }
  /** Files onto the note: encrypted and uploaded as the composer does (pictures as JPEG, at most 2400 px). */
  private func add(_ items: [(data: Data, type: UTType?)], names: [String] = []) async {
    uploading = true
    defer { uploading = false }
    for (i, (d, type)) in items.enumerated() {
      do {
        #if canImport(UIKit)
        if (type?.conforms(to: .image) ?? false), let img = UIImage(data: d) {
          let s = min(1, 2400 / max(img.size.width, img.size.height))
          let size = CGSize(width: (img.size.width * s).rounded(), height: (img.size.height * s).rounded())
          let fmt = UIGraphicsImageRendererFormat(); fmt.scale = 1; fmt.preferredRange = .standard; fmt.opaque = true
          let j = UIGraphicsImageRenderer(size: size, format: fmt).image { _ in img.draw(in: CGRect(origin: .zero, size: size)) }.jpegData(compressionQuality: 0.85) ?? d
          files.append(try await model.upload(j, name: "picture-\(files.count + 1).jpg", type: "image/jpeg", width: Int(size.width), height: Int(size.height)))
          continue
        }
        #endif
        let name = i < names.count ? names[i] : "file-\(files.count + 1).\(type?.preferredFilenameExtension ?? "bin")"
        files.append(try await model.upload(d, name: name, type: type?.preferredMIMEType ?? "application/octet-stream"))
      } catch { model.fail("Not attached", error) }
    }
    keep()
  }
  @State private var keepTask: Task<Void, Never>?
  private func keepSoon() {
    keepTask?.cancel()
    keepTask = Task { try? await Task.sleep(nanoseconds: 1_200_000_000); if !Task.isCancelled { keep() } }
  }
  private func keep() {
    guard let room = model.room, loaded else { return }
    let t = text, id = noteId, atts = files
    Task {
      if t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && atts.isEmpty { if let id = id { try? await room.deleteNote(id); noteId = nil }; return }
      if let id = id, let n = model.desk?.notes.first(where: { $0.id == id }), n.text == t, n.attachments == atts { return }
      var fields: [String: JV] = ["text": .str(t), "attachments": .arr(atts), "updated_at": .n(nowMs())]
      if id == nil { fields["created_at"] = .n(nowMs()) }
      if let made = try? await room.saveNote(objectId: id, fields: fields), noteId == nil { noteId = made }
    }
  }
  private func bin() {
    let t = text, id = noteId, atts = files
    text = ""; noteId = nil; files = []
    onDone?()
    guard let room = model.room, let id = id else { return }
    Task {
      try? await room.deleteNote(id)
      model.say("Note thrown away", String(t.prefix(80)), undo: { [weak model] in _ = try? await model?.room?.saveNote(fields: ["text": .str(t), "attachments": .arr(atts), "created_at": .n(nowMs()), "updated_at": .n(nowMs())]) })
    }
  }
  private func send(_ to: Agent?) {
    guard let to = to, let room = model.room else { return }
    // the pictures on the screen, else those kept on the note object (attached in an earlier opening of the note)
    let kept = noteId.flatMap { id in model.desk?.notes.first { $0.id == id }?.attachments } ?? []
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines), id = noteId, atts = files.isEmpty ? kept : files
    text = ""; noteId = nil; files = []
    keepTask?.cancel()
    onDone?()
    // held for three seconds: the toast's Undo brings it back (notes.mjs HOLD_MS)
    var undone = false
    model.say("Note sent to \(to.name)", "", undo: { undone = true })
    Task {
      try? await Task.sleep(nanoseconds: 3_000_000_000)
      if undone { text = t; files = atts; noteId = id; return }
      do {
        var fields: [String: JV] = [:]
        if let id = id, id.count == 32 { fields["note"] = .obj(["object_id": .str(id), "written_at": .n(nowMs())]) }
        if !atts.isEmpty { fields["attachments"] = .arr(atts) }
        guard let key = model.desk?.sessionKey(of: to.id) else { throw ZError("not-found", "unknown session") }
        try await room.sendMessage(sessionId: key, text: t, fields: fields)
        if let id = id { try? await room.deleteNote(id) }
      } catch { model.fail("Not sent", error) }
    }
  }
}

#if canImport(UIKit)
/** The camera, for a picture on the note. */
struct CameraPicker: UIViewControllerRepresentable {
  let done: (Data) -> Void
  func makeCoordinator() -> C { C(done: done) }
  func makeUIViewController(context: Context) -> UIImagePickerController {
    let p = UIImagePickerController()
    p.sourceType = UIImagePickerController.isSourceTypeAvailable(.camera) ? .camera : .photoLibrary
    p.delegate = context.coordinator
    return p
  }
  func updateUIViewController(_ c: UIImagePickerController, context: Context) {}
  final class C: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    let done: (Data) -> Void
    init(done: @escaping (Data) -> Void) { self.done = done }
    func imagePickerController(_ p: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
      p.dismiss(animated: true)
      if let img = info[.originalImage] as? UIImage, let d = img.jpegData(compressionQuality: 0.9) { done(d) }
    }
    func imagePickerControllerDidCancel(_ p: UIImagePickerController) { p.dismiss(animated: true) }
  }
}
#endif

// ---- the drawing a session wears --------------------------------------------------------------------------------

struct DrawingPicker: View {
  @EnvironmentObject var model: BoardModel
  let agent: Agent
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 58), spacing: 10)], spacing: 10) {
          ForEach(Pen.drawings, id: \.self) { name in
            let hue = Pen.drawingHue(name) ?? 162
            let on = agent.mark == "draw:\(name)"
            Button { model.editSession(agent, ["icon": .str("draw:\(name)")]); dismiss() } label: {
              PenMark(doc: PenStore.mark("draw:\(name)"), inks: PenInks(stroke: Tone.color(hue: hue, .pen))).frame(width: 34, height: 34)
                .frame(width: 58, height: 58)
                .background(RoundedRectangle(cornerRadius: 12).fill(Tone.color(hue: hue, .wash)))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(on ? Ink.fg : .clear, lineWidth: 2))
            }.buttonStyle(.plain).accessibilityLabel(name)
          }
        }.padding(16)
      }
      .navigationTitle("Change Icon").navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
    }
  }
}
