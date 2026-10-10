// KitScreen.swift: the Emergency Kit's page (app/web/public/auth.mjs kitPage and kitGate). The kit is made with the
// account, always; this page comes right after and stays until "Open Trommi": a sheet of paper whose twelve words are
// hidden behind drawn strokes until "Show" (hidden, the page holds none of the words: no text, nothing for VoiceOver),
// Save (the share sheet with the kit as a file, the web's download word for word), Print, and "Open Trommi" once it was
// shown, saved or printed. The sheet also carries the account id, as text and as a QR code that holds the app's
// address with hub and id (never the words): both are public and are not hidden. While the account's register `kit` says { pending: true } every device opens here; after a
// relaunch the words are gone (they live in this page's model only, never on disk, in a log or in a default), so the
// page asks for the password and makes a new kit, which replaces the unseen one.
import SwiftUI
import TrommiClient
#if canImport(UIKit)
import UIKit
#endif
import UniformTypeIdentifiers

/** The kit's page is up: the account's email, the words while this launch still has them, and the account id. */
struct KitGate: Equatable {
  /** Empty for an account without an email. */
  var email: String
  var words: String?
  /** The account id the sheet prints; empty while it is not known. */
  var accountId = ""
}

/** The kit as a file for the share sheet: made in memory when the system asks for it. */
struct KitFile: Transferable {
  let text: String
  static var transferRepresentation: some TransferRepresentation {
    DataRepresentation(exportedContentType: .plainText) { Data($0.text.utf8) }.suggestedFileName(KIT_FILE_NAME)
  }
}

/** The lengths of the strokes that stand for the hidden words: the web's made-up twelve, never the real ones. */
private let KIT_STROKES: [Int] = [5, 7, 5, 5, 6, 6, 6, 6, 5, 7, 6, 6]   // orbit lantern maple quiet saddle copper violin harbor ember thistle canyon pepper

struct KitScreen: View {
  @EnvironmentObject var model: BoardModel
  @Environment(\.scenePhase) private var scenePhase
  let gate: KitGate
  @State private var shown = false
  @State private var saved = false
  @State private var password = ""
  @State private var error: String?
  @State private var busy = false
  var body: some View {
    Group {
      if let words = gate.words { kit(words) } else { again }
    }
    // (the words are not left on screen for the app switcher's picture)
    .onChange(of: scenePhase) { _, p in if p != .active { shown = false } }
    .onAppear {
      // (the demo's list of screens: shown, or after a reload with a wrong password)
      if model.demoOnboard == "kit-shown" { shown = true; saved = true }
      if model.demoOnboard == "kit-wrong" { error = "Wrong password." }
    }
  }

  /** With the words: the sheet, Show, Save, Print, Open Trommi. */
  private func kit(_ words: String) -> some View {
    let whole = EmergencyKit(words: words, email: gate.email, accountId: gate.accountId)
    let qr = model.kitQR(gate.accountId)
    return ObShell(title: "Your Emergency Kit", lead: "Twelve words that set a new password if you forget yours.", home: false) {
      VStack(spacing: 12) {
        Button { flip() } label: { KitSheet(email: gate.email, words: shown ? words : nil, accountId: gate.accountId, qr: qr) }
          .buttonStyle(.plain)
          .accessibilityLabel(shown ? "Your Emergency Kit, shown" : "Your Emergency Kit, hidden")
          .accessibilityHint(shown ? "Hides the twelve words" : "Shows the twelve words")
        Button(shown ? "Hide" : "Show") { flip() }.buttonStyle(ObChip())
      }
      .frame(maxWidth: .infinity)
      HStack(spacing: 12) {
        if model.demo { Button("Save") { saved = true }.buttonStyle(ObSecond()) } else {
          ShareLink(item: KitFile(text: emergencyKitText(whole)), preview: SharePreview(KIT_FILE_NAME)) { Text("Save") }
            .buttonStyle(ObSecond())
            .simultaneousGesture(TapGesture().onEnded { saved = true })
        }
        Button("Print") { saved = true; if !model.demo { printKit(whole, qr: qr) } }.buttonStyle(ObSecond())
      }
      Text("Without it or your password, nobody can recover your account. Not even Trommi.").font(Face.text(15)).foregroundStyle(Ink.muted)
        .fixedSize(horizontal: false, vertical: true)
      ObError(text: error)
      Button("Open Trommi") {
        busy = true; error = nil
        Task {
          if await model.kitSaved() == false { error = "Not saved yet. Try again." }
          busy = false
        }
      }
      .buttonStyle(ObGo()).disabled(!saved || busy)
      if !saved { Text("Save, print or show it first.").font(Face.text(14)).foregroundStyle(Ink.muted).frame(maxWidth: .infinity) }
    }
  }
  private func flip() { shown.toggle(); if shown { saved = true } }

  /** After a relaunch: the words are gone, the password makes a new kit. */
  private var again: some View {
    ObShell(title: "Your Emergency Kit", lead: "Enter your password to make it.", home: false, content: {
      ObPassword(text: $password)
      ObError(text: error)
      Button(busy ? "Making…" : "Make kit") {
        if password.isEmpty { error = "Enter your password."; return }
        busy = true; error = nil
        let p = password
        Task {
          error = await model.makeKit(password: p)
          if error == nil { password = "" }
          busy = false
        }
      }
      .buttonStyle(ObGo()).disabled(busy)
    }, foot: {
      if !model.demo { Button("Log out") { model.logOut() }.buttonStyle(ObLink()) }
    })
  }
}

