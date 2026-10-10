// SignIn.swift: the screens before the board, as the web app's (app/web/public/auth.mjs "ob"): one calm column, the
// bell and the name, a short headline, at most one line under it, one primary button, "Try the demo" at the foot.
// Start (Create account, Log in), Create account, Log in (with "Scan a code" as the quiet third way), New password
// (the Emergency Kit's words), Scan a code, the six emoji. A device is never asked for its name: it calls itself
// "iPhone" or "iPad" (UIDeviceName), renamed under Settings → Devices. The kit's page is KitScreen.swift.
//
// An account is named by ONE field at Log in and New password: "Email or account ID" (the id is printed on the
// Emergency Kit). With passkeys switched on (`Passkeys.available`) the passkey comes first on Create account and Log
// in, and needs no field: the email is optional beside it. Switched off, both screens are the password's alone.
import SwiftUI
import TrommiClient
#if canImport(UIKit)
import UIKit
import UniformTypeIdentifiers
#endif

// ---- the parts every screen uses ---------------------------------------------------------------------------------

/** One screen: the bell (the way back to the start), a headline, at most one line under it, the demo at the foot. */
struct ObShell<Content: View, Foot: View>: View {
  @EnvironmentObject var model: BoardModel
  let title: String
  var lead = ""
  var home = true
  /** The last word of the headline gets the pen's line under it (the start: "decide."). */
  var underlined = false
  @ViewBuilder var content: () -> Content
  @ViewBuilder var foot: () -> Foot
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        Button { model.go(.start) } label: {
          HStack(spacing: 8) {
            PenMark("ui:BELL", color: Ink.fg).frame(width: 26, height: 26)
            Text("Trommi").font(Face.display(20, .bold)).foregroundStyle(Ink.fg)
          }
        }
        .buttonStyle(QuietLink()).disabled(!home)
        .accessibilityLabel(home ? "Trommi: back to the start" : "Trommi")
        Group {
          if underlined { Greeting(text: title) } else { Text(title).font(Face.display(34, .heavy)).foregroundStyle(Ink.fg).accessibilityAddTraits(.isHeader) }
        }.padding(.top, 40)
        if !lead.isEmpty { Text(lead).font(Face.text(17)).foregroundStyle(Ink.muted).padding(.top, 10).fixedSize(horizontal: false, vertical: true) }
        VStack(alignment: .leading, spacing: 16) { content() }.padding(.top, 28)
        HStack(spacing: 18) {
          foot()
          // (a state of these screens opened from the demo's list: the way back to its room)
          if model.demo { Button("Back to the demo") { model.backToDemo() }.buttonStyle(ObLink()) }
          else { Button("Try the demo") { model.startDemo() }.buttonStyle(ObLink()).accessibilityHint("A made-up room on this device: nothing is sent") }
        }
        .frame(maxWidth: .infinity).padding(.top, 40)
      }
      .padding(.horizontal, 24).padding(.vertical, 28)
      .frame(maxWidth: 440).frame(maxWidth: .infinity)
    }
    .scrollDismissesKeyboard(.interactively)
    .background(Ink.bg.ignoresSafeArea())
  }
}
extension ObShell where Foot == EmptyView {
  init(title: String, lead: String = "", home: Bool = true, underlined: Bool = false, @ViewBuilder content: @escaping () -> Content) {
    self.init(title: title, lead: lead, home: home, underlined: underlined, content: content, foot: { EmptyView() })
  }
}

