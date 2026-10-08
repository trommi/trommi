// forge.mjs: malicious members. Every forgery goes through a real member's real keys and chain (client._send or a
// hand-sealed envelope), so the hub accepts the signature; the rules of the room (README R1) must stop the effect:
// no client may show it, no agent may act on it, and the oracle (which never learns of it) must keep matching.
import { Finding } from './world.mjs'

const ZERO = '0'.repeat(64)
function cloneChains(m) { return new Map([...m].map(([k, c]) => [k, { ...c, hashes: new Map(c.hashes) }])) }
const refusal = e => e?.code ?? e?.message

export async function forge(R, a) {
  const w = R.w, z = w.t.z, codec = w.t.codec
  const d = R.dev(a.dev); if (!d) return 'skip'
  const room = d.room
  const others = [...room.devs.values()].filter(x => x !== d && !x.removed && x.client && !x.dead)
  const agents = others.filter(x => x.role === 'agent'), humans = others.filter(x => x.isHuman)
  const pick = arr => arr.length ? arr[a.r % arr.length] : null
  const cardsOf = who => [...R.refs].filter(([k, id]) => k.startsWith('#c') && d.client.model.cards.get(id)?.agent_device_id === who.id).map(([k, id]) => id)
  const mark = `forged ${a.what}`
  const send = async opts => { try { await d.client._send(opts); return 'ok' } catch (e) { return `refused:${refusal(e)}` } }

  switch (a.what) {
    case 'foreign_version': case 'foreign_close': case 'foreign_note': {
      // a card version (or a closing one) for an object that belongs to somebody else
      const victim = pick(d.isHuman ? agents : agents)
      if (!victim) return 'skip'
      const id = pick(cardsOf(victim)); if (!id) return 'skip'
      const card = d.client.model.cards.get(id)
      const content = { object_type: 'card', card_type: 'decision', title: `FZMARK FZFORGED ${mark}`, options: [{ key: 'a', label: 'x' }], object_version: card.object_version + 1, previous_version_hash: card.version_hash }
      return send({ kind: codec.KIND.object_version, content, object: { object_id: id, object_state: a.what === 'foreign_close' ? 'closed' : 'open', urgency: 'normal' } })
    }
    case 'foreign_register': {
      const other = pick(others); if (!other) return 'skip'
      const values = d.isHuman ? { [`profile`]: { task: `FZMARK FZFORGED ${mark}` }, [`status_line/forged`]: { label: 'FZMARK FZFORGED' }, [`device/${other.id}`]: { device_name: `FZMARK FZFORGED ${mark}` } }
        : { crown: { n: `FZMARK FZFORGED ${mark}` }, [`desk/${'a'.repeat(32)}`]: { n: 'FZMARK FZFORGED' }, [`device/${other.id}`]: { device_name: `FZMARK FZFORGED ${mark}` }, [`session/${other.id}`]: { name: 'FZMARK FZFORGED' } }
      return send({ kind: codec.KIND.status, content: { values } })
    }
    case 'foreign_timeline': {
      const other = pick(agents); if (!other) return 'skip'
      if (d.isHuman) {
        const id = pick(cardsOf(other))
        // a human writes into the conversation of a card of agent X but addresses another agent (or nobody)
        const third = agents.find(x => x !== other)
        const tl = { timeline_kind: 'chat', timeline_id: id ? `card/${id}` : `session/${other.id}` }
        return send({ kind: codec.KIND.timeline_item, content: { content_type: 'message', text: `FZMARK FZFORGED ${mark}` }, recipient: third?.id ?? null, timeline: tl })
      }
      // an agent writes into another agent's session chat, or a chat on a card scope as canvas
      return send({ kind: codec.KIND.timeline_item, content: { content_type: 'message', text: `FZMARK FZFORGED ${mark}` }, timeline: { timeline_kind: 'chat', timeline_id: `session/${other.id}` } })
    }
    case 'agent_desk': {
      if (d.isHuman) return 'skip'
      const desk = Object.keys({}).length ? '' : 'b'.repeat(32)
      return send({ kind: codec.KIND.timeline_item, content: { content_type: 'strokes', strokes: [{ stroke_id: 'forged.0', points: 'AA', style: {} }] }, timeline: { timeline_kind: 'scribble', timeline_id: `desk/${desk}` } })
    }
    case 'foreign_answer': {
      const victim = pick(agents); if (!victim) return 'skip'
      const id = pick(cardsOf(victim)); if (!id) return 'skip'
      const card = d.client.model.cards.get(id)
      const bind = z.encodeAnswerBind({ cardId: z.unhex(id), cardHash: z.unhex(card.version_hash), choice: 'a' })
      if (d.isHuman) {
        // answer addressed to someone who does not own the card
        const wrong = agents.find(x => x !== victim) ?? humans[0]
        if (!wrong) return 'skip'
        return send({ kind: codec.KIND.answer, content: { answer_action: 'answer', choices: ['a'] }, bind, recipient: wrong.id, object: { object_id: id, object_state: 'answered', urgency: 'normal', answered_at: Date.now() } })
      }
      // an agent answers somebody's card (agents hold no vote)
      return send({ kind: codec.KIND.answer, content: { answer_action: 'answer', choices: ['a'] }, bind, recipient: victim.id, object: { object_id: id, object_state: 'answered', urgency: 'normal', answered_at: Date.now() } })
    }
    case 'bitflip': case 'garbage': case 'steal_envelope': case 'bom': case 'oversize': {
      const hub = d.client.hub
      let bytesB64, adopt = null
      const last = d.client.recentSent.at(-1)
      if (a.what === 'garbage') { const n = 1 + (a.r % 600); const u = new Uint8Array(n); for (let i = 0; i < n; i++) u[i] = (a.r * 31 + i * 17) & 255; bytesB64 = z.b64u(u) }
      else if (a.what === 'bitflip') { if (!last) return 'skip'; const u = z.unb64u(last.bytes).slice(); const at = a.r % u.length; u[at] ^= 1 << (a.r % 8); bytesB64 = z.b64u(u) }
      else if (a.what === 'steal_envelope') {
        const other = pick(others); const l = other?.client?.recentSent.at(-1); if (!l) return 'skip'; bytesB64 = l.bytes     // someone else's valid envelope, posted by me
      } else if (a.what === 'bom' || a.what === 'oversize') {
        const secret = d.client.secrets.get(d.client.state.epoch)
        const payload = a.what === 'bom' ? new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"schema_version":1,"content_type":"message","text":"FZMARK FZFORGED bom"}')]) : new TextEncoder().encode(JSON.stringify({ schema_version: 1, content_type: 'message', text: 'FZMARK FZFORGED ' + 'x'.repeat(70000) }))
        try {
          const target = agents[0] ?? humans[0]
          const chains = cloneChains(d.client.chains)
          const sealed = await z.sealEnvelope({ device: d.client.device, state: d.client.state, secret, chains, kind: codec.KIND.timeline_item, payload, recipient: target ? z.unhex(target.id) : null,
            timelineKind: 1, timelineId: `session/${agents[0]?.id ?? d.id}`, isHead: false })
          bytesB64 = z.b64u(sealed.bytes)
          adopt = () => { for (const [k, c] of chains) d.client.chains.set(k, c); d.client._dirty.chains.add(z.b64u(d.client.device.id)) }
        } catch (e) { return `refused:local-${refusal(e)}` }
      }
      let res
      try { res = await hub.postEnvelope(bytesB64) }
      catch (e) { if (e.status >= 500) throw new Finding('hub-error', `hub answered ${e.status} ${e.code} to a ${a.what} envelope`, { action: a }); return `refused:${e.code}` }
      if (adopt) adopt()
      if (a.what === 'bom') { const t = agents[0] ?? humans[0]; R.oracle(room.idx).addChat(agents[0] ? `session/@${agents[0].name}` : `session/@${d.name}`, { from: d.name, to: null, text: 'FZMARK FZFORGED bom', certain: false }) }
      // the hub cannot read bodies: a BOM body or an oversize padded body it may only refuse by size; clients must quarantine the content (nothing shown)
      if (a.what === 'garbage' || a.what === 'bitflip' || a.what === 'steal_envelope') throw new Finding('invariant', `hub accepted a ${a.what} envelope (${JSON.stringify(res)})`, { action: a })
      if (a.what === 'oversize') throw new Finding('invariant', `hub accepted an envelope with a 70 KB body (${JSON.stringify(res)}); limit is 64 KiB padded`, { action: a })
      return 'ok'
    }
  }
  return 'skip'
}
