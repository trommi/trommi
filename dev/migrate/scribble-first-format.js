// One-time migration: every old Scribble Board of the room onto the one room board. Not part of the app, not run by
// CI; run once by hand, in the owner's own browser.
//
// Why: until 8 October 2026 each desk had a board of its own (timeline desk/<deskCanvas(desk id)>, and on "All" before
// 880d427 the board desk/616c6c…03), and boards drawn before cdaaa64 are in the first stroke format, which no app
// reads any more. Since then the room has ONE board (ROOM_BOARD, shared/scribble.ts: the timeline that was the 'main'
// desk's). This script reads every old board with the owner's own device (a desk board is written by humans only:
// timelineRefusal), works out what was on each (adds, pieces, moves, erasures, in either format), and sends the
// shapes as NEW strokes items in the current format onto the room board, the boards side by side in a row (the room
// board's own content stays where it is; each next board starts GAP right of the last). Append-only: no envelope is
// deleted or changed. Afterwards the app writes a fresh snapshot of the room board.
//
// Each shape written carries group "ff:<sender 16 hex>/<sequence>/<index>" (its old id): a second run skips what is
// there already, so running twice adds nothing.
//
// Run: open https://app.trommi.com signed in (the browser that drew the boards), DevTools -> Console, paste this whole
// file, then
//   await trommiMigrateScribble({ dryRun: true })      // counts per old board, writes nothing
//   await trommiMigrateScribble({ dryRun: false })     // the real run
// dev/migrate/test.mjs loads the same file in Node and runs trommiMigrateScribble.core against a local hub.
;(() => {
  const ROOM_BOARD = 'desk/6d61696e000000000000000000000004'   // shared/scribble.ts ROOM_BOARD
  const GAP = 400                                              // board units between two boards in the row
  const ITEM_BYTES = 40_000                                    // a strokes item well under the core's 60 KB body limit

  // ---- base64url ----
  const b64u = bytes => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
  const unb64u = text => { const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)); return Uint8Array.from(s, c => c.charCodeAt(0)) }

  // ---- the current format (shared/ink.ts packPoints, unpackPoints, bake) ----
  const Q = 16, TAU = Math.PI * 2, HALF_PI = Math.PI / 2
  const fin = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
  function putVar(out, v) { while (v >= 128) { out.push((v % 128) + 128); v = Math.floor(v / 128) } out.push(v) }
  const zig = v => (v >= 0 ? 2 * v : -2 * v - 1)
  const unzig = v => (v % 2 ? -(v + 1) / 2 : v / 2)
  function packPoints(ink) {
    const p = ink.pts, n = p.length >> 1, az = ink.az, al = ink.al
    const tilt = Boolean(az && al && az.length >= n && al.length >= n)
    const out = [(tilt ? 1 : 0) | (ink.sim ? 2 : 0)]
    let lx = 0, ly = 0, lt = 0
    for (let i = 0; i < n; i++) {
      const x = Math.round(fin(p[2 * i]) * Q), y = Math.round(fin(p[2 * i + 1]) * Q)
      const t = Math.max(i ? lt : 0, Math.round(fin(ink.t?.[i] ?? lt)))
      putVar(out, zig(x - lx)); putVar(out, zig(y - ly)); putVar(out, t - lt)
      out.push(Math.round(clamp(fin(ink.f?.[i] ?? 0.5), 0, 1) * 255))
      if (tilt) { const a = ((fin(az[i]) % TAU) + TAU) % TAU; out.push(Math.round((a / TAU) * 256) % 256, Math.round((clamp(fin(al[i]), 0, HALF_PI) / HALF_PI) * 255)) }
      lx = x; ly = y; lt = t
    }
    return b64u(Uint8Array.from(out))
  }
  function unpackPoints(text) {
    let b
    try { b = unb64u(typeof text === 'string' ? text : '') } catch { return null }
    if (!b.length || b[0] & ~3) return null
    const tilt = (b[0] & 1) === 1
    const ink = { pts: [], t: [], f: [], az: tilt ? [] : null, al: tilt ? [] : null, sim: (b[0] & 2) === 2 }
    let o = 1, x = 0, y = 0, t = 0
    const v = () => { let r = 0, m = 1; for (let k = 0; k < 8; k++) { if (o >= b.length) throw 0; const c = b[o++]; r += (c & 127) * m; if (c < 128) return r; m *= 128 } throw 0 }
    try {
      while (o < b.length) {
        if (ink.t.length >= 50_000) return null
        x += unzig(v()); y += unzig(v()); t += v()
        if (o + (tilt ? 3 : 1) > b.length) return null
        ink.pts.push(x / Q, y / Q); ink.t.push(t); ink.f.push(Math.round((b[o++] / 255) * 1000) / 1000)
        if (tilt) { ink.az.push((b[o++] / 256) * TAU); ink.al.push((b[o++] / 255) * HALF_PI) }
      }
    } catch { return null }
    return ink.t.length ? ink : null
  }
  function bake(ink, m) {
    if (!Array.isArray(m) || m.length !== 6 || !m.every(Number.isFinite)) return { ink, scale: 1 }
    const [a, b, c, d, tx, ty] = m
    const pts = ink.pts.slice()
    for (let i = 0; i < pts.length; i += 2) { const x = pts[i], y = pts[i + 1]; pts[i] = a * x + c * y + tx; pts[i + 1] = b * x + d * y + ty }
    const turn = Math.atan2(b, a)
    return { ink: { ...ink, pts, az: ink.az && turn ? ink.az.map(v => (((v + turn) % TAU) + TAU) % TAU) : ink.az }, scale: Math.sqrt(Math.abs(a * d - b * c)) || 1 }
  }

  // ---- the first format (shared/scribble.mjs at 0e50a99) ----
  // Entry = { points, pressure?, style: { tool, color?, size? }, z?, group?, text?, wrap?, attachment?, nw?, nh?, mime?, name?, continues? }
  // points: base64url, 1/8 unit, the first point as two int32 BE, then int16 BE deltas; pressure: one byte per point.
  function decodePoints(text) {
    let b
    try { b = unb64u(typeof text === 'string' ? text : '') } catch { return [] }
    if (b.length < 8 || (b.length - 8) % 4) return []
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
    let x = v.getInt32(0), y = v.getInt32(4)
    const out = [x / 8, y / 8]
    for (let o = 8; o < b.length; o += 4) { x += v.getInt16(o); y += v.getInt16(o + 2); out.push(x / 8, y / 8) }
    return out
  }
  function decodePressure(text, n) {
    if (!text) return null
    let b
    try { b = unb64u(text) } catch { return null }
    return b.length === n ? Array.from(b, v => Math.round((v / 255) * 100) / 100) : null
  }
  /** The old pen was half · (0.35 + 1.3 p) wide; the current one half · (0.3 + 1.4 √f): this force draws the same width. */
  const forceOf = p => Math.min(1, ((0.05 + 1.3 * p) / 1.4) ** 2)
  const TOKENS = new Set(['ink', 'red', 'orange', 'yellow', 'green', 'blue', 'violet', 'pink'])
  const HEX = { '#e03131': 'red', '#f08c00': 'orange', '#2f9e44': 'green', '#1971c2': 'blue', '#9c36b5': 'violet', '#1b1f23': 'ink', '#e9eeea': 'ink',
    '#ffd43b': 'yellow', '#69db7c': 'green', '#ff8cc6': 'pink', '#66c2ff': 'blue', '#ffa94d': 'orange' }
  function token(color, marker, stats) {
    const k = typeof color === 'string' ? color.toLowerCase() : null
    if (k && TOKENS.has(k)) return k
    if (k && HEX[k]) return HEX[k]
    if (k) stats.unknown_colours++   // painted as the tool's first colour
    return marker ? 'yellow' : 'ink'
  }

  // ---- shapes: one form for both formats ----
  // { id, by, first, tool: pen | marker | text | voice | sticky | image, z, group, ink? (strokes), color, width,
  //   at? (notes), text, size, wrap, rect?, attachment, nw, nh, mime, name (pictures) }
  const WORDS = new Set(['text', 'voice', 'sticky'])
  const num = (v, d = 0) => (Number.isFinite(v) ? v : d)
  const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : null)
  const nums = (v, n) => (Array.isArray(v) && v.length === n && v.every(Number.isFinite) ? [...v] : null)
  const isFirst = e => Boolean(e && e.tool == null && e.style && typeof e.style === 'object')
  function firstShape(e, id, by, stats) {
    const old = e.style.tool, tool = old === 'hl' ? 'marker' : old
    const pts = decodePoints(e.points)
    const s = { id, by, first: true, tool, z: num(e.z), group: str(e.group, 80) }
    if (tool === 'pen' || tool === 'marker') {
      const n = pts.length >> 1
      if (!n) return null
      const pr = tool === 'pen' ? decodePressure(e.pressure, n) : null
      const w = num(e.style.size, tool === 'marker' ? 18 : 4)
      return Object.assign(s, { ink: { pts, t: Array.from({ length: n }, (_, i) => i * 8), f: pr ? pr.map(forceOf) : new Array(n).fill(0.25), az: null, al: null, sim: !pr },
        color: token(e.style.color, tool === 'marker', stats), width: w > 0 && w <= 1000 ? w : tool === 'marker' ? 18 : 4 })
    }
    if (WORDS.has(tool)) {
      if (pts.length < 2) return null
      return Object.assign(s, { at: pts.slice(0, 2), text: String(e.text ?? '').slice(0, 20000), size: num(e.style.size, 20) || 20, color: token(e.style.color, false, stats), wrap: Number.isFinite(e.wrap) ? e.wrap : null })
    }
    if (tool === 'image' && pts.length >= 4 && e.attachment?.attachment_id) return Object.assign(s, { rect: pts.slice(0, 4), attachment: e.attachment, nw: num(e.nw), nh: num(e.nh), mime: str(e.mime, 80), name: str(e.name) })
    return null
  }
  function currentShape(e, id, by) {
    const tool = e?.tool
    const s = { id, by, first: false, tool, z: num(e?.z), group: str(e?.group, 80) }
    if (tool === 'pen' || tool === 'marker') {
      const got = unpackPoints(e.points)
      if (!got) return null
      const { ink, scale } = bake(got, e.transform)
      const w = num(e.width, tool === 'marker' ? 18 : 4)
      return Object.assign(s, { ink, color: str(e.color, 40), width: (w > 0 && w <= 1000 ? w : tool === 'marker' ? 18 : 4) * scale })
    }
    if (WORDS.has(tool)) { const at = nums(e.at, 2); return at && Object.assign(s, { at, text: String(e.text ?? '').slice(0, 20000), size: num(e.size, 20), color: str(e.color, 40), wrap: Number.isFinite(e.wrap) ? e.wrap : null }) }
    if (tool === 'image') { const rect = nums(e.rect, 4); return rect && e.attachment?.attachment_id ? Object.assign(s, { rect, attachment: e.attachment, nw: num(e.nw), nh: num(e.nh), mime: str(e.mime, 80), name: str(e.name) }) : null }
    return null
  }
  function shift(s, dx, dy) {
    if (s.ink) for (let k = 0; k < s.ink.pts.length; k += 2) { s.ink.pts[k] += dx; s.ink.pts[k + 1] += dy }
    if (s.at) { s.at[0] += dx; s.at[1] += dy }
    if (s.rect) { s.rect[0] += dx; s.rect[1] += dy; s.rect[2] += dx; s.rect[3] += dy }
  }

  /** What a board's items left, both formats (adding once per id, erasing wins, moves add up, pieces continue their
   *  stroke, an item once per sender and sequence). items: { envelope_number, sender_device_id, sender_sequence, content }. */
  function reduceBoard(items) {
    const shapes = new Map(), erased = new Set(), done = new Set()
    const stats = { first_format_items: 0, unreadable: 0, pieces: 0, erased: 0, moved: 0, unknown_colours: 0 }
    for (const it of [...items].sort((a, b) => a.envelope_number - b.envelope_number)) {
      const by = it.sender_device_id, seq = it.sender_sequence, c = it.content
      if (!by || !Number.isSafeInteger(seq) || !c || done.has(`${by}/${seq}`)) continue
      done.add(`${by}/${seq}`)
      if (c.content_type === 'strokes') {
        let first = false
        ;(Array.isArray(c.strokes) ? c.strokes : []).forEach((e, i) => {
          if (e?.continues != null) {
            const head = shapes.get(e.continues)
            if (!head?.ink || !e.continues.startsWith(`${by}/`)) return
            if (head.first) {
              const more = decodePoints(e.points), n = more.length >> 1
              if (!n) return
              const pr = head.tool === 'pen' && !head.ink.sim ? decodePressure(e.pressure, n) : null
              const t0 = (head.ink.t.at(-1) ?? 0) + 8
              head.ink.pts.push(...more); head.ink.t.push(...Array.from({ length: n }, (_, k) => t0 + k * 8)); head.ink.f.push(...(pr ? pr.map(forceOf) : new Array(n).fill(head.ink.sim ? 0.25 : forceOf(0.5))))
              first = true
            } else {
              const more = unpackPoints(e.points)
              if (!more) return
              head.ink.pts.push(...more.pts); head.ink.t.push(...more.t); head.ink.f.push(...more.f)
              if (head.ink.az && more.az) { head.ink.az.push(...more.az); head.ink.al.push(...more.al) } else head.ink.az = head.ink.al = null
            }
            stats.pieces++
            return
          }
          const id = `${by}/${seq}/${i}`
          if (isFirst(e)) first = true
          if (erased.has(id) || shapes.has(id)) return
          const s = isFirst(e) ? firstShape(e, id, by, stats) : currentShape(e, id, by)
          if (s) shapes.set(id, s); else stats.unreadable++
        })
        if (first) stats.first_format_items++
      } else if (c.content_type === 'erase' || c.content_type === 'send_away') {
        for (const id of Array.isArray(c.stroke_ids) ? c.stroke_ids : []) { erased.add(id); if (shapes.delete(id)) stats.erased++ }
      } else if (c.content_type === 'move') {
        const [dx, dy] = Array.isArray(c.offset) ? c.offset.map(v => num(v)) : [0, 0]
        if (dx || dy) for (const id of Array.isArray(c.stroke_ids) ? c.stroke_ids : []) { const s = shapes.get(id); if (s) { shift(s, dx, dy); stats.moved++ } }
      }
    }
    return { shapes, stats }
  }

  const r2 = v => Math.round(v * 100) / 100
  const markOf = id => { const [by, seq, i] = id.split('/'); return `ff:${by.slice(0, 16)}/${seq}/${i}` }
  /** A shape -> a current-format entry (README "Scribble strokes"), marked with its old id. */
  function entryOf(s) {
    const e = s.ink ? { tool: s.tool, color: s.color ?? (s.tool === 'marker' ? 'yellow' : 'ink'), width: r2(s.width), points: packPoints(s.ink) }
      : s.at ? { tool: s.tool, at: s.at.map(r2), text: s.text ?? '', size: s.size, color: s.color ?? 'ink', ...(s.wrap != null ? { wrap: s.wrap } : {}) }
      : { tool: 'image', rect: s.rect.map(r2), attachment: s.attachment, ...Object.fromEntries(['nw', 'nh', 'mime', 'name'].filter(k => s[k] != null && s[k] !== 0).map(k => [k, s[k]])) }
    if (s.z) e.z = s.z
    e.group = markOf(s.id)
    return e
  }
  /** The box of shapes [x0, y0, x1, y1], or null. */
  function boxOf(shapes) {
    let b = null
    const add = (x, y) => { b = b ? [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)] : [x, y, x, y] }
    for (const s of shapes) {
      if (s.ink) for (let k = 0; k < s.ink.pts.length; k += 2) add(s.ink.pts[k], s.ink.pts[k + 1])
      if (s.at) add(s.at[0], s.at[1])
      if (s.rect) { add(s.rect[0], s.rect[1]); add(s.rect[2], s.rect[3]) }
    }
    return b
  }
  function batches(entries) {
    const out = []
    let cur = [], size = 0
    for (const e of entries) {
      const n = JSON.stringify(e).length
      if (cur.length && size + n > ITEM_BYTES) { out.push(cur); cur = []; size = 0 }
      cur.push(e); size += n
    }
    if (cur.length) out.push(cur)
    return out
  }

  /**
   * The run on an environment:
   *   timelines(): [{ timeline_id, label }]     the old boards (the room board among them or not)
   *   items(timeline_id): its items              { envelope_number, sender_device_id, sender_sequence, content }
   *   headersOnly(timeline_id): n                records this device keeps without their body (opened by prepare)
   *   prepare(timeline_id)                       (real run) makes those readable before items()
   *   send(timeline_id, strokes), settle(), snapshot(timeline_id) -> { shapes, snapshot }
   * The room board stays as it is and gets its own first-format shapes; every other board goes right of it, in a row.
   */
  async function core(env, { dryRun = true, into = ROOM_BOARD, log = console.log } = {}) {
    const report = []
    const boards = (await env.timelines()).filter(b => b.timeline_id !== into)
    const order = [{ timeline_id: into, label: 'room board' }, ...boards]
    const there = new Set()
    let right = null
    for (const { timeline_id, label } of order) {
      if (!dryRun && (await env.headersOnly(timeline_id))) await env.prepare(timeline_id)
      const items = await env.items(timeline_id)
      const { shapes, stats } = reduceBoard(items)
      const own = timeline_id === into
      if (own) for (const it of items) for (const e of it.content?.content_type === 'strokes' ? it.content.strokes ?? [] : []) if (typeof e?.group === 'string' && e.group.startsWith('ff:')) there.add(e.group)
      // the room board's current-format shapes are on it already; everything else goes
      const moving = [...shapes.values()].filter(s => !own || s.first)
      let dx = 0
      const box = boxOf(own ? shapes.values() : moving)
      if (box) {
        if (!own && right != null) dx = Math.round(right + GAP - box[0])
        right = Math.max(right ?? -Infinity, box[2] + dx)
      }
      const entries = [], failures = []
      let skipped = 0
      for (const s of moving) {
        try {
          if (dx) shift(s, dx, 0)
          const e = entryOf(s)
          if (there.has(e.group)) { skipped++; continue }
          if (JSON.stringify(e).length > ITEM_BYTES) { failures.push(`${s.id}: too big for one item`); continue }
          entries.push(e)
        } catch (err) { failures.push(`${s.id}: ${err.message}`) }
      }
      const first = moving.filter(s => s.first).length
      const row = { board: label, timeline: timeline_id, items: items.length, first_format_items: stats.first_format_items, headers_unopened: await env.headersOnly(timeline_id),
        shapes_left: shapes.size, first_format_shapes: first, current_shapes_to_move: moving.length - first, erased: stats.erased, moved: stats.moved, pieces: stats.pieces,
        unreadable: stats.unreadable, unknown_colours: stats.unknown_colours, already_migrated: skipped, to_write: entries.length, shift_x: dx, failures: failures.length, items_written: 0 }
      if (failures.length) log('failures', timeline_id, failures)
      if (!dryRun && entries.length) {
        for (const part of batches(entries)) { await env.send(into, part); row.items_written++ }
        for (const e of entries) there.add(e.group)
      }
      if (row.items || row.headers_unopened || own) report.push(row)
    }
    if (!dryRun && report.some(r => r.items_written)) {
      await env.settle()
      log('snapshot', into, await env.snapshot(into))
    }
    return report
  }

  // ---- the browser: the app's own client (its worker holds the keys) and its IndexedDB cache ----
  /** whiteboard.mjs deskCanvas as it was: a desk id folded into desk/<32 hex>. */
  function deskCanvas(desk) {
    const id = String(desk || 'main')
    if (/^[0-9a-f]{32}$/.test(id)) return `desk/${id}`
    const bytes = new TextEncoder().encode(id), out = new Uint8Array(16)
    bytes.forEach((v, i) => { out[i % 16] ^= v })
    out[15] ^= bytes.length & 0xff
    return `desk/${[...out].map(b => b.toString(16).padStart(2, '0')).join('')}`
  }
  const req = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
  async function browserEnv() {
    const t = globalThis.trommi
    if (!t?.client?.loadTimelineAfter) throw new Error('open https://app.trommi.com signed in, then run this in its console')
    const client = t.client, m = t.model()
    const db = await req(indexedDB.open('trommi', 1))
    const P = 'room/'
    const store = mode => db.transaction('kv', mode).objectStore('kv')
    const range = async prefix => {
      const s = store('readonly'), k = IDBKeyRange.bound(P + prefix, P + prefix + '￿')
      const [keys, values] = await Promise.all([req(s.getAllKeys(k)), req(s.getAll(k))])
      return keys.map((key, i) => [key.slice(P.length), values[i]])
    }
    // the old boards: every desk's, the default one's, the old All board's, and any this device keeps
    const boards = new Map()
    for (const d of m.desks ?? []) boards.set(deskCanvas(d.id), `desk ${d.name ?? d.id}`)
    boards.set(deskCanvas('main'), boards.get(deskCanvas('main')) ?? 'desk main')
    boards.set(deskCanvas('all'), 'old "All" board')
    for (const pre of ['tl/canvas:desk/', 'tl/scribble:desk/']) for (const [k] of await range(pre)) { const id = 'desk/' + k.slice(pre.length).split('/')[0]; if (!boards.has(id)) boards.set(id, 'kept on this device') }
    const legacy = async tid => (await range(`tl/canvas:${tid}/`)).map(([, v]) => v)
    const keyOf = (tid, n) => `${P}tl/scribble:${tid}/${String(n).padStart(12, '0')}`
    const cache = new Map()
    return {
      async timelines() { return [...boards].map(([timeline_id, label]) => ({ timeline_id, label })) },
      async items(tid) {
        if (cache.has(tid)) return cache.get(tid)
        const byN = new Map()
        // records verified before 0e50a99 are kept under tl/canvas:<id>; the client reads only tl/scribble:<id>
        for (const r of await legacy(tid)) if (r?.c) byN.set(r.n, { envelope_number: r.n, sender_device_id: r.s, sender_sequence: r.q, content: r.c })
        for (const it of (await client.loadTimelineAfter(`scribble:${tid}`, 0)).items ?? []) if (it.content) byN.set(it.envelope_number, it)
        const out = [...byN.values()]
        cache.set(tid, out)
        return out
      },
      async headersOnly(tid) {
        let n = 0
        for (const r of await legacy(tid)) if (!r?.c && !(await req(store('readonly').get(keyOf(tid, r.n))))?.c) n++
        return n
      },
      // the same verified record under the current key, so that the client opens its body (a local cache copy only)
      async prepare(tid) {
        cache.delete(tid)
        const s = store('readwrite')
        for (const [k, v] of await range(`tl/canvas:${tid}/`)) { const to = P + k.replace('tl/canvas:', 'tl/scribble:'); if (!(await req(s.get(to)))) s.put(v, to) }
        await new Promise((resolve, reject) => { s.transaction.oncomplete = resolve; s.transaction.onerror = () => reject(s.transaction.error) })
      },
      send: (tid, strokes) => client.sendStrokes({ timeline_id: tid, content_type: 'strokes', strokes }),
      settle: () => client.settle(),
      async snapshot(tid) {
        const wb = await t.view('whiteboard')
        const c = await wb.openCanvas({ client, timeline_id: tid })
        try {
          const before = client.model.human?.scribble_snapshots?.get(tid)?.last_envelope_number ?? 0
          await c.snapshotNow()
          for (let i = 0; i < 100 && (client.model.human?.scribble_snapshots?.get(tid)?.last_envelope_number ?? 0) <= before; i++) await new Promise(r => setTimeout(r, 100))
          return { shapes: c.count(), snapshot_last_envelope_number: client.model.human?.scribble_snapshots?.get(tid)?.last_envelope_number ?? null }
        } finally { c.close() }
      },
    }
  }

  /** dryRun: counts only, nothing is sent and nothing is stored. */
  async function trommiMigrateScribble({ dryRun = true } = {}) {
    const env = await browserEnv()
    console.log(`Scribble Board migration onto the room board ${ROOM_BOARD}: ${dryRun ? 'DRY RUN, nothing is written' : 'REAL RUN'}`)
    const report = await core(env, { dryRun })
    console.table(report)
    return report
  }
  Object.assign(trommiMigrateScribble, { core, ROOM_BOARD, lib: { packPoints, unpackPoints, decodePoints, decodePressure, reduceBoard, entryOf, boxOf, batches, forceOf, deskCanvas } })
  globalThis.trommiMigrateScribble = trommiMigrateScribble
})()
