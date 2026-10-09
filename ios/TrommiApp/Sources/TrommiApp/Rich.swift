// Rich.swift: the light markdown agents write (ui.mjs rich): paragraphs, headings, lists, **bold**, *italic*, `code`,
// links, __words underlined with the pen__, fenced code, tables, and a layout fenced as html (shown in a sandboxed page,
// no scripts). And what a message or a card carries: pictures (fetched and decrypted on demand), videos, files.
import SwiftUI
import TrommiClient
import TrommiCore
#if canImport(WebKit)
import WebKit
#endif
#if canImport(UIKit)
import UIKit
import ImageIO
#endif
#if canImport(AVKit)
import AVKit
#endif

enum RichBlock: Hashable {
  case text(String)
  case heading(String, Int)
  case code(String, String)          // language, text
  case table([[String]])
  case html(String)
  case quote(String)
  case rule
}

enum RichParse {
  static func blocks(_ text: String) -> [RichBlock] {
    var out = [RichBlock]()
    var para = [String]()
    func flush() { if !para.isEmpty { out.append(.text(para.joined(separator: "\n"))); para = [] } }
    let lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
    var i = 0
    while i < lines.count {
      let line = lines[i]
      let t = line.trimmingCharacters(in: .whitespaces)
      if t.hasPrefix("```") {
        flush()
        let lang = String(t.dropFirst(3)).trimmingCharacters(in: .whitespaces)
        var body = [String]()
        i += 1
        while i < lines.count && !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("```") { body.append(lines[i]); i += 1 }
        i += 1
        out.append(lang.lowercased() == "html" ? .html(body.joined(separator: "\n")) : .code(lang, body.joined(separator: "\n")))
        continue
      }
      if t.hasPrefix("|") && i + 1 < lines.count && lines[i + 1].trimmingCharacters(in: .whitespaces).range(of: #"^\|?\s*:?-{2,}"#, options: .regularExpression) != nil {
        flush()
        var rows = [[String]]()
        func cells(_ s: String) -> [String] {
          var x = s.trimmingCharacters(in: .whitespaces)
          if x.hasPrefix("|") { x.removeFirst() }
          if x.hasSuffix("|") { x.removeLast() }
          return x.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
        }
        rows.append(cells(t)); i += 2
        while i < lines.count && lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("|") { rows.append(cells(lines[i])); i += 1 }
        out.append(.table(rows))
        continue
      }
      if let m = t.range(of: #"^#{1,4}\s"#, options: .regularExpression) {
        flush(); out.append(.heading(String(t[m.upperBound...]), t.prefix(while: { $0 == "#" }).count)); i += 1; continue
      }
      if t == "---" || t == "***" { flush(); out.append(.rule); i += 1; continue }
      if t.hasPrefix(">") { flush(); out.append(.quote(String(t.dropFirst()).trimmingCharacters(in: .whitespaces))); i += 1; continue }
      if t.isEmpty { flush(); i += 1; continue }
      para.append(line)
      i += 1
    }
    flush()
    return out
  }
  /** Inline markdown to an attributed string; `__x__` is underlined (drawn by the view in the accent ink). */
  static func inline(_ s: String) -> AttributedString {
    var src = s
    // lists: "- x" / "* x" / "1. x" keep their marks, as lines
    src = src.replacingOccurrences(of: #"(?m)^(\s*)[-*]\s+"#, with: "$1• ", options: .regularExpression)
    var unders = [String]()
    src = src.replacingOccurrences(of: #"(?<![\w.])__(?=\S)(.+?)(?<=\S)__(?![\w])"#, with: "⟦$1⟧", options: .regularExpression)
    var a = (try? AttributedString(markdown: src, options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(src)
    // the pen's underline: ⟦…⟧
    while let open = a.range(of: "⟦"), let close = a[open.upperBound...].range(of: "⟧") {
      let inner = open.upperBound..<close.lowerBound
      a[inner].underlineStyle = .single
      a[inner].underlineColor = UIColorBridge.accent
      unders.append(String(a[inner].characters))
      a.removeSubrange(close)
      a.removeSubrange(open)
    }
    return a
  }
}
enum UIColorBridge {
  #if canImport(UIKit)
  static var accent: UIColor { UIColor { $0.userInterfaceStyle == .dark ? UIColor(rgb: 0x6fd0b5) : UIColor(rgb: 0x1b6a57) } }
  #endif
}

struct RichText: View {
  let text: String
  var size: CGFloat = 16
  var color: Color = Ink.fg
  @State private var layout: String?
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ForEach(Array(RichParse.blocks(text).enumerated()), id: \.offset) { _, b in block(b) }
    }
    .sheet(item: Binding(get: { layout.map { LayoutPage(html: $0) } }, set: { layout = $0?.html })) { p in LayoutSheet(html: p.html) }
  }
  @ViewBuilder private func block(_ b: RichBlock) -> some View {
    switch b {
    case .text(let s):
      Text(RichParse.inline(s)).font(Face.text(size)).foregroundStyle(color).lineSpacing(3).textSelection(.enabled).tint(Ink.accent)
        .fixedSize(horizontal: false, vertical: true)
    case .heading(let s, let level):
      Text(RichParse.inline(s)).font(Face.display(level <= 1 ? size + 6 : level == 2 ? size + 3 : size + 1, .bold)).foregroundStyle(color)
    case .code(_, let s):
      ScrollView(.horizontal, showsIndicators: false) {
        Text(s).font(Face.mono(size - 3)).foregroundStyle(Ink.fg).textSelection(.enabled).padding(12)
      }
      .background(RoundedRectangle(cornerRadius: 10).fill(Ink.sunken))
      .overlay(alignment: .topTrailing) { Button { copyText(s) } label: { Image(systemName: "doc.on.doc").font(.system(size: 12)).foregroundStyle(Ink.muted).padding(8) } }
    case .table(let rows):
      ScrollView(.horizontal, showsIndicators: false) {
        Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
          ForEach(Array(rows.enumerated()), id: \.offset) { i, r in
            GridRow { ForEach(Array(r.enumerated()), id: \.offset) { _, c in Text(RichParse.inline(c)).font(Face.text(size - 2, i == 0 ? .semibold : .regular)).foregroundStyle(Ink.fg) } }
            if i == 0 { Rectangle().fill(Ink.fg).frame(height: 1.5).gridCellUnsizedAxes(.horizontal) } else { Rectangle().fill(Ink.lineStrong).frame(height: 1).gridCellUnsizedAxes(.horizontal) }
          }
        }.padding(.vertical, 4)
      }
    case .html(let h):
      Button { layout = h } label: {
        HStack(spacing: 10) { Sketch("page", color: Ink.accent).frame(width: 20, height: 20); Text("Open the layout").font(Face.text(15, .semibold)) }
          .foregroundStyle(Ink.accent).padding(.horizontal, 14).padding(.vertical, 10)
          .background(RoundedRectangle(cornerRadius: 10).strokeBorder(Ink.lineStrong))
      }.buttonStyle(.plain)
    case .quote(let s):
      HStack(spacing: 10) { Rectangle().fill(Ink.lineStrong).frame(width: 3); Text(RichParse.inline(s)).font(Face.text(size)).foregroundStyle(Ink.muted) }
    case .rule:
      DashedRule().frame(height: 1)
    }
  }
}
struct LayoutPage: Identifiable { let html: String; var id: Int { html.hashValue } }

/** An agent's layout (html), in a page of its own: no scripts, no network (a sandbox like the web's frame). */
struct LayoutSheet: View {
  let html: String
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    NavigationStack {
      SandboxedPage(html: html).ignoresSafeArea(edges: .bottom)
        .navigationTitle("Layout").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
    }
  }
}
#if canImport(WebKit) && canImport(UIKit)
struct SandboxedPage: UIViewRepresentable {
  let html: String
  var data: Data? = nil
  func makeUIView(context: Context) -> WKWebView {
    let cfg = WKWebViewConfiguration()
    cfg.defaultWebpagePreferences.allowsContentJavaScript = false
    cfg.websiteDataStore = .nonPersistent()
    let v = WKWebView(frame: .zero, configuration: cfg)
    v.isOpaque = false
    return v
  }
  func updateUIView(_ v: WKWebView, context: Context) {
    // a strict CSP: nothing is fetched, no script runs; pictures inline only
    let csp = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:\">"
    let page = data.flatMap { String(data: $0, encoding: .utf8) } ?? html
    v.loadHTMLString("<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\(csp)<style>body{font:16px -apple-system,sans-serif;margin:16px;color:#141c18}@media (prefers-color-scheme: dark){body{color:#e9eeea;background:#0e1311}}</style></head><body>\(page)</body></html>", baseURL: nil)
  }
}
#else
struct SandboxedPage: View { let html: String; var data: Data? = nil; var body: some View { Text(html) } }
#endif

