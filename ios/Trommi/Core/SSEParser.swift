// Server-Sent Events, fed with bytes as they arrive from the network. Chunks
// may end anywhere, also in the middle of a UTF-8 character or a line.
import Foundation

struct SSEParser {
    private var buffer: [UInt8] = []
    private var data: [String] = []

    /// Feed the next chunk; returns the data of every event completed by it.
    mutating func feed(_ chunk: Data) -> [String] {
        buffer.append(contentsOf: chunk)
        var events: [String] = []
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
    private mutating func line(_ text: String) -> String? {
        if text.isEmpty {
            guard !data.isEmpty else { return nil }
            defer { data = [] }
            return data.joined(separator: "\n")
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
