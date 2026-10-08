// codec.ts: the encrypted body's payload (UTF-8 JSON, schema_version 1) for the seven envelope kinds,
// the names of header values, and attachment references. README "Inside the envelope: the body".
import * as z from './crypto/zcrypto.mjs'
import type { AttachmentRef, Bind, Body, ContentState, KindName } from './types.ts'

export const SCHEMA_VERSION = 1
const te = new TextEncoder()
const td = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })   // R5: bad UTF-8 or a BOM is refused, never repaired

export const KIND = Object.freeze({ timeline_item: 1, object_version: 2, answer: 3, permission_request: 4, verdict: 5, status: 6, decide_again: 7 } as const)
export const KIND_NAME: Readonly<Record<number, KindName | 'scribble'>> = Object.freeze({ 1: 'timeline_item', 2: 'object_version', 3: 'answer', 4: 'permission_request', 5: 'verdict', 6: 'status', 7: 'decide_again', 8: 'scribble' })
export const OBJECT_STATE = Object.freeze({ open: 1, answered: 2, closed: 3 } as const)
export const OBJECT_STATE_NAME: Readonly<Record<number, 'open' | 'answered' | 'closed'>> = Object.freeze({ 1: 'open', 2: 'answered', 3: 'closed' })
export const URGENCY = Object.freeze({ low: 0, normal: 1, high: 2, critical: 3 } as const)
export const URGENCY_NAME: Readonly<Record<number, 'low' | 'normal' | 'high' | 'critical'>> = Object.freeze({ 0: 'low', 1: 'normal', 2: 'high', 3: 'critical' })
export const TIMELINE_KIND = Object.freeze({ chat: 1, scribble: 2 } as const)
export const TIMELINE_KIND_NAME: Readonly<Record<number, 'chat' | 'scribble'>> = Object.freeze({ 1: 'chat', 2: 'scribble' })

/** Body fields per kind (besides schema_version), exactly the README names. Unknown fields are dropped on encode, kept on decode. */
export const FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  message: ['content_type', 'text', 'details', 'html', 'attachments', 'hand_back', 'explain', 'present_card', 'copied_cards', 'marks', 'published_object_id', 'note'],
  strokes: ['content_type', 'strokes', 'attachments'],
  erase: ['content_type', 'stroke_ids', 'offset'],
  move: ['content_type', 'stroke_ids', 'offset'],
  send_away: ['content_type', 'stroke_ids', 'offset'],
  selection_sent: ['content_type', 'text', 'attachments', 'stroke_ids', 'board'],
  card: ['object_type', 'object_version', 'previous_version_hash', 'card_type', 'title', 'teaser', 'body', 'options', 'sections', 'html', 'allows_multiple',
    'recommended', 'urgency_reason', 'attachments', 'change_note', 'close_summary', 'withdraw_reason', 'merged_into_object_id', 'merged_from_object_ids'],
  note: ['object_type', 'object_version', 'previous_version_hash', 'text'],
  published: ['object_type', 'object_version', 'previous_version_hash', 'attachments', 'title', 'note', 'released_until'],
  answer: ['answer_action', 'choices', 'note', 'option_notes', 'attachments', 'marks', 'trusted'],
  permission_request: ['tool_name', 'description', 'input_preview', 'withdraw_reason'],
  verdict: [],
  status: ['values', 'lamport'],
  decide_again: [],
})
export const CARD_CONTENT_FIELDS: readonly string[] = FIELDS['card']!.slice(3)

// ---- what this version knows (README "Versioning and compatibility") --------------------------------------------
// Anything else a newer client may write: it is verified and kept, never applied as something it is not, and shown
// as "needs a newer Trommi" (model.newer, item_state 'unsupported', card.unsupported).
/** Timeline item content types. */
export const CONTENT_TYPES: readonly string[] = Object.freeze(Object.keys(FIELDS).filter(k => FIELDS[k]![0] === 'content_type'))
/** Object types (object_version bodies). */
export const OBJECT_TYPES: readonly string[] = Object.freeze(['card', 'note', 'published'])
/** A card's card_type. */
export const CARD_TYPES: readonly string[] = Object.freeze(['decision', 'info'])
/** An answer's answer_action. */
export const ANSWER_ACTIONS: readonly string[] = Object.freeze(['answer', 'read', 'shred'])
/** What every client says (or shows) when it meets something only a newer version understands. */
export const UPDATE_MESSAGE = 'This needs a newer version of Trommi. Update to see it.'

