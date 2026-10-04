// agent.mjs: what an agent's client does (the channel drives it): objects (cards, permission requests, published),
// messages, status registers, and the gate on everything a human sends it (authoriseCommand) before it becomes a
// `command`. Mixed into Client (see index.mjs). Contract: client/core/README.md "Agent API".
import * as z from './zcrypto.mjs'
import * as codec from './codec.mjs'
import * as M from './model.mjs'
import { Client, randomHex, objectIdOf, ZERO_HASH } from './client.mjs'

const { unhex, hex, ZError } = z
const URGENCY_ORDER = ['low', 'normal', 'high', 'critical']

const agentMethods = {
  _needAgent() { if (this.is_human) throw new ZError('forbidden', 'only an agent does this') },

  /**
   * The lease (v1.1): one running process per agent key. A new process takes over; the hub ends the old one's
   * stream, whose reconnect (naming the old lease generation) and posts get 409 lease-lost: client 'error' code
   * 'lease-lost', then it stops, before it posts anything. Renewals never take over (renew: true).
   * Returns { agent_session_id, lease_generation, expires_at }; agent_session_id = hex(device_id).slice(0, 16).
   */
  async claimSession({ process_instance } = {}) {
    this._needAgent()
    const instance = process_instance ?? randomHex(8)
    const r = await this.hub.agentLease({ process_instance: instance })
    this.hub.lease_generation = r.lease_generation
    this._leaseInstance = instance
    clearInterval(this._leaseTimer)
    const every = Math.max(30_000, Math.min(5 * 60_000, ((r.expires_at ?? Date.now() + 600_000) - Date.now()) / 2))
    this._leaseTimer = setInterval(() => this.hub.agentLease({ process_instance: instance, renew: true }).then(x => { this.hub.lease_generation = x.lease_generation }).catch(e => {
      if (e.code === 'lease-lost') this.hub.onLeaseLost(e)
    }), every)
    this._leaseTimer.unref?.()
    const agent_session_id = r.agent_session_id ?? this.my_device_id.slice(0, 16)
    this.model.room.agent_session_id = agent_session_id
    const ch = M.emptyChange(); ch.room = true; this._emitChange(ch)
    return { ...r, agent_session_id }
  },

  /** The newest version of an own object: what was last sent (may be ahead of the model until the hub echoes it). */
  _head(object_id) {
    const local = this.localHeads.get(object_id)
    const card = this.model.cards.get(object_id)
    if (local && (!card || local.object_version >= card.object_version)) return local
    if (card) {
      const content = { object_type: 'card' }
      for (const f of codec.CARD_CONTENT_FIELDS) content[f] = card[f]
      return { object_version: card.object_version, version_hash: card.version_hash, content, object_state: card.object_state, urgency: card.urgency }
    }
    const pub = this.model.published.get(object_id)
    if (pub) return { object_version: pub.object_version, version_hash: pub.version_hash, content: { object_type: 'published', attachments: pub.attachments, title: pub.title, note: pub.note, released_until: pub.released_until }, object_state: pub.object_state, urgency: 'normal' }
    return null
  },

  /** One new version of an own object. `make(head)` returns { fields, object_state, urgency }. object_id null: a new object (R1 id). */
  async _version(object_id, make, { push = false, kind = codec.KIND.object_version, bind = null, session_id = null } = {}) {
    let id = object_id
    const sid = session_id ?? (object_id ? (this.model.cards.get(object_id)?.session_id ?? this.model.published.get(object_id)?.session_id ?? this.localHeads.get(object_id)?.session_id) : null) ?? this.session_id
    if (!sid) throw new ZError('no-session', 'no session is assigned to this agent yet')
    const r = await this._send({
      kind, push,
      content: async () => {
        if (!id) id = await objectIdOf(this.my_device_id, (this.chains.get(z.b64u(this.device.id))?.seq ?? 0) + 1)
        const head = id === object_id ? this._head(id) : null
        const { fields, object_state, urgency } = make(head, id)
        const content = kind === codec.KIND.object_version
          ? { ...(head?.content ?? {}), ...fields, object_version: (head?.object_version ?? 0) + 1, previous_version_hash: head?.version_hash ?? ZERO_HASH }
          : fields
        for (const k of Object.keys(content)) if (content[k] === undefined) delete content[k]
        return { content, object: { object_id: id, object_state, urgency }, bind: bind ? bind(id) : null, session_id: sid }
      },
      after: (sealed, content) => kind === codec.KIND.object_version && this.localHeads.set(id, { session_id: sid, object_version: content.object_version, version_hash: hex(sealed.hash), content, object_state: codec.OBJECT_STATE_NAME[sealed.header.card.state], urgency: codec.URGENCY_NAME[sealed.header.card.urgency] }),
    })
    return { ...r, object_id: id }
  },

  async sendCard({ card_type = 'decision', urgency = 'normal', session_id = null, ...fields }) {
    this._needAgent()
    if (card_type === 'decision' && !(fields.options?.length >= 1)) throw new ZError('bad-argument', 'a decision needs options')
    const r = await this._version(null, () => ({ fields: { object_type: 'card', card_type, ...fields }, object_state: 'open', urgency }), { push: true, session_id })
    return r.object_id
  },

  _ownOpen(object_id) {
    const head = this._head(object_id)
    if (!head || head.content.object_type !== 'card') throw new ZError('not-found', `no own card ${object_id}`)
    const card = this.model.cards.get(object_id)
    if (card && card.agent_device_id !== this.my_device_id) throw new ZError('forbidden', 'not this agent\'s card')
    return head
  },

  async revise(object_id, { urgency, ...changes } = {}) {
    this._needAgent()
    const head = this._ownOpen(object_id)
    if (head.object_state !== 'open') throw new ZError('card-closed', 'only an open card can be revised')
    for (const f of ['close_summary', 'withdraw_reason', 'merged_into_object_id']) changes[f] = changes[f] ?? null
    await this._version(object_id, h => ({ fields: changes, object_state: 'open', urgency: urgency ?? h.urgency }))
  },
  setUrgency(object_id, urgency, urgency_reason) { return this.revise(object_id, { urgency, ...(urgency_reason !== undefined ? { urgency_reason } : {}) }) },

  async withdraw(object_id, withdraw_reason = '') {
    this._needAgent()
    const head = this._ownOpen(object_id)
    if (head.object_state !== 'open') throw new ZError('card-closed', 'only an open card can be withdrawn; close an answered one')
    await this._version(object_id, h => ({ fields: { withdraw_reason }, object_state: 'closed', urgency: h.urgency }))
  },

  async merge(object_ids, { session_id = null, ...fields }) {
    this._needAgent()
    const heads = object_ids.map(id => [id, this._ownOpen(id)])
    for (const [, h] of heads) if (h.object_state !== 'open') throw new ZError('card-closed', 'only open cards can be merged')
    const urgency = fields.urgency ?? heads.map(([, h]) => h.urgency).reduce((a, b) => (URGENCY_ORDER.indexOf(b) > URGENCY_ORDER.indexOf(a) ? b : a), 'low')
    const { urgency: _u, ...rest } = fields
    const new_id = await this.sendCard({ ...rest, urgency, merged_from_object_ids: object_ids, session_id: session_id ?? this.model.cards.get(object_ids[0])?.session_id ?? null })
    for (const [id] of heads) await this._version(id, h => ({ fields: { merged_into_object_id: new_id }, object_state: 'closed', urgency: h.urgency }))
    return new_id
  },

  /** Close an own card (after an answer, or any time) or end a published object. */
  async close(object_id, close_summary = '') {
    this._needAgent()
    const head = this._head(object_id)
    if (!head) throw new ZError('not-found', `no own object ${object_id}`)
    if (head.content.object_type === 'published') return this._version(object_id, h => ({ fields: {}, object_state: 'closed', urgency: h.urgency }))
    this._ownOpen(object_id)
    await this._version(object_id, h => ({ fields: { close_summary }, object_state: 'closed', urgency: h.urgency }))
  },
  unpublish(object_id) { return this.close(object_id) },

  async publish({ attachments, title, note, released_until, session_id = null }) {
    this._needAgent()
    const r = await this._version(null, () => ({ fields: { object_type: 'published', attachments, title, note, released_until }, object_state: 'open', urgency: 'normal' }), { session_id })
    return r.object_id
  },

  setStatus(values, { session_id = null } = {}) { this._needAgent(); return this.setRegisters(values, { session_id }) },

  async requestPermission({ tool_name, description = '', input_preview = '', expires_in_ms = 10 * 60_000, session_id = null }) {
    this._needAgent()
    const expiresAt = Date.now() + expires_in_ms
    const r = await this._version(null, () => ({ fields: { tool_name, description, input_preview }, object_state: 'open', urgency: 'critical' }),
      { kind: codec.KIND.permission_request, push: true, session_id, bind: id => z.encodeRequestBind({ requestId: unhex(id), expiresAt }) })
    return r.object_id
  },

  // ---- the gate ---------------------------------------------------------------------------

  /** Called by the sync engine BEFORE the reducer applies the record: judge it against the board as it is. */
  _preAuthorise(rec) {
    if (rec.recipient_device_id !== this.my_device_id) return null
    if (rec.sender_sequence <= (this.delivered.get(rec.sender_device_id) ?? 0)) return null
    if (![codec.KIND.timeline_item, codec.KIND.answer, codec.KIND.verdict, codec.KIND.decide_again].includes(rec.kind)) return null
    const base = { session_id: rec.session_id ?? null, envelope_number: rec.envelope_number, envelope_hash: rec.envelope_hash, sender_sequence: rec.sender_sequence, sent_at: rec.sent_at, sender_device_id: rec.sender_device_id, object_id: rec.object?.object_id ?? null,
      timeline_key: rec.timeline_id ? M.timelineKey(rec.timeline_kind, rec.timeline_id) : null, rec }
    if (rec.is_head && !rec.content) return { ...base, refused: 'undecryptable' }
    const sk = rec.session_id ? this.sessionKeys.get(rec.session_id) : null
    if (rec.session_id && !sk?.state.agentIds.includes(this.my_device_id)) return { ...base, refused: 'not-assigned', message: 'a command in a session this agent does not hold' }
    const ctx = { state: this.state, agentId: this.device.id, now: Date.now(), ownSeq: this.chains.get(z.b64u(this.device.id))?.seq ?? 0,
      epochChangedAt: rec.session_id ? sk?.since ?? null : this.epochChangedAt, sessionEpoch: sk?.state.epoch ?? null,
      seenOfMe: this.frontiers.get(rec.sender_device_id)?.get(this.my_device_id) ?? 0 }
    const card = rec.object ? this.model.cards.get(rec.object.object_id) : null
    if (rec.kind === codec.KIND.answer || rec.kind === codec.KIND.decide_again) {
      if (card) {
        // R7: every answer's choices are options; a trusted answer's choices also the agent's own recommendation.
        const answering = rec.kind === codec.KIND.answer && rec.content?.answer_action === 'answer'
        const recd = card.recommended == null ? [] : Array.isArray(card.recommended) ? card.recommended : [card.recommended]
        const options = (card.options ?? []).map(o => o.key)
        ctx.card = { id: unhex(card.object_id), hash: unhex(card.version_hash), open: card.object_state === 'open', options: answering ? (rec.content?.trusted ? options.filter(k => recd.includes(k)) : options) : null }
        if (card.answer?.envelope_hash) ctx.decision = { hash: unhex(card.answer.envelope_hash) }
        base.previous_choices = card.answer?.choices ?? null
      }
    } else if (rec.kind === codec.KIND.verdict) {
      const p = this.model.permissions.get(rec.object?.object_id ?? rec.bind?.requestId)
      if (p) ctx.request = { id: unhex(p.object_id), hash: unhex(p.version_hash), expiresAt: p.expires_at, pending: p.permission_state === 'pending' }
    }
    try {
      const r = z.authoriseCommand({ header: rec._header, kind: rec.kind, bind: rec._bind ?? new Uint8Array(0) }, ctx)
      return { ...base, late: r.late, refused: null }
    } catch (e) {
      return { ...base, refused: e.code ?? 'refused', message: e.message }
    }
  },

  /**
   * After a batch: refresh the member list before any answer/verdict/decide-again (R3), fetch bodies of thread items
   * that came pruned, then hand out commands in order, once per (sender, sequence) (R4). Refusals become alert/<envelope_hash>.
   */
  async _deliverCommands(commands) {
    // Held commands go first, in order (MEDIUM-6: a halt holds commands back, it never drops them).
    if (this._heldCommands?.length && !this.commandsHalted) { commands = [...this._heldCommands, ...commands]; this._heldCommands = [] }
    // Review 3: a held command and the same envelope met again in a replay (resync) are one command: once per envelope hash.
    commands = dedupeCommands(commands)
    if (!this.commandsHalted && commands.some(c => !c.refused && c.rec.is_head)) {
      const err = await this._refreshMembers({ throwOnFork: true }).then(() => null, e => e)
      if (err?.code === 'log-fork' || err?.code === 'log-rollback') {
        this.commandsHalted = err.code
        this.emit('error', new ZError(err.code, 'the member list forked: commands halted until a human acts'))
      } else if (err) {
        // R3 fails closed: no answer, verdict or decide-again without a fresh member list. Hold and try again soon.
        this._heldCommands = dedupeCommands([...(this._heldCommands ?? []), ...commands])
        clearTimeout(this._heldTimer)
        this._heldTimer = setTimeout(() => this.serial(() => this._deliverCommands([])).catch(e => this.emit('error', e)), 3000)
        this._heldTimer.unref?.()
        return
      }
    }
    if (this.commandsHalted) { this._heldCommands = dedupeCommands([...(this._heldCommands ?? []), ...commands]); return }   // held, not marked delivered
    for (const c of commands) {
      if (c.refused) continue
      const sender = z.memberAt(this.state, unhex(c.sender_device_id))
      if (!sender || sender.role !== z.ROLE.HUMAN) { c.refused = 'removed-sender'; c.message = 'the sender was removed meanwhile'; continue }
      if (c.rec.kind === codec.KIND.timeline_item && !c.rec.content && c.timeline_key) {
        const items = await this._readTimeline(c.timeline_key, { before: c.envelope_number + 1, limit: 50 }).catch(() => [])
        const it = items.find(i => i.envelope_number === c.envelope_number)
        if (it?.content) { c.rec.content = it.content; c.rec.content_state = 'ok' }
        else { c.refused = 'undecryptable'; c.message = 'the body of this message could not be fetched' }
      }
    }
    const alerts = {}
    for (const c of commands) {
      if ((this.delivered.get(c.sender_device_id) ?? 0) < c.sender_sequence) this.delivered.set(c.sender_device_id, c.sender_sequence)
      if (c.refused) {
        alerts[`alert/${c.envelope_hash}`] = { code: c.refused, message: c.message ?? '', sender_device_id: c.sender_device_id, envelope_number: c.envelope_number }
        this.emit('alert', { code: c.refused, message: c.message ?? '', envelope_number: c.envelope_number, sender_device_id: c.sender_device_id, source: 'local' })
        continue
      }
      // R4: every command sent before the history boundary (the first start without sync state) is history, not a prompt:
      // by envelope number (the room's head then; review 3: the signed sent_at alone let a future-dated old command count
      // as live) and by time.
      c.history = (this.historyBeforeNumber != null && c.envelope_number <= this.historyBeforeNumber) || (this.historyBefore != null && c.sent_at < this.historyBefore)
      this.emit('command', commandOf(this.model, c))
    }
    if (Object.keys(alerts).length) this.setRegisters(alerts).catch(e => this.emit('error', e))   // not awaited: we are inside the sync queue
    this._dirty.records.set('sync', this._syncRecord())
  },

  /** A human resolved a fork (or the channel decides to go on): deliver commands again, the held ones first. */
  resumeCommands() { this.commandsHalted = null; return this.serial(() => this._deliverCommands([])) },
}

