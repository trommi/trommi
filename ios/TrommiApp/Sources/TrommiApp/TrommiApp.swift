// TrommiApp: the spike's iOS app. Sign in as the web app does: scan the QR code of "Pair a device" on a signed-in
// device (or paste its link) and compare the six emoji, or log in with email and password; then the open cards
// (title, options); tap an option to answer. Everything below the views is TrommiCore and
// TrommiClient, the same code `trommi-swift` runs and the tests check against the JS core.
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif
import TrommiClient
import TrommiCore

@main
struct TrommiApp: App {
  @StateObject private var model = BoardModel()
  #if canImport(UIKit)
  @UIApplicationDelegateAdaptor(PushDelegate.self) private var push   // Push.swift
  #endif
  var body: some Scene {
    WindowGroup {
      RootView().environmentObject(model)
      #if canImport(UIKit)
        .onAppear { push.model = model; push.ask() }
        .onChange(of: model.phase) { _, p in if p == .board { push.ask() } }
      #endif
    }
  }
}

@MainActor
final class BoardModel: ObservableObject {
  /** The screens before the board, as the web app's sign-in (app/web/public/auth.mjs: welcome, scan, join, log in). */
  enum Phase: Equatable { case start, scan, paste, email, deviceName(String), asking, checkCode(String), signingIn, pairFailed(String), board }
  /** The hub of app.trommi.com (app.mjs): email + password sign in there. A pairing link names its own hub. */
  static let hubURL = "https://hub.trommi.com"

  @Published var phase: Phase = .start
  @Published var cards: [Card] = []
  @Published var status: String = ""
  @Published var error: String?
  @Published var busy = false
  @Published var lastEmail = ""
  private var room: Room?
  private var joinTask: Task<Void, Never>?

  init() {
    if let id = Store.rooms(base: Store.defaultBase()).first, let r = try? Room.open(roomId: id) {
      room = r
      phase = .board
      Task { await refresh() }
    }
  }

  func go(_ p: Phase) { error = nil; phase = p }

  /** A scanned or pasted text: a pairing link carries "#v1." (as the web's scan page checks). */
  func gotLink(_ text: String) -> Bool {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard t.contains("#v1."), (try? parseInviteLink(t)) != nil else { return false }
    go(.deviceName(t))
    return true
  }

  /** Pair with a signed-in device: own keys, then six emoji to compare there; that device adds this one. */
  func pair(link: String, name: String) {
    error = nil
    phase = .asking
    joinTask = Task {
      do {
        let r = try await Room.join(link: link) { ev in
          if case .checkCode(let code) = ev { Task { @MainActor in if self.phase == .asking { self.phase = .checkCode(code) } } }
        }
        try await r.sendDeviceRegister(name: name, platform: "ios")
        room = r
        phase = .board
        await refresh()
      } catch is CancellationError {
      } catch {
        if Task.isCancelled { return }
        let why: String
        switch (error as? ZError)?.code {
        case "invite-used": why = "The code was used already."
        case "invite-expired": why = "The code has expired."
        case "code-mismatch": why = "The other device said the emoji did not match; the code is used up."
        default: why = describe(error)
        }
        phase = .pairFailed(why)
      }
    }
  }
  func cancelPairing() { joinTask?.cancel(); joinTask = nil; go(.scan) }

  /** Log in with email and password (shared/account.mjs loginWithPassword): this device adds itself to the room. */
  func login(email: String, password: String, name: String) async {
    lastEmail = email
    error = nil
    phase = .signingIn
    do {
      // The one place the sign-in's outcome is handled: a later "check your email" step of the hub lands here.
      switch try await Room.signInWithPassword(hubURL: Self.hubURL, email: email, password: password) {
      case .joined(let r):
        try await r.sendDeviceRegister(name: name, platform: "ios")
        room = r
        phase = .board
        await refresh()
      }
    } catch {
      self.error = accountError(error)
      phase = .email
    }
  }

  func refresh() async {
    guard let room = room else { return }
    busy = true
    defer { busy = false }
    do {
      let report = try await room.sync()
      cards = room.openCards
      status = "\(report.envelopes) verified" + (report.refused > 0 ? ", \(report.refused) refused" : "")
      error = report.warnings.first
    } catch { self.error = describe(error) }
  }

  func answer(_ card: Card, _ option: CardOption) async {
    guard let room = room else { return }
    busy = true
    defer { busy = false }
    do {
      _ = try await room.answer(cardId: card.id, choices: [option.key])
      await refresh()
    } catch { self.error = describe(error) }
  }

