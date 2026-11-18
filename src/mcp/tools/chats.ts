/**
 * Reading Telegram: status, chats (people, groups, channels, bots), a chat's
 * messages, search across chats, group members, and marking a chat read.
 */
import * as z from 'zod';
import { defineTool, jsonResult, textResult, ToolInputError, type ToolContext } from '../registry.js';
import { chatParam, fmt, fold, messageId, messageLine, parseWhen, resolveChat, sinceParam, untilParam } from './common.js';
import type { ChatInfo, MessageInfo } from '../../telegram/types.js';

/** The messages the given ones reply to, when they are not in the page already (one request). */
async function quotedOf(ctx: ToolContext, chatId: string, messages: MessageInfo[]): Promise<Map<number, MessageInfo>> {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const missing = [...new Set(messages.map((m) => m.replyToId).filter((id): id is number => Boolean(id) && !byId.has(id!)))].slice(0, 50);
  if (missing.length) {
    try {
      for (const m of await ctx.tg.messages(chatId, missing)) byId.set(m.id, m);
    } catch {
      // Quotes are a nicety: the transcript stands without them.
    }
  }
  return byId;
}

export const statusTool = defineTool({
  name: 'telegram_status',
  title: 'Telegram connection status',
  description: 'Whether Telegram is logged in and connected, as which account, which bots telegram_bot may talk to, where files can go, and the admin page. Call it when a tool says Telegram is unavailable.',
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async handler(_args, ctx) {
    const s = ctx.tg.status();
    const admin = `${ctx.config.baseUrl.origin}/admin`;
    return jsonResult({
      state: s.state,
      account: s.state === 'open' ? s.me : undefined,
      connected_since: s.state === 'open' ? new Date(s.since).toISOString() : undefined,
      error: s.state === 'error' ? s.message : undefined,
      bots_allowed: ctx.config.botAllowlist.length ? ctx.config.botAllowlist.map((b) => `@${b}`) : undefined,
      files_can_go_to: ctx.config.peerUploadHosts,
      timezone: ctx.config.defaultTimezone,
      admin_page: admin,
      note: s.state === 'open' ? 'Telegram keeps the whole history: every chat can be read and searched back to its beginning.' : `Not connected: the owner logs in on ${admin}.`,
    });
  },
});

function chatRow(ctx: ToolContext, c: ChatInfo) {
  const tz = ctx.config.defaultTimezone;
  return {
    chat_id: c.id,
    name: c.name,
    kind: c.kind,
    username: c.username ? `@${c.username}` : undefined,
    phone: c.phone,
    unread: c.unread || undefined,
    mentions: c.mentions,
    last_message_at: c.lastDate ? fmt(c.lastDate, tz) : undefined,
    last_message: c.lastPreview,
    members: c.members,
    archived: c.archived || undefined,
    pinned: c.pinned || undefined,
    muted: c.muted,
  };
}

export const listChatsTool = defineTool({
  name: 'telegram_list_chats',
  title: 'List Telegram chats, groups, channels and bots',
  description:
    'Lists chats most recent first: chat_id, name, kind (user, bot, group, channel), @username, unread count and mentions, time and preview of the last message. query finds by name or username (accents and case ignored, every word must match); kind keeps one kind; unread_only shows what is waiting; archived chats are included only with include_archived (or when query is given).',
  inputSchema: {
    query: z.string().max(100).optional(),
    kind: z.enum(['all', 'user', 'bot', 'group', 'channel']).optional().describe('Default all.'),
    unread_only: z.boolean().optional(),
    include_archived: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional().describe('Default 30.'),
    offset: z.number().int().min(0).optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx) {
    let chats = await ctx.tg.dialogs();
    if (args.query?.trim()) {
      const words = fold(args.query).split(' ');
      chats = chats.filter((c) => words.every((w) => fold(`${c.name} ${c.username ?? ''}`).includes(w)));
    } else if (!args.include_archived) chats = chats.filter((c) => !c.archived);
    if (args.kind && args.kind !== 'all') chats = chats.filter((c) => c.kind === args.kind);
    if (args.unread_only) chats = chats.filter((c) => c.unread > 0);
    chats = [...chats].sort((a, b) => Number(b.pinned && !b.archived) - Number(a.pinned && !a.archived) || (b.lastDate ?? 0) - (a.lastDate ?? 0));
    const limit = args.limit ?? 30;
    const offset = args.offset ?? 0;
    const page = chats.slice(offset, offset + limit);
    if (!page.length) return jsonResult({ count: 0, note: args.query ? `No chat name contains "${args.query}". For someone you have no chat with, pass their @username to the other tools.` : 'No chats match.' });
    return jsonResult({ total: chats.length, chats: page.map((c) => chatRow(ctx, c)), next_offset: offset + limit < chats.length ? offset + limit : undefined });
  },
});