// ---- attachments ------------------------------------------------------------------------------------------

func kindOf(_ a: JV) -> String {
  let t = a["media_type"].string ?? ""
  return t.hasPrefix("image/") ? "image" : t.hasPrefix("video/") ? "video" : t.hasPrefix("audio/") ? "audio" : t == "text/html" ? "html" : "file"
}
func sizeWord(_ n: Int) -> String { n >= 1_000_000 ? String(format: "%.1f MB", Double(n) / 1e6) : n >= 1000 ? "\(Int((Double(n) / 1000).rounded())) kB" : "\(n) B" }

/** Decrypted pictures, kept while the app runs. */
@MainActor final class PictureCache {
  static let shared = PictureCache()
  #if canImport(UIKit)
  private var images: [String: UIImage] = [:]
  func image(_ id: String) -> UIImage? { images[id] }
  func put(_ id: String, _ i: UIImage) { if images.count > 120 { images.removeAll() }; images[id] = i }
  #endif
}

#if canImport(UIKit)
/** A picture's bytes as a picture of at most `maxPixel`, through ImageIO's thumbnail: any format the system reads
 *  (JPEG, HEIC, PNG, GIF, WebP), turned upright, never decoded at full size. nil when the bytes are no picture. */
enum Thumb {
  static func image(_ data: Data, maxPixel: Int) -> UIImage? {
    guard let src = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(src) > 0 else { return nil }
    let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                                 kCGImageSourceThumbnailMaxPixelSize: maxPixel, kCGImageSourceShouldCacheImmediately: true]
    guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary), cg.width > 0, cg.height > 0 else { return nil }
    return UIImage(cgImage: cg)
  }
}
#endif

