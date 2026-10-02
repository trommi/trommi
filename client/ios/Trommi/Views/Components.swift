// Small pieces every screen uses: the card surface, relative time, button
// looks, the connection badge, the notice banner and the note with "Back".
import SwiftUI

extension View {
    /// White (or dark) sheet with a hairline border, as every row on the board.
    func cardSurface() -> some View {
        self
            .background(Theme.surface)
            .clipShape(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
    }
}

/// Relative time that keeps itself current: "5 min ago".
struct Ago: View {
    let ts: Double

    var body: some View {
        TimelineView(.periodic(from: Date(), by: 30)) { context in
            Text(Wording.ago(ts, now: context.date.timeIntervalSince1970 * 1000))
        }
    }
}

/// The filled button: the option the agent leads with, "Connect", "Save".
struct LeadButtonStyle: ButtonStyle {
    var compact = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(compact ? .subheadline.weight(.semibold) : .body.weight(.semibold))
            .foregroundStyle(Theme.accentFg)
            .padding(.horizontal, compact ? 14 : 16)
            .padding(.vertical, compact ? 8 : 14)
            .frame(minHeight: compact ? 36 : 52)
            .background(Theme.accent, in: RoundedRectangle(cornerRadius: compact ? Theme.radiusSmall : Theme.radius, style: .continuous))
            .opacity(configuration.isPressed ? 0.8 : 1)
    }
}

/// The outlined button of every other option.
struct PlainOptionButtonStyle: ButtonStyle {
    var compact = false
    var tint: Color = Theme.fg

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(compact ? .subheadline.weight(.semibold) : .body.weight(.semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, compact ? 14 : 16)
            .padding(.vertical, compact ? 8 : 14)
            .frame(minHeight: compact ? 36 : 52)
            .background(configuration.isPressed ? Theme.sunken : Theme.surface, in: RoundedRectangle(cornerRadius: compact ? Theme.radiusSmall : Theme.radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: compact ? Theme.radiusSmall : Theme.radius, style: .continuous).strokeBorder(Theme.lineStrong, lineWidth: 1))
    }
}

/// Dot and word for the state of the connection, in the navigation bar.
struct ConnectionBadge: View {
    @Environment(AppModel.self) private var model

    private var color: Color {
        switch model.connection {
        case .online: return Theme.status(.done)
        case .connecting: return Theme.status(.working)
        case .offline: return Theme.status(.decision)
        }
    }

    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 8, height: 8)
            Text(model.connection.text).font(.caption).foregroundStyle(Theme.muted)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Connection: \(model.connection.text)")
        .accessibilityIdentifier("connection-state")
    }
}

/// What just happened to a question, and the way back: "Answered: Postgres", "Moved to Later",
/// with "Back", for a few seconds (AppModel.back). The identifiers are the ones the UI tests
/// knew the undo bar by.
struct BackBar: View {
    @Environment(AppModel.self) private var model
    /// Called with the card id once it is back.
    var onBack: (String) -> Void = { _ in }
    @State private var working = false

    var body: some View {
        if let note = model.back {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(note.head).font(.subheadline.weight(.semibold)).lineLimit(1)
                    Text(note.title).font(.caption).lineLimit(1)
                }
                Spacer(minLength: 8)
                Button {
                    takeBack()
                } label: {
                    Label("Back", systemImage: "arrow.uturn.backward")
                        .font(.subheadline.weight(.semibold))
                }
                .disabled(working)
                .accessibilityIdentifier("undo-button")
                .accessibilityLabel("Back: take back \(note.head), \(note.title)")
            }
            .foregroundStyle(Theme.bg)
            .tint(Theme.bg)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Theme.fg, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .accessibilityIdentifier("undo-bar")
        }
    }

    private func takeBack() {
        working = true
        Task {
            // A failure shows as a notice at the top; then nothing came back.
            let cardID = await model.takeBack()
            working = false
            if let cardID { onBack(cardID) }
        }
    }
}

/// A sentence at the top when something was not saved; goes away by itself.
struct NoticeBanner: ViewModifier {
    @Environment(AppModel.self) private var model

    func body(content: Content) -> some View {
        content.overlay(alignment: .top) {
            if let text = model.notice {
                Label(text, systemImage: "exclamationmark.triangle.fill")
                    .font(.subheadline)
                    .foregroundStyle(Theme.urgency(.critical))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.urgencySoft(.critical), in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
                    .padding(.horizontal, 12)
                    .padding(.top, 4)
                    .onTapGesture { model.notice = nil }
                    .task(id: text) {
                        try? await Task.sleep(nanoseconds: 6_000_000_000)
                        if !Task.isCancelled, model.notice == text { model.notice = nil }
                    }
                    .accessibilityIdentifier("notice")
            }
        }
    }
}

extension View {
    func noticeBanner() -> some View { modifier(NoticeBanner()) }
}

/// A line of small text for something that went wrong right here.
struct InlineError: View {
    let text: String?

    var body: some View {
        if let text {
            Text(text)
                .font(.footnote)
                .foregroundStyle(Theme.urgency(.critical))
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// A heading between groups of rows: a mark, a name, and a count ("API  3 questions").
struct GroupHeading<Mark: View>: View {
    let title: String
    let count: String
    let mark: Mark

    init(title: String, count: String, @ViewBuilder mark: () -> Mark) {
        self.title = title
        self.count = count
        self.mark = mark()
    }

    var body: some View {
        HStack(spacing: 8) {
            mark
            Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.fg)
            Text(count).font(.caption).foregroundStyle(Theme.muted)
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}
