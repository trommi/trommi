// worker-protocol.ts: the messages between the page (remote.ts) and the client core in its worker (core-worker.ts).
// Every message is structured-clone data. Calls are answered in order of their completion; changes come in the order
// the core made them, and a call's own changes (an optimistic echo) always arrive before its answer.
import type { ModelPatch, ModelSnapshot } from './mirror.ts'

/** An error as it travels: name, message and its own fields (code, status, retry_after, …). */
export interface WireError { name: string; message: string; [field: string]: unknown }

/** What the page sends. */
export type ToWorker =
  | { t: 'open'; id: number; storage: { name: string; prefix: string }; client: string | null }
  | { t: 'call'; id: number; method: string; args: unknown[] }
  /** An account screen's step that makes a room (ACCOUNT_OPENS), its arguments without storage; answered by 'opened'. */
  | { t: 'account'; id: number; fn: string; args: Record<string, unknown>; storage: { name: string; prefix: string }; client: string | null }
  /** Join with an invite link (room.ts joinRoom): 'join-code' when the check code is there, 'opened' once added. */
  | { t: 'join'; id: number; args: Record<string, unknown>; storage: { name: string; prefix: string }; client: string | null }

/** What the worker sends. */
export type FromWorker =
  | { t: 'ready' }
  | { t: 'opened'; id: number; model: ModelSnapshot | null; error?: WireError; extra: Extra; value?: unknown }
  | { t: 'result'; id: number; ok: true; value: unknown }
  | { t: 'result'; id: number; ok: false; error: WireError }
  | { t: 'change'; patch: ModelPatch }
  | { t: 'snapshot'; model: ModelSnapshot; extra: Extra }
  | { t: 'event'; event: 'alert' | 'error' | 'reset' | 'join-code'; data: unknown }

/** What travels beside the model: the client's counters and this tab's role (tabs.ts). */
export interface Extra { stats?: Record<string, number> | null; tabRole?: string | null; [k: string]: unknown }

/** The client's methods the page may call (core/README.md "Human actions", "Sessions and keys", timelines,
 *  attachments, push), by name. Anything else is refused in the worker. */
export const CALLS: readonly string[] = Object.freeze([
  // life
  'start', 'stop', 'flush', 'settle', 'catchUp',
  // human actions (tabs.ts FORWARDED)
  'sendMessage', 'answer', 'trust', 'markRead', 'shred', 'decideAgain', 'verdict', 'setRegisters', 'setDraft', 'snooze',
  'duck', 'setCrown', 'setDesk', 'saveNote', 'deleteNote', 'sendStrokes', 'createInvite', 'confirmInvite', 'removeDevices',
  'createSession', 'assignSession', 'leaveRoom', 'writeSnapshot',
  // timelines and attachments
  'loadTimeline', 'timelineWindow', 'loadTimelineAfter', 'uploadAttachment', 'fetchAttachment', 'attachmentBlob',
  'shareAttachment', 'myShares', 'revokeShare',
  // push
  'pushSubscribe', 'pushStates',
])

/** account.ts functions that make a room (run in the worker, which then holds it). */
export const ACCOUNT_OPENS: readonly string[] = Object.freeze(['createAccount', 'createAccountWithPasskey', 'loginWithPassword', 'loginWithPasskey', 'resetPassword', 'recoverWithKit'])
/** account.ts functions that take the signed-in client (run in the worker on its client). */
export const ACCOUNT_CALLS: readonly string[] = Object.freeze(['accountStatus', 'addAccount', 'makeEmergencyKit', 'changePassword', 'setPassword', 'checkUnlock', 'passkeyChallengeFor', 'addPasskey', 'removePasskey', 'verifyEmail', 'resendEmailCode'])
