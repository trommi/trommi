// RoomAccount.swift: how this device comes into a room: founding one, joining by link (the six emoji), or signing in
// with the recovery code (which the account keeps sealed under the password, the Emergency Kit words or a passkey:
// Account.swift), or, when every device is lost, the whole recovery with it. spec/v2.md 5.1.1, 12.1, 8.4 and 8.7.
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
   * with `not-member`: asked again after 1 s, 2 s, 4 s, then every 5 s, for five minutes in all (spec/hub-api.md
   * "A device that was just invited"); after that the invitation was not completed.
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
      var shown = false, shownAt: UInt64 = 0, asked = 0
      while nowMs() < until {
        if !shown {
          do {
            let r = try await hub.getInviteReveal(l.invite)
            if let reveal = (r["reveal"] as? String).flatMap({ try? unb64u($0) }), let rs = (r["signature"] as? String).flatMap({ try? unb64u($0) }) {
              // The core checks the Reveal against invite, Request and commitment before one emoji is shown.
              onEvent(.checkCode(checkCodeText(try made.device.joinReveal(SignedReveal(reveal: reveal, signature: rs)).numbers)))
              shown = true; shownAt = nowMs()
            }
          }
          catch let e as HubError where e.code == "invite-burned" { throw TrommiError("code-mismatch", "the other device said the emoji do not match: nobody was added") }
          catch let e as HubError where e.code == "invite-used" { throw TrommiError("invite-used", "this invite was answered for another device") }
          catch let e as HubError where e.code == "not-found" || e.isOffline { _ = e }
        } else {
          if let room = try await takeFirstWelcome(hub: hub, made: made, room: l.room, hubURL: l.hub) {
            onEvent(.joined)
            return room
          }
          if nowMs() - shownAt >= 5 * 60_000 { throw TrommiError("invite-not-completed", "the invitation was not completed") }
          try await Task.sleep(nanoseconds: UInt64(asked < 3 ? 1 << asked : 5) * 1_000_000_000)
          asked += 1
          continue
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
      // (the room group's past is to be learned: this device holds it from the epoch of its Welcome on)
      let record = RoomRecord(hubURL: hubURL, roomId: hex(room), myDeviceId: hex(made.device.id), role: "human", deviceRegisterSent: false, past: PastWork(toLearn: [hex(room)]))
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

  /** The Keychain item that holds the recovery code while a sign-in with it is not finished. */
  static func joinCodeItem(_ dir: URL) -> String { "join-\(dir.lastPathComponent)" }

  /**
   * Sign in on this device with the recovery code (8.4): the code's key signs in to the hub, and this device joins
   * the room group and every live session group from outside, authorised by that key. Every other human device sees
   * the new leaf. `challenge`: one a login answer carried.
   *
   * Until the hub accepted the join of the room group, a failure throws and nothing is left of the device. From
   * then on the device is a leaf of the room and is kept whatever happens: the room record is written at once, and
   * the session groups are joined after it. What is left of them when this returns (the hub did not answer, the app
   * was ended) is finished by the next sync (`finishCodeJoin`). The code is kept in the Keychain for exactly that
   * long (8.5: forgotten once the join has finished).
   */
  public static func joinWithRecoveryCode(hubURL: String, roomId: String, code: Bytes, base: URL = Store.defaultBase(), challenge: Bytes? = nil) async throws -> Room {
    let tools = Core.tools
    let hubURL = try tools.canonicalHub(hubURL)
    let room = try unhex(roomId)
    // A device an earlier sign-in left unsure is settled first: resumed when the hub took its join, never made twice.
    if let resumed = try await resumeUnsureJoin(base: base, hubURL: hubURL, roomId: roomId, code: code) { return resumed }
    let made = try newDevice(base: base, roomId: roomId)
    let hub: HubClient
    do { hub = try HubClient(hubURL: hubURL, room: room, signer: try tools.recoverySigner(code: code)) } catch { abandon(made); throw error }
    do {
      _ = try await hub.signIn(challenge: challenge)
      // The core reads the room from the hub under the recovery key's token, checks it, and posts the join.
      _ = try await tools.joinRoomWithRecoveryCode(device: made.device, code: code, hub: hub, nowMs: nowMs())
    } catch {
      // No answer to a join that was posted: the hub may have taken it. The room group's log, read under the
      // recovery key, is handed to the core, which says whether its own join is in it; what cannot be told yet is
      // kept and settled by the next sign-in (`resumeUnsureJoin`).
      let posted = made.device.outbox().contains { $0.kind == .externalCommit && $0.group == room }
      guard posted, Self.unsure(error) else { abandon(made); throw error }
      switch await Self.stagedJoinTaken(made.device, recoveryHub: hub, room: room) {
      case true?: break
      case false?: abandon(made); throw error
      case nil:
        do { try LocalKey.write(joinCodeItem(made.store.dir), code, dir: made.store.dir) } catch { abandon(made); throw error }
        made.store.markUnsureJoin(roomId)
        Store.lifecycle.withLock { made.state.close() }
        throw TrommiError("pending", "the hub did not answer the sign-in: signing in again finishes it")
      }
    }
    return try await settleCodeJoin(made, hubURL: hubURL, roomId: roomId, code: code, recoveryHub: hub)
  }

  /** The device is in the room: the record at once, then the session groups (`finishCodeJoin`). */
  private static func settleCodeJoin(_ made: (store: Store, state: DeviceStore, device: CoreDevice), hubURL: String, roomId: String, code: Bytes, recoveryHub: HubClient) async throws -> Room {
    let joined: Room
    do {
      try? LocalKey.write(joinCodeItem(made.store.dir), code, dir: made.store.dir)
      let record = RoomRecord(hubURL: hubURL, roomId: roomId, myDeviceId: hex(made.device.id), role: "human", deviceRegisterSent: false, codeJoin: true)
      try made.store.save(record)
      made.store.markUnsureJoin(nil)
      joined = try Room(store: made.store, record: record, deviceStore: made.state, device: made.device)
    } catch { abandon(made); throw error }
    await joined.finishCodeJoin(as: recoveryHub, code: code)
    return joined
  }

  /** An error after which nothing is known of what the hub did: no answer, or one it could not give. */
  static func unsure(_ error: Error) -> Bool {
    guard let h = error as? HubError else { return error is CancellationError }
    return h.isOffline || h.status >= 500
  }

  /**
   * Whether the hub took this device's join of the room group, by the core's word: the group's Commits, read under
   * the recovery key, are handed to the core from its place on. true: its own Commit is among them (the core took
   * the room); false: another Commit took that epoch and the join is dropped; nil: nothing could be read, or the
   * log does not say yet. A refusal of the hub is no "not taken": only the log decides.
   */
  static func stagedJoinTaken(_ device: CoreDevice, recoveryHub: HubClient, room: RoomId) async -> Bool? {
    guard let past = try? await recoveryHub.history(of: room) else { return nil }
    for commit in past.commits where commit.change > device.cursor {
      let entry = LogEntry(change: commit.change, group: room, kind: .commit(bytes: commit.commit, recoveryAuth: commit.recoveryAuth))
      guard let done = try? device.processLogEntry(entry) else { continue }
      switch done {
      case .ownCommit: return true
      case .joinSuperseded: return false
      default: continue
      }
    }
    if device.room != nil { return true }
    return device.outbox().contains { $0.kind == .externalCommit && $0.group == room } ? nil : false
  }

  /**
   * A folder an earlier sign-in to this room left unsure (`joinWithRecoveryCode`): the room group's log decides
   * (`stagedJoinTaken`). Taken: it is resumed as the room's device. Not taken: the folder goes and a new device
   * signs in. Not known: `pending` again, and the folder stays.
   */
  private static func resumeUnsureJoin(base: URL, hubURL: String, roomId: String, code: Bytes) async throws -> Room? {
    let room = try unhex(roomId)
    let left: Store? = Store.lifecycle.withLock { Store.folders(base).map { Store(dir: $0) }.first { !$0.hasRecord && $0.unsureJoin == roomId } }
    guard let store = left else { return nil }
    let state: DeviceStore, device: CoreDevice
    do {
      state = try Store.lifecycle.withLock { try store.openState() }
      do { device = try Core.tools.openDevice(store: state) } catch { state.close(); throw error }
    } catch { Store.lifecycle.withLock { store.wipe() }; return nil }
    let made = (store: store, state: state, device: device)
    let recoveryHub: HubClient
    do {
      recoveryHub = try HubClient(hubURL: hubURL, room: room, signer: try Core.tools.recoverySigner(code: code))
      _ = try await recoveryHub.signIn()
    } catch {
      Store.lifecycle.withLock { state.close() }
      throw Self.unsure(error) ? TrommiError("pending", "the hub did not answer the sign-in: signing in again finishes it") : error
    }
    var taken = await stagedJoinTaken(device, recoveryHub: recoveryHub, room: room)
    // Not in the log, and no other Commit took its epoch: the same join goes out once more, and the log decides again.
    if taken == nil, let staged = device.outbox().first(where: { $0.kind == .externalCommit && $0.group == room }) {
      do {
        let answer = try await recoveryHub.post(staged)
        if let change = Wire.uint(answer["change"]) { try? device.outboxAccepted(staged.id, change: change) }
      } catch let e as HubError where !unsure(e) && Core.tools.isFinalRefusal(e.code) && e.code != "epoch-taken" {
        try? device.outboxRefused(staged.id, code: e.code)
      } catch {}
      taken = await stagedJoinTaken(device, recoveryHub: recoveryHub, room: room)
    }
    switch taken {
    case true?:
      return try await settleCodeJoin(made, hubURL: hubURL, roomId: roomId, code: code, recoveryHub: recoveryHub)
    case false?:
      abandon(made); return nil
    case nil:
      Store.lifecycle.withLock { state.close() }
      throw TrommiError("pending", "the hub did not answer the sign-in: signing in again finishes it")
    }
  }

  /**
   * Joins the session groups a sign-in with the recovery code has left (see `joinWithRecoveryCode`), and forgets the
   * code once nothing is left that another try could mend. `recoveryHub`: the hub client of the sign-in itself,
   * signed in as the recovery key; later this device's own. A session the core or the hub refused for good is said
   * as an alert: another device of the person can add this one to it. (The core is called from here directly: the
   * binding lets one caller in at a time, and this runs before the first catch-up or inside it.)
   */
  func finishCodeJoin(as recoveryHub: HubClient? = nil, code given: Bytes? = nil) async {
    guard record.codeJoin == true else { return }
    let item = Room.joinCodeItem(store.dir)
    // (a Keychain that does not answer now is not a code that is gone: the work waits for the next sync)
    let stored: Bytes?
    do { stored = try LocalKey.read(item, dir: store.dir) } catch { if given == nil { return }; stored = nil }
    if let code = given ?? stored {
      guard let left = try? await Core.tools.joinSessionsWithRecoveryCode(device: device, code: code, hub: recoveryHub ?? hub, nowMs: nowMs()), !left.again else { return }
      var change = Change()
      for session in left.notJoined { board.pushAlert(&change, code: session.code, message: "a session could not be joined when this device signed in: another device of yours can add it") }
      try? await refreshGroups(&change)
      emit(change)
    }
    LocalKey.delete(item, dir: store.dir)
    record.codeJoin = nil
    try? store.save(record)
  }

  /**
   * The recovery when every device is lost (8.7): a new device signs in to the hub with the code's key and runs the
   * whole recovery (`CoreTools.recoverWithCode`): it joins the room group and every live session group, removes
   * every other human device and replaces the code, all published by the hub at once or not at all. `confirm` is
   * asked with the human devices that will be removed, before anything is posted that changes the room; `account`
   * gives the account's new sealed copies for the new code (Account.swift; `hub` is the recovery key's client, for
   * a passkey's challenge). A failure, or a `confirm` that says no (`cancelled`), leaves nothing of the device.
   */
  public static func recoverWithCode(hubURL: String, roomId: String, code: Bytes, base: URL = Store.defaultBase(), challenge: Bytes? = nil,
                                     confirm: @escaping ([DeviceId]) async -> Bool, account: @escaping (HubClient, Bytes) async throws -> Bytes) async throws -> (room: Room, removed: [DeviceId]) {
    let tools = Core.tools
    let hubURL = try tools.canonicalHub(hubURL)
    let room = try unhex(roomId)
    let made = try newDevice(base: base, roomId: roomId)
    do {
      let hub = try HubClient(hubURL: hubURL, room: room, signer: try tools.recoverySigner(code: code))
      _ = try await hub.signIn(challenge: challenge)
      let done = try await tools.recoverWithCode(device: made.device, code: code, hub: hub, nowMs: nowMs(), confirm: confirm) { try await account(hub, $0) }
      let record = RoomRecord(hubURL: hubURL, roomId: roomId, myDeviceId: hex(made.device.id), role: "human", deviceRegisterSent: false)
      try made.store.save(record)
      return (try Room(store: made.store, record: record, deviceStore: made.state, device: made.device), done.removed)
    } catch { abandon(made); throw error }
  }
}
