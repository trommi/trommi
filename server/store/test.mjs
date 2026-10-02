// node server/store/test.mjs
// Tests for store.mjs and migrate.mjs. Everything is written into a fresh temporary directory; the repo's
// data/ is never opened. STORE_BENCH=0 skips the benchmark, STORE_BENCH_DIR puts its files on another disk
// (the default temporary directory is often a RAM disk, where fsync costs nothing).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { Store, StoreError, SCHEMA_VERSION, DAY, ENC_SEALED, QUEUE_MAX } from './store.mjs'
import { readState, normalise, importState, verify, queueOf } from './migrate.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SELF = fileURLToPath(import.meta.url)
const REPO = path.join(HERE, '..', '..')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ---- child processes: a writer that is killed, and one that stops in the middle of a transaction ----------

const BATCH = 20
if (process.argv[2] === '--writer') {
  const [file, ack, mode] = process.argv.slice(3)
  const store = new Store(file, { synchronous: mode === 'fast' ? 'NORMAL' : 'FULL' })
  store.upsertSession({ id: 'w', profile: { name: 'Writer' } })
  const open = [], decided = []
  let seed = process.pid
  const rnd = n => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >>> 8) % n
  for (let b = 0; ; b++) {
    // One commit that touches the log, a view and the queue: after a kill, all of it is there or none of it.
    store.tx(() => {
      for (let i = 0; i < BATCH; i++) store.append({ sender: 'w', type: 'bulk', ref: `${process.pid}-${b}`, body: { i, pad: 'x'.repeat(100) } })
      const kind = rnd(5) === 0 ? 'permission' : 'decision'
      open.push(store.askCard({ session: 'w', kind, requestId: kind === 'permission' ? `${process.pid}-${b}` : undefined, body: { kind, title: `q${b}`, options: [{ key: 'a' }, { key: 'b' }] } }).card)
      store.postMessage({ session: 'w', from: 'agent', body: { text: `batch ${b}` } })
    })
    if (open.length > 3) {
      const card = open.splice(rnd(open.length), 1)[0]
      const what = rnd(4)
      if (card.kind === 'permission') what < 2 ? store.answerCard({ id: card.id, choice: 'a' }) : store.expireCard({ id: card.id })
      else if (what === 0) store.withdrawCard({ id: card.id, by: 'w' })
      else {
        store.answerCard({ id: card.id, choice: 'b', deliver: { method: 'notify', params: { card: card.id } } })
        decided.push(card)
      }
    }
    if (decided.length > 2) {
      const card = decided.shift()
      if (rnd(3) === 0) { store.reopenCard({ id: card.id }); open.push(card) } else store.closeCard({ id: card.id, by: 'w', summary: 'ok' })
    }
    fs.appendFileSync(ack, `${store.cursor()}\n`)
  }
}
if (process.argv[2] === '--stall') {
  const [file, ack] = process.argv.slice(3)
  const store = new Store(file)
  store.upsertSession({ id: 'w', profile: { name: 'Writer' } })
  store.append({ sender: 'w', type: 'bulk', ref: 'committed', body: {} })
  store.tx(() => {
    for (let i = 0; i < BATCH; i++) store.append({ sender: 'w', type: 'bulk', ref: 'never-committed', body: { i } })
    store.askCard({ session: 'w', id: 'half', body: { title: 'half' } })
    fs.appendFileSync(ack, `mid ${store.cursor()}\n`)
    // Hold the transaction open until the parent kills this process.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000)
  })
}

// ---- harness ---------------------------------------------------------------------------------------------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'trommi-store-'))
let fileNo = 0
const dbFile = (name = 'db') => path.join(TMP, `${name}-${++fileNo}.db`)
let passed = 0
const results = []
async function test(name, fn) {
  const started = performance.now()
  try {
    await fn()
    passed++
    console.log(`ok   ${name} (${Math.round(performance.now() - started)} ms)`)
  } catch (err) {
    results.push(name)
    console.log(`FAIL ${name}\n${err.stack}`)
  }
}
const refused = (fn, code, what) => assert.throws(fn, err => err instanceof StoreError && err.code === code, what ?? `expected to be refused as ${code}`)
// A store with a clock the test moves, and one session.
function fresh({ file = ':memory:', at = 1_800_000_000_000, sessions = ['a'], ...options } = {}) {
  const clock = { t: at }
  const store = new Store(file, { now: () => clock.t++, ...options })
  for (const id of sessions) store.upsertSession({ id, profile: { name: id.toUpperCase() } })
  return { store, clock }
}
const ask = (store, session, fields = {}) => store.askCard({
  session, body: { kind: fields.kind ?? 'decision', title: fields.title ?? 'q', options: [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }] }, ...fields,
}).card

// The cards as the log alone says they are, up to a cursor: the check that the view was kept in step.
function replay(store, upTo = Infinity) {
  const cards = new Map()
  for (let cursor = 0, more = true; more;) {
    const page = store.eventsAfter(cursor, { limit: 1000 })
    for (const e of page.events) {
      if (e.seq > upTo) return cards
      if (!e.cardId || !e.type.startsWith('card.')) continue
      const c = cards.get(e.cardId) ?? {}
      // a purged event has lost its content; its header still names the status
      if (e.purged) Object.assign(c, { status: e.cardStatus, kind: c.kind ?? 'unknown' })
      else if (e.type === 'card.asked') Object.assign(c, { status: 'open', kind: e.body.kind ?? 'decision' })
      else if (e.type === 'card.answered') c.status = c.kind === 'permission' ? 'done' : 'decided'
      else if (e.type === 'card.reopened') c.status = 'open'
      else if (['card.closed', 'card.withdrawn', 'card.expired'].includes(e.type)) c.status = 'done'
      assert.equal(e.cardStatus, c.status, `the header of event ${e.seq} names the card's status`)
      cards.set(e.cardId, c)
    }
    ;({ cursor, more } = page)
  }
  return cards
}
const openIn = cards => [...cards].filter(([, c]) => c.status === 'open').map(([id]) => id).sort()
function assertViewMatchesLog(store) {
  const fromLog = replay(store)
  const rows = store.q('SELECT id, status FROM cards ORDER BY id').all()
  assert.deepEqual(rows.map(r => [r.id, r.status]), [...fromLog].map(([id, c]) => [id, c.status]).sort((x, y) => (x[0] < y[0] ? -1 : 1)), 'the cards view is what the log says')
}

// ---- schema ----------------------------------------------------------------------------------------------

await test('schema: a fresh database is at the current version, in WAL mode, with foreign keys on', () => {
  const file = dbFile()
  const store = new Store(file)
  assert.equal(store.version, SCHEMA_VERSION)
  assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
  assert.equal(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
  assert.equal(store.db.prepare('PRAGMA synchronous').get().synchronous, 2, 'FULL by default')
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name)
  assert.deepEqual(tables, ['admin_log', 'blobs', 'canvases', 'cards', 'deliveries', 'devices', 'event_blobs', 'events', 'invites', 'member_log',
    'messages', 'meta', 'pad_elements', 'pad_links', 'pads', 'senders', 'sessions', 'status_lines', 'wrapped_keys'])
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  // the foreign keys are enforced, not only declared
  assert.throws(() => store.db.exec("INSERT INTO cards (id, session, number, kind, status, created, ask_seq, last_seq) VALUES ('x', 'nobody', 1, 'decision', 'open', 1, 1, 1)"), /FOREIGN KEY/)
  store.close()
  // opening again changes nothing
  const again = new Store(file)
  assert.equal(again.version, SCHEMA_VERSION)
  assert.equal(again.meta('next_number'), 1)
  again.close()
})

await test('schema: a database at version 1 is migrated in steps and keeps its data', () => {
  const file = dbFile()
  const v1 = new Store(file, { targetVersion: 1 })
  assert.equal(v1.version, 1)
  v1.upsertSession({ id: 'a', profile: { name: 'A' } })
  const card = ask(v1, 'a', { title: 'kept?' })
  v1.postMessage({ session: 'a', from: 'user', id: 'm1', body: { text: 'hello' } })
  v1.enqueue('a', 'notify', { n: 1 })
  assert.equal(v1.purge().cards, 0, 'purge works without the pad tables')
  assert.throws(() => v1.putElement({ type: 'text', author: 'me', data: {} }), /no such table/)
  const cursor = v1.cursor()
  v1.close()

  const v2 = new Store(file, { targetVersion: 2 })
  assert.equal(v2.version, 2)
  v2.putElement({ id: 'e1', type: 'text', author: 'me', data: { text: 'on v2' } })
  assert.throws(() => v2.memberLog(), /no such table/)
  v2.close()

  const now = new Store(file)
  assert.equal(now.version, SCHEMA_VERSION)
  assert.equal(now.card(card.id).ask.title, 'kept?')
  assert.equal(now.messages('a')[0].body.text, 'hello')
  assert.equal(now.queued('a'), 1)
  assert.equal(now.element('e1').data.text, 'on v2')
  assert.equal(now.cursor(), cursor + 1)
  assert.deepEqual(now.memberLog(), [])
  now.close()

  // a database from the future is refused, not guessed at
  const raw = new DatabaseSync(file)
  raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
  raw.close()
  refused(() => new Store(file), 'conflict')
  const untouched = new DatabaseSync(file)
  assert.equal(untouched.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION + 1)
  untouched.close()
})

// ---- the log ---------------------------------------------------------------------------------------------

await test('append: idempotent on the client id, numbered per sender', () => {
  const { store } = fresh({ sessions: ['a', 'b'] })
  const base = store.cursor()
  const first = store.append({ sender: 'phone', clientId: 'c-1', type: 'note', session: 'a', body: { text: 'once' } })
  assert.deepEqual([first.seq, first.senderSeq, first.duplicate], [base + 1, 1, false])
  const again = store.append({ sender: 'phone', clientId: 'c-1', type: 'note', session: 'a', body: { text: 'different text, same id' } })
  assert.deepEqual([again.seq, again.senderSeq, again.duplicate], [first.seq, 1, true])
  assert.equal(store.cursor(), base + 1, 'the repeat wrote nothing')
  assert.equal(store.event(first.seq).body.text, 'once', 'and changed nothing')
  // the same client id from another sender is another event
  const other = store.append({ sender: 'laptop', clientId: 'c-1', type: 'note', body: {} })
  assert.deepEqual([other.seq, other.senderSeq, other.duplicate], [base + 2, 1, false])
  // per-sender numbers continue; a sender that numbers itself must not skip or repeat
  assert.equal(store.append({ sender: 'phone', type: 'note', body: {} }).senderSeq, 2)
  assert.equal(store.append({ sender: 'phone', type: 'note', senderSeq: 3, body: {} }).senderSeq, 3)
  refused(() => store.append({ sender: 'phone', type: 'note', senderSeq: 3, body: {} }), 'conflict', 'a replayed number')
  refused(() => store.append({ sender: 'phone', type: 'note', senderSeq: 9, body: {} }), 'conflict', 'a gap')
  refused(() => store.append({ sender: 'phone', type: 'note', session: 'nobody', body: {} }), 'not_found')
  refused(() => store.append({ sender: 'phone', type: 'card.answered', body: {} }), 'invalid', 'types with a view go through their method')
  refused(() => store.append({ type: 'note' }), 'invalid')
  assert.equal(store.cursor(), base + 4, 'refused appends leave no row')
  // opaque bytes go in and come out untouched, with their hash
  const sealed = crypto.randomBytes(300)
  const e = store.event(store.append({ sender: 'phone', type: 'note', payload: sealed, epoch: 2 }).seq)
  assert.ok(Buffer.from(e.payload).equals(sealed))
  assert.deepEqual([e.enc, e.epoch, e.size, e.body], [ENC_SEALED, 2, 300, undefined])
  assert.ok(Buffer.from(e.hash).equals(crypto.createHash('sha256').update(sealed).digest()))
  // appendMany commits together: one bad entry, none written
  const before = store.cursor()
  refused(() => store.appendMany([{ sender: 'x', type: 'note', body: 1 }, { sender: 'x', type: 'note', session: 'nobody' }]), 'not_found')
  assert.equal(store.cursor(), before)
  assert.equal(store.q('SELECT COUNT(*) AS n FROM senders WHERE id = ?').get('x').n, 0)
})

