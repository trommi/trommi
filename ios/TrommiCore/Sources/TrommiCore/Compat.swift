// Compat.swift: what this version of Trommi knows, and how it meets what a newer one wrote (README "Versioning and
// compatibility"; shared/codec.mjs and shared/model.mjs "forward compatibility", hub/ops/versions.mjs).
//
// The rules every client follows:
//   - unknown fields are ignored, and kept where a body is written again (notes, registers);
//   - an envelope kind, object type, card type, content type, answer action, timeline kind or schema_version this
//     version does not know is verified like any other (signature, chain) but never applied as something it is not:
//     it shows as a placeholder, `Item.unsupported(kind:)`, with `Compat.UPDATE_MESSAGE`;
//   - a write that would need a newer format is refused locally ("needs-update");
//   - the hub says which client versions it serves: `HubVersionInfo` (GET /v1/version), 426 client-too-old.
import Foundation

public enum Compat {
  /** The body schema this version writes and reads (codec.mjs SCHEMA_VERSION); a higher one is "newer_schema". */
  public static let SCHEMA_VERSION = 1
  /** The hub protocol this version speaks (Trommi-Protocol header). */
  public static let PROTOCOL_VERSION = 1
  public static let CONTENT_TYPES: Set<String> = ["message", "strokes", "erase", "move", "send_away", "selection_sent", "clip_request"]
  public static let OBJECT_TYPES: Set<String> = ["card", "note", "published"]
  public static let CARD_TYPES: Set<String> = ["decision", "info"]
  public static let ANSWER_ACTIONS: Set<String> = ["answer", "read", "shred"]
  public static let TIMELINE_KINDS: Set<Int> = [TIMELINE.CHAT, TIMELINE.CANVAS]
  /** What a client says where something of a newer version would be. */
  public static let UPDATE_MESSAGE = "This needs a newer version of Trommi. Update to see it."
}

/** One record as this version can show it: in full, or as a placeholder that asks for an update. */
public enum Item: Equatable {
  case supported
  /** `kind` names what is newer, e.g. "envelope kind 9", "card_type poll", "schema_version 2" (model.newer.what in JS). */
  case unsupported(kind: String)

  public var isSupported: Bool { self == .supported }

  /**
   * Classify one verified record from its signed header and its decoded body (nil fields: not in the body). The same
   * rules as shared/model.mjs: a kind of a newer format, a newer schema_version, then by kind the object type, card
   * type, answer action, timeline kind and content type.
   */
  public static func of(envelopeKind: Int, timelineKind: Int? = nil, schemaVersion: Int? = nil, contentType: String? = nil,
                        objectType: String? = nil, cardType: String? = nil, answerAction: String? = nil) -> Item {
    if !KIND.isKnown(envelopeKind) { return .unsupported(kind: "envelope kind \(envelopeKind)") }
    if let v = schemaVersion, v > Compat.SCHEMA_VERSION { return .unsupported(kind: "schema_version \(v)") }
    switch envelopeKind {
    case KIND.TIMELINE_ITEM:
      if let t = timelineKind, !Compat.TIMELINE_KINDS.contains(t) { return .unsupported(kind: "timeline kind \(t)") }
      if let c = contentType, !Compat.CONTENT_TYPES.contains(c) { return .unsupported(kind: "content_type \(c)") }
    case KIND.OBJECT_VERSION:
      if let o = objectType, !Compat.OBJECT_TYPES.contains(o) { return .unsupported(kind: "object_type \(o)") }
      if objectType == "card", let t = cardType, !Compat.CARD_TYPES.contains(t) { return .unsupported(kind: "card_type \(t)") }
    case KIND.ANSWER:
      if let a = answerAction, !Compat.ANSWER_ACTIONS.contains(a) { return .unsupported(kind: "answer_action \(a)") }
    default: break
    }
    return .supported
  }
}

