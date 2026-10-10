// LiveCore.swift: `CoreTools` (TrommiClient/Core.swift) on the Rust core, through the UniFFI module TrommiCoreRust
// (core/swift, built by core/swift/build.sh). The app installs it once at launch: `Core.tools = LiveCore()`.
// The device is LiveDevice.swift; the store, errors and bytes at the edge are LiveStore.swift.
//
// WHAT IS REAL AND WHAT IS STUBBED, against the binding of core/swift/src (the facade's calls, one for one):
//
//   real, CoreTools     version, selfTest, createDevice, openDevice,
//                       normaliseEmail, checkPassword, passwordKeys, kitAuthKey, generateKitWords, parseKitWords,
//                       generateRecoveryCode, formatRecoveryCode, parseRecoveryCode, sealCode, openCode,
//                       encryptFile, decryptFile, createShareLink, generatePushKey, isFinalRefusal, canonicalHub,
//                       recoverySigner, parseInviteLink, inviteRequest, checkEmoji
//   real, CoreDevice    id, room, cursor, isOwner, groups, keyPackagesToUpload, keyPackage, foundRoom,
//                       foundSession, addToSession, changeAgents (removing only: the core's removeAgents),
//                       removeHumanDevices, cleanSession, update, archive, joinWelcome, processLogEntry, logFinding,
//                       processRelay, sendHandover, sendStrokePiece, outbox, outboxAccepted, outboxRefused,
//                       signHubAuth, close, sendEnvelope, receiveEnvelope, register, cut,
//                       openInvite, acceptInviteRequest, confirmInvite, burnInvite
//   real by a detour    recoverySigner's id  the recovery key's public half is read out of a `HubAuth` it signed
//   real, and not in    Recovery (section 8) as the core has it, which Core.swift's two awaited calls cannot say
//   Core.swift yet      (LiveRecovery.swift): LiveCore.recoveryAnchor, LiveCore.joinWithRecoveryCode(device:code:
//                       hub:nowMs:); LiveDevice.joinRoomWithCode, joinSessionWithCode, newRecoveryCode, replaceCode,
//                       prepareRecovery, recover, holdsRecoveryMac, keyIsConfirmed, sendRecoveryAuth, postSealedKey,
//                       verifyFounding, heldBack. Also LiveDevice.isHuman, disallowed, roomRoles, holdsKey.
//                       Invites (12.1): LiveDevice.inviteSteps, inviteHandover, inviteRecommit, inviteForget (what
//                       follows a confirmed invite), joinRequest, joinReveal, joinObserve, joinInvited (the new
//                       device); LiveCore.inviteReveal(device:reveal:signature:).
//   stubbed, CoreTools  inviteReveal(joiner:reveal:signature:)   (the core checks a Reveal on the device),
//                       joinWithRecoveryCode(device:code:groupInfos:sealedKeys:nowMs:)   (the core needs more of the
//                                            hub than this call hands over, and the hub's answer between its steps)
//   stubbed, CoreDevice contentKey           (gone from the binding: a content key never leaves the core),
//                       addHumanDevice, changeAgents(enrol:)   (gone from the core: a device comes by invite only),
//                       replaceRecoveryCode(nowMs:)   (the core needs the code in force and the account's new copies)
//
// A stubbed call throws `TrommiError("not-built", "<call>: not in this build of the core binding")`. To make a call
// real, replace the body of its line with the call into TrommiCoreRust and move its name up in the list above.
import Foundation
import TrommiClient
import TrommiCoreRust

/// Open, with `createDevice` open, for one reason: a test wraps the devices it makes (Tests/TrommiCoreLiveTests).
open class LiveCore: CoreTools {
  public init() {}

  // ---- real -----------------------------------------------------------------------------------------------

  public var version: String { versions().core }
  /// What the build is made of, for the information screen: core, OpenMLS, its crypto provider, the binding.
  public var buildVersions: (core: String, openmls: String, provider: String, binding: String) {
    let v = versions()
    return (v.core, v.openmls, v.provider, v.binding)
  }

