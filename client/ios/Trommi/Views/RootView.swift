import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            switch model.phase {
            case .onboarding: OnboardingView()
            case .board: BoardView()
            }
        }
        .animation(.easeInOut(duration: 0.25), value: model.phase)
    }
}

/// The two tabs of the app. The inbox is the start screen.
private struct BoardView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        TabView {
            InboxScreen()
                .tabItem { Label("Posteingang", systemImage: "tray.full") }
                .badge(model.state.queue.count)
            SessionsScreen()
                .tabItem { Label("Sitzungen", systemImage: "person.2") }
        }
        .noticeBanner()
    }
}
