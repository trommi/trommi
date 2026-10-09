// NoteDrop: anything dropped onto the app goes onto the note (drag and drop between apps on the iPad, and on the
// iPhone a thing picked up in another app and carried over). Pictures, videos and files become the note's attachments,
// encrypted and uploaded as the paperclip's and the share sheet's are; links and text become words in the note. What a
// dropped thing becomes is decided by ShareIntake (TrommiCore, the Share Extension's rules, under `swift test`), with
// the share sheet's limits: 20 things per drop, 32 MB per file, pictures as JPEG of at most 2400 px. The note opens,
// and while the finger hovers the whole app shows a hand-drawn dashed outline and one line of glass.
import SwiftUI
import ShareInbox
import TrommiClient
import TrommiCore
import UniformTypeIdentifiers
#if canImport(UIKit)
import UIKit
import ImageIO
#endif

extension Notification.Name {
  /** Open the note where it is a sheet of its own (the iPad's corner button). */
  static let trommiNoteOpen = Notification.Name("trommi-note-open")
  /** Something for the note: the note on screen takes it (object: NoteAddition). */
  static let trommiNoteAdd = Notification.Name("trommi-note-add")
  /** A drop is being uploaded (object: Bool): the note on screen shows it. */
  static let trommiNoteDropping = Notification.Name("trommi-note-dropping")
}

/** Words and uploaded files on their way onto the note. The note on screen takes them into what he is writing; if none
 *  is open they go onto the stored note (ShareImport.addToNote). */
final class NoteAddition {
  let words: String
  let files: [JV]
  var taken = false
  init(words: String, files: [JV]) { self.words = words; self.files = files }
}

/** The whole app as a drop target. `open` opens the note. */
struct NoteDropTarget: ViewModifier {
  @EnvironmentObject var model: BoardModel
  var open: () -> Void
  @State private var over = false
  func body(content: Content) -> some View {
    content
      .onDrop(of: NoteDrop.types, isTargeted: $over) { providers in
        guard NoteDrop.take(providers, model: model) else { return false }
        open()
        return true
      }
      .overlay { if over { NoteDropHint().transition(.opacity) } }
      .animation(.easeOut(duration: 0.15), value: over)
  }
}

/** While something hovers over the app: a hand-drawn dashed outline around the page and one line of glass. */
struct NoteDropHint: View {
  var body: some View {
    ZStack {
      Ink.bg.opacity(0.6).ignoresSafeArea()
      PenBox(r: 26).stroke(Ink.fg.opacity(0.75), style: StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round, dash: [11, 9]))
        .padding(.horizontal, 12).padding(.vertical, 6)
      HStack(spacing: 10) {
        PenMark("sidebar:NOTE_ICON").frame(width: 26, height: 26)
        Text("Drop onto the note").font(Face.text(17, .semibold)).foregroundStyle(Ink.fg)
      }
      .padding(.horizontal, 20).padding(.vertical, 13)
      .glass(Capsule())
    }
    .allowsHitTesting(false)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Drop onto the note")
  }
}

@MainActor
enum NoteDrop {
  /** What the app takes: pictures, videos, any file, links, text. */
  static let types: [UTType] = [.image, .movie, .fileURL, .url, .plainText, .data]

  /** One dropped thing, loaded. */
  enum Loaded {
    case file(data: Data, name: String, type: String, width: Int?, height: Int?)
    case words(ShareItem)
    case skipped(String)
  }

  /**
   * Take a drop: false when nothing can be taken (the demo, no room). The loading is started here, inside the drop (the
   * providers answer only while the drop session lives); uploading and the note follow when all are loaded.
   */
  static func take(_ providers: [NSItemProvider], model m: BoardModel) -> Bool {
    guard !m.demo, m.room != nil, !providers.isEmpty else { return false }
    #if canImport(UIKit)
    let list = Array(providers.prefix(ShareInbox.maxItems))
    let box = Results(count: list.count)
    let group = DispatchGroup()
    for (i, p) in list.enumerated() {
      group.enter()
      load(p, index: i) { r in box.set(i, r); group.leave() }
    }
    let more = providers.count - list.count
    group.notify(queue: .main) {
      Task { @MainActor in await finish(box.all(), more: more, model: m) }
    }
    return true
    #else
    return false
    #endif
  }

