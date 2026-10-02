import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        content
            .sheet(item: browserBinding) { request in
                SafariView(url: request.url).ignoresSafeArea()
            }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .onboarding: OnboardingView()
        case .board: BoardView()
        }
    }

    /// The link the human tapped; closing the browser clears it.
    private var browserBinding: Binding<BrowserRequest?> {
        Binding(get: { model.browser }, set: { model.browser = $0 })
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
