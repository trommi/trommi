// The light markdown agents write: paragraphs, bullet lists, **bold**, `code`,
// fenced code blocks and bare links. Parses to plain values; the view decides
// how they look. Follows rich() and inline() in public/js/ui.js.
import Foundation

enum Inline: Equatable, Sendable {
    case text(String)
    case bold(String)
    case code(String)
    case link(String)
}

enum MarkdownBlock: Equatable, Sendable {
    case paragraph([Inline])
    case list([[Inline]])
    case code(String)
}

enum Markdown {
    static func parse(_ source: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        for (i, chunk) in splitFences(source).enumerated() {
            if i % 2 == 1 {
                blocks.append(.code(chunk.hasSuffix("\n") ? String(chunk.dropLast()) : chunk))
                continue
            }
            for lines in paragraphs(chunk) {
                if lines.allSatisfy({ bulletText($0) != nil }) {
                    blocks.append(.list(lines.map { inline(bulletText($0) ?? $0) }))
                } else {
                    blocks.append(.paragraph(inline(lines.joined(separator: "\n"))))
                }
            }
        }
        return blocks
    }

    /// Text outside fences at even positions, code inside fences at odd ones.
    /// A fence line is ``` plus whatever follows on that line (a language name).
    static func splitFences(_ source: String) -> [String] {
        // "\r\n" is one Character in Swift and would hide the line break.
        var rest = Substring(source.replacingOccurrences(of: "\r\n", with: "\n"))
        var chunks: [String] = []
        while let fence = rest.range(of: "```") {
            chunks.append(String(rest[..<fence.lowerBound]))
            let tail = rest[fence.upperBound...]
            if let newline = tail.firstIndex(of: "\n") {
                rest = tail[tail.index(after: newline)...]
            } else {
                rest = tail[tail.endIndex...]
            }
        }
        chunks.append(String(rest))
        return chunks
    }

    /// Groups of non-blank lines, separated by empty lines.
    private static func paragraphs(_ chunk: String) -> [[String]] {
        var groups: [[String]] = []
        var current: [String] = []
        for line in chunk.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.isEmpty {
                if !current.isEmpty { groups.append(current); current = [] }
            } else if !line.allSatisfy(\.isWhitespace) {
                current.append(String(line))
            }
        }
        if !current.isEmpty { groups.append(current) }
        return groups
    }

    /// The text of a "- item" or "* item" line, nil if the line is no bullet.
    static func bulletText(_ line: String) -> String? {
        let trimmed = line.drop(while: \.isWhitespace)
        guard let mark = trimmed.first, mark == "-" || mark == "*" else { return nil }
        let afterMark = trimmed.dropFirst()
        guard let space = afterMark.first, space.isWhitespace else { return nil }
        return String(afterMark.drop(while: \.isWhitespace))
    }

    /// `code`, **bold** and bare http(s) links inside a run of text.
    static func inline(_ text: String) -> [Inline] {
        let chars = Array(text)
        var out: [Inline] = []
        var plain = ""
        var i = 0

        func flush() {
            if !plain.isEmpty { out.append(.text(plain)); plain = "" }
        }
        func starts(_ prefix: String, at index: Int) -> Bool {
            let p = Array(prefix)
            return index + p.count <= chars.count && Array(chars[index..<(index + p.count)]) == p
        }

        while i < chars.count {
            // `code`: at least one character, no backtick or line break inside.
            if chars[i] == "`" {
                var j = i + 1
                while j < chars.count, chars[j] != "`", chars[j] != "\n" { j += 1 }
                if j < chars.count, chars[j] == "`", j > i + 1 {
                    flush()
                    out.append(.code(String(chars[(i + 1)..<j])))
                    i = j + 1
                    continue
                }
            }
            // **bold**: at least one character, no asterisk or line break inside.
            if starts("**", at: i) {
                var j = i + 2
                while j < chars.count, chars[j] != "*", chars[j] != "\n" { j += 1 }
                if j > i + 2, starts("**", at: j) {
                    flush()
                    out.append(.bold(String(chars[(i + 2)..<j])))
                    i = j + 2
                    continue
                }
            }
            // A bare link runs until whitespace or one of < > ).
            if chars[i] == "h", starts("http://", at: i) || starts("https://", at: i) {
                let schemeEnd = i + (starts("https://", at: i) ? 8 : 7)
                var j = schemeEnd
                while j < chars.count, !chars[j].isWhitespace, chars[j] != "<", chars[j] != ">", chars[j] != ")" { j += 1 }
                if j > schemeEnd {
                    flush()
                    out.append(.link(String(chars[i..<j])))
                    i = j
                    continue
                }
            }
            plain.append(chars[i])
            i += 1
        }
        flush()
        return out
    }
}
