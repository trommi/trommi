// admin-view.mjs: the HTML of the read-only admin page (hub/admin.mjs does login, sessions and routing).
//
//   /       overview: tiles (big number + sparkline) and charts of the host and the hub, 1 h / 24 h / 7 d
//   /data   data browser: a tree on the left (global tables, rooms → members, envelopes by kind and timeline,
//           objects, attachments, keys, invites, account), a paged, sortable, filterable table on the right and,
//           with a row selected, every column of it plus the decoded cleartext envelope header and links to
//           related rows.
//   /test-accounts  the throwaway accounts of old e2e runs (email ending in @example.org) and a "Delete these N test
//           rooms" form that needs the number typed; the deletion itself is the hub's (hub/ops/delete-room.mjs).
//
// What never leaves this module in full: ciphertext, signed blobs and secrets (OPAQUE_COLUMN and every BLOB that
// is not a device id) are shown as size + first 16 bytes hex. Opaque columns can neither be filtered, sorted nor
// searched (no oracle on e-mail addresses). The encrypted body is never decoded; the envelope
// header is cleartext by design (the hub routes by it) and is decoded without any key.
// No external assets, no framework: one stylesheet and one small script, both pinned by hash in the CSP.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostStats, openSeries } from './ops/metrics.mjs';
import { COLUMN_CLASSES, TABLE_NOTES } from './store.mjs';
import { peekEnvelope, joinEnvelope } from '../shared/crypto/zcrypto.mjs';
import { KIND_NAME, OBJECT_STATE_NAME, URGENCY_NAME, TIMELINE_KIND_NAME } from '../shared/codec.ts';

export const PAGE_SIZE = 50;
const COUNT_CAP = 10000;
const TZ = process.env.ADMIN_TZ || 'Europe/Berlin';

// Columns whose content is ciphertext, signed blobs or secrets: never shown in full.
// escrow_id, key_escrow: the removed password escrow's table, left in databases from before (the id was a passphrase verifier).
export const OPAQUE_COLUMN = /^(encrypted_body|key_sealed|key_back_link|envelope_header|envelope_nonce|envelope_signature|subscription|endpoint|access_token.*|signed_.*|.*_signature|escrow_id|key_escrow|.*_secret.*|.*_hash|.*_salt|.*_wrapped|.*_token|email)$/;
// Device ids are public (the member list names them); as BLOBs they are shown in full hex so they can be linked.
const DEVICE_COLUMN = /(^|_)device_id$/;

// ---------- small helpers ----------

export function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;
const isBytes = (v) => v instanceof Uint8Array;
const hexOf = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('hex');
/** A value as plain text for links and filters: bytes as hex. */
const plain = (v) => (isBytes(v) ? hexOf(v) : String(v));
export const isOpaque = (column) => OPAQUE_COLUMN.test(column);