/** "x.y.z" against "x.y.z": -1, 0, 1 (pre-release and build suffixes ignored; missing parts are 0). */
public func compareVersions(_ a: String, _ b: String) -> Int {
  func parts(_ v: String) -> [Int] {
    let core = v.split(whereSeparator: { $0 == "-" || $0 == "+" }).first.map(String.init) ?? ""
    return core.split(separator: ".").map { Int($0) ?? 0 }
  }
  let x = parts(a), y = parts(b)
  for i in 0..<3 {
    let p = i < x.count ? x[i] : 0, q = i < y.count ? y[i] : 0
    if p != q { return p < q ? -1 : 1 }
  }
  return 0
}

/**
 * The hub's GET /v1/version: which protocols it speaks and which client versions it serves. Unknown fields are ignored,
 * missing ones are empty. `verdict(kind:version:)` says what the app shows: nothing, a quiet "update available", or the
 * "please update" screen (the hub also answers such a client 426 client-too-old, and its stream `upgrade_required`).
 */
public struct HubVersionInfo: Decodable, Equatable {
  public var protocolVersionsSupported: [Int]
  public var minimumClientVersions: [String: String]
  public var recommendedClientVersions: [String: String]
  /** The highest versions a client may WRITE here ("envelope", "schema"; 1 when the hub says nothing): write min(own, this). */
  public var writeFormatVersions: [String: Int]
  public var message: String?

  enum CodingKeys: String, CodingKey {
    case protocolVersionsSupported = "protocol_versions_supported", minimumClientVersions = "minimum_client_versions"
    case recommendedClientVersions = "recommended_client_versions", writeFormatVersions = "write_format_versions", message
  }
  public init(protocolVersionsSupported: [Int] = [Compat.PROTOCOL_VERSION], minimumClientVersions: [String: String] = [:], recommendedClientVersions: [String: String] = [:], writeFormatVersions: [String: Int] = [:], message: String? = nil) {
    self.protocolVersionsSupported = protocolVersionsSupported; self.minimumClientVersions = minimumClientVersions
    self.recommendedClientVersions = recommendedClientVersions; self.writeFormatVersions = writeFormatVersions; self.message = message
  }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    protocolVersionsSupported = (try? c.decodeIfPresent([Int].self, forKey: .protocolVersionsSupported)) ?? [Compat.PROTOCOL_VERSION]
    minimumClientVersions = (try? c.decodeIfPresent([String: String].self, forKey: .minimumClientVersions)) ?? [:]
    recommendedClientVersions = (try? c.decodeIfPresent([String: String].self, forKey: .recommendedClientVersions)) ?? [:]
    writeFormatVersions = (try? c.decodeIfPresent([String: Int].self, forKey: .writeFormatVersions)) ?? [:]
    message = try? c.decodeIfPresent(String.self, forKey: .message)
  }
  /** The schema_version to write: the lower of this version's and the hub's level. */
  public var writeSchemaVersion: Int { min(Compat.SCHEMA_VERSION, max(1, writeFormatVersions["schema"] ?? 1)) }
  /** From the response body; nil when it is not JSON of this shape. */
  public static func parse(_ data: Data) -> HubVersionInfo? { try? JSONDecoder().decode(HubVersionInfo.self, from: data) }

  public enum Verdict: Equatable {
    case current
    /** The hub recommends a newer version: a quiet offer, the app keeps working. */
    case updateAvailable(recommended: String)
    /** This version is below the hub's minimum, or speaks no protocol the hub does: the "please update" screen. */
    case updateRequired(minimum: String?, message: String)
  }
  /** `kind`: "ios" for the iOS app (Trommi-Client ios/<version>). */
  public func verdict(kind: String = "ios", version: String) -> Verdict {
    if !protocolVersionsSupported.contains(Compat.PROTOCOL_VERSION) {
      return .updateRequired(minimum: minimumClientVersions[kind], message: message ?? "Please update Trommi.")
    }
    if let min = minimumClientVersions[kind], compareVersions(version, min) < 0 {
      return .updateRequired(minimum: min, message: message ?? "Please update Trommi (\(kind)) to \(min) or newer.")
    }
    if let rec = recommendedClientVersions[kind], compareVersions(version, rec) < 0 { return .updateAvailable(recommended: rec) }
    return .current
  }
}
