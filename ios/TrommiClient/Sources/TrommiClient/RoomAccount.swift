// RoomAccount.swift: how this device comes into a room: founding one, joining by link (the six emoji), or signing in
// with the recovery code (which the account keeps sealed under the password, the Emergency Kit words or a passkey:
// Account.swift). spec/v2.md 5.1.1, 12.1, 8.4 and 8.7.
import Foundation

extension Room {
  public enum JoinEvent { case requested, checkCode(String), joined }

  /**
   * A new device in a new folder. Folders an earlier join or founding left without a room are cleared first (never
   * one whose state is open: the lock says so). Refused when this device is in that room already.
   */
  private static func newDevice(base: URL, roomId: String?) throws -> (store: Store, state: DeviceStore, device: CoreDevice) {
    Store.lifecycle.lock(); defer { Store.lifecycle.unlock() }
    if let id = roomId, Store(base: base, roomId: id) != nil { throw TrommiError("room-exists", "this device is already in that room") }
    Store.sweep(base: base)
    let store = try Store.new(base: base)
    let state = try store.openState(create: true)
    do { return (store, state, try Core.tools.createDevice(store: state)) }
    catch { state.close(); store.wipe(); throw error }
  }
  /** Gives up a device that never came into a room. */
  private static func abandon(_ made: (store: Store, state: DeviceStore, device: CoreDevice)) {
    Store.lifecycle.lock(); defer { Store.lifecycle.unlock() }
    made.state.close()
    made.store.wipe()
  }

  /**
   * Join with an invite link a signed-in device made (for a human device), spec/v2.md 12.1. The steps are the
   * core's: it checks the Offer and makes the Request (`joinRequest`), checks the Reveal (`joinReveal`: only then
   * is a code shown), and takes the one Welcome that answers its Request (`joinInvited`: the Offer's room,
   * committed by the inviter). `onEvent` gets the check code to show as emoji; the human compares it with the other
   * device and confirms there. Between the Reveal and the inviter's Commit the hub answers this device's sign-in
   * with `not-member`: asked again until the invite runs out.
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
      let join = try made.device.joinRequest(link: link, offer: SignedOffer(offer: offer, signature: sig), nowMs: nowMs())
      if join.role != .human { throw TrommiError("bad-invite", "this is an invite for an agent: make one for a device in the app") }
      try await hub.postInviteRequest(l.invite, request: join.request.request, mac: join.request.mac, signature: join.request.signature)
      onEvent(.requested)
      let until = nowMs() + timeoutMs
      var shown = false
      while nowMs() < until {
        if !shown {
          do {
            let r = try await hub.getInviteReveal(l.invite)
            if let reveal = (r["reveal"] as? String).flatMap({ try? unb64u($0) }), let rs = (r["signature"] as? String).flatMap({ try? unb64u($0) }) {
              // The core checks the Reveal against invite, Request and commitment before one emoji is shown.
              onEvent(.checkCode(checkCodeText(try made.device.joinReveal(SignedReveal(reveal: reveal, signature: rs)).numbers)))
              shown = true
            }
          }
          catch let e as HubError where e.code == "invite-burned" { throw TrommiError("code-mismatch", "the other device said the emoji do not match: nobody was added") }
          catch let e as HubError where e.code == "invite-used" { throw TrommiError("invite-used", "this invite was answered for another device") }
          catch let e as HubError where e.code == "not-found" || e.isOffline { _ = e }
        } else if let room = try await takeFirstWelcome(hub: hub, made: made, room: l.room, hubURL: l.hub) {
          onEvent(.joined)
          return room
        }
        try await Task.sleep(nanoseconds: pollMs * 1_000_000)
      }
      throw TrommiError("invite-expired", "the invite ran out before it was confirmed")
    } catch { abandon(made); throw error }
  }

  /**
   * Once the inviter committed: the token (only a leaf gets one: `not-member` until then), the Welcome, the room
   * record. nil: not yet. A refusal of the core to sign (a core that signs in only for a room it is already in:
   * `no-room`) is thrown, not waited out.
   */
  private static func takeFirstWelcome(hub: HubClient, made: (store: Store, state: DeviceStore, device: CoreDevice), room: RoomId, hubURL: String) async throws -> Room? {
    do { _ = try await hub.signIn() }
    catch let e as HubError where e.code == "not-member" || e.code == "unauthorised" || e.isOffline { return nil }
    for w in try await hub.welcomes() {
      guard let bytes = (w["welcome"] as? String).flatMap({ try? unb64u($0) }) else { continue }
      // (a Welcome into a session group comes later, in the catch-up; the one to take here is the room group's,
      // which the core knows by the invite it stored)
      guard let joined = try? made.device.joinInvited(bytes, nowMs: nowMs()), joined.group == room else { continue }
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
      let room = try made.device.foundRoom(recoveryCode: code, nowMs: nowMs())
      guard let entry = made.device.outbox().first(where: { $0.kind == .roomFounding }) else { throw TrommiError("internal", "the core made no founding") }
      // The same bytes again while no answer comes: the hub answers a repeated founding with its first answer. If
      // none comes at all, this device is given up; had the hub taken the founding after all, the account it made
      // signs in like on any new device.
      let hub = try HubClient(hubURL: hubURL), body = try account?(room, code)
      var r: JSON = [:]
      for attempt in 0..<3 {
        do { r = try await hub.post(entry, account: body, foundToken: foundToken); break }
        catch let e as HubError where e.isOffline && attempt < 2 { try await Task.sleep(nanoseconds: 1_500_000_000) }
      }
      guard (r["room_id"] as? String).flatMap({ try? unb64u($0) }) == room else { throw TrommiError("wrong-room", "the hub named another room id") }
      try made.device.outboxAccepted(entry.id, change: nil)
      let record = RoomRecord(hubURL: hubURL, roomId: hex(room), myDeviceId: hex(made.device.id), role: "human", deviceRegisterSent: false)
      try made.store.save(record)
      return (try Room(store: made.store, record: record, deviceStore: made.state, device: made.device), code)
    } catch { abandon(made); throw error }
  }

  /**
   * Sign in on this device with the recovery code (8.4): the code's key signs in to the hub, and this device joins
   * the room group and every live session group from outside, authorised by that key. Every other human device sees the new leaf. `challenge`: one a login answer carried.
   */
  public static func joinWithRecoveryCode(hubURL: String, roomId: String, code: Bytes, base: URL = Store.defaultBase(), challenge: Bytes? = nil) async throws -> Room {
    let tools = Core.tools
    let hubURL = try tools.canonicalHub(hubURL)
    let room = try unhex(roomId)
    let made = try newDevice(base: base, roomId: roomId)
    do {
      let hub = try HubClient(hubURL: hubURL, room: room, signer: try tools.recoverySigner(code: code))
      _ = try await hub.signIn(challenge: challenge)
      // The core reads the room from the hub under the recovery key's token, checks it, and posts the joins.
      _ = try await tools.joinWithRecoveryCode(device: made.device, code: code, hub: hub, nowMs: nowMs())
      let record = RoomRecord(hubURL: hubURL, roomId: roomId, myDeviceId: hex(made.device.id), role: "human", deviceRegisterSent: false)
      try made.store.save(record)
      return try Room(store: made.store, record: record, deviceStore: made.state, device: made.device)
    } catch { abandon(made); throw error }
  }
}
