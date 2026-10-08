// account-remote.ts: the account (account.ts) as the page uses it, with its slow and secret parts in the core worker.
// Creating an account, logging in, a new password from the Emergency Kit and joining with a link run in a new core
// worker (remote.ts), which then holds the room: the page gets a RemoteClient, and Argon2id, the room's founding or
// joining crypto and the device keys never run on the page's thread. The account routes of a signed-in device (a new
// kit, a new password, …) run in the worker of that device's RemoteClient. The light parts (the password rule,
// generated passwords) are the same functions as account.ts. A page without workers, or with ?core=page, runs it all
// here as before (account.ts, room.ts).
import { accountInWorker, joinInWorker, type RemoteClient } from './remote.ts'
import type { AccountClient } from './account.ts'
import { joinRoom as joinHere } from './room.ts'

export { PASSWORD_MIN, normaliseEmail, passwordProblem, generatePassword, generateRecoveryWords, parseRecoveryWords } from './passwords.ts'

type Args = Record<string, unknown> & { client?: string | null }
const local = () => import('./account.ts')
const isRemote = (c: unknown): c is RemoteClient => !!c && typeof (c as RemoteClient).call === 'function' && !!(c as RemoteClient).worker

/** The same rule as core-start.ts: workers, unless this tab asked for the core in the page (?core=page). */
export function workerWanted(): boolean {
  if (typeof Worker !== 'function') return false
  try { return (new URLSearchParams(location.search).get('core') ?? sessionStorage.getItem('trommi-core')) !== 'page' } catch { return true }
}
const workerFailed = (e: unknown) => ['worker-failed', 'worker-timeout'].includes((e as { code?: string } | null)?.code ?? '')

/** A step that makes a room: in a worker, else (no worker, or one that does not come up) here. */
async function opening<T>(fn: 'createAccount' | 'loginWithPassword' | 'resetPassword', args: Args): Promise<T> {
  if (workerWanted()) {
    try { return await accountInWorker(fn, args, { client: args.client ?? null }) as T }
    catch (e) { if (!workerFailed(e)) throw e; console.warn('core worker:', (e as Error).message, '(the account step runs in the page)') }
  }
  return ((await local())[fn] as unknown as (a: Args) => Promise<T>)(args)
}
export const createAccount = (args: Args) => opening<{ client: RemoteClient | AccountClient; recovery_code: string }>('createAccount', args)
export const loginWithPassword = (args: Args) => opening<{ client: RemoteClient | AccountClient }>('loginWithPassword', args)
export const resetPassword = (args: Args) => opening<{ client: RemoteClient | AccountClient }>('resetPassword', args)

/** A route of the signed-in device's account: in its worker, or here for a client of the page. */
async function onClient<T>(fn: string, client: AccountClient | RemoteClient, args?: unknown): Promise<T> {
  if (isRemote(client)) return client.call('account', fn, args) as Promise<T>
  return ((await local()) as unknown as Record<string, (c: unknown, a: unknown) => Promise<T>>)[fn]!(client, args)
}
export const accountStatus = (client: AccountClient | RemoteClient) => onClient<Record<string, unknown> | null>('accountStatus', client)
export const addAccount = (client: AccountClient | RemoteClient, args: { email: string; password: string; recovery_code: string }) => onClient<unknown>('addAccount', client, args)
export const makeEmergencyKit = (client: AccountClient | RemoteClient, args: { recovery_code?: string | null; password?: string | null } = {}) => onClient<{ words: string; email: string }>('makeEmergencyKit', client, args)
export const changePassword = (client: AccountClient | RemoteClient, args: { current: string; next: string }) => onClient<void>('changePassword', client, args)
export const verifyEmail = (client: AccountClient | RemoteClient, code: unknown) => onClient<unknown>('verifyEmail', client, code)
export const resendEmailCode = (client: AccountClient | RemoteClient) => onClient<unknown>('resendEmailCode', client)

/** Join with an invite link (room.ts joinRoom's shape), in a worker when the page has them. */
export function joinRoom(args: Args): { check_code: Promise<string>; client: Promise<unknown>; cancel(): void } {
  return workerWanted() ? joinInWorker(args, { client: args.client ?? null }) : joinHere(args as never)
}
