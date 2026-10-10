// codec.ts: the bodies of stored content (spec/v1.md 9.1: UTF-8 JSON, `schema_version` 2) between the wire and the
// model, both directions, and nothing else. The core seals and opens envelopes and hands a body's payload over as
// JSON text; decodeBody turns that text into the fields the model and the views name (types.ts), encodeBody turns a
// draft's fields into the text the core seals.
//
// What differs between the two forms, and is converted here and nowhere else:
//   ids             the wire's are base64url, the model's lowercase hex: object ids, device ids, envelope hashes,
//                   file ids, the ids inside register names and inside a shape id
//   attachments     wire { file_id, poster_file_id?, … } (9.1.1)  <->  model { attachment_id, poster_attachment_id?, … }
//   a message       wire artifact_object_id                       <->  model published_object_id
//   an Artifact     wire shared_until                             <->  model released_until
//   registers       wire board_snapshot/<board> { attachment, frontier, change }
//                                             <->  model scribble_snapshot/desk/<board> { attachment, frontier, last_envelope_number }
//   board items     wire shape_ids, every position and length a whole number of 1/16 board unit (10.5)
//                                             <->  model stroke_ids, board units
// A reader keeps fields it does not know (9.1.2); a writer writes the fields of its kind and drops the rest, except
// on a Note, whose fields are the app's. Board items and stroke pieces are read strictly, as trommi-core's
// `board_items` reads them: anything it would refuse is 'bad' here.
import type { FileRef } from './core-api.ts'
import { b64u, idFromHex, idToHex, unb64u, unhex } from './ids.ts'
import { Q, quantum, unpackPoints } from './ink.ts'
import type { AttachmentRef } from './types.ts'

export const SCHEMA_VERSION = 2
/** What every client says (or shows) when it meets something only a newer version understands. */
export const UPDATE_MESSAGE = 'This needs a newer version of Trommi. Update to see it.'

/** Which body: a Chat message, a board item, the version of a card, Note or Artifact, an answer, a take back, a
 *  permission request, a verdict, a register value. */
export type BodyKind = 'message' | 'board_item' | 'card' | 'note' | 'artifact' | 'answer' | 'take_back' | 'request' | 'verdict' | 'register'
/** A body as plain fields. */
export type Fields = Record<string, unknown>

/** A body that cannot be written (encodeBody): `code` is 'bad-argument' or 'bad-format'. */
export class BodyError extends Error {
  code: string
  constructor(code: string, message: string) { super(message); this.name = 'BodyError'; this.code = code }
}
const bad = (message: string): never => { throw new BodyError('bad-format', message) }

/** Body fields per kind (besides schema_version), by their model names. */
const FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  message: ['content_type', 'text', 'details', 'html', 'attachments', 'explain', 'hand_back', 'present_card', 'copied_cards', 'marks', 'terminal', 'note', 'published_object_id'],
  card: ['object_version', 'previous_version_hash', 'card_type', 'title', 'teaser', 'body', 'options', 'sections', 'html', 'allows_multiple', 'recommended', 'urgency_reason', 'attachments',
    'change_note', 'close_summary', 'withdraw_reason', 'merged_into_object_id', 'merged_from_object_ids'],
  artifact: ['object_version', 'previous_version_hash', 'artifact_type', 'title', 'note', 'attachments', 'released_until'],
  answer: ['answer_action', 'choices', 'note', 'option_notes', 'attachments', 'marks', 'trusted'],
  request: ['tool_name', 'description', 'input_preview'],
  take_back: [],
  verdict: [],
})
/** A card's own fields: everything of its body but the version's number and predecessor. */
export const CARD_CONTENT_FIELDS: readonly string[] = FIELDS['card']!.slice(2)
/** A card's card_type. */
export const CARD_TYPES: readonly string[] = Object.freeze(['decision', 'info'])
/** An answer's answer_action. */
export const ANSWER_ACTIONS: readonly string[] = Object.freeze(['answer', 'read', 'shred'])
/** A board item's content types (10.5). */
export const BOARD_CONTENT_TYPES: readonly string[] = Object.freeze(['strokes', 'erase', 'move', 'send_away'])

// ---- ids ---------------------------------------------------------------------------------------------------------