function opaqueBytes(value) {
  if (isBytes(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const text = String(value);
  if (/^[A-Za-z0-9_-]+$/.test(text)) return Buffer.from(text, 'base64url');
  return Buffer.from(text, 'utf8');
}

/** One stored value as HTML: NULL, opaque (size + 16 bytes hex), a device id in hex, or escaped text (max 300 chars). */
export function renderCell(column, value) {
  if (value === null || value === undefined) return '<span class="null">NULL</span>';
  if (isBytes(value) && DEVICE_COLUMN.test(column) && !isOpaque(column) && value.byteLength <= 64) return `<span class="id">${hexOf(value)}</span>`;
  if (isBytes(value) || isOpaque(column)) {
    const bytes = opaqueBytes(value);
    const hex = bytes.subarray(0, 16).toString('hex');
    return `<span class="opaque">${bytes.length} B · ${hex}${bytes.length > 16 ? '…' : ''}</span>`;
  }
  const text = String(value);
  return esc(text.length > 300 ? `${text.slice(0, 300)}…` : text);
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '?';
  if (Math.abs(n) < 1024) return `${Math.round(n)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n; let i = -1;
  do { v /= 1024; i += 1; } while (Math.abs(v) >= 1024 && i < units.length - 1);
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
const fmtNum = (n, digits = 0) => (Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 }) : '–');
const short = (id, n = 8) => (id.length > n + 2 ? `${id.slice(0, n)}…` : id);

const dateFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const timeFmt = new Intl.DateTimeFormat('de-DE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('de-DE', { timeZone: TZ, weekday: 'short', day: '2-digit', month: '2-digit' });
const dayTimeFmt = new Intl.DateTimeFormat('de-DE', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit' });
const isTime = (column, value) => /(_at|^sent_at|^time)$/.test(column) && typeof value === 'number' && value > 1e11 && value < 1e14;

function fileSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}
function dirSize(dir, budget = { entries: 200_000 }) {
  let total = 0;
  let list;
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of list) {
    if (--budget.entries < 0) break;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full, budget);
    else if (entry.isFile()) total += fileSize(full);
  }
  return total;
}

// Counts are cached for a few seconds: the tree asks for many of them on every page.
const caches = new WeakMap();
function cached(db, key, ms, fn) {
  let countCache = caches.get(db);
  if (!countCache) caches.set(db, countCache = new Map());
  const hit = countCache.get(key);
  const t = Date.now();
  if (hit && hit.until > t) return hit.value;
  const value = fn();
  countCache.set(key, { until: t + ms, value });
  if (countCache.size > 5000) countCache.clear();
  return value;
}

// ---------- page frame ----------

const CSS = `
/* The look of the web app: colours, type, radii and the ink focus ring are copied from app/web/public/app.css
   (:root and :root[data-theme="dark"]), the three fonts are its fonts/f1, f7, f3 (served by this listener as
   /fonts/*.woff2). Copied, not linked: the page stays one stylesheet pinned by hash. Dark follows the system here. */
@font-face{font-family:"Bricolage Grotesque";font-weight:600 800;font-display:swap;src:url(/fonts/display.woff2) format("woff2")}
@font-face{font-family:"IBM Plex Sans";font-weight:400 600;font-display:swap;src:url(/fonts/sans.woff2) format("woff2")}
@font-face{font-family:"IBM Plex Mono";font-weight:400;font-display:swap;src:url(/fonts/mono.woff2) format("woff2")}
:root{color-scheme:light;--bg:#f5f6f2;--surface:#fff;--surface-2:#fafbf8;--sunken:#eceee8;--fg:#141c18;--muted:#5c6862;--faint:#8a958f;--line:#e1e5df;--line-strong:#c9d0c8;
--accent:#1b6a57;--accent-soft:#dcefe8;--warn:#b4551b;--bad:#b3261e;--bad-soft:#fbe0de;
--display:"Bricolage Grotesque","Avenir Next","Segoe UI",sans-serif;--font:"IBM Plex Sans","Segoe UI",system-ui,sans-serif;--mono:"IBM Plex Mono",ui-monospace,"SF Mono",Menlo,monospace}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#0e1311;--surface:#171d1a;--surface-2:#1c2420;--sunken:#111715;--fg:#e9eeea;--muted:#9aa8a0;--faint:#6c7a73;--line:#252f2a;--line-strong:#35423b;
--accent:#6fd0b5;--accent-soft:#17332b;--warn:#f2a56c;--bad:#ff8a80;--bad-soft:#41191a}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 var(--font);-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
h1,h2,h3,h4,p{margin:0}
h1{font:800 1.7rem/1.15 var(--display);letter-spacing:-.01em}
h2{font:700 1.2rem/1.2 var(--display)}
h3{font:600 .95rem/1.3 var(--font)}
h4{font:600 .72rem/1.3 var(--font);letter-spacing:.07em;text-transform:uppercase;color:var(--faint);margin:22px 0 8px}
button,input,select{font:inherit;color:inherit}
input[type=search],input[type=password],input[type=text]{background:var(--surface);border:1px solid var(--line-strong);border-radius:8px;padding:7px 11px;min-width:0}
input::placeholder{color:var(--faint)}
:focus{outline:none}
:is(a,button,input,summary,label):focus-visible{outline:2px solid var(--fg);outline-offset:2px}
button{min-height:36px;background:var(--surface);border:1px solid var(--line-strong);border-radius:999px;padding:0 16px;font-size:.84rem;font-weight:600;cursor:pointer;white-space:nowrap}
button:hover{border-color:var(--fg)}
button.primary{background:var(--fg);border-color:var(--fg);color:var(--bg)}
button.danger{background:var(--bad);border-color:var(--bad);color:var(--surface)}button.danger:hover{filter:brightness(1.08)}
::selection{background:var(--accent-soft)}
.mono,.id,.opaque,code{font-family:var(--mono);font-size:.8rem}
.muted{color:var(--muted)}.null{color:var(--faint)}.opaque{color:var(--muted)}.err{color:var(--bad)}.ok{color:var(--accent)}
p.err{padding:9px 14px;border-radius:12px;background:var(--bad-soft);font-size:.84rem;font-weight:500;margin:0 0 14px}
.sprite{position:absolute;width:0;height:0}
.top{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:8px;height:52px;padding:0 20px;background:var(--surface);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:8px;margin-right:16px;white-space:nowrap}
.brand svg{width:26px;height:26px;color:var(--accent)}
.brand b{font:800 1.1rem/1 var(--display)}
.brand small{font-size:.72rem;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--faint)}
.top nav{display:flex;gap:2px;min-width:0}
.top nav a{padding:6px 12px;border-radius:999px;color:var(--muted);font-size:.9rem;font-weight:500;white-space:nowrap}
.top nav a:hover{color:var(--fg);background:var(--sunken);text-decoration:none}
.top nav a.on{background:var(--sunken);color:var(--fg);font-weight:600}
.who{margin-left:auto;display:flex;align-items:center;gap:12px;font-size:.84rem;color:var(--muted);white-space:nowrap}
.who form{margin:0}.who button{min-height:32px;padding:0 13px}
.page{max-width:1280px;margin:0 auto;padding:28px 24px 56px}
.head{display:flex;align-items:baseline;gap:6px 14px;flex-wrap:wrap;margin-bottom:20px}
.head .seg{align-self:center}
.seg{display:inline-flex;padding:3px;border-radius:999px;background:var(--sunken)}
.seg a{padding:3px 14px;border-radius:999px;color:var(--muted);font-size:.84rem;font-weight:600}
.seg a:hover{color:var(--fg);text-decoration:none}
.seg a.on{background:var(--surface);color:var(--fg);box-shadow:0 1px 2px rgb(20 30 25/.14)}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px;margin-bottom:12px}
.tile,.chart,.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;min-width:0}
.tile{padding:14px 16px 12px}
.tile .k{font-size:.72rem;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--faint)}
.tile .v{font:800 1.7rem/1.3 var(--display);font-variant-numeric:tabular-nums;white-space:nowrap}
.tile .v small{font:500 .84rem var(--font);color:var(--muted);margin-left:4px}
.tile .s{font-size:.78rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.spark{display:block;width:100%;height:28px;margin-top:8px}
.line{fill:none;stroke:var(--accent);stroke-width:1.75;stroke-linejoin:round;stroke-linecap:round}
.area{fill:var(--accent);opacity:.1;stroke:none}
.grid line{stroke:var(--line);stroke-width:1}
.hair{stroke:var(--faint);stroke-width:1;visibility:hidden}
.dot{stroke:var(--accent);stroke-width:8;stroke-linecap:round;visibility:hidden}
.hover .hair,.hover .dot{visibility:visible}
.charts{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,340px),1fr));gap:12px}
.chart{margin:0;padding:14px 16px 12px}
.chart header{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:10px}
.readout{font-size:.78rem;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
.hover .readout{color:var(--fg)}
.plotwrap{position:relative;margin-left:54px}
.plot{display:block;width:100%;height:150px;touch-action:pan-y;cursor:crosshair}
.ylab{position:absolute;left:-54px;width:48px;text-align:right;font-size:.7rem;color:var(--faint);transform:translateY(-50%);font-variant-numeric:tabular-nums;white-space:nowrap}
.y100{top:0}.y50{top:50%}.y0{top:100%}
.xlabs{display:flex;justify-content:space-between;margin:6px 0 0 54px;font-size:.7rem;color:var(--faint)}
.empty{display:flex;align-items:center;justify-content:center;height:150px;padding:0 12px;text-align:center;color:var(--faint);font-size:.84rem;border:1px dashed var(--line-strong);border-radius:8px}
.cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);gap:12px;margin-top:12px}
.card{padding:16px 18px}
.card+.card{margin-top:12px}.cols .card+.card{margin-top:0}
.card h3{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:10px}
.kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 16px;margin:0;font-size:.84rem}
.kv dt{color:var(--muted)}.kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
.tlist{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:0 18px;margin:0 -8px;padding:0;list-style:none;font-size:.84rem}
.tlist a{display:flex;justify-content:space-between;align-items:baseline;gap:8px;padding:4px 8px;border-radius:8px;color:var(--fg)}
.tlist a:hover{background:var(--sunken);text-decoration:none}
.n{color:var(--faint);font-variant-numeric:tabular-nums;font-size:.78rem;font-weight:500}
.cm{display:inline-flex;align-items:center;gap:4px;font:600 .72rem/1.3 var(--font);letter-spacing:0;text-transform:none;white-space:nowrap;color:var(--muted)}
.cm svg{width:14px;height:14px;flex:none;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
.cm-e2e{color:var(--accent)}.cm-plain{color:var(--warn)}.cm-none{color:var(--bad)}
.grid th .cm,.kv dt .cm{display:flex;margin-top:2px;font-weight:500}
.sum{display:flex;flex-wrap:wrap;gap:4px 14px;align-items:center;font-size:.78rem;color:var(--muted)}
.sum b{font-weight:600;color:var(--fg);font-variant-numeric:tabular-nums}
.legend{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px 28px;margin:0;padding:0;list-style:none;font-size:.84rem;color:var(--muted)}
.legend .cm{display:flex;font-size:.9rem;margin-bottom:3px}.legend .cm svg{width:17px;height:17px}
.schema{scroll-margin-top:64px}
.schema header{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:6px}
.schema h2 a{color:var(--fg)}
.schema .scroll{margin-top:10px}
.schema .grid th{position:static}.schema .grid td{white-space:normal;max-width:none}.schema .grid td:nth-child(-n+4){white-space:nowrap}
.schema .grid tr:last-child td{border-bottom:0}
.data{display:grid;grid-template-columns:280px minmax(0,1fr);height:calc(100dvh - 52px)}
.data.with-detail{grid-template-columns:280px minmax(0,1fr) minmax(330px,420px)}
.tree{overflow:auto;background:var(--surface-2);border-right:1px solid var(--line);padding:8px 10px 32px;font-size:.84rem}
.tree ul{list-style:none;margin:0;padding:0}
.tree ul ul{margin-left:11px;padding-left:7px;border-left:1px solid var(--line-strong)}
.tree .grp{font-size:.72rem;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--faint);padding:14px 8px 5px}
.tree .lbl{font-size:.78rem;color:var(--faint);padding:8px 8px 2px}
.tree a.node{display:flex;justify-content:space-between;align-items:baseline;gap:8px;padding:4px 8px;border-radius:8px;color:var(--fg);white-space:nowrap}
.tree a.node span:first-child{overflow:hidden;text-overflow:ellipsis}
.tree a.node:hover{background:var(--sunken);text-decoration:none}
.tree a.node.on{background:var(--accent-soft);font-weight:600}
.tree a.node.on .n{color:var(--muted)}
.tree summary{list-style:none;cursor:pointer}.tree summary::-webkit-details-marker{display:none}
.tree summary a.node{justify-content:flex-start;font-weight:600}.tree summary a.node .n{margin-left:auto}
.tree summary a.node::before{content:"";align-self:center;flex:none;border:4px solid transparent;border-left:5px solid var(--faint);border-right:0;margin-right:-1px}
.tree details[open]>summary a.node::before{transform:rotate(90deg)}
.tree .find{display:flex;padding:2px 4px 6px}.tree .find input{flex:1;font-size:.8rem;padding:5px 10px}
.pane{display:flex;flex-direction:column;min-width:0;min-height:0}
.panehead{padding:16px 20px 12px;border-bottom:1px solid var(--line);background:var(--surface);display:flex;flex-direction:column;gap:10px}
.crumbs{font-size:.78rem;color:var(--muted);display:flex;flex-wrap:wrap;gap:5px}
.crumbs span+span::before{content:"/";margin-right:5px;color:var(--faint)}
.titlerow{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}.titlerow .muted{font-size:.84rem}
.chips{display:flex;gap:6px;flex-wrap:wrap}
.chip{display:inline-flex;gap:4px;align-items:center;background:var(--accent-soft);border-radius:999px;padding:2px 4px 2px 12px;font-size:.78rem;font-weight:500;max-width:100%}
.chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip a{color:var(--fg);padding:0 7px;border-radius:999px}.chip a:hover{background:var(--surface);text-decoration:none}
.tools{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.tools form{display:flex;gap:6px;margin:0;flex:1 1 240px;max-width:440px}.tools input[type=search]{flex:1;padding:6px 11px;font-size:.84rem}
.pager{display:flex;gap:6px;align-items:center;margin-left:auto;font-size:.78rem;color:var(--muted);white-space:nowrap}
.pager a,.pager .off{border:1px solid var(--line-strong);border-radius:999px;padding:4px 12px;background:var(--surface);color:var(--fg);font-weight:600}
.pager a:hover{border-color:var(--fg);text-decoration:none}.pager .off{color:var(--faint);border-color:var(--line)}
.tablewrap{flex:1;min-height:0;overflow:auto;background:var(--surface)}
table.grid{border-collapse:separate;border-spacing:0;font-size:.84rem;min-width:100%}
.grid th{position:sticky;top:0;z-index:2;background:var(--surface);border-bottom:1.5px solid var(--fg);text-align:left;font-weight:600;padding:8px 12px 7px;white-space:nowrap;vertical-align:bottom}
.grid th a{color:var(--fg)}.grid th a.on{color:var(--accent)}
.grid td{padding:6px 12px;border-bottom:1px solid var(--line);white-space:nowrap;max-width:24em;overflow:hidden;text-overflow:ellipsis;vertical-align:top}
.grid tr[data-href]{cursor:pointer}.grid tbody tr[data-href]:hover td{background:var(--surface-2)}
.grid tr.sel td,.grid tbody tr.sel:hover td{background:var(--accent-soft)}
.grid td.num{text-align:right;font-variant-numeric:tabular-nums}
.grid td.open{padding-right:2px}.grid td.open a{color:var(--faint)}
.grid td.none{padding:44px 12px;text-align:center;color:var(--faint);border-bottom:0}
.tag{display:inline-block;font-size:.72rem;font-weight:600;padding:1px 8px;border-radius:999px;background:var(--sunken);color:var(--muted)}
.detail{overflow:auto;border-left:1px solid var(--line);background:var(--surface);padding:16px 20px 32px}
.detail header{display:flex;justify-content:space-between;align-items:center;gap:8px}
.detail .close{font-size:1.3rem;line-height:1;padding:3px 9px;border-radius:999px;color:var(--muted)}.detail .close:hover{background:var(--sunken);color:var(--fg);text-decoration:none}
.detail .kv{gap:8px 16px}.detail .kv dt{font-family:var(--mono);font-size:.76rem;color:var(--fg)}
.rel{list-style:none;margin:0 -8px;padding:0;display:flex;flex-direction:column;font-size:.84rem}
.rel a{display:block;padding:4px 8px;border-radius:8px}.rel a:hover{background:var(--sunken);text-decoration:none}
.note{font-size:.78rem;color:var(--muted);margin:8px 0 0}
.treetoggle{display:none}
#tt{position:absolute;opacity:0;pointer-events:none;width:1px;height:1px}
.login{max-width:400px;margin:14vh auto 0;background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:28px}
.login .brand{margin:0 0 20px}
.login h1{font-size:1.35rem;margin-bottom:4px}.login form{display:flex;flex-direction:column;gap:14px;margin-top:18px}
.login label,.form label{display:flex;flex-direction:column;gap:5px;font-size:.84rem;font-weight:500;color:var(--muted)}
.notice{max-width:460px;margin:12vh auto 0;text-align:center}.notice h1{margin-bottom:8px}.notice p{color:var(--muted);margin-bottom:18px}
.scroll{overflow:auto}
.two{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:12px;align-items:start}.two .card+.card{margin-top:0}
.mini th:not(:first-child){text-align:right}.card .tools{margin-top:12px}.card .grid th{position:static}.card .grid tr:last-child td{border-bottom:0}.card h4:first-of-type{margin-top:14px}
.side{display:flex;align-items:center;gap:8px;margin-bottom:2px}.side .cm svg{width:20px;height:20px}.side .cm{font-size:0}
.unseen{list-style:none;margin:10px 0 0;padding:0;font-size:.84rem}
.unseen li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 12px;padding:10px 0;border-top:1px solid var(--line)}
.unseen li b{font-weight:600}.unseen li .mono{grid-column:1/-1;color:var(--faint);font-size:.74rem}
@media (max-width:820px){.two{grid-template-columns:minmax(0,1fr)}}
.confirm{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:18px}.confirm input{width:7em}
.form{max-width:460px;display:flex;flex-direction:column;gap:14px}
@media (max-width:820px){
.cols{grid-template-columns:minmax(0,1fr)}
.top{padding:0 10px;gap:4px}.brand small,.brand b,.who .login-name{display:none}.brand{margin-right:2px}
.top nav{overflow-x:auto;scrollbar-width:none}.top nav a{padding:6px 9px;font-size:.84rem}.who{gap:6px;padding-left:4px}.who button{padding:0 11px}
.page{padding:20px 16px 40px}
h1{font-size:1.35rem}
.tile .v{font-size:1.35rem}.tiles{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.tile{padding:12px 13px 10px}
.data,.data.with-detail{display:flex;flex-direction:column;height:auto}
.treetoggle{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 16px;border-bottom:1px solid var(--line);background:var(--surface-2);font-size:.84rem;cursor:pointer}
.treetoggle::after{content:"";flex:none;border:5px solid transparent;border-top:6px solid var(--muted);border-bottom:0}
.tree{display:none;border-right:0;border-bottom:1px solid var(--line);max-height:60vh}
#tt:checked~.data .tree,.tree:target{display:block}.tree:focus{outline:none}
.plot,.empty{height:120px}
.detail{order:1;border-left:0;border-bottom:1px solid var(--line);padding:16px 16px 24px}
.pane{order:2}.panehead{padding:14px 16px 12px}
.tablewrap{max-height:75vh}
.pager{margin-left:0}
.card{padding:14px}
.login{margin:8vh 16px 0;padding:22px}
}`;

// Hover on charts (hairline + readout), whole table rows clickable, live filter of the room list.
const JS = `(()=>{for(const f of document.querySelectorAll('.chart[data-pts]')){const p=JSON.parse(f.dataset.pts);if(!p.length)continue;const plot=f.querySelector('.plot'),hair=f.querySelector('.hair'),dot=f.querySelector('.dot'),out=f.querySelector('.readout'),rest=out.textContent;
const show=e=>{const r=plot.getBoundingClientRect(),x=(e.clientX-r.left)/r.width;let lo=0,hi=p.length-1;while(lo<hi){const m=(lo+hi)>>1;if(p[m][0]<x)lo=m+1;else hi=m}if(lo>0&&x-p[lo-1][0]<p[lo][0]-x)lo--;const X=p[lo][0]*1000,Y=p[lo][1]*200;
for(const [k,v] of [['x1',X],['x2',X]]){hair.setAttribute(k,v);dot.setAttribute(k,v)}dot.setAttribute('y1',Y);dot.setAttribute('y2',Y);f.classList.add('hover');out.textContent=p[lo][2]};
plot.addEventListener('pointermove',show);plot.addEventListener('pointerdown',show);plot.addEventListener('pointerleave',()=>{f.classList.remove('hover');out.textContent=rest})}
for(const tr of document.querySelectorAll('tr[data-href]'))tr.addEventListener('click',e=>{if(e.target.closest('a')||getSelection().toString())return;location.href=tr.dataset.href});
const rf=document.getElementById('roomfilter');if(rf)rf.addEventListener('input',()=>{const q=rf.value.trim().toLowerCase();for(const li of document.querySelectorAll('[data-room]'))li.hidden=!!q&&!li.dataset.room.startsWith(q)})})();`;

const sha = (text) => crypto.createHash('sha256').update(text).digest('base64');
export const CSP = `default-src 'none'; style-src 'sha256-${sha(CSS)}'; script-src 'sha256-${sha(JS)}'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`;

// The app's counter bell (the strokes of app/web/public/icons/trommi.svg).
const BELL = '<svg viewBox="1.5 2.5 23 19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.1 19Q12.3 18.6 16.7 19L21 19.3"/><path d="M4.8 18.9Q5.2 15.1 5.7 13.7Q6.2 12.3 7.5 11.3Q8.7 10.3 10.3 9.5Q12 8.8 13.7 9.3Q15.3 9.8 16.4 11Q17.5 12.2 18.1 13.7Q18.6 15.2 18.8 17L18.9 18.8"/><path d="M11.8 8.6L12.2 6.9"/><path d="M10 6.6Q11.8 6 12.8 6.4L13.8 6.8"/><path d="M18.5 7.3Q19.5 5.8 19.8 5.2L20 4.5"/><path d="M20.6 10.3Q21.5 9.4 22.3 8.9L23.1 8.5"/></svg>';
// The marks of what a column holds: a closed lock (end-to-end encrypted), an open eye (the hub reads it), a hash sign, a dashed ring (not classified).
const SPRITE = '<svg class="sprite" aria-hidden="true"><symbol id="c-e2e" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9.5" rx="2"/><path d="M8.2 11V8a3.8 3.8 0 0 1 7.6 0v3"/></symbol><symbol id="c-plain" viewBox="0 0 24 24"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/></symbol><symbol id="c-hash" viewBox="0 0 24 24"><path d="M9.5 4 7.5 20M16.5 4l-2 16M4.5 9.2h16M3.5 14.8h16"/></symbol><symbol id="c-none" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" stroke-dasharray="3 3.2"/><path d="M12 8v4.5M12 16v.1"/></symbol></svg>';

export const head = (title) => `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${esc(title)}</title><style>${CSS}</style></head><body>${SPRITE}`;
const foot = `<script>${JS}</script></body></html>`;

export function topBar(login, csrf, on = '') {
  const tab = (href, label, key) => `<a href="${href}"${on === key ? ' class="on"' : ''}>${label}</a>`;
  return `<header class="top"><span class="brand">${BELL}<b>Trommi</b> <small>hub admin</small></span><nav>${tab('/', 'Übersicht', 'overview')}${tab('/data', 'Daten', 'data')}${tab('/accounts', 'Konten', 'accounts')}${tab('/schema', 'Schema', 'schema')}${tab('/test-accounts', 'Test accounts', 'tests')}${tab('/password', 'Passwort ändern', 'password')}</nav>
<div class="who"><span class="login-name">${esc(login)}</span><form method="post" action="/logout"><input type="hidden" name="csrf" value="${esc(csrf)}"><button>Abmelden</button></form></div></header>`;
}

export function renderLoginPage(login, message = '') {
  return `${head('Trommi hub admin')}<div class="login"><span class="brand">${BELL}<b>Trommi</b> <small>hub admin</small></span><h1>Sign in</h1><p class="muted">Tailscale login: <span class="mono">${esc(login)}</span></p>${message ? `<p class="err">${esc(message)}</p>` : ''}
<form method="post" action="/login"><label>Admin password <input type="password" name="password" autocomplete="current-password" required autofocus></label><button class="primary">Anmelden</button></form></div></body></html>`;
}

export function renderPasswordPage(login, csrf, message = '', minLength = 16) {
  return `${head('Trommi hub admin')}${topBar(login, csrf, 'password')}<main class="page"><div class="head"><h1>Passwort ändern</h1></div>${message ? `<p class="err">${esc(message)}</p>` : ''}
<form class="form card" method="post" action="/password"><input type="hidden" name="csrf" value="${esc(csrf)}">
<label>Current password <input type="password" name="current" autocomplete="current-password" required></label>
<label>New password (at least ${minLength} characters) <input type="password" name="new1" autocomplete="new-password" minlength="${minLength}" required></label>
<label>New password again <input type="password" name="new2" autocomplete="new-password" minlength="${minLength}" required></label>
<div><button class="primary">change</button> <span class="muted">signs out every admin session</span></div></form></main></body></html>`;
}

// ---------- schema ----------

export function tableInfo(db) {
  return cached(db, 'schema', 5000, () => {
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
    return names.map((name) => {
      const columns = db.prepare(`PRAGMA table_info(${quoteIdent(name)})`).all();
      let rowid = true;
      try { db.prepare(`SELECT rowid FROM ${quoteIdent(name)} LIMIT 0`).all(); } catch { rowid = false; }
      const pk = columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
      return { name, columns, names: new Set(columns.map((c) => c.name)), rowid, pk };
    });
  });
}
function totalCount(db, table) {
  return cached(db, `count:${table}`, 10000, () => { try { return Number(db.prepare(`SELECT count(*) AS n FROM ${quoteIdent(table)}`).get().n); } catch { return null; } });
}
const colType = (table, col) => String(table.columns.find((c) => c.name === col)?.type || '').toUpperCase();
/** A filter value bound as the column stores it: hex for BLOB columns, numbers for INTEGER columns. */
function bindFor(table, col, value) {
  const type = colType(table, col);
  if (type.includes('BLOB') && /^([0-9a-f]{2})+$/i.test(value)) return Buffer.from(value, 'hex');
  if (type.includes('INT') && /^-?\d{1,15}$/.test(value)) return Number(value);
  return value;
}

// ---------- what a column holds (COLUMN_CLASSES in hub/store.mjs, beside the schema) ----------

// class -> [name, short name under a column head, what it means]
const CLASS_LABEL = {
  e2e: ['End-to-end encrypted', 'E2E encrypted', 'Ciphertext or a sealed key. Only the members\' devices can open it; the hub cannot.'],
  plain: ['Server-readable', 'readable', 'Ids, numbers, times, roles, addresses and signed records. The hub reads them to route and to answer.'],
  hash: ['Hash or proof', 'hash', 'A hash, salt or signature. It links or proves something and says nothing of the content.'],
  none: ['Not classified', 'unclassified', 'A column the hub\'s schema does not name (a table from before). Take it as readable.'],
};
const CLASS_ORDER = ['e2e', 'plain', 'hash', 'none'];
export const classOf = (table, column) => COLUMN_CLASSES[table]?.[column]?.[0] ?? 'none';
/** The mark of a class: its drawing and its name in words (never colour alone). */
const classMark = (cls, long = false) => `<span class="cm cm-${cls}" title="${esc(CLASS_LABEL[cls][0])}"><svg aria-hidden="true"><use href="#c-${cls}"/></svg>${esc(CLASS_LABEL[cls][long ? 0 : 1])}</span>`;
/** A table's columns counted by class, each count with its mark (a class without a column is left out). */
function classSummary(table) {
  const n = { e2e: 0, plain: 0, hash: 0, none: 0 };
  for (const c of table.columns) n[classOf(table.name, c.name)] += 1;
  return CLASS_ORDER.filter((k) => n[k]).map((k) => `<span><b>${n[k]}</b> ${classMark(k, true)}</span>`).join('');
}
/** Whether this page shows a column's values as size + first bytes only (renderCell). */
const isMasked = (c) => isOpaque(c.name) || (String(c.type || '').toUpperCase().includes('BLOB') && !DEVICE_COLUMN.test(c.name));

/** /schema: every table of hub.db with its columns, each marked with what it holds; the legend on top. */
export function renderSchema(db, { login = '', csrf = '' } = {}) {
  const tables = db ? tableInfo(db) : [];
  const total = { e2e: 0, plain: 0, hash: 0, none: 0 };
  const cards = tables.map((t) => {
    const rows = t.columns.map((c) => {
      const cls = classOf(t.name, c.name);
      total[cls] += 1;
      return `<tr><td class="mono">${esc(c.name)}</td><td class="mono muted">${esc(c.type || '')}</td><td>${classMark(cls, true)}</td><td class="muted">${isMasked(c) ? 'masked: size + 16 bytes' : 'shown'}</td><td class="muted">${esc(COLUMN_CLASSES[t.name]?.[c.name]?.[1] || '')}</td></tr>`;
    }).join('');
    return `<section class="card schema" id="t-${esc(t.name)}"><header><h2><a href="${esc(dataHref({ table: t.name }))}">${esc(t.name)}</a></h2><span class="n">${esc(fmtNum(totalCount(db, t.name)))} rows</span></header>
<div class="sum">${classSummary(t)}</div>${TABLE_NOTES[t.name] ? `<p class="note">${esc(TABLE_NOTES[t.name])}</p>` : ''}
<div class="scroll"><table class="grid"><thead><tr><th>Column</th><th>Type</th><th>Holds</th><th>On this page</th><th>Note</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  });
  const columns = CLASS_ORDER.reduce((a, k) => a + total[k], 0);
  const legend = CLASS_ORDER.filter((k) => k !== 'none' || total.none).map((k) => `<li>${classMark(k, true)}${esc(CLASS_LABEL[k][2])} <span class="n">${total[k]} column${total[k] === 1 ? '' : 's'}</span></li>`).join('');
  return `${head('Schema · Trommi hub admin')}${login ? topBar(login, csrf, 'schema') : ''}<main class="page">
<div class="head"><h1>Schema</h1><span class="muted">${tables.length} tables · ${columns} columns in hub.db</span></div>
<section class="card"><h3>What the hub can read</h3><ul class="legend">${legend}</ul>
<p class="note">Masked values are shown as size and first 16 bytes only and can be neither searched, filtered nor sorted. Nothing here is decrypted: the hub holds no key that could.</p></section>
${cards.join('\n') || '<section class="card"><p class="muted">hub.db does not exist yet. It is made when the hub first starts.</p></section>'}
</main></body></html>`;
}

