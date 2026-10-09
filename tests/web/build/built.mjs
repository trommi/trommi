// built.mjs: the web app as its build makes it, written into a folder outside the repository, for the tests that need
// the built app on disk (build.test.mjs compares two of them, wasm-load.mjs and measure.mjs serve one).
// It is what `node app/web/dev/build.mjs --write` leaves in public/, without touching public/: the files of public/ as
// they are, and over them everything generate() returns.
//   node tests/web/build/built.mjs <folder>      (as a command: one build into <folder>, which must not exist or be empty)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generate, coreFiles, coreFromPkg } from '../../../app/web/dev/build.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.join(HERE, '..', '..', '..')
const PUBLIC = path.join(REPO, 'app', 'web', 'public')
/** What an earlier --write may have left in public/: never part of a build. */
const LEFT_BEHIND = /^(gen\/|demo\/fixture\.json$|demo\/files\/)/

/** A new empty folder for one test run, under the system's temporary folder (TMPDIR moves it). */
export const tempDir = name => fs.mkdtempSync(path.join(os.tmpdir(), `trommi-${name}-`))

/** One build into `dir`: { out } as generate() returned it. */
export async function writeBuilt(dir) {
  const made = await generate()
  fs.mkdirSync(dir, { recursive: true })
  if (fs.readdirSync(dir).length) throw new Error(`${dir} is not empty`)
  fs.cpSync(PUBLIC, dir, { recursive: true, filter: src => !LEFT_BEHIND.test(path.relative(PUBLIC, src).split(path.sep).join('/') + (fs.statSync(src).isDirectory() ? '/' : '')) })
  for (const [f, content] of Object.entries(made.out)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), content) }
  return made
}

/** The probe worker (probe-worker.mjs: core-wasm.ts and nothing else of the app) as one file, into
 *  <dir>/test/probe-worker.mjs: bundled with the build's own constants (the .wasm's address and hash) and the
 *  binding's scripts inside it, as the build bundles the app's worker. Needed as long as the app's worker does not
 *  load the Rust core itself. Returns its address. */
export async function writeProbe(dir) {
  const esbuild = await import('esbuild')
  const core = coreFiles(REPO)
  if (!fs.existsSync(path.join(dir, core.wasm))) throw new Error(`${dir} is not this checkout's build: ${core.wasm} is missing`)
  const made = await esbuild.build({
    entryPoints: [path.join(HERE, 'probe-worker.mjs')], bundle: true, format: 'esm', minify: true, write: false, target: ['es2022'], logLevel: 'silent',
    plugins: [coreFromPkg(REPO)], define: core.define,
  })
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'test', 'probe-worker.mjs'), made.outputFiles[0].text)
  return '/test/probe-worker.mjs'
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dir = process.argv[2]
  if (!dir) { console.error('usage: node tests/web/build/built.mjs <folder>'); process.exit(2) }
  await writeBuilt(path.resolve(dir))
}
