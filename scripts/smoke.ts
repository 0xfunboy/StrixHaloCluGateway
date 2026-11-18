import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Exercise the shipped entrypoints, without loading source modules, node_modules,
// external providers, or an existing user's state. Also covers symlink releases.
const repository = await realpath(fileURLToPath(new URL('..', import.meta.url)));
const temporary = await mkdtemp(path.join(tmpdir(), 'yed1z-release-smoke-'));
const state = path.join(temporary, 'state');
const workspace = path.join(temporary, 'projects');
const release = path.join(temporary, 'current');
const payload = path.join(temporary, 'payload');
let server: ChildProcess | undefined;
let exited: Promise<number | null> | undefined;
try {
  await mkdir(workspace);
  await mkdir(payload);
  await cp(path.join(repository, 'dist'), path.join(payload, 'dist'), { recursive: true });
  await symlink(payload, release, 'dir');
  const cli = path.join(release, 'dist/cli.mjs');
  const init = spawnSync(process.execPath, [cli, 'init', '--name', 'Release smoke', '--state', state, '--workspace', workspace], { encoding: 'utf8' });
  assert.equal(init.status, 0, 'Bundled init must exit successfully.');
  const token = init.stdout.match(/Chiave di accesso[^\n]*: ([A-Za-z0-9_-]+)/)?.[1];
  assert.ok(token, 'Setup must return an initial key.');
  const repeated = spawnSync(process.execPath, [cli, 'init', '--state', state], { encoding: 'utf8' });
  assert.equal(repeated.status, 0);
  assert.match(repeated.stdout, /Chiave e dati preservati/);
  const configPath = path.join(state, 'config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.port = 0;
  config.telemetryIntervalMs = 300000;
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  server = spawn(process.execPath, [path.join(release, 'dist/server.mjs')], {
    cwd: payload,
    env: { ...process.env, YED1Z_STATE_DIR: state },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  exited = new Promise(resolve => server!.once('exit', code => resolve(code)));
  let output = '';
  server.stderr?.resume();
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Bundled server startup timed out.')), 10000);
    server!.once('error', error => { clearTimeout(timer); reject(error); });
    server!.once('exit', () => { clearTimeout(timer); reject(new Error('Bundled server exited before readiness.')); });
    server!.stdout!.on('data', data => {
      output += String(data);
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  const dashboard = await fetch(url);
  assert.equal(dashboard.status, 200);
  const dashboardHtml = await dashboard.text();
  assert.match(dashboardHtml, /DUAL_STRIX_HALO_WORKSTATION_HUD/);
  assert.match(dashboardHtml, /href="\/control"/);
  assert.match(dashboardHtml, /src="\/static\/app\.js/);
  assert.match(dashboard.headers.get('content-security-policy') ?? '', /script-src 'self' 'unsafe-inline'/);
  for (const alias of ['/index.html', '/cockpit/classic']) {
    const response = await fetch(url + alias);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), dashboardHtml);
  }
  for (const route of ['/control', '/control/', '/control/index.html']) {
    const response = await fetch(url + route);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy') ?? '', /script-src 'self';/);
    assert.match(await response.text(), /src="\/assets\/app\.js\?v=[a-f0-9]{16}"/);
  }
  for (const page of ['/', '/control', '/cockpit']) {
    const html = await (await fetch(url + page)).text();
    const assets = [...html.matchAll(/(?:src|href)="(\/(?:assets|static)\/[\w.-]+\.(?:js|css)\?v=([a-f0-9]{16}))"/g)];
    assert.equal(assets.length, 2, `Versioned JS and CSS on ${page}`);
    for (const [, asset, version] of assets) {
      const response = await fetch(url + asset);
      assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(createHash('sha256').update(bytes).digest('hex').slice(0, 16), version);
    }
  }
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  for (const page of ['/cockpit','/assets/cockpit.js','/static/style.css','/static/app.js','/static/assets/strix_halo_dual_cluster.jpg','/static/assets/strix_halo_die_schematic.jpg']) {
    const response = await fetch(url+page); assert.equal(response.status,200,page); await response.arrayBuffer();
  }
  const asset = await fetch(url + '/assets/app.js');
  assert.equal(asset.status, 200);
  assert.ok((await asset.text()).length > 10000);
  assert.equal((await fetch(url + '/api/health')).status, 200);
  const guest = await fetch(url + '/api/bootstrap');
  assert.equal(guest.status, 200);
  const guestState = await guest.json();
  assert.equal(guestState.user.id, 'guest');
  assert.deepEqual(guestState.accounts, []);
  assert.deepEqual(guestState.conversations, []);
  assert.equal((await fetch(url + '/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Unauthorized' }) })).status, 401);
  const login = await fetch(url + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify({ token })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const bootstrap = await fetch(url + '/api/bootstrap', { headers: { Cookie: cookie } });
  assert.equal(bootstrap.status, 200);
  assert.equal((await bootstrap.json()).user.name, 'Release smoke');
  const project = await fetch(url + '/api/projects', {
    method: 'POST', headers: { Cookie: cookie, Origin: url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Prepared through bundled server', targetId: 'coordinator', workspace: 'smoke-project' })
  });
  assert.equal(project.status, 201);
  assert.equal((await stat(path.join(workspace, 'smoke-project'))).isDirectory(), true);
  server.kill('SIGTERM');
  const closeTimer = setTimeout(() => server?.kill('SIGKILL'), 5000);
  try { assert.equal(await exited, 0, 'Bundled server must shut down cleanly.'); }
  finally { clearTimeout(closeTimer); }
  server = undefined;
  process.stdout.write('Release smoke PASS: bundled CLI + symlink startup + setup preservation + HTTP/CSP/assets + cookie login + authorization + project workspace + graceful shutdown.\n');
} finally {
  if (server) { server.kill('SIGKILL'); await exited; }
  await rm(temporary, { recursive: true, force: true });
}
