// The focus flow: one card as a whole page. A tap on an option decides and
// the next open card slides in; swiping moves between cards without deciding.
// Answered cards stay as pages until the flow is closed, so one can look back
// and take an answer back.
import SwiftUI

struct FocusView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let start: String?

    /// The pages: the stack as it was when the flow opened, plus cards that arrived since.
    @State private var order: [String] = []
    @State private var current = FocusView.donePage
    @State private var ready = false

    private static let donePage = "#fertig"

    private var position: String {
        guard let at = order.firstIndex(of: current) else { return "Fertig" }
        return "\(at + 1) von \(order.count)"
    }

    private var currentCard: Card? { model.state.card(current) }

    var body: some View {
        NavigationStack {
            TabView(selection: $current) {
                ForEach(order, id: \.self) { id in
                    page(id).tag(id)
                }
                DonePage(open: model.state.queue.count, close: { dismiss() }).tag(FocusView.donePage)
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .background(Theme.bg)
            .safeAreaInset(edge: .top) {
                UndoBar(onUndone: { id in
                    if !order.contains(id) { order.append(id) }
                    withAnimation { current = id }
                })
            }
            .animation(.easeOut(duration: 0.25), value: model.undo)
            .navigationTitle(position)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Schließen") { dismiss() }
                        .accessibilityLabel("Fokus-Modus schließen")
                        .accessibilityIdentifier("focus-close")
                }
                ToolbarItem(placement: .primaryAction) {
                    if model.state.speech, let card = currentCard { SpeakerButton(cardID: card.id) }
                }
            }
            .noticeBanner()
        }
        .onAppear(perform: setUp)
        .onChange(of: model.state.queue) { _, queue in
            // Cards that arrive while the flow is open join at the end.
            for id in queue where !order.contains(id) { order.append(id) }
        }
        .onChange(of: current) { _, _ in model.speaker.stop() }
        .onDisappear { model.speaker.stop() }
    }

    @ViewBuilder
    private func page(_ id: String) -> some View {
        if let card = model.state.card(id) {
            CardPage(card: card, onDecided: { advance(from: id) }, onFailed: { withAnimation { current = id } })
        } else {
            VStack(spacing: 8) {
                Image(systemName: "tray").font(.largeTitle).foregroundStyle(Theme.faint)
                Text("Diese Karte gibt es nicht mehr.").foregroundStyle(Theme.muted)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func setUp() {
        guard !ready else { return }
        ready = true
        var pages = model.state.queue
        if let start, !pages.contains(start), model.state.card(start) != nil { pages.insert(start, at: 0) }
        order = pages
        current = start.flatMap { pages.contains($0) ? $0 : nil } ?? pages.first ?? FocusView.donePage
    }

    /// The card was answered: show the next one that is still open, or the last page.
    private func advance(from id: String) {
        guard current == id else { return }
        let next = FocusOrder.next(after: id, before: order, after: model.state.queue.filter { $0 != id })
        withAnimation(.easeInOut(duration: 0.35)) { current = next ?? FocusView.donePage }
    }
}

private struct DonePage: View {
    let open: Int
    let close: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: open == 0 ? "checkmark.circle" : "rectangle.stack")
                .font(.system(size: 52))
                .foregroundStyle(open == 0 ? Theme.status(.done) : Theme.muted)
                .accessibilityHidden(true)
            Text(open == 0 ? "Alles entschieden" : (open == 1 ? "1 offene Entscheidung wartet." : "\(open) offene Entscheidungen warten."))
                .font(.title3.weight(.semibold))
                .foregroundStyle(Theme.fg)
            if open == 0 {
                Text("Neue Karten erscheinen hier, sobald ein Agent etwas wissen will.")
                    .font(.subheadline)
                    .foregroundStyle(Theme.muted)
                    .multilineTextAlignment(.center)
            }
            Button("Zum Posteingang", action: close)
                .buttonStyle(LeadButtonStyle(compact: true))
                .padding(.top, 6)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("focus-done")
    }
}

