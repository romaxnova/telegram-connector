/**
 * Browser routes: the landing page, owner sign-in (ADMIN_PASSWORD), the
 * consent screen for Claude, and the admin page where Telegram is logged in
 * (API keys, phone number, code, cloud password) and out, and Claude's access
 * is reviewed.
 */
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Config } from '../config.js';
import type { AuthStore } from '../auth/store.js';
import type { ConnectorOAuthProvider } from '../auth/provider.js';
import type { ClientRegistry } from '../auth/clients.js';
import { attachSession, clearSessionCookie, requireSameOrigin, setSessionCookie } from '../auth/session.js';
import { constantTimeEqual, sha256Hex } from '../crypto.js';
import type { Logger } from '../log.js';
import type { LinkState } from '../telegram/types.js';
import { esc, fmtTime, page } from './html.js';
import { memoryReport } from '../memory.js';

/** What the admin page drives on the Telegram connection. */
export interface LoginControl {
  status(): LinkState;
  keysFromEnvironment(): boolean;
  setApiKeys(apiId: string, apiHash: string): void;
  sendCode(phone: string): Promise<void>;
  submitCode(code: string): Promise<void>;
  submitPassword(password: string): Promise<void>;
  cancelLogin(): void;
  logout(): Promise<void>;
}

export interface WebDeps {
  config: Config;
  store: AuthStore;
  clients: ClientRegistry;
  provider: ConnectorOAuthProvider;
  log: Logger;
  tg: LoginControl;
}

/** Who approved Claude: there is one owner, signed in with the admin password. */
export const OWNER = 'owner';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Only relative paths on this site may be used as a post-login destination. */
export function safeNext(v: unknown): string {
  const s = str(v);
  return /^\/(?!\/)[\w\-./?=&%+]*$/.test(s) && s.length < 512 ? s : '/admin';
}

export function passwordMatches(given: string, expected: string): boolean {
  // Hashing first keeps the comparison constant-time whatever the lengths.
  return constantTimeEqual(sha256Hex(given), sha256Hex(expected));
}

