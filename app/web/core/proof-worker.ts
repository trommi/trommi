// proof-worker.ts: the worker behind the "MLS proof" screen (public/proof.mjs). It loads the Rust core, runs the
// core's own self test once, says what came of it, and ends. Nothing else: no room, no store, no hub.
//
// Why a worker of its own and not a call to the core worker: the screen must work where that one does not run or is
// busy (no room on this device, the demo room, a room that is catching up), and the self test's last step derives
// password keys with Argon2id over 64 MiB, which must never run on the page's thread.
//
// What it loads: its own file (the build bundles it with the binding's scripts, app/web/dev/build.mjs) and the
// core's .wasm, fetched by core-wasm.ts with the SHA-256 the build gave it. No other request leaves it.
//
// It posts exactly one message, then closes:
//   { report, versions }              the self test ran (report.ok says whether every step passed)
//   { error: { code, message } }      the core did not load (`core-load`), or the self test itself threw (the core's
//                                     error code, `internal` when it has none)
import { loadCore } from './core-wasm.ts'
import type { Core, SelfTestReport, Versions } from './core-api.ts'

/** The one message this worker posts. */
export type ProofResult = { report: SelfTestReport; versions: Versions } | { error: { code: string; message: string } }

const said = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err))

async function prove(): Promise<ProofResult> {
  let core: Core
  try { core = await loadCore() } catch (err) { return { error: { code: 'core-load', message: said(err) } } }
  try { return { report: core.selfTest(Date.now()), versions: core.versions() } } catch (err) { return { error: { code: core.errorCode(err) ?? 'internal', message: said(err) } } }
}

postMessage(await prove())
close()