// ---------- accounts: what the hub knows of one user, and what it cannot see ----------
//
// One account belongs to one room, and a room is one user's whole board. Everything here is a count, a size or a
// time out of the hub's own tables; the email stays masked as everywhere. Every query is bound to one room and
// answered from an index; the one sum over a room's envelopes reads its newest SCAN_CAP only.
const SCAN_CAP = 50000;
function ask(db, sql, ...args) {
  return cached(db, `ask:${args.join(',')}:${sql}`, 10000, () => { try { return db.prepare(sql).all(...args).map((r) => Object.values(r)); } catch { return []; } });
}
const num = (v) => fmtNum(Number(v ?? 0));
const when = (t) => (typeof t === 'number' && t > 0 ? dateFmt.format(t) : '–');
const miniTable = (heads, rows) => `<div class="scroll"><table class="grid mini"><thead><tr>${heads.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="num"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const kvList = (pairs) => `<dl class="kv">${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;

function accountDetail(db, room, has) {
  const one = (sql, ...args) => ask(db, sql, ...args)[0] ?? [];
  const known = [];
  const section = (title, html) => { if (html) known.push(`<h4>${esc(title)}</h4>${html}`); };

  const [founded, lastNumber] = one('SELECT founded_at, last_envelope_number FROM rooms WHERE room_id = ?', room);
  const [lastAt] = has('envelopes') ? one('SELECT received_at FROM envelopes WHERE room_id = ? ORDER BY envelope_number DESC LIMIT 1', room) : [];
  let account = null;
  if (has('accounts')) { try { account = db.prepare('SELECT * FROM accounts WHERE room_id = ?').get(room) ?? null; } catch { account = null; } }
  section('Account', account
    ? kvList([['email', renderCell('email', account.email)], ['verified', esc(account.email_verified_at ? when(account.email_verified_at) : 'not verified')], ['created', esc(when(account.created_at))],
      ['changed', esc(when(account.updated_at))], ['Emergency Kit', account.recovery_hash ? 'set' : 'not set']])
    : '<p class="muted">No account: this room has no email sign-in, only its devices.</p>');
  const entries = has('member_entries') ? one('SELECT count(*) FROM member_entries WHERE room_id = ?', room)[0] : null;
  section('Room', kvList([['founded', esc(when(founded))], ['last envelope received', esc(when(lastAt))], ['envelopes ever', esc(num(lastNumber))], ...(entries == null ? [] : [['member entries', esc(num(entries))]])]));

  if (has('devices')) {
    const rows = ask(db, 'SELECT device_role, sum(removed_entry_number IS NULL), sum(removed_entry_number IS NOT NULL) FROM devices WHERE room_id = ? GROUP BY device_role ORDER BY device_role', room);
    section('Devices', rows.length ? miniTable(['Role', 'Active', 'Removed'], rows.map(([role, a, r]) => [esc(String(role)), esc(num(a)), esc(num(r))])) : '');
  }
  let bodies = 0; let padded = 0;
  if (has('envelopes')) {
    const rows = ask(db, `SELECT envelope_kind, count(*), sum(b), sum(padded_size) FROM (SELECT envelope_kind, encrypted_body IS NOT NULL AS b, padded_size FROM envelopes WHERE room_id = ? ORDER BY envelope_number DESC LIMIT ${SCAN_CAP}) GROUP BY envelope_kind ORDER BY envelope_kind`, room);
    for (const r of rows) { bodies += Number(r[2] ?? 0); padded += Number(r[3] ?? 0); }
    const capped = Number(lastNumber ?? 0) > SCAN_CAP;
    section('Envelopes by kind', rows.length ? `${miniTable(['Kind', 'Envelopes', 'Body kept', 'Padded size'], rows.map(([k, n, b, size]) => [esc(enumName('envelope_kind', k) ?? String(k)), esc(num(n)), esc(num(b)), esc(formatBytes(Number(size ?? 0)))]))}
<p class="note">${capped ? `The newest ${fmtNum(SCAN_CAP)} envelopes only. ` : ''}The kind, the sender device, the time, the card and its state and urgency stand in each envelope's cleartext header. Bodies are padded, so a size is a step, not a length. A body is dropped 30 days after its card is done.</p>` : '');
  }
  if (has('timelines')) {
    const rows = ask(db, "SELECT timeline_kind, CASE WHEN instr(timeline_id, '/') > 0 THEN substr(timeline_id, 1, instr(timeline_id, '/')) ELSE '' END, count(*), sum(item_count) FROM timelines WHERE room_id = ? GROUP BY 1, 2 ORDER BY 1, 2", room);
    section('Timelines', rows.length ? `${miniTable(['Kind', 'Id begins with', 'Timelines', 'Items'], rows.map(([k, prefix, n, items]) => [esc(enumName('timeline_kind', k) ?? String(k)), `<span class="mono">${esc(String(prefix || '–'))}</span>`, esc(num(n)), esc(num(items))]))}
<p class="note">A timeline's id is cleartext and begins with what it hangs on (a card, a session, a desk), so the hub can tell chats from boards and count them. What is written or drawn in them it cannot read.</p>` : '');
  }
  if (has('objects')) {
    const rows = ask(db, 'SELECT object_state, count(*), sum(urgency >= 2) FROM objects WHERE room_id = ? GROUP BY object_state ORDER BY object_state', room);
    section('Cards and other objects', rows.length ? miniTable(['State', 'Objects', 'High or critical'], rows.map(([st, n, u]) => [esc(enumName('object_state', st) ?? String(st)), esc(num(n)), esc(num(u))])) : '');
  }
  const more = [];
  if (has('session_grants')) more.push(['agent sessions', esc(num(one('SELECT count(DISTINCT session_id) FROM session_grants WHERE room_id = ?', room)[0]))]);
  let files = 0; let fileBytes = 0;
  if (has('attachments')) {
    [files = 0, fileBytes = 0] = one('SELECT count(*), sum(total_size) FROM attachments WHERE room_id = ?', room);
    more.push(['attachments', `${esc(num(files))} · ${esc(formatBytes(Number(fileBytes ?? 0)))}`]);
  }
  if (has('shares')) more.push(['shared links', esc(num(one('SELECT count(*) FROM shares WHERE room_id = ?', room)[0]))]);
  if (has('push_subscriptions')) {
    const rows = ask(db, "SELECT level, sum(endpoint NOT LIKE 'apns:%'), sum(endpoint LIKE 'apns:%') FROM push_subscriptions WHERE room_id = ? GROUP BY level ORDER BY level", room);
    more.push(['push registrations', rows.length ? rows.map(([level, web, apns]) => `${esc(String(level))}: ${esc(num(web))} Web Push, ${esc(num(apns))} APNs`).join('<br>') : '0']);
  }
  if (has('live_activities')) more.push(['Live Activity registrations', esc(num(one('SELECT count(*) FROM live_activities WHERE room_id = ?', room)[0]))]);
  if (has('invites')) more.push(['open invites', esc(num(one('SELECT count(*) FROM invites WHERE room_id = ? AND used_at IS NULL AND burned_at IS NULL', room)[0]))]);
  if (has('agent_leases')) more.push(['running agents', esc(num(one('SELECT count(*) FROM agent_leases WHERE room_id = ?', room)[0]))]);
  section('Counted', more.length ? kvList(more) : '');

  // The other side comes out of COLUMN_CLASSES: every end-to-end encrypted column of a table with a room_id, and how many of it this room has.
  const unseen = [];
  for (const [table, cols] of Object.entries(COLUMN_CLASSES)) {
    if (!has(table) || !cols.room_id) continue;
    for (const [col, [cls, note]] of Object.entries(cols)) {
      if (cls !== 'e2e' || !has(table, col)) continue;
      const n = table === 'envelopes' && col === 'encrypted_body' ? bodies : Number(one(`SELECT count(*) FROM ${quoteIdent(table)} WHERE room_id = ? AND ${quoteIdent(col)} IS NOT NULL`, room)[0] ?? 0);
      if (!n) continue;
      const size = table === 'envelopes' && col === 'encrypted_body' ? ` · ${formatBytes(padded)} padded` : '';
      unseen.push(`<li><b>${esc(note.charAt(0).toUpperCase() + note.slice(1))}</b><span class="n">${esc(fmtNum(n))} stored${esc(size)}</span><span class="mono">${esc(table)}.${esc(col)}</span></li>`);
    }
  }
  if (Number(files) > 0) unseen.push(`<li><b>What is in the files, and what they are called</b><span class="n">${esc(num(files))} files · ${esc(formatBytes(Number(fileBytes ?? 0)))}</span><span class="mono">attachments/ beside hub.db: encrypted on the device before upload</span></li>`);
  return `<div class="two"><section class="card"><div class="side">${classMark('plain', true)}<h2>The hub knows</h2></div><p class="muted">Counts, sizes and times from its own tables.</p>${known.join('')}</section>
<section class="card"><div class="side">${classMark('e2e', true)}<h2>The hub cannot see</h2></div><p class="muted">Ciphertext it stores and has no key for.</p>
${unseen.length ? `<ul class="unseen">${unseen.join('')}</ul>` : '<p class="note">Nothing encrypted is stored for this room yet.</p>'}
<p class="note">So: no message text, no card title, option or answer, no drawing, no name of a session, desk or device, no file. How many there are, how big, when and from which device stands on the left, because that the hub does know.</p></section></div>`;
}

/** /accounts: the rooms with their account, 50 per page; /accounts?room=<id>: one of them. null: no such room. */
export function renderAccounts(db, params, { login = '', csrf = '' } = {}) {
  const tables = db ? tableInfo(db) : [];
  const has = (table, col) => { const t = tables.find((x) => x.name === table); return !!t && (col === undefined || t.names.has(col)); };
  const frame = (body) => `${head('Konten · Trommi hub admin')}${login ? topBar(login, csrf, 'accounts') : ''}<main class="page">${body}</main>${foot}`;
  if (!has('rooms')) return frame('<div class="head"><h1>Accounts</h1></div><section class="card"><p class="muted">hub.db has no rooms yet. They come with the first sign-up.</p></section>');
  const room = params.get('room') || '';
  if (room) {
    if (!ROOM_RE.test(room) || !ask(db, 'SELECT 1 FROM rooms WHERE room_id = ?', room).length) return null;
    return frame(`<div class="crumbs"><span><a href="/accounts">Accounts</a></span><span>room <span class="mono">${esc(short(room, 12))}</span></span></div>
<div class="head"><h1>One account</h1><span class="muted">room <span class="mono">${esc(short(room, 16))}</span> · <a href="${esc(dataHref({ room, table: 'envelopes' }))}">its rows</a></span></div>${accountDetail(db, room, has)}`);
  }
  const page = Math.max(0, Math.min(1_000_000, Number.parseInt(params.get('page') || '', 10) || 0));
  const total = totalCount(db, 'rooms') ?? 0;
  const list = ask(db, `SELECT room_id, founded_at, last_envelope_number FROM rooms ORDER BY last_envelope_number DESC, room_id LIMIT ${PAGE_SIZE + 1} OFFSET ${page * PAGE_SIZE}`);
  const more = list.length > PAGE_SIZE;
  const rows = list.slice(0, PAGE_SIZE).map(([id, founded, last]) => {
    let account = null;
    if (has('accounts')) { try { account = db.prepare('SELECT * FROM accounts WHERE room_id = ?').get(id) ?? null; } catch { account = null; } }
    const roles = Object.fromEntries(has('devices') ? ask(db, 'SELECT device_role, count(*) FROM devices WHERE room_id = ? AND removed_entry_number IS NULL GROUP BY device_role', id) : []);
    const [files, bytes] = has('attachments') ? ask(db, 'SELECT count(*), sum(total_size) FROM attachments WHERE room_id = ?', id)[0] ?? [] : [];
    const [lastAt] = has('envelopes') ? ask(db, 'SELECT received_at FROM envelopes WHERE room_id = ? ORDER BY envelope_number DESC LIMIT 1', id)[0] ?? [] : [];
    const href = `/accounts?room=${id}`;
    return `<tr data-href="${esc(href)}"><td><a class="id" href="${esc(href)}" title="${esc(id)}">${esc(short(String(id), 12))}</a></td>
<td>${account ? `${renderCell('email', account.email)} <span class="tag">${account.email_verified_at ? 'verified' : 'not verified'}</span>` : '<span class="null">no account</span>'}</td>
<td class="num">${esc(num(roles.human))}</td><td class="num">${esc(num(roles.agent))}</td><td class="num">${esc(num(last))}</td><td class="num">${esc(num(files))} · ${esc(formatBytes(Number(bytes ?? 0)))}</td><td>${esc(when(founded))}</td><td>${esc(when(lastAt))}</td></tr>`;
  });
  const prev = page > 0 ? `<a href="/accounts${page > 1 ? `?page=${page - 1}` : ''}">‹ prev</a>` : '<span class="off">‹ prev</span>';
  const next = more ? `<a href="/accounts?page=${page + 1}">next ›</a>` : '<span class="off">next ›</span>';
  return frame(`<div class="head"><h1>Accounts</h1><span class="muted">${esc(fmtNum(total))} room${total === 1 ? '' : 's'} · one account belongs to one room, a room is one user's whole board</span></div>
<section class="card">${rows.length ? `<div class="scroll"><table class="grid"><thead><tr><th>Room</th><th>Account</th><th>Humans</th><th>Agents</th><th>Envelopes</th><th>Attachments</th><th>Founded</th><th>Last activity</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>
<div class="tools"><div class="pager"><span>${fmtNum(page * PAGE_SIZE + 1)}–${fmtNum(page * PAGE_SIZE + rows.length)} of ${fmtNum(total)}</span>${prev}${next}</div></div>` : '<p class="muted">No rooms on this page.</p>'}
<p class="note">Open a row for everything the hub can count of that room, and for what it stores without being able to read it. Emails stay masked here as everywhere.</p></section>`);
}

/** A page that only says something (not found, no database yet), in the page's frame. */
export function renderNotice(title, text, { login = '', csrf = '' } = {}) {
  return `${head(`${title} · Trommi hub admin`)}${login ? topBar(login, csrf) : ''}<main class="page notice"><h1>${esc(title)}</h1><p>${esc(text)}</p><a href="/">Back to the overview</a></main></body></html>`;
}

// ---------- the data view's state (all from the query string, all validated) ----------

const ROOM_RE = /^[0-9a-f]{1,64}$/;

export function parseState(params, tables) {
  const get = (k) => { const v = params.get(k); return typeof v === 'string' ? v : ''; };
  const room = [get('room'), get('room_id')].find((v) => ROOM_RE.test(v)) || '';
  const tname = get('t') || get('table');
  let table = tables.find((t) => t.name === tname) || null;
  const filters = [];
  const key = [];
  if (table) {
    for (const [k, v] of params) {
      if (v.length > 256) continue;
      if (k.startsWith('f.')) {
        const col = k.slice(2);
        if (table.names.has(col) && !isOpaque(col) && col !== 'room_id' && !filters.some(([c]) => c === col)) filters.push([col, v]);
      } else if (k === 'rowid' && table.rowid && /^\d{1,15}$/.test(v)) key.push(['rowid', v]);
      else if (k.startsWith('k.') && !table.rowid) {
        const col = k.slice(2);
        if (table.pk.includes(col) && !isOpaque(col)) key.push([k, v]);
      }
    }
  }
  if (!table && !room) table = tables.find((t) => t.name === 'envelopes') || tables[0] || null;
  if (!table && room) table = tables.find((t) => t.name === 'envelopes') || null;
  const sortCol = get('sort');
  const sort = table && table.names.has(sortCol) && !isOpaque(sortCol) ? sortCol : '';
  const dir = get('dir') === 'asc' ? 'asc' : 'desc';
  const q = get('q').trim().slice(0, 100);
  const page = Math.max(0, Math.min(1_000_000, Number.parseInt(get('page'), 10) || 0));
  return { room, table, filters, key, sort, dir, q, page };
}

/** /data?... for a state (fields left out are dropped; `undefined` keeps nothing). */
export function dataHref(s) {
  const p = new URLSearchParams();
  if (s.room) p.set('room', s.room);
  if (s.table) p.set('t', typeof s.table === 'string' ? s.table : s.table.name);
  for (const [c, v] of s.filters || []) p.set(`f.${c}`, v);
  if (s.q) p.set('q', s.q);
  if (s.sort) { p.set('sort', s.sort); p.set('dir', s.dir || 'desc'); }
  if (s.page) p.set('page', String(s.page));
  for (const [k, v] of s.key || []) p.set(k, v);
  const text = p.toString();
  return `/data${text ? `?${text}` : ''}`;
}

function whereOf(table, s) {
  const conds = [];
  const args = [];
  if (s.room && table.names.has('room_id')) { conds.push('room_id = ?'); args.push(s.room); }
  for (const [col, v] of s.filters) { conds.push(`${quoteIdent(col)} = ?`); args.push(bindFor(table, col, v)); }
  if (s.q) {
    const ors = [];
    const like = `${s.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    for (const c of table.columns) {
      if (isOpaque(c.name)) continue;
      const type = String(c.type || '').toUpperCase();
      if (type.includes('BLOB')) {
        if (DEVICE_COLUMN.test(c.name) && /^[0-9a-f]+$/i.test(s.q)) { ors.push(`hex(${quoteIdent(c.name)}) LIKE ?`); args.push(`${s.q.toUpperCase()}%`); }
      } else if (type.includes('INT') || type.includes('REAL')) {
        if (/^-?\d{1,15}$/.test(s.q)) { ors.push(`${quoteIdent(c.name)} = ?`); args.push(Number(s.q)); }
      } else { ors.push(`${quoteIdent(c.name)} LIKE ? ESCAPE '\\'`); args.push(like); }
    }
    conds.push(ors.length ? `(${ors.join(' OR ')})` : '0');
  }
  return { where: conds.length ? `WHERE ${conds.join(' AND ')}` : '', args };
}

function defaultOrder(table) {
  if (table.rowid) return ['rowid DESC'];
  return table.pk.map((c) => `${quoteIdent(c)} DESC`);
}

function rowKey(table, row) {
  if (table.rowid) return [['rowid', String(row.__rowid)]];
  if (table.pk.length && table.pk.every((c) => !isOpaque(c))) return table.pk.map((c) => [`k.${c}`, plain(row[c])]);
  return null;
}

// ---------- names for stored numbers ----------

function enumName(column, value) {
  if (typeof value !== 'number') return null;
  if (column === 'envelope_kind' || column === 'first_kind') return KIND_NAME[value] ?? null;
  if (column === 'timeline_kind') return TIMELINE_KIND_NAME[value] ?? null;
  if (column === 'object_state') return OBJECT_STATE_NAME[value] ?? null;
  if (column === 'urgency') return URGENCY_NAME[value] ?? null;
  return null;
}
const filterLabel = (col, v) => { const n = enumName(col, /^-?\d+$/.test(v) ? Number(v) : v); return `${col} = ${n ? `${n}` : short(v, 16)}`; };

// Links from a value to related rows: where a click on that cell goes.
function cellLink(table, col, value, s) {
  if (value === null || value === undefined || isOpaque(col)) return null;
  const v = plain(value);
  const room = s.room;
  const has = (name) => s.tables.some((t) => t.name === name);
  if (col === 'room_id' && ROOM_RE.test(v)) return dataHref({ room: v, table: 'envelopes' });
  if (col === 'object_id' && has('envelopes')) return dataHref({ room, table: 'envelopes', filters: [['object_id', v]] });
  if (col === 'timeline_id' && has('envelopes')) return dataHref({ room, table: 'envelopes', filters: [['timeline_id', v]] });
  if (DEVICE_COLUMN.test(col) && has('envelopes') && /^[0-9a-f]+$/.test(v)) return dataHref({ room, table: 'envelopes', filters: [['sender_device_id', v]] });
  if (col === 'attachment_id' && table.name !== 'attachments' && has('attachments')) return dataHref({ room, table: 'attachments', filters: [['attachment_id', v]] });
  if (col === 'session_id' && table.name !== 'session_grants' && has('session_grants')) return dataHref({ room, table: 'session_grants', filters: [['session_id', v]] });
  if (col === 'invite_id' && table.name !== 'invites' && has('invites')) return dataHref({ room, table: 'invites', filters: [['invite_id', v]] });
  if (/(^|_)envelope_number$/.test(col) && table.name !== 'envelopes' && has('envelopes') && /^\d+$/.test(v)) return dataHref({ room, table: 'envelopes', filters: [['envelope_number', v]] });
  return null;
}

function cellHtml(table, col, value, s) {
  let html = renderCell(col, value);
  if (value !== null && value !== undefined && !isOpaque(col) && !isBytes(value)) {
    const name = enumName(col, value);
    if (name) html = `<span class="tag" title="${esc(value)}">${esc(name)}</span>`;
    else if (isTime(col, value)) html = `<span title="${esc(value)}">${esc(dateFmt.format(value))}</span>`;
    else if (typeof value === 'string' && /^[0-9a-f]{16,}$|^(card|session|desk)\/[0-9a-f]{32}$/.test(value)) html = `<span class="id" title="${esc(value)}">${esc(value.length > 24 ? `${value.slice(0, value.indexOf('/') + 13)}…` : value)}</span>`;
  } else if (isBytes(value) && DEVICE_COLUMN.test(col) && !isOpaque(col) && value.byteLength <= 64) {
    const v = hexOf(value);
    html = `<span class="id" title="${v}">${v.slice(0, 12)}…</span>`;
  }
  const link = cellLink(table, col, value, s);
  return link ? `<a href="${esc(link)}">${html}</a>` : html;
}

// ---------- the tree ----------

function node(href, label, count, on, extra = '') {
  return `<a class="node${on ? ' on' : ''}" href="${esc(href)}"${extra}><span>${label}</span>${count == null ? '' : `<span class="n">${esc(fmtNum(count))}</span>`}</a>`;
}

function renderTree(db, s) {
  const tables = s.tables;
  const has = (name) => tables.some((t) => t.name === name);
  const filtersKey = (f) => f.map(([c, v]) => `${c}=${v}`).sort().join('&');
  const current = `${s.room}|${s.table?.name}|${filtersKey(s.filters)}`;
  const isOn = (room, table, filters = []) => current === `${room}|${table}|${filtersKey(filters)}`;
  const leaf = (room, table, label, filters = [], count = undefined) => {
    if (!has(table)) return '';
    const n = count !== undefined ? count : roomCount(db, room, table);
    return `<li>${node(dataHref({ room, table, filters }), label, n, isOn(room, table, filters))}</li>`;
  };
  const out = ['<nav class="tree" id="tree" aria-label="Tables">'];

  // Rooms
  if (has('rooms')) {
    const rooms = db.prepare('SELECT room_id, last_envelope_number, founded_at FROM rooms ORDER BY last_envelope_number DESC, room_id LIMIT 300').all();
    const total = totalCount(db, 'rooms');
    out.push(`<div class="grp">Rooms <span class="n">${fmtNum(total)}</span></div>`);
    if (total > 8) out.push('<div class="find"><input id="roomfilter" type="search" placeholder="Filter rooms by id" aria-label="Filter rooms" autocomplete="off"></div>');
    if (s.room && !rooms.some((r) => r.room_id === s.room)) rooms.unshift({ room_id: s.room, last_envelope_number: null });
    out.push('<ul>');
    for (const r of rooms) {
      const open = r.room_id === s.room;
      const label = `<span class="mono">${esc(short(r.room_id, 12))}</span>`;
      if (!open) {
        out.push(`<li data-room="${esc(r.room_id)}">${node(dataHref({ room: r.room_id, table: 'envelopes' }), label, r.last_envelope_number, false, ` title="${esc(r.room_id)}"`)}</li>`);
        continue;
      }
      out.push(`<li data-room="${esc(r.room_id)}"><details open><summary>${node(dataHref({ room: r.room_id, table: 'envelopes' }), label, null, false, ` title="${esc(r.room_id)}"`)}</summary><ul>`);
      out.push(roomSubtree(db, r.room_id, leaf, has, tables));
      out.push('</ul></details></li>');
    }
    if (total > rooms.length) out.push(`<li class="lbl">${fmtNum(total - rooms.length)} more: open one by id (?room=…)</li>`);
    out.push('</ul>');
  }
  // Global tables
  out.push('<div class="grp">All tables</div><ul>');
  for (const t of tables) out.push(`<li>${node(dataHref({ table: t.name }), esc(t.name), totalCount(db, t.name), isOn('', t.name))}</li>`);
  out.push('</ul></nav>');
  return out.join('');
}

function roomCount(db, room, table) {
  if (!room) return totalCount(db, table);
  return cached(db, `rc:${room}:${table}`, 10000, () => {
    try { return Number(db.prepare(`SELECT count(*) AS n FROM ${quoteIdent(table)} WHERE room_id = ?`).get(room).n); } catch { return null; }
  });
}
function grouped(db, room, sql) {
  return cached(db, `g:${room}:${sql}`, 10000, () => { try { return db.prepare(sql).all(room); } catch { return []; } });
}

function roomSubtree(db, room, leaf, has, tables) {
  const out = [];
  const known = new Set(['rooms']);
  const use = (...names) => { for (const n of names) known.add(n); };
  const section = (label, inner) => { if (inner.trim()) out.push(`<li class="lbl">${label}</li>${inner}`); };

  use('devices', 'member_entries');
  section('Members', leaf(room, 'devices', 'devices') + leaf(room, 'member_entries', 'member_entries'));

  if (has('envelopes')) {
    use('envelopes', 'timelines');
    const parts = [leaf(room, 'envelopes', 'all envelopes')];
    const kinds = grouped(db, room, 'SELECT envelope_kind AS k, count(*) AS n FROM envelopes WHERE room_id = ? GROUP BY envelope_kind ORDER BY envelope_kind');
    if (kinds.length) {
      parts.push('<li class="lbl">by envelope_kind</li>');
      for (const k of kinds) parts.push(leaf(room, 'envelopes', esc(enumName('envelope_kind', k.k) ?? String(k.k)), [['envelope_kind', String(k.k)]], k.n));
    }
    const tkinds = grouped(db, room, 'SELECT timeline_kind AS k, count(*) AS n FROM envelopes WHERE room_id = ? AND timeline_kind IS NOT NULL GROUP BY timeline_kind ORDER BY timeline_kind');
    if (tkinds.length) {
      parts.push('<li class="lbl">by timeline_kind</li>');
      for (const k of tkinds) parts.push(leaf(room, 'envelopes', esc(enumName('timeline_kind', k.k) ?? String(k.k)), [['timeline_kind', String(k.k)]], k.n));
    }
    if (has('timelines')) {
      const lines = grouped(db, room, 'SELECT timeline_kind AS k, timeline_id AS id, item_count AS n FROM timelines WHERE room_id = ? ORDER BY last_envelope_number DESC LIMIT 25');
      if (lines.length) {
        parts.push(`<li class="lbl">timelines (${fmtNum(roomCount(db, room, 'timelines'))}, newest)</li>`);
        for (const l of lines) {
          const kind = enumName('timeline_kind', l.k) ?? String(l.k);
          parts.push(leaf(room, 'envelopes', `<span class="mono">${esc(String(l.id).replace(/^(\w+\/)([0-9a-f]{8})[0-9a-f]+$/, '$1$2…'))}</span> <span class="muted">${esc(kind)}</span>`, [['timeline_kind', String(l.k)], ['timeline_id', String(l.id)]], l.n));
        }
        parts.push(leaf(room, 'timelines', 'all timelines'));
      }
    }
    section('Envelopes', parts.join(''));
  }
  if (has('objects')) {
    use('objects');
    const parts = [leaf(room, 'objects', 'all objects')];
    for (const st of grouped(db, room, 'SELECT object_state AS k, count(*) AS n FROM objects WHERE room_id = ? GROUP BY object_state ORDER BY object_state')) {
      parts.push(leaf(room, 'objects', esc(enumName('object_state', st.k) ?? String(st.k)), [['object_state', String(st.k)]], st.n));
    }
    section('Objects', parts.join(''));
  }
  use('attachments', 'shares');
  section('Attachments', leaf(room, 'attachments', 'attachments') + leaf(room, 'shares', 'shares'));
  const keys = ['sealed_room_keys', 'key_back_links', 'session_grants', 'sealed_session_keys', 'session_key_back_links'];
  use(...keys);
  section('Keys', keys.map((k) => leaf(room, k, k)).join(''));
  use('invites', 'join_requests');
  section('Invites', leaf(room, 'invites', 'invites') + leaf(room, 'join_requests', 'join_requests'));
  use('accounts');
  section('Account', leaf(room, 'accounts', 'accounts'));
  const rest = [];
  for (const t of tables) if (!known.has(t.name) && t.names.has('room_id')) rest.push(leaf(room, t.name, esc(t.name)));
  section('Other', rest.join(''));
  return out.join('');
}

// ---------- the table pane ----------

function crumbs(s) {
  const parts = [`<span><a href="/data">Data</a></span>`];
  if (s.room) parts.push(`<span><a href="${esc(dataHref({ room: s.room, table: 'envelopes' }))}">room <span class="mono">${esc(short(s.room, 12))}</span></a></span>`);
  if (s.table) parts.push(`<span>${esc(s.table.name)}</span>`);
  return `<div class="crumbs">${parts.join('')}</div>`;
}

function renderTablePane(db, s) {
  const table = s.table;
  if (!table) return '<section class="pane"><div class="panehead"><h2>No tables yet</h2><p class="muted">hub.db has no tables. They are made when the hub first starts.</p></div></section>';
  const { where, args } = whereOf(table, s);
  const order = s.sort ? [`${quoteIdent(s.sort)} ${s.dir.toUpperCase()}`, ...defaultOrder(table)] : defaultOrder(table);
  const select = table.rowid ? 'SELECT rowid AS __rowid, *' : 'SELECT *';
  const rows = db.prepare(`${select} FROM ${quoteIdent(table.name)} ${where} ${order.length ? `ORDER BY ${order.join(', ')}` : ''} LIMIT ${PAGE_SIZE + 1} OFFSET ${s.page * PAGE_SIZE}`).all(...args);
  const more = rows.length > PAGE_SIZE;
  if (more) rows.pop();
  let count;
  let capped = false;
  if (!where) count = totalCount(db, table.name);
  else {
    count = Number(db.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM ${quoteIdent(table.name)} ${where} LIMIT ${COUNT_CAP + 1})`).get(...args).n);
    if (count > COUNT_CAP) { capped = true; count = COUNT_CAP; }
  }
  const roomIgnored = s.room && !table.names.has('room_id');
  const base = { room: s.room, table, filters: s.filters, q: s.q, sort: s.sort, dir: s.dir };
  const out = ['<section class="pane"><div class="panehead">', crumbs(s)];
  out.push(`<div class="titlerow"><h2>${esc(table.name)}</h2><span class="muted">${fmtNum(count)}${capped ? '+' : ''} rows${s.room && !roomIgnored ? ' in this room' : ''}${roomIgnored ? ' (no room_id: room filter ignored)' : ''}</span></div>`);
  out.push(`<div class="sum">${classSummary(table)}<a href="/schema#t-${esc(table.name)}">What the marks mean</a></div>`);
  const chips = s.filters.map(([c, v]) => {
    const rest = s.filters.filter(([x]) => x !== c);
    return `<span class="chip" title="${esc(`${c} = ${v}`)}"><span>${esc(filterLabel(c, v))}</span><a href="${esc(dataHref({ ...base, filters: rest }))}" aria-label="remove filter">×</a></span>`;
  });
  if (chips.length) out.push(`<div class="chips">${chips.join('')}</div>`);
  // Search box: keeps room, table, filters and sort as hidden fields.
  const hidden = [];
  if (s.room) hidden.push(['room', s.room]);
  hidden.push(['t', table.name]);
  for (const [c, v] of s.filters) hidden.push([`f.${c}`, v]);
  if (s.sort) hidden.push(['sort', s.sort], ['dir', s.dir]);
  const from = count ? s.page * PAGE_SIZE + 1 : 0;
  const to = s.page * PAGE_SIZE + rows.length;
  const newest = !s.sort;
  const prev = s.page > 0 ? `<a href="${esc(dataHref({ ...base, page: s.page - 1 }))}">‹ ${newest ? 'newer' : 'prev'}</a>` : `<span class="off">‹ ${newest ? 'newer' : 'prev'}</span>`;
  const next = more ? `<a href="${esc(dataHref({ ...base, page: s.page + 1 }))}">${newest ? 'older' : 'next'} ›</a>` : `<span class="off">${newest ? 'older' : 'next'} ›</span>`;
  out.push(`<div class="tools"><form method="get" action="/data">${hidden.map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}<input type="search" name="q" value="${esc(s.q)}" placeholder="Filter: id prefix, number, text" aria-label="Filter rows"><button>Filter</button></form>
<div class="pager"><span>${fmtNum(from)}–${fmtNum(to)} of ${fmtNum(count)}${capped ? '+' : ''} · page ${s.page + 1}</span>${prev}${next}</div></div>`);
  out.push('</div><div class="tablewrap"><table class="grid"><thead><tr><th></th>');
  // Inside a room its room_id is the same on every row: left out of the table (the row detail has it).
  const shown = s.room && !roomIgnored ? table.columns.filter((c) => c.name !== 'room_id') : table.columns;
  for (const c of shown) {
    const mark = classMark(classOf(table.name, c.name));
    if (isOpaque(c.name)) { out.push(`<th>${esc(c.name)}${mark}</th>`); continue; }
    const on = s.sort === c.name;
    const dir = on && s.dir === 'desc' ? 'asc' : 'desc';
    out.push(`<th><a${on ? ' class="on"' : ''} href="${esc(dataHref({ room: s.room, table, filters: s.filters, q: s.q, sort: c.name, dir }))}" title="sort">${esc(c.name)}${on ? (s.dir === 'desc' ? ' ↓' : ' ↑') : ''}</a>${mark}</th>`);
  }
  out.push('</tr></thead><tbody>');
  const selected = s.key.map(([k, v]) => `${k}=${v}`).join('&');
  for (const row of rows) {
    const key = rowKey(table, row);
    const href = key ? dataHref({ ...base, page: s.page, key }) : '';
    const isSel = key && key.map(([k, v]) => `${k}=${v}`).join('&') === selected;
    out.push(`<tr${href ? ` data-href="${esc(href)}"` : ''}${isSel ? ' class="sel"' : ''}><td class="open">${href ? `<a href="${esc(href)}" aria-label="open row">›</a>` : ''}</td>`);
    for (const c of shown) {
      const v = row[c.name];
      const num = typeof v === 'number' && !enumName(c.name, v) && !isTime(c.name, v);
      out.push(`<td${num ? ' class="num"' : ''}>${cellHtml(table, c.name, v, s)}</td>`);
    }
    out.push('</tr>');
  }
  if (!rows.length) out.push(`<tr><td class="none" colspan="${shown.length + 1}">${where ? 'No rows match.' : 'This table is empty.'}</td></tr>`);
  out.push('</tbody></table></div></section>');
  return out.join('');
}

