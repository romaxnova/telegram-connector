/**
 * The connection to Telegram: this server logs in as the owner's Telegram
 * account through Telegram's own client API (MTProto, via GramJS), like any
 * Telegram app. Login happens on the admin page (phone number, the code
 * Telegram sends to the owner's apps, and the cloud password when 2FA is on).
 * The session is kept encrypted (SecretStore) so a restart needs no new login.
 *
 * Telegram keeps the whole history on its servers, so nothing is indexed here:
 * tools ask Telegram directly. Tools use the TelegramPort interface.
 */
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { CustomFile } from 'telegram/client/uploads.js';
import { computeCheck } from 'telegram/Password.js';
import { Logger, LogLevel } from 'telegram/extensions/Logger.js';
import bigInt from 'big-integer';
import type { Logger as AppLogger } from '../log.js';
import type { SecretStore } from './secrets.js';
import type { ChatInfo, ChatKind, FileFilter, HistoryOptions, LinkState, MessageInfo, MessageKind, OutgoingFile, SearchOptions, TelegramPort } from './types.js';

const DIALOG_CACHE_MS = 60_000;
const SESSION = 'session';
const API_ID = 'api_id';
const API_HASH = 'api_hash';

/** The connection is not usable right now; the message says what the owner should do. */
export class TelegramUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramUnavailable';
  }
}

/** A Telegram refusal Claude or the owner can act on (wrong code, unknown chat, flood wait). */
export class TelegramError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramError';
  }
}

/** Telegram's error codes in words. */
export function explain(err: unknown): string {
  const code = (err as { errorMessage?: string })?.errorMessage ?? (err instanceof Error ? err.message : String(err));
  const wait = /FLOOD_WAIT_(\d+)|A wait of (\d+) seconds/.exec(code);
  if (wait) return `Telegram asks to wait ${wait[1] ?? wait[2]} seconds before trying again (too many requests).`;
  const known: Record<string, string> = {
    PHONE_NUMBER_INVALID: 'Telegram does not know this phone number. Enter it with its country code, e.g. +33 6 12 34 56 78.',
    PHONE_NUMBER_BANNED: 'Telegram has banned this phone number.',
    PHONE_CODE_INVALID: 'The code is wrong. Check the message Telegram sent to your Telegram app and try again.',
    PHONE_CODE_EXPIRED: 'The code has expired. Start the login again to get a new one.',
    PHONE_CODE_EMPTY: 'Enter the code Telegram sent you.',
    PASSWORD_HASH_INVALID: 'The cloud password (two-step verification) is wrong.',
    API_ID_INVALID: 'The API id and hash are not valid: copy them again from my.telegram.org → API development tools.',
    AUTH_KEY_UNREGISTERED: 'The Telegram session has ended (logged out from another device). Log in again on the admin page.',
    SESSION_REVOKED: 'The Telegram session was terminated from another device. Log in again on the admin page.',
    USER_DEACTIVATED: 'This Telegram account is deactivated.',
    CHAT_WRITE_FORBIDDEN: 'You cannot write in this chat (read-only channel or restricted group).',
    USER_IS_BLOCKED: 'This user or bot has blocked you, or you blocked them.',
    PEER_ID_INVALID: 'Telegram does not know this chat.',
    MESSAGE_ID_INVALID: 'There is no message with this id in that chat.',
    BOT_RESPONSE_TIMEOUT: 'The bot did not answer the button press in time.',
    DATA_INVALID: 'This button no longer works (the bot changed the message).',
  };
  for (const [k, v] of Object.entries(known)) if (code.includes(k)) return v;
  return `Telegram refused: ${code.slice(0, 200)}`;
}

function num(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = Number(typeof v === 'object' ? String(v) : v);
  return Number.isFinite(n) ? n : undefined;
}

function personName(e: unknown): string {
  if (!e) return 'unknown';
  if (e instanceof Api.User) {
    const name = [e.firstName, e.lastName].filter(Boolean).join(' ').trim();
    return name || (e.username ? `@${e.username}` : e.phone ? `+${e.phone}` : `user ${e.id.toString()}`);
  }
  if (e instanceof Api.Chat || e instanceof Api.Channel) return e.title;
  if (e instanceof Api.ChatForbidden || e instanceof Api.ChannelForbidden) return e.title;
  return 'unknown';
}

