// private.mjs: the same ground in what each engine has for a PRIVATE window (pw.mjs says how each is opened):
// the probe of engine.mjs, and the binding's test page with the real core (scenario, kill, store). IndexedDB and Web
// Locks are where private windows have differed from normal ones.
// What is opened is the engine's private STORAGE: for WebKit an ephemeral session, for Chromium an off-the-record
// profile, for Firefox a real private window. The private window of Safari on an iPhone or a Mac is the same engine with a real
// person's settings (Lockdown Mode, content blockers, "Prevent cross-site tracking"): not this.
import { probeChecks, probeIn, probeNotes } from './engine.mjs'
import { runCase } from './bindings.mjs'

const PRIVATE = { private: true }

export const steps = [
  ['a private window: the engine under the app\'s policy, page and module worker', async ctx => {
    const { check, note } = ctx.run
    await ctx.within('private-probe', PRIVATE, async profile => {
      const found = await probeIn(profile, `${ctx.server.origin}/probe`)
      ctx.report.probe = found
      for (const [ok, what, seen] of probeChecks(found)) check(ok, what, seen)
      for (const line of probeNotes(found)) note(line)
      // what tells this window from a normal one, as far as a page can see
      const signs = await profile.page.js("return { serviceWorker: !!navigator.serviceWorker, persisted: await navigator.storage?.persisted?.().catch(e => e.name), persist: await Promise.race([navigator.storage?.persist?.().catch(e => e.name), new Promise(r => setTimeout(() => r('no answer in 3 s'), 3000))]), databases: typeof indexedDB.databases, cookies: navigator.cookieEnabled, localStorage: (() => { try { localStorage.setItem('probe', '1'); localStorage.removeItem('probe'); return true } catch (e) { return e.name } })() }")
      ctx.report.signs = signs
      note(`what the page sees of this window: ${JSON.stringify(signs)}`)
      if (profile.isPrivate) check(profile.isPrivate(), 'what the page stored lies in the profile\'s private storage only (the window is a private one)')
    })
  }],
  ...['scenario', 'kill', 'store'].map(what => [`a private window: the binding's test page: ${what}`, async ctx => {
    const { check, note } = ctx.run
    const result = await runCase(ctx, what, PRIVATE)
    ;(ctx.report.bindings ??= {})[what] = result
    check(result.ok === true, 'the case passes', Object.fromEntries(Object.entries(result).filter(([k]) => !['console'].includes(k))))
    check((result.violations ?? []).length === 0, 'no violation of the policy', result.violations)
    check(result.console.length === 0, 'nothing on the console', result.console)
    note(JSON.stringify(Object.fromEntries(Object.entries(result).filter(([k]) => !['console', 'violations', 'contentType', 'load'].includes(k)))))
  }]),
]