/// Reads the card aloud; shows a spinner while the MP3 is made.
struct SpeakerButton: View {
    @Environment(AppModel.self) private var model
    let cardID: String

    var body: some View {
        Button {
            model.speaker.toggle(cardID)
        } label: {
            switch model.speaker.phase {
            case .loading(cardID): ProgressView()
            case .playing(cardID): Image(systemName: "speaker.wave.2.fill")
            default: Image(systemName: "speaker.wave.2")
            }
        }
        .accessibilityLabel(model.speaker.isBusy(with: cardID) ? "Vorlesen beenden" : "Karte vorlesen")
        .onChange(of: model.speaker.failure) { _, failure in
            if let failure {
                model.notice = failure
                model.speaker.failure = nil
            }
        }
    }
}

/// One card, whole: tab, title, reason, text, attachments, and the options within reach of the thumb.
struct CardPage: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var typeSize
    let card: Card
    var onDecided: () -> Void = {}
    var onFailed: () -> Void = {}

    @State private var note = ""
    @State private var showNote = false
    @State private var error: String?
    @FocusState private var noteFocused: Bool

    /// Many options or very large type would cover the card; then the options scroll with it.
    private var optionsInline: Bool { card.options.count > 4 || typeSize.isAccessibilitySize }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top) {
                    CardTab(card: card)
                    Spacer()
                    HStack(spacing: 4) {
                        Text(card.kind == .permission ? "Freigabe" : "Entscheidung")
                        Text("·").accessibilityHidden(true)
                        Ago(ts: card.created)
                    }
                    .font(.caption)
                    .foregroundStyle(Theme.faint)
                    .padding(.top, 7)
                    .padding(.trailing, 12)
                }
                VStack(alignment: .leading, spacing: 14) {
                    if model.severalAgents, let agent = model.state.agent(card.agent) {
                        HStack(spacing: 6) {
                            Avatar(agent: agent, size: 20)
                            Text(agent.name).font(.footnote.weight(.medium)).foregroundStyle(Theme.muted)
                        }
                    }
                    Text(card.title)
                        .font(.title2.weight(.bold))
                        .foregroundStyle(Theme.fg)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                        .accessibilityIdentifier("focus-title")
                    if !card.urgencyReason.isEmpty {
                        Label(card.urgencyReason, systemImage: "bolt.fill")
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
                    if card.status != .open { Verdict(card: card) }
                    if card.status == .open, optionsInline { answerArea }
                }
                .padding(16)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .cardSurface()
            .padding(12)
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom) {
            if card.status == .open, !optionsInline {
                answerArea
                    .padding(.horizontal, 12)
                    .padding(.top, 10)
                    .padding(.bottom, 8)
                    .background(.bar)
            }
        }
        .accessibilityIdentifier("focus-card-\(card.id)")
    }

    private var answerArea: some View {
        VStack(alignment: .leading, spacing: 8) {
            InlineError(text: error)
            if card.kind == .decision {
                if showNote {
                    TextField("Anmerkung für den Agenten, optional", text: $note, axis: .vertical)
                        .lineLimit(1...4)
                        .focused($noteFocused)
                        .padding(10)
                        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radiusSmall, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: Theme.radiusSmall, style: .continuous).strokeBorder(Theme.lineStrong, lineWidth: 1))
                        .accessibilityHint("Wird mit dem nächsten Tipp gesendet.")
                        .accessibilityIdentifier("note-field")
                } else {
                    Button {
                        showNote = true
                        noteFocused = true
                    } label: {
                        Label("Anmerkung dazu?", systemImage: "square.and.pencil").font(.footnote)
                    }
                    .foregroundStyle(Theme.muted)
                    .accessibilityIdentifier("note-toggle")
                }
            }
            options
        }
    }

    @ViewBuilder
    private var options: some View {
        if card.kind == .permission {
            HStack(spacing: 10) {
                ForEach(card.orderedOptions) { option in
                    let button = Button { answer(option) } label: {
                        Text(option.label).frame(maxWidth: .infinity)
                    }
                    .disabled(model.isPending(card.id))
                    .accessibilityIdentifier("option-\(card.id)-\(option.key)")
                    if option.key == card.leadKey {
                        button.buttonStyle(LeadButtonStyle())
                    } else {
                        button.buttonStyle(PlainOptionButtonStyle(tint: Theme.deny))
                    }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Freigabe erteilen oder ablehnen")
        } else {
            VStack(spacing: 8) {
                ForEach(card.options) { option in
                    let button = Button { answer(option) } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(option.label).multilineTextAlignment(.leading)
                            if !option.detail.isEmpty {
                                Text(option.detail)
                                    .font(.footnote.weight(.regular))
                                    .opacity(0.8)
                                    .multilineTextAlignment(.leading)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .disabled(model.isPending(card.id))
                    .accessibilityIdentifier("option-\(card.id)-\(option.key)")
                    if option.key == card.leadKey {
                        button.buttonStyle(LeadButtonStyle())
                    } else {
                        button.buttonStyle(PlainOptionButtonStyle())
                    }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Antwort wählen, ein Tipp entscheidet")
        }
    }

    private func answer(_ option: CardOption) {
        error = nil
        noteFocused = false
        let text = note
        Task { @MainActor in
            // The answer shows at once; the next card slides in a moment later.
            let work = Task { @MainActor in await model.decide(card, option, note: text) }
            try? await Task.sleep(nanoseconds: 350_000_000)
            if model.state.card(card.id)?.status != .open { onDecided() }
            if let reason = await work.value {
                error = reason
                onFailed()
            } else {
                note = ""
                showNote = false
            }
        }
    }
}

/// What became of a card that is no longer open.
private struct Verdict: View {
    @Environment(AppModel.self) private var model
    let card: Card
    @State private var working = false

    private var headline: String {
        if card.kind == .permission {
            switch card.choice {
            case "allow": return "Erlaubt"
            case "deny": return "Abgelehnt"
            default: return "Ohne Antwort"
            }
        }
        if card.choice == nil { return "Ohne Antwort" }
        return card.status == .done ? "Abgeschlossen" : "Entschieden, der Agent setzt es um"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(headline, systemImage: card.choice == nil ? "minus.circle" : "checkmark.circle.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(card.choice == nil ? Theme.muted : Theme.status(.done))
            if card.kind == .decision, let label = card.choiceLabel {
                LabeledContent("Deine Antwort", value: label).font(.subheadline)
            }
            if !card.note.isEmpty {
                LabeledContent("Deine Anmerkung", value: card.note).font(.subheadline)
            }
            if !card.summary.isEmpty {
                LabeledContent("Ergebnis", value: card.summary).font(.subheadline)
            }
            if card.kind == .decision, card.choice != nil, !model.isPending(card.id) {
                Button {
                    working = true
                    Task {
                        await model.reopen(card.id)
                        working = false
                    }
                } label: {
                    Label("Neu entscheiden", systemImage: "arrow.uturn.backward")
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
}

/// A tool approval: what the agent wants to do, and the exact input in monospace.
private struct PermissionBox: View {
    let card: Card

    private var tool: String {
        // "Freigabe: Bash" names the tool after the colon.
        guard let colon = card.title.firstIndex(of: ":"), card.title.distance(from: card.title.startIndex, to: colon) <= 24 else { return card.title }
        let name = card.title[card.title.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        return name.isEmpty ? "Werkzeug" : name
    }

    var body: some View {
        let parsed = PermissionBody.parse(card.body)
        VStack(alignment: .leading, spacing: 12) {
            if !parsed.description.isEmpty {
                Text(parsed.description).font(.body).foregroundStyle(Theme.fg).fixedSize(horizontal: false, vertical: true)
            }
            if !parsed.raw.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) {
                        Image(systemName: "shield.lefthalf.filled").accessibilityHidden(true)
                        Text(tool).fontWeight(.semibold)
                        Text("Eingabe").foregroundStyle(Theme.faint)
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
    }
}
