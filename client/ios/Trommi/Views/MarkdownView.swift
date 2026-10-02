// Shows what Markdown.parse found: paragraphs, bullet lists and code blocks.
// Links open in the in-app browser.
import SwiftUI

struct MarkdownView: View {
    @Environment(AppModel.self) private var model
    private let blocks: [MarkdownBlock]
    private let font: Font

    init(_ text: String, font: Font = .body) {
        blocks = Markdown.parse(text)
        self.font = font
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                view(of: block)
            }
        }
        .foregroundStyle(Theme.fg)
        .tint(Theme.accent)
        .environment(\.openURL, OpenURLAction { url in
            model.open(link: url.absoluteString)
            return .handled
        })
    }

    @ViewBuilder
    private func view(of block: MarkdownBlock) -> some View {
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

    private func attributed(_ inlines: [Inline]) -> AttributedString {
        var out = AttributedString()
        for piece in inlines {
            switch piece {
            case .text(let text):
                out.append(AttributedString(text))
            case .bold(let text):
                var part = AttributedString(text)
                part.swiftUI.font = font.bold()
                out.append(part)
            case .code(let text):
                var part = AttributedString(text)
                part.swiftUI.font = Font.system(.callout, design: .monospaced)
                part.swiftUI.backgroundColor = Theme.sunken
                out.append(part)
            case .link(let text):
                var part = AttributedString(text)
                if let url = URL(string: text) { part.link = url }
                out.append(part)
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