  /// Two suites. "core": the Rust core's own check of its main paths (twelve steps, recovery among them), with
  /// devices in memory inside the library. "swift": a device through this file's adapter and a store written in
  /// Swift, which the first suite never touches. A suite stops at its first failed step. The last step of "core" is
  /// the slow one (Argon2id over 64 MiB): call this off the main thread.
  public func selfTest() -> [TrommiClient.SelfTestStep] {
    let report = TrommiCoreRust.selfTest(nowMs: nowMs())
    return report.steps.map { TrommiClient.SelfTestStep(suite: "core", name: $0.name, ok: $0.ok, micros: $0.micros, detail: $0.detail) } + swiftSuite()
  }

  open func createDevice(store: CoreStorage) throws -> TrommiClient.CoreDevice { try LiveDevice(store: store, create: true) }
  public func openDevice(store: CoreStorage) throws -> TrommiClient.CoreDevice { try LiveDevice(store: store, create: false) }

  // account (8.8)
  public func normaliseEmail(_ email: String) throws -> String { try core { try TrommiCoreRust.normaliseEmail(email: email) } }
  public func checkPassword(_ password: String) throws { try core { try TrommiCoreRust.checkPassword(password: password) } }
  public func passwordKeys(email: String, password: String, kdf: String?) throws -> PasswordKeys {
    let keys = try core { try TrommiCoreRust.passwordKeys(email: email, password: password, kdf: kdf) }
    return PasswordKeys(authKey: b64u(keys.authKey.bytes), wrapKey: keys.wrapKey.bytes)
  }
  public func kitAuthKey(email: String, words: String) throws -> String { b64u(try core { try kitKeys(email: email, words: words) }.authKey.bytes) }
  public func generateKitWords() throws -> String { try core { try TrommiCoreRust.generateKitWords() } }
  public func parseKitWords(_ text: String) throws -> String { try core { try TrommiCoreRust.parseKitWords(text: text) } }
  public func generateRecoveryCode() throws -> Bytes { try core { try TrommiCoreRust.generateRecoveryCode() }.bytes }
  /// Empty for anything but 32 bytes: Core.swift's call cannot throw, the core's does.
  public func formatRecoveryCode(_ code: Bytes) -> String { (try? TrommiCoreRust.formatRecoveryCode(recoveryCode: code.data)) ?? "" }
  public func parseRecoveryCode(_ text: String) throws -> Bytes { try core { try TrommiCoreRust.parseRecoveryCode(text: text) }.bytes }
  public func sealCode(_ code: Bytes, email: String, room: RoomId, way: TrommiClient.AccountWay) throws -> Bytes {
    try core {
      let (key, way, credential) = try wrapKey(way, email: email, room: room)
      return try sealRecoveryCode(wrapKey: key, roomId: room.data, wayIn: way, credentialId: credential, recoveryCode: code.data)
    }.bytes
  }
  public func openCode(_ sealed: Bytes, email: String, room: RoomId, way: TrommiClient.AccountWay) throws -> Bytes {
    try core {
      let (key, way, credential) = try wrapKey(way, email: email, room: room)
      return try openRecoveryCode(wrapKey: key, roomId: room.data, wayIn: way, credentialId: credential, sealed: sealed.data)
    }.bytes
  }
  /// The key that seals one copy of the code. The e-mail goes into the kit's key alone: the password's key was
  /// derived from it already, and a passkey's key hangs on the room and the credential, so `email` is not read
  /// for those two and may be empty.
  private func wrapKey(_ way: TrommiClient.AccountWay, email: String, room: RoomId) throws -> (key: Data, way: TrommiCoreRust.AccountWay, credential: Data?) {
    switch way {
    case .password(let wrapKey): return (wrapKey.data, .password, nil)
    case .kit(let words): return (try kitKeys(email: email, words: words).wrapKey, .kit, nil)
    case .passkey(let prf, let credentialId): return (try passkeyWrapKey(prf: prf.data, roomId: room.data, credentialId: credentialId.data), .passkey, credentialId.data)
    }
  }

