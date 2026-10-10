// account.ts: the Trommi account on protocol v2 (spec/v2.md 8.4, 8.6, 8.7, 8.8; spec/hub-api.md "The account").
//
// An account has passkeys, a password or both, and an Emergency Kit (twelve words, made with the account and with
// every new recovery code). It has an id, a UUID the hub mints, which is public and printed on every kit; an e-mail
// is optional beside a passkey, and a password needs one (its keys are derived from it). The kit's keys are salted
// with the e-mail where the account has one and with the id where it has none (`kit_form`; the latter needs the
// core's `kitKeysFor` and `accountIdParse`, which today's binding does not have: `core-missing`). It is a way into
// the ROOM the first device founded: each way in opens
// one sealed copy of the room's recovery code, and a device that holds the code joins the room (8.4). The hub checks
// a login and hands out the sealed copy; it never sees the password, the kit's words, a passkey's prf output or the
// code.
//
// This module holds no cryptography of its own. Every key and every sealed copy is the core's (core/src/account.rs,
// through `Core`: passwordKeys, kitKeys, passkeyWrapKey, sealRecoveryCode, openRecoveryCode, …), the hub's routes
// are hub.ts's, and founding or joining a room is room.ts's. What is here is the order of those steps:
//
//   create account      a fresh code; room.ts founds the room and asks for the account's body once the room id
//                       exists (the copies are sealed for that room), and the hub makes room and account together
//   log in              the hub's answer to the login key → the sealed copy → the code → joinWithCode (8.4)
//   forgot password     the kit's words open the kit's copy; with a new password the device runs the recovery of
//                       8.7 as one request (resetPassword); for a new passkey it signs in (8.4, recoverWithKit),
//                       the passkey is added and the code is replaced by 8.6 (addPasskey with the words)
//   bare recovery code  recoverWithCode: the recovery of 8.7 for a room without an account
//   settings            a new password, a passkey more or less, a new kit: the code is opened with a way in given
//                       again and sealed anew; the account's revision guards against a change from elsewhere
//
// It runs in the core worker only: the slow key derivation (Argon2id over 64 MiB) never runs on the page's thread,
// and the page gets nothing secret back except what it must show once: the kit's words and, after a recovery
// with the bare code, the new recovery code. WebAuthn's prompts are the page's (public/auth.mjs); what a ceremony
// returned comes here as bytes.
//
// Secrets: codes, wrap keys, login keys and prf outputs are zeroed here once used (also the prf bytes a caller
// handed in: in the worker they are its own copy). A password and the kit's words are JavaScript strings and
// cannot be. No error made here carries a secret, and nothing here writes a log line.
import { loadCore } from './core-wasm.ts'
import type { AccountKeys, AccountName, AccountWay, Core } from './core-api.ts'
import { Hub, HubError } from './hub.ts'
import type { AccountCopies, AccountView, Kdf, KitForm, KitPart, LoginAnswer, NewAccount } from './hub.ts'
import { b64u, hex, unb64u, unhex } from './ids.ts'
import { foundRoom, joinWithCode } from './room.ts'
import type { DeviceOptions } from './room.ts'
import type { Client } from './client.ts'
import { accountName } from './account-name.ts'

/** What the account needs of a signed-in device (client.ts gives it): the core, the hub client signed in as this
 *  device, the room, and the one request of 8.6. It holds no key itself. */
export interface AccountClient {
  core: Core
  hub: Hub
  room_id: Uint8Array
  /** 8.6. `code`: the code in force (a device forgets it once it has joined). The core makes the new code;
   *  `account` is asked for the account's copies of it before the request is built. */
  replaceRecoveryCode(o: { code: Uint8Array; account: (new_code: Uint8Array) => Record<string, unknown> }): Promise<void>
  /** Resolves only if `code` is the room's recovery code in force, by the device's own verified room state;
   *  `wrong-recovery` otherwise. Changes nothing, sends nothing. */
  checkRecoveryCode(code: Uint8Array): Promise<void>
}
/** The Emergency Kit as the screen shows it, once: the words, the account's id (null only when the hub could not be
 *  asked for it after the account was made; the screen reads it again), its e-mail if it has one, and which of the
 *  two the kit opens with (`form`). */
export interface Kit { words: string; email: string | null; account: string | null; form: KitForm }
/** A passkey of the account as the screens list it. Ids are base64url, as WebAuthn on the page reads them. */
export interface PasskeyStatus { credential_id: string; transports: string[]; created_at: number; last_used_at: number | null }
/** The account as the screens see it: no sealed copy and no key leaves the worker. An account always has its kit
 *  and its id (`account`, as printed); `email` is null for an account without one. */
