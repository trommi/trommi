// QRScanner.swift: the camera view that reads the pairing QR code a signed-in device shows (web app: menu → Devices →
// "Pair a device"). AVFoundation's metadata output, QR only; the first code that holds a pairing link ("#v2.") wins.
import SwiftUI
#if canImport(UIKit) && canImport(AVFoundation)
import AVFoundation
import UIKit

struct QRScannerView: UIViewRepresentable {
  /** Called once with the scanned text when it is a pairing link; other codes are ignored. */
  let onLink: (String) -> Void
  /** Called when the camera cannot be used (no permission, no camera). */
  let onUnavailable: (String) -> Void

  func makeUIView(context: Context) -> ScannerUIView {
    let v = ScannerUIView()
    v.onLink = onLink
    v.onUnavailable = onUnavailable
    v.start()
    return v
  }
  func updateUIView(_ uiView: ScannerUIView, context: Context) {}
  static func dismantleUIView(_ uiView: ScannerUIView, coordinator: ()) { uiView.stop() }
}

final class ScannerUIView: UIView, AVCaptureMetadataOutputObjectsDelegate {
  var onLink: ((String) -> Void)?
  var onUnavailable: ((String) -> Void)?
  private let session = AVCaptureSession()
  private var preview: AVCaptureVideoPreviewLayer?
  private var done = false

  override func layoutSubviews() {
    super.layoutSubviews()
    preview?.frame = bounds
  }

  func start() {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized: configure()
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video) { ok in
        DispatchQueue.main.async { ok ? self.configure() : self.onUnavailable?("Trommi may not use the camera. Allow it in Settings → Trommi, or paste the link.") }
      }
    default: onUnavailable?("Trommi may not use the camera. Allow it in Settings → Trommi, or paste the link.")
    }
  }

  private func configure() {
    guard let camera = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: camera), session.canAddInput(input) else {
      onUnavailable?("No camera on this device. Paste the link instead.")
      return
    }
    session.addInput(input)
    let output = AVCaptureMetadataOutput()
    guard session.canAddOutput(output) else { onUnavailable?("The camera cannot read codes right now."); return }
    session.addOutput(output)
    output.setMetadataObjectsDelegate(self, queue: .main)
    output.metadataObjectTypes = [.qr]
    let layer = AVCaptureVideoPreviewLayer(session: session)
    layer.videoGravity = .resizeAspectFill
    layer.frame = bounds
    self.layer.addSublayer(layer)
    preview = layer
    DispatchQueue.global(qos: .userInitiated).async { self.session.startRunning() }
  }

  func stop() {
    let s = session
    DispatchQueue.global(qos: .userInitiated).async { if s.isRunning { s.stopRunning() } }
  }

  func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
    guard !done else { return }
    for o in objects {
      guard let text = (o as? AVMetadataMachineReadableCodeObject)?.stringValue, text.contains("#v2.") else { continue }
      done = true
      UINotificationFeedbackGenerator().notificationOccurred(.success)
      stop()
      onLink?(text)
      return
    }
  }
}
#else
struct QRScannerView: View {
  let onLink: (String) -> Void
  let onUnavailable: (String) -> Void
  var body: some View { Text("No camera here.").onAppear { onUnavailable("No camera on this device. Paste the link instead.") } }
}
#endif