await test('cursor: paging with a limit, and resuming after a gap', () => {
  const { store } = fresh({ sessions: ['a', 'b'] })
  const base = store.cursor()
  store.appendMany(Array.from({ length: 2500 }, (_, i) => ({ sender: i % 2 ? 'a' : 'b', type: 'note', session: i % 2 ? 'a' : 'b', body: { i } })))
  // page through everything
  const seen = []
  let cursor = 0, pages = 0, more = true
  while (more) {
    const page = store.eventsAfter(cursor, { limit: 1000 })
    assert.ok(page.events.length <= 1000)
    seen.push(...page.events.map(e => e.seq))
    ;({ cursor, more } = page)
    pages++
  }
  assert.equal(pages, 3)
  assert.deepEqual(seen, Array.from({ length: base + 2500 }, (_, i) => i + 1), 'every seq once, in order, no holes')
  assert.equal(cursor, store.cursor())
  // no read is unbounded: an absurd limit is cut down, a missing one has a default
  assert.equal(store.eventsAfter(0, { limit: 1e9 }).events.length, 1000)
  assert.equal(store.eventsAfter(0).events.length, 200)
  // a client that was away: it holds a cursor, more arrives, it gets exactly what it missed
  const held = cursor
  store.appendMany(Array.from({ length: 300 }, (_, i) => ({ sender: 'a', type: 'note', session: 'a', body: { late: i } })))
  const caught = store.eventsAfter(held, { limit: 1000 })
  assert.deepEqual([caught.events.length, caught.events[0].seq, caught.events.at(-1).seq, caught.more], [300, held + 1, held + 300, false])
  assert.deepEqual(store.eventsAfter(caught.cursor), { events: [], cursor: caught.cursor, more: false }, 'up to date: nothing, same cursor')
  // one conversation only
  const mine = store.eventsAfter(0, { session: 'b', limit: 1000 })
  assert.ok(mine.events.every(e => e.session === 'b') && mine.events.length === 1000 && mine.more)
  // a gap in one sender's chain is filled by that sender's numbers
  const fill = store.eventsFrom('a', 1240, { limit: 20 })
  assert.deepEqual(fill.events.map(e => e.senderSeq), Array.from({ length: 20 }, (_, i) => 1241 + i))
  assert.ok(fill.events.every(e => e.sender === 'a') && fill.more)
  // scrolling back in a conversation
  const back = store.eventsBefore('a', null, { limit: 5 })
  assert.deepEqual(back.events.map(e => e.body.late), [299, 298, 297, 296, 295])
  assert.deepEqual(store.eventsBefore('a', back.cursor, { limit: 2 }).events.map(e => e.body.late), [294, 293])
})

// ---- cards -----------------------------------------------------------------------------------------------

await test('cards: every transition, and every illegal one refused without a trace', () => {
  const { store } = fresh({ sessions: ['a', 'b'] })
  // a refused step writes no event and leaves the card as it was
  const untouched = (fn, code) => {
    const before = [store.cursor(), JSON.stringify(store.q('SELECT * FROM cards ORDER BY id').all()), store.q('SELECT COUNT(*) AS n FROM deliveries').get().n]
    refused(fn, code)
    assert.deepEqual([store.cursor(), JSON.stringify(store.q('SELECT * FROM cards ORDER BY id').all()), store.q('SELECT COUNT(*) AS n FROM deliveries').get().n], before)
  }

  // ask
  const c1 = ask(store, 'a', { title: 'first' })
  assert.deepEqual([c1.number, c1.status, c1.urgency, c1.kind, c1.ask.title], [1, 'open', 'normal', 'decision', 'first'])
  const c2 = ask(store, 'a', { title: 'urgent', urgency: 'high' })
  const c3 = ask(store, 'b', { title: 'whenever', urgency: 'low' })
  const perm = store.askCard({ session: 'b', kind: 'permission', requestId: 'r1', urgency: 'low', body: { kind: 'permission', title: 'Approval: Bash', options: [{ key: 'allow' }, { key: 'deny' }] } }).card
  assert.deepEqual([perm.urgency, perm.number], ['critical', 4], 'an approval is always critical')
  assert.deepEqual(store.snapshot().queue, [perm.id, c2.id, c1.id, c3.id], 'approvals first, then urgency, then oldest')
  // the same approval request again makes no second card
  const repeat = store.askCard({ session: 'b', kind: 'permission', requestId: 'r1', body: { kind: 'permission' } })
  assert.deepEqual([repeat.duplicate, repeat.card.id], [true, perm.id])
  untouched(() => ask(store, 'a', { id: c1.id }), 'conflict')
  untouched(() => ask(store, 'nobody'), 'not_found')
  untouched(() => ask(store, 'a', { urgency: 'asap' }), 'invalid')
  untouched(() => ask(store, 'a', { kind: 'poll' }), 'invalid')
  assert.equal(store.meta('next_number'), 5, 'a refused card uses no number')

  // set urgency
  assert.equal(store.setUrgency({ id: c3.id, by: 'b', urgency: 'critical', reason: 'now blocking' }).card.urgency, 'critical')
  assert.deepEqual(store.snapshot().queue, [perm.id, c3.id, c2.id, c1.id])
  assert.equal(store.card(c3.id).urgencyNote.reason, 'now blocking')
  untouched(() => store.setUrgency({ id: c3.id, by: 'b', urgency: 'soon' }), 'invalid')
  untouched(() => store.setUrgency({ id: c3.id, by: 'a', urgency: 'low' }), 'not_found')   // not a's card
  untouched(() => store.setUrgency({ id: perm.id, by: 'b', urgency: 'low' }), 'illegal')
  untouched(() => store.setUrgency({ id: 'nope', urgency: 'low' }), 'not_found')

  // answer
  store.setStatus({ session: 'a', id: 'deploy', label: 'Deploy', state: 'decision', cardId: c1.id })
  untouched(() => store.answerCard({ id: c1.id, choice: 'maybe' }), 'invalid')   // not an option
  untouched(() => store.answerCard({ id: 'nope', choice: 'yes' }), 'not_found')
  const answered = store.answerCard({ id: c1.id, choice: 'yes', note: 'after lunch', clientId: 'tap-1', deliver: { method: 'notifications/claude/channel', params: { meta: { kind: 'decision', card_id: c1.id, choice: 'yes' } } } })
  assert.deepEqual([answered.card.status, answered.card.answer, answered.card.answeredAt], ['decided', { choice: 'yes', note: 'after lunch' }, answered.created])
  assert.deepEqual(store.statusLines({ session: 'a' }).map(t => [t.id, t.state, t.cardId]), [['deploy', 'working', null]], 'the line that waited on the card moves on')
  assert.equal(store.handOver('a')[0].params.meta.choice, 'yes', 'the notification was queued with the answer')
  // the tap is sent twice (a retry after a lost response): same result, no second event, no error
  const retry = store.answerCard({ id: c1.id, choice: 'no', clientId: 'tap-1' })
  assert.deepEqual([retry.duplicate, retry.seq, retry.card.answer.choice, store.queued('a')], [true, answered.seq, 'yes', 1])
  untouched(() => store.answerCard({ id: c1.id, choice: 'no' }), 'illegal')   // already decided
  untouched(() => store.setUrgency({ id: c1.id, by: 'a', urgency: 'low' }), 'illegal')   // only open cards
  untouched(() => store.withdrawCard({ id: c1.id, by: 'a' }), 'illegal')   // the human spent an answer on it

  // reopen
  untouched(() => store.reopenCard({ id: c2.id }), 'illegal')   // is open
  untouched(() => store.reopenCard({ id: perm.id }), 'illegal')   // approvals are not reopened
  const reopened = store.reopenCard({ id: c1.id, deliver: out => ({ method: 'notify', params: { previous: out.card.id } }) })
  assert.deepEqual([reopened.card.status, reopened.card.answeredAt, reopened.card.answer, reopened.previous.choice], ['open', null, undefined, 'yes'])
  assert.equal(store.event(reopened.seq).body.previous_choice, 'yes')
  assert.equal(store.queued('a'), 2)

  // close
  store.answerCard({ id: c1.id, choice: 'no' })
  untouched(() => store.closeCard({ id: c1.id, by: 'b', summary: 'not mine' }), 'not_found')
  const closed = store.closeCard({ id: c1.id, by: 'a', summary: 'done as asked' })
  assert.deepEqual([closed.card.status, closed.card.closedAs, closed.card.close.summary, closed.card.answer.choice], ['done', 'closed', 'done as asked', 'no'])
  untouched(() => store.answerCard({ id: c1.id, choice: 'yes' }), 'illegal')   // done
  untouched(() => store.withdrawCard({ id: c1.id, by: 'a' }), 'illegal')   // done
  // a closed card that had an answer can still be taken back, as today
  assert.equal(store.reopenCard({ id: c1.id }).card.status, 'open')
  // an open decision may be closed by its agent, as server.mjs allows; it was never answered, so no reopening
  assert.deepEqual([store.closeCard({ id: c1.id, by: 'a', summary: 'moot' }).card.status, store.card(c1.id).answeredAt], ['done', null])
  untouched(() => store.reopenCard({ id: c1.id }), 'illegal')

  // withdraw
  const withdrawn = store.withdrawCard({ id: c2.id, by: 'a', reason: 'staging answered it' })
  assert.deepEqual([withdrawn.card.status, withdrawn.card.closedAs, withdrawn.card.close.reason], ['done', 'withdrawn', 'staging answered it'])
  untouched(() => store.withdrawCard({ id: c2.id, by: 'a' }), 'illegal')   // already done
  untouched(() => store.reopenCard({ id: c2.id }), 'illegal')   // withdrawn, never answered
  untouched(() => store.withdrawCard({ id: perm.id, by: 'b' }), 'illegal')

  // approvals: only the human answers, and the answer finishes the card
  untouched(() => store.closeCard({ id: perm.id, by: 'b' }), 'illegal')
  untouched(() => store.expireCard({ id: c3.id }), 'illegal')   // not an approval
  const allowed = store.answerCard({ id: perm.id, choice: 'allow' })
  assert.deepEqual([allowed.card.status, allowed.card.closedAs], ['done', 'answered'])
  untouched(() => store.expireCard({ id: perm.id }), 'illegal')
  // approvals that are open when the session's link drops end with it
  const p2 = store.askCard({ session: 'b', kind: 'permission', requestId: 'r2', body: { kind: 'permission' } }).card
  const p3 = store.askCard({ session: 'b', kind: 'permission', requestId: 'r3', body: { kind: 'permission' } }).card
  assert.equal(store.expirePermissions('b'), 2)
  assert.deepEqual([p2, p3].map(p => [store.card(p.id).status, store.card(p.id).closedAs]), [['done', 'expired'], ['done', 'expired']])
  assert.equal(store.expirePermissions('b'), 0)
  // a request id may come again once the first card is done
  assert.equal(store.askCard({ session: 'b', kind: 'permission', requestId: 'r2', body: { kind: 'permission' } }).duplicate, false)

  // what is left, and that view and log agree
  assert.deepEqual(store.snapshot().counts.cards, { open: 2, decided: 0, done: 5 })
  assertViewMatchesLog(store)
  assert.deepEqual(store.cards({ session: 'a' }).map(c => c.number), [2, 1])
  assert.deepEqual(store.cards({ status: 'open', limit: 1 }).map(c => c.number), [7])
  // a multi-step change is one commit: if the last step fails, the first is undone
  refused(() => store.tx(() => {
    store.answerCard({ id: c3.id, choice: 'yes' })
    store.closeCard({ id: c3.id, by: 'a' })   // not a's card
  }), 'not_found')
  assert.equal(store.card(c3.id).status, 'open')
})

await test('cards: a question whose content is ciphertext still moves through its states', () => {
  const { store } = fresh()
  const sealed = crypto.randomBytes(120)
  const { card } = store.askCard({ session: 'a', urgency: null, payload: sealed })
  assert.deepEqual([card.urgency, card.ask, Buffer.from(card.askPayload).equals(sealed)], [null, undefined, true])
  // the store cannot see the options, so it does not judge the choice; status and answer time stay readable
  const out = store.answerCard({ id: card.id, payload: crypto.randomBytes(60) })
  const header = store.event(out.seq)
  assert.deepEqual([out.card.status, header.cardStatus, header.answeredAt, header.body], ['decided', 'decided', out.created, undefined])
  assert.equal(store.reopenCard({ id: card.id }).previous, null, 'the previous choice is the client\'s to read')
})