/** A picture of the room: fetched from the hub, decrypted and checked, then shown. */
struct AttachmentImage: View {
  @EnvironmentObject var model: BoardModel
  let ref: JV
  var contentMode: ContentMode = .fill
  /** A small tile (the note's row): while it loads and when it cannot be shown, the file's name stands in it. */
  var named = false
  #if canImport(UIKit)
  @State private var image: UIImage?
  #endif
  @State private var failed = false
  var body: some View {
    ZStack {
      #if canImport(UIKit)
      if let i = image { Image(uiImage: i).resizable().aspectRatio(contentMode: contentMode) }
      else if named {
        // never an empty box: the picture's sign and its name until it is there, and if it never comes
        Rectangle().fill(Color.white.opacity(0.5)).overlay {
          VStack(spacing: 3) {
            if failed { Sketch("picture", color: Ink.noteInk).frame(width: 20, height: 20) } else { ProgressView().tint(Ink.noteInk) }
            Text(ref["file_name"].string ?? "picture").font(Face.text(10)).foregroundStyle(Ink.noteInk).lineLimit(2).multilineTextAlignment(.center)
          }.padding(4)
        }
      }
      else if failed { Rectangle().fill(Ink.sunken).overlay(Sketch("picture", color: Ink.muted).frame(width: 28, height: 28)) }
      else { Rectangle().fill(Ink.sunken).overlay(ProgressView().tint(Ink.muted)) }
      #endif
    }
    .task(id: ref["attachment_id"].string) { await load() }
  }
  private func load() async {
    #if canImport(UIKit)
    guard let id = ref["attachment_id"].string else { failed = true; return }
    if let hit = PictureCache.shared.image(id) { image = hit; return }
    do {
      let d = try await model.attachment(ref)
      // decoded off the main thread at display size, through ImageIO (HEIC, PNG with alpha, orientation, and an HDR
      // photo as its standard-range picture: drawn small it came out black, 8 October); UIKit's decoder as the fallback
      let made = await Task.detached(priority: .userInitiated) { () -> UIImage? in
        if let t = Thumb.image(d, maxPixel: 1600) { return t }
        guard let i = UIImage(data: d) else { return nil }
        return i.preparingForDisplay() ?? i
      }.value
      guard let shown = made, shown.size.width > 0, shown.size.height > 0 else { failed = true; return }
      PictureCache.shared.put(id, shown)
      image = shown
    } catch { failed = true }
    #endif
  }
}

