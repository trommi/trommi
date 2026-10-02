# server/store

The hub's next storage layer: an append-only event log with a few views beside it, in one SQLite file, on Node's built-in `node:sqlite`. No dependencies. **Not used by `server.mjs` yet.** The data model and the reasons are in `docs/storage.md`.

```
store.mjs     the store
migrate.mjs   import a state.json into a store database
test.mjs      node server/store/test.mjs   (STORE_BENCH=0 skips the benchmark, STORE_BENCH_DIR=<dir> runs it on another disk)
```

Needs Node 22.13 or newer (tested on 26.8.1).

## API

```js
import { Store } from './store/store.mjs'
const store = new Store('data/trommi.db')          // creates or migrates; WAL, foreign keys, synchronous=FULL
```

Every method is synchronous and either happens completely or not at all. A refused call throws a `StoreError` with a `code`: `invalid`, `not_found`, `illegal` (the state does not allow it), `conflict`. Every write takes an optional `clientId`; the same `(sender, clientId)` again returns the first result with `duplicate: true` and changes nothing. Content goes in as `body` (any JSON value) or as `payload` (bytes, stored untouched, for ciphertext).

**The log**

```js
store.append({ sender: 'human', clientId: 'k1', type: 'note', session: 'api', body: { text: 'hi' } })
// → { seq: 41, senderSeq: 7, created: 1790…, duplicate: false }
store.appendMany([…])                               // one commit
store.eventsAfter(cursor, { limit: 200, session })  // → { events, cursor, more }   oldest first
store.eventsBefore(session, beforeSeq, { limit })   // scrolling back in a conversation
store.eventsFrom(sender, afterSenderSeq, { limit }) // one sender's chain, to fill a gap
store.cursor()                                      // the newest seq
```

**Snapshot for a client:** sessions, the open cards in stack order with their questions, status lines, counts, and the cursor the picture belongs to.

```js
const { cursor, sessions, cards, queue, status, counts } = store.snapshot()
// then: store.eventsAfter(cursor) until more is false, and again on every reconnect
```

**Sessions**

```js
store.upsertSession({ id: 'api', instance, profile: { name: 'api', model: 'Claude Opus 5.5' } })   // event only if something changed
store.setPresence('api', true, { instance })        // not logged
store.forgetSession('api', { data: true })          // → { messages, cards, files: [to delete] }
```

**Cards:** each step is an event, and the `cards` row moves in the same transaction.

```js
const { card } = store.askCard({ session: 'api', urgency: 'high', body: { title, body, options, recommended }, blobs: ['files/ab12.png'] })
store.askCard({ session: 'api', kind: 'permission', requestId: 'abcde', body: {…} })   // one card per request id
store.answerCard({ id: card.id, choice: 'tonight', note: 'after the backup', clientId: tapId,
  deliver: { method: 'notifications/claude/channel', params: { content, meta: { kind: 'decision', card_id: card.id, choice: 'tonight' } } } })
store.reopenCard({ id: card.id, deliver: out => ({ method, params }) })   // → { …, previous: { choice, note } }
store.closeCard({ id: card.id, by: 'api', summary: 'ran at 02:00' })
store.withdrawCard({ id: card.id, by: 'api', reason: 'moot' })
store.setUrgency({ id: card.id, by: 'api', urgency: 'critical', reason: 'nothing else left' })
store.expirePermissions('api')                      // when the session's link drops
store.card(id); store.cards({ session, status, before, limit }); store.openCards()
```

`deliver` queues the notification for the agent in the same transaction as the answer, so an answer can never be stored without it. `by` is the session that acts; a card of another session is "not found" for it.

**Messages and status lines**

```js
store.postMessage({ session: 'api', from: 'agent', body: { text, details, attachments }, blobs })
store.postMessage({ session: 'api', from: 'user', body: { text }, clientId, deliver: { method, params } })
store.messages('api', { before, limit })            // newest first
store.setStatus({ session: 'api', id: 'deploy', label: 'Deploy', state: 'decision', detail: '…', cardId: card.id })
store.clearStatus({ session: 'api', id: 'deploy' }) // without id: all lines of the session
```

**Delivery queue** for sessions that are away:

```js
store.enqueue('api', method, params)
for (const d of store.handOver('api')) if (link.send(d.method, d.params)) store.acknowledge(d.id)
// handed over but not acknowledged comes again next time, with d.attempts counted up
```

**Blobs** are files on disk that the store knows by reference; it never reads or writes them.

```js
store.registerBlob({ id: 'files/ab12.png', kind: 'attachment', path: 'files/ab12.png', size, session: 'api', meta: { name: 'shot.png' } })
store.revokeBlob(assetId, { by: 'api' })            // → the file to delete; the message that showed it loses its content
```

**Purge by retention.** The store decides what goes; the caller deletes the files and says so.

