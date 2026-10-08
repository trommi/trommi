// TrommiShare: Trommi in the iOS share sheet. The sheet is the note (ShareSheet.swift): what was shared as thumbnails,
// a text field, "To: <desk> · <crowned session> ▾" (the last one used picked) and two ways: Send (to that crown) and
// Keep in Note (into the one note; nothing is sent). The extension holds no room, no device key and no board: it seals
// what was shared into the App Group's inbox (ShareInbox, AES-256-GCM under the inbox key in the shared Keychain item)
// and rings the app (a Darwin notification). The app imports it into the note, or sends it to the crowned session
// through the room's own encrypted path, at once while it runs and else when it next comes to the front
// (ShareImport.swift).
// Why not send from here: the extension would need the room's device key and the whole sync engine (memory), and two
// processes sealing with one device key fork its envelope chain (Room.send: "chain-behind").
import Foundation
import ShareInbox
#if canImport(UIKit)
import UIKit
import SwiftUI
import UniformTypeIdentifiers
import ImageIO
import CoreText

/** The extension's principal class (Info.plist NSExtensionPrincipalClass, an Objective-C name without the module). */
@objc(TrommiShareViewController)
public final class TrommiShareViewController: UIViewController {
  private let model = ShareModel()

  public override func viewDidLoad() {
    super.viewDidLoad()
    ShareFonts.register()
    view.backgroundColor = .clear
    model.close = { [weak self] done in
      guard let ctx = self?.extensionContext else { return }
      if done { ctx.completeRequest(returningItems: nil) }
      else { ctx.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError)) }
    }
    let host = UIHostingController(rootView: ShareRoot(model: model))
    host.view.backgroundColor = .clear
    addChild(host)
    host.view.frame = view.bounds
    host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(host.view)
    host.didMove(toParent: self)
    model.load(extensionContext?.inputItems.compactMap { $0 as? NSExtensionItem } ?? [])
  }
}

/** The app's fonts, read from the containing app's resource bundle (no second copy in the extension). */
enum ShareFonts {
  static func register() {
    // …/Trommi.app/PlugIns/TrommiShare.appex → …/Trommi.app
    let app = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent()
    let fm = FileManager.default
    guard let bundles = try? fm.contentsOfDirectory(at: app, includingPropertiesForKeys: nil) else { return }
    for b in bundles where b.pathExtension == "bundle" {
      let dir = b.appendingPathComponent("Fonts")
      for f in (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? [] where f.pathExtension == "ttf" {
        CTFontManagerRegisterFontsForURL(f as CFURL, .process, nil)
      }
    }
  }
}

/** German on a German phone, else English (the app's words). */
func L(_ en: String, _ de: String) -> String { (Locale.preferredLanguages.first ?? "en").hasPrefix("de") ? de : en }

/** One shared thing as the sheet shows it. */
struct Loaded: Identifiable {
  let id = UUID()
  var item: ShareItem
  var thumb: UIImage?
}

@MainActor
final class ShareModel: ObservableObject {
  enum Phase: Equatable { case loading, editing, saving, done(String, String), failed(String) }
  @Published var items: [Loaded] = []
  @Published var skipped: [String] = []
  @Published var phase: Phase = .loading
  @Published var text = ""
  /** The desk whose crowned session gets a Send. */
  @Published var desk: String?
  let inbox: ShareInbox?
  let snapshot: ShareSnapshot?
  /** The share being written: its payloads are sealed into the inbox as they load, the manifest only on Send or Keep. */
  let requestId = ShareInbox.newId()
  var close: (Bool) -> Void = { _ in }
  private static let lastKey = "share-last-desk"

  init() {
    inbox = ShareGroup.inbox(create: false)
    snapshot = inbox?.readSnapshot()
    desk = snapshot?.preselect(last: UserDefaults.standard.string(forKey: Self.lastKey))?.id
  }

