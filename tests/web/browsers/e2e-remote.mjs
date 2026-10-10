// e2e-remote.mjs: tests/web/e2e/remote.mjs (sign-up, kit, reload, proof, log out/in, join by link with the emoji, a
// note both ways, a file, a desk, a third device by password, forgot password on a second account) against a
// DEPLOYED app and hub, driven in this engine instead of Chromium. It makes two e2e-<random>@example.invalid accounts
// there, as remote.mjs says; read it before pointing it at a hub that is not yours.
//   node tests/web/browsers/run.mjs --browser firefox e2e-remote [--app https://app.trommi.com] [--hub https://hub.trommi.com]
import { openProfile } from './pw.mjs'

export const ownServer = true
export const steps = [['the deployed app end to end (tests/web/e2e/remote.mjs), each of its steps below', async ctx => {
  const { runRemote } = await import('../e2e/remote.mjs')
  const code = await runRemote({ app: ctx.appUrl ?? 'https://app.trommi.com', hub: ctx.hubUrl ?? 'https://hub.trommi.com', shots: ctx.out, open: (name, seen) => openProfile(ctx.engine, name, seen) })
  ctx.run.check(code === 0, 'every step of the remote run passed (its lines are above)', code)
}]]
