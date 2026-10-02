import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        content
            // A link the human tapped, wherever in the app: shown over whatever is on screen.
            .onChange(of: model.browser?.id) { _, _ in
                guard let request = model.browser else { return }
                model.browser = nil
                Browser.open(request.url)
            }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .onboarding: OnboardingView()
        case .board: BoardView()
        }
    }
}

/// The two tabs of the app. The inbox is the start screen.
private struct BoardView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        TabView {
            InboxScreen()
                .tabItem { Label("Inbox", systemImage: "tray.full") }
                .badge(model.state.freshCount(later: model.later))
            SessionsScreen()
                .tabItem { Label("Sessions", systemImage: "person.2") }
        }
        .noticeBanner()
    }
}
