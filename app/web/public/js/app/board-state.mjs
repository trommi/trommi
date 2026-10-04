// The seam between the client core's model (core/README.md) and the views of today's board (public/js/views,
// synced from trommi-hub server/views): boardState(client.model) returns the board's state in the shape the views were
// written for ({ cards, queue, agents, tasks, messages, desks, memos, assets }), so the app renders the same markup.
//
// Incremental: a card's board form is kept per object_id and made again only when a change names it (or a register
// that it shows: its draft, its snooze). The messages are built on first read (only a session's page and a card's
// thread read them), from the timeline windows that are in memory plus the events every client knows from the heads
// (asked, revised, answered, read, shredded, closed).

import { rememberRef } from './att.mjs'
import { boardMemos } from './memo-store.mjs'

const SESSION_ID_LEN = 12
// A session's id on the board (its address /s/<id>): the start of the agent's device id, known from the first envelope
// on and never changing. (The hub's agent_session_id is random hex and arrives later, with GET devices: it would move
// the address. A readable one, as the mock room has, is kept.)
// A session's key in the core's model: its session_id (v1.1, R6), or the agent's device id (the mock room, v1).
export const sessionKey = s => s.session_id ?? s.agent_device_id
// The sessions as the board shows them: one per key (a stored copy filed under an older key is not a second session).
const sessionsOf = m => [...m.sessions].filter(([k, s]) => k === sessionKey(s)).map(([, s]) => s)
// What belongs to a session (a card, a request, a published object) names it by session_id or by its agent.
const keyOf = o => o.session_id ?? o.agent_device_id
// The versions a human reads as the question: the first, and every later one that leaves it open. A version that
// closes the card (close_card, withdraw, merge; also a second close) ends it and is no revision: the card's "Done"
// line says what became of it, so it never shows as "Question revised" or as a new "Version n".
export const revisionsOf = c => (c?.versions ?? []).filter(v => v.object_version === 1 || v.object_state === 'open')
/** How the core addresses a session for a send: { session_id } (v1.1) or { agent_device_id } (the mock, v1). */
export const addressOf = (model, key) => (model.sessions.get(key)?.session_id ? { session_id: key } : { agent_device_id: key })
// The parent a session names (profile.parent_session), as core model.parentSessionOf rules: a child session an agent
// opened itself counts only under a session that agent is assigned to; any other claim as before (display only).
function parentClaim(m, s) {
  const want = s.profile?.parent_session
  if (!want || typeof want !== 'string') return null
  if (!s.created_by_agent) return want
  const parent = m.sessions.get(want)
  return parent && parent !== s && (parent.agent_device_ids ?? []).includes(s.creator_device_id) ? want : null
}
export const agentIdOf = s => (s.agent_session_id && !/^[0-9a-f]{12,}$/.test(s.agent_session_id) ? s.agent_session_id : sessionKey(s).slice(0, SESSION_ID_LEN))

export class BoardState {
  constructor(client) {
    this.client = client
    this.cardCache = new Map()       // object_id -> board card
    this.eventCache = new Map()      // object_id -> [event messages]
    this.state = null
    this.version = 0
  }
  get model() { return this.client.model }

