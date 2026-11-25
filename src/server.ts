/**
 * Entry point: wires configuration, storage, the Telegram connection and the HTTP app together.
 */
import { ScheduledSender, ScheduledStore } from './schedule/scheduled.js';
import sharp from 'sharp';
import { MediaTextCache } from './media/media-text.js';
import { loadConfig, ConfigError } from './config.js';
import { createLogger } from './log.js';
import { checkpoint, cleanupExpired, compact, fileSizes, openDatabase } from './db.js';
import { memoryReport } from './memory.js';
import { AuthStore } from './auth/store.js';
import { ClientRegistry } from './auth/clients.js';
import { ConnectorOAuthProvider } from './auth/provider.js';
import { createApp } from './app.js';
import { SqliteUploadVault, UploadStore } from './uploads.js';
import { SecretStore } from './telegram/secrets.js';
import { TelegramService } from './telegram/client.js';
import { allTools } from './mcp/tools/index.js';
import { VERSION } from './version.js';

const DAY_S = 24 * 60 * 60;

function main(): void {
  // Images (photos shown to Claude, OCR): libvips keeps a cache of recent operations and one
  // thread per core, and the process never gives that memory back (measured: +55 MB after four
  // photos, then flat at +15 MB without them). One connector reads one image at a time anyway.
  sharp.cache(false);
  sharp.concurrency(1);
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`Configuration error: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  const log = createLogger(config.logLevel);
  if (config.storageWarning) log.warn(config.storageWarning);
  if (!config.peerUploadHosts.length) log.warn('PEER_UPLOAD_HOSTS is empty: Telegram files cannot be sent to the other connectors until it lists their hosts');
  const db = openDatabase(config.dbPath);
  const keys = [config.encryptionKey, config.encryptionKeyPrevious];
  const secrets = new SecretStore(db, keys);
  if (config.encryptionKeyPrevious) {
    const n = secrets.reencrypt();
    if (n > 0) log.info('re-encrypted the telegram session with the current key; TOKEN_ENCRYPTION_KEY_PREVIOUS can be removed', { count: n });
  }
  const store = new AuthStore(db);
  const clients = new ClientRegistry(store, { allowedRedirectUris: config.allowedRedirectUris, cimdAllowedHosts: config.cimdAllowedHosts, dcrEnabled: config.dcrEnabled }, log);
  const provider = new ConnectorOAuthProvider(
    store,
    clients,
    { mcpUrl: config.mcpUrl, consentPath: '/consent', accessTokenTtlSeconds: config.accessTokenTtlSeconds, refreshTokenTtlSeconds: config.refreshTokenTtlSeconds },
    log,
  );
  const uploads = new UploadStore({}, Date.now, new SqliteUploadVault(db, keys));
  const tg = new TelegramService(secrets, log, config.telegramApi);
  const mediaText = new MediaTextCache(db, keys);
  const scheduled = new ScheduledStore(db, keys);
  tg.onLogout = () => {
    mediaText.clear();
    scheduled.clear();
  };
  const app = createApp({ config, log, store, clients, provider, tools: allTools, tg, uploads, mediaText, scheduled });
  const server = app.listen(config.port, '0.0.0.0', (err?: Error) => {
    if (err) {
      log.error('could not start listening', { port: config.port, error: err.message });
      process.exit(1);
    }
    log.info('listening', { version: VERSION, port: config.port, mcpUrl: config.mcpUrl.href, tools: allTools.length });
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 15 * 60_000;

  // Scheduled messages go out from here; a failure is told in the user's Saved Messages.
  const sender = new ScheduledSender(
    scheduled,
    {
      ready: () => tg.status().state === 'open',
      send: async (chatId, text) => String(await tg.sendText(chatId, text)),
      notify: async (text) => {
        const s = tg.status();
        if (s.state === 'open' && s.me.id) await tg.sendText(s.me.id, text);
      },
    },
    log,
    { timezone: config.defaultTimezone },
  );
  sender.start();
  tg.start().catch((err: unknown) => log.error('telegram could not start', { error: err instanceof Error ? err.message : String(err) }));

  const logMemory = () => {
    const sizes = fileSizes(db);
    log.info('memory', { ...memoryReport(), dbMb: Math.round((sizes.pages * sizes.pageSize) / 104857.6) / 10, state: tg.status().state });
  };
  logMemory();

  const housekeeping = setInterval(
    () => {
      try {
        cleanupExpired(db);
        store.pruneClients(30 * DAY_S);
        uploads.sweep();
        compact(db);
        logMemory();
      } catch (err) {
        log.warn('housekeeping failed', { error: err instanceof Error ? err.message : String(err) });
      }
    },
    60 * 60 * 1000,
  );
  housekeeping.unref();

  const shutdown = (signal: string) => {
    log.info('shutting down', { signal });
    clearInterval(housekeeping);
    void tg.stop();
    server.close(() => {
      try {
        checkpoint(db, 'TRUNCATE');
      } catch {
        /* best effort */
      }
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
