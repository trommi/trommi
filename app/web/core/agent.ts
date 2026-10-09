// agent.ts: what an agent's client does (the connector drives it): objects (cards, permission requests, published),
// messages, status registers, and the gate on everything a human sends it (authoriseCommand) before it becomes a
// `command`. Mixed into Client (see index.ts). Contract: core/README.md "Agent API".
import * as z from './crypto/zcrypto.mjs'
import * as codec from './codec.ts'
import * as M from './model.ts'
import * as G from './crypto/session-grants.mjs'
import { Client, randomHex, objectIdOf, ZERO_HASH } from './client.ts'
import type { Model, Rec } from './types.ts'

const { unhex, hex, ZError } = z
const URGENCY_ORDER = ['low', 'normal', 'high', 'critical']
/** An own object's newest version as this agent knows it (_head). */
type Head = { object_version: number; version_hash: string | null; content: Record<string, any>; object_state?: string; urgency?: string; session_id?: string | null }
/** What `make(head)` gives _version: the body's fields and the header's state and urgency. */
type Made = { fields: Record<string, any>; object_state: string; urgency: string }
/** A command on its way to the connector (README "Agent API"): the record, and what the gate said. */
type Pending = Record<string, any> & { rec: Rec }

/** Methods typed with the Client as `this` (they are mixed into its prototype below). */
const mixin = <T>(m: T & ThisType<Client>): T => m

