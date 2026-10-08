// test-hub.mjs: a small HTTP hub for shared/ tests, on top of shared/crypto/hub.mjs (memory storage), speaking the
// README routes the core uses. Stand-in only while hub/server.mjs does not have the v1.1 routes (sessions, grants,
// lease); the tests prefer hub/server.mjs when it has them.
import http from 'node:http'
import * as z from './crypto/zcrypto.mjs'
import { createHub } from './crypto/hub.mjs'

const { b64u, unb64u, hex, unhex } = z
const STATUS = { unauthorised: 401, 'bad-challenge': 401, forbidden: 403, 'not-member': 403, 'removed-sender': 403, 'wrong-sender': 403, 'not-found': 404, 'no-room': 404,
  replay: 409, gap: 409, equivocation: 409, 'room-exists': 409, 'invite-used': 409, 'instance-conflict': 409, 'lease-lost': 409, 'wrong-epoch': 409, 'invite-expired': 410, 'invite-burned': 410, 'too-many': 429 }

export async function startTestHub({ port = 0, host = '127.0.0.1' } = {}) {
  const rooms = new Map()      // room_id -> { hub, streams: Set, storage }
  let hubUrl = null
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body)) }
    try {
      const url = new URL(req.url, 'http://x')
      const parts = url.pathname.split('/').filter(Boolean)    // v1 rooms :id ...
      let body = {}
      if (req.method === 'POST' || req.method === 'PUT') {
        const chunks = []
        for await (const c of req) chunks.push(c)
        const raw = Buffer.concat(chunks)
        if (req.method === 'PUT' && parts[3] === 'attachments') body = raw
        else body = raw.length ? JSON.parse(raw) : {}
        if (req.method === 'PUT' && parts[3] !== 'attachments') void 0
      }
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
      const q = k => url.searchParams.get(k)
      if (parts[0] !== 'v1') return send(404, { error: 'not-found' })
      if (parts[1] === 'rooms' && parts.length === 2 && req.method === 'POST') {
        const storage = (await import('./crypto/hub.mjs')).memoryStorage()
        const hub = await createHub({ hubUrl, storage })
        const r = await hub.found({ entry: unb64u(body.signed_entry), wraps: body.sealed_room_keys.map(w => ({ id: unhex(w.device_id), sealed: unb64u(w.key_sealed) })) })
        rooms.set(hub.roomId, { hub, storage, streams: new Set() })
        return send(201, { room_id: hub.roomId, entry_number: 0, entry_hash: r.hash, key_epoch: 1 })
      }
      const room = rooms.get(parts[2])
      if (!room) return send(404, { error: 'no-room', message: 'no such room' })
      const { hub, storage } = room
      const route = parts.slice(3).join('/')
      const M = req.method
      const deliver = (event, data, id) => { for (const s of room.streams) s.write(`${id != null ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
      const memberEvent = r => deliver('member_entry', { entry_number: r.seq, entry_hash: r.hash, key_epoch: r.epoch })
      if (M === 'POST' && route === 'challenge') return send(200, { challenge: b64u(hub.challenge()) })
      if (M === 'POST' && route === 'access_tokens') {
        const r = await hub.signIn(unb64u(body.signed_challenge))
        return send(200, { access_token: r.token, device_id: r.id, signer: r.kind === 'recovery' ? 'recovery' : 'device', device_role: r.role, expires_at: r.expiresAt })
      }
      if (M === 'GET' && route === 'members') {
        const after = Number(q('after_entry_number') ?? -1)
        const r = hub.log({ token: q('invite_id') ? undefined : token, inviteId: q('invite_id') ?? undefined, after })
        return send(200, { room_id: r.roomId, last_entry_number: r.head, signed_entries: r.entries.map(b64u) })
      }
      if (M === 'POST' && route === 'members') {
        const r = await hub.postEntry({ entry: unb64u(body.signed_entry), wraps: (body.sealed_room_keys ?? []).map(w => ({ id: unhex(w.device_id), sealed: unb64u(w.key_sealed) })), backLink: body.key_back_link ? unb64u(body.key_back_link) : undefined, cuts: body.cuts })
        memberEvent(r)
        for (const s of [...room.streams]) if (s.deviceId && r.signedOut?.includes(s.deviceId)) s.end()
        return send(200, { entry_number: r.seq, entry_hash: r.hash, key_epoch: r.epoch })
      }
      if (M === 'GET' && route === 'devices') {
        hub.authorise(token)
        const online = new Set([...room.streams].map(s => s.deviceId))
        return send(200, { devices: hub.members().map(m => ({ device_id: m.id, device_role: m.role, is_active: m.active, is_online: online.has(m.id), agent_session_id: m.role === 'agent' ? m.id.slice(0, 16) : undefined })) })
      }
      if (M === 'GET' && route === 'sealed_room_keys') return send(200, { sealed_room_keys: hub.wraps(token, { afterEpoch: Number(q('after_key_epoch') ?? 0) }).map(w => ({ key_epoch: w.epoch, key_sealed: b64u(w.sealed) })) })
      if (M === 'GET' && route === 'key_back_links') return send(200, { key_back_links: hub.backLinks(token).map(l => ({ key_epoch: l.epoch, key_back_link: b64u(l.bytes) })) })
      if (M === 'POST' && route === 'invites') { const r = await hub.postInvite(token, unb64u(body.signed_offer)); return send(200, { invite_id: r.inviteId, device_role: r.role, expires_at: r.expiresAt }) }
      if (parts[3] === 'invites' && parts[4]) {
        const id = parts[4], sub = parts[5]
        if (M === 'GET' && !sub) { const r = hub.invite(id); return send(200, { signed_offer: b64u(r.offer), device_role: r.role, expires_at: r.expiresAt, room_id: r.roomId, signed_entries: r.entries.map(b64u) }) }
        if (M === 'POST' && sub === 'requests') {
          const r = await hub.postRequest(id, unb64u(body.signed_request))
          deliver('join_request', { invite_id: id })
          return send(200, { request_hash: r.requestHash })
        }
        if (M === 'GET' && sub === 'requests') return send(200, { signed_requests: hub.requests(token, id).map(b64u) })
        if (M === 'POST' && sub === 'reveal') { const r = await hub.postReveal(token, id, unb64u(body.signed_reveal)); return send(200, { request_hash: r.requestHash }) }
        if (M === 'GET' && sub === 'status') {
          const r = hub.joinStatus(id, q('request_hash'))
          return send(200, { join_status: r.status, signed_reveal: r.reveal ? b64u(r.reveal) : undefined, signed_entries: r.entries?.map(b64u), key_sealed: r.wrap ? b64u(r.wrap) : undefined })
        }
        if (M === 'DELETE' && !sub) return send(404, { error: 'not-found' })
      }
      const pruneThread = async e => (z.peekEnvelope(e.bytes).header.isHead ? e.bytes : z.pruneEnvelope(e.bytes))
      if (M === 'POST' && route === 'envelopes') {
        const lease = req.headers['x-lease-generation'] != null ? Number(req.headers['x-lease-generation']) : null
        const r = await hub.postEnvelope(token, unb64u(body.envelope), { leaseGeneration: lease })
        deliver('envelope', { envelope_number: r.n, envelope: body.envelope }, r.n)
        return send(200, { envelope_number: r.n })
      }
      if (M === 'GET' && route === 'envelopes') {
        // Members; also the recovery key (as hub/server.mjs serves it: the headers for the cuts of a recovery).
        const after = Number(q('after_envelope_number') ?? 0), limit = Number(q('limit') ?? 1000)
        const list = hub.authorise(token).kind === 'recovery' ? storage.envelopes(after, limit) : hub.envelopes(token, { after, limit })
        const all = storage.envelopes(0, Infinity)
        return send(200, { last_envelope_number: all.at(-1)?.n ?? 0, envelopes: await Promise.all(list.map(async e => ({ envelope_number: e.n, envelope: b64u(await pruneThread(e)) }))) })
      }
      if (M === 'GET' && route === 'threads') {
        hub.authorise(token)
        const kind = { chat: 1, canvas: 2 }[q('timeline_kind')], tid = q('timeline_id'), limit = Number(q('limit') ?? 50)
        let items = storage.envelopes(0, Infinity).filter(e => { const h = z.peekEnvelope(e.bytes).header; return h.timelineKind === kind && h.timelineId === tid })
        let has_more = false
        if (q('after_envelope_number') != null) { items = items.filter(e => e.n > Number(q('after_envelope_number'))); has_more = items.length > limit; items = items.slice(0, limit) }
        else { const before = Number(q('before_envelope_number') ?? Infinity); items = items.filter(e => e.n < before).reverse(); has_more = items.length > limit; items = items.slice(0, limit) }
        return send(200, { envelopes: items.map(e => ({ envelope_number: e.n, envelope: b64u(e.bytes) })), has_more })
      }
      if (M === 'GET' && route === 'stream') {
        const who = hub.authorise(token)
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        const after = Number(q('after_envelope_number') ?? 0)
        for (const e of storage.envelopes(after, Infinity)) res.write(`id: ${e.n}\nevent: envelope\ndata: ${JSON.stringify({ envelope_number: e.n, envelope: b64u(await pruneThread(e)) })}\n\n`)
        res.deviceId = who.id
        room.streams.add(res)
        req.on('close', () => room.streams.delete(res))
        return
      }
      if (M === 'POST' && route === 'agent_lease') { const r = hub.takeLease(token, { instance: body.process_instance }); return send(200, { lease_generation: r.generation, expires_at: r.expiresAt }) }
      if (M === 'GET' && route === 'sessions') {
        hub.authorise(token)
        return send(200, { sessions: [...storage._data.grants.keys()].map(sid => ({ session_id: sid, last_grant_number: storage.grants(sid).length - 1 })) })
      }
      if (parts[3] === 'sessions' && parts[4]) {
        const sid = parts[4], sub = parts[5]
        if (M === 'GET' && sub === 'grants') { const after = Number(q('after_grant_number') ?? -1); return send(200, { signed_grants: (await hub.grants(token, sid)).slice(after + 1).map(b64u) }) }
        if (M === 'POST' && sub === 'grants') {
          const r = await hub.postGrant({ sessionId: sid, grant: unb64u(body.signed_grant), wraps: body.sealed_session_keys.map(w => ({ id: unhex(w.device_id), sealed: unb64u(w.key_sealed) })), backLink: body.key_back_link ? unb64u(body.key_back_link) : undefined })
          deliver('session_grant', { session_id: sid, grant_number: r.grantNumber, session_key_epoch: r.sessionKeyEpoch })
          return send(200, { grant_number: r.grantNumber, grant_hash: r.grantHash, session_key_epoch: r.sessionKeyEpoch })
        }
        if (M === 'GET' && sub === 'sealed_session_keys') return send(200, { sealed_session_keys: hub.sessionWraps(token, sid, { afterEpoch: Number(q('after_session_key_epoch') ?? 0) }).map(w => ({ session_key_epoch: w.epoch, key_sealed: b64u(w.sealed) })) })
        if (M === 'GET' && sub === 'key_back_links') return send(200, { key_back_links: (await hub.sessionBackLinks(token, sid)).map(l => ({ session_key_epoch: l.epoch, key_back_link: b64u(l.bytes) })) })
      }
      if (parts[3] === 'attachments' && parts[4]) {
        room.files ??= new Map()
        if (M === 'PUT') { hub.authorise(token); room.files.set(parts[4], body); return send(201, { attachment_id: parts[4], total_size: body.length }) }
        if (M === 'GET') { hub.authorise(token); const b = room.files.get(parts[4]); if (!b) return send(404, { error: 'not-found' }); res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(b) }
      }
      return send(404, { error: 'not-found', message: `${M} ${route}` })
    } catch (e) {
      send(STATUS[e.code] ?? (e.code ? 400 : 500), { error: e.code ?? 'internal', message: e.message })
    }
  })
  // PUT bodies arrive raw: re-wire body parsing for PUT
  await new Promise(r => server.listen(port, host, r))
  hubUrl = `http://${host}:${server.address().port}`
  return { hubUrl, port: server.address().port, rooms, close: () => new Promise(r => { for (const room of rooms.values()) for (const s of room.streams) s.end(); server.close(r); server.closeAllConnections() }) }
}
