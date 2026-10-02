// The first screen: paste or scan the link from data/url.txt, try it, keep it.
import SwiftUI
import VisionKit
import AVFoundation

struct OnboardingView: View {
    @Environment(AppModel.self) private var model
    @State private var link = ""
    @State private var working = false
    @State private var error: String?
    @State private var scanning = false
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Trommi").font(.largeTitle.weight(.bold)).foregroundStyle(Theme.fg)
                        Text("Your agents put questions in front of you. Here you answer them, the most urgent first.")
                            .font(.body)
                            .foregroundStyle(Theme.muted)
                    }
                    .padding(.top, 24)

                    VStack(alignment: .leading, spacing: 10) {
                        Text("Link to the server").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.fg)
                        TextField("http://computer:8790/?t=TOKEN", text: $link, axis: .vertical)
                            .lineLimit(1...4)
                            .font(.system(.callout, design: .monospaced))
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                            .focused($focused)
                            .padding(12)
                            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).strokeBorder(Theme.lineStrong, lineWidth: 1))
                            .accessibilityIdentifier("login-link")
                        Text("The link is on the server's machine in data/url.txt. Take the line with the address in the network, not localhost.")
                            .font(.footnote)
                            .foregroundStyle(Theme.muted)
                        HStack(spacing: 10) {
                            PasteButton(payloadType: String.self) { strings in
                                if let first = strings.first { link = first.trimmingCharacters(in: .whitespacesAndNewlines) }
                            }
                            .labelStyle(.titleAndIcon)
                            if DataScannerViewController.isSupported {
                                Button { scanning = true } label: { Label("Scan QR code", systemImage: "qrcode.viewfinder") }
                                    .buttonStyle(.bordered)
                                    .accessibilityIdentifier("login-scan")
                            }
                        }
                    }

                    InlineError(text: error ?? model.onboardingMessage)

                    Button(action: connect) {
                        HStack(spacing: 8) {
                            if working { ProgressView().tint(Theme.accentFg) }
                            Text(working ? "Connecting" : "Connect")
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(LeadButtonStyle())
                    .disabled(working || link.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("login-connect")

                    Button("Look at the demo") { model.startDemo() }
                        .frame(maxWidth: .infinity)
                        .accessibilityIdentifier("login-demo")
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 24)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.bg)
            .toolbar(.hidden, for: .navigationBar)
            .sheet(isPresented: $scanning) {
                ScannerSheet { found in
                    scanning = false
                    link = found
                    connect()
                }
            }
        }
    }

    private func connect() {
        focused = false
        error = nil
        model.onboardingMessage = nil
        let parsed: ServerLink
        do { parsed = try ServerLink.parse(link) } catch {
            self.error = readable(error)
            return
        }
        working = true
        Task {
            do {
                try await withTimeout(seconds: 12) { try await model.signIn(parsed) }
            } catch {
                self.error = "Not connected: \(readable(error))"
            }
            working = false
        }
    }
}

/// Runs `work`, but gives up after `seconds` with "the server did not answer".
@MainActor
private func withTimeout(seconds: Double, _ work: @escaping @MainActor () async throws -> Void) async throws {
    let task = Task { @MainActor in try await work() }
    let timer = Task {
        try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        task.cancel()
    }
    defer { timer.cancel() }
    do {
        try await task.value
    } catch is CancellationError {
        throw ClientError.unreachable("")
    }
}

/// Camera sheet that reads a QR code holding the login link.
private struct ScannerSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onFound: (String) -> Void
    @State private var allowed: Bool?

    var body: some View {
        NavigationStack {
            Group {
                if allowed == true {
                    LinkScanner(onFound: onFound).ignoresSafeArea(edges: .bottom)
                } else if allowed == false {
                    VStack(spacing: 10) {
                        Image(systemName: "camera.fill").font(.largeTitle).foregroundStyle(Theme.faint)
                        Text("No access to the camera. Allow it in Settings, or paste the link.")
                            .multilineTextAlignment(.center)
                            .foregroundStyle(Theme.muted)
                    }
                    .padding(32)
                } else {
                    ProgressView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .navigationTitle("Scan QR code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            .task { allowed = await AVCaptureDevice.requestAccess(for: .video) }
        }
    }
}

private struct LinkScanner: UIViewControllerRepresentable {
    let onFound: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onFound: onFound) }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced,
                                                recognizesMultipleItems: false, isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        if !scanner.isScanning { try? scanner.startScanning() }
    }

    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
        scanner.stopScanning()
    }

    @MainActor
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onFound: (String) -> Void
        private var done = false

        init(onFound: @escaping (String) -> Void) { self.onFound = onFound }

        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !done else { return }
            for item in addedItems {
                if case .barcode(let code) = item, let text = code.payloadStringValue, (try? ServerLink.parse(text)) != nil {
                    done = true
                    Haptics.play(.tap)
                    onFound(text)
                    return
                }
            }
        }
    }
}