export interface AccountStatus { email: string | null; account: string; kit_form: KitForm; revision: number; has_password: boolean; has_recovery: true; user_handle: string; passkeys: PasskeyStatus[] }
/** What navigator.credentials.create() gave, as bytes, with the prf output of that passkey. */
export interface PasskeyRegistration { credential_id: Uint8Array; attestation_object: Uint8Array; client_data_json: Uint8Array; transports?: string[]; prf: Uint8Array }
/** What navigator.credentials.get() gave, as bytes, with the prf output. */
export interface PasskeyAssertion { credential_id: Uint8Array; authenticator_data: Uint8Array; client_data_json: Uint8Array; signature: Uint8Array; user_handle?: Uint8Array | null; prf: Uint8Array }
/** A way in given again on a signed-in device: the password, a passkey of the account, or the kit's words. */
export type Unlock = { password: string } | { passkey: { credential_id: Uint8Array; prf: Uint8Array } } | { words: string }
/** What a step that makes this device's room takes besides its own fields; room.ts reads it, this module hands it on. */
type Opening = DeviceOptions & { hub_url: string }

/** A refusal of this module's own. Its codes: `no-account`, `no-password`, `no-room`, `bad-argument`, `bad-passkey`,
 *  `wrong-login` (a passkey that is not the account's), `needs-email` (a password on an account without e-mail),
 *  `account-changed`, `internal`. Everything else thrown here is the core's
 *  (TrommiError) or the hub's (HubError), each with its stable `code`. */
export class AccountError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'AccountError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Keys and sealed copies

/** One way in whose wrap key is in hand: it seals and opens that way's copy of the code. */
interface Way { name: AccountWay; credential_id: Uint8Array | null; wrap_key: Uint8Array }

const zero = (...secrets: (Uint8Array | null | undefined)[]): void => { for (const s of secrets) s?.fill(0) }
const zeroKeys = (...keys: (AccountKeys | null | undefined)[]): void => { for (const k of keys) zero(k?.authKey, k?.wrapKey) }
const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, i) => byte === b[i])
const passwordWay = (keys: AccountKeys): Way => ({ name: 'password', credential_id: null, wrap_key: keys.wrapKey })
const kitWay = (keys: AccountKeys): Way => ({ name: 'kit', credential_id: null, wrap_key: keys.wrapKey })
/** `no-prf` unless the passkey gave its 32 bytes; `bad-format` for a credential id WebAuthn does not allow. */
const passkeyWay = (core: Core, room_id: Uint8Array, p: { credential_id: Uint8Array; prf: Uint8Array }): Way =>
  ({ name: 'passkey', credential_id: p.credential_id, wrap_key: core.passkeyWrapKey(p.prf, room_id, p.credential_id) })
/** The one key derivation record this client writes and derives with (the core's; a hub does not choose the cost). */
const pinnedKdf = (core: Core): Kdf => JSON.parse(core.kdfRecord()) as Kdf

/** The code sealed for one room and one way in. The copy is opened once more before it leaves: a copy that would
 *  not open is found here, not at the next login. */
function sealed(core: Core, way: Way, room_id: Uint8Array, code: Uint8Array): Uint8Array {
  const copy = core.sealRecoveryCode(way.wrap_key, room_id, way.name, way.credential_id, code)
  const back = core.openRecoveryCode(way.wrap_key, room_id, way.name, way.credential_id, copy)
  const opens = equal(back, code)
  zero(back)
  if (!opens) throw new AccountError('internal', 'a sealed copy does not open')
  return copy
}
const open = (core: Core, way: Way, room_id: Uint8Array, copy: Uint8Array): Uint8Array => core.openRecoveryCode(way.wrap_key, room_id, way.name, way.credential_id, copy)

/** The kit's keys for the account `name` names. An e-mail: the binding's `kitKeys`, as ever. An id: `kitKeysFor`. */
const kitKeysOf = (core: Core, name: AccountName, words: string): AccountKeys => (name.kind === 'email' ? core.kitKeys(name.email, words) : core.kitKeysFor(name, words))
/** How a NEW kit of an account is made: under its e-mail where it has one, else under its id. */
const kitNameOf = (email: string | null, id: Uint8Array): AccountName => (email !== null ? { kind: 'email', email } : { kind: 'id', id })
/** A new Emergency Kit: fresh words and their two keys. */
function newKit(core: Core, name: AccountName): { words: string; keys: AccountKeys; form: KitForm } {
  const words = core.generateKitWords()
  return { words, keys: kitKeysOf(core, name, words), form: name.kind }
}
/** The kit's part of a body for the hub. The login key is a copy: the body is the hub client's from here on. */
const kitPart = (core: Core, kit: { keys: AccountKeys; form: KitForm }, room_id: Uint8Array, code: Uint8Array): KitPart =>
  ({ auth_key: kit.keys.authKey.slice(), sealed_copy: sealed(core, kitWay(kit.keys), room_id, code), form: kit.form })