/** The one primary button of a screen; while it works it says so and cannot be pressed again. */
struct ObGo: ButtonStyle {
  @Environment(\.isEnabled) private var enabled
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.font(Face.text(18, .semibold)).foregroundStyle(Ink.accentFg)
      .frame(maxWidth: .infinity, minHeight: 54)
      .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Ink.accent))
      .opacity(!enabled ? 0.45 : configuration.isPressed ? 0.8 : 1)
  }
}
/** The second way of a screen: an outline. */
struct ObSecond: ButtonStyle {
  @Environment(\.isEnabled) private var enabled
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.font(Face.text(18, .semibold)).foregroundStyle(Ink.fg)
      .frame(maxWidth: .infinity, minHeight: 54)
      .background(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Ink.fg, lineWidth: 1.5))
      .contentShape(Rectangle())
      .opacity(!enabled ? 0.45 : configuration.isPressed ? 0.6 : 1)
  }
}
/** A quiet way in a line of text. */
struct ObLink: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.font(Face.text(16, .semibold)).foregroundStyle(Ink.accent).frame(minHeight: 44).contentShape(Rectangle())
      .opacity(configuration.isPressed ? 0.5 : 1)
  }
}
/** A small outlined word beside a thing (Show, Copy). */
struct ObChip: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.font(Face.text(15, .semibold)).foregroundStyle(Ink.fg)
      .padding(.horizontal, 14).frame(minHeight: 36)
      .background(Capsule().fill(Ink.surface)).overlay(Capsule().strokeBorder(Ink.fg, lineWidth: 1.5))
      .opacity(configuration.isPressed ? 0.6 : 1)
  }
}
extension View {
  /** A field of these screens: one outlined line. */
  func obInput() -> some View {
    self.font(Face.text(17)).padding(.horizontal, 14).frame(minHeight: 50)
      .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Ink.surface))
      .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Ink.lineStrong, lineWidth: 1.5))
  }
}
func obLabel(_ s: String) -> some View { Text(s).font(Face.text(14, .semibold)).foregroundStyle(Ink.fg) }

/** The one line a form says when it failed: its place is kept, so nothing jumps. */
struct ObError: View {
  let text: String?
  var body: some View {
    Text(text ?? " ").font(Face.text(15)).foregroundStyle(Ink.urgCritical).frame(maxWidth: .infinity, minHeight: 22, alignment: .leading)
      .accessibilityHidden(text == nil)
  }
}

struct ObEmail: View {
  @Binding var text: String
  /** What the field asks for: the email, or (Log in, New password) the email or the account id. */
  var label = "Email"
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      obLabel(label)
      TextField("", text: $text)
        .textContentType(.username).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
        .accessibilityLabel(label)
        .obInput()
    }
  }
}
/** The field that names an account by its email or its account id. */
let ACCOUNT_FIELD = "Email or account ID"

/** The line between two ways of one screen. */
struct ObOr: View {
  var body: some View {
    HStack(spacing: 12) {
      Rectangle().fill(Ink.line).frame(height: 1)
      Text("or").font(Face.text(14)).foregroundStyle(Ink.muted)
      Rectangle().fill(Ink.line).frame(height: 1)
    }
  }
}

/**
 * A password: Show/Hide in the field. A new one with the rule counted down live and "Generate": five words, put into
 * the field and shown in full on a slip under it, with Copy (the slip goes when the field is typed in).
 */