function kindOf(e: unknown): ChatKind {
  if (e instanceof Api.User) return e.bot ? 'bot' : 'user';
  if (e instanceof Api.Channel) return e.megagroup || e.gigagroup ? 'group' : 'channel';
  return 'group';
}

/** One line for service messages worth reading; undefined for the rest. */
function actionText(action: Api.TypeMessageAction): string | undefined {
  if (action instanceof Api.MessageActionChatCreate || action instanceof Api.MessageActionChannelCreate) return `Created "${action.title}"`;
  if (action instanceof Api.MessageActionChatEditTitle) return `Renamed to "${action.title}"`;
  if (action instanceof Api.MessageActionChatAddUser) return 'Added members';
  if (action instanceof Api.MessageActionChatJoinedByLink || action instanceof Api.MessageActionChatJoinedByRequest) return 'Joined';
  if (action instanceof Api.MessageActionChatDeleteUser) return 'Left or was removed';
  if (action instanceof Api.MessageActionPinMessage) return 'Pinned a message';
  if (action instanceof Api.MessageActionPhoneCall) return 'Call';
  return undefined;
}

/**
 * Name, type, size and duration of a message's file, read from the document's attributes. (GramJS's
 * own message.file helper crashes on duration, width and height: it tests instanceof against an array.)
 */
export function mediaOf(media: Api.TypeMessageMedia | undefined): { filename?: string; mimetype?: string; size?: number; seconds?: number } | undefined {
  if (media instanceof Api.MessageMediaPhoto && media.photo instanceof Api.Photo) {
    const sizes = media.photo.sizes.map((p) => (p instanceof Api.PhotoSize ? p.size : p instanceof Api.PhotoSizeProgressive ? Math.max(...p.sizes) : 0));
    return { mimetype: 'image/jpeg', size: Math.max(0, ...sizes) || undefined };
  }
  if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
    const d = media.document;
    let filename: string | undefined;
    let seconds: number | undefined;
    for (const a of d.attributes) {
      if (a instanceof Api.DocumentAttributeFilename) filename = a.fileName;
      else if (a instanceof Api.DocumentAttributeAudio || a instanceof Api.DocumentAttributeVideo) seconds = Math.round(Number(a.duration)) || undefined;
    }
    return { filename, mimetype: d.mimeType, size: num(d.size), seconds };
  }
  return undefined;
}

function filterOf(f: FileFilter | undefined): Api.TypeMessagesFilter | undefined {
  switch (f) {
    case 'document':
      return new Api.InputMessagesFilterDocument();
    case 'photo':
      return new Api.InputMessagesFilterPhotos();
    case 'video':
      return new Api.InputMessagesFilterVideo();
    case 'audio':
      return new Api.InputMessagesFilterMusic();
    case 'voice':
      return new Api.InputMessagesFilterVoice();
    case 'media':
      return new Api.InputMessagesFilterPhotoVideo();
    case 'url':
      return new Api.InputMessagesFilterUrl();
    default:
      return undefined;
  }
}

export interface ApiKeys {
  apiId: number;
  apiHash: string;
}

export class TelegramService implements TelegramPort {
  private client: TelegramClient | undefined;
  private link: LinkState = { state: 'logged_out' };
  private pending: { phone: string; phoneCodeHash: string } | undefined;
  private dialogCache: { at: number; list: ChatInfo[] } | undefined;
  private names = new Map<string, string>();

  constructor(
    private readonly secrets: SecretStore,
    private readonly log: AppLogger,
    private readonly envKeys: ApiKeys | undefined,
  ) {}

  status(): LinkState {
    return this.link;
  }

  /** API keys: from the environment, else from the admin page. */
  apiKeys(): ApiKeys | undefined {
    if (this.envKeys) return this.envKeys;
    const id = Number(this.secrets.get(API_ID));
    const hash = this.secrets.get(API_HASH);
    return id && hash ? { apiId: id, apiHash: hash } : undefined;
  }

  keysFromEnvironment(): boolean {
    return Boolean(this.envKeys);
  }

