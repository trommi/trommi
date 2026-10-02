// Live dictation: the microphone's sound goes to the hub in small pieces
// (POST /speech/live/<id>, 16-bit mono at 16 kHz) and the words come back on an
// event stream while the human is still speaking (POST /speech/live: ready,
// delta, final, error). Here is everything of it that needs no microphone: the
// events, the text as it grows in the field, and the conversion of samples.
// Follows client/web/js/speech.js and liveOpen() in server.mjs.
import Foundation
import Observation

/// One event of the dictation stream.
enum DictationEvent: Equatable, Sendable {
    /// The hub is listening: where to send the sound, at which rate, and for how long at most.
    case ready(id: String, rate: Int, maxSeconds: Double)
    /// More words, to be appended. Never revised.
    case delta(String)
    /// The whole text once more, read by the better model when `polished`. `reason`: stop, idle or limit.
    case final(text: String, polished: Bool, reason: String)
    case failed(String)

    /// An event as the hub writes it: its name and its JSON. Unknown events are nil.
    static func parse(event: String, data: String) -> DictationEvent? {
        let object = (try? JSONSerialization.jsonObject(with: Data(data.utf8))) as? [String: Any] ?? [:]
        switch event {
        case "ready":
            guard let id = object["id"] as? String, !id.isEmpty else { return nil }
            return .ready(id: id, rate: (object["rate"] as? NSNumber)?.intValue ?? PCM.rate, maxSeconds: (object["max_seconds"] as? NSNumber)?.doubleValue ?? 180)
        case "delta":
            guard let text = object["text"] as? String else { return nil }
            return .delta(text)
        case "final":
            return .final(text: object["text"] as? String ?? "", polished: (object["polished"] as? Bool) ?? false, reason: object["reason"] as? String ?? "stop")
        case "error":
            return .failed(object["message"] as? String ?? "The speech service failed.")
        default:
            return nil
        }
    }
}

/// The text of a field while it is dictated into. What stood there stays; the streamed words
/// follow it, provisional until the final reading replaces them. If the human types in the
/// middle of it, what stands is theirs: new words follow their text, and the final reading
/// no longer replaces anything (anchor() and settle() in speech.js; the app has no caret to
/// follow, so words go to the end of the field).
struct LiveText: Equatable, Sendable {
    /// What the words are appended to: the field when the dictation began, or as the human last left it.
    private(set) var base: String
    /// The words heard since.
    private(set) var heard = ""
    /// The human typed into the field while the dictation ran.
    private(set) var edited = false

    init(base: String) { self.base = base }

    private func joined(_ words: String) -> String {
        let clean = words.trimmingCharacters(in: .whitespacesAndNewlines)
        if clean.isEmpty { return base }
        let glue = base.isEmpty || base.last?.isWhitespace == true ? "" : " "
        return base + glue + clean
    }

    /// The field as the dictation last wrote it.
    var shown: String { joined(heard) }

    /// More words arrived. `current`: what the field holds. Returns what it should hold now.
    mutating func delta(_ text: String, current: String) -> String {
        if current != shown {
            base = current
            heard = ""
            edited = true
        }
        heard += text
        return shown
    }

    /// The final reading of the whole dictation. It replaces the provisional words, unless
    /// the human has typed in between or nothing was heard.
    func final(_ text: String, current: String) -> String {
        guard !edited, current == shown, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return current }
        return joined(text)
    }
}

/// Sound for the hub: 16-bit signed samples, little endian, mono, 16 kHz.
enum PCM {
    static let rate = 16_000

    /// One sample in -1...1 as a 16-bit number, clipped (as pcm-worklet.js writes it).
    static func int16(_ sample: Float) -> Int16 {
        let s = max(-1, min(1, sample.isFinite ? sample : 0))
        return Int16((s < 0 ? s * 32768 : s * 32767).rounded())
    }

    /// Samples as the bytes the hub takes.
    static func bytes(_ samples: [Float]) -> Data {
        var out = Data(capacity: samples.count * 2)
        for sample in samples {
            let value = UInt16(bitPattern: int16(sample))
            out.append(UInt8(value & 0xFF))
            out.append(UInt8(value >> 8))
        }
        return out
    }
}

/// Brings the microphone's rate (44.1 or 48 kHz) down to the hub's, piece by piece: each
/// output sample is taken between its two neighbours on the input, and the place in the
/// input is carried from one piece to the next, so the pieces join without a click.
struct Resampler: Sendable {
    let step: Double
    private var position = 0.0
    private var last: Float?

    init(from inputRate: Double, to outputRate: Double = Double(PCM.rate)) {
        step = inputRate > 0 && outputRate > 0 ? inputRate / outputRate : 1
    }

