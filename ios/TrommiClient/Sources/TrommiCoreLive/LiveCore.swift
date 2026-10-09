// LiveCore.swift: `CoreTools` (TrommiClient/Core.swift) on the Rust core, through the UniFFI module TrommiCoreRust
// (core/swift, built by core/swift/build.sh). The app installs it once at launch: `Core.tools = LiveCore()`.
//
// The binding grows with the core; this file follows it one line at a time. Today:
//
//   real      version
//   stubbed   selfTest; createDevice, openDevice; account (normaliseEmail … recoveryPublicKeys); canonicalHub;
//             invite (parseInviteLink, inviteRequest, inviteReveal, checkEmoji); files (encryptFile, decryptFile,
//             createShareLink); generatePushKey; recovery (recoverySigner, joinWithRecoveryCode)
//
// A stubbed call that can throw throws `TrommiError("not-built", "<call>: not in this build of the core binding")`.
// One that cannot throw returns a value that says the same. To make a call real, replace the body of its one line
// with the call into TrommiCoreRust and move its name up in the list above.
import Foundation
import TrommiClient
import TrommiCoreRust

public final class LiveCore: CoreTools {
  public init() {}

  // ---- real -----------------------------------------------------------------------------------------------

  public var version: String { coreVersion() }

  // ---- stubbed: one line per call ---------------------------------------------------------------------------

  public func selfTest() -> [SelfTestStep] { [SelfTestStep(suite: "", name: "self_test", ok: false, micros: 0, detail: Self.missing("selfTest()"))] }

  public func createDevice(store: CoreStorage) throws -> CoreDevice { try notBuilt() }
  public func openDevice(store: CoreStorage) throws -> CoreDevice { try notBuilt() }

  // account (8.8)
  public func normaliseEmail(_ email: String) throws -> String { try notBuilt() }
  public func checkPassword(_ password: String) throws { try notBuilt() as Void }
  public func passwordKeys(email: String, password: String, kdf: String?) throws -> PasswordKeys { try notBuilt() }
  public func kitAuthKey(email: String, words: String) throws -> String { try notBuilt() }
  public func generateKitWords() throws -> String { try notBuilt() }
  public func parseKitWords(_ text: String) throws -> String { try notBuilt() }
  public func generateRecoveryCode() throws -> Bytes { try notBuilt() }
  public func formatRecoveryCode(_ code: Bytes) -> String { Self.missing("formatRecoveryCode(_:)") }
  public func parseRecoveryCode(_ text: String) throws -> Bytes { try notBuilt() }
  public func sealCode(_ code: Bytes, email: String, room: RoomId, way: AccountWay) throws -> Bytes { try notBuilt() }
  public func openCode(_ sealed: Bytes, email: String, room: RoomId, way: AccountWay) throws -> Bytes { try notBuilt() }
  public func recoveryPublicKeys(code: Bytes) throws -> (signatureKey: Bytes, hpkeKey: Bytes) { try notBuilt() }

  // hub_auth (12.3)
  public func canonicalHub(_ text: String) throws -> String { try notBuilt() }

  // invite, the joining side (12.1)
  public func parseInviteLink(_ text: String) throws -> InviteLinkParts { try notBuilt() }
  public func inviteRequest(link: String, offer: Bytes, offerSignature: Bytes, device: CoreDevice, nowMs: UInt64) throws -> JoinRequest { try notBuilt() }
  public func inviteReveal(joiner: Bytes, reveal: Bytes, signature: Bytes) throws -> [UInt8] { try notBuilt() }
  public func checkEmoji(_ numbers: [UInt8]) -> [(emoji: String, word: String)] { numbers.map { _ in (emoji: "?", word: "not-built") } }

  // files (11)
  public func encryptFile(_ plain: Bytes) throws -> SealedFile { try notBuilt() }
  public func decryptFile(fileId: FileId, fileKey: Bytes, sha256: Bytes, stored: Bytes) throws -> Bytes { try notBuilt() }
  public func createShareLink(app: String, fileId: FileId, fileKey: Bytes) throws -> ShareLinkParts { try notBuilt() }

  // push (15.2)
  public func generatePushKey() throws -> Bytes { try notBuilt() }

  // recovery (section 8)
  public func recoverySigner(code: Bytes) throws -> CoreSigner { try notBuilt() }
  public func joinWithRecoveryCode(device: CoreDevice, code: Bytes, groupInfos: [(group: GroupId, groupInfo: Bytes)], sealedKeys: [Bytes], nowMs: UInt64) throws -> Bytes { try notBuilt() }

  // ---- what a stub answers ----------------------------------------------------------------------------------

  /// The code every stubbed call refuses with.
  public static let notBuiltCode = "not-built"

  private static func missing(_ call: String) -> String { "\(call): not in this build of the core binding" }

  /// Refuses in the name of the calling function (`#function`, for example "normaliseEmail(_:)").
  private func notBuilt<T>(_ call: String = #function) throws -> T { throw TrommiError(Self.notBuiltCode, Self.missing(call)) }
}
