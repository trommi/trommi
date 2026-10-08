// ts.mjs: a TypeScript module of this repository as browser JavaScript, for the places that serve sources one file
// each (app/web/dev/build.mjs for the dev server's gen/vendor/, shared/browser-test.mjs). Node 26 runs .ts itself and
// esbuild bundles it, so this is only about serving one file: the types are erased (the code is erasable-only, see
// tsconfig.json), nothing else changes. esbuild when it is installed (with an inline source map, so the browser shows
// the .ts source), else Node's own stripTypeScriptTypes (blanks the types in place: the lines stay where they were).
//   import { toJs, renameTs } from '../dev/ts.mjs'
//   toJs(source, 'shared/codec.ts')        -> JavaScript
//   renameTs(js, '.mjs')                   -> its relative imports of './x.ts' as './x.mjs'
import module from 'node:module'

const esbuild = await import('esbuild').catch(() => null)

/** The JavaScript of a TypeScript module (file: its name, for messages and the source map). */
export function toJs(source, file = 'module.ts', { sourcemap = true } = {}) {
  if (esbuild) return esbuild.transformSync(source, { loader: 'ts', format: 'esm', target: 'es2022', sourcefile: file, sourcemap: sourcemap ? 'inline' : false, tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } } }).code
  const warn = process.emitWarning
  process.emitWarning = (w, ...a) => (String(w).includes('stripTypeScriptTypes') ? undefined : warn.call(process, w, ...a))   // (experimental: one warning per process)
  try { return module.stripTypeScriptTypes(source, { mode: 'strip' }) } finally { process.emitWarning = warn }
}

/** Relative module addresses ending in .ts (static imports and exports, import('…')) given another extension. */
export const renameTs = (js, ext) => js
  .replace(/(\b(?:from|import)\s*)(['"])(\.{1,2}\/[^'"]+?)\.ts\2/g, (_, head, q, spec) => `${head}${q}${spec}${ext}${q}`)
  .replace(/(\bimport\(\s*)(['"])(\.{1,2}\/[^'"]+?)\.ts\2/g, (_, head, q, spec) => `${head}${q}${spec}${ext}${q}`)
