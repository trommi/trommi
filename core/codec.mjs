// codec.mjs: the encrypted body's payload (UTF-8 JSON, schema_version 1) for the seven envelope kinds,
// the names of header values, and attachment references. README "Inside the envelope: the body".
import * as z from './zcrypto.mjs'

export const SCHEMA_VERSION = 1
const te = new TextEncoder()
const td = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })   // R5: bad UTF-8 or a BOM is refused, never repaired

export const KIND = Object.freeze({ timeline_item: 1, object_version: 2, answer: 3, permission_request: 4, verdict: 5, status: 6, decide_again: 7 })
export const KIND_NAME = Object.freeze({ 1: 'timeline_item', 2: 'object_version', 3: 'answer', 4: 'permission_request', 5: 'verdict', 6: 'status', 7: 'decide_again', 8: 'scribble' })
export const OBJECT_STATE = Object.freeze({ open: 1, answered: 2, closed: 3 })
export const OBJECT_STATE_NAME = Object.freeze({ 1: 'open', 2: 'answered', 3: 'closed' })
export const URGENCY = Object.freeze({ low: 0, normal: 1, high: 2, critical: 3 })
export const URGENCY_NAME = Object.freeze({ 0: 'low', 1: 'normal', 2: 'high', 3: 'critical' })
export const TIMELINE_KIND = Object.freeze({ chat: 1, canvas: 2 })
export const TIMELINE_KIND_NAME = Object.freeze({ 1: 'chat', 2: 'canvas' })

/** Body fields per kind (besides schema_version), exactly the README names. Unknown fields are dropped on encode, kept on decode. */
export const FIELDS = Object.freeze({
  message: ['content_type', 'text', 'details', 'html', 'attachments', 'hand_back', 'explain', 'present_card', 'copied_cards', 'marks', 'published_object_id', 'memo'],
  strokes: ['content_type', 'strokes', 'attachments'],
  erase: ['content_type', 'stroke_ids', 'offset'],
  move: ['content_type', 'stroke_ids', 'offset'],
  send_away: ['content_type', 'stroke_ids', 'offset'],
  selection_sent: ['content_type', 'text', 'attachments', 'stroke_ids'],
  card: ['object_type', 'object_version', 'previous_version_hash', 'card_type', 'title', 'body', 'options', 'sections', 'html', 'allows_multiple',
    'recommended', 'urgency_reason', 'attachments', 'change_note', 'close_summary', 'withdraw_reason', 'merged_into_object_id', 'merged_from_object_ids'],
  memo: ['object_type', 'object_version', 'previous_version_hash', 'text', 'x', 'y', 'color', 'desk_id'],
  published: ['object_type', 'object_version', 'previous_version_hash', 'attachments', 'title', 'note', 'released_until'],
  answer: ['answer_action', 'choices', 'note', 'option_notes', 'attachments', 'marks', 'trusted'],
  permission_request: ['tool_name', 'description', 'input_preview'],
  verdict: [],
  status: ['values', 'lamport'],
  decide_again: [],
})
export const CARD_CONTENT_FIELDS = FIELDS.card.slice(3)

export const ATTACHMENT_FIELDS = ['attachment_id', 'file_key', 'sha256', 'file_name', 'media_type', 'total_size', 'width', 'height', 'caption', 'page', 'poster_attachment_id', 'marks']

function pick(src, fields) {
  const out = { schema_version: SCHEMA_VERSION }
  if (fields === PASS_THROUGH) { for (const [k, v] of Object.entries(src)) if (v !== undefined && k !== 'schema_version') out[k] = v; return out }
  for (const f of fields) if (src[f] !== undefined) out[f] = src[f]
  return out
}
/** Memos carry whatever the app puts on them (place, session, to, …): their fields are app-defined. */
export const PASS_THROUGH = Symbol('pass-through')

/** The field list for a body: by kind, and for timeline items and objects by content_type / object_type. */
export function fieldsFor(kind, content) {
  switch (kind) {
    case KIND.timeline_item: {
      const f = FIELDS[content.content_type]
      if (!f) throw new z.ZError('bad-argument', `unknown content_type ${content.content_type}`)
      return f
    }
    case KIND.object_version: {
      if (content.object_type === 'memo') return PASS_THROUGH
      const f = FIELDS[content.object_type]
      if (!f) throw new z.ZError('bad-argument', `unknown object_type ${content.object_type}`)
      return f
    }
    default: return FIELDS[KIND_NAME[kind]]
  }
}