const HEX = /^[0-9a-f]+$/
/** A wire id of exactly `bytes` bytes as hex, or null when the text is not one. */
function hexId(text: unknown, bytes: number): string | null {
  if (typeof text !== 'string' || text.length !== Math.ceil((bytes * 4) / 3)) return null
  try { const h = idToHex(text); return h.length === bytes * 2 ? h : null } catch { return null }
}
/** A model id of exactly `bytes` bytes as the wire writes it, or null when the text is not one. */
const wireId = (text: unknown, bytes: number): string | null => (typeof text === 'string' && text.length === bytes * 2 && HEX.test(text) ? idFromHex(text) : null)
/** The same, keeping what is not an id as it stands (a desk called 'main', a value a newer client wrote). */
const softHex = (v: unknown, bytes: number): unknown => hexId(v, bytes) ?? v
const softWire = (v: unknown, bytes: number): unknown => wireId(v, bytes) ?? v
const isObject = (v: unknown): v is Fields => !!v && typeof v === 'object' && !Array.isArray(v)

/** A shape id `<sender>/<envelope number>/<index>` (10.1): the wire's sender is base64url, the model's hex. */
export function shapeIdFromWire(id: unknown): string | null {
  const m = typeof id === 'string' ? /^([A-Za-z0-9_-]{43})\/([1-9][0-9]{0,15})\/(0|[1-9][0-9]{0,9})$/.exec(id) : null
  const sender = m ? hexId(m[1], 32) : null
  return sender && Number(m![3]) <= 0xffffffff ? `${sender}/${m![2]}/${m![3]}` : null
}
export function shapeIdToWire(id: unknown): string | null {
  const m = typeof id === 'string' ? /^([0-9a-f]{64})\/([1-9][0-9]{0,15})\/(0|[1-9][0-9]{0,9})$/.exec(id) : null
  return m && Number(m[3]) <= 0xffffffff ? `${idFromHex(m[1]!)}/${m[2]}/${m[3]}` : null
}

// ---- attachments (9.1.1) -----------------------------------------------------------------------------------------

const B64U = /^[A-Za-z0-9_-]+$/
/** A page named as another attachment of the same list: 'attachment:<id>'. */
const pageRef = (page: unknown, to: (id: string) => string | null): unknown => {
  if (typeof page !== 'string' || !page.startsWith('attachment:')) return page
  const id = to(page.slice(11))
  return id ? `attachment:${id}` : page
}
/** A wire attachment reference as the model keeps it; throws for one that names no file. */
export function attachmentFromWire(a: unknown): AttachmentRef {
  if (!isObject(a)) return bad('an attachment is not an object')
  const { file_id, poster_file_id, ...rest } = a
  const attachment_id = hexId(file_id, 16)
  if (!attachment_id || typeof a['file_key'] !== 'string' || !B64U.test(a['file_key']) || typeof a['sha256'] !== 'string' || !B64U.test(a['sha256'])) return bad('an attachment names no file')
  const out: Fields = { attachment_id, ...rest }
  if (poster_file_id != null) out['poster_attachment_id'] = hexId(poster_file_id, 16) ?? bad('a poster names no file')
  if ('page' in out) out['page'] = pageRef(out['page'], id => hexId(id, 16))
  return out as AttachmentRef
}
const ATTACHMENT_FIELDS: readonly string[] = ['file_key', 'sha256', 'file_name', 'media_type', 'total_size', 'width', 'height', 'caption', 'page', 'marks']
/** A model attachment reference as a body carries it. */
export function attachmentToWire(a: unknown): Fields {
  if (!isObject(a)) throw new BodyError('bad-argument', 'an attachment is not an object')
  const file_id = wireId(a['attachment_id'], 16)
  if (!file_id || typeof a['file_key'] !== 'string' || typeof a['sha256'] !== 'string') throw new BodyError('bad-argument', 'an attachment needs attachment_id, file_key and sha256')
  const out: Fields = { file_id, file_name: 'file', media_type: 'application/octet-stream', total_size: 0 }
  for (const f of ATTACHMENT_FIELDS) if (a[f] != null) out[f] = a[f]
  if ('page' in out) out['page'] = pageRef(out['page'], id => wireId(id, 16))
  if (a['poster_attachment_id'] != null) out['poster_file_id'] = wireId(a['poster_attachment_id'], 16) ?? bad('a poster names no file')
  return out
}
/** The model's reference for a file the core encrypted (core-api.ts FileRef), with what the app knows of it. */
export function attachmentRef(file: FileRef, meta: Fields = {}): AttachmentRef {
  const ref = attachmentFromWire({ file_id: b64u(file.fileId), file_key: b64u(file.fileKey), sha256: b64u(file.sha256), total_size: 0 }) as Fields
  for (const f of ['total_size', 'file_name', 'media_type', 'width', 'height', 'caption', 'page', 'poster_attachment_id', 'marks']) if (meta[f] != null) ref[f] = meta[f]
  return ref as AttachmentRef
}
/** What the core needs to fetch and open a model attachment (core-api.ts FileRef). `fileKey` is a secret. */
export function fileRefOf(a: AttachmentRef): FileRef {
  if (!wireId(a.attachment_id, 16)) bad('an attachment names no file')
  return { fileId: unhex(a.attachment_id), fileKey: unb64u(a.file_key), sha256: unb64u(a.sha256) }
}
const listFromWire = (list: unknown): AttachmentRef[] => (Array.isArray(list) ? list.map(attachmentFromWire) : bad('attachments is not a list'))
const listToWire = (list: unknown): Fields[] => (Array.isArray(list) ? list.map(attachmentToWire) : bad('attachments is not a list'))

