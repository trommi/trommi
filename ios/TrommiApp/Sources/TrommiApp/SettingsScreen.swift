// SettingsScreen.swift: Settings as one list, the way iOS Settings reads, on Trommi's paper (agents.mjs, auth.mjs): on
// top the two invitations (Invite a Device: its QR code blurred until Show Code, the invite made only then, six emoji and
// They Match; Invite Agent…: the command for a terminal), then a row for each page: Sessions (grouped by desk, folded,
// the main session first, a search), Devices (and Push on this phone: Yes, Only Knocking, No), Account (the login, the
// Emergency Kit, the password, Log Out), Theme (the Demo is a row of the pill menu, under Settings). Route .settings(<page>): "" or "agents" is the list itself.
import SwiftUI
import TrommiClient
#if canImport(CoreImage)
import CoreImage.CIFilterBuiltins
#endif

struct SettingsScreen: View {
  @EnvironmentObject var model: BoardModel
  let tab: String
  init(tab: String) { self.tab = tab }
  var body: some View {
    switch tab {
    case "sessions": SessionsPage()
    case "devices": DevicesPage()
    case "account": AccountPage()
    case "theme": ThemePage()
    case "mls-proof": CoreProofPage()   // CoreProofScreen.swift: an info screen, not a setting
    default: SettingsHome()
    }
  }
}

// ---- the parts every page uses ---------------------------------------------------------------------------------

/** A page of Settings: paper, a large title, the groups one under the other. */
struct SettingsPage<Content: View>: View {
  let title: String
  @ViewBuilder var content: Content
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 26) { content }
        .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 90)
        .frame(maxWidth: 680).frame(maxWidth: .infinity)
    }
    .background(Ink.bg.ignoresSafeArea())
    .navigationTitle(title)
    .navigationBarTitleDisplayMode(.large)
  }
}

/** A group of rows as iOS Settings draws it: a caption, a sheet of paper with hairlines, a note under it. */
struct SettingsGroup<Content: View>: View {
  var header: String? = nil
  var footer: String? = nil
  @ViewBuilder var content: Content
  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      if let h = header { Text(h.uppercased()).font(Face.text(12, .semibold)).kerning(0.9).foregroundStyle(Ink.muted).padding(.horizontal, 16) }
      VStack(spacing: 0) { content }
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Ink.surface))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Ink.line))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
      if let f = footer { Text(f).font(Face.text(13)).foregroundStyle(Ink.muted).padding(.horizontal, 16).fixedSize(horizontal: false, vertical: true) }
    }
  }
}

/** The hairline between two rows, from under the icon to the edge. */
struct RowRule: View {
  var inset: CGFloat = 56
  var body: some View { Rectangle().fill(Ink.line).frame(height: 1).padding(.leading, inset) }
}

/** One row: a drawn icon, the title, a detail on the right, a chevron when it opens a page. */
struct SettingsRow<Icon: View>: View {
  let title: String
  var detail: String? = nil
  var tint: Color = Ink.fg
  var chevron = false
  @ViewBuilder var icon: Icon
  var body: some View {
    HStack(spacing: 14) {
      icon.frame(width: 26, height: 26)
      Text(title).font(Face.text(17, .medium)).foregroundStyle(tint).lineLimit(1)
      Spacer(minLength: 8)
      if let d = detail { Text(d).font(Face.text(15)).foregroundStyle(Ink.muted).lineLimit(1) }
      if chevron { Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Ink.faint) }
    }
    .padding(.horizontal, 16).frame(minHeight: 52)
    .contentShape(Rectangle())
  }
}

// ---- the list ---------------------------------------------------------------------------------------------------

struct SettingsHome: View {
  @EnvironmentObject var model: BoardModel
  @State private var inviteDevice = false
  @State private var askAgentName = false
  @State private var agentName = ""
  @State private var inviteAgent = false
  @State private var account: AccountStatus?
  var body: some View {
    let _ = model.version
    let agents = (model.desk?.agents ?? []).filter { !$0.archived && !$0.removed }
    let connected = agents.filter { $0.online }.count
    let devices = (model.board?.members.values.filter { $0.isActive && $0.deviceRole == "human" }.count) ?? 0
    SettingsPage(title: "Settings") {
      SettingsGroup(footer: "A device scans a code and shows six emoji; an agent gets one command for its terminal. Nobody is added before you confirm.") {
        Button { inviteDevice = true } label: { SettingsRow(title: "Invite a Device", tint: Ink.accent) { Sketch("heads", color: Ink.accent) } }.buttonStyle(.plain)
        RowRule()
        Button { agentName = ""; askAgentName = true } label: { SettingsRow(title: "Invite Agent…", tint: Ink.accent) { PenMark("ui:PLUS", color: Ink.accent) } }.buttonStyle(.plain)
      }
      SettingsGroup {
        link("sessions") { SettingsRow(title: "Sessions", detail: agents.isEmpty ? nil : "\(connected) of \(agents.count) connected", chevron: true) { Sketch("bubble") } }
        RowRule()
        link("devices") { SettingsRow(title: "Devices", detail: devices > 0 ? "\(devices)" : nil, chevron: true) { Sketch("keycap") } }
        RowRule()
        link("account") { SettingsRow(title: "Account", detail: model.demo ? "Demo" : account?.email, chevron: true) { Sketch("key") } }
      }
      SettingsGroup {
        link("theme") { SettingsRow(title: "Theme", detail: model.theme.word, chevron: true) { Sketch(model.theme == .dark ? "moon" : "sun") } }
      }
      SettingsGroup {
        link("mls-proof") { SettingsRow(title: "MLS proof", chevron: true) { Image(systemName: "checkmark.shield").font(.system(size: 20)).foregroundStyle(Ink.fg) } }
      }
      if let r = model.room {
        Text("Trommi \(HubClient.appVersion) · room \(String(r.record.roomId.prefix(12)))… · key epoch \(r.state.epoch)").font(Face.mono(12)).foregroundStyle(Ink.faint)
          .frame(maxWidth: .infinity).textSelection(.enabled)
      }
    }
    .sheet(isPresented: $inviteDevice) { InviteDeviceSheet() }
    .sheet(isPresented: $inviteAgent) { AgentInviteSheet(label: agentName.trimmingCharacters(in: .whitespaces)) }
    // (a state of the demo's list opens its sheet here: DemoMode.swift openDemoScreen)
    .onAppear {
      switch model.demoSheet { case "pair": inviteDevice = true; case "invite": agentName = "Website"; inviteAgent = true; default: break }
      model.demoSheet = nil
    }
    .alert("Invite Agent", isPresented: $askAgentName) {
      TextField("Name of the Session (e.g. Website)", text: $agentName)
      Button("Cancel", role: .cancel) {}
      Button("Continue") { inviteAgent = true }
    } message: { Text("The session gets this name on the board. You can leave it empty and rename it later.") }
    .task { if account == nil, !model.demo { account = try? await model.room?.accountStatus() } }
  }
  private func link<L: View>(_ page: String, @ViewBuilder _ label: () -> L) -> some View {
    Button { model.path.append(.settings(page)) } label: { label() }.buttonStyle(.plain)
  }
}