const passwordPart = (core: Core, keys: AccountKeys, room_id: Uint8Array, code: Uint8Array): { auth_key: Uint8Array; sealed_copy: Uint8Array; kdf: Kdf } =>
  ({ auth_key: keys.authKey.slice(), sealed_copy: sealed(core, passwordWay(keys), room_id, code), kdf: pinnedKdf(core) })
/** A passkey's registration as the hub takes it. The hub wants each transport as lowercase letters and hyphens, at
 *  most 16 characters, at most 8 of them; what a browser reports beyond that is left out. */
function passkeyPart(core: Core, p: PasskeyRegistration, room_id: Uint8Array, code: Uint8Array): NonNullable<NewAccount['passkey']> {
  const way = passkeyWay(core, room_id, p)
  try {
    const transports = (p.transports ?? []).filter(t => /^[a-z-]{1,16}$/.test(t)).slice(0, 8)
    return { attestation_object: p.attestation_object, client_data_json: p.client_data_json, sealed_copy: sealed(core, way, room_id, code), transports }
  } finally { zero(way.wrap_key) }
}

const anonymous = (o: Opening): Hub => new Hub({ hub_url: o.hub_url, client_name: o.client ?? null, ...(o.fetch ? { fetch: o.fetch } : {}) })
/** The room a login answered with. An account has a list of rooms, one for now: the first is taken. */
function roomOf(answer: LoginAnswer): LoginAnswer['rooms'][number] {
  const room = answer.rooms[0]
  if (!room) throw new AccountError('no-room', 'this account has no room')
  return room
}
/** A client room.ts made, as the account's routes take it. */
const signedIn = (client: Client): AccountClient => client
/** Ends a client whose account step failed after the device had joined: its room stays stored, the screen opens it. */
const stop = async (client: Client): Promise<void> => { try { await client.stop() } catch { /* the step's own error is the one to tell */ } }

// ---------------------------------------------------------------------------------------------------------------------
// Create account

/**
 * Create an account with a password: this device founds the room, and the hub makes the account in the same
 * transaction (e-mail, the password's login key and copy, the Emergency Kit's). Returns the kit, whose words are
 * shown once and never stored; the room's recovery code does not leave this function. `weak-password`,
 * `bad-email`; from the hub `account-exists`, `rate-limited`. A refused founding leaves nothing stored (room.ts).
 * `found_token`: the hub's word, where it founds rooms by invitation; room.ts hands it on.
 */
export async function createAccount(o: Opening & { email: string; password: string; found_token?: string | null }): Promise<{ client: Client; kit: Kit }> {
  const { email: given, password, ...device } = o
  const core = await loadCore()
  const email = core.normaliseEmail(given)
  core.checkPassword(password)
  const keys = core.passwordKeys(email, password)
  try {
    return await found(core, device, { email, account: null }, { kind: 'email', email }, (room_id, code) => ({ password: passwordPart(core, keys, room_id, code) }))
  } finally { zeroKeys(keys) }
}

/**
 * Create an account whose way in is a passkey; an e-mail is optional. The page asked the hub for a challenge
 * (`passkeyChallenge`), which names the id the account will have, made the passkey over it with that id as its user
 * handle, and has its prf output before it calls this; nothing but that question reached the hub until then.
 * `account`: that id, as printed. With an e-mail the kit is made under it; without one under the id, which needs the
 * core's `accountIdParse` and `kitKeysFor` (`core-missing` on a binding without them, before anything is founded).
 * `no-prf` when the passkey gave no key (nothing is founded then).
 */
export async function createAccountWithPasskey(o: Opening & { email?: string | null; account: string; passkey: PasskeyRegistration; found_token?: string | null }): Promise<{ client: Client; kit: Kit }> {
  const { email: given, account: named, passkey, ...device } = o
  const core = await loadCore()
  try {
    const email = given == null || given.trim() === '' ? null : core.normaliseEmail(given)
    const id = accountName(named)
    if (id.kind !== 'id' || id.account !== named) throw new AccountError('bad-argument', 'account: the id the passkey\'s challenge named')
    // a passkey without a prf output is refused before a room is founded (the room id here is none)
    zero(passkeyWay(core, new Uint8Array(32), passkey).wrap_key)
    const name: AccountName = email !== null ? { kind: 'email', email } : { kind: 'id', id: core.accountIdParse(id.account) }
    return await found(core, device, { email, account: id.account }, name, (room_id, code) => ({ passkey: passkeyPart(core, passkey, room_id, code) }))
  } finally { zero(passkey.prf) }
}

/** Founds the room with its account. `wayIn`: the way in's part of the sign-up body, sealed for the room id the
 *  core made; the kit's part is added here. room.ts posts the founding once it has that body. `who.account`: the
 *  id, where it is known beforehand (a passkey's challenge named it); else the hub mints it with the account, and
 *  it is read once the device is in. */