struct ObPassword<Side: View>: View {
  var label = "Password"
  var fresh = false
  @Binding var text: String
  /** The rule failed at the last try: its line turns red until the field changes. */
  @Binding var bad: Bool
  @ViewBuilder var side: () -> Side
  @State private var shown = false
  @State private var made = ""
  @State private var copied = false
  /** Opens with a generated password already in the field (a drawn state of the demo). */
  var generated = false
  init(label: String = "Password", fresh: Bool = false, generated: Bool = false, text: Binding<String>, bad: Binding<Bool> = .constant(false), @ViewBuilder side: @escaping () -> Side) {
    self.generated = generated
    self.label = label; self.fresh = fresh; _text = text; _bad = bad; self.side = side
  }
  var body: some View {
    let n = text.precomposedStringWithCanonicalMapping.count
    let isMade = !made.isEmpty && made == text
    VStack(alignment: .leading, spacing: 6) {
      HStack { obLabel(label); Spacer(); side() }
      HStack(spacing: 8) {
        Group {
          if shown { TextField("", text: $text) } else { SecureField("", text: $text) }
        }
        .textContentType(fresh ? .newPassword : .password).textInputAutocapitalization(.never).autocorrectionDisabled()
        .accessibilityLabel(label)
        Button(shown ? "Hide" : "Show") { shown.toggle() }.buttonStyle(ObLink())
      }
      .obInput()
      if fresh {
        if isMade {
          HStack(spacing: 10) {
            Text(made).font(Face.mono(15, .medium)).foregroundStyle(Ink.fg).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button(copied ? "Copied" : "Copy") { copySecret(made); copied = true }.buttonStyle(ObChip())
          }
          .padding(12).background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Ink.sunken))
        }
        HStack {
          Text(isMade ? "Save it in your password manager." : bad ? PW_RULE : n == 0 ? PW_RULE : n < PASSWORD_MIN ? "\(PASSWORD_MIN - n) more" : "Long enough")
            .font(Face.text(14)).foregroundStyle(bad && !isMade ? Ink.urgCritical : n >= PASSWORD_MIN ? Ink.accent : Ink.muted)
          Spacer()
          Button("Generate") { made = generatePassword(); text = made; shown = false; copied = false; bad = false }
            .buttonStyle(ObLink()).accessibilityHint("Five random words")
        }
      }
    }
    .onChange(of: text) { _, _ in bad = false; copied = false }
    .onAppear { if generated && text.isEmpty { made = generatePassword(); text = made } }
  }
}
extension ObPassword where Side == EmptyView {
  init(label: String = "Password", fresh: Bool = false, generated: Bool = false, text: Binding<String>, bad: Binding<Bool> = .constant(false)) {
    self.init(label: label, fresh: fresh, generated: generated, text: text, bad: bad, side: { EmptyView() })
  }
}
let PW_RULE = "At least \(PASSWORD_MIN) characters"

/** A secret onto the clipboard: this device only (no Handoff), gone after two minutes. */
func copySecret(_ s: String) {
  #if canImport(UIKit)
  UIPasteboard.general.setItems([[UTType.utf8PlainText.identifier: s]], options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(120)])
  #endif
}

/** A form's email, checked with a human word; nil (and the word said) when it is missing or no address. */
@MainActor func checkedEmail(_ email: String, _ model: BoardModel) -> String? {
  let e = email.trimmingCharacters(in: .whitespacesAndNewlines)
  if (try? normaliseEmail(e)) == nil { model.error = e.isEmpty ? "Enter your email." : "That is not an email address."; return nil }
  return e
}
/** A form's "Email or account ID", checked with a human word; nil (and the word said) when it is missing or neither. */
@MainActor func checkedAccount(_ text: String, _ model: BoardModel) -> String? {
  let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
  if looksLikeAccountId(t) || (try? normaliseEmail(t)) != nil { return t }
  model.error = t.isEmpty ? "Enter your email or account ID." : "That is not an email address or an account ID."
  return nil
}

// ---- the screens ----------------------------------------------------------------------------------------------

/** The start: "Agents ask. You decide." with Create account (primary) and Log in. */
struct StartView: View {
  @EnvironmentObject var model: BoardModel
  var body: some View {
    ObShell(title: "Agents ask. You decide.", lead: "A desk for your Claude Code sessions, end-to-end encrypted.", home: false, underlined: true) {
      if model.loggedOut { Text("Logged out.").font(Face.text(15, .medium)).foregroundStyle(Ink.accent) }
      if let e = model.error { ObError(text: e) }
      VStack(spacing: 12) {
        Button("Create account") { model.go(.create) }.buttonStyle(ObGo())
        Button("Log in") { model.go(.email) }.buttonStyle(ObSecond())
      }
    }
  }
}

/**
 * Create account: email and a new password. The device founds the account and its Emergency Kit is made at once.
 * With passkeys switched on the passkey comes first: the email, which is optional beside it, then "Create with
 * passkey" as the screen's primary button, then the password as the second way (it needs the email).
 */
