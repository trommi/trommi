// LiveCore.swift: `CoreTools` (TrommiClient/Core.swift) on the Rust core, through the UniFFI module TrommiCoreRust
// (core/swift, built by core/swift/build.sh). The app installs it once at launch: `Core.tools = LiveCore()`.
// The device is LiveDevice.swift; the store, errors and bytes at the edge are LiveStore.swift.
//
// WHAT IS REAL AND WHAT IS STUBBED, against the binding of core/swift/src (the facade's calls, one for one):
//
//   real, CoreTools     version, selfTest, createDevice, openDevice,
//                       normaliseEmail, checkPassword, passwordKeys, kitAuthKey, generateKitWords, parseKitWords,
//                       generateRecoveryCode, formatRecoveryCode, parseRecoveryCode, sealCode, openCode,
//                       encryptFile, decryptFile, generatePushKey
//   real, CoreDevice    id, room, cursor, isOwner, groups, contentKey, keyPackagesToUpload, keyPackage,
//                       foundSession, addHumanDevice, addToSession, changeAgents, removeHumanDevices, cleanSession,
//                       update, archive, joinWelcome, processLogEntry, logFinding, sendHandover, sendStrokePiece,
//                       outbox, outboxAccepted, outboxRefused, signHubAuth, close; CoreTools: createShareLink, isFinalRefusal
//   real by a detour    The core has the thing, the binding has no call of that shape; each asks the core itself.
//                       canonicalHub         the binding checks a hub's address only inside `hubSignIn`: a device in
//                                            memory signs a challenge of zeros for it and the signature is dropped
//   stubbed, CoreTools  parseInviteLink, inviteRequest, inviteReveal, checkEmoji, recoverySigner,
//                       joinWithRecoveryCode
//   stubbed, CoreDevice sendEnvelope, receiveEnvelope, register, cut, processRelay, openInvite,
//                       acceptInviteRequest, confirmInvite, burnInvite, replaceRecoveryCode
//
// A stubbed call throws `TrommiError("not-built", "<call>: not in this build of the core binding")`; the one that
// cannot throw (`checkEmoji`) returns a value that says the same. To make a call real, replace the body of its line
// with the call into TrommiCoreRust and move its name up in the list above.
//
// RECOVERY IS A STAND-IN in every build made with TROMMI_STAND_IN_RECOVERY=1, until the core carries section 8: a
// room founded with it cannot be recovered. Without that variable no room can be founded at all (`internal`).
// `recoveryState` says which one this build has.
import Foundation
import TrommiClient
import TrommiCoreRust

/// Open, with `createDevice` open, for one reason: a test wraps the devices it makes (Tests/TrommiCoreLiveTests).
open class LiveCore: CoreTools {
  public init() {}

  // ---- real -----------------------------------------------------------------------------------------------

  public var version: String { versions().core }
  /// The state of the recovery construct in this build, in the core's words: "built", or why it is not.
  public var recoveryState: String { versions().recovery }
  /// What the build is made of, for the information screen: core, OpenMLS, its crypto provider, the binding.
  public var buildVersions: (core: String, openmls: String, provider: String, binding: String) {
    let v = versions()
    return (v.core, v.openmls, v.provider, v.binding)
  }

  /// Two suites. "core": the Rust core's own check of its main paths, with devices in memory inside the library.
  /// "swift": the same device through this file's adapter and a store written in Swift, which the first suite
  /// never touches. A suite stops at its first failed step. The last step of "core" is the slow one (Argon2id over
  /// 64 MiB): call this off the main thread.
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

  /// Whether a code of the hub is its last word on an outbox entry, so that `outboxRefused` takes it. Not final,
  /// and the entry is sent again unchanged: the hub could not answer (`internal`, `overloaded`, `rate-limited`), it
  /// asks to sign in again (`unauthorised`), or the code is none this core knows. The rest of the list are codes
  /// no hub sends. The table is the core's (core/swift/src/device.rs `is_refusal`); a test holds the two together.
  public func isFinalRefusal(_ code: String) -> Bool { Self.isFinalRefusal(code) }
  public static func isFinalRefusal(_ code: String) -> Bool {
    errorCodeFromText(text: code) != nil && !notFinal.contains(code)
  }
  static let notFinal: Set<String> = ["internal", "overloaded", "rate-limited", "unauthorised", "storage", "entropy", "busy",
                                      "bad-email", "weak-password", "bad-kdf", "bad-recovery-words", "bad-recovery-code", "no-prf"]

  // ---- real by a detour: the core answers, through a device in memory ---------------------------------------

  /// `text` itself when it is a hub's canonical address (https, lower-case host, an optional port; http only for
  /// localhost and 127.0.0.1), `bad-format` otherwise. Nothing is normalised: the core refuses, it does not repair.
  public func canonicalHub(_ text: String) throws -> String {
    let probe = try LiveDevice(store: MemoryStorage(), create: true)
    defer { probe.close() }
    _ = try probe.signHubAuth(room: ZERO32, hub: text, challenge: ZERO32)
    return text
  }

  // =========================================================================================================
  // STUBBED: not in this build of the core binding. One line per call.
  // =========================================================================================================


  // invite, the joining side (12.1)
  public func parseInviteLink(_ text: String) throws -> InviteLinkParts { try notBuilt() }
  public func inviteRequest(link: String, offer: Bytes, offerSignature: Bytes, device: TrommiClient.CoreDevice, nowMs: UInt64) throws -> JoinRequest { try notBuilt() }
  public func inviteReveal(joiner: Bytes, reveal: Bytes, signature: Bytes) throws -> [UInt8] { try notBuilt() }
  public func checkEmoji(_ numbers: [UInt8]) -> [(emoji: String, word: String)] { numbers.map { _ in (emoji: "?", word: Self.notBuiltCode) } }

  // recovery (section 8)
  public func recoverySigner(code: Bytes) throws -> CoreSigner { try notBuilt() }
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

