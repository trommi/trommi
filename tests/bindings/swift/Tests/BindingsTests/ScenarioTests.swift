// Runs tests/bindings/scenario.json through the Swift binding. The steps mean what they mean in
// tests/bindings/scenario.mjs, which runs the same file through the browser binding.
import Foundation
import XCTest
import TrommiCoreRust

/// One step of the scenario, as the JSON spells it.
struct Step: Decodable {
  let `do`: String
  var device: String?
  var by: String?
  var agent: String?
  var humans: [String]?
  var devices: [String]?
  var group: String?
  var name: String?
  var number: UInt32?
  var text: String?
  var message: String?
  var bytes: Int?
  var pieces: Int?
  var count: Int?
  var remember: Bool?
  var same: Bool?
  var removed: Bool?
  var refused: String?
  var epoch_of: String?
  var like: String?
  var role: String?
  var writer: String?
  var reader: String?
  var chat: String?
  var confirmed: Bool?
  var early: Bool?
  var feed: Bool?
  var register: Bool?
  var groups: [String]?
  var session: String?
  var parent: String?
  var helper: String?
  var helpers: [String]?
  var epoch: UInt64?
}

struct Scenario: Decodable {
  let steps: [Step]
}

struct Unexpected: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }
}

func check(_ holds: Bool, _ what: String) throws {
  if !holds { throw Unexpected(what) }
}

func now() -> UInt64 { UInt64(Date().timeIntervalSince1970 * 1000) }

/// The least a hub does: one change counter, the ordered log, the Welcomes, and what it serves a device that
/// comes with the recovery code (every GroupInfo of the room group, every SealedKey, the links).
final class Hub {
  var change: UInt64 = 0
  /// One order for the log's entries and the stored envelopes: an envelope has an empty `recoveryAuth` and is
  /// told apart by `envelopes`, the change numbers that are envelopes.
  var log: [LogEntry] = []
  var envelopes: Set<UInt64> = []
  /// Who posted each envelope, by its change number.
  var posted: [UInt64: Data] = [:]
  /// Application messages that are only passed on.
  var relayed: [(group: Data, bytes: Data)] = []
  var welcomes: [(change: UInt64, bytes: Data)] = []
  /// The room group's GroupInfo of every epoch, from its founding.
  var roomInfos: [Data] = []
  /// Per session group: its founding GroupInfo and its newest.
  var sessions: [Data: (founding: Data, current: Data)] = [:]
  var rows: [Data] = []
  var links: [Data] = []

  /// Posts everything in the device's outbox and reports each as accepted.
  func post(_ device: CoreDevice) throws {
    for entry in try device.outbox() {
      func part(_ at: Int) -> Data { at < entry.parts.count ? entry.parts[at] : Data() }
      // Where the Commit, its GroupInfo, its Welcome, its SealedKey and its RecoveryAuth stand among the parts.
      var commit: (bytes: Data, groupInfo: Data, welcome: Data, sealedKey: Data, recoveryAuth: Data?)?
      switch entry.kind {
      case .groupFounding:
        rows.append(part(1))
        sessions[entry.group ?? Data()] = (part(0), part(0))
        commit = (part(2), part(3), part(4), part(5), nil)
      case .commit: commit = (part(0), part(1), part(2), part(3), nil)
      case .externalCommit: commit = (part(0), part(1), Data(), part(2), part(3))
      case .recoveryCode:
        commit = (part(0), part(1), Data(), part(2), nil)
        links.append(part(3))
      case .recoveryCommit: commit = (part(0), part(1), part(2), part(3), part(4).isEmpty ? nil : part(4))
      case .recoveryFinish: links.append(part(0))
      default: break
      }
      var accepted: UInt64?
      if entry.kind == .roomFounding {
        roomInfos.append(part(0))
        rows.append(part(1))
        change += 1
        accepted = change
      } else if let commit, let group = entry.group {
        change += 1
        accepted = change
        rows.append(commit.sealedKey)
        if group.count == 32 { roomInfos.append(commit.groupInfo) } else { sessions[group]?.current = commit.groupInfo }
        if !commit.welcome.isEmpty { welcomes.append((change, commit.welcome)) }
        log.append(LogEntry(change: change, group: group, kind: .commit, bytes: commit.bytes, recoveryAuth: commit.recoveryAuth))
      } else if entry.kind == .message, let group = entry.group {
        change += 1
        accepted = change
        log.append(LogEntry(change: change, group: group, kind: .message, bytes: part(0), recoveryAuth: nil))
      } else if entry.kind == .envelope, let group = entry.group {
        // A stored envelope has its place in the same one order as the log's entries.
        change += 1
        accepted = change
        envelopes.insert(change)
        // The header reads without a device, and is the one the outbox entry is for.
        let info = try envelopeHeader(envelope: part(0))
        guard info.header.group == group, info.header.sender == (try device.id()), !info.pruned else { throw Unexpected("the envelope's header is another") }
        posted[change] = try device.id()
        log.append(LogEntry(change: change, group: group, kind: .message, bytes: part(0), recoveryAuth: nil))
      } else if entry.kind == .relayMessage, let group = entry.group {
        // Passed on, never stored: no change number.
        relayed.append((group, part(0)))
      }
      try device.outboxAccepted(id: entry.id, change: accepted)
    }
    // What the hub accepted comes back in its log: a device merges its own Commits there, at their place.
    _ = try feed(device, room: nil)
  }