const agentMethods = mixin({
  _needAgent() { if (this.is_human) throw new ZError('forbidden', 'only an agent does this') },

  /**
   * The lease (v1.1): one running process per agent key. A new process takes over; the hub ends the old one's
   * stream, whose reconnect (naming the old lease generation) and posts get 409 lease-lost: client 'error' code
   * 'lease-lost', then it stops, before it posts anything. Renewals never take over (renew: true).
   * Returns { agent_session_id, lease_generation, expires_at }; agent_session_id = hex(device_id).slice(0, 16).
   */
  async claimSession({ process_instance }: { process_instance?: string | undefined } = {}): Promise<any> {
    this._needAgent()
    // One instance per process (R4): a claim without one (the outbox, before start() took the lease) uses the process's,
    // never a fresh one, which would take this process's own lease over and fence its own posts and stream.
    const instance = process_instance ?? this._leaseInstance ?? (this._processInstance ??= randomHex(8))
    const r = await this.hub.agentLease({ process_instance: instance })
    this.hub.lease_generation = r.lease_generation
    this._leaseInstance = instance
    clearInterval(this._leaseTimer)
    const every = Math.max(30_000, Math.min(5 * 60_000, ((r.expires_at ?? Date.now() + 600_000) - Date.now()) / 2))
    this._leaseTimer = setInterval(() => this.hub.agentLease({ process_instance: instance, renew: true }).then(x => { this.hub.lease_generation = x.lease_generation }).catch(e => {
      if (e.code === 'lease-lost') this.hub.onLeaseLost!(e)
    }), every)
    ;(this._leaseTimer as { unref?: () => void }).unref?.()
    const agent_session_id = r.agent_session_id ?? this.my_device_id.slice(0, 16)
    this.model.room.agent_session_id = agent_session_id
    const ch = M.emptyChange(); ch.room = true; this._emitChange(ch)
    return { ...r, agent_session_id }
  },

  /** The newest version of an own object: what was last sent (may be ahead of the model until the hub echoes it). */
  _head(object_id: string): Head | null {
    const local = this.localHeads.get(object_id)
    const card = this.model.cards.get(object_id)
    if (local && (!card || local.object_version >= card.object_version)) return local
    if (card) {
      const content: Record<string, any> = { object_type: 'card' }
      for (const f of codec.CARD_CONTENT_FIELDS) content[f] = card[f]
      return { object_version: card.object_version, version_hash: card.version_hash, content, object_state: card.object_state, urgency: card.urgency }
    }
    const pub = this.model.published.get(object_id)
    if (pub) return { object_version: pub.object_version, version_hash: pub.version_hash, content: { object_type: 'published', attachments: pub.attachments, title: pub.title, note: pub.note, released_until: pub.released_until }, object_state: pub.object_state, urgency: 'normal' }
    return null
  },

  /** One new version of an own object. `make(head)` returns { fields, object_state, urgency }. object_id null: a new object (R1 id). */
  async _version(object_id: string | null, make: (head: Head | null, id: string) => Made, { push = false, kind = codec.KIND.object_version as number, bind = null, session_id = null }: { push?: boolean; kind?: number; bind?: ((id: string) => Uint8Array) | null; session_id?: string | null } = {}): Promise<{ local_id: string; envelope_hash: string; seq: number; object_id: string }> {
    let id = object_id
    const sid = session_id ?? (object_id ? (this.model.cards.get(object_id)?.session_id ?? this.model.published.get(object_id)?.session_id ?? this.localHeads.get(object_id)?.session_id) : null) ?? this.session_id
    if (!sid) throw new ZError('no-session', 'no session is assigned to this agent yet')
    const r = await this._send({
      kind, push,
      content: async () => {
        if (!id) id = await objectIdOf(this.my_device_id, (this.chains.get(z.b64u(this.device.id))?.seq ?? 0) + 1)
        const head = id === object_id ? this._head(id) : null
        const { fields, object_state, urgency } = make(head, id)
        const content: Record<string, any> = kind === codec.KIND.object_version
          ? { ...(head?.content ?? {}), ...fields, object_version: (head?.object_version ?? 0) + 1, previous_version_hash: head?.version_hash ?? ZERO_HASH }
          : fields
        for (const k of Object.keys(content)) if (content[k] === undefined) delete content[k]
        return { content, object: { object_id: id, object_state, urgency }, bind: bind ? bind(id) : null, session_id: sid }
      },
      after: (sealed, content) => kind === codec.KIND.object_version && this.localHeads.set(id!, { session_id: sid, object_version: content['object_version'] as number, version_hash: hex(sealed.hash), content, object_state: codec.OBJECT_STATE_NAME[(sealed as any).header.card.state]!, urgency: codec.URGENCY_NAME[(sealed as any).header.card.urgency]! }),
    })
    return { ...r, object_id: id! }
  },

  async sendCard({ card_type = 'decision', urgency = 'normal', session_id = null, ...fields }: { card_type?: string; urgency?: string; session_id?: string | null; [field: string]: any }): Promise<string> {
    this._needAgent()
    if (card_type === 'decision' && !(fields['options']?.length >= 1)) throw new ZError('bad-argument', 'a decision needs options')
    const r = await this._version(null, () => ({ fields: { object_type: 'card', card_type, ...fields }, object_state: 'open', urgency }), { push: true, session_id })
    return r.object_id
  },

  /** Whether this agent holds the object (a card, a published page): it created it, or it continues the session it is in. */
  holds(obj: { agent_device_id: string; session_id?: string | null } | null | undefined): boolean { return !!obj && M.holderOf(this.model, obj) === this.my_device_id },

  _ownOpen(object_id: string): Head {
    const head = this._head(object_id)
    if (!head || head.content.object_type !== 'card') throw new ZError('not-found', `no own card ${object_id}`)
    const card = this.model.cards.get(object_id)
    if (card && M.holderOf(this.model, card) !== this.my_device_id) throw new ZError('forbidden', 'not this agent\'s card')
    if (card && !M.cardSupported(card)) throw new ZError('needs-update', `card ${object_id} was made by a newer Trommi connector: ${codec.UPDATE_MESSAGE}`)
    return head
  },
  /** An own card is open only if neither the last sent version nor the room (a human's answer, read, shred) closed it. */
  _ownOpenState(object_id: string): Head {
    const head = this._ownOpen(object_id)
    const card = this.model.cards.get(object_id)
    if (card && card.object_state !== 'open' && !card.answer?.pending) return { ...head, object_state: card.object_state }
    return head
  },

  async revise(object_id: string, { urgency, ...changes }: { urgency?: string; [field: string]: any } = {}): Promise<void> {
    this._needAgent()
    const head = this._ownOpenState(object_id)
    if (head.object_state !== 'open') throw new ZError('card-closed', 'only an open card can be revised')
    for (const f of ['close_summary', 'withdraw_reason', 'merged_into_object_id']) changes[f] = changes[f] ?? null
    await this._version(object_id, h => ({ fields: changes, object_state: 'open', urgency: urgency ?? h!.urgency! }))
  },
  setUrgency(object_id: string, urgency: string, urgency_reason?: string): Promise<void> { return this.revise(object_id, { urgency, ...(urgency_reason !== undefined ? { urgency_reason } : {}) }) },

  async withdraw(object_id: string, withdraw_reason = ''): Promise<void> {
    this._needAgent()
    const head = this._ownOpenState(object_id)
    if (head.object_state !== 'open') throw new ZError('card-closed', 'only an open card can be withdrawn; close an answered one')
    await this._version(object_id, h => ({ fields: { withdraw_reason }, object_state: 'closed', urgency: h!.urgency! }))
  },

  async merge(object_ids: string[], { session_id = null, ...fields }: { session_id?: string | null; [field: string]: any }): Promise<string> {
    this._needAgent()
    const heads = object_ids.map((id): [string, Head] => [id, this._ownOpenState(id)])
    for (const [, h] of heads) if (h.object_state !== 'open') throw new ZError('card-closed', 'only open cards can be merged')
    const urgency = fields['urgency'] ?? heads.map(([, h]) => h.urgency!).reduce((a, b) => (URGENCY_ORDER.indexOf(b) > URGENCY_ORDER.indexOf(a) ? b : a), 'low')
    const { urgency: _u, ...rest } = fields
    const new_id = await this.sendCard({ ...rest, urgency, merged_from_object_ids: object_ids, session_id: session_id ?? this.model.cards.get(object_ids[0]!)?.session_id ?? null })
    for (const [id] of heads) await this._version(id, h => ({ fields: { merged_into_object_id: new_id }, object_state: 'closed', urgency: h!.urgency! }))
    return new_id
  },

  /** Close an own card (after an answer, or any time) or end a published object. */
  async close(object_id: string, close_summary = ''): Promise<unknown> {
    this._needAgent()
    const head = this._head(object_id)
    if (!head) throw new ZError('not-found', `no own object ${object_id}`)
    if (head.content['object_type'] === 'published') return this._version(object_id, h => ({ fields: {}, object_state: 'closed', urgency: h!.urgency! }))
    this._ownOpen(object_id)
    await this._version(object_id, h => ({ fields: { close_summary }, object_state: 'closed', urgency: h!.urgency! }))
    return undefined
  },
  unpublish(object_id: string): Promise<unknown> { return this.close(object_id) },

  async publish({ attachments, title, note, released_until, session_id = null }: { attachments: unknown[]; title?: string; note?: string | null; released_until?: number | null; session_id?: string | null }): Promise<string> {
    this._needAgent()
    const r = await this._version(null, () => ({ fields: { object_type: 'published', attachments, title, note, released_until }, object_state: 'open', urgency: 'normal' }), { session_id })
    return r.object_id
  },

  setStatus(values: Record<string, unknown>, { session_id = null }: { session_id?: string | null } = {}) { this._needAgent(); return this.setRegisters(values, { session_id }) },

  /**
   * The receipt (model.ts "the receipt"): every command of the session up to envelope number up_to was handed to the
   * agent. Written only when the mark rises above what this process last wrote or the room shows.
   */
  async markHeard(up_to: number, { session_id = null }: { session_id?: string | null } = {}): Promise<boolean> {
    this._needAgent()
    const sid = session_id ?? this.session_id
    if (!sid || !Number.isSafeInteger(up_to) || up_to < 0) return false
    const sent = this._heardSent ??= new Map()
    if (up_to <= Math.max(sent.get(sid) ?? -1, this.model.sessions.get(sid)?.heard_up_to ?? -1)) return false
    sent.set(sid, up_to)
    try { await this.setStatus({ heard: { up_to, at: Date.now() } }, { session_id: sid }) } catch (e: any) { if (sent.get(sid) === up_to) sent.delete(sid); throw e }
    return true
  },

  /**
   * A child session: the agent opens a session of its own under its main session, without a human's
   * approval, for a helper ("Design", "Server"). It draws the session key, seals it to itself, every active human device
   * and the recovery key (never to another agent), signs the first grant (core/crypto/session-grants.mjs: itself alone, no
   * history) and writes its profile there with parent_session = its main session. Humans re-key it like any session.
   * Returns the new session_id.
   */
  async openChildSession({ profile = {} }: { profile?: Record<string, unknown> } = {}): Promise<string> {
    this._needAgent()
    const parent = this.session_id
    if (!parent) throw new ZError('no-session', 'no main session is assigned to this agent yet')
    const sid = await this.serial(async () => {
      await this._refreshMembers()
      const r = await G.createSessionGrant({ state: this.state, signer: this.device, agentIds: [this.my_device_id] })
      await this._postGrant(r)
      return r.sessionState.sessionId
    })
    await this.setStatus({ profile: { ...profile, parent_session: parent, is_main: false } }, { session_id: sid })
    return sid
  },
  /** The child sessions this agent holds: the ones it opened itself, and the ones of a session it continues. */
  childSessionIds(): string[] { return this.session_ids.filter(sid => this.sessionKeys.get(sid)?.state.createdByAgent) },

  async requestPermission({ tool_name, description = '', input_preview = '', expires_in_ms = 10 * 60_000, session_id = null }: { tool_name: string; description?: string; input_preview?: string; expires_in_ms?: number; session_id?: string | null }): Promise<string> {
    this._needAgent()
    const expiresAt = Date.now() + expires_in_ms
    const r = await this._version(null, () => ({ fields: { tool_name, description, input_preview }, object_state: 'open', urgency: 'critical' }),
      { kind: codec.KIND.permission_request, push: true, session_id, bind: id => z.encodeRequestBind({ requestId: unhex(id), expiresAt }) })
    ;(this._requests ??= new Map()).set(r.object_id, { session_id: session_id ?? this.session_id, expires_at: expiresAt })
    return r.object_id
  },
  /**
   * Withdraw an own permission request that still waits (the prompt was answered elsewhere, e.g. in the terminal): a
   * second permission_request head of the same object, closed. A verdict after it is refused (request-not-pending).
   * Returns false when the request is not pending any more (answered, withdrawn, run out).
   */
  async withdrawPermission(object_id: string, withdraw_reason = ''): Promise<boolean> {
    this._needAgent()
    const p = this.model.permissions.get(object_id)
    const own = p ?? this._requests?.get(object_id)   // sent, not echoed by the hub yet
    if (!own || (p && p.agent_device_id !== this.my_device_id)) throw new ZError('not-found', `no own permission request ${object_id}`)
    if (p ? p.permission_state !== 'pending' : (own as { withdrawn?: boolean }).withdrawn) return false
    if (Date.now() > own.expires_at) return false
    await this._version(object_id, () => ({ fields: { withdraw_reason }, object_state: 'closed', urgency: 'critical' }),
      { kind: codec.KIND.permission_request, session_id: own.session_id, bind: id => z.encodeRequestBind({ requestId: unhex(id), expiresAt: own.expires_at }) })
    const mine = this._requests?.get(object_id)
    if (mine) mine.withdrawn = true
    return true
  },

  // ---- the gate ---------------------------------------------------------------------------

  /** Called by the sync engine BEFORE the reducer applies the record: judge it against the board as it is. */
  _preAuthorise(rec: Rec): Pending | null {
    if (rec.recipient_device_id !== this.my_device_id) return null
    if (rec.sender_sequence! <= (this.delivered.get(rec.sender_device_id) ?? 0)) return null
    if (!([codec.KIND.timeline_item, codec.KIND.answer, codec.KIND.verdict, codec.KIND.decide_again] as number[]).includes(rec.kind)) return null
    const base: Pending = { session_id: rec.session_id ?? null, envelope_number: rec.envelope_number, envelope_hash: rec.envelope_hash, sender_sequence: rec.sender_sequence, sent_at: rec.sent_at, sender_device_id: rec.sender_device_id, object_id: rec.object?.object_id ?? null,
      timeline_key: rec.timeline_id ? M.timelineKey(String(rec.timeline_kind), rec.timeline_id) : null, rec }
    if (rec.is_head && !rec.content) return rec.content_state === 'newer_schema' ? { ...base, refused: null, unsupported: 'a newer format' } : { ...base, refused: 'undecryptable' }
    const sk = rec.session_id ? this.sessionKeys.get(rec.session_id) : null
    if (rec.session_id && !sk?.state.agentIds.includes(this.my_device_id)) return { ...base, refused: 'not-assigned', message: 'a command in a session this agent does not hold' }
    const ctx: Record<string, any> = { state: this.state, agentId: this.device.id, now: Date.now(), ownSeq: this.chains.get(z.b64u(this.device.id))?.seq ?? 0,
      epochChangedAt: rec.session_id ? sk?.since ?? null : this.epochChangedAt, sessionEpoch: sk?.state.epoch ?? null,
      seenOfMe: this.frontiers.get(rec.sender_device_id)?.get(this.my_device_id) ?? 0 }
    const card = rec.object ? this.model.cards.get(rec.object.object_id) : null
    if (rec.kind === codec.KIND.answer || rec.kind === codec.KIND.decide_again) {
      if (card) {
        // R7: every answer's choices are options; a trusted answer's choices also the agent's own recommendation.
        const answering = rec.kind === codec.KIND.answer && rec.content?.['answer_action'] === 'answer'
        const recd = card.recommended == null ? [] : Array.isArray(card.recommended) ? card.recommended : [card.recommended]
        const options = (card.options ?? []).map(o => o.key)
        ctx['card'] = { id: unhex(card.object_id), hash: unhex(card.version_hash!), open: card.object_state === 'open', options: answering ? (rec.content?.['trusted'] ? options.filter(k => recd.includes(k)) : options) : null }
        if (card.answer?.envelope_hash) ctx['decision'] = { hash: unhex(card.answer.envelope_hash) }
        base['previous_choices'] = card.answer?.choices ?? null
      }
    } else if (rec.kind === codec.KIND.verdict) {
      const p = this.model.permissions.get((rec.object?.object_id ?? rec.bind?.requestId)!)
      if (p) ctx['request'] = { id: unhex(p.object_id), hash: unhex(p.version_hash), expiresAt: p.expires_at, pending: p.permission_state === 'pending' }
    }
    try {
      const r = z.authoriseCommand({ header: rec['_header'], kind: rec.kind, bind: rec['_bind'] ?? new Uint8Array(0) }, ctx)
      return { ...base, late: r['late'], refused: null }
    } catch (e: any) {
      return { ...base, refused: e.code ?? 'refused', message: e.message }
    }
  },

  /**
   * After a batch: refresh the member list before any answer/verdict/decide-again (R3), fetch bodies of thread items
   * that came pruned, then hand out commands in order, once per (sender, sequence) (R4). Refusals become alert/<envelope_hash>.
   */
  async _deliverCommands(commands: Pending[]): Promise<void> {
    // Held commands go first, in order (a halt holds commands back, it never drops them).
    if (this._heldCommands?.length && !this.commandsHalted) { commands = [...this._heldCommands, ...commands]; this._heldCommands = [] }
    // A held command and the same envelope met again in a replay (resync) are one command: once per envelope hash.
    commands = dedupeCommands(commands)
    if (!this.commandsHalted && commands.some(c => !c.refused && c.rec.is_head)) {
      const err = await this._refreshMembers({ throwOnFork: true }).then(() => null, (e: any) => e)
      if (err?.code === 'log-fork' || err?.code === 'log-rollback') {
        this.commandsHalted = err.code
        this.emit('error', new ZError(err.code, 'the member list forked: commands halted until a human acts'))
      } else if (err) {
        // R3 fails closed: no answer, verdict or decide-again without a fresh member list. Hold and try again soon.
        this._heldCommands = dedupeCommands([...(this._heldCommands ?? []), ...commands])
        clearTimeout(this._heldTimer)
        this._heldTimer = setTimeout(() => this.serial(() => this._deliverCommands([])).catch(e => this.emit('error', e)), 3000)
        ;(this._heldTimer as { unref?: () => void }).unref?.()
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
    const alerts: Record<string, unknown> = {}
    for (const c of commands) {
      if ((this.delivered.get(c.sender_device_id) ?? 0) < c.sender_sequence) this.delivered.set(c.sender_device_id, c.sender_sequence)
      if (c.refused) {
        alerts[`alert/${c.envelope_hash}`] = { code: c.refused, message: c.message ?? '', sender_device_id: c.sender_device_id, envelope_number: c.envelope_number }
        this.emit('alert', { code: c.refused, message: c.message ?? '', envelope_number: c.envelope_number, sender_device_id: c.sender_device_id, source: 'local' })
        continue
      }
      // R4: every command sent before the history boundary (the first start without sync state) is history, not a prompt:
      // by envelope number (the room's head then: the signed sent_at alone would let a future-dated old command count
      // as live) and by time.
      c.history = (this.historyBeforeNumber != null && c.envelope_number <= this.historyBeforeNumber) || (this.historyBefore != null && c.sent_at < this.historyBefore)
      this.emit('command', c.unsupported ? { ...commandOf(this.model, c), command: 'unsupported', what: c.unsupported } : commandOf(this.model, c))
    }
    if (Object.keys(alerts).length) this.setRegisters(alerts).catch(e => this.emit('error', e))   // not awaited: we are inside the sync queue
    // The hub takes an object's state from the signed header alone, so a refused answer (bad choice, stale version,
    // read on a decision) still marks the card closed there, and retention would prune it while it is open everywhere.
    // The owner says it again: a new version, unchanged and open, becomes the hub's newest head. Taken from the model
    // (card.refused_head, stored with the card), so a crash between the refusal and the re-send does not lose it.
    this._reassertRefused()
    this._dirty.records.set('sync', this._syncRecord())
    // What was handed out reaches storage at once (not with the debounced flush), so a crash right after does not
    // hand the same command out again after the restart. Kept apart from the sync record, whose cursor must not run
    // ahead of the model it belongs to.
    if (commands.length) await this.storage.set('delivered', Object.fromEntries(this.delivered)).catch(e => this.emit('error', e))
  },

  /** Re-send every own open card whose newest head at the hub is a refused answer (once per card and head). */
  _reassertRefused(): void {
    if (this.is_human) return
    const done = (this._reasserted ??= new Map())      // card -> the refused head it was re-sent for (until the version is back)
    for (const id of M.cardsToReassert(this.model, this.my_device_id)) {
      const head = this.model.cards.get(id)!.refused_head
      if (done.get(id) === head) continue
      done.set(id, head)
      // not awaited (we may be inside the sync queue); settle() waits for it
      const p: Promise<unknown> = new Promise<void>(r => queueMicrotask(r)).then(() => this._version(id, h => ({ fields: {}, object_state: 'open', urgency: h?.urgency ?? 'normal' })))
        .catch(e => { if (done.get(id) === head) done.delete(id); this.emit('error', e) })
      const bg = (this._background ??= new Set()); bg.add(p); p.finally(() => bg.delete(p))
    }
  },

  /** A human resolved a fork (or the connector decides to go on): deliver commands again, the held ones first. */
  resumeCommands(): Promise<void> { this.commandsHalted = null; return this.serial(() => this._deliverCommands([])) },
})

function dedupeCommands(list: Pending[]): Pending[] {
  const seen = new Set<string>()
  return list.filter(c => { if (seen.has(c.envelope_hash)) return false; seen.add(c.envelope_hash); return true })
}

function commandOf(model: Model, c: Pending): Record<string, any> {
  const { rec } = c
  const content = rec.content ?? {}
  const card = c.object_id ? model.cards.get(c.object_id) ?? null : null
  const out = { session_id: c.session_id ?? null, envelope_number: c.envelope_number, envelope_hash: c.envelope_hash, sender_device_id: c.sender_device_id, sender_sequence: c.sender_sequence, sent_at: c.sent_at,
    object_id: c.object_id, timeline_key: c.timeline_key, content, late: !!c.late, history: !!c.history, card }
  switch (rec.kind) {
    case codec.KIND.timeline_item: {
      const ct = content.content_type
      const scope = rec.timeline_id?.startsWith('card/') ? rec.timeline_id.slice(5) : null
      const unsupported = rec.content_state === 'newer_schema' ? 'a newer message format' : M.contentTypeKnown(content) ? null : `content_type ${ct}`
      return { ...out, command: ct === 'selection_sent' ? 'selection_sent' : 'message', object_id: scope, card: scope ? model.cards.get(scope) ?? null : null, ...(unsupported ? { unsupported } : {}) }
    }
    case codec.KIND.answer: {
      const a = content.answer_action
      // settled: the answer closed the card itself (every choice a final option); nothing is left for the agent to close.
      const settled = (a ?? 'answer') === 'answer' && codec.OBJECT_STATE_NAME[rec.object?.object_state as number] === 'closed'
      // An answer action of a newer version: never taken for a plain answer; the connector says it needs an update.
      if (typeof a === 'string' && !codec.ANSWER_ACTIONS.includes(a)) return { ...out, command: 'unsupported', what: `answer_action ${a}` }
      if (rec.content_state === 'newer_schema') return { ...out, command: 'unsupported', what: 'a newer answer format' }
      return { ...out, command: a === 'read' ? 'read' : a === 'shred' ? 'shred' : content.trusted ? 'trust' : 'answer', choices: content.choices ?? [], settled }
    }
    case codec.KIND.decide_again: return { ...out, command: 'decide_again', previous_choices: c.previous_choices ?? [] }
    case codec.KIND.verdict: return { ...out, command: 'verdict', allow: !!rec.bind?.allow, permission: model.permissions.get(c.object_id ?? rec.bind?.requestId) ?? null }
  }
  return out
}

Object.assign(Client.prototype, agentMethods)
export type AgentMethods = typeof agentMethods
export { agentMethods }
