// actions.mjs: the action generator (a pure function of the seed: it never looks at what the system did) and the
// executor (real shared/ calls) that also feeds the oracle. Actions name devices ('r0:H1', 'r0:A2'), cards
// ('#c3'), notes ('#m1'), permission requests ('#p1'), attachments ('#f1'); the executor resolves them, and a name
// that does not resolve (the creating action was shrunk away) makes the action a skip.
import { RoomOracle } from './oracle.mjs'
import { Dev, Finding, sleep } from './world.mjs'

const hex = n => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')   // only for names never replayed
const hexOf = (rng, n) => Array.from({ length: n }, () => '0123456789abcdef'[rng.int(16)]).join('')
const OPTS = ['a', 'b', 'c', 'd']

// ---------------------------------------------------------------------------------------------------------
// generator
// ---------------------------------------------------------------------------------------------------------
export class Gen {
  constructor(rng, { rooms = 1, profile = 'strict', remote = false } = {}) {
    this.rng = rng; this.profile = profile; this.remote = remote
    this.R = Array.from({ length: rooms }, (_, i) => ({ i, humans: [`r${i}:H0`], agents: [], dead: new Set(), cards: [], perms: [], notes: [], strokes: [], desks: [hexOf(rng, 32), hexOf(rng, 32)], files: [], nH: 1, nA: 0, crashed: new Set(), removedAgents: new Set() }))
    this.c = { card: 0, perm: 0, note: 0, stroke: 0, file: 0, text: 0 }
  }
  text(label = 't') { return `FZMARK-${label}${this.c.text++} ${this.rng.word()}` }
  /** Next action. */
  next() {
    const rng = this.rng
    const r = this.R[rng.int(this.R.length)]
    const liveH = r.humans.filter(n => !r.dead.has(n) && !r.crashed.has(n))
    const liveA = r.agents.filter(n => !r.dead.has(n) && !r.crashed.has(n))
    const allLiveH = r.humans.filter(n => !r.dead.has(n))
    const strict = this.profile !== 'chaos'
    const choices = []
    const add = (w, f) => choices.push([f, w])
    const H = () => rng.pick(liveH), A = () => rng.pick(liveA)
    const openish = () => r.cards.filter(c => !r.dead.has(c.agent) && !r.crashed.has(c.agent))

    if (r.agents.length < 3 && liveH.length) add(r.agents.length ? 4 : 30, () => ({ t: 'invite_agent', room: r.i, inviter: H(), name: `r${r.i}:A${r.nA++}`, _add: 'agent' }))
    if (liveH.length && r.humans.length < 4) add(r.humans.length > 1 ? 3 : 14, () => {
      const mode = rng.weighted([['ok', 8], ['wrong_code', 2], ['stolen', 2]])
      return { t: 'invite_human', room: r.i, inviter: H(), name: `r${r.i}:H${r.nH++}`, mode, _add: 'human' }
    })
    if (liveA.length && liveH.length) {
      add(22, () => { const ref = `#c${this.c.card++}`; const ty = rng.weighted([['decision', 8], ['info', 3]]); const a = A()
        r.cards.push({ ref, agent: a }); return { t: 'card', room: r.i, agent: a, ref, card_type: ty, title: this.text('card'), options: ty === 'info' ? [] : OPTS.slice(0, rng.range(1, 4)).map(k => ({ key: k, label: `opt ${k}` })), urgency: rng.pick(['low', 'normal', 'normal', 'high', 'critical']), multi: rng.chance(0.2) } })
      if (r.cards.length) {
        const c = () => rng.pick(openish())
        add(7, () => { const x = c(); return x && { t: 'revise', agent: x.agent, ref: x.ref, title: this.text('rev'), urgency: rng.chance(0.3) ? rng.pick(['low', 'normal', 'high', 'critical']) : null } })
        add(2, () => { const x = c(); return x && { t: 'withdraw', agent: x.agent, ref: x.ref } })
        add(3, () => { const x = c(); return x && { t: 'close', agent: x.agent, ref: x.ref } })
        add(2, () => { const x = c(); return x && { t: 'merge', agent: x.agent, ref: x.ref, newRef: `#c${this.c.card++}`, title: this.text('merged') } })
        add(8, () => { const x = c(); if (!x) return null; return { t: 'agent_msg', agent: x.agent, ref: rng.chance(0.7) ? x.ref : null, text: this.text('am'), present: rng.chance(0.3) } })
      }
      add(6, () => ({ t: 'agent_msg', agent: A(), ref: null, text: this.text('am'), present: false }))
      add(4, () => { const a = A(); const ref = `#p${this.c.perm++}`; r.perms.push({ ref, agent: a }); return { t: 'perm', agent: a, ref, tool: rng.pick(['Bash', 'Edit', 'Write']) } })
      add(4, () => ({ t: 'reg_a', agent: A(), key: rng.pick(['profile', 'status_line/tests', 'status_line/build', 'status_line/x']), value: rng.chance(0.2) ? null : { label: this.text('l'), state: rng.pick(['ok', 'running', 'failed']), model: 'm', task: this.text('task') } }))
      add(2, () => { const a = A(); return { t: 'stroke', dev: a, tl: `session/@${a}`, n: rng.range(1, 3), sid: `S${this.c.stroke++}` } })
    }
    if (liveH.length) {
      if (r.cards.length) {
        const c = () => rng.pick(r.cards)
        add(14, () => { const x = c(); return { t: 'answer', dev: H(), ref: x.ref, pick: rng.weighted([['one', 10], ['bad', 2], ['two', 2], ['none', 1]]), trust: rng.chance(0.1) } })
        add(3, () => ({ t: 'read', dev: H(), ref: c().ref }))
        add(2, () => ({ t: 'shred', dev: H(), ref: c().ref }))
        add(5, () => ({ t: 'decide_again', dev: H(), ref: c().ref }))
        add(2, () => ({ t: 'stale_answer', dev: H(), ref: c().ref }))
        add(9, () => { const x = c(); return { t: 'msg_h', dev: H(), ref: x.ref, agent: x.agent, text: this.text('hm'), mode: rng.weighted([['plain', 6], ['hand_back', 2], ['explain', 1]]) } })
        add(5, () => ({ t: 'reg_h', dev: H(), key: rng.pick([`draft/${c().ref}`, `snooze/${c().ref}`, `duck/${c().ref}`]), value: rng.chance(0.25) ? null : { until: rng.chance(0.5) ? 4e12 : 1, note: this.text('d') } }))
      }
      if (liveA.length) add(9, () => ({ t: 'msg_h', dev: H(), ref: null, agent: A(), text: this.text('hm'), mode: 'plain' }))
      if (r.perms.length) add(6, () => ({ t: 'verdict', dev: H(), ref: rng.pick(r.perms).ref, allow: rng.chance(0.5) }))
      add(5, () => ({ t: 'reg_h', dev: H(), key: rng.pick(['crown', `desk/${rng.pick(r.desks)}`, `desk/${rng.pick(r.desks)}`]), value: rng.chance(0.2) ? null : { name: this.text('n'), n: rng.int(1000) } }))
      if (liveA.length) add(3, () => { const a = A(); return { t: 'reg_h', dev: H(), key: rng.pick([`session/@${a}`, `read_up_to/@${a}`]), value: rng.chance(0.2) ? null : rng.chance(0.5) ? { name: this.text('sn'), archived: rng.chance(0.3) } : rng.int(100) } })
      add(4, () => { const ref = r.notes.length && rng.chance(0.5) ? rng.pick(r.notes) : `#m${this.c.note++}`; if (!r.notes.includes(ref)) r.notes.push(ref); return { t: 'note', dev: H(), ref, text: this.text('note') } })
      if (r.notes.length) add(1, () => ({ t: 'note_del', dev: H(), ref: rng.pick(r.notes) }))
      add(8, () => ({ t: 'stroke', dev: H(), tl: `desk/${rng.pick(r.desks)}`, n: rng.range(1, 4), sid: `S${this.c.stroke++}` }))
      if (r.strokes.length) add(3, () => { const s = rng.pick(r.strokes); return { t: rng.pick(['erase', 'move', 'send_away']), dev: H(), tl: s.tl, ids: [s.id] } })
      add(1, () => ({ t: 'snapshot', dev: H(), tl: `desk/${rng.pick(r.desks)}` }))
      add(3, () => { const ref = `#f${this.c.file++}`; r.files.push(ref); return { t: 'attach', dev: H(), ref, size: rng.pick([1, 100, 65535, 65536, 65537, 150000, 262144]), where: rng.pick(['msg', 'msg', 'card']), agent: liveA.length ? A() : null } })
      if (r.files.length) add(3, () => ({ t: 'fetch_attach', dev: rng.chance(0.8) ? rng.pick(r.humans.filter(n => !r.dead.has(n))) : (liveA.length ? A() : H()), ref: rng.pick(r.files), range: rng.chance(0.5) }))
      if (liveH.length > 1 || allLiveH.length > 1) add(2, () => ({ t: 'remove', room: r.i, by: H(), target: rng.pick(r.humans.concat(r.agents).filter(n => !r.dead.has(n))), _rm: true }))
      if (!this.remote) add(1, () => ({ t: 'recover', room: r.i, name: `r${r.i}:H${r.nH++}`, _recover: true }))
    }
    // process lifecycle and the network
    if (r.humans.length + r.agents.length > 1 || true) {
      add(strict ? 3 : 2, () => { const all = r.humans.concat(r.agents).filter(n => !r.dead.has(n) && !r.crashed.has(n)); const d = rng.pick(all); r.crashed.add(d)
        return { t: 'crash', dev: d, mid: rng.chance(0.5) ? this.text('mid') : null, delay: rng.int(30) } })
      add(5, () => { const d = [...r.crashed][0]; return d && (r.crashed.delete(d), { t: 'restart', dev: d }) })
      add(3, () => ({ t: 'dup_send', dev: rng.pick(r.humans.concat(r.agents).filter(n => !r.dead.has(n) && !r.crashed.has(n))) }))
      add(3, () => ({ t: 'net', dev: rng.pick(r.humans.concat(r.agents).filter(n => !r.dead.has(n) && !r.crashed.has(n))), delay: rng.pick([0, 0, 5, 40]), lose: rng.pick([0, 0, 0.05, 0.2]), offline: rng.pick([0, 0, 0.05, 0.15]) }))
      add(2, () => ({ t: 'drop_streams', dev: rng.pick(r.humans.concat(r.agents).filter(n => !r.dead.has(n) && !r.crashed.has(n))) }))
      if (!this.remote) { add(1, () => ({ t: 'hub_restart' })); add(1, () => ({ t: 'prune' })) }
      add(1, () => ({ t: 'removed_try', room: r.i }))
      add(2, () => ({ t: 'http_fuzz', dev: rng.pick(r.humans.concat(r.agents).filter(n => !r.dead.has(n) && !r.crashed.has(n))), r: rng.int(1e9), n: 40 }))
      add(3, () => ({ t: 'forge', dev: rng.pick(r.humans.concat(r.agents).filter(n => !r.dead.has(n) && !r.crashed.has(n))), what: rng.pick(FORGERIES), room: r.i, r: rng.int(1e9) }))
    }
    // drop crashed devices from the pools; never let all humans become unusable
    for (let tries = 0; tries < 20; tries++) {
      const f = rng.weighted(choices)
      const a = f()
      if (a) {
        if (a._rm) { r.dead.add(a.target); if (r.agents.includes(a.target)) r.removedAgents.add(a.target) }
        if (a._add === 'agent') r.agents.push(a.name)
        if (a._add === 'human') { if (a.mode !== 'stolen' || true) r.humans.push(a.name) }
        if (a._recover) { for (const h of r.humans) r.dead.add(h); r.humans.push(a.name) }
        if (a.t === 'stroke') r.strokes.push({ id: a.sid, tl: a.tl })
        if (a.t === 'merge') r.cards.push({ ref: a.newRef, agent: a.agent })
        return a
      }
    }
    return { t: 'noop' }
  }
}
export const FORGERIES = ['foreign_version', 'foreign_close', 'foreign_register', 'foreign_timeline', 'foreign_answer', 'bitflip', 'garbage', 'bom', 'oversize', 'steal_envelope', 'foreign_note', 'agent_desk']

