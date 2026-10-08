// SettingsScreen.swift: the clipboard of Settings (agents.mjs, auth.mjs): Agents (every session: rename, its drawing,
// the crown, the desk, archive), Devices (pair a device from this phone: a QR code to scan and "They match"; the
// people and agents with keys to this room, their fingerprints), Account (the login, the theme, log out).
import SwiftUI
import TrommiClient
import TrommiCore
#if canImport(CoreImage)
import CoreImage.CIFilterBuiltins
#endif

struct SettingsScreen: View {
  @EnvironmentObject var model: BoardModel
  @State var tab: String
  init(tab: String) { _tab = State(initialValue: tab) }
  var body: some View {
    let _ = model.version
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        Picker("Settings", selection: $tab) {
          Text("Agents").tag("agents"); Text("Devices").tag("devices"); Text("Account").tag("account")
        }
        .pickerStyle(.segmented)
        switch tab {
        case "devices": DevicesPane()
        case "account": AccountPane()
        default: AgentsPane()
        }
      }
      .padding(20)
      .background(Clipboard())
      .padding(.horizontal, 12).padding(.top, 30).padding(.bottom, 40)
      .frame(maxWidth: 760).frame(maxWidth: .infinity)
    }
    .background(Ink.bg)
    .navigationTitle("Settings")
    .navigationBarTitleDisplayMode(.inline)
  }
}

/** The clipboard: kraft board, a sheet of paper, the metal clamp on top. */
struct Clipboard: View {
  var body: some View {
    ZStack(alignment: .top) {
      RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.dyn(0x8a6d45, 0x6b5638)).padding(-8)
      RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Ink.surface)
      PenMark("auth:CLAMP", color: Ink.fg).frame(width: 110, height: 40).offset(y: -34)
    }
  }
}