// ---- Sessions ---------------------------------------------------------------------------------------------------

struct SessionsPage: View {
  @EnvironmentObject var model: BoardModel
  @State private var query = ""
  @State private var open = Set<String>()
  @State private var renaming: Agent?
  @State private var name = ""
  @State private var drawingFor: Agent?
  @State private var deleting: Agent?
  var body: some View {
    let _ = model.version
    let d = model.desk
    let terms = query.lowercased().split(separator: " ").map(String.init)
    let matches: (Agent) -> Bool = { a in terms.allSatisfy { "\(a.name) \(a.given) \(a.model) \(a.task)".lowercased().contains($0) } }
    let desks = d?.desks ?? []
    let groups: [(id: String, name: String, list: [Agent])] = desks.isEmpty
      ? [("", "Sessions", ordered((d?.view(desk: nil).here ?? []).filter(matches)))]
      : desks.map { desk in (desk.id, desk.name, ordered((d?.view(desk: desk.id).here ?? []).filter(matches))) }
    let archived = (d?.agents ?? []).filter { $0.archived && matches($0) }
    SettingsPage(title: "Sessions") {
      if groups.allSatisfy({ $0.list.isEmpty }) && archived.isEmpty {
        Text(terms.isEmpty ? "No session yet: Invite Agent… in Settings." : "No session has these words.").font(Face.text(15)).foregroundStyle(Ink.muted).padding(.top, 20)
      }
      ForEach(groups, id: \.id) { g in
        if !g.list.isEmpty { group(id: g.id, name: g.name, list: g.list, desk: !desks.isEmpty) }
      }
      if !archived.isEmpty { group(id: "#archive", name: "Archive", list: archived, desk: false) }
    }
    .searchable(text: $query, prompt: "Search Sessions")
    .alert("Rename Session", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
      TextField("Name", text: $name)
      Button("Cancel", role: .cancel) {}
      Button("Rename") { if let a = renaming { model.editSession(a, ["name": .str(String(name.prefix(60)))]) } }
    }
    .sheet(item: $drawingFor) { a in DrawingPicker(agent: a) }
    .confirmationDialog("Delete \(deleting?.name ?? "this session")?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
      Button("Delete Session", role: .destructive) { if let a = deleting { model.deleteSession(a) } }
    } message: { Text("Its connector leaves the room, its open questions are shredded and it goes to the archive.") }
  }
  /** The main session (the crown) first, then the board's order. */
  private func ordered(_ list: [Agent]) -> [Agent] {
    list.enumerated().sorted { ($0.element.starred ? 0 : 1, $0.offset) < ($1.element.starred ? 0 : 1, $1.offset) }.map { $0.element }
  }
  @ViewBuilder private func group(id: String, name: String, list: [Agent], desk: Bool) -> some View {
    // folded by default; a search opens every group that has a match
    let shown = !query.isEmpty || open.contains(id)
    let connected = list.filter { $0.online }.count
    SettingsGroup {
      Button { withAnimation(.snappy) { if open.contains(id) { open.remove(id) } else { open.insert(id) } } } label: {
        HStack(spacing: 14) {
          Group { if id == "#archive" { Sketch("archive") } else if desk { Sketch("desk") } else { Sketch("bubble") } }.frame(width: 26, height: 26)
          Text(name).font(Face.text(17, .semibold)).foregroundStyle(Ink.fg).lineLimit(1)
          Spacer(minLength: 8)
          Text(id == "#archive" ? "\(list.count)" : "\(connected) of \(list.count) connected").font(Face.text(14)).foregroundStyle(Ink.muted)
          Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Ink.faint).rotationEffect(.degrees(shown ? 90 : 0))
        }
        .padding(.horizontal, 16).frame(minHeight: 54).contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("\(name), \(list.count) sessions, \(shown ? "open" : "folded")")
      if shown {
        ForEach(list) { a in
          RowRule(inset: 16)
          row(a)
        }
      }
    }
  }
  private func row(_ a: Agent) -> some View {
    let open = model.view?.fresh.filter { $0.agent == a.id }.count ?? 0
    return HStack(spacing: 12) {
      Button { model.path.append(.session(a.id)) } label: {
        HStack(spacing: 12) {
          AgentMark(agent: a, size: 30).padding(.leading, a.parent != nil ? 14 : 0)
          VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
              Text(a.name).font(Face.text(17, .medium)).foregroundStyle(Ink.fg).lineLimit(1)
              if a.starred { Text("Main").font(Face.text(11, .bold)).foregroundStyle(Ink.goldPen).padding(.horizontal, 6).padding(.vertical, 2).background(Capsule().strokeBorder(Ink.goldPen)) }
            }
            Text([a.model, a.archived ? "archived" : a.online ? "connected" : "away"].filter { !$0.isEmpty }.joined(separator: " · ")).font(Face.text(13)).foregroundStyle(Ink.muted).lineLimit(1)
          }
          Spacer(minLength: 4)
          if open > 0 { Text("\(open)").font(Face.text(14, .semibold)).foregroundStyle(Ink.muted).frame(minWidth: 26, minHeight: 26).overlay(Circle().strokeBorder(Ink.lineStrong)) }
        }.contentShape(Rectangle())
      }.buttonStyle(.plain)
      Menu { SessionActions(agent: a, rename: { name = a.label.isEmpty ? a.name : a.label; renaming = a }, icon: { drawingFor = a }, delete: { deleting = a }) } label: {
        Image(systemName: "ellipsis.circle").font(.system(size: 20)).foregroundStyle(Ink.muted).frame(width: 40, height: 40)
      }
      .accessibilityLabel("More for \(a.name)")
    }
    .padding(.leading, 16).padding(.trailing, 6).padding(.vertical, 6)
    .contextMenu { SessionActions(agent: a, rename: { name = a.label.isEmpty ? a.name : a.label; renaming = a }, icon: { drawingFor = a }, delete: { deleting = a }) }
  }
}