  /** After a change of the core (or with no change: everything). Returns the new state object. */
  update(change = null) {
    const m = this.model
    if (!change) { this.cardCache.clear(); this.eventCache.clear() }
    else {
      for (const id of change.cards) { this.cardCache.delete(id); this.eventCache.delete(id) }
      for (const id of change.permissions) this.cardCache.delete(id)
      for (const key of change.registers) {
        const at = key.indexOf('/'), kind = key.slice(0, at), id = key.slice(at + 1)
        if (kind === 'draft' || kind === 'snooze' || kind === 'duck') this.cardCache.delete(id)
        if (kind === 'session' || key === 'crown') { this.cardCache.clear(); this.eventCache.clear() }   // agent ids and names change
      }
    }
    // Agents (sessions) and their ids on the board. A card's board form names its agent: only when that naming
    // changes (a session came, went or was renamed) are all cards made again; a status line changes nothing here.
    const devToAgent = new Map(), agentToDev = new Map()
    for (const s of sessionsOf(m)) { const id = agentIdOf(s), key = sessionKey(s); devToAgent.set(key, id); agentToDev.set(id, key) }
    const naming = [...devToAgent].join()
    if (naming !== this.naming) { this.naming = naming; this.cardCache.clear(); this.eventCache.clear() }
    this.devToAgent = devToAgent; this.agentToDev = agentToDev
    // Card numbers: the order cards (and permission requests) were first filed in, from 1. Never reused, the same on
    // every device. Sorted again only when a card or request came that was not numbered yet.
    const fresh = !change || !this.numberOf || [...change.cards, ...change.permissions].some(id => !this.numberOf.has(id)) || m.cards.size + m.permissions.size !== this.numberOf.size
    if (fresh) {
      const numbered = [...[...m.cards.values()].map(c => [c.first_envelope_number, c.object_id, 0]), ...[...m.permissions.values()].map(p => [p.envelope_number, p.object_id, 1])].sort((a, b) => a[0] - b[0])
      this.numberOf = new Map(numbered.map(([, id], i) => [id, i + 1]))
      this.order = numbered.filter(x => !x[2]).map(x => x[1])
      this.permOrder = numbered.filter(x => x[2]).map(x => x[1])
    }
    const numberOf = this.numberOf
    const all = this.order.map(id => m.cards.get(id)).filter(Boolean)
    const perms = this.permOrder.map(id => m.permissions.get(id)).filter(Boolean)
    const cards = []
    for (const c of all) { let b = this.cardCache.get(c.object_id); if (!b || b.number !== numberOf.get(c.object_id)) { b = this.boardCard(c, numberOf.get(c.object_id)); this.cardCache.set(c.object_id, b) } cards.push(b) }
    for (const p of perms) { let b = this.cardCache.get(p.object_id); if (!b) { b = this.permissionCard(p, numberOf.get(p.object_id)); this.cardCache.set(p.object_id, b) } cards.push(b) }
    this.byId = new Map(cards.map(c => [c.id, c]))
    const agents = this.agents()
    const shelved = new Set(agents.filter(a => a.archived).map(a => a.id))
    const queue = cards.filter(c => c.status === 'open' && !shelved.has(c.agent) && !c.snoozed_until).sort((a, b) => a.created - b.created || a.number - b.number).map(c => c.id)
    const tasks = []
    for (const s of sessionsOf(m)) for (const t of s.status_lines ?? []) tasks.push({ agent: devToAgent.get(sessionKey(s)), id: t.id, label: t.label, state: t.state, detail: t.detail, card_id: t.object_id ?? null, updated: t.updated_at ?? 0 })
    const desks = [...m.human.desks].filter(([, v]) => v).map(([id, v]) => ({ id, name: v.name || 'Desk', created: v.created_at ?? 0 })).sort((a, b) => (a.id === 'main' ? -1 : b.id === 'main' ? 1 : a.created - b.created))
    const memos = boardMemos(m, devToAgent)
    // Published objects (an agent's publish): the first attachment is the thing itself; type by its media type.
    const assetType = t => (t === 'text/html' ? 'html' : t.startsWith('image/') ? 'image' : t.startsWith('video/') ? 'video' : t.startsWith('audio/') ? 'audio' : 'file')
    const assets = [...m.published.values()].filter(p => p.object_state !== 'closed').map(p => { const a = p.attachments?.[0]; return { id: p.object_id, agent: devToAgent.get(keyOf(p)), type: assetType(String(a?.media_type ?? '')), title: p.title, note: p.note ?? '', size: a?.total_size ?? 0, att: this.att(a), envelope_number: p.envelope_number, created: p.sent_at ?? 0 } })
    const self = this
    let messages = null
    const state = {
      cards, queue, agents, tasks, desks, memos, assets, pending: [], hub: {}, speech: false,
      get messages() { return (messages ??= self.messages(cards)) },
      messagesOf: agent => self.messagesOf(agent),
      messagesOfCard: id => self.messagesOfCard(id),
    }
    this.state = state
    this.version++
    return state
  }

