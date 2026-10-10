// Passkeys.swift: the system's part of a passkey (AuthenticationServices): making one for the account and answering
// a sign-in challenge with one, each with the prf extension over the account's fixed input. The prf output is what
// opens the passkey's sealed copy of the recovery code; it goes to the core through Account.swift and nowhere else.
// What the hub is sent and what is sealed is Account.swift's (`Room.addPasskey`, `Room.signInWithPasskey`).
//
// The relying party is the web app's domain, so a passkey made in the browser signs in here and the other way round.
// The system hands out passkeys of a domain only to an app that the domain names and that names the domain:
//   - the entitlement com.apple.developer.associated-domains needs the line  webcredentials:app.trommi.com
//   - https://app.trommi.com/.well-known/apple-app-site-association needs
//       "webcredentials": { "apps": ["<team id>.<bundle id>"] }
// Until both are there every request fails, so the controls (Create account → "Create with passkey", Log in → "Log in
// with passkey", Settings → Account → "Add passkey") are shown only when `Passkeys.available` says so: on by itself once
// the domain's file names this app (`Passkeys.probe`, at every start), or by the one constant `forcedOn`. Switched on,
// the passkey comes first on Create account and Log in (SignIn.swift). app/ios/README.md "Account" lists what switching
// it on needs.
//
// A passkey's user id is the 16 bytes of the account id, which the hub names with its challenge; its name is the
// account's email, or the account id for an account without one (`PasskeyRequest.name`).
import AuthenticationServices
import CryptoKit
import SwiftUI
import TrommiClient
#if canImport(UIKit)
import UIKit
#endif

@MainActor
enum Passkeys {
  static let relyingParty = "app.trommi.com"
  /**
   * The one constant: true switches passkeys on whatever the probe says. Left false, they are on as soon as the
   * domain's file names this app (`probe`), which the web app serves; the entitlement is in the app already.
   */
  static let forcedOn = false
  /**
   * The one switch for offering passkeys (the owner's decision, 10 October 2026, as on the web): off. Password managers
   * do not all give the prf output (1Password does not), so an account that opens only with a passkey is not reliable.
   * Off: no "Create with passkey", no "Log in with passkey", no "Add Passkey" unless the account has one already. All
   * the passkey code stays; switched on, the domain's file decides as before.
   */
  static let offered = false
  private static let known = "trommi.passkeys.associated"
  /** Whether the controls are shown: the switch, then the last probe's word (offline, the last word holds). */
  static private(set) var available: Bool = offered && (forcedOn || UserDefaults.standard.bool(forKey: known))
  /**
   * Reads https://app.trommi.com/.well-known/apple-app-site-association and switches passkeys on or off by whether
   * its `webcredentials` names this app. No answer changes nothing. Whether it changed is returned.
   */
  @discardableResult static func probe() async -> Bool {
    if forcedOn || !offered { return false }
    guard let bundle = Bundle.main.bundleIdentifier, let url = URL(string: "https://\(relyingParty)/.well-known/apple-app-site-association") else { return false }
    var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
    req.httpMethod = "GET"
    guard let (data, response) = try? await URLSession.shared.data(for: req), (response as? HTTPURLResponse)?.statusCode == 200, data.count < 128 * 1024 else { return false }
    let on = associationAllowsPasskeys(Bytes(data), bundleId: bundle)
    UserDefaults.standard.set(on, forKey: known)
    defer { available = on }
    return on != available
  }