/** A card's `teaser` (README "card"): the two short lines the Desk row shows under the title. Optional plain text:
 *  a string, already trimmed, not empty, no control characters (no line breaks), at most TEASER_MAX characters. */
export const TEASER_MAX = 160
export function teaserValid(t: unknown): t is string {
  return typeof t === 'string' && t.length > 0 && t === t.trim() && [...t].length <= TEASER_MAX && !/[\u0000-\u001f\u007f]/.test(t)
}

export const ATTACHMENT_FIELDS: readonly string[] = ['attachment_id', 'file_key', 'sha256', 'file_name', 'media_type', 'total_size', 'width', 'height', 'caption', 'page', 'poster_attachment_id', 'marks']

/** A body as the codec handles it: a JSON object. */
export type Content = Record<string, unknown>
/** Notes carry whatever the app puts on them (place, session, to, …): their fields are app-defined. */
export const PASS_THROUGH: unique symbol = Symbol('pass-through')
type Fields = readonly string[] | typeof PASS_THROUGH

function pick(src: Content, fields: Fields): Content {
  const out: Content = { schema_version: SCHEMA_VERSION }
  if (fields === PASS_THROUGH) { for (const [k, v] of Object.entries(src)) if (v !== undefined && k !== 'schema_version') out[k] = v; return out }
  for (const f of fields) if (src[f] !== undefined) out[f] = src[f]
  return out
}

/** The field list for a body: by kind, and for timeline items and objects by content_type / object_type. */
export function fieldsFor(kind: number, content: Content): Fields {
  switch (kind) {
    case KIND.timeline_item: {
      const f = FIELDS[String(content['content_type'])]
      if (!f) throw new z.ZError('bad-argument', `unknown content_type ${String(content['content_type'])}`)
      return f
    }
    case KIND.object_version: {
      if (content['object_type'] === 'note') return PASS_THROUGH
      const f = FIELDS[String(content['object_type'])]
      if (!f) throw new z.ZError('bad-argument', `unknown object_type ${String(content['object_type'])}`)
      return f
    }
    default: {
      const f = FIELDS[KIND_NAME[kind] ?? '']
      if (!f) throw new z.ZError('bad-argument', `unknown kind ${kind}`)
      return f
    }
  }
}

const HEX32 = /^[0-9a-f]{32}$/

/** A message's `note`: the note of the human it was sent from (README "message"): { object_id: 32 hex, written_at: ms }.
 *  Nothing else in it, written_at a whole number of ms within 0..2^53 (or null). */
export function noteRefValid(v: unknown): v is { object_id: string; written_at?: number | null } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const m = v as Content
  if (Object.keys(m).some(k => k !== 'object_id' && k !== 'written_at')) return false
  if (!(typeof m['object_id'] === 'string' && HEX32.test(m['object_id']))) return false
  const at = m['written_at']
  return at == null || (typeof at === 'number' && Number.isSafeInteger(at) && at >= 0)
}

/** An option whose `final` is anything but true. */
const hasNonFinal = (o: unknown): boolean => !!o && typeof o === 'object' && 'final' in o && o.final !== true
/** A card's options as they are sent: `final` only where it is true (README "card"). */
const plainOptions = (options: unknown[]): unknown[] => options.map(o => { if (!o || typeof o !== 'object' || !hasNonFinal(o)) return o; const { final: _final, ...rest } = o as Content; return rest })

export function encodePayload(kind: number, content: Content): Uint8Array {
  if (kind === KIND.object_version && content['object_type'] === 'card' && Array.isArray(content['options']) && content['options'].some(hasNonFinal)) content = { ...content, options: plainOptions(content['options']) }
  if (kind === KIND.timeline_item && content['content_type'] === 'message' && content['note'] !== undefined && !noteRefValid(content['note'])) throw new z.ZError('bad-argument', 'note must be { object_id: 32 hex, written_at?: ms }')
  if (kind === KIND.object_version && content['object_type'] === 'card' && content['teaser'] != null && !teaserValid(content['teaser'])) throw new z.ZError('bad-argument', `teaser must be plain one-paragraph text, trimmed, at most ${TEASER_MAX} characters`)
  return te.encode(JSON.stringify(pick(content, fieldsFor(kind, content))))
}