  agents() {
    // A child session its agent closed (close_session: the helper is done) goes to the archive by itself, unless a
    // question of it is still open; the human's own archive setting wins either way.
    const closedChild = s => Boolean(s.profile?.closed_at && s.profile?.parent_session && !(s.open_card_ids?.length))
    const m = this.model, crown = m.human.crown?.session_id ?? m.human.crown?.agent_device_id ?? null
    const list = sessionsOf(m).filter(s => s.is_active !== false || s.card_ids?.length)
    // When the agent process behind a session last said anything, in any of its sessions (main or child).
    const lastOfDevice = new Map()
    for (const s of list) if (s.agent_device_id) lastOfDevice.set(s.agent_device_id, Math.max(lastOfDevice.get(s.agent_device_id) ?? 0, s.last_activity_at ?? 0))
    const out = list.map((s, i) => {
      const key = sessionKey(s), set = m.human.session_settings.get(key) ?? s.settings ?? {}
      const p = s.profile ?? {}
      const id = this.devToAgent.get(key)
      // The human's choice wins; else the session's own claim, a session id (child sessions, checked by the core) or a board id.
      const claimed = parentClaim(m, s)
      const wanted = 'parent' in set ? set.parent : claimed && this.devToAgent.has(claimed) ? this.devToAgent.get(claimed) : claimed
      const parent = wanted && this.agentToDev.has(wanted) ? wanted : null
      return {
        id, device_id: key, session_id: s.session_id ?? null, agent_device_id: s.agent_device_id, name: p.agent_name || s.device_name || id, label: set.name || '', icon: set.icon || p.icon || '', icon_by: set.icon ? 'human' : 'agent',
        online: Boolean(s.is_online), model: p.model ?? '', task: p.task ?? '', client: '', host: '', starred: crown === key || crown === s.agent_device_id, parent, main: Boolean(p.is_main),
        desk: set.desk ?? null, archived: 'archived' in set ? Boolean(set.archived) : closedChild(s), group: set.group ?? null, position: set.position ?? i, seen: s.last_activity_at ?? 0, connected: s.last_activity_at ?? 0, active: s.last_activity_at ?? 0, device_active: lastOfDevice.get(s.agent_device_id) ?? 0,
        removed: s.is_active === false,
      }
    })
    // A helper without a desk of its own lies on its main's desk (a child session lands where its main is).
    const byId = new Map(out.map(a => [a.id, a]))
    for (const a of out) if (a.desk == null) a.desk = (a.parent && byId.get(a.parent)?.desk) || 'main'
    return out.sort((a, b) => a.position - b.position)
  }

  att(a) {
    if (!a) return null
    rememberRef(a)
    const type = String(a.media_type ?? '')
    const kind = type.startsWith('image/') ? 'image' : type.startsWith('video/') ? 'video' : type.startsWith('audio/') ? 'audio' : 'file'
    // The page a picture was made from: another attachment of the same list ('attachment:<id>') or an address.
    const p = typeof a.page === 'string' ? a.page : a.page?.url ?? null
    const page = p ? { url: p.startsWith('attachment:') ? `/att/${p.slice(11)}` : p, kind: p.startsWith('attachment:') ? 'file' : 'link' } : null
    return { name: a.file_name ?? 'file', url: a.url ?? `/att/${a.attachment_id}`, image: kind === 'image', kind, type, size: a.total_size, width: a.width, height: a.height, caption: a.caption, title: a.caption ?? a.title, page, marks: a.marks, ref: a }
  }
  /** A list of attachment references as the views want them; a page that belongs to a picture is not a file of its own. */
  atts(list) {
    if (!list?.length) return []
    for (const a of list) rememberRef(a)
    const pages = new Set(list.map(a => (typeof a.page === 'string' && a.page.startsWith('attachment:') ? a.page.slice(11) : null)).filter(Boolean))
    return list.filter(a => !pages.has(a.attachment_id)).map(a => this.att(a)).filter(Boolean)
  }

