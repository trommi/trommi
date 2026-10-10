// hub.ts: the hub's routes (spec/hub-api.md) over fetch, for a human device, the recovery key's token and a device that
// is not a member yet (account, invite and share routes). It signs in by a signed challenge (spec/v2.md 12.3), keeps
// the token and renews it, posts the outbox, pages the catch-up and reads the live stream. It keeps no state about the
// room beyond the token, and it runs wherever fetch and streams do: a Web Worker and Node.
//
// The hub is not trusted. Everything it answers is checked for its shape before it is handed on: types, sizes, counts,
// ids and byte strings in their one base64url spelling, change numbers in the order the protocol says. An answer that
// fails is a HubError `bad-answer`, never a value. No redirect is followed (the token would travel with it), every
// answer has a size limit, and a path is only ever built from ids this module checked itself.
//
// Three outcomes of a request must never be confused, because the engine voids an outbox entry only on the first:
//   refused     the hub said `{ error, message }` with a code and its status of spec/v2.md 16 → HubError, `transient` false
//   not reached no answer (after one more try at once, for a request that is safe to repeat: `REPEATABLE`), a
//               broken answer, a deadline                                 → HubError `offline`, status 0
//   not now     5xx (`overloaded`, `internal`), `rate-limited`, `too-many` (a limit that may free up), a proxy's own
//               error (any status whose body is not a refusal this protocol knows), an answer that does not parse,
//               a sign-in that has to be made again                       → HubError, `transient` true
// A repeated post of the same bytes gets the hub's first answer again (hub-api.md), so sending again is safe. Two
// writes are the exception: a relayed message is passed on each time it is posted (its receivers must take a piece
// twice), and a claim of KeyPackages uses them up each time.
//
// Ids and byte strings are Uint8Array on this module's side, as the core has them (core-api.ts); in the hub's JSON
// and in a path they are base64url. The fields keep the hub's names.
//
// Nothing here writes a log line: tokens, bodies and share secrets never leave this module but in a request.
import { b64u, hex, unb64u } from './ids.ts'
import type { LogEntry, OutboxEntry, ServedGroup, ServedRoom, SignedHubAuth } from './core-api.ts'

const MIB = 1 << 20
/** Most a JSON answer may hold: a small one; a list (the hub's 8 MiB of envelopes, the one item that may exceed it,
 *  and the JSON around them); the Desk (the same budget, the registers and the room's groups). */
const CAP_SMALL = MIB
const CAP_LIST = 16 * MIB
const CAP_DESK = 32 * MIB
/** spec/v2.md 16: a file is at most 64 MiB. */
const CAP_FILE = 64 * MIB
const CAP_REFUSAL = 64 << 10
/** One event of the stream: a Commit with its RecoveryAuth in base64url stays far below the hub's stream buffer. */
const CAP_EVENT = 4 * MIB
/** The sizes of what travels in an answer (v2.md 16): an envelope (padded body 64 KiB, 255 file ids), an entry of a
 *  group's log, a GroupInfo or a Welcome (each within the 1 MiB of a Commit), a KeyPackage, the small structs. */
const MAX_ENVELOPE = 128 << 10
const MAX_MLS = MIB
const MAX_KEY_PACKAGE = 16 << 10
const MAX_SMALL_STRUCT = 1024
/** Most a room may weigh as it is served to a device that comes with the code (`servedRoom`): every Commit of the
 *  room group and of each live session group, their GroupInfos, every SealedKey and RecoveryLink. */
const CAP_SERVED = 256 * MIB
/** A signature or a MAC: 64 and 32 bytes in v2.md; their exact form is the core's to check, here only that they are small. */
const MAX_TAG = 128
/** hub-api.md "Decided for the first hub" 32: one catch-up answer looks at most so many change numbers ahead. */
const CHANGES_WINDOW = 20_000
/** v2.md 12.3.1: a token is for ten minutes. */
const TOKEN_MS = 600_000
const CODE = /^[a-z0-9-]{1,40}$/
/** The codes a hub refuses with and the status each comes with (v2.md 16; hub-api.md "Decided" 28; hub/src/error.rs).
 *  An answer that is not one of these with its own status is not taken for the hub's refusal. */
const STATUS_OF: Record<string, number> = Object.fromEntries(Object.entries({
  400: 'bad-format newer-version bad-commit bad-signature bad-invite bad-key-package wrong-room incomplete chain-break bad-email bad-passkey',
  401: 'unauthorised bad-challenge wrong-login wrong-recovery',
  403: 'forbidden not-member removed-sender wrong-sender',
  404: 'not-found no-room', 405: 'method-not-allowed', 410: 'gone invite-expired invite-burned',
  409: 'epoch-taken wrong-epoch room-behind group-behind stale-session epoch-full replay gap equivocation room-exists invite-used lease-lost account-exists last-way-in account-changed',
  413: 'too-large quota-exceeded', 416: 'range', 426: 'client-too-old', 429: 'too-many rate-limited', 500: 'internal', 503: 'overloaded',
}).flatMap(([status, codes]) => codes.split(' ').map(code => [code, Number(status)])))
/** Refusals that say "not now" of bytes that may be sent again unchanged: throttling, a limit that may free up
 *  (KeyPackages not yet claimed, uploads or a recovery in progress), a sign-in to make again, a client to update. */
const NOT_NOW = new Set(['rate-limited', 'too-many', 'unauthorised', 'bad-challenge', 'client-too-old'])
const TOKEN = /^[A-Za-z0-9_-]{16,200}$/
const PATH = /^\/v2(\/[A-Za-z0-9_-]{1,128}){1,8}$/
/**
 * The requests that may go a second time at once when the first met no answer at all (the connection was dead: a hub
 * that restarted leaves kept-alive connections behind, and not every platform's fetch takes a fresh one by itself as
 * browsers do). A request that got no answer may still have been carried out, so only these: every GET, and the
 * writes the hub answers alike when the same bytes come again (hub-api.md "Decided" 7 and 13), and the logins and
 * challenges, which change nothing. NOT among them, because a second arrival is refused or done twice: a claim of
 * KeyPackages, a relayed message, a request or a reject, opening a recovery, the sign-in's token (its challenge is
 * used up), a passkey login and a new passkey (their challenge too), sign-up, a new password or kit (the revision
 * moved), push, and every DELETE.
 */
const REPEATABLE = [
  /^GET /,
  /^PUT \/v2\/(files\/[^/]+|key-packages|sealed-keys|invites\/[^/]+\/reveal)$/,
  /^POST \/v2\/(rooms|groups|envelopes|invites|shares|account\/login|account\/recover|account\/passkey\/challenge|account\/passkeys\/challenge)$/,
  /^POST \/v2\/groups\/[^/]+\/(commits|messages|archive)$/,
  /^POST \/v2\/rooms\/[^/]+\/(recovery-code|recovery\/[^/]+\/(commits|finish))$/,
  /^POST \/v2\/invites\/[^/]+\/request$/,
]
const QUERY_VALUE = /^[A-Za-z0-9_.-]{0,512}$/

/** A request that did not end in the answer the protocol promises. `code` is the hub's (v2.md 16) or one of this
 *  module's: `offline` (not reached, status 0), `bad-answer` (reached, but the answer is not the protocol's),
 *  `http-<status>` (a status without a refusal this protocol knows: a proxy). `message` is this module's own text:
 *  what the hub wrote is in `hub_message`, which is not printed with the error (a hub could echo a secret there). */
