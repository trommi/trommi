// check.mjs: the invariants. Everything here compares what the real clients and the hub hold against (a) each other,
// (b) the oracle, (c) the security rules.
import fs from 'node:fs'
import path from 'node:path'
import { Finding, sleep } from './world.mjs'

const canon = v => JSON.stringify(v, (k, x) => (x instanceof Map ? Object.fromEntries([...x].sort((a, b) => (a[0] < b[0] ? -1 : 1))) : x instanceof Set ? [...x].sort() : x))

export function maps(runner) {
  const idToRef = new Map(), devToName = new Map()
  for (const [ref, id] of runner.refs) idToRef.set(typeof id === 'string' ? id : id?.attachment_id, ref)
  for (const d of runner.w.devs.values()) { if (d.id) devToName.set(d.id, d.name); for (const sid of d.client?.session_ids ?? []) devToName.set(sid, d.name) }
  for (const d of runner.w.devs.values()) if (d.sessionId) devToName.set(d.sessionId, d.name)
  for (const d of runner.w.devs.values()) for (const se of d.client?.model.sessions.values() ?? []) if (se.session_id && devToName.has(se.agent_device_id)) devToName.set(se.session_id, devToName.get(se.agent_device_id))
  return { idToRef, devToName }
}
const keyBack = (key, m) => key.replace(/\/([0-9a-f]{32,64})/g, (s, id) => '/' + (m.idToRef.get(id) ?? (m.devToName.has(id) ? '@' + m.devToName.get(id) : id)))
const tlBack = (key, m) => key.replace(/([0-9a-f]{32,64})/g, id => m.idToRef.get(id) ?? (m.devToName.has(id) ? '@' + m.devToName.get(id) : id))

/** The projections of one client, in the oracle's vocabulary. */
export function snapOf(client, m, { agentView = false, mask = null } = {}) {
  const mod = client.model
  const nm = id => m.devToName.get(id) ?? `?${String(id).slice(0, 8)}`
  const rf = id => m.idToRef.get(id) ?? `?${String(id).slice(0, 8)}`
  const s = { members: {}, cards: {}, stack: [], perms: {}, notes: {}, regs: {}, agentRegs: {}, tl: {} }
  for (const [id, mem] of mod.members) s.members[nm(id)] = `${mem.device_role}:${mem.is_active ? 'active' : 'removed'}`
  for (const [id, c] of mod.cards) {
    if (agentView && c.agent_device_id !== client.my_device_id) continue
    s.cards[rf(id)] = { agent: nm(c.agent_device_id), v: c.object_version, title: c.title, state: c.object_state, urgency: c.urgency, closed_how: c.closed_how, answer: c.answer ? c.answer.choices : null }
  }
  Object.defineProperty(s, '_maskedOpen', { value: [], enumerable: false, writable: true })
  if (mask) for (const r of mask) { if (s.cards[r]) { if (s.cards[r].state === 'open') s._maskedOpen.push(r); s.cards[r] = { agent: s.cards[r].agent, masked: true } } if (s.perms[r]) s.perms[r] = { agent: s.perms[r].agent, masked: true } }
  s.stack = mod.stack.map(rf).filter(r => !(mask && mask.has(r)))
  for (const [id, p] of mod.permissions) { if (agentView && p.agent_device_id !== client.my_device_id) continue; s.perms[rf(id)] = { agent: nm(p.agent_device_id), state: p.permission_state } }
  if (mask) for (const r of mask) if (s.perms[r]) s.perms[r] = { agent: s.perms[r].agent, masked: true }
  if (!agentView) for (const [id, x] of mod.notes) if (x.object_state !== 'closed') s.notes[rf(id)] = { text: x.text, state: x.object_state, v: x.object_version }
  if (!agentView) {
    for (const [k, v] of mod.human.raw) if (!v.pending && v.value !== null && v.value !== undefined) s.regs[keyBack(k, m)] = v.value
  }
  for (const [id, se] of mod.sessions) {
    if (agentView && id !== client.my_device_id) continue
    if (!agentView && se.session_id && se.session_id !== id) {}
    const regs = {}
    for (const [k, v] of se.registers) if (!k.startsWith('alert/') && v.value !== null && v.value !== undefined) regs[k] = v.value
    if (Object.keys(regs).length) { if (s.agentRegs[nm(id)]) { client.__phantom = true; Object.assign(s.agentRegs[nm(id)], regs) } else s.agentRegs[nm(id)] = regs }
  }
  if (!agentView) for (const [k, t] of mod.timelines) s.tl[tlBack(k, m)] = t.item_count
  return s
}