  setApiKeys(apiId: string, apiHash: string): void {
    const id = Number(apiId.trim());
    const hash = apiHash.trim();
    if (!Number.isInteger(id) || id <= 0) throw new TelegramError('The api_id is a number, as shown on my.telegram.org → API development tools.');
    if (!/^[0-9a-f]{32}$/i.test(hash)) throw new TelegramError('The api_hash is 32 letters and digits, as shown on my.telegram.org → API development tools.');
    this.secrets.set(API_ID, String(id));
    this.secrets.set(API_HASH, hash);
    this.link = { state: 'logged_out' };
  }

  private newClient(keys: ApiKeys, session: string): TelegramClient {
    return new TelegramClient(new StringSession(session), keys.apiId, keys.apiHash, {
      connectionRetries: 10,
      autoReconnect: true,
      floodSleepThreshold: 30,
      deviceModel: 'Claude connector',
      systemVersion: 'Linux',
      appVersion: '1.0',
      baseLogger: new Logger(LogLevel.ERROR),
    });
  }

  /** On boot: reconnects a stored session; otherwise waits for the owner to log in. */
  async start(): Promise<void> {
    const keys = this.apiKeys();
    if (!keys) {
      this.link = { state: 'needs_api_keys' };
      return;
    }
    const session = this.secrets.get(SESSION);
    if (!session) {
      this.link = { state: 'logged_out' };
      return;
    }
    this.link = { state: 'connecting' };
    try {
      this.client = this.newClient(keys, session);
      await this.client.connect();
      if (!(await this.client.checkAuthorization())) {
        this.log.warn('telegram session no longer valid; log in again');
        this.secrets.delete(SESSION);
        this.link = { state: 'logged_out' };
        return;
      }
      await this.opened();
    } catch (err) {
      this.log.error('telegram could not connect', { error: explain(err) });
      this.link = { state: 'error', message: explain(err) };
    }
  }

  private async opened(): Promise<void> {
    const me = (await this.client!.getMe()) as Api.User;
    this.link = { state: 'open', since: Date.now(), me: { name: personName(me), username: me.username ?? undefined, phone: me.phone ? `+${me.phone}` : undefined } };
    this.log.info('telegram connected');
    // Warm the entity cache so chats can be addressed by id.
    this.dialogs({ refresh: true }).catch(() => undefined);
  }

  /** Step 1 of the login: Telegram sends a code to the account's Telegram apps (or by SMS). */
  async sendCode(phoneInput: string): Promise<void> {
    const keys = this.apiKeys();
    if (!keys) throw new TelegramError('Enter the API id and hash first.');
    const phone = internationalNumber(phoneInput);
    await this.client?.disconnect().catch(() => undefined);
    this.client = this.newClient(keys, '');
    try {
      await this.client.connect();
      const sent = await this.client.sendCode(keys, phone);
      this.pending = { phone, phoneCodeHash: sent.phoneCodeHash };
      this.link = { state: 'awaiting_code', phone, viaApp: sent.isCodeViaApp, since: Date.now() };
      this.log.info('telegram login code sent', { viaApp: sent.isCodeViaApp });
    } catch (err) {
      throw new TelegramError(explain(err));
    }
  }

  /** Step 2: the code. Accounts with two-step verification then need their cloud password. */
  async submitCode(code: string): Promise<void> {
    if (!this.client || !this.pending) throw new TelegramError('The login has expired. Start again.');
    const phoneCode = code.replace(/\D/g, '');
    try {
      await this.client.invoke(new Api.auth.SignIn({ phoneNumber: this.pending.phone, phoneCodeHash: this.pending.phoneCodeHash, phoneCode }));
    } catch (err) {
      if ((err as { errorMessage?: string }).errorMessage === 'SESSION_PASSWORD_NEEDED') {
        const pw = await this.client.invoke(new Api.account.GetPassword());
        this.link = { state: 'awaiting_password', phone: this.pending.phone, hint: pw.hint ?? undefined };
        return;
      }
      throw new TelegramError(explain(err));
    }
    await this.finishLogin();
  }

  /** Step 3 (two-step verification only): the cloud password. */
  async submitPassword(password: string): Promise<void> {
    if (!this.client || this.link.state !== 'awaiting_password') throw new TelegramError('The login has expired. Start again.');
    try {
      const pw = await this.client.invoke(new Api.account.GetPassword());
      await this.client.invoke(new Api.auth.CheckPassword({ password: await computeCheck(pw, password) }));
    } catch (err) {
      throw new TelegramError(explain(err));
    }
    await this.finishLogin();
  }