// ---- small rules of single fields --------------------------------------------------------------------------------

/** A card's `teaser`: the two short lines the Desk row shows under the title. Plain text: a string, already trimmed,
 *  not empty, no control characters (no line breaks), at most TEASER_MAX characters. */
export const TEASER_MAX = 160
function teaserValid(t: unknown): t is string {
  return typeof t === 'string' && t.length > 0 && t === t.trim() && [...t].length <= TEASER_MAX && !/[\u0000-\u001f\u007f]/.test(t)
}
const HEX32 = /^[0-9a-f]{32}$/
/** A message's `note` in the model: the note of the human it was sent from, { object_id: 32 hex, written_at: ms }.
 *  Nothing else in it, written_at a whole number of ms (or null). */
export function noteRefValid(v: unknown): v is { object_id: string; written_at?: number | null } {
  if (!isObject(v) || Object.keys(v).some(k => k !== 'object_id' && k !== 'written_at')) return false
  if (!(typeof v['object_id'] === 'string' && HEX32.test(v['object_id']))) return false
  const at = v['written_at']
  return at == null || (typeof at === 'number' && Number.isSafeInteger(at) && at >= 0)
}
/** An option whose `final` is anything but true. */
const hasNonFinal = (o: unknown): boolean => isObject(o) && 'final' in o && o['final'] !== true
/** Options as every client reads them: `final` only where it is true. */
const plainOptions = (options: unknown[]): unknown[] => options.map(o => { if (!hasNonFinal(o)) return o; const { final: _final, ...rest } = o as Fields; return rest })

// ---- registers (9.3) ---------------------------------------------------------------------------------------------

/** Register names whose tail is one id of 16 bytes. */
const ID_NAMES: readonly string[] = ['desk/', 'session/', 'draft/', 'snooze/', 'duck/']
const TIMELINE_SCOPES: readonly string[] = ['session/', 'card/', 'desk/']
function mapName(name: string, id: (text: string, bytes: number) => string | null, snapshotFrom: string, snapshotTo: string): string {
  const tail = (prefix: string, bytes: number, out = prefix): string | null => { if (!name.startsWith(prefix)) return null; const got = id(name.slice(prefix.length), bytes); return got ? out + got : name }
  for (const p of ID_NAMES) { const got = tail(p, 16); if (got) return got }
  for (const s of TIMELINE_SCOPES) { const got = tail(`read/${s}`, 16); if (got) return got }
  return tail('device/', 32) ?? tail('alert/', 32) ?? tail(snapshotFrom, 16, snapshotTo) ?? name
}
/** A register's name on the wire -> its key in the model ('board_snapshot/<board>' is 'scribble_snapshot/desk/<board>'). */
export const registerKeyOf = (name: string): string => mapName(name, hexId, 'board_snapshot/', 'scribble_snapshot/desk/')
/** A register's key in the model -> its name on the wire. */
export const registerNameOf = (key: string): string => mapName(key, wireId, 'scribble_snapshot/desk/', 'board_snapshot/')

