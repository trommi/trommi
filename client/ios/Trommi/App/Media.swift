// Sound and pictures: attachments are behind the cookie, so the app loads
// them itself; reading a card aloud and dictation go through the server too.
import SwiftUI
import AVFoundation

/// Pictures of attachments, loaded once and kept while memory allows.
@MainActor
final class ImageStore {
    var client: (any BoardClient)? { didSet { cache.removeAllObjects() } }
    private let cache = NSCache<NSString, UIImage>()

    func image(_ path: String) async throws -> UIImage {
        if let hit = cache.object(forKey: path as NSString) { return hit }
        guard let client else { throw ClientError.notFound }
        let data = try await client.data(path: path)
        guard let image = UIImage(data: data) else { throw ClientError.badAnswer }
        cache.setObject(image, forKey: path as NSString)
        return image
    }

    /// The attachment as a file, for Quick Look.
    func file(_ attachment: Attachment) async throws -> URL {
        guard let client else { throw ClientError.notFound }
        let data = try await client.data(path: attachment.url)
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("attachments", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let name = attachment.name.replacingOccurrences(of: "/", with: "_")
        let url = folder.appendingPathComponent(name.isEmpty ? "Attachment" : name)
        try data.write(to: url, options: .atomic)
        return url
    }
}

extension MediaAccess {
    /// A player for a video or audio attachment. It streams in ranges and
    /// carries the cookie, which AVFoundation only sends when told to.
    func player(path: String) -> AVPlayer? {
        guard let url = link.url(path: path), let host = url.host else { return nil }
        var options: [String: Any] = [:]
        if let cookie = HTTPCookie(properties: [.name: cookie.name, .value: cookie.value, .domain: host, .path: "/"]) {
            options[AVURLAssetHTTPCookiesKey] = [cookie]
        }
        return AVPlayer(playerItem: AVPlayerItem(asset: AVURLAsset(url: url, options: options)))
    }
}

/// Reads one question aloud at a time: GET /speech/card/<id> is an MP3.
@MainActor
@Observable
final class Speaker {
    enum Phase: Equatable { case idle, loading(String), playing(String) }

    private(set) var phase: Phase = .idle
    var failure: String?
    @ObservationIgnored var client: (any BoardClient)?
    @ObservationIgnored private var player: AVAudioPlayer?
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private let ending = PlaybackEnd()

    func isBusy(with cardID: String) -> Bool { phase == .loading(cardID) || phase == .playing(cardID) }

    /// Reads the question, or stops if it is the one being read.
    func toggle(_ cardID: String) {
        let same = isBusy(with: cardID)
        stop()
        guard !same, let client, let path = client.media?.link.cardSpeechPath(cardID) else { return }
        phase = .loading(cardID)
        task = Task { [weak self] in
            do {
                let data = try await client.data(path: path)
                guard let self, !Task.isCancelled, self.phase == .loading(cardID) else { return }
                try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
                try AVAudioSession.sharedInstance().setActive(true)
                let player = try AVAudioPlayer(data: data)
                self.ending.onEnd = { [weak self] in
                    Task { @MainActor in self?.stop() }
                }
                player.delegate = self.ending
                self.player = player
                player.play()
                self.phase = .playing(cardID)
            } catch {
                guard let self, !Task.isCancelled else { return }
                self.phase = .idle
                self.failure = "Not read aloud: \(readable(error))"
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
        player?.stop()
        player = nil
        phase = .idle
    }
}

/// AVAudioPlayer reports its end to a delegate object; this one passes it on.
private final class PlaybackEnd: NSObject, AVAudioPlayerDelegate {
    var onEnd: (() -> Void)?

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        onEnd?()
    }
}

/// Dictation: first tap records, second tap stops and hands the recording to
/// POST /speech/transcribe. The transcript goes to `onText`.
@MainActor
@Observable
final class Dictation {
    enum Phase { case idle, recording, working }

    private(set) var phase: Phase = .idle
    var failure: String?
    @ObservationIgnored private var recorder: AVAudioRecorder?
    @ObservationIgnored private let file = FileManager.default.temporaryDirectory.appendingPathComponent("dictation.m4a")

    /// VoiceOver label, as in speech.js.
    var label: String { phase == .recording ? "Stop recording" : "Dictate a message" }

    func toggle(transcribe: @escaping (Data) async throws -> String, onText: @escaping (String) -> Void) {
        switch phase {
        case .working: return
        case .recording: finish(transcribe: transcribe, onText: onText)
        case .idle: Task { await begin() }
        }
    }

    private func begin() async {
        failure = nil
        guard await AVAudioApplication.requestRecordPermission() else {
            failure = "No access to the microphone. Allow it in Settings."
            return
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
            try session.setActive(true)
            let settings: [String: Any] = [
                AVFormatIDKey: Int(kAudioFormatMPEG4AAC), AVSampleRateKey: 44_100, AVNumberOfChannelsKey: 1,
                AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
            ]
            let recorder = try AVAudioRecorder(url: file, settings: settings)
            guard recorder.record() else { throw ClientError.badAnswer }
            self.recorder = recorder
            phase = .recording
            Haptics.play(.tap)
        } catch {
            failure = "The recording could not be started."
        }
    }

    private func finish(transcribe: @escaping (Data) async throws -> String, onText: @escaping (String) -> Void) {
        recorder?.stop()
        recorder = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        guard let audio = try? Data(contentsOf: file), !audio.isEmpty else {
            phase = .idle
            return
        }
        phase = .working
        Task {
            do {
                let text = try await transcribe(audio)
                if !text.isEmpty { onText(text) }
            } catch {
                failure = "Not recognised: \(readable(error))"
            }
            try? FileManager.default.removeItem(at: file)
            phase = .idle
        }
    }

    /// Leaving the screen while recording throws the recording away.
    func cancel() {
        recorder?.stop()
        recorder = nil
        if phase == .recording { phase = .idle }
    }
}
