// One question, whole: who asks and how urgent it is, the title, the reason,
// the text, the attachments, and the answers within reach of the thumb. One
// tap answers. Two options are a pair of tiles as in the row (no left, yes
// right); more are a stack; where several may be right the options are
// switches and "Send" sends them. The option the agent recommends is circled.
// Instead of answering, the human can ask back; what was asked and what the
// agent replied stands under the card. Which tiles a card gets is decided in
// Core (Card.cardTiles, Card.answerMode).
import SwiftUI

struct CardPage: View {
    @Environment(AppModel.self) private var model
    let card: Card
    /// The human tapped an answer (before the server confirmed it).
    var onAnswer: () -> Void = {}

    @State private var note = ""
    /// The switched-on options of a card that takes several answers.
    @State private var picked: Set<String> = []

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                meta
                Text(card.title)
                    .font(.title2.weight(.bold))
                    .foregroundStyle(Theme.fg)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("focus-title")
                if !card.urgencyReason.isEmpty {
                    Text(card.urgencyReason)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Theme.urgency(card.urgency))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 7)
                        .background(Theme.urgencySoft(card.urgency), in: RoundedRectangle(cornerRadius: Theme.radiusSmall, style: .continuous))
                }
                if card.kind == .permission {
                    PermissionBox(card: card)
                } else if !card.body.isEmpty {
                    MarkdownView(card.body)
                }
                AttachmentList(attachments: card.attachments)
                if card.status != .open {
                    Verdict(card: card)
                }
                if card.kind == .decision {
                    AskBack(card: card)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .cardSurface()
            .padding(12)
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom) {
            if card.status == .open {
                answers
                    .padding(.horizontal, 12)
                    .padding(.top, 10)
                    .padding(.bottom, 8)
                    .background(.bar)
            }
        }
        .accessibilityIdentifier("focus-card-\(card.id)")
    }

    /// "API · Blocking · 4 min ago": who asks, how urgent, how old.
    private var meta: some View {
        HStack(spacing: 6) {
            if model.state.severalSessions, let agent = model.state.agent(card.agent) {
                DoodleView(doodle: Doodle.mark(agent.mark), size: 14).foregroundStyle(Theme.avatar(hue: agent.hue))
                Text(agent.displayName).fontWeight(.medium)
            }
            if !card.urgencyWord.isEmpty {
                Text(card.urgencyWord)
                    .fontWeight(.semibold)
                    .foregroundStyle(Theme.urgency(card.kind == .permission ? .critical : card.urgency))
            }
            Ago(ts: card.created).foregroundStyle(Theme.faint)
            Spacer(minLength: 0)
        }
        .font(.caption)
        .foregroundStyle(Theme.muted)
    }

    // MARK: answers

    private var answers: some View {
        VStack(alignment: .leading, spacing: 8) {
            if card.answerMode == .pair {
                HStack(spacing: 10) {
                    ForEach(card.cardTiles) { tile in
                        answerButton(tile)
                    }
                }
            } else {
                // Many options would cover the card; then they scroll in a box of their own.
                ScrollView {
                    VStack(spacing: 8) {
                        ForEach(card.cardTiles) { tile in
                            answerButton(tile)
                        }
                    }
                    .padding(6)
                }
                .frame(maxHeight: 280)
                .fixedSize(horizontal: false, vertical: true)
            }
            if card.answerMode == .several {
                Button {
                    answer(card.options.filter { picked.contains($0.key) })
                } label: {
                    VStack(spacing: 2) {
                        Text("Send").font(.body.weight(.semibold))
                        Text(Card.sendDetail(picked.count)).font(.footnote).opacity(0.8)
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(LeadButtonStyle())
                .disabled(picked.isEmpty || model.isPending(card.id))
                .opacity(picked.isEmpty ? 0.5 : 1)
                .accessibilityIdentifier("send-\(card.id)")
            }
            if card.kind == .decision {
                TextField("Add a note?", text: $note)
                    .textFieldStyle(.roundedBorder)
                    .submitLabel(.done)
                    .accessibilityLabel("Note for the agent, optional. It is sent with your answer.")
                    .accessibilityIdentifier("note-field")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(answersLabel)
    }

    private var answersLabel: String {
        if card.kind == .permission { return "Allow or deny" }
        return card.answerMode == .several ? "Your answers. Choose one or more, then send." : "Your answer. One tap answers."
    }

    private func answerButton(_ tile: AnswerTile) -> some View {
        let several = card.answerMode == .several
        let on = picked.contains(tile.id)
        return Button {
            if several {
                if on { picked.remove(tile.id) } else { picked.insert(tile.id) }
            } else {
                answer([tile.option])
            }
        } label: {
            AnswerLabel(tile: tile, pair: card.answerMode == .pair, seed: "\(card.id)/\(tile.id)", checked: several ? on : nil)
        }
        .buttonStyle(.plain)
        .disabled(model.isPending(card.id))
        .accessibilityLabel(tile.spoken)
        .accessibilityHint(tile.option.detail)
        .accessibilityValue(several ? (on ? "chosen" : "not chosen") : "")
        .accessibilityIdentifier("option-\(card.id)-\(tile.id)")
    }

    private func answer(_ options: [CardOption]) {
        guard !options.isEmpty else { return }
        let text = note
        onAnswer()
        Task {
            // A refusal brings the question back and shows as a notice at the top.
            await model.decide(card, options, note: text)
        }
    }
}

/// An answer on the whole card: the label, the consequence small beneath it.
private struct AnswerLabel: View {
    let tile: AnswerTile
    /// One of two side by side, with a sketched thumb; else one line of a stack.
    let pair: Bool
    let seed: String
    /// On a card that takes several answers: whether this option is switched on. nil elsewhere.
    let checked: Bool?

    private var filled: Bool { tile.isLead }

    var body: some View {
        content
            .foregroundStyle(filled ? Theme.accentFg : Theme.fg)
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, minHeight: pair ? 76 : 52, alignment: pair ? .center : .leading)
            .background(filled ? Theme.accent : Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).strokeBorder(filled ? Theme.accent : Theme.lineStrong, lineWidth: 1))
            .overlay {
                if tile.advised {
                    AdviceCircle(seed: seed).padding(-4)
                }
            }
            .contentShape(Rectangle())
    }

    @ViewBuilder
    private var content: some View {
        if pair {
            VStack(spacing: 4) {
                SketchIcon(kind: tile.sketch, size: tile.label == nil ? 34 : 26)
                words(.center)
            }
        } else if let checked {
            HStack(spacing: 10) {
                Image(systemName: checked ? "checkmark.square.fill" : "square")
                    .font(.title3)
                    .foregroundStyle(checked ? Theme.accent : Theme.muted)
                    .accessibilityHidden(true)
                words(.leading)
            }
        } else {
            words(.leading)
        }
    }

    private func words(_ alignment: HorizontalAlignment) -> some View {
        VStack(alignment: alignment, spacing: 2) {
            if let label = tile.label {
                Text(label).font(.body.weight(.semibold))
            }
            if !tile.option.detail.isEmpty {
                Text(tile.option.detail).font(.footnote).opacity(0.8)
            }
        }
        .multilineTextAlignment(alignment == .center ? .center : .leading)
    }
}

/// Asking back: instead of answering, a question to the agent about this card. It is
/// sent as a chat message that names the card; the card stays open, and what was asked
/// and what the agent replies stands here as a short thread.
private struct AskBack: View {
    @Environment(AppModel.self) private var model
    let card: Card

    @State private var text = ""
    @State private var sending = false
    @State private var error: String?

    private var canSend: Bool { !sending && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(model.state.thread(of: card.id)) { message in
                ThreadMessage(message: message, agentName: model.state.agent(card.agent)?.displayName ?? "Agent")
            }
            if model.state.threadAwaitsReply(card.id) {
                Text(ConversationText.askWaiting).font(.footnote).foregroundStyle(Theme.muted)
            }
            if card.status == .open {
                HStack(spacing: 8) {
                    TextField(ConversationText.askPlaceholder, text: $text)
                        .textFieldStyle(.roundedBorder)
                        .submitLabel(.send)
                        .onSubmit { send() }
                        .accessibilityIdentifier("ask-field")
                    Button(ConversationText.askBack) { send() }
                        .buttonStyle(.bordered)
                        .disabled(!canSend)
                        .accessibilityIdentifier("ask-send")
                }
                InlineError(text: error)
            }
        }
    }

    private func send() {
        let question = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty, !sending else { return }
        sending = true
        error = nil
        Task {
            do {
                try await model.send(question, to: card.agent, about: card.id)
                if text.trimmingCharacters(in: .whitespacesAndNewlines) == question { text = "" }
            } catch {
                self.error = "Not sent: \(readable(error))"
            }
            sending = false
        }
    }
}

