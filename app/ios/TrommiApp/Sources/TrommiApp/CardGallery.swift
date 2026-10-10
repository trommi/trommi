// CardGallery.swift: what a card carries, on its page (card.mjs cardMedia; the rules are TrommiClient's Gallery). ONE
// stage of a fixed size, the same for every picture and video of the card, so nothing on the page moves when another
// one is shown or a picture comes late. A picture is fitted in and centred, never larger than itself; a tall one stands
// at its width, its top first, and is scrolled inside the stage. A swipe turns to the next. On the stage's lower edge
// the words its agent gave the picture and the page behind it. Under the stage ONE strip: the pictures and videos small,
// then the other files as tiles, and at its end which one stands ("2 / 5"). No line with the file's name.
import SwiftUI
import UIKit
import AVFoundation
import TrommiClient

struct CardGallery: View {
  @EnvironmentObject var model: BoardModel
  /** What the stage and the strip show (the attachments that sit on no option's tile). */
  let list: [JV]
  /** Every attachment of the card: the page behind a picture may be one of them. */
  let all: [JV]
  /** Which picture or video stands, counted through the pictures, then the videos. */
  @Binding var at: Int
  /** The height the card's page has; the stage is never taller than a share of it. */
  var viewport: CGFloat = 0
  /** Open this picture large (its place among the pictures). */
  let onLarge: (Int) -> Void
  @State private var width: CGFloat = 0
  @State private var opened: OpenedFile?
  @Environment(\.openURL) private var openURL

  private static let thumb = CGSize(width: 56, height: 42)

