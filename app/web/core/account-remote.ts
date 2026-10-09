// account-remote.ts: the account (account.ts) as the page uses it. Everything slow or secret runs in the core
// worker: creating an account, logging in, the Emergency Kit's ways back and joining with a link run in a new core
// worker (remote.ts), which then holds the room, and the page gets its RemoteClient; the account's routes of a
// signed-in device (a new kit, a new password, a passkey, …) run in the worker of that device's RemoteClient. The
// page's thread never loads the core: no key is derived on it and no sealed copy is opened on it.
//
// What stays on the page is light and holds no key (passwords.ts, passkey.ts): a form's own checks, a generated
// password, the hub's challenge for a passkey and the prf input. WebAuthn's prompts are the page's too
// (public/auth.mjs); these functions carry what a ceremony returned, the prf output with it, into the worker.
//
// A page without workers cannot run the core: every step that needs it fails with `worker-failed`, which the
// screens word.
import { accountInWorker, joinInWorker, type RemoteClient } from './remote.ts'
import type { AccountStatus, Kit, PasskeyRegistration, Unlock } from './account.ts'
import { PASSKEY_PRF_INPUT, passkeyChallenge as challengeFromHub } from './passkey.ts'

export { PASSWORD_MIN, normaliseEmail, passwordProblem, generatePassword, parseRecoveryWords } from './passwords.ts'

type Args = Record<string, unknown> & { client?: string | null }
type Opened = { client: RemoteClient }
/** A step of account.ts that makes this device's room (worker-protocol.ts ACCOUNT_OPENS). */
type Opens = 'createAccount' | 'createAccountWithPasskey' | 'loginWithPassword' | 'loginWithPasskey' | 'resetPassword' | 'recoverWithKit' | 'recoverWithCode'

/** A step that makes a room, in a new core worker. `onEvent`: what the worker says before it is done; what it
 *  returns (or throws) is the page's answer to that event. */
async function opening<T extends Opened>(fn: Opens, args: Args, onEvent?: (event: string, data: unknown) => unknown): Promise<T> {
  if (typeof Worker !== 'function') throw Object.assign(new Error('this browser runs no workers'), { code: 'worker-failed' })
  const options = { client: args.client ?? null, ...(onEvent ? { onEvent } : {}) }
  return await accountInWorker(fn, args, options) as unknown as T
}
export const createAccount = (args: Args) => opening<Opened & { kit: Kit }>('createAccount', args)
export const createAccountWithPasskey = (args: Args) => opening<Opened & { kit: Kit }>('createAccountWithPasskey', args)
export const loginWithPassword = (args: Args) => opening<Opened>('loginWithPassword', args)
export const loginWithPasskey = (args: Args) => opening<Opened>('loginWithPasskey', args)
export const recoverWithKit = (args: Args) => opening<Opened>('recoverWithKit', args)
export const resetPassword = (args: Args) => opening<Opened & { kit: Kit }>('resetPassword', args)
/** `on_recovery_code` cannot cross to the worker as a function: the worker says the new code as its event
 *  `recovery-code` before anything of the recovery is posted, waits until the page has taken it (remote.ts), and
 *  the code is shown here. A recovery without it is refused in the worker. */
export function recoverWithCode({ on_recovery_code, ...args }: Args & { on_recovery_code: (code: string) => unknown }) {
  return opening<Opened & { recovery_code: string }>('recoverWithCode', args, (event, data) => (event === 'recovery-code' ? on_recovery_code(String(data)) : undefined))
}

// The light parts of a passkey ceremony, on the page beside navigator.credentials (passkey.ts).
export const passkeyChallenge = (args: { hub_url: string; client?: string | null }): Promise<string> => challengeFromHub(args)
export const passkeyPrfInput = async (): Promise<Uint8Array<ArrayBuffer>> => PASSKEY_PRF_INPUT

/** A route of the signed-in device's account, in its worker (worker-protocol.ts ACCOUNT_CALLS). */
const onClient = <T>(fn: string, client: RemoteClient, args?: unknown): Promise<T> => client.call('account', fn, args) as Promise<T>
export const accountStatus = (client: RemoteClient) => onClient<AccountStatus | null>('accountStatus', client)
export const addAccount = (client: RemoteClient, args: { email: string; password: string; recovery_code: string }) => onClient<{ kit: Kit }>('addAccount', client, args)
export const makeEmergencyKit = (client: RemoteClient, args: Unlock) => onClient<Kit>('makeEmergencyKit', client, args)
export const changePassword = (client: RemoteClient, args: { current: string; next: string }) => onClient<{ kit: Kit | null }>('changePassword', client, args)
export const setPassword = (client: RemoteClient, args: { unlock: Unlock; next: string }) => onClient<{ kit: Kit | null }>('setPassword', client, args)
export const checkUnlock = (client: RemoteClient, args: Unlock) => onClient<void>('checkUnlock', client, args)
export const passkeyChallengeFor = (client: RemoteClient) => onClient<string>('passkeyChallengeFor', client)
export const addPasskey = (client: RemoteClient, args: { unlock: Unlock; passkey: PasskeyRegistration }) => onClient<{ credential_id: string; kit: Kit | null }>('addPasskey', client, args)
export const removePasskey = (client: RemoteClient, credential_id: string) => onClient<void>('removePasskey', client, credential_id)
export const replaceRecoveryCode = (client: RemoteClient, args: Unlock) => onClient<Kit>('replaceRecoveryCode', client, args)

/** Join with an invite link (room.ts joinRoom's shape), in a new core worker. */
export function joinRoom(args: Args): { check_code: Promise<string>; client: Promise<RemoteClient>; cancel(): void } {
  return joinInWorker(args, { client: args.client ?? null })
}
