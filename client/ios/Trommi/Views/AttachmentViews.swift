// Attachments of questions and messages: pictures open in a zoomable viewer,
// video and audio play in place, anything else opens in Quick Look.
import SwiftUI
import AVKit
import Combine
import QuickLook
import UIKit

struct AttachmentList: View {
    let attachments: [Attachment]
    @State private var viewer: ViewerRequest?

    private var images: [Attachment] { attachments.filter { $0.kind == .image || $0.kind == .scribble } }

    var body: some View {
        if !attachments.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                pictures
                ForEach(attachments.filter { $0.kind == .video }) { video in
                    VideoAttachment(attachment: video)
                }
                ForEach(attachments.filter { $0.kind == .audio }) { audio in
                    AudioAttachment(attachment: audio)
                }
                ForEach(attachments.filter { $0.kind == .file }) { file in
                    FileAttachment(attachment: file)
                }
            }
            .fullScreenCover(item: $viewer) { request in
                ImageViewer(images: images, start: request.index)
            }
        }
    }

    @ViewBuilder
    private var pictures: some View {
        if images.count == 1, let only = images.first {
            thumbnail(only, index: 0).frame(maxHeight: 320)
        } else if images.count > 1 {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(Array(images.enumerated()), id: \.offset) { index, image in
                        thumbnail(image, index: index).frame(height: 180)
                    }
                }
            }
        }
    }

    private func thumbnail(_ image: Attachment, index: Int) -> some View {
        Button {
            viewer = ViewerRequest(index: index)
        } label: {
            RemoteImage(attachment: image)
                .clipShape(RoundedRectangle(cornerRadius: Theme.radiusSmall, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: Theme.radiusSmall, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Enlarge image \(index + 1) of \(images.count): \(image.name)")
    }
}

/// A picture behind the cookie. Shows a spinner while loading and the file name if it cannot be shown.
struct RemoteImage: View {
    @Environment(Media.self) private var media
    let attachment: Attachment
    /// Fill the frame and crop, for small square thumbnails; otherwise fit.
    var fill = false
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        content
            .task(id: attachment.url) {
                await load()
            }
    }

    @ViewBuilder
    private var content: some View {
        if let image {
            if fill {
                Color.clear.overlay(Image(uiImage: image).resizable().scaledToFill()).clipped()
            } else {
                Image(uiImage: image).resizable().scaledToFit()
            }
        } else if failed {
            VStack(spacing: 6) {
                Image(systemName: "photo").font(.title2)
                if !fill {
                    Text(attachment.name).font(.caption).lineLimit(2).multilineTextAlignment(.center)
                }
            }
            .foregroundStyle(Theme.faint)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .frame(minWidth: fill ? 0 : 140, minHeight: fill ? 0 : 100)
            .background(Theme.sunken)
        } else {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .frame(minWidth: fill ? 0 : 140, minHeight: fill ? 0 : 100)
                .background(Theme.sunken)
        }
    }

    private func load() async {
        do {
            image = try await media.images.image(attachment.url)
            failed = false
        } catch {
            failed = !(error is CancellationError)
        }
    }
}

/// Full screen pictures: back and next between them, pinch or double tap to zoom.
struct ImageViewer: View {
    @Environment(\.dismiss) private var dismiss
    let images: [Attachment]
    @State private var index: Int

    init(images: [Attachment], start: Int) {
        self.images = images
        _index = State(initialValue: start)
    }

    private var current: Attachment? { images.indices.contains(index) ? images[index] : nil }

    private var title: String {
        guard let current else { return "" }
        return images.count > 1 ? "\(index + 1) / \(images.count) · \(current.name)" : current.name
    }

    var body: some View {
        NavigationStack {
            page
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.black)
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close") { dismiss() }
                            .accessibilityLabel("Close image view")
                            .accessibilityIdentifier("viewer-close")
                    }
                    ToolbarItemGroup(placement: .bottomBar) {
                        if images.count > 1 {
                            Button {
                                index -= 1
                            } label: {
                                Label("Previous image", systemImage: "chevron.left")
                            }
                            .disabled(index <= 0)
                            Spacer()
                            Button {
                                index += 1
                            } label: {
                                Label("Next image", systemImage: "chevron.right")
                            }
                            .disabled(index >= images.count - 1)
                        }
                    }
                }
        }
    }

    @ViewBuilder
    private var page: some View {
        if let current {
            ZoomPage(attachment: current).id(current.url)
        }
    }
}

private struct ZoomPage: View {
    @Environment(Media.self) private var media
    let attachment: Attachment
    @State private var image: UIImage?

    var body: some View {
        content
            .task {
                image = try? await media.images.image(attachment.url)
            }
    }

