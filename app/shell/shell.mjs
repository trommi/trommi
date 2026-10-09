// The shell's page: starts the app's proof worker (app/web/core/proof-worker.ts), which loads the Rust core, runs
// its self test once and posts one message: { report, versions } or { error: { code, message } }.
/* global __SHELL_WORKER__ */
const $ = id => document.getElementById(id)
const ms = micros => (micros / 1000).toFixed(micros < 100_000 ? 1 : 0)
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e }

function show(result) {
  const { report, versions, error } = result
  const failed = report?.steps.find(step => !step.ok)
  const line = $('line')
  line.textContent = error ? `FAIL: ${error.code === 'core-load' || error.code === 'worker-load' ? 'the Rust core did not load' : 'the self test stopped'} (${error.message})`
    : report.ok ? `OK: the Rust core ran ${report.steps.length} steps in ${Math.round(report.micros / 1000)} ms`
    : `FAIL: at "${failed?.name ?? 'an unnamed step'}"`
  line.className = report?.ok ? 'ok' : 'fail'
  $('steps').replaceChildren(...(report?.steps ?? []).map(step => {
    const li = el('li', null, step.ok ? 'ok' : 'fail')
    const name = el('span', step.name)
    if (step.detail) name.append(el('small', step.detail))
    const time = el('span', null, 'time')
    time.append(el('b', step.ok ? 'OK' : 'FAIL'), ` ${ms(step.micros)} ms`)
    li.append(name, time)
    return li
  }))
  const facts = [
    ...(versions ? [['Core', versions.core], ['OpenMLS', versions.openmls], ['Provider', versions.provider], ['Binding', versions.binding]] : []),
    ['Build', document.documentElement.dataset.build],
    ['Browser', navigator.userAgent],
  ]
  $('facts').replaceChildren(...facts.flatMap(([label, value]) => [el('dt', label), el('dd', value)]))
  document.documentElement.dataset.proof = report?.ok ? 'ok' : 'fail'
  $('again').disabled = false
}

function run() {
  $('again').disabled = true
  $('line').className = ''
  $('line').textContent = 'The Rust core is testing itself…'
  let worker
  try { worker = new Worker(__SHELL_WORKER__, { type: 'module' }) } catch (err) { show({ error: { code: 'worker-load', message: String(err) } }); return }
  worker.onmessage = e => show(e.data)
  worker.onerror = e => { show({ error: { code: 'worker-load', message: e.message || 'the worker did not start' } }); worker.terminate() }
}

$('again').addEventListener('click', run)
run()