  var body: some View {
    let media = Gallery.media(list), files = Gallery.files(list)
    let i = min(max(at, 0), max(media.count - 1, 0))
    VStack(alignment: .leading, spacing: 8) {
      if !media.isEmpty { stage(media, i) }
      if media.count > 1 || !files.isEmpty { strip(media, files, i) }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    .sheet(item: $opened) { f in FileSheet(file: f) }
  }

  // ---- the stage ------------------------------------------------------------------------------------------

  @ViewBuilder private func stage(_ media: [JV], _ i: Int) -> some View {
    let s = Gallery.stage(width: Double(width), viewport: Double(viewport))
    let size = CGSize(width: s.width, height: s.height)
    let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
    let pictures = media.filter { Gallery.kind($0) == "image" }.count
    let said = i < pictures ? Gallery.caption(media[i]) : ""
    let page = i < pictures ? Gallery.page(media[i], among: all) : nil
    Group {
      if size.width > 0 {
        ScrollView(.horizontal, showsIndicators: false) {
          LazyHStack(spacing: 0) {
            ForEach(Array(media.enumerated()), id: \.offset) { n, a in
              Group {
                if n < pictures { StagePicture(ref: a, stage: size, label: "Picture \(n + 1) of \(media.count)") { onLarge(n) } }
                else { StageVideo(ref: a, active: n == i, label: "Video \(n + 1) of \(media.count)") { open(a) } }
              }
              .frame(width: size.width, height: size.height).clipped()
            }
          }
          .scrollTargetLayout()
        }
        .scrollTargetBehavior(.paging)
        .scrollPosition(id: Binding(get: { Optional(i) }, set: { if let n = $0, n != at { at = n } }))
        .scrollDisabled(media.count < 2)
        .frame(width: size.width, height: size.height)
      } else {
        // the first layout pass, before the width is known: the stage's place in the phone's proportion
        Color.clear.aspectRatio(4.0 / 3, contentMode: .fit)
      }
    }
    .background(Ink.surface)
    .clipShape(shape)
    .overlay(shape.strokeBorder(Ink.line, lineWidth: 1))
    .overlay(alignment: .bottomLeading) {
      if !said.isEmpty {
        Text(said).font(Face.text(12, .medium)).foregroundStyle(Ink.fg).lineLimit(1).truncationMode(.tail)
          .padding(.horizontal, 10).padding(.vertical, 6)
          .glass(RoundedRectangle(cornerRadius: 9, style: .continuous))
          .frame(maxWidth: max(0, size.width / 2 - 14), alignment: .leading)
          .padding(8).allowsHitTesting(false)
      }
    }
    .overlay(alignment: .bottomTrailing) {
      if let p = page {
        Button { open(p) } label: {
          HStack(spacing: 5) {
            Sketch("page", color: Ink.fg).frame(width: 15, height: 15)
            Text(p.name).font(Face.text(12, .semibold)).foregroundStyle(Ink.fg).lineLimit(1).truncationMode(.middle)
            Text("open").font(Face.text(12)).foregroundStyle(Ink.muted)
          }
          .padding(.horizontal, 10).frame(minHeight: 30)
          .glass(Capsule(), interactive: true)
          .frame(maxWidth: max(0, size.width / 2 - 14), alignment: .trailing)
          .padding(8).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("This picture has a page behind it: open \(p.name)")
      }
    }
  }

  // ---- the strip ------------------------------------------------------------------------------------------

  private func strip(_ media: [JV], _ files: [JV], _ i: Int) -> some View {
    let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
    let pictures = media.filter { Gallery.kind($0) == "image" }.count
    return HStack(spacing: 4) {
      ScrollViewReader { proxy in
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 6) {
            if media.count > 1 {
              ForEach(Array(media.enumerated()), id: \.offset) { n, a in
                Button { withAnimation(.easeOut(duration: 0.22)) { at = n } } label: { small(a, video: n >= pictures, on: n == i) }
                  .buttonStyle(.plain).id("small-\(n)")
                  .accessibilityLabel("Show \(n >= pictures ? "video" : "picture") \(n + 1)\(Gallery.caption(a).isEmpty ? "" : ": \(Gallery.caption(a))")")
                  .accessibilityAddTraits(n == i ? .isSelected : [])
              }
            }
            ForEach(Array(files.enumerated()), id: \.offset) { _, f in
              Button { open(f) } label: { tile(f) }.buttonStyle(.plain)
                .accessibilityLabel("Open \(f["file_name"].string ?? "file")\((f["total_size"].int ?? 0) > 0 ? ", \(sizeWord(f["total_size"].int ?? 0))" : "")")
            }
          }
          .padding(6)
        }
        // the one that stands stays in view
        .onChange(of: i) { _, n in withAnimation(.easeOut(duration: 0.22)) { proxy.scrollTo("small-\(n)", anchor: .center) } }
        .onAppear { proxy.scrollTo("small-\(i)", anchor: .center) }
      }
      // a place of its own at the strip's end: it never lies on a tile
      if media.count > 1 {
        Text(Gallery.counter(at: i, of: media.count)).font(Face.text(12, .semibold)).monospacedDigit().foregroundStyle(Ink.muted)
          .fixedSize().padding(.trailing, 12)
          .accessibilityLabel("\(i + 1) of \(media.count)")
      }
    }
    .background(shape.fill(Ink.surface))
    .clipShape(shape)
    .overlay(shape.strokeBorder(Ink.line, lineWidth: 1))
  }
  /** A small picture or video of the strip; the one on the stage has the accent's ring. */
  private func small(_ a: JV, video: Bool, on: Bool) -> some View {
    let shape = RoundedRectangle(cornerRadius: 7, style: .continuous)
    return ZStack {
      Ink.sunken
      if video { Sketch("play", color: Ink.fg).frame(width: 20, height: 20) }
      else { AttachmentImage(ref: a).frame(width: Self.thumb.width, height: Self.thumb.height, alignment: .top).clipped() }
    }
    .frame(width: Self.thumb.width, height: Self.thumb.height)
    .clipShape(shape)
    .overlay(shape.strokeBorder(on ? Ink.accent : Ink.line, lineWidth: on ? 2 : 1))
    .contentShape(Rectangle())
  }
  /** A file that is neither picture nor video: the clip and its short name, as high as the small pictures. */
  private func tile(_ f: JV) -> some View {
    let shape = RoundedRectangle(cornerRadius: 7, style: .continuous)
    let sound = (f["media_type"].string ?? "").hasPrefix("audio/")
    return HStack(spacing: 5) {
      Sketch(sound ? "play" : "clip", color: Ink.fg).frame(width: 16, height: 16)
      Text(f["file_name"].string ?? "file").font(Face.mono(12, .semibold)).foregroundStyle(Ink.fg).lineLimit(1).truncationMode(.middle)
    }
    .padding(.leading, 7).padding(.trailing, 9)
    .frame(maxWidth: 150).frame(height: Self.thumb.height)
    .background(shape.fill(Ink.sunken))
    .overlay(shape.strokeBorder(Ink.line, lineWidth: 1))
    .contentShape(Rectangle())
  }

