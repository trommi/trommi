// Shows what Markdown.parse found: paragraphs, bullet lists and code blocks.
import SwiftUI

struct MarkdownView: View {
    private let blocks: [MarkdownBlock]
    var font: Font = .body

    init(_ text: String, font: Font = .body) {
        blocks = Markdown.parse(text)
        self.font = font
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .paragraph(let inlines):
                    Text(attributed(inlines))
                        .font(font)
                        .fixedSize(horizontal: false, vertical: true)
                case .list(let items):
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text("•").font(font).foregroundStyle(Theme.muted).accessibilityHidden(true)
                                Text(attributed(item)).font(font).fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                case .code(let code):
                    CodeBlock(code: code)
                }
            }
        }
        .foregroundStyle(Theme.fg)
        .tint(Theme.accent)
        .textSelection(.enabled)
    }

    private func attributed(_ inlines: [Inline]) -> AttributedString {
        var out = AttributedString()
        for piece in inlines {
            switch piece {
            case .text(let text):
                out += AttributedString(text)
            case .bold(let text):
                var part = AttributedString(text)
                part.swiftUI.font = font.bold()
                out += part
            case .code(let text):
                var part = AttributedString(text)
                part.swiftUI.font = Font.system(.callout, design: .monospaced)
                part.swiftUI.backgroundColor = Theme.sunken
                out += part
            case .link(let text):
                var part = AttributedString(text)
                if let url = URL(string: text) { part.link = url }
                out += part
            }
        }
        return out
    }
}

/// Monospace text that scrolls sideways instead of wrapping.
struct CodeBlock: View {
    let code: String

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(code)
                .font(.system(.footnote, design: .monospaced))
                .foregroundStyle(Theme.fg)
                .textSelection(.enabled)
                .padding(12)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.sunken, in: RoundedRectangle(cornerRadius: Theme.radiusSmall, style: .continuous))
        .accessibilityLabel("Code: \(code)")
    }
}