// ---- messages, status lines, sessions --------------------------------------------------------------------

await test('messages, status lines and sessions', () => {
  const { store } = fresh({ sessions: ['a', 'b'] })
  // sessions: a change is an event, presence is not, an unchanged profile writes nothing
  const before = store.cursor()
  assert.equal(store.upsertSession({ id: 'a', profile: { name: 'A' } }).changed, false)
  store.setPresence('a', true, { instance: 'i1' })
  assert.equal(store.cursor(), before)
  assert.deepEqual(store.upsertSession({ id: 'a', profile: { model: 'Opus', task: 'storage' } }).changed, true)
  assert.deepEqual([store.session('a').profile, store.session('a').online, store.session('a').instance], [{ name: 'A', model: 'Opus', task: 'storage' }, true, 'i1'])
  assert.deepEqual(store.event(store.cursor()).type, 'session.updated')
  store.upsertSession({ id: 'b', archived: true })
  refused(() => store.setPresence('nobody', true), 'not_found')

  // messages
  for (let i = 0; i < 5; i++) store.postMessage({ session: 'a', from: i % 2 ? 'agent' : 'user', id: `m${i}`, body: { text: `t${i}` }, clientId: `k${i}` })
  assert.equal(store.postMessage({ session: 'a', from: 'user', body: { text: 'again' }, clientId: 'k0' }).id, 'm0', 'a retry returns the first message')
  refused(() => store.postMessage({ session: 'a', from: 'user', id: 'm0', body: {} }), 'conflict')
  refused(() => store.postMessage({ session: 'a', from: 'robot', body: {} }), 'invalid')
  refused(() => store.postMessage({ session: 'nobody', from: 'user', body: {} }), 'not_found')
  assert.deepEqual(store.messages('a', { limit: 2 }).map(m => [m.id, m.from, m.body.text]), [['m4', 'user', 't4'], ['m3', 'agent', 't3']])
  assert.deepEqual(store.messages('a', { before: store.messages('a', { limit: 2 })[1].seq, limit: 10 }).map(m => m.id), ['m2', 'm1', 'm0'])
  assert.equal(store.session('a').messages, 5)
  assert.deepEqual(store.eventsAfter(0, { session: 'a' }).events.filter(e => e.type === 'message').map(e => e.sender), ['human', 'a', 'human', 'a', 'human'])
  // a message to a session that is away queues its notification in the same commit
  const sent = store.postMessage({ session: 'b', from: 'user', body: { text: 'are you there?' }, deliver: { method: 'notifications/claude/channel', params: { content: 'are you there?' } } })
  assert.deepEqual(store.handOver('b').map(d => [d.eventSeq, d.params.content]), [[sent.seq, 'are you there?']])

  // status lines
  const card = ask(store, 'a')
  refused(() => store.setStatus({ session: 'a', id: 'x', state: 'working' }), 'invalid', 'a new line needs a label')
  refused(() => store.setStatus({ session: 'a', id: 'x', label: 'X', state: 'blocked' }), 'invalid')
  refused(() => store.setStatus({ session: 'b', id: 'x', label: 'X', state: 'decision', cardId: card.id }), 'not_found', 'a line cannot point at another session\'s card')
  assert.equal(store.statusLines().length, 0, 'a refused call leaves no half-made line')
  store.setStatus({ session: 'a', id: 'x', label: 'Tests', state: 'working', detail: '1 of 3' })
  store.setStatus({ session: 'a', id: 'x', state: 'decision', cardId: card.id })
  store.setStatus({ session: 'a', id: 'y', label: 'Docs', state: 'done' })
  store.setStatus({ session: 'b', id: 'x', label: 'Other', state: 'working' })
  assert.deepEqual(store.statusLines({ session: 'a' }).map(t => [t.id, t.label, t.detail, t.state, t.cardId]), [['x', 'Tests', '1 of 3', 'decision', card.id], ['y', 'Docs', '', 'done', null]])
  store.setStatus({ session: 'a', id: 'x', state: 'working' })
  assert.equal(store.statusLines({ session: 'a' }).find(t => t.id === 'x').cardId, null, 'only a waiting line points at a card')
  assert.equal(store.clearStatus({ session: 'a', id: 'y' }).removed, 1)
  assert.equal(store.clearStatus({ session: 'a' }).removed, 1)
  assert.deepEqual(store.statusLines().map(t => [t.session, t.id]), [['b', 'x']])

  // the snapshot: an archived session's questions stay open but leave the stack
  const shelved = ask(store, 'b')
  const snap = store.snapshot()
  assert.deepEqual([snap.cards.map(c => c.id).sort(), snap.queue], [[card.id, shelved.id].sort(), [card.id]])
  assert.deepEqual([snap.cursor, snap.counts.events, snap.counts.messages, snap.counts.queued, snap.truncated], [store.cursor(), store.cursor(), { a: 5, b: 1 }, { b: 1 }, false])
  assert.equal(store.snapshot({ cards: 1 }).truncated, true, 'a cut-off snapshot says so')
})

await test('sessions: forgetting one, with and without its data', () => {
  const { store } = fresh({ sessions: ['gone', 'kept', 'stays'] })
  for (const id of ['gone', 'kept']) {
    store.registerBlob({ id: `files/${id}.png`, kind: 'attachment', path: `files/${id}.png`, size: 10, session: id })
    store.postMessage({ session: id, from: 'agent', id: `msg-${id}`, body: { text: 'secret plan' }, blobs: [`files/${id}.png`] })
    ask(store, id, { id: `card-${id}` })
    store.setStatus({ session: id, id: 't', label: 'T', state: 'working' })
    store.enqueue(id, 'notify', {})
  }
  store.setPresence('gone', true)
  refused(() => store.forgetSession('gone', { data: true }), 'conflict', 'a session that is online is not forgotten')
  store.setPresence('gone', false)
  const cursor = store.cursor()
  const out = store.forgetSession('gone', { data: true })
  assert.deepEqual([out.messages, out.cards, out.files], [1, 1, [{ id: 'files/gone.png', kind: 'attachment', path: 'files/gone.png', size: 10 }]])
  assert.deepEqual([store.session('gone'), store.card('card-gone'), store.messages('gone').length, store.queued('gone'), store.statusLines({ session: 'gone' }).length], [null, null, 0, 0, 0])
  // the log keeps its numbering; the content is gone
  const left = store.eventsAfter(0, { session: 'gone' }).events
  assert.ok(left.length >= 3 && left.every(e => e.purged && e.payload === null && e.hash))
  assert.equal(store.cursor(), cursor + 1)
  assert.ok(!JSON.stringify([...store.exportRows()]).includes('secret plan') || store.messages('kept')[0].body.text === 'secret plan')
  // without data: the session leaves the board, its conversation stays
  const kept = store.forgetSession('kept')
  assert.deepEqual([kept.messages, kept.cards, kept.files, store.session('kept'), store.queued('kept')], [0, 0, [], null, 0])
  assert.equal(store.card('card-kept').status, 'open')
  assert.equal(store.messages('kept')[0].body.text, 'secret plan')
  assert.deepEqual(store.sessions().map(s => s.id), ['stays'])
  refused(() => store.forgetSession('kept'), 'not_found')
  // a session of the same name that comes back starts clean
  store.upsertSession({ id: 'gone', profile: { name: 'Back' } })
  assert.deepEqual([store.session('gone').profile, store.session('gone').messages], [{ name: 'Back' }, 0])
})

// ---- delivery queue --------------------------------------------------------------------------------------

await test('queue: survives closing and reopening the database, nothing is lost between hand-over and acknowledgement', () => {
  const file = dbFile()
  let { store } = fresh({ file })
  for (const n of [1, 2, 3]) store.enqueue('a', 'notifications/claude/channel', { content: `m${n}` })
  const handed = store.handOver('a', { limit: 2 })
  assert.deepEqual(handed.map(d => [d.params.content, d.attempts]), [['m1', 1], ['m2', 1]])
  assert.equal(store.queued('a'), 3, 'handed over is not delivered')
  store.close()

  store = new Store(file)
  assert.equal(store.queued('a'), 3)
  // what was handed over but never acknowledged comes again, in order, and says so
  const second = store.handOver('a')
  assert.deepEqual(second.map(d => [d.params.content, d.attempts]), [['m1', 2], ['m2', 2], ['m3', 1]])
  assert.equal(store.acknowledge(second.slice(0, 2).map(d => d.id)), 2)
  assert.equal(store.acknowledge(second[0].id), 0, 'acknowledging twice is harmless')
  store.close()

  store = new Store(file)
  assert.deepEqual(store.handOver('a').map(d => d.params.content), ['m3'])
  // a session that stays away keeps the newest QUEUE_MAX
  for (let n = 4; n <= QUEUE_MAX + 10; n++) store.enqueue('a', 'notify', { content: `m${n}` })
  const waiting = store.handOver('a', { limit: 1000 })
  assert.deepEqual([waiting.length, waiting[0].params.content, waiting.at(-1).params.content], [QUEUE_MAX, 'm11', `m${QUEUE_MAX + 10}`])
  // an enqueue with a key happens once
  const once = store.enqueue('a', 'notify', {}, { dedupe: 'k' })
  assert.deepEqual([store.enqueue('a', 'notify', {}, { dedupe: 'k' }), store.queued('a')], [{ id: once.id, duplicate: true }, QUEUE_MAX])
  refused(() => store.enqueue('nobody', 'notify', {}), 'not_found')
  refused(() => store.enqueue('a', '', {}), 'invalid')
  assert.equal(store.clearQueue('a'), QUEUE_MAX)
  store.close()
})

// ---- blobs, canvases -------------------------------------------------------------------------------------

await test('blobs and canvases: files by reference', () => {
  const { store } = fresh()
  const blob = store.registerBlob({ id: 'b1', kind: 'attachment', path: 'files/ab12.png', size: 2048, session: 'a', meta: { name: 'shot.png', kind: 'image' } })
  assert.deepEqual([blob.retention, blob.meta.name, blob.duplicate], ['refs', 'shot.png', false])
  assert.equal(store.registerBlob({ id: 'b1', kind: 'attachment', path: 'files/other.png' }).duplicate, true)
  refused(() => store.registerBlob({ id: 'b2', kind: 'attachment', path: 'files/ab12.png' }), 'conflict', 'one record per file')
  for (const bad of ['/etc/passwd', '../token', 'files/../token', 'files//x', '', 'files\\x']) refused(() => store.registerBlob({ id: 'x', kind: 'attachment', path: bad }), 'invalid', bad)
  refused(() => store.registerBlob({ id: 'x', kind: 'movie', path: 'files/x' }), 'invalid')
  refused(() => store.postMessage({ session: 'a', from: 'agent', body: {}, blobs: ['missing'] }), 'not_found')
  assert.equal(store.messages('a').length, 0, 'the message with the unknown file was not stored')
  // an asset: revoking it empties the message that carried its key
  const asset = store.registerBlob({ id: 'q3n0XWb1kq0lYb6m3v8K2A', kind: 'asset', path: 'assets/q3n0XWb1kq0lYb6m3v8K2A', size: 4096, session: 'a' })
  assert.equal(asset.retention, 'age')
  const shown = store.postMessage({ session: 'a', from: 'agent', body: { text: 'link', asset: { key: 'THE-KEY' } }, blobs: [asset.id] })
  refused(() => store.revokeBlob(asset.id, { by: 'someone-else' }), 'not_found')
  assert.deepEqual(store.revokeBlob(asset.id, { by: 'a' }), { id: asset.id, kind: 'asset', path: asset.path, size: 4096 })
  assert.deepEqual([store.event(shown.seq).purged, store.event(shown.seq).payload, store.messages('a')[0].purged], [true, null, true])
  assert.ok(!JSON.stringify([...store.exportRows()]).includes('THE-KEY'), 'the hub forgot the key with the asset')
  refused(() => store.revokeBlob(asset.id), 'not_found')
  assert.deepEqual(store.doomedFiles().map(f => f.id), [asset.id])
  assert.deepEqual([store.confirmDeleted([asset.id, 'b1']), store.blob(asset.id), store.blob('b1').id, store.doomedFiles()], [1, null, 'b1', []])
  assert.deepEqual(store.blobs({ kind: 'attachment' }).map(b => b.id), ['b1'])

  // canvas: the version only goes up
  store.registerBlob({ id: 'scribbles/canvas-a.json', kind: 'canvas', path: 'scribbles/canvas-a.json', size: 100, session: 'a' })
  assert.equal(store.saveCanvas({ session: 'a', doc: 'scribbles/canvas-a.json' }).version, 1)
  assert.equal(store.saveCanvas({ session: 'a', version: 5 }).version, 5)
  refused(() => store.saveCanvas({ session: 'a', version: 5 }), 'conflict')
  refused(() => store.saveCanvas({ session: 'a', version: 2 }), 'conflict', 'an older canvas never replaces a newer one')
  refused(() => store.saveCanvas({ session: 'a', doc: 'nope' }), 'not_found')
  assert.deepEqual([store.canvas('a').version, store.canvas('a').doc, store.canvas('nobody')], [5, 'scribbles/canvas-a.json', null])
})