    @ViewBuilder
    private var content: some View {
        if let image {
            ZoomableImage(image: image).accessibilityLabel(attachment.name)
        } else {
            ProgressView().tint(.white)
        }
    }
}

/// UIScrollView does the pinching; SwiftUI has no equal for it yet.
private struct ZoomableImage: UIViewRepresentable {
    let image: UIImage

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UIScrollView {
        let scroll = UIScrollView()
        scroll.minimumZoomScale = 1
        scroll.maximumZoomScale = 6
        scroll.showsVerticalScrollIndicator = false
        scroll.showsHorizontalScrollIndicator = false
        scroll.delegate = context.coordinator
        let view = UIImageView(image: image)
        view.contentMode = .scaleAspectFit
        view.frame = scroll.bounds
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        scroll.addSubview(view)
        context.coordinator.imageView = view
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.doubleTap(_:)))
        tap.numberOfTapsRequired = 2
        scroll.addGestureRecognizer(tap)
        return scroll
    }

    func updateUIView(_ scroll: UIScrollView, context: Context) {
        context.coordinator.imageView?.image = image
    }

    @MainActor
    final class Coordinator: NSObject, UIScrollViewDelegate {
        weak var imageView: UIImageView?

        func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

        @objc func doubleTap(_ gesture: UITapGestureRecognizer) {
            guard let scroll = gesture.view as? UIScrollView else { return }
            if scroll.zoomScale > 1 {
                scroll.setZoomScale(1, animated: true)
            } else {
                let point = gesture.location(in: imageView)
                let size = CGSize(width: scroll.bounds.width / 2.5, height: scroll.bounds.height / 2.5)
                scroll.zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
            }
        }
    }
}

struct VideoAttachment: View {
    @Environment(AppModel.self) private var model
    let attachment: Attachment
    @State private var player: AVPlayer?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            screen
                .aspectRatio(16 / 9, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
            Text(attachment.name).font(.caption).foregroundStyle(Theme.faint).lineLimit(1)
        }
        .onAppear {
            if player == nil { player = model.client?.media?.player(path: attachment.url) }
        }
        .onDisappear { player?.pause() }
        .accessibilityLabel("Video: \(attachment.name)")
    }

    @ViewBuilder
    private var screen: some View {
        if let player {
            VideoPlayer(player: player)
        } else {
            ZStack {
                Color.black
                Image(systemName: "play.slash").font(.title).foregroundStyle(Color.white.opacity(0.7))
            }
        }
    }
}

struct AudioAttachment: View {
    @Environment(AppModel.self) private var model
    let attachment: Attachment
    @State private var player: AVPlayer?
    @State private var playing = false

    var body: some View {
        HStack(spacing: 12) {
            Button {
                toggle()
            } label: {
                Image(systemName: playing ? "pause.circle.fill" : "play.circle.fill").font(.system(size: 34))
            }
            .buttonStyle(.plain)
            .foregroundStyle(Theme.accent)
            .accessibilityLabel(playing ? "Pause: \(attachment.name)" : "Play: \(attachment.name)")
            Text(attachment.name).font(.subheadline).foregroundStyle(Theme.fg).lineLimit(2)
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(Theme.sunken, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
        .onReceive(NotificationCenter.default.publisher(for: .AVPlayerItemDidPlayToEndTime)) { note in
            guard let item = note.object as? AVPlayerItem, item === player?.currentItem else { return }
            playing = false
            player?.seek(to: .zero)
        }
        .onDisappear {
            player?.pause()
            playing = false
        }
    }

    private func toggle() {
        if player == nil { player = model.client?.media?.player(path: attachment.url) }
        guard let player else { return }
        if playing { player.pause() } else { player.play() }
        playing.toggle()
    }
}

struct FileAttachment: View {
    @Environment(Media.self) private var media
    let attachment: Attachment
    @State private var preview: URL?
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                load()
            } label: {
                HStack(spacing: 10) {
                    if loading {
                        ProgressView()
                    } else {
                        Image(systemName: "doc")
                    }
                    Text(attachment.name).lineLimit(2)
                    Spacer(minLength: 0)
                }
                .font(.subheadline)
                .padding(10)
                .background(Theme.sunken, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
            }
            .buttonStyle(.plain)
            .foregroundStyle(Theme.fg)
            .disabled(loading)
            .accessibilityLabel("Open file: \(attachment.name)")
            InlineError(text: error)
        }
        .quickLookPreview($preview)
    }

    private func load() {
        loading = true
        error = nil
        Task {
            do {
                preview = try await media.images.file(attachment)
            } catch {
                self.error = "Not loaded: \(readable(error))"
            }
            loading = false
        }
    }
}
