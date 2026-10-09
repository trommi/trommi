// model-shape.ts: an empty model and an empty change (core/README.md "The model", "Change notifications"), with
// nothing else: the page's copy of a model in a worker (mirror.ts) needs these without the reducer, the codec and the
// crypto behind it. model.ts re-exports them.
import type { Change, HumanRegisters, Model, Newer } from './types.ts'

export function emptyModel(): Model {
  return {
    room: { room_id: null, hub_url: null, my_device_id: null, my_role: null, key_epoch: 0, last_entry_number: -1, last_envelope_number: 0, connection: 'offline', agent_session_id: null, outbox_blocked: null },
    members: new Map(), sessions: new Map(), cards: new Map(), permissions: new Map(), notes: new Map(), published: new Map(),
    timelines: new Map(), human: emptyHuman(), invites: new Map(), alerts: [], outbox: [],
    stack: [], open_permission_ids: [], newer: emptyNewer(),
  }
}
export const emptyNewer = (): Newer => ({ count: 0, what: [], envelope_number: 0 })
function emptyHuman(): HumanRegisters {
  return { drafts: new Map(), snoozes: new Map(), ducks: new Map(), crown: null, desks: new Map(), session_settings: new Map(), scribble_snapshots: new Map(), raw: new Map() }
}

/** A change record: what a batch touched. Every field always present. */
export function emptyChange(): Change {
  return { cards: new Set(), sessions: new Set(), permissions: new Set(), notes: new Set(), published: new Set(), timelines: new Set(), registers: new Set(),
    members: false, invites: new Set(), alerts: false, outbox: false, stack: false, room: false, items: new Map() }
}