  // ---- opening ----------------------------------------------------------------------------------------------

  /** A file, or a video large: fetched and decrypted, then the file's sheet (preview, the system's player, share). */
  private func open(_ f: JV) {
    Task {
      do {
        let d = try await model.attachment(f)
        opened = OpenedFile(name: f["file_name"].string ?? "file", type: f["media_type"].string ?? "", data: d)
      } catch { model.fail("Not opened", error) }
    }
  }
  private func open(_ p: Gallery.Page) {
    if let f = p.file { open(f) } else if let s = p.url, let u = URL(string: s) { openURL(u) }
  }
}

/**
 * A picture on the stage: fitted in and centred (Gallery.fitted), a tall one at its width and scrolled, its top first.
 * Until it is fetched and decrypted its place says so, at the size the card knows for it; when it does not come, the
 * line says why, and a tap tries again. A tap on the picture opens it large.
 */
struct StagePicture: View {
  @EnvironmentObject var model: BoardModel
  let ref: JV
  let stage: CGSize
  let label: String
  let onLarge: () -> Void
  @State private var image: UIImage?
  @State private var failure: String?

  var body: some View {
    // the size the card knows; one it does not know is the picture's own once it has come
    let known = Gallery.size(ref) ?? image.map { (width: Double($0.size.width), height: Double($0.size.height)) }
    let f = known.map { Gallery.fitted(width: $0.width, height: $0.height, stage: (width: Double(stage.width), height: Double(stage.height))) }
    ZStack {
      if let why = failure {
        VStack(spacing: 8) {
          Sketch("picture", color: Ink.muted).frame(width: 28, height: 28)
          Text("This file could not be loaded: \(why)").font(Face.text(13, .medium)).foregroundStyle(Ink.muted).multilineTextAlignment(.center)
          Text("Tap to try again").font(Face.text(12)).foregroundStyle(Ink.faint)
        }.padding(16)
      } else if let i = image, let f = f, f.width > 0 {
        let shown = Image(uiImage: i).resizable().interpolation(.high).frame(width: f.width, height: f.height)
        if f.scrolls {
          ScrollView(.vertical) { shown.frame(maxWidth: .infinity) }.scrollBounceBehavior(.basedOnSize)
        } else { shown }
      } else {
        // its place while it comes: nothing moves when it is there
        ZStack {
          if let f = f, f.width > 0 { Ink.sunken.frame(width: f.width, height: min(f.height, stage.height)) }
          Text("Opening the picture…").font(Face.text(13, .medium)).foregroundStyle(Ink.muted)
        }
      }
    }
    .frame(width: stage.width, height: stage.height)
    .contentShape(Rectangle())
    .onTapGesture { if failure == nil { onLarge() } else { Task { await load() } } }
    .task(id: ref["attachment_id"].string) { await load() }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(failure.map { "\(label). This file could not be loaded: \($0)" } ?? (image == nil ? "\(label). Opening the picture" : "\(label)\(Gallery.caption(ref).isEmpty ? "" : ": \(Gallery.caption(ref))"). Open it large"))
    .accessibilityAddTraits(.isButton)
  }
  private func load() async {
    image = nil; failure = nil
    // a tall one is read at its width, so it is decoded larger than a picture that is fitted in
    let tall = Gallery.size(ref).map { Gallery.isTall(width: $0.width, height: $0.height) } ?? false
    do { image = try await Pictures.load(ref, model: model, maxPixel: tall ? 4096 : 1600) }
    catch { if !Task.isCancelled { failure = model.describe(error) } }
  }
}