async function found(core: Core, device: Opening, who: { email: string | null; account: string | null }, name: AccountName, wayIn: (room_id: Uint8Array, code: Uint8Array) => Pick<NewAccount, 'password' | 'passkey'>): Promise<{ client: Client; kit: Kit }> {
  const code = core.generateRecoveryCode()
  let kit: ReturnType<typeof newKit> | null = null
  try {
    const made = kit = newKit(core, name)
    const account = (room_id: Uint8Array): Record<string, unknown> => {
      const body: NewAccount = { ...(who.email !== null ? { email: who.email } : {}), kit: kitPart(core, made, room_id, code), ...wayIn(room_id, code) }
      return { ...body }
    }
    const { client } = await foundRoom({ ...device, recovery_code: code, account })
    // (the kit is in hand whatever this read does: a kit under the e-mail opens without the id)
    const id = who.account ?? await signedIn(client).hub.account().then(view => view.account, () => null)
    return { client, kit: { words: made.words, email: who.email, account: id, form: made.form } }
  } finally { zero(code); zeroKeys(kit?.keys) }
}

// ---------------------------------------------------------------------------------------------------------------------
// Log in on a new device (8.4)

/**
 * Log in with a password. `account`: the one field of the screen; a password signs in under the account's e-mail,
 * from which its keys are derived, so an account id here is `needs-email` (nothing is sent). The keys are derived
 * with the pinned record before the hub is asked: nothing a hub answers changes what the derivation costs. One
 * refusal for an unknown e-mail and a wrong password, `wrong-login`; the same when the copy the hub hands out does
 * not open for this account and that room.
 */
export async function loginWithPassword(o: Opening & { account: string; password: string }): Promise<{ client: Client }> {
  const { account: named, password, ...device } = o
  const core = await loadCore()
  if (accountName(named).kind !== 'email') throw new AccountError('needs-email', 'a password signs in under the account\'s e-mail')
  const email = core.normaliseEmail(named)
  const keys = core.passwordKeys(email, password)
  try {
    const room = roomOf(await anonymous(device).login(email, keys.authKey))
    return await signIn(core, device, room, passwordWay(keys))
  } finally { zeroKeys(keys) }
}

/**
 * Log in with a passkey: the assertion of a get() over `passkeyChallenge()`, with its prf output. No name is
 * needed (the passkey names its account). Every miss at the hub is `wrong-login`; `no-prf` when the passkey gave no
 * key here (nothing is sent then). The answer must be for the account the passkey itself names: its user handle is
 * the account's id (`wrong-login` for another account's answer; its copy would not open under this passkey either).
 */
export async function loginWithPasskey(o: Opening & { assertion: PasskeyAssertion }): Promise<{ client: Client }> {
  const { assertion: a, ...device } = o
  const core = await loadCore()
  let way: Way | null = null
  try {
    zero(passkeyWay(core, new Uint8Array(32), a).wrap_key)
    const answer = await anonymous(device).passkeyLogin({
      credential_id: a.credential_id, authenticator_data: a.authenticator_data, client_data_json: a.client_data_json, signature: a.signature, user_handle: a.user_handle ?? null,
    })
    if (a.user_handle?.length && hex(a.user_handle) !== answer.account.replaceAll('-', '')) throw new AccountError('wrong-login', 'the answer is for another account than the passkey\'s')
    const room = roomOf(answer)
    way = passkeyWay(core, room.room_id, a)
    return await signIn(core, device, room, way)
  } finally { zero(a.prf, way?.wrap_key) }
}

/** Opens the copy a login answered with and joins that room with the code. The copy is sealed with the room id and
 *  the way in: a hub that hands out another room's copy, or another way's, gets `wrong-login` (`wrong-recovery`
 *  for the kit's). The code must then be the one the room's state names (8.4, room.ts): an older copy joins nothing. */
async function signIn(core: Core, device: Opening, room: LoginAnswer['rooms'][number], way: Way): Promise<{ client: Client }> {
  const code = open(core, way, room.room_id, room.sealed_copy)
  try { return await joinWithCode({ ...device, room_id: hex(room.room_id), code }) } finally { zero(code) }
}

// ---------------------------------------------------------------------------------------------------------------------
// The Emergency Kit and the bare code: forgot password, recovery (8.7, 8.6)

/**
 * The Emergency Kit without a new password: the one field and the words, and this device signs in (8.4). The
 * screen then asks for the way in from now on, and `setPassword` or `addPasskey` with `{ words }` replaces the code
 * (8.6). `account`: an e-mail opens a kit made under the e-mail; an account id opens a kit made under the id (an
 * account without e-mail), and needs the core's `accountIdParse` and `kitKeysFor`. The kit's sheet says which of
 * the two it opens with. One refusal for every miss: `wrong-recovery`; `bad-account` for a text that is neither.
 */
