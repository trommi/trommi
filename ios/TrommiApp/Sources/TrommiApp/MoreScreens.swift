// MoreScreens.swift: Blitz (every open question, one after the other), Off your mind (the whole end list with its
// search), Media and Pages (what the agents published and sent), a picture in full screen, the corner note (the yellow
// slip to the crowned session), the drawing a session wears.
import SwiftUI
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
    let pubs = (model.board?.published.values.filter { $0.objectState != "closed" } ?? []).sorted { $0.envelopeNumber > $1.envelopeNumber }
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
/** The note as a sheet (the iPad's corner button). */
struct NoteSheet: View {
  @Environment(\.dismiss) private var dismiss
  var body: some View { NoteScreen(onDone: { dismiss() }) }
}

/**
 * The note (notes.mjs): the yellow slip to the desk's crowned session, a page of its own on the iPhone (the bar stays).
 * Words, pictures and files (encrypted like the composer's); kept as a note object while he writes (every device sees
 * it), sent with a three-second Undo, then gone from the desk.
 */
struct NoteScreen: View {
  @EnvironmentObject var model: BoardModel
  var onDone: (() -> Void)? = nil
  @State private var text = ""
  @State private var noteId: String?
  @State private var files: [JV] = []          // uploaded attachment references
  @State private var loaded = false
  @State private var uploading = false
  @State private var pickingPhotos = false
  @State private var importing = false
  @State private var camera = false
  @FocusState private var focused: Bool
  var body: some View {
    let crown = model.desk?.crownOf(desk: model.deskId)
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Text("Note").font(Face.display(26, .heavy)).foregroundStyle(Ink.noteInk)
        Spacer()
        if let c = crown { HStack(spacing: 6) { Text("to").font(Face.text(14)).foregroundStyle(Ink.noteInk.opacity(0.7)); AgentMark(agent: c, size: 20); Text(c.name).font(Face.text(14, .semibold)).foregroundStyle(Ink.noteInk) } }
      }
      TextEditor(text: $text)
        .font(Face.text(18)).foregroundStyle(Ink.noteInk)
        .scrollContentBackground(.hidden)
        .focused($focused)
        .frame(minHeight: 140)
      if !files.isEmpty || uploading {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 8) {
            ForEach(Array(files.enumerated()), id: \.offset) { i, f in
              ZStack(alignment: .topTrailing) {
                if kindOf(f) == "image" { AttachmentImage(ref: f).frame(width: 72, height: 72).clipShape(RoundedRectangle(cornerRadius: 8)) }
                else { VStack { Sketch("clip", color: Ink.noteInk).frame(width: 18, height: 18); Text(f["file_name"].string ?? "file").font(Face.text(11)).lineLimit(2) }.frame(width: 72, height: 72).background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.5))) }
                Button { files.remove(at: i); keepSoon() } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Ink.noteInk) }.offset(x: 6, y: -6)
              }
            }
            if uploading { ProgressView().frame(width: 72, height: 72) }
          }.padding(.top, 6)
        }
      }
      HStack(spacing: 14) {
        Menu {
          Button { camera = true } label: { Label("Camera", systemImage: "camera") }
          Button { pickingPhotos = true } label: { Label("Pictures and videos", systemImage: "photo.on.rectangle") }
          Button { importing = true } label: { Label("A file", systemImage: "doc") }
        } label: { Sketch("clip", color: Ink.noteInk).frame(width: 24, height: 24).frame(width: 44, height: 44) }
        .accessibilityLabel("Attach")
        Button { bin() } label: { Image(systemName: "trash").font(.system(size: 17)).frame(width: 44, height: 44) }.foregroundStyle(Ink.noteInk.opacity(0.8)).accessibilityLabel("Throw away")
        Spacer()
        Button { send(crown) } label: {
          HStack(spacing: 6) { PenMark("crown").frame(width: 20, height: 15); Text(crown == nil ? "No crown yet" : "Send to \(crown!.name)").font(Face.text(16, .semibold)) }
            .foregroundStyle(Ink.noteInk).padding(.horizontal, 14).padding(.vertical, 11).background(Capsule().fill(Color.white.opacity(0.5)))
        }.disabled(crown == nil || (text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && files.isEmpty) || uploading)
      }
      if crown == nil { Text("Give a session the crown (its menu: Give it the crown): a note goes to it.").font(Face.text(13)).foregroundStyle(Ink.noteInk.opacity(0.7)) }
      Spacer(minLength: 0)
    }
    .padding(20)
    .background(Ink.noteYellow.ignoresSafeArea())
    .onAppear {
      if !loaded, let n = model.desk?.notes.filter({ $0.held.isNull }).sorted(by: { $0.updated > $1.updated }).first { text = n.text; noteId = n.id; files = n.attachments }
      loaded = true
    }
    .onChange(of: text) { _, _ in keepSoon() }
    .onDisappear { keep() }
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
          let fmt = UIGraphicsImageRendererFormat(); fmt.scale = 1
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
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines), id = noteId, atts = files
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
      .navigationTitle("Its drawing").navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
    }
  }
}