/**
 * A video on the stage: black, a play mark; a tap fetches and decrypts it, then plays it in place, and a tap on the
 * video pauses and plays. The small button in the corner opens it large (the system's player: full screen, AirPlay).
 * It stops when another one is shown.
 */
struct StageVideo: View {
  @EnvironmentObject var model: BoardModel
  let ref: JV
  let active: Bool
  let label: String
  let onLarge: () -> Void
  @State private var player: AVPlayer?
  @State private var loading = false
  @State private var playing = false
  @State private var failure: String?

  var body: some View {
    ZStack {
      Color.black
      if let p = player { PlayerLayer(player: p) }
      if let why = failure {
        Text("This file could not be loaded: \(why)").font(Face.text(13, .medium)).foregroundStyle(.white.opacity(0.8)).multilineTextAlignment(.center).padding(16)
      } else if loading {
        VStack(spacing: 8) { ProgressView().tint(.white); Text("Opening the video…").font(Face.text(13, .medium)).foregroundStyle(.white.opacity(0.8)) }
      } else if !playing {
        Sketch("play", color: .white).frame(width: 26, height: 26).frame(width: 58, height: 58).glass(Circle())
      }
    }
    .contentShape(Rectangle())
    .onTapGesture { toggle() }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(label). \(playing ? "Pause" : "Play")")
    .accessibilityAddTraits(.isButton)
    .overlay(alignment: .topTrailing) {
      Button { pause(); onLarge() } label: {
        Image(systemName: "arrow.up.left.and.arrow.down.right").font(.system(size: 13, weight: .bold)).foregroundStyle(.white)
          .frame(width: 36, height: 36).glass(Circle(), interactive: true)
          .padding(8).contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Open the video large")
    }
    .onChange(of: active) { _, on in if !on { pause() } }
    .onDisappear { pause() }
    // at its end it stands at the start again, ready to play
    .onReceive(NotificationCenter.default.publisher(for: AVPlayerItem.didPlayToEndTimeNotification)) { n in
      if let p = player, (n.object as? AVPlayerItem) === p.currentItem { playing = false; p.seek(to: .zero) }
    }
  }
  private func pause() { player?.pause(); playing = false }
  private func toggle() {
    if let p = player { if playing { pause() } else { p.play(); playing = true }; return }
    guard !loading else { return }
    loading = true; failure = nil
    Task {
      defer { loading = false }
      do {
        let d = try await model.attachment(ref)
        let p = AVPlayer(url: TempFile.url(OpenedFile(name: ref["file_name"].string ?? "video.mp4", type: ref["media_type"].string ?? "video/mp4", data: d)))
        player = p
        if active { p.play(); playing = true }
      } catch { failure = model.describe(error) }
    }
  }
}

/** A player's picture alone, no controls of its own (the stage's taps are the card's). */
struct PlayerLayer: UIViewRepresentable {
  let player: AVPlayer
  final class Surface: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var video: AVPlayerLayer { layer as! AVPlayerLayer }
  }
  func makeUIView(context: Context) -> Surface {
    let v = Surface()
    v.isUserInteractionEnabled = false
    v.video.videoGravity = .resizeAspect
    v.video.player = player
    return v
  }
  func updateUIView(_ v: Surface, context: Context) { if v.video.player !== player { v.video.player = player } }
}
