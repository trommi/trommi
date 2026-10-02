// Small pieces every screen uses: the corner tab of a card, the card surface,
// avatars, lights, button looks, the notice banner and the undo bar.
import SwiftUI

/// The strip flush with the top left corner of a card: "Nr. 5 | Blockiert".
struct CardTab: View {
    let card: Card

    var body: some View {
        HStack(spacing: 8) {
            Text("Nr. \(card.number)")
            Rectangle().fill(Theme.surface.opacity(0.45)).frame(width: 1, height: 11)
            Text(card.tabLabel)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(Theme.surface)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Theme.urgency(card.urgency))
        .clipShape(UnevenRoundedRectangle(topLeadingRadius: Theme.radius, bottomLeadingRadius: 0, bottomTrailingRadius: 10, topTrailingRadius: 0))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Nr. \(card.number), \(card.tabLabel)")
    }
}

extension View {
    /// White (or dark) sheet with a hairline border, as every card on the board.
    func cardSurface() -> some View {
        background(Theme.surface)
            .clipShape(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
    }
}

struct Avatar: View {
    let agent: Agent
    var size: CGFloat = 36

    var body: some View {
        Text(agent.initial)
            .font(.system(size: size * 0.45, weight: .semibold, design: .rounded))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(Theme.avatar(hue: agent.hue), in: Circle())
            .overlay(alignment: .bottomTrailing) {
                Circle()
                    .fill(agent.online ? Theme.status(.done) : Theme.faint)
                    .frame(width: size * 0.28, height: size * 0.28)
                    .overlay(Circle().strokeBorder(Theme.surface, lineWidth: 2))
            }
            .accessibilityHidden(true)
    }
}

/// Relative time that keeps itself current: "vor 5 Min."
struct Ago: View {
    let ts: Double

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            Text(Wording.ago(ts, now: context.date.timeIntervalSince1970 * 1000))
        }
    }
}

enum Clock {
    private static let formatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "de_DE")
        f.dateFormat = "HH:mm"
        return f
    }()

    static func time(_ ts: Double) -> String { formatter.string(from: Date(timeIntervalSince1970: ts / 1000)) }
}

/// The filled button of the option the agent leads with, and of "Erlauben".
struct LeadButtonStyle: ButtonStyle {
    var compact = false
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(compact ? .subheadline.weight(.semibold) : .body.weight(.semibold))
            .foregroundStyle(Theme.accentFg)
            .padding(.horizontal, compact ? 14 : 16)
            .padding(.vertical, compact ? 8 : 14)
            .frame(minHeight: compact ? 36 : 52)
            .background(Theme.accent, in: RoundedRectangle(cornerRadius: compact ? Theme.radiusSmall : Theme.radius, style: .continuous))
            .opacity(enabled ? (configuration.isPressed ? 0.8 : 1) : 0.45)
    }
}

/// The outlined button of every other option; `tint` is red for "Ablehnen".
struct PlainOptionButtonStyle: ButtonStyle {
    var compact = false
    var tint: Color = Theme.fg
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(compact ? .subheadline.weight(.semibold) : .body.weight(.semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, compact ? 14 : 16)
            .padding(.vertical, compact ? 8 : 14)
            .frame(minHeight: compact ? 36 : 52)
            .background(configuration.isPressed ? Theme.sunken : Theme.surface, in: RoundedRectangle(cornerRadius: compact ? Theme.radiusSmall : Theme.radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: compact ? Theme.radiusSmall : Theme.radius, style: .continuous).strokeBorder(Theme.lineStrong, lineWidth: 1))
            .opacity(enabled ? 1 : 0.45)
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
        .accessibilityLabel("Verbindung: \(model.connection.text)")
        .accessibilityIdentifier("connection-state")
    }
}

/// "Nr. 5 entschieden: Postgres – Rückgängig", for ten seconds after an answer.
struct UndoBar: View {
    @Environment(AppModel.self) private var model
    /// Called with the card id once the answer was taken back.
    var onUndone: (String) -> Void = { _ in }
    @State private var working = false

    var body: some View {
        if let offer = model.undo {
            HStack(spacing: 12) {
                (Text("Nr. \(offer.number) entschieden: ") + Text(offer.label).bold())
                    .font(.subheadline)
                    .lineLimit(2)
                Spacer(minLength: 8)
                Button {
                    working = true
                    Task {
                        let failed = await model.reopen(offer.cardID)
                        working = false
                        if failed == nil { onUndone(offer.cardID) }
                    }
                } label: {
                    Label("Rückgängig", systemImage: "arrow.uturn.backward")
                        .font(.subheadline.weight(.semibold))
                }
                .disabled(working)
                .accessibilityIdentifier("undo-button")
                .accessibilityLabel("Entscheidung zu Nr. \(offer.number) rückgängig machen")
            }
            .foregroundStyle(Theme.bg)
            .tint(Theme.bg)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Theme.fg, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .accessibilityIdentifier("undo-bar")
        }
    }
}

/// A sentence at the top when something was not taken over; goes away by itself.
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
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .accessibilityIdentifier("notice")
                    .accessibilityAddTraits(.isStaticText)
            }
        }
        .animation(.easeOut(duration: 0.25), value: model.notice)
    }
}

extension View {
    func noticeBanner() -> some View { modifier(NoticeBanner()) }
}

/// A line of small text for something that went wrong in this very row.
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