// ---- retention -------------------------------------------------------------------------------------------

await test('purge: removes exactly what is past retention and leaves open cards', () => {
  const { store, clock } = fresh({ sessions: ['a', 'away'] })
  const now = clock.t
  const days = n => now - n * DAY
  const file = (name, at) => store.registerBlob({ id: `files/${name}`, kind: 'attachment', path: `files/${name}`, size: name.length, session: 'a', at }).id
  const card = (id, created, { answered, close, withdraw, blobs = [] } = {}) => {
    ask(store, 'a', { id, at: created, blobs })
    if (answered) store.answerCard({ id, choice: 'yes', at: answered })
    if (close) store.closeCard({ id, by: 'a', summary: 'did it', at: close })
    if (withdraw) store.withdrawCard({ id, by: 'a', at: withdraw })
  }
  file('old.png', days(40)); file('shared.png', days(40)); file('young.png', days(29)); file('open.png', days(90)); file('loose-old.png', days(31)); file('loose-new.png', days(2))
  card('old-done', days(40), { answered: days(31), close: days(31), blobs: ['files/old.png', 'files/shared.png'] })
  card('old-decided', days(60), { answered: days(30) - 1 })                       // answered a moment more than 30 days ago, never closed
  card('edge', days(60), { answered: days(30) })                                  // answered exactly 30 days ago: stays
  card('old-withdrawn', days(31), { withdraw: days(1) })                          // never answered: its age counts
  card('recent', days(40), { answered: days(29), close: days(29), blobs: ['files/young.png'] })
  card('old-open', days(90), { blobs: ['files/open.png', 'files/shared.png'] })   // open cards are never touched
  store.noteCard({ id: 'old-done', body: { kind: 'urgency', text: 'x' }, sender: 'import', at: days(35) })
  store.setStatus({ session: 'a', id: 'waits', label: 'Waits', state: 'decision', cardId: 'old-open' })
  store.setStatus({ session: 'a', id: 'stale', label: 'Stale', state: 'working' })
  store.q("UPDATE status_lines SET card_id = 'old-done' WHERE id = 'stale'").run()
  // assets
  const asset = (id, at, retention) => {
    store.registerBlob({ id, kind: 'asset', path: `assets/${id}`, size: 64, session: 'a', retention, at })
    return store.postMessage({ session: 'a', from: 'agent', id: `msg-${id}`, body: { text: 'link', asset: { key: `KEY-${id}` } }, blobs: [id], at }).seq
  }
  const [oldAsset, keptAsset, youngAsset] = [asset('asset-old', days(31)), asset('asset-keep', days(31), 'keep'), asset('asset-young', days(29))]
  // chat, old and new
  store.postMessage({ session: 'a', from: 'user', id: 'chat-old', body: { text: 'long ago' }, at: days(200) })
  store.postMessage({ session: 'a', from: 'user', id: 'chat-new', body: { text: 'yesterday' }, at: days(1) })
  // notifications for a session that never came back
  store.enqueue('away', 'notify', { n: 'old' }, { at: days(31) })
  store.enqueue('away', 'notify', { n: 'new' }, { at: days(29) })
  clock.t = now

  const events = store.cursor()
  const picture = () => JSON.stringify([store.q('SELECT * FROM cards ORDER BY id').all(), store.q('SELECT seq, purged_at, size FROM events').all(), store.q('SELECT * FROM blobs ORDER BY id').all(), store.q('SELECT * FROM deliveries').all(), store.q('SELECT * FROM status_lines').all()])
  const before = picture()
  const expected = { cutoff: days(30), cards: 3, events: 9, messages: 0, deliveries: 1, assets: 1, elements: 0, more: false }
  const files = [{ id: 'asset-old', kind: 'asset', path: 'assets/asset-old', size: 64 }, { id: 'files/loose-old.png', kind: 'attachment', path: 'files/loose-old.png', size: 13 }, { id: 'files/old.png', kind: 'attachment', path: 'files/old.png', size: 7 }]

  // the preview: the same numbers, nothing changed
  assert.deepEqual(store.purge({ dryRun: true, at: now }), { ...expected, files })
  assert.equal(picture(), before)

  assert.deepEqual(store.purge({ at: now }), { ...expected, files })
  assert.deepEqual(store.q('SELECT id FROM cards ORDER BY id').all().map(r => r.id), ['edge', 'old-open', 'recent'])
  assert.equal(store.card('old-open').status, 'open')
  // the log keeps every header; the purged cards' events have lost their content, the others not
  assert.equal(store.cursor(), events)
  const byCard = id => store.q('SELECT type, payload, purged_at, hash FROM events WHERE card_id = ? ORDER BY seq').all(id)
  for (const id of ['old-done', 'old-decided', 'old-withdrawn']) assert.ok(byCard(id).filter(e => e.type.startsWith('card.')).every(e => e.payload === null && e.purged_at === now && e.hash), id)
  assert.equal(byCard('old-done').length, 4)
  for (const id of ['edge', 'recent', 'old-open']) assert.ok(byCard(id).every(e => e.payload !== null && e.purged_at === null), id)
  // files: gone with the last event that showed them; a file an open card still shows stays
  assert.deepEqual(store.doomedFiles().map(f => f.id), ['asset-old', 'files/loose-old.png', 'files/old.png'])
  assert.deepEqual(store.blobs().map(b => b.id), ['asset-keep', 'asset-young', 'files/loose-new.png', 'files/open.png', 'files/shared.png', 'files/young.png'])
  // the asset's message is still in the conversation, without its content and without the key
  assert.deepEqual([oldAsset, keptAsset, youngAsset].map(seq => store.event(seq).purged), [true, false, false])
  assert.ok(!JSON.stringify([...store.exportRows()]).includes('KEY-asset-old'))
  assert.deepEqual(store.messages('a', { limit: 10 }).map(m => [m.id, m.purged]).sort(), [['chat-new', false], ['chat-old', false], ['msg-asset-keep', false], ['msg-asset-old', true], ['msg-asset-young', false]])
  // queue and status lines
  assert.deepEqual(store.handOver('away').map(d => d.params.n), ['new'])
  assert.deepEqual(store.statusLines({ session: 'a' }).map(t => [t.id, t.cardId]).sort(), [['stale', null], ['waits', 'old-open']])
  assertViewMatchesLogAfterPurge(store)

  // the files are deleted by the caller, then confirmed; until then they are remembered
  assert.equal(store.confirmDeleted(files.map(f => f.id)), 3)
  assert.deepEqual(store.doomedFiles(), [])
  // nothing more to do
  assert.deepEqual(store.purge({ at: now }), { cutoff: days(30), cards: 0, events: 0, messages: 0, deliveries: 0, assets: 0, elements: 0, files: [], more: false })
  // one moment later the edge card is past retention too
  assert.equal(store.purge({ at: now + 1 }).cards, 1)

  // chat is kept unless a retention for messages is given
  assert.deepEqual([store.purge({ at: now, messageDays: 30 }).messages, store.messages('a', { limit: 10 }).map(m => m.id).includes('chat-old'), store.session('a').messages], [3, false, 2])

  // a limit: the work is done in steps, and says when there is more
  const many = fresh()
  for (let i = 0; i < 5; i++) { ask(many.store, 'a', { id: `c${i}`, at: 1000 + i }); many.store.withdrawCard({ id: `c${i}`, by: 'a', at: 2000 }) }
  const step = many.store.purge({ limit: 2 })
  assert.deepEqual([step.cards, step.more], [2, true])
  assert.deepEqual([many.store.purge({ limit: 2 }).more, many.store.purge({ limit: 2 }).more, many.store.q('SELECT COUNT(*) AS n FROM cards').get().n], [true, false, 0])
})
// After a purge the view holds fewer cards than the log names; those that remain must still agree.
function assertViewMatchesLogAfterPurge(store) {
  const fromLog = replay(store)
  for (const r of store.q('SELECT id, status FROM cards').all()) assert.equal(fromLog.get(r.id)?.status, r.status, r.id)
}

// ---- pad -------------------------------------------------------------------------------------------------

