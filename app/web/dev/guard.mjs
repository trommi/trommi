// guard.mjs: the argument check every browser test and measuring script runs first, so that a mistyped option never
// starts a run, least of all one against the public app.
//   1. Only the options the script names are taken; an unknown one, a bare word or --help prints the usage and exits
//      before anything is started (exit 0 for --help/-h, 2 otherwise).
//   2. A target that is not this machine or a private network (an --app/--hub/... URL, or a --resolve rule naming
//      a public host) is refused unless --i-mean-production is given too.
// Both spellings are understood: `--name value` and `--name=value`.
//
//   import { guard } from './guard.mjs'
//   guard({ usage: 'node dev/x.mjs [--hub URL]', values: ['hub'], flags: ['quick'], targets: ['hub'] })

const PROD_FLAG = 'i-mean-production'

/** Whether a URL (or a bare host) points at this machine or a private network (the word 'local' does too). */
function isLocal(target) {
  const t = String(target ?? '').trim()
  if (!t || t === 'local') return true
  let host
  try { host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `http://${t}`).hostname } catch { return false }
  host = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0') return true
  const ip = host.split('.').map(Number)
  if (ip.length === 4 && ip.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a, b] = ip
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127)
  }
  return false
}

/**
 * Checks process.argv against what the script takes. Returns { name: value } (a flag: true).
 * values: options that take a value; flags: options without one; targets: the value options that name a hub or app
 * (checked by isLocal); resolve: the option holding Chromium host-resolver rules ("MAP host ip, …").
 */
export function guard({ usage, values = [], flags = [], targets = [], resolve = null, argv = process.argv.slice(2) }) {
  const takes = new Set(values), plain = new Set([...flags, PROD_FLAG])
  const out = {}
  const stop = (code, why) => {
    if (why) console.error(`${why}\n`)
    console.error(`usage: ${usage}\n  options: ${[...values.map(v => `--${v} <value>`), ...flags.map(f => `--${f}`)].join(' ') || '(none)'}\n  a target off this machine also needs --${PROD_FLAG}`)
    process.exit(code)
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') stop(0)
    if (!a.startsWith('--')) stop(2, `unknown argument: ${a}`)
    const eq = a.indexOf('=')
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2)
    if (takes.has(name)) {
      if (eq > 0) out[name] = a.slice(eq + 1)
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[name] = argv[++i]
      else stop(2, `--${name} needs a value`)
    } else if (plain.has(name) && eq < 0) out[name] = true
    else stop(2, `unknown option: --${name}`)
  }
  const far = targets.filter(t => out[t] != null && !isLocal(out[t])).map(t => `--${t} ${out[t]}`)
  if (resolve && out[resolve] && /trommi\.com/i.test(out[resolve])) far.push(`--${resolve} (maps a production host)`)
  if (far.length && !out[PROD_FLAG]) stop(2, `refused: ${far.join(', ')} is not this machine. Add --${PROD_FLAG} to really run against it.`)
  return out
}
