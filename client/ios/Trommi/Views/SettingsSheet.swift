// Where the app is connected to, and the way out.
import SwiftUI

struct SettingsSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var confirm = false

    private var leaveTitle: String { model.isDemo ? "End the demo" : "Sign out" }

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    LabeledContent("Address", value: model.serverAddress)
                    LabeledContent("Connection", value: model.connection.text)
                    LabeledContent("Dictation and read-aloud", value: model.state.speech ? "set up" : "not set up")
                }
                Section {
                    Button(leaveTitle, role: .destructive) { confirm = true }
                        .accessibilityIdentifier("sign-out")
                } footer: {
                    Text(model.isDemo
                         ? "The demo runs only inside the app. Nothing of it reaches a server."
                         : "The token is removed from the Keychain. To sign in again you need the link from data/url.txt.")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog(model.isDemo ? "End the demo?" : "Really sign out?", isPresented: $confirm, titleVisibility: .visible) {
                Button(leaveTitle, role: .destructive) {
                    dismiss()
                    model.signOut()
                }
                Button("Cancel", role: .cancel) {}
            }
        }
    }
}