// ---------- the row detail ----------

function decodeHeader(row) {
  try {
    const bytes = (v) => (isBytes(v) ? v : null);
    const env = joinEnvelope({ headerBytes: bytes(row.envelope_header), nonce: bytes(row.envelope_nonce), signature: bytes(row.envelope_signature), ciphertextHash: bytes(row.encrypted_body_hash) });
    return { header: peekEnvelope(env).header };
  } catch (error) { return { error: error.message || String(error) }; }
}
const hx = (b) => hexOf(b);
const masked = (b) => `<span class="opaque">${b.length} B · ${hx(b.subarray(0, 16))}${b.length > 16 ? '…' : ''}</span>`;

function renderHeader(h, s) {
  const dev = (b) => { const v = hx(b); return `<a class="id" href="${esc(dataHref({ room: s.room, table: 'envelopes', filters: [['sender_device_id', v]] }))}">${v}</a>`; };
  const rows = [
    ['room', `<span class="id">${hx(h.roomId)}</span>`],
    ['key', `${h.keyScope === 1 ? 'session' : 'room'} key, epoch ${h.epoch}${h.sessionId ? ` · session <span class="id">${hx(h.sessionId)}</span>` : ''}`],
    ['sender', dev(h.sender)],
    ['sequence', `${h.seq} · previous ${masked(h.prev)}`],
    ['member log', `entry ${h.logSeq} · ${masked(h.logHash)}`],
    ['recipient', h.recipient.every((x) => x === 0) ? '<span class="muted">everyone</span>' : dev(h.recipient)],
    ['time', `${esc(dateFmt.format(Number(h.time)))} <span class="muted">(${esc(String(h.time))})</span>`],
    ['kind', `${esc(KIND_NAME[h.kind] ?? String(h.kind))} <span class="muted">(${h.kind}${h.isHead ? ', head' : ', thread item'})</span>`],
    ['push', h.push ? 'yes' : 'no'],
  ];
  if (h.card) rows.push(['object', `<a class="id" href="${esc(dataHref({ room: s.room, table: 'envelopes', filters: [['object_id', hx(h.card.id)]] }))}">${hx(h.card.id)}</a> · ${esc(OBJECT_STATE_NAME[h.card.state] ?? h.card.state)} · ${esc(URGENCY_NAME[h.card.urgency] ?? h.card.urgency)}${h.card.answeredAt ? ` · answered ${esc(dateFmt.format(Number(h.card.answeredAt)))}` : ''}`]);
  if (h.timelineId) rows.push(['timeline', `${esc(TIMELINE_KIND_NAME[h.timelineKind] ?? h.timelineKind)} · <a class="id" href="${esc(dataHref({ room: s.room, table: 'envelopes', filters: [['timeline_id', h.timelineId]] }))}">${esc(h.timelineId)}</a>`]);
  if (h.blobs.length) rows.push(['attachments', h.blobs.map((b) => `<a class="id" href="${esc(dataHref({ room: s.room, table: 'attachments', filters: [['attachment_id', hx(b)]] }))}">${hx(b)}</a>`).join('<br>')]);
  rows.push(['seen', h.seen.length ? h.seen.map((x) => `<span class="id">${hx(x.sender).slice(0, 12)}…</span> #${x.seq}`).join('<br>') : '<span class="muted">none</span>']);
  return `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
}

function relations(table, row, s) {
  const room = row.room_id && ROOM_RE.test(String(row.room_id)) ? String(row.room_id) : s.room;
  const has = (name) => s.tables.some((t) => t.name === name);
  const links = [];
  const add = (label, t, filters) => { if (has(t)) links.push([label, dataHref({ room, table: t, filters })]); };
  const v = (c) => (row[c] == null ? null : plain(row[c]));
  if (v('object_id')) {
    add('object row', 'objects', [['object_id', v('object_id')]]);
    add('all envelopes of this object (versions, answers)', 'envelopes', [['object_id', v('object_id')]]);
    add('card timeline (chat on the card)', 'envelopes', [['timeline_id', `card/${v('object_id')}`]]);
    add('attachments of this object', 'attachments', [['object_id', v('object_id')]]);
  }
  if (v('timeline_id')) add('this timeline', 'envelopes', [['timeline_id', v('timeline_id')]]);
  for (const c of table.columns.map((x) => x.name)) {
    if (!DEVICE_COLUMN.test(c) || !v(c) || !/^[0-9a-f]+$/.test(v(c))) continue;
    add(`${c}: the device`, 'devices', [['device_id', v(c)]]);
    add(`${c}: its envelopes`, 'envelopes', [['sender_device_id', v(c)]]);
  }
  if (table.name === 'devices' && v('device_id')) {
    add('sealed room keys of this device', 'sealed_room_keys', [['device_id', v('device_id')]]);
    add('member entries it signed', 'member_entries', [['signer_device_id', v('device_id')]]);
    add('agent lease', 'agent_leases', [['device_id', v('device_id')]]);
  }
  for (const c of ['first_envelope_number', 'latest_head_envelope_number', 'last_envelope_number', 'added_entry_number']) {
    if (v(c) == null || table.name === 'rooms') continue;
    if (c === 'added_entry_number') add('member entry that added it', 'member_entries', [['entry_number', v(c)]]);
    else add(c.replace(/_/g, ' '), 'envelopes', [['envelope_number', v(c)]]);
  }
  if (v('attachment_id')) { add('attachment row', 'attachments', [['attachment_id', v('attachment_id')]]); add('shares of it', 'shares', [['attachment_id', v('attachment_id')]]); }
  if (v('attachment_ids')) for (const id of String(v('attachment_ids')).match(/[0-9a-f]{32}/g) || []) add(`attachment ${id.slice(0, 8)}…`, 'attachments', [['attachment_id', id]]);
  if (v('session_id')) { add('session grants', 'session_grants', [['session_id', v('session_id')]]); add('sealed session keys', 'sealed_session_keys', [['session_id', v('session_id')]]); }
  if (v('invite_id')) { add('invite', 'invites', [['invite_id', v('invite_id')]]); add('join requests', 'join_requests', [['invite_id', v('invite_id')]]); }
  if (room && table.name !== 'envelopes') add('room: all envelopes', 'envelopes', []);
  const seen = new Set();
  return links.filter(([, h]) => !seen.has(h) && seen.add(h));
}

function renderDetail(db, s) {
  const table = s.table;
  if (!table || !s.key.length) return '';
  const keyCols = s.key.map(([k]) => (k === 'rowid' ? 'rowid' : quoteIdent(k.slice(2))));
  const args = s.key.map(([k, v]) => (k === 'rowid' ? Number(v) : bindFor(table, k.slice(2), v)));
  const select = table.rowid ? 'SELECT rowid AS __rowid, *' : 'SELECT *';
  const row = db.prepare(`${select} FROM ${quoteIdent(table.name)} WHERE ${keyCols.map((c) => `${c} = ?`).join(' AND ')} LIMIT 1`).get(...args);
  const close = dataHref({ room: s.room, table, filters: s.filters, q: s.q, sort: s.sort, dir: s.dir, page: s.page });
  const out = [`<aside class="detail" aria-label="Row"><header><h3>${esc(table.name)} <span class="muted">${esc(s.key.map(([k, v]) => `${k.replace(/^k\./, '')} ${short(v, 12)}`).join(' · '))}</span></h3><a class="close" href="${esc(close)}" aria-label="close">×</a></header>`];
  if (!row) { out.push('<p class="muted">This row does not exist (any more).</p></aside>'); return out.join(''); }
  const rel = relations(table, row, s);
  if (rel.length) out.push(`<h4>Related</h4><ul class="rel">${rel.map(([label, h]) => `<li><a href="${esc(h)}">${esc(label)} →</a></li>`).join('')}</ul>`);
  if (table.name === 'envelopes' && 'envelope_header' in row) {
    const d = decodeHeader(row);
    out.push('<h4>Cleartext header, decoded</h4>');
    out.push(d.header ? renderHeader(d.header, s) : `<p class="note">The stored header does not decode: ${esc(d.error)}</p>`);
    out.push('<p class="note">Signed but not encrypted: the hub routes by it. The body stays ciphertext and is shown as size + first bytes only.</p>');
  }
  out.push('<h4>All columns</h4><dl class="kv">');
  for (const c of table.columns) {
    const v = row[c.name];
    let html;
    if (v === null || v === undefined || isOpaque(c.name) || isBytes(v)) html = renderCell(c.name, v);
    else {
      const text = String(v);
      html = esc(text.length > 4000 ? `${text.slice(0, 4000)}…` : text);
      if (/^[0-9a-f]{16,}$/.test(text)) html = `<span class="id">${html}</span>`;
      const name = enumName(c.name, v);
      if (name) html += ` <span class="tag">${esc(name)}</span>`;
      if (isTime(c.name, v)) html += ` <span class="muted">${esc(dateFmt.format(v))}</span>`;
    }
    const link = cellLink(table, c.name, v, s);
    out.push(`<dt>${esc(c.name)}${classMark(classOf(table.name, c.name))}</dt><dd>${link ? `<a href="${esc(link)}">${html}</a>` : html}</dd>`);
  }
  out.push('</dl></aside>');
  return out.join('');
}

/** The data browser: tree | table | (row). */
export function renderData(db, params, { login = '', csrf = '' } = {}) {
  const tables = tableInfo(db);
  const s = { ...parseState(params, tables), tables };
  const detail = renderDetail(db, s);
  const where = [s.room ? `room ${short(s.room, 8)}` : 'all tables', s.table?.name].filter(Boolean).join(' › ');
  return `${head('Daten · Trommi hub admin')}${login ? topBar(login, csrf, 'data') : ''}<input type="checkbox" id="tt" aria-label="show tree"><label class="treetoggle" for="tt"><span>Tree: <b>${esc(where)}</b></span></label><div class="data${detail ? ' with-detail' : ''}">${renderTree(db, s)}${renderTablePane(db, s)}${detail}</div>${foot}`;
}

// ---------- overview: tiles and charts ----------

export const RANGES = { '1h': { ms: 3600000, label: '1 h' }, '24h': { ms: 86400000, label: '24 h' }, '7d': { ms: 7 * 86400000, label: '7 d' } };

const pctOf = (part, whole) => (whole > 0 ? (100 * part) / whole : NaN);
/** One point from a 10 s ring sample or a persisted minute row. */
function pointOf(x) {
  const ring = 'mem_available_bytes' in x;
  return {
    at: x.at,
    cpu: x.cpu_percent ?? (ring && x.cpus ? (100 * x.load1) / x.cpus : NaN),
    ram: ring ? pctOf((x.mem_total_bytes ?? NaN) - x.mem_available_bytes, x.mem_total_bytes ?? NaN) : x.mem_used_percent,
    disk: x.disk_free_bytes,
    diskTotal: x.disk_total_bytes,
    streams: x.open_streams,
    ingest: ring ? x.envelopes_per_second * 60 : x.envelopes_per_minute,
    latency: x.request_ms_p95,
    requests: x.requests_per_second,
    db: (x.sqlite_bytes ?? NaN) + (x.wal_bytes ?? 0),
  };
}

function loadPoints({ metrics, dataDir, range, now }) {
  const since = now - RANGES[range].ms;
  // 1 h: the 10 s samples of this process, and before its first sample the persisted minutes (a restart leaves no hole).
  const ring = range === '1h' && metrics?.history ? metrics.history().filter((x) => x.at >= since) : [];
  let minutes = [];
  if (metrics?.series) minutes = metrics.series(since, 360);
  else if (dataDir) {
    let series = null;
    try { series = openSeries(dataDir, { readOnly: true }); minutes = series ? series.read(since, 360, now) : []; } catch { minutes = []; } finally { series?.close(); }
  }
  const firstRing = ring.length ? ring[0].at : Infinity;
  const rows = [...minutes.filter((x) => x.at + 60000 <= firstRing), ...ring];
  return rows.map(pointOf).filter((p) => p.at >= since && p.at <= now + 60000);
}

const PCT = (v) => `${fmtNum(v, v < 10 ? 1 : 0)} %`;
const MS = (v) => `${fmtNum(v, v < 10 ? 1 : 0)} ms`;
const SERIES = [
  { key: 'cpu', tile: 'CPU', title: 'CPU', fmt: PCT, max: 100 },
  { key: 'ram', tile: 'RAM', title: 'RAM used', fmt: PCT, max: 100 },
  { key: 'disk', tile: 'Disk free', title: 'Disk free (data)', fmt: formatBytes },
  { key: 'streams', tile: 'Open streams', title: 'Open streams', fmt: (v) => fmtNum(v) },
  { key: 'ingest', tile: 'Ingest', title: 'Ingest, envelopes/min', fmt: (v) => fmtNum(v, v < 10 ? 1 : 0) },
  { key: 'latency', tile: 'Latency', title: 'Request latency p95', fmt: MS },
  { key: 'requests', title: 'Requests/s', fmt: (v) => fmtNum(v, 1) },
  { key: 'db', tile: 'Database', title: 'Database (hub.db + WAL)', fmt: formatBytes },
];

function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** Path data for line and area in a 1000 x 200 box; gaps longer than 3 steps break the line. */
function paths(pts, t0, t1, max, step) {
  let line = ''; let area = ''; let seg = [];
  const flush = () => {
    if (!seg.length) return;
    line += `M${seg.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L')}`;
    area += `M${seg[0][0].toFixed(1)},200L${seg.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L')}L${seg.at(-1)[0].toFixed(1)},200Z`;
    if (seg.length === 1) line += `L${(seg[0][0] + 0.01).toFixed(2)},${seg[0][1].toFixed(1)}`;
    seg = [];
  };
  let prevAt = null;
  for (const p of pts) {
    if (prevAt != null && p.at - prevAt > Math.max(step * 3.5, 150000)) flush();
    seg.push([((p.at - t0) / (t1 - t0)) * 1000, 200 - (Math.max(0, p.v) / max) * 200]);
    prevAt = p.at;
  }
  flush();
  return { line, area };
}