  /** Make a passkey for the account, on this device or in the person's password manager. */
  static func make(_ r: PasskeyRequest) async throws -> PasskeyMade {
    let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: relyingParty)
    let request = provider.createCredentialRegistrationRequest(challenge: Data(r.challenge), name: r.name, userID: Data(r.userHandle))
    request.userVerificationPreference = .required
    request.prf = .inputValues(.init(saltInput1: Data(PASSKEY_PRF_INPUT)))
    guard let made = try await PasskeySheet().run(request).credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration,
          let attestation = made.rawAttestationObject else { throw TrommiError("passkey-failed", "the system made no passkey") }
    guard let prf = made.prf, prf.isSupported else { throw TrommiError("no-prf", "this passkey gives no key") }
    var output = prf.first.map(bytes)
    if output == nil {
      // A passkey store that says it can, and gives the output only when the passkey is used: used once, here. The
      // challenge of this second step is this device's own and is sent nowhere; only the output is wanted.
      output = try await assertion(challenge: systemRandom(32), only: [Bytes(made.credentialID)]).prf
    }
    guard let key = output, key.count == 32 else { throw TrommiError("no-prf", "this passkey gives no key") }
    return PasskeyMade(credentialId: Bytes(made.credentialID), attestationObject: Bytes(attestation), clientDataJSON: Bytes(made.rawClientDataJSON), prf: key)
  }

  /** Answer the hub's sign-in challenge with a passkey the person picks. */
  static func assert(challenge: Bytes) async throws -> PasskeyAssertion { try await assertion(challenge: challenge, only: nil) }

  /**
   * The way in for an account without a password, on a device that is in already: one of the account's passkeys
   * (`existing`) is used once for its prf output, which opens the account's sealed copy here (Account.swift). The
   * challenge is this device's own and is sent nowhere.
   */
  static func unlock(_ existing: [Bytes]) async throws -> WayIn {
    guard !existing.isEmpty else { throw TrommiError("wrong-login", "this account has no passkey") }
    let a = try await assertion(challenge: systemRandom(32), only: existing)
    guard a.prf.count == 32 else { throw TrommiError("no-prf", "this passkey gives no key") }
    return .passkey(credentialId: a.credentialId, prf: a.prf)
  }

  private static func assertion(challenge: Bytes, only: [Bytes]?) async throws -> PasskeyAssertion {
    let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: relyingParty)
    let request = provider.createCredentialAssertionRequest(challenge: Data(challenge))
    request.userVerificationPreference = .required
    request.prf = .inputValues(.init(saltInput1: Data(PASSKEY_PRF_INPUT)))
    if let ids = only { request.allowedCredentials = ids.map { ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: Data($0)) } }
    // (some of these are declared without saying whether they can be missing: each is asked for)
    guard let a = try await PasskeySheet().run(request).credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion,
          let data = a.rawAuthenticatorData as Data?, let signature = a.signature as Data? else {
      throw TrommiError("passkey-failed", "the system gave no passkey")
    }
    // (without the prf output the passkey proves who it is but opens nothing: Account.swift says `no-prf` and sends nothing)
    return PasskeyAssertion(credentialId: Bytes(a.credentialID), authenticatorData: Bytes(data), clientDataJSON: Bytes(a.rawClientDataJSON),
                            signature: Bytes(signature), userHandle: (a.userID as Data?).map { Bytes($0) }, prf: a.prf.map { bytes($0.first) } ?? [])
  }

  private static func bytes(_ key: SymmetricKey) -> Bytes { key.withUnsafeBytes { Bytes($0) } }
}

/** One request to the system's passkey sheet, as an async call. */
@MainActor
private final class PasskeySheet: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
  private var done: CheckedContinuation<ASAuthorization, Error>?
  private var controller: ASAuthorizationController?

  func run(_ request: ASAuthorizationRequest) async throws -> ASAuthorization {
    try await withCheckedThrowingContinuation { c in
      done = c
      let controller = ASAuthorizationController(authorizationRequests: [request])
      controller.delegate = self
      controller.presentationContextProvider = self
      self.controller = controller   // (kept until the system answers)
      controller.performRequests()
    }
  }
  private func finish(_ result: Result<ASAuthorization, Error>) {
    done?.resume(with: result)
    done = nil; controller = nil
  }
  func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) { finish(.success(authorization)) }
  func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
    // The system's own text is not passed on: one code for "the person closed the sheet", one for everything else.
    let cancelled = (error as? ASAuthorizationError)?.code == .canceled
    finish(.failure(TrommiError(cancelled ? "passkey-cancelled" : "passkey-failed", cancelled ? "no passkey was used" : "the passkey did not work")))
  }
  func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
    #if canImport(UIKit)
    return UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first ?? ASPresentationAnchor()
    #else
    return ASPresentationAnchor()
    #endif
  }
}
