// storage-file.mjs: the storage adapter for Node (the agent connector). Not exported by index.mjs: browsers cannot load node:fs.
//
//   const storage = await fileStorage({ dir, key_file?, prefix? })
//
// dir: created with mode 0700. State lives in memory and is written as one JSON file `<prefix>state.json`
// (durable before a write resolves: temp file + fsync + rename + directory fsync, mode 0600). The device key is a 66-byte key file (shared/crypto/FORMAT.md §4),
// mode 0600: `key_file` is a path or a function (room_id hex) -> path; default `<dir>/<prefix>device.key`.
// Several sessions of one room may share `dir` with different prefixes.
import fs from 'node:fs/promises'
import path from 'node:path'
import * as z from './crypto/zcrypto.mjs'
import { rangeOf } from './storage-memory.mjs'

export async function fileStorage({ dir, key_file = null, prefix = '', write_delay_ms: _ignored = 0 } = {}) {   // write_delay_ms: ignored since writes are write-ahead
  if (!dir) throw new z.ZError('bad-argument', 'fileStorage needs a dir')
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await fs.chmod(dir, 0o700).catch(() => {})
  const file = path.join(dir, `${prefix}state.json`)
  const map = new Map()
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'))
    for (const [k, v] of Object.entries(data)) map.set(k, v)
  } catch (e) { if (e.code !== 'ENOENT') throw e }

  // Write-ahead (R4): every write resolves only once the whole state is on disk: temp file, fsync, rename, fsync of the
  // directory. Concurrent writers share the next write; a failed write rejects every waiter (the client stops sending).
  let chain = Promise.resolve(), queued = null
  const writeNow = async () => {
    const tmp = `${file}.${process.pid}.tmp`
    const fh = await fs.open(tmp, 'w', 0o600)
    try { await fh.writeFile(JSON.stringify(Object.fromEntries(map))); await fh.sync() } finally { await fh.close() }
    await fs.rename(tmp, file)
    const dh = await fs.open(dir, 'r')
    try { await dh.sync() } catch (e) { if (e.code !== 'EINVAL' && e.code !== 'EISDIR' && e.code !== 'EPERM') throw e } finally { await dh.close() }
  }
  const persist = () => {
    if (queued) return queued
    queued = chain.then(() => { queued = null; return writeNow() })
    chain = queued.catch(() => {})
    return queued
  }
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
  const keyPath = room_id => {
    const p = typeof key_file === 'function' ? key_file(room_id) : key_file
    return p ?? path.join(dir, `${prefix}device.key`)
  }
  return {
    extractable_keys: true,
    file,
    async get(key) { return clone(map.get(key)) },
    async set(key, value) { map.set(key, clone(value)); await persist() },
    async delete(key) { map.delete(key); await persist() },
    async setMany(entries) { for (const [k, v] of entries) v === undefined ? map.delete(k) : map.set(k, clone(v)); await persist() },
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
      map.set('device_key_file', p); await persist()
    },
    async loadDevice() {
      const p = map.get('device_key_file') ?? keyPath(map.get('room')?.room_id ?? null)
      let bytes
      try { bytes = new Uint8Array(await fs.readFile(p)) } catch (e) { if (e.code === 'ENOENT') return null; throw e }
      const st = await fs.stat(p)
      if (st.mode & 0o077) throw new z.ZError('bad-key-file', `${p} is readable by others (mode ${(st.mode & 0o777).toString(8)}); chmod 600`)
      return z.importDeviceSecret(bytes, { extractable: true })
    },
    async flush() { await chain },
    async close() { await this.flush() },
  }
}
