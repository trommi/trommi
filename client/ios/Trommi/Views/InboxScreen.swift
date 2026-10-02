// The inbox: every open question of every session, grouped by who is asking.
// Yes/no questions are answered right in the row; "Choose" opens the card;
// "Later" moves a question into one group at the very bottom.
// What is shown, and in which order, is decided in Core (BoardState.inbox).
import SwiftUI

/// Which card the whole-card view opens on; nil walks through all of them.
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
                .navigationTitle("Inbox")
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) { ConnectionBadge() }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            showSettings = true
                        } label: {
                            Image(systemName: "gearshape")
                        }
                        .accessibilityLabel("Settings")
                        .accessibilityIdentifier("settings-button")
                    }
                }
                .safeAreaInset(edge: .bottom) { UndoBar() }
                .fullScreenCover(item: $focus) { request in
                    FocusView(start: request.start)
                }
                .sheet(isPresented: $showSettings) { SettingsSheet() }
        }
    }

    @ViewBuilder
    private var content: some View {
        if model.loaded {
            ScrollView {
                InboxList(inbox: model.state.inbox(later: model.later)) { cardID in
                    focus = FocusRequest(start: cardID)
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 24)
            }
        } else {
            VStack(spacing: 12) {
                ProgressView()
                Text("Loading questions").font(.subheadline).foregroundStyle(Theme.muted)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

/// The groups of an inbox: one per sender, then "Later". Also used for one session's questions.
struct InboxList: View {
    let inbox: InboxModel
    /// Open one card, or with nil walk through all of them.
    let open: (String?) -> Void

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 10) {
            header
            ForEach(inbox.groups) { group in
                if inbox.session == nil {
                    GroupHeading(title: group.agent.displayName, count: group.countLabel) {
                        SessionMark(agent: group.agent, size: 24)
                    }
                    .padding(.top, 8)
                    .accessibilityIdentifier("inbox-group-\(group.agent.id)")
                }
                ForEach(group.cards) { card in
                    QuestionRow(card: card, vip: group.agent.starred, open: { open(card.id) })
                }
            }
            if !inbox.later.isEmpty {
                GroupHeading(title: "Later", count: inbox.laterCountLabel) {
                    SketchIcon(kind: .later, size: 20).foregroundStyle(Theme.muted).frame(width: 24, height: 24)
                }
                .padding(.top, 8)
                .accessibilityIdentifier("inbox-group-later")
                ForEach(inbox.later) { row in
                    QuestionRow(card: row.card, vip: row.sender?.starred ?? false, off: true, sender: row.sender, open: { open(row.card.id) })
                }
            }
            if inbox.isEmpty {
                Text(inbox.emptyText)
                    .font(.subheadline)
                    .foregroundStyle(Theme.muted)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 40)
                    .accessibilityIdentifier("inbox-empty")
            }
        }
    }

    /// "3 questions need you." with the number circled, and the way to go through them one by one.
    private var header: some View {
        HStack(spacing: 10) {
            HStack(spacing: 6) {
                if let count = inbox.circled {
                    Text("\(count)")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(Theme.fg)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .overlay(Capsule().strokeBorder(Theme.urgency(.high), lineWidth: 1.5))
                }
                Text(inbox.line).font(.subheadline).foregroundStyle(Theme.muted)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(inbox.sentence)
            .accessibilityIdentifier("inbox-line")
            Spacer(minLength: 0)
            if inbox.offersWalk {
                Button("Go through them") { open(nil) }
                    .buttonStyle(LeadButtonStyle(compact: true))
                    .accessibilityIdentifier("inbox-go")
            }
        }
        .padding(.top, 4)
    }
}
