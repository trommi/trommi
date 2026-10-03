// Sized variants of the board's stored pictures (docs/turbo.md, "Thumbnails"): /files/<name>?w=<width>.
//
// Node cannot decode or scale a picture, and the hub takes no dependency for it: a tool that is on the machine
// does the work (libvips' vipsthumbnail, else ImageMagick), started with execFile and fixed arguments, never
// through a shell. Without a tool, or when it fails, the caller serves the original. A variant is made on the
// first request, kept in <data>/thumbs and never made twice; requests for the same one share one job.
// Only plain board files: the encrypted assets (/a/…) never come here.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'

/** The widths a variant can have. Any other request gets the nearest of these. */
export const WIDTHS = [160, 320, 640, 1280]
const QUALITY = 82
const MAX_PIXELS = 100e6   // a picture larger than this is not handed to a tool
const NAME = /^[\w-]+\.(?:png|jpe?g|webp|gif)$/i
const HEAD = 256 * 1024    // how much of a file is read to find its size (a JPEG's may stand behind its EXIF block)

// ---- the size of a picture, from its first bytes ----
/** { width, height, type: 'png' | 'jpeg' | 'webp' | 'gif' } of the picture these bytes begin, or null. */
export function imageSize(b) {
  if (!Buffer.isBuffer(b) || b.length < 24) return null
  const ok = (type, width, height) => (width > 0 && height > 0 ? { width, height, type } : null)
  if (b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a && b.toString('latin1', 12, 16) === 'IHDR') return ok('png', b.readUInt32BE(16), b.readUInt32BE(20))
  if (/^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return ok('gif', b.readUInt16LE(6), b.readUInt16LE(8))
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' && b.length >= 30) {
    const chunk = b.toString('latin1', 12, 16)
    if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return ok('webp', b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff)
    if (chunk === 'VP8L' && b[20] === 0x2f) { const bits = b.readUInt32LE(21); return ok('webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1) }
    if (chunk === 'VP8X') return ok('webp', b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1)
    return null
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let turned = false
    for (let at = 2; at + 9 < b.length;) {
      if (b[at] !== 0xff) return null
      const marker = b[at + 1]
      if (marker === 0xff) { at++; continue }                                    // fill bytes
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue }   // markers without a length
      const length = b.readUInt16BE(at + 2)
      if (length < 2) return null
      // The frame header: SOF0…SOF15 without DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = b.readUInt16BE(at + 5), width = b.readUInt16BE(at + 7)
        return turned ? ok('jpeg', height, width) : ok('jpeg', width, height)
      }
      // EXIF orientation 5…8: the picture is shown turned by a quarter, so its sides swap.
      if (marker === 0xe1 && b.toString('latin1', at + 4, at + 10) === 'Exif\0\0') turned = exifTurned(b.subarray(at + 10, Math.min(b.length, at + 2 + length)))
      at += 2 + length
    }
  }
  return null
}
function exifTurned(t) {
  if (t.length < 14) return false
  const little = t.toString('latin1', 0, 2) === 'II'
  const u16 = at => (little ? t.readUInt16LE(at) : t.readUInt16BE(at)), u32 = at => (little ? t.readUInt32LE(at) : t.readUInt32BE(at))
  const dir = u32(4)
  if (dir + 2 > t.length) return false
  for (let i = 0, n = u16(dir); i < n && dir + 14 + i * 12 <= t.length; i++) {
    const entry = dir + 2 + i * 12
    if (u16(entry) === 0x0112) return u16(entry + 8) >= 5 && u16(entry + 8) <= 8
  }
  return false
}
/** The size of a picture file (its first bytes are read), or null if it is none of PNG, JPEG, WebP, GIF or cannot be read. */
export function imageSizeOfFile(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const head = Buffer.alloc(HEAD)
    return imageSize(head.subarray(0, fs.readSync(fd, head, 0, HEAD, 0)))
  } catch { return null } finally { if (fd != null) fs.closeSync(fd) }
}

// ---- sizes for the views (views/picture.mjs): read once per file, kept while the hub runs ----
let filesDir = null
const sizes = new Map()
/** The size of the stored picture behind a /files/ URL, or null. A stored file never changes, so one read is enough. */
export function sizeOfUrl(url) {
  if (!filesDir || typeof url !== 'string' || !url.startsWith('/files/')) return null
  const name = url.slice(7)
  if (!NAME.test(name)) return null
  if (!sizes.has(name)) sizes.set(name, imageSizeOfFile(path.join(filesDir, name)))
  return sizes.get(name)
}

/** The allowed width nearest to what was asked (the smaller one of two that are equally near), or null if that is no number. */
export function snap(asked) {
  const n = Number(asked)
  if (asked == null || asked === '' || !Number.isFinite(n)) return null
  return WIDTHS.reduce((best, w) => (Math.abs(w - n) < Math.abs(best - n) ? w : best))
}

