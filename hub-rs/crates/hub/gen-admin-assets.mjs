// gen-admin-assets.mjs: copy the admin page's stylesheet, script, bell and sprite from hub/admin-view.mjs into
// src/admin_assets.rs, byte for byte (the CSP pins stylesheet and script by hash), and with them the table of what
// each column holds (COLUMN_CLASSES, TABLE_NOTES of hub/store.mjs). Run after changing any of them:
//   node hub-rs/crates/hub/gen-admin-assets.mjs
//   node hub-rs/crates/hub/gen-admin-assets.mjs --check     exits 1 when src/admin_assets.rs is not the current one
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { COLUMN_CLASSES, TABLE_NOTES } from '../../../hub/store.mjs'

const here = path.dirname(new URL(import.meta.url).pathname)
const src = fs.readFileSync(path.join(here, '../../../hub/admin-view.mjs'), 'utf8')
const template = name => {
  const start = src.indexOf(`const ${name} = \``) + `const ${name} = \``.length
  // eslint-disable-next-line no-eval
  return eval(`\`${src.slice(start, src.indexOf('`;', start))}\``)
}
const quoted = name => {
  const start = src.indexOf(`const ${name} = '`) + `const ${name} = '`.length
  return src.slice(start, src.indexOf("';", start))
}
const css = template('CSS'), js = template('JS'), bell = quoted('BELL'), sprite = quoted('SPRITE')
for (const [n, v] of [['CSS', css], ['JS', js], ['BELL', bell], ['SPRITE', sprite]]) if (v.includes('"##')) throw new Error(`${n} contains "##`)
const lit = text => JSON.stringify(text)     // a JSON string is a Rust string literal for this text (ASCII and plain UTF-8, no \u escapes needed)
const classes = Object.entries(COLUMN_CLASSES).flatMap(([table, cols]) => Object.entries(cols).map(([col, [cls, note]]) => `    (${lit(table)}, ${lit(col)}, ${lit(cls)}, ${lit(note)}),`))
const notes = Object.entries(TABLE_NOTES).map(([table, note]) => `    (${lit(table)}, ${lit(note)}),`)
const out = `// Generated from hub/admin-view.mjs (CSS, JS, BELL, SPRITE: the same bytes, so the CSP hashes match) and from
// hub/store.mjs (COLUMN_CLASSES, TABLE_NOTES: what each column of hub.db holds). Do not edit.
// Regenerate: node hub-rs/crates/hub/gen-admin-assets.mjs
pub const CSS: &str = r##"${css}"##;
pub const JS: &str = r##"${js}"##;
pub const BELL: &str = r##"${bell}"##;
pub const SPRITE: &str = r##"${sprite}"##;
/// (table, column, class, note); class: e2e (end-to-end encrypted), plain (the hub reads it), hash (hash, salt or signature).
pub const COLUMN_CLASSES: &[(&str, &str, &str, &str)] = &[
${classes.join('\n')}
];
/// (table, note)
pub const TABLE_NOTES: &[(&str, &str)] = &[
${notes.join('\n')}
];
`
const file = path.join(here, 'src/admin_assets.rs')
if (process.argv.includes('--check')) {
  if (fs.readFileSync(file, 'utf8') !== out) { console.error('hub-rs/crates/hub/src/admin_assets.rs is stale: run node hub-rs/crates/hub/gen-admin-assets.mjs'); process.exit(1) }
} else {
  fs.writeFileSync(file, out)
  const sha = t => crypto.createHash('sha256').update(t).digest('base64')
  console.log(`src/admin_assets.rs: CSS sha256-${sha(css)}, JS sha256-${sha(js)}, ${classes.length} columns`)
}