struct CreateView: View {
  @EnvironmentObject var model: BoardModel
  @State private var email = ""
  @State private var password = ""
  @State private var bad = false
  var body: some View {
    ObShell(title: "Create account") {
      if Passkeys.available {
        ObEmail(text: $email, label: "Email (optional with a passkey)")
        Button(model.signing ? "Creating…" : "Create with passkey") { createWithPasskey() }.buttonStyle(ObGo()).disabled(model.signing)
        ObOr()
        ObPassword(fresh: true, generated: model.demoOnboard == "create-generated", text: $password, bad: $bad)
        ObError(text: model.error)
        Button(model.signing ? "Creating…" : "Create account") { create() }.buttonStyle(ObSecond()).disabled(model.signing)
      } else {
        ObEmail(text: $email)
        ObPassword(fresh: true, generated: model.demoOnboard == "create-generated", text: $password, bad: $bad)
        ObError(text: model.error)
        Button(model.signing ? "Creating…" : "Create account") { create() }.buttonStyle(ObGo()).disabled(model.signing)
      }
      HStack(spacing: 6) {
        Text("Have an account?").font(Face.text(16)).foregroundStyle(Ink.muted)
        Button("Log in") { model.go(.email) }.buttonStyle(ObLink())
      }.frame(maxWidth: .infinity)
    }
    .onAppear {
      if email.isEmpty { email = model.lastEmail }
      // (the demo's list of screens: the states of this form, drawn only)
      switch model.demoOnboard {
      case "create-typing": password = "seven77"
      case "create-error": password = "short"; bad = true
      case "create-busy", "create-offline", "create-limit": password = "a long enough password"
      default: break
      }
    }
    .onChange(of: email) { _, _ in model.error = nil }
    .onChange(of: password) { _, _ in model.error = nil }
  }
  private func create() {
    guard let e = checkedEmail(email, model) else { return }
    if passwordProblem(password) != nil { model.error = nil; bad = true; return }
    Task { await model.create(email: e, password: password) }
  }
  /** An empty field is no email; one that is typed must be an address. */
  private func createWithPasskey() {
    var e = email.trimmingCharacters(in: .whitespacesAndNewlines)
    if !e.isEmpty { guard let checked = checkedEmail(e, model) else { return }; e = checked }
    Task { await model.createWithPasskey(email: e) }
  }
}

/**
 * Log in with password; "Scan a code" is the quiet third way. One field names the account: its email or its account
 * id. With passkeys switched on "Log in with passkey" comes first, as the screen's primary button and with no field
 * (the passkey names its account itself); the password is then the second way.
 */
struct EmailView: View {
  @EnvironmentObject var model: BoardModel
  @State private var email = ""
  @State private var password = ""
  var body: some View {
    ObShell(title: "Log in") {
      if Passkeys.available {
        Button("Log in with passkey") { Task { await model.loginWithPasskey() } }.buttonStyle(ObGo()).disabled(model.signing)
        ObOr()
      }
      ObEmail(text: $email, label: ACCOUNT_FIELD)
      ObPassword(text: $password, bad: .constant(false)) { Button("Forgot?") { model.go(.forgot) }.buttonStyle(ObLink()).frame(height: 20) }
      ObError(text: model.error)
      if Passkeys.available {
        Button(model.signing ? "Logging in…" : "Log in") { login() }.buttonStyle(ObSecond()).disabled(model.signing)
      } else {
        Button(model.signing ? "Logging in…" : "Log in") { login() }.buttonStyle(ObGo()).disabled(model.signing)
      }
      ObOr()
      Button("Scan a code") { model.go(.scan) }.buttonStyle(ObSecond()).disabled(model.signing)
      HStack(spacing: 6) {
        Text("New here?").font(Face.text(16)).foregroundStyle(Ink.muted)
        Button("Create account") { model.go(.create) }.buttonStyle(ObLink())
      }.frame(maxWidth: .infinity)
    }
    .onAppear {
      if email.isEmpty { email = model.lastEmail }
      if model.demoOnboard == "login-error" { password = "not my password" }
    }
  }
  private func login() {
    guard let a = checkedAccount(email, model) else { return }
    if password.isEmpty { model.error = "Enter your password."; return }
    Task { await model.login(account: a, password: password) }
  }
}

/**
 * New password: the account's email or account id, the twelve words of the Emergency Kit, a new password (auth.mjs
 * forgotFlow). Named by its account id, the account is one without an email: it has no password, so none is asked
 * for and the words log this device in.
 */