/** What can be done with a session, in Apple's words. */
struct SessionActions: View {
  @EnvironmentObject var model: BoardModel
  let agent: Agent
  let rename: () -> Void
  let icon: () -> Void
  let delete: () -> Void
  var body: some View {
    let a = agent
    Button(action: rename) { Label("Rename…", systemImage: "pencil") }
    Button(action: icon) { Label("Change Icon…", systemImage: "scribble") }
    if !a.archived {
      if a.starred { Button { model.star(a, false) } label: { Label("Remove as Main Session", systemImage: "crown") } }
      else { Button { model.star(a, true) } label: { Label("Make Main Session", systemImage: "crown") } }
    }
    let others = (model.desk?.desks ?? []).filter { $0.id != model.desk?.deskOf(a) }
    if !others.isEmpty && a.parent == nil {
      Menu { ForEach(others) { d in Button(d.name) { model.editSession(a, ["desk": .str(d.id)]) } } } label: { Label("Move to Desk…", systemImage: "rectangle.portrait.and.arrow.forward") }
    }
    Divider()
    Button { model.editSession(a, ["archived": .bool(!a.archived)]) } label: { Label(a.archived ? "Unarchive" : "Archive", systemImage: "archivebox") }
      .disabled(a.online && !a.archived)
    Button(role: .destructive, action: delete) { Label("Delete…", systemImage: "trash") }
  }
}

// ---- Devices ----------------------------------------------------------------------------------------------------

