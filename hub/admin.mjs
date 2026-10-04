// Read-only admin view of hub.db, on its own listener (default 8791), never part of the public 8790 listener.
//
// Wired in by hub/server.mjs when ADMIN_PORT is set. On trommi-hub: ADMIN_HOST=0.0.0.0 inside the container with
// ADMIN_PUBLISHED_LOOPBACK=1, the container port published on the host's 127.0.0.1:8791 only (compose.override.yaml,
// written by the deploy), and `tailscale serve --https=8443 http://localhost:8791` in front of it:
// https://trommi-hub.tail276436.ts.net:8443
//
// Two checks on every request, both required:
//   1. Header Tailscale-User-Login names a login in ADMIN_LOGINS (required; there is no default login).
//      Why the header can be trusted at all: the listener binds a loopback address only (startAdmin refuses any
//      other host), so the only ones who can send it a request are processes on the same machine; the intended one
//      is `tailscale serve` on that host, which strips any client-sent Tailscale-User-Login and sets it itself from
//      the authenticated tailnet identity. Every other local process (and a sibling container sharing the host's
//      network) could forge it, so the header alone is never enough: the password below is the second factor.
//      Never put this listener behind any proxy that passes client headers through (cloudflared, nginx, a Docker port
//      published beyond the host's loopback): there the header is whatever the caller writes. Inside a container the
//      listener must bind 0.0.0.0 for Docker's port mapping to reach it; that is allowed only with
//      allowPublishedLoopback (ADMIN_PUBLISHED_LOOPBACK=1), which states that the port is published on 127.0.0.1 only.
//   2. A session cookie from the admin password (scrypt hash in <dataDir>/admin-password-hash, or the
//      initial ADMIN_PASSWORD_HASH env value while that file does not exist).
//
// Hub data is opened read-only. The only write this module ever does is the password hash file.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { hostStats } from './ops/metrics.mjs';

const scryptAsync = promisify(crypto.scrypt);
const PAGE_SIZE = 50;
const SESSION_MS = 12 * 60 * 60 * 1000;
const COOKIE = 'trommi_admin';
const MIN_PASSWORD = 16;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAILS_PER_LOGIN = 5;
const FAILS_GLOBAL = 20;
export const PASSWORD_FILE = 'admin-password-hash';

// ---------- password hashing ----------
// Format: scrypt:<N>:<r>:<p>:<salt b64url>:<hash b64url>  (no "$", so it is safe in a compose .env file)

