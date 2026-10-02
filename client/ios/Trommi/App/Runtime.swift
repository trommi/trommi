// Connects the model in Core with what only the device can do: the Keychain,
// haptics, the preferences, the app bundle, and loading pictures and audio.
import SwiftUI
import UIKit
import SafariServices

/// Pictures and read-aloud; both follow the model's client.
@MainActor
@Observable
final class Media {
    let images = ImageStore()
    let speaker = Speaker()

    func use(_ client: (any BoardClient)?) {
        speaker.stop()
        images.client = client
        speaker.client = client
    }
}

/// A short buzz when something was answered, failed or taken back.
@MainActor
enum Haptics {
    static func play(_ feedback: Feedback) {
        switch feedback {
        case .decided: UINotificationFeedbackGenerator().notificationOccurred(.success)
        case .failed: UINotificationFeedbackGenerator().notificationOccurred(.error)
        case .tap: UIImpactFeedbackGenerator(style: .light).impactOccurred()
        }
    }
}

/// The in-app browser for links in messages: published pages (/a/<id>#key) and anything
/// else an agent links to. Presented from whatever is on top, so it also opens over a
/// question that is shown full screen.
@MainActor
enum Browser {
    static func open(_ url: URL) {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let windows = scenes.flatMap { $0.windows }
        let window = windows.first(where: { $0.isKeyWindow }) ?? windows.first
        guard let root = window?.rootViewController else { return }
        var top = root
        while let next = top.presentedViewController { top = next }
        top.present(SFSafariViewController(url: url), animated: true)
    }
}

@MainActor
enum Runtime {
    private static let laterKey = "trommi-later"

    /// The model as the app runs it. With the launch argument `-trommiStub 1` (UI tests)
    /// it starts on the demo board; otherwise on the stored server, or on the first screen.
    static func makeModel(media: Media) -> AppModel {
        let defaults = UserDefaults.standard
        var hooks = AppHooks()
        hooks.feedback = { Haptics.play($0) }
        hooks.loadLogin = { Keychain.load() }
        hooks.saveLogin = { Keychain.save($0) }
        hooks.clearLogin = { Keychain.clear() }
        hooks.loadLater = { defaults.data(forKey: laterKey) }
        hooks.saveLater = { defaults.set($0, forKey: laterKey) }
        hooks.demoData = {
            guard let url = Bundle.main.url(forResource: "demo-state", withExtension: "json") else { return nil }
            return try? Data(contentsOf: url)
        }
        hooks.clientChanged = { client in media.use(client) }
        let model = AppModel(hooks: hooks)
        if defaults.bool(forKey: "trommiStub") {
            model.startDemo(failing: defaults.string(forKey: "trommiStubFail"))
        } else {
            model.resume()
        }
        return model
    }
}