struct DevicesPage: View {
  @EnvironmentObject var model: BoardModel
  @State private var removing: RoomMember?
  @State private var pushLevel = Push.level
  @State private var pushes: [String: (web: Int, apns: Int, level: String)] = [:]
  @State private var inviteDevice = false
  @State private var showRemoved = false
  @State private var renaming = false
  @State private var newName = ""
  var body: some View {
    let _ = model.version
    let members = (model.board?.members.values.map { $0 } ?? []).sorted { $0.addedEntryNumber < $1.addedEntryNumber }
    let people = members.filter { $0.isActive && $0.deviceRole == "human" }
    let agents = members.filter { $0.isActive && $0.deviceRole != "human" }
    let gone = members.filter { !$0.isActive }
    SettingsPage(title: "Devices") {
      SettingsGroup(header: "Push on This \(UIDeviceName.model)", footer: pushLevel == "knocking" ? "Only urgent questions and a session that lost its link ring here." : pushLevel == "off" ? "Nothing rings here; the board still shows everything." : "Every new question rings here.") {
        Picker("Push", selection: Binding(get: { pushLevel }, set: { l in pushLevel = l; Task { await Push.setLevel(l); await loadPush() } })) {
          Text("Yes").tag("all"); Text("Only Knocking").tag("knocking"); Text("No").tag("off")
        }
        .pickerStyle(.segmented).padding(12)
        .disabled(model.demo)
      }
      SettingsGroup(header: "Your Devices") {
        ForEach(Array(people.enumerated()), id: \.element.deviceId) { i, d in
          if i > 0 { RowRule() }
          deviceRow(d)
        }
        RowRule()
        Button { inviteDevice = true } label: { SettingsRow(title: "Invite a Device", tint: Ink.accent) { PenMark("ui:PLUS", color: Ink.accent) } }.buttonStyle(.plain)
      }
      SettingsGroup(header: "Agents", footer: "Every device holds its own keys; the hub sees sealed envelopes only. The fingerprint comes from the device's own key, as the room's group names it: it must look the same on every device.") {
        if agents.isEmpty { Text("No agent yet.").font(Face.text(15)).foregroundStyle(Ink.muted).padding(16).frame(maxWidth: .infinity, alignment: .leading) }
        ForEach(Array(agents.enumerated()), id: \.element.deviceId) { i, d in
          if i > 0 { RowRule() }
          deviceRow(d)
        }
      }
      if !gone.isEmpty {
        SettingsGroup {
          Button { withAnimation(.snappy) { showRemoved.toggle() } } label: {
            SettingsRow(title: "Removed", detail: "\(gone.count)") {
              Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Ink.faint).rotationEffect(.degrees(showRemoved ? 90 : 0))
            }
          }.buttonStyle(.plain)
          if showRemoved { ForEach(gone, id: \.deviceId) { d in RowRule(); deviceRow(d) } }
        }
      }
    }
    .sheet(isPresented: $inviteDevice) { InviteDeviceSheet() }
    .confirmationDialog("Remove \(removing?.deviceName.isEmpty == false ? removing!.deviceName : "This Device")?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
      Button("Remove", role: .destructive) { if let d = removing { model.removeDevice(d.deviceId, name: d.deviceName) } }
      // (spec/v1.md 8.6: a device that is not in his hands any more may have learned the recovery code; Account makes a new one)
      if removing?.deviceRole == "human" {
        Button("Remove and Make New Recovery Code…", role: .destructive) {
          if let d = removing { model.removeDevice(d.deviceId, name: d.deviceName); model.path.append(.settings("account")) }
        }
      }
    } message: {
      Text(removing?.deviceRole == "human" ? "It can open nothing new after this. Everyone else gets a new key; that takes a moment. If it is lost or no longer yours, also make a new recovery code." : "It can read nothing new after this. The others get a new key; the session’s history stays.")
    }
    .alert("Rename This Device", isPresented: $renaming) {
      TextField("Name", text: $newName)
      Button("Cancel", role: .cancel) {}
      Button("Save") {
        let n = String(newName.trimmingCharacters(in: .whitespaces).prefix(40))
        if !n.isEmpty, let room = model.acting() { model.act("Not renamed") { try await room.renameDevice(name: n, platform: "ios") } }
      }
    }
    .task { await loadPush() }
  }
  private func loadPush() async { if let p = try? await model.room?.hub.pushStates() { pushes = p } }
  private func deviceRow(_ d: RoomMember) -> some View {
    HStack(spacing: 14) {
      Circle().fill(d.isOnline || d.isMe ? Ink.accent : Ink.lineStrong).frame(width: 9, height: 9).frame(width: 26)
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 6) {
          Text(d.deviceName.isEmpty ? (d.deviceRole == "human" ? "Device" : "Agent") : d.deviceName).font(Face.text(17, .medium)).foregroundStyle(d.isActive ? Ink.fg : Ink.muted).lineLimit(1)
          if d.isMe { Text("This Device").font(Face.text(12, .semibold)).foregroundStyle(Ink.accent) }
        }
        Text(d.fingerprint).font(Face.mono(12)).foregroundStyle(Ink.muted)
        if d.deviceRole == "human" && d.isActive {
          let p = pushes[d.deviceId]
          Text(p == nil ? "Push: No" : p!.level == "knocking" ? "Push: Only Knocking" : "Push: Yes").font(Face.text(12)).foregroundStyle(Ink.faint)
        }
      }
      Spacer(minLength: 4)
      // this device named itself ("iPhone"); here it gets the name he wants (its own register device/<id>)
      if d.isActive && d.isMe && !model.demo {
        Button("Rename") { newName = d.deviceName; renaming = true }.font(Face.text(15, .semibold)).foregroundStyle(Ink.accent).frame(minHeight: 40)
      }
      if d.isActive && !d.isMe {
        Menu {
          Button(role: .destructive) { removing = d } label: { Label("Remove…", systemImage: "trash") }
        } label: { Image(systemName: "ellipsis.circle").font(.system(size: 20)).foregroundStyle(Ink.muted).frame(width: 40, height: 40) }
        .accessibilityLabel("More for \(d.deviceName)")
      }
    }
    .padding(.horizontal, 16).padding(.vertical, 10)
  }
}

// ---- Account ----------------------------------------------------------------------------------------------------