  /** Upload the files, then onto the note: the open one, else the stored one. */
  private static func finish(_ got: [Loaded], more: Int, model m: BoardModel) async {
    guard let room = m.room else { return }
    NotificationCenter.default.post(name: .trommiNoteDropping, object: true)
    var atts = [JV](), words = [ShareItem](), skipped = [String]()
    if more > 0 { skipped.append("more than \(ShareInbox.maxItems) things") }
    for g in got {
      switch g {
      case .words(let w): words.append(w)
      case .skipped(let why): skipped.append(why)
      case .file(let data, let name, let type, let width, let height):
        do { atts.append(try await m.upload(data, name: name, type: type, width: width, height: height)) }
        catch { skipped.append("\(name): \(m.describe(error))") }
      }
    }
    NotificationCenter.default.post(name: .trommiNoteDropping, object: false)
    let text = ShareIntake.joined(words)
    if !atts.isEmpty || !text.isEmpty {
      let add = NoteAddition(words: text, files: atts)
      NotificationCenter.default.post(name: .trommiNoteAdd, object: add)
      if !add.taken {
        await ShareImport.shared.addToNote(text, atts, room: room, model: m)
        if skipped.isEmpty { m.say("Added to the note", "Dropped onto Trommi") }
      }
    }
    if !skipped.isEmpty { m.fail(atts.isEmpty && text.isEmpty ? "Nothing added to the note" : "Not all of it added", ZError("drop", skipped.joined(separator: " · "))) }
  }

  #if canImport(UIKit)
  /** The results of the loads, which come back on any queue, in the order of the drop. */
  private final class Results: @unchecked Sendable {
    private var slots: [Loaded?]
    private let lock = NSLock()
    init(count: Int) { slots = Array(repeating: nil, count: count) }
    func set(_ i: Int, _ r: Loaded?) { lock.lock(); slots[i] = r; lock.unlock() }
    func all() -> [Loaded] { lock.lock(); defer { lock.unlock() }; return slots.compactMap { $0 } }
  }

  /** Load one provider as what ShareIntake says it is. `done` is called once, on any queue. */
  nonisolated private static func load(_ p: NSItemProvider, index: Int, done: @escaping @Sendable (Loaded?) -> Void) {
    let dataType = p.registeredTypeIdentifiers.first { UTType($0)?.conforms(to: .data) == true && UTType($0)?.conforms(to: .plainText) != true }
    let has = { (t: UTType) in p.hasItemConformingToTypeIdentifier(t.identifier) }
    let label = p.suggestedName ?? "item \(index + 1)"
    switch ShareIntake.kind(.init(image: has(.image), url: has(.url), fileURL: has(.fileURL), data: dataType != nil, text: has(.plainText))) {
    case .image:
      _ = p.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, err in
        guard let data = data, let src = CGImageSourceCreateWithData(data as CFData, nil), let pic = jpeg(src, maxPixel: 2400) else {
          done(.skipped("\(label): \(err?.localizedDescription ?? "not a picture")")); return
        }
        done(.file(data: pic.data, name: "picture-\(index + 1).jpg", type: "image/jpeg", width: pic.width, height: pic.height))
      }
    case .url:
      _ = p.loadObject(ofClass: URL.self) { url, _ in
        done(url.flatMap { ShareIntake.words($0.absoluteString) }.map { .words($0) })
      }
    case .file:
      let type = dataType ?? UTType.data.identifier
      let ut = UTType(type)
      let suggested = p.suggestedName
      _ = p.loadFileRepresentation(forTypeIdentifier: type) { url, err in
        guard let url = url else { done(.skipped("\(label): \(err?.localizedDescription ?? "not readable")")); return }
        // the file is valid only inside this handler: read here
        let name = ShareIntake.fileName(suggested: suggested, file: url.deletingPathExtension().lastPathComponent, ext: url.pathExtension, typeExt: ut?.preferredFilenameExtension)
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        if size > ShareInbox.maxItemBytes { done(.skipped(ShareError.tooLarge(name).description)); return }
        guard let d = try? Data(contentsOf: url) else { done(.skipped("\(name): not readable")); return }
        let ext = (name as NSString).pathExtension
        let mime = UTType(filenameExtension: ext)?.preferredMIMEType ?? ut?.preferredMIMEType ?? "application/octet-stream"
        done(.file(data: d, name: name, type: mime, width: nil, height: nil))
      }
    case .text:
      _ = p.loadObject(ofClass: String.self) { s, _ in
        done(s.flatMap { ShareIntake.words($0) }.map { .words($0) })
      }
    case nil:
      done(.skipped("\(label): not something the note takes"))
    }
  }

  /** A picture as JPEG of at most `maxPixel`, through ImageIO's thumbnail (a 48 MP photo is never decoded whole). */
  nonisolated private static func jpeg(_ s: CGImageSource, maxPixel: Int) -> (data: Data, width: Int, height: Int)? {
    let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                                 kCGImageSourceThumbnailMaxPixelSize: maxPixel, kCGImageSourceShouldCacheImmediately: true]
    guard let img = CGImageSourceCreateThumbnailAtIndex(s, 0, opts as CFDictionary) else { return nil }
    let out = NSMutableData()
    guard let dst = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(dst, img, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
    guard CGImageDestinationFinalize(dst) else { return nil }
    return (out as Data, img.width, img.height)
  }
  #endif
}