export async function recoverWithKit(o: Opening & { account: string; words: string }): Promise<{ client: Client }> {
  const { account: named, words, ...device } = o
  const core = await loadCore()
  const who = accountName(named)
  const name: AccountName = who.kind === 'email' ? { kind: 'email', email: core.normaliseEmail(who.email) } : { kind: 'id', id: core.accountIdParse(who.account) }
  const keys = kitKeysOf(core, name, words)
  try {
    const answer = await anonymous(device).recover(who.kind === 'email' ? who.email : who.account, keys.authKey)
    // an answer for another account than the one named opens nothing; said before anything is joined
    if (who.kind === 'id' ? answer.account !== who.account : answer.email !== who.email) throw new AccountError('wrong-recovery', 'the answer is for another account than the one named')
    return await signIn(core, device, roomOf(answer), kitWay(keys))
  } finally { zeroKeys(keys) }
}

/**
 * Forgot password: the one field, the Emergency Kit's words and a new password, as ONE request of spec 8.7: the
 * device joins with the code the kit opens, every other human device is removed, the recovery code is replaced, and
 * the finish takes the account's new copies with it: a new Emergency Kit and the password set anew. All or nothing
 * at the hub. The old password, every passkey and the old kit open nothing after it. Returns the new kit, shown
 * once. `wrong-recovery` for every miss, `weak-password`; `needs-email` for an account without e-mail, said before
 * anything is joined (its way in is a passkey: `recoverWithKit`, then `addPasskey`).
 */
export async function resetPassword(o: Opening & { account: string; words: string; new_password: string }): Promise<{ client: Client; kit: Kit }> {
  const { account: named, words, new_password, ...device } = o
  const core = await loadCore()
  core.checkPassword(new_password)
  const who = accountName(named)
  const name: AccountName = who.kind === 'email' ? { kind: 'email', email: core.normaliseEmail(who.email) } : { kind: 'id', id: core.accountIdParse(who.account) }
  const keys = kitKeysOf(core, name, words)
  let password: AccountKeys | null = null
  try {
    const answer = await anonymous(device).recover(who.kind === 'email' ? who.email : who.account, keys.authKey)
    if (who.kind === 'id' ? answer.account !== who.account : answer.email !== who.email) throw new AccountError('wrong-recovery', 'the answer is for another account than the one named')
    // a password's keys are derived from the e-mail: an account without one has none to set
    const email = answer.email
    if (email === null) throw new AccountError('needs-email', 'a password needs an e-mail: this account has none')
    const room = roomOf(answer)
    const code = open(core, kitWay(keys), room.room_id, room.sealed_copy)
    try {
      // ONE request of spec 8.7: the room's recovery, whose finish takes the new code's copies with it: a new kit
      // and the password set anew. All or nothing at the hub: a failure before the finish leaves the account as
      // it was, opened by the words in hand.
      const next = password = core.passwordKeys(email, new_password)
      const made: Kit[] = []
      const copies = (new_code: Uint8Array): Record<string, unknown> => {
        const kit = newKit(core, { kind: 'email', email })
        try {
          const account: AccountCopies = { kit: kitPart(core, kit, room.room_id, new_code), password: passwordPart(core, next, room.room_id, new_code) }
          made.push(kitOf(kit, { email, account: answer.account }))
          return { ...account }
        } finally { zeroKeys(kit.keys) }
      }
      const { client } = await joinWithCode({ ...device, room_id: hex(room.room_id), code, recover: true, account: copies })
      const kit = made.at(-1)
      if (kit === undefined) {
        await stop(client)
        throw new AccountError('internal', 'the recovery asked for no copies of the new code')
      }
      return { client, kit }
    } finally { zero(code) }
  } finally { zeroKeys(keys, password) }
}

/**
 * Recovery with the bare recovery code (8.7), for a room without an account whose id the person has: the device
 * joins, removes every other human device and replaces the code. The new code is the only way back from then on,
 * so `on_recovery_code` is called with it, as it is shown, and has returned, BEFORE anything of the recovery is
 * posted; if it fails, nothing is posted. It must not wait for the person (the hub holds the room for ten
 * minutes): it puts the code on the screen. The code comes back in the result too. `bad-recovery-code` for a text
 * that is no code; `wrong-recovery` when it is not this room's. A room WITH an account is recovered with its
 * Emergency Kit (`resetPassword`, `recoverWithKit`): the hub refuses this one for it (`incomplete`).
 */