struct ForgotView: View {
  @EnvironmentObject var model: BoardModel
  @State private var email = ""
  @State private var words = ""
  @State private var password = ""
  @State private var bad = false
  var body: some View {
    let byId = looksLikeAccountId(email)
    ObShell(title: "New password", lead: "With the words of your Emergency Kit.") {
      ObEmail(text: $email, label: ACCOUNT_FIELD)
      VStack(alignment: .leading, spacing: 6) {
        obLabel("Twelve words")
        TextField("", text: $words, axis: .vertical).lineLimit(3...5)
          .textInputAutocapitalization(.never).autocorrectionDisabled()
          .accessibilityLabel("Twelve words")
          .padding(.vertical, 12).obInput()
      }
      if !byId { ObPassword(label: "New password", fresh: true, text: $password, bad: $bad) }
      ObError(text: model.error)
      Button(model.signing ? (byId ? "Logging in…" : "Setting…") : (byId ? "Log in" : "Set password")) {
        guard let a = checkedAccount(email, model) else { return }
        if (try? parseRecoveryWords(words)) == nil { model.error = "Check the twelve words."; return }
        if !byId && passwordProblem(password) != nil { model.error = nil; bad = true; return }
        Task { await model.forgot(account: a, words: words, password: byId ? nil : password) }
      }
      .buttonStyle(ObGo()).disabled(model.signing)
      Button("Back to log in") { model.go(.email) }.buttonStyle(ObLink()).frame(maxWidth: .infinity)
    }
    .onAppear { if email.isEmpty { email = model.lastEmail } }
  }
}

/** Scan the code a logged-in device shows, or paste its link. Then this device asks at once: no name, no second step. */
struct ScanView: View {
  @EnvironmentObject var model: BoardModel
  @State private var camera = true
  @State private var link = ""
  var body: some View {
    ObShell(title: "Scan a code", lead: "On a logged-in device: Settings → Invite a Device.") {
      if camera && !model.demo {
        QRScannerView(onLink: { text in if !model.gotLink(text) { model.error = "That is not a Trommi link." } }, onUnavailable: { _ in camera = false })
          .aspectRatio(1, contentMode: .fit)
          .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
      }
      VStack(alignment: .leading, spacing: 6) {
        obLabel(camera && !model.demo ? "Or paste its link" : "Paste its link")
        TextField("https://app.trommi.com/join#v2…", text: $link)
          .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
          .accessibilityLabel("Its link")
          .obInput()
      }
      ObError(text: model.error)
      Button("Next") { if !model.gotLink(link) { model.error = "That is not a Trommi link." } }.buttonStyle(ObGo())
      Button("Back to log in") { model.go(.email) }.buttonStyle(ObLink()).frame(maxWidth: .infinity)
    }
  }
}

/** The join is on its way: this device made its keys and asked. */
struct AskingView: View {
  var body: some View {
    ObShell(title: "Log in") {
      HStack(spacing: 10) { ProgressView(); Text("Asking the other device…").font(Face.text(17)).foregroundStyle(Ink.muted) }
    }
  }
}

struct CheckCodeView: View {
  @EnvironmentObject var model: BoardModel
  let code: String
  var body: some View {
    ObShell(title: "Same six emoji?", lead: "If they match, tap “They match” on the other device.", home: false) {
      let e = checkEmoji(code)
      LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 3), spacing: 16) {
        ForEach(Array(e.enumerated()), id: \.offset) { _, x in
          VStack { Text(x.emoji).font(.system(size: 48)); Text(x.word).font(Face.text(13)).foregroundStyle(Ink.muted) }
        }
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("Check code: \(e.map { $0.word }.joined(separator: ", "))")
      HStack(spacing: 10) { ProgressView(); Text("Waiting for the other device…").font(Face.text(17)).foregroundStyle(Ink.muted) }
      Button("Cancel") { model.cancelPairing() }.buttonStyle(ObLink()).frame(maxWidth: .infinity)
    }
  }
}

struct PairFailedView: View {
  @EnvironmentObject var model: BoardModel
  let why: String
  var body: some View {
    ObShell(title: "Not logged in", lead: "Show a new code on the other device.") {
      ObError(text: why)
      Button("Scan again") { model.go(.scan) }.buttonStyle(ObGo())
    }
  }
}