struct AccountPage: View {
  @EnvironmentObject var model: BoardModel
  @State private var leave = false
  @State private var status: AccountStatus?
  @State private var loaded = false
  @State private var code = ""
  @State private var kitPassword = ""
  @State private var kit: String?
  @State private var current = ""
  @State private var next = ""
  @State private var said = ""
  @State private var error = ""
  @State private var passkeyAsk = false
  @State private var passkeyPassword = ""
  @State private var codeAsk = false
  @State private var codePassword = ""
  var body: some View {
    SettingsPage(title: "Account") {
      if !said.isEmpty { Text(said).font(Face.text(15, .medium)).foregroundStyle(Ink.accent) }
      if !error.isEmpty { Text(error).font(Face.text(15)).foregroundStyle(Ink.urgCritical) }
      if model.demo {
        SettingsGroup(footer: "The demo is a made-up room on this phone: no account, nothing is sent.") {
          SettingsRow(title: "Demo Room") { PenMark("sidebar:DEMO_MARK", color: Ink.fg) }
        }
      } else if !loaded {
        ProgressView().frame(maxWidth: .infinity)
      } else if let st = status {
        SettingsGroup(header: "Email") {
          // (a hub that does not confirm addresses: the address alone, nothing to confirm)
          SettingsRow(title: st.email.isEmpty ? "No Email" : st.email, detail: !st.confirmsEmail ? nil : st.emailVerifiedAt != nil ? "Confirmed" : "Not Confirmed") { Sketch("letter") }
          if st.confirmsEmail && st.emailVerifiedAt == nil {
            RowRule()
            VStack(alignment: .leading, spacing: 10) {
              Text("We send a six-digit code to \(st.email).").font(Face.text(14)).foregroundStyle(Ink.muted)
              HStack {
                TextField("Code", text: $code).keyboardType(.numberPad).textContentType(.oneTimeCode).font(Face.mono(18)).padding(10).background(RoundedRectangle(cornerRadius: 10).strokeBorder(Ink.lineStrong))
                Button("Confirm") { run { try await model.room?.verifyEmail(code: code); said = "Email confirmed."; await load() } }.buttonStyle(QuietWay())
              }
              Button("Send Code") { run { try await model.room?.resendEmailCode(); said = "Code sent." } }.font(Face.text(15, .semibold)).foregroundStyle(Ink.accent)
            }.padding(16)
          }
        }
        SettingsGroup(header: "Emergency Kit", footer: st.hasRecovery ? "Made. With it you can set a new password if you forget yours." : "Not made yet. With it you can set a new password if you forget yours.") {
          if let k = kit {
            VStack(alignment: .leading, spacing: 10) {
              Text("Save or print it. It is shown only now; the old kit no longer works.").font(Face.text(14)).foregroundStyle(Ink.muted)
              // (the same sheet and the same file as the kit's page: KitScreen.swift)
              KitSheet(email: st.email, words: k, accountId: st.accountId, qr: model.kitQR(st.accountId))
              HStack(spacing: 12) {
                ShareLink(item: KitFile(text: emergencyKitText(EmergencyKit(words: k, email: st.email, accountId: st.accountId))), preview: SharePreview(KIT_FILE_NAME)) { Text("Save") }.buttonStyle(QuietWay())
                Button("Print") { printKit(EmergencyKit(words: k, email: st.email, accountId: st.accountId), qr: model.kitQR(st.accountId)) }.buttonStyle(QuietWay())
              }
            }.padding(16)
          } else {
            VStack(alignment: .leading, spacing: 10) {
              Text(st.hasRecovery ? "Make a New Kit" : "Make the Emergency Kit").font(Face.text(17, .medium))
              if st.hasPassword {
                HStack {
                  SecureField("Your Password", text: $kitPassword).textContentType(.password).font(Face.text(16)).padding(10).background(RoundedRectangle(cornerRadius: 10).strokeBorder(Ink.lineStrong))
                  Button("Make") { run { let r = try await model.room?.makeEmergencyKit(password: kitPassword); kit = r?.words; kitPassword = ""; await load() } }.buttonStyle(QuietWay()).disabled(kitPassword.isEmpty)
                }
              } else {
                // (an account without a password: one of its passkeys opens it)
                Button("Make with Passkey") { run(passkey: true) { guard let r = model.room else { return }; kit = try await r.makeEmergencyKit(way: try await model.wayIn(r, password: nil)).words; await load() } }.buttonStyle(QuietWay())
              }
            }.padding(16)
          }
        }
        if !st.hasPassword {
          SettingsGroup(header: "Passkeys", footer: "This account opens with a passkey; it has no password. If you lose your passkeys and your Emergency Kit, nobody (not even Trommi) can recover your data.") {
            SettingsRow(title: st.passkeys.count == 1 ? "1 Passkey" : "\(st.passkeys.count) Passkeys") { Sketch("key") }
          }
          if model.passkeysOn {
            SettingsGroup(footer: "For after you removed a device that is lost or no longer yours. You get a new Emergency Kit; the old kit stops working, and your other passkeys have to be added again.") {
              Button { codeAsk = true } label: { SettingsRow(title: "New Recovery Code…") { Sketch("key") } }.buttonStyle(.plain)
            }
            .alert("New Recovery Code", isPresented: $codeAsk) {
              Button("Use Passkey") { run(passkey: true) { guard let r = model.room else { return }; kit = try await r.replaceRecoveryCode(way: try await model.wayIn(r, password: nil)).words; said = "New recovery code made. Save your new Emergency Kit."; await load() } }
              Button("Cancel", role: .cancel) {}
            } message: { Text("Your passkey opens the account. Then save or print the new Emergency Kit.") }
            SettingsGroup {
              // (a passkey of the account opens its key, which the new passkey then holds too)
              Button { run(passkey: true) { guard let r = model.room else { return }; let way = try await model.wayIn(r, password: nil); try await r.addPasskey(way: way) { try await Passkeys.make($0) }; said = "Passkey added."; await load() } } label: { SettingsRow(title: "Add Passkey") { Sketch("key") } }.buttonStyle(.plain)
            }
          }
        } else {
        SettingsGroup(header: "Password", footer: "If you lose your password and your Emergency Kit, nobody (not even Trommi) can recover your data.") {
          VStack(alignment: .leading, spacing: 8) {
            SecureField("Current Password", text: $current).textContentType(.password).font(Face.text(16)).padding(10).background(RoundedRectangle(cornerRadius: 10).strokeBorder(Ink.lineStrong))
            HStack {
              SecureField("New Password (at least 12 characters)", text: $next).textContentType(.password).font(Face.text(16)).padding(10).background(RoundedRectangle(cornerRadius: 10).strokeBorder(Ink.lineStrong))
              Button { next = generatePassword() } label: { Image(systemName: "dice") }.accessibilityLabel("Suggest a Password")
            }
            if !next.isEmpty && next.count >= 12 { Text(next).font(Face.mono(13)).foregroundStyle(Ink.muted).textSelection(.enabled) }
            Button("Change Password") { run { try await model.room?.changePassword(current: current, next: next); current = ""; next = ""; said = "Password changed." } }
              .buttonStyle(QuietWay()).disabled(passwordProblem(next) != nil || current.isEmpty)
          }.padding(16)
        }
        if st.hasPassword {
          // (spec/v1.md 8.6: the room gets a new recovery code; the new kit shows in the Emergency Kit group above)
          SettingsGroup(footer: "For after you removed a device that is lost or no longer yours. You get a new Emergency Kit; the old kit stops working, and passkeys have to be added again.") {
            Button { codeAsk = true } label: { SettingsRow(title: "New Recovery Code…") { Sketch("key") } }.buttonStyle(.plain)
          }
          .alert("New Recovery Code", isPresented: $codeAsk) {
            SecureField("Your Password", text: $codePassword)
            Button("Make New Code") {
              let p = codePassword
              codePassword = ""
              run { let r = try await model.room?.replaceRecoveryCode(way: .password(p)); kit = r?.words; said = "New recovery code made. Save your new Emergency Kit."; await load() }
            }
            Button("Cancel", role: .cancel) { codePassword = "" }
          } message: { Text("Your password opens the account. Then save or print the new Emergency Kit.") }
        }
        if model.passkeysOn && st.hasPassword {
          SettingsGroup {
            Button { passkeyAsk = true } label: { SettingsRow(title: "Add Passkey") { Sketch("key") } }.buttonStyle(.plain)
          }
          // (the password opens the account's key, which the new passkey then holds too)
          .alert("Add Passkey", isPresented: $passkeyAsk) {
            SecureField("Your Password", text: $passkeyPassword)
            Button("Add Passkey") {
              let p = passkeyPassword
              passkeyPassword = ""
              run(passkey: true) { try await model.room?.addPasskey(password: p) { try await Passkeys.make($0) }; said = "Passkey added."; await load() }
            }
            Button("Cancel", role: .cancel) { passkeyPassword = "" }
          }
        }
        }
      } else {
        SettingsGroup(footer: "This account was made before email and password: add a login at app.trommi.com → Settings → Account (it needs the recovery code shown when you started).") {
          SettingsRow(title: "No Login Yet") { Sketch("letter") }
        }
      }
      if let r = model.room {
        SettingsGroup(header: "This Device") {
          SettingsRow(title: "Room", detail: "\(String(r.record.roomId.prefix(12)))…") { Sketch("key") }
          RowRule()
          SettingsRow(title: "Hub", detail: r.record.hubURL.replacingOccurrences(of: "https://", with: "")) { Sketch("link") }
          RowRule()
          SettingsRow(title: "Version", detail: "Trommi \(HubClient.appVersion) · key epoch \(r.state.epoch)") { PenMark("ui:BELL", color: Ink.fg) }
        }
        SettingsGroup(footer: "This device forgets the room and its keys. To take it out of the room, remove it under Devices on another device. Your other devices and your agents carry on.") {
          Button { leave = true } label: { SettingsRow(title: "Log Out…", tint: Ink.urgCritical) { PenMark("sidebar:LEAVE", color: Ink.urgCritical) } }.buttonStyle(.plain)
        }
        .confirmationDialog("Log Out of This Device?", isPresented: $leave, titleVisibility: .visible) {
          Button("Log Out", role: .destructive) { model.logOut() }
        } message: { Text("This phone logs in again with email and password or by scanning the code of a signed-in device.") }
      }
    }
    .task { await load() }
  }
  private func load() async { if !model.demo { status = try? await model.room?.accountStatus() }; loaded = true }
  /** `passkey`: what went wrong is said in the passkey's words, which the sign-in screen shares. */
  private func run(passkey: Bool = false, _ op: @escaping () async throws -> Void) {
    error = ""; said = ""
    Task {
      do { try await op() }
      catch {
        let code = (error as? TrommiError)?.code ?? (error as? HubError)?.code ?? ""
        if passkey && code != "wrong-login" { self.error = model.accountError(error); return }
        // (a wait the hub names is said as it is)
        if code == "rate-limited", let wait = retryWait(of: error) { self.error = "Too many tries. Please wait \(waitText(seconds: wait))."; return }
        self.error = ["wrong-login": "That password is not right.", "weak-password": "The password needs at least 12 characters.", "wrong-code": "Wrong or expired code.",
                      "account-changed": "Changed on another device meanwhile. Please try again.",
                      "pending": "Trommi has not answered yet. Check again later; if no new kit shows then, make a new Emergency Kit.", "rate-limited": "Too many tries. Please wait a few minutes."][code] ?? model.describe(error)
      }
    }
  }
}

