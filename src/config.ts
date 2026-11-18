/**
 * Configuration: everything comes from environment variables.
 * Nothing secret is ever read from disk or from the repository.
 */

/** The one service this connector serves (kept as a type so the shared auth code reads the same as in G-Spot Assistant). */
export type Service = 'telegram';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Config {
  /** Public HTTPS origin of this server, e.g. https://telegram.up.railway.app (no trailing slash). */
  baseUrl: URL;
  port: number;
  /** Path of the MCP endpoint; the full URL is what the owner pastes into claude.ai. */
  mcpPath: string;
  mcpUrl: URL;
  serverName: string;
  /** The owner's password for the admin page and for approving Claude (at least 12 characters). */
  adminPassword: string;
  encryptionKey: Buffer;
  encryptionKeyPrevious: Buffer | undefined;
  dataDir: string;
  dbPath: string;
  /** Set when the data directory will not survive a redeploy (a Railway service without a volume). */
  storageWarning: string | undefined;
  /** Where this server's source code is published (linked from every page, as the AGPL asks of modified copies). */
  sourceUrl: string;
  /**
   * Hosts of other connectors (G-Spot Assistant, the WhatsApp connector) whose upload links this server may push Telegram files to.
   * Anything else is refused, so a message in a chat cannot get Claude to send your files elsewhere.
   */
  peerUploadHosts: string[];
  /** Telegram API keys (my.telegram.org); when absent they are entered on the admin page and stored encrypted. */
  telegramApi: { apiId: number; apiHash: string } | undefined;
  /** Bots (usernames, lower case, without @) Claude may talk to through telegram_bot. Empty: none. */
  botAllowlist: string[];
  /** Redirect URIs an OAuth client may use. Loopback entries match any port; an entry ending in "/*" any one last path segment. */
  allowedRedirectUris: string[];
  /** Hosts from which Client ID Metadata Documents may be fetched. */
  cimdAllowedHosts: string[];
  dcrEnabled: boolean;
  anthropicIpLock: boolean;
  anthropicIpRanges: string[];
  trustProxy: number | boolean;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  defaultTimezone: string;
  logLevel: LogLevel;
}

const DEFAULT_REDIRECT_URIS = [
  // claude.ai on the web, desktop and mobile; Anthropic asks to allow claude.com too, in case the callback moves there.
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  // Claude Code and other local clients (any port).
  'http://localhost/callback',
  'http://127.0.0.1/callback',
  // ChatGPT: one callback per connector, and the older shared one.
  'https://chatgpt.com/connector/oauth/*',
  'https://chatgpt.com/connector_platform_oauth_redirect',
];

export const DEFAULT_SOURCE_URL = 'https://github.com/romaxnova/telegram-connector';

/** Shortest admin password accepted: the login page is rate limited, but a short password is still guessable. */
export const MIN_PASSWORD_LENGTH = 12;

export class ConfigError extends Error {}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new ConfigError(`Missing required environment variable ${name}`);
  return v;
}

function optional(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const v = env[name]?.trim();
  return v ? v : fallback;
}

function list(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const v = env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new ConfigError(`${name} must be true or false`);
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const v = env[name]?.trim();
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

/** Accepts a 32-byte key as base64, base64url or hex. */
export function parseKey(name: string, value: string): Buffer {
  const v = value.trim();
  let buf: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(v)) buf = Buffer.from(v, 'hex');
  else buf = Buffer.from(v, 'base64');
  if (buf.length !== 32) {
    throw new ConfigError(`${name} must be 32 bytes encoded as base64 or hex (run: npm run generate-secrets)`);
  }
  return buf;
}

