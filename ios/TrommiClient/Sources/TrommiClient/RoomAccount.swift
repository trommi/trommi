// RoomAccount.swift: how this device comes into a room: founding one, joining by link (the six emoji), or signing in
// with the recovery code (which the account keeps sealed under the password, the Emergency Kit words or a passkey:
// Account.swift). spec/v2.md 5.1.1, 12.1, 8.4 and 8.7.
import Foundation

extension Room {
  public enum JoinEvent { case requested, checkCode(String), joined }

  /** A new device over an empty folder of that room. A folder left by a join that never finished is cleared first. */
  private static func newDevice(base: URL, roomId: String?) throws -> (store: Store, state: DeviceStore, device: CoreDevice) {
    // Before the room is known (founding) the device lives under a name of its own and is moved once the room has one.
    let store = Store(base: base, roomId: roomId ?? "founding-\(hex(systemRandom(8)))")
    if FileManager.default.fileExists(atPath: store.dir.appendingPathComponent("room.json").path) { throw TrommiError("room-exists", "this device is already in that room") }
    store.wipe()
    let state = try store.openState()
    do { return (store, state, try Core.tools.createDevice(store: state)) }
    catch { state.close(); store.wipe(); throw error }
  }

  /**
   * Join with an invite link a signed-in device made (for a human device). `onEvent` gets the check code to show as
   * emoji; the human compares it with the other device and confirms there. Returns once the inviter added this
   * device and its Welcome checked: for this room, committed by the inviter of the Offer.
   */
  public static func join(link: String, base: URL = Store.defaultBase(), pollMs: UInt64 = 800, timeoutMs: UInt64 = 15 * 60_000, onEvent: (JoinEvent) -> Void) async throws -> Room {
    let tools = Core.tools
    let l = try tools.parseInviteLink(link)
    let roomId = hex(l.room)
    let made = try newDevice(base: base, roomId: roomId)
    do {
      let hub = try HubClient(hubURL: l.hub, room: l.room, signer: made.device)
      let inv = try await hub.getInvite(l.invite)
      guard let offer = (inv["offer"] as? String).flatMap({ try? unb64u($0) }), let sig = (inv["signature"] as? String).flatMap({ try? unb64u($0) }) else { throw TrommiError("bad-invite", "the hub gave no Offer") }
      let join = try tools.inviteRequest(link: link, offer: offer, offerSignature: sig, device: made.device, nowMs: nowMs())
      if join.role != ROLE.HUMAN { throw TrommiError("bad-invite", "this is an invite for an agent: make one for a device in the app") }
      try await hub.postInviteRequest(l.invite, request: join.request, mac: join.mac, signature: join.signature)
      onEvent(.requested)
      let until = nowMs() + timeoutMs
      var shown = false
      while nowMs() < until {
        if !shown {
          do {
            let r = try await hub.getInviteReveal(l.invite)
            if let reveal = (r["reveal"] as? String).flatMap({ try? unb64u($0) }), let rs = (r["signature"] as? String).flatMap({ try? unb64u($0) }) {
              // The Reveal is checked against invite, request and commitment before one emoji is shown.
              onEvent(.checkCode(checkCodeText(try tools.inviteReveal(joiner: join.joiner, reveal: reveal, signature: rs))))
              shown = true
            }
          }
          catch let e as HubError where e.code == "invite-burned" { throw TrommiError("code-mismatch", "the other device said the emoji do not match: nobody was added") }
          catch let e as HubError where e.code == "invite-used" { throw TrommiError("invite-used", "this invite was answered for another device") }
          catch let e as HubError where e.code == "not-found" || e.isOffline { _ = e }
        } else if let room = try await takeFirstWelcome(hub: hub, made: made, room: l.room, inviter: join.inviter, hubURL: l.hub) {
          onEvent(.joined)
          return room
        }
        try await Task.sleep(nanoseconds: pollMs * 1_000_000)
      }
      throw TrommiError("invite-expired", "the invite ran out before it was confirmed")
    } catch { made.state.close(); made.store.wipe(); throw error }
  }

  /** Once the inviter committed: the token (only a leaf gets one), the Welcome, the room record. nil: not yet. */
  private static func takeFirstWelcome(hub: HubClient, made: (store: Store, state: DeviceStore, device: CoreDevice), room: RoomId, inviter: DeviceId, hubURL: String) async throws -> Room? {
    do { _ = try await hub.signIn() }
    catch let e as HubError where e.code == "not-member" || e.code == "unauthorised" || e.isOffline { return nil }
    for w in try await hub.welcomes() {
      guard let bytes = (w["welcome"] as? String).flatMap({ try? unb64u($0) }) else { continue }
      // (a Welcome into a session group comes later, in the catch-up; the first to take is the room group's)
      guard let joined = try? made.device.joinWelcome(bytes, room: room, committer: inviter, nowMs: nowMs()), joined.group.count == 32 else { continue }
      let record = RoomRecord(hubURL: hubURL, roomId: hex(room), myDeviceId: hex(made.device.id), role: "human", deviceRegisterSent: false)
      try made.store.save(record)
      return try Room(store: made.store, record: record, deviceStore: made.state, device: made.device)
    }
    return nil
  }