await test('pad: elements one by one, and sending a selection to a session', () => {
  const { store, clock } = fresh({ sessions: ['a', 'b'] })
  const stroke = store.putElement({ type: 'stroke', x: 10, y: 10, w: 100, h: 40, author: 'phone', data: { tool: 'pen', color: 'ink', size: 4, pts: [0, 0, 100, 40] } }).element
  const text = store.putElement({ id: 't1', type: 'text', x: 500, y: 500, w: 200, h: 30, author: 'phone', group: 'g1', data: { text: 'move this button' } }).element
  store.registerBlob({ id: 'pad/img1', kind: 'pad', path: 'pad/img1.png', size: 5000 })
  store.registerBlob({ id: 'pad/voice1', kind: 'voice', path: 'pad/voice1.m4a', size: 9000, retention: 'owner' })
  const image = store.putElement({ id: 'i1', type: 'image', x: 0, y: 0, w: 300, h: 200, author: 'laptop', blob: 'pad/img1', data: { mime: 'image/png', nw: 600, nh: 400 } }).element
  const voice = store.putElement({ id: 'v1', type: 'voice', x: 900, y: 0, w: 200, h: 60, author: 'phone', blob: 'pad/voice1', data: { text: 'spoken', ms: 4200 } }).element
  assert.deepEqual([stroke.z, text.z, image.z, voice.z], [1, 2, 3, 4], 'new elements go on top')
  assert.deepEqual([stroke.rev, text.group, image.blob, voice.data.ms, stroke.author, stroke.created], [1, 'g1', 'pad/img1', 4200, 'phone', stroke.updated])
  refused(() => store.putElement({ type: 'sticker', author: 'x' }), 'invalid')
  refused(() => store.putElement({ type: 'text' }), 'invalid', 'an element has an author')
  refused(() => store.putElement({ type: 'image', author: 'x', blob: 'nope' }), 'not_found')

  // change one element: only that row moves, its revision counts up, the content stays unless given
  const moved = store.putElement({ id: 't1', x: 520, z: 10, author: 'laptop', ifRev: 1 }).element
  assert.deepEqual([moved.x, moved.y, moved.z, moved.rev, moved.data.text, moved.author, moved.group], [520, 500, 10, 2, 'move this button', 'phone', 'g1'])
  assert.ok(moved.updated > moved.created)
  refused(() => store.putElement({ id: 't1', x: 0, ifRev: 1, author: 'phone' }), 'conflict', 'someone else changed it first')
  refused(() => store.putElement({ id: 't1', x: 0, rev: 2, author: 'phone' }), 'conflict', 'a stale revision from another device')
  assert.equal(store.putElement({ id: 't1', data: { text: 'edited' }, rev: 7, author: 'phone' }).element.rev, 7)
  refused(() => store.putElement({ id: 't1', type: 'stroke', author: 'phone' }), 'invalid')
  assert.equal(store.element('t1').x, 520)
  // a retry of the same put changes nothing
  const put = store.putElement({ id: 'i1', x: 5, author: 'laptop', clientId: 'drag-1' })
  assert.deepEqual([store.putElement({ id: 'i1', x: 99, author: 'laptop', clientId: 'drag-1' }).duplicate, store.element('i1').x, store.element('i1').rev], [true, 5, put.element.rev])

  // read: in stacking order, by rectangle, in pages
  assert.deepEqual(store.elements().map(e => e.id), [stroke.id, 'i1', 'v1', 't1'])
  assert.deepEqual(store.elements({ box: [0, 0, 400, 300] }).map(e => e.id), [stroke.id, 'i1'])
  assert.deepEqual(store.elements({ limit: 2 }).map(e => e.id), [stroke.id, 'i1'])
  assert.deepEqual(store.elements({ after: [3, 'i1'], limit: 2 }).map(e => e.id), ['v1', 't1'])
  assert.deepEqual(store.elements({ pad: 'other' }), [])

  // send two elements to a session: one event, a link per element, the notification, in one commit
  const cursor = store.cursor()
  const sent = store.sendElements({ ids: ['t1', stroke.id], session: 'a', by: 'phone', body: { note: 'see the arrow' }, clientId: 'send-1',
    deliver: out => ({ method: 'notifications/claude/channel', params: { content: 'see the arrow', meta: { kind: 'pad', elements: out.elements.map(e => e.id).join(',') } } }) })
  assert.equal(sent.seq, cursor + 1)
  assert.deepEqual(store.event(sent.seq).body, { note: 'see the arrow', elements: [{ id: 't1', rev: 7 }, { id: stroke.id, rev: 1 }] })
  assert.deepEqual(store.elementLinks({ element: 't1' }), [{ element: 't1', session: 'a', seq: sent.seq, rev: 7, sentAt: sent.created, sentBy: 'phone' }])
  assert.deepEqual(store.elementLinks({ session: 'a' }).map(l => l.element).sort(), [stroke.id, 't1'].sort())
  assert.deepEqual(store.handOver('a').map(d => [d.eventSeq, d.params.meta.elements]), [[sent.seq, `t1,${stroke.id}`]])
  assert.equal(store.sendElements({ ids: ['t1'], session: 'a', by: 'phone', clientId: 'send-1' }).duplicate, true)
  // the same element to a second session, later, in its newer revision
  store.putElement({ id: 't1', x: 1, author: 'phone' })
  store.sendElements({ ids: 't1', session: 'b', by: 'laptop' })
  assert.deepEqual(store.elementLinks({ element: 't1' }).map(l => [l.session, l.rev]), [['b', 8], ['a', 7]])
  // all or nothing: one unknown element, nothing sent
  const before = [store.cursor(), store.queued('a'), store.elementLinks({ session: 'a' }).length]
  refused(() => store.sendElements({ ids: ['i1', 'nope'], session: 'a', deliver: { method: 'x' } }), 'not_found')
  refused(() => store.sendElements({ ids: ['i1'], session: 'nobody' }), 'not_found')
  refused(() => store.sendElements({ ids: [], session: 'a' }), 'invalid')
  assert.deepEqual([store.cursor(), store.queued('a'), store.elementLinks({ session: 'a' }).length], before)

  // what was sent is news about the element: it shows up for a device that catches up, in the same revision
  assert.deepEqual(store.elements({ sinceSeq: sent.seq }).map(e => [e.id, e.rev]), [['t1', 8]])
  assert.deepEqual([sent.elements.map(e => e.seq), store.element(stroke.id).seq, store.element(stroke.id).rev], [[sent.seq, sent.seq], sent.seq, 1])

  // delete: a tombstone for the other devices, the element no longer there; its file stays for an undo
  const since = store.cursor()
  const dropped = store.deleteElement('i1', { by: 'laptop' })
  assert.deepEqual([dropped.element.deleted, dropped.element.rev, dropped.element.data, store.blob('pad/img1').doomed], [true, 3, undefined, false])
  assert.deepEqual([store.element('i1'), store.element('i1', { deleted: true }).rev, store.elements().map(e => e.id)], [null, 3, [stroke.id, 'v1', 't1']])
  assert.deepEqual(store.elements({ sinceSeq: since }).map(e => [e.id, e.deleted, e.data]), [['i1', true, undefined]])
  refused(() => store.deleteElement('i1'), 'not_found')
  refused(() => store.putElement({ id: 'i1', x: 1, author: 'x' }), 'not_found')
  refused(() => store.sendElements({ ids: ['i1'], session: 'a' }), 'not_found')
  // undo of a delete: the same id again with a newer revision and its data; older or without data is refused
  refused(() => store.putElement({ id: 'i1', rev: 3, author: 'laptop', data: { mime: 'image/png' } }), 'not_found')
  refused(() => store.putElement({ id: 'i1', rev: 4, author: 'laptop' }), 'invalid')
  refused(() => store.putElement({ id: 'i1', rev: 4, type: 'text', author: 'laptop', data: {} }), 'invalid')
  const back = store.putElement({ id: 'i1', rev: 4, x: 7, author: 'laptop', blob: 'pad/img1', data: { mime: 'image/png', nw: 600, nh: 400 } }).element
  assert.deepEqual([back.deleted, back.rev, back.x, back.blob, back.data.nw, back.updated > dropped.created, back.created], [false, 4, 7, 'pad/img1', 600, true, image.created])
  assert.deepEqual(store.elements().map(e => e.id), [stroke.id, 'i1', 'v1', 't1'])
  // a delete with a revision of its own: it must be newer than what is stored
  refused(() => store.deleteElement('i1', { by: 'laptop', rev: 4 }), 'conflict')
  assert.equal(store.deleteElement('i1', { by: 'laptop', rev: 9 }).element.rev, 9)
  store.deleteElement('t1', { by: 'phone' })
  // tombstones go with the retention, and only then the file of a deleted picture; what was sent stays in the log
  clock.t += 31 * DAY
  const purged = store.purge()
  assert.deepEqual([purged.elements, store.elements({ sinceSeq: 0 }).map(e => e.id).sort(), store.elementLinks({ element: 't1' })], [2, [stroke.id, 'v1'].sort(), []])
  assert.deepEqual([purged.files.filter(f => f.kind === 'pad'), store.blob('pad/img1').doomed, store.blob('pad/voice1').doomed], [[{ id: 'pad/img1', kind: 'pad', path: 'pad/img1.png', size: 5000 }], true, false])
  assert.equal(store.event(sent.seq).type, 'pad.sent')
})

// ---- members, keys, admin log ----------------------------------------------------------------------------

await test('member list and wrapped keys: appended in order, sealed keys kept as they are', () => {
  const { store } = fresh()
  const entry = text => Buffer.from(text)
  refused(() => store.appendMember({ kind: 'add', device: 'd2', role: 'agent', signer: 'd1', entry: entry('x') }), 'illegal', 'the list starts with the founding entry')
  const founding = store.appendMember({ kind: 'founding', device: 'd1', role: 'human', signer: 'd1', entry: entry('founding'), signPub: crypto.randomBytes(32), kexPub: crypto.randomBytes(32) })
  assert.deepEqual([founding.n, Buffer.from(founding.hash).toString('hex')], [1, crypto.createHash('sha256').update('founding').digest('hex')])
  refused(() => store.appendMember({ kind: 'add', device: 'd2', role: 'agent', signer: 'd1', entry: entry('add d2') }), 'conflict', 'an entry must name its predecessor')
  refused(() => store.appendMember({ kind: 'add', device: 'd2', role: 'agent', signer: 'd1', entry: entry('add d2'), prevHash: crypto.randomBytes(32) }), 'conflict', 'a wrong predecessor')
  refused(() => store.appendMember({ n: 5, kind: 'add', device: 'd2', role: 'agent', signer: 'd1', entry: entry('add d2'), prevHash: founding.hash }), 'conflict', 'a skipped number')
  const added = store.appendMember({ n: 2, kind: 'add', device: 'd2', role: 'agent', session: 'a', signer: 'd1', entry: entry('add d2'), prevHash: founding.hash })
  refused(() => store.appendMember({ kind: 'founding', device: 'd9', role: 'human', signer: 'd9', entry: entry('again'), prevHash: added.hash }), 'illegal')
  refused(() => store.appendMember({ kind: 'add', device: 'd2', role: 'agent', signer: 'd1', entry: entry('add d2 again'), prevHash: added.hash }), 'conflict')
  const removed = store.appendMember({ kind: 'remove', device: 'd2', signer: 'd1', entry: entry('remove d2'), prevHash: added.hash })
  store.appendMember({ kind: 'epoch', epoch: 2, signer: 'd1', entry: entry('epoch 2'), prevHash: removed.hash })
  assert.deepEqual(store.memberLog().map(m => [m.n, m.kind, m.device]), [[1, 'founding', 'd1'], [2, 'add', 'd2'], [3, 'remove', 'd2'], [4, 'epoch', null]])
  assert.deepEqual(store.memberLog({ after: 2, limit: 1 }).map(m => m.n), [3])
  assert.deepEqual(store.devices().map(d => [d.id, d.role, d.member, d.session]), [['d1', 'human', true, null], ['d2', 'agent', false, 'a']])
  // keys: the hub stores what it cannot open, one per epoch and recipient
  const sealed = [crypto.randomBytes(92), crypto.randomBytes(92)]
  store.putWrappedKey({ epoch: 1, recipient: 'd1', wrapped: sealed[0] })
  store.putWrappedKey({ epoch: 2, recipient: 'd1', wrapped: sealed[1] })
  store.putWrappedKey({ epoch: 2, recipient: 'd1', wrapped: crypto.randomBytes(92) })   // a second copy is ignored
  store.putWrappedKey({ epoch: 2, recipient: 'recovery', kind: 'recovery', wrapped: crypto.randomBytes(92) })
  assert.deepEqual(store.wrappedKeys('d1').map(k => [k.epoch, Buffer.from(k.wrapped).equals(sealed[k.epoch - 1])]), [[1, true], [2, true]])
  assert.deepEqual(store.wrappedKeys('d1', { afterEpoch: 1 }).map(k => k.epoch), [2])
  refused(() => store.putWrappedKey({ epoch: 3, recipient: 'd1', wrapped: 'not bytes' }), 'invalid')
})

await test('admin log: the last 300, repeated wrong keys in one line', () => {
  const { store } = fresh()
  store.audit({ action: 'login', from: '127.0.0.1' })
  for (let i = 0; i < 50; i++) store.audit({ action: 'login-failed', from: '10.0.0.9' })
  store.audit({ action: 'purge', detail: '3 cards, 2 files' })
  assert.deepEqual(store.adminLog().map(e => [e.action, e.count ?? 1, e.detail]), [['login', 1, ''], ['login-failed', 50, ''], ['purge', 1, '3 cards, 2 files']])
  for (let i = 0; i < 400; i++) store.audit({ action: 'links', detail: String(i) })
  const log = store.adminLog()
  assert.deepEqual([log.length, log[0].detail, log.at(-1).detail], [300, '100', '399'])
})

// ---- snapshot --------------------------------------------------------------------------------------------

await test('snapshot: picture and cursor agree while another connection is in the middle of a write', () => {
  const file = dbFile()
  const writer = new Store(file)
  const reader = new Store(file)
  writer.upsertSession({ id: 'a', profile: { name: 'A' } })
  const c1 = ask(writer, 'a', { id: 'c1' })
  const before = reader.snapshot()
  let during
  writer.tx(() => {
    writer.answerCard({ id: c1.id, choice: 'yes' })
    ask(writer, 'a', { id: 'c2' })
    writer.postMessage({ session: 'a', from: 'user', body: { text: 'half-way' } })
    // The other connection reads now: it must see none of the three steps, and is not blocked.
    during = reader.snapshot()
  })
  const after = reader.snapshot()
  assert.deepEqual([during.cursor, during.queue, during.counts], [before.cursor, ['c1'], before.counts])
  assert.deepEqual([after.cursor, after.queue, after.counts.cards, after.counts.messages], [before.cursor + 3, ['c2'], { open: 1, decided: 1, done: 0 }, { a: 1 }])
  // snapshot + tail: what the reader had, plus the events after its cursor, is the new picture
  const tail = reader.eventsAfter(during.cursor).events
  assert.deepEqual(tail.map(e => [e.type, e.cardId]), [['card.answered', 'c1'], ['card.asked', 'c2'], ['message', null]])
  // a writer that fails half-way leaves the reader's picture as it was
  assert.throws(() => writer.tx(() => { ask(writer, 'a', { id: 'c3' }); throw new Error('boom') }), /boom/)
  assert.deepEqual(reader.snapshot().queue, ['c2'])
  writer.close(); reader.close()
})