  private async finishLogin(): Promise<void> {
    const session = (this.client!.session as StringSession).save();
    this.secrets.set(SESSION, session);
    this.pending = undefined;
    await this.opened();
  }

  cancelLogin(): void {
    if (this.link.state !== 'awaiting_code' && this.link.state !== 'awaiting_password') return;
    this.pending = undefined;
    void this.client?.disconnect().catch(() => undefined);
    this.client = undefined;
    this.link = { state: this.apiKeys() ? 'logged_out' : 'needs_api_keys' };
  }

  /** Ends the session on Telegram (it disappears from Settings → Devices) and forgets it here. */
  async logout(): Promise<void> {
    try {
      if (this.client && this.link.state === 'open') await this.client.invoke(new Api.auth.LogOut());
    } catch {
      // Already gone on Telegram's side.
    }
    await this.client?.disconnect().catch(() => undefined);
    this.client = undefined;
    this.secrets.delete(SESSION);
    this.dialogCache = undefined;
    this.link = { state: this.apiKeys() ? 'logged_out' : 'needs_api_keys' };
    this.log.info('telegram logged out');
  }

  async stop(): Promise<void> {
    await this.client?.disconnect().catch(() => undefined);
  }

  private open(): TelegramClient {
    if (!this.client || this.link.state !== 'open') {
      const s = this.link.state;
      throw new TelegramUnavailable(
        s === 'connecting'
          ? 'Telegram is connecting. Try again in a moment.'
          : s === 'error'
            ? `Telegram could not connect: ${this.link.state === 'error' ? this.link.message : ''} The owner checks the admin page.`
            : 'Telegram is not logged in on this connector. The owner logs in on the admin page.',
      );
    }
    return this.client;
  }