  /**
   * Found a room on a hub: this device makes its key, a recovery code and the room group, and posts the founding.
   * `account`: given the room id and the code, the account to make in the same step (Account.swift), or nil. The
   * code is returned for the caller to seal and is never shown or stored by this function.
   */
  public static func foundRoom(hubURL: String, base: URL = Store.defaultBase(), foundToken: String? = nil, account: ((RoomId, Bytes) throws -> JSON)? = nil) async throws -> (room: Room, recoveryCode: Bytes) {
    let tools = Core.tools
    let hubURL = try tools.canonicalHub(hubURL)
    let made = try newDevice(base: base, roomId: nil)
    do {
      let code = try tools.generateRecoveryCode()
      let keys = try tools.recoveryPublicKeys(code: code)
      let room = try made.device.foundRoom(recoverySignatureKey: keys.signatureKey, recoveryHpkeKey: keys.hpkeKey, nowMs: nowMs())
      guard let entry = made.device.outbox().first(where: { $0.kind == .roomFounding }) else { throw TrommiError("internal", "the core made no founding") }
      let r = try await HubClient(hubURL: hubURL).post(entry, account: try account?(room, code), foundToken: foundToken)
      guard (r["room_id"] as? String).flatMap({ try? unb64u($0) }) == room else { throw TrommiError("wrong-room", "the hub named another room id") }
      try made.device.outboxAccepted(entry.id, change: nil)
      // The folder takes the room's name; the state's lock is given back for the move and taken again.
      made.state.close()
      let store = Store(base: base, roomId: hex(room))
      try? FileManager.default.removeItem(at: store.dir)
      try FileManager.default.moveItem(at: made.store.dir, to: store.dir)
      try LocalKey.move(from: made.store.dir, to: store.dir)
      let record = RoomRecord(hubURL: hubURL, roomId: hex(room), myDeviceId: hex(made.device.id), role: "human", deviceRegisterSent: false)
      try store.save(record)
      return (try Room.open(base: base, roomId: hex(room)), code)
    } catch { made.state.close(); made.store.wipe(); throw error }
  }

  /**
   * Sign in on this device with the recovery code (8.4, 8.7): the code's key signs in to the hub, this device joins
   * the room group and every live session group from outside, authorised by that key, and the hub publishes all of
   * it or nothing. Every other human device sees the new leaf. `challenge`: one a login answer carried.
   */
  public static func joinWithRecoveryCode(hubURL: String, roomId: String, code: Bytes, base: URL = Store.defaultBase(), challenge: Bytes? = nil) async throws -> Room {
    let tools = Core.tools
    let hubURL = try tools.canonicalHub(hubURL)
    let room = try unhex(roomId)
    let made = try newDevice(base: base, roomId: roomId)
    do {
      let hub = try HubClient(hubURL: hubURL, room: room, signer: try tools.recoverySigner(code: code))
      _ = try await hub.signIn(challenge: challenge)
      // What the recovery key may read: the groups, each one's GroupInfo, the sealed keys.
      var infos = [(group: GroupId, groupInfo: Bytes)]()
      for g in try await hub.groups() where g["live"] as? Bool != false {
        guard let id = (g["group_id"] as? String).flatMap({ try? unb64u($0) }) else { continue }
        let info = try await hub.groupInfo(id)
        guard let bytes = (info["group_info"] as? String).flatMap({ try? unb64u($0) }) else { throw TrommiError("incomplete", "the hub gave no GroupInfo for a group") }
        infos.append((id, bytes))
      }
      var sealed = [Bytes](), after: UInt64 = 0
      while true {
        let page = try await hub.request("GET", "/sealed-keys", query: ["after": String(after)])
        sealed += (page["rows"] as? [String] ?? []).compactMap { try? unb64u($0) }
        guard page["more"] as? Bool == true, let next = (page["change"] as? NSNumber)?.uint64Value, next > after else { break }
        after = next
      }
      let link = try tools.joinWithRecoveryCode(device: made.device, code: code, groupInfos: infos, sealedKeys: sealed, nowMs: nowMs())
      // One transaction at the hub: nothing is visible to others until `finish`.
      let opened = try await hub.request("POST", "/rooms/\(b64u(room))/recovery")
      guard let rid = opened["recovery_id"] as? String else { throw TrommiError("bad-format", "the hub opened no recovery") }
      do {
        for e in made.device.outbox() where e.kind == .externalCommit {
          guard e.parts.count >= 3, let group = e.group else { continue }
          var body: JSON = ["group_id": b64u(group), "epoch": e.epoch, "commit": b64u(e.parts[0]), "group_info": b64u(e.parts[1]), "sealed_key": b64u(e.parts[2])]
          if e.parts.count > 3, !e.parts[3].isEmpty { body["recovery_auth"] = b64u(e.parts[3]) }
          let r = try await hub.request("POST", "/rooms/\(b64u(room))/recovery/\(rid)/commits", body: body)
          try made.device.outboxAccepted(e.id, change: (r["change"] as? NSNumber)?.uint64Value)
        }
        try await hub.request("POST", "/rooms/\(b64u(room))/recovery/\(rid)/finish", body: ["recovery_link": b64u(link)])
      } catch {
        _ = try? await hub.request("DELETE", "/rooms/\(b64u(room))/recovery/\(rid)")
        throw error
      }
      let record = RoomRecord(hubURL: hubURL, roomId: roomId, myDeviceId: hex(made.device.id), role: "human", deviceRegisterSent: false)
      try made.store.save(record)
      return try Room(store: made.store, record: record, deviceStore: made.state, device: made.device)
    } catch { made.state.close(); made.store.wipe(); throw error }
  }
}