  /// A group as the hub serves it to a device that verifies it from its founding.
  func served(_ group: Data, founding: Data, current: Data) -> ServedGroup {
    let commits = log.filter { $0.kind == .commit && $0.group == group && !envelopes.contains($0.change) }
      .map { ServedCommit(change: $0.change, commit: $0.bytes, recoveryAuth: $0.recoveryAuth) }
    return ServedGroup(founding: founding, commits: commits, current: current)
  }

  /// The room as the hub serves it to a device that comes with the recovery code.
  func servedRoom(_ room: Data, code: Data) throws -> ServedRoom {
    let anchor = try recoveryAnchor(recoveryCode: code, room: room, rows: rows)
    return ServedRoom(
      room: room, group: served(room, founding: roomInfos[0], current: roomInfos[roomInfos.count - 1]),
      anchor: roomInfos[Int(anchor.epoch)], rows: rows, links: links,
      sessions: sessions.map { served($0.key, founding: $0.value.founding, current: $0.value.current) })
  }

  /// Hands the device everything after its cursor, with every Welcome at its place. Returns what the log's
  /// entries did and what became of the envelopes.
  func sync(_ device: CoreDevice, room: Data, batched: Bool = false) throws -> (done: [Processed], envelopes: [ReceivedEnvelope]) {
    try feed(device, room: room, batched: batched)
  }

  /// The log after the device's cursor, strictly by change number; with `room`, also the Welcomes at their places.
  func feed(_ device: CoreDevice, room: Data?, batched: Bool = false) throws -> (done: [Processed], envelopes: [ReceivedEnvelope]) {
    var done: [Processed] = []
    var received: [ReceivedEnvelope] = []
    let cursor = try device.cursor()
    let after = log.filter { $0.change > cursor }
    func join(_ entry: LogEntry) {
      guard let room else { return }
      for welcome in welcomes where welcome.change == entry.change {
        // A Welcome for another device does not open here: that is no finding.
        _ = try? device.joinWelcome(welcome: welcome.bytes, room: room, committer: nil, nowMs: now())
      }
    }
    if batched {
      // Through the batch call: a batch ends where a Welcome is due, and goes on behind an entry that is passed over.
      var rest = after[...]
      while let first = rest.first {
        _ = first
        let due = room == nil ? nil : rest.firstIndex { entry in welcomes.contains { $0.change == entry.change } }
        let end = due.map { $0 + 1 } ?? rest.endIndex
        let batch = Array(rest[rest.startIndex..<end])
        let items = batch.map { entry in
          envelopes.contains(entry.change)
            ? FeedItem(entry: nil, envelope: ServedEnvelope(bytes: entry.bytes, change: entry.change, voidCode: nil))
            : FeedItem(entry: entry, envelope: nil)
        }
        let fed = try device.feed(items: items, nowMs: now())
        for outcome in fed.outcomes {
          if let envelope = outcome.envelope { received.append(envelope) }
          if let processed = outcome.processed { done.append(processed) }
        }
        guard let refusedAt = fed.refusedAt, let code = fed.code else {
          join(batch[batch.count - 1])
          rest = rest[end...]
          continue
        }
        guard logFinding(code: code) == .duplicate else { throw CoreError.Refused(code: code, message: fed.message ?? "") }
        join(batch[Int(refusedAt)])
        rest = rest[(rest.startIndex + Int(refusedAt) + 1)...]
      }
      return (done, received)
    }
    for entry in after {
      if envelopes.contains(entry.change) {
        received.append(try device.receiveEnvelope(envelope: entry.bytes, change: entry.change, ordered: true, voidCode: nil, nowMs: now()))
        continue
      }
      do {
        done.append(try device.processLogEntry(entry: entry, nowMs: now()))
      } catch let CoreError.Refused(code, _) where logFinding(code: code) == .duplicate {
        // An entry behind what the device holds (its own Commit, a group's Commits before it joined) is passed over.
      }
      join(entry)
    }
    return (done, received)
  }
}

/// The code a call is refused with; nil when it is not refused.
func refusal(_ work: () throws -> Void) -> ErrorCode? {
  do { try work() } catch let CoreError.Refused(code, _) { return code } catch { return .internal }
  return nil
}

/// A draft of the kind `kind` with nothing else filled in.
func draft(_ kind: DraftKind) -> Draft {
  Draft(
    kind: kind, session: nil, card: nil, board: nil, group: nil, name: nil, value: nil, objectId: nil, requestId: nil,
    choices: nil, closes: nil, closed: nil, allow: nil, urgency: nil, push: nil, expiresAt: nil, payload: nil)
}

/// The board of all desks: the one board id that is no Desk's.
let allDesks = Data("all-desks".utf8) + Data([0, 0, 0, 0, 0, 0, 9])

final class ScenarioTests: XCTestCase {
  let hub = Hub()
  var stores: [String: FileStore] = [:]
  var devices: [String: CoreDevice] = [:]
  var groups: [String: Data] = [:]
  var remembered: [String: [OutboxEntry]] = [:]
  var room = Data()
  /// How many messages same_key had written.
  var spoken = 0
  /// Per device, the envelopes its syncs brought.
  var seen: [String: [ReceivedEnvelope]] = [:]
  /// The recovery code in force.
  var code = Data()
  var folder = URL(fileURLWithPath: NSTemporaryDirectory())

