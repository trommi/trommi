// mirror.ts: the model of a client that runs somewhere else (a Web Worker), kept as an exact copy here.
//
// The client core mutates its model in place and says after every batch what it touched (the `change` event, README
// "Change notifications"). patchOf(model, change) takes exactly those records out of the model (structured-clone data:
// Maps, Sets and plain objects); applyPatch(mirror, patch) puts them into the copy and returns the change as the copy's
// listeners know it, its items being the copy's own objects. A record keeps its identity in the copy (Object.assign in
// place, as the core mutates in place); a record that is gone is deleted. snapshotOf(model) is the whole model once
// (at open, and after a 'reset': a new client behind the copy).
//
// Every record the core changes is named in its change (that is the contract the app renders by); what the builder
// keeps for itself (model._builder: echoes, the projection's sort state) does not travel.
import { emptyChange, emptyModel } from './model-shape.ts'
import type { Alert, Card, Change, HumanRegister, Invite, Member, Model, Newer, Note, OutboxItem, PermissionRequest, Published, Room, Session, Timeline, TimelineItem } from './types.ts'

type Entries<V> = [string, V | null][]
type ItemKey = number | string
/** One timeline's part of a patch: its fields (no items), the items added or replaced, the keys its window holds now. */
export interface TimelinePatch { key: string; meta: Omit<Timeline, 'items'> | null; items: TimelineItem[]; keys: ItemKey[] }
/** One human register: its raw entry, and the derived value it gives (the drafts, snoozes, … maps). */
export interface HumanPatch { key: string; raw: HumanRegister | null }
/** What the copy needs after one change: the records it names, and the change itself (as plain lists). */
export interface ModelPatch {
  room: Room
  newer?: Newer
  members?: [string, Member][]
  sessions?: Entries<Session>
  cards?: Entries<Card>
  permissions?: Entries<PermissionRequest>
  notes?: Entries<Note>
  published?: Entries<Published>
  invites?: Entries<Invite>
  timelines?: TimelinePatch[]
  human?: HumanPatch[]
  crown?: unknown
  alerts?: Alert[]
  outbox?: OutboxItem[]
  stack?: string[]
  open_permission_ids?: string[]
  change: PlainChange
  extra?: Record<string, unknown>
}
/** A change as plain lists (Sets and Maps clone as well, but lists say what is meant). items: timeline key -> item keys. */
export interface PlainChange {
  cards: string[]; sessions: string[]; permissions: string[]; notes: string[]; published: string[]; timelines: string[]; registers: string[]; invites: string[]
  members: boolean; alerts: boolean; outbox: boolean; stack: boolean; room: boolean
  items: [string, ItemKey[]][]
}
/** The whole model as it travels (without the builder's own state). */
export type ModelSnapshot = Omit<Model, '_builder'>

const MAPS = ['sessions', 'cards', 'permissions', 'notes', 'published', 'invites'] as const

/** The whole model, for the copy's first picture. */
export function snapshotOf(model: Model): ModelSnapshot {
  const { _builder, ...rest } = model
  return rest
}

const itemKeyOf = (it: TimelineItem): ItemKey => it.envelope_number ?? it.local_id ?? ''
const timelineMeta = (t: Timeline): Omit<Timeline, 'items'> => { const { items: _items, ...meta } = t; return meta }

/** The records one change names, out of the model. */
export function patchOf(model: Model, change: Change, extra?: Record<string, unknown>): ModelPatch {
  const p: ModelPatch = { room: model.room, change: plainChange(change) }
  if (change.room) p.newer = model.newer
  if (change.members) p.members = [...model.members]
  for (const name of MAPS) {
    const ids = change[name]
    if (!ids.size) continue
    const map = model[name] as Map<string, unknown>
    ;(p as unknown as Record<string, Entries<unknown>>)[name] = [...ids].map(id => [id, map.get(id) ?? null])
  }
  if (change.timelines.size || change.items.size) {
    const keys = new Set([...change.timelines, ...change.items.keys()])
    p.timelines = [...keys].map(key => {
      const t = model.timelines.get(key)
      return { key, meta: t ? timelineMeta(t) : null, items: change.items.get(key) ?? [], keys: t ? [...t.items.keys()] : [] }
    })
  }
  if (change.registers.size) {
    p.human = [...change.registers].map(key => ({ key, raw: model.human.raw.get(key) ?? null }))
    p.crown = model.human.crown
  }
  if (change.alerts) p.alerts = model.alerts
  if (change.outbox) p.outbox = model.outbox
  if (change.stack) { p.stack = model.stack; p.open_permission_ids = model.open_permission_ids }
  if (extra) p.extra = extra
  return p
}

