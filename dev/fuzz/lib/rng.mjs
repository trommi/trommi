// rng.mjs: seeded PRNG (sfc32) so every random choice of a run is reproducible from its seed string.
function xmur3(str) {
  let h = 1779033703 ^ str.length
  for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19) }
  return () => { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return (h ^= h >>> 16) >>> 0 }
}
export function makeRng(seed) {
  const s = xmur3(String(seed))
  let a = s(), b = s(), c = s(), d = s()
  const next = () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0
    let t = (a + b) | 0
    a = b ^ (b >>> 9); b = (c + (c << 3)) | 0; c = (c << 21) | (c >>> 11); d = (d + 1) | 0
    t = (t + d) | 0; c = (c + t) | 0
    return (t >>> 0) / 4294967296
  }
  for (let i = 0; i < 12; i++) next()
  const rng = {
    next,
    int: (n) => Math.floor(next() * n),                       // 0..n-1
    range: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: p => next() < p,
    pick: arr => arr[Math.floor(next() * arr.length)],
    weighted(entries) {                                        // [[value, weight], ...]
      let total = 0
      for (const [, w] of entries) total += w
      let r = next() * total
      for (const [v, w] of entries) { r -= w; if (r < 0) return v }
      return entries[entries.length - 1][0]
    },
    shuffle(arr) { const a2 = [...arr]; for (let i = a2.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [a2[i], a2[j]] = [a2[j], a2[i]] } return a2 },
    bytes(n) { const u = new Uint8Array(n); for (let i = 0; i < n; i++) u[i] = Math.floor(next() * 256); return u },
    word: () => rng.pick(['alpha', 'beta', 'gamma', 'delta', 'omega', 'kiwi', 'lemon', 'mango', 'tau', 'ümlaut', '日本', 'emoji😀', 'quote"s', "ap'os", 'back\\slash', '<b>x</b>', 'nul\u0000x', 'ok']),
    fork: label => makeRng(`${seed}/${label}`),
  }
  return rng
}