  boardCard(c, number) {
    const m = this.model, a = c.answer, h = m.human
    const status = c.object_state === 'open' ? 'open'
      : c.closed_how === 'shredded' ? 'shredded'
        : c.closed_how === 'answered' && c.object_state === 'answered' ? 'decided' : 'done'
    const snooze = h.snoozes.get(c.object_id)
    const draft = h.drafts.get(c.object_id)
    const atts = list => this.atts(list)
    const turns = revisionsOf(c)
    const versions = turns.slice(0, -1).map(v => ({ n: v.object_version, at: v.sent_at, title: v.content?.title ?? '', body: v.content?.body ?? '', options: v.content?.options ?? [], ...(v.content?.sections ? { sections: v.content.sections } : {}), ...(v.content?.html ? { html: v.content.html } : {}), recommended: v.content?.recommended ?? null, multiple: Boolean(v.content?.allows_multiple), attachments: atts(v.content?.attachments), urgency: v.urgency, note: v.content?.change_note ?? '' }))
    const current = turns.at(-1)
    const card = {
      id: c.object_id, object_id: c.object_id, agent: this.devToAgent.get(keyOf(c)) ?? keyOf(c).slice(0, SESSION_ID_LEN), number,
      kind: c.card_type === 'info' ? 'info' : 'decision', status, urgency: c.urgency ?? 'normal', urgency_reason: c.urgency_reason ?? '',
      title: c.title ?? '', body: c.body ?? '', options: c.options ?? [], attachments: atts(c.attachments), version: c.object_version ?? 1,
      multiple: Boolean(c.allows_multiple), choice: a?.choices?.[0] ?? null, choices: a?.choices ?? [], note: a?.note ?? '', summary: c.close_summary || c.withdraw_reason || '',
      created: c.created_at ?? 0, decided: a?.answered_at ?? (status === 'done' ? c.updated_at : null), recommended: c.recommended ?? null,
      version_hash: c.version_hash, content_state: c.content_state,
    }
    if (c.sections) card.sections = c.sections
    if (c.html) card.html = c.html
    if (versions.length) { card.versions = versions; card.revised = current?.sent_at ?? c.updated_at; card.revisions = versions.length; card.revision_note = c.change_note ?? '' }
    if (a) {
      card.answered_version = a.bound_object_version
      if (a.option_notes && Object.keys(a.option_notes).length) card.option_notes = a.option_notes
      if (a.marks?.length) card.marks = a.marks
      if (a.attachments?.length) card.note_attachments = atts(a.attachments)
      if (a.trusted) card.trusted = true
      if (a.answer_action === 'read') card.read = a.answered_at
      if (a.answer_action === 'shred') card.shredded = a.answered_at
      if (a.pending) card.pending = true
    }
    if (c.in_revision && status === 'open') card.with_agent = this.timeOf(c.timeline_key, c.in_revision.envelope_number) ?? c.updated_at ?? Date.now()
    if (draft && status === 'open') card.draft = { keys: draft.keys ?? [], note: draft.note ?? '', notes: draft.notes ?? {}, ...(draft.marks?.length ? { marks: draft.marks } : {}), ts: draft.ts ?? 0 }
    if (snooze?.until > Date.now() && status === 'open') { card.snoozed_until = snooze.until; card.snoozed_at = snooze.at ?? 0 }
    else if (snooze?.until && status === 'open') card.unsnoozed = snooze.until   // woken by hand or by the clock: "Back from snooze"
    if (c.merged_into_object_id) card.merged_into = c.merged_into_object_id
    if (c.merged_from_object_ids?.length) card.merged_from = c.merged_from_object_ids.map(id => ({ id, number: this.numberOf?.get(id), title: m.cards.get(id)?.title ?? '' }))
    return card
  }
  permissionCard(p, number) {
    const status = p.permission_state === 'pending' && !(p.expires_at && p.expires_at < Date.now()) ? 'open' : 'done'
    return {
      id: p.object_id, object_id: p.object_id, agent: this.devToAgent.get(keyOf(p)) ?? keyOf(p).slice(0, SESSION_ID_LEN), number, kind: 'permission', status, urgency: 'critical', urgency_reason: '',
      request_id: p.object_id, title: `Approval: ${p.tool_name}`, body: `${p.description ?? ''}\n\n${p.input_preview ?? ''}`,
      options: [{ key: 'allow', label: 'Allow', detail: '' }, { key: 'deny', label: 'Deny', detail: '' }], attachments: [], version: 1, multiple: false,
      choice: p.verdict ? (p.verdict.allow ? 'allow' : 'deny') : null, choices: p.verdict ? [p.verdict.allow ? 'allow' : 'deny'] : [], note: '',
      summary: p.permission_state === 'expired' ? 'Expired' : '', created: p.sent_at ?? 0, decided: p.verdict ? p.sent_at : null, recommended: null,
    }
  }
  timeOf(key, n) {
    const t = this.model.timelines.get(key)
    return t?.items.get(n)?.sent_at ?? null
  }