/**
 * The kit as a sheet of paper: the bell and its name, the email, the account id (as a QR code and as text), twelve
 * numbered places, and how it is used. Hidden (words nil) each place is a drawn stroke and the sheet holds no word at
 * all; shown, the words stand there. The account id is public and always shown; `qr` is the text of its QR code
 * (BoardModel.kitQR: the app's address with hub and id, never the words).
 */
struct KitSheet: View {
  let email: String
  let words: [String]?
  let accountId: String
  let qr: String?
  init(email: String, words: String?, accountId: String = "", qr: String? = nil) {
    self.email = email; self.words = words?.split(separator: " ").map(String.init); self.accountId = accountId; self.qr = qr
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 8) {
        PenMark("ui:BELL", color: Ink.fg).frame(width: 22, height: 22)
        Text("Trommi Emergency Kit").font(Face.text(16, .bold)).foregroundStyle(Ink.fg)
      }
      if !email.isEmpty { Text(email).font(Face.text(14)).foregroundStyle(Ink.muted).lineLimit(1).truncationMode(.middle) }
      if !accountId.isEmpty {
        VStack(alignment: .leading, spacing: 4) {
          if let qr = qr {
            QRCode(text: qr, label: "QR code with your account ID").frame(width: 96, height: 96)
              .padding(6).background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(.white))
          }
          Text("Account ID").font(Face.text(12, .semibold)).foregroundStyle(Ink.muted)
          Text(accountId).font(Face.mono(13)).foregroundStyle(Ink.fg).lineLimit(1).minimumScaleFactor(0.6)
        }
      }
      LazyVGrid(columns: [GridItem(.flexible(), alignment: .leading), GridItem(.flexible(), alignment: .leading)], alignment: .leading, spacing: 10) {
        ForEach(0..<12, id: \.self) { i in
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("\(i + 1)").font(Face.mono(13)).foregroundStyle(Ink.faint).frame(width: 20, alignment: .trailing)
            if let w = words, i < w.count {
              Text(w[i]).font(Face.mono(17, .medium)).foregroundStyle(Ink.fg).lineLimit(1).minimumScaleFactor(0.7)
            } else {
              PenUnderline().stroke(Ink.fg.opacity(0.75), style: StrokeStyle(lineWidth: 3.2, lineCap: .round))
                .frame(width: CGFloat(3 + KIT_STROKES[i]) * 8, height: 8).frame(height: 22)
            }
          }
        }
      }
      .accessibilityHidden(words == nil)
      Text("Forgot your password? app.trommi.com → Log in → Forgot password → your \(email.isEmpty ? "account ID" : "email") and these 12 words.")
        .font(Face.text(12)).foregroundStyle(Ink.muted).fixedSize(horizontal: false, vertical: true)
    }
    .padding(18)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(PenBox(r: 14).fill(Ink.surface))
    .overlay(PenBox(r: 14).stroke(Ink.fg, lineWidth: 1.8))
    .background(PenBox(r: 14).fill(Ink.lineStrong).offset(y: 4))
  }
}

/**
 * Print the kit (the system's print sheet): one page with the words, the account id and, when `qr` is given, its QR
 * code (the picture travels inside the page's text); nothing is written to a file here.
 */
@MainActor func printKit(_ kit: EmergencyKit, qr: String?) {
  #if canImport(UIKit)
  func esc(_ s: String) -> String { s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;") }
  let rows = kit.words.split(separator: " ").enumerated().map { "<li>\(esc(String($0.element)))</li>" }.joined()
  let name = kit.email.isEmpty ? "account ID" : "email"
  let picture = qr.flatMap { qrImage($0)?.pngData() }.map { "<p><img width=\"120\" height=\"120\" src=\"data:image/png;base64,\($0.base64EncodedString())\"></p>" } ?? ""
  let id = kit.accountId.isEmpty ? "" : "\(picture)<p>Account ID: <b style=\"font-family: Menlo, monospace;\">\(esc(kit.accountId))</b></p>"
  let email = kit.email.isEmpty ? "" : "<p>Email: <b>\(esc(kit.email))</b></p>"
  let html = """
  <html><body style="font-family: -apple-system, Helvetica, sans-serif; font-size: 13pt; margin: 36pt;">
  <h1 style="font-size: 20pt;">Trommi Emergency Kit</h1>
  \(id)\(email)
  <ol style="font-family: Menlo, monospace; font-size: 15pt; line-height: 1.7; columns: 2;">\(rows)</ol>
  <p>Forgot your password? Open https://app.trommi.com, choose "Log in", then "Forgot password?". \(kit.email.isEmpty ? "Enter your account ID and these 12 words." : "Enter your email and these 12 words, then choose a new password.")</p>
  <p>Keep this kit private and offline: with these words and your \(name), anyone can get into your account. If you lose your password and your Emergency Kit, nobody (not even Trommi) can recover your data.</p>
  </body></html>
  """
  let info = UIPrintInfo(dictionary: nil)
  info.outputType = .general
  info.jobName = "Trommi Emergency Kit"
  let c = UIPrintInteractionController.shared
  c.printInfo = info
  c.printFormatter = UIMarkupTextPrintFormatter(markupText: html)
  c.present(animated: true) { c, _, _ in c.printFormatter = nil }   // (the shared controller does not keep the words)
  #endif
}