function plainChange(c: Change): PlainChange {
  return {
    cards: [...c.cards], sessions: [...c.sessions], permissions: [...c.permissions], notes: [...c.notes], published: [...c.published], timelines: [...c.timelines],
    registers: [...c.registers], invites: [...c.invites], members: c.members, alerts: c.alerts, outbox: c.outbox, stack: c.stack, room: c.room,
    items: [...c.items].map(([k, list]) => [k, list.map(itemKeyOf)]),
  }
}

/** The copy, from a snapshot (Maps and objects as they came). */
export function mirrorOf(snap: ModelSnapshot): Model {
  return { ...emptyModel(), ...snap }
}

/** Replace a record's fields in place: the same object, the new fields, the gone ones deleted. */
function assignInPlace<T extends object>(target: T, src: T): T {
  for (const k of Object.keys(target)) if (!(k in src)) delete (target as Record<string, unknown>)[k]
  return Object.assign(target, src)
}
function putAll<V extends object>(map: Map<string, V>, entries: Entries<V>): void {
  for (const [id, v] of entries) {
    if (v == null) { map.delete(id); continue }
    const had = map.get(id)
    if (had) assignInPlace(had, v); else map.set(id, v)
  }
}

/** Where a human register shows besides raw (model.ts setHumanRegister): the map and the id, or the crown. */
function slotOf(model: Model, key: string): { map: Map<string, unknown>; id: string } | 'crown' | null {
  const slash = key.indexOf('/')
  const prefix = slash < 0 ? key : key.slice(0, slash), id = slash < 0 ? '' : key.slice(slash + 1)
  const h = model.human
  switch (prefix) {
    case 'draft': return { map: h.drafts, id }
    case 'snooze': return { map: h.snoozes as Map<string, unknown>, id }
    case 'duck': return { map: h.ducks, id }
    case 'desk': return { map: h.desks, id }
    case 'session': return { map: h.session_settings as Map<string, unknown>, id }
    case 'scribble_snapshot': return { map: h.scribble_snapshots, id }
    case 'crown': return 'crown'
    default: return null
  }
}

/** Put a patch into the copy; returns the change for the copy's listeners (Sets, items as the copy's objects). */
export function applyPatch(m: Model, p: ModelPatch): Change {
  assignInPlace(m.room, { ...m.room, ...p.room })   // (fields the page set on its own, the account's, stay)
  if (p.newer) m.newer = p.newer
  if (p.members) {
    const keep = new Set(p.members.map(([id]) => id))
    for (const id of [...m.members.keys()]) if (!keep.has(id)) m.members.delete(id)
    putAll(m.members, p.members)
  }
  for (const name of MAPS) { const e = (p as unknown as Record<string, Entries<object> | undefined>)[name]; if (e) putAll(m[name] as Map<string, object>, e) }
  const items = new Map<string, TimelineItem[]>()
  for (const tp of p.timelines ?? []) {
    if (!tp.meta) { m.timelines.delete(tp.key); continue }
    let t = m.timelines.get(tp.key)
    if (!t) { t = { ...tp.meta, items: new Map() }; m.timelines.set(tp.key, t) }
    else { const its = t.items; assignInPlace(t, { ...tp.meta, items: its }) }
    for (const it of tp.items) t.items.set(itemKeyOf(it), it)
    const keep = new Set(tp.keys)
    for (const k of [...t.items.keys()]) if (!keep.has(k)) t.items.delete(k)
  }
  for (const [key, keys] of p.change.items) {
    const t = m.timelines.get(key)
    items.set(key, keys.map(k => t?.items.get(k)).filter((x): x is TimelineItem => !!x))
  }
  for (const { key, raw } of p.human ?? []) {
    if (raw) m.human.raw.set(key, raw); else m.human.raw.delete(key)
    const slot = slotOf(m, key)
    const value = raw?.value
    if (slot === 'crown') m.human.crown = value ?? null
    else if (slot) { if (value === null || value === undefined) slot.map.delete(slot.id); else slot.map.set(slot.id, value) }
  }
  if ('crown' in p) m.human.crown = p.crown
  if (p.alerts) m.alerts = p.alerts
  if (p.outbox) m.outbox = p.outbox
  if (p.stack) m.stack = p.stack
  if (p.open_permission_ids) m.open_permission_ids = p.open_permission_ids
  const c = emptyChange()
  const pc = p.change
  for (const k of ['cards', 'sessions', 'permissions', 'notes', 'published', 'timelines', 'registers', 'invites'] as const) for (const id of pc[k]) c[k].add(id)
  c.members = pc.members; c.alerts = pc.alerts; c.outbox = pc.outbox; c.stack = pc.stack; c.room = pc.room
  c.items = items
  return c
}
