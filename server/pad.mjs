// The global pad on the server: one record per element, a running number for
// every change, the bytes of pictures and voice notes, and "send this selection
// to a session". The model and the wire format are in docs/pad.md.
//
// Storage is SQLite, through server/store/store.mjs (the event log with its
// pad_elements and pad_links views), in a database file of its own:
//   data/pad.db          elements, tombstones, where what was sent, the log of changes
//   data/pad/blobs/<id>  the bytes of pictures and voice notes; the database knows them by reference
// The board's own state stays in state.json until it moves over; nothing else
// in server.mjs touches this database. node:sqlite needs Node 22.13 or newer,
// so the store is loaded only when the pad is first used: a hub on an older
// Node starts and serves everything else, and the pad's routes say why they do not.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const ELEMENT_TYPES = ['stroke', 'image', 'text', 'voice']
const ID = /^[0-9a-z]{6,40}$/
const PAD = /^[A-Za-z0-9:_-]{1,80}$/
const MAX_RECORD = 2e6          // one element as JSON; a long stroke is some 50 kB
const MAX_BLOB = 30e6
const SENT_KEEP = 50            // links kept per element

const fail = (status, message, extra) => Object.assign(new Error(message), { status, ...extra })
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)

export const PAD_NODE = [22, 13]
/** Why the pad cannot work in this process, or null. Cheap: looks at the version only. */
export function padSupport() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major > PAD_NODE[0] || (major === PAD_NODE[0] && minor >= PAD_NODE[1])) return null
  return `The pad is off: it keeps its elements in SQLite (node:sqlite), which needs Node ${PAD_NODE.join('.')} or newer; this hub runs on Node ${process.versions.node}. Everything else works.`
}

/** The store, opened on data/pad.db. One per data folder; only the hub opens it.
 *  Rejects with a readable message when node:sqlite is not there. */