  override func setUpWithError() throws {
    folder = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("trommi-bindings-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
  }

  override func tearDown() {
    devices.values.forEach { $0.close() }
    try? FileManager.default.removeItem(at: folder)
  }

  func device(_ name: String?) throws -> CoreDevice {
    guard let name, let device = devices[name] else { throw Unexpected("no device \(name ?? "?")") }
    return device
  }

  func group(_ name: String?) throws -> Data {
    guard let name, let group = groups[name] else { throw Unexpected("no group \(name ?? "?")") }
    return group
  }

  /// A device on the stored state `name`, new or as stored.
  func start(_ name: String, create: Bool) throws -> (CoreDevice, FileStore) {
    // A device that closes, or cannot be opened, lets its store go itself: the lock is free again.
    let store = FileStore(directory: folder.appendingPathComponent(name))
    return (create ? try CoreDevice.create(store: store) : try CoreDevice.open(store: store), store)
  }

  func key(_ name: String, _ groupName: String?) throws -> (epoch: UInt64, held: Bool) {
    let id = try group(groupName)
    let epoch = try device(name).group(group: id).epoch
    return (epoch, try device(name).holdsKey(group: id, epoch: epoch))
  }

  /// The applied or shown envelope among `envelopes` whose body is a Chat message with `text`.
  func chat(in envelopes: [ReceivedEnvelope], _ text: String) -> ReceivedEnvelope? {
    envelopes.first { envelope in
      guard let payload = envelope.payload, let body = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] else { return false }
      return body["text"] as? String == text
    }
  }