/** Expected snapshot from the oracle for a human (or agent) member. */
export function expectedSnap(runner, roomIdx, m, { agentName = null, mask = null } = {}) {
  const O = runner.O.get(roomIdx)
  const s = { members: {}, cards: {}, stack: [], perms: {}, notes: {}, regs: {}, agentRegs: {}, tl: {} }
  for (const [n, mem] of O.members) s.members[n] = `${mem.role}:${mem.active ? 'active' : 'removed'}`
  for (const [ref, c] of O.cards) {
    if (agentName && c.agent !== agentName) continue
    s.cards[ref] = { agent: c.agent, v: c.v, title: c.title, state: c.state, urgency: c.urgency, closed_how: c.closed_how, answer: c.answer ? c.answer.choices : null }
  }
  for (const [ref, p] of O.perms) { if (agentName && p.agent !== agentName) continue; s.perms[ref] = { agent: p.agent, state: p.state } }
  if (mask) { for (const r of mask) { if (s.perms[r]) s.perms[r] = { agent: s.perms[r].agent, masked: true } } }
  if (!agentName) for (const [ref, x] of O.notes) if (x.state !== 'closed') s.notes[ref] = { text: x.text, state: x.state, v: x.v }
  if (!agentName) {
    for (const [k, v] of O.regs) if (v !== null) s.regs[k] = v
    const now = Date.now()
    const snoozed = ref => { const v = O.regs.get(`snooze/${ref}`); return !!v && (v.until == null || v.until > now) }
    const archived = new Set([...O.members.keys()].filter(n => O.regs.get(`session/@${n}`)?.archived))
    s.stack = O.stack(snoozed, archived)
    if (mask) s.stack = s.stack.filter(r => !mask.has(r))
    for (const [tl, items] of O.chat) s.tl[`chat:${tl}`] = items.length
    for (const [tl, items] of O.canvas) s.tl[`scribble:${tl}`] = items.length
  }
  for (const [n, regs] of O.agentRegs) { if (agentName && n !== agentName) continue; const o = {}; for (const [k, v] of regs) if (v !== null) o[k] = v; if (Object.keys(o).length) s.agentRegs[n] = o }
  return s
}

function stackInconsistent(client, m) {
  const mod = client.model
  if (mod.human.snoozes.size || [...mod.sessions.values()].some(x => x.settings?.archived)) return false
  const own = [...mod.cards.values()].filter(c => c.object_state === 'open').map(c => c.object_id).sort()
  return JSON.stringify(own) !== JSON.stringify([...mod.stack].sort())
}
/** F13 (gone with v1.1 sessions): a session keyed by an agent's device id (64 hex) instead of a session id (32 hex). */
function phantomOf(d) {
  const c = d.client; if (!c) return null
  for (const [id, se] of c.model.sessions) if (se.registers.size && /^[0-9a-f]{64}$/.test(id)) return id
  return null
}
export function maskFor(runner, dev) {
  return runner.prunedRefs ?? null
}
function diff(a, b, path = '', out = []) {
  if (out.length > 12) return out
  if (a === b) return out
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], `${path}.${k}`, out)
  } else if (canon(a) !== canon(b)) out.push(`${path}: client=${canon(a)} oracle=${canon(b)}`)
  return out
}

// tolerance for chat/canvas counts: items of a crashed process may or may not exist
function chatBounds(O, w) { const o = {}; for (const [tl, items] of O.chat) o[`chat:${tl}`] = [items.filter(i => i.certain && !w.devs.get(i.from)?.dead).length, items.length]; return o }