/** A message's `memo`: the note of the human it was sent from (README "message"): { object_id: 32 hex, written_at: ms }.
 *  Nothing else in it, written_at a whole number of ms within 0..2^53 (or null). */
export function memoRefValid(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return false
  if (Object.keys(m).some(k => k !== 'object_id' && k !== 'written_at')) return false
  if (!(typeof m.object_id === 'string' && HEX32.test(m.object_id))) return false
  return m.written_at == null || (Number.isSafeInteger(m.written_at) && m.written_at >= 0)
}

export function encodePayload(kind, content) {
  if (kind === KIND.timeline_item && content?.content_type === 'message' && content.memo !== undefined && !memoRefValid(content.memo)) throw new z.ZError('bad-argument', 'memo must be { object_id: 32 hex, written_at?: ms }')
  return te.encode(JSON.stringify(pick(content, fieldsFor(kind, content))))
}

/** -> { content, content_state: 'ok' | 'newer_schema' | 'undecryptable' } */
export function decodePayload(bytes) {
  let content
  try { const text = td.decode(bytes); if (text.charCodeAt(0) === 0xfeff) throw new Error('bom'); content = JSON.parse(text) } catch { return { content: null, content_state: 'undecryptable' } }
  if (!content || typeof content !== 'object' || Array.isArray(content)) return { content: null, content_state: 'undecryptable' }
  if (!attachmentIdsValid(content)) return { content: null, content_state: 'undecryptable' }   // a ref id is not hex: refuse the body
  if (content.schema_version > SCHEMA_VERSION) return { content, content_state: 'newer_schema' }
  if (content.content_type === 'message' && content.memo !== undefined && !memoRefValid(content.memo)) delete content.memo   // a bad note mark: the message stays, plain
  return { content, content_state: 'ok' }
}

const HEX32 = /^[0-9a-f]{32}$/
/** Every attachment_id / poster_attachment_id anywhere in a body is 32 lowercase hex (they reach URLs and file names). */
export function attachmentIdsValid(content, depth = 0) {
  if (depth > 32) return false
  if (Array.isArray(content)) return content.every(v => attachmentIdsValid(v, depth + 1))
  if (!content || typeof content !== 'object') return true
  for (const [k, v] of Object.entries(content)) {
    if ((k === 'attachment_id' || k === 'poster_attachment_id') && v != null && !(typeof v === 'string' && HEX32.test(v))) return false
    if (v && typeof v === 'object' && !attachmentIdsValid(v, depth + 1)) return false
  }
  return true
}

/** The attachment ids a body references (they go into the header's blob list). */
export function attachmentIdsOf(content) {
  const ids = new Set()
  const add = list => { for (const a of list ?? []) if (a?.attachment_id) { ids.add(a.attachment_id); if (a.poster_attachment_id) ids.add(a.poster_attachment_id) } }
  add(content?.attachments)
  if (content?.values) for (const v of Object.values(content.values)) if (v?.attachment?.attachment_id) add([v.attachment])
  return [...ids]
}

/** Build the README attachment reference from an encryptAsset result. */
export function attachmentRef(asset, meta = {}) {
  const ref = { attachment_id: z.hex(asset.blobId), file_key: z.b64u(asset.key), sha256: z.b64u(asset.sha256), total_size: asset.size }
  for (const f of ATTACHMENT_FIELDS) if (meta[f] !== undefined && ref[f] === undefined) ref[f] = meta[f]
  return ref
}

/** Header values to names, and the bind's byte fields to hex. */
export function decodeBindFor(kind, bind) {
  if (![KIND.answer, KIND.permission_request, KIND.verdict, KIND.decide_again].includes(kind)) return null
  const b = z.decodeBind(kind, bind)
  const out = {}
  for (const [k, v] of Object.entries(b)) out[k] = v instanceof Uint8Array ? z.hex(v) : v
  return out
}