const lines = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [])
async function until(test, ms = 20000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(5)) if (test()) return true
  throw new Error('timed out waiting for the child process')
}
const startChild = (mode, file, ack, ...rest) => {
  const child = spawn(process.execPath, [SELF, mode, file, ack, ...rest], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal, stderr })))
  return { child, exited }
}

await test('snapshot: consistent under interleaved writes from another process', async () => {
  const file = dbFile()
  const ack = `${file}.ack`
  new Store(file).close()
  const { child, exited } = startChild('--writer', file, ack, 'fast')
  await until(() => lines(ack).length > 5)
  const reader = new Store(file)
  const snaps = []
  while (snaps.length < 40) {
    snaps.push(reader.snapshot({ cards: 5000 }))
    await sleep(8)
  }
  child.kill('SIGKILL')
  const { signal, stderr } = await exited
  assert.equal(signal, 'SIGKILL', stderr)
  assert.ok(new Set(snaps.map(s => s.cursor)).size > 10, 'the writer was writing while the snapshots were taken')
  for (const snap of snaps) {
    // every snapshot is the state after exactly the events up to its cursor: no half of a transaction
    assert.equal(snap.truncated, false)
    assert.deepEqual(snap.cards.map(c => c.id).sort(), openIn(replay(reader, snap.cursor)), `snapshot at ${snap.cursor}`)
    assert.ok(snap.cards.every(c => c.lastSeq <= snap.cursor && c.askSeq <= snap.cursor))
    assert.equal(snap.counts.cards.open, snap.cards.length)
    assert.equal(snap.counts.events, snap.cursor)
  }
  // the bulk rows of one commit are all in or all out at every cursor a snapshot saw
  const partial = reader.q("SELECT ref, COUNT(*) AS n FROM events WHERE type = 'bulk' AND seq <= ? GROUP BY ref HAVING n != ?")
  for (const snap of snaps) assert.deepEqual(partial.all(snap.cursor, BATCH), [], `no half batch at ${snap.cursor}`)
  reader.close()
})

// ---- crash safety ----------------------------------------------------------------------------------------

function assertSound(store, acked) {
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), [])
  const { n, top } = store.q('SELECT COUNT(*) AS n, COALESCE(MAX(seq), 0) AS top FROM events').get()
  assert.equal(n, top, 'the log has no holes')
  assert.ok(top >= acked, `everything that was acknowledged is there (${acked} of ${top})`)
  assert.deepEqual(store.q("SELECT ref, COUNT(*) AS n FROM events WHERE type = 'bulk' AND ref != 'committed' GROUP BY ref HAVING n != ?").all(BATCH), [], 'no half transaction')
  assert.deepEqual(store.q('SELECT s.id FROM senders s WHERE s.last_seq != (SELECT COALESCE(MAX(sender_seq), 0) FROM events e WHERE e.sender = s.n)').all(), [], 'the per-sender counters match the log')
  assertViewMatchesLog(store)
  const asked = store.q("SELECT COUNT(*) AS n FROM events WHERE type = 'card.asked'").get().n
  assert.equal(store.q('SELECT COUNT(*) AS n FROM cards').get().n, asked)
  assert.equal(store.q('SELECT COUNT(*) AS n FROM messages').get().n, store.q("SELECT COUNT(*) AS n FROM events WHERE type = 'message'").get().n)
  assert.equal(store.q('SELECT COALESCE(SUM(messages), 0) AS n FROM sessions').get().n, store.q('SELECT COUNT(*) AS n FROM messages').get().n)
  return top
}

await test('crash: a writer killed in the middle of a transaction leaves a sound database', async () => {
  const file = dbFile()
  const ack = `${file}.ack`
  // 1. certainly mid-transaction: the child reports from inside an open transaction and is killed there
  const stalled = startChild('--stall', file, ack)
  await until(() => lines(ack).some(l => l.startsWith('mid ')))
  const inside = Number(lines(ack).find(l => l.startsWith('mid ')).slice(4))
  stalled.child.kill('SIGKILL')
  assert.equal((await stalled.exited).signal, 'SIGKILL')
  let store = new Store(file)
  const top = assertSound(store, 0)
  assert.ok(inside > top, 'the child had written more than is there now')
  assert.deepEqual([store.q("SELECT COUNT(*) AS n FROM events WHERE ref = 'never-committed'").get().n, store.card('half'), store.q("SELECT COUNT(*) AS n FROM events WHERE ref = 'committed'").get().n], [0, null, 1])
  // the database is writable again at once, and numbering continues without a hole
  assert.equal(store.append({ sender: 'w', type: 'note', body: {} }).seq, top + 1)
  store.close()

  // 2. killed at arbitrary moments, five times over, on the same file
  let kills = 0
  for (const wait of [3, 11, 23, 37, 61]) {
    fs.rmSync(ack, { force: true })
    const { child, exited } = startChild('--writer', file, ack)
    await until(() => lines(ack).length >= 2)
    await sleep(wait)
    child.kill('SIGKILL')
    const { signal, stderr } = await exited
    assert.equal(signal, 'SIGKILL', stderr)
    const acked = Number(lines(ack).filter(l => /^\d+$/.test(l)).at(-1))   // a torn last line is not an acknowledgement
    store = new Store(file)
    assertSound(store, acked)
    store.close()
    kills++
  }
  assert.equal(kills, 5)
  assert.ok(fs.statSync(file).size > 0)
})

// ---- export, backup --------------------------------------------------------------------------------------

await test('export and backup', async () => {
  const file = dbFile()
  const { store } = fresh({ file, sessions: ['a'] })
  ask(store, 'a', { id: 'c1', title: 'exported?' })
  store.postMessage({ session: 'a', from: 'user', id: 'm1', body: { text: 'my token is hunter2-secret' } })
  store.append({ sender: 'phone', type: 'note', payload: Buffer.from([1, 2, 3]) })
  store.enqueue('a', 'notify', { content: 'names /home/me/secret/path' })
  store.putElement({ id: 'e1', type: 'text', author: 'phone', data: { text: 'on the pad' } })
  const out = path.join(TMP, 'export.jsonl')
  const count = store.exportTo(out, { scrub: line => line.split('hunter2-secret').join('[removed]') })
  const rows = fs.readFileSync(out, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.equal(rows.length, count)
  assert.equal(fs.statSync(out).mode & 0o077, 0, 'the export is readable by its owner only')
  assert.deepEqual([rows[0].format, rows[0].schema, rows[0].cursor], ['trommi-store', SCHEMA_VERSION, store.cursor()])
  const of = table => rows.filter(r => r.table === table).map(r => r.row)
  assert.equal(of('events').length, store.cursor())
  assert.deepEqual(of('events').find(e => e.type === 'card.asked').payload.$json.title, 'exported?')
  assert.deepEqual(of('events').find(e => e.type === 'note').payload, { $b64: 'AQID' }, 'opaque bytes are exported as they are')
  assert.equal(of('pad_elements')[0].payload.$json.text, 'on the pad')
  const text = fs.readFileSync(out, 'utf8')
  assert.ok(!text.includes('hunter2-secret') && text.includes('[removed]'))
  assert.ok(!text.includes('/home/me/secret/path') && of('deliveries').length === 0, 'waiting notifications are counted, not exported')
  assert.deepEqual(of('pending_counts'), [{ session: 'a', count: 1 }])
  // a copy taken while the database is open is a database
  const copy = path.join(TMP, 'backup.db')
  await store.backup(copy)
  const restored = new Store(copy)
  assert.deepEqual([restored.cursor(), restored.card('c1').ask.title, restored.queued('a')], [store.cursor(), 'exported?', 1])
  restored.close(); store.close()
})

// ---- import of state.json --------------------------------------------------------------------------------

// The files of a directory with size and content hash, to prove a source was only read.
const fingerprint = dir => JSON.stringify(fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => {
  const f = path.join(e.parentPath, e.name)
  return [path.relative(dir, f), fs.statSync(f).size, fs.statSync(f).mtimeMs, crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]
}).sort())
const cli = (...args) => spawnSync(process.execPath, [path.join(HERE, 'migrate.mjs'), ...args], { encoding: 'utf8' })

await test('import: the demo state from dev/demo-state.mjs, with a dry run, twice', () => {
  const dir = path.join(TMP, 'sample')
  const made = spawnSync(process.execPath, [path.join(REPO, 'dev', 'demo-state.mjs'), dir], { encoding: 'utf8' })
  assert.equal(made.status, 0, made.stderr)
  const before = fingerprint(dir)
  const target = path.join(TMP, 'sample.db')
  // dry run: counts, and no database
  const dry = cli(dir, target, '--dry-run')
  assert.equal(dry.status, 0, dry.stderr)
  const preview = JSON.parse(dry.stdout)
  assert.deepEqual([preview.imported.messages, preview.imported.cards, preview.imported.status_lines, preview.imported.blobs, preview.missing_files, preview.verified],
    [7, 8, 4, 5, [], 'matches the state file'])
  assert.ok(!fs.existsSync(target), 'a dry run writes no database')
  // the real import says the same
  const real = cli(dir, target)
  assert.equal(real.status, 0, real.stderr)
  assert.deepEqual(JSON.parse(real.stdout).imported, preview.imported)
  const store = new Store(target)
  const cursor = store.cursor()
  const state = normalise(readState(path.join(dir, 'state.json')).raw)
  assert.deepEqual(verify(store, state), [])
  // the stack is the one the demo wrote, except the approval: load() ends an approval left open by a hub that stopped
  assert.deepEqual(store.snapshot().queue, ['c-migrate', 'c-phone', 'c-theme', 'c-next'])
  assert.deepEqual([store.card('c-perm').status, store.card('c-perm').closedAs], ['done', 'expired'])
  assert.deepEqual([store.card('c-db').status, store.card('c-db').answer, store.card('c-name').closedAs, store.card('c-name').close.summary],
    ['decided', { choice: 'pg', note: 'mit Docker' }, 'closed', 'Ordner und package.json umbenannt'])
  assert.equal(store.card('c-theme').ask.attachments.length, 2)
  assert.deepEqual(store.q("SELECT blob_id FROM event_blobs WHERE seq = ? ORDER BY blob_id").all(store.card('c-theme').askSeq).map(r => r.blob_id), ['files/thema-dunkel.png', 'files/thema-hell.png'])
  assert.equal(store.blob('files/thema-hell.png').size, fs.statSync(path.join(dir, 'files', 'thema-hell.png')).size)
  // the conversation in order: messages, and the cards' own events where the markers were
  const talk = store.eventsAfter(0, { session: 'agent', limit: 1000 }).events.filter(e => e.type !== 'status.set')
  assert.deepEqual(talk.map(e => e.created), [...talk.map(e => e.created)].sort((a, b) => a - b), 'in the order it happened')
  assert.deepEqual(talk.filter(e => e.cardId === 'c-phone').map(e => [e.type, e.body.kind ?? null]), [['card.asked', 'decision'], ['card.note', 'urgency']])
  assert.equal(store.next_number ?? store.meta('next_number'), 9)
  assertViewMatchesLog(store)
  store.close()
  // again: nothing new
  const again = JSON.parse(cli(dir, target).stdout)
  assert.deepEqual([Object.values(again.imported).every(n => n === 0), again.already_present.messages, again.already_present.cards, again.store.events], [true, 7, 8, cursor])
  assert.equal(fingerprint(dir), before, 'the source was only read')
})

