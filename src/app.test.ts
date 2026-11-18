import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.js';
import { openDatabase } from './db.js';
import { AuthStore } from './auth/store.js';
import { ClientRegistry } from './auth/clients.js';
import { ConnectorOAuthProvider } from './auth/provider.js';
import { silentLogger } from './log.js';
import { allTools } from './mcp/tools/index.js';
import { SecretStore } from './telegram/secrets.js';
import { TelegramService } from './telegram/client.js';
import { TEST_KEY, testConfig } from './test-support.js';

async function start() {
  const config = testConfig({ BASE_URL: 'http://localhost' });
  const db = openDatabase(':memory:');
  const store = new AuthStore(db);
  const clients = new ClientRegistry(store, { allowedRedirectUris: config.allowedRedirectUris, cimdAllowedHosts: config.cimdAllowedHosts, dcrEnabled: true }, silentLogger);
  const provider = new ConnectorOAuthProvider(store, clients, { mcpUrl: config.mcpUrl, consentPath: '/consent', accessTokenTtlSeconds: 3600, refreshTokenTtlSeconds: 86400 }, silentLogger);
  const tg = new TelegramService(new SecretStore(db, [TEST_KEY]), silentLogger, undefined);
  await tg.start();
  const app = createApp({ config, log: silentLogger, store, clients, provider, tools: allTools, tg });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

test('MCP needs a bearer token; the admin needs the password and then asks for the Telegram API keys', async () => {
  const s = await start();
  try {
    assert.equal(await (await fetch(`${s.base}/healthz`)).text(), 'ok');
    assert.equal((await fetch(`${s.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
    const login = await fetch(`${s.base}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost' }, body: new URLSearchParams({ password: 'correct horse battery staple', next: '/admin' }) });
    assert.equal(login.status, 302);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const admin = await (await fetch(`${s.base}/admin`, { headers: { cookie } })).text();
    assert.match(admin, /my\.telegram\.org/);
    assert.match(admin, /api_hash/);
    // Keys saved: the next step asks for the phone number.
    const saved = await fetch(`${s.base}/admin/keys`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost' }, body: new URLSearchParams({ api_id: '123456', api_hash: '0123456789abcdef0123456789abcdef' }) });
    assert.equal(saved.status, 303);
    assert.match(await (await fetch(`${s.base}/admin`, { headers: { cookie } })).text(), /Send me a login code/);
    const bad = await fetch(`${s.base}/admin/phone`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost' }, body: new URLSearchParams({ phone: '06 12 34 56 78' }) });
    assert.match(decodeURIComponent(bad.headers.get('location')!), /country code/);
  } finally {
    s.close();
  }
});