  // ---- the conversation: timeline windows + what the heads say ----
  /** Every message of the board (global; prefer messagesOf, which builds one session's only). */
  messages(cards) {
    const out = []
    for (const a of this.state.agents) out.push(...this.messagesOf(a.id))
    return out.sort((x, y) => x.seq - y.seq || x.ts - y.ts)
  }
  /** One session's conversation: its cards' events, its chat and its cards' chats (the windows in memory), in
   *  hub order. Built once per state and session. */
  messagesOf(agent) {
    const st = this.state, cached = st.__byAgent ??= new Map()
    if (cached.has(agent)) return cached.get(agent)
    const m = this.model, dev = this.agentToDev.get(agent)
    const humans = this.humans ??= new Set()
    humans.clear(); for (const x of m.members.values()) if (x.device_role === 'human') humans.add(x.device_id)
    const out = []
    const cardIds = m.sessions.get(dev)?.card_ids ?? st.cards.filter(c => c.agent === agent).map(c => c.id)
    for (const id of cardIds) {
      const card = this.byId.get(id) ?? null
      if (!card || card.kind === 'permission') continue
      let ev = this.eventCache.get(id)
      if (!ev) { ev = this.eventsOf(m.cards.get(id), card); this.eventCache.set(id, ev) }
      out.push(...ev)
      this.itemsOf(m.timelines.get(`chat:card/${id}`), agent, id, out)
    }
    this.itemsOf(m.timelines.get(`chat:session/${dev}`), agent, null, out)
    out.sort((x, y) => x.seq - y.seq || x.ts - y.ts)
    cached.set(agent, out)
    return out
  }
  /** One card's conversation: its events and its chat window, in hub order. Built once per state and card. */
  messagesOfCard(id) {
    const st = this.state, cached = st.__byCard ??= new Map()
    if (cached.has(id)) return cached.get(id)
    const card = this.byId.get(id), out = []
    if (card && card.kind !== 'permission') {
      if (!this.humans) { this.humans = new Set(); for (const x of this.model.members.values()) if (x.device_role === 'human') this.humans.add(x.device_id) }
      let ev = this.eventCache.get(id)
      if (!ev) { ev = this.eventsOf(this.model.cards.get(id), card); this.eventCache.set(id, ev) }
      out.push(...ev)
      this.itemsOf(this.model.timelines.get(`chat:card/${id}`), card.agent, id, out)
      out.sort((x, y) => x.seq - y.seq || x.ts - y.ts)
    }
    cached.set(id, out)
    return out
  }
  itemsOf(t, agent, cardId, out) {
    if (!t?.items.size) return
    const me = this.model.room.my_device_id
    for (const i of t.items.values()) {
      const kind = i.content_type ?? 'message'
      if (kind !== 'message' && kind !== 'selection_sent') continue
      const human = i.sender_device_id === me || this.humans.has(i.sender_device_id)
      const c = i.content ?? {}
      const msg = {
        id: i.envelope_number != null ? `e${i.envelope_number}` : i.local_id, seq: i.envelope_number ?? Number.MAX_SAFE_INTEGER, agent, from: human ? 'user' : 'agent',
        text: i.item_state === 'loaded' || !i.item_state ? (c.text ?? '') : i.item_state === 'pruned' ? '(removed after 30 days)' : i.item_state === 'newer_schema' ? '(needs a newer app)' : '',
        attachments: this.atts(c.attachments), ts: i.sent_at ?? 0,
      }
      // A selection of the Scratchpad sent to the session: shown as the board's Scribble card.
      if (kind === 'selection_sent') msg.attachments = msg.attachments.map(x => ({ ...x, kind: 'scribble' }))
      if (cardId) msg.card_id = cardId
      if (c.details) msg.details = c.details
      if (c.html) msg.html = c.html
      if (c.published_object_id) { if (this.model.published.get(c.published_object_id)?.object_state === 'closed') continue; msg.published = c.published_object_id }   // a revoked asset leaves the conversation
      if (c.hand_back) msg.handback = true
      if (c.explain) msg.explain = true
      if (c.present_card) msg.present = true
      if (c.marks?.length) msg.marks = c.marks
      if (c.copied_cards?.length) msg.cards = c.copied_cards.map(id => { const b = this.cardCache.get(id); return b ? { id, number: b.number, title: b.title, agent: b.agent, choice_label: null } : { id, number: null, title: id, agent } })
      if (i.pending) msg.pending = true
      out.push(msg)
    }
  }
  eventsOf(c, card) {
    if (!c) return []
    const ev = (n, kind, text, ts, extra = {}) => ({ id: `v${n}${kind[0]}`, seq: n, agent: card.agent, from: 'event', kind, card_id: card.id, text, ts, ...extra })
    const out = []
    for (const v of revisionsOf(c)) {
      if (v.object_version === 1) out.push(ev(v.envelope_number, card.kind === 'info' ? 'info' : 'asked', v.content?.title ?? card.title, v.sent_at))
      else out.push(ev(v.envelope_number, 'revised', v.content?.change_note || v.content?.title || card.title, v.sent_at, { version: v.object_version }))
    }
    const label = keys => keys.map(k => card.options.find(o => o.key === k)?.label ?? k).join(', ')
    for (const a of c.answers ?? []) {
      if (a.answer_action === 'read') out.push(ev(a.envelope_number, 'read', card.title, a.answered_at))
      else if (a.answer_action === 'shred') out.push(ev(a.envelope_number, 'shredded', [card.title, a.note].filter(Boolean).join(' · '), a.answered_at))
      else out.push(ev(a.envelope_number, 'decided', a.trusted ? `Whatever: your call${a.choices?.length ? ` · ${label(a.choices)}` : ''}` : label(a.choices ?? []), a.answered_at, a.trusted ? { trusted: true } : {}))
      if (a.taken_back_at) out.push(ev(a.taken_back_at, 'reopened', card.title, a.answered_at + 1))
    }
    if (c.object_state === 'closed' && (c.close_summary || c.withdraw_reason)) out.push(ev((c.envelope_number ?? 0) + 0.5, 'done', c.withdraw_reason ? `Withdrawn: ${c.withdraw_reason}` : c.close_summary, c.updated_at))
    return out
  }
}