export async function hashPassword(password, { N = 16384, r = 8, p = 1 } = {}) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(String(password).normalize('NFC'), salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt:${N}:${r}:${p}:${salt.toString('base64url')}:${Buffer.from(hash).toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').trim().split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every(Number.isInteger) || N > 1 << 20 || r > 32 || p > 16) return false;
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  if (expected.length < 16) return false;
  const got = Buffer.from(await scryptAsync(String(password).normalize('NFC'), salt, expected.length, { N, r, p, maxmem: 256 * 1024 * 1024 }));
  return crypto.timingSafeEqual(got, expected);
}

// ---------- Tailscale login ----------

export function parseLogins(value) {
  return new Set(String(value ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

function headerLogin(headers) {
  const raw = headers['tailscale-user-login'];
  return String(Array.isArray(raw) ? raw[0] : raw ?? '').trim().toLowerCase();
}

// ---------- rendering ----------

const CSS = `body{font:14px/1.4 system-ui,sans-serif;margin:16px;color:#222;background:#fafaf7}
h1{font-size:18px;margin:0 0 8px}h2{font-size:15px;margin:16px 0 6px}
table{border-collapse:collapse;font-size:12px}td,th{border:1px solid #ddd;padding:3px 6px;text-align:left;vertical-align:top;max-width:28em;overflow-wrap:anywhere}
th{background:#eee}.opaque{color:#666;font-family:ui-monospace,monospace}.null{color:#aaa}.err{color:#b00}
nav a{margin-right:10px}.wrap{overflow-x:auto}form{margin:8px 0}form.inline{display:inline}label{margin-right:8px}
@media (prefers-color-scheme:dark){body{background:#1b1b1a;color:#ddd}th{background:#2a2a28}td,th{border-color:#3a3a38}a{color:#9cf}.err{color:#f88}}`;
const CSS_HASH = crypto.createHash('sha256').update(CSS).digest('base64');
const CSP = `default-src 'none'; style-src 'sha256-${CSS_HASH}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`;

// Columns whose content is ciphertext, signed blobs or secrets: never shown in full.
// escrow_id: with the room id it fetches the escrow blob and is itself a passphrase-derived verifier (review 3).
const OPAQUE_COLUMN = /^(encrypted_body|key_sealed|key_back_link|envelope_header|envelope_nonce|envelope_signature|subscription|endpoint|access_token.*|signed_.*|.*_signature|escrow_id|key_escrow|.*_secret.*|.*_hash|.*_salt|.*_wrapped|email)$/;

function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function opaqueBytes(value) {
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const text = String(value);
  if (/^[A-Za-z0-9_-]+$/.test(text)) return Buffer.from(text, 'base64url');
  return Buffer.from(text, 'utf8');
}

export function renderCell(column, value) {
  if (value === null || value === undefined) return '<span class="null">NULL</span>';
  if (value instanceof Uint8Array || OPAQUE_COLUMN.test(column)) {
    const bytes = opaqueBytes(value);
    const hex = bytes.subarray(0, 16).toString('hex');
    return `<span class="opaque">${bytes.length} B · ${hex}${bytes.length > 16 ? '…' : ''}</span>`;
  }
  const text = String(value);
  return esc(text.length > 300 ? `${text.slice(0, 300)}…` : text);
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n; let i = -1;
  do { v /= 1024; i += 1; } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(1)} ${units[i]}`;
}

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

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;

function tableInfo(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  return tables.map((name) => {
    const columns = db.prepare(`PRAGMA table_info(${quoteIdent(name)})`).all();
    let count = null;
    try { count = Number(db.prepare(`SELECT count(*) AS n FROM ${quoteIdent(name)}`).get().n); } catch { /* ignore */ }
    return { name, columns, count };
  });
}

function orderClause(db, table) {
  // Newest first: rowid if the table has one, else the primary key columns descending.
  try {
    db.prepare(`SELECT rowid FROM ${quoteIdent(table.name)} LIMIT 0`).all();
    return 'ORDER BY rowid DESC';
  } catch {
    const pk = table.columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
    return pk.length ? `ORDER BY ${pk.map((c) => `${quoteIdent(c.name)} DESC`).join(', ')}` : '';
  }
}

function link(params) {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '' && v !== null) search.set(k, String(v));
  const s = search.toString();
  return `/${s ? `?${s}` : ''}`;
}

const head = (title) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body>`;

function topBar(login, csrf) {
  return `<p>${esc(login)} · <a href="/">Tabellen</a> · <a href="/password">Passwort ändern</a> · <form class="inline" method="post" action="/logout"><input type="hidden" name="csrf" value="${esc(csrf)}"><button>Abmelden</button></form></p>`;
}

export function renderLoginPage(login, message = '') {
  return `${head('Trommi hub admin')}<h1>Trommi hub admin</h1><p>Tailscale login: ${esc(login)}</p>${message ? `<p class="err">${esc(message)}</p>` : ''}
<form method="post" action="/login"><label>Admin password <input type="password" name="password" autocomplete="current-password" required autofocus></label> <button>Anmelden</button></form></body></html>`;
}

function renderPasswordPage(login, csrf, message = '') {
  return `${head('Trommi hub admin')}<h1>Passwort ändern</h1>${topBar(login, csrf)}${message ? `<p class="err">${esc(message)}</p>` : ''}
<form method="post" action="/password"><input type="hidden" name="csrf" value="${esc(csrf)}">
<p><label>Current password <input type="password" name="current" autocomplete="current-password" required></label></p>
<p><label>New password (at least ${MIN_PASSWORD} characters) <input type="password" name="new1" autocomplete="new-password" minlength="${MIN_PASSWORD}" required></label></p>
<p><label>New password again <input type="password" name="new2" autocomplete="new-password" minlength="${MIN_PASSWORD}" required></label></p>
<p><button>change</button> (signs out every admin session)</p></form></body></html>`;
}

function pct(part, whole) { return whole > 0 ? `${Math.round((100 * part) / whole)} %` : '?'; }

/** Host and hub numbers: CPU (load / cores), RAM, free disk; the newest 10 s metrics sample when the hub passes its metrics. */
export function renderOverview({ dataDir, metrics, startedAt, now = Date.now } = {}) {
  const h = hostStats(dataDir || '/');
  const cpus = h.cpus || os.availableParallelism();
  const used = h.memTotal - h.memAvailable;
  const rows = [
    ['CPU', `load ${h.load.map((x) => x.toFixed(2)).join(' / ')} (1/5/15 min) on ${cpus} cores · ${pct(h.load[0], cpus)}`],
    ['RAM', `${formatBytes(used)} used of ${formatBytes(h.memTotal)} (${pct(used, h.memTotal)}), ${formatBytes(h.memAvailable)} available`],
    ['Disk (data)', `${formatBytes(h.disk.free)} free of ${formatBytes(h.disk.total)} (${pct(h.disk.free, h.disk.total)} free)`],
  ];
  const last = metrics?.history?.().at(-1);
  if (last) {
    rows.push(
      ['Hub', `${last.open_streams} open streams · ${last.requests_per_second.toFixed(1)} req/s · ${last.envelopes_per_second.toFixed(2)} envelopes/s · write queue ${last.write_queue_depth}`],
      ['Hub process', `RSS ${formatBytes(last.rss_bytes)} · heap ${formatBytes(last.heap_used_bytes)} · event-loop lag p99 ${last.event_loop_lag_p99_ms.toFixed(1)} ms · GC max ${last.gc_max_ms.toFixed(1)} ms`],
      ['SQLite', `${formatBytes(last.sqlite_bytes)} · WAL ${formatBytes(last.wal_bytes)} · stream buffers ${formatBytes(last.outbound_bytes_total)}`],
    );
  } else if (metrics) rows.push(['Hub', 'first metrics sample in under 10 s']);
  if (startedAt) rows.push(['Uptime', `${Math.floor((now() - startedAt) / 3600000)} h ${Math.floor(((now() - startedAt) % 3600000) / 60000)} min`]);
  return `<h2>Overview</h2><table><tbody>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</tbody></table>`;
}

export function renderPage(db, { table: tableName, room_id: roomId, page = 0 }, { dbPath, dataDir, login = '', csrf = '', metrics, startedAt } = {}) {
  const tables = tableInfo(db);
  const selected = tables.find((t) => t.name === tableName) || tables.find((t) => t.name === 'envelopes') || tables[0];
  const roomFilter = typeof roomId === 'string' && /^[0-9a-f]{1,64}$/.test(roomId) ? roomId : '';
  const pageNumber = Math.max(0, Math.min(1_000_000, Number.parseInt(page, 10) || 0));
  const parts = [];
  parts.push(`${head('Trommi hub admin')}<h1>Trommi hub admin (read-only)</h1>`);
  if (login) parts.push(topBar(login, csrf));
  const dbSize = dbPath ? fileSize(dbPath) + fileSize(`${dbPath}-wal`) : 0;
  const attachmentsSize = dataDir ? dirSize(path.join(dataDir, 'attachments')) : 0;
  parts.push(renderOverview({ dataDir, metrics, startedAt }));
  parts.push(`<p>hub.db: ${formatBytes(dbSize)} · attachments: ${formatBytes(attachmentsSize)}</p><h2>Tables</h2>`);
  parts.push('<nav>');
  for (const t of tables) {
    const label = `${esc(t.name)} (${t.count ?? '?'})`;
    parts.push(t === selected ? `<b>${label}</b> ` : `<a href="${esc(link({ table: t.name, room_id: roomFilter }))}">${label}</a> `);
  }
  parts.push('</nav>');
  parts.push('<form method="get" action="/"><label>table <select name="table">');
  for (const t of tables) parts.push(`<option${t === selected ? ' selected' : ''}>${esc(t.name)}</option>`);
  parts.push(`</select></label> <label>room_id <input name="room_id" size="66" value="${esc(roomFilter)}" pattern="[0-9a-f]{1,64}"></label> <button>show</button></form>`);
  if (!selected) {
    parts.push('<p>No tables yet.</p></body></html>');
    return parts.join('');
  }
  const hasRoom = selected.columns.some((c) => c.name === 'room_id');
  const where = hasRoom && roomFilter ? 'WHERE room_id = ?' : '';
  const params = where ? [roomFilter] : [];
  const sql = `SELECT * FROM ${quoteIdent(selected.name)} ${where} ${orderClause(db, selected)} LIMIT ${PAGE_SIZE + 1} OFFSET ${pageNumber * PAGE_SIZE}`;
  const rows = db.prepare(sql).all(...params);
  const more = rows.length > PAGE_SIZE;
  if (more) rows.pop();
  let filteredCount = selected.count;
  if (where) filteredCount = Number(db.prepare(`SELECT count(*) AS n FROM ${quoteIdent(selected.name)} ${where}`).get(...params).n);
  parts.push(`<h2>${esc(selected.name)}: ${filteredCount} rows${where ? ' in this room' : ''}${roomFilter && !hasRoom ? ' (table has no room_id; filter ignored)' : ''}, page ${pageNumber + 1}</h2>`);
  parts.push('<div class="wrap"><table><thead><tr>');
  for (const c of selected.columns) parts.push(`<th>${esc(c.name)}</th>`);
  parts.push('</tr></thead><tbody>');
  for (const row of rows) {
    parts.push('<tr>');
    for (const c of selected.columns) parts.push(`<td>${renderCell(c.name, row[c.name])}</td>`);
    parts.push('</tr>');
  }
  parts.push('</tbody></table></div><p>');
  if (pageNumber > 0) parts.push(`<a href="${esc(link({ table: selected.name, room_id: roomFilter, page: pageNumber - 1 }))}">newer</a> `);
  if (more) parts.push(`<a href="${esc(link({ table: selected.name, room_id: roomFilter, page: pageNumber + 1 }))}">older</a>`);
  parts.push('</p></body></html>');
  return parts.join('');
}

// ---------- server ----------

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * startAdmin({ dbPath | db, dataDir, port = 8791, host = '127.0.0.1', env = process.env, metrics?, allowPublishedLoopback?, now? });
 * host must be loopback, or 0.0.0.0 inside a container with allowPublishedLoopback (port published on the host's 127.0.0.1 only).
 * env: ADMIN_LOGINS (comma list, required), ADMIN_PASSWORD_HASH (initial hash, used only while <dataDir>/admin-password-hash is missing).
 * → Promise<{ server, port, close }>
 */
export async function startAdmin({ dbPath, db: givenDb, dataDir, port = 8791, host = '127.0.0.1', env = process.env, metrics, allowPublishedLoopback = false, now = Date.now, log = console } = {}) {
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
  if (!loopback && !(allowPublishedLoopback && host === '0.0.0.0')) throw new Error('admin: binds a loopback address only (the Tailscale-User-Login header is trusted only from tailscale serve on this host)');
  const allowed = parseLogins(env.ADMIN_LOGINS);
  if (!allowed.size) throw new Error('admin: ADMIN_LOGINS is required (comma list of Tailscale logins); there is no default');
  const passwordFile = dataDir ? path.join(dataDir, PASSWORD_FILE) : null;
  const sessions = new Map(); // token -> { login, expires_at, csrf }
  const failures = []; // { login, at }
  const startedAt = now();

  function currentHash() {
    if (passwordFile) {
      try { const text = fs.readFileSync(passwordFile, 'utf8').trim(); if (text) return text; } catch { /* missing */ }
    }
    return String(env.ADMIN_PASSWORD_HASH || '').trim() || null;
  }
  if (!currentHash()) log.warn?.('admin: no admin password hash set; refusing every request');

  function writeHash(hash) {
    if (!passwordFile) throw new Error('no data dir');
    const tmp = `${passwordFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${hash}\n`, { mode: 0o600 });
    fs.renameSync(tmp, passwordFile);
  }

  function limited(login) {
    const cutoff = now() - FAIL_WINDOW_MS;
    while (failures.length && failures[0].at < cutoff) failures.shift();
    return failures.length >= FAILS_GLOBAL || failures.filter((f) => f.login === login).length >= FAILS_PER_LOGIN;
  }
  const fail = (login) => failures.push({ login, at: now() });

  function sessionFor(req, login) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const session = sessions.get(token);
    if (!session) return null;
    if (session.expires_at <= now()) { sessions.delete(token); return null; }
    if (session.login !== login) return null;
    return { token, ...session };
  }

  let db = givenDb || null;
  function openDb() {
    if (db) return db;
    if (!dbPath || !fs.existsSync(dbPath)) return null;
    db = new DatabaseSync(dbPath, { readOnly: true });
    return db;
  }

  const send = (res, status, body, type = 'text/plain; charset=utf-8', extra = {}) => {
    res.writeHead(status, {
      'content-type': type,
      'content-security-policy': CSP,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...extra,
    });
    res.end(body);
  };
  const html = 'text/html; charset=utf-8';
  const redirect = (res, to, extra = {}) => send(res, 303, '', 'text/plain', { location: to, ...extra });
  const cookie = (value, maxAge) => `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;

  const server = http.createServer(async (req, res) => {
    try {
      // Check 1: Tailscale identity.
      const login = headerLogin(req.headers);
      if (!login) return send(res, 403, 'forbidden: missing Tailscale-User-Login (reach this page only via tailscale serve)\n');
      if (!allowed.has(login)) return send(res, 403, 'forbidden: this Tailscale login is not allowed\n');
      const hash = currentHash();
      if (!hash) return send(res, 403, 'forbidden: no admin password set (node hub/admin.mjs hash)\n');

      const url = new URL(req.url, 'http://admin.invalid');
      const method = req.method;

      if (url.pathname === '/login' && method === 'POST') {
        if (limited(login)) return send(res, 429, 'too many attempts, try again later\n', 'text/plain; charset=utf-8', { 'retry-after': String(FAIL_WINDOW_MS / 1000) });
        const body = await readBody(req);
        if (!(await verifyPassword(body.get('password') || '', hash))) {
          fail(login);
          return send(res, 403, renderLoginPage(login, 'Wrong password.'), html);
        }
        for (let i = failures.length - 1; i >= 0; i -= 1) if (failures[i].login === login) failures.splice(i, 1);
        const token = crypto.randomBytes(32).toString('base64url');
        sessions.set(token, { login, expires_at: now() + SESSION_MS, csrf: crypto.randomBytes(16).toString('base64url') });
        return redirect(res, '/', { 'set-cookie': cookie(token, SESSION_MS / 1000) });
      }

      // Check 2: password session.
      const session = sessionFor(req, login);
      if (!session) {
        if (method === 'GET' || method === 'HEAD') return send(res, 403, method === 'HEAD' ? '' : renderLoginPage(login), html);
        return send(res, 403, 'forbidden: sign in first\n');
      }

      if (method === 'POST') {
        const body = await readBody(req);
        if (!safeEqual(body.get('csrf') || '', session.csrf)) return send(res, 403, 'forbidden: bad form token\n');
        if (url.pathname === '/logout') {
          sessions.delete(session.token);
          return redirect(res, '/', { 'set-cookie': cookie('', 0) });
        }
        if (url.pathname === '/password') {
          if (limited(login)) return send(res, 429, 'too many attempts, try again later\n');
          const current = body.get('current') || '';
          const new1 = body.get('new1') || '';
          const new2 = body.get('new2') || '';
          if (!(await verifyPassword(current, hash))) {
            fail(login);
            return send(res, 403, renderPasswordPage(login, session.csrf, 'Current password is wrong.'), html);
          }
          if (new1 !== new2) return send(res, 400, renderPasswordPage(login, session.csrf, 'The new passwords differ.'), html);
          if ([...new1].length < MIN_PASSWORD) return send(res, 400, renderPasswordPage(login, session.csrf, `The new password needs at least ${MIN_PASSWORD} characters.`), html);
          writeHash(await hashPassword(new1));
          sessions.clear();
          log.warn?.(`admin: password changed by ${login}; all sessions ended`);
          return redirect(res, '/', { 'set-cookie': cookie('', 0) });
        }
        return send(res, 404, 'not found\n');
      }
      if (method !== 'GET' && method !== 'HEAD') return send(res, 405, 'method not allowed\n');
      if (url.pathname === '/password') return send(res, 200, method === 'HEAD' ? '' : renderPasswordPage(login, session.csrf), html);
      if (url.pathname !== '/') return send(res, 404, 'not found\n');
      const database = openDb();
      if (!database) return send(res, 503, 'hub.db does not exist yet\n');
      const page = renderPage(database, Object.fromEntries(url.searchParams), { dbPath, dataDir, login, csrf: session.csrf, metrics, startedAt });
      return send(res, 200, method === 'HEAD' ? '' : page, html);
    } catch (error) {
      if (error?.status === 413) return send(res, 413, 'too large\n');
      log.error?.('admin:', error);
      if (!res.headersSent) send(res, 500, 'internal error\n');
      else res.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  return {
    server,
    port: server.address().port,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
      if (db && !givenDb) { try { db.close(); } catch { /* ignore */ } db = null; }
    }),
  };
}

// Command line: `node hub/admin.mjs hash` reads a password from stdin and prints its hash (to set ADMIN_PASSWORD_HASH).
if (import.meta.url === `file://${process.argv[1]}` && process.argv[2] === 'hash') {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  if ([...password].length < MIN_PASSWORD) { console.error(`password needs at least ${MIN_PASSWORD} characters`); process.exit(1); }
  console.log(await hashPassword(password));
}
