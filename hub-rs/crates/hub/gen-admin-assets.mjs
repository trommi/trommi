// gen-admin-assets.mjs: copy the admin page's stylesheet, script and bell from hub/admin-view.mjs into
// src/admin_assets.rs, byte for byte (the CSP pins both by hash). Run after changing them in admin-view.mjs:
//   node hub-rs/crates/hub/gen-admin-assets.mjs
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const here = path.dirname(new URL(import.meta.url).pathname)
const src = fs.readFileSync(path.join(here, '../../../hub/admin-view.mjs'), 'utf8')
const template = name => {
  const start = src.indexOf(`const ${name} = \``) + `const ${name} = \``.length
  // eslint-disable-next-line no-eval
  return eval(`\`${src.slice(start, src.indexOf('`;', start))}\``)
}
const css = template('CSS'), js = template('JS')
const b = src.indexOf("const BELL = '") + "const BELL = '".length
const bell = src.slice(b, src.indexOf("';", b))
for (const [n, v] of [['CSS', css], ['JS', js], ['BELL', bell]]) if (v.includes('"##')) throw new Error(`${n} contains "##`)
const out = `// Generated from hub/admin-view.mjs (CSS, JS, BELL): the same bytes, so the CSP hashes match.
// Regenerate: node hub-rs/crates/hub/gen-admin-assets.mjs
pub const CSS: &str = r##"${css}"##;
pub const JS: &str = r##"${js}"##;
pub const BELL: &str = r##"${bell}"##;
`
fs.writeFileSync(path.join(here, 'src/admin_assets.rs'), out)
const sha = t => crypto.createHash('sha256').update(t).digest('base64')
console.log(`src/admin_assets.rs: CSS sha256-${sha(css)}, JS sha256-${sha(js)}`)
