// QR codes for pairing, self-contained (no CDN, no dependency): qrSvg(text) draws the invite link as an SVG (byte mode,
// error correction M, versions 1-40, the mask with the lowest penalty), scanQr(video) reads one with the browser's
// BarcodeDetector where it exists. The encoder follows ISO/IEC 18004 as Project Nayuki's reference describes it.

const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28]
const BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49]
const FORMAT_M = 0

const rawModules = v => { let r = (16 * v + 128) * v + 64; if (v >= 2) { const n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36 } return r }
const dataCodewords = v => Math.floor(rawModules(v) / 8) - ECC_PER_BLOCK[v] * BLOCKS[v]
const bit = (x, i) => ((x >>> i) & 1) !== 0

function gfMul(x, y) { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x } return z }
function rsDivisor(degree) {
  const r = new Array(degree).fill(0); r[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) { r[j] = gfMul(r[j], root); if (j + 1 < r.length) r[j] ^= r[j + 1] }
    root = gfMul(root, 0x02)
  }
  return r
}
function rsRemainder(data, div) {
  const r = div.map(() => 0)
  for (const b of data) { const f = b ^ r.shift(); r.push(0); div.forEach((c, i) => { r[i] ^= gfMul(c, f) }) }
  return r
}

function alignmentPositions(v) {
  if (v === 1) return []
  const n = Math.floor(v / 7) + 2
  const step = v === 32 ? 26 : Math.ceil((v * 4 + 4) / (n * 2 - 2)) * 2
  const r = [6]
  for (let pos = v * 4 + 10; r.length < n; pos -= step) r.splice(1, 0, pos)
  return r
}

/** The modules of a QR code for `text` (UTF-8, byte mode, level M): an array of rows of booleans. */
export function qrMatrix(text) {
  const bytes = [...new TextEncoder().encode(text)]
  let v = 1
  for (; v <= 40; v++) if (4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= dataCodewords(v) * 8) break
  if (v > 40) throw new Error('too long for a QR code')
  const cap = dataCodewords(v) * 8
  const bits = []
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1) }
  push(4, 4); push(bytes.length, v < 10 ? 8 : 16); for (const b of bytes) push(b, 8)
  push(0, Math.min(4, cap - bits.length)); push(0, (8 - bits.length % 8) % 8)
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) push(pad, 8)
  const data = []
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0))

  // Error correction, split into blocks and interleaved.
  const nb = BLOCKS[v], eccLen = ECC_PER_BLOCK[v], raw = Math.floor(rawModules(v) / 8)
  const short = nb - raw % nb, shortLen = Math.floor(raw / nb), div = rsDivisor(eccLen)
  const blocks = []
  for (let i = 0, k = 0; i < nb; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < short ? 0 : 1)); k += dat.length
    const ecc = rsRemainder(dat, div)
    if (i < short) dat.push(0)
    blocks.push(dat.concat(ecc))
  }
  const words = []
  for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= short) words.push(b[i]) })

  const size = v * 4 + 17
  const mod = Array.from({ length: size }, () => new Array(size).fill(false))
  const fn = Array.from({ length: size }, () => new Array(size).fill(false))
  const set = (x, y, dark) => { mod[y][x] = dark; fn[y][x] = true }
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0) }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4)
    }
  }
  const al = alignmentPositions(v), last = al.length - 1
  al.forEach((ax, i) => al.forEach((ay, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
  }))
  const format = mask => {
    const d = (FORMAT_M << 3) | mask
    let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537)
    const b = ((d << 10) | r) ^ 0x5412
    for (let i = 0; i <= 5; i++) set(8, i, bit(b, i))
    set(8, 7, bit(b, 6)); set(8, 8, bit(b, 7)); set(7, 8, bit(b, 8))
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(b, i))
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(b, i))
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(b, i))
    set(8, size - 8, true)
  }
  format(0)
  if (v >= 7) {
    let r = v; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25)
    const b = (v << 12) | r
    for (let i = 0; i < 18; i++) { const a = size - 11 + i % 3, c = Math.floor(i / 3); set(a, c, bit(b, i)); set(c, a, bit(b, i)) }
  }
  // The data, in the zigzag of two-module columns.
  for (let right = size - 1, i = 0; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert
      if (!fn[y][x] && i < words.length * 8) { mod[y][x] = bit(words[i >>> 3], 7 - (i & 7)); i++ }
    }
  }
  const MASKS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
    (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0]
  const applyMask = m => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[m](x, y)) mod[y][x] = !mod[y][x] }
  // Penalty (runs, 2x2 blocks, balance; the finder-look rule left out: any mask reads, this only picks a calmer one).
  const penalty = () => {
    let p = 0, dark = 0
    for (let y = 0; y < size; y++) {
      for (let x = 0, runX = 0, runY = 0; x < size; x++) {
        runX = x && mod[y][x] === mod[y][x - 1] ? runX + 1 : 1; if (runX === 5) p += 3; else if (runX > 5) p++
        runY = x && mod[x][y] === mod[x - 1][y] ? runY + 1 : 1; if (runY === 5) p += 3; else if (runY > 5) p++
        if (mod[y][x]) dark++
        if (x && y && mod[y][x] === mod[y][x - 1] && mod[y][x] === mod[y - 1][x] && mod[y][x] === mod[y - 1][x - 1]) p += 3
      }
    }
    return p + Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10
  }
  let best = 0, bestP = Infinity
  for (let m = 0; m < 8; m++) { applyMask(m); format(m); const p = penalty(); if (p < bestP) { best = m; bestP = p } applyMask(m) }
  applyMask(best); format(best)
  return mod
}

/** An SVG of the QR code (dark modules on white, with the quiet zone), scalable; `label` for screen readers. */
export function qrSvg(text, label = 'QR-Code') {
  const m = qrMatrix(text), n = m.length + 8
  let d = ''
  m.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x + 4} ${y + 4}h1v1h-1z` }))
  return `<svg class="qr" viewBox="0 0 ${n} ${n}" role="img" aria-label="${label}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`
}

/** Can this browser read QR codes from the camera? */
export async function canScan() {
  try { return 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia && (await BarcodeDetector.getSupportedFormats()).includes('qr_code') } catch { return false }
}

/** Read QR codes from the back camera into `video` until onText returns true or stop() is called. */
export async function scanQr(video, onText) {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
  video.srcObject = stream
  video.setAttribute('playsinline', '')
  await video.play()
  const detector = new BarcodeDetector({ formats: ['qr_code'] })
  let on = true
  const stop = () => { on = false; for (const t of stream.getTracks()) t.stop(); video.srcObject = null }
  const tick = async () => {
    if (!on) return
    try { for (const c of await detector.detect(video)) if (await onText(c.rawValue)) return stop() } catch {}
    setTimeout(tick, 180)
  }
  tick()
  return stop
}
