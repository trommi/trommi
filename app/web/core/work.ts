// work.ts: a turn's work trail as a client shows it (spec/v1.md 7.3).
//
// While an agent works, its connector sends what it does between the human's prompt and the final answer as MLS
// application messages in the session's group: one message per step, `{ text, tool? }`, numbered from 1 within the
// turn. They are never stored content and a device added later does not get them. model.ts puts each step into the
// session's Chat as an item of its own in the form the views always folded (types.ts WorkEnvelope, `terminal:
// 'work'`); stepEnvelope makes that form, foldWork puts the steps of one turn together into the one block a client
// draws.
//
// Where the block stands in the chat is workAnchor's: at the turn's first step, or behind what he typed into the
// terminal while the turn ran.
//
// Nothing in a step is trusted beyond its shape: an agent wrote it. Texts are cut, unknown kinds and states are
// left out, and a block lists at most 400 items.
import type { WorkEnvelope } from './types.ts'

export interface WorkLine {
  id: string
  kind: 'step' | 'text' | 'helper'
  tool?: string
  title?: string
  subject?: string
  state?: 'running' | 'ok' | 'failed' | 'interrupted'
  at?: number
  ms?: number
  steps?: number
  /** A failed shell command's exit code (1 to 255). */
  exit?: number
  text?: string
  input?: string
  output?: string
}
export interface WorkBlock {
  turn: string
  /** The highest `seq` folded in: a block changed when this did. */
  seq: number
  state: 'running' | 'done' | 'interrupted' | 'failed'
  started: number | null
  ended: number | null
  /** Steps beyond the trail's limit: counted, not listed. */
  more: number
  items: WorkLine[]
}

const WORK_STATES = ['running', 'done', 'interrupted', 'failed']
const STEP_STATES = ['running', 'ok', 'failed', 'interrupted']
const KINDS = ['step', 'text', 'helper']
const TEXTS: [keyof WorkLine, number][] = [['tool', 80], ['title', 200], ['subject', 300], ['text', 30000], ['input', 4000], ['output', 8000]]
export const WORK_ITEMS_MAX = 400

const bytes = new TextEncoder()
/**
 * One step of a turn (the `step` text of a work trail message, its `number` and `time`) in the form foldWork takes:
 * a step with a tool is a 'step' whose title is its text, one without is the agent's own words. `started_at`: when
 * the turn's first known step was sent. `state`: 'running' until the model learns that the turn ended. Null for a
 * step trommi-core would refuse (no object, a text above 30 000 bytes, a tool that is not 1 to 80 bytes).
 */
export function stepEnvelope(turn: string, number: number, time: number, step: string, started_at: number, state: WorkEnvelope['state'] = 'running'): WorkEnvelope | null {
  let s: unknown
  try { s = JSON.parse(step) } catch { return null }
  if (!s || typeof s !== 'object' || Array.isArray(s) || !Number.isSafeInteger(number) || number < 1) return null
  const { text, tool } = s as { text?: unknown; tool?: unknown }
  if (typeof text !== 'string' || bytes.encode(text).length > 30_000) return null
  if (tool !== undefined && !(typeof tool === 'string' && tool !== '' && bytes.encode(tool).length <= 80)) return null
  const id = String(number)
  return { turn, seq: number, state, started_at, items: [typeof tool === 'string' ? { id, kind: 'step', tool, title: text, state: 'ok', at: time } : { id, kind: 'text', text, at: time }] }
}

/** Whether a message's content is a step of a trail. */
export function isWork(content: unknown): content is { terminal: 'work'; work: WorkEnvelope } {
  const c = content as { terminal?: unknown; work?: { turn?: unknown; items?: unknown } } | null
  return c?.terminal === 'work' && typeof c.work?.turn === 'string' && c.work.turn !== '' && Array.isArray(c.work.items)
}

/**
 * The steps of ONE turn as one block. They are applied in the order of `seq`, whatever order they are given in;
 * an item (by `id`) stands where it first came and takes the fields of every later envelope that names it; the
 * turn's state and times are those of the last envelope that says them.
 */
export function foldWork(envelopes: readonly unknown[]): WorkBlock {
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
  const out: WorkBlock = { turn: '', seq: 0, state: 'running', started: null, ended: null, more: 0, items: [] }
  const at = new Map<string, WorkLine>()
  const list = (envelopes.filter(w => w && typeof w === 'object') as Record<string, unknown>[]).sort((a, b) => (num(a['seq']) ?? 0) - (num(b['seq']) ?? 0))
  for (const w of list) {
    if (typeof w['turn'] === 'string') out.turn = w['turn'].slice(0, 64)
    out.seq = Math.max(out.seq, num(w['seq']) ?? 0)
    if (WORK_STATES.includes(w['state'] as string)) out.state = w['state'] as WorkBlock['state']
    out.started = num(w['started_at']) ?? out.started
    out.ended = num(w['ended_at']) ?? out.ended
    out.more = num(w['more']) ?? out.more
    for (const x of (Array.isArray(w['items']) ? w['items'] : []) as Record<string, unknown>[]) {
      if (!x || typeof x !== 'object' || typeof x['id'] !== 'string' || !KINDS.includes(x['kind'] as string)) continue
      let item = at.get(x['id'])
      if (!item) {
        if (out.items.length >= WORK_ITEMS_MAX) continue
        item = { id: x['id'].slice(0, 80), kind: x['kind'] as WorkLine['kind'] }
        at.set(x['id'], item)
        out.items.push(item)
      }
      if (x['kind'] !== item.kind) continue
      for (const [k, max] of TEXTS) if (typeof x[k] === 'string') (item as unknown as Record<string, unknown>)[k] = (x[k] as string).slice(0, max)
      if (STEP_STATES.includes(x['state'] as string)) item.state = x['state'] as NonNullable<WorkLine['state']>
      for (const k of ['at', 'ms', 'steps'] as const) { const n = num(x[k]); if (n != null) item[k] = n }
      const exit = num(x['exit'])
      if (item.kind === 'step' && exit != null && Number.isInteger(exit) && exit > 0 && exit < 256) item.exit = exit
    }
  }
  return out
}

/**
 * Where a turn's block stands in its chat. `envelopes`: the places (envelope numbers) of the turn's envelopes;
 * `typed`: the places of the messages he typed into the terminal (`terminal: 'input'`) in the same chat. The block
 * stands at the turn's first envelope. But what he types while a turn runs goes into that turn (Claude Code hands it
 * to the agent with the next step's result), and the turn's trail goes on behind it: then the block stands behind
 * his last such message, at the first envelope after it, with all its steps. So his words never stand under the
 * work they were typed into, and the block is drawn once. null without an envelope.
 */
export function workAnchor(envelopes: readonly number[], typed: readonly number[]): number | null {
  const at = envelopes.filter(n => Number.isFinite(n)).sort((a, b) => a - b)
  const first = at[0], last = at[at.length - 1]
  if (first === undefined || last === undefined) return null
  let cut = -Infinity
  for (const t of typed) if (t > first && t < last && t > cut) cut = t
  return at.find(n => n > cut) ?? first
}
