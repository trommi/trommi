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
// Hub data is opened read-only. This module itself writes only the password hash file; the one destructive action,
// "Delete these N test rooms" (/test-accounts), is not done here but handed to actions.deleteTestRooms, which the hub
// passes in (hub/ops/delete-room.mjs: backup first, rooms of @example.org accounts only, on the hub's own connection).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { CSP, renderLoginPage, renderPasswordPage, renderOverview, renderData, renderTestAccounts } from './admin-view.mjs';
import { testAccounts } from './ops/delete-room.mjs';

const scryptAsync = promisify(crypto.scrypt);
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

// ---------- rendering: hub/admin-view.mjs ----------

export { renderCell, renderLoginPage, renderOverview, renderData } from './admin-view.mjs';

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
 * actions.deleteTestRooms(roomIds, { by }): from the hub (ops.deleteTestRooms); without it the delete button is off.
 * → Promise<{ server, port, close }>
 */
export async function startAdmin({ dbPath, db: givenDb, dataDir, port = 8791, host = '127.0.0.1', env = process.env, metrics, actions = {}, allowPublishedLoopback = false, now = Date.now, log = console } = {}) {
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
            return send(res, 403, renderPasswordPage(login, session.csrf, 'Current password is wrong.', MIN_PASSWORD), html);
          }
          if (new1 !== new2) return send(res, 400, renderPasswordPage(login, session.csrf, 'The new passwords differ.', MIN_PASSWORD), html);
          if ([...new1].length < MIN_PASSWORD) return send(res, 400, renderPasswordPage(login, session.csrf, `The new password needs at least ${MIN_PASSWORD} characters.`, MIN_PASSWORD), html);
          writeHash(await hashPassword(new1));
          sessions.clear();
          log.warn?.(`admin: password changed by ${login}; all sessions ended`);
          return redirect(res, '/', { 'set-cookie': cookie('', 0) });
        }
        if (url.pathname === '/test-accounts/delete') {
          const database = openDb();
          const list = testAccounts(database);
          const typed = String(body.get('confirm') || '').trim();
          const page = (status, extra) => send(res, status, renderTestAccounts(testAccounts(openDb()), { login, csrf: session.csrf, canDelete: !!actions.deleteTestRooms, ...extra }), html);
          if (!actions.deleteTestRooms) return page(503, { message: 'Deleting is not available on this listener (it needs the running hub).' });
          if (!list.length) return page(400, { message: 'There are no test accounts to delete.' });
          if (typed !== String(list.length)) return page(400, { message: `Type ${list.length} to confirm; nothing was deleted.` });
          const result = await actions.deleteTestRooms(list.map((r) => r.room_id), { by: login });
          log.warn?.(`admin: ${login} deleted ${result.deleted.length} test rooms (backup ${result.backup})`);
          return page(200, { result });
        }
        return send(res, 404, 'not found\n');
      }
      if (method !== 'GET' && method !== 'HEAD') return send(res, 405, 'method not allowed\n');
      if (url.pathname === '/password') return send(res, 200, method === 'HEAD' ? '' : renderPasswordPage(login, session.csrf, '', MIN_PASSWORD), html);
      if (url.pathname === '/test-accounts') return send(res, 200, method === 'HEAD' ? '' : renderTestAccounts(testAccounts(openDb()), { login, csrf: session.csrf, canDelete: !!actions.deleteTestRooms }), html);
      // /: overview (old links /?table=… still open the data view); /data: the data browser.
      const wantsData = url.pathname === '/data' || (url.pathname === '/' && url.searchParams.has('table'));
      if (url.pathname !== '/' && url.pathname !== '/data') return send(res, 404, 'not found\n');
      const database = openDb();
      if (wantsData && !database) return send(res, 503, 'hub.db does not exist yet\n');
      const page = wantsData
        ? renderData(database, url.searchParams, { login, csrf: session.csrf })
        : renderOverview({ db: database, dbPath, dataDir, metrics, startedAt, range: url.searchParams.get('range'), now: now(), login, csrf: session.csrf });
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
