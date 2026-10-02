// The text field with send, and the microphone when the server can transcribe.
import SwiftUI

struct Composer: View {
    @Environment(AppModel.self) private var model
    let agentID: String
    let placeholder: String
    @Binding var draft: String

    @State private var sending = false
    @State private var error: String?
    @State private var dictation = Dictation()

    private var canSend: Bool { !sending && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            InlineError(text: error ?? dictation.failure)
            HStack(alignment: .bottom, spacing: 8) {
                TextField(placeholder, text: $draft, axis: .vertical)
                    .lineLimit(1...6)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radiusLarge, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: Theme.radiusLarge, style: .continuous).strokeBorder(Theme.lineStrong, lineWidth: 1))
                    .accessibilityIdentifier("composer-field")
                if model.state.speech {
                    Button {
                        dictate()
                    } label: {
                        microphone
                    }
                    .font(.title2)
                    .frame(width: 40, height: 40)
                    .accessibilityLabel(dictation.label)
                    .accessibilityIdentifier("composer-mic")
                }
                Button {
                    send()
                } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.system(size: 32))
                }
                .disabled(!canSend)
                .frame(width: 40, height: 40)
                .accessibilityLabel("Send")
                .accessibilityIdentifier("composer-send")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
        .onDisappear { dictation.cancel() }
    }

    @ViewBuilder
    private var microphone: some View {
        switch dictation.phase {
        case .idle:
            Image(systemName: "mic")
        case .recording:
            Image(systemName: "stop.circle.fill").foregroundStyle(Theme.status(.decision))
        case .working:
            ProgressView()
        }
    }

    private func dictate() {
        dictation.toggle(transcribe: { audio in
            try await model.transcribe(audio)
        }, onText: { text in
            // The transcript joins what is already typed.
            let glue = draft.isEmpty || draft.last?.isWhitespace == true ? "" : " "
            draft += glue + text
        })
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        sending = true
        error = nil
        Task {
            do {
                try await model.send(text, to: agentID)
                // Only clear what was sent; the human may already be typing the next message.
                if draft.trimmingCharacters(in: .whitespacesAndNewlines) == text { draft = "" }
            } catch {
                Haptics.play(.failed)
                self.error = "Not sent: \(readable(error)). Your text stays here."
            }
            sending = false
        }
    }
}
