// e2e-remote.mjs: tests/web/e2e/remote.mjs (sign-up, kit, reload, proof, log out/in, join by link with the emoji, a
// note both ways, a file, a desk, a third device by password, forgot password on a second account) against a
// DEPLOYED app and hub, driven in this engine instead of Chromium. It makes two e2e-<random>@example.invalid accounts
// there, as remote.mjs says; read it before pointing it at a hub that is not yours.
//   node tests/web/browsers/run.mjs --browser firefox e2e-remote [--app https://app.trommi.com] [--hub https://hub.trommi.com]
// remote.mjs is taken as it is; only its `openProfile` (Chromium's, from harness.mjs) is swapped for this engine's: a
// copy of it is written under TMP with that one import changed (the file in tests/web/e2e stays untouched).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { TMP, cannot } from './pw.mjs'

export const ownServer = true
const E2E = path.join(path.dirname(fileURLToPath(import.meta.url)), '../e2e')

async function remoteIn(engine) {
  const source = fs.readFileSync(path.join(E2E, 'remote.mjs'), 'utf8')
  const was = "import { openProfile, run, sleep, TMP, watch } from './harness.mjs'"
  if (!source.includes(was)) throw cannot(`tests/web/e2e/remote.mjs no longer has the line this mode changes: ${was}`)
  const at = rel => JSON.stringify(pathToFileURL(path.join(E2E, rel)).href)
  const pw = JSON.stringify(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'pw.mjs')).href)
  const copy = source
    .replace(was, `import { run, sleep, TMP, watch } from ${at('harness.mjs')}\nimport { openProfile as openIn } from ${pw}\nconst openProfile = (name, seen) => openIn(${JSON.stringify(engine)}, name, seen)`)
    .replace(/from '\.\/(real|ui)\.mjs'/g, (_, f) => `from ${at(`${f}.mjs`)}`)
  const file = path.join(TMP, `e2e-remote-${engine}.mjs`)
  fs.mkdirSync(TMP, { recursive: true })
  fs.writeFileSync(file, copy)
  return import(pathToFileURL(file).href)
}

export const steps = [['the deployed app end to end (tests/web/e2e/remote.mjs), each of its steps below', async ctx => {
  const { runRemote } = await remoteIn(ctx.engine)
  const code = await runRemote({ app: ctx.appUrl ?? 'https://app.trommi.com', hub: ctx.hubUrl ?? 'https://hub.trommi.com', shots: ctx.out })
  ctx.run.check(code === 0, 'every step of the remote run passed (its lines are above)', code)
}]]
