// Sessions: every session with its mark and what it needs right now, sessions
// laid together as one row, the disconnected ones below, the archive last.
// Rows and badges are decided in Core (BoardState.sessionUnits).
import SwiftUI

struct SessionsScreen: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationStack {
            content
                .background(Theme.bg)
                .navigationTitle("Sessions")
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) { ConnectionBadge() }
                }
                .navigationDestination(for: String.self) { unitID in
                    ConversationScreen(unitID: unitID)
                }
        }
    }

    @ViewBuilder
    private var content: some View {
        if model.loaded {
            list
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var list: some View {
        let units = model.state.sessionUnits
        let apart = model.state.tellApart()
        let here = units.filter(\.online)
        let away = units.filter { !$0.online }
        return List {
            Section {
                ForEach(here) { unit in
                    link(unit, apart)
                }
            } header: {
                Text(model.state.connectedLine).textCase(nil)
            }
            if !away.isEmpty {
                Section("Disconnected") {
                    ForEach(away) { unit in
                        link(unit, apart)
                    }
                }
            }
            if !model.state.archivedSessions.isEmpty {
                Section("Archive") {
                    ForEach(model.state.archivedSessions) { agent in
                        ArchivedRow(agent: agent)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
    }

    private func link(_ unit: SessionUnit, _ apart: [String: String]) -> some View {
        NavigationLink(value: unit.id) {
            SessionRow(unit: unit, second: secondLine(unit, apart))
        }
        .listRowBackground(Theme.surface)
        .accessibilityIdentifier("session-\(unit.id)")
    }

    /// What tells sessions of the same name apart, else what the session is working on.
    private func secondLine(_ unit: SessionUnit, _ apart: [String: String]) -> String {
        if unit.members.count == 1, let only = unit.members.first, let line = apart[only.id] { return line }
        return unit.taskLine
    }
}

private struct SessionRow: View {
    let unit: SessionUnit
    let second: String

    private var spoken: String {
        [unit.name, unit.starred ? "VIP" : "", second, unit.badge.title].filter { !$0.isEmpty }.joined(separator: ", ")
    }

    var body: some View {
        HStack(spacing: 12) {
            UnitMark(unit: unit, size: 40)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(unit.name).font(.body.weight(.semibold)).foregroundStyle(Theme.fg).lineLimit(1)
                    if unit.starred {
                        Image(systemName: "star.fill").font(.caption).foregroundStyle(Theme.urgency(.high))
                    }
                }
                if !second.isEmpty {
                    Text(second).font(.subheadline).foregroundStyle(Theme.muted).lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            SessionBadgeView(badge: unit.badge)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spoken)
    }
}

/// A raised hand when the session is stopped waiting for the human, the number of open
/// questions in a ring while it works, the same in grey when it is disconnected.
struct SessionBadgeView: View {
    let badge: SessionBadge

    var body: some View {
        switch badge {
        case .quiet:
            EmptyView()
        case .waiting(_, let offline):
            SketchIcon(kind: .hand, size: 24)
                .foregroundStyle(offline ? Theme.faint : Theme.status(.decision))
        case .running(let open):
            Text(open > 0 ? "\(open)" : " ")
                .font(.footnote.weight(.bold))
                .foregroundStyle(Theme.fg)
                .frame(width: 26, height: 26)
                .overlay(Circle().strokeBorder(Theme.status(.working), lineWidth: 1.5))
        case .open(let open):
            Text("\(open)")
                .font(.footnote.weight(.bold))
                .foregroundStyle(Theme.faint)
                .frame(width: 26, height: 26)
                .overlay(Circle().strokeBorder(Theme.lineStrong, lineWidth: 1.5))
        }
    }
}

/// A session the human put away. It comes back by itself when it reconnects.
private struct ArchivedRow: View {
    @Environment(AppModel.self) private var model
    let agent: Agent
    @State private var working = false

    var body: some View {
        HStack(spacing: 12) {
            SessionMark(agent: agent, size: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(agent.displayName).font(.body).foregroundStyle(Theme.fg).lineLimit(1)
                TimelineView(.periodic(from: Date(), by: 30)) { context in
                    Text(agent.stateLine(now: context.date.timeIntervalSince1970 * 1000))
                        .font(.caption)
                        .foregroundStyle(Theme.muted)
                }
            }
            Spacer(minLength: 8)
            Button("Fetch back") {
                working = true
                Task {
                    await model.archive(agent, false)
                    working = false
                }
            }
            .buttonStyle(.bordered)
            .disabled(working)
            .accessibilityIdentifier("unarchive-\(agent.id)")
        }
        .listRowBackground(Theme.surface)
        .accessibilityIdentifier("archived-\(agent.id)")
    }
}
