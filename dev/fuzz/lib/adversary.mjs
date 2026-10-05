// adversary.mjs: a malicious hub as a per-device man in the middle. It sits between a real client and the real hub
// and rewrites what the hub says: it withholds envelopes, reorders them, replays old ones under new numbers, shows
// two clients different histories (fork), flips bits, serves a stale member list. In every attack it also drops the
// hub's void flag: a record the hub refused and kept header-only then looks like one retention pruned (for a refused
// answer that is the accepted FINDINGS H2; `attack.unvoidedAnswers` names the cards, the only thing the end check
// may forgive). It cannot sign, so it can never create content; the clients must never show or act on anything but
// what members really sent, and must say so
// (alert) when they saw tampering. State of the attack lives in `attack` (shared) and is deterministic per device.
import { makeRng } from './rng.mjs'

export const ATTACKS = ['withhold', 'reorder', 'replay', 'fork', 'bitflip', 'stale_members', 'mixed']

export function makeAttack(seed, kind) {
  const rng = makeRng(`${seed}/attack`)
  const p = kind === 'mixed' ? { withhold: 0.05, reorder: 0.08, replay: 0.08, bitflip: 0.04, fork: 0.1, stale: 0.3 }
    : { withhold: kind === 'withhold' || kind === 'fork' ? 0.12 : 0, reorder: kind === 'reorder' ? 0.2 : 0, replay: kind === 'replay' ? 0.2 : 0, bitflip: kind === 'bitflip' ? 0.1 : 0, fork: 0, stale: kind === 'stale_members' ? 0.6 : 0 }
  return { kind, p, active: true, rng, counters: { withheld: 0, reordered: 0, replayed: 0, flipped: 0, stale: 0, unvoided: 0 }, tampered: new Map(), unvoidedAnswers: new Set(), forkKey: rng.next() }
}

const hash01 = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return ((h >>> 0) % 100000) / 100000 }
const b64u = b => Buffer.from(b).toString('base64url')
const unb64u = s => Uint8Array.from(Buffer.from(s, 'base64url'))

/** Rewrite a list of { envelope_number, envelope } records for one device. */
function rewrite(attack, dev, records, state, z) {
  if (!attack.active) return records
  const out = []
  for (let r of records) {
    if (r.void) {
      // the void flag is the hub's word alone: without it the header-only record reads as pruned by retention
      attack.counters.unvoided++
      try { const h = z.peekEnvelope(unb64u(r.envelope)).header; if (h.kind === z.KIND.ANSWER && h.card) attack.unvoidedAnswers.add(Buffer.from(h.card.id).toString('hex')) } catch {}
      r = { envelope_number: r.envelope_number, envelope: r.envelope }
    }
    const x = hash01(`${attack.forkKey}/${dev.name}/${r.envelope_number}/w`)
    const fork = attack.kind === 'fork' ? hash01(`${attack.forkKey}/${r.envelope_number}/f`) < 0.5 && dev.name.endsWith('H1') : false
    if (attack.p.withhold && x < attack.p.withhold && !state.delivered.has(r.envelope_number)) { attack.counters.withheld++; continue }
    if (fork) { attack.counters.withheld++; continue }
    let rec = r
    if (attack.p.bitflip && hash01(`${attack.forkKey}/${dev.name}/${r.envelope_number}/b`) < attack.p.bitflip) {
      const u = unb64u(r.envelope); const at = Math.floor(hash01(`${r.envelope_number}/at`) * u.length); u[at] ^= 0x10
      rec = { ...r, envelope: b64u(u) }; attack.counters.flipped++; attack.tampered.set(dev.name, (attack.tampered.get(dev.name) ?? 0) + 1)
    }
    out.push(rec)
    if (attack.p.replay && hash01(`${attack.forkKey}/${dev.name}/${r.envelope_number}/r`) < attack.p.replay) { out.push({ ...r, envelope_number: r.envelope_number }); attack.counters.replayed++ }
  }
  if (attack.p.reorder) for (let i = 0; i + 1 < out.length; i++) if (hash01(`${attack.forkKey}/${dev.name}/${out[i].envelope_number}/o`) < attack.p.reorder) { [out[i], out[i + 1]] = [out[i + 1], out[i]]; attack.counters.reordered++; i++ }
  for (const r of out) state.delivered.add(r.envelope_number)
  return out
}

/** Install the man in the middle on a device. */
export function install(dev, attack, z) {
  const state = { delivered: new Set() }
  dev.mitm = async (url, init, res) => {
    if (!attack.active) return res
    const u = new URL(url)
    const path = u.pathname
    if (init.method && init.method !== 'GET') return res
    if (/\/envelopes$/.test(path) || /\/threads$/.test(path)) {
      const body = await res.clone().json().catch(() => null)
      if (!body?.envelopes) return res
      body.envelopes = /\/threads$/.test(path) ? body.envelopes : rewrite(attack, dev, body.envelopes, state, z)
      return new Response(JSON.stringify(body), { status: res.status, headers: { 'content-type': 'application/json' } })
    }
    if (/\/members$/.test(path) && attack.p.stale && hash01(`${attack.forkKey}/${dev.name}/${Date.now() >> 9}/s`) < attack.p.stale) {
      const body = await res.clone().json().catch(() => null)
      if (!body?.signed_entries || body.signed_entries.length === 0) return res
      attack.counters.stale++
      body.signed_entries = body.signed_entries.slice(0, Math.floor(body.signed_entries.length / 2))
      body.last_entry_number = Math.max(-1, Number(u.searchParams.get('after_entry_number') ?? -1) + body.signed_entries.length)
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (/\/stream$/.test(path)) {
      const dec = new TextDecoder(), enc = new TextEncoder()
      let buf = ''
      const ts = new TransformStream({
        transform(chunk, ctl) {
          buf += dec.decode(chunk, { stream: true })
          let at
          while ((at = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, at); buf = buf.slice(at + 2)
            const m = /^event: envelope\ndata: (.*)$/m.exec(block)
            if (m) {
              let d; try { d = JSON.parse(m[1]) } catch { ctl.enqueue(enc.encode(block + '\n\n')); continue }
              const kept = rewrite(attack, dev, [d], state, z)
              for (const k of kept) ctl.enqueue(enc.encode(`id: ${k.envelope_number}\nevent: envelope\ndata: ${JSON.stringify(k)}\n\n`))
            } else ctl.enqueue(enc.encode(block + '\n\n'))
          }
        },
      })
      return new Response(res.body.pipeThrough(ts), { status: res.status, headers: res.headers })
    }
    return res
  }
}
