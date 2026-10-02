// The pieces of a conversation: the human's bubbles, the agent's prose with
// its collapsed details, open questions as rows, and one-line markers.
import SwiftUI

struct ConversationItemView: View {
    @Environment(AppModel.self) private var model
    let item: ConversationItem
    /// The session is starred.
    let vip: Bool
    /// The question in this item was put off with "Later".
    let off: Bool
    let openCard: (String) -> Void

    var body: some View {
        switch item {
        case .day(_, let label):
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(Theme.faint)
                .frame(maxWidth: .infinity)
                .padding(.top, 6)
        case .user(let message):
            VStack(alignment: .trailing, spacing: 4) {
                about(message)
                UserBubble(message: message)
            }
        case .agent(let message, let continued):
            VStack(alignment: .leading, spacing: 4) {
                about(message)
                AgentMessage(message: message, continued: continued)
            }
        case .question(_, let card):
            // The same row as in the inbox, answerable right where it was asked.
            QuestionRow(card: card, vip: vip, off: off, open: { openCard(card.id) })
        case .event(let message, let card):
            EventLine(message: message) {
                if let card { openCard(card.id) }
            }
        }
    }
}

extension ConversationItemView {
    /// Asked back about a question, or the agent's reply to that: say which one, and lead there on a tap.
    @ViewBuilder
    fileprivate func about(_ message: Message) -> some View {
        if let card = model.state.question(about: message) {
            Button {
                openCard(card.id)
            } label: {
                HStack(spacing: 5) {
                    Text("About").fontWeight(.semibold)
                    Text(card.title).lineLimit(1)
                }
                .font(.caption)
                .foregroundStyle(Theme.muted)
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity, alignment: message.from == .user ? .trailing : .leading)
            .accessibilityIdentifier("message-about")
        }
    }
}

private struct UserBubble: View {
    let message: Message

    var body: some View {
        VStack(alignment: .trailing, spacing: 3) {
            if !message.attachments.isEmpty {
                AttachmentList(attachments: message.attachments).frame(maxWidth: 260)
            }
            if !message.text.isEmpty {
                Text(message.text)
                    .font(.body)
                    .foregroundStyle(Theme.accentFg)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(Theme.accent, in: RoundedRectangle(cornerRadius: Theme.radiusLarge, style: .continuous))
                    .textSelection(.enabled)
            }
            Text(Wording.clock(message.ts)).font(.caption2).foregroundStyle(Theme.faint)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 48)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("You, \(Wording.clock(message.ts)): \(message.text)")
        .accessibilityIdentifier("message-user")
    }
}

private struct AgentMessage: View {
    @Environment(AppModel.self) private var model
    let message: Message
    /// The message before came from the agent too, moments ago: no header again.
    let continued: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !continued {
                HStack(spacing: 6) {
                    Image(systemName: "sparkle").foregroundStyle(Theme.accent).accessibilityHidden(true)
                    Text("Agent").fontWeight(.semibold).foregroundStyle(Theme.fg)
                    Text(Wording.clock(message.ts)).foregroundStyle(Theme.faint)
                }
                .font(.caption)
            }
            MarkdownView(message.text)
            if let asset = message.asset, !asset.gone {
                Button {
                    open(asset)
                } label: {
                    Label("Open \(asset.title)", systemImage: "arrow.up.right.square")
                }
                .buttonStyle(PlainOptionButtonStyle(compact: true))
                .accessibilityIdentifier("asset-\(asset.id)")
            }
            AttachmentList(attachments: message.attachments)
            if !message.details.isEmpty {
                // What the agent chose to show of its reasoning or evidence, closed until asked for.
                DisclosureGroup("Details") {
                    MarkdownView(message.details, font: .subheadline)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.top, 6)
                }
                .font(.subheadline.weight(.medium))
                .tint(Theme.muted)
                .accessibilityIdentifier("message-details")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("message-agent")
    }

    /// A published page lives on the board's own address, with its key behind the #.
    private func open(_ asset: AssetRef) {
        if let url = model.client?.media?.link.assetURL(asset) {
            model.open(link: url.absoluteString)
        } else {
            model.notice = "This link cannot be opened here."
        }
    }
}

/// "Answered  Postgres  14:05": something happened on the board. A tap opens the card.
private struct EventLine: View {
    let message: Message
    let open: () -> Void

    private var icon: String {
        switch message.kind {
        case "decided": return "checkmark"
        case "done": return "checkmark.circle"
        case "urgency": return "bolt"
        case "reopened": return "arrow.uturn.backward"
        default: return "questionmark.circle"
        }
    }

    var body: some View {
        Button(action: open) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: icon).accessibilityHidden(true)
                Text(Wording.eventLabel(message.kind)).fontWeight(.semibold)
                Text(message.text).foregroundStyle(Theme.fg).lineLimit(2).multilineTextAlignment(.leading)
                Spacer(minLength: 4)
                Text(Wording.clock(message.ts)).font(.caption2).foregroundStyle(Theme.faint)
            }
            .font(.footnote)
            .foregroundStyle(Theme.muted)
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(Theme.sunken, in: RoundedRectangle(cornerRadius: Theme.radiusSmall, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("event-\(message.kind)")
    }
}

/// Before the first message: what the conversation is for, and three ways to start it.
struct EmptyConversation: View {
    let pick: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(ConversationText.emptyTitle).font(.headline).foregroundStyle(Theme.fg)
            Text(ConversationText.emptyBody).font(.subheadline).foregroundStyle(Theme.muted)
            ForEach(ConversationText.starters, id: \.self) { text in
                Button(text) { pick(text) }
                    .buttonStyle(PlainOptionButtonStyle(compact: true))
            }
        }
        .padding(.vertical, 24)
        .accessibilityIdentifier("conversation-empty")
    }
}
