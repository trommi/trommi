// Tests for hub/admin.mjs + admin-view.mjs: Tailscale login + admin password, logout, password change, rate limit,
// read-only render, the data browser (tree, filters, sort, row detail) and the overview graphs.
// Run: node hub/admin-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { startAdmin, hashPassword, verifyPassword, renderCell, PASSWORD_FILE } from './admin.mjs';
import { hubMetrics, openSeries } from './ops/metrics.mjs';

const LOGIN = 'admin@example.com';
const PASSWORD = 'correct horse battery staple 42';
const NEW_PASSWORD = 'an even longer new password 99';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${name}`); } catch (error) { console.error(`FAIL ${name}`); throw error; }
}

// ---------- a temp hub.db with README tables ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trommi-admin-'));
const dbPath = path.join(dir, 'hub.db');
const ROOM = 'a'.repeat(64);
const OTHER_ROOM = 'b'.repeat(64);
{
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE rooms (room_id TEXT PRIMARY KEY, founded_at INTEGER, last_entry_number INTEGER, last_envelope_number INTEGER) WITHOUT ROWID;
    CREATE TABLE member_entries (room_id TEXT, entry_number INTEGER, previous_entry_hash TEXT, entry_hash TEXT, entry_action TEXT, signer_device_id TEXT, signed_entry BLOB, received_at INTEGER, PRIMARY KEY (room_id, entry_number));
    CREATE TABLE envelopes (room_id TEXT, envelope_number INTEGER, sender_device_id TEXT, envelope_kind TEXT, timeline_kind TEXT, timeline_id TEXT, is_head INTEGER, envelope_header BLOB, envelope_nonce BLOB, encrypted_body BLOB, encrypted_body_hash TEXT, envelope_signature BLOB, received_at INTEGER, PRIMARY KEY (room_id, envelope_number));
    CREATE TABLE push_subscriptions (room_id TEXT, device_id TEXT, endpoint TEXT, subscription TEXT, created_at INTEGER);
    CREATE TABLE settings (key TEXT, value TEXT);
    CREATE TABLE accounts (room_id TEXT PRIMARY KEY, email TEXT, auth_hash BLOB, created_at INTEGER) WITHOUT ROWID;
    CREATE TABLE objects (room_id TEXT, object_id TEXT, object_state INTEGER, urgency INTEGER, owner_device_id TEXT, first_envelope_number INTEGER, PRIMARY KEY (room_id, object_id)) WITHOUT ROWID;
  `);
  db.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run(ROOM, 'someone@example.com', Buffer.alloc(32, 3), 1791100000000);
  db.prepare('INSERT INTO objects VALUES (?,?,?,?,?,?)').run(ROOM, 'c'.repeat(32), 2, 2, 'd'.repeat(64), 7);
  db.prepare('INSERT INTO rooms VALUES (?,?,?,?)').run(ROOM, 1, 0, 120);
  db.prepare('INSERT INTO rooms VALUES (?,?,?,?)').run(OTHER_ROOM, 2, 0, 1);
  const ins = db.prepare('INSERT INTO envelopes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (let n = 1; n <= 120; n += 1) {
    ins.run(ROOM, n, 'd'.repeat(64), 'message', 'chat', `card/${'c'.repeat(32)}`, 0, Buffer.from('hdr'), Buffer.alloc(24, 7), Buffer.alloc(100, n), 'h'.repeat(64), Buffer.alloc(64, 9), 1000 + n);
  }
  ins.run(OTHER_ROOM, 1, 'e'.repeat(64), 'card', null, null, 1, Buffer.from('hdr'), Buffer.alloc(24), Buffer.from('SECRET-PLAINTEXT-MARKER-XYZ'), 'h', Buffer.alloc(64), 5);
  db.prepare('INSERT INTO push_subscriptions VALUES (?,?,?,?,?)').run(ROOM, 'd'.repeat(64), 'https://push.example/secret-endpoint-token', '{"keys":{"auth":"SECRETAUTH"}}', 1);
  db.prepare('INSERT INTO settings VALUES (?,?)').run('<script>alert(1)</script>', 'x');
  db.close();
}
fs.mkdirSync(path.join(dir, 'attachments', ROOM), { recursive: true });
fs.writeFileSync(path.join(dir, 'attachments', ROOM, 'f'.repeat(32)), Buffer.alloc(3000));