  var picked: ShareSnapshot.Desk? { snapshot?.crowned.first { $0.id == desk } }
  var isDone: Bool { if case .done = phase { return true }; return false }
  private var hasSomething: Bool { !items.isEmpty || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
  var canKeep: Bool { inbox != nil && (phase == .editing || isFailed) && hasSomething }
  var canSend: Bool { canKeep && picked?.crown != nil }
  private var isFailed: Bool { if case .failed = phase { return true }; return false }

  func pick(_ id: String) {
    desk = id
    UserDefaults.standard.set(id, forKey: Self.lastKey)
  }
  func remove(_ id: UUID) { items.removeAll { $0.id == id } }

  // ---- loading what was shared, one at a time (memory) --------------------------------------------------

  func load(_ ext: [NSExtensionItem]) {
    Task {
      var index = 0
      for e in ext {
        if let t = e.attributedContentText?.string.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty, text.isEmpty { text = t }
        for p in e.attachments ?? [] {
          if items.count >= ShareInbox.maxItems { skipped.append(L("more than \(ShareInbox.maxItems) items", "mehr als \(ShareInbox.maxItems) Dinge")); break }
          do {
            if let l = try await loadOne(p, index: index) { items.append(l); index += 1 }
          } catch {
            skipped.append(p.suggestedName ?? "\(error)")
          }
        }
      }
      phase = .editing
    }
  }

  private func loadOne(_ p: NSItemProvider, index: Int) async throws -> Loaded? {
    guard let inbox = inbox else { return nil }
    let id = requestId
    if p.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
      let raw = try await p.loadItemAsync(UTType.image.identifier)
      let src: CGImageSource?
      switch raw {
      case let u as URL: src = CGImageSourceCreateWithURL(u as CFURL, nil)
      case let d as Data: src = CGImageSourceCreateWithData(d as CFData, nil)
      case let i as UIImage: src = i.jpegData(compressionQuality: 0.9).flatMap { CGImageSourceCreateWithData($0 as CFData, nil) }
      default: src = nil
      }
      guard let s = src, let pic = ShareImages.jpeg(s, maxPixel: 2400), let thumb = ShareImages.thumb(s) else { throw ShareError.damaged("picture") }
      let name = "picture-\(index + 1).jpg"
      let file = try inbox.addPayload(pic.data, request: id, index: index, name: name)
      return Loaded(item: ShareItem(kind: .image, file: file, name: name, type: "image/jpeg", size: pic.data.count, width: pic.width, height: pic.height), thumb: thumb)
    }
    if p.hasItemConformingToTypeIdentifier(UTType.url.identifier) && !p.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
      if let u = try await p.loadItemAsync(UTType.url.identifier) as? URL {
        return Loaded(item: ShareItem(kind: .url, name: u.host ?? "link", type: "text/uri-list", text: u.absoluteString))
      }
    }
    if let type = p.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .data) == true && UTType($0)?.conforms(to: .plainText) != true })
        ?? (p.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) ? UTType.data.identifier : nil) {
      let ut = UTType(type)
      return try await withCheckedThrowingContinuation { (c: CheckedContinuation<Loaded?, Error>) in
        _ = p.loadFileRepresentation(forTypeIdentifier: type) { url, err in
          guard let url = url else { c.resume(throwing: err ?? ShareError.damaged("file")); return }
          do {
            // the file is valid only inside this handler: read (mapped), seal, write, here
            let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            var name = p.suggestedName ?? url.deletingPathExtension().lastPathComponent
            let ext = url.pathExtension.isEmpty ? (ut?.preferredFilenameExtension ?? "") : url.pathExtension
            if !ext.isEmpty && !name.lowercased().hasSuffix(".\(ext.lowercased())") { name += ".\(ext)" }
            if size > ShareInbox.maxItemBytes { throw ShareError.tooLarge(name) }
            let d = try Data(contentsOf: url, options: .mappedIfSafe)
            let file = try inbox.addPayload(d, request: id, index: index, name: name)
            let mime = UTType(filenameExtension: ext)?.preferredMIMEType ?? ut?.preferredMIMEType ?? "application/octet-stream"
            c.resume(returning: Loaded(item: ShareItem(kind: .file, file: file, name: name, type: mime, size: d.count)))
          } catch { c.resume(throwing: error) }
        }
      }
    }
    if p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
      let raw = try await p.loadItemAsync(UTType.plainText.identifier)
      let s = (raw as? String) ?? (raw as? Data).flatMap { String(data: $0, encoding: .utf8) } ?? (raw as? NSAttributedString)?.string
      if let s = s?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty {
        if let u = URL(string: s), u.scheme?.hasPrefix("http") == true, !s.contains(" ") {
          return Loaded(item: ShareItem(kind: .url, name: u.host ?? "link", type: "text/uri-list", text: s))
        }
        return Loaded(item: ShareItem(kind: .text, name: "text", type: "text/plain", text: String(s.prefix(ShareInbox.maxTextChars))))
      }
    }
    return nil
  }

  // ---- Send or Keep in Note --------------------------------------------------------------------------

  func go(_ action: ShareAction) {
    guard let inbox = inbox, action == .send ? canSend : canKeep else { return }
    let d = action == .send ? picked : nil
    phase = .saving
    let r = ShareRequest(id: requestId, action: action, to: d?.crown?.id, toName: d?.crown?.name, desk: d?.id,
                         room: snapshot?.room, text: text, items: items.map { $0.item })
    do {
      try inbox.commit(r)
    } catch {
      phase = .failed("\(error)")
      return
    }
    if let d = d { UserDefaults.standard.set(d.id, forKey: Self.lastKey) }
    ShareSignal.post()
    Task {
      // a running app takes it at once (it claims the share): then it is on its way; else it waits for the app
      var taken = false
      for _ in 0..<10 where !taken {
        try? await Task.sleep(nanoseconds: 150_000_000)
        taken = !inbox.isWaiting(r.id)
      }
      if action == .send {
        let to = d?.crown?.name ?? ""
        phase = .done("paperplane.fill", taken ? L("Sending to \(to)", "Geht an \(to)") : L("Sends as soon as Trommi opens", "Wird gesendet, sobald Trommi öffnet"))
      } else {
        phase = .done("note.text.badge.plus", taken ? L("In the note", "In der Notiz") : L("Goes into the note as soon as Trommi opens", "Kommt in die Notiz, sobald Trommi öffnet"))
      }
      try? await Task.sleep(nanoseconds: 1_300_000_000)
      close(true)
    }
  }
  func cancel() {
    inbox?.discard(requestId)
    close(false)
  }
}