  /** Runs a Telegram call, turning its errors into readable ones and noticing a revoked session. */
  private async call<T>(fn: (c: TelegramClient) => Promise<T>): Promise<T> {
    const c = this.open();
    try {
      return await fn(c);
    } catch (err) {
      if (err instanceof TelegramError || err instanceof TelegramUnavailable) throw err;
      const code = (err as { errorMessage?: string })?.errorMessage ?? '';
      if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|USER_DEACTIVATED/.test(code)) {
        this.secrets.delete(SESSION);
        this.link = { state: 'logged_out' };
      }
      throw new TelegramError(explain(err));
    }
  }

  // ---- reading ----

  private chatFromDialog(d: { id?: { toString(): string }; entity?: unknown; name?: string; title?: string; unreadCount: number; unreadMentionsCount: number; archived: boolean; pinned: boolean; date: number; message?: Api.Message; dialog: Api.Dialog }): ChatInfo | undefined {
    if (!d.id || !d.entity) return undefined;
    const e = d.entity;
    const id = d.id.toString();
    const name = d.name || d.title || personName(e);
    this.names.set(id, name);
    const muteUntil = num(d.dialog.notifySettings?.muteUntil) ?? 0;
    return {
      id,
      name,
      kind: kindOf(e),
      username: (e as { username?: string }).username ?? undefined,
      phone: e instanceof Api.User && e.phone ? `+${e.phone}` : undefined,
      unread: d.unreadCount,
      mentions: d.unreadMentionsCount || undefined,
      archived: d.archived,
      pinned: d.pinned,
      muted: muteUntil > Date.now() / 1000 || undefined,
      lastDate: d.date || undefined,
      lastPreview: d.message ? this.preview(d.message) : undefined,
      members: num((e as { participantsCount?: number }).participantsCount),
    };
  }

  private preview(m: Api.Message | Api.MessageService): string {
    const info = this.toMessage(m, '');
    const body = info.text ?? (info.media ? `[${info.kind}${info.media.filename ? ` ${info.media.filename}` : ''}]` : `[${info.kind}]`);
    const line = body.replace(/\s+/g, ' ');
    return line.length > 120 ? `${line.slice(0, 120)}…` : line;
  }

  async dialogs(opts: { archived?: boolean; refresh?: boolean } = {}): Promise<ChatInfo[]> {
    if (!opts.refresh && this.dialogCache && Date.now() - this.dialogCache.at < DIALOG_CACHE_MS) {
      return opts.archived === undefined ? this.dialogCache.list : this.dialogCache.list.filter((c) => c.archived === opts.archived);
    }
    const list = await this.call(async (c) => {
      const [main, archive] = await Promise.all([c.getDialogs({ limit: 1000, folder: 0 }), c.getDialogs({ limit: 500, folder: 1 })]);
      return [...main, ...archive].map((d) => this.chatFromDialog(d as never)).filter((x): x is ChatInfo => Boolean(x));
    });
    this.dialogCache = { at: Date.now(), list };
    return opts.archived === undefined ? list : list.filter((c) => c.archived === opts.archived);
  }

  async resolve(ref: string): Promise<ChatInfo | undefined> {
    const r = ref.trim();
    const username = /^@?([A-Za-z][A-Za-z0-9_]{3,31})$/.exec(r)?.[1] ?? /(?:https?:\/\/)?t(?:elegram)?\.me\/([A-Za-z][A-Za-z0-9_]{3,31})\/?$/i.exec(r)?.[1];
    if (!username) return undefined;
    return this.call(async (c) => {
      try {
        const e = await c.getEntity(username);
        const id = (await c.getPeerId(e)).toString();
        const name = personName(e);
        this.names.set(id, name);
        return { id, name, kind: kindOf(e), username, unread: 0, archived: false, pinned: false };
      } catch (err) {
        if (/USERNAME_NOT_OCCUPIED|USERNAME_INVALID|No user has/.test(String((err as { errorMessage?: string })?.errorMessage ?? err))) return undefined;
        throw err;
      }
    });
  }

  /** The entity of a chat id; the dialogs are loaded first when Telegram's cache does not have it yet. */
  private async peer(c: TelegramClient, chatId: string): Promise<Api.TypeInputPeer> {
    const id = bigInt(chatId);
    try {
      return await c.getInputEntity(id);
    } catch {
      await this.dialogs({ refresh: true });
      try {
        return await c.getInputEntity(id);
      } catch {
        throw new TelegramError(`Telegram does not know chat ${chatId}. Use telegram_list_chats to find it.`);
      }
    }
  }

  toMessage(m: Api.Message | Api.MessageService, chatId: string): MessageInfo {
    const sender = (m as { sender?: unknown }).sender;
    const base: MessageInfo = {
      id: m.id,
      chatId: chatId || (m.chatId?.toString() ?? ''),
      date: m.date,
      out: Boolean(m.out),
      senderName: m.out ? 'me' : sender ? personName(sender) : (m.post ? this.names.get(chatId) ?? 'channel' : 'unknown'),
      senderId: m.senderId?.toString(),
      kind: 'other',
      replyToId: (m.replyTo as Api.MessageReplyHeader | undefined)?.replyToMsgId ?? undefined,
    };
    if (m instanceof Api.MessageService) {
      const text = actionText(m.action);
      return { ...base, kind: 'service', ...(text ? { text } : {}) };
    }
    const msg = m;
    const media = mediaOf(msg.media);
    let kind: MessageKind = 'text';
    if (msg.sticker) kind = 'sticker';
    else if (msg.gif) kind = 'gif';
    else if (msg.videoNote) kind = 'video_note';
    else if (msg.voice) kind = 'voice';
    else if (msg.audio) kind = 'audio';
    else if (msg.video) kind = 'video';
    else if (msg.photo) kind = 'photo';
    else if (msg.document) kind = 'document';
    else if (msg.geo) kind = 'location';
    else if (msg.contact) kind = 'contact';
    else if (msg.poll) kind = 'poll';
    let text = msg.message || undefined;
    if (kind === 'location' && msg.geo instanceof Api.GeoPoint) text = [text, `https://maps.google.com/?q=${msg.geo.lat},${msg.geo.long}`].filter(Boolean).join(' ');
    if (kind === 'contact' && msg.contact) text = `${[msg.contact.firstName, msg.contact.lastName].filter(Boolean).join(' ')} +${msg.contact.phoneNumber}`;
    if (kind === 'poll' && msg.poll) {
      const q = msg.poll.poll.question;
      const question = typeof q === 'string' ? q : ((q as { text?: string })?.text ?? 'Poll');
      const answers = msg.poll.poll.answers.map((a) => (typeof a.text === 'string' ? a.text : ((a.text as { text?: string })?.text ?? ''))).join(' | ');
      text = `${question} [${answers}]`;
    }
    const markup = msg.replyMarkup;
    const buttons =
      markup instanceof Api.ReplyInlineMarkup || markup instanceof Api.ReplyKeyboardMarkup ? markup.rows.map((r) => r.buttons.map((b) => (b as { text: string }).text)) : undefined;
    const fwd = msg.fwdFrom;
    return {
      ...base,
      kind,
      text,
      media: kind === 'text' ? undefined : media,
      forwardedFrom: fwd ? (fwd.fromName ?? (fwd.fromId ? this.names.get(String(num((fwd.fromId as { userId?: unknown; channelId?: unknown }).userId ?? (fwd.fromId as { channelId?: unknown }).channelId))) ?? 'someone' : 'someone')) : undefined,
      edited: Boolean(msg.editDate && !msg.editHide) || undefined,
      buttons: buttons?.length ? buttons : undefined,
      views: msg.views ?? undefined,
    };
  }

  async history(chatId: string, opts: HistoryOptions): Promise<MessageInfo[]> {
    return this.call(async (c) => {
      const peer = await this.peer(c, chatId);
      if (opts.fromStart && opts.since !== undefined) {
        const list = await c.getMessages(peer, { limit: opts.limit, reverse: true, offsetDate: opts.since, ...(opts.beforeId ? { maxId: opts.beforeId } : {}) });
        return list.filter((m) => (opts.until === undefined || m.date <= opts.until)).map((m) => this.toMessage(m, chatId));
      }
      const list = await c.getMessages(peer, {
        limit: opts.limit,
        ...(opts.beforeId ? { offsetId: opts.beforeId } : {}),
        ...(opts.afterId ? { minId: opts.afterId } : {}),
        ...(opts.until !== undefined ? { offsetDate: opts.until } : {}),
      });
      return list
        .filter((m) => opts.since === undefined || m.date >= opts.since)
        .map((m) => this.toMessage(m, chatId))
        .reverse();
    });
  }

  async search(opts: SearchOptions): Promise<MessageInfo[]> {
    return this.call(async (c) => {
      const filter = filterOf(opts.filter);
      const params = {
        limit: opts.limit,
        search: opts.query ?? '',
        ...(filter ? { filter } : {}),
        ...(opts.until !== undefined ? { offsetDate: opts.until } : {}),
        ...(opts.beforeId ? { offsetId: opts.beforeId } : {}),
      };
      let list: Api.Message[];
      if (opts.chatId) {
        const peer = await this.peer(c, opts.chatId);
        const fromUser = opts.fromId ? await this.peer(c, opts.fromId) : undefined;
        list = await c.getMessages(peer, { ...params, ...(fromUser ? { fromUser } : {}) });
      } else {
        // No chat: Telegram's global search across every chat (messages.searchGlobal).
        list = await c.getMessages(undefined, params);
      }
      return list.filter((m) => opts.since === undefined || m.date >= opts.since).map((m) => this.toMessage(m, opts.chatId ?? m.chatId?.toString() ?? ''));
    });
  }

  async messages(chatId: string, ids: number[]): Promise<MessageInfo[]> {
    return this.call(async (c) => {
      const peer = await this.peer(c, chatId);
      const list = await c.getMessages(peer, { ids });
      return list.filter(Boolean).map((m) => this.toMessage(m, chatId));
    });
  }

  chatName(chatId: string): string | undefined {
    return this.names.get(chatId);
  }

  async download(chatId: string, messageId: number): Promise<{ data: Buffer; filename?: string; mimetype?: string }> {
    return this.call(async (c) => {
      const peer = await this.peer(c, chatId);
      const [m] = await c.getMessages(peer, { ids: [messageId] });
      if (!m || !(m instanceof Api.Message) || !m.media) throw new TelegramError(`Message ${messageId} carries no file.`);
      const data = await c.downloadMedia(m, {});
      if (!data || !(data instanceof Buffer)) throw new TelegramError(`The file of message ${messageId} could not be downloaded.`);
      const info = mediaOf(m.media);
      return { data, filename: info?.filename, mimetype: info?.mimetype };
    });
  }

  // ---- writing ----

  async sendText(chatId: string, text: string, replyTo?: number): Promise<number> {
    return this.call(async (c) => {
      const peer = await this.peer(c, chatId);
      const sent = await c.sendMessage(peer, { message: text, ...(replyTo ? { replyTo } : {}) });
      this.dialogCache = undefined;
      return sent.id;
    });
  }

  async sendFile(chatId: string, file: OutgoingFile, replyTo?: number): Promise<number> {
    return this.call(async (c) => {
      const peer = await this.peer(c, chatId);
      const sent = await c.sendFile(peer, {
        file: new CustomFile(file.filename, file.data.length, '', file.data),
        ...(file.caption ? { caption: file.caption } : {}),
        forceDocument: Boolean(file.asDocument) || !/^(image\/(jpeg|png|webp)|video\/mp4)$/i.test(file.mimetype),
        ...(replyTo ? { replyTo } : {}),
        workers: 1,
      });
      this.dialogCache = undefined;
      return sent.id;
    });
  }

  async markRead(chatId: string): Promise<void> {
    await this.call(async (c) => {
      const peer = await this.peer(c, chatId);
      await c.markAsRead(peer);
      this.dialogCache = undefined;
    });
  }

  async press(chatId: string, messageId: number, button: { text?: string; row?: number; column?: number }): Promise<string | undefined> {
    return this.call(async (c) => {
      const peer = await this.peer(c, chatId);
      const [m] = await c.getMessages(peer, { ids: [messageId] });
      if (!m || !(m instanceof Api.Message)) throw new TelegramError(`No message ${messageId} in this chat.`);
      const rows = this.toMessage(m, chatId).buttons ?? [];
      if (!rows.length) throw new TelegramError(`Message ${messageId} has no buttons.`);
      let i: number | undefined;
      let j: number | undefined;
      if (button.text !== undefined) {
        const wanted = button.text.trim().toLowerCase();
        outer: for (const [ri, row] of rows.entries()) {
          for (const [ci, label] of row.entries()) {
            if (label.trim().toLowerCase() === wanted) {
              i = ri;
              j = ci;
              break outer;
            }
          }
        }
        if (i === undefined) throw new TelegramError(`No button "${button.text}" on message ${messageId}. Buttons: ${rows.map((r) => r.join(' | ')).join(' / ')}`);
      } else {
        i = button.row ?? 0;
        j = button.column ?? 0;
        if (!rows[i]?.[j]) throw new TelegramError(`No button at row ${i}, column ${j}.`);
      }
      const answer = await m.click({ i, j });
      if (answer instanceof Api.messages.BotCallbackAnswer) return answer.message ?? (answer.url ? `Opens ${answer.url}` : undefined);
      if (typeof answer === 'string') return answer;
      return undefined;
    });
  }

  async members(chatId: string, limit: number): Promise<{ name: string; username?: string; admin?: boolean }[]> {
    return this.call(async (c) => {
      const peer = await this.peer(c, chatId);
      const users = await c.getParticipants(peer, { limit });
      return users.map((u) => {
        const p = (u as unknown as { participant?: unknown }).participant;
        const admin = p instanceof Api.ChannelParticipantAdmin || p instanceof Api.ChannelParticipantCreator || p instanceof Api.ChatParticipantAdmin || p instanceof Api.ChatParticipantCreator;
        return { name: personName(u), username: u.username ?? undefined, admin: admin || undefined };
      });
    });
  }
}

/** A phone number in international form (+ and country code), as Telegram's login expects it. */
export function internationalNumber(input: string): string {
  const s = input.trim().replace(/[\s().\-/]/g, '');
  const example = 'Enter the number with its country code, for example +33 6 12 34 56 78.';
  let digits: string;
  if (s.startsWith('+')) digits = s.slice(1);
  else if (s.startsWith('00')) digits = s.slice(2);
  else if (s.startsWith('0')) throw new TelegramError(`${example} A number starting with 0 is missing it.`);
  else digits = s;
  if (!/^\d{8,15}$/.test(digits)) throw new TelegramError(example);
  if (/^(33|32|41|44|49|39|31|43|34|351)0/.test(digits)) digits = digits.replace(/^(33|32|41|44|49|39|31|43|34|351)0/, '$1');
  return `+${digits}`;
}
