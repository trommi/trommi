// "MLS proof" (/settings/proof, the last row of Settings): the Rust core tests itself in this browser and the page
// shows what came of it. One first line (OK or FAIL), then every step with its time, then what ran: the core's
// versions, the app, the browser. "Run again" repeats it, "Copy result" copies the same lines as plain text. The iOS
// app has the same screen at the same place.
//
// The self test runs in a worker of its own (core/proof-worker.ts: its last step derives password keys over 64 MiB,
// never on the page's thread), so the screen needs no room: it also opens by its address on a device that is not logged in
// (proofScreen, from app.mjs's boot), in the demo room, and while the room's own worker is busy. Nothing is sent and
// nothing stored: the only requests are for the app's own files (the worker, the core's .wasm, gen/build.txt for the
// commit this build was made from).
import { CLIENT } from './app.mjs'
import { Controller, controller, copyText, html, settingsPage } from './ui.mjs'

/* global __TROMMI_PROOF_WORKER__ */
// The worker's address: the deployed bundle names its file (dev/build.mjs), the dev server serves the source.
const WORKER = typeof __TROMMI_PROOF_WORKER__ === 'string' ? __TROMMI_PROOF_WORKER__ : '/gen/vendor/proof-worker.mjs'
const TITLE = 'MLS proof'
const RUNNING = 'The Rust core is testing itself…'

/** A time the core measured (microseconds) in milliseconds: one decimal under 100 ms. */
const ms = micros => (micros / 1000).toFixed(micros < 100_000 ? 1 : 0)

/** The commit this build was made from (gen/build.txt), null where the file cannot be read (offline). Asked once. */
let commit = null
const buildCommit = () => (commit ??= fetch('/gen/build.txt').then(r => (r.ok ? r.text() : '')).then(text => /^commit: (\S+)$/m.exec(text)?.[1] ?? null, () => null))

/** What the screen says of one run, for the page and for "Copy result" alike:
 *  { ok, line, error, steps: [{ ok, name, time, detail }], versions: [[label, value, warning?]], here: [[label, value]] }.
 *  result: the worker's one message ({ report, versions } or { error: { code, message } }). */
function account(result, madeFrom) {
  const { report, versions: v, error } = result
  const failed = report?.steps.find(step => !step.ok)
  const line = error ? (error.code === 'core-load' || error.code === 'worker-load' ? 'FAIL: the Rust core did not load' : 'FAIL: the self test stopped')
    : report.ok ? `OK: the Rust core ran ${report.steps.length} steps in ${Math.round(report.micros / 1000)} ms`
    : `FAIL: at "${failed?.name ?? 'an unnamed step'}"`
  const build = document.documentElement.dataset.build
  return {
    ok: Boolean(report?.ok), line,
    error: error ? `${error.message} (${error.code})` : '',
    steps: (report?.steps ?? []).map(step => ({ ok: step.ok, name: step.name, time: `${ms(step.micros)} ms`, detail: step.detail })),
    versions: [
      ...(v ? [['Core', v.core], ['OpenMLS', v.openmls], ['Provider', v.provider], ['Binding', v.binding], ['Recovery', v.recovery, v.recovery !== 'built']] : []),
      ['App', `Trommi ${CLIENT}, build ${build}${madeFrom ? `, commit ${madeFrom}` : ''}`],
    ],
    here: [['Browser', navigator.userAgent], ['Cores', String(navigator.hardwareConcurrency ?? 'unknown')], ['Ran in', "a worker, off the page's thread"]],
  }
}
/** The same as plain text, a line each. */
const asText = a => [
  a.line, ...(a.error ? [a.error] : []),
  ...a.steps.flatMap(step => [`${step.ok ? 'OK' : 'FAIL'}: ${step.name}, ${step.time}`, ...(step.detail ? [`  ${step.detail}`] : [])]),
  ...[...a.versions, ...a.here].map(([label, value]) => `${label}: ${value}`),
].join('\n')

