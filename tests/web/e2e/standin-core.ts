// standin-core.ts: what the stand-in end-to-end run (standin.mjs) puts in the place of app/web/core/core-wasm.ts when
// it bundles the app's worker (harness.mjs `standInWorker`). TEST ONLY. The product has no switch for this: the test
// builds the app the normal way and then replaces the ONE worker file with a bundle of the same entry
// (app/web/core/core-worker.ts) in which every import of core-wasm.ts resolves to this module.
//
// It has core-wasm.ts's two exports:
//   loadCore()   the STAND-IN core of tests/web/stand-in/core.ts over the real WASM binding, loaded in the browser the
//                way core-wasm.ts loads it (the .wasm fetched with the integrity the build names). Devices, groups,
//                Commits, Welcomes, the hub sign-in, files, share links, the account and recovery are the binding's;
//                stored content (cards, chats, notes, registers, the board) and the invite handshake are plain JSON
//                WITHOUT cryptography. Nothing a run on this module shows is evidence about content encryption.
//   IdbStore     the binding's store, unchanged but for two things the stand-in needs:
//                - it remembers the name it was last loaded under, because the stand-in keeps its own state in a
//                  SECOND store beside the device's (`<name>:stand-in`) and is handed the app's wrapped store, which
//                  does not say its name. One worker holds one device, so "the last one loaded" is that device's;
//                - destroy(name) deletes that second store too, so logging out leaves nothing of the stand-in behind.
import * as binding from '../../../core/wasm/js/trommi-core.js'
import { IdbStore as BindingStore } from '../../../core/wasm/js/idb-store.js'
import type { Core } from '../../../app/web/core/core-api.ts'
import { standInCore } from '../stand-in/core.ts'

declare const __TROMMI_CORE_WASM__: string
declare const __TROMMI_CORE_WASM_SHA256__: string

const standInName = (name: string): string => `${name}:stand-in`
let lastLoaded: string | null = null

export class IdbStore extends BindingStore {
  readonly #name: string
  constructor(name: string, opts: { wait?: boolean } = {}) {
    super(name, opts)
    this.#name = name
  }
  override async load(): ReturnType<BindingStore['load']> {
    const stored = await super.load()
    lastLoaded = this.#name
    return stored
  }
  static override async destroy(name: string): Promise<void> {
    await BindingStore.destroy(name)
    await BindingStore.destroy(standInName(name))
  }
}

let loading: Promise<Core> | null = null
export function loadCore(): Promise<Core> {
  loading ??= (async () => {
    await binding.init(fetch(__TROMMI_CORE_WASM__, { integrity: `sha256-${__TROMMI_CORE_WASM_SHA256__}` }))
    return standInCore(binding, {
      stateStore: () => {
        if (lastLoaded === null) throw new Error('the stand-in was asked for a device before any store was loaded')
        return new BindingStore(standInName(lastLoaded))
      },
    })
  })().catch(err => { loading = null; throw err })
  return loading
}
