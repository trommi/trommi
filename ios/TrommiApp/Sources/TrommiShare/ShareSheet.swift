// The share sheet's face: system chrome (Liquid Glass on iOS 26+: the navigation bar, the mode switch, the button),
// Trommi's look for the content (the note's yellow paper, the session tree with the crown, IBM Plex Sans).
import Foundation
import ShareInbox
#if canImport(UIKit)
import SwiftUI
import UIKit

enum SInk {
  static let noteYellow = Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 0xd9 / 255, green: 0xc3 / 255, blue: 0x5f / 255, alpha: 1) : UIColor(red: 0xf5 / 255, green: 0xd6 / 255, blue: 0x4a / 255, alpha: 1) })
  static let noteInk = Color(red: 0x3b / 255, green: 0x30 / 255, blue: 0x0d / 255)
  static let accent = Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 0x6f / 255, green: 0xd0 / 255, blue: 0xb5 / 255, alpha: 1) : UIColor(red: 0x1b / 255, green: 0x6a / 255, blue: 0x57 / 255, alpha: 1) })
  static let gold = Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 0xdc / 255, green: 0xb8 / 255, blue: 0x4e / 255, alpha: 1) : UIColor(red: 0xa8 / 255, green: 0x82 / 255, blue: 0x0f / 255, alpha: 1) })
  /** A session's colour from its hue (a simple stand-in for the app's oklch tones). */
  static func hue(_ h: Int) -> Color { Color(hue: Double((h + 10) % 360) / 360, saturation: 0.45, brightness: 0.62) }
}
enum SFace {
  static func text(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
    let name = weight == .semibold || weight == .bold ? "IBMPlexSans-SemiBold" : weight == .medium ? "IBMPlexSans-Medium" : "IBMPlexSans-Regular"
    return UIFont(name: name, size: size) != nil ? .custom(name, size: size, relativeTo: .body) : .system(size: size, weight: weight)
  }
}

struct ShareRoot: View {
  @ObservedObject var model: ShareModel
  @FocusState private var typing: Bool