/** BASE_URL, or the public address the host gives the service (Railway, Render), so a deploy needs no URL typed in. */
function publicOrigin(env: NodeJS.ProcessEnv): string {
  const explicit = env['BASE_URL']?.trim();
  if (explicit) return explicit;
  const railway = env['RAILWAY_PUBLIC_DOMAIN']?.trim();
  if (railway) return `https://${railway}`;
  const render = env['RENDER_EXTERNAL_URL']?.trim();
  if (render) return render;
  throw new ConfigError('Missing BASE_URL: set it to the public https address of this server (on Railway it is found by itself once the service has a public domain)');
}

/** An IANA zone, in the runtime's canonical spelling ("europe/paris" → "Europe/Paris"). */
function timeZone(env: NodeJS.ProcessEnv): string {
  const raw = optional(env, 'DEFAULT_TIMEZONE', 'UTC');
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: raw }).resolvedOptions().timeZone;
  } catch {
    throw new ConfigError(`DEFAULT_TIMEZONE "${raw.slice(0, 60)}" is not an IANA time zone such as Europe/Paris or America/New_York`);
  }
}

/** Why the data directory will not survive a redeploy, if it will not: Railway gives a service no persistent disk without a volume. */
function storageWarning(env: NodeJS.ProcessEnv, dataDir: string): string | undefined {
  const onRailway = Boolean(env['RAILWAY_PROJECT_ID']?.trim() || env['RAILWAY_ENVIRONMENT_ID']?.trim());
  const volume = env['RAILWAY_VOLUME_MOUNT_PATH']?.trim().replace(/\/+$/, '');
  if (!onRailway) return undefined;
  if (!volume) return 'No volume is attached to this Railway service: the Telegram login is lost at every deploy. Attach a volume to the service (mount path /data).';
  const dir = dataDir.replace(/\/+$/, '');
  if (dir !== volume && !dir.startsWith(`${volume}/`)) return `DATA_DIR (${dataDir}) is not on the volume mounted at ${volume}: the Telegram login is lost at every deploy. Remove DATA_DIR or set it to ${volume}.`;
  return undefined;
}