extension NSItemProvider {
  func loadItemAsync(_ type: String) async throws -> NSSecureCoding? {
    try await withCheckedThrowingContinuation { c in
      loadItem(forTypeIdentifier: type, options: nil) { v, e in
        if let e = e { c.resume(throwing: e) } else { c.resume(returning: v) }
      }
    }
  }
}

/** Pictures without decoding them at full size: ImageIO's thumbnails (a 48 MP photo never lands in memory whole). */
enum ShareImages {
  static func jpeg(_ s: CGImageSource, maxPixel: Int) -> (data: Data, width: Int, height: Int)? {
    let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                                 kCGImageSourceThumbnailMaxPixelSize: maxPixel, kCGImageSourceShouldCacheImmediately: true]
    guard let img = CGImageSourceCreateThumbnailAtIndex(s, 0, opts as CFDictionary) else { return nil }
    let out = NSMutableData()
    guard let dst = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(dst, img, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
    guard CGImageDestinationFinalize(dst) else { return nil }
    return (out as Data, img.width, img.height)
  }
  static func thumb(_ s: CGImageSource) -> UIImage? {
    let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                                 kCGImageSourceThumbnailMaxPixelSize: 240]
    return CGImageSourceCreateThumbnailAtIndex(s, 0, opts as CFDictionary).map { UIImage(cgImage: $0) }
  }
}
#endif
