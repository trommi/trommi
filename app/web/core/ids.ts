// ids.ts: ids and byte strings between the core, the hub and the model. The core and the hub's JSON speak strict
// base64url (no padding); the model the views read keeps lowercase hex, as it always did (ids in addresses, in
// timeline keys, in data attributes). Bytes for both are Uint8Array.
const HEX = /^(?:[0-9a-f]{2})*$/
const B64U = /^[A-Za-z0-9_-]*$/

export function hex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}
export function unhex(text: string): Uint8Array {
  if (typeof text !== 'string' || !HEX.test(text)) throw Object.assign(new Error('not lowercase hex'), { code: 'bad-format' })
  const out = new Uint8Array(text.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(2 * i, 2 * i + 2), 16)
  return out
}
export function b64u(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
/** Strict: only the canonical spelling of some bytes is read (no padding, no stray bits). */
export function unb64u(text: string): Uint8Array {
  if (typeof text !== 'string' || !B64U.test(text) || text.length % 4 === 1) throw Object.assign(new Error('not base64url'), { code: 'bad-format' })
  const bin = atob(text.replaceAll('-', '+').replaceAll('_', '/'))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  if (b64u(out) !== text) throw Object.assign(new Error('not canonical base64url'), { code: 'bad-format' })
  return out
}
/** An id as the model keeps it (hex) from the core's or the hub's (base64url), and back. */
export const idToHex = (id: string): string => hex(unb64u(id))
export const idFromHex = (id: string): string => b64u(unhex(id))