  func run(_ step: Step) throws {
    switch step.do {
    case "create":
      let (device, store) = try start(step.device!, create: true)
      devices[step.device!] = device
      stores[step.device!] = store
    case "found_room":
      code = try generateRecoveryCode()
      room = try device(step.device).foundRoom(recoveryCode: code, nowMs: now())
      groups["room"] = try roomGroupId(room: room)
    case "post":
      try hub.post(device(step.device))
    case "invite":
      try invite(by: step.by!, device: step.device!, agent: step.role == "agent", session: nil)
    case "hand_over":
      let steps = try device(step.by).inviteSteps().filter { $0.kind == .handover }
      try check(steps.count == 1, "the invite asks for no handover")
      _ = try device(step.by).inviteHandover(inviteId: steps[0].inviteId)
    case "join":
      guard let welcome = hub.welcomes.last?.bytes else { throw Unexpected("no Welcome") }
      let inviter = try device(step.by).id()
      let joined = try device(step.device).joinInvited(welcome: welcome, nowMs: now())
      try check(joined.offending.isEmpty && joined.addedBy == inviter, "the join is not the expected one")
    case "same_key":
      let keys = try step.devices!.map { try key($0, step.group) }
      try check(keys.allSatisfy { $0.epoch == keys[0].epoch && $0.held }, "the devices do not share the key of \(step.group!)")
      // Holding a key says little: in a session, what the first writes now, every other one must open.
      if step.group == "room" { return }
      spoken += 1
      let said = "same key \(spoken)"
      try say(step.devices![0], in: step.group, said)
      try hub.post(device(step.devices![0]))
      for name in step.devices!.dropFirst() {
        let envelopes = try hub.sync(device(name), room: room).envelopes
        try check(chat(in: envelopes, said)?.outcome == .applied, "\(name) did not open what \(step.devices![0]) wrote in \(step.group!)")
      }
    case "gate":
      // The command gate of an agent device, for the Chat message with this text: act once, then done.
      let agent = try device(step.device)
      guard let envelope = chat(in: (seen[step.device!] ?? []).reversed(), step.text!), envelope.command else {
        throw Unexpected("the message is not one the gate is asked about")
      }
      try check(try agent.commandsPending().contains(envelope.envelopeHash), "the command is not pending")
      let first = try agent.command(envelopeHash: envelope.envelopeHash, nowMs: now())
      try check(first.gate == .act && first.command == .chat, "the gate answered \(first.gate)")
      try check(try agent.commandsUncertain().contains(envelope.envelopeHash), "a started command is not known as unfinished")
      try agent.commandFinished(envelopeHash: envelope.envelopeHash)
      try check(try agent.command(envelopeHash: envelope.envelopeHash, nowMs: now()).gate == .done, "a finished command was let through again")
      try check(refusal { _ = try agent.command(envelopeHash: Data(count: 32), nowMs: now()) } == .notFound, "the gate answered for an envelope it never saw")
    case "sign_in":
      let signed = try device(step.device).hubSignIn(hub: "https://hub.example", challenge: Data(repeating: 9, count: 32))
      try check(signed.signature.count == 64 && signed.auth.count > 96, "the sign-in is not a signed HubAuth")
    case "sync":
      let (done, envelopes) = try hub.sync(device(step.device), room: room, batched: step.feed == true)
      seen[step.device!, default: []] += envelopes
      if let expected = step.message {
        let message = done.first { $0.kind == .message }?.message
        try check(message?.kind == .workTrail && message?.payload == Data(expected.utf8), "the message did not arrive as it was sent")
      }
      if step.removed == true { try check(done.contains { $0.removed }, "the device did not learn of its removal") }
      if let text = step.chat {
        let envelope = chat(in: envelopes, text)
        try check(
          envelope?.outcome == .applied && envelope?.header.kind == .item && envelope?.header.timeline?.kind == .sessionChat,
          "the Chat message was not applied")
        // One that was shown before its turn is now confirmed by its sender's chain.
        if step.confirmed == true { try check(envelope?.confirmed == true, "the fetched envelope was not confirmed by its chain") }
      }
    case "chat":
      try say(step.device!, in: step.group, step.text!)
    case "fetch":
      // The newest envelope, handed over out of order, before the entries in front of it: shown, not yet confirmed.
      guard let entry = hub.log.last(where: { hub.envelopes.contains($0.change) }) else { throw Unexpected("no envelope") }
      let cursor = try device(step.device).cursor()
      let fetched = try device(step.device).receiveEnvelope(envelope: entry.bytes, change: entry.change, ordered: false, voidCode: nil, nowMs: now())
      try check(fetched.outcome == .provisional && chat(in: [fetched], step.text!) != nil, "an envelope fetched out of order is \(fetched.outcome)")
      try check(try device(step.device).cursor() == cursor, "an envelope fetched out of order moved the cursor")
    case "stroke":
      // A stroke still being drawn: relayed, never stored.
      _ = try device(step.device).sendStrokePiece(board: allDesks, piece: Data(#"{"stroke":"AAAAAAAAAAAAAAAAAAAAAA","number":1}"#.utf8))
    case "relay":
      guard let relayed = hub.relayed.last else { throw Unexpected("nothing was relayed") }
      let cursor = try device(step.device).cursor()
      let piece = try device(step.device).receiveRelay(group: relayed.group, message: relayed.bytes, nowMs: now())
      let body = try piece.flatMap { try JSONSerialization.jsonObject(with: $0.payload) as? [String: Any] }
      try check(piece?.kind == .strokePiece && piece?.board == allDesks && (body?["number"] as? NSNumber)?.intValue == 1, "the stroke piece did not arrive")
      try check(try device(step.device).cursor() == cursor, "a relayed message moved the cursor")
    case "board":
      try board(writer: device(step.writer), reader: device(step.reader))
    case "found_session":
      // The agent's KeyPackage is the one of its confirmed Request, which the invite's next step names.
      let agent = try device(step.agent).id()
      guard let next = try device(step.by).inviteSteps().first(where: { $0.kind == .foundSession }), next.device == agent,
        let invited = next.keyPackage
      else { throw Unexpected("the invite asks for no session") }
      let keyPackages = try [invited] + step.humans!.map { try device($0).keyPackage(nowMs: now()) }
      let session = try device(step.by).foundSession(agent: device(step.agent).id(), keyPackages: keyPackages, nowMs: now())
      groups[step.name!] = try sessionGroupId(room: room, session: session)
    case "work_trail":
      _ = try device(step.device).sendWorkTrail(
        group: group(step.group), turn: Data(repeating: 7, count: 16), number: step.number!, step: Data(step.text!.utf8), nowMs: now())
    case "file":
      try file(bytes: step.bytes!, pieces: step.pieces!)
    case "restart":
      let name = step.device!
      let id = try? device(name).id()
      devices[name]?.close()
      let (again, store) = try start(name, create: false)
      devices[name] = again
      stores[name] = store
      if let id { try check(try again.id() == id, "the device opened from its store is another") }
    case "update":
      _ = try device(step.device).update(group: group(step.group), forced: true, nowMs: now())
    case "outbox":
      let outbox = try device(step.device).outbox()
      try check(outbox.count == step.count!, "the outbox of \(step.device!) holds \(outbox.count), not \(step.count!)")
      if step.remember == true { remembered[step.device!] = outbox }
      if step.same == true { try check(outbox == remembered[step.device!], "the outbox is not the same after the restart") }
    case "fail_next_write":
      stores[step.device!]!.failNextWrite()
    case "second_owner":
      let (second, _) = try start(step.device!, create: false)
      second.close()
    case "remove_human":
      let gone = try device(step.by).cutOf(group: group("room"), device: device(step.device).id())
      _ = try device(step.by).removeHumanDevices(cuts: [gone], nowMs: now())
    case "clean_session":
      let id = try group(step.group)
      let cuts = try device(step.by).group(group: id).disallowed.map { try device(step.by).cutOf(group: id, device: $0) }
      _ = try device(step.by).cleanSession(group: id, cuts: cuts, replacement: nil, nowMs: now())
    case "join_with_code":
      let joined = try device(step.device).joinRoomWithCode(recoveryCode: code, served: hub.servedRoom(room, code: code), nowMs: now())
      try check(joined.outbox.count == 1 && joined.unverified.isEmpty && joined.missingLink == nil, "the room did not verify whole")
    case "join_session_with_code":
      let id = try group(step.group)
      guard let session = hub.sessions[id] else { throw Unexpected("the hub has no such session") }
      _ = try device(step.device).joinSessionWithCode(
        recoveryCode: code, served: hub.served(id, founding: session.founding, current: session.current), nowMs: now())
    case "earlier_key":
      let id = try group(step.group)
      let held = try [step.device, step.like].allSatisfy { try device($0).holdsKey(group: id, epoch: step.epoch!) }
      try check(held && (try device(step.device).keyIsConfirmed(group: id, epoch: step.epoch!)), "the code did not open the earlier key")
    case "replace_code":
      let next = try device(step.device).newRecoveryCode(recoveryCode: code)
      try check(next.count == 32 && next != code, "the new code is not a new code")
      _ = try device(step.device).replaceCode(recoveryCode: code, account: Data("the account's sealed copies".utf8), nowMs: now())
      code = next
    case "recover":
      let served = try hub.servedRoom(room, code: code)
      try check(!served.sessions.isEmpty, "the room is served without its sessions")
      let plan = try device(step.device).prepareRecovery(recoveryCode: code, served: served)
      // The chains of the devices to go, as the hub's chain route serves them: every envelope of theirs, in order.
      let gone = Set(plan.removals.flatMap { $0.devices })
      try check(!gone.isEmpty && plan.newCode.count == 32, "the recovery removes nobody")
      let chains = hub.log.filter { hub.envelopes.contains($0.change) && gone.contains(hub.posted[$0.change] ?? Data()) }
        .map { ServedEnvelope(bytes: $0.bytes, change: $0.change, voidCode: nil) }
        .reversed() as [ServedEnvelope]  // in any order: the device sorts them
      try check(!chains.isEmpty, "the devices to go wrote nothing")
      let built = try device(step.device).recover(
        recoveryCode: code, served: served, chains: chains, account: Data("the account's sealed copies".utf8), nowMs: now())
      try check(built.unverified.isEmpty && built.outbox.count >= 2, "the recovery was not built whole")
      code = plan.newCode
    case "early":
      // An item written in the room before anyone else is there.
      var item = draft(.boardItem)
      item.board = allDesks
      item.payload = Data(#"{"content_type":"erase","shape_ids":["\#(base64urlEncode(bytes: try device(step.device).id()))/9/0"]}"#.utf8)
      _ = try device(step.device).seal(draft: item, recipient: nil, fileIds: [], nowMs: now())
    case "learn":
      // A device that joined by link learns the past of its groups from their public history.
      for name in step.groups! {
        let id = try group(name)
        guard let founding = name == "room" ? hub.roomInfos.first : hub.sessions[id]?.founding else { throw Unexpected("no founding of \(name)") }
        // Before: its knowledge begins after the founding, and the past is not held; a group it is a leaf of says the same.
        guard let before = try device(step.device).groupPast(group: id), before.fromEpoch >= 1, !before.learned
        else { throw Unexpected("the past of \(name) is not shown as missing") }
        let learned = try device(step.device).learnHistory(group: id, founding: founding, commits: hub.served(id, founding: founding, current: founding).commits)
        try check(learned.epochs >= 1, "nothing of \(name) was learned")
        let after = try device(step.device).groupPast(group: id)
        try check(after?.learned == true && after?.fromEpoch == before.fromEpoch, "the past of \(name) is not shown as learned")
        if let summary = try device(step.device).groups().first(where: { $0.group == id }) {
          try check(summary.pastLearned && summary.ownFrom == before.fromEpoch, "the summary of \(name) does not show its past")
        }
      }
    case "read_back":
      // Every stored envelope once more, in the hub's order: what was written before the device came opens now.
      var read: [ReceivedEnvelope] = []
      for entry in hub.log where hub.envelopes.contains(entry.change) {
        var envelope = try device(step.device).receiveEnvelope(envelope: entry.bytes, change: entry.change, ordered: true, voidCode: nil, nowMs: now())
        // One the device's chain already holds is a replay in order; fetched as a page it is read back with its body.
        if envelope.code == .replay {
          envelope = try device(step.device).receiveEnvelope(envelope: entry.bytes, change: entry.change, ordered: false, voidCode: nil, nowMs: now())
        }
        read.append(envelope)
      }
      let opened = read.filter { $0.payload != nil && $0.outcome == .applied }
      if step.early == true {
        try check(opened.contains { String(decoding: $0.payload ?? Data(), as: UTF8.self).contains("/9/0") }, "the early item did not open")
      }
      if let text = step.text { try check(chat(in: opened, text) != nil, "the earlier Chat message did not open") }
      if step.register == true {
        try check(
          read.contains { $0.header.kind == .register && $0.register?.name.hasPrefix("board_snapshot/") == true && $0.register?.current == true },
          "the register was not shown on reading back")
      }
      if step.early != true && step.text == nil { try check(!opened.isEmpty, "nothing opened on reading back") }
    case "found_helper":
      // A helper session under a main session: the helper device follows the room and the main session first.
      let (opener, helper) = (try device(step.by), try device(step.helper))
      let parent = try group(step.parent)
      guard let main = hub.sessions[parent] else { throw Unexpected("the hub has no such session") }
      try helper.observeRoom(groupInfo: hub.roomInfos[hub.roomInfos.count - 1], expectedState: nil)
      try helper.observeSession(groupInfo: main.current)
      var keyPackages = try step.humans!.map { try device($0).keyPackage(nowMs: now()) }
      keyPackages.append(try helper.keyPackage(nowMs: now()))
      let session = try opener.foundHelper(parent: parent.subdata(in: parent.startIndex + 32..<parent.endIndex), keyPackages: keyPackages, nowMs: now())
      groups[step.name!] = try sessionGroupId(room: room, session: session)
      try hub.post(opener)
    case "take_over":
      // A session is handed to a new agent device by invite, and with it every helper session under it.
      let (human, agent) = (try device(step.by), try device(step.device))
      try invite(by: step.by!, device: step.device!, agent: true, session: step.session)
      try hub.post(human)
      var did: [String] = []
      for _ in 0..<16 {
        let steps = try human.inviteSteps()
        guard let next = steps.first(where: { $0.kind != .wait }) ?? steps.first else { break }
        switch next.kind {
        case .takeOver:
          // The main session's step carries the KeyPackage of the confirmed Request; a helper session's asks for a fresh one.
          did.append(next.keyPackage == nil ? "takeOverHelper" : "takeOver")
          let keyPackage = try next.keyPackage ?? agent.keyPackage(nowMs: now())
          _ = try human.cleanSession(group: next.group!, cuts: next.cuts, replacement: Replacement(device: next.device!, keyPackage: keyPackage), nowMs: now())
        case .handover:
          did.append("handover")
          _ = try human.inviteHandover(inviteId: next.inviteId)
        case .checkHelpers:
          did.append("checkHelpers")
          try human.inviteChecked(inviteId: next.inviteId, helpers: step.helpers!.map { try group($0) })
        case .commit:
          did.append("commit")
          _ = try human.inviteRecommit(inviteId: next.inviteId, nowMs: now())
        default:
          did.append("wait")
        }
        try hub.post(human)
      }
      try check(try human.inviteSteps().isEmpty, "the takeover did not finish: \(did)")
      for kind in ["takeOver", "takeOverHelper", "handover", "checkHelpers"] { try check(did.contains(kind), "the takeover had no step \(kind): \(did)") }
    case "holds_recovery_mac":
      try check(try device(step.device).holdsRecoveryMac(), "the device does not hold the key of the code in force")
    case "no_key":
      let epoch = try key(step.epoch_of!, step.group).epoch
      try check(!(try device(step.device).holdsKey(group: group(step.group), epoch: epoch)), "the removed device holds the key of the epoch after its removal")
    default:
      throw Unexpected("the scenario has a step this test does not know: \(step.do)")
    }
  }

  /// One invite from its opening to its Commit in the inviter's outbox. Both sides must show the same six emoji.
  func invite(by: String, device name: String, agent: Bool, session: String?) throws {
    let (inviter, newcomer) = (try device(by), try device(name))
    let role: InviteRole = agent ? .agent : .human
    let taken = try session.map { name -> Data in
      let id = try group(name)
      return id.subdata(in: id.startIndex + 32..<id.endIndex)
    }
    let openedAt = now()
    let opened = try inviter.inviteOpen(role: role, sessionId: taken, app: "https://app.example", hub: "https://hub.example", nowMs: openedAt)
    let parts = try inviteLinkParse(text: opened.link)
    try check(parts.inviteId == opened.inviteId && (try hubAddress(text: "https://hub.example")) == "https://hub.example", "the link names another invite")
    // The deadline is the link's fifth part: ten minutes for a human device, fifteen for an agent device.
    let life = inviteLifeMs(role: role)
    try check(
      life == (agent ? 15 : 10) * 60000 && parts.expiresAt == opened.expiresAt && opened.expiresAt == openedAt + life,
      "the invite does not live \(life) ms")
    let late = opened.expiresAt + inviteClockToleranceMs() + 1
    try check(
      try inviteLinkCheck(text: opened.link, nowMs: openedAt).inviteId == opened.inviteId
        && (try inviteLinkCheck(text: opened.link, nowMs: late - 1)).expiresAt == opened.expiresAt,
      "a live link is refused")
    try check(refusal { _ = try inviteLinkCheck(text: opened.link, nowMs: late) } == .inviteExpired, "an expired link is taken by the stateless check")
    let read = try newcomer.joinLink(link: opened.link, nowMs: openedAt)
    try check(read.inviteId == opened.inviteId && read.hub == "https://hub.example" && read.expiresAt == opened.expiresAt, "joinLink reads another link")
    try check(refusal { _ = try newcomer.joinLink(link: opened.link, nowMs: late) } == .inviteExpired, "joinLink takes an expired link")
    let offer = SignedOffer(offer: opened.offer, signature: opened.signature, mac: opened.mac)
    try check(opened.mac.count == 32, "the Offer comes without its MAC")
    // An expired link, an altered deadline, an Offer of another invite, a missing or wrong MAC: refused, nothing stored.
    try check(refusal { _ = try newcomer.joinRequest(link: opened.link, offer: offer, nowMs: late) } == .inviteExpired, "an expired link was answered")
    let cut = opened.link.lastIndex(of: ".")!
    let deadline = String(opened.link[opened.link.index(after: cut)...])
    var moved = try base64urlDecode(text: deadline).reduce(UInt64(0)) { $0 << 8 | UInt64($1) } + 60000
    let movedBytes = Data((0..<8).map { _ -> UInt8 in defer { moved >>= 8 }; return UInt8(moved & 0xff) }.reversed())
    let altered = String(opened.link[...cut]) + base64urlEncode(bytes: movedBytes)
    try check(try inviteLinkParse(text: altered).expiresAt == opened.expiresAt + 60000, "the deadline was not altered")
    try check(refusal { _ = try newcomer.joinRequest(link: altered, offer: offer, nowMs: openedAt) } == .badInvite, "a link with an altered deadline was answered")
    let other = try inviter.inviteOpen(role: role, sessionId: taken, app: "https://app.example", hub: "https://hub.example", nowMs: openedAt)
    try check(
      refusal { _ = try newcomer.joinRequest(link: opened.link, offer: SignedOffer(offer: other.offer, signature: other.signature, mac: other.mac), nowMs: openedAt) }
        == .badInvite, "an Offer of another invite was answered")
    try check(
      refusal { _ = try newcomer.joinRequest(link: opened.link, offer: SignedOffer(offer: opened.offer, signature: opened.signature, mac: Data()), nowMs: openedAt) }
        == .badInvite, "an Offer without its MAC was answered")
    var wrong = opened.mac
    wrong[wrong.startIndex] ^= 1
    try check(
      refusal { _ = try newcomer.joinRequest(link: opened.link, offer: SignedOffer(offer: opened.offer, signature: opened.signature, mac: wrong), nowMs: openedAt) }
        == .badInvite, "an Offer with a wrong MAC was answered")
    let asked = try newcomer.joinRequest(link: opened.link, offer: offer, nowMs: now())
    try check(asked.role == role && asked.inviter == (try inviter.id()), "the Request is for another invite")
    let accepted = try inviter.inviteAccept(
      inviteId: opened.inviteId, request: SignedRequest(request: asked.request, mac: asked.mac, signature: asked.signature), nowMs: now())
    let shown = try newcomer.joinReveal(reveal: SignedReveal(reveal: accepted.reveal, signature: accepted.signature))
    try check(shown == accepted.code && shown.emoji.count == 6, "the two sides show different codes")
    // The newcomer signs in at the invite's hub before it is let in: for the Welcome, or the GroupInfo, it must fetch.
    let signed = try newcomer.hubSignIn(hub: "https://hub.example", challenge: Data(repeating: 4, count: 32))
    try check(signed.signature.count == 64, "a joining device cannot sign in")
    try check(
      refusal { _ = try newcomer.hubSignIn(hub: "https://other.example", challenge: Data(repeating: 4, count: 32)) } == .badInvite,
      "a joining device signed in at another hub")
    // An agent device follows the room from the epoch its Offer names: the one before the Commit that enrols it.
    if agent { try newcomer.joinObserve(groupInfo: hub.roomInfos[Int(asked.roomEpoch)]) }
    let confirmed = try inviter.inviteConfirm(
      inviteId: opened.inviteId, code: accepted.code.numbers, requestHash: accepted.requestHash, matches: true, nowMs: now())
    try check(confirmed?.role == role && confirmed?.newDevice == (try newcomer.id()), "the confirmed invite was not committed")
  }

  /// A Chat message in a session, sealed into the outbox.
  func say(_ name: String, in groupName: String?, _ text: String) throws {
    let id = try group(groupName)
    var message = draft(.sessionChat)
    message.session = id.subdata(in: id.startIndex + 32..<id.endIndex)
    message.payload = try JSONSerialization.data(withJSONObject: ["content_type": "message", "text": text])
    let sealed = try device(name).seal(draft: message, recipient: nil, fileIds: [], nowMs: now())
    let entry = try device(name).outbox().first { $0.id == sealed.outboxId }
    try check(entry?.kind == .envelope && entry?.parts.count == 1 && sealed.seq >= 1 && sealed.group == id, "the sealed envelope is not in the outbox")
  }

  /// A board: an item, the writer's snapshot register, another item; the reader loads it and is told what is new.
  func board(writer: CoreDevice, reader: CoreDevice) throws {
    let roomGroup = try group("room")
    let writerId = try writer.id()
    let name = "board_snapshot/\(base64urlEncode(bytes: allDesks))"
    var item = draft(.boardItem)
    item.board = allDesks
    item.payload = Data(#"{"content_type":"erase","shape_ids":["\#(base64urlEncode(bytes: writerId))/1/0"]}"#.utf8)
    _ = try writer.seal(draft: item, recipient: nil, fileIds: [], nowMs: now())
    try hub.post(writer)
    // A device takes its own envelope into its chain when the hub hands it back, like anyone's.
    _ = try hub.sync(writer, room: room)
    let head = try writer.chainHead(group: roomGroup, sender: writerId)
    try check(head.seq >= 1, "the writer does not hold its own envelopes")
    let change = try writer.cursor()
    let snapshot: [String: Any] = [
      "attachment": ["file_id": "AAAAAAAAAAAAAAAAAAAAAA"],
      "frontier": [base64urlEncode(bytes: writerId): [head.seq, base64urlEncode(bytes: head.hash)] as [Any]],
      "change": change,
    ]
    var register = draft(.register)
    register.group = roomGroup
    register.name = name
    register.value = try JSONSerialization.data(withJSONObject: snapshot)
    _ = try writer.seal(draft: register, recipient: nil, fileIds: [], nowMs: now())
    try hub.post(writer)
    let second = try writer.seal(draft: item, recipient: nil, fileIds: [], nowMs: now())
    try hub.post(writer)
    // Before the reader read the register it has no snapshot; after, a hub that leaves the newer item out is found out.
    try check(refusal { _ = try reader.boardLoad(board: allDesks, served: []) } == .notFound, "a board loaded without its snapshot")
    let envelopes = try hub.sync(reader, room: room).envelopes
    try check(envelopes.count == 3 && envelopes.allSatisfy { $0.outcome == .applied }, "the board's envelopes were not applied")
    try check(envelopes[1].register?.current == true && envelopes[1].header.kind == .register, "the snapshot register was not taken")
    guard let value = try reader.register(group: roomGroup, name: name), let read = try JSONSerialization.jsonObject(with: value) as? [String: Any]
    else { throw Unexpected("the register has no value") }
    try check(
      (read["change"] as? NSNumber)?.uint64Value == change && (read["attachment"] as? [String: Any])?["file_id"] as? String == "AAAAAAAAAAAAAAAAAAAAAA",
      "the register reads another value")
    try check(refusal { _ = try reader.boardLoad(board: allDesks, served: []) } == .withheld, "a withheld item went unnoticed")
    let loaded = try reader.boardLoad(board: allDesks, served: [ServedItem(sender: writerId, seq: second.seq, hash: second.envelopeHash)])
    try check(loaded.fresh == [0] && loaded.covered.isEmpty && loaded.frontier.first?.seq == second.seq, "the board did not load as written")
    // The board itself: the items the reader opened, merged for the frontier it verified.
    let items = try [envelopes[0], envelopes[2]].map { envelope -> BoardItem in
      guard let payload = envelope.payload else { throw Unexpected("a board item did not open") }
      return BoardItem(sender: envelope.header.sender, seq: envelope.header.seq, payload: payload)
    }
    let merged = try boardReduce(snapshot: nil, snapshotFrontier: [], items: items, frontier: loaded.frontier)
    try check((try JSONSerialization.jsonObject(with: merged)) is [String: Any], "the board did not reduce to a snapshot file")
    let cut = try reader.cutOf(group: roomGroup, device: writerId)
    try check(cut.seq == second.seq && cut.hash == second.envelopeHash, "the Cut is not the last accepted envelope")
  }

  func file(bytes: Int, pieces: Int) throws {
    let plain = Data((0..<bytes).map { UInt8($0 % 251) })
    let encryptor = try FileEncryptor()
    var stored: [Data] = []
    for start in stride(from: 0, to: plain.count, by: pieces) {
      stored.append(try encryptor.update(plaintext: plain.subdata(in: start..<min(start + pieces, plain.count))))
    }
    let end = try encryptor.finish()
    stored.append(end.stored)
    try check(end.plainLen == UInt64(bytes) && (try fileLayout(storedLen: end.storedLen)).plainLen == UInt64(bytes), "the file has another length")
    let decryptor = try FileDecryptor(file: end.file)
    var opened = Data()
    for piece in stored { opened.append(try decryptor.update(stored: piece)) }
    opened.append(try decryptor.finish())
    try check(opened == plain, "the file came back changed")
    // One changed byte: the file is refused at the latest when it ends.
    stored[0][stored[0].startIndex + 30] ^= 1
    let tampered = try FileDecryptor(file: end.file)
    var refused: ErrorCode?
    do {
      for piece in stored { _ = try tampered.update(stored: piece) }
      _ = try tampered.finish()
    } catch let CoreError.Refused(code, _) {
      refused = code
    }
    try check(refused == .decryptFailed, "a changed file was not refused")
  }

  /// A process that dies runs no orderly close. Here the first device is left as it is, alive and unclosed, and
  /// only the operating system's part is played: its lock goes. The next device finds the request that was
  /// written and not sent, byte for byte; and a store object in use cannot be handed to a second device.
  func testADeviceThatDiedLeavesItsRequestToTheNext() throws {
    let (first, store) = try start("K", create: true)
    _ = try first.foundRoom(recoveryCode: generateRecoveryCode(), nowMs: now())
    let before = try first.outbox()
    XCTAssertEqual(before.count, 1)
    // The store object belongs to the first device: a second open with it fails and leaves the first its lock.
    XCTAssertThrowsError(try CoreDevice.open(store: store))
    XCTAssertThrowsError(try start("K", create: false)) { error in
      guard case let CoreError.Refused(code, _) = error else { return XCTFail("\(error)") }
      XCTAssertEqual(code, .storage)
    }
    store.close()
    let (next, _) = try start("K", create: false)
    XCTAssertEqual(try next.outbox(), before)
    XCTAssertEqual(try next.id(), try first.id())
    // The one that "died" wrote nothing more; if it did, it would find out that it is the owner no longer.
    _ = try next.keyPackage(nowMs: now())
    XCTAssertThrowsError(try first.keyPackage(nowMs: now()))
    next.close()
  }

  func testTheScenario() throws {
    let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../scenario.json")
    let scenario = try JSONDecoder().decode(Scenario.self, from: Data(contentsOf: file))
    var ran = 0
    for step in scenario.steps {
      var refused: String?
      do {
        try run(step)
      } catch let CoreError.Refused(code, message) {
        guard step.refused != nil else { return XCTFail("step \(ran + 1) (\(step.do)): \(message)") }
        refused = errorCodeText(code: code)
      }
      if let expected = step.refused {
        XCTAssertEqual(refused, expected, "step \(ran + 1) (\(step.do))")
        if refused != expected { return }
      }
      ran += 1
    }
    XCTAssertEqual(ran, scenario.steps.count)
    XCTAssertGreaterThan(ran, 108)
  }
}