  /** The web's wording for the account errors (auth.mjs accountError). */
  private func accountError(_ e: Error) -> String {
    let code = (e as? ZError)?.code ?? (e as? HubError)?.code ?? ""
    switch code {
    case "wrong-login": return "Email or password is wrong."
    case "rate-limited": return "Too many tries. Please wait a few minutes."
    case "bad-email": return "That is not an email address."
    case "offline": return "Trommi is not reachable. Check the connection."
    case "room-exists": return "This device is signed in already."
    case "bad-recovery-code": return "This recovery code does not belong to this account."
    default: return describe(e)
    }
  }

  private func describe(_ e: Error) -> String {
    if let z = e as? ZError { return z.description }
    if let h = e as? HubError { return h.code == "offline" ? "Trommi is not reachable. Check the connection." : "hub: \(h.description)" }
    return "\(e)"
  }
}

/** What the web's name field guesses ("Phone"); iOS 16+ reports only the model, which is a fine default. */
enum UIDeviceName {
  static var current: String {
    #if canImport(UIKit)
    return UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
    #else
    return ProcessInfo.processInfo.hostName
    #endif
  }
}

struct RootView: View {
  @EnvironmentObject var model: BoardModel
  var body: some View {
    NavigationStack {
      Group {
        switch model.phase {
        case .start: StartView()
        case .scan: ScanView()
        case .paste: PasteView()
        case .email: EmailView()
        case .deviceName(let link): DeviceNameView(link: link)
        case .asking: Waiting(text: "Asking the other device…")
        case .checkCode(let code): CheckCodeView(code: code)
        case .signingIn: Waiting(text: "Logging in…")
        case .pairFailed(let why): PairFailedView(why: why)
        case .board: BoardView()
        }
      }
      .navigationTitle(title)
      .navigationBarTitleDisplayMode(model.phase == .start || model.phase == .board ? .large : .inline)
      .toolbar {
        if [.scan, .paste, .email].contains(model.phase) || { if case .deviceName = model.phase { return true }; return false }() {
          ToolbarItem(placement: .topBarLeading) { Button("Back") { model.go(.start) } }
        }
      }
    }
  }
  private var title: String {
    switch model.phase {
    case .start, .board: return "Trommi"
    case .email, .signingIn: return "Log in"
    default: return "Log in with a signed-in device"
    }
  }
}

struct Waiting: View {
  let text: String
  var body: some View { VStack(spacing: 12) { ProgressView(); Text(text).foregroundStyle(.secondary) }.frame(maxWidth: .infinity, maxHeight: .infinity) }
}

/** The start screen: scan (primary), email, and a small paste fallback. */
struct StartView: View {
  @EnvironmentObject var model: BoardModel
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Your agents ask, you answer, from any device. End-to-end encrypted: the hub carries sealed envelopes only.")
        .foregroundStyle(.secondary)
      Spacer()
      Button { model.go(.scan) } label: {
        Label("Scan QR code", systemImage: "qrcode.viewfinder").frame(maxWidth: .infinity)
      }
      .buttonStyle(.borderedProminent).controlSize(.large)
      Text("On a device that is logged in: menu → Devices → \u{201C}Pair a device\u{201D}. Then scan its code here.")
        .font(.footnote).foregroundStyle(.secondary)
      Button { model.go(.email) } label: {
        Label("Sign in with email", systemImage: "envelope").frame(maxWidth: .infinity)
      }
      .buttonStyle(.bordered).controlSize(.large)
      Button("Paste link") { model.go(.paste) }
        .font(.footnote).frame(maxWidth: .infinity)
        .padding(.top, 4)
    }
    .padding()
  }
}

struct ScanView: View {
  @EnvironmentObject var model: BoardModel
  @State private var unavailable: String?
  @State private var wrongCode = false
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("1. On the device that is logged in: menu → Devices → \u{201C}Pair a device\u{201D}.\n2. Hold its QR code in front of this camera.")
        .font(.subheadline)
      if let u = unavailable {
        Text(u).foregroundStyle(.secondary)
      } else {
        QRScannerView(onLink: { text in if !model.gotLink(text) { wrongCode = true } }, onUnavailable: { unavailable = $0 })
          .aspectRatio(1, contentMode: .fit)
          .clipShape(RoundedRectangle(cornerRadius: 12))
      }
      if wrongCode { Text("That is no pairing link.").foregroundStyle(.red).font(.footnote) }
      Spacer()
      Button("Paste the link instead") { model.go(.paste) }.font(.footnote).frame(maxWidth: .infinity)
    }
    .padding()
  }
}

struct PasteView: View {
  @EnvironmentObject var model: BoardModel
  @State private var link = ""
  @State private var wrong = false
  var body: some View {
    Form {
      Section {
        TextField("https://app.trommi.com/join#v1…", text: $link, axis: .vertical)
          .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL).lineLimit(2...5)
        Button("Next") { wrong = !model.gotLink(link) }.disabled(link.isEmpty)
      } header: { Text("Paste the link here") } footer: {
        Text(wrong ? "That is no pairing link. It contains \u{201C}#v1.\u{201D}." : "The link of \u{201C}Pair a device\u{201D} on a signed-in device (under \u{201C}No scanner? Send the link\u{201D}).")
          .foregroundStyle(wrong ? .red : .secondary)
      }
    }
  }
}