struct AgentsPane: View {
  @EnvironmentObject var model: BoardModel
  @State private var query = ""
  @State private var renaming: Agent?
  @State private var name = ""
  @State private var drawingFor: Agent?
  var body: some View {
    let agents = model.desk?.agents ?? []
    let connected = agents.filter { $0.online && !$0.archived }.count
    let live = agents.filter { !$0.archived && !$0.removed }
    VStack(alignment: .leading, spacing: 14) {
      Text("\(connected) of \(live.count) sessions are connected.").font(Face.text(17)).foregroundStyle(Ink.muted)
      TextField("Find a session, a machine, a model", text: $query).font(Face.text(16)).padding(12)
        .background(RoundedRectangle(cornerRadius: 12).strokeBorder(Ink.lineStrong))
      let shown = agents.filter { a in query.isEmpty || "\(a.name) \(a.model) \(a.task)".lowercased().contains(query.lowercased()) }
      let desks = model.desk?.desks ?? []
      ForEach(desks.isEmpty ? [DeskDesc(id: "", name: "", created: 0, order: nil, crown: nil)] : desks) { d in
        let mine = shown.filter { d.id.isEmpty || model.desk?.deskOf($0) == d.id }.filter { !$0.archived }
        if !mine.isEmpty {
          if !d.id.isEmpty { HStack(spacing: 8) { Sketch("desk").frame(width: 22, height: 22); Text(d.name).font(Face.text(16, .semibold)) }.padding(.top, 6) }
          ForEach(mine) { a in agentRow(a) }
        }
      }
      let archived = shown.filter { $0.archived }
      if !archived.isEmpty {
        DisclosureGroup("Archive (\(archived.count))") { VStack(spacing: 0) { ForEach(archived) { a in agentRow(a) } } }.font(Face.text(15, .medium)).tint(Ink.fg)
      }
      Divider()
      VStack(alignment: .leading, spacing: 8) {
        Text("Invite an agent").font(Face.display(20, .bold))
        Text("On a computer with Claude Code and Node 22+: the web app (Settings → Agents → Invite an agent) gives the one command to run in the project folder. Then the agent's questions land here.")
          .font(Face.text(14)).foregroundStyle(Ink.muted)
      }
    }
    .alert("Rename", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
      TextField("Name", text: $name)
      Button("Save") { if let a = renaming { model.editSession(a, ["name": .str(String(name.prefix(60)))]) } }
      Button("Cancel", role: .cancel) {}
    }
    .sheet(item: $drawingFor) { a in DrawingPicker(agent: a) }
  }
  private func agentRow(_ a: Agent) -> some View {
    let open = model.view?.fresh.filter { $0.agent == a.id }.count ?? 0
    return HStack(spacing: 12) {
      Button { drawingFor = a } label: { AgentMark(agent: a, size: 30) }.buttonStyle(.plain)
      Button { model.path.append(.session(a.id)) } label: {
        VStack(alignment: .leading, spacing: 2) {
          Text(a.name).font(Face.text(17, .medium)).foregroundStyle(Ink.fg)
          Text([a.model, a.online ? "connected" : "away"].filter { !$0.isEmpty }.joined(separator: " · ")).font(Face.text(13)).foregroundStyle(Ink.muted)
        }.frame(maxWidth: .infinity, alignment: .leading)
      }.buttonStyle(.plain)
      if open > 0 { Text("\(open)").font(Face.text(14, .semibold)).foregroundStyle(Ink.muted).frame(width: 30, height: 30).overlay(Circle().strokeBorder(Ink.lineStrong)) }
      Menu {
        Button { name = a.label.isEmpty ? a.name : a.label; renaming = a } label: { Label("Rename", systemImage: "pencil") }
        Button { drawingFor = a } label: { Label("Its drawing", systemImage: "scribble") }
        Button { model.star(a, !a.starred) } label: { Label(a.starred ? "Take the crown off" : "Give it the crown", systemImage: "crown") }
        let others = (model.desk?.desks ?? []).filter { $0.id != model.desk?.deskOf(a) }
        if !others.isEmpty && a.parent == nil { Menu("Move to other desk") { ForEach(others) { d in Button(d.name) { model.editSession(a, ["desk": .str(d.id)]) } } } }
        Button { model.editSession(a, ["archived": .bool(!a.archived)]) } label: { Label(a.archived ? "Back from the archive" : "Archive", systemImage: "archivebox") }.disabled(a.online && !a.archived)
      } label: { Image(systemName: "ellipsis").font(.system(size: 18, weight: .semibold)).foregroundStyle(Ink.muted).frame(width: 36, height: 36) }
    }
    .padding(.vertical, 8)
    .overlay(alignment: .bottom) { Rectangle().fill(Ink.line).frame(height: 1) }
  }
}

struct DevicesPane: View {
  @EnvironmentObject var model: BoardModel
  @State private var pairing = false
  var body: some View {
    let members = (model.room?.board.members.values.map { $0 } ?? []).sorted { $0.addedEntryNumber < $1.addedEntryNumber }
    let people = members.filter { $0.isActive && $0.deviceRole == "human" }
    let agents = members.filter { $0.isActive && $0.deviceRole != "human" }
    let gone = members.filter { !$0.isActive }
    VStack(alignment: .leading, spacing: 14) {
      Text("Add a device").font(Face.display(22, .bold))
      Button { pairing = true } label: {
        HStack(spacing: 12) {
          PenMark("draw:phone", color: Ink.fg).frame(width: 34, height: 34)
          VStack(alignment: .leading, spacing: 2) {
            Text("Pair a device").font(Face.text(17, .semibold)).foregroundStyle(Ink.fg)
            Text("A QR code appears here. The new device scans it, you tap a number. Done.").font(Face.text(14)).foregroundStyle(Ink.muted)
          }
          Spacer()
        }.padding(14).background(RoundedRectangle(cornerRadius: 12).strokeBorder(Ink.fg, lineWidth: 1.5))
      }.buttonStyle(.plain)
      Text("Your devices").font(Face.display(20, .bold)).padding(.top, 6)
      ForEach(people, id: \.deviceId) { deviceRow($0) }
      Text("Agents").font(Face.display(20, .bold)).padding(.top, 6)
      if agents.isEmpty { Text("No agent yet.").font(Face.text(15)).foregroundStyle(Ink.muted) }
      ForEach(agents, id: \.deviceId) { deviceRow($0) }
      if !gone.isEmpty { DisclosureGroup("Removed (\(gone.count))") { ForEach(gone, id: \.deviceId) { deviceRow($0) } }.font(Face.text(15, .medium)).tint(Ink.fg) }
      Text("Every device holds its own keys; the hub sees sealed envelopes only. The fingerprint comes from the signed member list: it must look the same on every device.")
        .font(Face.text(13)).foregroundStyle(Ink.muted)
    }
    .sheet(isPresented: $pairing) { PairSheet() }
  }
  private func deviceRow(_ d: RoomMember) -> some View {
    HStack(spacing: 12) {
      Circle().fill(d.isOnline || d.isMe ? Ink.accent : Ink.lineStrong).frame(width: 9, height: 9)
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 6) {
          Text(d.deviceName.isEmpty ? (d.deviceRole == "human" ? "Device" : "Agent") : d.deviceName).font(Face.text(16, .semibold)).foregroundStyle(d.isActive ? Ink.fg : Ink.muted)
          if d.isMe { Text("this device").font(Face.text(13)).italic().foregroundStyle(Ink.muted) }
        }
        Text("\(d.deviceRole == "human" ? "Person" : "Agent") · \(d.fingerprint)\(d.isActive ? "" : " · removed")").font(Face.mono(12)).foregroundStyle(Ink.muted)
      }
      Spacer()
    }.padding(.vertical, 6)
  }
}

