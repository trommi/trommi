// LiveRecovery.swift: recovery and signing in on a new device (spec/v2.md section 8) on the Rust core, as the binding
// has it (core/swift/src/recovery.rs and the recovery calls of core/swift/src/device.rs), one call for one call.
//
// WHY THESE ARE NOT Core.swift's TWO AWAITED CALLS. Core.swift guessed `joinWithRecoveryCode(device:code:groupInfos:
// sealedKeys:nowMs:)` and `replaceRecoveryCode(nowMs:)` before the core had recovery. The core's real flow needs more:
//   - a join verifies the room from its founding: per group the GroupInfo of epoch 0, every Commit since, and the
//     current GroupInfo; for the room also the GroupInfo of the anchor's epoch, every SealedKey and RecoveryLink;
//   - the hub must have accepted the join of the room group before a session group can be joined;
//   - replacing the code needs the code in force and the account's new sealed copies.
// So the calls here take exactly what the core takes. Their parameters and results are plain tuples of bytes and
// numbers: when Core.swift declares the same calls with the same tuples, LiveCore and LiveDevice conform as they are.
//
// THE CODE (32 bytes) is held by the caller only while it founds, joins, recovers or replaces; nothing here keeps
// it, except `RecoverySigner`, which lives as long as the hub client that signs in with it.
//
import Foundation
import TrommiClient
import TrommiCoreRust

/// One group as the hub serves it to a device that verifies it from its founding: the GroupInfo of epoch 0, every
/// Commit since in the hub's order (each with its change number and, for a join from outside, its RecoveryAuth), and
/// the GroupInfo the hub offers as current. Nothing in it is trusted.
public typealias LiveServedGroup = (founding: Bytes, commits: [(change: UInt64, commit: Bytes, recoveryAuth: Bytes?)], current: Bytes)
/// A room as the hub serves it to a device that comes with the code: the room group, the GroupInfo of the anchor's
/// epoch (`LiveCore.recoveryAnchor` names the epoch), every SealedKey and RecoveryLink of the room, and every live
/// session group, main sessions before helper sessions. Nothing in it is trusted.
public typealias LiveServedRoom = (room: RoomId, group: LiveServedGroup, anchor: Bytes, sealedKeys: [Bytes], links: [Bytes], sessions: [LiveServedGroup])
/// What a join with the code, or a whole recovery, leaves behind. `outbox`: the entries to post, in order; the
/// device's state changes only when the hub accepted the last. `missingLink`: a recovery key whose link to the code
/// it replaced the hub did not serve (the content of the older codes' time stays closed; the finding is `withheld`).
/// `unverified`: the served session groups that did not verify and are not joined, by their place in `sessions`.
public typealias LiveCodeJoin = (outbox: [UInt64], missingLink: Bytes?, unverified: [(index: Int, code: String)])

/// Signs the hub's challenge under the recovery code (12.3, 8.4), for a device that is not yet a member: the token it
/// gets may read what a join with the code needs and post that join.
final class RecoverySigner: CoreSigner {
  private let code: Data
  /// The recovery signature key's public half, which the hub knows this signer by.
  let id: DeviceId

  /// `bad-format` unless the code is 32 bytes.
  init(code: Bytes) throws {
    self.code = code.data
    // The binding hands out no public key of a code. A signed `HubAuth` ends with the signer's key (32 bytes) and
    // the challenge (32 bytes): the key is read from one made for nobody.
    let probe = try core { try recoverySignIn(recoveryCode: code.data, room: ZERO32.data, hub: "http://localhost", challenge: ZERO32.data) }.auth.bytes
    guard probe.count >= 64 else { throw TrommiError("internal", "a signed HubAuth is shorter than its two last fields") }
    id = Bytes(probe[(probe.count - 64)..<(probe.count - 32)])
  }

  func signHubAuth(room: RoomId, hub: String, challenge: Bytes) throws -> (auth: Bytes, signature: Bytes) {
    let signed = try core { try recoverySignIn(recoveryCode: code, room: room.data, hub: hub, challenge: challenge.data) }
    return (signed.auth.bytes, signed.signature.bytes)
  }
}

