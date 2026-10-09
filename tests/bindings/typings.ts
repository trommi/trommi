// The TypeScript declarations of the browser binding, used as an app would: `tsc` must accept this file under the
// strictest settings (tests/bindings/tsconfig.json). It is compiled, never run.
import {
  Device, FileDecryptor, FileEncryptor, TrommiError, init, logFinding, selfTest, sessionGroupId,
  type ErrorCode, type LogEntry, type OutboxEntry, type Store, type StoredState, type StoreWrite,
} from '../../core/wasm/js/trommi-core.js'
import { IdbStore } from '../../core/wasm/js/idb-store.js'

/** A store of the host's own satisfies the interface. */
class OwnStore implements Store {
  async load(): Promise<StoredState> { return { revision: 0, entries: [] } }
  async apply(write: StoreWrite): Promise<void> { void write.expectedRevision }
}

export async function use(hubCode: string, entry: LogEntry): Promise<void> {
  await init(fetch('/gen/app/trommi_core_wasm_bg.wasm', { integrity: 'sha256-…' }))
  const report = selfTest(Date.now())
  const line: string = report.steps.map(step => `${step.ok ? 'OK' : 'FAIL'} ${step.name} ${step.micros / 1000} ms`).join('\n')
  void line

  const device: Device = await Device.open(new IdbStore('device'))
  const other: Device = await Device.create(new OwnStore())
  const room: Uint8Array | null = await device.room()
  if (!room) return
  const session = await device.foundSession(await other.id(), [await other.keyPackage(Date.now())], Date.now())
  const key: Uint8Array = await device.contentKey(sessionGroupId(room, session), 1)
  void key

  const outbox: OutboxEntry[] = await device.outbox()
  for (const waiting of outbox) {
    // A hub's code is text until it is known to be one of the codes.
    const code = hubCode as ErrorCode
    if (waiting.kind === 'commit') await device.outboxRefused(waiting.id, code)
    else await device.outboxAccepted(waiting.id, null)
  }
  try {
    const processed = await device.processLogEntry(entry)
    if (processed.kind === 'message' && processed.message?.kind === 'workTrail') void processed.message.payload
  } catch (error) {
    if (error instanceof TrommiError && logFinding(error.code) === 'badGroup') throw error
  }

  const encryptor = new FileEncryptor()
  const stored: Uint8Array[] = [encryptor.update(new Uint8Array(10))]
  const end = encryptor.finish()
  const decryptor = new FileDecryptor(end.file)
  for (const piece of [...stored, end.stored]) decryptor.update(piece)
  decryptor.finish()
  await device.close()

  // @ts-expect-error a count is a number, not a bigint
  await device.outboxAccepted(1n)
  // @ts-expect-error there is no such code
  await device.outboxRefused(1, 'no-such-code')
  // @ts-expect-error a device is not constructed directly
  new Device()
}
