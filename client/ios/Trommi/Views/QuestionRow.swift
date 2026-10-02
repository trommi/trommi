// One question as a row. Every row has the same height, with two square tiles
// at its trailing edge: no and yes for a yes/no question, otherwise "Later"
// and "Choose", which opens the options. (The web has since moved "Later" to a
// small tag on the row's edge and lets "Choose" unfold the row in place; Core
// already says which it would be, RowActions.choose(inline:count:), this view
// does not draw it yet.) The same row stands in the inbox and
// in a session's conversation. Follows questionRow() in client/web/js/inbox.js;
// which tiles a card gets is decided in Core (Card.rowActions).
import SwiftUI

struct QuestionRow: View {
    @Environment(AppModel.self) private var model
    let card: Card
    /// The session is starred.
    var vip = false
    /// The question was put off: its first tile fetches it back.
    var off = false
    /// The session that asked, named on the row when nothing around it says so.
    var sender: Agent? = nil
    /// Open the whole card.
    let open: () -> Void

    @State private var error: String?
    @State private var viewer: ViewerRequest?

    var body: some View {
        HStack(spacing: 8) {
            Button(action: open) {
                text
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("row-text-\(card.id)")
            .accessibilityHint("Opens the whole question")
            thumbnail
            tiles
        }
        .padding(.leading, 14)
        .padding(.trailing, 10)
        .frame(height: Theme.rowHeight)
        .cardSurface()
        // The row keeps its height; very large type would not fit two lines of title.
        .dynamicTypeSize(...DynamicTypeSize.xxLarge)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("row-\(card.id)")
        .fullScreenCover(item: $viewer) { request in
            ImageViewer(images: card.images, start: request.index)
        }
    }

    // MARK: text

    private var text: some View {
        VStack(alignment: .leading, spacing: 3) {
            head
            Text(card.title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.fg)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
            if let error {
                Text(error).font(.caption).foregroundStyle(Theme.urgency(.critical)).lineLimit(1)
            } else if !card.excerpt.isEmpty {
                Text(card.excerpt).font(.caption).foregroundStyle(Theme.muted).lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    /// Only what stands out: a tab for blocking and urgent, an hourglass for "whenever", VIP, who asks, and the age.
    private var head: some View {
        HStack(spacing: 6) {
            urgency
            if vip {
                Text("VIP")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(Theme.accent)
            }
            if let sender {
                HStack(spacing: 3) {
                    DoodleView(doodle: Doodle.mark(sender.mark), size: 12)
                    Text(sender.displayName).lineLimit(1)
                }
                .font(.caption2)
                .foregroundStyle(Theme.muted)
            }
            Ago(ts: card.created)
                .font(.caption2)
                .foregroundStyle(Theme.faint)
                .lineLimit(1)
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private var urgency: some View {
        switch card.urgencyMark {
        case .tab(let word, let level):
            Text(word)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(Theme.surface)
                .lineLimit(1)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Theme.urgency(level), in: RoundedRectangle(cornerRadius: 5, style: .continuous))
        case .whenever:
            SketchIcon(kind: .whenever, size: 13)
                .foregroundStyle(Theme.urgency(.low))
                .accessibilityHidden(false)
                .accessibilityLabel("Whenever")
        case .plain:
            EmptyView()
        }
    }

    // MARK: picture

    /// One small picture stands for all of them; it opens large on tap, without leaving the list.
    @ViewBuilder
    private var thumbnail: some View {
        if let first = card.images.first {
            Button {
                viewer = ViewerRequest(index: 0)
            } label: {
                RemoteImage(attachment: first, fill: true)
                    .frame(width: 44, height: 44)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.radiusSmall, style: .continuous))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(card.images.count == 1 ? "Enlarge \(first.name)" : "Look at \(card.images.count) pictures")
        }
    }

    // MARK: tiles

    @ViewBuilder
    private var tiles: some View {
        switch card.rowActions {
        case .answer(let answers):
            ForEach(answers) { tile in
                Button {
                    answer(tile.option)
                } label: {
                    TileLabel(sketch: tile.sketch, label: tile.label, lead: tile.isLead, advice: tile.advised ? "\(card.id)/\(tile.id)" : nil)
                }
                .buttonStyle(.plain)
                .disabled(model.isPending(card.id))
                .accessibilityLabel(tile.spoken)
                .accessibilityHint(tile.option.detail.isEmpty ? "Answers at once" : tile.option.detail)
                .accessibilityIdentifier("answer-\(card.id)-\(tile.id)")
            }
        case .choose:
            Button {
                // "Later" says where the question went, with the way back (the note at the foot of the list).
                if off { model.fetchBack(card.id) } else { model.later(card) }
            } label: {
                TileLabel(sketch: off ? .back : .later, label: off ? "Fetch back" : "Later", lead: false, advice: nil)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier(off ? "back-\(card.id)" : "later-\(card.id)")
            Button(action: open) {
                TileLabel(sketch: .choose, label: "Choose", lead: true, advice: nil)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("choose-\(card.id)")
        }
    }

    private func answer(_ option: CardOption) {
        error = nil
        Task {
            error = await model.decide(card, option)
        }
    }
}

/// A square tile: a sketched icon, and a word below it unless the icon says it all.
struct TileLabel: View {
    let sketch: SketchKind
    let label: String?
    /// Filled: the answer the agent leads with, or "Choose".
    let lead: Bool
    /// Seed of the hand-drawn circle when the agent recommends this answer.
    let advice: String?

    var body: some View {
        VStack(spacing: 2) {
            SketchIcon(kind: sketch, size: label == nil ? 30 : 24)
            if let label {
                Text(label)
                    .font(.caption2.weight(.semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
            }
        }
        .foregroundStyle(lead ? Theme.accentFg : Theme.fg)
        .padding(.horizontal, 3)
        .frame(width: Theme.tile, height: Theme.tile)
        .background(lead ? Theme.accent : Theme.surface2, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).strokeBorder(lead ? Theme.accent : Theme.lineStrong, lineWidth: 1))
        .overlay {
            if let advice {
                AdviceCircle(seed: advice).padding(-3)
            }
        }
        .contentShape(Rectangle())
    }
}

/// Which picture the full-screen viewer starts with.
struct ViewerRequest: Identifiable {
    let id = UUID()
    var index: Int
}