function dedupeCommands(list) {
  const seen = new Set()
  return list.filter(c => { if (seen.has(c.envelope_hash)) return false; seen.add(c.envelope_hash); return true })
}

function commandOf(model, c) {
  const { rec } = c
  const content = rec.content ?? {}
  const card = c.object_id ? model.cards.get(c.object_id) ?? null : null
  const out = { session_id: c.session_id ?? null, envelope_number: c.envelope_number, envelope_hash: c.envelope_hash, sender_device_id: c.sender_device_id, sender_sequence: c.sender_sequence, sent_at: c.sent_at,
    object_id: c.object_id, timeline_key: c.timeline_key, content, late: !!c.late, history: !!c.history, card }
  switch (rec.kind) {
    case codec.KIND.timeline_item: {
      const ct = content.content_type
      const scope = rec.timeline_id?.startsWith('card/') ? rec.timeline_id.slice(5) : null
      return { ...out, command: ct === 'selection_sent' ? 'selection_sent' : 'message', object_id: scope, card: scope ? model.cards.get(scope) ?? null : null }
    }
    case codec.KIND.answer: {
      const a = content.answer_action
      return { ...out, command: a === 'read' ? 'read' : a === 'shred' ? 'shred' : content.trusted ? 'trust' : 'answer', choices: content.choices ?? [] }
    }
    case codec.KIND.decide_again: return { ...out, command: 'decide_again', previous_choices: c.previous_choices ?? [] }
    case codec.KIND.verdict: return { ...out, command: 'verdict', allow: !!rec.bind?.allow, permission: model.permissions.get(c.object_id ?? rec.bind?.requestId) ?? null }
  }
  return out
}

Object.assign(Client.prototype, agentMethods)
export { agentMethods }