export async function recoverWithCode(o: Opening & { room_id: string; code: string; on_recovery_code: (code: string) => unknown }): Promise<{ client: Client; recovery_code: string }> {
  const { room_id: room, code: typed, on_recovery_code, ...device } = o
  const core = await loadCore()
  const room_id = unhex(room)
  if (room_id.length !== 32) throw new AccountError('bad-argument', 'a room id is 32 bytes')
  if (typeof on_recovery_code !== 'function') throw new AccountError('bad-argument', 'the new code must be shown before the recovery: on_recovery_code')
  const code = core.parseRecoveryCode(typed)
  try {
    const told: string[] = []
    const none = async (new_code: Uint8Array): Promise<null> => {
      const text = core.formatRecoveryCode(new_code)
      await on_recovery_code(text)
      told.push(text)
      return null
    }
    const { client } = await joinWithCode({ ...device, room_id: hex(room_id), code, recover: true, account: none })
    const recovery_code = told.at(-1)
    if (recovery_code === undefined) {
      await stop(client)
      throw new AccountError('internal', 'the recovery told no new code')
    }
    return { client, recovery_code }
  } finally { zero(code) }
}

// ---------------------------------------------------------------------------------------------------------------------
// A signed-in device: the account's routes

const statusOf = (v: AccountView): AccountStatus => ({
  email: v.email, account: v.account, kit_form: v.kit_form, revision: v.revision, has_password: v.has_password, has_recovery: true, user_handle: b64u(v.user_handle),
  passkeys: v.passkeys.map(p => ({ credential_id: b64u(p.credential_id), transports: p.transports, created_at: p.created_at, last_used_at: p.last_used_at })),
})
/** The account of this device's room as the hub has it, with its sealed copies; null for a room without one. */
async function viewOf(client: AccountClient): Promise<AccountView | null> {
  try { return await client.hub.account() } catch (e) { if (e instanceof HubError && e.code === 'not-found') return null; throw e }
}
/** The account of the room as the screens see it, or null: a room founded without one. */
export async function accountStatus(client: AccountClient): Promise<AccountStatus | null> {
  const view = await viewOf(client)
  return view ? statusOf(view) : null
}

/** The code in hand on a signed-in device, with the account it was read from and the way that opened it. */
interface Unlocked { view: AccountView; code: Uint8Array; way: Way }
/**
 * The room's recovery code from a way in the person gives again: the account's password, one of its passkeys (the
 * prf output of a get() on the page) or the Emergency Kit's words. `wrong-login` (`wrong-recovery` for the words)
 * when it does not open; `bad-kdf` when the hub names another derivation than the pinned one (nothing is derived
 * then); `wrong-recovery` when the copy opens to a code that is not the room's now (an old copy). The caller
 * forgets the result (`forget`).
 */
async function unlock(client: AccountClient, given: Unlock): Promise<Unlocked> {
  const { core, room_id } = client
  let way: Way | null = null, code: Uint8Array | null = null
  try {
    const view = await viewOf(client)
    if (!view) throw new AccountError('no-account', 'this room has no account yet')
    let copy: Uint8Array
    if ('passkey' in given) {
      const held = view.passkeys.find(p => equal(p.credential_id, given.passkey.credential_id))
      if (!held) throw new AccountError('wrong-login', 'this passkey does not belong to the account')
      way = passkeyWay(core, room_id, given.passkey)
      copy = held.sealed_copy
    } else if ('words' in given) {
      // the kit is opened in the form it was made in, which the account's later e-mail does not change
      if (view.kit_form === 'email' && view.email === null) throw new AccountError('internal', 'a kit under an e-mail the account does not have')
      const keys = kitKeysOf(core, view.kit_form === 'email' ? { kind: 'email', email: view.email! } : { kind: 'id', id: view.user_handle }, given.words)
      zero(keys.authKey)
      way = kitWay(keys)
      copy = view.kit_copy
    } else {
      if (!view.password_copy || view.email === null) throw new AccountError('no-password', 'this account has no password')
      const keys = core.passwordKeys(view.email, given.password, view.kdf ? JSON.stringify(view.kdf) : null)
      zero(keys.authKey)
      way = passwordWay(keys)
      copy = view.password_copy
    }
    code = open(core, way, room_id, copy)
    // a hub can hand out an authentic OLD copy: only the code in force is sealed anew
    await client.checkRecoveryCode(code)
    return { view, way, code }
  } catch (e) {
    zero(way?.wrap_key, code)
    throw e
  } finally { if ('passkey' in given) zero(given.passkey.prf) }
}
const forget = (u: Unlocked | null): void => zero(u?.code, u?.way.wrap_key)
const kitOf = (kit: { words: string; form: KitForm }, view: { email: string | null; account: string }): Kit => ({ words: kit.words, email: view.email, account: view.account, form: kit.form })

/** Does this way in open the account? Asked before a passkey is made, so a wrong password leaves no stray passkey. */
export async function checkUnlock(client: AccountClient, given: Unlock): Promise<void> { forget(await unlock(client, given)) }

/**
 * Add a login to a room that has none (founded without an account). It needs the room's recovery code, which only
 * the person has. Returns the Emergency Kit made with it. `bad-recovery-code` for a text that is no code, and for
 * a code that is not this room's.
 */