type IdMap = (v: unknown, bytes: number) => unknown
const crownIds = (v: unknown, id: IdMap): unknown => (isObject(v) ? { ...v, ...('session_id' in v ? { session_id: id(v['session_id'], 16) } : {}), ...('agent_device_id' in v ? { agent_device_id: id(v['agent_device_id'], 32) } : {}) } : v)
const frontierIds = (f: unknown, id: IdMap): unknown => (isObject(f) ? Object.fromEntries(Object.entries(f).map(([k, v]) => [id(k, 32), Array.isArray(v) ? [v[0], id(v[1], 32)] : v])) : f)
/** The ids inside a register's value, one way or the other; the rest of the value is the app's and stays. */
function registerValue(key: string, value: unknown, toModel: boolean): unknown {
  if (!isObject(value)) return value
  const id: IdMap = toModel ? softHex : softWire
  if (key === 'crown') return crownIds(value, id)
  if (key.startsWith('desk/')) return 'crown' in value ? { ...value, crown: crownIds(value['crown'], id) } : value
  if (key.startsWith('session/')) return 'desk' in value ? { ...value, desk: id(value['desk'], 16) } : value
  if (key === 'goals') return 'desk_id' in value ? { ...value, desk_id: id(value['desk_id'], 16) } : value
  if (key.startsWith('status_line/')) return 'object_id' in value ? { ...value, object_id: id(value['object_id'], 16) } : value
  if (key.startsWith('alert/')) return 'sender_device_id' in value ? { ...value, sender_device_id: id(value['sender_device_id'], 32) } : value
  if (key.startsWith('scribble_snapshot/')) {
    if (toModel) {
      const { change, ...rest } = value
      return { ...rest, attachment: attachmentFromWire(value['attachment']), frontier: frontierIds(value['frontier'], id), last_envelope_number: change ?? 0 }
    }
    return { attachment: attachmentToWire(value['attachment']), frontier: frontierIds(value['frontier'], id), change: value['last_envelope_number'] ?? value['change'] ?? 0 }
  }
  return value
}

// ---- board items (10.5) and stroke pieces (7.2) --------------------------------------------------------------------

const PENS: readonly unknown[] = ['pen', 'marker'], NOTES: readonly unknown[] = ['text', 'sticky', 'voice']
const MAX_WIDTH = 1000 * Q, MAX_SHAPES = 1000, MAX_SHAPE_IDS = 2000
const utf8 = new TextEncoder()
const bytesOf = (s: string): number => utf8.encode(s).length
const i32 = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= -(2 ** 31) && v < 2 ** 31
const i32s = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every(i32)
const text = (v: unknown, min: number, max: number): v is string => typeof v === 'string' && bytesOf(v) >= min && bytesOf(v) <= max
const u32 = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff
const size = (v: unknown): v is number => i32(v) && v >= 1 && v <= MAX_WIDTH
/** Fields a shape may carry by its tool; a field of another tool, or one that is null, refuses the shape. */
const SHAPE_FIELDS: readonly string[] = ['color', 'width', 'points', 'live', 'at', 'text', 'size', 'wrap', 'rect', 'attachment']
const TOOL_FIELDS: Readonly<Record<string, readonly string[]>> = { pen: ['color', 'width', 'points', 'live'], note: ['at', 'text', 'size', 'color', 'wrap'], image: ['rect', 'attachment'] }

