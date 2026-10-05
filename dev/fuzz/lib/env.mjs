// env.mjs: load the code under test from a root directory (default: this repository; --root for a pinned clone).
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import fs from 'node:fs'
import { execSync } from 'node:child_process'

export const FUZZ_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
export const REPO_ROOT = path.dirname(path.dirname(FUZZ_DIR))

const cache = new Map()
export async function loadTarget(root = REPO_ROOT) {
  root = path.resolve(root)
  if (cache.has(root)) return cache.get(root)
  const imp = rel => import(pathToFileURL(path.join(root, rel)).href)
  const [hubMod, core, mem, file, zc, zh, store] = await Promise.all([
    imp('hub/server.mjs'), imp('shared/index.mjs'), imp('shared/storage-memory.mjs'),
    imp('shared/storage-file.mjs').catch(() => null), imp('shared/crypto/zcrypto.mjs'), imp('shared/crypto/hub.mjs'), imp('hub/store.mjs'),
  ])
  const codec = await imp('shared/codec.mjs')
  const t = { root, startHub: hubMod.startHub, LIMITS: hubMod.LIMITS, core, memoryStorage: mem.memoryStorage, fileStorage: file?.fileStorage, z: zc, hubLib: zh, store, codec,
    commit: (() => { try { return execSync('git rev-parse --short HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch { return 'unknown' } })(),
    // features of the target that may land during the night
    features: { sessionKeys: typeof core.Client?.prototype?.assignSession === 'function' } }
  cache.set(root, t)
  return t
}
function safeRead(p) { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
