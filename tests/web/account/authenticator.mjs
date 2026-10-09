// authenticator.mjs: a passkey in software, for the account's test against the REAL hub, which checks a registration
// and an assertion as WebAuthn has them (hub/src/webauthn.rs: the ceremony's type, its own challenge, an allowed
// origin and its relying-party id, user present and verified, the ES256 signature under the registered key). TEST
// ONLY. What it makes is what navigator.credentials would hand to public/auth.mjs, as bytes: an attestation object
// with the format "none", authenticator data, clientDataJSON, a signature. Its prf output is 32 random bytes fixed
// for the passkey, as an authenticator's is for one input.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'

const sha256 = data => createHash('sha256').update(data).digest()
const text = s => Buffer.concat([Buffer.from([0x60 | s.length]), Buffer.from(s)])
const blob = b => Buffer.concat([b.length < 24 ? Buffer.from([0x40 | b.length]) : b.length < 256 ? Buffer.from([0x58, b.length]) : Buffer.from([0x59, b.length >> 8, b.length & 255]), b])
const u8 = b => new Uint8Array(b)

export function softPasskey(origin) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' })
  const credential_id = randomBytes(32), prf = randomBytes(32)
  // COSE: { 1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y }
  const cose = Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21]), blob(Buffer.from(jwk.x, 'base64url')), Buffer.from([0x22]), blob(Buffer.from(jwk.y, 'base64url'))])
  const rp = sha256(new URL(origin).hostname)
  let count = 0
  // flags: user present 0x01, user verified 0x04, attested credential data 0x40
  const authData = attested => {
    const counter = Buffer.alloc(4); counter.writeUInt32BE(++count)
    const head = Buffer.concat([rp, Buffer.from([attested ? 0x45 : 0x05]), counter])
    return attested ? Buffer.concat([head, Buffer.alloc(16), Buffer.from([0, credential_id.length]), credential_id, cose]) : head
  }
  const clientData = (type, challenge) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }))
  return {
    credential_id: u8(credential_id), prf: u8(prf),
    /** As create() over the hub's challenge (base64url): what account.ts takes as a PasskeyRegistration. */
    create(challenge) {
      const attestation_object = Buffer.concat([Buffer.from([0xa3]), text('fmt'), text('none'), text('attStmt'), Buffer.from([0xa0]), text('authData'), blob(authData(true))])
      return { credential_id: u8(credential_id), attestation_object: u8(attestation_object), client_data_json: u8(clientData('webauthn.create', challenge)), transports: ['internal', 'hybrid'], prf: u8(prf) }
    },
    /** As get() over the hub's challenge: a PasskeyAssertion. */
    get(challenge, user_handle = null) {
      const authenticator_data = authData(false), client_data_json = clientData('webauthn.get', challenge)
      const signature = sign('sha256', Buffer.concat([authenticator_data, sha256(client_data_json)]), privateKey)
      return { credential_id: u8(credential_id), authenticator_data: u8(authenticator_data), client_data_json: u8(client_data_json), signature: u8(signature), user_handle, prf: u8(prf) }
    },
    /** The way in a signed-in device gives again with this passkey. */
    unlock() { return { passkey: { credential_id: u8(credential_id), prf: u8(prf) } } },
  }
}
