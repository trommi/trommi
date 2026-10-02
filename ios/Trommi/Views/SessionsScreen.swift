// Sitzungen: the agents with their state, and behind each one its conversation.
import SwiftUI

struct SessionsScreen: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationStack {
            Group {
                if !model.loaded {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    List(model.state.agents) { agent in
                        NavigationLink(value: agent.id) {
                            AgentRow(agent: agent, summary: model.state.summary(of: agent))
                        }
                        .listRowBackground(Theme.surface)
                        .accessibilityIdentifier("session-\(agent.id)")
                    }
                    .listStyle(.insetGrouped)
                    .scrollContentBackground(.hidden)
                }
            }
            .background(Theme.bg)
            .navigationTitle("Sitzungen")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { ConnectionBadge() }
            }
            .navigationDestination(for: String.self) { ChatScreen(agentID: $0) }
        }
    }
}

private struct AgentRow: View {
    let agent: Agent
    let summary: AgentSummary

    private var spoken: String {
        var parts = [agent.name, summary.subtitle]
        if summary.open > 0 { parts.append(Wording.openDecisions(summary.open)) }
        parts += summary.tasks.map { "\($0.label): \($0.state.word)" }
        return parts.joined(separator: ", ")
    }

    var body: some View {
        HStack(spacing: 12) {
            Avatar(agent: agent, size: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(agent.name).font(.body.weight(.semibold)).foregroundStyle(Theme.fg)
                Text(summary.subtitle).font(.subheadline).foregroundStyle(Theme.muted)
            }
            Spacer(minLength: 8)
            // One light per work stream, as the agent reports them.
            HStack(spacing: 4) {
                ForEach(summary.tasks.prefix(6)) { task in
                    Circle().fill(Theme.status(task.state)).frame(width: 9, height: 9)
                }
            }
            if summary.open > 0 {
                Text("\(summary.open)")
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(Theme.surface)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Theme.status(.decision), in: Capsule())
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spoken)
    }
}

struct ChatScreen: View {
    @Environment(AppModel.self) private var model
    let agentID: String
    @State private var focus: FocusRequest?
    @State private var draft = ""

    private var messages: [Message] { model.state.conversation(of: agentID) }
    private var tasks: [TaskLine] { model.state.tasks.filter { $0.agent == agentID } }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if !tasks.isEmpty { StatusStrip(tasks: tasks) { card in focus = FocusRequest(start: card) } }
                    if messages.isEmpty {
                        EmptyChat { draft = $0 }
                    }
                    ForEach(messages) { message in
                        MessageRow(message: message, card: model.state.card(message.cardID)) { card in
                            focus = FocusRequest(start: card)
                        }
                        .id(message.id)
                    }
                    Color.clear.frame(height: 1).id("ende")
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: messages.count) { _, _ in
                withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo("ende", anchor: .bottom) }
            }
        }
        .background(Theme.bg)
        .safeAreaInset(edge: .bottom) { Composer(agentID: agentID, draft: $draft) }
        .navigationTitle(model.state.agent(agentID)?.name ?? "Sitzung")
        .navigationBarTitleDisplayMode(.inline)
        .fullScreenCover(item: $focus) { FocusView(start: $0.start) }
    }
}

/// The traffic lights of one agent: one chip per work stream.
private struct StatusStrip: View {
    let tasks: [TaskLine]
    let openCard: (String) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(tasks) { task in
                    Button {
                        if let card = task.cardID { openCard(card) }
                    } label: {
                        HStack(spacing: 6) {
                            Circle().fill(Theme.status(task.state)).frame(width: 8, height: 8)
                            Text(task.label).font(.caption.weight(.semibold)).foregroundStyle(Theme.fg)
                            if !task.detail.isEmpty {
                                Text(task.detail).font(.caption).foregroundStyle(Theme.muted).lineLimit(1)
                            }
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(Theme.statusSoft(task.state), in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(task.label), \(task.state.word)\(task.detail.isEmpty ? "" : ": \(task.detail)")")
                }
            }
        }
    }
}

private struct EmptyChat: View {
    let pick: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Noch keine Nachrichten.").font(.subheadline).foregroundStyle(Theme.muted)
            ForEach(["Wo stehen wir gerade?", "Was brauchst du von mir?", "Fass zusammen, was du zuletzt getan hast."], id: \.self) { text in
                Button(text) { pick(text) }.buttonStyle(PlainOptionButtonStyle(compact: true))
            }
        }
        .padding(.vertical, 24)
    }
}

private struct MessageRow: View {
    let message: Message
    let card: Card?
    let openCard: (String) -> Void

    var body: some View {
        switch message.from {
        case .user: userBubble
        case .agent: agentProse
        case .event:
            // A question stays answerable where it was asked, as long as its card is open.
            if message.kind == "asked", let card, card.status == .open, card.kind == .decision {
                AskCard(card: card) { openCard(card.id) }
            } else {
                eventLine
            }
        }
    }