private func served(_ group: LiveServedGroup) -> TrommiCoreRust.ServedGroup {
  ServedGroup(founding: group.founding.data, commits: group.commits.map { ServedCommit(change: $0.change, commit: $0.commit.data, recoveryAuth: $0.recoveryAuth?.data) },
              current: group.current.data)
}
private func served(_ room: LiveServedRoom) -> TrommiCoreRust.ServedRoom {
  ServedRoom(room: room.room.data, group: served(room.group), anchor: room.anchor.data, rows: room.sealedKeys.map(\.data), links: room.links.map(\.data),
             sessions: room.sessions.map(served))
}
private func codeJoin(_ join: TrommiCoreRust.CodeJoin) -> LiveCodeJoin {
  (join.outbox, join.missingLink?.bytes, join.unverified.map { (Int($0.index), errorCodeText(code: $0.code)) })
}

// ---- without a device -------------------------------------------------------------------------------------

extension LiveCore {
  /// Who signs in to the hub while a device joins with the code (8.4).
  public func recoverySigner(code: Bytes) throws -> CoreSigner { try RecoverySigner(code: code) }

  /// The anchor of a join with the code (8.5), from the room's SealedKeys as the hub lists them: the newest epoch of
  /// the room group that a human device vouched for under this code. The caller asks the hub for the GroupInfo of
  /// that epoch. `wrong-recovery`: none is vouched for under this code; `equivocation`: two name different
  /// GroupInfos for the newest epoch. `groupInfo` is the hash that names the GroupInfo, which the core checks itself.
  public func recoveryAnchor(code: Bytes, room: RoomId, sealedKeys: [Bytes]) throws -> (group: GroupId, epoch: UInt64, groupInfo: Hash32) {
    let anchor = try core { try TrommiCoreRust.recoveryAnchor(recoveryCode: code.data, room: room.data, rows: sealedKeys.map(\.data)) }
    return (anchor.group.bytes, anchor.epoch, anchor.groupInfo.bytes)
  }
}

// ---- on the device ----------------------------------------------------------------------------------------

extension LiveDevice {
  /// Signs in on a new device with the code (8.4, 8.5): checks the room the hub served and builds the join of the
  /// room group from outside (one `externalCommit` in the outbox). Nothing of the device changes until the hub
  /// accepted that entry (`outboxAccepted`); then it is a human device, holds every content key the code opened,
  /// and joins each live session group with `joinSessionWithCode`.
  public func joinRoomWithCode(_ code: Bytes, served room: LiveServedRoom, nowMs: UInt64) throws -> LiveCodeJoin {
    codeJoin(try core { try device.joinRoomWithCode(recoveryCode: code.data, served: served(room), nowMs: nowMs) })
  }

  /// Joins one live session group with the code, as a human device that joined the room group with it. Main sessions
  /// before their helper sessions. The outbox entry's id (an `externalCommit`).
  public func joinSessionWithCode(_ code: Bytes, served group: LiveServedGroup, nowMs: UInt64) throws -> UInt64 {
    try core { try device.joinSessionWithCode(recoveryCode: code.data, served: served(group), nowMs: nowMs) }
  }

  /// Makes a new recovery code to replace the one in force (8.6) and returns it: for the account's new sealed copies,
  /// and shown to the person. Nothing is stored or sent yet; the device keeps its part in memory until `replaceCode`,
  /// and a second call makes another code. `wrong-recovery` unless `current` is the code in force.
  public func newRecoveryCode(current: Bytes) throws -> Bytes {
    try core { try device.newRecoveryCode(recoveryCode: current.data) }.bytes
  }

  /// Replaces the code with the one `newRecoveryCode` made (`incomplete` when none was made), as a human device:
  /// one outbox entry of kind `recoveryCode` with the room Commit, its GroupInfo and SealedKey, the RecoveryLink, and
  /// `account` as its fifth part, exactly as given. `account` is whatever the hub's route takes as the account's new
  /// sealed copies (for POST /v2/rooms/{room}/recovery-code: the JSON of its `account` object; empty for a room
  /// without an account). Once the hub accepted the entry the device sends the new key for the sealed keys to every
  /// human device by itself. The outbox entry's id.
  public func replaceCode(current: Bytes, account: Bytes, nowMs: UInt64) throws -> UInt64 {
    try core { try device.replaceCode(recoveryCode: current.data, account: account.data, nowMs: nowMs) }
  }