/** One shape as the wire carries it, checked as trommi-core checks it; returns its family. Throws BodyError. */
export function checkWireShape(e: unknown, withId: boolean): 'pen' | 'note' | 'image' {
  if (!isObject(e)) return bad('a shape is not an object')
  const family = PENS.includes(e['tool']) ? 'pen' : NOTES.includes(e['tool']) ? 'note' : e['tool'] === 'image' ? 'image' : bad('an unknown tool')
  if (('id' in e) !== withId) bad(withId ? 'a shape without its id' : 'a shape names an id')
  for (const f of [...SHAPE_FIELDS, 'group', 'id']) if (f in e && (e[f] === null || (SHAPE_FIELDS.includes(f) && !TOOL_FIELDS[family]!.includes(f)))) bad(`a shape's ${f} does not belong`)
  if ('z' in e && !i32(e['z'])) bad('a layer is not a whole number')
  if ('group' in e && !text(e['group'], 1, 80)) bad('a group name is out of range')
  if (family === 'pen') {
    if (!text(e['color'], 1, 40) || !size(e['width']) || !unpackPoints(e['points'])) bad('a stroke is not readable')
    if ('live' in e && !hexId(e['live'], 16)) bad('a live stroke id is not 16 bytes')
  } else if (family === 'note') {
    if (!i32s(e['at'], 2) || !text(e['text'], 0, 20000) || !size(e['size']) || !text(e['color'], 1, 40) || ('wrap' in e && !(i32(e['wrap']) && e['wrap'] > 0))) bad('a note is not readable')
  } else {
    const a = e['attachment']
    if (!i32s(e['rect'], 4) || !isObject(a) || !text(a['file_name'], 1, 255) || !text(a['media_type'], 1, 255) || !(typeof a['total_size'] === 'number' && Number.isSafeInteger(a['total_size']) && a['total_size'] >= 0)) return bad('a picture is not readable')
    for (const f of ['width', 'height']) if (f in a && !u32(a[f])) bad('a picture size is not a whole number')
    if (!hexId(a['file_key'], 32) || !hexId(a['sha256'], 32)) bad('a picture names no file')
    attachmentFromWire(a)
  }
  return family
}
const units = (q: number): number => q / Q
/** A wire shape -> the model's entry (board units; a picture's own size, type and name beside its attachment). */
export function entryFromWire(e: Fields, withId = false): Fields {
  const family = checkWireShape(e, withId)
  const out: Fields = { tool: e['tool'] }
  if (family === 'pen') {
    Object.assign(out, { color: e['color'], width: units(e['width'] as number), points: e['points'] })
    if ('live' in e) out['live'] = hexId(e['live'], 16)
  } else if (family === 'note') {
    Object.assign(out, { at: (e['at'] as number[]).map(units), text: e['text'], size: units(e['size'] as number), color: e['color'] })
    if ('wrap' in e) out['wrap'] = units(e['wrap'] as number)
  } else {
    const a = attachmentFromWire(e['attachment'])
    Object.assign(out, { rect: (e['rect'] as number[]).map(units), attachment: a, nw: a.width ?? 0, nh: a.height ?? 0, mime: a.media_type ?? null, name: a.file_name ?? null })
  }
  if (e['z']) out['z'] = e['z']
  if ('group' in e) out['group'] = e['group']
  return out
}
const lengthQ = (v: unknown, fallback: number): number => Math.max(1, Math.min(MAX_WIDTH, Math.round((typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback) * Q)))
/** A model entry -> the wire's shape. Throws BodyError for what no reader would take. */
export function entryToWire(e: unknown): Fields {
  if (!isObject(e)) return bad('a shape is not an object')
  const tool = e['tool']
  const out: Fields = { tool }
  if (PENS.includes(tool)) {
    Object.assign(out, { color: e['color'] ?? (tool === 'marker' ? 'yellow' : 'ink'), width: lengthQ(e['width'], tool === 'marker' ? 18 : 4), points: e['points'] })
    if (e['live'] != null) out['live'] = wireId(e['live'], 16) ?? bad('a live stroke id is not 16 bytes')
  } else if (NOTES.includes(tool)) {
    const at = Array.isArray(e['at']) ? e['at'] : []
    Object.assign(out, { at: [quantum(at[0]), quantum(at[1])], text: String(e['text'] ?? ''), size: lengthQ(e['size'], 20), color: e['color'] ?? 'ink' })
    if (e['wrap'] != null) out['wrap'] = lengthQ(e['wrap'], 1)
  } else if (tool === 'image') {
    const rect = Array.isArray(e['rect']) ? e['rect'] : []
    const a = attachmentToWire(e['attachment'])
    delete a['page']; delete a['caption']; delete a['marks']
    for (const [k, v] of [['width', e['nw']], ['height', e['nh']]] as const) if (typeof v === 'number' && v > 0) a[k] = Math.round(v)
    if (typeof e['mime'] === 'string' && e['mime']) a['media_type'] = e['mime']
    if (typeof e['name'] === 'string' && e['name']) a['file_name'] = e['name']
    Object.assign(out, { rect: [0, 1, 2, 3].map(i => quantum(rect[i])), attachment: a })
  }
  if (typeof e['z'] === 'number' && e['z']) out['z'] = Math.round(e['z']) | 0
  if (typeof e['group'] === 'string' && e['group']) out['group'] = e['group']
  checkWireShape(out, false)
  return out
}