// ---- Theme -----------------------------------------------------------------------------------------------------

struct ThemePage: View {
  @EnvironmentObject var model: BoardModel
  var body: some View {
    SettingsPage(title: "Theme") {
      SettingsGroup(footer: "System follows the iPhone’s appearance.") {
        ForEach(Array(ThemeMode.allCases.enumerated()), id: \.element) { i, t in
          if i > 0 { RowRule() }
          Button { model.theme = t } label: {
            SettingsRow(title: t.word) {
              Group { if t == .dark { Sketch("moon") } else if t == .light { Sketch("sun") } else { Sketch("frame") } }
            }
            .overlay(alignment: .trailing) { if model.theme == t { Sketch("tick", color: Ink.accent).frame(width: 20, height: 20).padding(.trailing, 16) } }
          }.buttonStyle(.plain)
          .accessibilityAddTraits(model.theme == t ? .isSelected : [])
        }
      }
    }
  }
}

// ---- inviting a device ------------------------------------------------------------------------------------------

/** Invite a Device (his decision, 8 October): the QR code blurred until he taps Show Code (the code is a key to the room
 *  while it is open, so the invite is made only then); the new device scans it; both show six emoji; They Match. */
struct InviteDeviceSheet: View {
  @EnvironmentObject var model: BoardModel
  @Environment(\.dismiss) private var dismiss
  @StateObject private var pairing = PairingModel()
  @State private var revealed = false
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 18) {
          Text("On the new device open Trommi (the app or app.trommi.com) and choose Scan QR Code. Both devices then show six emoji: if they are the same, tap They Match.")
            .font(Face.text(16)).foregroundStyle(Ink.muted).multilineTextAlignment(.center)
          switch pairing.state {
          case .open(let link, let until) where revealed:
            QRCode(text: link).frame(width: 240, height: 240).padding(12).background(RoundedRectangle(cornerRadius: 16).fill(.white))
            HStack(spacing: 18) {
              ShareLink(item: link) { Label("Send Link", systemImage: "square.and.arrow.up").font(Face.text(15, .medium)) }
              Button { revealed = false; pairing.cancel(); pairing.state = .making } label: { Label("Hide Code", systemImage: "eye.slash").font(Face.text(15, .medium)) }
            }
            TimelineView(.periodic(from: .now, by: 30)) { _ in
              Text("Waiting for the new device… The code works once, \(validFor(until)).").font(Face.text(14)).foregroundStyle(Ink.muted)
            }
          case .confirm(let code):
            Text("A device wants to join. Does it show these six emoji, in this order?").font(Face.text(17, .medium)).multilineTextAlignment(.center)
            EmojiGrid(code: code)
            HStack(spacing: 12) {
              Button { pairing.confirm(false) } label: { Text("They Don’t Match").font(Face.text(16, .semibold)).frame(maxWidth: .infinity, minHeight: 52) }.buttonStyle(TileStyle(lead: false, hue: 162))
              Button { pairing.confirm(true) } label: { Text("They Match").font(Face.text(16, .semibold)).frame(maxWidth: .infinity, minHeight: 52) }.buttonStyle(TileStyle(lead: true, hue: 162))
            }
            Text("They Don’t Match burns the invite: nobody is added.").font(Face.text(13)).foregroundStyle(Ink.muted)
          case .adding: ProgressView("Adding the device…").padding(40)
          case .joined(let name):
            Text("✓ \(name.isEmpty ? "The new device" : name) is in now.").font(Face.display(22, .bold)).foregroundStyle(Ink.accent)
            Button("Invite Another") { revealed = false; pairing.state = .making }.buttonStyle(QuietWay())
          case .failed(let why):
            Text(why).font(Face.text(16)).foregroundStyle(Ink.urgCritical).multilineTextAlignment(.center)
            Button("Try Again") { reveal() }.buttonStyle(QuietWay())
          default:
            // the code, blurred: a stand-in until he reveals the real one (nothing is made before)
            Button(action: reveal) {
              ZStack {
                QRCode(text: "https://app.trommi.com/join#v2.stand-in-for-the-blur").frame(width: 240, height: 240).padding(12)
                  .background(RoundedRectangle(cornerRadius: 16).fill(.white)).blur(radius: 10).opacity(0.75)
                if revealed { ProgressView() } else {
                  Label("Show Code", systemImage: "eye").font(Face.text(16, .semibold)).foregroundStyle(Ink.fg)
                    .padding(.horizontal, 16).padding(.vertical, 10).glass(Capsule(), interactive: true)
                }
              }
            }.buttonStyle(.plain).accessibilityLabel("Show Code")
          }
        }
        .padding(24).frame(maxWidth: .infinity)
      }
      .background(Ink.bg.ignoresSafeArea())
      .navigationTitle("Invite a Device").navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { pairing.cancel(); dismiss() } } }
    }
    .onDisappear { pairing.cancel() }
  }
  private func reveal() {
    revealed = true
    if model.demo { pairing.state = .failed("The demo invites nobody: it is a made-up room on this phone."); return }
    pairing.start(model.room)
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
  /** What VoiceOver calls it: the code to pair a device, or (the Emergency Kit's sheet) the one with the account id. */
  var label = "QR code to pair"
  var body: some View {
    #if canImport(UIKit)
    if let img = qrImage(text) { Image(uiImage: img).interpolation(.none).resizable().scaledToFit().accessibilityLabel(label) }
    #endif
  }
}
#if canImport(UIKit)
/** A QR code as a picture: for `QRCode`, and for the printed Emergency Kit (KitScreen.swift). */
func qrImage(_ text: String) -> UIImage? {
  let f = CIFilter.qrCodeGenerator()
  f.message = Data(text.utf8)
  f.correctionLevel = "M"
  guard let out = f.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)), let cg = CIContext().createCGImage(out, from: out.extent) else { return nil }
  return UIImage(cgImage: cg)
}
#endif

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
    switch (e as? TrommiError)?.code {
    case "code-mismatch": return "They did not match. Nobody was added; the invite is used up."
    case "invite-expired": return "The invite has expired."
    default: return "That did not work: \((e as? TrommiError)?.message ?? (e as? HubError)?.message ?? "\(e)")"
    }
  }
}


