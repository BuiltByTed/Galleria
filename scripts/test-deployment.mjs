// Real HTTP regression tests using isolated storage. Set GALLERIA_TEST_IMAGE to
// test the combined Docker image, including the original Unraid volume mount.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const image = process.env.GALLERIA_TEST_IMAGE;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const result = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return result;
}
async function fixture(t, overrides = {}, mount = '/app/data') {
  const data = mkdtempSync(path.join(tmpdir(), 'galleria-deployment-'));
  for (const dir of ['photos', 'optimized', 'logs']) mkdirSync(path.join(data, dir));
  // Suppress unrelated external download/analytics traffic in test fixtures.
  writeFileSync(path.join(data, 'GeoLite2-City.mmdb'), 'test');
  writeFileSync(path.join(data, '.installation-analytics.json'), JSON.stringify({ installation_started: true, setup_complete: true }));
  const webPort = await port();
  const apiPort = await port();
  const url = `http://127.0.0.1:${webPort}`;
  let children = [];
  let container;
  let logs = '';
  const env = { ...process.env, DOMAIN: '', FRONTEND_DOMAIN: '', BACKEND_DOMAIN: '', API_URL: '', ALLOWED_ORIGINS: '', NODE_ENV: 'test', LOG_LEVEL: 'error', ...overrides };
  const ownData = () => {
    if (container) execFileSync('docker', ['exec', container, 'chown', '-R', `${process.getuid()}:${process.getgid()}`, mount], { stdio: 'ignore' });
  };
  const stop = async () => {
    ownData();
    if (container) { execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' }); container = undefined; }
    for (const child of children) child.kill('SIGTERM');
    await Promise.all(children.map(child => new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve))));
    children = [];
  };
  const start = async () => {
    if (image) {
      const args = ['run', '-d', '--name', `galleria-test-${webPort}`, '-p', `127.0.0.1:${webPort}:3000`, '-p', `127.0.0.1:${apiPort}:3001`, '-v', `${data}:${mount}`];
      for (const key of ['DOMAIN', 'FRONTEND_DOMAIN', 'BACKEND_DOMAIN', 'API_URL', 'ALLOWED_ORIGINS', 'LOG_LEVEL']) args.push('-e', `${key}=${env[key]}`);
      if (mount === '/data') args.push('-e', 'DATA_DIR=/data');
      container = execFileSync('docker', [...args, image], { encoding: 'utf8' }).trim();
    } else {
      for (const [cwd, args, servicePort] of [
        ['backend', ['--no-warnings', '--loader', 'ts-node/esm', 'src/server.ts'], apiPort],
        ['frontend', ['server.js'], webPort],
      ]) {
        const child = spawn(process.execPath, args, { cwd: path.join(root, cwd), env: { ...env, DATA_DIR: data, PORT: String(servicePort), HOST: '127.0.0.1', BACKEND_INTERNAL_URL: `http://127.0.0.1:${apiPort}`, TS_NODE_TRANSPILE_ONLY: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
        for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-16000); });
        children.push(child);
      }
    }
    for (let i = 0; i < 160; i++) {
      try { if ((await fetch(`${url}/api/health`)).ok) return; } catch {}
      await pause(250);
    }
    if (container) logs = execFileSync('docker', ['logs', container], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    throw new Error(`Services did not become ready:\n${logs}`);
  };
  t.after(async () => { await stop(); rmSync(data, { recursive: true, force: true }); });
  await start();
  return { ownData, url, apiUrl: `http://127.0.0.1:${apiPort}`, data, env, restart: async () => { await stop(); await start(); } };
}
async function json(url, endpoint, body, headers = {}, method = 'POST') {
  const response = await fetch(url + endpoint, { method, headers: { 'content-type': 'application/json', origin: url, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, headers: response.headers, body: await response.json() };
}
const password = 'A-test-password-123!';
const setup = { siteName: 'Test Gallery', authMethod: 'password', adminName: 'Test Admin', adminUsername: 'photographer', adminPassword: password };
async function login(f, identifier = { username: 'photographer' }, base = f.url, headers = {}) {
  const result = await json(base, '/api/auth-extended/login', { ...identifier, password }, headers);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const cookies = result.headers.getSetCookie();
  assert.ok(cookies.some(cookie => cookie.startsWith('connect.sid=')), 'login must reach the browser with a session cookie');
  return cookies.map(cookie => cookie.split(';')[0]).join('; ');
}

test('fresh single-origin setup, upload, CSRF, login and restart on a custom web port', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  assert.match(await (await fetch(f.url)).text(), new RegExp(`window.__RUNTIME_API_URL__ = "${f.url}"`));
  assert.equal((await json(f.url, '/api/setup/initialize', { ...setup, adminUsername: 'bad@username' })).status, 400);
  assert.equal((await json(f.url, '/api/setup/initialize', { ...setup, authMethod: 'unknown' })).status, 400);
  assert.equal((await json(f.url, '/api/setup/initialize', { ...setup, authMethod: 'google', googleClientId: 'test', googleClientSecret: 'test' })).status, 400);
  // Multipart avatar upload must reach the backend intact during OOBE.
  const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#3388aa' } }).png().toBuffer();
  const avatar = new FormData(); avatar.append('avatar', new Blob([png], { type: 'image/png' }), 'avatar.png');
  const upload = await fetch(`${f.url}/api/setup/upload-avatar`, { method: 'POST', body: avatar });
  assert.equal(upload.status, 200, await upload.text());
  assert.equal((await json(f.url, '/api/setup/initialize', setup)).status, 200);
  assert.equal((await json(f.url, '/api/setup/initialize', setup)).status, 409);
  const config = JSON.parse(readFileSync(path.join(f.data, 'config.json')));
  assert.equal(config.environment.frontend.apiUrl, '');
  assert.equal(config.environment.frontend.siteUrl, f.url);
  assert.deepEqual(config.environment.auth.authorizedEmails, []);
  let cookie = await login(f);
  const status = await fetch(`${f.url}/api/auth/status`, { headers: { cookie } });
  assert.equal((await status.json()).authenticated, true);
  const created = await json(f.url, '/api/albums', { name: 'proxy-test' }, { cookie });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const rejected = await json(f.url, '/api/albums', { name: 'evil' }, { cookie, origin: 'https://evil.example.com' });
  assert.equal(rejected.status, 403);
  const photo = new FormData(); photo.append('photo', new Blob([png], { type: 'image/png' }), 'photo.png');
  const photoUpload = await fetch(`${f.url}/api/albums/proxy-test/upload`, { method: 'POST', headers: { cookie, origin: f.url }, body: photo });
  assert.equal(photoUpload.status, 200, await photoUpload.clone().text());
  const uploaded = await photoUpload.json();
  assert.equal(uploaded.success, true);
  assert.deepEqual(readFileSync(path.join(f.data, 'photos', 'proxy-test', uploaded.filename)), png);
  let asset;
  for (let i = 0; i < 40; i++) {
    asset = await fetch(`${f.url}/optimized/thumbnail/proxy-test/${uploaded.filename}`, { headers: { cookie } });
    if (asset.ok) break;
    await pause(250);
  }
  assert.equal(asset.status, 200);
  assert.ok((await asset.arrayBuffer()).byteLength > 0);
  // Backend remains directly reachable for old reverse proxy mappings.
  assert.equal((await fetch(`${f.apiUrl}/api/health`)).status, 200);
  await f.restart();
  const retained = await fetch(`${f.url}/api/auth/status`, { headers: { cookie } });
  assert.equal((await retained.json()).authenticated, true, 'session survives first OOBE restart');
  cookie = await login(f);
  assert.equal((await fetch(`${f.url}/api/auth/status`, { headers: { cookie } })).status, 200);
  assert.ok(existsSync(path.join(f.data, 'gallery.db')));
});

for (const domain of ['', 'https://photos.example.com']) {
test(`HTTPS proxy with DOMAIN=${domain || '(blank)'} preserves URLs, secure cookies and Google callback`, { timeout: 120000 }, async t => {
  const f = await fixture(t, { DOMAIN: domain }, '/data');
  const headers = { 'x-forwarded-host': 'photos.example.com', 'x-forwarded-proto': 'https', origin: 'https://photos.example.com' };
  const page = await fetch(f.url, { headers });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /window.__RUNTIME_API_URL__ = "https:\/\/photos.example.com"/);
  const result = await json(f.url, '/api/setup/initialize', setup, headers);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const loggedIn = await json(f.url, '/api/auth-extended/login', { username: 'photographer', password }, headers);
  assert.equal(loggedIn.status, 200);
  assert.match(loggedIn.headers.getSetCookie().join(';'), /Secure/);
  f.ownData();
  const configPath = path.join(f.data, 'config.json');
  const config = JSON.parse(readFileSync(configPath));
  config.environment.auth.google = { enabled: true, clientId: 'test-client', clientSecret: 'test-secret' };
  writeFileSync(configPath, JSON.stringify(config));
  await f.restart();
  const oauth = await fetch(`${f.url}/api/auth/google`, { headers, redirect: 'manual' });
  assert.equal(oauth.status, 302);
  assert.equal(new URL(oauth.headers.get('location')).searchParams.get('redirect_uri'), 'https://photos.example.com/api/auth/google/callback');
});

}

