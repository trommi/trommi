// session-grants.d.mts: the TypeScript view of session-grants.mjs (R6: per-session keys). The JavaScript stays as it is;
// keep this in step with it.
import type { Bytes, Device, LogState, Secret } from './zcrypto.mjs'

type Obj = { [field: string]: any }

/** A verified grant chain of one session (applyGrant, verifyGrants); ids as hex. */
export interface SessionState {
  sessionId: string; grantNumber: number; grantHash: Bytes; epoch: number; agentIds: string[]; withHistory: boolean
  keyCommit: Bytes; histCommit: Bytes; manifestHash: Bytes; logSeq: number; signerId: string; time: number
  epochs: Map<number, { keyCommit: Bytes; histCommit: Bytes; withHistory: boolean }>
  creatorId: string; createdByAgent: boolean; stale: boolean
  [field: string]: any
}
/** A grant as decodeGrant reads it (ids as bytes). */
export interface Grant { roomId: Bytes; sessionId: Bytes; grantNumber: number; epoch: number; withHistory: boolean; agentIds: Bytes[]; logSeq: number; time: number; signerId: Bytes; body: Bytes; signature: Bytes; [field: string]: any }

export const OBJ_GRANT: number
export const OBJ_SESSION_BACK_LINK: number
export const LABEL: Readonly<Record<string, string>>
export function newSessionSecret(epoch: number): Secret
export function sessionCommits(sessionId: Bytes, secret: Secret): Promise<Obj>
export function wrapSessionKey(args: { roomId: Bytes; sessionId: Bytes; secret: Secret; recipients: { id: Bytes; kexPub: Bytes; withHist?: boolean }[] }): Promise<{ id: Bytes; sealed: Bytes }[]>
export function grantManifestHash(wraps: { id: Bytes; sealed: Bytes }[]): Promise<Bytes>
export function unwrapSessionKey(args: { roomId: Bytes; sessionState: SessionState; device: Device; sealed: Bytes; epoch: number }): Promise<Secret>
export function makeSessionBackLink(args: { roomId: Bytes; sessionId: Bytes; secret: Secret; previous: Secret }): Promise<Bytes>
export function openSessionBackLink(args: { roomId: Bytes; sessionState: SessionState; secret: Secret; link: Bytes }): Promise<Secret>
export function decodeGrant(bytes: Bytes): Grant
export function createSessionGrant(args: Obj): Promise<{ grant: Uint8Array<ArrayBuffer>; secret: Secret; wraps: { id: Bytes; sealed: Bytes }[]; backLink: Bytes | null; sessionState: SessionState }>
export function applyGrant(sessionState: SessionState | null, grantBytes: Bytes, roomState: LogState): Promise<SessionState>
export function lastMemberChange(roomState: LogState): number
export function grantIsStale(sessionState: SessionState | null | undefined, roomState: LogState): boolean
export function verifyGrants(grants: Bytes[], roomState: LogState): Promise<SessionState>