export async function openPadStore(dataDir, { retentionDays = 30 } = {}) {
  let Store
  try {
    ({ Store } = await import('./store/store.mjs'))
  } catch (err) {
    throw fail(501, padSupport() ?? `The pad is off: SQLite (node:sqlite) could not be loaded in this Node ${process.versions.node} (${err.code ?? err.message}). Everything else works.`)
  }
  const blobDir = path.join(dataDir, 'pad', 'blobs')
  fs.mkdirSync(blobDir, { recursive: true, mode: 0o700 })
  const store = new Store(path.join(dataDir, 'pad.db'))
  // Names this store, so a page notices one that started over and sends what only it still has.
  if (!store.meta('pad_epoch')) store.setMeta('pad_epoch', crypto.randomBytes(6).toString('hex'))
  const epoch = String(store.meta('pad_epoch'))
  const cursor = () => store.cursor()

  /** A row of the store as the record the page works with; "sent" is folded in from the links. */
  function recordOf(e) {
    const about = new Map()
    const sent = store.elementLinks({ element: e.id, limit: SENT_KEEP }).reverse().map(l => {
      if (!about.has(l.seq)) about.set(l.seq, store.event(l.seq)?.body?.message_id ?? l.seq)
      return { session: l.session, at: l.sentAt, message_id: about.get(l.seq), rev: l.rev }
    })
    if (e.deleted) return { id: e.id, pad: e.pad, deleted: true, author: e.author, updated: e.updated, rev: e.rev, seq: e.seq, blob: e.blob, sent }
    return {
      id: e.id, pad: e.pad, type: e.type, x: e.x, y: e.y, w: e.w, h: e.h, rotation: e.rotation, z: e.z, group: e.group,
      author: e.author, created: e.created, updated: e.updated, rev: e.rev, seq: e.seq, blob: e.blob, data: e.data, sent,
    }
  }

  const listeners = new Set()
  const tell = (changed, origin) => {
    if (changed.length) for (const fn of listeners) fn({ seq: cursor(), elements: changed, client_id: origin ?? null })
  }

  /** What the page sent, as the record the store keeps. Throws on what is no element. */
  function clean(given, pad) {
    if (!given || typeof given !== 'object') throw fail(400, 'an element must be an object')
    const id = String(given.id ?? '')
    if (!ID.test(id)) throw fail(400, `not an element id: ${JSON.stringify(given.id)}`)
    const rev = Math.floor(num(given.rev, 0))
    if (rev < 1) throw fail(400, `element ${id}: rev must be a positive number`)
    const author = String(given.author ?? 'human').slice(0, 80) || 'human'
    if (given.deleted) return { id, pad, deleted: true, author, rev }
    if (!ELEMENT_TYPES.includes(given.type)) throw fail(400, `element ${id}: type must be one of ${ELEMENT_TYPES.join(', ')}`)
    if (!given.data || typeof given.data !== 'object') throw fail(400, `element ${id}: data is required`)
    if (given.blob != null && !ID.test(String(given.blob))) throw fail(400, `element ${id}: blob is not an id`)
    const rec = {
      id, pad, type: given.type,
      x: num(given.x), y: num(given.y), w: num(given.w), h: num(given.h), rotation: num(given.rotation),
      z: Math.round(num(given.z)), group: given.group == null ? null : String(given.group).slice(0, 40),
      author, created: num(given.created, Date.now()), rev,
      blob: given.blob == null ? null : String(given.blob), data: given.data,
    }
    if (JSON.stringify(rec).length > MAX_RECORD) throw fail(413, `element ${id} is too large`)
    return rec
  }

  /** Create or change. Per element { id, rev, seq, updated } or { id, error, current }. One commit for the call. */
  function put(pad, list, origin) {
    if (!PAD.test(String(pad ?? ''))) throw fail(400, 'pad is required')
    if (!Array.isArray(list) || !list.length) throw fail(400, 'elements must be a non-empty list')
    if (list.length > 5000) throw fail(413, 'too many elements in one call')
    const wanted = list.map(given => clean(given, pad))   // all or nothing on malformed input
    const changed = []
    const results = store.tx(() => wanted.map(rec => {
      const have = store.element(rec.id, { deleted: true })
      const ok = el => { const out = recordOf(el); changed.push(out); return { id: out.id, rev: out.rev, seq: out.seq, updated: out.updated } }
      // Last writer wins, per element: the order of arrival decides, the revision says who is behind.
      if (have && (rec.rev <= have.rev || have.pad !== pad)) return { id: rec.id, error: 'conflict', current: recordOf(have) }
      if (have && !rec.deleted && have.type !== rec.type) return { id: rec.id, error: 'type', current: recordOf(have) }
      try {
        if (rec.deleted) {
          // Made and deleted before the server ever heard of it, or deleted twice: nothing to take off.
          if (!have || have.deleted) return { id: rec.id, rev: rec.rev, seq: have?.seq ?? cursor(), updated: have?.updated ?? Date.now() }
          return ok(store.deleteElement(rec.id, { by: rec.author, rev: rec.rev }).element)
        }
        // The bytes come first (PUT /pad/blobs/<id>); an element that names bytes the server does not have waits for them.
        if (rec.blob && !(store.blob(rec.blob)?.doomed === false)) return { id: rec.id, error: 'blob' }
        // The hub's clock sets "updated"; a put with a newer revision also brings a deleted element back.
        return ok(store.putElement({ ...rec, sender: rec.author }).element)
      } catch (err) {
        if (!err.code) throw err
        return { id: rec.id, error: err.code === 'conflict' ? 'conflict' : err.message, ...(have ? { current: recordOf(have) } : {}) }
      }
    }))
    tell(changed, origin)
    return { seq: cursor(), epoch, results }
  }

  /** A tombstone. Without a revision, the next one. */
  function remove(id, { rev, author, origin } = {}) {
    const have = store.element(id, { deleted: true })
    if (!have) throw fail(404, 'unknown element')
    return put(have.pad, [{ id, deleted: true, author: author ?? have.author, rev: rev ?? have.rev + 1 }], origin)
  }

  /** Every live element bottom first, or with since: what changed after that number, tombstones included. */
  function list(pad, since) {
    const out = []
    const PAGE = 2000
    for (;;) {
      const page = since == null
        ? store.elements({ pad, limit: PAGE, after: out.length ? [out.at(-1).z, out.at(-1).id] : undefined })
        : store.elements({ pad, limit: PAGE, sinceSeq: out.length ? out.at(-1).seq : since })
      out.push(...page)
      if (page.length < PAGE) break
    }
    return { seq: cursor(), epoch, elements: out.map(recordOf) }
  }

  /** Note where elements went: one event, one link per element. No new revision: a link is
   *  not a change to the element, but its running number moves, so other devices hear of it. */
  function link(ids, { session, message_id, pad }, origin) {
    const out = store.tx(() => {
      // The board's sessions live in state.json; this database only needs to know the id.
      store.upsertSession({ id: session })
      return store.sendElements({ ids, session, by: 'human', body: { pad, message_id } })
    })
    const changed = out.elements.map(e => recordOf(store.element(e.id)))
    tell(changed, origin)
    return changed
  }

  const blobFile = id => path.join(blobDir, id)
  function putBlob(id, type, bytes) {
    if (!ID.test(id)) throw fail(400, 'not a blob id')
    if (!bytes.length) throw fail(400, 'empty blob')
    const tmp = `${blobFile(id)}.${process.pid}.tmp`
    fs.writeFileSync(tmp, bytes, { mode: 0o600 })
    fs.renameSync(tmp, blobFile(id))
    store.registerBlob({ id, kind: 'pad', path: `pad/blobs/${id}`, size: bytes.length, meta: { type: String(type || 'application/octet-stream').slice(0, 120) } })
  }
  function getBlob(id) {
    if (!ID.test(id)) return null
    const blob = store.blob(id)
    if (!blob || blob.doomed || !fs.existsSync(blobFile(id))) return null
    return { type: blob.meta?.type ?? 'application/octet-stream', file: blobFile(id), size: fs.statSync(blobFile(id)).size }
  }

  /** Tombstones past the retention go, and with them the files that were kept for an undo. */
  function purge() {
    for (const f of store.doomedFiles()) { fs.rmSync(path.join(dataDir, f.path), { force: true }); store.confirmDeleted(f.id) }
    const out = store.purge({ days: retentionDays })
    for (const f of out.files ?? []) fs.rmSync(path.join(dataDir, f.path), { force: true })
    if (out.files?.length) store.confirmDeleted(out.files.map(f => f.id))
    return out
  }
  try { purge() } catch (err) { console.error(`[board] pad cleanup failed: ${err.message}`) }
  setInterval(() => { try { purge() } catch (err) { console.error(`[board] pad cleanup failed: ${err.message}`) } }, 6 * 3600000).unref()

  return {
    get seq() { return cursor() },
    epoch,
    get: id => { const e = store.element(id, { deleted: true }); return e ? recordOf(e) : undefined },
    put, remove, list, link, putBlob, getBlob, purge,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    close: () => store.close(),
  }
}