export async function addAccount(client: AccountClient, { email: given, password, recovery_code }: { email: string; password: string; recovery_code: string }): Promise<{ kit: Kit }> {
  const { core, hub, room_id } = client
  const email = core.normaliseEmail(given)
  core.checkPassword(password)
  const code = core.parseRecoveryCode(recovery_code)
  let keys: AccountKeys | null = null, kit: ReturnType<typeof newKit> | null = null, body: (NewAccount & { password: NonNullable<NewAccount['password']> }) | null = null
  try {
    // a code of another room would make an account whose copies open nothing here
    await client.checkRecoveryCode(code).catch((e: unknown) => { throw (e as { code?: unknown } | null)?.code === 'wrong-recovery' ? new AccountError('bad-recovery-code', 'this is not the recovery code of this room') : e })
    keys = core.passwordKeys(email, password)
    kit = newKit(core, { kind: 'email', email })
    body = { email, kit: kitPart(core, kit, room_id, code), password: passwordPart(core, keys, room_id, code) }
    const view = await hub.createAccount(body)
    return { kit: kitOf(kit, view) }
  } finally { zero(code, body?.kit.auth_key, body?.password.auth_key); zeroKeys(keys, kit?.keys) }
}

/**
 * A new Emergency Kit for the same code: new words, the code (opened with `given`) sealed under them, replacing the
 * kit before. It is made under the account's e-mail where it has one now, else under its id. `account-changed` when
 * the account changed since it was read.
 */
export async function makeEmergencyKit(client: AccountClient, given: Unlock): Promise<Kit> {
  const { core, hub, room_id } = client
  const u = await unlock(client, given)
  let kit: ReturnType<typeof newKit> | null = null, part: ReturnType<typeof kitPart> | null = null
  try {
    kit = newKit(core, kitNameOf(u.view.email, u.view.user_handle))
    part = kitPart(core, kit, room_id, u.code)
    await hub.putKit({ ...part, revision: u.view.revision })
    return kitOf(kit, u.view)
  } finally { forget(u); zero(part?.auth_key); zeroKeys(kit?.keys) }
}

/** A signed-in device changes the password: the code is sealed anew and the hub swaps the login key. */
export const changePassword = (client: AccountClient, { current, next }: { current: string; next: string }): Promise<{ kit: Kit | null }> => setPassword(client, { unlock: { password: current }, next })

/**
 * A password from any way in: how an account with passkeys only gets one, and the new one after the Emergency Kit.
 * With `{ words }` the kit was the way in, so the code is replaced by 8.6 once the password is set: the copy under
 * the new password and a new kit (returned, shown once); every passkey and the old kit open nothing after it.
 * `weak-password`, `account-changed`; `needs-email` for an account without e-mail (`setEmail` first).
 */
export async function setPassword(client: AccountClient, { unlock: given, next }: { unlock: Unlock; next: string }): Promise<{ kit: Kit | null }> {
  const { core, hub, room_id } = client
  core.checkPassword(next)
  const u = await unlock(client, given)
  let keys: AccountKeys | null = null, part: ReturnType<typeof passwordPart> | null = null
  try {
    if (u.view.email === null) throw new AccountError('needs-email', 'a password needs an e-mail: this account has none')
    keys = core.passwordKeys(u.view.email, next)
    part = passwordPart(core, keys, room_id, u.code)
    const { revision } = await hub.putPassword({ ...part, revision: u.view.revision })
    return { kit: 'words' in given ? await replaceCode(client, u.view, passwordWay(keys), u.code, revision) : null }
  } finally { forget(u); zero(part?.auth_key); zeroKeys(keys) }
}

/**
 * Gives an account without e-mail one, once: a second name for it, and what a password needs. The Emergency Kit
 * it has stays as it is (made under the id). `bad-email`, `account-exists`, `forbidden` when it has one already.
 */
export async function setEmail(client: AccountClient, { email: given }: { email: string }): Promise<void> {
  const email = client.core.normaliseEmail(given)
  const view = await viewOf(client)
  if (!view) throw new AccountError('no-account', 'this room has no account yet')
  await client.hub.putEmail({ email, revision: view.revision })
}

/** A challenge (base64url) for a passkey added to this room's account; the hub binds it to the account as it is
 *  now. The passkey carries the account's id as its user handle (`accountStatus().user_handle`): the hub's answer
 *  must name that id, or the challenge is not used (`bad-passkey`). */
export async function passkeyChallengeFor(client: AccountClient): Promise<string> {
  const [answer, view] = [await client.hub.accountPasskeyChallenge(), await viewOf(client)]
  if (answer.account !== view?.account) throw new AccountError('bad-passkey', 'the challenge names another account')
  return b64u(answer.challenge)
}

