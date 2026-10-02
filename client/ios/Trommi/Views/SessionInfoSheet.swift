// About one session: where it runs and as what, its status lines, and what
// the human can do with it: mark it VIP, rename it, pick another mark, lay it
// together with another session, put it away. Follows mountRoster() and
// openEditor() in client/web/js/agents.js; the rules live in Core (Sessions.swift).
import SwiftUI

struct SessionInfoSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let agentID: String

    @State private var name = ""
    @State private var mark = ""
    @State private var loaded = false
    @State private var saving = false
    @State private var error: String?

    private var agent: Agent? { model.state.agent(agentID) }

    var body: some View {
        NavigationStack {
            form
                .navigationTitle("Session")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close") { dismiss() }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") { save() }
                            .disabled(saving || !changed)
                            .accessibilityIdentifier("session-save")
                    }
                }
        }
        .onAppear(perform: load)
    }

    @ViewBuilder
    private var form: some View {
        if let agent {
            Form {
                Section {
                    TextField("Name of the session", text: $name)
                        .accessibilityIdentifier("session-name")
                    MarkPicker(choices: agent.markChoices, hue: agent.hue, picked: $mark)
                    InlineError(text: error)
                } header: {
                    Text("Name and mark")
                } footer: {
                    Text("The session calls itself \(agent.name). An emptied name falls back to that.")
                }
                Section("About") {
                    LabeledContent("State", value: agent.stateLine(now: Date().timeIntervalSince1970 * 1000))
                    LabeledContent("Task", value: agent.task.isEmpty ? "no task named" : agent.task)
                    ForEach(agent.facts(open: openCount(agent), now: Date().timeIntervalSince1970 * 1000)) { fact in
                        LabeledContent(fact.term, value: fact.shown)
                    }
                }
                statusLines(agent)
                Section {
                    Toggle("VIP: its questions lead the inbox", isOn: starBinding(agent))
                        .accessibilityIdentifier("session-star")
                    PairingControl(agent: agent)
                    if !agent.online {
                        Button("Archive", role: .destructive) {
                            archive(agent)
                        }
                        .accessibilityIdentifier("session-archive")
                    }
                } footer: {
                    if !agent.online {
                        Text("An archived session is put away with its questions. It comes back by itself when it reconnects.")
                    }
                }
            }
        } else {
            Text("This session is no longer here.")
                .foregroundStyle(Theme.muted)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder
    private func statusLines(_ agent: Agent) -> some View {
        let tasks = model.state.tasks.filter { $0.agent == agent.id }
        if !tasks.isEmpty {
            Section("Status") {
                ForEach(tasks) { task in
                    HStack(spacing: 8) {
                        Circle().fill(Theme.status(task.state)).frame(width: 9, height: 9)
                        Text(task.line).font(.subheadline)
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("\(task.line), \(task.state.word)")
                }
            }
        }
    }

    private var changed: Bool {
        guard let agent else { return false }
        return name.trimmingCharacters(in: .whitespacesAndNewlines) != agent.displayName || mark != agent.mark
    }

    private func openCount(_ agent: Agent) -> Int {
        model.state.openCards.filter { $0.agent == agent.id }.count
    }

    private func load() {
        guard !loaded, let agent else { return }
        loaded = true
        name = agent.displayName
        mark = agent.mark
    }

    private func save() {
        guard let agent else { return }
        saving = true
        error = nil
        Task {
            error = await model.rename(agent, name: name, mark: mark)
            saving = false
            if error == nil { dismiss() }
        }
    }

    private func starBinding(_ agent: Agent) -> Binding<Bool> {
        Binding(get: { agent.starred }, set: { starred in
            Task { await model.star(agent, starred) }
        })
    }

    private func archive(_ agent: Agent) {
        Task {
            if await model.archive(agent, true) == nil { dismiss() }
        }
    }
}

/// A handful of scribbles to choose the session's mark from; the current one first.
private struct MarkPicker: View {
    let choices: [String]
    let hue: Int
    @Binding var picked: String

    private let columns = [GridItem(.adaptive(minimum: 48), spacing: 8)]

    var body: some View {
        LazyVGrid(columns: columns, spacing: 8) {
            ForEach(choices, id: \.self) { seed in
                Button {
                    picked = seed
                } label: {
                    DoodleView(doodle: Doodle.mark(seed), size: 30)
                        .foregroundStyle(Theme.avatar(hue: hue))
                        .frame(width: 46, height: 46)
                        .background(Theme.sunken, in: RoundedRectangle(cornerRadius: Theme.radiusSmall, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: Theme.radiusSmall, style: .continuous)
                            .strokeBorder(seed == picked ? Theme.accent : Color.clear, lineWidth: 2))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(seed == picked ? "Mark, selected" : "Mark")
                .accessibilityIdentifier("mark-\(seed)")
            }
        }
        .padding(.vertical, 4)
    }
}

/// Lay this session together with another one, or split it from its group.
private struct PairingControl: View {
    @Environment(AppModel.self) private var model
    let agent: Agent

    var body: some View {
        if let group = model.state.group(of: agent.id) {
            LabeledContent("Together with", value: group.members.filter { $0.id != agent.id }.map(\.displayName).joined(separator: ", "))
            Button("Split") {
                Task { await model.unpair(agent.id) }
            }
            .accessibilityIdentifier("session-split")
        } else if !others.isEmpty {
            Menu("Put together with…") {
                ForEach(others) { other in
                    Button(title(other)) {
                        Task { await model.pair(agent.id, with: other.id) }
                    }
                }
            }
            .accessibilityIdentifier("session-pair")
        }
    }

    private var others: [Agent] { model.state.sessions.filter { $0.id != agent.id } }

    private func title(_ other: Agent) -> String {
        [other.displayName, model.state.tellApart()[other.id] ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
    }
}