export class HubError extends Error {
  code: string
  status: number
  /** The hub stored a void record for the envelope: its number is used up (v2.md 9.0.11). */
  voided: boolean
  /** Seconds the hub asks to wait (`retry-after`), or null. */
  retry_after: number | null
  /** The further members of a refusal's body (the current `epoch` of `epoch-taken`, the `seq` of a `gap`): unchecked. */
  details: Readonly<Record<string, unknown>>
  declare readonly hub_message: string | null
  constructor(code: string, message: string, more: { status?: number; voided?: boolean; retry_after?: number | null; details?: Record<string, unknown>; hub_message?: string | null } = {}) {
    super(message)
    Object.defineProperty(this, 'hub_message', { value: more.hub_message ?? null, enumerable: false })
    this.name = 'HubError'
    this.code = code
    this.status = more.status ?? 0
    this.voided = more.voided ?? false
    this.retry_after = more.retry_after ?? null
    this.details = more.details ?? {}
  }
  /** True when the same request may be sent again later as it is: the hub was not reached, is busy, throttles or is
   *  at a limit that may free up, its answer was unusable, or the sign-in has to be made again. False: the hub
   *  refused these bytes, and sending them again gets the same refusal. */
  get transient(): boolean {
    return this.status === 0 || this.status >= 500 || this.code === 'bad-answer' || this.code.startsWith('http-') || NOT_NOW.has(this.code)
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// What the hub serves, as this module hands it on.

/** One entry of the room's one order (hub-api.md "Decided" 19). `logEntry` makes the core's `LogEntry` of a Commit
 *  or message. */
export type ChangeItem =
  | { change: number; kind: 'commit'; group: Uint8Array; n: number; epoch: number; at: number; bytes: Uint8Array; sender: Uint8Array; recovery_auth: Uint8Array | null }
  | { change: number; kind: 'message'; group: Uint8Array; n: number; epoch: number; at: number; bytes: Uint8Array; sender: Uint8Array }
  | { change: number; kind: 'envelope'; envelope: Uint8Array; received_at: number; void_code: string | null }
export type LogItem = Extract<ChangeItem, { kind: 'commit' | 'message' }>
/** A Commit or message of the hub's log as the core's `processLogEntry` takes it. */
export const logEntry = (item: LogItem): LogEntry => ({ change: item.change, group: item.group, kind: item.kind, bytes: item.bytes, recoveryAuth: item.kind === 'commit' ? item.recovery_auth : null })
/** An envelope as a read route serves it: pruned form when its body is gone; `cut` only on the chain route. */
export interface EnvelopeItem { change: number; envelope: Uint8Array; received_at: number; void_code: string | null; cut: boolean }
export interface ChainItem extends EnvelopeItem { seq: number }

/** A wish a device left for the human devices, as the stream announces it and `requests()` lists it. */
export interface RequestRow {
  id: number; device: Uint8Array; kind: 'readmit' | 'handover' | 'session' | 'reject'; group: Uint8Array | null
  key_package: Uint8Array | null; n: number | null; at: number; committer: Uint8Array | null
}
/** One event of the live stream (hub-api.md "Decided" 20). Only `change` has a number and is replayed on resume. */
export type StreamEvent =
  | { event: 'change'; item: ChangeItem }
  | { event: 'relay'; group: Uint8Array; epoch: number; sender: Uint8Array; message: Uint8Array }
  | { event: 'welcome'; group: Uint8Array }
  | { event: 'request'; kind: 'readmit' | 'handover' | 'session' | 'reject'; id: number; device: Uint8Array; group: Uint8Array | null; n: number | null; committer: Uint8Array | null }
  | { event: 'invite_request'; invite_id: Uint8Array }
  | { event: 'presence'; device: Uint8Array; online: boolean; lost: boolean; hears: boolean | null; working: boolean | null; last_call_at: number | null }
  | { event: 'archived'; group: Uint8Array }
  | { event: 'file_evicted'; file_id: Uint8Array }

export interface GroupRow {
  group: Uint8Array; kind: 'room' | 'main' | 'helper'; session_id: Uint8Array | null; parent: Uint8Array | null
  epoch: number; room_epoch: number; live: boolean; stale: boolean; leaves: Uint8Array[]
}
/** An open object of the Desk: `state` 1 open, 2 answered, 3 closed; `urgency` 0 to 3 (v2.md 9). */
export interface DeskObject {
  object_id: Uint8Array; group: Uint8Array; state: number; urgency: number; answered_at: number; owner: Uint8Array
  first_change: number; head_change: number; version: EnvelopeItem | null
}
export interface Desk {
  cards: DeskObject[]; notes: DeskObject[]; permission_requests: DeskObject[]; artifacts: DeskObject[]
  registers: EnvelopeItem[]; groups?: GroupRow[]
  /** The Desk was cut short: the rest comes by `changes`. */
  truncated: boolean
  change: number
}
export interface ObjectEnvelopes {
  object_id: Uint8Array; group: Uint8Array; state: number; urgency: number; owner: Uint8Array; first_change: number; head_change: number
  items: EnvelopeItem[]; more: boolean
}
export type ObjectRoute = 'cards' | 'notes' | 'permission-requests' | 'artifacts'

/** The body of a Commit as its routes take it. `epoch`: the epoch it builds on. */
export interface CommitParts {
  epoch: number; commit: Uint8Array; group_info: Uint8Array; sealed_key: Uint8Array
  welcome?: Uint8Array | null; recovery_auth?: Uint8Array | null
}

/** The key derivation record: the hub stores and returns exactly the pinned one, as a JSON object. */
export type Kdf = Record<string, string | number>
export interface PasskeyRegistration { attestation_object: Uint8Array; client_data_json: Uint8Array; sealed_copy: Uint8Array; transports?: string[] }
/** Which salt an Emergency Kit's keys have (v2.md 8.8.2). It follows from the account alone: its e-mail where it
 *  has one, else its id. The hub cannot check a kit; `kit_form` in its answers says which the account's kit has. */
export type KitForm = 'email' | 'id'
/** A kit's part of a body: its login key and the code sealed under its wrap key. */
export interface KitPart { auth_key: Uint8Array; sealed_copy: Uint8Array }
/** `POST /v2/account`, and `account` of `POST /v2/rooms`: the Emergency Kit and at least one way in. An e-mail
 *  comes with a password and is optional beside a passkey. The account's id is the hub's: with a passkey the one
 *  it named with the registration's challenge (`passkeyChallenge`). */
export interface NewAccount {
  email?: string | null
  kit: KitPart
  password?: { auth_key: Uint8Array; sealed_copy: Uint8Array; kdf: Kdf }
  passkey?: PasskeyRegistration
}
/** The account's new sealed copies that come with new recovery keys (v2.md 8.6, 8.7): a new kit and ONE way in;
 *  the hub removes every other. Either the way in used just now, with a new copy under it (`password: { sealed_copy }`,
 *  the login key stays; `passkey: { credential_id, sealed_copy }`), or one set anew, after a recovery with the kit's
 *  words or the bare code: a password with its login key and `kdf`, or a passkey registered as in sign-up (its
 *  challenge is the account's, or one of `passkeyChallenge()`, which needs no token). */
export interface AccountCopies {
  kit: KitPart
  password?: { sealed_copy: Uint8Array } | { auth_key: Uint8Array; sealed_copy: Uint8Array; kdf: Kdf }
  passkey?: { credential_id: Uint8Array; sealed_copy: Uint8Array } | PasskeyRegistration
}
export interface AccountView {
  /** null: an account without an e-mail (its ways in are its passkeys and its kit). */
  email: string | null
  /** The account's id as it is printed: a UUID, lower case, with dashes. Its 16 bytes are `user_handle`. */
  account: string
  kit_form: KitForm
  revision: number; has_password: boolean; kdf: Kdf | null
  password_copy: Uint8Array | null; kit_copy: Uint8Array; user_handle: Uint8Array
  passkeys: { credential_id: Uint8Array; sealed_copy: Uint8Array; transports: string[]; created_at: number; last_used_at: number | null }[]
  rooms: Uint8Array[]
}
/** What a login answers: per room the sealed copy of its recovery code and a sign-in challenge of that room; and
 *  which account it is: its id, and its e-mail if it has one. */
export interface LoginAnswer { rooms: { room_id: Uint8Array; sealed_copy: Uint8Array; challenge: Uint8Array }[]; kdf: Kdf | null; account: string; email: string | null }
/** A passkey challenge with the id of the account the passkey is for: the one an account made on this challenge
 *  will have (no token), or this room's account's. `user_handle` is the id's 16 bytes, the passkey's `user.id`. */
export interface PasskeyChallenge { challenge: Uint8Array; account: string; user_handle: Uint8Array }
/** The challenge of this room's account, with what a new kit of it is salted with (a recovery asks for it for that). */
export interface AccountPasskeyChallenge extends PasskeyChallenge { email: string | null; kit_form: KitForm }

export interface PushRegistration {
  web_push?: { endpoint: string; keys: { p256dh: Uint8Array; auth: Uint8Array } }
  apns?: { token: string; key: Uint8Array; environment: string; topic: string }
  level: 'all' | 'knocking'
}

export interface Transfer {
  /** Bytes moved so far and in all; called as they move where the platform streams, else once at the end. */
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}
export interface OutboxAnswer {
  /** The room's change number the hub gave the write; null for a kind that takes none. */
  change: number | null
  epoch?: number; n?: number | null; room_id?: Uint8Array; group_id?: Uint8Array; unused?: number
  /** Of a recovery: a part was kept; the finish published, from which change, and the device that joined. */
  kept?: boolean; published?: boolean; first_change?: number; device?: Uint8Array
}
/** What `postOutbox` needs beside the entry. */
export interface OutboxOptions {
  /** `recoveryCode`, `recoveryFinish`: the account's new copies in place of the bytes the entry carries (null: a
   *  room without an account). Left out: what the entry carries (`accountCopiesBytes`). */
  account?: AccountCopies | null
  /** `recoveryCommit`, `recoveryFinish`: the recovery they belong to, as `openRecovery` answered. Whoever runs the
   *  recovery opens it (under the recovery key's token) and keeps its id until the finish was answered. */
  recovery_id?: Uint8Array
}
/** The device's `hubSignIn` for one room: `HubAuth` and its signature over the hub's challenge (12.3). */
export type Signer = (hub: string, challenge: Uint8Array) => Promise<SignedHubAuth>

export interface RequestOptions {
  body?: unknown
  /** False: without the token (the routes of hub-api.md's first block). Default true. */
  auth?: boolean
  headers?: Record<string, string>
  /** True: the answer's bytes as a Uint8Array instead of parsed JSON. A `body` that is a Uint8Array is sent as bytes. */
  raw?: boolean
  query?: Record<string, string | number | null | undefined>
  signal?: AbortSignal
}

// ---------------------------------------------------------------------------------------------------------------------
// Checks. `bad` is for what the hub answered, `wrong` for what this module was called with.

function bad(what: string, status = 200): never {
  throw new HubError('bad-answer', `the hub's answer is not what the protocol says: ${what}`, { status })
}
function wrong(what: string): never {
  throw Object.assign(new Error(what), { code: 'bad-argument' })
}
function obj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) bad(what)
  return v as Record<string, unknown>
}
function list(v: unknown, what: string, max: number): unknown[] {
  if (!Array.isArray(v) || v.length > max) bad(what)
  return v
}
function int(v: unknown, what: string, min = 0): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) bad(what)
  return v
}
function bool(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') bad(what)
  return v
}
function text(v: unknown, what: string, max: number): string {
  if (typeof v !== 'string' || v.length > max) bad(what)
  return v
}
function oneOf<T extends string>(v: unknown, what: string, ...allowed: T[]): T {
  if (typeof v !== 'string' || !allowed.includes(v as T)) bad(what)
  return v as T
}
/** A byte string in its one base64url spelling, of `min` to `max` bytes (`max` left out: exactly `min`). */
function bytes(v: unknown, what: string, min: number, max = min): Uint8Array {
  let out: Uint8Array
  try { out = unb64u(v as string) } catch { bad(what) }
  if (out.length < min || out.length > max) bad(what)
  return out
}
/** An id: a byte string of one of the lengths. */
function id(v: unknown, what: string, ...lengths: number[]): Uint8Array {
  let out: Uint8Array
  try { out = unb64u(v as string) } catch { bad(what) }
  if (!lengths.includes(out.length)) bad(what)
  return out
}
const maybe = <T>(v: unknown, read: (v: unknown) => T): T | null => v === null || v === undefined ? null : read(v)
/** An id of the caller's as it goes into a path or a body: bytes of one of the lengths, written in base64url, so
 *  nothing but [A-Za-z0-9_-] of a fixed length. */
function own(v: unknown, what: string, ...lengths: number[]): string {
  if (!(v instanceof Uint8Array) || !lengths.includes(v.length)) wrong(`${what}: an id of ${lengths.join(' or ')} bytes`)
  return b64u(v)
}
const same = (bytes: Uint8Array, text: string): boolean => b64u(bytes) === text
function ownInt(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) wrong(`${what}: a whole number`)
  return v
}
const GROUP = [32, 48] as const

