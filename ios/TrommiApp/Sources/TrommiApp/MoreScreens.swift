// MoreScreens.swift: Blitz (every open question, one after the other), Off your mind (the whole end list with its
// search), Media and Pages (what the agents published and sent), a picture in full screen, the corner note (the yellow
// slip to the crowned session), the drawing a session wears.
import SwiftUI
import TrommiClient
import TrommiCore

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
          Button("Back to the Desk") { model.path = [] }.buttonStyle(QuietWay())
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
        if let v = model.view {
          WithAgents(view: v)
          EndList(view: v, full: true, query: query)
        }
      }
      .padding(.horizontal, 16).padding(.bottom, 40)
      .frame(maxWidth: 760).frame(maxWidth: .infinity)
    }
    .searchable(text: $query, prompt: "Search the list")
    .background(Ink.bg)
    .navigationBarTitleDisplayMode(.inline)
  }
}

// ---- Media and Pages ----------------------------------------------------------------------------------------

struct MediaScreen: View {
  @EnvironmentObject var model: BoardModel
  let pages: Bool
  var body: some View {
    let _ = model.version
    let pubs = (model.room?.board.published.values.filter { $0.objectState != "closed" } ?? []).sorted { $0.envelopeNumber > $1.envelopeNumber }
    let items = pubs.filter { p in let k = kindOf(p.attachments.first ?? .null); return pages ? k == "html" || k == "file" : k == "image" || k == "video" || k == "audio" }
    // pictures the agents sent in their talk (Media) as well
    let sent: [JV] = pages ? [] : (model.desk?.agents ?? []).flatMap { a in (model.desk?.messagesOf(agent: a.id) ?? []).filter { $0.from == "agent" }.flatMap { $0.attachments.filter { kindOf($0) == "image" } } }
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        Text(pages ? "Pages" : "Media").font(Face.display(34, .heavy)).padding(.top, 10)
        if items.isEmpty && sent.isEmpty { Text(pages ? "No pages yet: what the agents publish shows here." : "No pictures yet.").font(Face.text(15)).foregroundStyle(Ink.muted) }
        ForEach(items, id: \.objectId) { p in PublishedCard(published: p) }
        if !sent.isEmpty {
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
struct PicturesView: View {
  let list: [JV]
  let start: Int
  @State private var at = 0
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
      .accessibilityLabel("The note")
      .sheet(isPresented: $open) { NoteSheet().presentationDetents([.medium, .large]) }
  }
}
struct NoteSheet: View {
  @EnvironmentObject var model: BoardModel
  @Environment(\.dismiss) private var dismiss
  @State private var text = ""
  @State private var noteId: String?
  @State private var loaded = false
  @FocusState private var focused: Bool
  var body: some View {
    let crown = model.desk?.crownOf(desk: model.deskId)
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Text("Note").font(Face.display(24, .heavy)).foregroundStyle(Ink.noteInk)
        Spacer()
        if let c = crown { HStack(spacing: 6) { Text("to").font(Face.text(14)).foregroundStyle(Ink.noteInk.opacity(0.7)); AgentMark(agent: c, size: 20); Text(c.name).font(Face.text(14, .semibold)).foregroundStyle(Ink.noteInk) } }
      }
      TextEditor(text: $text)
        .font(Face.text(18)).foregroundStyle(Ink.noteInk)
        .scrollContentBackground(.hidden)
        .focused($focused)
        .frame(minHeight: 160)
      HStack(spacing: 10) {
        Button { bin() } label: { Label("Throw away", systemImage: "trash").font(Face.text(15, .medium)) }.foregroundStyle(Ink.noteInk.opacity(0.8))
        Spacer()
        Button { send(crown) } label: {
          HStack(spacing: 6) { PenMark("crown").frame(width: 20, height: 15); Text(crown == nil ? "No crown yet" : "Send to \(crown!.name)").font(Face.text(16, .semibold)) }
            .foregroundStyle(Ink.noteInk).padding(.horizontal, 14).padding(.vertical, 10).background(Capsule().fill(Color.white.opacity(0.5)))
        }.disabled(crown == nil || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
      if crown == nil { Text("Give a session the crown (its menu: Give it the crown): a note goes to it.").font(Face.text(13)).foregroundStyle(Ink.noteInk.opacity(0.7)) }
    }
    .padding(20)
    .background(Ink.noteYellow.ignoresSafeArea())
    .onAppear {
      if !loaded, let n = model.desk?.notes.filter({ $0.held.isNull }).sorted(by: { $0.updated > $1.updated }).first { text = n.text; noteId = n.id }
      loaded = true; focused = true
    }
    .onDisappear { keep() }
  }
  private func keep() {
    guard let room = model.room else { return }
    let t = text
    let id = noteId
    Task {
      if t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { if let id = id { try? await room.deleteNote(id) }; return }
      if let id = id, model.desk?.notes.first(where: { $0.id == id })?.text == t { return }
      _ = try? await room.saveNote(objectId: id, fields: id == nil ? ["text": .str(t), "created_at": .n(nowMs()), "updated_at": .n(nowMs())] : ["text": .str(t), "updated_at": .n(nowMs())])
    }
  }
  private func bin() {
    let t = text, id = noteId
    text = ""; noteId = nil
    dismiss()
    guard let room = model.room, let id = id else { return }
    Task {
      try? await room.deleteNote(id)
      model.say("Note thrown away", String(t.prefix(80)), undo: { [weak model] in _ = try? await model?.room?.saveNote(fields: ["text": .str(t), "created_at": .n(nowMs()), "updated_at": .n(nowMs())]) })
    }
  }
  private func send(_ to: Agent?) {
    guard let to = to, let room = model.room else { return }
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines), id = noteId
    text = ""; noteId = nil
    dismiss()
    // held for three seconds: the toast's Undo brings it back (notes.mjs HOLD_MS)
    var undone = false
    model.say("Note sent to \(to.name)", "", undo: { [weak model] in undone = true; model?.say("Not sent", "The note is back") })
    Task {
      try? await Task.sleep(nanoseconds: 3_000_000_000)
      if undone { text = t; return }
      do {
        var fields: [String: JV] = [:]
        if let id = id, id.count == 32 { fields["note"] = .obj(["object_id": .str(id), "written_at": .n(nowMs())]) }
        guard let key = model.desk?.sessionKey(of: to.id) else { throw ZError("not-found", "unknown session") }
        try await room.sendMessage(sessionId: key, text: t, fields: fields)
        if let id = id { try? await room.deleteNote(id) }
      } catch { model.fail("Not sent", error) }
    }
  }
}

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
      .navigationTitle("Its drawing").navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
    }
  }
}
