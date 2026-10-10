// worker-protocol.ts: the messages between the page (remote.ts) and the client core in its worker (core-worker.ts).
// Every message is structured-clone data. Calls are answered in order of their completion; changes come in the order
// the core made them, and a call's own changes (an optimistic echo) always arrive before its answer.
import type { ModelPatch, ModelSnapshot } from './mirror.ts'

/** An error as it travels: name, message and its own fields (code, status, retry_after, …). */
export interface WireError { name: string; message: string; [field: string]: unknown }

/** Where the device is stored: the name of its IndexedDB databases (store-idb.ts). */
export interface StorageName { name: string }
/** What the page sends. */
export type ToWorker =
  | { t: 'open'; id: number; storage: StorageName; client: string | null }
  | { t: 'call'; id: number; method: string; args: unknown[] }
  /** An account screen's step that makes a room (ACCOUNT_OPENS), its arguments without storage; answered by 'opened'. */
  | { t: 'account'; id: number; fn: string; args: Record<string, unknown>; storage: StorageName; client: string | null }
  /** Join with an invite link (room.ts joinRoom): 'join-code' when the check code is there, 'opened' once added. */
  | { t: 'join'; id: number; args: Record<string, unknown>; storage: StorageName; client: string | null }
  /** The page took an event that asked for it (`ack` on the event): `ok` false when its handler failed. */
  | { t: 'ack'; ack: number; ok: boolean }

/** What the worker sends. */
export type FromWorker =
  | { t: 'ready' }
  /** `value`: everything the step returned beside its client (a new account's Emergency Kit, a new recovery code). */
  | { t: 'opened'; id: number; model: ModelSnapshot | null; error?: WireError; extra: Extra; value?: unknown }
  | { t: 'result'; id: number; ok: true; value: unknown }
  | { t: 'result'; id: number; ok: false; error: WireError }
  | { t: 'change'; patch: ModelPatch }
  | { t: 'snapshot'; model: ModelSnapshot; extra: Extra }
  /** `ack`: the worker waits until the page answers with that number ('recovery-code': the new code is on screen). */
  | { t: 'event'; event: 'alert' | 'error' | 'reset' | 'join-code' | 'recovery-code'; data: unknown; ack?: number }

/** What travels beside the model: the client's counters and this tab's role (tabs.ts). */
export interface Extra { stats?: Record<string, number> | null; tabRole?: string | null; [k: string]: unknown }

/** The client's methods the page may call (README.md "Human actions", "Sessions and keys", timelines,
 *  attachments, push), by name. Anything else is refused in the worker. `writeSnapshot` is gone with protocol v1's
 *  room snapshots (no view calls it); `sendStrokePiece` is new (spec 7.2). */
export const CALLS: readonly string[] = Object.freeze([
  // life
  'start', 'stop', 'flush', 'settle', 'catchUp',
  // human actions
  'sendMessage', 'answer', 'trust', 'markRead', 'shred', 'decideAgain', 'verdict', 'setRegisters', 'setDraft', 'snooze',
  'duck', 'setCrown', 'setDesk', 'saveNote', 'deleteNote', 'sendStrokes', 'sendStrokePiece', 'createInvite', 'confirmInvite', 'removeDevices',
  'leaveRoom',
  // timelines and attachments
  'loadTimeline', 'timelineWindow', 'loadTimelineAfter', 'uploadAttachment', 'fetchAttachment', 'attachmentBlob',
  'shareAttachment', 'myShares', 'revokeShare',
  // push
  'pushSubscribe', 'pushStates',
])
/** What the worker adds to a client for the page (core-worker.ts): the account's routes, the hub's Web Push key,
 *  the app's name for the hub. */
export const HOST_CALLS: readonly string[] = Object.freeze(['account', 'pushKey', 'configure'])
/** account.ts functions that make a room (run in the worker, which then holds it). */
export const ACCOUNT_OPENS: readonly string[] = Object.freeze(['createAccount', 'createAccountWithPasskey', 'loginWithPassword', 'loginWithPasskey', 'resetPassword', 'recoverWithKit', 'recoverWithCode'])
/** account.ts functions that take the signed-in client (run in the worker on its client). */
export const ACCOUNT_CALLS: readonly string[] = Object.freeze(['accountStatus', 'addAccount', 'makeEmergencyKit', 'changePassword', 'setPassword', 'checkUnlock', 'passkeyChallengeFor', 'addPasskey', 'removePasskey', 'replaceRecoveryCode'])
