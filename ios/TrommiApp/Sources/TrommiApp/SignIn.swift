// SignIn.swift: the screens before the board, as the web app's sign-in (app/web/public/auth.mjs): the start (scan, email,
// paste), the camera, the six emoji to compare, the email login.
import SwiftUI
import TrommiClient
import TrommiCore

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

