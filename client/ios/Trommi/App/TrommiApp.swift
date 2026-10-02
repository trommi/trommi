import SwiftUI

@main
@MainActor
struct TrommiApp: App {
    @State private var media: Media
    @State private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let media = Media()
        _media = State(initialValue: media)
        _model = State(initialValue: Runtime.makeModel(media: media))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .environment(media)
                .tint(Theme.accent)
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { model.reconnect() }
                }
        }
    }
}