  /// Prepares the whole recovery when every device is lost (8.7), on a new device with the code: checks the room the
  /// hub serves after the recovery was opened there, makes the new code, and names the leaves the recovery removes,
  /// per group, main sessions before helper sessions. The caller names each one's Cut, seals the new code for the
  /// account, and calls `recover`.
  public func prepareRecovery(_ code: Bytes, served room: LiveServedRoom) throws -> (newCode: Bytes, removals: [(group: GroupId, devices: [DeviceId])]) {
    let plan = try core { try device.prepareRecovery(recoveryCode: code.data, served: served(room)) }
    return (plan.newCode.bytes, plan.removals.map { ($0.group.bytes, $0.devices.map(\.bytes)) })
  }

  /// The whole recovery, as `prepareRecovery` prepared it: joins the room group and every session group from outside,
  /// removes every other human device together with the replacement of the code, then every leaf the new room state
  /// does not allow. `chains`: the envelopes of the devices to go, as the hub's chain route serves them
  /// (GET /v2/groups/{group}/chains/{sender}), in the hub's order; the core verifies each chain from number 1 and
  /// takes the Cut from the head it verified (`gap`, `chain-break`, `equivocation` fail the recovery). A device of
  /// which nothing is handed in is cut at nothing. `account`: as for `replaceCode`. The entries (kinds 11
  /// `recoveryCommit` and, last, 12 `recoveryFinish`) are posted in order; the device's state changes only when
  /// the hub accepted the last.
  public func recover(_ code: Bytes, served room: LiveServedRoom, chains: [(bytes: Bytes, change: UInt64, voidCode: String?)], account: Bytes, nowMs: UInt64) throws -> LiveCodeJoin {
    let theirs = try chains.map { e -> ServedEnvelope in
      let void = try e.voidCode.map { text -> ErrorCode in
        guard let code = errorCodeFromText(text: text) else { throw TrommiError("bad-format", "a void code this core does not know") }
        return code
      }
      return ServedEnvelope(bytes: e.bytes.data, change: e.change, voidCode: void)
    }
    return codeJoin(try core { try device.recover(recoveryCode: code.data, served: served(room), chains: theirs, account: account.data, nowMs: nowMs) })
  }

  /// Learns the past of a group this device joined by link, from its public history: the founding GroupInfo and
  /// every Commit from the first on, in order. The room group first, then main sessions, then helper sessions
  /// (`room-behind`, `group-behind` otherwise); taken only if it arrives at this device's own state (`bad-group`).
  /// Returns how many epochs were recorded. Envelopes of those epochs, refused with `group-behind` until then, are
  /// handed to `receiveEnvelope` again afterwards.
  public func learnHistory(group: GroupId, founding: Bytes, commits: [(change: UInt64, commit: Bytes, recoveryAuth: Bytes?)]) throws -> UInt64 {
    try core {
      try device.learnHistory(group: group.data, founding: founding.data,
                              commits: commits.map { ServedCommit(change: $0.change, commit: $0.commit.data, recoveryAuth: $0.recoveryAuth?.data) })
    }.epochs
  }

  /// Whether this device holds the key that authenticates the room's sealed keys under the code in force (8.3). A
  /// human device that does not founds nothing and commits nothing: it asks another human device, which answers
  /// with `sendRecoveryAuth`.
  public func holdsRecoveryMac() throws -> Bool { try core { try device.holdsRecoveryMac() } }

  /// Whether the content key of `group` at `epoch` is vouched for: the device derived it itself, or a human device's
  /// sealed key names it. Content of an epoch whose key is not confirmed is shown as unconfirmed (8.5).
  public func keyIsConfirmed(group: GroupId, epoch: UInt64) throws -> Bool { try core { try device.keyIsConfirmed(group: group.data, epoch: epoch) } }

  /// Sends the key that authenticates the room's sealed keys to `recipient`, or to every human device with nil
  /// (7.4): room group, from a human device that holds it (`no-key` otherwise). The outbox entry's id, or nil while
  /// a Commit of this device is pending in the room group: it is then sent when that is decided.
  public func sendRecoveryAuth(recipient: DeviceId?) throws -> UInt64? {
    try core { try device.sendRecoveryAuth(recipient: (recipient ?? ZERO32).data) }
  }

  /// Posts the sealed key of the epoch `group` stands in, vouched for by this device, when the hub lists none this
  /// device can verify (8.3). `listed`: the sealed keys the hub lists for it; `groupInfo`: the GroupInfo the hub
  /// holds for that epoch. The outbox entry's id (a `sealedKey`), or nil when one is listed.
  public func postSealedKey(group: GroupId, groupInfo: Bytes, listed: [Bytes]) throws -> UInt64? {
    try core { try device.postSealedKey(group: group.data, groupInfo: groupInfo.data, listed: listed.map(\.data)) }
  }