const facts = (title, id, list) => html`<section class="room-section" aria-labelledby="${id}"><h3 id="${id}">${title}</h3><dl class="set-group proof-facts">${list.map(([label, value, warning]) => html`<div${warning ? html` class="is-warning"` : ''}><dt>${label}</dt><dd>${value}</dd></div>`)}</dl></section>`
const shown = a => html`${a.error ? html`<p class="room-error" role="alert" id="proof-error">${a.error}</p>` : ''}
${a.steps.length ? html`<section class="room-section" aria-labelledby="proof-steps-head"><h3 id="proof-steps-head">Steps</h3><ol class="set-group proof-steps" id="proof-steps">${a.steps.map(step => html`<li class="${step.ok ? 'is-ok' : 'is-fail'}"><span class="proof-name">${step.name}${step.detail ? html`<small>${step.detail}</small>` : ''}</span><span class="proof-time"><b>${step.ok ? 'OK' : 'FAIL'}</b> ${step.time}</span></li>`)}</ol></section>` : ''}
${facts('Versions', 'proof-versions-head', a.versions)}
${facts('This browser', 'proof-here-head', a.here)}`

/** The page's main. alone: the screen without a room around it (no Settings to go back to). */
const proofMain = ({ alone = false } = {}) => settingsPage(TITLE, html`<div class="proof" data-controller="proof">
<p class="proof-line room-wait" id="proof-line" role="status" data-proof-target="line">${RUNNING}</p>
<div data-proof-target="out"></div>
<p class="proof-do"><button type="button" class="set-pill" id="proof-again" data-action="proof#run" data-proof-target="again" disabled>Run again</button><button type="button" class="set-pill" id="proof-copy" data-action="proof#copy" data-proof-target="copy" disabled>Copy result</button></p>
${alone ? html`<p class="room-meta"><a href="/">Open Trommi</a></p>` : ''}
</div>`, { lead: 'The encryption core tests itself on this device. Nothing is sent, nothing is stored.', back: !alone })

export function register(t) {
  t.get(/^\/settings\/proof$/, ({ req, res }) => t.page(req, res, { title: `${TITLE} · Settings · Trommi`, view: 'settings-proof', css: 'room', main: proofMain() }))
}

/** The screen on a device without a room (app.mjs boot): a page of its own, as the account screens are. */
export function proofScreen() {
  document.title = `${TITLE} · Trommi`
  const root = document.createElement('div')
  root.id = 'room-screen'
  root.innerHTML = String(proofMain({ alone: true }))
  document.body.replaceChildren(root)
}

controller('proof', class extends Controller {
  static targets = ['line', 'out', 'again', 'copy']

  connect() {
    buildCommit().then(madeFrom => { this.madeFrom = madeFrom; if (this.result) this.paint() })
    this.run()
  }
  disconnect() { this.stop(); clearTimeout(this.timer) }
  stop() { this.worker?.terminate(); this.worker = null }

  /** One run: a new worker, its one message (or its failure to start) is the result. */
  run() {
    this.stop()
    this.result = null
    this.paint()
    const done = result => { this.stop(); this.result = result; this.paint() }
    try {
      this.worker = new Worker(WORKER, { type: 'module', name: 'trommi-proof' })
      this.worker.onmessage = e => done(e.data)
      this.worker.onerror = e => { e.preventDefault(); done({ error: { code: 'worker-load', message: e.message || 'the worker did not start' } }) }
    } catch (err) {
      done({ error: { code: 'worker-load', message: `${err.name}: ${err.message}` } })
    }
  }

  paint() {
    const a = this.result ? account(this.result, this.madeFrom) : null
    const line = this.lineTarget
    line.textContent = a ? a.line : RUNNING
    line.classList.toggle('room-wait', !a)
    line.classList.toggle('is-ok', Boolean(a?.ok))
    line.classList.toggle('is-fail', Boolean(a && !a.ok))
    this.outTarget.innerHTML = a ? String(shown(a)) : ''
    this.element.dataset.state = !a ? 'running' : a.ok ? 'ok' : 'fail'
    this.againTarget.disabled = this.copyTarget.disabled = !a
  }

  async copy() {
    if (!this.result) return
    const ok = await copyText(asText(account(this.result, this.madeFrom)))
    this.copyTarget.textContent = ok ? 'Copied' : 'Not copied'
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.copyTarget.textContent = 'Copy result' }, 1800)
  }
})