function timeLabel(t, range) {
  if (range === '1h') return timeFmt.format(t);
  if (range === '24h') return timeFmt.format(t);
  return dayFmt.format(t);
}

function chartSvg(pts, t0, t1, max, step, cls) {
  const { line, area } = paths(pts, t0, t1, max, step);
  return `<svg class="${cls}" viewBox="0 0 1000 200" preserveAspectRatio="none" aria-hidden="true">${cls === 'plot' ? '<g class="grid"><line x1="0" y1="0.5" x2="1000" y2="0.5" vector-effect="non-scaling-stroke"/><line x1="0" y1="100" x2="1000" y2="100" vector-effect="non-scaling-stroke"/><line x1="0" y1="199.5" x2="1000" y2="199.5" vector-effect="non-scaling-stroke"/></g>' : ''}<path class="area" d="${area}"/><path class="line" d="${line}" vector-effect="non-scaling-stroke"/>${cls === 'plot' ? '<line class="hair" x1="0" y1="0" x2="0" y2="200" vector-effect="non-scaling-stroke"/><line class="dot" x1="0" y1="0" x2="0" y2="0" vector-effect="non-scaling-stroke"/>' : ''}</svg>`;
}

export function renderOverview({ db, dbPath, dataDir, metrics, startedAt, range: wanted, now = Date.now(), login = '', csrf = '' } = {}) {
  const range = RANGES[wanted] ? wanted : '1h';
  const t1 = now; const t0 = now - RANGES[range].ms;
  const step = range === '1h' ? 10000 : Math.max(60000, Math.ceil(RANGES[range].ms / 360 / 60000) * 60000);
  const points = loadPoints({ metrics, dataDir, range, now });
  const h = hostStats(dataDir || '/');
  const cpus = h.cpus || os.availableParallelism();
  const memUsed = h.memTotal - h.memAvailable;
  const last = metrics?.history?.().at(-1);
  const dbSize = dbPath ? fileSize(dbPath) + fileSize(`${dbPath}-wal`) : 0;
  const attachmentsSize = dataDir ? dirSize(path.join(dataDir, 'attachments')) : 0;

  const now1 = {
    cpu: last?.cpu_percent ?? (100 * h.load[0]) / cpus,
    ram: pctOf(memUsed, h.memTotal),
    disk: h.disk.free,
    streams: last?.open_streams,
    ingest: last ? last.envelopes_per_second * 60 : undefined,
    latency: last?.request_ms_p95,
    requests: last?.requests_per_second,
    db: dbSize,
  };
  const sub = {
    cpu: `load ${h.load.map((x) => x.toFixed(2)).join(' / ')} · ${cpus} cores`,
    ram: `${formatBytes(memUsed)} of ${formatBytes(h.memTotal)}`,
    disk: `${PCT(pctOf(h.disk.free, h.disk.total))} of ${formatBytes(h.disk.total)} free`,
    streams: 'live connections now',
    ingest: 'envelopes per minute',
    latency: 'p95, streams excluded',
    requests: 'all routes',
    db: `attachments ${formatBytes(attachmentsSize)}`,
  };
  const tiles = [];
  const charts = [];
  for (const def of SERIES) {
    const pts = points.map((p) => ({ at: p.at, v: p[def.key] })).filter((p) => Number.isFinite(p.v));
    const peak = pts.reduce((m, p) => Math.max(m, p.v), 0);
    const max = def.max ?? niceMax(peak * 1.1);
    const cur = Number.isFinite(now1[def.key]) ? now1[def.key] : pts.at(-1)?.v;
    const value = Number.isFinite(cur) ? def.fmt(cur) : '–';
    const [big, unit] = /^([\d.,–-]+)\s?(.*)$/.exec(value)?.slice(1) ?? [value, ''];
    if (def.key !== 'requests') {
      tiles.push(`<div class="tile"><div class="k">${esc(def.tile)}</div><div class="v">${esc(big)}${unit ? `<small>${esc(unit)}</small>` : ''}</div><div class="s">${esc(sub[def.key])}</div>${pts.length > 1 ? chartSvg(pts, t0, t1, max, step, 'spark') : '<svg class="spark" aria-hidden="true"></svg>'}</div>`);
    }
    if (!pts.length) {
      charts.push(`<figure class="chart"><header><h3>${esc(def.title)}</h3><span class="readout">no data yet</span></header><div class="empty">${range === '1h' ? 'The first sample comes within 10 s.' : 'Collected every minute from now on.'}</div></figure>`);
      continue;
    }
    const lastPt = pts.at(-1);
    const hover = pts.map((p) => [+(((p.at - t0) / (t1 - t0))).toFixed(4), +(1 - Math.max(0, p.v) / max).toFixed(4), `${range === '7d' ? dayTimeFmt.format(p.at) : timeFmt.format(p.at)} · ${def.fmt(p.v)}`]);
    const mid = t0 + (t1 - t0) / 2;
    charts.push(`<figure class="chart" data-pts="${esc(JSON.stringify(hover))}"><header><h3>${esc(def.title)}</h3><span class="readout">${esc(`now ${def.fmt(lastPt.v)} · peak ${def.fmt(peak)}`)}</span></header>
<div class="plotwrap"><span class="ylab y100">${esc(def.fmt(max))}</span><span class="ylab y50">${esc(def.fmt(max / 2))}</span><span class="ylab y0">0</span>${chartSvg(pts, t0, t1, max, step, 'plot')}</div>
<div class="xlabs"><span>${esc(timeLabel(t0, range))}</span><span>${esc(timeLabel(mid, range))}</span><span>${esc(range === '1h' ? 'now' : timeLabel(t1, range))}</span></div></figure>`);
  }
  const seg = Object.entries(RANGES).map(([k, r]) => `<a href="/?range=${k}"${k === range ? ' class="on"' : ''}>${r.label}</a>`).join('');

  // Hub process and tables
  const hub = [];
  if (startedAt) hub.push(['Uptime', `${Math.floor((now - startedAt) / 3600000)} h ${Math.floor(((now - startedAt) % 3600000) / 60000)} min`]);
  if (last) {
    hub.push(['Hub process', `RSS ${formatBytes(last.rss_bytes)} · heap ${formatBytes(last.heap_used_bytes)}`]);
    hub.push(['Event loop', `lag p99 ${MS(last.event_loop_lag_p99_ms)} · GC max ${MS(last.gc_max_ms)}`]);
    hub.push(['Writes', `queue ${last.write_queue_depth} · stream buffers ${formatBytes(last.outbound_bytes_total)}`]);
    hub.push(['SQLite', `${formatBytes(last.sqlite_bytes)} · WAL ${formatBytes(last.wal_bytes)}`]);
  } else if (metrics) hub.push(['Hub', 'first metrics sample in under 10 s']);
  hub.push(['hub.db', `${formatBytes(dbSize)} · attachments: ${formatBytes(attachmentsSize)}`]);
  let tablesHtml = '<p class="muted">hub.db does not exist yet.</p>';
  if (db) {
    const tables = tableInfo(db);
    tablesHtml = `<ul class="tlist">${tables.map((t) => `<li><a href="${esc(dataHref({ table: t.name }))}"><span>${esc(t.name)}</span><span class="n">${esc(fmtNum(totalCount(db, t.name)))}</span></a></li>`).join('')}</ul>`;
  }
  return `${head('Übersicht · Trommi hub admin')}${login ? topBar(login, csrf, 'overview') : ''}<main class="page">
<div class="head"><h1>Overview</h1><div class="seg" role="tablist" aria-label="Range">${seg}</div><span class="muted">${esc(dateFmt.format(now))}</span></div>
<div class="tiles">${tiles.join('')}</div>
<div class="charts">${charts.join('')}</div>
<div class="cols"><section class="card"><h3>Hub</h3><dl class="kv">${hub.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></section>
<section class="card"><h3>Tables <span><a href="/data">Data browser</a> · <a href="/schema">Schema</a></span></h3>${tablesHtml}</section></div>
</main>${foot}`;
}

