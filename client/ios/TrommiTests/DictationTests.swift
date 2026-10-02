import XCTest
#if canImport(TrommiCore)
@testable import TrommiCore
#else
@testable import Trommi
#endif

/// Live dictation without a microphone: the events of the hub's stream, the text as it
/// grows in the field, and the samples as the hub takes them.
final class DictationCoreTests: XCTestCase {
    func testNamedEventsOfAStream() {
        var parser = SSEParser()
        let wire = "event: ready\ndata: {\"id\":\"abc\",\"rate\":16000,\"max_seconds\":180}\n\nevent: delta\ndata: {\"text\":\"Hel\"}\n\n: ping\n\nevent: del"
        var events = parser.feedEvents(Data(wire.utf8))
        XCTAssertEqual(events, [SSEEvent(name: "ready", data: #"{"id":"abc","rate":16000,"max_seconds":180}"#), SSEEvent(name: "delta", data: #"{"text":"Hel"}"#)])
        events = parser.feedEvents(Data("ta\ndata: {\"text\":\"lo\"}\n\ndata: plain\n\n".utf8))
        XCTAssertEqual(events, [SSEEvent(name: "delta", data: #"{"text":"lo"}"#), SSEEvent(name: "message", data: "plain")],
                       "a name split over two chunks; an event without a name is a message, and a name does not leak into the next event")
        // The state stream still reads as before.
        var states = SSEParser()
        XCTAssertEqual(states.feed(Data("data: {}\n\n".utf8)), ["{}"])
    }

    func testDictationEventsAsTheHubWritesThem() {
        XCTAssertEqual(DictationEvent.parse(event: "ready", data: #"{"id":"a1b2","rate":16000,"max_seconds":180}"#), .ready(id: "a1b2", rate: 16000, maxSeconds: 180))
        XCTAssertEqual(DictationEvent.parse(event: "delta", data: #"{"text":" nimm"}"#), .delta(" nimm"))
        XCTAssertEqual(DictationEvent.parse(event: "final", data: #"{"text":"Bitte nimm die zweite.","polished":true,"reason":"stop","seconds":2.4}"#),
                       .final(text: "Bitte nimm die zweite.", polished: true, reason: "stop"))
        XCTAssertEqual(DictationEvent.parse(event: "final", data: #"{"text":"","polished":false,"reason":"idle"}"#), .final(text: "", polished: false, reason: "idle"))
        XCTAssertEqual(DictationEvent.parse(event: "error", data: #"{"message":"Speech service: the live connection failed"}"#), .failed("Speech service: the live connection failed"))
        XCTAssertNil(DictationEvent.parse(event: "ready", data: "{}"), "ready without an id is no start")
        XCTAssertNil(DictationEvent.parse(event: "message", data: "{}"))
        XCTAssertNil(DictationEvent.parse(event: "delta", data: "not json"))
    }

    func testWordsGrowInTheFieldAndTheFinalReadingReplacesThem() {
        var live = LiveText(base: "Deploy")
        var field = "Deploy"
        field = live.delta("Bitten in", current: field)
        XCTAssertEqual(field, "Deploy Bitten in")
        field = live.delta(" die zweite", current: field)
        XCTAssertEqual(field, "Deploy Bitten in die zweite")
        XCTAssertEqual(live.final("Bitte nimm die zweite.", current: field), "Deploy Bitte nimm die zweite.", "the better reading replaces the provisional words")

        // Into an empty field, and one that ends in a space: no stray space.
        var empty = LiveText(base: "")
        XCTAssertEqual(empty.delta(" Hello", current: ""), "Hello")
        XCTAssertEqual(empty.final("Hello there.", current: "Hello"), "Hello there.")
        var spaced = LiveText(base: "Note: ")
        XCTAssertEqual(spaced.delta("yes", current: "Note: "), "Note: yes")

        // Nothing heard: the field is as it was.
        XCTAssertEqual(LiveText(base: "Deploy").final("", current: "Deploy"), "Deploy")
    }

    func testWhatTheHumanTypedMeanwhileStands() {
        var live = LiveText(base: "")
        var field = live.delta("Hello", current: "")
        field += " world"   // typed while the dictation runs
        field = live.delta(" there", current: field)
        XCTAssertEqual(field, "Hello world there", "what stands is the human's now; new words follow it")
        XCTAssertTrue(live.edited)
        XCTAssertEqual(live.final("Hello there.", current: field), "Hello world there", "the final reading no longer replaces anything")
        // Typed after the last word and before the final reading: left alone too.
        var late = LiveText(base: "")
        _ = late.delta("Hello", current: "")
        XCTAssertEqual(late.final("Hello.", current: "Hello!"), "Hello!")
    }

    func testSamplesAsSixteenBitLittleEndian() {
        XCTAssertEqual(PCM.int16(0), 0)
        XCTAssertEqual(PCM.int16(1), 32767)
        XCTAssertEqual(PCM.int16(-1), -32768)
        XCTAssertEqual(PCM.int16(2.5), 32767, "clipped")
        XCTAssertEqual(PCM.int16(-7), -32768)
        XCTAssertEqual(PCM.int16(.nan), 0)
        XCTAssertEqual(PCM.int16(0.5), 16384)
        XCTAssertEqual(Array(PCM.bytes([0, 1, -1, 0.5])), [0x00, 0x00, 0xFF, 0x7F, 0x00, 0x80, 0x00, 0x40])
        XCTAssertEqual(PCM.rate, 16_000)
    }

    func testResamplingKeepsTheLengthAndJoinsPiecesWithoutAGap() {
        // 48 kHz down to 16 kHz: every third sample.
        var third = Resampler(from: 48_000)
        let ramp = (0..<480).map { Float($0) }
        XCTAssertEqual(third.feed(ramp), stride(from: 0, to: 480, by: 3).map { Float($0) })

        // 44.1 kHz: one second in pieces of odd sizes gives one second out, and a ramp stays a ramp.
        var cd = Resampler(from: 44_100)
        var out: [Float] = []
        var next = 0
        for size in [1000, 4410, 37, 4096, 4096, 30461] {
            out += cd.feed((next..<(next + size)).map { Float($0) })
            next += size
        }
        XCTAssertEqual(next, 44_100)
        XCTAssertEqual(out.count, 16_000)
        for (i, value) in out.enumerated() where i % 997 == 0 {
            XCTAssertEqual(Double(value), Double(i) * 44_100 / 16_000, accuracy: 0.01, "sample \(i)")
        }
        // The same rate passes through; nothing in, nothing out.
        var same = Resampler(from: 16_000)
        XCTAssertEqual(same.feed([0.1, 0.2, 0.3]), [0.1, 0.2, 0.3])
        XCTAssertEqual(same.feed([]), [])
    }

    func testTheFeedTurnsMicrophoneSoundIntoPiecesForTheHub() async {
        let feed = AudioFeed()
        feed.feed([Float](repeating: 0.5, count: 4800), rate: 48_000)
        feed.feed([], rate: 48_000)
        feed.feed([Float](repeating: -0.5, count: 4800), rate: 48_000)
        feed.finish()
        var pieces: [Data] = []
        for await piece in feed.pieces { pieces.append(piece) }
        XCTAssertEqual(pieces.map(\.count), [3200, 3200], "a tenth of a second each, two bytes a sample")
        XCTAssertEqual(Array(pieces[0].prefix(2)), [0x00, 0x40])
        XCTAssertEqual(Array(pieces[1].suffix(2)), [0x00, 0xC0])
    }
}

/// A whole dictation against the board in memory, which "hears" one sentence.
@MainActor
final class LiveDictationTests: XCTestCase {
    private func until(_ what: String, _ done: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        for _ in 0..<400 {
            if done() { return }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTFail("never happened: \(what)", file: file, line: line)
    }

    private final class Field { var text = "" }

    func testWordsAppearWhileSpeakingAndTheFinalTextStands() async throws {
        let stub = StubBoardClient(state: try Fixture.multi())
        let dictation = LiveDictation()
        let field = Field()
        field.text = "Deploy:"
        XCTAssertEqual(dictation.label, "Dictate")
        let feed = try XCTUnwrap(dictation.start(client: stub, read: { field.text }, write: { field.text = $0 }))
        XCTAssertTrue(dictation.isActive)
        XCTAssertNil(dictation.start(client: stub, read: { field.text }, write: { field.text = $0 }), "one dictation at a time")
        try await until("the hub listens") { dictation.phase == .listening }
        XCTAssertEqual(dictation.label, "Stop dictating")

        let silence = [Float](repeating: 0, count: 1600)
        feed.feed(silence, rate: 16_000)
        feed.feed(silence, rate: 16_000)
        try await until("the first words") { field.text == "Deploy: This is" }
        feed.feed(silence, rate: 16_000)
        try await until("more words") { field.text == "Deploy: This is a" }

        dictation.stop()
        XCTAssertEqual(dictation.phase, .finishing)
        try await until("the end") { dictation.phase == .idle }
        XCTAssertEqual(field.text, "Deploy: This is a dictated sentence.", "the final reading replaces what was streamed")
        XCTAssertNil(dictation.failure)
        dictation.stop()
        XCTAssertEqual(dictation.phase, .idle, "stopping twice does nothing")
    }

    func testARefusalIsSaidAndNothingIsLeftRunning() async throws {
        let stub = StubBoardClient(state: try Fixture.multi())
        stub.failNext("dictation")
        let dictation = LiveDictation()
        let field = Field()
        _ = dictation.start(client: stub, read: { field.text }, write: { field.text = $0 })
        try await until("the refusal") { dictation.failure != nil }
        XCTAssertEqual(dictation.failure, "Not recognised: Speech is not set up (TINFOIL_API_KEY or data/tinfoil.key is missing)")
        try await until("idle") { dictation.phase == .idle }
        XCTAssertEqual(field.text, "")

        // The next start clears the sentence; leaving the screen ends it at once.
        let feed = try XCTUnwrap(dictation.start(client: stub, read: { field.text }, write: { field.text = $0 }))
        XCTAssertNil(dictation.failure)
        feed.feed([Float](repeating: 0, count: 160), rate: 16_000)
        dictation.cancel()
        XCTAssertEqual(dictation.phase, .idle)
        // The stream was let go, so the board has ended the dictation too.
        var ended: String?
        for _ in 0..<200 where ended == nil {
            do {
                try await stub.sendDictationAudio(id: "stub-1", pcm: Data([0, 0]))
                try await Task.sleep(nanoseconds: 5_000_000)
            } catch {
                ended = readable(error)
            }
        }
        XCTAssertEqual(ended, "This dictation has ended")
    }

    func testStoppingBeforeAnythingWasSaidLeavesTheFieldAlone() async throws {
        let stub = StubBoardClient(state: try Fixture.multi())
        let dictation = LiveDictation()
        let field = Field()
        field.text = "As it was"
        _ = dictation.start(client: stub, read: { field.text }, write: { field.text = $0 })
        dictation.stop()
        try await until("the end") { dictation.phase == .idle }
        XCTAssertEqual(field.text, "As it was")
        XCTAssertNil(dictation.failure)
    }
}