// Media types a blob may be served as; anything else goes out as plain bytes.
const BLOB_TYPE = /^(image\/(png|jpeg|webp|gif)|audio\/[a-z0-9.+-]+(;\s*codecs=[a-z0-9.,"+ -]+)?)$/i

/** The pad's HTTP routes. Returns a function (req, res, url) that resolves to true if it answered.
 *  ctx: what the routes need from the board: dir() the data folder, files (folder of attachments), retentionDays,
 *  send, readJson, readRaw, pngBytes, sessionOf(id) -> session id or null, say(session, text,
 *  attachments) -> message id, deliver(session, method, params), ping (ms). */
export function padRoutes(ctx) {
  let opening = null
  // Opened on first use: by then this process is the hub, and whatever an earlier hub wrote is in the file.
  // If SQLite is not there, every pad route says so (501) and the rest of the board is untouched.
  const pad = () => (opening ??= openPadStore(ctx.dir(), { retentionDays: ctx.retentionDays }).catch(err => {
    const off = err.status === 501
    console.error(`[board] ${off ? err.message : `the pad's database could not be opened: ${err.message}`}`)
    if (!off) opening = null   // a locked or missing file may be there the next time
    throw off ? err : fail(503, `The pad's database could not be opened: ${err.message}`)
  }))
  const json = (res, code, body) => ctx.send(res, code, JSON.stringify(body))
  const sinceOf = url => {
    const raw = url.searchParams.get('since')
    return raw == null || raw === '' ? null : Math.max(0, Math.floor(num(raw)))
  }

  return async function route(req, res, url) {
    const p = url.pathname
    try {
      if (req.method === 'GET' && p === '/pad/elements') {
        return json(res, 200, (await pad()).list(url.searchParams.get('pad') || 'global', sinceOf(url))), true
      }
      if (req.method === 'POST' && p === '/pad/elements') {
        const body = await ctx.readJson(req, 64e6)
        return json(res, 200, { ok: true, ...(await pad()).put(body.pad || 'global', body.elements, body.client_id) }), true
      }
      if (req.method === 'DELETE' && p.startsWith('/pad/elements/')) {
        const rev = url.searchParams.get('rev')
        const out = (await pad()).remove(path.basename(p), { rev: rev == null ? undefined : Math.floor(num(rev)), origin: url.searchParams.get('client_id') })
        const [result] = out.results
        return json(res, result.error ? 409 : 200, { ok: !result.error, seq: out.seq, epoch: out.epoch, ...result }), true
      }
      if (p.startsWith('/pad/blobs/')) {
        const id = path.basename(p)
        if (req.method === 'PUT') {
          const bytes = await ctx.readRaw(req, MAX_BLOB)
          ;(await pad()).putBlob(id, req.headers['content-type'], bytes)
          return json(res, 200, { ok: true, id }), true
        }
        if (req.method === 'GET') {
          const blob = (await pad()).getBlob(id)
          if (!blob) return json(res, 404, { error: 'not found' }), true
          res.writeHead(200, {
            'Content-Type': BLOB_TYPE.test(blob.type) ? blob.type : 'application/octet-stream', 'Content-Length': blob.size,
            // The bytes of an id never change; and they never run as a page.
            'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox",
          })
          fs.createReadStream(blob.file).on('error', () => res.destroy()).pipe(res)
          return true
        }
      }
      if (req.method === 'GET' && p === '/pad/events') {
        const name = url.searchParams.get('pad') || 'global'
        const since = sinceOf(url)
        const s = await pad()
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
        const write = msg => res.write(`data: ${JSON.stringify(msg)}\n\n`)
        res.write('retry: 2000\n\n')
        write({ hello: true, seq: s.seq, epoch: s.epoch })
        if (since != null) {
          const missed = s.list(name, since).elements
          if (missed.length) write({ seq: s.seq, elements: missed, client_id: null })
        }
        const off = s.subscribe(change => {
          const mine = change.elements.filter(r => r.pad === name)
          if (mine.length) write({ ...change, elements: mine })
        })
        // A comment line now and then, so a proxy does not close a quiet stream.
        const beat = setInterval(() => res.write(': ping\n\n'), ctx.ping ?? 15000)
        req.on('close', () => { off(); clearInterval(beat) })
        return true
      }
      if (req.method === 'POST' && p === '/pad/send') {
        // The picture of a selection with photos in it is large; the limit is generous but finite.
        const body = await ctx.readJson(req, 96e6)
        const name = body.pad || 'global'
        const s = await pad()
        const session = ctx.sessionOf(body.session)
        if (!session) return json(res, 404, { error: 'unknown session' }), true
        const png = ctx.pngBytes(body.png)
        if (!Array.isArray(body.elements) || !body.elements.length) throw fail(400, 'elements must be a non-empty list')
        if (body.elements.length > 500) throw fail(413, 'send at most 500 elements at a time')
        const ids = body.elements.map(e => {
          const have = s.get(String(e?.id ?? ''))
          if (!have || have.deleted || have.pad !== name) throw fail(409, `element ${e?.id} is not on the pad (any more); it may not have been saved yet`)
          return have.id
        })
        const words = String(body.text ?? '').trim()
        const file = `pad-${crypto.randomBytes(6).toString('hex')}.png`
        const image = path.join(ctx.files, file)
        fs.writeFileSync(image, png, { mode: 0o600 })
        const messageId = ctx.say(session, words, [{ kind: 'image', name: 'From the pad', url: `/files/${file}`, image: true, size: png.length, pad: name }])
        await ctx.deliver(session, 'notifications/claude/channel', {
          content: words || 'The human selected something on their pad and sent it to you. image_path shows it.',
          meta: { kind: 'pad', pad: name, message_id: messageId, elements: ids.join(','), image_path: image },
        })
        const elements = s.link(ids, { session, message_id: messageId, pad: name }, body.client_id)
        return json(res, 200, { ok: true, message_id: messageId, seq: s.seq, elements }), true
      }
      return false
    } catch (err) {
      json(res, err.status ?? 400, { error: err.message, ...(err.current ? { current: err.current } : {}) })
      return true
    }
  }
}
