// Tests for hub/admin.mjs: Tailscale login + admin password, logout, password change, rate limit, read-only render.
// Run: node hub/admin-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startAdmin, hashPassword, verifyPassword, renderCell, PASSWORD_FILE } from './admin.mjs';

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
  `);
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
    for (const p of ['/', '/?table=envelopes', '/password', '/nothing']) {
      const res = await request(p);
      assert.equal(res.status, 403, p);
      const html = await res.text();
      assert.match(html, /type="password" name="password"/, p);
      assert.doesNotMatch(html, /envelopes \(/, p);
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
    const html = await page.text();
    assert.match(html, /envelopes \(121\)/);
    assert.match(html, /attachments: 2\.9 KiB/);
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
    let html = await get('/?table=envelopes');
    assert.match(html, /100 B · 78787878787878787878787878787878…/);
    assert.ok(html.indexOf('>120<') > 0 && html.indexOf('>120<') < html.indexOf('>72<'), 'newest first');
    assert.doesNotMatch(html, />71</, 'page size 50');
    assert.doesNotMatch(html, /SECRET-PLAINTEXT-MARKER-XYZ/);
    html = await get(`/?table=envelopes&room_id=${OTHER_ROOM}`);
    assert.match(html, /1 rows in this room/);
    assert.match(html, /27 B · 5345435245542d504c41494e54455854…/);
    assert.doesNotMatch(html, /SECRET-PLAINTEXT/);
    html = await get('/?table=envelopes&page=2');
    assert.match(html, />21</);
    assert.match(html, /newer/);
    html = await get('/?table=push_subscriptions');
    assert.doesNotMatch(html, /SECRETAUTH|secret-endpoint-token/);
    html = await get('/?table=settings');
    assert.doesNotMatch(html, /<script>/);
    html = await get('/?table=rooms');
    assert.match(html, /rooms: 2 rows/);
    html = await get(`/?table=envelopes&room_id=${encodeURIComponent("' OR 1=1 --")}`);
    assert.match(html, /envelopes: 121 rows/);
    assert.equal(renderCell('signed_entry', 'AAEC'), '<span class="opaque">3 B · 000102</span>');
    assert.equal((await request('/', { cookie, method: 'PUT' })).status, 405);
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
} finally {
  await admin.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`admin-test: ${passed} passed`);
