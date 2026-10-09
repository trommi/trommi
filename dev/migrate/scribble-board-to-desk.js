// One-time move: what is on the 'main' desk's Scribble Board onto another desk's board. Not part of the app, not run
// by CI; run once by hand, in the owner's own browser. Only needed when the desk that should have the drawings is not
// the desk with the id 'main'.
//
// Why: on 8 and 9 October 2026 the room had ONE board, the timeline MAIN_BOARD (shared/scribble.ts), and everything
// was drawn or migrated onto it. Since 9 October every desk has its own board again (deskBoard(desk id)) and MAIN_BOARD
// is the board of the desk 'main'. If the drawings belong to another desk (the owner: "Trommi App"), this script
// copies every shape of MAIN_BOARD onto that desk's board as new strokes items (same place, same z, same pictures),
// checks that they arrived, and then erases them on MAIN_BOARD. Append-only: no envelope is deleted or changed.
// When the named desk IS 'main' it says so and writes nothing.
//
// A second run adds nothing: a shape that is on the target already (the same entry) is not copied again, and a run
// that stopped between copying and erasing is finished by the next one.
//
// Run: open https://app.trommi.com signed in, DevTools -> Console, paste this whole file, then
//   await trommiBoardToDesk({ desk: 'Trommi App', dryRun: true })     // says what it would do, writes nothing
//   await trommiBoardToDesk({ desk: 'Trommi App', dryRun: false })    // the real run
// (desk: the desk's name as the menu shows it, or its id.) Reload the app afterwards.
;(() => {
  const ITEM_BYTES = 40_000   // a strokes item well under the core's 60 KB body limit
  const sleep = ms => new Promise(r => setTimeout(r, ms))

  async function trommiBoardToDesk({ desk = 'Trommi App', dryRun = true, log = console.log } = {}) {
    const t = globalThis.trommi
    if (!t?.client?.loadTimelineAfter || !t.view) throw new Error('open the app signed in, then run this in its console')
    const client = t.client
    const { wire, MAIN_BOARD, deskBoard } = await t.view('whiteboard')
    const { CanvasState, entryOf, chunks } = wire
    const desks = t.model().desks ?? []
    log(`Scribble Board of the desk 'main' onto the desk "${desk}": ${dryRun ? 'DRY RUN, nothing is written' : 'REAL RUN'}`)
    for (const d of desks) log(`  desk ${JSON.stringify(d.name)}  id ${d.id}  board ${deskBoard(d.id)}`)
    const named = desks.filter(d => d.name === desk || d.id === desk)
    if (named.length !== 1) throw new Error(named.length ? `${named.length} desks are called "${desk}": name it by its id` : `no desk is called "${desk}"`)
    const from = MAIN_BOARD, to = deskBoard(named[0].id)
    if (to === from) { log(`"${desk}" is the desk 'main': its board is ${MAIN_BOARD} already. Nothing to do.`); return { moved: 0, nothing_to_do: true } }

    const outboxEmpty = async () => { for (let i = 0; i < 600 && client.model.outbox.length; i++) await sleep(100); if (client.model.outbox.length) throw new Error('the hub has not taken everything yet (offline?): nothing was erased; run again when the app is online') }
    const read = async timeline_id => {
      const st = new CanvasState()
      const items = (await client.loadTimelineAfter(`scribble:${timeline_id}`, 0)).items ?? []
      for (const it of items.sort((a, b) => (a.envelope_number ?? Infinity) - (b.envelope_number ?? Infinity))) if (!it.pending && it.item_state === 'loaded' && it.content) st.apply(it)
      return st
    }
    const same = s => JSON.stringify(entryOf(s))   // (a shape's whole entry: tool, colour, width, points, text, place, picture, z, group)
    const count = st => { const n = {}; for (const s of st.shapes.values()) n[s.tool] = (n[s.tool] ?? 0) + 1; return JSON.stringify(n) }

    const src = await read(from), dst = await read(to)
    const have = new Set([...dst.shapes.values()].map(same))
    const all = [...src.shapes.values()], todo = all.filter(s => !have.has(same(s)))
    log(`  on 'main' (${from}): ${all.length} shapes ${count(src)}`)
    log(`  on "${desk}" (${to}): ${dst.shapes.size} shapes ${count(dst)}`)
    log(`  to copy: ${todo.length}; then to erase on 'main': ${all.length}`)
    if (dryRun) return { moved: 0, would_copy: todo.length, would_erase: all.length }

    // 1. copy
    const entries = todo.map(entryOf)
    for (let at = 0; at < entries.length;) {
      let end = at, size = 0
      while (end < entries.length && (end === at || size + JSON.stringify(entries[end]).length < ITEM_BYTES)) size += JSON.stringify(entries[end++]).length
      await client.sendStrokes({ timeline_id: to, content_type: 'strokes', strokes: entries.slice(at, end) })
      at = end
    }
    await outboxEmpty()
    // 2. check: everything of 'main' is on the target now
    const now = new Set([...(await read(to)).shapes.values()].map(same))
    const missing = all.filter(s => !now.has(same(s)))
    if (missing.length) throw new Error(`${missing.length} shapes did not arrive on "${desk}": nothing was erased; run again`)
    // 3. erase on 'main'
    for (const part of chunks(all.map(s => s.id))) await client.sendStrokes({ timeline_id: from, content_type: 'erase', stroke_ids: part })
    await outboxEmpty()
    log(`  done: ${todo.length} copied, ${all.length} erased on 'main'. Reload the app.`)
    return { moved: all.length, copied: todo.length }
  }
  globalThis.trommiBoardToDesk = trommiBoardToDesk
})()
