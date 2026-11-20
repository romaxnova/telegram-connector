/**
 * Test helpers: a fake Telegram that records what it was asked to do, and a ready-made ToolContext.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { loadConfig, type Config } from './config.js';
import { silentLogger } from './log.js';
import type { ToolContext, ToolDefinition } from './mcp/registry.js';
import { runTool } from './mcp/server.js';
import { UploadStore } from './uploads.js';
import type { ChatInfo, HistoryOptions, LinkState, MessageInfo, OutgoingFile, SearchOptions, TelegramPort } from './telegram/types.js';

export const TEST_KEY = Buffer.alloc(32, 7);

export function testEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    BASE_URL: 'https://tg.test',
    ADMIN_PASSWORD: 'correct horse battery staple',
    TOKEN_ENCRYPTION_KEY: TEST_KEY.toString('base64'),
    DB_PATH: ':memory:',
    DEFAULT_TIMEZONE: 'Europe/Paris',
    LOG_LEVEL: 'error',
    PEER_UPLOAD_HOSTS: 'gspot.test',
    TELEGRAM_BOT_ALLOWLIST: '@PriceBot',
    ...overrides,
  };
}

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig(testEnv(overrides));
}

/** A Telegram account held in memory: chats, their messages (ids ascending), files, and a scripted bot. */
export class FakeTelegram implements TelegramPort {
  state: LinkState = { state: 'open', since: Date.now(), me: { name: 'Roman', username: 'roman' } };
  chats: ChatInfo[] = [];
  history_: Map<string, MessageInfo[]> = new Map();
  files = new Map<string, Buffer>();
  sent: { chatId: string; text?: string; file?: OutgoingFile; voice?: { ogg: Buffer; seconds: number; waveform: Buffer }; replyTo?: number }[] = [];
  pressed: { chatId: string; messageId: number; button: unknown }[] = [];
  read: string[] = [];
  /** How a bot answers: called on each text or press, may append messages. */
  botScript?: (chatId: string, input: { text?: string; press?: string }) => void;
  private nextId = 1000;

  status(): LinkState {
    return this.state;
  }
  async dialogs(opts: { archived?: boolean } = {}): Promise<ChatInfo[]> {
    return opts.archived === undefined ? this.chats : this.chats.filter((c) => c.archived === opts.archived);
  }
  async resolve(ref: string): Promise<ChatInfo | undefined> {
    const u = ref.replace(/^@/, '').replace(/^(?:https?:\/\/)?t\.me\//, '').toLowerCase();
    return this.chats.find((c) => c.username?.toLowerCase() === u);
  }
  add(chatId: string, m: Partial<MessageInfo> & { text?: string }): MessageInfo {
    const list = this.history_.get(chatId) ?? [];
    const msg: MessageInfo = { id: m.id ?? ++this.nextId, chatId, date: m.date ?? 1_763_400_000 + list.length * 60, out: false, senderName: 'Someone', kind: 'text', ...m };
    list.push(msg);
    this.history_.set(chatId, list);
    return msg;
  }
  async history(chatId: string, o: HistoryOptions): Promise<MessageInfo[]> {
    let list = [...(this.history_.get(chatId) ?? [])];
    if (o.beforeId) list = list.filter((m) => m.id < o.beforeId!);
    if (o.afterId) list = list.filter((m) => m.id > o.afterId!);
    if (o.since !== undefined) list = list.filter((m) => m.date >= o.since!);
    if (o.until !== undefined) list = list.filter((m) => m.date <= o.until!);
    return o.fromStart ? list.slice(0, o.limit) : list.slice(-o.limit);
  }
  async search(o: SearchOptions): Promise<MessageInfo[]> {
    const pool = o.chatId ? (this.history_.get(o.chatId) ?? []) : [...this.history_.values()].flat();
    const q = (o.query ?? '').toLowerCase();
    return pool
      .filter((m) => !q || `${m.text ?? ''} ${m.media?.filename ?? ''}`.toLowerCase().includes(q))
      .filter((m) => !o.filter || (o.filter === 'document' ? m.kind === 'document' : o.filter === 'photo' ? m.kind === 'photo' : true))
      .sort((a, b) => b.date - a.date)
      .slice(0, o.limit);
  }
  async messages(chatId: string, ids: number[]): Promise<MessageInfo[]> {
    return (this.history_.get(chatId) ?? []).filter((m) => ids.includes(m.id));
  }
  async download(chatId: string, messageId: number) {
    const data = this.files.get(`${chatId}/${messageId}`);
    if (!data) throw new Error('no file');
    const m = (this.history_.get(chatId) ?? []).find((x) => x.id === messageId);
    return { data, filename: m?.media?.filename, mimetype: m?.media?.mimetype };
  }
  async sendText(chatId: string, text: string, replyTo?: number): Promise<number> {
    this.sent.push({ chatId, text, replyTo });
    const m = this.add(chatId, { out: true, senderName: 'me', text });
    this.botScript?.(chatId, { text });
    return m.id;
  }
  async sendFile(chatId: string, file: OutgoingFile, replyTo?: number): Promise<number> {
    this.sent.push({ chatId, file, replyTo });
    return this.add(chatId, { out: true, senderName: 'me', kind: 'document', media: { filename: file.filename } }).id;
  }
  async sendVoice(chatId: string, note: { ogg: Buffer; seconds: number; waveform: Buffer }, replyTo?: number): Promise<number> {
    this.sent.push({ chatId, voice: note, replyTo });
    return this.add(chatId, { out: true, senderName: 'me', kind: 'voice', media: { seconds: note.seconds } }).id;
  }
  async markRead(chatId: string): Promise<void> {
    this.read.push(chatId);
  }
  async press(chatId: string, messageId: number, button: { text?: string }): Promise<string | undefined> {
    this.pressed.push({ chatId, messageId, button });
    this.botScript?.(chatId, { press: button.text });
    return undefined;
  }
  async members(): Promise<{ name: string; username?: string; admin?: boolean }[]> {
    return [{ name: 'Alice', username: 'alice', admin: true }, { name: 'Bob' }];
  }
}

export function testContext(overrides: Partial<ToolContext> = {}): ToolContext & { tg: FakeTelegram } {
  return { config: testConfig(), log: silentLogger, uploads: new UploadStore(), tg: new FakeTelegram(), ...overrides } as ToolContext & { tg: FakeTelegram };
}

/** Runs a tool as the MCP server would, and returns its text. */
export async function call(def: ToolDefinition<any>, args: Record<string, unknown>, ctx: ToolContext): Promise<{ text: string; isError: boolean; result: CallToolResult }> {
  const result = await runTool(def as ToolDefinition, args, ctx);
  const text = result.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  return { text, isError: Boolean(result.isError), result };
}