// ---- the tools: the first that is on the machine does the work ----
// (source, type, width, target) -> arguments. "<width>x>" keeps the ratio and only ever shrinks.
const TOOLS = [
  { bin: 'vipsthumbnail', args: (src, type, w, out) => [src, '--size', `${w}x>`, '-o', `${out}[Q=${QUALITY},strip]`] },
  // The format is named, so ImageMagick never picks a decoder by what the file claims to be.
  { bin: 'magick', args: (src, type, w, out) => [`${type}:${src}`, '-auto-orient', '-strip', '-thumbnail', `${w}x>`, '-quality', String(QUALITY), `webp:${out}`] },
]

/**
 * files: the folder of the stored files; cache: the folder for the variants (made here); tools: for tests.
 * Returns { serve(req, res, name, asked) }: answers with the variant and resolves true, or resolves false
 * and has written nothing: the caller then serves the original.
 */
export function createThumbs({ files, cache, tools = TOOLS, parallel = 3 }) {
  filesDir = files
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 })
  const usable = tools.map(t => ({ ...t }))   // a tool that is not installed is dropped at its first use
  const jobs = new Map()                      // cache name -> the promise of the one job making it
  const failed = new Set()                    // variants no tool could make: not tried again until the hub restarts
  let running = 0
  const waiting = []

  // Variants of files that are gone, and what a stopped hub left half-made. Once, off the start-up path.
  fs.promises.readdir(cache).then(list => {
    for (const entry of list) {
      const source = /^(.+)\.\d+\.webp$/.exec(entry)?.[1]
      if (entry.startsWith('tmp-') || !source || !fs.existsSync(path.join(files, source))) fs.promises.rm(path.join(cache, entry), { force: true }).catch(() => {})
    }
  }).catch(() => {})

  const slot = () => (running < parallel ? (running++, Promise.resolve()) : new Promise(go => waiting.push(go)))
  const release = () => { const next = waiting.shift(); if (next) next(); else running-- }
  const exec = (bin, args) => new Promise((resolve, reject) => execFile(bin, args, { timeout: 30000, windowsHide: true, maxBuffer: 1 << 20 }, err => (err ? reject(err) : resolve())))

  async function make(src, type, width, target) {
    await slot()
    const tmp = path.join(cache, `tmp-${crypto.randomBytes(6).toString('hex')}.webp`)
    try {
      for (const tool of [...usable]) {
        try {
          await exec(tool.bin, tool.args(src, type, width, tmp))
          if (imageSize(await fs.promises.readFile(tmp))?.type !== 'webp') throw new Error('no picture came out')
          await fs.promises.chmod(tmp, 0o600)
          await fs.promises.rename(tmp, target)
          return true
        } catch (err) {
          if (err.code === 'ENOENT' && err.syscall?.startsWith('spawn')) usable.splice(usable.indexOf(tool), 1)
          else console.error(`[board] thumbnail: ${tool.bin} failed for ${path.basename(src)} at ${width}: ${String(err.message).split('\n')[0]}`)
        }
      }
      return false
    } finally {
      fs.promises.rm(tmp, { force: true }).catch(() => {})
      release()
    }
  }

  async function serve(req, res, name, asked) {
    const width = snap(asked)
    if (width == null || !NAME.test(name) || !usable.length) return false
    const src = path.join(files, name)
    const size = sizeOfUrl(`/files/${name}`)
    // No variant: not a picture a tool may open, a GIF (it may move), or one too large to hand to a tool.
    if (!size || size.type === 'gif' || size.width * size.height > MAX_PIXELS) return false
    const key = `${name}.${width}.webp`, target = path.join(cache, key)
    if (failed.has(key)) return false
    let stat = await fs.promises.stat(target).catch(() => null)
    if (!stat) {
      if (!fs.existsSync(src)) return false
      if (!jobs.has(key)) jobs.set(key, make(src, size.type, width, target).finally(() => jobs.delete(key)))
      if (!(await jobs.get(key))) { failed.add(key); return false }
      stat = await fs.promises.stat(target).catch(() => null)
      if (!stat) return false
    }
    // A flat drawing can be smaller as it is than its variant: then the original is the lighter answer.
    const whole = await fs.promises.stat(src).catch(() => null)
    if (!whole || stat.size >= whole.size) return false
    const etag = `"${name}-${width}-${stat.size}"`
    const headers = {
      'Cache-Control': 'private, max-age=604800, immutable', ETag: etag,
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'X-Content-Type-Options': 'nosniff',
    }
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return true }
    res.writeHead(200, { ...headers, 'Content-Type': 'image/webp', 'Content-Length': stat.size })
    fs.createReadStream(target).on('error', () => res.destroy()).pipe(res)
    return true
  }
  return { serve, tools: () => usable.map(t => t.bin) }
}