  /// First contact with a session group this device joined by Welcome: verifies the group from its founding through
  /// its Commits against the room states this device holds. `bad-group` is the finding: the device then opens none
  /// of the session's content. `room-behind` and `group-behind` are no findings: process further and ask again.
  public func verifyFounding(group: GroupId, served: LiveServedGroup) throws {
    try core { try device.verifyFounding(group: group.data, served: TrommiCoreLive.served(served)) }
  }
}

// ---- signing in on a new device, against a hub (8.4) -------------------------------------------------------

/// Reads from a hub what a device that comes with the code needs, under the recovery key's token.
struct ServedByHub {
  let hub: HubClient

  private func bytes(_ json: JSON, _ field: String) throws -> Bytes {
    guard let text = json[field] as? String, let bytes = try? unb64u(text), !bytes.isEmpty else { throw TrommiError("bad-format", "the hub's answer has no \(field)") }
    return bytes
  }

  /// Every SealedKey and RecoveryLink of the room: GET /v2/sealed-keys?after=, page by page.
  func sealedKeys() async throws -> (sealedKeys: [Bytes], links: [Bytes]) {
    var rows = [Bytes](), links = [Bytes](), after: UInt64 = 0
    while true {
      let page = try await hub.request("GET", "/sealed-keys", query: ["after": String(after)])
      rows += try (page["rows"] as? [JSON] ?? []).map { try bytes($0, "sealed_key") }
      links += try (page["links"] as? [JSON] ?? []).map { try bytes($0, "recovery_link") }
      guard page["more"] as? Bool == true else { return (rows, links) }
      guard let next = Wire.uint(page["change"]), next > after else { throw TrommiError("bad-format", "the hub's list of sealed keys does not move on") }
      after = next
    }
  }

  /// One group from its founding: GET /v2/groups/{group}/info?epoch=0, the Commits of GET /v2/groups/{group}/log, and
  /// GET /v2/groups/{group}/info. A Commit that the hub took between the last two would make the current GroupInfo
  /// one epoch ahead of the Commits read, so the three are read again until they fit.
  func group(_ id: GroupId) async throws -> LiveServedGroup {
    for _ in 0..<3 {
      let founding = try bytes(try await hub.groupInfo(id, epoch: 0), "group_info")
      var commits = [(change: UInt64, commit: Bytes, recoveryAuth: Bytes?)](), after: UInt64 = 0, reached: UInt64 = 0
      while true {
        let page = try await hub.groupLog(id, after: after)
        let items = page["items"] as? [JSON] ?? []
        for item in items {
          guard let n = Wire.uint(item["n"]), n > after else { throw TrommiError("bad-format", "the hub's log of a group is not in order") }
          after = n
          guard item["kind"] as? String == "commit" else { continue }
          guard let change = Wire.uint(item["change"]), let epoch = Wire.uint(item["epoch"]) else { throw TrommiError("bad-format", "a Commit of the hub's log has no change number or epoch") }
          commits.append((change, try bytes(item, "bytes"), (item["recovery_auth"] as? String).flatMap { try? unb64u($0) }))
          reached = epoch + 1
        }
        guard page["more"] as? Bool == true, !items.isEmpty else { break }
      }
      let current = try await hub.groupInfo(id)
      if Wire.uint(current["epoch"]) == reached { return (founding, commits, try bytes(current, "group_info")) }
    }
    throw TrommiError("busy", "a group kept changing while it was read from the hub")
  }

  /// The live session groups, main sessions before helper sessions: GET /v2/rooms/{room}/groups.
  func liveSessions() async throws -> [GroupId] {
    var main = [GroupId](), helper = [GroupId]()
    for group in try await hub.groups() where group["live"] as? Bool == true {
      guard let id = (group["group_id"] as? String).flatMap({ try? unb64u($0) }) else { throw TrommiError("bad-format", "a group of the hub's list has no id") }
      switch group["kind"] as? String {
      case "main": main.append(id)
      case "helper": helper.append(id)
      default: break   // the room group
      }
    }
    return main + helper
  }