function envelopeItem(v: unknown): EnvelopeItem {
  const o = obj(v, 'an envelope item')
  return {
    change: int(o.change, 'change', 1), envelope: bytes(o.envelope, 'envelope', 1, MAX_ENVELOPE),
    received_at: int(o.received_at, 'received_at'),
    void_code: maybe(o.void_code, c => typeof c === 'string' && CODE.test(c) ? c : bad('void_code')), cut: o.cut === true,
  }
}
function logItem(o: Record<string, unknown>): LogItem {
  const base = {
    change: int(o.change, 'change', 1), group: id(o.group_id, 'group_id', ...GROUP), n: int(o.n, 'n', 1), epoch: int(o.epoch, 'epoch'),
    at: int(o.at, 'at'), bytes: bytes(o.bytes, 'bytes', 1, MAX_MLS), sender: id(o.sender, 'sender', 32),
  }
  if (o.kind === 'commit') return { ...base, kind: 'commit', recovery_auth: maybe(o.recovery_auth, a => bytes(a, 'recovery_auth', 1, MAX_SMALL_STRUCT)) }
  if (o.kind === 'message') return { ...base, kind: 'message' }
  return bad('the kind of a log entry')
}
function changeItem(v: unknown): ChangeItem {
  const o = obj(v, 'a change')
  if (o.kind !== 'envelope') return logItem(o)
  const e = envelopeItem(o)
  return { change: e.change, kind: 'envelope', envelope: e.envelope, received_at: e.received_at, void_code: e.void_code }
}
/** A page of envelopes whose change numbers run strictly one way from `from`. */
function envelopePage(v: unknown, limit: number, from: number, direction: 1 | -1): { items: EnvelopeItem[]; more: boolean } {
  const o = obj(v, 'a page')
  let at = from
  const items = list(o.items, 'items', limit).map(x => {
    const item = envelopeItem(x)
    if (direction * (item.change - at) <= 0) bad('envelopes out of order')
    at = item.change
    return item
  })
  return { items, more: bool(o.more, 'more') }
}
function groupRow(v: unknown): GroupRow {
  const o = obj(v, 'a group')
  return {
    group: id(o.group_id, 'group_id', ...GROUP), kind: oneOf(o.kind, 'kind', 'room', 'main', 'helper'),
    session_id: maybe(o.session_id, s => id(s, 'session_id', 16)), parent: maybe(o.parent, s => id(s, 'parent', 16)),
    epoch: int(o.epoch, 'epoch'), room_epoch: int(o.room_epoch, 'room_epoch'), live: bool(o.live, 'live'), stale: bool(o.stale, 'stale'),
    leaves: list(o.leaves, 'leaves', 4096).map(d => id(d, 'a leaf', 32)),
  }
}
function requestRow(v: unknown): RequestRow {
  const o = obj(v, 'a request')
  return {
    id: int(o.id, 'id'), device: id(o.device, 'device', 32), kind: oneOf(o.kind, 'kind', 'readmit', 'handover', 'session', 'reject'),
    group: maybe(o.group_id, g => id(g, 'group_id', ...GROUP)), key_package: maybe(o.key_package, k => bytes(k, 'key_package', 1, MAX_KEY_PACKAGE)),
    n: maybe(o.n, n => int(n, 'n')), at: int(o.at, 'at'), committer: maybe(o.committer, c => id(c, 'committer', 32)),
  }
}
function kdf(v: unknown): Kdf | null {
  return maybe(v, k => {
    const entries = Object.entries(obj(k, 'kdf'))
    if (entries.length > 8 || entries.some(([, x]) => typeof x !== 'string' && typeof x !== 'number')) bad('kdf')
    return Object.fromEntries(entries) as Kdf
  })
}
/** An account id in its one printed form, which must be the text of these 16 bytes when they are given. */
function accountId(v: unknown, handle?: Uint8Array): string {
  const t = text(v, 'account', 36)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(t)) bad('account')
  if (handle && hex(handle) !== t.replaceAll('-', '')) bad('account: not the id of user_handle')
  return t
}
function passkeyChallengeAnswer(v: unknown): PasskeyChallenge {
  const o = obj(v, 'a challenge answer'), user_handle = bytes(o.user_handle, 'user_handle', 16)
  return { challenge: bytes(o.challenge, 'challenge', 32), account: accountId(o.account, user_handle), user_handle }
}
function loginAnswer(v: unknown): LoginAnswer {
  const o = obj(v, 'a login answer')
  return {
    account: accountId(o.account), email: maybe(o.email, e => text(e, 'email', 254)),
    rooms: list(o.rooms, 'rooms', 16).map(r => {
      const room = obj(r, 'a room')
      return { room_id: id(room.room_id, 'room_id', 32), sealed_copy: bytes(room.sealed_copy, 'sealed_copy', 61), challenge: bytes(room.challenge, 'challenge', 32) }
    }),
    kdf: kdf(o.kdf),
  }
}
function accountView(v: unknown): AccountView {
  const o = obj(v, 'an account'), user_handle = bytes(o.user_handle, 'user_handle', 16)
  return {
    email: maybe(o.email, e => text(e, 'email', 254)), account: accountId(o.account, user_handle), kit_form: oneOf(o.kit_form, 'kit_form', 'email', 'id'), revision: int(o.revision, 'revision'), has_password: bool(o.has_password, 'has_password'), kdf: kdf(o.kdf),
    password_copy: maybe(o.password_copy, c => bytes(c, 'password_copy', 61)), kit_copy: bytes(o.kit_copy, 'kit_copy', 61),
    user_handle,
    passkeys: list(o.passkeys, 'passkeys', 64).map(p => {
      const k = obj(p, 'a passkey')
      return {
        credential_id: bytes(k.credential_id, 'credential_id', 1, 1023), sealed_copy: bytes(k.sealed_copy, 'sealed_copy', 61),
        transports: maybe(k.transports, t => list(t, 'transports', 8).map(x => text(x, 'a transport', 16))) ?? [],
        created_at: int(k.created_at, 'created_at'), last_used_at: maybe(k.last_used_at, t => int(t, 'last_used_at')),
      }
    }),
    rooms: list(o.rooms, 'rooms', 16).map(r => id(r, 'a room', 32)),
  }
}
function streamEvent(name: string, v: unknown): StreamEvent | null {
  const o = obj(v, `the data of a ${name} event`)
  switch (name) {
    case 'relay':
      return { event: 'relay', group: id(o.group_id, 'group_id', ...GROUP), epoch: int(o.epoch, 'epoch'), sender: id(o.sender, 'sender', 32), message: bytes(o.message, 'message', 1, MAX_MLS) }
    case 'welcome': return { event: 'welcome', group: id(o.group_id, 'group_id', ...GROUP) }
    case 'file_evicted': return { event: 'file_evicted', file_id: id(o.file_id, 'file_id', 16) }
    case 'request':
      if (o.kind === 'invite') return { event: 'invite_request', invite_id: id(o.invite_id, 'invite_id', 16) }
      return {
        event: 'request', kind: oneOf(o.kind, 'kind', 'readmit', 'handover', 'session', 'reject'), id: int(o.id, 'id'), device: id(o.device, 'device', 32),
        group: maybe(o.group_id, g => id(g, 'group_id', ...GROUP)), n: maybe(o.n, n => int(n, 'n')), committer: maybe(o.committer, c => id(c, 'committer', 32)),
      }
    case 'presence':
      if (o.archived === true) return { event: 'archived', group: id(o.group_id, 'group_id', ...GROUP) }
      return {
        event: 'presence', device: id(o.device, 'device', 32), online: bool(o.online, 'online'), lost: o.lost === true,
        hears: maybe(o.hears, h => bool(h, 'hears')), working: maybe(o.working, w => bool(w, 'working')), last_call_at: maybe(o.last_call_at, t => int(t, 'last_call_at')),
      }
    default: return null     // an event of a later hub: not this client's
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Bodies this module builds

const enc = (b: Uint8Array): string => b64u(b)
function commitBody(c: CommitParts): Record<string, unknown> {
  return {
    epoch: ownInt(c.epoch, 'epoch'), commit: enc(c.commit), group_info: enc(c.group_info), sealed_key: enc(c.sealed_key),
    ...(c.welcome?.length ? { welcome: enc(c.welcome) } : {}), ...(c.recovery_auth?.length ? { recovery_auth: enc(c.recovery_auth) } : {}),
  }
}
/** The one field that names an account, as typed: the hub reads an e-mail (with `@`) or an id out of it. */
function ownName(name: unknown): string {
  if (typeof name !== 'string' || name.length < 1 || name.length > 254) wrong('an account is named by its e-mail or its id')
  return name
}
function passkeyBody(p: PasskeyRegistration): Record<string, unknown> {
  return { attestation_object: enc(p.attestation_object), client_data_json: enc(p.client_data_json), sealed_copy: enc(p.sealed_copy), ...(p.transports ? { transports: p.transports } : {}) }
}
const kitBody = (k: KitPart): Record<string, unknown> => ({ auth_key: enc(k.auth_key), sealed_copy: enc(k.sealed_copy) })
function accountBody(a: NewAccount): Record<string, unknown> {
  return {
    ...(a.email != null ? { email: a.email } : {}),
    kit: kitBody(a.kit),
    ...(a.password ? { password: { auth_key: enc(a.password.auth_key), sealed_copy: enc(a.password.sealed_copy), kdf: a.password.kdf } } : {}),
    ...(a.passkey ? { passkey: passkeyBody(a.passkey) } : {}),
  }
}
function copiesBody(a: AccountCopies | null): Record<string, unknown> | null {
  if (!a) return null
  return {
    kit: kitBody(a.kit),
    ...(a.password ? { password: 'auth_key' in a.password ? { auth_key: enc(a.password.auth_key), sealed_copy: enc(a.password.sealed_copy), kdf: a.password.kdf } : { sealed_copy: enc(a.password.sealed_copy) } } : {}),
    ...(a.passkey ? { passkey: 'attestation_object' in a.passkey ? passkeyBody(a.passkey) : { credential_id: enc(a.passkey.credential_id), sealed_copy: enc(a.passkey.sealed_copy) } } : {}),
  }
}

/**
 * The account's new sealed copies as the bytes the core keeps with a `recoveryCode` or `recoveryFinish` outbox entry
 * (its `replaceCode` and `recover` take them as `account`): the JSON of the hub's body, UTF-8. A room without an
 * account: no bytes. `postOutbox` reads them back into the request.
 */
export function accountCopiesBytes(copies: AccountCopies | null): Uint8Array {
  return copies ? new TextEncoder().encode(JSON.stringify(copiesBody(copies))) : new Uint8Array(0)
}
/** The reverse, strict: exactly the members `accountCopiesBytes` writes, each a byte string of the hub's length. */
function accountCopiesOf(account: Uint8Array): AccountCopies | null {
  if (account.length === 0) return null
  const part = (v: unknown, name: string, min: number, max = min): Uint8Array => {
    let out: Uint8Array | null = null
    try { out = unb64u(v as string) } catch { /* refused below */ }
    if (!out || out.length < min || out.length > max) wrong(`the account's copies: ${name}`)
    return out
  }
  const members = (v: unknown, ...names: string[]): Record<string, unknown> => {
    if (typeof v !== 'object' || v === null || Array.isArray(v) || Object.keys(v).some(k => !names.includes(k))) wrong('the account\'s copies: not what accountCopiesBytes writes')
    return v as Record<string, unknown>
  }
  let parsed: unknown
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(account)) } catch { wrong('the account\'s copies: not what accountCopiesBytes writes') }
  const o = members(parsed, 'kit', 'password', 'passkey'), kit = members(o.kit, 'auth_key', 'sealed_copy')
  const copies: AccountCopies = { kit: { auth_key: part(kit.auth_key, 'kit.auth_key', 32), sealed_copy: part(kit.sealed_copy, 'kit.sealed_copy', 61) } }
  const has = (v: unknown, name: string): boolean => typeof v === 'object' && v !== null && Object.hasOwn(v, name)
  if (o.password !== undefined && o.passkey !== undefined) wrong('the account\'s copies: one way in')
  if (has(o.password, 'auth_key')) {
    const w = members(o.password, 'auth_key', 'sealed_copy', 'kdf'), k = Object.entries(members(w.kdf, 'alg', 'v', 'm', 't', 'p'))
    if (k.some(([, x]) => typeof x !== 'string' && typeof x !== 'number')) wrong('the account\'s copies: password.kdf')
    copies.password = { auth_key: part(w.auth_key, 'password.auth_key', 32), sealed_copy: part(w.sealed_copy, 'password.sealed_copy', 61), kdf: Object.fromEntries(k) as Kdf }
  } else if (o.password !== undefined) copies.password = { sealed_copy: part(members(o.password, 'sealed_copy').sealed_copy, 'password.sealed_copy', 61) }
  if (has(o.passkey, 'attestation_object')) {
    const k = members(o.passkey, 'attestation_object', 'client_data_json', 'sealed_copy', 'transports')
    const transports = k.transports
    if (transports !== undefined && !(Array.isArray(transports) && transports.length <= 8 && transports.every(x => typeof x === 'string' && /^[a-z-]{1,16}$/.test(x)))) wrong('the account\'s copies: passkey.transports')
    copies.passkey = {
      attestation_object: part(k.attestation_object, 'passkey.attestation_object', 1, 8192), client_data_json: part(k.client_data_json, 'passkey.client_data_json', 1, 4096),
      sealed_copy: part(k.sealed_copy, 'passkey.sealed_copy', 61), ...(transports !== undefined ? { transports: transports as string[] } : {}),
    }
  } else if (o.passkey !== undefined) {
    const k = members(o.passkey, 'credential_id', 'sealed_copy')
    copies.passkey = { credential_id: part(k.credential_id, 'passkey.credential_id', 1, 1023), sealed_copy: part(k.sealed_copy, 'passkey.sealed_copy', 61) }
  }
  return copies
}

/**
 * The canonical hub address: `https://` + lowercase host [+ `:port`], nothing after it. Plain http only for a hub on
 * this machine or a private network (development). The device signs this very text when it signs in (12.3).
 */
export function hubAddress(url: string): string {
  let u: URL
  try { u = new URL(String(url).trim()) } catch { wrong('not a hub address') }
  const host = u.hostname.toLowerCase()
  const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(host) || /\.(local|ts\.net)$/.test(host)
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) wrong('a hub address is https:// (plain http only for a local hub)')
  if (u.username || u.password || u.search || u.hash || u.pathname.replace(/\/+$/, '') !== '') wrong('a hub address has no path, query or credentials')
  return `${u.protocol}//${u.host.toLowerCase()}`
}

/** Whether fetch takes a stream as a request body here (Node; Chromium over HTTP/2). */
function requestStreams(): boolean {
  try {
    let asked = false
    const init = { method: 'POST', body: new ReadableStream(), get duplex() { asked = true; return 'half' } }
    const typed = new Request('https://hub.invalid', init as RequestInit).headers.has('content-type')
    return asked && !typed
  } catch { return false }
}

function sleep(ms: number, wakers?: Set<() => void>): Promise<void> {
  return new Promise(resolve => {
    const done = (): void => { clearTimeout(timer); wakers?.delete(done); resolve() }
    const timer = setTimeout(done, ms)
    ;(timer as { unref?: () => void }).unref?.()
    wakers?.add(done)
  })
}

/** The deadline of one request: aborts the fetch after `ms`. With `idle_ms` (a file) it also aborts when nothing
 *  moved for that long, so that a large transfer gets its time and a stalled one does not. The caller's own signal
 *  aborts it too. */
class Watch {
  readonly signal: AbortSignal
  private readonly own = new AbortController()
  private readonly timer: ReturnType<typeof setTimeout>
  private idle: ReturnType<typeof setTimeout> | undefined
  private readonly idle_ms: number | undefined
  private readonly outer: AbortSignal | undefined
  constructor(ms: number, outer?: AbortSignal, idle_ms?: number) {
    this.outer = outer
    this.idle_ms = idle_ms
    this.signal = outer ? AbortSignal.any([outer, this.own.signal]) : this.own.signal
    this.timer = this.after(ms)
    this.kick()
  }
  private after(ms: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => this.own.abort(), ms)
    ;(timer as { unref?: () => void }).unref?.()
    return timer
  }
  /** Something moved. */
  kick(): void {
    if (this.idle_ms === undefined) return
    clearTimeout(this.idle)
    this.idle = this.after(this.idle_ms)
  }
  /** The request is over, however it ended: its timers stop, and what may still be open of it is cut. */
  done(): void { clearTimeout(this.timer); clearTimeout(this.idle); this.own.abort() }
  /** What a failed fetch or read means: the caller's abort is the caller's; anything else is "not reached". */
  failure(what: string): unknown {
    if (this.outer?.aborted) return this.outer.reason ?? new DOMException('aborted', 'AbortError')
    return new HubError('offline', this.own.signal.aborted ? 'the hub did not answer in time' : what)
  }
  /** What `work` gives, or this request's end if that comes first (the work itself goes on for whoever else waits
   *  for it). A request that is over already starts none. */
  within<T>(work: () => Promise<T>): Promise<T> {
    if (this.signal.aborted) return Promise.reject(this.failure('the hub was not reached'))
    return new Promise<T>((resolve, reject) => {
      const over = (): void => reject(this.failure('the hub was not reached'))
      this.signal.addEventListener('abort', over, { once: true })
      work().then(resolve, reject).finally(() => this.signal.removeEventListener('abort', over))
    })
  }
}

interface Send {
  query?: Record<string, string | number | null | undefined> | undefined
  json?: unknown
  /** A binary body, made anew for each attempt (a stream is read once). */
  body?: (() => Uint8Array | Blob | ReadableStream<Uint8Array>) | undefined
  length?: number
  auth?: boolean
  headers?: Record<string, string> | undefined
  signal?: AbortSignal | undefined
  timeout_ms?: number
  /** Never sent a second time by itself, whatever its route (a relayed message). */
  once?: boolean
}

/** Every stream of this context that is open: `closeAllStreams` ends them (the page goes: a reload, a tab closed). */
const OPEN_STREAMS = new Set<() => void>()
/** Ends every live stream of this context at once, its connection aborted. A browser may keep a stream's connection
 *  open past the page that opened it (Firefox under a service worker did, one more per reload, until the six
 *  connections to the host were taken): the page says when it goes, and nothing is left behind. */
export function closeAllStreams(): void { for (const close of [...OPEN_STREAMS]) close() }

export class Hub {
  hub_url: string
  /** `<kind>/<major>.<minor>.<patch>`, sent as `Trommi-Client` on every request (`client-too-old`). */
  client_name: string | null
  /** What the hub called the signed-in key: 'human', 'agent', 'helper', 'recovery', or 'removed' (a key taken out of
   *  the room within thirty days: its token reads `removal` alone, hub-api.md 42). */
  role: string | null = null
  /** Told the role of every sign-in, as it comes (the engine checks a `removed` one itself). */
  onRole: ((role: string) => void) | null = null
  /** Times in milliseconds; a test shortens them. `get_retry`: the waits before a GET is tried again after "not
   *  reached" or 502 to 504. `backoff_*`: between tries of the stream, doubling, with jitter. `stale`: a stream
   *  silent for so long is dead (the hub pings every 25 s). `stream_stood`: a stream open for so long worked. `renew_before`: a token is renewed so long before its end. */
  timing = { request: 30_000, transfer_idle: 30_000, get_retry: [300, 1000], backoff_first: 500, backoff_max: 30_000, stale: 70_000, stream_stood: 5000, renew_before: 60_000 }
  private readonly fetch: typeof fetch
  private signer: { room_id: Uint8Array; room: string; sign: Signer } | null = null
  private token: string | null = null
  private renew_at = 0
  private signing: { signer: object; done: Promise<void> } | null = null
  private down = false
  private readonly wakers = new Set<() => void>()
  private streams_uploads = requestStreams()