test('legacy email accounts, persisted API config and split-domain environment survive upgrades', { timeout: 120000 }, async t => {
  const f = await fixture(t, { FRONTEND_DOMAIN: 'https://photos.example.com', BACKEND_DOMAIN: 'https://api.example.com' });
  const legacySetup = { ...setup, adminUsername: undefined, authorizedEmail: 'existing@example.com' };
  assert.equal((await json(f.url, '/api/setup/initialize', legacySetup)).status, 200);
  f.ownData();
  const db = new Database(path.join(f.data, 'gallery.db'));
  const before = db.prepare('SELECT id, email, password_hash, role FROM users').get();
  db.close();
  f.ownData();
  const configPath = path.join(f.data, 'config.json');
  const config = JSON.parse(readFileSync(configPath));
  delete config.environment.frontend.siteUrl; // Pre-1.2.0 config shape.
  writeFileSync(configPath, JSON.stringify(config));
  await f.restart();
  const headers = { 'x-forwarded-host': 'photos.example.com', 'x-forwarded-proto': 'https' };
  const page = await fetch(f.url, { headers });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /window.__RUNTIME_API_URL__ = "https:\/\/api.example.com"/);
  await login(f, { email: 'existing@example.com' }, f.apiUrl, { 'x-forwarded-host': 'api.example.com', 'x-forwarded-proto': 'https', origin: 'https://photos.example.com' });
  // Persisted config alone must also keep an existing split deployment working.
  f.env.FRONTEND_DOMAIN = ''; f.env.BACKEND_DOMAIN = '';
  await f.restart();
  const savedPage = await fetch(f.url, { headers });
  assert.match(await savedPage.text(), /window.__RUNTIME_API_URL__ = "https:\/\/api.example.com"/);
  await login(f, { email: 'existing@example.com' }, f.apiUrl, { 'x-forwarded-host': 'api.example.com', 'x-forwarded-proto': 'https', origin: 'https://photos.example.com' });
  f.ownData();
  const upgradedDb = new Database(path.join(f.data, 'gallery.db'));
  assert.deepEqual(upgradedDb.prepare('SELECT id, email, password_hash, role FROM users').get(), before);
  upgradedDb.close();
});
