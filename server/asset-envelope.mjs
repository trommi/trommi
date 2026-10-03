// The asset envelope: what turns a page or a file into ciphertext and a link.
// Shared by the channel process (server.mjs, hub or spoke) and by
// dev/session.mjs, so that whoever stands beside the agent encrypts, and the
// hub only ever stores and serves ciphertext.
//
// A page or a file the agent publishes under a link. Whoever has the link and
// is signed in to the board can open it; someone outside needs a release, with
// a link of its own (/r/<id>#<key>). The key stands behind the # of the link,
// which a browser never sends.
//
// The blob, version 1:
//   "ZWA1" | nonce, 12 bytes | AES-256-GCM ciphertext | tag, 16 bytes
//   associated data: "ZWA1/" + asset id, so a blob opens only under its own address
//   plaintext: header length (uint32, big endian) | header, JSON | content | zeros
//   header: { v: 1, type, title, name, mime, size, created }
// The zeros pad the plaintext to a step, so the length says little about the
// content. Each asset has a key and a nonce of its own, used once. One piece,
// not the 64 KiB chunks docs/krypto-konzept.md plans for attachments: the viewer
// decrypts in memory, which is why assets have a size limit of their own.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// ---- file types: what an extension is shown as, and served as -------------

export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif'])
export const VIDEO_EXT = new Set(['.mp4', '.m4v', '.webm', '.mov'])
export const AUDIO_EXT = new Set(['.mp3', '.m4a', '.wav', '.ogg', '.flac'])
export const HTML_EXT = new Set(['.html', '.htm'])
export const kindOf = ext => (IMAGE_EXT.has(ext) ? 'image' : VIDEO_EXT.has(ext) ? 'video' : AUDIO_EXT.has(ext) ? 'audio' : 'file')
export const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.json': 'application/json',
  '.mjs': 'text/javascript; charset=utf-8', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
}

// ---- the envelope ---------------------------------------------------------

// An asset is decrypted in the browser's memory in one piece, so it stays far smaller than an attachment.
export const MAX_ASSET = Number(process.env.BOARD_MAX_ASSET_MB || 64) * 1024 * 1024
export const ASSET_TYPES = ['html', 'image', 'video', 'audio', 'file']
export const ASSET_LABEL = { html: 'HTML page', image: 'Image', video: 'Video', audio: 'Audio', file: 'File' }
export const ASSET_MAGIC = Buffer.from('ZWA1')
// 128 random bits in base64url: the address cannot be guessed, and it cannot name a path.
export const ASSET_ID = /^[A-Za-z0-9_-]{22}$/
export const ASSET_KEY = /^[A-Za-z0-9_-]{43}$/

// Padmé: at most about 12 % on top, and only log(log(size)) bits of the length left to see.
export function padded(size) {
  const e = Math.floor(Math.log2(size))
  const step = 2 ** (e - Math.floor(Math.log2(e)) - 1)
  return Math.max(1024, Math.ceil(size / step) * step)
}
export const ASSET_BLOB_MAX = padded(MAX_ASSET + 4096) + 64

// What publish_asset was given, as the bytes to encrypt and what to say about them inside the envelope.
export function readAsset(args) {
  const file = typeof args.path === 'string' && args.path ? path.resolve(args.path) : null
  if (file ? args.content != null : typeof args.content !== 'string') throw new Error('give either path (a file) or content (a string)')
  if (file && !fs.statSync(file).isFile()) throw new Error(`not a file: ${args.path}`)
  if ((file ? fs.statSync(file).size : Buffer.byteLength(args.content)) > MAX_ASSET) throw new Error(`asset larger than ${MAX_ASSET / 1024 / 1024} MB`)
  const ext = file ? path.extname(file).toLowerCase() : ''
  const type = args.type ?? (!file || HTML_EXT.has(ext) ? 'html' : kindOf(ext))
  if (!ASSET_TYPES.includes(type)) throw new Error(`type must be one of ${ASSET_TYPES.join(', ')}; got ${JSON.stringify(type)}`)
  const name = file ? path.basename(file) : type === 'html' ? 'page.html' : 'asset.txt'
  const mime = type === 'html' ? 'text/html' : MIME[ext]?.split(';')[0] ?? (file ? 'application/octet-stream' : 'text/plain')
  const title = String(args.title ?? '').trim().slice(0, 200) || name
  return { meta: { type, title, name, mime }, content: file ? fs.readFileSync(file) : Buffer.from(args.content) }
}

// A fresh id, a fresh key, and the blob only that key opens under that id.
export function sealAsset(meta, content) {
  const id = crypto.randomBytes(16).toString('base64url')
  const key = crypto.randomBytes(32)
  const nonce = crypto.randomBytes(12)
  const header = Buffer.from(JSON.stringify({ v: 1, ...meta, size: content.length, created: Date.now() }))
  const length = Buffer.alloc(4)
  length.writeUInt32BE(header.length)
  const size = 4 + header.length + content.length
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(`ZWA1/${id}`))
  const sealed = [length, header, content, Buffer.alloc(padded(size) - size)].map(part => cipher.update(part))
  return { id, key: key.toString('base64url'), blob: Buffer.concat([ASSET_MAGIC, nonce, ...sealed, cipher.final(), cipher.getAuthTag()]) }
}

// Everything publish_asset does before the hub is involved: read, encrypt, and
// say what the hub is told. It is handed the key only for an asset it has to
// show on the board; of a silent one it learns the address and the size.
export function prepareAsset(args) {
  const { meta, content } = readAsset(args)
  const { id, key, blob } = sealAsset(meta, content)
  const silent = args.silent === true
  const shown = silent ? {} : { type: meta.type, title: meta.title, note: String(args.note ?? '').trim().slice(0, 2000), key }
  return { id, key, blob, meta, record: { id, keep: args.keep === true, silent, ...shown } }
}

// How a process that is not the hub hands the hub an asset: POST route, with x-board-token added by the caller.
export const assetUpload = (session, instance, record, blob) => ({
  route: `/agent/asset?${new URLSearchParams({ id: session, instance })}`,
  headers: { 'Content-Type': 'application/octet-stream', 'x-asset': Buffer.from(JSON.stringify(record)).toString('base64url') },
  body: blob,
})

export const assetLink = (base, id, key) => `${base}/a/${id}#${key}`