export function createWebRouter(d: WebDeps): Router {
  const r = Router();
  const secure = d.config.baseUrl.protocol === 'https:';
  const form = express.urlencoded({ extended: false, limit: '16kb' });
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });
  // Password guesses: a handful per quarter hour from one address.
  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, skipSuccessfulRequests: true });

  r.use(attachSession(d.store));
  r.use(requireSameOrigin(d.config.baseUrl.origin));
  r.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const fail = (res: Response, status: number, message: string, signedIn = false) =>
    res.status(status).send(page({ title: status >= 500 ? 'Something went wrong' : 'Cannot continue', body: `<div class="alert error">${esc(message)}</div><p><a href="/admin">Back to admin</a></p>`, ...(signedIn ? { signedInAs: OWNER } : {}) }));

  const requireOwner = (req: Request, res: Response, next: NextFunction) => {
    if (req.session) return next();
    if (req.method === 'GET') {
      res.redirect(302, `/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
      return;
    }
    fail(res, 403, 'Your session has expired. Sign in again.');
  };

  r.get('/', (req, res) => {
    res.send(
      page({
        title: d.config.serverName,
        body: `${storageBanner()}<p>Private Telegram connector for Claude. MCP endpoint: <code>${esc(d.config.mcpUrl.href)}</code></p><p><a class="btn" href="/admin">Open admin</a></p><p class="muted"><a href="/privacy">Privacy</a></p>`,
        ...(req.session ? { signedInAs: OWNER } : {}),
      }),
    );
  });

  r.get('/privacy', (_req, res) => {
    res.send(
      page({
        title: 'Privacy',
        body: `<p>This server belongs to one person and serves only them. It is logged in to their Telegram account like another Telegram app. It stores only that login session, encrypted; messages and files stay on Telegram and are fetched when asked for. It talks to Telegram, to the AI assistant its owner connected, and to the owner's own other connectors when asked to move a file; to nothing else. Files staged for sending are kept encrypted for 24 hours at most. Logging out from the admin page (or from Telegram → Settings → Devices) ends the session.</p>`,
      }),
    );
  });

  // ---- Owner sign-in ----
  r.get('/admin/login', limiter, (req, res) => {
    if (req.session) return res.redirect(302, safeNext(req.query['next']));
    const next = safeNext(req.query['next']);
    res.send(
      page({
        title: 'Sign in',
        body: `<form class="card" method="post" action="/admin/login"><input type="hidden" name="next" value="${esc(next)}">
<label>Admin password<br><input type="password" name="password" autocomplete="current-password" required autofocus></label>
<div class="row"><button class="primary" type="submit">Sign in</button></div>
<p class="muted">The password is the <code>ADMIN_PASSWORD</code> variable in this server's settings (on Railway: the service, then Variables).</p></form>`,
      }),
    );
  });

  r.post('/admin/login', loginLimiter, form, (req, res) => {
    const next = safeNext(req.body?.next);
    if (!passwordMatches(str(req.body?.password), d.config.adminPassword)) {
      d.log.warn('owner sign-in refused: wrong password');
      res.status(401).send(page({ title: 'Sign in', body: `<div class="alert error">Wrong password.</div><p><a href="/admin/login?next=${encodeURIComponent(next)}">Try again</a></p>` }));
      return;
    }
    const id = d.store.createSession(OWNER);
    setSessionCookie(res, id, secure);
    d.log.info('owner signed in');
    res.redirect(302, next);
  });

  r.post('/admin/logout', (req, res) => {
    if (req.session) d.store.revokeSession(req.session.id);
    clearSessionCookie(res, secure);
    res.redirect(302, '/');
  });

  // ---- Admin ----
  r.get('/admin', limiter, requireOwner, (req, res) => {
    const s = d.tg.status();
    res.send(
      page({
        title: 'Telegram connector',
        signedInAs: OWNER,
        ...(s.state === 'connecting' ? { refreshSeconds: 4 } : {}),
        body: `${storageBanner()}${flash(str(req.query['done']))}${telegramCard(s)}${claudeCard()}${botsCard()}${bridgeCard()}${serverCard()}`,
      }),
    );
  });

  /** Runs one login step; a Telegram refusal is shown on the admin page, the step can be retried. */
  const step = (fn: (req: Request) => Promise<void> | void) => async (req: Request, res: Response) => {
    try {
      await fn(req);
    } catch (err) {
      d.log.info('telegram login step refused', { error: err instanceof Error ? err.message.slice(0, 120) : 'unknown' });
      return res.redirect(303, `/admin?done=${encodeURIComponent(`error:${err instanceof Error ? err.message : String(err)}`)}`);
    }
    res.redirect(303, '/admin');
  };

  r.post('/admin/keys', limiter, requireOwner, form, step((req) => d.tg.setApiKeys(str(req.body?.api_id), str(req.body?.api_hash))));
  r.post('/admin/phone', loginLimiter, requireOwner, form, step((req) => d.tg.sendCode(str(req.body?.phone))));
  r.post('/admin/code', loginLimiter, requireOwner, form, step((req) => d.tg.submitCode(str(req.body?.code))));
  r.post('/admin/password', loginLimiter, requireOwner, form, step((req) => d.tg.submitPassword(str(req.body?.password))));
  r.post('/admin/cancel', limiter, requireOwner, step(() => d.tg.cancelLogin()));

  r.post('/admin/logout-telegram', limiter, requireOwner, form, async (req, res) => {
    if (str(req.body?.confirm) !== 'yes') return fail(res, 400, 'Tick the box to confirm.', true);
    await d.tg.logout();
    res.redirect(303, '/admin?done=loggedout');
  });

  r.post('/admin/revoke', limiter, requireOwner, form, (req, res) => {
    const family = str(req.body?.family);
    if (family) d.store.revokeFamily(family);
    res.redirect(303, '/admin?done=revoked');
  });

  // ---- Consent for Claude (OAuth) ----
  r.get('/consent', limiter, requireOwner, async (req, res) => {
    const id = str(req.query['req']);
    const ar = id ? d.store.getAuthorizationRequest(id) : undefined;
    if (!ar) return fail(res, 400, 'This authorization request has expired. Go back to Claude and connect again.', true);
    const client = await d.clients.getClient(ar.clientId);
    const redirect = new URL(ar.redirectUri);
    const loopback = LOOPBACK_HOSTS.has(redirect.hostname);
    res.send(
      page({
        title: 'Authorize Claude',
        signedInAs: OWNER,
        body: `<div class="card"><p><strong>${esc(client?.client_name ?? 'An OAuth client')}</strong> wants to read your Telegram chats and send messages and files as you, through ${esc(d.config.serverName)}.</p>
<p>After approval the browser is sent to <code>${esc(redirect.origin + redirect.pathname)}</code>.</p>
${loopback ? '<div class="alert warn">The redirect goes to a program on this computer (loopback address). Only approve if you just started this from Claude Code or another local MCP client.</div>' : ''}
<p class="muted">Client id: <code>${esc(ar.clientId)}</code></p>
<form method="post" action="/consent"><input type="hidden" name="req" value="${esc(ar.id)}">
<button class="primary" type="submit" name="decision" value="approve">Approve</button> <button type="submit" name="decision" value="deny">Deny</button></form></div>`,
      }),
    );
  });

  r.post('/consent', limiter, requireOwner, form, (req, res) => {
    const id = str(req.body?.req);
    const decision = str(req.body?.decision);
    const url = decision === 'approve' ? d.provider.approve(id, OWNER) : d.provider.deny(id);
    if (!url) return fail(res, 400, 'This authorization request has expired. Go back to Claude and connect again.', true);
    res.redirect(302, url);
  });

  // ---- page parts ----

  function flash(done: string): string {
    if (done === 'loggedout') return '<div class="alert">Telegram is logged out: this connector no longer appears in Telegram → Settings → Devices.</div>';
    if (done === 'revoked') return '<div class="alert">Access revoked: that client must connect again.</div>';
    if (done.startsWith('error:')) return `<div class="alert error">${esc(done.slice(6, 400))}</div>`;
    return '';
  }

  function telegramCard(s: LinkState): string {
    switch (s.state) {
      case 'needs_api_keys':
        return `<div class="card"><h2>Telegram <span class="badge warn">not set up</span></h2>
<p>Telegram asks every app that logs in to an account for its own API key, free and personal:</p>
<ol><li>Open <a href="https://my.telegram.org/apps" rel="noreferrer">my.telegram.org</a> and log in with your phone number (Telegram sends the code to your Telegram app).</li>
<li>Choose <strong>API development tools</strong> and fill in the short form: App title "Claude connector", Short name "claudeconnector", Platform "Other". Leave the rest empty.</li>
<li>Copy <strong>App api_id</strong> and <strong>App api_hash</strong> below.</li></ol>
<form method="post" action="/admin/keys"><label>api_id<br><input type="text" name="api_id" inputmode="numeric" required></label><label>api_hash<br><input type="text" name="api_hash" required autocomplete="off"></label><div class="row"><button class="primary" type="submit">Save</button></div></form>
<p class="muted">They are stored encrypted on this server. (Or set TELEGRAM_API_ID and TELEGRAM_API_HASH in the server's variables.)</p></div>`;
      case 'logged_out':
        return `<div class="card"><h2>Telegram <span class="badge warn">not logged in</span></h2>
<p>This connector logs in to your Telegram account like another Telegram app (it will show in Telegram → Settings → Devices). Telegram keeps your whole history, so Claude can read any chat back to its start.</p>
<form method="post" action="/admin/phone"><label>Your Telegram phone number, with country code<br><input type="tel" name="phone" placeholder="+33 6 12 34 56 78" required></label><div class="row"><button class="primary" type="submit">Send me a login code</button></div></form>
<p class="muted">Telegram sends the code inside your Telegram app (a message from "Telegram"), or by SMS.${d.tg.keysFromEnvironment() ? '' : ' Wrong API keys? Clear them by setting new ones in the server variables.'}</p></div>`;
      case 'awaiting_code':
        return `<div class="card"><h2>Enter the login code</h2>
<p>Telegram sent a code to ${s.viaApp ? 'your <strong>Telegram app</strong> (a message from "Telegram" in your chats)' : 'your phone by <strong>SMS</strong>'} for <strong>${esc(s.phone)}</strong>.</p>
<div class="alert warn">Never send this code to anyone in a chat: Telegram blocks a login whose code was shared in a message. Type it only here.</div>
<form method="post" action="/admin/code"><label>Code<br><input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" required autofocus></label><div class="row"><button class="primary" type="submit">Log in</button></div></form>
<form method="post" action="/admin/cancel"><button type="submit">Cancel</button></form></div>`;
      case 'awaiting_password':
        return `<div class="card"><h2>Two-step verification</h2>
<p>Your account has a cloud password. Enter it to finish logging in${s.hint ? ` (hint: <em>${esc(s.hint)}</em>)` : ''}.</p>
<form method="post" action="/admin/password"><label>Cloud password<br><input type="password" name="password" autocomplete="current-password" required autofocus></label><div class="row"><button class="primary" type="submit">Log in</button></div></form>
<form method="post" action="/admin/cancel"><button type="submit">Cancel</button></form></div>`;
      case 'connecting':
        return '<div class="card"><h2>Telegram <span class="badge warn">connecting</span></h2><p>Connecting to Telegram…</p></div>';
      case 'error':
        return `<div class="card"><h2>Telegram <span class="badge warn">error</span></h2><p>${esc(s.message)}</p>${logoutForm()}</div>`;
      case 'open':
        return `<div class="card"><h2>Telegram <span class="badge">connected</span></h2>
<div>Account: <strong>${esc(s.me.name)}</strong>${s.me.username ? ` @${esc(s.me.username)}` : ''}${s.me.phone ? ` · ${esc(s.me.phone)}` : ''}, connected since ${esc(fmtTime(Math.floor(s.since / 1000)))}</div>
<p class="muted">This session appears in Telegram → Settings → Devices as "Claude connector"; ending it there also logs this connector out.</p>
${logoutForm()}</div>`;
    }
  }

  function logoutForm(): string {
    return `<form method="post" action="/admin/logout-telegram" class="row"><label><input type="checkbox" name="confirm" value="yes"> End the Telegram session</label><button class="danger" type="submit">Log out of Telegram</button></form>`;
  }

  function botsCard(): string {
    const bots = d.config.botAllowlist;
    return `<div class="card"><h2>Bots Claude may talk to</h2>${
      bots.length ? `<p>${bots.map((b) => `<code>@${esc(b)}</code>`).join(', ')}</p>` : '<p class="muted">None. Claude can read any bot conversation, but sends messages and presses buttons only in bots listed here.</p>'
    }<p class="muted">Set <code>TELEGRAM_BOT_ALLOWLIST</code> (usernames, comma-separated) in the server variables to change the list. Each call still asks you first.</p></div>`;
  }

  function claudeCard(): string {
    const families = d.store.listTokenFamilies();
    const rows = families
      .map((f) => `<tr><td><code>${esc(f.clientId.slice(0, 48))}</code></td><td>${esc(fmtTime(f.createdAt))}</td><td><form method="post" action="/admin/revoke" class="inline"><input type="hidden" name="family" value="${esc(f.familyId)}"><button class="danger" type="submit">Revoke</button></form></td></tr>`)
      .join('');
    return `<div class="card"><h2>Claude</h2><p>In Claude: Settings → Connectors → <strong>Add custom connector</strong>, and paste <code>${esc(d.config.mcpUrl.href)}</code>. Claude then sends you here to approve it.</p>
<p class="muted">In the connector's tool permissions, set the sending tools (telegram_send_message, telegram_send_file, telegram_bot) to <strong>Ask</strong>, so nothing goes out without you seeing it.</p>
${families.length ? `<table><tr><th>Connected client</th><th>Since</th><th></th></tr>${rows}</table>` : '<p class="muted">No client connected yet.</p>'}</div>`;
  }

  function bridgeCard(): string {
    const hosts = d.config.peerUploadHosts;
    return `<div class="card"><h2>Files with your other connectors</h2>${
      hosts.length
        ? `<p>Telegram files may go to: ${hosts.map((h) => `<code>${esc(h)}</code>`).join(', ')}.</p>`
        : '<div class="alert warn">No connector may receive files yet: set <code>PEER_UPLOAD_HOSTS</code> to the host names of your G-Spot Assistant and WhatsApp connector.</div>'
    }<p class="muted">For files to come here from them, they list this server (<code>${esc(d.config.baseUrl.host)}</code>) in their own <code>PEER_UPLOAD_HOSTS</code>.</p></div>`;
  }

  function serverCard(): string {
    const m = memoryReport();
    const hours = Math.floor(process.uptime() / 3600);
    const up = hours >= 48 ? `${Math.floor(hours / 24)} days` : hours >= 1 ? `${hours} h` : `${Math.max(1, Math.round(process.uptime() / 60))} min`;
    return `<div class="card muted">Memory: ${m.rssMb} MB${m.containerMb !== undefined ? ` (container ${m.containerMb} MB)` : ''} · running for ${up}</div>`;
  }

  function storageBanner(): string {
    return d.config.storageWarning ? `<div class="alert error">${esc(d.config.storageWarning)}</div>` : '';
  }

  return r;
}