/** What a message or a card carries: pictures as a strip, other files as chips (open, share). */
struct Attachments: View {
  @EnvironmentObject var model: BoardModel
  let list: [JV]
  var onPicture: ((Int) -> Void)? = nil
  @State private var opened: OpenedFile?
  var body: some View {
    let pics = list.filter { kindOf($0) == "image" }
    let files = list.filter { kindOf($0) != "image" }
    VStack(alignment: .leading, spacing: 8) {
      if pics.count == 1 {
        Button { onPicture?(0) } label: {
          AttachmentImage(ref: pics[0], contentMode: .fit).frame(maxWidth: 360, maxHeight: 300).clipShape(RoundedRectangle(cornerRadius: 12))
        }.buttonStyle(.plain)
      } else if pics.count > 1 {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 8) {
            ForEach(Array(pics.enumerated()), id: \.offset) { i, p in
              Button { onPicture?(i) } label: { AttachmentImage(ref: p).frame(width: 150, height: 112).clipShape(RoundedRectangle(cornerRadius: 10)) }.buttonStyle(.plain)
            }
          }
        }
      }
      // videos play right here, in the talk (a tap loads and decrypts it)
      ForEach(Array(files.filter { kindOf($0) == "video" }.enumerated()), id: \.offset) { _, f in InlineVideo(ref: f) }
      ForEach(Array(files.filter { kindOf($0) != "video" }.enumerated()), id: \.offset) { _, f in
        Button { open(f) } label: {
          HStack(spacing: 8) {
            Sketch(kindOf(f) == "video" || kindOf(f) == "audio" ? "play" : "clip", color: Ink.fg).frame(width: 18, height: 18)
            Text(f["file_name"].string ?? "file").font(Face.text(14, .medium)).foregroundStyle(Ink.fg).lineLimit(1)
            if let n = f["total_size"].int, n > 0 { Text(sizeWord(n)).font(Face.text(12)).foregroundStyle(Ink.muted) }
          }
          .padding(.horizontal, 12).padding(.vertical, 8)
          .background(RoundedRectangle(cornerRadius: 10).fill(Ink.surface))
          .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Ink.lineStrong))
        }.buttonStyle(.plain)
      }
    }
    .sheet(item: $opened) { f in FileSheet(file: f) }
  }
  private func open(_ f: JV) {
    Task {
      do {
        let d = try await model.attachment(f)
        opened = OpenedFile(name: f["file_name"].string ?? "file", type: f["media_type"].string ?? "", data: d)
      } catch { model.fail("Not opened", error) }
    }
  }
}
struct OpenedFile: Identifiable { let id = UUID(); let name: String; let type: String; let data: Data; /** An artifact's file (its reference): the bar offers Copy Link. */ var ref: JV? = nil }

/** A video of the room, played inline: its name and a play button; a tap fetches and decrypts it, then the system's player
 *  plays it in place (full screen and AirPlay from its own controls). */