// ---------------------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------------------
const TOLERATED = new Set(['offline', 'timeout'])

export class Runner {
  constructor(world, { strict }) {
    this.w = world; this.strict = strict
    this.O = new Map()                 // room idx -> RoomOracle
    this.refs = new Map()              // '#c1' -> object id (hex), '#f1' -> attachment ref
    this.files = new Map()
    this.sent = { human: new Map(), agentIssued: 0 }    // what humans sent to agents (for the command-uniqueness check)
    this.log = []                      // [{ i, a, outcome }]
    this.flags = { pruned: false }
    this.notes = []                    // oracle caveats
  }
  staleSessionRefused() { this.known('A1-agent-send-refused-until-rekey', 'an agent\'s send waited for a human device to re-key its session after a removal and was refused (stale-session-key): no human device did it in time. Seen when a hostile hub serves the remover a member list without its own removal (it re-keys only once it has read that entry), or when the remover is offline') }
  known(id, text) {
    // FUZZ_STRICT=1: the masks of findings marked fixed in FINDINGS.md fail the run instead (to see what they still hide)
    if (process.env.FUZZ_STRICT && /^F(3|4|6|7|8|11|12|17|18|19)-/.test(id)) throw new Finding('masked', `${id}: ${text.slice(0, 120)}`)
    this.w.known.set(id, text)
  }
  oracle(i) { let o = this.O.get(i); if (!o) this.O.set(i, o = new RoomOracle(i)); return o }
  roomOf(i) { return this.w.rooms[i] }

