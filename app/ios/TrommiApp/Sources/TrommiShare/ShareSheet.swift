// The share sheet's face: the note itself, as the app shows it (the yellow paper, its ink, IBM Plex Sans), compact.
// What was shared as thumbnails, a text field, "To: <desk> · <crowned session> ▾", and two ways: Send (to that crown)
// and Keep in Note. The drawings come from the app's snapshot as small pictures (the extension has no pen of its own).
import Foundation
import ShareInbox
#if canImport(UIKit)
import SwiftUI
import UIKit

enum SInk {
  /** The note's paper and ink (Theme.swift Ink.noteYellow, Ink.noteInk). */
  static let noteYellow = Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 0xd9 / 255, green: 0xc3 / 255, blue: 0x5f / 255, alpha: 1) : UIColor(red: 0xf5 / 255, green: 0xd6 / 255, blue: 0x4a / 255, alpha: 1) })
  static let noteInk = Color(red: 0x3b / 255, green: 0x30 / 255, blue: 0x0d / 255)
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
    VStack(alignment: .leading, spacing: 12) {
      head
      if model.inbox == nil { unavailable }
      else if case .done(let icon, let line) = model.phase { done(icon, line) }
      else { paper }
    }
    .padding(.horizontal, 20).padding(.top, 14).padding(.bottom, 12)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .foregroundStyle(SInk.noteInk)
    .background(SInk.noteYellow.ignoresSafeArea())
    .environment(\.colorScheme, .light)   // the paper is yellow in both modes: the system's controls on it in light
  }

  // ---- the head: Cancel, the recipient -------------------------------------------------------------------

  private var head: some View {
    HStack(spacing: 8) {
      Button(L("Cancel", "Abbrechen")) { model.cancel() }
        .font(SFace.text(16)).foregroundStyle(SInk.noteInk.opacity(0.75))
      Spacer(minLength: 8)
      if model.inbox != nil, !model.isDone { recipient }
    }
    .frame(minHeight: 36)
  }

  /** "To: <desk drawing> Desk · <session drawing> Session ▾": the desks' crowned sessions, the last one used picked. */
  @ViewBuilder private var recipient: some View {
    let crowned = model.snapshot?.crowned ?? []
    if crowned.isEmpty {
      Text(L("To: no main session", "An: keine Hauptsession")).font(SFace.text(15)).foregroundStyle(SInk.noteInk.opacity(0.6))
    } else {
      Menu {
        Section(L("Main Session of a Desk", "Hauptsession eines Desks")) {
          ForEach(crowned) { d in
            Button { model.pick(d.id) } label: {
              Label {
                Text("\(d.name) · \(d.crown?.name ?? "")")
              } icon: {
                if d.id == model.desk { Image(systemName: "checkmark") } else { picture(d.crown?.mark, template: false) ?? Image(systemName: "person") }
              }
            }
          }
        }
      } label: { chip }
      .accessibilityLabel(L("Recipient: ", "Empfänger: ") + (model.picked.map { "\($0.name), \($0.crown?.name ?? "")" } ?? ""))
    }
  }
  private var chip: some View {
    HStack(spacing: 5) {
      Text(L("To:", "An:")).foregroundStyle(SInk.noteInk.opacity(0.7))
      if let d = model.picked {
        if (model.snapshot?.crowned.count ?? 0) > 1 {
          picture(model.snapshot?.deskMark, template: true)?.resizable().scaledToFit().frame(width: 18, height: 18).foregroundStyle(SInk.noteInk.opacity(0.7))
          Text(d.name).foregroundStyle(SInk.noteInk.opacity(0.7)).lineLimit(1)
          Text("·").foregroundStyle(SInk.noteInk.opacity(0.5))
        }
        picture(d.crown?.mark, template: false)?.resizable().scaledToFit().frame(width: 20, height: 20)
        Text(d.crown?.name ?? "").fontWeight(.semibold).lineLimit(1)
      }
      Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold)).foregroundStyle(SInk.noteInk.opacity(0.7))
    }
    .font(SFace.text(15))
    .foregroundStyle(SInk.noteInk)
    .padding(.horizontal, 10).padding(.vertical, 6)
    .background(Capsule().fill(Color.white.opacity(0.35)))
  }
  private func picture(_ png: Data?, template: Bool) -> Image? {
    guard let png = png, let ui = UIImage(data: png, scale: 3) else { return nil }
    return Image(uiImage: ui.withRenderingMode(template ? .alwaysTemplate : .alwaysOriginal))
  }

  // ---- the paper: what was shared, the words, the two ways ----------------------------------------------

  private var paper: some View {
    VStack(alignment: .leading, spacing: 10) {
      if !model.items.isEmpty || model.phase == .loading { strip }
      TextEditor(text: $model.text)
        .font(SFace.text(18)).foregroundStyle(SInk.noteInk)
        .scrollContentBackground(.hidden)
        .focused($typing)
        .frame(minHeight: 90)
        .overlay(alignment: .topLeading) {
          if model.text.isEmpty {
            Text(L("Write a note…", "Schreib etwas dazu…")).font(SFace.text(18)).foregroundStyle(SInk.noteInk.opacity(0.45))
              .padding(.top, 8).padding(.leading, 5).allowsHitTesting(false)
          }
        }
      problems
      actions
      if model.snapshot?.crowned.isEmpty ?? true {
        Text(model.snapshot == nil ? L("Open Trommi once: then its main sessions show here.", "Öffne Trommi einmal: dann stehen hier seine Hauptsessions.")
                                   : L("Make a session the main session of its desk (its ⋯ menu): then you can send to it.", "Mach eine Session zur Hauptsession ihres Desks (ihr ⋯-Menü): dann kannst du an sie senden."))
          .font(SFace.text(13)).foregroundStyle(SInk.noteInk.opacity(0.7))
      }
    }
  }

  /** Keep in Note (nothing is sent) on the left, Send (the round paper plane, as on the note in the app) on the right. */
  private var actions: some View {
    HStack(spacing: 10) {
      Button { typing = false; model.go(.note) } label: {
        Image(systemName: "square.and.arrow.down").font(.system(size: 19, weight: .semibold)).foregroundStyle(SInk.noteInk)
          .frame(width: 46, height: 46)
          .background(Circle().strokeBorder(SInk.noteInk.opacity(0.55), lineWidth: 1.2))
          .contentShape(Circle())
      }
      .accessibilityLabel(L("Save to note", "In die Notiz sichern"))
      .disabled(!model.canKeep).opacity(model.canKeep ? 1 : 0.4)
      Spacer()
      Button { typing = false; model.go(.send) } label: {
        Image(systemName: "paperplane.fill").font(.system(size: 18, weight: .semibold)).foregroundStyle(SInk.noteYellow)
          .frame(width: 46, height: 46).background(Circle().fill(SInk.noteInk))
      }
      .disabled(!model.canSend).opacity(model.canSend ? 1 : 0.35)
      .accessibilityLabel(model.picked?.crown.map { L("Send to ", "Senden an ") + $0.name } ?? L("Send", "Senden"))
    }
    .buttonStyle(.plain)
  }

  /** What was shared, as thumbnails (a cross takes one out). */
  private var strip: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(model.items) { l in
          ZStack(alignment: .topTrailing) {
            tile(l)
            Button { model.remove(l.id) } label: { Image(systemName: "xmark.circle.fill").font(.system(size: 18)).foregroundStyle(SInk.noteInk, SInk.noteYellow) }
              .buttonStyle(.plain).offset(x: 6, y: -6)
              .accessibilityLabel(L("Remove", "Entfernen"))
          }
        }
        if model.phase == .loading { ProgressView().tint(SInk.noteInk).frame(width: 72, height: 72) }
      }
      .padding(.top, 6).padding(.trailing, 6)
    }
  }
  private func tile(_ l: Loaded) -> some View {
    Group {
      if let t = l.thumb { Image(uiImage: t).resizable().scaledToFill() }
      else {
        VStack(spacing: 4) {
          Image(systemName: l.item.kind == .url ? "link" : l.item.kind == .text ? "text.alignleft" : "paperclip").font(.system(size: 18))
          Text(l.item.kind == .text ? (l.item.text ?? "") : l.item.name)
            .font(SFace.text(11)).lineLimit(2).multilineTextAlignment(.center)
        }
        .padding(4)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.white.opacity(0.5))
      }
    }
    .frame(width: 72, height: 72)
    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    .accessibilityLabel(l.item.name)
  }

  @ViewBuilder private var problems: some View {
    if !model.skipped.isEmpty {
      Text(L("Left out: ", "Weggelassen: ") + model.skipped.joined(separator: ", "))
        .font(SFace.text(13)).foregroundStyle(SInk.noteInk.opacity(0.75))
    }
    if case .failed(let why) = model.phase {
      Text(L("Not saved: ", "Nicht gespeichert: ") + why).font(SFace.text(13)).foregroundStyle(.red)
    }
  }

  // ---- after ---------------------------------------------------------------------------------------------

  private func done(_ icon: String, _ line: String) -> some View {
    VStack(spacing: 14) {
      Image(systemName: icon).font(.system(size: 34, weight: .medium))
      Text(line).font(SFace.text(18, .medium)).multilineTextAlignment(.center)
    }
    .padding(32)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var unavailable: some View {
    VStack(spacing: 12) {
      Image(systemName: "lock").font(.system(size: 30)).foregroundStyle(SInk.noteInk.opacity(0.7))
      Text(L("Open Trommi once and sign in: then you can share into it.", "Öffne Trommi einmal und melde dich an: dann kannst du hierher teilen."))
        .font(SFace.text(16)).multilineTextAlignment(.center)
    }
    .padding(32)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}
#endif