  // files (11): the whole file at once here; the binding's `FileEncryptor` and `FileDecryptor` also take it in pieces
  public func encryptFile(_ plain: Bytes) throws -> SealedFile {
    try core {
      let encryptor = try FileEncryptor()
      defer { encryptor.close() }   // wipes the file's key, also when a step below refused
      var stored = try encryptor.update(plaintext: plain.data)
      let end = try encryptor.finish()
      stored.append(end.stored)
      return SealedFile(fileId: end.file.fileId.bytes, fileKey: end.file.fileKey.bytes, sha256: end.file.sha256.bytes, stored: stored.bytes)
    }
  }
  /// Nothing is returned unless the whole file is the one the reference names (`decrypt-failed` otherwise).
  public func decryptFile(fileId: FileId, fileKey: Bytes, sha256: Bytes, stored: Bytes) throws -> Bytes {
    try core {
      let decryptor = try FileDecryptor(file: FileRef(fileId: fileId.data, fileKey: fileKey.data, sha256: sha256.data))
      defer { decryptor.close() }
      var plain = try decryptor.update(stored: stored.data)
      plain.append(try decryptor.finish())
      return plain
    }.bytes
  }
  public func createShareLink(app: String, fileId: FileId, fileKey: Bytes, sha256: Bytes) throws -> ShareLinkParts {
    let link = try core { try shareLinkCreate(app: app, file: FileRef(fileId: fileId.data, fileKey: fileKey.data, sha256: sha256.data)) }
    return ShareLinkParts(link: link.text, shareId: link.shareId.bytes, secretHash: link.secretHash.bytes)
  }

  // push (15.2)
  public func generatePushKey() throws -> Bytes { try core { try TrommiCoreRust.generatePushKey() }.bytes }

  /// Whether a code of the hub is its last word on an outbox entry, so that the caller reports it with
  /// `outboxRefused` and stops sending those bytes. Not final, and the entry is sent again unchanged: a refusal that
  /// says nothing about the request (`passing`: the hub failed or is busy, wants a new sign-in, a newer client or
  /// the lease), a code no hub answers with (`notOfAHub`), and a code this core does not know. Every other code
  /// judges the request, `quota-exceeded`, `too-many` and `gap` among them: the core undoes what the entry was for.
  /// The two lists are the core's (core/src/device.rs `refusal_is_passing`, core/swift/src/device.rs `is_hub_code`);
  /// a test holds them together.
  public func isFinalRefusal(_ code: String) -> Bool { Self.isFinalRefusal(code) }
  public static func isFinalRefusal(_ code: String) -> Bool {
    errorCodeFromText(text: code) != nil && !passing.contains(code) && !notOfAHub.contains(code)
  }
  static let passing: Set<String> = ["internal", "overloaded", "rate-limited", "unauthorised", "bad-challenge", "client-too-old", "lease-lost"]
  /// What only a client finds, the account's own checks, and what a device says only of itself.
  static let notOfAHub: Set<String> = ["storage", "entropy", "busy", "bad-email", "weak-password", "bad-kdf", "bad-recovery-words", "bad-recovery-code", "no-prf",
                                       "withheld", "hub-voided-other", "bad-group", "no-key", "pruned", "decrypt-failed", "code-not-confirmed", "hash-mismatch", "cut"]

  // invite, the joining side (12.1): the joining side's state is the device's, kept in its store
  /// The hub, the room and the invite's id a link names. The link's secret is not among them.
  public func parseInviteLink(_ text: String) throws -> TrommiClient.InviteLinkParts {
    let parts = try core { try inviteLinkParse(text: text) }
    return TrommiClient.InviteLinkParts(hub: parts.hub, room: parts.roomId.bytes, invite: parts.inviteId.bytes)
  }
  public func inviteRequest(link: String, offer: Bytes, offerSignature: Bytes, device: TrommiClient.CoreDevice, nowMs: UInt64) throws -> TrommiClient.JoinRequest {
    try live(device).joinRequest(link: link, offer: offer, offerSignature: offerSignature, nowMs: nowMs)
  }
  /// Checks the Reveal against the Request `device` made; the six numbers 0 to 63.
  public func inviteReveal(device: TrommiClient.CoreDevice, reveal: Bytes, signature: Bytes) throws -> [UInt8] {
    try live(device).joinReveal(reveal: reveal, signature: signature)
  }
  /// The emoji and word of each number, from the core's list of 64. A number that is none of them is "?" without a
  /// word: this call cannot throw.
  public func checkEmoji(_ numbers: [UInt8]) -> [(emoji: String, word: String)] {
    let all = TrommiCoreRust.checkEmoji()
    return numbers.map { Int($0) < all.count ? (emoji: all[Int($0)].emoji, word: all[Int($0)].word) : (emoji: "?", word: "") }
  }
  private func live(_ device: TrommiClient.CoreDevice) throws -> LiveDevice {
    guard let live = device as? LiveDevice else { throw TrommiError("bad-format", "not a device of this core") }
    return live
  }

