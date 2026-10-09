// storage-file.ts: the storage adapter for Node (the agent connector). Not exported by index.ts: browsers cannot load node:fs.
//
//   const storage = await fileStorage({ dir, key_file?, prefix? })
//
// dir: created with mode 0700. State lives in memory; on disk it is `<prefix>state.json` (a snapshot) and
// `<prefix>state.log` (a journal: one JSON line per write, [[key, value] | [key]] with [key] a delete), both mode 0600.
// A write resolves once its line is appended and fsynced (write-ahead, R4); the cost is the write's own size, not the
// state's. When the journal outgrows the snapshot (and 1 MiB), the state is written whole (temp file + fsync + rename +
// directory fsync) and the journal emptied. Opening reads the snapshot and replays the journal (a torn last line, from a
// crash in the middle of an append, is dropped: its write never resolved).
// The device key is a 66-byte key file (spec/FORMAT.md §4), mode 0600: `key_file` is a path or a function
// (room_id hex) -> path; default `<dir>/<prefix>device.key`. Several sessions of one room may share `dir` with different
// prefixes.
import fs from 'node:fs/promises'
import path from 'node:path'
import * as z from './crypto/zcrypto.mjs'
import { rangeOf } from './storage-memory.ts'
import type { Storage, StoredDevice } from './types.ts'

type Entry = [string, unknown] | [string]
export interface FileStorage extends Storage {
  file: string
  saveDevice(device: StoredDevice, opts?: { room_id?: string | null }): Promise<void>
  flush(): Promise<void>
}
const errCode = (e: unknown): string | undefined => (e as { code?: string } | null)?.code

export async function fileStorage({ dir, key_file = null, prefix = '' }: { dir?: string; key_file?: string | ((room_id: string | null) => string) | null; prefix?: string } = {}): Promise<FileStorage> {
  if (!dir) throw new z.ZError('bad-argument', 'fileStorage needs a dir')
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await fs.chmod(dir, 0o700).catch(() => {})
  const file = path.join(dir, `${prefix}state.json`), journal = path.join(dir, `${prefix}state.log`)
  const map = new Map<string, any>()
  let snapshotBytes = 0, journalBytes = 0
  try {
    const text = await fs.readFile(file, 'utf8')
    snapshotBytes = text.length
    for (const [k, v] of Object.entries(JSON.parse(text))) map.set(k, v)
  } catch (e) { if (errCode(e) !== 'ENOENT') throw e }
  try {
    const text = await fs.readFile(journal, 'utf8')
    let good = 0
    for (let at = 0, end; (end = text.indexOf('\n', at)) >= 0; at = end + 1) {
      let entries: Entry[]
      try { entries = JSON.parse(text.slice(at, end)) } catch { break }
      for (const e of entries) e.length > 1 ? map.set(e[0], (e as [string, unknown])[1]) : map.delete(e[0])
      good = end + 1
    }
    // A torn last line (a crash in the middle of an append; that write never resolved) is cut off, so the next append
    // starts on a line of its own.
    if (good < text.length) await fs.truncate(journal, Buffer.byteLength(text.slice(0, good)))
    journalBytes = good
  } catch (e) { if (errCode(e) !== 'ENOENT') throw e }

  const syncDir = async () => {
    const dh = await fs.open(dir, 'r')
    try { await dh.sync() } catch (e) { const c = errCode(e); if (c !== 'EINVAL' && c !== 'EISDIR' && c !== 'EPERM') throw e } finally { await dh.close() }
  }
  /** The whole state as the snapshot; the journal starts empty again. */
  const compact = async () => {
    const tmp = `${file}.${process.pid}.tmp`
    const text = JSON.stringify(Object.fromEntries(map))
    const fh = await fs.open(tmp, 'w', 0o600)
    try { await fh.writeFile(text); await fh.sync() } finally { await fh.close() }
    await fs.rename(tmp, file)
    await syncDir()
    snapshotBytes = text.length
    const jh = await fs.open(journal, 'w', 0o600)   // (a crash before this point replays the journal over the new snapshot: the same state)
    try { await jh.sync() } finally { await jh.close() }
    journalBytes = 0
  }
  // Write-ahead (R4): concurrent writers share the next append; a failed write rejects every waiter (the client stops
  // sending).
  let chain: Promise<void> = Promise.resolve(), queued: Promise<void> | null = null, pending: Entry[][] = []
  const writeNow = async () => {
    const lines = pending.map(entries => JSON.stringify(entries)).join('\n') + '\n'
    pending = []
    const fresh = journalBytes === 0
    const jh = await fs.open(journal, 'a', 0o600)
    try { await jh.appendFile(lines); await jh.sync() } finally { await jh.close() }
    if (fresh) await syncDir()   // (the journal's own name, when it was just made)
    journalBytes += lines.length
    if (journalBytes > Math.max(1 << 20, snapshotBytes)) await compact()
  }
  const persist = (entries: Entry[]): Promise<void> => {
    pending.push(entries)
    if (queued) return queued
    queued = chain.then(() => { queued = null; return writeNow() })
    chain = queued.catch(() => {})
    return queued
  }
  const clone = (v: unknown): any => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
  const keyPath = (room_id: string | null): string => {
    const p = typeof key_file === 'function' ? key_file(room_id) : key_file
    return p ?? path.join(dir, `${prefix}device.key`)
  }
  return {
    extractable_keys: true,
    file,
    async get(key) { return clone(map.get(key)) },
    async set(key, value) { const v = clone(value); map.set(key, v); await persist([[key, v]]) },
    async delete(key) { map.delete(key); await persist([[key]]) },
    async setMany(entries) {
      const out: Entry[] = []
      for (const [k, v] of entries) { if (v === undefined) { map.delete(k); out.push([k]) } else { const c = clone(v); map.set(k, c); out.push([k, c]) } }
      if (out.length) await persist(out)
    },
    async keys(p = '') { return [...map.keys()].filter(k => k.startsWith(p)).sort() },
    async range(p, opts = {}) { return rangeOf(map, p, opts).map(([k, v]) => [k, clone(v)]) },
    /** Write the key file (0600). `room_id` (hex) picks the path when key_file is a function. */
    async saveDevice(device, { room_id } = {}) {
      const room = room_id ?? map.get('room')?.room_id ?? null
      const p = keyPath(room)
      await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o700 })
      const tmp = `${p}.${process.pid}.tmp`
      const fh = await fs.open(tmp, 'w', 0o600)
      try { await fh.writeFile(await z.exportDeviceSecret(device)); await fh.sync() } finally { await fh.close() }
      await fs.rename(tmp, p)
      map.set('device_key_file', p); await persist([['device_key_file', p]])
    },
    async loadDevice() {
      const p = map.get('device_key_file') ?? keyPath(map.get('room')?.room_id ?? null)
      let bytes: Uint8Array
      try { bytes = new Uint8Array(await fs.readFile(p)) } catch (e) { if (errCode(e) === 'ENOENT') return null; throw e }
      const st = await fs.stat(p)
      if (st.mode & 0o077) throw new z.ZError('bad-key-file', `${p} is readable by others (mode ${(st.mode & 0o777).toString(8)}); chmod 600`)
      return z.importDeviceSecret(bytes, { extractable: true })
    },
    async flush() { await chain },
    async close() { await chain },   // (flush)
  }
}