/** Pair a device from this phone: the QR code of an invite link; the new device scans it; both show six emoji; "They match". */
struct PairSheet: View {
  @EnvironmentObject var model: BoardModel
  @Environment(\.dismiss) private var dismiss
  @StateObject private var pairing = PairingModel()
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 18) {
          switch pairing.state {
          case .making: ProgressView().padding(40)
          case .open(let link, let until):
            QRCode(text: link).frame(width: 240, height: 240).padding(12).background(RoundedRectangle(cornerRadius: 16).fill(.white))
            VStack(alignment: .leading, spacing: 8) {
              Text("1. On the new device, open the camera and scan the code. Or open app.trommi.com there and choose “Pair a device”.")
              Text("2. Both devices then show six emoji. If they are the same, tap “They match” here.")
            }.font(Face.text(16)).foregroundStyle(Ink.fg)
            ShareLink(item: link) { Label("No scanner? Send the link", systemImage: "square.and.arrow.up").font(Face.text(15, .medium)) }
            Text("Waiting for the new device… The code works once, until \(clockOf(until)).").font(Face.text(14)).foregroundStyle(Ink.muted)
          case .confirm(let code):
            Text("A device wants to join. Does it show these six emoji, in this order?").font(Face.text(17, .medium)).multilineTextAlignment(.center)
            EmojiGrid(code: code)
            HStack(spacing: 12) {
              Button { pairing.confirm(false) } label: { Text("They don’t match").font(Face.text(16, .semibold)).frame(maxWidth: .infinity, minHeight: 52) }.buttonStyle(TileStyle(lead: false, hue: 162))
              Button { pairing.confirm(true) } label: { Text("They match").font(Face.text(16, .semibold)).frame(maxWidth: .infinity, minHeight: 52) }.buttonStyle(TileStyle(lead: true, hue: 162))
            }
            Text("“They don’t match” burns the invite: nobody is added.").font(Face.text(13)).foregroundStyle(Ink.muted)
          case .adding: ProgressView("Adding the device…").padding(40)
          case .joined(let name):
            Text("✓ \(name.isEmpty ? "The new device" : name) is in now.").font(Face.display(22, .bold)).foregroundStyle(Ink.accent)
            Button("Done") { dismiss() }.buttonStyle(QuietWay())
          case .failed(let why):
            Text(why).font(Face.text(16)).foregroundStyle(Ink.urgCritical).multilineTextAlignment(.center)
            Button("Pair again") { pairing.start(model.room) }.buttonStyle(QuietWay())
          }
        }
        .padding(24).frame(maxWidth: .infinity)
      }
      .navigationTitle("Pair a device").navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .topBarLeading) { Button("Close") { pairing.cancel(); dismiss() } } }
    }
    .onAppear { pairing.start(model.room) }
  }
}