/** The web's join form: this device names itself, makes its own keys, then the six emoji. */
struct DeviceNameView: View {
  @EnvironmentObject var model: BoardModel
  let link: String
  @State private var name = UIDeviceName.current
  var body: some View {
    Form {
      Section { Text("This device now makes its own keys. Then both devices show six emoji; on the other device you confirm that they match.").foregroundStyle(.secondary) }
      Section("Name of this device") { TextField("Name of this device", text: $name).onChange(of: name) { _, v in if v.count > 40 { name = String(v.prefix(40)) } } }
      Section { Button("Next") { model.pair(link: link, name: name.trimmingCharacters(in: .whitespaces)) }.disabled(name.trimmingCharacters(in: .whitespaces).isEmpty) }
    }
  }
}

struct CheckCodeView: View {
  @EnvironmentObject var model: BoardModel
  let code: String
  var body: some View {
    VStack(spacing: 24) {
      Text("The other device shows six emoji too. If they are these, in this order, tap \u{201C}They match\u{201D} there:")
        .multilineTextAlignment(.center)
      let e = checkEmoji(code)
      LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 3), spacing: 16) {
        ForEach(Array(e.enumerated()), id: \.offset) { _, x in
          VStack { Text(x.emoji).font(.system(size: 48)); Text(x.word).font(.caption).foregroundStyle(.secondary) }
        }
      }
      .accessibilityLabel("Check code: \(e.map { $0.word }.joined(separator: ", "))")
      HStack(spacing: 8) { ProgressView(); Text("Waiting until it adds this device…").foregroundStyle(.secondary) }
      Text("They don\u{2019}t match? Tap \u{201C}They don\u{2019}t match\u{201D} there; the code is then used up.")
        .font(.footnote).multilineTextAlignment(.center).foregroundStyle(.secondary)
      Button("Cancel and scan again") { model.cancelPairing() }.font(.footnote)
    }
    .padding()
  }
}

struct PairFailedView: View {
  @EnvironmentObject var model: BoardModel
  let why: String
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Not logged in: \(why)").foregroundStyle(.red)
      Text("Show a new code on the other device.").foregroundStyle(.secondary)
      Button("Scan again") { model.go(.scan) }.buttonStyle(.borderedProminent)
      Button("Back") { model.go(.start) }
      Spacer()
    }
    .padding()
  }
}

/** Log in with email and password, as the web's "Log in" form. */
struct EmailView: View {
  @EnvironmentObject var model: BoardModel
  @State private var email = ""
  @State private var password = ""
  @State private var name = UIDeviceName.current
  var body: some View {
    Form {
      if let e = model.error { Section { Text(e).foregroundStyle(.red) } }
      Section {
        TextField("Email", text: $email)
          .textContentType(.username).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
        SecureField("Password", text: $password).textContentType(.password)
      }
      Section("Name of this device") { TextField("Name of this device", text: $name) }
      Section {
        Button("Log in") { Task { await model.login(email: email, password: password, name: name.trimmingCharacters(in: .whitespaces)) } }
          .disabled(email.isEmpty || password.isEmpty || name.trimmingCharacters(in: .whitespaces).isEmpty)
      } footer: {
        Text("Your password never leaves this device. Forgot it? Set a new one with your Emergency Kit at app.trommi.com.")
      }
    }
    .onAppear { if email.isEmpty { email = model.lastEmail } }
  }
}

struct BoardView: View {
  @EnvironmentObject var model: BoardModel
  var body: some View {
    List {
      if let e = model.error { Text(e).font(.footnote).foregroundStyle(.red) }
      if model.cards.isEmpty && !model.busy { Text("No open questions.").foregroundStyle(.secondary) }
      ForEach(model.cards, id: \.id) { card in
        VStack(alignment: .leading, spacing: 8) {
          HStack(alignment: .firstTextBaseline) {
            if card.urgency >= 2 { Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.orange) }
            Text(card.title.isEmpty ? "(no title)" : card.title).font(.headline)
          }
          if let body = card.body, !body.isEmpty { Text(body).font(.subheadline).foregroundStyle(.secondary).lineLimit(4) }
          if !card.options.isEmpty {
            HStack {
              ForEach(card.options, id: \.key) { o in
                Button(o.label) { Task { await model.answer(card, o) } }
                  .buttonStyle(.bordered)
                  .disabled(model.busy)
              }
            }
          }
        }
        .padding(.vertical, 4)
      }
      if !model.status.isEmpty { Text(model.status).font(.caption2).foregroundStyle(.tertiary) }
    }
    .refreshable { await model.refresh() }
    .toolbar { if model.busy { ProgressView() } }
  }
}