/**
 * Add a passkey: the code (opened with `given`) sealed under the new passkey, with its registration (made on the
 * page over `passkeyChallengeFor`). With `{ words }` the code is then replaced by 8.6, as in `setPassword`: this
 * passkey and a new kit are the ways in after it. Returns the passkey's id (base64url) and that kit, if one was made.
 * An error with `passkey_kept` true: the passkey is, or may be, registered with the account.
 */
export async function addPasskey(client: AccountClient, { unlock: given, passkey }: { unlock: Unlock; passkey: PasskeyRegistration }): Promise<{ credential_id: string; kit: Kit | null }> {
  const { core, hub, room_id } = client
  let u: Unlocked | null = null, way: Way | null = null
  try {
    u = await unlock(client, given)
    way = passkeyWay(core, room_id, passkey)
    const added = await hub.addPasskey(passkeyPart(core, passkey, room_id, u.code))
    // the hub read the id out of the attestation; the copy is sealed for the id the page named
    if (!equal(added.credential_id, passkey.credential_id)) {
      await hub.removePasskey(added.credential_id).catch(() => {})
      throw new AccountError('bad-passkey', 'the passkey\'s id is not the one in its registration')
    }
    if (!('words' in given)) return { credential_id: b64u(added.credential_id), kit: null }
    // If the code cannot be replaced, the passkey is taken back and the account is as it was (the kit's words
    // still open it). If it cannot be taken back either, or the replacement may have gone through unanswered, the
    // error says `passkey_kept`: the passkey may be a way in, and the screen must not tell its store to drop it.
    try { return { credential_id: b64u(added.credential_id), kit: await replaceCode(client, u.view, way, u.code, u.view.revision + 1) } } catch (e) {
      const gone = await hub.removePasskey(added.credential_id).then(() => true, () => false)
      throw gone ? e : kept(e)
    }
  } finally { forget(u); zero(way?.wrap_key, passkey.prf) }
}

/** Marks an error of a step after which a passkey may be registered: the screen keeps the passkey then. */
const kept = (e: unknown): unknown => (e instanceof Error ? Object.assign(e, { passkey_kept: true }) : e)

/** Remove a passkey (its id, base64url). `last-way-in` when the account has no password and no other passkey: the
 *  hub decides that in the transaction that would remove it. */
export const removePasskey = (client: AccountClient, credential_id: string): Promise<void> => client.hub.removePasskey(unb64u(credential_id))

/**
 * Replace the room's recovery code (8.6): for after a human device was removed that is not in the person's hands.
 * The way in given again (the password or a passkey) keeps its copy, under the new code, and a new Emergency Kit
 * comes back; every other way in is removed and set up again by the person.
 */
export async function replaceRecoveryCode(client: AccountClient, given: Unlock): Promise<Kit> {
  if ('words' in given) throw new AccountError('bad-argument', 'after the Emergency Kit the code is replaced with the new way in: setPassword or addPasskey')
  const u = await unlock(client, given)
  try { return await replaceCode(client, u.view, u.way, u.code, u.view.revision) } finally { forget(u) }
}

/**
 * 8.6 as one request of the client: the core makes a new code (it needs `code`, the one in force), and the account
 * gets its copy under `way` (the way in used or set just now) and one under a new Emergency Kit; the hub removes
 * every other way in with it, whole or not at all. The new kit is not the only way in when it comes back: `way`
 * opens the account too.
 *
 * `revision`: the account's revision when `way` was read or set. The hub takes the copies without a revision, so
 * the account is read once more first and the replacement is not made if it changed meanwhile (`account-changed`):
 * a password changed on another device in between would otherwise keep its login key over a copy sealed under the
 * password of before. (That check and the request are two steps; the hub closes the rest when it takes a revision
 * with the copies.)
 */
async function replaceCode(client: AccountClient, view: AccountView, way: Way, code: Uint8Array, revision: number): Promise<Kit> {
  const { core, room_id } = client
  if ((await viewOf(client))?.revision !== revision) throw new AccountError('account-changed', 'the account changed meanwhile: try again')
  const made: Kit[] = []
  const copies = (new_code: Uint8Array): Record<string, unknown> => {
    const kit = newKit(core, kitNameOf(view.email, view.user_handle))
    try {
      const copy = sealed(core, way, room_id, new_code)
      const account: AccountCopies = {
        kit: kitPart(core, kit, room_id, new_code),
        ...(way.name === 'passkey' && way.credential_id ? { passkey: { credential_id: way.credential_id, sealed_copy: copy } } : { password: { sealed_copy: copy } }),
      }
      made.push(kitOf(kit, view))
      return { ...account }
    } finally { zeroKeys(kit.keys) }
  }
  await client.replaceRecoveryCode({ code, account: copies })
  const kit = made.at(-1)
  if (kit === undefined) throw new AccountError('internal', 'the replacement asked for no copies of the new code')
  return kit
}