  constructor(opts: { hub_url: string; client_name?: string | null; fetch?: typeof fetch }) {
    this.hub_url = hubAddress(opts.hub_url)
    this.client_name = opts.client_name ?? null
    this.fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init))
  }

  // ---- signing in (v2.md 12.3)

  /** Token by signed challenge (12.3); kept and renewed before it runs out, and once after a 401. A Hub signs in to
   *  one room: called again it takes a new signer for the same room (the device was opened anew), never another room. */
  useSigner(room_id: Uint8Array, sign: Signer): void {
    const room = own(room_id, 'room_id', 32)
    if (this.signer && this.signer.room !== room) wrong('this hub client is signed in to another room: make a new one')
    this.signer = { room_id, room, sign }
    this.token = null
    this.role = null
  }
  get room_id(): Uint8Array | null { return this.signer?.room_id ?? null }
  /** `DELETE /v2/token`: ends the token this client holds, at once, and the hub cuts this device's streams. A
   *  client without a token asks nothing (it does not sign in to sign out). The token is forgotten here whatever
   *  the hub answers; it would have run out within ten minutes. A later call signs in anew. */
  async signOut(): Promise<void> {
    const token = this.token
    if (!token) return
    this.token = null
    this.role = null
    const watch = new Watch(this.timing.request)
    try {
      const res = await this.fetch(`${this.hub_url}/v2/token`, { method: 'DELETE', headers: { authorization: `Bearer ${token}`, ...(this.client_name ? { 'trommi-client': this.client_name } : {}) }, redirect: 'manual', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: watch.signal })
      void res.body?.cancel().catch(() => {})
      if (!res.ok) throw new HubError(res.status === 401 ? 'unauthorised' : `http-${res.status}`, 'the hub did not end the token', { status: res.status })
    } catch (e) {
      throw e instanceof HubError ? e : new HubError('offline', 'the hub was not reached')
    } finally { watch.done() }
  }

  /** Signs in now. `challenge`: one the hub handed out already (a login answers with one per room), saving a round
   *  trip; if the hub no longer holds it, a new one is asked for. Concurrent callers share one sign-in. */
  signIn(challenge?: Uint8Array): Promise<void> {
    const signer = this.signer
    if (!signer) return Promise.reject(Object.assign(new Error('this hub client has no signer: useSigner first'), { code: 'bad-argument' }))
    // a sign-in under a signer that was replaced meanwhile is not this one's, whether it succeeds or fails
    if (this.signing?.signer !== signer) {
      const running = { signer, done: this.takeToken(signer, challenge).finally(() => { if (this.signing === running) this.signing = null }) }
      this.signing = running
    }
    return this.signing.done
  }
  private async takeToken(signer: { room_id: Uint8Array; room: string; sign: Signer }, given?: Uint8Array): Promise<void> {
    let challenge = given ?? await this.challenge(signer.room_id)
    let answer: Record<string, unknown>
    // a challenge lives two minutes and is one of ten thousand the hub holds: one that is gone is replaced, once
    for (let second = false; ; second = true) {
      const { auth, signature } = await signer.sign(this.hub_url, challenge)
      try {
        answer = obj(await this.call('POST', `/v2/rooms/${signer.room}/tokens`, { json: { auth: enc(auth), signature: enc(signature) } }), 'a token answer')
        break
      } catch (e) {
        if (second || !(e instanceof HubError) || e.code !== 'bad-challenge') throw e
        challenge = await this.challenge(signer.room_id)
      }
    }
    const token = text(answer.token, 'token', 200)
    if (!TOKEN.test(token)) bad('token')
    const expires_at = int(answer.expires_at, 'expires_at')
    const role = oneOf(answer.role, 'role', 'human', 'agent', 'helper', 'recovery', 'removed')
    if (this.signer !== signer) return
    // The hub's clock is not this one's: the token is taken to live at least two renewal spans and at most the ten
    // minutes of 12.3.1. One that ended earlier is found out by its 401.
    const now = Date.now()
    const life = Math.min(TOKEN_MS, Math.max(2 * this.timing.renew_before, expires_at - now))
    this.token = token
    this.renew_at = now + life - this.timing.renew_before
    this.role = role
    try { this.onRole?.(role) } catch {}
  }
  /** Forgets the token this client holds, without asking the hub: the next request signs in anew (and so learns the
   *  key's role as the hub has it now). */
  forgetToken(): void { this.token = null; this.role = null }
  private async bearer(): Promise<string> {
    // twice at most: a sign-in that ended under a signer replaced meanwhile leaves no token
    for (let i = 0; i < 2 && (!this.token || Date.now() >= this.renew_at); i++) await this.signIn()
    return this.token ?? wrong('the signer was replaced while signing in')
  }

  // ---- one request

  private offline(what: string): HubError {
    this.down = true
    return new HubError('offline', what)
  }
  /** Wakes every stream that waits to reconnect (the browser went online; a request got through again). */
  wake(): void { for (const w of [...this.wakers]) w() }

  /** The hub's `{ error, message }` as a HubError. Anything else under an error status (a proxy's page, a code this
   *  protocol does not have, a code under another status than its own) is `http-<status>`: not the hub's refusal. */
  private async refusal(res: Response, watch?: Watch): Promise<HubError> {
    let body: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(await this.read(res, CAP_REFUSAL, watch)))
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
    } catch { /* no refusal body: named by its status below */ }
    // (seconds: the `retry-after` header, else the refusal's own `retry_after`)
    const named = res.headers.get('retry-after')
    const after = named !== null ? Number(named) : typeof body['retry_after'] === 'number' ? body['retry_after'] : NaN
    const retry_after = Number.isInteger(after) && after > 0 && after <= 86_400 ? after : null
    const { error, message, voided, ...details } = body
    if (typeof error !== 'string' || typeof message !== 'string' || !Object.hasOwn(STATUS_OF, error) || STATUS_OF[error] !== res.status) {
      return new HubError(`http-${res.status}`, 'the hub answered with an error that is no refusal of this protocol', { status: res.status, retry_after })
    }
    return new HubError(error, `the hub refused: ${error}`, { status: res.status, voided: voided === true, retry_after, details, hub_message: message.slice(0, 300) })
  }

  /** The whole body, at most `cap` bytes. A body that breaks off is "not reached"; one that is too long is refused. */
  private async read(res: Response, cap: number, watch?: Watch, onChunk?: (total: number) => void): Promise<Uint8Array> {
    const declared = Number(res.headers.get('content-length') ?? '0')
    const reader = res.body?.getReader()
    if (!reader) return new Uint8Array(0)
    if (declared > cap) { void reader.cancel().catch(() => {}); bad('an answer larger than the protocol allows', res.status) }
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      let step: ReadableStreamReadResult<Uint8Array>
      try { step = await reader.read() } catch { throw watch ? watch.failure('the answer broke off') : this.offline('the answer broke off') }
      if (step.done) break
      total += step.value.length
      if (total > cap) { void reader.cancel().catch(() => {}); bad('an answer larger than the protocol allows', res.status) }
      chunks.push(step.value)
      watch?.kick()
      onChunk?.(total)
    }
    const out = new Uint8Array(total)
    let at = 0
    for (const c of chunks) { out.set(c, at); at += c.length }
    return out
  }

  /** Sends one request and returns its 2xx answer, unread. Signs in again once when the token is refused. */
  private async exchange(method: string, path: string, o: Send, watch: Watch, retried = false, resent = false): Promise<Response> {
    const headers: Record<string, string> = { ...o.headers }
    if (this.client_name) headers['trommi-client'] = this.client_name
    let token: string | null = null
    if (o.auth) { token = await watch.within(() => this.bearer()); headers['authorization'] = `Bearer ${token}` }
    let body: BodyInit | undefined
    if (o.json !== undefined) { body = JSON.stringify(o.json); headers['content-type'] = 'application/json' }
    else if (o.body) {
      body = o.body() as BodyInit
      headers['content-type'] = 'application/octet-stream'
      // a browser sets the length itself and drops this header; Node sends a stream chunked without it, and the hub
      // then reserves a whole file's room for the upload
      if (o.length !== undefined) headers['content-length'] = String(o.length)
    }
    let url = this.hub_url + path
    const query = Object.entries(o.query ?? {}).filter(([, v]) => v !== null && v !== undefined)
    if (query.length) url += '?' + query.map(([k, v]) => `${k}=${v}`).join('&')
    const init: RequestInit & { duplex?: 'half' } = { method, headers, redirect: 'manual', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: watch.signal }
    if (body !== undefined) init.body = body
    if (body instanceof ReadableStream) init.duplex = 'half'
    let res: Response
    try { res = await this.fetch(url, init) } catch {
      const failure = watch.failure('the hub was not reached')
      // no answer at all, and time left: once more at once, on a connection of its own, where that is safe
      if (failure instanceof HubError && !watch.signal.aborted && !resent && !o.once && REPEATABLE.some(r => r.test(`${method} ${path}`))) return this.exchange(method, path, o, watch, retried, true)
      if (failure instanceof HubError) this.down = true
      throw failure
    }
    // a redirect is never followed: the token and the body would go where it points
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      void res.body?.cancel().catch(() => {})
      bad('a redirect', res.status || 302)
    }
    if (res.status >= 500) this.down = true
    else if (this.down) { this.down = false; this.wake() }
    if (res.ok) return res
    const refusal = await this.refusal(res, watch)
    if (refusal.code === 'unauthorised' && o.auth && !retried && this.signer) {
      // the hub forgot the token (it restarted) or ended it early: sign in again, once
      if (this.token === token) this.token = null
      return this.exchange(method, path, o, watch, true, resent)
    }
    throw refusal
  }

  private async callOnce(method: string, path: string, o: Send, cap: number): Promise<unknown> {
    const watch = new Watch(o.timeout_ms ?? this.timing.request, o.signal)
    try {
      const res = await this.exchange(method, path, o, watch)
      const raw = await this.read(res, cap, watch)
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as unknown } catch { return bad('not JSON', res.status) }
    } finally { watch.done() }
  }
  /** A JSON route. A GET that was not reached, or met 502 to 504, is tried again after a short wait (it changes
   *  nothing); a write is sent once here: its caller knows that the same bytes may go again. */
  private async call(method: string, path: string, o: Send = {}, cap = CAP_SMALL): Promise<unknown> {
    const waits = method === 'GET' ? this.timing.get_retry : []
    for (let attempt = 0; ; attempt++) {
      try { return await this.callOnce(method, path, o, cap) } catch (e) {
        const wait = waits[attempt]
        if (wait === undefined || !(e instanceof HubError) || !(e.status === 0 || (e.status >= 502 && e.status <= 504))) throw e
        await sleep(Math.min(5000, e.retry_after !== null ? e.retry_after * 1000 : wait) + Math.random() * 200)
        if (o.signal?.aborted) throw o.signal.reason ?? new DOMException('aborted', 'AbortError')
      }
    }
  }
  private get(path: string, query?: Send['query'], cap = CAP_SMALL, auth = true): Promise<unknown> { return this.call('GET', path, { query, auth }, cap) }
  private send(method: string, path: string, json: unknown, auth = true, headers?: Record<string, string>): Promise<unknown> { return this.call(method, path, { json, auth, headers }) }

  /** Any route by its path: the way out for a route this class has no method for. The path is `/v2/…` of plain
   *  segments, parameters go in `query`; the answer is the hub's JSON, unchecked beyond its size. */
  async request(method: string, path: string, opts: RequestOptions = {}): Promise<any> {
    if (!PATH.test(path)) wrong('a path is /v2/ and plain segments')
    for (const [k, v] of Object.entries(opts.query ?? {})) if (!/^[a-z_]{1,32}$/.test(k) || (v !== null && v !== undefined && !QUERY_VALUE.test(String(v)))) wrong(`query ${k}`)
    const o: Send = { query: opts.query, auth: opts.auth ?? true, headers: opts.headers, signal: opts.signal }
    if (opts.body instanceof Uint8Array) { const b = opts.body; o.body = () => b; o.length = b.length } else if (opts.body !== undefined) o.json = opts.body
    if (!opts.raw) return this.call(method, path, o, CAP_LIST)
    const watch = new Watch(this.timing.request, opts.signal)
    try { return await this.read(await this.exchange(method, path, o, watch), CAP_FILE, watch) } finally { watch.done() }
  }

  // ---- the outbox

  /**
   * One outbox entry to its route (hub-api.md), by kind; `parts` in the order core/swift/src/records.rs `OutboxKind`
   * (and core/src/store.rs) names.
   * Resolves with the hub's answer; a refusal throws HubError. A repeated post of the same bytes gets the first
   * answer again, so an entry whose answer was lost is simply posted again. (`relayMessage` is the exception: the
   * hub passes it on each time, hub delivery.rs `message`; a stroke piece must be harmless when it arrives twice.)
   * The account's new copies travel in the entry (`recoveryCode`, `recoveryFinish`: its last part, written by
   * `accountCopiesBytes`) and are read back into the request here. A founding that makes the account in the same
   * transaction goes through `foundRoom`. The parts of a recovery (8.7) are posted under the recovery key's token,
   * with `opts.recovery_id`; a join with the code (`externalCommit`) under that token too, on the group's own route.
   */
  async postOutbox(entry: OutboxEntry, opts: OutboxOptions = {}): Promise<OutboxAnswer> {
    const p = entry.parts
    const part = (i: number): Uint8Array => p[i]?.length ? p[i] : wrong(`outbox ${entry.kind}: part ${i} is missing`)
    const count = (n: number): void => { if (p.length !== n) wrong(`outbox ${entry.kind}: ${n} parts, not ${p.length}`) }
    const group = (): Uint8Array => entry.group ?? wrong(`outbox ${entry.kind}: no group`)
    switch (entry.kind) {
      case 'roomFounding': {
        count(2)
        const found = await this.foundRoom({ group_info: part(0), sealed_key: part(1) })
        if (entry.group !== null && !same(found.room_id, b64u(entry.group))) bad('another room than the one founded')
        return { change: null, ...found }
      }
      case 'groupFounding': {
        count(6)
        const found = await this.foundGroup({ group_info_0: part(0), sealed_key_0: part(1), commit: part(2), group_info: part(3), welcome: p[4] ?? null, sealed_key: part(5) })
        if (entry.group !== null && !same(found.group_id, b64u(entry.group))) bad('another group than the one founded')
        return { change: null, ...found }
      }
      case 'commit': count(4); return this.postCommit(group(), { epoch: entry.epoch, commit: part(0), group_info: part(1), welcome: p[2] ?? null, sealed_key: part(3) })
      case 'externalCommit': count(4); return this.postCommit(group(), { epoch: entry.epoch, commit: part(0), group_info: part(1), sealed_key: part(2), recovery_auth: part(3) })
      case 'message': count(1); return { change: null, ...await this.postMessage(group(), entry.epoch, part(0), false) }
      case 'relayMessage': count(1); return { change: null, ...await this.postMessage(group(), entry.epoch, part(0), true) }
      case 'envelope': count(1); return this.postEnvelope(part(0))
      case 'keyPackages': {
        if (p.length < 1) wrong('outbox keyPackages: the last-resort part, then the single-use ones')
        return { change: null, ...await this.putKeyPackages({ last_resort: p[0]?.length ? p[0] : null, single_use: p.slice(1) }) }
      }
      case 'sealedKey': count(1); await this.putSealedKey(part(0)); return { change: null }
      case 'recoveryCode': {
        count(5)
        const account = opts.account !== undefined ? opts.account : accountCopiesOf(p[4] as Uint8Array)
        return this.postRecoveryCode(group(), { epoch: entry.epoch, commit: part(0), group_info: part(1), sealed_key: part(2) }, part(3), account)
      }
      case 'recoveryCommit': {
        count(5)
        const c = { epoch: entry.epoch, commit: part(0), group_info: part(1), welcome: p[2] ?? null, sealed_key: part(3), recovery_auth: p[4] ?? null }
        return { change: null, ...await this.recoveryCommit(opts.recovery_id ?? wrong('outbox recoveryCommit: the recovery it belongs to'), group(), c) }
      }
      case 'recoveryFinish': {
        count(2)
        const account = opts.account !== undefined ? opts.account : accountCopiesOf(p[1] as Uint8Array)
        return this.finishRecovery(opts.recovery_id ?? wrong('outbox recoveryFinish: the recovery it belongs to'), part(0), account)
      }
      default: {
        const unknown: never = entry.kind       // a kind the binding grew: this line stops compiling
        return wrong(`an outbox kind this client does not know: ${String(unknown)}`)
      }
    }
  }

  // ---- rooms, recovery (hub-api.md: no token for the founding; the recovery key's token for a recovery)

  /** `POST /v2/rooms`: founds the room; `account` is made in the same transaction. `found_token`: the hub's word,
   *  where it founds by invitation. */
  async foundRoom(f: { group_info: Uint8Array; sealed_key: Uint8Array; account?: NewAccount | null; found_token?: string | null }): Promise<{ room_id: Uint8Array }> {
    const json = { group_info: enc(f.group_info), sealed_key: enc(f.sealed_key), ...(f.account ? { account: accountBody(f.account) } : {}) }
    const o = obj(await this.send('POST', '/v2/rooms', json, false, f.found_token ? { 'x-found-token': f.found_token } : undefined), 'a founding answer')
    return { room_id: id(o.room_id, 'room_id', 32) }
  }
  /** `GET /v2/rooms/{room}/challenge`: 32 bytes, two minutes, one use. */
  async challenge(room_id: Uint8Array): Promise<Uint8Array> {
    const o = obj(await this.get(`/v2/rooms/${own(room_id, 'room_id', 32)}/challenge`, undefined, CAP_SMALL, false), 'a challenge answer')
    return bytes(o.challenge, 'challenge', 32)
  }
  private roomPath(rest: string): string {
    if (!this.signer) wrong('this hub client has no signer: useSigner first')
    return `/v2/rooms/${this.signer.room}${rest}`
  }
  /** `GET /v2/rooms/{room}/groups`: what the asker may see of the room's groups. */
  async roomGroups(): Promise<GroupRow[]> {
    // in pages of up to 1000 (and 8 MiB), the next from the answer's `after`; a hub that answers the bare list of
    // every group (before point 43) is read as one page
    const out: GroupRow[] = []
    let after: string | null = null
    for (let pages = 0; pages < 1000; pages++) {
      const v = await this.get(this.roomPath('/groups'), { limit: 1000, after: after ?? undefined }, CAP_DESK)
      if (Array.isArray(v)) return list(v, 'groups', 10_000).map(groupRow)
      const o = obj(v, 'a page of groups')
      out.push(...list(o.items, 'items', 1000).map(groupRow))
      const next = o.after === undefined || o.after === null ? null : String(o.after)
      if (!bool(o.more, 'more') || next === null || next === after) break
      after = next
    }
    return out
  }
  /** `POST /v2/rooms/{room}/recovery` (8.7): locks the room for ten minutes. */
  async openRecovery(): Promise<{ recovery_id: Uint8Array; expires_at: number }> {
    const o = obj(await this.send('POST', this.roomPath('/recovery'), {}), 'a recovery')
    return { recovery_id: id(o.recovery_id, 'recovery_id', 16), expires_at: int(o.expires_at, 'expires_at') }
  }
  /** `POST …/recovery/{id}/commits`: one part; nothing is published before `finishRecovery`. */
  async recoveryCommit(recovery_id: Uint8Array, group: Uint8Array, c: CommitParts): Promise<{ epoch: number; kept: boolean }> {
    const json = { group_id: own(group, 'group', ...GROUP), ...commitBody(c) }
    const o = obj(await this.send('POST', this.roomPath(`/recovery/${own(recovery_id, 'recovery_id', 16)}/commits`), json), 'a recovery part')
    return { epoch: int(o.epoch, 'epoch'), kept: bool(o.kept, 'kept') }
  }
  /** `POST …/recovery/{id}/finish`: publishes all parts or nothing; repeated, it gives the same answer. */
  async finishRecovery(recovery_id: Uint8Array, recovery_link: Uint8Array, account: AccountCopies | null): Promise<{ published: boolean; first_change: number; change: number; device: Uint8Array }> {
    const json = { recovery_link: enc(recovery_link), account: copiesBody(account) }
    const o = obj(await this.send('POST', this.roomPath(`/recovery/${own(recovery_id, 'recovery_id', 16)}/finish`), json), 'a finished recovery')
    return { published: bool(o.published, 'published'), first_change: int(o.first_change, 'first_change'), change: int(o.change, 'change'), device: id(o.device, 'device', 32) }
  }
  /** `DELETE …/recovery/{id}`: gives the room back without publishing. */
  async dropRecovery(recovery_id: Uint8Array): Promise<{ dropped: boolean }> {
    const o = obj(await this.send('DELETE', this.roomPath(`/recovery/${own(recovery_id, 'recovery_id', 16)}`), undefined), 'a dropped recovery')
    return { dropped: bool(o.dropped, 'dropped') }
  }
  /** `POST /v2/rooms/{room}/recovery-code` (8.6): the room Commit with new recovery keys, its RecoveryLink and the
   *  account's new copies, all or nothing. */
  async postRecoveryCode(room_id: Uint8Array, c: CommitParts, recovery_link: Uint8Array, account: AccountCopies | null): Promise<{ epoch: number; change: number }> {
    // the Commit goes nested under `commit`, as hub-api.md writes the route
    const json = { commit: commitBody(c), recovery_link: enc(recovery_link), account: copiesBody(account) }
    return this.committed(await this.send('POST', `/v2/rooms/${own(room_id, 'room_id', 32)}/recovery-code`, json), c.epoch)
  }

  /**
   * One group as a device verifies it from its founding (8.4): the founding GroupInfo, every Commit in the hub's
   * order, the GroupInfo the hub offers as current. Nothing in it is trusted, the core checks it; here only that the
   * Commits are the group's, one per epoch from 0 up to the current one.
   */
  async servedGroup(group: Uint8Array, budget = { bytes: CAP_SERVED }): Promise<ServedGroup> {
    const spend = (b: Uint8Array): Uint8Array => { if ((budget.bytes -= b.length) < 0) bad('a room larger than a device takes'); return b }
    // the current GroupInfo first: a Commit accepted while the log is read lies beyond it and is left out
    const current = await this.groupInfo(group)
    const founding = current.epoch === 0 ? current : await this.groupInfo(group, 0)
    const commits: ServedGroup['commits'] = []
    for (let after = 0, more = current.epoch > 0; more;) {
      const page = await this.groupLog(group, { after, limit: 1000, commits_only: true })
      for (const item of page.items) {
        if (item.kind !== 'commit' || item.epoch !== commits.length) bad('a log that is not one Commit per epoch')
        if (item.epoch < current.epoch) commits.push({ change: item.change, commit: spend(item.bytes), recoveryAuth: item.recovery_auth })
        after = item.n
      }
      more = page.more && commits.length < current.epoch
      if (page.more && page.items.length === 0) bad('more to come, and no step forward')
    }
    if (commits.length !== current.epoch) bad('a log that does not reach the current epoch')
    return { founding: spend(founding.group_info), commits, current: spend(current.group_info) }
  }
  /**
   * The room as a device that holds the recovery code needs it (8.4, 8.5, 8.7), under the recovery key's token
   * (`useSigner` with the core's `recoverySignIn`): the room group, every SealedKey and RecoveryLink, the GroupInfo
   * of the anchor's epoch, every live session group, main sessions before helper sessions. `anchorOf` is the core's
   * `recoveryAnchor(code, room, rows)`: it names the epoch whose GroupInfo is fetched. Nothing in the answer is
   * trusted (the core verifies all of it); here it is only checked for its shape and its size. `served` is the
   * binding's `ServedRoom`; `session_groups` names the group of each of `served.sessions`, in the same order.
   */
  async servedRoom(opts: { anchorOf: (rows: Uint8Array[]) => { group: Uint8Array; epoch: number } }): Promise<{ served: ServedRoom; session_groups: Uint8Array[] }> {
    if (!this.signer) wrong('this hub client has no signer: useSigner first')
    const room = this.signer.room_id, budget = { bytes: CAP_SERVED }
    const spend = (b: Uint8Array): Uint8Array => { if ((budget.bytes -= b.length) < 0) bad('a room larger than a device takes'); return b }
    const group = await this.servedGroup(room, budget)
    const rows: Uint8Array[] = [], links: Uint8Array[] = []
    for (let after = 0, more = true; more;) {
      const page = await this.sealedKeys(after, 2000)
      for (const r of page.rows) rows.push(spend(r.sealed_key))
      for (const l of page.links) links.push(spend(l.recovery_link))
      after = page.change
      more = page.more
    }
    const anchor = opts.anchorOf(rows)
    if (!same(anchor.group, this.signer.room)) wrong('the anchor is an epoch of the room group')
    const anchored = spend((await this.groupInfo(room, ownInt(anchor.epoch, 'the anchor\'s epoch'))).group_info)
    const live = (await this.roomGroups()).filter(g => g.live && g.kind !== 'room')
    const sessions: ServedGroup[] = [], session_groups: Uint8Array[] = []
    for (const kind of ['main', 'helper'] as const) {
      for (const g of live) if (g.kind === kind) { sessions.push(await this.servedGroup(g.group, budget)); session_groups.push(g.group) }
    }
    return { served: { room, group, anchor: anchored, rows, links, sessions }, session_groups }
  }

  // ---- groups: the MLS delivery service

  private committed(v: unknown, built_on: number): { epoch: number; change: number } {
    const o = obj(v, 'a Commit answer')
    const answer = { epoch: int(o.epoch, 'epoch'), change: int(o.change, 'change', 1) }
    if (answer.epoch !== built_on + 1) bad('the epoch after a Commit')
    return answer
  }
  /** `POST /v2/groups`: the founding of a session group (5.2.5). */
  async foundGroup(f: { group_info_0: Uint8Array; sealed_key_0: Uint8Array; commit: Uint8Array; group_info: Uint8Array; welcome?: Uint8Array | null; sealed_key: Uint8Array }): Promise<{ group_id: Uint8Array }> {
    const json = {
      group_info_0: enc(f.group_info_0), sealed_key_0: enc(f.sealed_key_0), commit: enc(f.commit), group_info: enc(f.group_info), sealed_key: enc(f.sealed_key),
      ...(f.welcome?.length ? { welcome: enc(f.welcome) } : {}),
    }
    return { group_id: id(obj(await this.send('POST', '/v2/groups', json), 'a founding answer').group_id, 'group_id', 48) }
  }
  /** `POST /v2/groups/{group}/commits`: `epoch-taken` (with the current `epoch` in `details`), `room-behind`,
   *  `bad-commit`, `incomplete`. */
  async postCommit(group: Uint8Array, c: CommitParts): Promise<{ epoch: number; change: number }> {
    return this.committed(await this.send('POST', `/v2/groups/${own(group, 'group', ...GROUP)}/commits`, commitBody(c)), c.epoch)
  }
  /** `POST /v2/groups/{group}/reject` (14.7): this leaf cannot merge the accepted Commit `n`. */
  async rejectCommit(group: Uint8Array, n: number): Promise<{ id: number }> {
    return { id: int(obj(await this.send('POST', `/v2/groups/${own(group, 'group', ...GROUP)}/reject`, { n: ownInt(n, 'n') }), 'a request answer').id, 'id') }
  }
  /** `POST /v2/groups/{group}/archive` (5.2.10). */
  async archiveGroup(group: Uint8Array): Promise<void> {
    if (obj(await this.send('POST', `/v2/groups/${own(group, 'group', ...GROUP)}/archive`, {}), 'an archive answer').archived !== true) bad('archived')
  }
  /** `GET /v2/groups/{group}/log?after=&limit=&kind=commit`: the group's ordered log after number `after`; `gone`
   *  when that is older than what is kept. Entries come strictly ascending by `n`. */
  async groupLog(group: Uint8Array, opts: { after?: number; limit?: number; commits_only?: boolean } = {}): Promise<{ items: LogItem[]; more: boolean }> {
    const g = own(group, 'group', ...GROUP)
    const after = ownInt(opts.after ?? 0, 'after'), limit = Math.min(1000, Math.max(1, ownInt(opts.limit ?? 200, 'limit')))
    const o = obj(await this.get(`/v2/groups/${g}/log`, { after, limit, kind: opts.commits_only ? 'commit' : undefined }, CAP_LIST), 'a log page')
    let n = after
    const items = list(o.items, 'items', limit).map(x => {
      const item = logItem(obj(x, 'a log entry'))
      if (!same(item.group, g) || item.n <= n || (opts.commits_only && item.kind !== 'commit')) bad('a log entry out of place')
      n = item.n
      return item
    })
    return { items, more: bool(o.more, 'more') }
  }
  /** `GET /v2/groups/{group}/removal?after=`: for a key the hub took out of the room (role `removed`, thirty days),
   *  the group's Commits after `after` up to and including the one that removed it, whose log number is
   *  `removed_at` (hub-api.md 42); at most 200 a page. `not-found` where the key was not removed from that group. */
  async removal(group: Uint8Array, after = 0): Promise<{ items: Extract<LogItem, { kind: 'commit' }>[]; more: boolean; removed_at: number }> {
    const g = own(group, 'group', ...GROUP)
    const o = obj(await this.get(`/v2/groups/${g}/removal`, { after: ownInt(after, 'after') }, CAP_LIST), 'a removal page')
    const removed_at = int(o.removed_at, 'removed_at', 1)
    let n = after
    const items = list(o.items, 'items', 200).map(x => {
      const item = logItem(obj(x, 'a log entry'))
      if (!same(item.group, g) || item.kind !== 'commit' || item.n <= n || item.n > removed_at) bad('a removal entry out of place')
      n = item.n
      return item as Extract<LogItem, { kind: 'commit' }>
    })
    return { items, more: bool(o.more, 'more'), removed_at }
  }
  /** `POST /v2/groups/{group}/messages`: an application message; `relay`: passed on, not stored (7.2). */
  async postMessage(group: Uint8Array, epoch: number, message: Uint8Array, relay: boolean): Promise<{ n: number | null }> {
    const json = { epoch: ownInt(epoch, 'epoch'), message: enc(message), ...(relay ? { relay: true } : {}) }
    const o = obj(await this.call('POST', `/v2/groups/${own(group, 'group', ...GROUP)}/messages`, { json, auth: true, once: relay }), 'a message answer')
    return { n: relay ? (o.n === null ? null : bad('n of a relayed message')) : int(o.n, 'n', 1) }
  }
  /** `GET /v2/groups/{group}/info?epoch=`: the GroupInfo of that epoch, or of the current one. */
  async groupInfo(group: Uint8Array, epoch?: number): Promise<{ epoch: number; group_info: Uint8Array }> {
    const o = obj(await this.get(`/v2/groups/${own(group, 'group', ...GROUP)}/info`, { epoch: epoch === undefined ? undefined : ownInt(epoch, 'epoch') }, 2 * MIB), 'a GroupInfo answer')
    const answer = { epoch: int(o.epoch, 'epoch'), group_info: bytes(o.group_info, 'group_info', 1, MAX_MLS) }
    if (epoch !== undefined && answer.epoch !== epoch) bad('another epoch than the one asked for')
    return answer
  }
  /** `GET /v2/welcomes`: for this device; one is deleted when the device has joined. */
  async welcomes(): Promise<{ group: Uint8Array; welcome: Uint8Array; at: number }[]> {
    // an answer holds at most 8 MiB: asked again after the last one's `id` until an answer is empty (a hub whose
    // Welcomes carry no id answers all of them at once)
    const out: { group: Uint8Array; welcome: Uint8Array; at: number }[] = []
    let after: number | null = null
    for (let pages = 0; pages < 10_000; pages++) {
      const page = list(await this.get('/v2/welcomes', after === null ? undefined : { after }, CAP_LIST), 'welcomes', 10_000).map(w => obj(w, 'a welcome'))
      for (const o of page) out.push({ group: id(o.group_id, 'group_id', ...GROUP), welcome: bytes(o.welcome, 'welcome', 1, MAX_MLS), at: int(o.at, 'at') })
      const last = page.at(-1)?.id
      if (!page.length || last === undefined || last === null) break
      const n = int(last, 'id')
      if (after !== null && n <= after) bad('Welcomes out of order')
      after = n
    }
    return out
  }
  /** `PUT /v2/key-packages` (14.2): answers how many single-use ones the hub now holds unused. */
  async putKeyPackages(k: { single_use: Uint8Array[]; last_resort?: Uint8Array | null }): Promise<{ unused: number }> {
    const json = { single_use: k.single_use.map(enc), ...(k.last_resort?.length ? { last_resort: enc(k.last_resort) } : {}) }
    return { unused: int(obj(await this.send('PUT', '/v2/key-packages', json), 'a KeyPackage answer').unused, 'unused') }
  }
  /** `POST /v2/key-packages/claim`: one KeyPackage of each device, all or nothing. NOT repeatable: a claim that was
   *  not answered used its KeyPackages up. The answer is in the order asked. */
  async claimKeyPackages(devices: Uint8Array[]): Promise<{ device: Uint8Array; key_package: Uint8Array }[]> {
    const asked = devices.map(d => own(d, 'device', 32))
    if (asked.length < 1 || asked.length > 64 || new Set(asked).size !== asked.length) wrong('devices: 1 to 64, each once')
    const got = obj(obj(await this.send('POST', '/v2/key-packages/claim', { devices: asked }), 'a claim answer').key_packages, 'key_packages')
    if (Object.keys(got).length !== asked.length) bad('KeyPackages of other devices than the ones asked for')
    return asked.map((d, i) => ({ device: devices[i] as Uint8Array, key_package: Object.hasOwn(got, d) ? bytes(got[d], 'a KeyPackage', 1, MAX_KEY_PACKAGE) : bad('a KeyPackage is missing') }))
  }
  /** `PUT /v2/sealed-keys` (8.3). */
  async putSealedKey(sealed_key: Uint8Array): Promise<void> {
    if (obj(await this.send('PUT', '/v2/sealed-keys', { sealed_key: enc(sealed_key) }), 'a SealedKey answer').stored !== true) bad('stored')
  }
  /** `GET /v2/sealed-keys?after=`: the SealedKeys and RecoveryLinks above change `after`, each ascending. `change`
   *  is the cursor for the next call: both lists are complete up to it. */
  async sealedKeys(after = 0, limit = 500): Promise<{ rows: { change: number; sealed_key: Uint8Array }[]; links: { room_epoch: number; change: number; recovery_link: Uint8Array }[]; change: number; more: boolean }> {
    const from = ownInt(after, 'after'), most = Math.min(2000, Math.max(1, ownInt(limit, 'limit')))
    const o = obj(await this.get('/v2/sealed-keys', { after: from, limit: most }, CAP_LIST), 'sealed keys')
    const ascending = (): ((change: number) => number) => { let at = from; return c => { if (c <= at) bad('sealed keys out of order'); at = c; return c } }
    const [row, link] = [ascending(), ascending()]
    const rows = list(o.rows, 'rows', most).map(r => { const x = obj(r, 'a row'); return { change: row(int(x.change, 'change', 1)), sealed_key: bytes(x.sealed_key, 'sealed_key', 1, MAX_SMALL_STRUCT) } })
    const links = list(o.links, 'links', most).map(r => { const x = obj(r, 'a link'); return { room_epoch: int(x.room_epoch, 'room_epoch'), change: link(int(x.change, 'change', 1)), recovery_link: bytes(x.recovery_link, 'recovery_link', 1, MAX_SMALL_STRUCT) } })
    const change = int(o.change, 'change'), more = bool(o.more, 'more')
    // the cursor is the newest change served, no further: one that ran ahead would skip keys (hub delivery.rs sealed_keys)
    if (change !== Math.max(from, rows.at(-1)?.change ?? 0, links.at(-1)?.change ?? 0) || (more && change === from)) bad('a cursor that is not where the lists end')
    return { rows, links, change, more }
  }
  /** `POST /v2/requests`: an unsigned wish of this device to the human devices. */
  async postRequest(r: { kind: 'readmit' | 'handover' | 'session'; group?: Uint8Array | null; key_package?: Uint8Array | null }): Promise<{ id: number }> {
    const json = { kind: r.kind, ...(r.group ? { group: own(r.group, 'group', ...GROUP) } : {}), ...(r.key_package?.length ? { key_package: enc(r.key_package) } : {}) }
    return { id: int(obj(await this.send('POST', '/v2/requests', json), 'a request answer').id, 'id') }
  }
  /** `GET /v2/requests`: a human device sees every wish of the room. */
  async requests(): Promise<RequestRow[]> {
    return list(await this.get('/v2/requests', undefined, CAP_LIST), 'requests', 100_000).map(requestRow)
  }

  // ---- content

  /** `POST /v2/envelopes`: every stored item. A refusal with `voided` used the envelope's number up. */
  async postEnvelope(envelope: Uint8Array): Promise<{ change: number }> {
    return { change: int(obj(await this.send('POST', '/v2/envelopes', { envelope: enc(envelope) }), 'an envelope answer').change, 'change', 1) }
  }
  /** `GET /v2/desk`: the open objects with their current version, every writer's newest value per register, the groups. */
  async desk(): Promise<Desk> {
    const o = obj(await this.get('/v2/desk', undefined, CAP_DESK), 'the Desk')
    const objects = (v: unknown): DeskObject[] => list(v, 'objects', 1000).map(x => {
      const d = obj(x, 'an object')
      return {
        object_id: id(d.object_id, 'object_id', 16), group: id(d.group_id, 'group_id', ...GROUP), state: int(d.state, 'state', 1), urgency: int(d.urgency, 'urgency'),
        answered_at: int(d.answered_at, 'answered_at'), owner: id(d.owner, 'owner', 32), first_change: int(d.first_change, 'first_change', 1),
        head_change: int(d.head_change, 'head_change', 1), version: maybe(d.version, envelopeItem),
      }
    })
    return {
      cards: objects(o.cards), notes: objects(o.notes), permission_requests: objects(o.permission_requests), artifacts: objects(o.artifacts),
      registers: list(o.registers, 'registers', 20_000).map(envelopeItem), ...(o.groups === undefined ? {} : { groups: list(o.groups, 'groups', 10_000).map(groupRow) }),
      truncated: bool(o.truncated, 'truncated'), change: int(o.change, 'change'),
    }
  }
  /** `GET /v2/chats/{scope}/{id}/items?before=&limit=`: a Chat's envelopes, newest first, below change `before`. */
  async chatItems(scope: 'session' | 'card', ref: Uint8Array, opts: { before?: number; limit?: number } = {}): Promise<{ items: EnvelopeItem[]; more: boolean }> {
    if (scope !== 'session' && scope !== 'card') wrong('a Chat is of a session or a card')
    const limit = Math.min(200, Math.max(1, ownInt(opts.limit ?? 50, 'limit')))
    const before = opts.before === undefined ? undefined : ownInt(opts.before, 'before')
    // a timeline is named by 32 hex digits in this one route (hub content.rs chat_key)
    const page = await this.get(`/v2/chats/${scope}/${hex(unb64u(own(ref, 'ref', 16)))}/items`, { before, limit }, CAP_LIST)
    return envelopePage(page, limit, before ?? Number.MAX_SAFE_INTEGER, -1)
  }
  /** `GET /v2/boards/{board}?after_change=`: the board's items after that change, oldest first (10.3). */
  async boardItems(board: Uint8Array, opts: { after_change?: number; limit?: number } = {}): Promise<{ items: EnvelopeItem[]; more: boolean }> {
    const limit = Math.min(2000, Math.max(1, ownInt(opts.limit ?? 500, 'limit'))), after = ownInt(opts.after_change ?? 0, 'after_change')
    return envelopePage(await this.get(`/v2/boards/${own(board, 'board', 16)}`, { after_change: after, limit }, CAP_LIST), limit, after, 1)
  }
  /** `GET /v2/cards/{object}?after=&limit=` and its siblings: every envelope of the object, by change. */
  async objectEnvelopes(route: ObjectRoute, object_id: Uint8Array, opts: { after?: number; limit?: number } = {}): Promise<ObjectEnvelopes> {
    if (!['cards', 'notes', 'permission-requests', 'artifacts'].includes(route)) wrong('no such object route')
    const limit = Math.min(2000, Math.max(1, ownInt(opts.limit ?? 500, 'limit'))), after = ownInt(opts.after ?? 0, 'after')
    const asked = own(object_id, 'object_id', 16)
    const v = await this.get(`/v2/${route}/${asked}`, { after, limit }, CAP_LIST)
    const o = obj(v, 'an object')
    if (o.object_id !== asked) bad('another object than the one asked for')
    return {
      object_id, group: id(o.group_id, 'group_id', ...GROUP), state: int(o.state, 'state', 1), urgency: int(o.urgency, 'urgency'), owner: id(o.owner, 'owner', 32),
      first_change: int(o.first_change, 'first_change', 1), head_change: int(o.head_change, 'head_change', 1), ...envelopePage(v, limit, after, 1),
    }
  }
  /** `GET /v2/groups/{group}/chains/{sender}?after=&limit=`: a sender's envelopes in pruned form, ascending by
   *  `seq`; those beyond its Cut marked `cut` (9.0.5, 10.3). */
  async chain(group: Uint8Array, sender: Uint8Array, opts: { after?: number; limit?: number } = {}): Promise<{ items: ChainItem[]; more: boolean }> {
    const limit = Math.min(2000, Math.max(1, ownInt(opts.limit ?? 500, 'limit'))), after = ownInt(opts.after ?? 0, 'after')
    const o = obj(await this.get(`/v2/groups/${own(group, 'group', ...GROUP)}/chains/${own(sender, 'sender', 32)}`, { after, limit }, CAP_LIST), 'a chain page')
    let seq = after
    const items = list(o.items, 'items', limit).map(x => {
      const item = { ...envelopeItem(x), seq: int(obj(x, 'a chain item').seq, 'seq', 1) }
      if (item.seq <= seq) bad('a chain out of order')
      seq = item.seq
      return item
    })
    return { items, more: bool(o.more, 'more') }
  }
  /**
   * `GET /v2/changes?after=&limit=`: catch-up, everything this device may see above change `after`, in the hub's one
   * order. The items come strictly ascending by `change`, all above `after` and none above the answer's `change`,
   * which is the cursor for the next call; an answer that breaks this is refused whole.
   */
  async changes(after: number, limit = 200): Promise<{ items: ChangeItem[]; change: number; more: boolean }> {
    const from = ownInt(after, 'after'), most = Math.min(1000, Math.max(1, ownInt(limit, 'limit')))
    const o = obj(await this.get('/v2/changes', { after: from, limit: most }, CAP_LIST), 'a catch-up answer')
    const change = int(o.change, 'change'), more = bool(o.more, 'more')
    if (change < from || change - from > CHANGES_WINDOW) bad('a cursor outside the stretch asked for')
    let at = from
    const items = list(o.items, 'items', most).map(x => {
      const item = changeItem(x)
      if (item.change <= at || item.change > change) bad('changes out of order')
      at = item.change
      return item
    })
    if (more && change === from) bad('more to come, and no step forward')
    return { items, change, more }
  }

  /**
   * Server-sent events from `after`; reconnects with backoff, resuming by the last change seen. Returns close().
   * `on` gets the events in the hub's order, one at a time, and is awaited: a `change` counts as handed over once it
   * returned (or its promise resolved), and only one whose number is above every one handed over before and above
   * `after()` at that moment is handed over at all, so neither a reconnect nor a catch-up beside the stream brings
   * one twice, and none is lost. An event the protocol does not allow ends the connection; the next one resumes
   * from the last good change. `on` throwing does the same without counting the event. `onError` hears why a
   * connection ended (a HubError: `not-member`, `client-too-old`, `offline`, …, or what `on` threw); the stream goes
   * on trying until close().
   */
  stream(after: () => number, on: (event: StreamEvent) => void | Promise<void>, onState: (s: 'connecting' | 'live' | 'offline') => void, onError?: (e: unknown) => void): () => void {
    let closed = false, last = -1, connection: AbortController | null = null
    // what the caller's own callbacks throw is the caller's: it never ends the stream's loop
    const tell = (state: 'connecting' | 'live' | 'offline'): void => { try { onState(state) } catch { /* the caller's */ } }
    const report = (e: unknown): void => { try { onError?.(e) } catch { /* the caller's */ } }
    const run = async (): Promise<void> => {
      let failures = 0, signins = 0
      while (!closed) {
        const ac = connection = new AbortController()
        tell('connecting')
        let stale: ReturnType<typeof setTimeout> | undefined
        const kick = (): void => { clearTimeout(stale); stale = setTimeout(() => ac.abort(), this.timing.stale) }
        let ended_by_hub = false, opened_at = 0, wait: number | null = null
        try {
          kick()
          const token = await this.bearer()
          if (closed) return
          const cursor = Math.max(ownInt(after(), 'after'), last)
          const headers: Record<string, string> = { accept: 'text/event-stream', authorization: `Bearer ${token}` }
          if (this.client_name) headers['trommi-client'] = this.client_name
          let res: Response
          try { res = await this.fetch(`${this.hub_url}/v2/stream?after=${cursor}`, { headers, redirect: 'manual', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: ac.signal }) }
          catch { throw this.offline('the hub was not reached') }
          if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) bad('a redirect', res.status || 302)
          if (!res.ok) {
            const refusal = await this.refusal(res)
            if (refusal.code === 'unauthorised' && this.token === token) this.token = null
            throw refusal
          }
          if (!res.headers.get('content-type')?.startsWith('text/event-stream') || !res.body) bad('not a stream of events')
          if (this.down) { this.down = false; this.wake() }
          opened_at = Date.now()
          tell('live')
          const reader = res.body.getReader(), decoder = new TextDecoder()
          let buffer = ''
          for (;;) {
            let step: ReadableStreamReadResult<Uint8Array>
            try { step = await reader.read() } catch { throw this.offline('the stream broke off') }
            if (step.done) break
            kick()
            // lines end in LF, CRLF or CR; a CR at the very end waits for what follows it
            buffer = (buffer + decoder.decode(step.value, { stream: true })).replace(/\r\n|\r(?!$)/g, '\n')
            for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
              const block = buffer.slice(0, end)
              buffer = buffer.slice(end + 2)
              if (block.length > CAP_EVENT) bad('an event larger than the protocol allows')
              let name = '', event_id: string | null = null
              const data: string[] = []
              for (const line of block.split('\n')) {
                const colon = line.indexOf(':')
                if (colon <= 0) continue      // a comment, or a line that is no field
                const value = line.slice(line[colon + 1] === ' ' ? colon + 2 : colon + 1)
                if (line.startsWith('event:')) name = value
                else if (line.startsWith('data:')) data.push(value)
                else if (line.startsWith('id:')) event_id = value
              }
              if (!name || name === 'ping') continue
              let parsed: unknown
              try { parsed = JSON.parse(data.join('\n')) } catch { bad('an event that is not JSON') }
              if (name === 'envelope' || name === 'log') {
                const item = changeItem(parsed)
                if ((item.kind === 'envelope') !== (name === 'envelope') || event_id !== String(item.change)) bad('an event that is not what it is named')
                if (item.change <= Math.max(cursor, last)) bad('a change that was sent before')
                // what a catch-up beside the stream took meanwhile is not handed over again
                if (item.change > ownInt(after(), 'after')) await on({ event: 'change', item })
                last = item.change
              } else {
                const event = streamEvent(name, parsed)
                if (event) await on(event)
              }
              if (closed) return
            }
            if (buffer.length > CAP_EVENT) bad('an event larger than the protocol allows')
          }
          ended_by_hub = true
        } catch (e) {
          if (closed) return
          if (e instanceof HubError && e.code === 'unauthorised' && ++signins <= 2) continue
          if (e instanceof HubError && e.retry_after !== null) wait = e.retry_after * 1000
          tell('offline')
          report(e)
        } finally {
          clearTimeout(stale)
          ac.abort()
        }
        if (closed) return
        // Only a connection that stood for a while counts as one that worked: then the count of failures starts
        // anew, and if the hub ended it (its token ran out, the hub restarts) the next one opens at once. Every
        // other end waits longer each time, to at most `backoff_max`; a hub cannot shorten that by what it sends.
        const worked = opened_at > 0 && Date.now() - opened_at >= this.timing.stream_stood
        if (worked) { failures = 0; signins = 0 }
        const step = worked && ended_by_hub ? 250 : Math.min(this.timing.backoff_max, this.timing.backoff_first * 2 ** Math.min(failures++, 16))
        await sleep(Math.min(this.timing.backoff_max, Math.max(wait ?? 0, step * (0.5 + Math.random() / 2))), this.wakers)
      }
    }
    void run().catch(e => { if (!closed) { tell('offline'); report(e) } })
    const close = (): void => { closed = true; connection?.abort(); OPEN_STREAMS.delete(close); this.wake() }
    OPEN_STREAMS.add(close)
    return close
  }

  // ---- files and Share links (v2.md 11)

  private async upload(path: string, data: Uint8Array | Blob, opts: Transfer, streamed: boolean): Promise<unknown> {
    const size = data instanceof Uint8Array ? data.length : data.size
    const body = streamed ? (): ReadableStream<Uint8Array> => {
      let at = 0
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (at >= size) { controller.close(); return }
          const end = Math.min(size, at + 65_536)
          controller.enqueue(data instanceof Uint8Array ? data.subarray(at, end) : new Uint8Array(await data.slice(at, end).arrayBuffer()))
          at = end
          opts.onProgress?.(at, size)
        },
      })
    } : () => data
    // the hub gives an upload a minute and the time its length needs at 16 KiB/s (hub api.rs `upload`)
    return this.callOnce('PUT', path, { body, length: size, auth: true, signal: opts.signal, timeout_ms: 60_000 + size / 16.384 }, CAP_SMALL)
  }
  /**
   * `PUT /v2/files/{file_id}`: the file's bytes (ciphertext), in one request, written once. The same bytes again get
   * the first answer; other bytes under the id are `replay`. Where the platform takes a stream as a request body the
   * bytes go in pieces and `onProgress` follows them; where it does not (a browser on HTTP/1.1), they go in one piece.
   */
  async putFile(file_id: Uint8Array, data: Uint8Array | Blob, opts: Transfer = {}): Promise<{ file_id: Uint8Array; size: number; sha256: Uint8Array }> {
    const asked = own(file_id, 'file_id', 16), path = `/v2/files/${asked}`
    const size = data instanceof Uint8Array ? data.length : data.size
    let answer: unknown
    if (opts.onProgress && this.streams_uploads) {
      try { answer = await this.upload(path, data, opts, true) } catch (e) {
        if (!(e instanceof HubError) || e.code !== 'offline') throw e
        // not reached with a stream: perhaps this platform sends none after all. The same bytes in one piece; if that
        // gets through, streams are not tried again.
        answer = await this.upload(path, data, opts, false)
        this.streams_uploads = false
      }
    } else answer = await this.upload(path, data, opts, false)
    const o = obj(answer, 'a file answer')
    if (o.file_id !== asked || int(o.size, 'size') !== size) bad('another file than the one sent')
    opts.onProgress?.(size, size)
    return { file_id, size, sha256: bytes(o.sha256, 'sha256', 32) }
  }

  /** Reads a file route. A body that breaks off is taken up again by `Range` from where it broke (a file never
   *  changes); the answer's status, range and length are checked against what was asked. */
  private async download(path: string, base: Send, opts: Transfer & { range?: { start: number; end?: number } }): Promise<{ bytes: Uint8Array; size: number }> {
    const first = ownInt(opts.range?.start ?? 0, 'range.start')
    const final = opts.range?.end === undefined ? null : ownInt(opts.range.end, 'range.end')
    if (final !== null && final < first) wrong('range: end before start')
    const parts: Uint8Array[] = []
    let got = 0, size: number | null = null, wanted: number | null = null
    for (let attempt = 0; ; attempt++) {
      const from = first + got, ranged = opts.range !== undefined || got > 0
      // the hub serves a file at no less than 16 KiB/s or drops the reader; the same floor here
      const watch = new Watch(60_000 + CAP_FILE / 16.384, opts.signal, this.timing.transfer_idle)
      try {
        const res = await this.exchange('GET', path, { ...base, headers: { ...base.headers, ...(ranged ? { range: `bytes=${from}-${final ?? ''}` } : {}) } }, watch)
        const length = res.headers.get('content-length')
        let expect: number | null = length !== null && /^\d{1,12}$/.test(length) ? Number(length) : null
        if (ranged) {
          const m = /^bytes (\d{1,12})-(\d{1,12})\/(\d{1,12})$/.exec(res.headers.get('content-range') ?? '')
          if (res.status !== 206 || !m) { void res.body?.cancel().catch(() => {}); bad('not the range asked for', res.status) }
          const [a, b, total] = [Number(m[1]), Number(m[2]), Number(m[3])]
          const last = Math.min(final ?? total - 1, total - 1)
          if (total < 1 || a > b || b >= total || a !== from || b !== last || total > CAP_FILE || (size !== null && total !== size) || (expect !== null && expect !== b - a + 1)) { void res.body?.cancel().catch(() => {}); bad('not the range asked for', res.status) }
          size = total
          expect = b - a + 1
          wanted ??= last - first + 1
        } else {
          if (res.status !== 200 || (expect !== null && expect > CAP_FILE)) { void res.body?.cancel().catch(() => {}); bad('not the file asked for', res.status) }
          size = expect
          wanted = expect
        }
        // every chunk is kept as it comes, so that a body that breaks off is taken up after its last byte
        const reader = res.body?.getReader()
        let piece = 0
        for (; reader;) {
          let step: ReadableStreamReadResult<Uint8Array>
          try { step = await reader.read() } catch { throw watch.failure('the answer broke off') }
          if (step.done) break
          piece += step.value.length
          if (piece > (expect ?? CAP_FILE)) { void reader.cancel().catch(() => {}); bad('more bytes than the answer announced', res.status) }
          parts.push(step.value)
          got += step.value.length
          watch.kick()
          opts.onProgress?.(got, wanted ?? got)
        }
        if (expect !== null && piece !== expect) throw new HubError('offline', 'the answer broke off')
        break
      } catch (e) {
        if (!(e instanceof HubError) || e.code !== 'offline' || attempt >= 2 || opts.signal?.aborted) throw e
      } finally { watch.done() }
    }
    const out = new Uint8Array(got)
    let at = 0
    for (const p of parts) { out.set(p, at); at += p.length }
    return { bytes: out, size: size ?? got }
  }
  /** `GET /v2/files/{file_id}` (with `Range`): the stored bytes, or the inclusive byte range asked for; `size` is
   *  the whole file's. */
  getFile(file_id: Uint8Array, opts: Transfer & { range?: { start: number; end?: number } } = {}): Promise<{ bytes: Uint8Array; size: number }> {
    return this.download(`/v2/files/${own(file_id, 'file_id', 16)}`, { auth: true }, opts)
  }
  /** `DELETE /v2/files/{file_id}`: its uploader or a human device. */
  async deleteFile(file_id: Uint8Array): Promise<void> {
    if (obj(await this.send('DELETE', `/v2/files/${own(file_id, 'file_id', 16)}`, undefined), 'a deletion').deleted !== true) bad('deleted')
  }
  /** `POST /v2/shares` (11.5): registers a Share link for a file of an open Artifact. */
  async postShare(s: { share_id: Uint8Array; secret_hash: Uint8Array; file_id: Uint8Array; expires_at: number }): Promise<{ share_id: Uint8Array; expires_at: number }> {
    const json = { share_id: own(s.share_id, 'share_id', 16), secret_hash: enc(s.secret_hash), file_id: own(s.file_id, 'file_id', 16), expires_at: ownInt(s.expires_at, 'expires_at') }
    const o = obj(await this.send('POST', '/v2/shares', json), 'a share')
    if (o.share_id !== json.share_id) bad('another share than the one registered')
    return { share_id: s.share_id, expires_at: int(o.expires_at, 'expires_at') }
  }
  /** `DELETE /v2/shares/{share_id}`: revokes the link. */
  async deleteShare(share_id: Uint8Array): Promise<void> {
    if (obj(await this.send('DELETE', `/v2/shares/${own(share_id, 'share_id', 16)}`, undefined), 'a deletion').deleted !== true) bad('deleted')
  }
  /** `GET /v2/shares/{share_id}`: the shared file's bytes for whoever holds the link's secret; no token. Every
   *  refusal is the same `not-found`. The secret travels in a header, never in the address. */
  getShared(share_id: Uint8Array, secret: Uint8Array, opts: Transfer & { range?: { start: number; end?: number } } = {}): Promise<{ bytes: Uint8Array; size: number }> {
    if (secret.length !== 32) wrong('a share secret is 32 bytes')
    return this.download(`/v2/shares/${own(share_id, 'share_id', 16)}`, { auth: false, headers: { 'x-share-secret': enc(secret) } }, opts)
  }

  // ---- invites (v2.md 12.1): the three signed messages, by invite id

  /** `GET /v2/invites/{invite_id}`: the Offer; a human device of its room (signed in) also gets the Requests. */
  async getInvite(invite_id: Uint8Array): Promise<{ offer: Uint8Array; signature: Uint8Array; mac: Uint8Array; expires_at: number; requests: { request: Uint8Array; mac: Uint8Array; signature: Uint8Array }[] | null }> {
    const o = obj(await this.get(`/v2/invites/${own(invite_id, 'invite_id', 16)}`, undefined, CAP_SMALL, this.signer !== null), 'an invite')
    return {
      // (the MAC that binds the Offer to the link; a hub before it serves none: the core then refuses the Offer)
      offer: bytes(o.offer, 'offer', 1, MAX_SMALL_STRUCT), signature: bytes(o.signature, 'signature', 1, MAX_TAG), mac: o.mac === undefined || o.mac === null ? new Uint8Array(0) : bytes(o.mac, 'mac', 1, MAX_TAG), expires_at: int(o.expires_at, 'expires_at'),
      requests: maybe(o.requests, r => list(r, 'requests', 4).map(x => {
        const q = obj(x, 'a Request')
        return { request: bytes(q.request, 'request', 1, MAX_KEY_PACKAGE), mac: bytes(q.mac, 'mac', 1, MAX_TAG), signature: bytes(q.signature, 'signature', 1, MAX_TAG) }
      })),
    }
  }
  /** `POST /v2/invites/{invite_id}/request`: the new device's Request, its MAC and signature; no token. */
  async postInviteRequest(invite_id: Uint8Array, r: { request: Uint8Array; mac: Uint8Array; signature: Uint8Array }): Promise<{ request_hash: Uint8Array }> {
    const json = { request: enc(r.request), mac: enc(r.mac), signature: enc(r.signature) }
    return { request_hash: id(obj(await this.send('POST', `/v2/invites/${own(invite_id, 'invite_id', 16)}/request`, json, false), 'a Request answer').request_hash, 'request_hash', 32) }
  }
  /** `GET /v2/invites/{invite_id}/reveal`: the Reveal once the inviter published it; `not-found` until then. */
  async getReveal(invite_id: Uint8Array): Promise<{ reveal: Uint8Array; signature: Uint8Array }> {
    const o = obj(await this.get(`/v2/invites/${own(invite_id, 'invite_id', 16)}/reveal`, undefined, CAP_SMALL, false), 'a Reveal')
    return { reveal: bytes(o.reveal, 'reveal', 1, MAX_SMALL_STRUCT), signature: bytes(o.signature, 'signature', 1, MAX_TAG) }
  }
  /** `POST /v2/invites`: a human device publishes its signed Offer. */
  async postInvite(offer: Uint8Array, signature: Uint8Array, mac: Uint8Array): Promise<{ invite_id: Uint8Array }> {
    return { invite_id: id(obj(await this.send('POST', '/v2/invites', { offer: enc(offer), signature: enc(signature), mac: enc(mac) }), 'an invite answer').invite_id, 'invite_id', 16) }
  }
  /** `PUT /v2/invites/{invite_id}/reveal`: the inviter accepted one Request. */
  async putReveal(invite_id: Uint8Array, reveal: Uint8Array, signature: Uint8Array): Promise<void> {
    if (obj(await this.send('PUT', `/v2/invites/${own(invite_id, 'invite_id', 16)}/reveal`, { reveal: enc(reveal), signature: enc(signature) }), 'a Reveal answer').revealed !== true) bad('revealed')
  }
  /** `DELETE /v2/invites/{invite_id}`: "they don't match" burns the invite. */
  async deleteInvite(invite_id: Uint8Array): Promise<void> {
    if (obj(await this.send('DELETE', `/v2/invites/${own(invite_id, 'invite_id', 16)}`, undefined), 'a burned invite').burned !== true) bad('burned')
  }

  // ---- the account (hub-api.md "The account"). Login keys and sealed copies are secrets: they go in bodies only.

  /** `POST /v2/account/login`. `account`: the one field that names an account, its e-mail (it contains `@`) or
   *  its id. `wrong-login` for a name nobody has and a wrong key alike; `rate-limited` with `retry_after` when
   *  this source has to wait. */
  async login(account: string, auth_key: Uint8Array): Promise<LoginAnswer> {
    return loginAnswer(await this.send('POST', '/v2/account/login', { account: ownName(account), auth_key: enc(auth_key) }, false))
  }
  /** `POST /v2/account/recover`: the same with the Emergency Kit's key; `wrong-recovery`. */
  async recover(account: string, auth_key: Uint8Array): Promise<LoginAnswer> {
    return loginAnswer(await this.send('POST', '/v2/account/recover', { account: ownName(account), auth_key: enc(auth_key) }, false))
  }
  /** `POST /v2/account/passkey/challenge`: a challenge for a sign-in with a passkey, or for the passkey of a new
   *  account, with the id that account will have; no token. */
  async passkeyChallenge(): Promise<PasskeyChallenge> {
    return passkeyChallengeAnswer(await this.send('POST', '/v2/account/passkey/challenge', {}, false))
  }
  /** `POST /v2/account/passkey/login`: every failure is `wrong-login`. */
  async passkeyLogin(a: { credential_id: Uint8Array; authenticator_data: Uint8Array; client_data_json: Uint8Array; signature: Uint8Array; user_handle?: Uint8Array | null }): Promise<LoginAnswer> {
    const json = {
      credential_id: enc(a.credential_id), authenticator_data: enc(a.authenticator_data), client_data_json: enc(a.client_data_json), signature: enc(a.signature),
      ...(a.user_handle?.length ? { user_handle: enc(a.user_handle) } : {}),
    }
    return loginAnswer(await this.send('POST', '/v2/account/passkey/login', json, false))
  }
  /** `POST /v2/account`: sign-up for a room that has none yet, by a human device of it. It is instant: the hub sends
   *  no mail and confirms no address. `account-exists`, `bad-email`, `bad-passkey`. */
  async createAccount(account: NewAccount): Promise<AccountView> { return accountView(await this.send('POST', '/v2/account', accountBody(account))) }
  /** `GET /v2/account`: the account of this device's room with its sealed copies; no hash leaves the hub. */
  async account(): Promise<AccountView> { return accountView(await this.get('/v2/account')) }
  /** `PUT /v2/account/password`: `account-changed` when `revision` is not the current one. */
  async putPassword(p: { auth_key: Uint8Array; sealed_copy: Uint8Array; kdf: Kdf; revision: number }): Promise<{ revision: number }> {
    const json = { auth_key: enc(p.auth_key), sealed_copy: enc(p.sealed_copy), kdf: p.kdf, revision: ownInt(p.revision, 'revision') }
    return { revision: int(obj(await this.send('PUT', '/v2/account/password', json), 'a revision').revision, 'revision') }
  }
  /** `PUT /v2/account/kit`: a new Emergency Kit replaces the one before. */
  async putKit(k: KitPart & { revision: number }): Promise<{ revision: number }> {
    const json = { ...kitBody(k), revision: ownInt(k.revision, 'revision') }
    return { revision: int(obj(await this.send('PUT', '/v2/account/kit', json), 'a revision').revision, 'revision') }
  }
  /** `PUT /v2/account/email`: gives an account without e-mail one, once (`forbidden` when it has one), together
   *  with its kit made anew under that e-mail (`incomplete` without); `bad-email`, `account-exists`, `account-changed`. */
  async putEmail(e: { email: string; kit: KitPart; revision: number }): Promise<{ revision: number }> {
    if (typeof e.email !== 'string' || e.email.length > 254) wrong('an e-mail address')
    return { revision: int(obj(await this.send('PUT', '/v2/account/email', { email: e.email, kit: kitBody(e.kit), revision: ownInt(e.revision, 'revision') }), 'a revision').revision, 'revision') }
  }
  /** `POST /v2/account/passkeys/challenge`: a challenge for adding a passkey to this room's account, with the
   *  account's id, which that passkey carries as its user handle, and what a new kit of the account is salted with. */
  async accountPasskeyChallenge(): Promise<AccountPasskeyChallenge> {
    const o = await this.send('POST', '/v2/account/passkeys/challenge', {}), more = obj(o, 'a challenge answer')
    return { ...passkeyChallengeAnswer(o), email: maybe(more.email, e => text(e, 'email', 254)), kit_form: oneOf(more.kit_form, 'kit_form', 'email', 'id') }
  }
  /** `POST /v2/account/passkeys`. */
  async addPasskey(passkey: PasskeyRegistration): Promise<{ credential_id: Uint8Array; created_at: number }> {
    const o = obj(await this.send('POST', '/v2/account/passkeys', passkeyBody(passkey)), 'a passkey answer')
    return { credential_id: bytes(o.credential_id, 'credential_id', 1, 1023), created_at: int(o.created_at, 'created_at') }
  }
  /** `DELETE /v2/account/passkeys/{credential_id}`: `last-way-in` when it is the only way into the account. */
  async removePasskey(credential_id: Uint8Array): Promise<void> {
    if (credential_id.length < 1 || credential_id.length > 1023) wrong('a credential id is 1 to 1023 bytes')
    if (obj(await this.call('DELETE', `/v2/account/passkeys/${enc(credential_id)}`, { auth: true }), 'a deletion').deleted !== true) bad('deleted')
  }

  // ---- push (v2.md 15), human devices

  /** `POST /v2/push`: registers this device for Web Push or APNs at a level. */
  async pushRegister(r: PushRegistration): Promise<void> {
    const json = {
      level: r.level,
      ...(r.web_push ? { web_push: { endpoint: r.web_push.endpoint, keys: { p256dh: enc(r.web_push.keys.p256dh), auth: enc(r.web_push.keys.auth) } } } : {}),
      ...(r.apns ? { apns: { token: r.apns.token, key: enc(r.apns.key), environment: r.apns.environment, topic: r.apns.topic } } : {}),
    }
    if (obj(await this.send('POST', '/v2/push', json), 'a registration').registered !== true) bad('registered')
  }
  /** `GET /v2/push`: this device's registrations and the hub's Web Push key. */
  async pushState(): Promise<{ subscriptions: { kind: 'web_push' | 'apns'; endpoint: string; level: 'all' | 'knocking'; created_at: number }[]; vapid_public_key: Uint8Array; apns: boolean }> {
    const o = obj(await this.get('/v2/push'), 'the push state')
    return {
      subscriptions: list(o.subscriptions, 'subscriptions', 64).map(s => {
        const x = obj(s, 'a registration')
        return { kind: oneOf(x.kind, 'kind', 'web_push', 'apns'), endpoint: text(x.endpoint, 'endpoint', 2048), level: oneOf(x.level, 'level', 'all', 'knocking'), created_at: int(x.created_at, 'created_at') }
      }),
      vapid_public_key: bytes(o.vapid_public_key, 'vapid_public_key', 65), apns: bool(o.apns, 'apns'),
    }
  }
  /** `DELETE /v2/push`: removes the registration with that endpoint, or all of this device's. */
  async pushRemove(endpoint?: string): Promise<{ deleted: number }> {
    return { deleted: int(obj(await this.send('DELETE', '/v2/push', endpoint === undefined ? {} : { endpoint }), 'a deletion').deleted, 'deleted') }
  }
}