function idsFromWire(list: unknown): string[] {
  if (!Array.isArray(list) || !list.length || list.length > MAX_SHAPE_IDS || new Set(list).size !== list.length) return bad('shape ids: 1 to 2 000, none twice')
  return list.map(id => shapeIdFromWire(id) ?? bad('a shape id is not readable'))
}
function boardFromWire(b: Fields): Fields {
  const has = (f: string) => { if (b[f] === null) bad(`${f} is null`); return f in b }
  const type = b['content_type']
  if (type === 'strokes' && has('strokes') && !has('shape_ids') && !has('offset')) {
    const list = b['strokes']
    if (!Array.isArray(list) || !list.length || list.length > MAX_SHAPES) return bad('strokes: 1 to 1 000 shapes')
    return { content_type: type, strokes: list.map(e => entryFromWire(e as Fields)) }
  }
  if ((type === 'erase' || type === 'send_away') && !has('strokes') && !has('offset')) return { content_type: type, stroke_ids: idsFromWire(b['shape_ids']) }
  if (type === 'move' && !has('strokes') && has('offset')) {
    if (!i32s(b['offset'], 2)) return bad('an offset is two whole numbers')
    return { content_type: type, stroke_ids: idsFromWire(b['shape_ids']), offset: (b['offset'] as number[]).map(units) }
  }
  return bad('not a board item')
}
function boardToWire(c: Fields): Fields {
  const type = c['content_type']
  const ids = (): string[] => {
    const list = Array.isArray(c['stroke_ids']) ? c['stroke_ids'].map(id => shapeIdToWire(id) ?? bad('a shape id is not readable')) : bad('stroke_ids is not a list')
    if (!list.length || list.length > MAX_SHAPE_IDS || new Set(list).size !== list.length) bad('shape ids: 1 to 2 000, none twice')
    return list
  }
  if (type === 'strokes') {
    const list = Array.isArray(c['strokes']) ? c['strokes'] : []
    if (!list.length || list.length > MAX_SHAPES) bad('strokes: 1 to 1 000 shapes')
    return { content_type: type, strokes: list.map(entryToWire) }
  }
  if (type === 'erase' || type === 'send_away') return { content_type: type, shape_ids: ids() }
  if (type === 'move') { const o = Array.isArray(c['offset']) ? c['offset'] : []; return { content_type: type, shape_ids: ids(), offset: [quantum(o[0]), quantum(o[1])] } }
  throw new BodyError('bad-argument', `unknown content_type ${String(type)}`)
}

/** A stroke piece as the model shows it: a stroke still being drawn, its new points (7.2). */
export interface StrokePiece { content_type: 'stroke_piece'; stroke: string; number: number; tool: string; color: string; width: number; points: string }
/** The `piece` of a stroke piece message -> the model's form, or null for one trommi-core would refuse. */
export function decodePiece(json: string): StrokePiece | null {
  let p: unknown
  try { p = JSON.parse(json) } catch { return null }
  if (!isObject(p) || bytesOf(json) > 40_000) return null
  const stroke = hexId(p['stroke'], 16)
  if (!stroke || !u32(p['number']) || p['number'] < 1 || !PENS.includes(p['tool']) || !text(p['color'], 1, 40) || !size(p['width']) || !unpackPoints(p['points'])) return null
  return { content_type: 'stroke_piece', stroke, number: p['number'], tool: p['tool'] as string, color: p['color'], width: units(p['width']), points: p['points'] as string }
}
/** The model's piece -> the `piece` text a stroke piece message carries. */
export function encodePiece(p: { stroke: string; number: number; tool: string; color?: string | null; width?: number | null; points: string }): string {
  const out = { stroke: wireId(p.stroke, 16) ?? bad('a live stroke id is not 16 bytes'), number: p.number, tool: p.tool, color: p.color ?? (p.tool === 'marker' ? 'yellow' : 'ink'), width: lengthQ(p.width, p.tool === 'marker' ? 18 : 4), points: p.points }
  const json = JSON.stringify(out)
  if (!decodePiece(json)) bad('a stroke piece is out of range')
  return json
}

// ---- the bodies --------------------------------------------------------------------------------------------------