/// One line of the thread under a card: who, when, what.
private struct ThreadMessage: View {
    let message: Message
    let agentName: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(message.from == .user ? "You" : agentName).fontWeight(.semibold).foregroundStyle(Theme.fg)
                Ago(ts: message.ts).foregroundStyle(Theme.faint)
            }
            .font(.caption)
            if message.from == .user {
                Text(message.text).font(.subheadline).foregroundStyle(Theme.fg).fixedSize(horizontal: false, vertical: true)
            } else {
                MarkdownView(message.text, font: .subheadline)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(message.from == .user ? Theme.accentSoft : Theme.sunken, in: RoundedRectangle(cornerRadius: Theme.radiusSmall, style: .continuous))
        .accessibilityIdentifier("thread-\(message.from.rawValue)")
    }
}

/// What became of a question that is no longer open.
struct Verdict: View {
    @Environment(AppModel.self) private var model
    let card: Card
    @State private var working = false

    private var headline: String {
        if card.kind == .permission {
            if card.choice == "allow" { return "Allowed" }
            if card.choice == "deny" { return "Denied" }
            return "No answer"
        }
        if card.choice == nil { return "No answer" }
        return card.status == .done ? "Done" : "Answered, the agent is working on it"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(headline, systemImage: card.choice == nil ? "minus.circle" : "checkmark.circle.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(card.choice == nil ? Theme.muted : Theme.status(.done))
            if card.kind == .decision, let label = card.choiceLabel {
                LabeledContent("Your answer", value: label).font(.subheadline)
            }
            if !card.note.isEmpty {
                LabeledContent("Your note", value: card.note).font(.subheadline)
            }
            if !card.summary.isEmpty {
                LabeledContent("Result", value: card.summary).font(.subheadline)
            }
            if card.kind == .decision, card.choice != nil, !model.isPending(card.id) {
                Button {
                    again()
                } label: {
                    Label("Answer again", systemImage: "arrow.uturn.backward")
                }
                .buttonStyle(PlainOptionButtonStyle(compact: true))
                .disabled(working)
                .accessibilityIdentifier("reopen-\(card.id)")
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface2, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
        .accessibilityIdentifier("verdict-\(card.id)")
    }

    private func again() {
        working = true
        Task {
            await model.reopen(card.id)
            working = false
        }
    }
}

/// A tool approval: what the agent wants to do, and the exact input in monospace.
private struct PermissionBox: View {
    let card: Card

    private var parsed: PermissionBody { PermissionBody.parse(card.body) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if !parsed.description.isEmpty {
                Text(parsed.description).font(.body).foregroundStyle(Theme.fg).fixedSize(horizontal: false, vertical: true)
            }
            if !parsed.raw.isEmpty {
                input
            }
        }
    }

    private var input: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "shield.lefthalf.filled").accessibilityHidden(true)
                Text(card.permissionTool).fontWeight(.semibold)
                Text("Input").foregroundStyle(Theme.faint)
            }
            .font(.caption)
            .foregroundStyle(Theme.muted)
            if parsed.rows.isEmpty {
                Text(parsed.raw).font(.system(.footnote, design: .monospaced)).foregroundStyle(Theme.fg)
            } else {
                ForEach(Array(parsed.rows.enumerated()), id: \.offset) { _, row in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.key).font(.caption2.weight(.semibold)).foregroundStyle(Theme.faint)
                        Text(row.value).font(.system(.footnote, design: .monospaced)).foregroundStyle(Theme.fg)
                    }
                }
            }
        }
        .textSelection(.enabled)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.sunken, in: RoundedRectangle(cornerRadius: Theme.radiusSmall, style: .continuous))
        .accessibilityIdentifier("permission-input")
    }
}