export const readChatTool = defineTool({
  name: 'telegram_read_chat',
  title: 'Read a Telegram chat',
  description:
    "Reads a chat, group, channel or bot conversation as a transcript, oldest to newest: time, sender, text, files ([document \"bail.pdf\", 230 KB]), replies, forwards, a bot's buttons, and each message's id after #. By default the latest `limit` messages; `before` (a message id) pages back; `since` with from_start: true reads forward from a date. Telegram keeps the whole history, so any period can be read. Files: telegram_get_file reads one, telegram_files_to_link moves it to Drive/Gmail or WhatsApp.",
  inputSchema: {
    chat: chatParam,
    limit: z.number().int().min(1).max(300).optional().describe('Messages to return (default 50).'),
    before: z.union([z.string().max(30), z.number().int()]).optional().describe('Only messages older than this message id: pass the `older` value of the previous result to page back.'),
    since: sinceParam,
    until: untilParam,
    from_start: z.boolean().optional().describe('With since: start from the oldest message after it instead of the newest ones.'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx) {
    const chat = await resolveChat(ctx, args.chat);
    const tz = ctx.config.defaultTimezone;
    const limit = args.limit ?? 50;
    const since = parseWhen(args.since, tz);
    const until = parseWhen(args.until, tz);
    const fromStart = Boolean(args.from_start && since !== undefined);
    const messages = (await ctx.tg.history(chat.id, { limit, beforeId: args.before !== undefined ? messageId(args.before) : undefined, since, until, fromStart })).filter(
      (m) => m.kind !== 'service' || m.text,
    );
    const header = `${chat.name}${chat.username ? ` @${chat.username}` : ''} (${chat.kind}${chat.members ? `, ${chat.members} members` : ''}${chat.phone ? `, ${chat.phone}` : ''}) · chat_id ${chat.id}${chat.unread ? ` · ${chat.unread} unread` : ''}\nTimes in ${tz}.`;
    if (!messages.length) return textResult(`${header}\n\nNo messages in that window.`);
    const quoted = await quotedOf(ctx, chat.id, messages);
    const lines = messages.map((m) => messageLine(ctx, m, { quoted }));
    const first = messages[0]!;
    const last = messages[messages.length - 1]!;
    const footer = fromStart
      ? messages.length >= limit
        ? `More after this: call again with since "${new Date(last.date * 1000).toISOString()}" and from_start: true.`
        : ''
      : messages.length >= limit
        ? `Older messages: call again with before ${first.id}.`
        : 'This is the beginning of the chat (or of the window asked for).';
    return textResult(`${header}\n\n${lines.join('\n')}${footer ? `\n\n${footer}` : ''}`);
  },
});

export const searchTool = defineTool({
  name: 'telegram_search_messages',
  title: 'Search Telegram messages',
  description:
    "Searches messages with Telegram's own search: in one chat (optionally from one sender) or across every chat, group and channel, newest first, optionally in a time window. Each hit shows its chat and id; telegram_read_chat with before <id+1> shows the conversation around it.",
  inputSchema: {
    query: z.string().min(1).max(200).describe('Words to look for.'),
    chat: chatParam.optional(),
    sender: z.string().max(200).optional().describe('With chat: only messages from this person (name, @username or chat_id).'),
    since: sinceParam,
    until: untilParam,
    limit: z.number().int().min(1).max(100).optional().describe('Default 30.'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx) {
    const tz = ctx.config.defaultTimezone;
    const chat = args.chat ? await resolveChat(ctx, args.chat) : undefined;
    if (args.sender && !chat) throw new ToolInputError('sender works together with chat: say in which chat to look.');
    const sender = args.sender ? await resolveChat(ctx, args.sender) : undefined;
    const hits = await ctx.tg.search({ query: args.query, chatId: chat?.id, fromId: sender?.id, since: parseWhen(args.since, tz), until: parseWhen(args.until, tz), limit: args.limit ?? 30 });
    if (!hits.length) return textResult(`No messages match "${args.query}"${chat ? ` in ${chat.name}` : ''}.`);
    const names = new Map((await ctx.tg.dialogs()).map((c) => [c.id, c.name]));
    const lines = hits.map((m) => messageLine(ctx, m, { chatName: chat ? undefined : `${names.get(m.chatId) ?? m.chatId} (chat_id ${m.chatId})` }));
    return textResult(`Times in ${tz}.\n${lines.join('\n')}`);
  },
});

export const groupInfoTool = defineTool({
  name: 'telegram_group_info',
  title: 'Telegram group or channel details',
  description: 'A group\'s or channel\'s kind, @username, member count and members (first 200: name, @username, admin). Channels with hidden members return what Telegram allows.',
  inputSchema: { chat: chatParam, limit: z.number().int().min(1).max(200).optional().describe('Members to list (default 100).') },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx) {
    const chat = await resolveChat(ctx, args.chat);
    if (chat.kind === 'user' || chat.kind === 'bot') throw new ToolInputError(`${chat.name} is a ${chat.kind}, not a group or channel.`);
    let members: Awaited<ReturnType<ToolContext['tg']['members']>> = [];
    let note: string | undefined;
    try {
      members = await ctx.tg.members(chat.id, args.limit ?? 100);
    } catch (err) {
      note = `Members are not visible: ${err instanceof Error ? err.message : String(err)}`;
    }
    return jsonResult({ chat_id: chat.id, name: chat.name, kind: chat.kind, username: chat.username ? `@${chat.username}` : undefined, member_count: chat.members, members: members.map((m) => ({ name: m.name, username: m.username ? `@${m.username}` : undefined, admin: m.admin })), note });
  },
});

export const markReadTool = defineTool({
  name: 'telegram_mark_read',
  title: 'Mark a Telegram chat as read',
  description: 'Marks a chat as read (clears its unread badge on every device, sends read receipts). Only when the user asks: reading through this connector leaves chats unread.',
  inputSchema: { chat: chatParam },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx) {
    const chat = await resolveChat(ctx, args.chat);
    await ctx.tg.markRead(chat.id);
    return jsonResult({ chat: chat.name, marked_read: true });
  },
});

export const readTools = [statusTool, listChatsTool, readChatTool, searchTool, groupInfoTool, markReadTool];