const idList = (list: unknown, id: IdMap): unknown => (Array.isArray(list) ? list.map(v => id(v, 16)) : list)
/** The ids and renamed fields of a body, wire -> model. Throws BodyError('bad-format'). */
function fromWire(kind: BodyKind, b: Fields): Fields {
  if (kind === 'board_item') return boardFromWire(b)
  if (kind === 'register') {
    if (typeof b['name'] !== 'string') return bad('a register without a name')
    const key = registerKeyOf(b['name'])
    return { name: b['name'], key, value: registerValue(key, b['value'] ?? null, true), lamport: typeof b['lamport'] === 'number' ? b['lamport'] : 0 }
  }
  const out: Fields = { ...b }
  if (Array.isArray(out['attachments'])) out['attachments'] = listFromWire(out['attachments'])
  else delete out['attachments']
  if (kind === 'message') {
    out['content_type'] ??= 'message'
    if ('copied_cards' in out) out['copied_cards'] = idList(out['copied_cards'], softHex)
    if ('artifact_object_id' in out) { const id = hexId(out['artifact_object_id'], 16); delete out['artifact_object_id']; if (id) out['published_object_id'] = id }
    if ('note' in out) {     // a bad note mark: the message stays, plain
      const note = isObject(out['note']) ? { ...out['note'], object_id: hexId(out['note']['object_id'], 16) } : null
      if (noteRefValid(note)) out['note'] = note; else delete out['note']
    }
  }
  if (kind === 'card' || kind === 'artifact' || kind === 'note') {
    if (out['previous_version_hash'] != null) out['previous_version_hash'] = hexId(out['previous_version_hash'], 32) ?? bad('previous_version_hash is not a hash')
  }
  if (kind === 'card') {
    if (out['merged_into_object_id'] != null) out['merged_into_object_id'] = softHex(out['merged_into_object_id'], 16)
    if (out['merged_from_object_ids'] != null) out['merged_from_object_ids'] = idList(out['merged_from_object_ids'], softHex)
    if (out['teaser'] != null && !teaserValid(out['teaser'])) delete out['teaser']    // a bad teaser: the Desk falls back to the body
    if (Array.isArray(out['options'])) out['options'] = plainOptions(out['options'])
  }
  if (kind === 'artifact' && 'shared_until' in out) { out['released_until'] = out['shared_until']; delete out['shared_until'] }
  return out
}

/**
 * A body's payload (the JSON the core opened, as its bytes or as text) as the model's fields; 'newer_schema' for a `schema_version`
 * above 2 (shown as "needs a newer Trommi"), 'bad' for what is no body of its kind. A register gives
 * { name, key, value, lamport }: `key` is the model's key for the wire's `name`.
 */
export function decodeBody(kind: BodyKind, payload: string | Uint8Array): Fields | 'newer_schema' | 'bad' {
  const parsed = parse(payload)
  if (typeof parsed === 'string') return parsed
  try { return fromWire(kind, parsed) } catch (e) { if (e instanceof BodyError) return 'bad'; throw e }
}
/** A board item's payload in the wire's own form, checked as decodeBody checks it: what a board's reducer takes. */
export function parseBoardItem(payload: string): Fields | 'newer_schema' | 'bad' {
  const parsed = parse(payload)
  if (typeof parsed === 'string') return parsed
  try { boardFromWire(parsed); return parsed } catch (e) { if (e instanceof BodyError) return 'bad'; throw e }
}
const utf8Text = new TextDecoder('utf-8', { fatal: true })
function parse(payload: string | Uint8Array): Fields | 'newer_schema' | 'bad' {
  let parsed: unknown
  try { parsed = JSON.parse(typeof payload === 'string' ? payload : utf8Text.decode(payload)) } catch { return 'bad' }
  if (!isObject(parsed)) return 'bad'
  const version = parsed['schema_version']
  if (version === undefined) return parsed
  if (!(typeof version === 'number' && Number.isInteger(version) && version >= SCHEMA_VERSION)) return 'bad'
  return version > SCHEMA_VERSION ? 'newer_schema' : parsed
}

