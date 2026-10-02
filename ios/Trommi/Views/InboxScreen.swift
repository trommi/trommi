// Posteingang: every open decision of every agent, grouped by who is asking.
// Yes/no questions are answered right in the row; anything longer opens.
import SwiftUI

/// Which card the focus flow starts with; nil is the most urgent one.
struct FocusRequest: Identifiable {
    let id = UUID()
    var start: String?
}

struct InboxScreen: View {
    @Environment(AppModel.self) private var model
    @State private var focus: FocusRequest?
    @State private var showSettings = false

    var body: some View {
        NavigationStack {
            content
                .background(Theme.bg)
                .navigationTitle("Posteingang")
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) { ConnectionBadge() }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { showSettings = true } label: { Image(systemName: "gearshape") }
                            .accessibilityLabel("Einstellungen")
                            .accessibilityIdentifier("settings-button")
                    }
                }
                .safeAreaInset(edge: .bottom) { UndoBar() }
                .animation(.easeOut(duration: 0.25), value: model.undo)
                .fullScreenCover(item: $focus) { request in
                    FocusView(start: request.start)
                }
                .sheet(isPresented: $showSettings) { SettingsSheet() }
        }
    }

    @ViewBuilder
    private var content: some View {
        if !model.loaded {
            VStack(spacing: 12) {
                ProgressView()
                Text("Entscheidungen werden geladen").font(.subheadline).foregroundStyle(Theme.muted)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            let groups = model.state.inboxGroups
            List {
                Section {
                    header
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                }
                ForEach(groups) { group in
                    Section {
                        ForEach(group.cards) { card in
                            InboxRow(card: card) { focus = FocusRequest(start: card.id) }
                                .listRowSeparator(.hidden)
                                .listRowBackground(Color.clear)
                                .listRowInsets(EdgeInsets(top: 5, leading: 16, bottom: 5, trailing: 16))
                        }
                    } header: {
                        GroupHeader(group: group)
                    }
                }
                if groups.isEmpty {
                    Text("Sobald ein Agent eine Frage hat, erscheint sie hier.")
                        .font(.subheadline)
                        .foregroundStyle(Theme.muted)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 40)
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                        .accessibilityIdentifier("inbox-empty")
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .animation(.easeOut(duration: 0.25), value: model.state.queue)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(model.state.inboxLine)
                .font(.subheadline)
                .foregroundStyle(Theme.muted)
                .accessibilityIdentifier("inbox-line")
            if model.state.queue.count > 1 {
                Button {
                    focus = FocusRequest(start: nil)
                } label: {
                    Label("Der Reihe nach durchgehen", systemImage: "rectangle.stack")
                }
                .buttonStyle(LeadButtonStyle(compact: true))
                .accessibilityIdentifier("inbox-go")
            }
        }
    }
}

private struct GroupHeader: View {
    let group: InboxGroup

    var body: some View {
        HStack(spacing: 8) {
            Avatar(agent: group.agent, size: 24)
            Text(group.agent.name).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.fg)
            Text(Wording.questions(group.cards.count)).font(.caption).foregroundStyle(Theme.muted)
            Spacer()
        }
        .textCase(nil)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        .accessibilityIdentifier("inbox-group-\(group.agent.id)")
    }
}

struct InboxRow: View {
    @Environment(AppModel.self) private var model
    let card: Card
    let open: () -> Void
    @State private var error: String?

    private var note: String {
        [card.isQuick ? "" : "\(card.options.count) Optionen",
         card.attachments.isEmpty ? "" : Wording.attachments(card.attachments.count)]
            .filter { !$0.isEmpty }.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top) {
                CardTab(card: card)
                Spacer()
                Ago(ts: card.created)
                    .font(.caption)
                    .foregroundStyle(Theme.faint)
                    .padding(.top, 7)
                    .padding(.trailing, 12)
            }
            Button(action: open) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(card.title)
                        .font(.headline)
                        .foregroundStyle(Theme.fg)
                        .multilineTextAlignment(.leading)
                    if !card.excerpt.isEmpty {
                        Text(card.excerpt)
                            .font(.subheadline)
                            .foregroundStyle(Theme.muted)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 14)
            .padding(.top, 10)
            .accessibilityIdentifier("inbox-text-\(card.id)")
            .accessibilityHint("Öffnet die ganze Karte")

            HStack(spacing: 10) {
                if !note.isEmpty {
                    Text(note).font(.caption).foregroundStyle(Theme.faint)
                }
                // The dashed leader between label and control, as in the web inbox.
                Line()
                    .stroke(Theme.lineStrong, style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    .frame(height: 1)
                    .accessibilityHidden(true)
                actions
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)

            if let error {
                InlineError(text: error).padding(.horizontal, 14).padding(.bottom, 10)
            }
        }
        .cardSurface()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("inbox-row-\(card.id)")
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if card.isQuick {
                ForEach(card.orderedOptions.reversed()) { option in
                    Button(option.label) { answer(option) }
                        .tint(option.key == card.leadKey ? Theme.accent : (card.kind == .permission ? Theme.deny : Theme.muted))
                }
            } else {
                Button("Ansehen", action: open).tint(Theme.accent)
            }
        }
    }

    @ViewBuilder
    private var actions: some View {
        if card.isQuick {
            HStack(spacing: 8) {
                ForEach(card.orderedOptions) { option in
                    let button = Button(option.label) { answer(option) }
                        .disabled(model.isPending(card.id))
                        .accessibilityIdentifier("answer-\(card.id)-\(option.key)")
                        .accessibilityHint(option.detail.isEmpty ? "Entscheidet sofort" : option.detail)
                    if option.key == card.leadKey {
                        button.buttonStyle(LeadButtonStyle(compact: true))
                    } else {
                        button.buttonStyle(PlainOptionButtonStyle(compact: true, tint: card.kind == .permission ? Theme.deny : Theme.fg))
                    }
                }
            }
        } else {
            Button(action: open) {
                HStack(spacing: 4) {
                    Text("Ansehen")
                    Image(systemName: "arrow.right").accessibilityHidden(true)
                }
            }
            .buttonStyle(PlainOptionButtonStyle(compact: true))
            .accessibilityIdentifier("open-\(card.id)")
        }
    }

    private func answer(_ option: CardOption) {
        error = nil
        Task { error = await model.decide(card, option) }
    }
}

private struct Line: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.midY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
        return path
    }
}

/// Where the app is connected to, and the way out.
struct SettingsSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var confirm = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    LabeledContent("Adresse", value: model.serverAddress)
                    LabeledContent("Verbindung", value: model.connection.text)
                    LabeledContent("Diktat und Vorlesen", value: model.state.speech ? "eingerichtet" : "nicht eingerichtet")
                }
                Section {
                    Button(model.isDemo ? "Demo beenden" : "Abmelden", role: .destructive) { confirm = true }
                        .accessibilityIdentifier("sign-out")
                } footer: {
                    Text(model.isDemo
                         ? "Die Demo läuft nur in der App. Nichts davon erreicht einen Server."
                         : "Das Token wird aus dem Schlüsselbund gelöscht. Zum Anmelden brauchst du wieder den Link aus data/url.txt.")
                }
            }
            .navigationTitle("Einstellungen")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Fertig") { dismiss() } }
            }
            .confirmationDialog(model.isDemo ? "Demo beenden?" : "Wirklich abmelden?", isPresented: $confirm, titleVisibility: .visible) {
                Button(model.isDemo ? "Demo beenden" : "Abmelden", role: .destructive) {
                    dismiss()
                    model.signOut()
                }
                Button("Abbrechen", role: .cancel) {}
            }
        }
    }
}