await test('import: every older shape of the state file that load() tolerates', () => {
  const dir = path.join(TMP, 'legacy')
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'scribbles'))
  fs.mkdirSync(path.join(dir, 'assets'))
  for (const [name, bytes] of [['files/ref.png', 11], ['scribbles/abc123.png', 5], ['scribbles/abc123.json', 7], ['scribbles/canvas-main.json', 20], ['scribbles/canvas-main.png', 30], ['token', 32]]) fs.writeFileSync(path.join(dir, name), 'x'.repeat(bytes))
  const aOld = 'O'.repeat(22)
  fs.writeFileSync(path.join(dir, 'assets', aOld), 'ZWA1' + 'x'.repeat(60))
  fs.writeFileSync(path.join(dir, 'admin-log.jsonl'), [{ ts: 5, action: 'login', detail: '', from: '127.0.0.1' }, { ts: 6, action: 'login-failed', detail: '', from: '10.0.0.1', count: 3 }].map(e => JSON.stringify(e)).join('\n') + '\nnot json\n')
  const option = key => ({ key, label: key, detail: '' })
  const old = (id, status, created, rest) => ({ id, kind: 'decision', status, title: id, body: '', options: [option('a'), option('b')], attachments: [], choice: null, note: '', summary: '', created, decided: null, ...rest })
  const state = {
    // the very first version: no agents, no numbers, no urgency, no queue; an agent message without attachments
    messages: [
      { id: 'm-old1', from: 'user', text: 'alt', ts: 1 }, { id: 'm-old2', from: 'agent', text: 'auch alt', ts: 2 },
      'not a message', null, { id: 'm-bad', from: 'nobody', text: 'x', ts: 3 },
      { id: 'w1', agent: 'weg', from: 'agent', text: 'mit Bild', attachments: [{ name: 'ref.png', url: '/files/ref.png', kind: 'image', image: true }, { name: 'x', url: '/files/../token', kind: 'file' }, { name: 'gone.png', url: '/files/gone.png' }], ts: 4 },
      { id: 'w2', agent: 'weg', from: 'user', text: '', attachments: [{ kind: 'scribble', id: 'abc123', name: 'Scribble', url: '/scribbles/abc123.png', image: true }], ts: 5 },
      { id: 'e-asked', from: 'event', kind: 'asked', card_id: 'twice', text: 'twice', ts: 40 },
      { id: 'e-dec1', from: 'event', kind: 'decided', card_id: 'twice', text: 'a', ts: 41 },
      { id: 'e-reop', from: 'event', kind: 'reopened', card_id: 'twice', text: 'twice', ts: 42 },
      { id: 'e-dec2', from: 'event', kind: 'decided', card_id: 'twice', text: 'b', ts: 43 },
      { id: 'e-done', from: 'event', kind: 'done', card_id: 'twice', text: 'erledigt', ts: 44 },
      { id: 'e-orphan', from: 'event', kind: 'done', card_id: 'purged-long-ago', text: 'x', ts: 6 },
      { id: 'e-withdrawn', from: 'event', kind: 'done', card_id: 'pulled', text: 'Withdrawn: moot', ts: 51 },
      { id: 'dup', from: 'user', text: 'one', ts: 60 }, { id: 'dup', from: 'user', text: 'two', ts: 61 },
      { from: 'user', text: 'no id at all', ts: 62 },
      { id: 'am', agent: 'main', from: 'agent', text: 'asset', attachments: [], asset: { id: aOld, type: 'html', title: 'Alt', url: `/a/${aOld}#${'k'.repeat(43)}`, size: 64 }, ts: 63 },
    ],
    cards: [
      old('old-done', 'done', 10, { choice: 'a', decided: 11, summary: 'fertig' }),
      old('old-open', 'open', 20),
      { ...old('old-perm', 'open', 30), kind: 'permission', request_id: 'stale' },
      old('twice', 'done', 40, { choice: 'b', decided: 43, summary: 'erledigt', number: 7, urgency: 'high', agent: 'weg' }),
      old('pulled', 'done', 50, { summary: 'moot', urgency: 'sooner or later' }),
      { ...old('no-arrays', 'open', 55), options: 'none', attachments: null },
      { kind: 'decision', status: 'open', title: 'a card without an id' }, 42,
    ],
    tasks: [{ id: 'deploy', label: 'Deploy', state: 'decision', detail: 'waits', card_id: 'old-open', updated: 70 }, { id: 'odd', label: 'Odd', state: 'exploding' }, { label: 'no id', state: 'working' },
      { id: 'dangling', label: 'Dangling', state: 'decision', card_id: 'purged-long-ago', updated: 71 }],
    agents: [{ id: 'main', name: 'main', cwd: '/tmp/main', host: 'h', platform: 'p', instance: 'i1', model: 'M', client: 'c', task: 't', joined: 1, connected: 2, seen: 3, online: true, starred: true, label: 'Chef', archived: false }, { name: 'no id' }],
    pending: { weg: [{ method: 'notifications/claude/channel', params: { content: 'wartet eins' }, ts: 80 }, { nothing: true }, null, { method: 'notifications/claude/channel', params: { content: 'wartet zwei' }, ts: 81 }], odd: 'not a list' },
    assets: [{ id: aOld, agent: 'main', type: 'html', title: 'Alt', size: 64, created: 62, keep: false, silent: false, wrapped_key: null }, { id: '../token', agent: 'main', created: 1 }],
    hub: 'main', queue: ['whatever', 'is', 'recomputed'],
  }
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state))
  const before = fingerprint(dir)
  const norm = normalise(readState(path.join(dir, 'state.json')).raw)
  assert.deepEqual(norm.skipped, { messages: 3, cards: 2, tasks: 2, agents: 1, pending: 2, assets: 1 })
  const { store } = fresh({ sessions: [] })
  const report = importState(store, norm, { dataDir: dir })
  assert.deepEqual(verify(store, norm), [])
  assert.deepEqual(report.missing_files, ['files/token', 'files/gone.png'])
  // records without an agent belong to the hub's session; ids that are only named get a session of their own
  assert.deepEqual(store.sessions().map(s => [s.id, s.profile.name, s.online]), [['main', 'main', false], ['weg', 'weg', false]])
  assert.deepEqual([store.session('main').profile.label, store.session('main').profile.starred, store.session('main').instance, store.session('main').joined], ['Chef', true, 'i1', 1])
  // numbers: kept where given, filled in in order where not
  assert.deepEqual(store.cards({ limit: 20 }).map(c => [c.id, c.number]).sort((a, b) => a[1] - b[1]), [['twice', 7], ['old-done', 8], ['old-open', 9], ['old-perm', 10], ['pulled', 11], ['no-arrays', 12]])
  assert.equal(store.meta('next_number'), 13)
  assert.deepEqual(store.snapshot().queue, ['old-open', 'no-arrays'])
  assert.deepEqual(['old-done', 'old-open', 'old-perm', 'twice', 'pulled'].map(id => [store.card(id).status, store.card(id).closedAs, store.card(id).urgency]),
    [['done', 'closed', 'normal'], ['open', null, 'normal'], ['done', 'expired', 'critical'], ['done', 'closed', 'high'], ['done', 'withdrawn', 'normal']])
  assert.deepEqual([store.card('no-arrays').ask.options, store.card('old-perm').close.summary], [[], 'Session ended before the approval was answered'])
  // the card that was answered twice keeps its history: the markers the final state does not explain are notes
  assert.deepEqual(store.q('SELECT type, created FROM events WHERE card_id = ? ORDER BY seq').all('twice').map(r => [r.type, r.created]),
    [['card.asked', 40], ['card.note', 41], ['card.note', 42], ['card.answered', 43], ['card.closed', 44]])
  assert.equal(store.card('twice').answer.choice, 'b')
  assert.equal(store.q("SELECT COUNT(*) AS n FROM events WHERE type = 'note'").get().n, 1, 'a marker of a card that no longer exists stays a note in the conversation')
  // messages: the agent message got its empty attachments, duplicates and missing ids are told apart
  assert.deepEqual(store.messages('main', { limit: 20 }).map(m => m.body.text).reverse(), ['alt', 'auch alt', 'one', 'two', 'no id at all', 'asset'])
  assert.deepEqual(store.messages('main', { limit: 20 }).at(-2).body.attachments, [])
  // files: by name only, never a path out of the folder; the scribble with its drawing
  assert.deepEqual(store.blobs().map(b => [b.id, b.kind, b.size, b.retention]), [
    [aOld, 'asset', 64, 'age'], ['files/gone.png', 'attachment', null, 'refs'], ['files/ref.png', 'attachment', 11, 'refs'], ['files/token', 'attachment', null, 'refs'],
    ['scribbles/abc123.json', 'scribble', 7, 'refs'], ['scribbles/abc123.png', 'scribble', 5, 'refs'],
    ['scribbles/canvas-main.json', 'canvas', 20, 'owner'], ['scribbles/canvas-main.png', 'canvas', 30, 'owner'],
  ])
  assert.deepEqual([store.canvas('main').version, store.canvas('main').doc, store.canvas('main').image, store.canvas('weg')], [1, 'scribbles/canvas-main.json', 'scribbles/canvas-main.png', null])
  // status lines, queue, admin log
  assert.deepEqual(store.statusLines().map(t => [t.session, t.id, t.state, t.cardId, t.label, t.updated]), [['main', 'deploy', 'decision', 'old-open', 'Deploy', 70], ['main', 'dangling', 'decision', null, 'Dangling', 71]])
  assert.deepEqual(store.handOver('weg').map(d => [d.params.content, d.created]), [['wartet eins', 80], ['wartet zwei', 81]])
  assert.equal(store.acknowledge(store.handOver('weg')[0].id), 1)
  assert.deepEqual(store.adminLog().map(e => [e.action, e.count ?? 1]), [['login', 1], ['login-failed', 3]])
  assert.equal(store.meta('hub'), 'main')
  // the purge that follows an import treats the old records as the server would: all of this is from 1970
  const purged = store.purge()
  assert.deepEqual([purged.cards, purged.assets, purged.deliveries, store.q('SELECT id FROM cards ORDER BY id').all().map(r => r.id)], [4, 1, 1, ['no-arrays', 'old-open']])
  assertViewMatchesLogAfterPurge(store)
  // importing the same file again adds nothing: not the purged cards, not the notification that was delivered
  const cursor = store.cursor()
  const again = importState(store, normalise(readState(path.join(dir, 'state.json')).raw), { dataDir: dir })
  assert.deepEqual([Object.values(again.imported).every(n => n === 0), store.cursor(), store.adminLog().length, store.queued('weg')], [true, cursor, 2, 0])
  assert.equal(fingerprint(dir), before, 'the source was only read')
})

await test('import: a broken, an empty and a missing state file', () => {
  const dir = path.join(TMP, 'broken')
  fs.mkdirSync(dir)
  const file = path.join(dir, 'state.json')
  for (const [content, complaint] of [['{"cards": [{"id": "halb', /not valid JSON/], ['[1, 2]', /not an object/], ['null', /not an object/], ['', /not valid JSON/]]) {
    fs.writeFileSync(file, content)
    const out = cli(dir, path.join(dir, 'out.db'))
    assert.equal(out.status, 2)
    assert.match(out.stderr, complaint)
    assert.match(out.stderr, /nothing imported/)
    // unlike load(), nothing is moved aside and no database appears
    assert.deepEqual(fs.readdirSync(dir), ['state.json'])
    assert.equal(fs.readFileSync(file, 'utf8'), content)
  }
  fs.writeFileSync(file, '{}')
  const empty = JSON.parse(cli(file, '--dry-run').stdout)
  assert.deepEqual([empty.store.events, empty.verified], [0, 'matches the state file'])
  fs.rmSync(file)
  const missing = cli(dir, '--dry-run')
  assert.deepEqual([missing.status, JSON.parse(missing.stdout).note], [0, 'no state file there: an empty board'])
  assert.equal(cli().status, 1)
  assert.deepEqual(fs.readdirSync(dir), [])
  // records with no agent go to the session named with --owner
  fs.writeFileSync(file, JSON.stringify({ messages: [{ id: 'm', from: 'user', text: 'hi', ts: 1 }] }))
  assert.equal(JSON.parse(cli(file, '--dry-run', '--owner', 'chef').stdout).owner, 'chef')
  // --data may name the same folder as the source
  assert.equal(JSON.parse(cli(dir, '--dry-run', '--data', dir).stdout).imported.messages, 1)
})