function pick(src: Fields, fields: readonly string[]): Fields {
  const out: Fields = {}
  for (const f of fields) if (src[f] !== undefined) out[f] = src[f]
  return out
}
/** The ids and renamed fields of a body, model -> wire. */
function toWire(kind: BodyKind, f: Fields): Fields {
  if (kind === 'board_item') return boardToWire(f)
  if (kind === 'register') throw new BodyError('bad-argument', 'a register is written with encodeRegister: the core makes its body')
  let out: Fields
  if (kind === 'note') { out = {}; for (const [k, v] of Object.entries(f)) if (v !== undefined && k !== 'schema_version') out[k] = v }   // a Note's fields are the app's
  else out = pick(kind === 'message' ? { content_type: 'message', ...f } : f, FIELDS[kind] ?? bad(`unknown kind ${kind}`))
  if (out['attachments'] != null) out['attachments'] = listToWire(out['attachments'])
  if (kind === 'message') {
    if (out['content_type'] !== 'message') throw new BodyError('bad-argument', `a Chat message has content_type message, not ${String(out['content_type'])}`)
    if (out['terminal'] === 'work') throw new BodyError('bad-argument', 'a work trail is no stored message (spec 7.3)')
    if (out['copied_cards'] != null) out['copied_cards'] = idList(out['copied_cards'], softWire)
    if (out['published_object_id'] != null) { out['artifact_object_id'] = wireId(out['published_object_id'], 16) ?? bad('published_object_id is not an object id'); delete out['published_object_id'] }
    if (out['note'] !== undefined) {
      if (!noteRefValid(out['note'])) throw new BodyError('bad-argument', 'note must be { object_id: 32 hex, written_at?: ms }')
      out['note'] = { ...out['note'], object_id: idFromHex(out['note'].object_id) }
    }
  }
  if ((kind === 'card' || kind === 'artifact' || kind === 'note') && out['previous_version_hash'] != null) out['previous_version_hash'] = wireId(out['previous_version_hash'], 32) ?? bad('previous_version_hash is not a hash')
  if (kind === 'card') {
    if (out['teaser'] != null && !teaserValid(out['teaser'])) throw new BodyError('bad-argument', `teaser must be plain one-paragraph text, trimmed, at most ${TEASER_MAX} characters`)
    if (Array.isArray(out['options'])) out['options'] = plainOptions(out['options'])
    if (out['merged_into_object_id'] != null) out['merged_into_object_id'] = softWire(out['merged_into_object_id'], 16)
    if (out['merged_from_object_ids'] != null) out['merged_from_object_ids'] = idList(out['merged_from_object_ids'], softWire)
  }
  if (kind === 'artifact' && 'released_until' in out) { out['shared_until'] = out['released_until']; delete out['released_until'] }
  return out
}

/** A draft's fields (the model's names) as the payload the core seals: one JSON object with `schema_version` 2.
 *  Throws BodyError for fields no reader would take. */
export function encodeBody(kind: Exclude<BodyKind, 'register'>, fields: Fields): string {
  return JSON.stringify({ schema_version: SCHEMA_VERSION, ...toWire(kind, fields) })
}
/** The same as the bytes a draft carries (core-api.ts Draft `payload`). */
export const encodeBodyBytes = (kind: Exclude<BodyKind, 'register'>, fields: Fields): Uint8Array => utf8.encode(encodeBody(kind, fields))
/** A register write as the core's draft takes it (core-api.ts Draft `register`): the wire's name for the model's
 *  key, and the value as JSON (null deletes). The core adds the lamport and makes the body. */
export function encodeRegister(key: string, value: unknown): { name: string; value: Uint8Array | null } {
  if (!key) throw new BodyError('bad-argument', 'a register needs its key')
  return { name: registerNameOf(key), value: value === null || value === undefined ? null : utf8.encode(JSON.stringify(registerValue(key, value, false))) }
}

/** The files a body names, as sealing takes them for the envelope's header (core-api.ts `seal`, fileIds): none twice. */
export function fileIdsOf(kind: BodyKind, fields: Fields): Uint8Array[] {
  const ids = new Set<string>()
  const add = (a: unknown) => { if (!isObject(a)) return; for (const f of ['attachment_id', 'poster_attachment_id']) if (wireId(a[f], 16)) ids.add(a[f] as string) }
  for (const a of Array.isArray(fields['attachments']) ? fields['attachments'] : []) add(a)
  if (kind === 'board_item') for (const e of Array.isArray(fields['strokes']) ? fields['strokes'] : []) if (isObject(e)) add(e['attachment'])
  if (kind === 'register' && isObject(fields['value'])) add(fields['value']['attachment'])
  return [...ids].map(unhex)
}