  /// `text` itself when it is a hub's canonical address (https, lower-case host, an optional port; http only for
  /// localhost and 127.0.0.1), `bad-format` otherwise. Nothing is normalised: the core refuses, it does not repair.
  public func canonicalHub(_ text: String) throws -> String { try core { try hubAddress(text: text) } }

  // =========================================================================================================
  // STUBBED: not in this build of the core binding. One line per call.
  // =========================================================================================================


  // invite, the joining side (12.1)
  // the binding checks a Reveal on the device that made the Request: `inviteReveal(device:reveal:signature:)`
  public func inviteReveal(joiner: Bytes, reveal: Bytes, signature: Bytes) throws -> [UInt8] { try notBuilt() }

  // recovery (section 8): the call the core cannot serve in this shape. The real ones are in LiveRecovery.swift.
  public func joinWithRecoveryCode(device: TrommiClient.CoreDevice, code: Bytes, groupInfos: [(group: GroupId, groupInfo: Bytes)], sealedKeys: [Bytes], nowMs: UInt64) throws -> Bytes { try notBuilt() }

  /// The code every stubbed call refuses with.
  public static let notBuiltCode = "not-built"

  // ---- the Swift half of the self-test ----------------------------------------------------------------------

  private func swiftSuite() -> [TrommiClient.SelfTestStep] {
    var steps = [TrommiClient.SelfTestStep]()
    var failed = false
    func step(_ name: String, _ body: () throws -> Void) {
      if failed { return }
      let start = DispatchTime.now().uptimeNanoseconds
      var detail = ""
      do { try body() } catch { failed = true; detail = (error as? TrommiError)?.description ?? "internal: an error of another kind" }
      steps.append(TrommiClient.SelfTestStep(suite: "swift", name: name, ok: !failed, micros: (DispatchTime.now().uptimeNanoseconds - start) / 1000, detail: detail))
    }
    func expect(_ holds: Bool, _ what: String) throws { if !holds { throw TrommiError("internal", what) } }

    let store = MemoryStorage()
    var device: LiveDevice?
    var id = Bytes(), room = Bytes(), sent = [TrommiClient.OutboxEntry]()
    step("a device is made over a store written in Swift") {
      device = try LiveDevice(store: store, create: true)
      id = device?.id ?? []
      try expect(id.count == 32 && device?.room == nil, "the new device is not as expected")
    }
    step("it founds a room; the founding is in its outbox") {
      room = try device?.foundRoom(recoveryCode: generateRecoveryCode(), nowMs: nowMs()) ?? []
      sent = device?.outbox() ?? []
      try expect(sent.count == 1 && sent[0].kind == .roomFounding && sent[0].parts.count == 2, "the outbox does not hold the founding")
    }
    step("opened again from the store: the same device, room and outbox") {
      device?.close()
      device = try LiveDevice(store: store, create: false)
      try expect(device?.id == id && device?.room == room && device?.outbox() ?? [] == sent, "the device opened from its store is another")
    }
    step("a write behind its back: the device is the owner no more") {
      store.writeBehindTheOwner()
      do { _ = try device?.keyPackage(nowMs: nowMs()); throw TrommiError("internal", "a conflict was not noticed") }
      catch let e as TrommiError where e.code == "storage" {}
      try expect(device?.isOwner == false, "the device still calls itself the owner")
    }
    device?.close()
    return steps
  }
}

