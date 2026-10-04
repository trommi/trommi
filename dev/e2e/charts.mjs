// charts.mjs: static SVG charts for docs/perf-night.md from the load runs' files (timeline.jsonl, hub-metrics.jsonl,
// app-perf.json). Plain SVG strings, no dependency; one y-axis per chart, small multiples instead of two scales.
//   node dev/e2e/charts.mjs --out=docs/perf --run=<load out dir>[,<label>] ... --app=<app-perf.json> ...
import fs from 'node:fs'
import path from 'node:path'
import { readJsonl } from './lib.mjs'

// palette: reference categorical slots 1-3 (validated adjacent and all-pairs), text tokens, light surface
const C = { s1: '#2a78d6', s2: '#eb6834', s3: '#1baf7a', ink: '#0b0b0b', ink2: '#52514e', grid: '#e4e3df', surface: '#fcfcfb', budget: '#52514e' }
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
const nice = v => { const p = 10 ** Math.floor(Math.log10(v || 1)); const m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p }
const fmt = v => (v >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${+(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k` : `${+v.toFixed(v < 10 ? 1 : 0)}`)

/**
 * A line chart. series: [{ label, color, points: [[x, y]] }]. One y axis. Direct labels at the line ends,
 * plus a legend row for two or more series.
 */
export function lineChart({ title, subtitle = '', xLabel, yLabel, series, width = 760, height = 300, yMax = null, xFmt = fmt, marks = [] }) {
  const m = { l: 56, r: 110, t: 66, b: 44 }
  const W = width - m.l - m.r, H = height - m.t - m.b
  const xs = series.flatMap(s => s.points.map(p => p[0])), ys = series.flatMap(s => s.points.map(p => p[1]))
  const x0 = Math.min(...xs), x1 = Math.max(...xs)
  const step = nice((yMax ?? Math.max(...ys) * 1.05) / 4)
  const top = yMax ?? step * 4
  const X = x => m.l + ((x - x0) / (x1 - x0 || 1)) * W, Y = y => m.t + H - (Math.min(y, top) / top) * H
  const ticks = Math.round(top / (yMax ? yMax / 4 : step))
  let g = ''
  for (let i = 0; i <= ticks; i++) {
    const v = (top / ticks) * i
    g += `<line x1="${m.l}" x2="${m.l + W}" y1="${Y(v)}" y2="${Y(v)}" stroke="${C.grid}" stroke-width="1"/><text x="${m.l - 8}" y="${Y(v) + 4}" text-anchor="end" font-size="11" fill="${C.ink2}">${fmt(v)}</text>`
  }
  const xstep = nice((x1 - x0) / 5)
  for (let v = Math.ceil(x0 / xstep) * xstep; v <= x1; v += xstep) {
    g += `<text x="${X(v)}" y="${m.t + H + 18}" text-anchor="middle" font-size="11" fill="${C.ink2}">${esc(xFmt(v))}</text>`
  }
  for (const mk of marks) g += `<line x1="${X(mk.x)}" x2="${X(mk.x)}" y1="${m.t}" y2="${m.t + H}" stroke="${C.ink2}" stroke-dasharray="3 3" stroke-width="1"/><text x="${X(mk.x) + 4}" y="${m.t + 12}" font-size="10" fill="${C.ink2}">${esc(mk.label)}</text>`
  let lines = '', labels = ''
  const ends = []
  for (const s of series) {
    if (!s.points.length) continue
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('')
    lines += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`
    const last = s.points.at(-1)
    ends.push({ x: X(last[0]) + 6, y: Y(last[1]) + 4, label: s.label })
  }
  ends.sort((a, b) => a.y - b.y)
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13
  for (const e of ends) labels += `<text x="${e.x}" y="${e.y}" font-size="11" fill="${C.ink}">${esc(e.label)}</text>`
  const legend = series.length > 1 ? series.map((s, i) => `<g transform="translate(${m.l + i * 170},${m.t - 16})"><rect width="12" height="3" y="-4" rx="1.5" fill="${s.color}"/><text x="18" y="0" font-size="11" fill="${C.ink2}">${esc(s.label)}</text></g>`).join('') : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" role="img" aria-label="${esc(title)}">
<rect width="100%" height="100%" fill="${C.surface}"/>
<text x="${m.l}" y="20" font-size="14" font-weight="600" fill="${C.ink}">${esc(title)}</text>
<text x="${m.l}" y="34" font-size="11" fill="${C.ink2}">${esc(subtitle)}</text>
${legend}${g}${lines}${labels}
<line x1="${m.l}" x2="${m.l + W}" y1="${m.t + H}" y2="${m.t + H}" stroke="${C.ink2}" stroke-width="1"/>
<text x="${m.l + W / 2}" y="${height - 8}" text-anchor="middle" font-size="11" fill="${C.ink2}">${esc(xLabel)}</text>
<text transform="translate(14,${m.t + H / 2}) rotate(-90)" text-anchor="middle" font-size="11" fill="${C.ink2}">${esc(yLabel)}</text>
</svg>`
}

/** Horizontal bars, grouped by row, with a budget line. rows: [{ label, values: [v | null per group] }], groups: [{ label, color }] */
export function barChart({ title, subtitle = '', rows, groups, budget = null, unit = 'ms', width = 760, xMax = null }) {
  const barH = 9, gap = 2, rowH = groups.length * (barH + gap) + 12
  const m = { l: 220, r: 60, t: 84, b: 34 }
  const height = m.t + rows.length * rowH + m.b
  const W = width - m.l - m.r
  const all = rows.flatMap(r => r.values).filter(v => v != null)
  const top = xMax ?? nice(Math.max(...all, budget ?? 0) * 1.1)
  const X = v => m.l + (Math.min(v, top) / top) * W
  let g = ''
  for (let i = 0; i <= 4; i++) { const v = (top / 4) * i; g += `<line x1="${X(v)}" x2="${X(v)}" y1="${m.t - 4}" y2="${height - m.b}" stroke="${C.grid}"/><text x="${X(v)}" y="${height - m.b + 16}" text-anchor="middle" font-size="11" fill="${C.ink2}">${fmt(v)}</text>` }
  rows.forEach((r, i) => {
    const y = m.t + i * rowH
    g += `<text x="${m.l - 8}" y="${y + rowH / 2}" text-anchor="end" font-size="11" fill="${C.ink}">${esc(r.label)}</text>`
    r.values.forEach((v, k) => {
      if (v == null) return
      const by = y + 4 + k * (barH + gap), w = Math.max(2, X(v) - m.l)
      g += `<path d="M${m.l},${by}h${w - 4}a4,4 0 0 1 4,4v${barH - 8}a4,4 0 0 1 -4,4h${-(w - 4)}z" fill="${groups[k].color}"/><text x="${m.l + w + 4}" y="${by + barH - 1}" font-size="10" fill="${C.ink2}">${v > top ? '› ' : ''}${fmt(v)}</text>`
    })
  })
  if (budget != null) g += `<line x1="${X(budget)}" x2="${X(budget)}" y1="${m.t - 8}" y2="${height - m.b}" stroke="${C.budget}" stroke-width="1.5" stroke-dasharray="4 3"/><text x="${X(budget) + 4}" y="${m.t - 10}" font-size="10" fill="${C.ink2}">Budget ${budget} ${unit}</text>`
  const legend = groups.map((s, i) => `<g transform="translate(${16 + i * 170},${56})"><rect width="12" height="8" y="-7" rx="2" fill="${s.color}"/><text x="18" y="0" font-size="11" fill="${C.ink2}">${esc(s.label)}</text></g>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" role="img" aria-label="${esc(title)}">
<rect width="100%" height="100%" fill="${C.surface}"/>
<text x="16" y="20" font-size="14" font-weight="600" fill="${C.ink}">${esc(title)}</text>
<text x="16" y="34" font-size="11" fill="${C.ink2}">${esc(subtitle)}</text>
${legend}${g}</svg>`
}

export const COLORS = C

// ---- CLI: the night's figures --------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = n => process.argv.filter(a => a.startsWith(`--${n}=`)).map(a => a.slice(n.length + 3))
  const out = arg('out')[0] ?? 'docs/perf'
  fs.mkdirSync(out, { recursive: true })
  const runs = arg('run').map(s => { const [dir, label] = s.split(','); return { dir, label: label ?? path.basename(dir) } })
  for (const r of runs) {
    const tl = readJsonl(path.join(r.dir, 'timeline.jsonl'))
    const hm = readJsonl(path.join(r.dir, 'hub-metrics.jsonl'))
    if (!tl.length) continue
    const t0 = tl[0].at, min = t => (t - t0) / 60000
    const smooth = (rows, f, k = 10) => rows.map((row, i) => { const w = rows.slice(Math.max(0, i - k + 1), i + 1).map(f).filter(v => v != null); return [min(row.at), w.length ? w.reduce((a, b) => a + b, 0) / w.length : null] }).filter(p => p[1] != null)
    fs.writeFileSync(path.join(out, `${r.label}-ingest.svg`), lineChart({ title: 'Ingest: envelopes accepted per second', subtitle: `${r.label} · 10 s mean`, xLabel: 'minutes', yLabel: 'envelopes/s', series: [{ label: 'accepted/s', color: C.s1, points: smooth(tl, x => x.acked_per_s) }] }))
    fs.writeFileSync(path.join(out, `${r.label}-latency.svg`), lineChart({ title: 'Delivery latency (seal → stream at another member)', subtitle: `${r.label} · per second, 10 s mean`, xLabel: 'minutes', yLabel: 'ms', yMax: 1000, series: [{ label: 'p50', color: C.s1, points: smooth(tl, x => x.lat_p50) }, { label: 'p99', color: C.s2, points: smooth(tl, x => x.lat_p99) }] }))
    if (hm.length) {
      fs.writeFileSync(path.join(out, `${r.label}-memory.svg`), lineChart({ title: 'Hub memory against envelopes stored', subtitle: `${r.label} · sampled every 5 s`, xLabel: 'envelopes in the hub', yLabel: 'MB', series: [{ label: 'RSS', color: C.s1, points: hm.map(x => [x.envelopes, x.rss_mb]) }, { label: 'JS heap used', color: C.s2, points: hm.map(x => [x.envelopes, x.heap_used_mb]) }] }))
    }
  }
  console.log(`charts in ${out}`)
}

/** Render SVG files to PNG (2x) in headless Chromium (for the board card). Needs the sandbox off. */
export async function toPng(svgFiles) {
  const { launchChromium } = await import('../cdp.mjs')
  const b = await launchChromium({ width: 800, height: 600 })
  const page = await b.page()
  await page.send('Page.enable')
  const out = []
  for (const f of svgFiles) {
    const svg = fs.readFileSync(f, 'utf8')
    const [, w, h] = /viewBox="0 0 (\d+) (\d+)"/.exec(svg)
    await page.send('Emulation.setDeviceMetricsOverride', { width: Number(w), height: Number(h), deviceScaleFactor: 2, mobile: false })
    await page.send('Page.navigate', { url: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` })
    await new Promise(r => setTimeout(r, 400))
    const s = await page.send('Page.captureScreenshot', { format: 'png' })
    const png = f.replace(/\.svg$/, '.png')
    fs.writeFileSync(png, Buffer.from(s.data, 'base64'))
    out.push(png)
  }
  await b.close()
  return out
}
if (import.meta.url === `file://${process.argv[1]}` && process.argv.includes('--png')) {
  const dir = process.argv.find(a => a.startsWith('--out='))?.slice(6) ?? 'docs/perf'
  console.log(await toPng(fs.readdirSync(dir).filter(f => f.endsWith('.svg')).map(f => path.join(dir, f))))
}