struct EmojiGrid: View {
  let code: String
  var body: some View {
    let e = checkEmoji(code)
    LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 3), spacing: 14) {
      ForEach(Array(e.enumerated()), id: \.offset) { _, x in
        VStack(spacing: 2) { Text(x.emoji).font(.system(size: 46)); Text(x.word).font(Face.text(13)).foregroundStyle(Ink.muted) }
      }
    }
    .accessibilityLabel("Check code: \(e.map { $0.word }.joined(separator: ", "))")
  }
}

/** A QR code, drawn crisp (CoreImage, error correction M as the web's). */
struct QRCode: View {
  let text: String
  var body: some View {
    #if canImport(UIKit)
    if let img = make() { Image(uiImage: img).interpolation(.none).resizable().scaledToFit().accessibilityLabel("QR code to pair") }
    #endif
  }
  #if canImport(UIKit)
  private func make() -> UIImage? {
    let f = CIFilter.qrCodeGenerator()
    f.message = Data(text.utf8)
    f.correctionLevel = "M"
    guard let out = f.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)), let cg = CIContext().createCGImage(out, from: out.extent) else { return nil }
    return UIImage(cgImage: cg)
  }
  #endif
}

struct AccountPane: View {
  @EnvironmentObject var model: BoardModel
  @State private var leave = false
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Your login").font(Face.display(22, .bold))
      Text("Email, password and the Emergency Kit are managed at app.trommi.com → Settings → Account.").font(Face.text(15)).foregroundStyle(Ink.muted)
      Text("Look").font(Face.display(20, .bold)).padding(.top, 6)
      Picker("Theme", selection: $model.theme) { ForEach(ThemeMode.allCases) { Text($0.word).tag($0) } }.pickerStyle(.segmented)
      Text("This device").font(Face.display(20, .bold)).padding(.top, 6)
      if let r = model.room {
        Text("Room \(String(r.record.roomId.prefix(16)))… · key epoch \(r.state.epoch) · hub \(r.record.hubURL)").font(Face.mono(12)).foregroundStyle(Ink.muted)
      }
      Text("If you lose your password and your Emergency Kit, nobody (not even Trommi) can recover your data.").font(Face.text(13)).foregroundStyle(Ink.muted)
    }
  }
}

/** The pairing in progress on this phone: make the link, wait for the newcomer, confirm. */
@MainActor final class PairingModel: ObservableObject {
  enum State { case making, open(String, UInt64), confirm(String), adding, joined(String), failed(String) }
  @Published var state: State = .making
  private var pairing: Room.Pairing?
  private var room: Room?
  private var watch: Task<Void, Never>?
  func start(_ room: Room?) {
    guard let room = room else { state = .failed("Not signed in."); return }
    self.room = room
    state = .making
    watch?.cancel()
    watch = Task {
      do {
        var p = try await room.createPairing()
        pairing = p
        state = .open(p.link, p.expiresAt)
        while !Task.isCancelled {
          if try await room.checkPairing(&p) { pairing = p; state = .confirm(p.code ?? ""); return }
          try await Task.sleep(nanoseconds: 1_000_000_000)
        }
      } catch is CancellationError {
      } catch { state = .failed(why(error)) }
    }
  }
  func confirm(_ yes: Bool) {
    guard let room = room, let p = pairing else { return }
    state = .adding
    Task {
      do {
        try await room.confirmPairing(p, matches: yes)
        let name = p.newcomerId.flatMap { room.board.members[$0]?.deviceName } ?? ""
        state = .joined(name)
      } catch { state = .failed(why(error)) }
    }
  }
  func cancel() { watch?.cancel() }
  private func why(_ e: Error) -> String {
    switch (e as? ZError)?.code {
    case "code-mismatch": return "They did not match. Nobody was added; the invite is used up."
    case "invite-expired": return "The invite has expired."
    default: return "That did not work: \((e as? ZError)?.message ?? (e as? HubError)?.message ?? "\(e)")"
    }
  }
}