/** Inviting an agent (auth.mjs clipboard): 1 the command to copy into a terminal in the project, 2 compare the six emoji, 3 start Claude Code there. */
struct AgentInviteSheet: View {
  @EnvironmentObject var model: BoardModel
  @Environment(\.dismiss) private var dismiss
  let label: String
  @State private var state = "making"     // making | open | confirm | adding | joined | failed
  @State private var inv: Room.AgentInvite?
  @State private var code = ""
  @State private var error = ""
  @State private var task: Task<Void, Never>?
  @State private var demoLink: String?
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          Text(label.isEmpty ? "Invite Agent" : "Invite \(label)").font(Face.display(26, .heavy))
          Text("On a computer with Claude Code or Codex.").font(Face.text(15)).foregroundStyle(Ink.muted)
          step(1, done: state != "making" && state != "open", "Copy these into a terminal") {
            if let link = inv?.pairing.link ?? demoLink, state == "open" {
              ForEach(Array(agentConnectSteps(link: link).enumerated()), id: \.offset) { _, s in
                VStack(alignment: .leading, spacing: 4) {
                  Text(s.title).font(Face.text(13, .medium)).foregroundStyle(Ink.muted)
                  CodeChip(text: s.command)
                }
              }
              Text("For Codex instead of Claude Code: \(agentConnectSteps(link: "", codex: true)[1].command)").font(Face.text(13)).foregroundStyle(Ink.muted)
            }
          }
          step(2, done: state == "joined", state == "confirm" ? "An agent wants to join. Its terminal shows six emoji, each with a word. Are they these, in this order?" : "Compare the six emoji") {
            if state == "confirm" {
              EmojiGrid(code: code)
              HStack(spacing: 12) {
                Button { confirm(false) } label: { Text("They Don’t Match").font(Face.text(16, .semibold)).frame(maxWidth: .infinity, minHeight: 50) }.buttonStyle(TileStyle(lead: false, hue: 162))
                Button { confirm(true) } label: { Text("They Match").font(Face.text(16, .semibold)).frame(maxWidth: .infinity, minHeight: 50) }.buttonStyle(TileStyle(lead: true, hue: 162))
              }
            } else if state == "adding" { ProgressView("Adding the agent…") }
            else if state == "joined" { Text("✓ The agent is in.").font(Face.text(17, .semibold)).foregroundStyle(Ink.accent) }
            else if state == "failed" { Text(error).font(Face.text(15)).foregroundStyle(Ink.urgCritical) }
          }
          step(3, done: state == "joined", "Start Claude Code there") { CodeChip(text: "claude") }
          if state == "open", let i = inv { TimelineView(.periodic(from: .now, by: 30)) { _ in Text("The link works once · \(validFor(i.pairing.expiresAt)).").font(Face.text(13)).foregroundStyle(Ink.muted) } }
        }.padding(22)
      }
      .background(Clipboard().padding(10).ignoresSafeArea(edges: .bottom))
      .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { task?.cancel(); dismiss() } } }
    }
    .onAppear(perform: start)
  }
  @ViewBuilder private func step<C: View>(_ n: Int, done: Bool, _ title: String, @ViewBuilder _ content: () -> C) -> some View {
    HStack(alignment: .top, spacing: 12) {
      PenMark(done ? "desk:BOX_TICK" : "desk:BOX", color: Ink.fg).frame(width: 26, height: 26)
      VStack(alignment: .leading, spacing: 10) { Text(title).font(Face.text(17, .semibold)).foregroundStyle(Ink.fg); content() }
    }
  }
  private func start() {
    // (the demo shows the three lines with a made-up link: nothing is invited)
    guard let room = model.room else { if model.demo { demoLink = "https://app.trommi.com/join#v2.ZGVtbw.ZGVtbw.ZGVtbw.ZGVtbw"; state = "open" }; return }
    task = Task {
      do {
        var i = try await room.createAgentInvite(label: label.isEmpty ? nil : label, desk: model.view?.all == true ? nil : model.view?.deskId)
        inv = i; state = "open"
        while !Task.isCancelled {
          if try await room.checkPairing(&i.pairing) { inv = i; code = i.pairing.code ?? ""; state = "confirm"; return }
          try await Task.sleep(nanoseconds: 1_000_000_000)
        }
      } catch is CancellationError {} catch { self.error = model.describe(error); state = "failed" }
    }
  }
  private func confirm(_ yes: Bool) {
    guard let room = model.room, let i = inv else { return }
    state = "adding"
    Task {
      do { try await room.confirmAgent(i, matches: yes); state = "joined" }
      catch { self.error = (error as? TrommiError)?.code == "code-mismatch" ? "They did not match: nobody was added." : model.describe(error); state = "failed" }
    }
  }
}

