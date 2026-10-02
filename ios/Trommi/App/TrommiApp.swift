import SwiftUI

@main
struct TrommiApp: App {
    @State private var model = AppModel.launch()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .tint(Theme.accent)
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { model.reconnect() }
                }
        }
    }
}
