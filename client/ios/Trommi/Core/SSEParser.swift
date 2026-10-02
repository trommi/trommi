// Server-Sent Events, fed with bytes as they arrive from the network. Chunks
// may end anywhere, also in the middle of a UTF-8 character or a line.
import Foundation

/// One event of a stream: its name ("message" when the stream gives none) and its data.
struct SSEEvent: Equatable, Sendable {
    var name: String
    var data: String
}

struct SSEParser {
    private var buffer: [UInt8] = []
    private var data: [String] = []
    private var name = ""

    /// Feed the next chunk; returns the data of every event completed by it.
    mutating func feed(_ chunk: Data) -> [String] {
        feedEvents(chunk).map(\.data)
    }

    /// Feed the next chunk; returns every event completed by it, with its name.
    mutating func feedEvents(_ chunk: Data) -> [SSEEvent] {
        buffer.append(contentsOf: chunk)
        var events: [SSEEvent] = []
        var start = 0
        while let newline = buffer[start...].firstIndex(of: 10) {
            var end = newline
            if end > start, buffer[end - 1] == 13 { end -= 1 }
            if let event = line(String(decoding: buffer[start..<end], as: UTF8.self)) { events.append(event) }
            start = newline + 1
        }
        buffer.removeFirst(start)
        return events
    }

    /// One line of the stream. An empty line ends the event.
    private mutating func line(_ text: String) -> SSEEvent? {
        if text.isEmpty {
            defer { data = []; name = "" }
            guard !data.isEmpty else { return nil }
            return SSEEvent(name: name.isEmpty ? "message" : name, data: data.joined(separator: "\n"))
        }
        if text.hasPrefix(":") { return nil }   // a comment, used as a heartbeat
        let field: Substring
        var value: Substring
        if let colon = text.firstIndex(of: ":") {
            field = text[..<colon]
            value = text[text.index(after: colon)...]
            if value.hasPrefix(" ") { value = value.dropFirst() }
        } else {
            field = Substring(text)
            value = ""
        }
        if field == "data" { data.append(String(value)) }
        if field == "event" { name = String(value) }
        return nil
    }
}

/// How long to wait before the n-th reconnect: 1, 2, 4, 8, 15, 15, ... seconds.
enum Backoff {
    static func delay(attempt: Int) -> Double {
        guard attempt > 0 else { return 0 }
        return min(15, pow(2, Double(min(attempt, 10) - 1)))
    }
}