  /// The whole room. `anchorEpoch` is asked of the caller once the SealedKeys are read (`LiveCore.recoveryAnchor`).
  func room(anchorEpoch: ([Bytes]) throws -> UInt64) async throws -> (served: LiveServedRoom, sessions: [GroupId]) {
    let sealed = try await sealedKeys()
    let anchor = try bytes(try await hub.groupInfo(hub.room, epoch: try anchorEpoch(sealed.sealedKeys)), "group_info")
    let roomGroup = try await group(hub.room)
    let ids = try await liveSessions()
    var sessions = [LiveServedGroup]()
    for id in ids { sessions.append(try await group(id)) }
    return ((hub.room, roomGroup, anchor, sealed.sealedKeys, sealed.links, sessions), ids)
  }
}

extension LiveCore {
  /// Signs a new device in with the recovery code against a hub (8.4, 8.5), start to end. `hub` is signed in as the
  /// recovery key (`recoverySigner(code:)`, `HubClient.signIn`) and names the room; `device` is new and in no room.
  ///
  ///   1. reads every SealedKey and RecoveryLink, and lets the core pick the anchor among them (`wrong-recovery` when
  ///      the code is not this room's);
  ///   2. reads the anchor's GroupInfo, the room group from its founding, and every live session group from its
  ///      founding (main sessions first);
  ///   3. the core checks all of it and builds the join of the room group; it is posted to the group's Commit route
  ///      with its RecoveryAuth, and the hub's change number reported to the device. Until here a failure throws
  ///      and leaves the device as it was: in no room.
  ///   4. each session group that verified is joined the same way. A failure here is not thrown: the device is in
  ///      the room, and gives up nothing by a session it is not in yet. It is returned in `notJoined` with its
  ///      code; a join the hub did not answer stays in the outbox and goes out with the device's own token later.
  ///
  /// Returns what the person should know: `missingLink` (see `LiveCodeJoin`) and the sessions not joined.
  public func joinWithRecoveryCode(device: TrommiClient.CoreDevice, code: Bytes, hub: HubClient, nowMs now: UInt64) async throws -> (missingLink: Bytes?, notJoined: [(group: GroupId, code: String)]) {
    guard let device = device as? LiveDevice else { throw TrommiError("bad-argument", "joinWithRecoveryCode: the device is not this core's") }
    let (served, sessions) = try await ServedByHub(hub: hub).room { try self.recoveryAnchor(code: code, room: hub.room, sealedKeys: $0).epoch }
    let joined = try device.joinRoomWithCode(code, served: served, nowMs: now)
    for id in joined.outbox { try await post(id, of: device, to: hub) }

    var notJoined = joined.unverified.compactMap { finding in sessions.indices.contains(finding.index) ? (group: sessions[finding.index], code: finding.code) : nil }
    for (index, group) in sessions.enumerated() where !joined.unverified.contains(where: { $0.index == index }) {
      do { try await post(try device.joinSessionWithCode(code, served: served.sessions[index], nowMs: now), of: device, to: hub) }
      catch let refused as TrommiError { notJoined.append((group, refused.code)) }
      catch let refused as HubError { notJoined.append((group, refused.code)) }
    }
    return (joined.missingLink, notJoined)
  }

  /// Posts one outbox entry of a join and reports the hub's answer to the device. The hub's last word against it
  /// (`isFinalRefusal`) is reported too, so the device drops what it had built, and thrown; so is anything else,
  /// with the entry left in the outbox.
  ///
  /// A join from outside is not a member's Commit: it was built on a copy of the state, and reporting the answer
  /// puts that copy in force (the device is in the group at once, its cursor untouched). So nothing is handed back
  /// here. The room's first catch-up reads the log from the start, in the hub's order; there the join's own Commit
  /// is passed over and gives the join its place (RecoveryTests.testANewDeviceJoinsWithTheCode holds this down).
  private func post(_ id: UInt64, of device: LiveDevice, to hub: HubClient) async throws {
    guard let entry = device.outbox().first(where: { $0.id == id }) else { throw TrommiError("internal", "an entry the core named is not in the outbox") }
    do {
      let answer = try await hub.post(entry)
      guard let change = Wire.uint(answer["change"]) else { throw TrommiError("bad-format", "the hub's answer to a join names no change number") }
      try device.outboxAccepted(id, change: change)
    } catch let refused as HubError where !refused.isOffline && isFinalRefusal(refused.code) {
      try? device.outboxRefused(id, code: refused.code)
      throw refused
    }
  }
}
