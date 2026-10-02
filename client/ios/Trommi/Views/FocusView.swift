// The whole-card view. Opened on one card ("Choose" on a row) it shows that
// card and closes on the answer. Opened without one ("Go through them") it
// walks every open question: an answer brings the next one in, "Previous" and
// "Next" move without answering. Which card is in front is decided in Core
// (FocusWalk); this view only draws it.
import SwiftUI

struct FocusView: View {
    @Environment(AppModel.self) private var model
    @Environment(Media.self) private var media
    @Environment(\.dismiss) private var dismiss
    let start: String?

    @State private var walk: FocusWalk?

    private var current: Card? { model.state.card(walk?.current) }

    var body: some View {
        NavigationStack {
            page
                .background(Theme.bg)
                .safeAreaInset(edge: .top) {
                    UndoBar(onUndone: { cardID in
                        walk?.sync(queue: model.state.queue, later: model.later.ids)
                        walk?.noteUndone(cardID)
                    })
                }
                .navigationTitle(walk?.position ?? "")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close") { dismiss() }
                            .accessibilityIdentifier("focus-close")
                    }
                    ToolbarItem(placement: .primaryAction) {
                        if model.state.speech, let card = current {
                            SpeakerButton(cardID: card.id)
                        }
                    }
                    ToolbarItemGroup(placement: .bottomBar) {
                        if let walk, !walk.single {
                            Button {
                                step(-1)
                            } label: {
                                Label("Previous", systemImage: "arrow.left")
                            }
                            .disabled(!walk.canGoBack)
                            .accessibilityLabel("Previous question")
                            .accessibilityIdentifier("focus-previous")
                            Spacer()
                            Button {
                                step(1)
                            } label: {
                                Label("Next", systemImage: "arrow.right")
                            }
                            .disabled(!walk.canGoForward)
                            .accessibilityLabel("Next question")
                            .accessibilityIdentifier("focus-next")
                        }
                    }
                }
                .noticeBanner()
        }
        .onAppear {
            if walk == nil { walk = FocusWalk(start: start, queue: model.state.queue, later: model.later.ids) }
        }
        .onChange(of: model.state.queue) { _, queue in
            stackChanged(queue)
        }
        .onDisappear { media.speaker.stop() }
    }

    @ViewBuilder
    private var page: some View {
        if let card = current {
            CardPage(card: card, onAnswer: { walk?.noteAnswered() })
                // A new card starts with an empty note and at the top.
                .id(card.id)
        } else if let walk {
            DonePage(text: walk.doneText, close: { dismiss() })
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func step(_ delta: Int) {
        media.speaker.stop()
        walk?.go(delta)
    }

    /// An answer here or elsewhere, a withdrawn or a new question: the walk follows; the window of one card closes.
    private func stackChanged(_ queue: [String]) {
        guard var next = walk else { return }
        let before = next.current
        let keep = next.sync(queue: queue, later: model.later.ids)
        walk = next
        if next.current != before { media.speaker.stop() }
        if !keep { dismiss() }
    }
}

private struct DonePage: View {
    let text: String
    let close: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "checkmark.circle")
                .font(.system(size: 52))
                .foregroundStyle(Theme.status(.done))
                .accessibilityHidden(true)
            Text("All answered")
                .font(.title3.weight(.semibold))
                .foregroundStyle(Theme.fg)
            Text(text)
                .font(.subheadline)
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
            Button("Close", action: close)
                .buttonStyle(LeadButtonStyle(compact: true))
                .padding(.top, 6)
                .accessibilityIdentifier("focus-done-close")
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("focus-done")
    }
}

/// Reads the question aloud; shows a spinner while the audio is made.
struct SpeakerButton: View {
    @Environment(AppModel.self) private var model
    @Environment(Media.self) private var media
    let cardID: String

    var body: some View {
        Button {
            media.speaker.toggle(cardID)
        } label: {
            icon
        }
        .accessibilityLabel(media.speaker.isBusy(with: cardID) ? "Stop reading" : "Read the question aloud")
        .onChange(of: media.speaker.failure) { _, failure in
            if let failure {
                model.notice = failure
                media.speaker.failure = nil
            }
        }
    }

    @ViewBuilder
    private var icon: some View {
        if media.speaker.phase == .loading(cardID) {
            ProgressView()
        } else if media.speaker.phase == .playing(cardID) {
            Image(systemName: "speaker.wave.2.fill")
        } else {
            Image(systemName: "speaker.wave.2")
        }
    }
}
