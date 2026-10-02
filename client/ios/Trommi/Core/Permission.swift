import Foundation

/// The body of a card that asks for a tool approval: a sentence, then the tool
/// input, usually JSON. Follows parsePermission() in client/web/js/focus.js.
struct PermissionBody: Equatable {
    var description: String
    /// The input as sent, for the monospace box.
    var raw: String
    /// Key and value per line when the input is a JSON object, in the order of the text.
    var rows: [Row]

    struct Row: Equatable { var key: String; var value: String }

    static func parse(_ body: String) -> PermissionBody {
        let text = body.replacingOccurrences(of: "\r\n", with: "\n")
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        // The input starts at the first line that opens with { or [ and is at
        // the top or follows an empty line.
        var start: Int?
        for (i, line) in lines.enumerated() {
            let opens = line.drop(while: \.isWhitespace).first.map { $0 == "{" || $0 == "[" } ?? false
            let free = i == 0 || lines[..<i].allSatisfy { $0.allSatisfy(\.isWhitespace) } || lines[i - 1].allSatisfy(\.isWhitespace)
            if opens && free { start = i; break }
        }
        guard let start else {
            return PermissionBody(description: text.trimmingCharacters(in: .whitespacesAndNewlines), raw: "", rows: [])
        }
        let description = lines[..<start].joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        let raw = lines[start...].joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return PermissionBody(description: description, raw: raw, rows: rows(raw))
    }

    private static func rows(_ raw: String) -> [Row] {
        guard let value = try? JSONSerialization.jsonObject(with: Data(raw.utf8)), let object = value as? [String: Any] else { return [] }
        // JSONSerialization forgets the order of keys; restore it from where each key appears in the text.
        let keys = object.keys.sorted { a, b in
            let pa = raw.range(of: "\"\(a)\"")?.lowerBound ?? raw.endIndex
            let pb = raw.range(of: "\"\(b)\"")?.lowerBound ?? raw.endIndex
            return pa != pb ? pa < pb : a < b
        }
        return keys.map { key in
            if let text = object[key] as? String { return Row(key: key, value: text) }
            let value = object[key] ?? NSNull()
            let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys, .fragmentsAllowed])
            return Row(key: key, value: data.map { String(decoding: $0, as: UTF8.self) } ?? "")
        }
    }
}
