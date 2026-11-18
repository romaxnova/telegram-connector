/**
 * Helpers shared by the Telegram tools: times in the owner's zone, finding a
 * chat from what Claude was told, and messages rendered as compact lines.
 */
import * as z from 'zod';
import { ToolInputError, type ToolContext } from '../registry.js';
import type { ChatInfo, MessageInfo } from '../../telegram/types.js';
import { humanSize } from '../extract/readable.js';

export const chatParam = z
  .string()
  .min(1)
  .max(200)
  .describe('The chat: its chat_id (from telegram_list_chats), an @username or t.me link, or (part of) the name of the person, group, channel or bot.');

export const sinceParam = z.string().max(40).optional().describe('Only from this time on: an ISO date or date-time (2026-11-01, 2026-11-01T18:00), read in the default timezone when it has no offset, or a number of days back such as "7d".');
export const untilParam = z.string().max(40).optional().describe('Only up to this time (same forms as since).');

/** "2026-11-18 14:05" in the configured zone. */
export function fmt(ts: number, tz: string): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ts * 1000));
}
/** Offset of a zone from UTC at an instant, in minutes. */
function offsetMinutes(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - utcMs) / 60000);
}
/** Unix seconds for a time given by Claude; undefined when none was given. */
export function parseWhen(value: string | undefined, tz: string, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined;
  const v = value.trim();
  const rel = /^(\d{1,4})\s*([dhw])$/i.exec(v);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    const ms = unit === 'h' ? n * 3600e3 : unit === 'w' ? n * 7 * 86400e3 : n * 86400e3;
    return Math.floor((now - ms) / 1000);
  }
  const local = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
  if (local) {
    const [, y, mo, d, h, mi, s] = local;
    const naive = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0));
    // The zone's offset at that wall-clock time (checked twice around DST changes).
    let utc = naive - offsetMinutes(naive, tz) * 60000;
    utc = naive - offsetMinutes(utc, tz) * 60000;
    return Math.floor(utc / 1000);
  }
  const parsed = Date.parse(v);
  if (Number.isNaN(parsed)) throw new ToolInputError(`"${v.slice(0, 40)}" is not a date: use 2026-11-01, 2026-11-01T18:00, an ISO time with offset, or "7d".`);
  return Math.floor(parsed / 1000);
}

/** Lower case, without accents or punctuation: how names are compared. */
export function fold(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@+]+/gu, ' ')
    .trim();
}

/**
 * The chat Claude means: an id, an @username or t.me link (also outside the dialogs), or a name.
 * Exact names win over partial ones; several matches are listed back for Claude to choose from.
 */
export async function resolveChat(ctx: ToolContext, input: string): Promise<ChatInfo> {
  const q = input.trim();
  const dialogs = await ctx.tg.dialogs();
  if (/^-?\d{4,20}$/.test(q)) {
    const byId = dialogs.find((c) => c.id === q);
    if (byId) return byId;
  }
  if (/^@|t(?:elegram)?\.me\//i.test(q)) {
    const uname = q.replace(/^@/, '').replace(/^(?:https?:\/\/)?t(?:elegram)?\.me\//i, '').replace(/\/$/, '').toLowerCase();
    const known = dialogs.find((c) => c.username?.toLowerCase() === uname);
    if (known) return known;
    const resolved = await ctx.tg.resolve(q);
    if (resolved) return resolved;
    throw new ToolInputError(`Telegram has no user, group, channel or bot @${uname}.`);
  }
  const digits = q.replace(/[\s().-]/g, '');
  if (/^\+\d{6,15}$/.test(digits)) {
    const byPhone = dialogs.find((c) => c.phone === digits);
    if (byPhone) return byPhone;
  }
  const f = fold(q);
  if (!f) throw new ToolInputError('Say which chat: a name, an @username or a chat_id.');
  const exact = dialogs.filter((c) => fold(c.name) === f || (c.username && c.username.toLowerCase() === f));
  if (exact.length === 1) return exact[0]!;
  const words = f.split(' ');
  const partial = exact.length ? exact : dialogs.filter((c) => words.every((w) => fold(`${c.name} ${c.username ?? ''}`).includes(w)));
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) {
    const tz = ctx.config.defaultTimezone;
    const list = partial
      .slice(0, 15)
      .map((c) => `${c.name}${c.username ? ` @${c.username}` : ''} (${c.kind}, chat_id ${c.id}${c.lastDate ? `, last message ${fmt(c.lastDate, tz)}` : ''})`)
      .join('; ');
    throw new ToolInputError(`Several chats match "${input}": ${list}${partial.length > 15 ? `; and ${partial.length - 15} more` : ''}. Ask the user which one, or pass its chat_id.`);
  }
  // A bare username Claude passed without @.
  if (/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(q)) {
    const resolved = await ctx.tg.resolve(q).catch(() => undefined);
    if (resolved) return resolved;
  }
  throw new ToolInputError(`No chat matches "${input}". Call telegram_list_chats with a shorter query, or pass an @username.`);
}

export function mediaPhrase(m: MessageInfo): string | undefined {
  if (!m.media) return undefined;
  const bits: string[] = [m.kind.replace('_', ' ')];
  if (m.media.filename) bits.push(`"${m.media.filename}"`);
  const extra: string[] = [];
  if (m.media.size) extra.push(humanSize(m.media.size));
  if (m.media.seconds) extra.push(`${m.media.seconds}s`);
  return `${bits.join(' ')}${extra.length ? `, ${extra.join(', ')}` : ''}`;
}

/** One message as a line of a transcript; `quoted` gives the start of the message it replies to. */
export function messageLine(ctx: ToolContext, m: MessageInfo, opts: { chatName?: string; quoted?: Map<number, MessageInfo> } = {}): string {
  const tz = ctx.config.defaultTimezone;
  const parts: string[] = [`[${fmt(m.date, tz)}] ${opts.chatName ? `${opts.chatName} · ` : ''}${m.senderName}:`];
  if (m.forwardedFrom) parts.push(`(forwarded from ${m.forwardedFrom})`);
  if (m.replyToId) {
    const q = opts.quoted?.get(m.replyToId);
    const qt = q?.text ? q.text.replace(/\s+/g, ' ') : undefined;
    parts.push(`(reply to #${m.replyToId}${qt ? ` "${qt.length > 80 ? `${qt.slice(0, 80)}…` : qt}"` : ''})`);
  }
  const media = mediaPhrase(m);
  if (media) parts.push(`[${media}]`);
  if (m.text) parts.push(m.text);
  if (m.edited) parts.push('(edited)');
  if (m.buttons?.length) parts.push(`{buttons: ${m.buttons.map((r) => r.join(' | ')).join(' / ')}}`);
  parts.push(`#${m.id}`);
  return parts.join(' ');
}

/** Message ids given as numbers, "#123" or "123". */
export function messageId(value: string | number): number {
  const n = typeof value === 'number' ? value : Number(String(value).trim().replace(/^#/, ''));
  if (!Number.isInteger(n) || n <= 0) throw new ToolInputError(`"${value}" is not a message id: ids are the numbers after # in telegram_read_chat.`);
  return n;
}