const quiet = { warn() {}, error() {} };
const env = { ADMIN_LOGINS: `${LOGIN}, other-admin@github`, ADMIN_PASSWORD_HASH: await hashPassword(PASSWORD) };
const admin = await startAdmin({ dbPath, dataDir: dir, port: 0, host: '127.0.0.1', env, log: quiet });
const base = `http://127.0.0.1:${admin.port}`;

function request(pathname, { login = LOGIN, cookie, method = 'GET', form } = {}, server = base) {
  const headers = {};
  if (login) headers['tailscale-user-login'] = login;
  if (cookie) headers.cookie = cookie;
  let body;
  if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
  return fetch(`${server}${pathname}`, { method, headers, body, redirect: 'manual' });
}
async function signIn(password = PASSWORD, login = LOGIN, server = base) {
  const res = await request('/login', { method: 'POST', form: { password }, login }, server);
  const setCookie = res.headers.get('set-cookie') || '';
  return { res, cookie: setCookie.split(';')[0] };
}
const csrfOf = (html) => /name="csrf" value="([^"]+)"/.exec(html)?.[1];

try {
  await test('hash format has no "$" and verifies', async () => {
    const h = await hashPassword('x'.repeat(20));
    assert.doesNotMatch(h, /\$/);
    assert.ok(await verifyPassword('x'.repeat(20), h));
    assert.ok(!(await verifyPassword('y'.repeat(20), h)));
    assert.ok(!(await verifyPassword('x', 'garbage')));
  });

  await test('missing Tailscale header → 403, no login form', async () => {
    const res = await request('/', { login: null });
    assert.equal(res.status, 403);
    assert.doesNotMatch(await res.text(), /password/i);
    assert.equal((await request('/login', { login: null, method: 'POST', form: { password: PASSWORD } })).status, 403);
  });

  await test('other Tailscale login → 403 even with the right password', async () => {
    assert.equal((await request('/', { login: 'intruder@example.com' })).status, 403);
    const { res, cookie } = await signIn(PASSWORD, 'intruder@example.com');
    assert.equal(res.status, 403);
    assert.equal(cookie, '');
  });

  await test('allowed login without password → 403 with the login form, before every page', async () => {
    for (const p of ['/', '/?table=envelopes', '/?range=7d', '/data', `/data?room=${ROOM}&t=envelopes&rowid=1`, '/password', '/nothing']) {
      const res = await request(p);
      assert.equal(res.status, 403, p);
      const html = await res.text();
      assert.match(html, /type="password" name="password"/, p);
      assert.doesNotMatch(html, /class="tree"|class="tiles"|envelopes|100 B/, p);
      assert.equal((await request(p, { method: 'HEAD' })).status, 403, p);
    }
  });

  await test('wrong password → 403, no cookie', async () => {
    const { res, cookie } = await signIn('wrong password, quite long');
    assert.equal(res.status, 403);
    assert.equal(cookie, '');
  });

  await test('allowed login + right password → 12 h session cookie, page renders', async () => {
    const { res, cookie } = await signIn();
    assert.equal(res.status, 303);
    const setCookie = res.headers.get('set-cookie');
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Max-Age=43200']) assert.ok(setCookie.includes(flag), flag);
    const page = await request('/', { cookie });
    assert.equal(page.status, 200);
    const csp = page.headers.get('content-security-policy');
    assert.match(csp, /default-src 'none'/);
    assert.doesNotMatch(csp, /unsafe/);
    assert.match(csp, /script-src 'sha256-[^']+'/);
    const html = await page.text();
    assert.match(html, /<h1>Overview<\/h1>/);
    assert.match(html, /<span>envelopes<\/span><span class="n">121<\/span>/);
    assert.match(html, /attachments: 2\.9 KiB/);
    // The inline style and script are exactly the ones the CSP pins.
    const sha = (t) => crypto.createHash('sha256').update(t).digest('base64');
    assert.ok(csp.includes(`'sha256-${sha(/<style>([\s\S]*?)<\/style>/.exec(html)[1])}'`), 'style hash');
    assert.ok(csp.includes(`'sha256-${sha(/<script>([\s\S]*?)<\/script>/.exec(html)[1])}'`), 'script hash');
    assert.doesNotMatch(html, / style=|<script src|<link /, 'no inline style attributes, no external assets');
    assert.match(html, /Abmelden/);
    assert.match(html, /Passwort ändern/);
    // The session is bound to the Tailscale login.
    assert.equal((await request('/', { cookie, login: 'other-admin@github' })).status, 403);
  });

  await test('logout ends the session on the server and clears the cookie', async () => {
    const { cookie } = await signIn();
    const html = await (await request('/', { cookie })).text();
    const csrf = csrfOf(html);
    assert.ok(csrf);
    assert.equal((await request('/logout', { cookie, method: 'POST', form: { csrf: 'nope' } })).status, 403);
    const res = await request('/logout', { cookie, method: 'POST', form: { csrf } });
    assert.equal(res.status, 303);
    assert.match(res.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await request('/', { cookie })).status, 403); // old cookie is dead server-side
  });

  await test('render: ciphertext as size + 16 bytes hex, never plaintext; secrets hidden; escaping; paging', async () => {
    const { cookie } = await signIn();
    const get = async (p) => (await request(p, { cookie })).text();
    const body = (html) => html.slice(html.indexOf('<section class="pane">'));
    let html = await get('/?table=envelopes');   // old links still open the data view
    assert.match(html, /100 B · 78787878787878787878787878787878…/);
    html = body(await get('/data?t=envelopes'));
    assert.match(html, /100 B · 78787878787878787878787878787878…/);
    assert.ok(html.indexOf('>120<') > 0 && html.indexOf('>120<') < html.indexOf('>72<'), 'newest first');
    assert.doesNotMatch(html, />71</, 'page size 50');
    assert.doesNotMatch(html, /SECRET-PLAINTEXT-MARKER-XYZ/);
    html = body(await get(`/?table=envelopes&room_id=${OTHER_ROOM}`));
    assert.match(html, /1 rows in this room/);
    assert.match(html, /27 B · 5345435245542d504c41494e54455854…/);
    assert.doesNotMatch(html, /SECRET-PLAINTEXT/);
    html = body(await get('/data?t=envelopes&page=2'));
    assert.match(html, />21</);
    assert.match(html, /newer/);
    html = await get('/data?t=push_subscriptions');
    assert.doesNotMatch(html, /SECRETAUTH|secret-endpoint-token/);
    html = await get('/data?t=settings');
    assert.doesNotMatch(html, /<script>alert/);
    html = body(await get('/data?t=rooms'));
    assert.match(html, /<h2>rooms<\/h2><span class="muted">2 rows/);
    html = body(await get(`/data?t=envelopes&room=${encodeURIComponent("' OR 1=1 --")}`));
    assert.match(html, /<h2>envelopes<\/h2><span class="muted">121 rows</);
    assert.equal(renderCell('signed_entry', 'AAEC'), '<span class="opaque">3 B · 000102</span>');
    assert.equal((await request('/', { cookie, method: 'PUT' })).status, 405);
  });


  await test('data browser: tree of rooms with counts, filters, sort, search, no oracle on opaque columns', async () => {
    const { cookie } = await signIn();
    const get = async (p) => { const r = await request(p, { cookie }); assert.equal(r.status, 200, p); return r.text(); };
    const body = (html) => html.slice(html.indexOf('<section class="pane">'));
    let html = await get(`/data?room=${ROOM}`);
    assert.match(html, /class="tree"/);
    assert.match(html, /<div class="grp">Rooms <span class="n">2<\/span>/);
    assert.match(html, new RegExp(`data-room="${ROOM}"><details open>`), 'selected room is open');
    assert.match(html, /<li class="lbl">by envelope_kind<\/li>/);
    assert.match(html, /<span>message<\/span><span class="n">120<\/span>/);
    assert.match(html, /<span>accounts<\/span><span class="n">1<\/span>/);
    assert.match(body(html), /120 rows in this room/);
    assert.doesNotMatch(body(html), /<th><a[^>]*>room_id/, 'room_id column left out inside a room');
    // filter by a column (as the tree links do), and by an unknown/opaque column: ignored
    html = body(await get(`/data?room=${OTHER_ROOM}&t=envelopes&f.envelope_kind=card`));
    assert.match(html, /1 rows in this room/);
    assert.match(html, /class="chip"/);
    html = body(await get(`/data?t=envelopes&f.encrypted_body=${'00'.repeat(4)}&f.nope=1`));
    assert.match(html, /121 rows/);
    // sort: by envelope_number ascending puts 1 first; an opaque column is never a sort key
    html = body(await get('/data?t=envelopes&sort=envelope_number&dir=asc'));
    assert.ok(html.indexOf('>1<') < html.indexOf('>2<'));
    assert.match(html, /envelope_number ↑/);
    html = body(await get('/data?t=accounts&sort=email&dir=asc'));
    assert.doesNotMatch(html, /email ↑/);
    // search: prefix over plain columns only (sender 'eee…' is one row); the e-mail is neither searched nor filtered nor shown
    html = body(await get('/data?t=envelopes&q=eeee'));
    assert.match(html, /1 rows/);
    html = body(await get('/data?t=accounts&q=someone'));
    assert.match(html, /0 rows/);
    html = body(await get(`/data?t=accounts&f.email=${encodeURIComponent('someone@example.com')}`));
    assert.match(html, /1 rows/, 'filter on an opaque column is ignored');
    html = body(await get(`/data?t=accounts&f.email=${encodeURIComponent('nobody@example.com')}`));
    assert.match(html, /1 rows/, 'no oracle: a wrong address gives the same answer');
    assert.doesNotMatch(html, /someone@example\.com/);
    // SQL in a filter value is a bound value
    html = body(await get(`/data?t=envelopes&f.envelope_kind=${encodeURIComponent("x' OR '1'='1")}`));
    assert.match(html, /0 rows/);
    // links between rows: object_id → its envelopes, device → its envelopes
    html = body(await get(`/data?room=${ROOM}&t=objects`));
    assert.match(html, new RegExp(`href="/data\\?room=${ROOM}&amp;t=envelopes&amp;f.object_id=${'c'.repeat(32)}"`));
    assert.match(html, new RegExp(`href="/data\\?room=${ROOM}&amp;t=envelopes&amp;f.sender_device_id=${'d'.repeat(64)}"`));
    assert.match(html, /<span class="tag" title="2">answered<\/span>/);
  });

  await test('row detail: every column, ciphertext as size + hex, related rows, keys of WITHOUT ROWID tables', async () => {
    const { cookie } = await signIn();
    const get = async (p) => (await request(p, { cookie })).text();
    let html = await get('/data?t=envelopes&rowid=121');
    assert.match(html, /<aside class="detail"/);
    assert.match(html, /27 B · 5345435245542d504c41494e54455854…/);
    assert.doesNotMatch(html, /SECRET-PLAINTEXT/);
    assert.match(html, /Cleartext header, decoded/);
    assert.match(html, /does not decode/);   // the fixture's header is not a real one
    assert.match(html, /sender_device_id: its envelopes/);
    html = await get(`/data?room=${ROOM}&t=objects&k.room_id=${ROOM}&k.object_id=${'c'.repeat(32)}`);
    assert.match(html, /all envelopes of this object/);
    assert.match(html, new RegExp(`f.timeline_id=card%2F${'c'.repeat(32)}`));
    assert.match(html, /first envelope number/);
    html = await get(`/data?t=accounts&k.room_id=${ROOM}`);
    assert.match(html, /<dt>email<\/dt><dd><span class="opaque">/);
    assert.doesNotMatch(html, /someone@example\.com/);
    html = await get(`/data?t=accounts&k.email=${encodeURIComponent('someone@example.com')}`);
    assert.doesNotMatch(html, /<aside class="detail"/, 'opaque columns are no row keys');
    html = await get('/data?t=envelopes&rowid=99999');
    assert.match(html, /does not exist/);
    assert.equal((await request('/data/x', { cookie })).status, 404);
  });

  await test('overview graphs: tiles, charts from the ring and from the persisted minutes (1 h / 24 h / 7 d)', async () => {
    const seriesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trommi-admin-series-'));
    let t = Date.UTC(2026, 9, 4, 10, 0, 5);
    const flow = { outbound: () => ({ count: 3, max: 0, total: 0 }), writeQueueDepth: 0, counters: {} };
    const wal = { dbBytes: () => 4096, walBytes: () => 0, last: { log_frames: 0, checkpointed_frames: 0, last_ms: 0 } };
    const metrics = hubMetrics({ dataDir: seriesDir, flow, wal, now: () => t });
    try {
      for (let i = 0; i < 20; i += 1) { metrics.sample(); t += 10000; }   // 200 s: crosses three minute borders
      const ring = metrics.history();
      assert.ok(ring.every((x) => x.cpu_percent >= 0 && x.cpu_percent <= 100 && 'request_ms_p95' in x && x.mem_total_bytes > 0));
      const minutes = metrics.series(t - 3600000, 360);
      assert.ok(minutes.length >= 3, `persisted minutes: ${minutes.length}`);
      assert.equal(minutes[0].open_streams, 3);
      const view = await startAdmin({ dbPath, dataDir: seriesDir, port: 0, host: '127.0.0.1', env, metrics, now: () => t, log: quiet });
      const server = `http://127.0.0.1:${view.port}`;
      try {
        const { cookie } = await signIn(PASSWORD, LOGIN, server);
        for (const range of ['1h', '24h', '7d']) {
          const html = await (await request(`/?range=${range}`, { cookie }, server)).text();
          assert.match(html, new RegExp(`href="/\\?range=${range}" class="on"`), range);
          for (const k of ['CPU', 'RAM', 'Disk free', 'Open streams', 'Ingest', 'Latency', 'Database']) assert.match(html, new RegExp(`<div class="k">${k}</div>`), `${range} ${k}`);
          assert.equal((html.match(/<figure class="chart" data-pts=/g) || []).length, 8, `${range}: eight charts with data`);
          assert.match(html, /<svg class="plot"/);
        }
      } finally { await view.close(); }
      // A standalone admin (no metrics object) reads metrics.db read-only.
      metrics.close();
      const alone = await startAdmin({ dbPath, dataDir: seriesDir, port: 0, host: '127.0.0.1', env, now: () => t, log: quiet });
      try {
        const server = `http://127.0.0.1:${alone.port}`;
        const { cookie } = await signIn(PASSWORD, LOGIN, server);
        const html = await (await request('/?range=24h', { cookie }, server)).text();
        assert.match(html, /<figure class="chart" data-pts=/);
      } finally { await alone.close(); }
      const ro = openSeries(seriesDir, { readOnly: true });
      assert.throws(() => ro.db.exec('DELETE FROM metrics_minute'), /readonly/);
      ro.close();
    } finally {
      metrics.close();
      fs.rmSync(seriesDir, { recursive: true, force: true });
    }
  });

  await test('the admin DB connection is read-only', () => {
    const ro = new DatabaseSync(dbPath, { readOnly: true });
    assert.throws(() => ro.exec('DELETE FROM envelopes'), /readonly/);
    ro.close();
  });

  await test('change password: checks, writes only the hash file (0600), ends all sessions', async () => {
    const a = await signIn();
    const b = await signIn();
    const html = await (await request('/password', { cookie: a.cookie })).text();
    const csrf = csrfOf(html);
    const post = (form) => request('/password', { cookie: a.cookie, method: 'POST', form: { csrf, ...form } });
    assert.equal((await post({ current: PASSWORD, new1: NEW_PASSWORD, new2: `${NEW_PASSWORD}x` })).status, 400);
    assert.equal((await post({ current: PASSWORD, new1: 'short pw', new2: 'short pw' })).status, 400);
    assert.equal((await post({ current: 'wrong current password!!', new1: NEW_PASSWORD, new2: NEW_PASSWORD })).status, 403);
    assert.equal((await request('/password', { cookie: a.cookie, method: 'POST', form: { current: PASSWORD, new1: NEW_PASSWORD, new2: NEW_PASSWORD } })).status, 403, 'csrf required');
    assert.ok(!fs.existsSync(path.join(dir, PASSWORD_FILE)));
    const res = await post({ current: PASSWORD, new1: NEW_PASSWORD, new2: NEW_PASSWORD });
    assert.equal(res.status, 303);
    const file = path.join(dir, PASSWORD_FILE);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const stored = fs.readFileSync(file, 'utf8');
    assert.match(stored, /^scrypt:/);
    assert.ok(!stored.includes(NEW_PASSWORD));
    assert.equal((await request('/', { cookie: a.cookie })).status, 403);
    assert.equal((await request('/', { cookie: b.cookie })).status, 403);
    assert.equal((await signIn(PASSWORD)).res.status, 403, 'old password no longer works');
    assert.equal((await signIn(NEW_PASSWORD)).res.status, 303);
  });

  await test('rate limit: 5 wrong attempts per login, then 429 even for the right password', async () => {
    const limitedAdmin = await startAdmin({ dbPath, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'trommi-admin-rl-')), port: 0, host: '127.0.0.1', env, log: quiet });
    const server = `http://127.0.0.1:${limitedAdmin.port}`;
    try {
      for (let i = 0; i < 5; i += 1) assert.equal((await signIn(`wrong password number ${i}`, LOGIN, server)).res.status, 403);
      const blocked = await signIn(PASSWORD, LOGIN, server);
      assert.equal(blocked.res.status, 429);
      assert.ok(blocked.res.headers.get('retry-after'));
      assert.equal((await signIn(PASSWORD, 'other-admin@github', server)).res.status, 303, 'other login not blocked');
    } finally { await limitedAdmin.close(); }
  });

  await test('no password hash configured → every request 403', async () => {
    const off = await startAdmin({ dbPath, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'trommi-admin-np-')), port: 0, host: '127.0.0.1', env: { ADMIN_LOGINS: LOGIN }, log: quiet });
    try {
      const res = await request('/', {}, `http://127.0.0.1:${off.port}`);
      assert.equal(res.status, 403);
      assert.match(await res.text(), /no admin password/);
    } finally { await off.close(); }
  });

  await test('review 3: loopback only, ADMIN_LOGINS required (no default login), escrow ids and secrets masked', async () => {
    await assert.rejects(startAdmin({ dbPath, dataDir: dir, port: 0, host: '0.0.0.0', env, log: quiet }), /loopback/);
    await assert.rejects(startAdmin({ dbPath, dataDir: dir, port: 0, host: '127.0.0.1', env: { ADMIN_PASSWORD_HASH: env.ADMIN_PASSWORD_HASH }, log: quiet }), /ADMIN_LOGINS is required/);
    const id = 'ab'.repeat(16);
    assert.ok(!renderCell('escrow_id', id).includes(id), 'escrow_id never in full');
    assert.ok(!renderCell('share_secret_hash', 'x'.repeat(40)).includes('x'.repeat(40)));
    assert.ok(!renderCell('email', 'someone@example.com').includes('someone@example.com'));
  });
  await test('container bind: 0.0.0.0 only with allowPublishedLoopback; any other address still refused', async () => {
    const inContainer = await startAdmin({ dbPath, dataDir: dir, port: 0, host: '0.0.0.0', allowPublishedLoopback: true, env, log: quiet });
    try {
      assert.equal((await request('/', { login: null }, `http://127.0.0.1:${inContainer.port}`)).status, 403);
    } finally { await inContainer.close(); }
    await assert.rejects(startAdmin({ dbPath, dataDir: dir, port: 0, host: '10.0.0.1', allowPublishedLoopback: true, env, log: quiet }), /loopback/);
  });

  await test('wired into the hub with ADMIN_PORT: overview (CPU, RAM, disk, hub metrics), tables, login page', async () => {
    const { startHub } = await import('./server.mjs');
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trommi-admin-hub-'));
    const saved = { ...process.env };
    Object.assign(process.env, { ADMIN_LOGINS: LOGIN, ADMIN_PASSWORD_HASH: env.ADMIN_PASSWORD_HASH });
    const hub = await startHub({ port: 0, host: '127.0.0.1', dataDir: hubDir, commit: 'test', log: () => {}, adminPort: '0' });
    try {
      assert.ok(hub.admin, 'admin listener started');
      hub.ops.metrics.sample();
      const server = `http://127.0.0.1:${hub.admin.port}`;
      const login = await request('/', {}, server);
      assert.equal(login.status, 403);
      assert.match(await login.text(), /Admin password/);
      const { cookie } = await signIn(PASSWORD, LOGIN, server);
      const html = await (await request('/', { cookie }, server)).text();
      assert.match(html, /Overview/);
      assert.match(html, /<div class="k">CPU<\/div><div class="v">[\d.,]+<small>%<\/small>/);
      assert.match(html, /<div class="s">load [\d.]+ /);
      assert.match(html, /<div class="k">RAM<\/div>/);
      assert.match(html, /<div class="k">Disk free<\/div>/);
      assert.match(html, /<h3>Open streams<\/h3>/);
      assert.match(html, /<span>envelopes<\/span>/);
      assert.ok(fs.existsSync(path.join(hubDir, 'metrics.db')), 'the hub keeps metrics.db');
      const data = await (await request('/data', { cookie }, server)).text();
      assert.match(data, /class="tree"/);
      // A real room: the founding envelope's cleartext header decodes; its body stays size + hex.
      const { foundRoom, memoryStorage } = await import('../shared/index.ts');
      const { client } = await foundRoom({ hub_url: `http://127.0.0.1:${hub.port}`, storage: memoryStorage(), device_name: 'Admin test phone' });
      await client.start({ stream: false });
      const roomId = hub.db.prepare('SELECT room_id FROM rooms').get().room_id;
      const findRow = () => hub.db.prepare('SELECT rowid AS r, encrypted_body FROM envelopes WHERE room_id = ? LIMIT 1').get(roomId);
      for (let i = 0; i < 100 && !findRow(); i += 1) await new Promise((r) => setTimeout(r, 50));   // the first envelope is posted in the background
      await client.stop();
      const row = findRow();
      assert.ok(row, 'the founding wrote an envelope');
      const detail = await (await request(`/data?room=${roomId}&t=envelopes&rowid=${row.r}`, { cookie }, server)).text();
      assert.match(detail, /Cleartext header, decoded/);
      assert.doesNotMatch(detail, /does not decode/);
      assert.match(detail, /<dt>sender<\/dt><dd><a class="id"/);
      assert.match(detail, /<dt>kind<\/dt>/);
      if (row.encrypted_body) assert.match(detail, new RegExp(`<dt>encrypted_body</dt><dd><span class="opaque">${row.encrypted_body.byteLength} B · ${Buffer.from(row.encrypted_body).subarray(0, 16).toString('hex')}…`));
      // The test-account cleanup end to end: the hub's own action, a backup, the room gone.
      hub.db.prepare('INSERT INTO accounts (room_id, email, created_at, updated_at, revision, auth_salt, auth_hash, key_wrapped, kdf) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(roomId, 'e2e@example.org', 1, 1, 1, Buffer.alloc(16), Buffer.alloc(32), Buffer.alloc(61), '{}');
      const tests = await (await request('/test-accounts', { cookie }, server)).text();
      assert.match(tests, /Delete these 1 test rooms/);
      const gone = await (await request('/test-accounts/delete', { cookie, method: 'POST', form: { csrf: csrfOf(tests), confirm: '1' } }, server)).text();
      assert.match(gone, /Deleted 1 test room</);
      assert.equal(hub.db.prepare('SELECT COUNT(*) AS n FROM envelopes WHERE room_id = ?').get(roomId).n, 0);
      assert.equal(hub.db.prepare('SELECT COUNT(*) AS n FROM rooms').get().n, 0);
      assert.equal(fs.readdirSync(path.join(hubDir, 'backups')).filter((f) => f.endsWith('-before-delete.db.gz')).length, 1);
      assert.match(html, /Passwort ändern/);
      assert.match(html, /Abmelden/);
    } finally {
      await hub.close();
      for (const k of ['ADMIN_LOGINS', 'ADMIN_PASSWORD_HASH']) if (k in saved) process.env[k] = saved[k]; else delete process.env[k];
      fs.rmSync(hubDir, { recursive: true, force: true });
    }
  });

  await test('test accounts: lists @example.org only, the delete needs the number typed and a form token, goes to the hub action', async () => {
    const T1 = '1'.repeat(64), T2 = '2'.repeat(64);
    const rw = new DatabaseSync(dbPath);
    rw.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run(T1, 'e2e-1@example.org', Buffer.alloc(32), 1791100000000);
    rw.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run(T2, 'e2e-2@example.org', Buffer.alloc(32), 1791100001000);
    rw.close();
    const calls = [];
    const actions = { async deleteTestRooms(ids, opts) {
      calls.push({ ids, opts });
      return { backup: '/data/backups/hub-x-before-delete.db.gz', deleted: ids.map((room_id) => ({ room_id, rows: { accounts: 1 }, files: 0 })), refused: [], totals: { accounts: ids.length, envelopes: 7, files: 3 } };
    } };
    const own = await startAdmin({ dbPath, dataDir: fs.mkdtempSync(path.join(dir, 'own-')), port: 0, host: '127.0.0.1', env, actions, log: quiet });   // own password file (an earlier test changed the shared one)
    const server = `http://127.0.0.1:${own.port}`;
    try {
      assert.equal((await request('/test-accounts', {}, server)).status, 403, 'behind the password');
      const { cookie } = await signIn(PASSWORD, LOGIN, server);
      const html = await (await request('/test-accounts', { cookie }, server)).text();
      assert.match(html, /<h1>Test accounts<\/h1>/);
      assert.match(html, /e2e-1@example\.org/);
      assert.match(html, /e2e-2@example\.org/);
      assert.doesNotMatch(html, /someone@example\.com/, 'real accounts are not listed');
      assert.match(html, /111111111111…/);
      assert.match(html, /Delete these 2 test rooms/);
      assert.match(html, /Type 2 to confirm/);
      const csrf = csrfOf(html);
      // Without the form token, with the wrong number, or a stale one: nothing is deleted.
      assert.equal((await request('/test-accounts/delete', { cookie, method: 'POST', form: { confirm: '2' } }, server)).status, 403);
      for (const confirm of ['', '1', '3', 'two']) {
        const res = await request('/test-accounts/delete', { cookie, method: 'POST', form: { csrf, confirm } }, server);
        assert.equal(res.status, 400, confirm);
        assert.match(await res.text(), /Type 2 to confirm; nothing was deleted/);
      }
      assert.equal(calls.length, 0);
      const done = await request('/test-accounts/delete', { cookie, method: 'POST', form: { csrf, confirm: '2' } }, server);
      assert.equal(done.status, 200);
      const page = await done.text();
      assert.deepEqual(calls, [{ ids: [T1, T2], opts: { by: LOGIN } }]);
      assert.match(page, /Deleted 2 test rooms/);
      assert.match(page, /hub-x-before-delete\.db\.gz/);
      assert.match(page, /<dt>envelopes<\/dt><dd>7 rows<\/dd>/);
      // Without the hub's action (the plain listener): listed, no button, a POST is refused.
      const plain = await (await request('/test-accounts', { cookie: (await signIn(NEW_PASSWORD)).cookie })).text();
      assert.doesNotMatch(plain, /Delete these/);
      assert.match(plain, /needs the running hub/);
    } finally {
      await own.close();
      const rw2 = new DatabaseSync(dbPath);
      rw2.prepare('DELETE FROM accounts WHERE room_id IN (?, ?)').run(T1, T2);
      rw2.close();
    }
  });

  await test('hub without ADMIN_LOGINS: admin not started, hub still runs', async () => {
    const { startHub } = await import('./server.mjs');
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trommi-admin-hub2-'));
    const saved = process.env.ADMIN_LOGINS;
    delete process.env.ADMIN_LOGINS;
    const lines = [];
    const hub = await startHub({ port: 0, host: '127.0.0.1', dataDir: hubDir, commit: 'test', log: (m) => lines.push(m), adminPort: '0' });
    try {
      assert.equal(hub.admin, null);
      assert.ok(lines.some((l) => /admin not started: .*ADMIN_LOGINS/.test(l)));
      assert.equal((await fetch(`http://127.0.0.1:${hub.port}/healthz`)).status, 200);
    } finally {
      await hub.close();
      if (saved !== undefined) process.env.ADMIN_LOGINS = saved;
      fs.rmSync(hubDir, { recursive: true, force: true });
    }
  });
  await test('Docker image copies every module the hub imports (hub/Dockerfile COPY list vs import graph of server.mjs)', async () => {
    const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
    const copied = new Set();
    for (const line of fs.readFileSync(path.join(root, 'hub/Dockerfile'), 'utf8').split('\n')) {
      const m = /^COPY\s+(.+)\s+\S+$/.exec(line.trim());
      if (!m) continue;
      for (const src of m[1].split(/\s+/)) {
        const abs = path.join(root, src);
        if (fs.statSync(abs).isDirectory()) for (const f of fs.readdirSync(abs, { recursive: true })) copied.add(path.join(src, f));
        else copied.add(src);
      }
    }
    const seen = new Set();
    const walk = (rel) => {
      if (seen.has(rel)) return;
      seen.add(rel);
      const code = fs.readFileSync(path.join(root, rel), 'utf8');
      for (const m of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) walk(path.relative(root, path.resolve(root, path.dirname(rel), m[1])));
    };
    walk('hub/server.mjs');
    assert.ok(seen.has('hub/admin.mjs') && seen.has('hub/admin-view.mjs'));
    const missing = [...seen].filter((f) => !copied.has(f));
    assert.deepEqual(missing, [], `hub/Dockerfile does not COPY: ${missing.join(', ')}`);
  });
} finally {
  await admin.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`admin-test: ${passed} passed`);