export interface Decoded { content: Body | null; content_state: Extract<ContentState, 'ok' | 'newer_schema' | 'undecryptable'> }
/** -> { content, content_state: 'ok' | 'newer_schema' | 'undecryptable' } */
export function decodePayload(bytes: Uint8Array): Decoded {
  let parsed: unknown
  try { const text = td.decode(bytes); if (text.charCodeAt(0) === 0xfeff) throw new Error('bom'); parsed = JSON.parse(text) } catch { return { content: null, content_state: 'undecryptable' } }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { content: null, content_state: 'undecryptable' }
  const content = parsed as Content
  if (!attachmentIdsValid(content)) return { content: null, content_state: 'undecryptable' }   // a ref id is not hex: refuse the body
  if ((content['schema_version'] as number) > SCHEMA_VERSION) return { content, content_state: 'newer_schema' }
  if (content['content_type'] === 'message' && content['note'] !== undefined && !noteRefValid(content['note'])) delete content['note']   // a bad note mark: the message stays, plain
  if (content['object_type'] === 'card' && content['teaser'] != null && !teaserValid(content['teaser'])) delete content['teaser']   // a bad teaser: the Desk falls back to the body
  // An option's `final` is true or absent: anything else is dropped, so every client reads the same.
  if (content['object_type'] === 'card' && Array.isArray(content['options'])) for (const o of content['options'] as unknown[]) if (hasNonFinal(o)) delete (o as Content)['final']
  return { content, content_state: 'ok' }
}

/** Every attachment_id / poster_attachment_id anywhere in a body is 32 lowercase hex (they reach URLs and file names). */
export function attachmentIdsValid(content: unknown, depth = 0): boolean {
  if (depth > 32) return false
  if (Array.isArray(content)) return content.every(v => attachmentIdsValid(v, depth + 1))
  if (!content || typeof content !== 'object') return true
  for (const [k, v] of Object.entries(content)) {
    if ((k === 'attachment_id' || k === 'poster_attachment_id') && v != null && !(typeof v === 'string' && HEX32.test(v))) return false
    if (v && typeof v === 'object' && !attachmentIdsValid(v, depth + 1)) return false
  }
  return true
}

type RefLike = { attachment_id?: string | null; poster_attachment_id?: string | null } | null | undefined
/** The attachment ids a body references (they go into the header's blob list). */
export function attachmentIdsOf(content: { attachments?: unknown; values?: unknown } | null | undefined): string[] {
  const ids = new Set<string>()
  const add = (list: unknown) => { for (const a of (Array.isArray(list) ? list : []) as RefLike[]) if (a?.attachment_id) { ids.add(a.attachment_id); if (a.poster_attachment_id) ids.add(a.poster_attachment_id) } }
  add(content?.attachments)
  const values = content?.values
  if (values && typeof values === 'object') for (const v of Object.values(values) as ({ attachment?: RefLike } | null)[]) if (v?.attachment?.attachment_id) add([v.attachment])
  return [...ids]
}

/** Build the README attachment reference from an encryptAsset result. */
export function attachmentRef(asset: { blobId: Uint8Array; key: Uint8Array; sha256: Uint8Array; size: number }, meta: Record<string, unknown> = {}): AttachmentRef {
  const ref: Record<string, unknown> = { attachment_id: z.hex(asset.blobId), file_key: z.b64u(asset.key), sha256: z.b64u(asset.sha256), total_size: asset.size }
  for (const f of ATTACHMENT_FIELDS) if (meta[f] !== undefined && ref[f] === undefined) ref[f] = meta[f]
  return ref as unknown as AttachmentRef
}

/** Header values to names, and the bind's byte fields to hex. */
const BOUND: readonly number[] = [KIND.answer, KIND.permission_request, KIND.verdict, KIND.decide_again]
export function decodeBindFor(kind: number, bind: Uint8Array): Bind | null {
  if (!BOUND.includes(kind)) return null
  const b = z.decodeBind(kind, bind) as Record<string, unknown>
  const out: Bind = {}
  for (const [k, v] of Object.entries(b)) out[k] = v instanceof Uint8Array ? z.hex(v) : v
  return out
}
