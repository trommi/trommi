#!/usr/bin/env node
// Shoot every named state of a target in every profile, so that two targets (the Turbo board, the new app) can be
// laid side by side by dev/verify/sbs.mjs.
//   node dev/verify/shoot.mjs --target turbo|app|<file.mjs> --out DIR [--base URL] [--verify-dir DIR]
//        [--start] [--only state1,state2] [--profiles desktop-light,desktop-dark,phone-light,phone-dark] [--hosts "MAP app.trommi.com 1.2.3.4"]
// Writes DIR/<target>/<profile>/<state>.png and DIR/<target>/manifest.json ({ state: { profile: { ok, ms, errors } } }).
// --start: the target starts its own board (turbo: port 8912, fresh for every state that changes the board).
// A state the target does not define is recorded as missing (that is a parity gap in itself).
// The canonical list of states is dev/verify/states.mjs. Needs the command sandbox disabled (Chromium).
import fs from 'node:fs'
import path from 'node:path'
import { STATES } from './states.mjs'
import { PROFILES, arg, loadTarget, openPage, sleep } from './lib.mjs'

const target = await loadTarget(arg('target', 'turbo'))
const out = path.resolve(arg('out', 'verify-shots'), target.name)
const verifyDir = path.resolve(arg('verify-dir', process.env.VERIFY_DIR ?? path.dirname(out)))
const only = (arg('only') ?? '').split(',').filter(Boolean)
const profiles = (arg('profiles') ?? Object.keys(PROFILES).join(',')).split(',')
let ctx = await target.connect({ verifyDir, base: arg('base') ?? undefined, start: process.argv.includes('--start') })
const names = STATES.map(s => s.name).filter(n => !only.length || only.includes(n))
// States that change the board run last, so that the others see the board as it was set up.
names.sort((a, b) => Boolean(target.states[a]?.mutates) - Boolean(target.states[b]?.mutates))
const manifest = fs.existsSync(path.join(out, 'manifest.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')) : {}

// Pass 1: every profile, the states that leave the board as it is. Pass 2: each state that changes the board, on a
// fresh board (target.refresh) per profile, when the target can make one; else after the others.
const calm = names.filter(n => !target.states[n]?.mutates), moving = names.filter(n => target.states[n]?.mutates)
async function shootIn(profile, list) {
  const errors = []
  const h = await openPage({ profile, base: ctx.base, hostRules: arg('hosts') ?? '', errors })
  try {
    await target.prepare(h, ctx, PROFILES[profile])
    for (const name of list) {
      const s = target.states[name]
      manifest[name] ??= {}
      if (!s) { manifest[name][profile] = { ok: false, missing: true }; console.log(`${profile.padEnd(14)} ${name.padEnd(24)} MISSING`); continue }
      if (s.profiles && !s.profiles.includes(profile)) continue
      errors.length = 0
      const t0 = Date.now()
      let ok = false, problem = null
      try {
        if (target.reset) await target.reset(h, ctx, PROFILES[profile])
        ok = Boolean(await h.go(s.path(ctx), s.ready))
        await h.settle?.()
        if (s.act) await s.act(h, ctx)
        await sleep(300)
      } catch (err) { problem = err.message }
      const file = await h.shot(path.join(out, profile, `${name}.png`))
      manifest[name][profile] = { ok: ok && !problem, ms: Date.now() - t0, file: path.relative(path.dirname(out), file), ...(problem ? { problem } : {}), ...(errors.length ? { errors: [...errors] } : {}) }
      console.log(`${profile.padEnd(14)} ${name.padEnd(24)} ${ok && !problem ? 'ok  ' : 'FAIL'} ${Date.now() - t0} ms${problem ? ` ${problem}` : ''}${errors.length ? ` [${errors.length} page errors: ${errors[0].slice(0, 120)}]` : ''}`)
    }
  } finally { await h.close() }
}
for (const profile of profiles) await shootIn(profile, calm)
for (const name of moving) for (const profile of profiles) {
  if (target.refresh) ctx = await target.refresh(ctx)
  await shootIn(profile, [name])
}
await target.close?.(ctx)
fs.mkdirSync(out, { recursive: true })
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 1))
process.exit(0)