struct InlineVideo: View {
  @EnvironmentObject var model: BoardModel
  let ref: JV
  @State private var url: URL?
  @State private var loading = false
  #if canImport(AVKit)
  @State private var player: AVPlayer?
  #endif
  var body: some View {
    let name = ref["file_name"].string ?? "video"
    VStack(alignment: .leading, spacing: 4) {
      #if canImport(AVKit)
      if let p = player {
        PlayerView(player: p).frame(maxWidth: 360).frame(height: 220).clipShape(RoundedRectangle(cornerRadius: 12))
          .onDisappear { p.pause() }
      } else { poster(name) }
      #else
      poster(name)
      #endif
    }
  }
  private func poster(_ name: String) -> some View {
    Button(action: load) {
      ZStack {
        RoundedRectangle(cornerRadius: 12).fill(Ink.sunken)
        if loading { ProgressView() } else {
          VStack(spacing: 8) {
            Image(systemName: "play.fill").font(.system(size: 22, weight: .bold)).foregroundStyle(Ink.fg).frame(width: 52, height: 52).background(Circle().fill(Ink.surface))
            Text(name).font(Face.text(13, .medium)).foregroundStyle(Ink.muted).lineLimit(1).padding(.horizontal, 12)
          }
        }
      }
      .frame(maxWidth: 360).frame(height: 160)
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Play \(name)")
  }
  private func load() {
    guard !loading else { return }
    loading = true
    Task {
      defer { loading = false }
      do {
        let d = try await model.attachment(ref)
        let u = TempFile.url(OpenedFile(name: ref["file_name"].string ?? "video.mp4", type: ref["media_type"].string ?? "video/mp4", data: d))
        #if canImport(AVKit)
        let p = AVPlayer(url: u)
        player = p
        p.play()
        #endif
      } catch { model.fail("Not played", error) }
    }
  }
}

/** A file of the room, opened: a page (sandboxed), a text, a video; and shared on (the system's sheet). An artifact also
 *  has Copy Link in the bar (SessionScreen.swift: the link for people outside the room; tinted while it holds, then
 *  Stop Sharing beside it). */
struct FileSheet: View {
  let file: OpenedFile
  @EnvironmentObject var model: BoardModel
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    NavigationStack {
      Group {
        if file.type == "text/html" { SandboxedPage(html: "", data: file.data) }
        else if file.type.hasPrefix("text/") || file.type == "application/json", let s = String(data: file.data, encoding: .utf8) {
          ScrollView { Text(s).font(Face.mono(13)).textSelection(.enabled).padding() }
        } else if file.type.hasPrefix("video/") || file.type.hasPrefix("audio/") {
          VideoFile(file: file)
        } else {
          VStack(spacing: 12) { Sketch("clip").frame(width: 40, height: 40); Text(file.name).font(Face.text(16, .medium)); Text(sizeWord(file.data.count)).foregroundStyle(Ink.muted) }
        }
      }
      .navigationTitle(file.name).navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) { Button("Done") { dismiss() } }
        ToolbarItem(placement: .topBarTrailing) { ShareLink(item: TempFile.url(file), preview: SharePreview(file.name)) }
        if let ref = file.ref {
          let live = model.room?.liveShare(ref["attachment_id"].string ?? "")
          ToolbarItem(placement: .topBarTrailing) {
            Button { model.copyLink(ref, title: file.name) } label: { Label(live.map(sharedWord) ?? "Copy Link", systemImage: "link") }
              .tint(live != nil ? Ink.accent : nil)
          }
          if live != nil {
            ToolbarItem(placement: .topBarTrailing) {
              Menu { Button(role: .destructive) { model.stopSharing(ref, title: file.name) } label: { Label("Stop Sharing", systemImage: "xmark.circle") } } label: { Image(systemName: "ellipsis") }
            }
          }
        }
      }
    }
  }
}
enum TempFile {
  static func url(_ f: OpenedFile) -> URL {
    let u = FileManager.default.temporaryDirectory.appendingPathComponent(f.name.replacingOccurrences(of: "/", with: "_"))
    try? f.data.write(to: u, options: [.atomic, .completeFileProtection])
    return u
  }
}
#if canImport(AVKit)
/** The system's player for a player already made (inline in the talk). */
struct PlayerView: UIViewControllerRepresentable {
  let player: AVPlayer
  func makeUIViewController(context: Context) -> AVPlayerViewController {
    let c = AVPlayerViewController()
    c.player = player
    return c
  }
  func updateUIViewController(_ c: AVPlayerViewController, context: Context) { if c.player !== player { c.player = player } }
}
struct VideoFile: UIViewControllerRepresentable {
  let file: OpenedFile
  func makeUIViewController(context: Context) -> AVPlayerViewController {
    let c = AVPlayerViewController()
    c.player = AVPlayer(url: TempFile.url(file))
    return c
  }
  func updateUIViewController(_ c: AVPlayerViewController, context: Context) {}
}
#else
struct VideoFile: View { let file: OpenedFile; var body: some View { Text(file.name) } }
#endif