```js
const out = store.purge({ days: 30 })               // → { cards, events, deliveries, assets, files: [{ id, path, size }], more }
for (const f of out.files) fs.rmSync(path.join(DATA, f.path), { force: true })
store.confirmDeleted(out.files.map(f => f.id))
store.purge({ days: 30, dryRun: true })             // the same numbers, nothing changed: the admin page's preview
store.doomedFiles()                                 // given up but not confirmed: retry after a crash
```

**Pad:** one row per element, in the shape `client/web/pad/` uses.

```js
store.putElement({ id, type: 'stroke', x, y, w, h, z, group, author: 'phone', data: { tool: 'pen', pts: […] } })
store.putElement({ id, x: 520, ifRev: 3, author: 'phone' })              // change one element; a stale revision is refused
store.elements({ pad: 'global', box: [x0, y0, x1, y1], after: [z, id], limit })
store.elements({ sinceSeq: cursor })                                    // what changed, tombstones included
store.deleteElement(id, { by: 'phone' })                                // → { file: the image to delete, or null }
store.sendElements({ ids: [a, b], session: 'api', by: 'phone', body: { note: 'this button' }, deliver: out => ({ method, params }) })
store.elementLinks({ element: a })                                      // where it was sent, in which revision
```

**Also:** `saveCanvas` / `canvas`, `appendMember` / `memberLog` / `devices`, `putWrappedKey` / `wrappedKeys`, `audit` / `adminLog`, `stats()`, `exportTo(file, { scrub })` (JSON lines; waiting notifications are counted, not exported), `backup(file)`, `checkpoint()`, `tx(fn)` to make several calls one commit.

## Importing today's state

```bash
node server/store/migrate.mjs data --dry-run        # counts only; imports into memory, writes nothing
node server/store/migrate.mjs data data/trommi.db   # the import; run it again and nothing is added
```

It reads `state.json` (and, beside it, file sizes, canvases and `admin-log.jsonl`), accepts every older shape `load()` accepts, compares the result with the source and exits non-zero if they differ. Options: `--owner <id>` for records that name no agent, `--data <dir>` if the files are elsewhere.

## How the server would switch over

Each step leaves a working system and can be undone by switching a flag off.

1. **Dual-write.** The hub opens the store beside `state.json` (`BOARD_STORE=dual`), imports the state once at start, and from then on every mutation in `server.mjs` also calls the matching store method: `addMessage` → `postMessage`, `addCard` → `askCard`, `decide` → `answerCard`, `reopen` → `reopenCard`, the tool cases → `closeCard`, `withdrawCard`, `setUrgency`, `setStatus`, `clearStatus`, `register` / `setProfile` / `/session` / `/star` → `upsertSession`, `deliver` → `enqueue`, `flush` → `handOver` + `acknowledge`, `storeAttachment` / `storeAsset` → `registerBlob`. JSON stays the truth; a store error is logged, never thrown. A check at start and after each purge compares the two (`verify` from `migrate.mjs` does this already) and logs differences. Nothing a user can see changes.
2. **Queue and idempotency from the store.** `state.pending` is dropped in favour of `deliveries`; `/message`, `/decide` and `/reopen` accept a `client_id` from the page and pass it through. This is the first step that fixes a real loss (a notification written after the card).
3. **Read path.** A new endpoint pair, `GET /snapshot` and `GET /events?after=<cursor>` (the SSE stream sends events with their `seq` as SSE `id`, so `Last-Event-ID` is the cursor). The web and iOS clients move from "replace the state" to "apply events"; the old `/events` frame keeps working, built from `snapshot()` plus recent conversation pages, until both clients have moved.
4. **Store is the truth.** `runTool`, `decide`, `reopen`, `purge`, `forgetSession` and the admin routes read from the store; the in-memory `state` object shrinks to presence (`links`) and caches. `state.json` is written one last time as a backup and left alone.
5. **Drop JSON.** Remove `load()`, `save()`, `commit()`'s full frame, and `admin-log.jsonl`. `migrate.mjs` stays for old installations.

Steps 3 and 4 are step 2 of the plan in `docs/krypto-konzept.md` ("event log instead of whole state"); from there the payloads can become ciphertext without touching the schema.

## What stays out of the database

- **File contents:** attachments (up to 1 GB), assets, scribble pictures, canvas documents, pad images, audio. They are streamed with Range requests straight from disk; in a database they would bloat every backup and every checkpoint. The database holds a row per file (`blobs`) and decides when it goes.
- **Secrets:** `token`, `admin-token`, `tinfoil.key`. They must be readable before the database is opened, by spokes too, and must never end up in an export or a backup.
- **`url.txt`:** derived, for a human to `cat`.
- **Presence and links:** who is connected right now lives in memory; the `online` column is only the last known state.
- **The speech cache** (`data/speech`): regenerable, cleaned by age.
- **The hub's stderr log:** a ring buffer in memory; a log that writes to the database it reports on hides exactly the failures it should show.
- **Canvas while drawing:** the document is saved to its file with a delay; only the version and the reference are rows.
- **Search:** not built. FTS5 is compiled in, but it only works on plaintext, which the crypto concept takes away from the hub.