    /// The next piece of input; returns the samples at the output rate that it completes.
    mutating func feed(_ input: [Float]) -> [Float] {
        guard !input.isEmpty else { return [] }
        // The sample before this piece stands at index -1.
        func at(_ i: Int) -> Float { i < 0 ? (last ?? input[0]) : input[i] }
        var out: [Float] = []
        out.reserveCapacity(Int(Double(input.count) / step) + 1)
        while position <= Double(input.count - 1) {
            let lower = Int(position.rounded(.down))
            let fraction = Float(position - Double(lower))
            let a = at(lower), b = at(min(lower + 1, input.count - 1))
            out.append(a + (b - a) * fraction)
            position += step
        }
        position -= Double(input.count)
        last = input[input.count - 1]
        return out
    }
}

/// Where the microphone puts its sound. It may be fed from any thread (the audio engine
/// calls from its own); the pieces come out in the order they went in, at the hub's rate.
final class AudioFeed: @unchecked Sendable {
    let pieces: AsyncStream<Data>
    private let continuation: AsyncStream<Data>.Continuation
    private let lock = NSLock()
    private var resampler: Resampler?
    private var rate = 0.0

    init() {
        var made: AsyncStream<Data>.Continuation!
        pieces = AsyncStream<Data> { made = $0 }
        continuation = made
    }

    /// The next piece from the microphone: mono samples in -1...1 at `rate` per second.
    func feed(_ samples: [Float], rate: Double) {
        guard !samples.isEmpty, rate > 0 else { return }
        lock.lock()
        if resampler == nil || self.rate != rate {
            resampler = Resampler(from: rate)
            self.rate = rate
        }
        let out = resampler?.feed(samples) ?? []
        lock.unlock()
        if !out.isEmpty { continuation.yield(PCM.bytes(out)) }
    }

    /// No more sound will come.
    func finish() { continuation.finish() }
}

/// One dictation into one text field: it asks the hub to listen, sends the sound as it comes
/// and writes the words into the field while the human is still speaking. What only a device
/// can do, the microphone, feeds the `AudioFeed` that `start` returns (App/Media.swift).
@MainActor
@Observable
final class LiveDictation {
    enum Phase: Equatable, Sendable {
        case idle
        /// Asked the hub; sound is already being collected.
        case starting
        case listening
        /// Stopped; the final reading is on its way.
        case finishing
    }

    private(set) var phase: Phase = .idle
    /// A sentence when the dictation did not work; cleared by the next start.
    var failure: String?

    @ObservationIgnored private var run: Task<Void, Never>?
    @ObservationIgnored private var upload: Task<Void, Never>?
    @ObservationIgnored private var feed: AudioFeed?

    /// Views keep one as @State, whose initial value is made outside the main actor's knowledge.
    nonisolated init() {}

    var isActive: Bool { phase != .idle }

    /// VoiceOver label of the microphone button.
    var label: String {
        switch phase {
        case .idle: return "Dictate"
        case .starting, .listening: return "Stop dictating"
        case .finishing: return "Finishing the dictation"
        }
    }

    /// Begin. `read` gives what the field holds, `write` puts text into it. Returns where the
    /// microphone's sound goes; nil when a dictation is already running.
    @discardableResult
    func start(client: any BoardClient, read: @escaping @MainActor () -> String, write: @escaping @MainActor (String) -> Void) -> AudioFeed? {
        guard phase == .idle else { return nil }
        failure = nil
        phase = .starting
        let feed = AudioFeed()
        self.feed = feed
        var live = LiveText(base: read())
        run = Task { [weak self] in
            do {
                for try await event in client.liveDictation() {
                    guard let self, !Task.isCancelled else { return }
                    switch event {
                    case .ready(let id, _, _):
                        if self.phase == .starting { self.phase = .listening }
                        // The sound collected so far, then every further piece, one after the other;
                        // when the microphone has stopped, the hub is told so and answers with the final text.
                        self.upload = Task {
                            for await piece in feed.pieces {
                                if Task.isCancelled { return }
                                do { try await client.sendDictationAudio(id: id, pcm: piece) } catch { break }
                            }
                            if !Task.isCancelled { try? await client.stopDictation(id: id) }
                        }
                    case .delta(let text):
                        write(live.delta(text, current: read()))
                    case .final(let text, _, _):
                        write(live.final(text, current: read()))
                    case .failed(let message):
                        self.failure = "Not recognised: \(message)"
                    }
                }
            } catch {
                if !Task.isCancelled { self?.failure = "Not recognised: \(readable(error))" }
            }
            guard let self, !Task.isCancelled else { return }
            self.finished()
        }
        return feed
    }

    /// The human stopped speaking: what is still to be sent goes out, then the final reading replaces the provisional words.
    func stop() {
        guard phase == .starting || phase == .listening else { return }
        phase = .finishing
        feed?.finish()
    }

    /// Leave at once (the view goes away): nothing is left running, here or on the hub.
    func cancel() {
        run?.cancel()
        upload?.cancel()
        finished()
    }

    private func finished() {
        feed?.finish()
        feed = nil
        run = nil
        upload = nil
        phase = .idle
    }
}
