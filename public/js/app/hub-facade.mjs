// What the views' form handlers call "the hub" (hub.decide, hub.message, hub.editSession, … in trommi-hub
// server/turbo.mjs and server/views/*), done with the client core's human actions (client/core/README.md).
// Every action shows at once (the core's optimistic echo) and is sealed, signed and sent by the core.

import { agentIdOf, sessionKey, addressOf } from './board-state.mjs'
import { memoStore } from './memo-store.mjs'
import { uploadFile } from './att.mjs'

const fail = (status, message) => Object.assign(new Error(message), { status })
const STALE = 'this question was revised while you were answering; read it again and answer the version that stands now'
const SNOOZE_HOUR = 7
function nextMorning(now = Date.now()) {
  const at = new Date(now)
  at.setHours(SNOOZE_HOUR, 0, 0, 0)
  if (at.getTime() <= now) at.setDate(at.getDate() + 1)
  return at.getTime()
}

export function hubFacade(client, board) {
  const m = () => client.model
  const card = id => { const c = board.state.cards.find(x => x.id === id); if (!c) throw fail(404, 'unknown card'); return c }
  const dev = agentId => board.agentToDev.get(agentId) ?? sessionKey([...m().sessions.values()].find(s => agentIdOf(s) === agentId) ?? {})
  // Files from a form (File objects) become encrypted attachments; returns the README references.
  const upload = async (files = [], object_id) => Promise.all(files.map(f => uploadFile(client, f, { file_name: f.name || 'file', media_type: f.type || 'application/octet-stream', object_id })))
  // A timeline key ('chat:session/<dev>'), or a session's board id (its chat).
  const timelineOf = ref => (String(ref).includes(':') ? ref : `chat:session/${dev(ref)}`)
  const draftOff = id => client.setDraft(id, null).catch(() => {})

  const hub = {
    state: () => board.state,
    agents: () => board.state.agents.map(a => ({ ...a, main: Boolean(a.main || board.state.agents.some(b => b.parent === a.id)) })),
    client,
    /** The next older page of a timeline into the window ("Earlier"): { loaded, has_more }. */
    loadOlder: ref => client.loadTimeline(timelineOf(ref), { limit: 50 }),
    /** Are there older items of that timeline than the window holds? */
    hasMore: ref => Boolean(m().timelines.get(timelineOf(ref))?.has_more),

    async decide(cardId, answer, note = '', seen, notes, files = [], marks) {
      const c = card(cardId)
      if (c.status !== 'open') throw new Error('card already decided')
      if (c.kind === 'permission') return client.verdict({ object_id: cardId, allow: [answer].flat()[0] === 'allow' })
      if (c.revised && seen !== undefined && seen !== c.revised) throw fail(409, STALE)
      const keys = [answer].flat().map(String)
      if (keys.some(k => !c.options.some(o => o.key === k))) throw fail(409, STALE)
      const choices = c.options.filter(o => keys.includes(o.key)).map(o => o.key)
      const attachments = await upload(files, cardId)
      await client.answer({ object_id: cardId, choices, note: note ?? '', option_notes: notes ?? {}, attachments, marks: marks ?? [] })
      draftOff(cardId)
    },
    async trust(cardId, note = '', seen) {
      const c = card(cardId)
      if (c.kind !== 'decision') throw new Error('only a question can be left to the agent')
      if (c.status !== 'open') throw new Error('card already decided')
      if (c.revised && seen !== undefined && seen !== c.revised) throw fail(409, STALE)
      await client.trust({ object_id: cardId, note })
      draftOff(cardId)
    },
    async closeInfo(cardId) { const c = card(cardId); if (c.kind !== 'info') throw new Error('only an info is closed by reading it'); await client.markRead({ object_id: cardId }) },
    async shred(cardId, note = '', marks, files = []) {
      const c = card(cardId)
      if (c.kind === 'permission') throw new Error('an approval cannot be thrown away: answer it with Allow or Deny')
      await client.shred({ object_id: cardId, note, marks: marks ?? [], attachments: await upload(files, cardId) })
      draftOff(cardId)
    },
    async snooze(cardId, { clear = false } = {}) {
      const c = card(cardId)
      if (c.kind === 'permission') throw new Error('an approval cannot be put off')
      await client.snooze(cardId, clear ? null : nextMorning())
    },
    async reopen(cardId) {
      const c = card(cardId)
      if (c.status === 'open' && c.snoozed_until) return client.snooze(cardId, null)
      const was = { keys: c.choices ?? [], note: c.note ?? '', notes: c.option_notes ?? {} }
      await client.decideAgain({ object_id: cardId })
      // What was taken back becomes the draft again: ticks and notes are where they were (README "decide again").
      if (c.kind === 'decision' && (was.keys.length || was.note || Object.keys(was.notes).length)) client.setDraft(cardId, { ...was, ts: Date.now() }).catch(() => {})
    },
    async takeBack(cardId) {
      const c = card(cardId)
      if (c.status !== 'open' || c.with_agent == null) throw fail(409, 'this card is not with the agent')
      await client.sendMessage({ ...addressOf(m(), dev(c.agent)), object_id: cardId, text: 'The human took the card back; no need to rework or explain it.', present_card: true })
    },
    async message({ agent, text = '', card_id, handback, explain, attachments = [], marks, cards }) {
      const key = dev(agent)
      if (!key) throw fail(404, 'unknown session')
      const files = attachments.filter(f => f instanceof Blob)
      await client.sendMessage({
        ...addressOf(m(), key), object_id: card_id ?? undefined, text,
        ...(handback ? { hand_back: true } : {}), ...(explain ? { explain: true } : {}),
        ...(files.length ? { attachments: await upload(files, card_id) } : {}),
        ...(marks?.length ? { marks } : {}), ...(cards?.length ? { copied_cards: cards } : {}),
      })
    },
    setDraft(cardId, { keys = [], note = '', notes = {}, marks } = {}) {
      const c = card(cardId)
      if (c.kind !== 'decision' || c.status !== 'open') return
      const empty = !keys.length && !String(note).trim() && !Object.keys(notes).length && !(marks?.length)
      const same = d => JSON.stringify([d?.keys ?? [], d?.note ?? '', d?.notes ?? {}, d?.marks ?? []])
      if (same(empty ? null : { keys, note, notes, marks }) === same(c.draft)) return
      return client.setDraft(cardId, empty ? null : { keys, note, notes, ...(marks?.length ? { marks } : {}), ts: Date.now() })
    },
    // A session's settings (the human's register session/<agent_device_id>): name, icon, desk, archived, group, order.
    async editSession(body) {
      const agents = board.state.agents
      const a = agents.find(x => x.id === body.agent)
      if (!a) throw fail(404, 'unknown session')
      const setOf = x => ({ ...(m().human.session_settings.get(x.device_id) ?? {}) })
      const writes = {}
      const put = (x, fields) => { writes[`session/${x.device_id}`] = { ...(writes[`session/${x.device_id}`] ?? setOf(x)), ...fields } }
      if ('label' in body) put(a, { name: String(body.label ?? '').slice(0, 60) })
      if ('icon' in body) put(a, { icon: body.icon || null })
      if ('archived' in body) { if (body.archived && a.online) throw fail(409, 'this session is connected; it can be archived once it is away'); put(a, { archived: Boolean(body.archived) }) }
      if ('group' in body) put(a, { group: body.group ? String(body.group).slice(0, 40) : null })
      if ('desk' in body) put(a, { desk: body.desk })
      if ('parent' in body) put(a, { parent: body.parent ?? null })
      if ('before' in body) {
        const order = agents.filter(x => x.id !== a.id)
        const at = body.before == null ? order.length : Math.max(0, order.findIndex(x => x.id === body.before))
        order.splice(at < 0 ? order.length : at, 0, a)
        order.forEach((x, i) => { if (x.position !== i) put(x, { position: i }) })
      }
      if (Object.keys(writes).length) await client.setRegisters(writes)
    },
    async starSession({ agent, starred }) {
      const a = board.state.agents.find(x => x.id === agent)
      if (!a) throw fail(404, 'unknown session')
      await client.setCrown(starred ? { session_id: a.session_id ?? undefined, agent_device_id: a.agent_device_id } : null)
    },
    // Desks: the human register desk/<id>.
    async desk({ id, name, remove }) {
      if (remove) { await client.setDesk(id, null); return { ok: true } }
      if (id) { await client.setDesk(id, { ...(m().human.desks.get(id) ?? {}), name }); return { ok: true, desk: { id, name } } }
      const made = [...crypto.getRandomValues(new Uint8Array(4))].map(b => b.toString(16).padStart(2, '0')).join('')
      if (!m().human.desks.size) await client.setDesk('main', { name: 'Desk', created_at: Date.now() - 1 })
      await client.setDesk(made, { name: String(name ?? '').trim().slice(0, 40) || 'Desk', created_at: Date.now() })
      return { ok: true, desk: { id: made, name } }
    },
    // Memos (objects of type memo; the old POST /memo): memo-store.mjs. Returns { code, text } like the hub's memoAct.
    memo: memoStore(client, board),
  }
  return hub
}
