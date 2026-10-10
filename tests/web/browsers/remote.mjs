// remote.mjs: a DEPLOYED app loaded in an engine, read only: the welcome screen and the self-test page
// (/settings/proof), at a desktop's and a phone's width and in a private window. Nothing is typed, no account is made, no screen that asks
// the hub anything is opened; what the app itself requests on those two pages is listed.
//   node tests/web/browsers/run.mjs --browser webkit remote [--app https://app.trommi.com]
import { counted } from './pw.mjs'

export const ownServer = true
const SIZES = [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844, phone: true }], ['private', { width: 1440, height: 900, private: true }]]

/** The proof page as it stands: its first line, its steps, its facts. */
export const readProof = page => page.js(`const root = document.querySelector('.proof')
  return { state: root?.dataset.state ?? null, line: document.getElementById('proof-line')?.textContent.trim() ?? null,
    error: document.getElementById('proof-error')?.textContent.trim() ?? null,
    steps: [...document.querySelectorAll('#proof-steps li')].map(li => li.innerText.replace(/\\s*\\n\\s*/g, ' | ')),
    facts: [...document.querySelectorAll('.proof-facts > div')].map(d => d.innerText.replace(/\\s*\\n\\s*/g, ': ')) }`)

export const steps = SIZES.map(([size, opts]) => [`the deployed app ${size === 'private' ? 'in a private window' : `at a ${size}'s width`}: the welcome screen, then /settings/proof passes`, async ctx => {
  const { check, note } = ctx.run
  const app = (ctx.appUrl ?? 'https://app.trommi.com').replace(/\/$/, '')
  await ctx.within(`remote-${size}`, { ...opts, requests: true }, async (profile, seen) => {
    const page = profile.page
    await page.go(`${app}/`)
    const welcome = await page.until("document.querySelector('#way-create') && document.querySelector('#way-login')", 'the welcome screen', 40000).then(() => true, err => err.message)
    check(welcome === true, 'the welcome screen is drawn', welcome)
    await page.shot(`remote-${size}-welcome`)
    const worker = await page.js("if (!navigator.serviceWorker) return 'no navigator.serviceWorker'; const reg = await Promise.race([navigator.serviceWorker.ready, new Promise(r => setTimeout(() => r(null), 8000))]); return reg ? (reg.active?.state ?? 'no active worker') + ' ' + new URL(reg.active?.scriptURL ?? 'x:/').pathname : 'not ready within 8 s'").catch(err => err.message)
    note(`service worker: ${worker}`)
    await page.go(`${app}/settings/proof`)
    const took = await page.until("['ok', 'fail'].includes(document.querySelector('.proof')?.dataset.state)", 'the self test\'s result', 120000).then(ms => ms, err => err.message)
    const proof = await readProof(page).catch(err => ({ error: err.message }))
    ;(ctx.report.remote ??= {})[size] = { app, welcome, worker, proof }
    check(proof.state === 'ok' && /^OK: /.test(proof.line ?? ''), 'the first line says OK', { took, state: proof.state, line: proof.line, error: proof.error })
    check((proof.steps ?? []).length > 0 && proof.steps.every(s => !/FAIL/.test(s)), 'every step passed', (proof.steps ?? []).filter(s => /FAIL/.test(s)))
    note(`${proof.line} (the page had its result ${typeof took === 'number' ? `${took} ms after it loaded` : took})`)
    for (const step of proof.steps ?? []) note(`  ${step}`)
    for (const fact of proof.facts ?? []) note(`  ${fact}`)
    await page.shot(`remote-${size}-proof`, { full: true })
    const violations = await page.violations()
    check(!violations.length && !seen.csp.length, 'no violation of the policy', [...violations, ...seen.csp])
    check(!seen.exceptions.length, 'no uncaught error', seen.exceptions)
    const elsewhere = counted(seen.requests.filter(r => !r.url.startsWith(app) && !/^(data|blob):/.test(r.url)).map(r => `${r.method} ${new URL(r.url).origin}${new URL(r.url).pathname} → ${r.failed ?? r.status}`))
    note(`requests to other places than the app: ${elsewhere.length ? elsewhere.join(' · ') : 'none'}`)
    for (const [kind, list] of [['console error', seen.errors], ['console warning', seen.warnings], ['failed request', seen.network]]) for (const line of counted(list)) note(`${kind}: ${line}`)
    ctx.report.remote[size].seen = { errors: counted(seen.errors), warnings: counted(seen.warnings), network: counted(seen.network), csp: seen.csp, exceptions: seen.exceptions, elsewhere }
  })
}])