/** "connector.up.railway.app", "https://connector.up.railway.app/" and the like, as bare lower-case host names. */
export function hostList(value: string): string[] {
  return list(value).map((h) => {
    try {
      return new URL(/^[a-z]+:\/\//i.test(h) ? h : `https://${h}`).host.toLowerCase();
    } catch {
      throw new ConfigError(`PEER_UPLOAD_HOSTS: "${h.slice(0, 80)}" is not a host name`);
    }
  });
}

function telegramApi(env: NodeJS.ProcessEnv): { apiId: number; apiHash: string } | undefined {
  const id = env['TELEGRAM_API_ID']?.trim();
  const hash = env['TELEGRAM_API_HASH']?.trim();
  if (!id && !hash) return undefined;
  if (!id || !hash) throw new ConfigError('Set both TELEGRAM_API_ID and TELEGRAM_API_HASH (my.telegram.org → API development tools), or neither to enter them on the admin page');
  const apiId = Number(id);
  if (!Number.isInteger(apiId) || apiId <= 0) throw new ConfigError('TELEGRAM_API_ID must be the number shown on my.telegram.org');
  if (!/^[0-9a-f]{32}$/i.test(hash)) throw new ConfigError('TELEGRAM_API_HASH must be the 32-character hash shown on my.telegram.org');
  return { apiId, apiHash: hash };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const baseUrlRaw = publicOrigin(env).replace(/\/+$/, '');
  let baseUrl: URL;
  try {
    baseUrl = new URL(baseUrlRaw);
  } catch {
    throw new ConfigError('BASE_URL must be an absolute URL such as https://example.up.railway.app');
  }
  const isLocal = baseUrl.hostname === 'localhost' || baseUrl.hostname === '127.0.0.1';
  if (baseUrl.protocol !== 'https:' && !isLocal) throw new ConfigError('BASE_URL must use https (http is only allowed for localhost)');
  if (baseUrl.pathname !== '/' || baseUrl.search || baseUrl.hash) {
    throw new ConfigError('BASE_URL must be an origin only, without a path, query or fragment');
  }

  const mcpPath = '/' + optional(env, 'MCP_PATH', '/mcp').replace(/^\/+|\/+$/g, '');
  if (mcpPath === '/' || mcpPath.startsWith('/.well-known')) throw new ConfigError('MCP_PATH must be a non-root path such as /mcp');

  const encryptionKey = parseKey('TOKEN_ENCRYPTION_KEY', required(env, 'TOKEN_ENCRYPTION_KEY'));
  const prev = env['TOKEN_ENCRYPTION_KEY_PREVIOUS']?.trim();
  const encryptionKeyPrevious = prev ? parseKey('TOKEN_ENCRYPTION_KEY_PREVIOUS', prev) : undefined;

  const adminPassword = required(env, 'ADMIN_PASSWORD');
  if (adminPassword.length < MIN_PASSWORD_LENGTH) throw new ConfigError(`ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters (run: npm run generate-secrets)`);

  const logLevelRaw = optional(env, 'LOG_LEVEL', 'info');
  if (!['debug', 'info', 'warn', 'error'].includes(logLevelRaw)) throw new ConfigError('LOG_LEVEL must be debug, info, warn or error');

  const trustProxyRaw = optional(env, 'TRUST_PROXY', '1');
  const trustProxy: number | boolean =
    trustProxyRaw === 'true' ? true : trustProxyRaw === 'false' ? false : Number.parseInt(trustProxyRaw, 10);
  if (typeof trustProxy === 'number' && !Number.isInteger(trustProxy)) throw new ConfigError('TRUST_PROXY must be a hop count, true or false');

  // On Railway the volume's mount path, wherever it was mounted.
  const dataDir = optional(env, 'DATA_DIR', env['RAILWAY_VOLUME_MOUNT_PATH']?.trim() || '/data');

  const sourceUrl = optional(env, 'SOURCE_URL', DEFAULT_SOURCE_URL);
  if (!/^https:\/\/[^\s"<>]+$/.test(sourceUrl)) throw new ConfigError('SOURCE_URL must be an https URL');

  return {
    baseUrl,
    port: int(env, 'PORT', 8080, 1, 65535),
    mcpPath,
    mcpUrl: new URL(mcpPath, baseUrl),
    serverName: optional(env, 'SERVER_NAME', 'Telegram Connector'),
    adminPassword,
    encryptionKey,
    encryptionKeyPrevious,
    dataDir,
    dbPath: optional(env, 'DB_PATH', `${dataDir.replace(/\/+$/, '')}/telegram.sqlite`),
    storageWarning: storageWarning(env, dataDir),
    sourceUrl,
    peerUploadHosts: hostList(optional(env, 'PEER_UPLOAD_HOSTS', '')),
    telegramApi: telegramApi(env),
    botAllowlist: list(optional(env, 'TELEGRAM_BOT_ALLOWLIST', '').toLowerCase()).map((b) => b.replace(/^@/, '')),
    allowedRedirectUris: [...DEFAULT_REDIRECT_URIS, ...list(optional(env, 'EXTRA_REDIRECT_URIS', ''))],
    cimdAllowedHosts: list(optional(env, 'CIMD_ALLOWED_HOSTS', 'claude.ai').toLowerCase()),
    dcrEnabled: bool(env, 'DCR_ENABLED', true),
    anthropicIpLock: bool(env, 'ANTHROPIC_IP_LOCK', false),
    anthropicIpRanges: list(optional(env, 'ANTHROPIC_IP_RANGES', '160.79.104.0/21')),
    trustProxy,
    accessTokenTtlSeconds: int(env, 'ACCESS_TOKEN_TTL_SECONDS', 3600, 60, 86400),
    refreshTokenTtlSeconds: int(env, 'REFRESH_TOKEN_TTL_DAYS', 90, 1, 3650) * 86400,
    defaultTimezone: timeZone(env),
    logLevel: logLevelRaw as LogLevel,
  };
}
