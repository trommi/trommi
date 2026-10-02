// A session: ONE conversation view. Its open questions stand in the log as the
// same rows as in the inbox, right where they were asked. A filter lays a list
// over the log instead: the questions only (open ones, then the answered), or
// the files. Sessions laid together share this screen; a picker says which one
// is shown. What the log consists of is decided in Core (conversationItems).
import SwiftUI

struct ConversationScreen: View {
    @Environment(AppModel.self) private var model
    /// A session id or a group id.
    let unitID: String

    @State private var member: String?
    @State private var filter = ConversationFilter.all
    @State private var focus: FocusRequest?
    @State private var showInfo = false
    @State private var draft = ""

    private var unit: SessionUnit? { model.state.sessionUnit(unitID) }

    /// The session whose conversation is shown: the picked member, else the first one.
    private var agent: Agent? {
        guard let unit else { return model.state.agent(unitID) }
        return unit.members.first { $0.id == member } ?? unit.members.first
    }

    var body: some View {
        content
            .background(Theme.bg)
            .navigationTitle(agent?.displayName ?? "Session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showInfo = true
                    } label: {
                        Image(systemName: "info.circle")
                    }
                    .accessibilityLabel("About this session")
                    .accessibilityIdentifier("session-info")
                }
            }
            .fullScreenCover(item: $focus) { request in
                FocusView(start: request.start)
            }
            .sheet(isPresented: $showInfo) {
                if let agent {
                    SessionInfoSheet(agentID: agent.id)
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        if let agent {
            VStack(spacing: 0) {
                pickers(agent)
                switch filter {
                case .all:
                    ConversationLog(agent: agent, draft: $draft) { cardID in
                        focus = FocusRequest(start: cardID)
                    }
                case .questions:
                    QuestionsList(agentID: agent.id) { cardID in
                        focus = FocusRequest(start: cardID)
                    }
                case .files:
                    FilesList(agentID: agent.id)
                }
            }
        } else {
            Text("This session is no longer here.")
                .font(.subheadline)
                .foregroundStyle(Theme.muted)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    /// Which member of a group is shown, and which of the three views.
    private func pickers(_ agent: Agent) -> some View {
        VStack(spacing: 8) {
            if let unit, unit.members.count > 1 {
                Picker("Session", selection: memberBinding(agent)) {
                    ForEach(unit.members) { one in
                        Text(memberTitle(one)).tag(one.id)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("member-picker")
            }
            Picker("Show", selection: $filter) {
                ForEach(ConversationFilter.allCases) { one in
                    Text(one.title).tag(one)
                }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("conversation-filter")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }

    private func memberBinding(_ agent: Agent) -> Binding<String> {
        Binding(get: { agent.id }, set: { member = $0 })
    }

    /// Members of the same name are told apart by their folder or machine.
    private func memberTitle(_ agent: Agent) -> String {
        model.state.tellApart()[agent.id] ?? agent.displayName
    }
}

/// The log of one session, with its composer.
private struct ConversationLog: View {
    @Environment(AppModel.self) private var model
    let agent: Agent
    @Binding var draft: String
    let openCard: (String) -> Void

    private static let end = "end-of-log"

    var body: some View {
        TimelineView(.periodic(from: Date(), by: 30)) { context in
            log(now: context.date.timeIntervalSince1970 * 1000)
        }
        .safeAreaInset(edge: .bottom) {
            Composer(agentID: agent.id, placeholder: ConversationText.placeholder(model.state.severalSessions ? agent.displayName : nil), draft: $draft)
        }
    }

    private func log(now: Double) -> some View {
        let items = model.state.conversationItems(of: agent.id, now: now)
        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if items.isEmpty {
                        EmptyConversation { text in draft = text }
                    }
                    ForEach(items) { item in
                        ConversationItemView(item: item, vip: agent.starred, off: isOff(item), openCard: openCard)
                    }
                    if model.state.agentIsWorking(agent.id, now: now) {
                        HStack(spacing: 8) {
                            ProgressView()
                            Text(ConversationText.working).font(.footnote).foregroundStyle(Theme.muted)
                        }
                        .accessibilityIdentifier("agent-working")
                    }
                    Color.clear.frame(height: 1).id(ConversationLog.end)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: items.count) { _, _ in
                withAnimation(.easeOut(duration: 0.25)) {
                    proxy.scrollTo(ConversationLog.end, anchor: .bottom)
                }
            }
        }
    }

    private func isOff(_ item: ConversationItem) -> Bool {
        if case .question(_, let card) = item { return model.later.contains(card.id) }
        return false
    }
}

/// The open questions of one session as rows, and below them what was answered.
private struct QuestionsList: View {
    @Environment(AppModel.self) private var model
    let agentID: String
    let openCard: (String) -> Void

    var body: some View {
        let history = model.state.history(of: agentID)
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                InboxList(inbox: model.state.inbox(later: model.later, session: agentID)) { cardID in
                    if let cardID { openCard(cardID) }
                }
                if !history.isEmpty {
                    GroupHeading(title: "Answered", count: model.state.historyCountLabel(of: agentID)) {
                        Image(systemName: "checkmark").font(.caption).foregroundStyle(Theme.muted).frame(width: 24, height: 24)
                    }
                    .padding(.top, 12)
                    ForEach(history) { row in
                        HistoryRowView(row: row)
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
        }
        .accessibilityIdentifier("questions-list")
    }
}

/// One answered question: the title, the answer, and what became of it. A tap unfolds the rest.
private struct HistoryRowView: View {
    @Environment(AppModel.self) private var model
    let row: HistoryRow
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                expanded.toggle()
            } label: {
                head
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("history-\(row.id)")
            if expanded {
                if !row.card.body.isEmpty {
                    MarkdownView(row.card.body, font: .subheadline)
                }
                AttachmentList(attachments: row.card.attachments)
                Verdict(card: row.card)
                Text(row.footnote).font(.caption2).foregroundStyle(Theme.faint)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardSurface()
    }

    private var head: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(row.card.title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.fg)
                .multilineTextAlignment(.leading)
            HStack(spacing: 6) {
                if row.answered {
                    Image(systemName: "checkmark").accessibilityHidden(true)
                }
                Text(row.pick).fontWeight(.medium).lineLimit(1)
                Text(row.outcome).lineLimit(1)
                Spacer(minLength: 4)
                Ago(ts: row.when)
            }
            .font(.caption)
            .foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

/// Everything the session ever sent, newest first: each line opens its item.
private struct FilesList: View {
    @Environment(AppModel.self) private var model
    let agentID: String
    @State private var viewer: ViewerRequest?

    var body: some View {
        let files = model.state.files(of: agentID)
        let pictures = files.filter(\.isPicture).compactMap(\.attachment)
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 8) {
                GroupHeading(title: "Files", count: Wording.items(files.count)) {
                    Image(systemName: "doc").font(.caption).foregroundStyle(Theme.muted).frame(width: 24, height: 24)
                }
                if files.isEmpty {
                    Text(ConversationText.noFiles)
                        .font(.subheadline)
                        .foregroundStyle(Theme.muted)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 40)
                }
                ForEach(files) { file in
                    FileRow(file: file) {
                        open(file, among: pictures)
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
        }
        .fullScreenCover(item: $viewer) { request in
            ImageViewer(images: pictures, start: request.index)
        }
        .accessibilityIdentifier("files-list")
    }

    private func open(_ file: FileItem, among pictures: [Attachment]) {
        if file.kind == .link {
            model.open(link: file.url)
        } else if let index = pictures.firstIndex(where: { $0.url == file.url }) {
            viewer = ViewerRequest(index: index)
        }
    }
}

private struct FileRow: View {
    let file: FileItem
    let open: () -> Void

    var body: some View {
        if file.isPicture || file.kind == .link {
            Button(action: open) {
                line
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("file-\(file.kind.rawValue)")
        } else if let attachment = file.attachment {
            // Video, audio and other files bring their own player or preview.
            VStack(alignment: .leading, spacing: 4) {
                AttachmentList(attachments: [attachment])
                meta
            }
            .padding(10)
            .cardSurface()
        }
    }

    private var line: some View {
        HStack(spacing: 10) {
            if let attachment = file.attachment, file.isPicture {
                RemoteImage(attachment: attachment, fill: true)
                    .frame(width: 44, height: 44)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.radiusSmall, style: .continuous))
            } else {
                Image(systemName: "arrow.up.right.square")
                    .foregroundStyle(Theme.muted)
                    .frame(width: 44, height: 44)
                    .background(Theme.sunken, in: RoundedRectangle(cornerRadius: Theme.radiusSmall, style: .continuous))
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(file.name).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.fg).lineLimit(1)
                meta
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .cardSurface()
        .contentShape(Rectangle())
    }

    /// "Picture · 5 min ago · Which default theme?"
    private var meta: some View {
        HStack(spacing: 4) {
            Text(file.kind.label)
            Text("·").accessibilityHidden(true)
            Ago(ts: file.ts)
            if let origin = file.origin {
                Text("·").accessibilityHidden(true)
                Text(origin).lineLimit(1)
            }
        }
        .font(.caption)
        .foregroundStyle(Theme.muted)
    }
}
