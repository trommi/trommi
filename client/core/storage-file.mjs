// storage-file.mjs: the storage adapter for Node (the agent channel). Not exported by index.mjs: browsers cannot load node:fs.
//
//   const storage = await fileStorage({ dir, key_file?, prefix? })
//
// dir: created with mode 0700. State lives in memory and is written as one JSON file `<prefix>state.json`
// (atomic: temp file + rename, mode 0600, debounced). The device key is a 66-byte key file (crypto/FORMAT.md §4),
// mode 0600: `key_file` is a path or a function (room_id hex) -> path; default `<dir>/<prefix>device.key`.
// Several sessions of one room may share `dir` with different prefixes.
import fs from 'node:fs/promises'
import path from 'node:path'
import * as z from './zcrypto.mjs'
import { rangeOf } from './storage-memory.mjs'

export async function fileStorage({ dir, key_file = null, prefix = '', write_delay_ms = 100 } = {}) {
  if (!dir) throw new z.ZError('bad-argument', 'fileStorage needs a dir')
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await fs.chmod(dir, 0o700).catch(() => {})
  const file = path.join(dir, `${prefix}state.json`)
  const map = new Map()
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'))
    for (const [k, v] of Object.entries(data)) map.set(k, v)
  } catch (e) { if (e.code !== 'ENOENT') throw e }

  let timer = null, writing = Promise.resolve(), dirty = false
  const flushNow = async () => {
    timer = null
    if (!dirty) return
    dirty = false
    const tmp = `${file}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(map)), { mode: 0o600 })
    await fs.rename(tmp, file)
  }
  const schedule = () => {
    dirty = true
    if (!timer) timer = setTimeout(() => { writing = writing.then(flushNow, flushNow) }, write_delay_ms)
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
    async set(key, value) { map.set(key, clone(value)); schedule() },
    async delete(key) { map.delete(key); schedule() },
    async setMany(entries) { for (const [k, v] of entries) v === undefined ? map.delete(k) : map.set(k, clone(v)); schedule() },
    async keys(p = '') { return [...map.keys()].filter(k => k.startsWith(p)).sort() },
    async range(p, opts = {}) { return rangeOf(map, p, opts).map(([k, v]) => [k, clone(v)]) },
    /** Write the key file (0600). `room_id` (hex) picks the path when key_file is a function. */
    async saveDevice(device, { room_id } = {}) {
      const room = room_id ?? map.get('room')?.room_id ?? null
      const p = keyPath(room)
      await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o700 })
      const tmp = `${p}.${process.pid}.tmp`
      await fs.writeFile(tmp, await z.exportDeviceSecret(device), { mode: 0o600 })
      await fs.rename(tmp, p)
      map.set('device_key_file', p); schedule()
    },
    async loadDevice() {
      const p = map.get('device_key_file') ?? keyPath(map.get('room')?.room_id ?? null)
      let bytes
      try { bytes = new Uint8Array(await fs.readFile(p)) } catch (e) { if (e.code === 'ENOENT') return null; throw e }
      const st = await fs.stat(p)
      if (st.mode & 0o077) throw new z.ZError('bad-key-file', `${p} is readable by others (mode ${(st.mode & 0o777).toString(8)}); chmod 600`)
      return z.importDeviceSecret(bytes, { extractable: true })
    },
    async flush() { if (timer) { clearTimeout(timer); writing = writing.then(flushNow, flushNow) } await writing },
    async close() { await this.flush() },
  }
}
