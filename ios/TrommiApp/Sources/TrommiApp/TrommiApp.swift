// TrommiApp: the spike's iOS app. Join a room with an invite link from the web app ("add a device"), compare the six
// emoji, then the open cards (title, options); tap an option to answer. Everything below the views is TrommiCore and
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
  var body: some Scene {
    WindowGroup {
      RootView().environmentObject(model)
    }
  }
}

@MainActor
final class BoardModel: ObservableObject {
  enum Phase { case start, joining, checkCode(String), board }
  @Published var phase: Phase = .start
  @Published var cards: [Card] = []
  @Published var status: String = ""
  @Published var error: String?
  @Published var busy = false
  private var room: Room?

  init() {
    if let id = Store.rooms(base: Store.defaultBase()).first, let r = try? Room.open(roomId: id) {
      room = r
      phase = .board
      Task { await refresh() }
    }
  }

  func join(link: String) async {
    error = nil
    phase = .joining
    do {
      let r = try await Room.join(link: link.trimmingCharacters(in: .whitespacesAndNewlines)) { ev in
        if case .checkCode(let code) = ev { Task { @MainActor in self.phase = .checkCode(code) } }
      }
      room = r
      try await r.sendDeviceRegister(name: UIDeviceName.current, platform: "ios")
      phase = .board
      await refresh()
    } catch {
      self.error = describe(error)
      phase = .start
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

  private func describe(_ e: Error) -> String {
    if let z = e as? ZError { return z.description }
    if let h = e as? HubError { return "hub: \(h.description)" }
    return "\(e)"
  }
}

enum UIDeviceName {
  static var current: String {
    #if canImport(UIKit)
    return UIDevice.current.name
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
        case .start: JoinView()
        case .joining: ProgressView("Asking to join…")
        case .checkCode(let code): CheckCodeView(code: code)
        case .board: BoardView()
        }
      }
      .navigationTitle("Trommi")
    }
  }
}

struct JoinView: View {
  @EnvironmentObject var model: BoardModel
  @State private var link = ""
  var body: some View {
    Form {
      Section {
        TextField("Invite link", text: $link, axis: .vertical)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .lineLimit(3...6)
        Button("Join") { Task { await model.join(link: link) } }
          .disabled(link.isEmpty)
      } footer: {
        Text("In the Trommi app on another device: add a device, copy the link, paste it here. Joining is your act: nothing is added before you confirm the six emoji there.")
      }
      if let e = model.error { Section { Text(e).foregroundStyle(.red) } }
    }
  }
}

struct CheckCodeView: View {
  let code: String
  var body: some View {
    VStack(spacing: 24) {
      Text("Compare with the other device").font(.headline)
      let e = checkEmoji(code)
      LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 3), spacing: 16) {
        ForEach(Array(e.enumerated()), id: \.offset) { _, x in
          VStack { Text(x.emoji).font(.system(size: 48)); Text(x.word).font(.caption).foregroundStyle(.secondary) }
        }
      }
      Text("Tap \u{201C}They match\u{201D} there only if it shows these six, in this order.")
        .font(.footnote).multilineTextAlignment(.center).foregroundStyle(.secondary)
      ProgressView()
    }
    .padding()
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