// ---------- test accounts ----------

/**
 * The accounts whose email ends with @example.org (from hub/ops/delete-room.mjs testAccounts) and the delete form.
 * Their emails are shown in full: they are throwaway addresses by construction, and the list is fixed by the
 * suffix, so it is no oracle on real addresses (those stay opaque everywhere else).
 * result: what deleteTestRooms returned (shown after a deletion); message: an error line.
 */
export function renderTestAccounts(list, { login = '', csrf = '', canDelete = false, message = '', result = null } = {}) {
  const when = (t) => (Number.isFinite(t) && t > 0 ? dateFmt.format(t) : '–');
  const n = list.length;
  let done = '';
  if (result) {
    const totals = Object.entries(result.totals || {}).filter(([k]) => k !== 'files').sort(([a], [b]) => a.localeCompare(b));
    done = `<section class="card"><h3 class="ok">Deleted ${esc(fmtNum(result.deleted.length))} test room${result.deleted.length === 1 ? '' : 's'}</h3><dl class="kv">
<dt>backup</dt><dd class="mono">${esc(result.backup)}</dd>
${totals.map(([t, c]) => `<dt>${esc(t)}</dt><dd>${esc(fmtNum(c))} rows</dd>`).join('')}
<dt>attachment files</dt><dd>${esc(fmtNum(result.totals?.files || 0))}</dd>
${result.refused.length ? `<dt class="err">refused</dt><dd class="err">${result.refused.map((r) => esc(`${r.room_id.slice(0, 12)}: ${r.message}`)).join('<br>')}</dd>` : ''}
</dl><p class="note">Every deleted room is also written to deletions.log in the hub's data directory.</p></section>`;
  }
  const rows = list.map((r) => `<tr><td class="mono">${esc(r.email)}</td><td><a class="id" href="${esc(dataHref({ room: r.room_id }))}">${esc(r.room_id.slice(0, 12))}…</a></td>
<td>${esc(when(r.created_at))}</td><td>${esc(when(r.last_activity))}</td><td class="num">${esc(fmtNum(r.envelopes))}</td><td class="num">${esc(fmtNum(r.attachments))}</td></tr>`).join('');
  const table = n ? `<div class="scroll"><table class="grid"><thead><tr><th>email</th><th>room</th><th>created</th><th>last activity</th><th>envelopes</th><th>attachments</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">No accounts with an email ending in @example.org.</p>';
  const form = n && canDelete
    ? `<form class="confirm" method="post" action="/test-accounts/delete"><input type="hidden" name="csrf" value="${esc(csrf)}">
<label for="confirm-n" class="muted">Type ${n} to confirm</label><input id="confirm-n" type="text" name="confirm" inputmode="numeric" autocomplete="off" required pattern="${n}">
<button class="danger">Delete these ${n} test rooms</button></form>
<p class="note">Removes every row of these rooms (account, members, devices, keys, envelopes, cards, attachments and their files, push registrations, links) in one transaction per room, after an online backup of hub.db to backups/ in the data directory. Only rooms whose account email ends with @example.org can be deleted.</p>`
    : n ? '<p class="note">Deleting needs the running hub (this listener has no hub attached).</p>' : '';
  return `${head('Test accounts · Trommi hub admin')}${login ? topBar(login, csrf, 'tests') : ''}<main class="page">
<div class="head"><h1>Test accounts</h1><span class="muted">${esc(fmtNum(n))} with an email ending in @example.org</span></div>
${message ? `<p class="err">${esc(message)}</p>` : ''}${done}
<section class="card">${table}${form}</section>
</main>${foot}`;
}
