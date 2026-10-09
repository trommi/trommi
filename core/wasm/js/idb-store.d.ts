// The types of the IndexedDB store (idb-store.js).
import type { Store, StoredState, StoreWrite } from './trommi-core.js'

/**
 * A device's store on IndexedDB: one strict transaction per write, the revision compared inside it, and a Web Lock
 * on `name` held from `load` until `close`, so that one tab or worker owns a stored state at a time.
 */
export class IdbStore implements Store {
  /** `name` names the stored state: one per device. With `wait`, `load` waits for the lock instead of failing. */
  constructor(name: string, options?: { wait?: boolean })
  load(): Promise<StoredState>
  apply(write: StoreWrite): Promise<void>
  close(): void
  /** Deletes a stored state for good. StoreConflict while a device has it open. */
  static destroy(name: string): Promise<void>
}