// A state file as a busy board would have it: many sessions, long conversations, cards in every state.
function synthetic({ sessions = 12, messages = 20000, cards = 2500 } = {}) {
  let seed = 42
  const rnd = n => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >>> 8) % n
  const t0 = 1_790_000_000_000
  const agents = Array.from({ length: sessions }, (_, i) => ({ id: `s${i}`, name: `Session ${i}`, cwd: `/work/s${i}`, host: 'box', platform: 'Linux x64', instance: `i${i}`, model: 'M', client: 'claude-code', task: 't', joined: t0, connected: t0, seen: t0, online: i % 2 === 0, archived: i === 3 }))
  const out = { agents, messages: [], cards: [], tasks: [], pending: {}, assets: [], hub: 's0' }
  let ts = t0, mid = 0, number = 1
  const say = m => out.messages.push({ id: `m${mid++}`, ts: ts += 1 + rnd(5000), ...m })
  const marker = (card, kind, text) => say({ agent: card.agent, from: 'event', kind, card_id: card.id, text })
  const perCard = Math.max(1, Math.floor(messages / cards))
  for (let i = 0; i < cards; i++) {
    const agent = `s${rnd(sessions)}`
    for (let k = 0; k < perCard; k++) {
      const from = rnd(2) ? 'agent' : 'user'
      say({ agent, from, text: `message ${mid} ${'lorem ipsum '.repeat(1 + rnd(20))}`, ...(from === 'agent' ? { attachments: rnd(10) === 0 ? [{ name: `shot${mid}.png`, url: `/files/f${mid}.png`, kind: 'image', image: true, size: 1000 + rnd(100000) }] : [] } : {}) })
    }
    const permission = rnd(12) === 0
    const card = {
      id: `c${i}`, agent, number: number++, kind: permission ? 'permission' : 'decision', status: 'open', urgency: permission ? 'critical' : ['low', 'normal', 'normal', 'high', 'critical'][rnd(5)],
      urgency_reason: '', title: `Question ${i}?`, body: 'context '.repeat(rnd(40)), options: permission ? [{ key: 'allow', label: 'Allow', detail: '' }, { key: 'deny', label: 'Deny', detail: '' }] : [{ key: 'a', label: 'A', detail: '' }, { key: 'b', label: 'B', detail: '' }],
      attachments: rnd(8) === 0 ? [{ name: `card${i}.png`, url: `/files/card${i}.png`, kind: 'image', image: true, size: 5000 }] : [],
      choice: null, note: '', summary: '', created: ts += 1000, decided: null, ...(permission ? { request_id: `r${i}` } : {}),
    }
    out.cards.push(card)
    if (permission) {
      // answered, or ended with its session; an approval is never left open in a file a running hub wrote for long
      if (rnd(3)) Object.assign(card, { choice: rnd(2) ? 'allow' : 'deny', decided: ts += 2000, status: 'done' })
      else Object.assign(card, { status: 'done', summary: 'Session ended before the approval was answered' })
      continue
    }
    marker(card, 'asked', card.title)
    const fate = rnd(10)
    if (fate < 2) continue                                    // stays open
    if (fate === 2) { card.status = 'done'; card.summary = 'moot'; marker(card, 'done', 'Withdrawn: moot'); continue }
    if (rnd(6) === 0) { marker(card, 'urgency', 'Urgent: now'); card.urgency = 'high' }
    if (rnd(8) === 0) { marker(card, 'decided', 'A'); marker(card, 'reopened', card.title) }   // answered, taken back
    Object.assign(card, { choice: rnd(2) ? 'a' : 'b', note: rnd(4) ? '' : 'a note', decided: ts += 3000, status: 'decided' })
    marker(card, 'decided', card.choice.toUpperCase())
    if (fate < 5) continue                                    // decided, not yet acted on
    Object.assign(card, { status: 'done', summary: `did ${i}` })
    marker(card, 'done', card.summary)
  }
  for (let i = 0; i < sessions; i++) {
    const open = out.cards.find(c => c.agent === `s${i}` && c.status === 'open')
    out.tasks.push({ agent: `s${i}`, id: 'main', label: 'Main', state: open ? 'decision' : 'working', detail: 'd', card_id: open?.id ?? null, updated: ts })
    if (i % 2) out.pending[`s${i}`] = Array.from({ length: 1 + rnd(130) }, (_, k) => ({ method: 'notifications/claude/channel', params: { content: `waiting ${k}`, meta: { kind: 'chat' } }, ts: ts + k }))
  }
  out.next_number = number
  out.queue = queueOf(out.cards, agents)
  return out
}

let importNote = ''
await test('import: a large synthetic state (12 sessions, 2 500 cards, about 25 000 messages and markers)', () => {
  const dir = path.join(TMP, 'large')
  fs.mkdirSync(dir)
  const state = synthetic()
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2))
  const target = path.join(TMP, 'large.db')
  const started = performance.now()
  const out = cli(dir, target, '--data', path.join(dir, 'no-files-here'))
  const took = performance.now() - started
  assert.equal(out.status, 0, out.stderr + out.stdout.slice(-2000))
  const report = JSON.parse(out.stdout)
  assert.equal(report.verified, 'matches the state file')
  const norm = normalise(state)
  const store = new Store(target)
  assert.deepEqual(verify(store, norm), [])
  // the stack: the same cards in the same order as the server computes it
  const snap = store.snapshot({ cards: 5000 })
  assert.deepEqual(snap.queue, queueOf(norm.cards, norm.agents))
  assert.ok(snap.queue.length > 100 && snap.cards.length > snap.queue.length, `an archived session's cards are open but not in the stack (${snap.cards.length} open, ${snap.queue.length} in the stack)`)
  assert.equal(report.imported.messages, state.messages.filter(m => m.from !== 'event').length)
  assert.equal(report.imported.cards, 2500)
  // a queue longer than the cap arrives cut to the newest, as load() cuts it
  for (const [id, queue] of Object.entries(state.pending)) assert.equal(store.queued(id), Math.min(queue.length, QUEUE_MAX))
  assertViewMatchesLog(store)
  // time in the log runs forward
  assert.equal(store.q('SELECT COUNT(*) AS n FROM events a JOIN events b ON b.seq = a.seq + 1 WHERE b.created < a.created AND a.type != \'session.joined\' AND b.type NOT IN (\'status.set\')').get().n, 0)
  const stats = store.stats()
  store.checkpoint()
  const jsonBytes = fs.statSync(path.join(dir, 'state.json')).size
  importNote = `import of a ${(jsonBytes / 1e6).toFixed(1)} MB state.json (${state.messages.length} messages and markers, 2500 cards): ${Math.round(took)} ms including process start, ${stats.cursor} events, database ${(fs.statSync(target).size / 1e6).toFixed(1)} MB`
  store.close()
  const again = JSON.parse(cli(dir, target).stdout)
  assert.ok(Object.values(again.imported).every(n => n === 0))
  assert.equal(again.store.events, stats.cursor)
})

// ---- benchmark -------------------------------------------------------------------------------------------

if (process.env.STORE_BENCH !== '0') {
  await test('benchmark: 100 000 events appended and read back', () => {
    const dir = fs.mkdtempSync(path.join(process.env.STORE_BENCH_DIR || TMP, 'bench-'))
    const N = 100_000
    const fsType = spawnSync('df', ['--output=fstype', dir], { encoding: 'utf8' }).stdout?.trim().split('\n').at(-1) ?? 'unknown'
    const say = line => console.log(`     ${line}`)
    say(`node ${process.version}, SQLite ${new DatabaseSync(':memory:').prepare('SELECT sqlite_version() AS v').get().v}, ${os.cpus()[0].model.trim()}, files in ${dir} (${fsType})`)
    // a chat message of ordinary length; the payload is about 240 bytes of JSON
    const body = i => ({ from: i % 2 ? 'agent' : 'user', text: `Message ${i}: the migration is written and green locally, ${'detail '.repeat(18)}`, attachments: [] })
    const rate = (n, ms) => `${Math.round(n / (ms / 1000)).toLocaleString('en-US')} events/s`
    const timed = fn => { const t = performance.now(); const out = fn(); return [performance.now() - t, out] }
    try {
      // 1. one commit per event, synchronous = NORMAL
      const fileA = path.join(dir, 'single.db')
      const a = new Store(fileA, { synchronous: 'NORMAL' })
      a.upsertSession({ id: 's', profile: { name: 'S' } })
      const [single] = timed(() => { for (let i = 0; i < N; i++) a.append({ sender: i % 2 ? 's' : 'human', clientId: `k${i}`, type: 'note', session: 's', body: body(i) }) })
      say(`append, one commit per event, synchronous=NORMAL: ${N} in ${Math.round(single)} ms = ${rate(N, single)}`)
      assert.equal(a.cursor(), N + 1)
      // 2. the same again as retries: every one is recognised and nothing is written
      const [dups] = timed(() => { for (let i = 0; i < N; i += 10) assert.equal(a.append({ sender: i % 2 ? 's' : 'human', clientId: `k${i}`, type: 'note', session: 's', body: body(i) }).duplicate, true) })
      say(`repeat of ${N / 10} already stored client ids: ${Math.round(dups)} ms = ${rate(N / 10, dups)}, nothing written`)
      assert.equal(a.cursor(), N + 1)
      // 3. read everything back in pages of 1000
      const [read, got] = timed(() => {
        let n = 0, bytes = 0
        for (let cursor = 0, more = true; more;) {
          const page = a.eventsAfter(cursor, { limit: 1000 })
          n += page.events.length
          for (const e of page.events) bytes += e.size
          ;({ cursor, more } = page)
        }
        return { n, bytes }
      })
      assert.equal(got.n, N + 1)
      say(`read all in pages of 1000 (decoded): ${got.n} in ${Math.round(read)} ms = ${rate(got.n, read)}, ${(got.bytes / N).toFixed(0)} bytes of payload per event`)
      // 4. a resume from near the end, and one conversation page: what a reconnecting client does
      const [resume] = timed(() => { for (let i = 0; i < 1000; i++) a.eventsAfter(N - 50, { limit: 200 }) })
      say(`resume (the last 50 events after a cursor): ${(resume / 1000).toFixed(3)} ms each`)
      for (let i = 0; i < 200; i++) a.askCard({ session: 's', body: { title: `q${i}`, options: [{ key: 'a' }, { key: 'b' }] } })
      const [snap] = timed(() => { for (let i = 0; i < 100; i++) a.snapshot() })
      say(`snapshot with 200 open cards on top of ${N} events: ${(snap / 100).toFixed(2)} ms each`)
      a.checkpoint()
      const size = fs.statSync(fileA).size
      say(`size on disk after checkpoint: ${(size / 1e6).toFixed(1)} MB = ${Math.round(size / N)} bytes per event (payload ${(got.bytes / N).toFixed(0)}, the rest is header, hash and three indexes)`)
      a.close()
      // 5. batches: 1000 events per commit
      const b = new Store(path.join(dir, 'batch.db'), { synchronous: 'NORMAL' })
      b.upsertSession({ id: 's', profile: { name: 'S' } })
      const [batched] = timed(() => { for (let i = 0; i < N; i += 1000) b.appendMany(Array.from({ length: 1000 }, (_, k) => ({ sender: 's', clientId: `k${i + k}`, type: 'note', session: 's', body: body(i + k) }))) })
      say(`append, 1000 per commit: ${N} in ${Math.round(batched)} ms = ${rate(N, batched)}`)
      b.close()
      // 6. the default, synchronous = FULL: every commit waits for the disk
      const c = new Store(path.join(dir, 'full.db'))
      c.upsertSession({ id: 's', profile: { name: 'S' } })
      const M = 2000
      const [full] = timed(() => { for (let i = 0; i < M; i++) c.append({ sender: 's', clientId: `k${i}`, type: 'note', session: 's', body: body(i) }) })
      say(`append, one commit per event, synchronous=FULL (the default): ${M} in ${Math.round(full)} ms = ${rate(M, full)}${fsType === 'tmpfs' ? ' (RAM disk: fsync costs nothing here)' : ''}`)
      // 7. a whole card: ask, answer with its notification, close
      const [life] = timed(() => { for (let i = 0; i < 1000; i++) { const { card } = c.askCard({ session: 's', body: { title: 'q', options: [{ key: 'a' }, { key: 'b' }] } }); c.answerCard({ id: card.id, choice: 'a', deliver: { method: 'n', params: {} } }); c.closeCard({ id: card.id, by: 's' }) } })
      say(`a card's life (ask, answer + queued notification, close; three commits, FULL): ${(life / 1000).toFixed(2)} ms`)
      c.close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}

// ---- done ------------------------------------------------------------------------------------------------

fs.rmSync(TMP, { recursive: true, force: true })
if (importNote) console.log(`     ${importNote}`)
console.log(`\n${passed} passed, ${results.length} failed`)
if (results.length) {
  console.log(results.map(name => `  failed: ${name}`).join('\n'))
  process.exit(1)
}