export async function checkOracle(runner, { final = false } = {}) {
  const w = runner.w, m = maps(runner), out = []
  for (const room of w.rooms) {
    if (!room || !runner.O.get(room.idx)) continue
    const O = runner.O.get(room.idx)
    const bounds = chatBounds(O, w)
    for (const d of room.devs.values()) {
      if (!d.client || d.dead || d.removed) continue
      const agentView = d.role === 'agent'
      const mask = maskFor(runner, d)
      const got = snapOf(d.client, m, { agentView, mask })
      const exp0 = { stack: [] }
      if (!agentView) {
        const bad = stackInconsistent(d.client, m)
        if (bad) runner.known('F18-stack-stale-after-refused-answer', 'model.stack is not re-projected after an optimistic echo is undone (answer refused: info card, bad choice, stale version): the open card stays missing from the stack while model.cards shows it open')
        got.stack = exp0.stack = []
      }
      const exp = expectedSnap(runner, room.idx, m, { agentName: agentView ? d.name : null, mask })
      if (!agentView) exp.stack = []
      if (mask) for (const r of mask) { const oc = exp.cards[r]; if (oc && oc.state !== 'open' && got._maskedOpen.includes(r)) out.push(`${d.name}: F9 again: ${r} is ${oc.state} but shows open after retention pruned it`); if (oc) exp.cards[r] = { agent: oc.agent, masked: true } }
      const tlG = got.tl; delete got.tl
      const tlE = exp.tl; delete exp.tl
      if (agentView) { got.members = exp.members = {}; got.agentRegs = exp.agentRegs = {}; got.stack = exp.stack = [] }
      // agents and humans: pre-prune content differences cannot occur in the model of a live client
      const dd = diff(got, exp)
      if (dd.length && [...room.devs.values()].some(x => x.client?.model.alerts.some(al => al.code === 'card-closed' || (al.code === 'answer-stale' && !runner.staleUsed)))) { runner.known('F17-answer-echo-undo-reopens-card', 'answer echo undo restores the pre-echo card state over a newer closed state'); runner.stopCompare = true; continue }
      { const ph = [...room.devs.values()].find(x => phantomOf(x)); if (ph) out.push(`${ph.name}: F13 again: agent registers in a phantom session ${phantomOf(ph).slice(0, 8)}`) }
      if (dd.length && [...room.devs.values()].some(x => x.everFaulty)) { runner.known('F12-network-error-skips-envelope', 'with lost responses / offline faults on a device, records are silently lost for it (alert or not) and never re-fetched; see failures for the shrunk traces'); runner.stopCompare = true; continue }
      if (dd.length) {
        const codes = d.client.model.alerts.map(a => `${a.code}:${a.message}`)
        if (codes.some(c => /^not-allowed:not allowed in session\//.test(c))) { runner.known('F11-missed-session-grant', 'a device that missed the session grant (stream dropped around the assignment) refuses every message of that session as not-allowed and never repairs it: grants are only learned from the stream event, a reconnect does not re-fetch them'); runner.stopCompare = true; continue }
        if (codes.some(c => /^(offline|internal|log-behind|http-|unauthorised)/.test(c) || /hub not reachable|simulated/.test(c))) { runner.known('F12-network-error-skips-envelope', 'a network error while verifying a record (member refresh after log-behind, grant fetch) is caught per record, pushed as an alert, and the cursor moves on: the envelope is never processed again (a card, a register or a message is lost for that device until it is re-synced from scratch)'); runner.stopCompare = true; continue }
      }
      if (dd.length) out.push(`${d.name} differs from the oracle:\n  ${dd.join('\n  ')}`)
      if (!agentView) {
        for (const k of new Set([...Object.keys(tlG), ...Object.keys(tlE)])) {
          const b = bounds[k] ?? [tlE[k] ?? 0, tlE[k] ?? 0]
          const n = tlG[k] ?? 0
          if ((n < b[0] || n > b[1]) && room.devs.size && [...room.devs.values()].some(x => x.client?.model.alerts.some(al => /^not-allowed/.test(al.code)))) { runner.known('F11-missed-session-grant', 'a device that missed the session grant (stream dropped around the assignment) refuses every message of that session as not-allowed and never repairs it'); runner.stopCompare = true; continue }
          if (n < b[0] || n > b[1]) out.push(`${d.name} timeline ${k}: has ${n} items, oracle ${b[0]}..${b[1]}`)
        }
      }
    }
  }
  if (out.length) throw new Finding('oracle', out.slice(0, 4).join('\n'))
}

/**
 * Humans must agree with each other on everything, whatever the oracle says (chaos mode).
 * `accepted`: card refs left out of the comparison (masked like pruned ones), for the one accepted outcome of a hostile
 * hub (FINDINGS H2); everything else is compared as always.
 */
export async function checkConvergence(runner, { accepted = null } = {}) {
  const w = runner.w, m = maps(runner), out = []
  const maskFor = (r, d) => { const p = r.prunedRefs ?? null; return accepted?.size ? new Set([...(p ?? []), ...accepted]) : p }
  for (const room of w.rooms) {
    if (!room) continue
    const humans = [...room.devs.values()].filter(d => d.isHuman && d.client && !d.dead && !d.removed)
    if (humans.length > 1) {
      const mk = d => maskFor(runner, d)
      const allMask = mk(humans[0])
      const noStack = x => { x.stack = []; return x }
      for (const d of humans) if (stackInconsistent(d.client, m)) runner.known('F18-stack-stale-after-refused-answer', 'model.stack not re-projected after an optimistic echo is undone')
      const base = noStack(snapOf(humans[0].client, m, { mask: allMask }))
      for (const d of humans.slice(1)) { const dd = diff(noStack(snapOf(d.client, m, { mask: allMask })), base); if (dd.length) out.push(`${d.name} vs ${humans[0].name}:\n  ${dd.join('\n  ')}`) }
    }
    // an agent agrees with the humans on its own cards, answers and permission requests
    for (const a of room.devs.values()) {
      if (runner.stopCompare) break
      if (a.role !== 'agent' || !a.client || a.dead || a.removed || !humans.length) continue
      const h = snapOf(humans[0].client, m, { mask: maskFor(runner, humans[0]) ?? maskFor(runner, a) })
      const um = maskFor(runner, humans[0]) ?? maskFor(runner, a)
      const g = snapOf(a.client, m, { agentView: true, mask: um })
      const own = {}; for (const [k, c] of Object.entries(h.cards)) if (c.agent === a.name) own[k] = c
      const ownP = {}; for (const [k, p] of Object.entries(h.perms)) if (p.agent === a.name) ownP[k] = p
      const dd = [...diff(g.cards, own, '.cards'), ...diff(g.perms, ownP, '.perms')]
      if (dd.length) out.push(`${a.name} vs ${humans[0].name} on its own objects:\n  ${dd.join('\n  ')}`)
    }
  }
  // F2 (fixed): 'in revision' (hand_back / explain) comes from message bodies; catch-up settles it from the conversation
  for (const room of w.rooms) {
    if (!room) continue
    const humans = [...room.devs.values()].filter(d => d.isHuman && d.client && !d.dead && !d.removed)
    const views = humans.map(d => canon([...d.client.model.cards].filter(([id]) => !accepted?.has(m.idToRef.get(id))).map(([id, c]) => [id, c.in_revision?.by ?? null]).sort()))
    if (new Set(views).size > 1) out.push(`F2 again: 'in revision' differs between human devices: ${humans.map((d, k) => `${d.name} ${views[k].replace(/[0-9a-f]{24}"/g, '"').slice(0, 120)}`).join(' / ')}`)
  }
  if (out.length && w.rooms.some(r => r && [...r.devs.values()].some(x => x.client?.model.alerts.some(al => al.code === 'card-closed' || (al.code === 'answer-stale' && !runner.staleUsed))))) { runner.known('F17-answer-echo-undo-reopens-card', 'a human answers a card that the agent closed a moment ago (the answer is bound to the old version): when the hub copy comes back as answer-stale, the optimistic echo is undone with the card state saved BEFORE the echo (open), which overwrites the newer closed state: that device shows the card open, the agent and other devices closed'); runner.stopCompare = true; return }
  if (out.length && w.rooms.some(r => r && [...r.devs.values()].some(x => x.client?.model.alerts.some(al => /^not-allowed/.test(al.code))))) { runner.known('F11-missed-session-grant', 'a device that missed the session grant refuses the session messages as not-allowed and never repairs it'); runner.stopCompare = true; return }
  { const ph = w.rooms.flatMap(r => r ? [...r.devs.values()] : []).find(x => phantomOf(x)); if (ph) out.push(`${ph.name}: F13 again: agent registers in a phantom session`) }
  if (out.length && w.rooms.some(r => r && [...r.devs.values()].some(x => x.everFaulty))) { runner.known('F12-network-error-skips-envelope', 'with lost responses / offline faults on a device, records are silently lost for it and never re-fetched; see failures for the shrunk traces'); runner.stopCompare = true; return }
  if (out.length) throw new Finding('convergence', out.slice(0, 4).join('\n'))
}

/** Load every timeline a human knows, compare the message sets with the oracle and across humans. */
export async function checkTimelines(runner, { against = true } = {}) {
  const w = runner.w, m = maps(runner), out = []
  for (const room of w.rooms) {
    if (!room) continue
    const O = runner.O.get(room.idx)
    const humans = [...room.devs.values()].filter(d => d.isHuman && d.client && !d.dead && !d.removed)
    if (!humans.length) continue
    const sets = []
    for (const d of humans.slice(0, 3)) {
      const set = {}; if (process.env.FZ_DEBUG) console.error('TL', d.name, d.client.model.room.last_envelope_number, [...d.client.model.timelines.keys()].map(k => k.slice(0, 24)))
      for (const [key, t] of d.client.model.timelines) {
        if (runner.flags.pruned && /^chat:card\//.test(key)) continue
        let items
        try {
          for (let tryN = 0; ; tryN++) { try { await d.client.loadTimeline(key, { limit: 200 }); break } catch (e) { if (e.code !== 'offline' || tryN > 8) throw e; await sleep(250) } }
          items = []
          for (let before = Infinity, guard = 0; guard < 100; guard++) {
            let page; for (let tryN = 0; ; tryN++) { try { page = await d.client.timelineWindow(key, { before_envelope_number: before, limit: 200 }); break } catch (e) { if (e.code !== 'offline' || tryN > 8) throw e; await sleep(250) } }
            if (!page.length) break
            items = page.concat(items); before = page[0].envelope_number
            if (page.length < 200) break
          }
          items = items.filter(i => !i.pending)
          if (items.some(i => /FZFORGED forged/.test(i.content?.text ?? ''))) { runner.known('F7-unauthorised-timeline-items-shown', 'a timeline item from a sender the rules forbid (human chat on card/X addressed to someone else than X\'s creator; agent chat into another agent\'s session) is refused by the reducer (not counted) but its record is still stored by sync and loadTimeline/timelineWindow returns and decrypts it: the UI would show it'); items = items.filter(i => !/FZFORGED forged/.test(i.content?.text ?? '')) }
          const win = [...t.items.values()].filter(i => !i.pending).length
          if (win < Math.min(items.length, 200) && win === 0) runner.known('F8-window-empty-after-restart', 'loadTimeline() returns no items for a timeline that has items in storage: the persisted loaded_down_to survives a restart while the in-memory window is empty, so the newest page never reloads')
        } catch (e) { out.push(`${d.name}: timeline read of ${key.slice(0, 30)} failed: ${e.code ?? e.message}`); continue }
        set[tlBack(key, m)] = items.map(i => i.content_type === 'message' ? `m:${i.content.text}` : i.content_type === 'strokes' ? `s:${i.content.strokes.map(s => s.stroke_id).join(',')}` : `${i.content_type}:${(i.content?.stroke_ids ?? []).join(',')}`)
      }
      sets.push([d.name, set])
    }
    for (const [n, s] of sets.slice(1)) { const dd = diff(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, [...v].sort()])), Object.fromEntries(Object.entries(sets[0][1]).map(([k, v]) => [k, [...v].sort()]))); if (dd.length) out.push(`timelines of ${n} differ from ${sets[0][0]}:\n  ${dd.join('\n  ')}`) }
    if (against && O) {
      const [dn, s] = sets[0]
      for (const [tl, items] of O.chat) {
        if (runner.flags.pruned && tl.startsWith('card/')) continue
        const got = s[`chat:${tl}`] ?? []
        const gotTexts = got.filter(x => x.startsWith('m:')).map(x => x.slice(2))
        const certain = items.filter(i => i.certain).map(i => i.text), all = items.map(i => i.text)
        const missing = certain.filter(t => !gotTexts.includes(t)), foreign = gotTexts.filter(t => !all.includes(t))
        if (missing.length || foreign.length || new Set(gotTexts).size !== gotTexts.length) out.push(`${dn} chat ${tl}: missing ${canon(missing)} unexpected ${canon(foreign)} duplicates ${gotTexts.length - new Set(gotTexts).size}; client list ${canon(got)}; keys ${canon(Object.keys(s))}; model keys ${canon([...humans[0].client.model.timelines.keys()])}`)
        // order: one sender's messages arrive in the order it sent them
        const bySender = new Map()
        for (const i of items) { if (!gotTexts.includes(i.text)) continue; const a = bySender.get(i.from) ?? []; a.push(i.text); bySender.set(i.from, a) }
        for (const [from, seq] of bySender) { const pos = seq.map(t => gotTexts.indexOf(t)); if (pos.some((p, i) => i && p < pos[i - 1])) out.push(`${dn} chat ${tl}: messages of ${from} out of order`) }
      }
      for (const [tl, items] of O.canvas) {
        const got = s[`scribble:${tl}`] ?? []
        const want = items.map(i => i.type === 'strokes' ? `s:${i.ids.join(',')}` : `${i.type}:${i.ids.join(',')}`)
        if (canon([...got].sort()) !== canon([...want].sort())) out.push(`${dn} canvas ${tl}: items differ: got ${got.length} want ${want.length}`)
      }
    }
  }
  if (out.length && runner.w.rooms.some(r => r && [...r.devs.values()].some(x => x.client?.model.alerts.some(al => /^not-allowed/.test(al.code))))) { runner.known('F11-missed-session-grant', 'a device that missed the session grant refuses the session messages as not-allowed and never repairs it'); runner.stopCompare = true; return }
  if (out.length && runner.w.rooms.some(r => r && [...r.devs.values()].some(x => x.everFaulty))) { runner.known('F12-network-error-skips-envelope', 'timeline items lost under network faults'); runner.stopCompare = true; return }
  if (out.length) throw new Finding('timeline', out.slice(0, 5).join('\n'))
}

// ---- security ---------------------------------------------------------------------------------------------

function strings(v, out = [], depth = 0) {
  if (depth > 8 || v == null) return out
  if (typeof v === 'string') out.push(v)
  else if (v instanceof Map) for (const [k, x] of v) { strings(k, out, depth + 1); strings(x, out, depth + 1) }
  else if (v instanceof Set) for (const x of v) strings(x, out, depth + 1)
  else if (Array.isArray(v)) for (const x of v) strings(x, out, depth + 1)
  else if (typeof v === 'object' && !(v instanceof Uint8Array)) for (const x of Object.values(v)) strings(x, out, depth + 1)
  return out
}
/** A removed device must hold nothing that was sent after the cut. */
export function checkRemoved(runner) {
  const out = []
  for (const d of runner.w.devs.values()) {
    if (!d.removed || !d.client || d.removedBatch == null) continue
    const strs = strings(d.client.model)
    for (const [, v] of d.storage_base._map) strings(v, strs)
    for (const s of strs) {
      for (const mm of s.matchAll(/FZMARK b(\d+) /g)) {
        if (Number(mm[1]) > d.removedBatch + (runner.strict ? 0 : 1) && !/FROM-REMOVED/.test(s) ) { out.push(`${d.name} (removed in batch ${d.removedBatch}) holds content of batch ${mm[1]}: ${s.slice(0, 80)}`); break }
      }
      if (out.length > 3) break
    }
  }
  if (out.length) throw new Finding('leak', out.join('\n'))
}
/** Nothing a removed device sent after the cut may exist anywhere. */
export function checkNoForeign(runner) {
  const m = maps(runner), out = []
  for (const d of runner.w.devs.values()) {
    if (d.removed || !d.client || d.dead) continue
    for (const s of strings(d.client.model)) if (s.includes('FZFORGED forged')) runner.known('F7-unauthorised-timeline-items-shown', 'unauthorised timeline item present in the model window'); else if (s.includes('FZFORGED bom')) runner.known('F3-bom-accepted', 'a body with a leading BOM is decoded and shown (TextDecoder strips the BOM in codec.decodePayload); R5 says refuse'); else if (s.includes('FROM-REMOVED') || s.includes('FZFORGED')) out.push(`${d.name} shows content of a removed device: ${s.slice(0, 60)}`)
    if (out.length) break
  }
  if (out.length) throw new Finding('leak', out.join('\n'))
}

export function checkCommands(runner) {
  const out = []
  for (const d of runner.w.devs.values()) {
    if (d.role !== 'agent') continue
    const seen = new Map()
    for (const c of d.commands) {
      const k = `${c.envelope_number}`
      if (seen.has(k)) {
        if (seen.get(k) === c.incarnation && !d.everFaulty) out.push(`${d.name}: command at envelope ${k} (${c.command}) delivered twice in one process`)
        else if (d.everFaulty) runner.known('F19-command-redelivered-in-process-under-faults', 'an agent with lost responses / offline faults is handed the same command (same envelope) twice by one process: the catch-up after a failed request re-delivers it; only the channel ledger stands between that and a double execution')
        else runner.known('F6-command-redelivered-after-restart', 'after a crash and restart the core hands the same command (same envelope) to the agent again: commands_delivered is not persisted in time (the debounced flush loses it), so only the channel ledger can stop a double execution')
      }
      seen.set(k, c.incarnation)
    }
  }
  if (out.length) throw new Finding('double-execution', out.slice(0, 3).join('\n'))
}

export function checkHub(w) {
  if (!w.hub && !w.hubLog.length) return
  const out = []
  const shut = /database is not open|closed/i
  const logs = w.hubLog.filter(l => !shut.test(l)), shutLogs = w.hubLog.filter(l => shut.test(l))
  if (shutLogs.length) w.known.set('F14-hub-shutdown-500', 'hub.close() closes the database while requests are still being handled: those requests die with "internal error ... database is not open" (500) instead of finishing or being refused cleanly')
  if (logs.length) out.push(`hub log: ${logs.slice(0, 3).join(' | ')}`)
  if (w.http.status500.length && !(shutLogs.length && !logs.length)) out.push(`hub answered 5xx: ${JSON.stringify(w.http.status500.slice(0, 3))}`)
  if (out.length) throw new Finding('hub-error', out.join('\n'))
}

export function dumpDerived(db) {
  return JSON.stringify({
    o: db.prepare('SELECT * FROM objects ORDER BY room_id, object_id').all().map(r => ({ ...r })),
    t: db.prepare('SELECT * FROM timelines ORDER BY room_id, timeline_kind, timeline_id').all().map(r => ({ ...r })),
  })
}
export function checkDerived(w) {
  if (!w.hub) return
  const before = dumpDerived(w.hub.db)
  w.hub.rebuildDerived()
  const after = dumpDerived(w.hub.db)
  if (before !== after) throw new Finding('derived', 'derived tables (objects, timelines) rebuilt from envelopes differ from the live ones', { before: before.slice(0, 500), after: after.slice(0, 500) })
}

/** The hub must never hold plaintext: scan every file under its data dir for the markers the fuzzer inserted. */
export function checkPlaintext(w) {
  if (!w.hub) return
  const hits = []
  w.hub.db.exec('PRAGMA wal_checkpoint(PASSIVE)')
  const walk = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else { const buf = fs.readFileSync(p); if (buf.includes('FZMARK')) hits.push(p.replace(w.dir, '')) } } }
  walk(path.join(w.dir, 'hub'))
  if (hits.length) throw new Finding('plaintext', `the hub's data dir holds plaintext markers in: ${hits.join(', ')}`)
}

// ---- safety under a malicious hub: nothing shown or executed that members did not really send ----------------------
/**
 * How many versions of each object each device really sent: the envelopes of kind object_version in the hub's database.
 * The man in the middle sits between the hub and the clients and writes nothing there, and a version counts one up from
 * the one before, so no device may show a higher version than its owner has rows. A row the hub voided names no object
 * any more (the clients may still be handed it without its flag): it counts for every object of its sender.
 */
function versionsSent(runner) {
  const db = runner.w.hub?.db
  if (!db) return null
  const hex = b => Buffer.from(b).toString('hex')
  const by = new Map(), voided = new Map()
  for (const r of db.prepare(`SELECT sender_device_id AS s, object_id AS o, COUNT(*) AS n FROM envelopes WHERE envelope_kind = ${runner.w.t.codec.KIND.object_version} GROUP BY sender_device_id, object_id`).all()) {
    if (r.o == null) voided.set(hex(r.s), (voided.get(hex(r.s)) ?? 0) + Number(r.n)); else by.set(`${hex(r.s)}/${r.o}`, Number(r.n))
  }
  return { by, voided }
}

export async function checkSafety(runner, { deep = false } = {}) {
  const m = maps(runner), out = []
  for (const room of runner.w.rooms) {
    const O = runner.O.get(room?.idx); if (!O) continue
    for (const d of room.devs.values()) {
      if (!d.client || d.dead) continue
      const rf = id => m.idToRef.get(id)
      // read here, in one go with this device's cards (nothing awaits in between): the deep check below awaits, and a
      // version that reached the hub meanwhile would be on the next device's screen and not in an older reading
      const log = versionsSent(runner)
      const sentOf = (owner, id) => !log ? Infinity : (log.by.get(`${owner}/${id}`) ?? 0) + (log.voided.get(owner) ?? 0)
      for (const [id, c] of d.client.model.cards) {
        const ref = rf(id), oc = ref && O.cards.get(ref)
        if (!oc) { if (!ref || !O.cards.has(ref)) { out.push(`${d.name} shows a card nobody created: ${id.slice(0, 8)} "${String(c.title).slice(0, 40)}"`); } continue }
        if (c.title && !oc.titles.has(c.title)) out.push(`${d.name}: card ${ref} shows a title no version ever had: ${c.title.slice(0, 50)}`)
        // What the owner sent is read from the hub's own log, not from the oracle and not from the owner's memory: the owner
        // sends versions no action names (F15: it says an open card again after refusing an answer, also one the oracle
        // never learns of: a forged one, one whose void flag the hostile hub dropped, one that crossed a revision), and a
        // crashed owner has no memory to ask.
        // The owner itself may be ahead of the hub by what it signed and still holds in its outbox.
        const sent = Math.max(sentOf(room.devs.get(oc.agent)?.id, id), d.name === oc.agent ? d.client.localHeads.get(id)?.object_version ?? 0 : 0)
        if (c.object_version > sent) out.push(`${d.name}: card ${ref} at version ${c.object_version}, only ${sent} were sent`)
        if (c.answer && !O.attempts.has(ref)) out.push(`${d.name}: card ${ref} shows an answer nobody gave`)
      }
      for (const [id, p] of d.client.model.permissions) { const ref = rf(id); if (!ref || !O.perms.has(ref)) out.push(`${d.name}: permission request nobody made`); else if (p.verdict && !O.perms.get(ref)) out.push('x') }
      for (const [id, x] of d.client.model.notes) { const ref = rf(id); const texts = ref && O.noteTexts.get(ref); if (x.text && (!texts || !texts.has(x.text))) out.push(`${d.name}: note ${ref ?? id.slice(0, 8)} shows text nobody saved: ${String(x.text).slice(0, 40)}`) }
      if (d.role === 'agent') for (const c of d.commands) {
        const t = c.content?.text
        if (c.command === 'message' && t && !O.sentTexts.has(t) && !/FZFORGED bom/.test(t) && !/FZFORGED forged/.test(t)) out.push(`${d.name} executed a message nobody sent: ${String(t).slice(0, 50)}`)
        if (['answer', 'trust', 'read', 'shred'].includes(c.command) && c.object_id) { const ref = rf(c.object_id); if (!ref || !O.attempts.has(ref)) out.push(`${d.name} executed ${c.command} on ${ref} that no human answered`) }
      }
      if (deep) for (const [key, t] of d.client.model.timelines) {
        if (!d.isHuman) continue
        try { await d.client.loadTimeline(key, { limit: 200 }) } catch { continue }
        for (const it of t.items.values()) if (it.content?.text && !it.pending && !O.sentTexts.has(it.content.text) && !/FZFORGED (bom|forged)/.test(it.content.text)) out.push(`${d.name}: timeline ${key.slice(0, 30)} shows a message nobody sent: ${it.content.text.slice(0, 50)}`)
      }
      // a member list never goes backwards
      const seq = d.client.state.head.seq
      d.maxSeq = Math.max(d.maxSeq ?? -1, seq)
      if (seq < d.maxSeq) out.push(`${d.name}: member list rolled back from ${d.maxSeq} to ${seq}`)
    }
  }
  const dedupe = [...new Set(out)]
  if (dedupe.length) throw new Finding('hostile-safety', dedupe.slice(0, 5).join('\n'))
}

/** R6: an agent holds session keys only; it must show nothing of other sessions, of the room-wide data, or from before its own grant. */
export function checkIsolation(runner) {
  if (!runner.w.t.features.sessionKeys) return
  const out = [], m = maps(runner)
  for (const d of runner.w.devs.values()) {
    if (d.role !== 'agent' || !d.client || d.dead || d.removed) continue
    const mod = d.client.model
    for (const [id, c] of mod.cards) if (c.agent_device_id !== d.id && (c.title || c.answer)) out.push(`${d.name} reads a card of another agent's session: ${String(c.title).slice(0, 40)}`)
    for (const [id, p] of mod.permissions) if (p.agent_device_id !== d.id && p.tool_name) out.push(`${d.name} reads another agent's permission request`)
    for (const [id, x] of mod.notes) if (x.text) out.push(`${d.name} reads a note (room scope): ${String(x.text).slice(0, 40)}`)
    for (const [k, v] of mod.human.raw) if (v.value !== null && v.value !== undefined) out.push(`${d.name} holds the human register ${k.slice(0, 30)}`)
    for (const [key, t] of mod.timelines) for (const it of t.items.values()) if (it.content?.text && !(key.includes(`session/${d.client.session_id}`) || key.startsWith('chat:card/'))) out.push(`${d.name} reads an item of timeline ${key.slice(0, 40)}`)
    for (const s of strings(mod)) for (const mm of s.matchAll(/FZMARK b(\d+) /g)) if (Number(mm[1]) < d.joinedBatch && !d.handoverWithHistory) { out.push(`${d.name} (joined in batch ${d.joinedBatch}) holds content of batch ${mm[1]}: ${s.slice(0, 60)}`); break }
    if (out.length > 3) break
  }
  if (out.length) throw new Finding('isolation', [...new Set(out)].slice(0, 5).join('\n'))
}