    private var userBubble: some View {
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
            Text(Clock.time(message.ts)).font(.caption2).foregroundStyle(Theme.faint)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 48)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Du, \(Clock.time(message.ts)): \(message.text)")
        .accessibilityIdentifier("message-user")
    }

    private var agentProse: some View {
        VStack(alignment: .leading, spacing: 8) {
            MarkdownView(message.text)
            AttachmentList(attachments: message.attachments)
            if !message.details.isEmpty {
                DisclosureGroup("Details") {
                    MarkdownView(message.details, font: .subheadline)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.top, 6)
                }
                .font(.subheadline.weight(.medium))
                .tint(Theme.muted)
                .accessibilityIdentifier("message-details")
            }
            Text(Clock.time(message.ts)).font(.caption2).foregroundStyle(Theme.faint)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("message-agent")
    }

    private var icon: String {
        switch message.kind {
        case "decided": return "checkmark"
        case "done": return "checkmark.circle"
        case "urgency": return "bolt"
        case "reopened": return "arrow.uturn.backward"
        default: return "questionmark.circle"
        }
    }

    private var eventLine: some View {
        Button {
            if let id = message.cardID, card != nil { openCard(id) }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: icon).accessibilityHidden(true)
                Text(Wording.eventLabel(message.kind)).fontWeight(.semibold)
                if let card { Text("Nr. \(card.number)") }
                Text(message.text).foregroundStyle(Theme.fg).lineLimit(2).multilineTextAlignment(.leading)
                Spacer(minLength: 4)
                Text(Clock.time(message.ts)).font(.caption2).foregroundStyle(Theme.faint)
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

/// An open question inside the conversation: answerable with one tap, as on the stack.
private struct AskCard: View {
    @Environment(AppModel.self) private var model
    let card: Card
    let open: () -> Void
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top) {
                CardTab(card: card)
                Spacer()
                Button("Ganze Karte", action: open)
                    .font(.caption.weight(.semibold))
                    .padding(.top, 6)
                    .padding(.trailing, 12)
                    .accessibilityIdentifier("ask-open-\(card.id)")
            }
            VStack(alignment: .leading, spacing: 10) {
                Text(card.title).font(.headline).foregroundStyle(Theme.fg).fixedSize(horizontal: false, vertical: true)
                if !card.urgencyReason.isEmpty {
                    Text(card.urgencyReason).font(.subheadline).foregroundStyle(Theme.urgency(card.urgency))
                }
                VStack(spacing: 6) {
                    ForEach(card.options) { option in
                        Button {
                            error = nil
                            Task { @MainActor in error = await model.decide(card, option) }
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(option.label).multilineTextAlignment(.leading)
                                if !option.detail.isEmpty {
                                    Text(option.detail).font(.caption.weight(.regular)).foregroundStyle(Theme.muted).multilineTextAlignment(.leading)
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .buttonStyle(PlainOptionButtonStyle(compact: true))
                        .disabled(model.isPending(card.id))
                        .accessibilityIdentifier("ask-\(card.id)-\(option.key)")
                    }
                }
                InlineError(text: error)
            }
            .padding(14)
        }
        .cardSurface()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("ask-card-\(card.id)")
    }
}

/// The text field with send, and the microphone when the server can transcribe.
private struct Composer: View {
    @Environment(AppModel.self) private var model
    let agentID: String
    @Binding var draft: String
    @State private var sending = false
    @State private var error: String?
    @State private var dictation = Dictation()

    private var canSend: Bool { !sending && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            InlineError(text: error ?? dictation.failure)
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Nachricht an den Agenten", text: $draft, axis: .vertical)
                    .lineLimit(1...6)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radiusLarge, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: Theme.radiusLarge, style: .continuous).strokeBorder(Theme.lineStrong, lineWidth: 1))
                    .accessibilityIdentifier("composer-field")
                if model.state.speech {
                    Button {
                        dictation.toggle(transcribe: { try await model.transcribe($0) }) { text in
                            // The transcript joins what is already typed.
                            let glue = draft.isEmpty || draft.last?.isWhitespace == true ? "" : " "
                            draft += glue + text
                        }
                    } label: {
                        switch dictation.phase {
                        case .idle: Image(systemName: "mic")
                        case .recording: Image(systemName: "stop.circle.fill").foregroundStyle(Theme.status(.decision))
                        case .working: ProgressView()
                        }
                    }
                    .font(.title2)
                    .frame(width: 40, height: 40)
                    .accessibilityLabel(dictation.label)
                    .accessibilityIdentifier("composer-mic")
                }
                Button(action: send) {
                    Image(systemName: "arrow.up.circle.fill").font(.system(size: 32))
                }
                .disabled(!canSend)
                .frame(width: 40, height: 40)
                .accessibilityLabel("Senden")
                .accessibilityIdentifier("composer-send")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
        .onDisappear { dictation.cancel() }
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        sending = true
        error = nil
        Task { @MainActor in
            do {
                try await model.send(text, to: agentID)
                draft = ""
            } catch {
                Haptics.failed()
                self.error = "Nicht gesendet: \(readable(error)). Dein Text bleibt hier stehen."
            }
            sending = false
        }
    }
}