  var body: some View {
    NavigationStack {
      Group {
        if model.inbox == nil { unavailable }
        else {
          switch model.phase {
          case .done(let line): done(line)
          default: form
          }
        }
      }
      .navigationTitle("Trommi")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button(L("Cancel", "Abbrechen")) { model.cancel() }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button(model.mode == .note ? L("Add", "Hinzufügen") : L("Send", "Senden")) { model.go() }
            .fontWeight(.semibold)
            .disabled(!model.canGo)
        }
      }
    }
  }

  // ---- the form ----------------------------------------------------------------------------------------

  private var form: some View {
    VStack(spacing: 12) {
      Picker("", selection: $model.mode) {
        Text(L("Add to Note", "Zur Notiz")).tag(ShareModel.Mode.note)
        Text(L("Send to Agent…", "An Agent senden…")).tag(ShareModel.Mode.send)
      }
      .pickerStyle(.segmented)
      .padding(.horizontal, 16).padding(.top, 8)

      if model.mode == .note { note } else { send }
    }
  }

  /** The note's paper: what was shared, a line to go with it. */
  private var note: some View {
    VStack(alignment: .leading, spacing: 10) {
      strip
      TextField(L("Add a line…", "Eine Zeile dazu…"), text: $model.text, axis: .vertical)
        .lineLimit(2...6)
        .font(SFace.text(17)).foregroundStyle(SInk.noteInk)
        .focused($typing)
      Text(L("Goes into your note. Nothing is sent.", "Kommt in deine Notiz. Es wird nichts gesendet."))
        .font(SFace.text(13)).foregroundStyle(SInk.noteInk.opacity(0.65))
      problems(SInk.noteInk.opacity(0.75))
      Spacer(minLength: 0)
    }
    .padding(16)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(SInk.noteYellow))
    .padding(.horizontal, 16).padding(.bottom, 16)
  }

  /** The tree of sessions, a line, Send. */
  private var send: some View {
    VStack(spacing: 0) {
      if model.tree.isEmpty {
        Text(L("Open Trommi once: then its sessions show here.", "Öffne Trommi einmal: dann stehen seine Sessions hier."))
          .font(SFace.text(15)).foregroundStyle(.secondary).padding(24)
        Spacer()
      } else {
        List {
          if !model.items.isEmpty || model.phase == .loading { Section { strip.listRowBackground(Color.clear).listRowInsets(EdgeInsets()) } }
          ForEach(model.tree) { d in
            Section(model.tree.count > 1 || d.desk.name != "Desk" ? d.desk.name : "") {
              ForEach(d.rows) { r in row(r) }
            }
          }
          Section {
            TextField(L("A short line (optional)", "Eine kurze Zeile (optional)"), text: $model.text, axis: .vertical)
              .lineLimit(1...4).font(SFace.text(16)).focused($typing)
            problems(.secondary)
          }
        }
        .listStyle(.insetGrouped)
        .scrollDismissesKeyboard(.interactively)
      }
    }
  }

  private func row(_ r: ShareSnapshot.Row) -> some View {
    Button { model.picked = r.session.id } label: {
      HStack(spacing: 10) {
        if r.depth > 0 { Image(systemName: "arrow.turn.down.right").font(.system(size: 12)).foregroundStyle(.tertiary).padding(.leading, 4) }
        Circle().fill(SInk.hue(r.session.hue)).frame(width: 10, height: 10)
          .overlay(Circle().stroke(Color.primary.opacity(0.12), lineWidth: 0.5))
        Text(r.session.name).font(SFace.text(16, r.depth == 0 ? .medium : .regular)).foregroundStyle(.primary).lineLimit(1)
        if r.crowned {
          Image(systemName: "crown.fill").font(.system(size: 12)).foregroundStyle(SInk.gold)
            .accessibilityLabel(L("main session", "Hauptsession"))
        }
        Spacer()
        if model.picked == r.session.id { Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(SInk.accent) }
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(model.picked == r.session.id ? .isSelected : [])
  }

  /** What was shared, as small tiles. */
  private var strip: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(model.items) { l in tile(l) }
        if model.phase == .loading { ProgressView().frame(width: 64, height: 64) }
      }
      .padding(.vertical, 2)
    }
  }
  private func tile(_ l: Loaded) -> some View {
    Group {
      if let t = l.thumb { Image(uiImage: t).resizable().scaledToFill() }
      else {
        VStack(spacing: 4) {
          Image(systemName: l.item.kind == .url ? "link" : l.item.kind == .text ? "text.alignleft" : "doc").font(.system(size: 18))
          Text(l.item.kind == .url ? (l.item.name) : l.item.kind == .text ? (l.item.text ?? "") : l.item.name)
            .font(SFace.text(10)).lineLimit(2).multilineTextAlignment(.center)
        }
        .padding(4)
        .foregroundStyle(SInk.noteInk)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.white.opacity(0.55))
      }
    }
    .frame(width: 64, height: 64)
    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    .accessibilityLabel(l.item.name)
  }

  @ViewBuilder private func problems(_ color: Color) -> some View {
    if !model.skipped.isEmpty {
      Text(L("Left out: ", "Weggelassen: ") + model.skipped.joined(separator: ", "))
        .font(SFace.text(13)).foregroundStyle(color)
    }
    if case .failed(let why) = model.phase {
      Text(L("Not saved: ", "Nicht gespeichert: ") + why).font(SFace.text(13)).foregroundStyle(.red)
    }
  }

  // ---- after ---------------------------------------------------------------------------------------------

  private func done(_ line: String) -> some View {
    VStack(spacing: 14) {
      Image(systemName: model.mode == .note ? "note.text.badge.plus" : "paperplane.fill")
        .font(.system(size: 34, weight: .medium)).foregroundStyle(SInk.accent)
      Text(line).font(SFace.text(18, .medium)).multilineTextAlignment(.center)
      if model.mode == .send, let n = model.pickedName { Text(n).font(SFace.text(15)).foregroundStyle(.secondary) }
    }
    .padding(32)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var unavailable: some View {
    VStack(spacing: 12) {
      Image(systemName: "lock").font(.system(size: 30)).foregroundStyle(.secondary)
      Text(L("Open Trommi once and sign in: then you can share into it.", "Öffne Trommi einmal und melde dich an: dann kannst du hierher teilen."))
        .font(SFace.text(16)).multilineTextAlignment(.center)
    }
    .padding(32)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}
#endif