  dev(name, { allowRemoved = false, allowDead = false } = {}) {
    const d = this.w.devs.get(name)
    if (!d || !d.client || (d.dead && !allowDead) || (d.removed && !allowRemoved)) return null
    return d
  }
  res(s) {
    if (typeof s !== 'string') return s
    // v1.1 (R6): a session is its own id; before, the agent's device id
    s = s.replace(/(session|read_up_to)\/@([A-Za-z0-9:_]+)/g, (m, k, n) => { const d = this.w.devs.get(n); return d ? `${k}/${d.client?.session_id ?? d.sessionId ?? d.id}` : m })
    return s.replace(/@([A-Za-z0-9:_]+)/g, (m, n) => this.w.devs.get(n)?.id ?? m).replace(/#([cmpf]\d+)/g, (m, n) => this.refs.get('#' + n)?.attachment_id ?? this.refs.get('#' + n) ?? m)
  }
  txt(s) { return `FZMARK b${this.w.batch} ${s}` }

  async run(a) {
    const w = this.w
    w.stats.actions++
    const fn = this[`do_${a.t}`]
    if (!fn) throw new Error(`no executor for ${a.t}`)
    let outcome
    try { outcome = await Promise.race([fn.call(this, a), sleep(a.t === 'found' && this.w.remote ? 3600e3 : 60000).then(() => { throw new Finding('liveness', `action ${a.t} did not finish within 60 s`, { action: a }) })]) }
    catch (e) {
      if (e instanceof Finding) throw e
      if (/simulated:|process killed|fenced:/.test(e?.message ?? '')) { w.stats.refused++; return 'refused:net' }
      if (e?.code && (e.name === 'ZError' || e?.constructor?.name === 'ZError')) { w.stats.refused++; outcome = `refused:${e.code}`; this.lastRefusal = e; if (e.code === 'stale-session-key') this.staleSessionRefused() }
      else throw new Finding('exception', `${a.t}: ${e?.stack ?? e}`, { action: a })
    }
    if (outcome === 'skip') w.stats.skipped++
    return outcome ?? 'ok'
  }

  // ---- membership ----
  async newDevFrom(name, room, role, storage) {
    const w = this.w
    const d = new Dev(w, room, name, role, name)
    d.storage_base = storage
    w.devs.set(name, d); room.devs.set(name, d)
    return d
  }
  async do_found(a) {
    const w = this.w
    const storage = w.newStorage('human')
    const d0 = new Dev(w, null, `r${a.room}:H0`, 'human', 'H0'); d0.storage_base = storage
    let out
    for (let attempt = 0; ; attempt++) {
      if (w.remote) await foundSlot(w)
      try { out = await w.t.core.foundRoom({ hub_url: w.hubUrl, storage, device_name: `FZ founder ${a.room}`, fetch: w.makeFetch(d0), found_token: w.remote ? process.env.FUZZ_FOUND_TOKEN || null : null }); break }
      catch (e) { if (e.code === 'rate-limited' && w.remote && attempt < 80) { await sleep(Math.min(120, e.retry_after || 60) * 1000); continue } throw e }
    }
    const { client, recovery_code } = out
    const room = { idx: a.room, room_id: client.model.room.room_id, recovery_code, devs: new Map([[d0.name, d0]]) }
    w.rooms[a.room] = room; d0.room = room; w.devs.set(d0.name, d0)
    await client.stop()
    await w.boot(d0)
    this.oracle(a.room).addMember(d0.name, 'human')
    if (w.onRoom) w.onRoom(room)
    return 'ok'
  }
  async joinFlow(a, role, { wrong = false } = {}) {
    const w = this.w, room = this.roomOf(a.room)
    const inviter = this.dev(a.inviter)
    if (!inviter || !inviter.isHuman) return 'skip'
    const storage = w.newStorage(role)
    const d = await this.newDevFrom(a.name, room, role, storage)
    d.joinedBatch = w.batch
    // F9 (fixed: a pruned answer counts from its signed header): a device that joins after a prune is compared as usual (masked content).
    inviter.faults = { delay: 0, lose_response: 0, offline: 0 }   // invites under faults wedge (known F4) and leave half-joined devices the oracle cannot judge
    const inv = await inviter.client.createInvite({ device_role: role })
    const j = this.w.t.core.joinRoom({ link: inv.link, storage, device_name: `FZ ${a.name}`, device_info: { device_name: `FZ ${a.name}`, platform: 'fuzz', folder: '~/fuzz', host: 'fz' }, fetch: w.makeFetch(d), poll_ms: 40 })
    return { inv, j, d, inviter }
  }
  async finishJoin(d) {
    const w = this.w
    await d.joinClient.stop?.()
    await w.boot(d)
  }
  async do_invite_agent(a) {
    const f = await this.joinFlow(a, 'agent'); if (f === 'skip') return f
    const { j, d, inviter } = f
    let client
    try {
      let stop = false
      const watcher = (async () => { while (!stop) { if (['failed', 'expired'].includes(inviter.client.model.invites.get(f.inv.invite_id)?.invite_state)) throw Object.assign(new Error('invite failed on the inviting side'), { inviteFailed: true }); await sleep(50) } })()
      watcher.catch(() => {})
      // Every agent invite asks: the human compares the six emoji the agent prints with the app's and taps "They match".
      const confirm = (async () => {
        const code = await j.check_code
        await untilTrue(() => inviter.client?.model.invites.get(f.inv.invite_id)?.invite_state === 'confirm_code', 'inviter never saw the agent', 20000)
        await inviter.client.confirmInvite(f.inv.invite_id, inviter.client.model.invites.get(f.inv.invite_id)?.check_code === code)
      })()
      confirm.catch(() => {})
      try { client = await inviteStep(this, a, inviter.client ? inviter : null, Promise.race([j.client, watcher]), 'agent join') } finally { stop = true }
    } catch (e) {
      j.cancel(); j.client.catch(() => {}); w_forget(this.w, d)
      if (e.known) return 'refused:invite-stuck'
      if (e.inviteFailed) { this.known('F4-agent-invite-failure-silent', 'an agent invite whose finalize hits a transient network error ends as invite_state failed on the inviter, and the joining agent keeps polling in silence until its 15 minute timeout'); return 'refused:invite-failed' }
      throw e
    }
    d.joinClient = client
    await this.finishJoin(d)
    this.oracle(a.room).addMember(d.name, 'agent')
    return 'ok'
  }
  async do_invite_human(a) {
    const f = await this.joinFlow(a, 'human'); if (f === 'skip') return f
    try { return await this.inviteHuman(a, f) } catch (e) { if (!this.w.devs.get(a.name)?.client) w_forget(this.w, f.d); throw e }
  }
  async inviteHuman(a, f) {
    const { inv, j, d, inviter } = f
    const O = this.oracle(a.room)
    if (a.mode === 'ok') {
      let code
      try {
        code = await inviteStep(this, a, inviter, j.check_code, 'check code')
        await inviteStep(this, a, inviter, untilTrue(() => inviter.client.model.invites.get(inv.invite_id)?.invite_state === 'confirm_code', 'inviter never saw the request', 20000), 'inviter request')
        await inviter.client.confirmInvite(inv.invite_id, inviter.client.model.invites.get(inv.invite_id)?.check_code === code)   // the human compares the emoji
        d.joinClient = await inviteStep(this, a, inviter, j.client, 'join')
      } catch (e) { j.cancel(); j.client.catch(() => {}); w_forget(this.w, d); if (e.known || e.code === 'offline' || e.code === 'invite-expired') return e.known ? 'refused:invite-stuck' : `refused:${e.code}`; throw e }
      await this.finishJoin(d)
      O.addMember(d.name, 'human')
      return 'ok'
    }
    if (a.mode === 'wrong_code') {
      let code
      try {
        code = await inviteStep(this, a, inviter, j.check_code, 'check code')
        await inviteStep(this, a, inviter, untilTrue(() => inviter.client.model.invites.get(inv.invite_id)?.invite_state === 'confirm_code', 'inviter never saw the request', 20000), 'inviter request')
      } catch (e) { j.cancel(); j.client.catch(() => {}); w_forget(this.w, d); if (e.known) return 'refused:invite-stuck'; throw e }
      // The human taps "They don't match" (whatever the two screens show): the invite burns, nobody joins.
      void code
      let err = null
      try { await inviter.client.confirmInvite(inv.invite_id, false) } catch (e) { err = e }
      if (err?.code !== 'code-mismatch') throw new Finding('invariant', `"they don't match" was not refused (got ${err?.code ?? 'success'})`, { action: a })
      j.cancel(); await j.client.catch(() => {})
      w_forget(this.w, d)
      return 'ok'
    }
    // stolen: an attacker posts its request first with the same link; the human compares the inviter's emoji with the victim's screen
    const attacker = this.w.t.core.joinRoom({ link: inv.link, storage: this.w.newStorage('human'), device_name: 'attacker', fetch: this.w.makeFetch(d), poll_ms: 40 })
    attacker.client.catch(() => {})
    await untilTrue(() => inviter.client.model.invites.get(inv.invite_id)?.invite_state === 'confirm_code', 'inviter never saw a request', 8000).catch(() => {})
    const victimCode = await Promise.race([j.check_code.catch(() => null), attacker.check_code.then(() => null, () => null), sleep(2500).then(() => null)])
    const shown = inviter.client.model.invites.get(inv.invite_id)?.check_code ?? null
    const matches = !!victimCode && shown === victimCode
    let err = null
    try { await inviter.client.confirmInvite(inv.invite_id, matches) } catch (e) { err = e }
    attacker.cancel()
    const joinedNow = inviter.client.model.invites.get(inv.invite_id)?.invite_state === 'joined'
    if (!joinedNow) j.cancel()
    await Promise.allSettled([attacker.client, j.client])
    // Whoever was answered first got the code. If the inviter's code matched the victim's screen and the victim was answered, it joins; otherwise nobody may join.
    const joined = inviter.client.model.invites.get(inv.invite_id)?.invite_state === 'joined'
    if (joined) {
      if (matches) { /* the victim was first: legitimate */ d.joinClient = await j.client.catch(() => null); if (d.joinClient) { await this.finishJoin(d); O.addMember(d.name, 'human') } else throw new Finding('invariant', 'invite joined but the intended device never got in', { action: a }) }
      else throw new Finding('invariant', 'stolen invite link: a device joined without the right check code', { action: a })
    } else w_forget(this.w, d)
    await sleep(0)
    return 'ok'
  }
  async do_remove(a) {
    const w = this.w, O = this.oracle(a.room)
    const by = this.dev(a.by), target = w.devs.get(a.target)
    if (!by || !by.isHuman || !target || target.removed) return 'skip'
    const humansActive = O.active('human')
    if (target.isHuman && humansActive.length <= 1) return 'skip'
    if (target === by) return 'skip'
    try { await by.client.removeDevices([target.id]) }
    catch (e) {
      // a lost response can hide a removal the hub did make
      const done = this.w.hub && this.w.hub.db.prepare('SELECT removed_entry_number r FROM devices WHERE room_id = ? AND device_id = ?').get(by.room.room_id, target.id)?.r != null
      if (!done) throw e
    }
    target.removed = true; target.removedBatch = w.batch
    for (const items of O.chat.values()) for (const it of items) if (it.from === target.name) it.certain = false   // may be beyond the cut
    O.remove([target.name])
    return 'ok'
  }
  async do_recover(a) {
    const w = this.w, room = this.roomOf(a.room), O = this.oracle(a.room)
    if (!room) return 'skip'
    // F10 (fixed: the recovery signs real cuts): the removed devices' history stays; compared like after a removal.
    const storage = w.newStorage('human')
    const d = await this.newDevFrom(a.name, room, 'human', storage)
    const { client, recovery_code } = await w.t.core.recoverRoom({ hub_url: w.hubUrl, room_id: room.room_id, code: room.recovery_code, storage, device_name: `FZ ${a.name}`, fetch: w.makeFetch(d) })
    room.recovery_code = recovery_code
    for (const [n, x] of room.devs) if (x.isHuman && n !== a.name && !x.removed) {
      x.removed = true; x.removedBatch = w.batch
      for (const items of O.chat.values()) for (const it of items) if (it.from === n) it.certain = false   // may be beyond the cut, as after a removal
    }
    O.recover(a.name)
    d.joinedBatch = w.batch
    await client.stop()
    await w.boot(d)
    return 'ok'
  }

  // ---- cards ----
  async do_card(a) {
    const d = this.dev(a.agent); if (!d || d.role !== 'agent') return 'skip'
    const id = await d.client.sendCard({ card_type: a.card_type, title: this.txt(a.title), body: `body ${a.title}`, options: a.options, urgency: a.urgency, allows_multiple: a.multi || undefined, recommended: a.options[0]?.key })
    this.refs.set(a.ref, id)
    this.oracle(d.room.idx).newCard(a.ref, a.agent, { title: this.txt(a.title), card_type: a.card_type, options: a.options, allows_multiple: a.multi, urgency: a.urgency })
    return 'ok'
  }
  card(a) { const id = this.refs.get(a.ref); return id ? id : null }
  async do_revise(a) {
    const d = this.dev(a.agent), id = this.card(a); if (!d || !id) return 'skip'
    const O = this.oracle(d.room.idx)
    const c = O.cards.get(a.ref)
    try { await d.client.revise(id, { title: this.txt(a.title), change_note: 'x', ...(a.urgency ? { urgency: a.urgency } : {}) }) }
    catch (e) { if (e.code === 'card-closed' && c && c.state !== 'open') return 'refused:card-closed'; throw e }
    if (this.strict && c && (c.state === 'answered' || (c.state === 'closed' && (c.closed_how === 'read' || c.closed_how === 'shredded')))) {
      // KNOWN F1: Client.revise checks the state it LAST SENT (open), not the answered state the humans put on the card: the revision reopens it and drops the answer.
      // F1 (fixed in core): an agent must not revise a card a human answered, read or shredded. Through a hostile hub
      // it may not have seen the answer (withheld): then the revision counts, as for the agent.
      if (!this.w.attack) throw new Finding('invariant', `F1 again: agent could revise ${a.ref} which the oracle holds as ${c.state}${c.closed_how ? '/' + c.closed_how : ''}`, { action: a })
      c.v++; c.title = this.txt(a.title); c.titles.add(c.title); if (a.urgency) c.urgency = a.urgency; c.state = 'open'; c.answer = null; c.closed_how = null; c.revision = null
      return 'ok'
    }
    if (!this.strict) return 'ok'
    if (c && c.state !== 'open' && this.w.attack) { c.v++; c.title = this.txt(a.title); c.titles.add(c.title); if (a.urgency) c.urgency = a.urgency; c.state = 'open'; c.answer = null; c.closed_how = null; c.revision = null; return 'ok' }   // a hostile hub withheld the close from the agent
    if (!O.revise(a.ref, { title: this.txt(a.title), urgency: a.urgency })) throw new Finding('invariant', `agent could revise ${a.ref} which the oracle holds as ${O.cards.get(a.ref)?.state}`, { action: a })
    return 'ok'
  }
  async do_withdraw(a) {
    const d = this.dev(a.agent), id = this.card(a); if (!d || !id) return 'skip'
    const O = this.oracle(d.room.idx), c = O.cards.get(a.ref)
    try { await d.client.withdraw(id, 'no longer needed') } catch (e) { if (e.code === 'card-closed' && c.state !== 'open') return 'refused:card-closed'; throw e }
    if (this.strict && (c.state === 'answered' || (c.state === 'closed' && (c.closed_how === 'read' || c.closed_how === 'shredded')))) { if (!this.w.attack) throw new Finding('invariant', `F1 again: agent could withdraw ${a.ref} which the oracle holds as ${c.state}${c.closed_how ? '/' + c.closed_how : ''}`, { action: a }); c.v++; c.state = 'closed'; c.closed_how = 'withdrawn'; c.revision = null; return 'ok' }
    if (!this.strict) return 'ok'
    if (c && c.state !== 'open' && this.w.attack) { c.v++; c.state = 'closed'; c.closed_how = 'withdrawn'; c.revision = null; return 'ok' }
    if (!O.withdraw(a.ref)) throw new Finding('invariant', `agent could withdraw ${a.ref} held as ${c.state}`, { action: a })
    return 'ok'
  }
  async do_close(a) {
    const d = this.dev(a.agent), id = this.card(a); if (!d || !id) return 'skip'
    const O = this.oracle(d.room.idx)
    await d.client.close(id, 'done')
    O.close(a.ref)
    return 'ok'
  }
  async do_merge(a) {
    const d = this.dev(a.agent), id = this.card(a); if (!d || !id) return 'skip'
    const O = this.oracle(d.room.idx), c = O.cards.get(a.ref)
    if (!c || c.state !== 'open') return 'skip'
    const nid = await d.client.merge([id], { title: this.txt(a.title), options: [{ key: 'a', label: 'merged a' }] })
    this.refs.set(a.newRef, nid)
    O.newCard(a.newRef, a.agent, { title: this.txt(a.title), card_type: 'decision', options: [{ key: 'a' }], urgency: c.urgency })
    c.v++; c.state = 'closed'; c.closed_how = 'merged'; c.revision = null
    return 'ok'
  }
  /** The card's owner agent was removed: it re-asserts nothing (F15) any more. */
  ownerGone(c) { const ag = c ? this.w.devs.get(c.agent) : null; return !ag || !!ag.removed }
  /** The owner agent is crashed (not running): it meets the refused answer only when it starts again. */
  ownerDown(c) { const ag = c ? this.w.devs.get(c.agent) : null; return !!ag && !ag.removed && (ag.dead || !ag.client) }
  async do_answer(a) {
    const d = this.dev(a.dev), id = this.card(a); if (!d || !d.isHuman || !id) return 'skip'
    const O = this.oracle(d.room.idx), c = O.cards.get(a.ref)
    if (!c) return 'skip'
    const cm = d.client.model.cards.get(id)
    if (!cm) return 'skip'
    let choices
    if (a.pick === 'one') choices = [c.options[0] ?? 'a']
    else if (a.pick === 'two') choices = c.options.slice(0, 2)
    else if (a.pick === 'bad') choices = ['zzz']
    else choices = []
    let action = 'answer'
    try {
      if (a.trust) await d.client.trust({ object_id: id }); else await d.client.answer({ object_id: id, choices, note: this.txt('note') })
    } catch (e) { if (['card-closed', 'bad-argument', 'card-pruned'].includes(e.code)) { return `refused:${e.code}` } throw e }
    O.attempts.add(a.ref)
    const trusted = !!a.trust
    const rec = trusted ? (cm.recommended == null ? [] : [].concat(cm.recommended)) : choices
    O.answer(a.ref, { action, choices: rec, trusted, ownerGone: this.ownerGone(c), ownerDown: this.ownerDown(c) })
    this.sent.human.set(`${a.ref}`, (this.sent.human.get(`${a.ref}`) ?? 0) + 1)
    return 'ok'
  }
  async do_read(a) {
    const d = this.dev(a.dev), id = this.card(a); if (!d || !d.isHuman || !id) return 'skip'
    const O = this.oracle(d.room.idx)
    O.attempts.add(a.ref)
    try { await d.client.markRead({ object_id: id }) } catch (e) { if (e.code === 'card-closed' || e.code === 'card-pruned') return `refused:${e.code}`; throw e }
    O.answer(a.ref, { action: 'read', choices: [], ownerGone: this.ownerGone(O.cards.get(a.ref)), ownerDown: this.ownerDown(O.cards.get(a.ref)) })
    return 'ok'
  }
  async do_shred(a) {
    const d = this.dev(a.dev), id = this.card(a); if (!d || !d.isHuman || !id) return 'skip'
    const O = this.oracle(d.room.idx)
    O.attempts.add(a.ref)
    try { await d.client.shred({ object_id: id }) } catch (e) { if (e.code === 'card-closed' || e.code === 'card-pruned') return `refused:${e.code}`; throw e }
    O.answer(a.ref, { action: 'shred', choices: [], ownerGone: this.ownerGone(O.cards.get(a.ref)), ownerDown: this.ownerDown(O.cards.get(a.ref)) })
    return 'ok'
  }
  async do_decide_again(a) {
    const d = this.dev(a.dev), id = this.card(a); if (!d || !d.isHuman || !id) return 'skip'
    const O = this.oracle(d.room.idx)
    try { await d.client.decideAgain({ object_id: id }) } catch (e) { if (['decision-mismatch', 'card-closed'].includes(e.code)) return `refused:${e.code}`; throw e }
    O.decideAgain(a.ref)
    return 'ok'
  }
  async do_stale_answer(a) {
    this.staleUsed = true
    // an answer bound to an OLDER version of the card: nobody may count it
    const d = this.dev(a.dev), id = this.card(a); if (!d || !d.isHuman || !id) return 'skip'
    const cm = d.client.model.cards.get(id)
    if (!cm || cm.object_state !== 'open' || cm.versions.length < 2) return 'skip'
    const z = this.w.t.z, old = cm.versions[cm.versions.length - 2]
    const bind = z.encodeAnswerBind({ cardId: z.unhex(id), cardHash: z.unhex(old.version_hash), choice: cm.options?.[0]?.key ?? 'a' })
    await d.client._send({ kind: this.w.t.codec.KIND.answer, content: { answer_action: 'answer', choices: [cm.options?.[0]?.key ?? 'a'] }, bind, recipient: cm.agent_device_id,
      object: { object_id: id, object_state: 'answered', urgency: cm.urgency, answered_at: Date.now() } })
    // oracle: no effect (refused by every member). A human did sign it, though: a hostile hub that serves it header-only
    // (as retention would) makes it count as a content-less answer (FINDINGS H2), so it is an attempt for the safety check.
    const ref = [...this.refs].find(([, v]) => v === id)?.[0]
    if (ref) this.oracle(d.room.idx).attempts.add(ref)
    return 'ok'
  }

  // ---- messages ----
  async do_msg_h(a) {
    const d = this.dev(a.dev); if (!d || !d.isHuman) return 'skip'
    const O = this.oracle(d.room.idx)
    const ag = this.w.devs.get(a.agent); if (!ag || ag.removed) return 'skip'
    const id = a.ref ? this.card(a) : null
    if (a.ref && !id) return 'skip'
    const text = this.txt(a.text)
    const fields = { text, ...(a.mode === 'hand_back' ? { hand_back: true } : a.mode === 'explain' ? { explain: true } : {}) }
    if (id) await d.client.sendMessage({ object_id: id, ...fields }); else await d.client.sendMessage({ agent_device_id: ag.id, ...fields })
    const tl = id ? `card/${a.ref}` : `session/@${a.agent}`
    O.addChat(tl, { from: a.dev, to: a.agent, text, certain: true })
    if (id && a.mode !== 'plain') O.handBack(a.ref, a.mode)
    return 'ok'
  }
  async do_agent_msg(a) {
    const d = this.dev(a.agent); if (!d || d.role !== 'agent') return 'skip'
    const O = this.oracle(d.room.idx)
    const id = a.ref ? this.card(a) : null
    if (a.ref && !id) return 'skip'
    const text = this.txt(a.text)
    await d.client.sendMessage({ text, ...(id ? { object_id: id } : {}), ...(a.present && id ? { present_card: true } : {}) })
    O.addChat(id ? `card/${a.ref}` : `session/@${a.agent}`, { from: a.agent, to: null, text, certain: true })
    if (a.present && id) O.presentCard(a.ref)
    return 'ok'
  }
  async do_perm(a) {
    const d = this.dev(a.agent); if (!d || d.role !== 'agent') return 'skip'
    const id = await d.client.requestPermission({ tool_name: a.tool, description: this.txt('perm'), input_preview: 'ls', expires_in_ms: 3_600_000 })
    this.refs.set(a.ref, id)
    this.oracle(d.room.idx).permRequest(a.ref, a.agent)
    return 'ok'
  }
  async do_verdict(a) {
    const d = this.dev(a.dev), id = this.card(a); if (!d || !d.isHuman || !id) return 'skip'
    const O = this.oracle(d.room.idx)
    if (!d.client.model.permissions.has(id)) return 'skip'
    await d.client.verdict({ object_id: id, allow: a.allow })
    O.verdict(a.ref, a.allow)
    return 'ok'
  }

  // ---- registers, notes ----
  async do_reg_h(a) {
    const d = this.dev(a.dev); if (!d || !d.isHuman) return 'skip'
    const key = this.res(a.key)
    if (/[#@]/.test(key)) return 'skip'
    await d.client.setRegisters({ [key]: a.value })
    this.oracle(d.room.idx).setReg(a.key, a.value)
    return 'ok'
  }
  async do_reg_a(a) {
    const d = this.dev(a.agent); if (!d || d.role !== 'agent') return 'skip'
    await d.client.setStatus({ [a.key]: a.value })
    this.oracle(d.room.idx).setAgentReg(a.agent, a.key, a.value)
    return 'ok'
  }
  async do_note(a) {
    const d = this.dev(a.dev); if (!d || !d.isHuman) return 'skip'
    const O = this.oracle(d.room.idx)
    const existing = this.refs.get(a.ref)
    if (existing && !d.client.model.notes.has(existing)) return 'skip'
    const text = this.txt(a.text)
    const id = await d.client.saveNote({ object_id: existing ?? null, text })
    this.refs.set(a.ref, id)
    const m = O.notes.get(a.ref)
    O.notes.set(a.ref, { text, state: 'open', v: (m?.v ?? 0) + 1 })
    ;(O.noteTexts.get(a.ref) ?? O.noteTexts.set(a.ref, new Set()).get(a.ref)).add(text)
    return 'ok'
  }
  async do_note_del(a) {
    const d = this.dev(a.dev), id = this.refs.get(a.ref); if (!d || !d.isHuman || !id || !d.client.model.notes.has(id)) return 'skip'
    await d.client.deleteNote(id)
    const m = this.oracle(d.room.idx).notes.get(a.ref); if (m) { m.state = 'closed'; m.v++ }
    return 'ok'
  }

  // ---- canvas ----
  async do_stroke(a) {
    const d = this.dev(a.dev); if (!d) return 'skip'
    const tl = this.res(a.tl)
    if (tl.includes('@')) return 'skip'
    const strokes = Array.from({ length: a.n }, (_, i) => ({ stroke_id: `${a.sid}.${i}`, points: 'AAAAAAAB', style: { tool: 'pen', color: '#123', size: 2 } }))
    await d.client.sendStrokes({ timeline_id: tl, content_type: 'strokes', strokes })
    this.oracle(d.room.idx).addCanvas(a.tl, { type: 'strokes', ids: strokes.map(s => s.stroke_id) })
    return 'ok'
  }
  async canvasTombstone(a, type) {
    const d = this.dev(a.dev); if (!d || !d.isHuman) return 'skip'
    const tl = this.res(a.tl); if (tl.includes('@')) return 'skip'
    await d.client.sendStrokes({ timeline_id: tl, content_type: type, stroke_ids: a.ids, ...(type !== 'erase' ? { offset: { x: 3, y: 4 } } : {}) })
    this.oracle(d.room.idx).addCanvas(a.tl, { type, ids: a.ids })
    return 'ok'
  }
  do_erase(a) { return this.canvasTombstone(a, 'erase') }
  do_move(a) { return this.canvasTombstone(a, 'move') }
  do_send_away(a) { return this.canvasTombstone(a, 'send_away') }
  async do_snapshot(a) {
    const d = this.dev(a.dev); if (!d || !d.isHuman) return 'skip'
    const bytes = new TextEncoder().encode(this.txt('snapshot-bytes'))
    const ref = await d.client.uploadAttachment(bytes, { file_name: 'canvas.snapshot', media_type: 'application/octet-stream' })
    const key = `canvas_snapshot/${a.tl.replace('desk/', 'desk/')}`
    const value = { attachment: ref, last_envelope_number: d.client.model.room.last_envelope_number, frontier: {} }
    await d.client.setRegisters({ [key]: value })
    this.oracle(d.room.idx).setReg(key, value)
    return 'ok'
  }

  // ---- attachments ----
  bytesFor(a) {
    const u = new Uint8Array(a.size)
    const mark = new TextEncoder().encode(`FZMARK-FILE ${a.ref} `)
    for (let i = 0; i < u.length; i++) u[i] = (i * 31 + a.size) & 255
    u.set(mark.subarray(0, Math.min(mark.length, u.length)), 0)
    return u
  }
  async do_attach(a) {
    const d = this.dev(a.dev); if (!d || !d.isHuman) return 'skip'
    const bytes = this.bytesFor(a)
    const ref = await d.client.uploadAttachment(bytes, { file_name: `f-${a.ref}.bin`, media_type: 'application/octet-stream' })
    this.refs.set(a.ref, ref)
    this.files.set(a.ref, { size: a.size, by: a.dev })
    const ag = a.agent && this.w.devs.get(a.agent)
    if (ag && !ag.removed && ag.role === 'agent') {
      const text = this.txt(`file ${a.ref}`)
      await d.client.sendMessage({ agent_device_id: ag.id, text, attachments: [ref] })
      this.oracle(d.room.idx).addChat(`session/@${a.agent}`, { from: a.dev, to: a.agent, text, certain: true })
    }
    return 'ok'
  }
  async do_fetch_attach(a) {
    const d = this.dev(a.dev); const ref = this.refs.get(a.ref); if (!d || !ref || !ref.attachment_id) return 'skip'
    if (!this.files.has(a.ref)) return 'skip'
    const want = this.bytesFor({ ref: a.ref, size: this.files.get(a.ref).size })
    if (d.room !== this.w.devs.get(this.files.get(a.ref).by)?.room) return 'skip'
    if (this.flags.pruned) return 'ok'
    // another device fetches: bypass the uploader's cache
    d.client.attachmentCache.delete(ref.attachment_id)
    const got = await d.client.fetchAttachment(ref)
    if (got.length !== want.length || !got.every((b, i) => b === want[i])) throw new Finding('invariant', `attachment ${a.ref} came back different (${got.length} vs ${want.length} bytes)`, { action: a })
    if (a.range) {
      const full = await d.client.hub.getAttachment(ref.attachment_id)
      const lo = Math.floor(full.length / 3), hi = Math.min(full.length - 1, lo + 70000)
      const res = await d.client.hub.fetch(`${d.client.hub.hub_url}/v1/rooms/${d.client.hub.room_id}/attachments/${ref.attachment_id}`, { headers: { authorization: await d.client.hub.authHeader(), range: `bytes=${lo}-${hi}` } })
      const part = new Uint8Array(await res.arrayBuffer())
      if (res.status !== 206 && !(res.status === 200 && lo === 0)) throw new Finding('invariant', `range read answered ${res.status}`, { action: a })
      if (res.status === 206 && (part.length !== hi - lo + 1 || !part.every((b, i) => b === full[lo + i]))) throw new Finding('invariant', 'range read returned other bytes than the stored blob', { action: a })
    }
    return 'ok'
  }

  // ---- lifecycle and network ----
  async do_crash(a) {
    const d = this.dev(a.dev); if (!d) return 'skip'
    const O = this.oracle(d.room.idx)
    let pending = null, midText = null
    if (a.mid) {
      midText = this.txt(a.mid)
      const target = d.isHuman ? [...d.room.devs.values()].find(x => x.role === 'agent' && !x.removed && x.id) : null
      let tl, send
      if (d.isHuman && target) { tl = `session/@${target.name}`; send = () => d.client.sendMessage({ agent_device_id: target.id, text: midText }) }
      else if (!d.isHuman) { tl = `session/@${d.name}`; send = () => d.client.sendMessage({ text: midText }) }
      if (send) {
        const item = { from: d.name, to: target?.name ?? null, text: midText, certain: false }
        O.addChat(tl, item)
        pending = send().then(() => { item.certain = true }, () => {})
        await sleep(a.delay)
      }
    }
    await this.w.crash(d)
    if (pending) await Promise.race([pending, sleep(3000)])   // a send of a killed process may never settle; that is not a finding
    return 'ok'
  }
  async do_restart(a) {
    const d = this.dev(a.dev, { allowDead: true, allowRemoved: true }); if (!d || !d.dead) return 'skip'
    if (d.removed) { d.dead = false; return 'skip' }
    d.faults = { delay: 0, lose_response: 0, offline: 0 }
    await this.w.boot(d)
    return 'ok'
  }
  async do_dup_send(a) {
    const d = this.dev(a.dev); if (!d) return 'skip'
    const last = d.client.recentSent.at(-1); if (!last) return 'skip'
    try { await d.client.hub.postEnvelope(last.bytes) } catch (e) { if (e.status !== 0 && !['replay', 'gap', 'rate-limited', 'wrong-epoch', 'removed-sender', 'offline', 'lease-lost'].includes(e.code)) throw new Finding('invariant', `a duplicate post was answered with ${e.code} (${e.status}); expected success or replay`, { action: a }) }
    return 'ok'
  }
  /** Hand-written traces only (dev/fuzz/regress): let timers run (a stream's reconnect, a re-send) where a mode does not quiesce. */
  async do_wait(a) { await sleep(Math.min(Number(a.ms) || 0, 5000)); return 'ok' }
  async do_net(a) { const d = this.dev(a.dev); if (!d) return 'skip'; if (a.lose || a.offline) d.everFaulty = true; d.faults = { delay: a.delay, lose_response: a.lose, offline: a.offline }; return 'ok' }
  async do_drop_streams(a) { const d = this.dev(a.dev); if (!d) return 'skip'; for (const ac of [...d.controllers]) { try { ac.abort(new Error('simulated reset')) } catch {} } return 'ok' }
  async do_hub_restart() {
    if (!(await this.w.restartHub())) return 'skip'
    // The lease survives a restart since F16 (9aa7248); the re-claim stays as an extra take-over path for the agents (R4)
    for (const d of this.w.devs.values()) if (d.role === 'agent' && d.client && !d.dead && !d.removed) {
      for (let k = 0; k < 8; k++) { try { await d.client.claimSession({ process_instance: `pi-${d.name}-re-${Math.random().toString(36).slice(2)}` }); break } catch (e) { d.errors.push(`reclaim: ${e.code ?? e.message}`); await sleep(150) } }
    }
    return 'ok'
  }
  async do_prune() {
    if (!this.w.hub) return 'skip'
    this.w.hub.prune({ days: -1000 })
    this.flags.pruned = true; this.prunedBatch ??= this.w.batch
    this.prunedRefs ??= new Set()
    // what the hub holds as not-open (it judges by header only: an answer with a bad choice already counts)
    const m = new Map([...this.refs].filter(([k]) => k.startsWith('#c')).map(([k, id]) => [id, k]))
    for (const r of this.w.hub.db.prepare('SELECT object_id FROM objects WHERE object_state != 1').all()) { const ref = m.get(r.object_id); if (ref) { this.prunedRefs.add(ref); if (this.O.get(0) && [...this.O.values()].some(O => O.cards.get(ref)?.state === 'open')) { this.known('F15-invalid-answer-closes-card-at-the-hub', 'the hub derives object_state from the signed header alone: an answer the clients refuse (bad choice, read on a decision card, answer to a stale version) still marks the object closed for retention, so the card (still open on every client) is pruned to header-only after 30 days and its content is destroyed'); this.prunedForAll = true } } }
    for (const O of this.O.values()) { for (const [ref, c] of O.cards) if (c.state !== 'open') this.prunedRefs.add(ref); for (const [ref, p] of O.perms) if (p.state !== 'pending') this.prunedRefs.add(ref) }
    const pm = new Map([...this.refs].filter(([k]) => k.startsWith('#p')).map(([k, id]) => [id, k]))
    for (const r of this.w.hub.db.prepare('SELECT object_id FROM objects WHERE object_state != 1').all()) { const ref = pm.get(r.object_id); if (ref) this.prunedRefs.add(ref) }
    // objects no action knows by name (a card sent by a process that crashed before the action returned): masked as check.mjs names them
    for (const r of this.w.hub.db.prepare('SELECT object_id FROM objects WHERE object_state != 1').all()) if (!m.has(r.object_id) && !pm.has(r.object_id)) this.prunedRefs.add(`?${r.object_id.slice(0, 8)}`)
    return 'ok'
  }
  async do_noop() { return 'skip' }
  async do_removed_try(a) {
    // a removed device keeps its keys and tries everything: nothing it sends after the cut may show up anywhere
    const ds = [...this.w.devs.values()].filter(d => d.removed && d.client && !d.dead && d.room?.idx === a.room)
    if (!ds.length) return 'skip'
    const d = ds[0]
    const text = this.txt('FROM-REMOVED')
    try { if (d.isHuman) { const ag = [...d.room.devs.values()].find(x => x.role === 'agent' && !x.removed); if (ag) await d.client.sendMessage({ agent_device_id: ag.id, text }) } else await d.client.sendMessage({ text }) } catch {}
    try { await d.client.setRegisters(d.isHuman ? { crown: { n: 'FROM-REMOVED' } } : { profile: { task: 'FROM-REMOVED' } }) } catch {}
    return 'ok'
  }
  async do_http_fuzz(a) { const { doHttpFuzz } = await import('./httpfuzz.mjs'); return doHttpFuzz(this, a) }
  async do_forge(a) { const { forge } = await import('./forge.mjs'); return forge(this, a) }
}

/** Remote hubs allow 10 rooms per address and hour: keep a ledger and stay under 8 (all workers share it through the file). */
async function foundSlot(w) {
  const fs = await import('node:fs'), path = await import('node:path'), { FUZZ_DIR } = await import('./env.mjs')
  const file = path.join(FUZZ_DIR, 'remote-rooms.jsonl')
  for (let i = 0; i < 400; i++) {
    let n = 0
    try { for (const l of fs.readFileSync(file, 'utf8').split('\n')) if (l) { const r = JSON.parse(l); if (r.hub === w.remote && Date.now() - Date.parse(r.at) < 3600e3) n++ } } catch {}
    if (n < 6) return
    await sleep(30000)
  }
}
const faulty = d => !!(d?.faults?.offline || d?.faults?.lose_response)
/** Wait for an invite step; a stall under network faults is the known F4 (wedged invite), without faults a finding. */
async function inviteStep(R, a, inviter, promise, what, ms = 20000) {
  let timer
  const stuck = new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error(`invite stuck at ${what}`), { stuck: true })), ms) })
  try { return await Promise.race([promise, stuck]) }
  catch (e) {
    if (e.stuck) {
      if (faulty(inviter)) { R.known('F4-invite-wedges-after-transient-error', 'an invite stalls forever when a request between accepting the join request and the reveal/finalize fails once (network error): the inviter retries accept (now refused or skipped) and the joiner waits until its 15 minute timeout in silence'); throw Object.assign(e, { known: true }) }
      throw new Finding('liveness', `invite stuck at ${what} without any network fault (${a.t} ${a.name})`, { action: a })
    }
    throw e
  } finally { clearTimeout(timer) }
}
function w_forget(w, d) { w.devs.delete(d.name); d.room?.devs.delete(d.name) }
export async function untilTrue(fn, msg, ms = 8000) {
  const end = Date.now() + ms
  for (;;) { if (await fn()) return true; if (Date.now() > end) throw new Finding('liveness', `timeout: ${msg}`); await sleep(15) }
}
