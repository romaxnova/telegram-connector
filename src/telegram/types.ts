/**
 * What the tools see of Telegram: plain values, so they can be tested with a
 * fake connection. client.ts turns GramJS objects into these.
 */

export type ChatKind = 'user' | 'bot' | 'group' | 'channel';

export interface ChatInfo {
  /** Telegram's marked id: users positive, basic groups negative, supergroups and channels -100…. */
  id: string;
  name: string;
  kind: ChatKind;
  username?: string;
  phone?: string;
  unread: number;
  mentions?: number;
  archived: boolean;
  pinned: boolean;
  muted?: boolean;
  /** Unix seconds of the last message. */
  lastDate?: number;
  lastPreview?: string;
  members?: number;
}

export type MessageKind = 'text' | 'photo' | 'video' | 'audio' | 'voice' | 'video_note' | 'document' | 'sticker' | 'gif' | 'location' | 'contact' | 'poll' | 'service' | 'other';

export const FILE_KINDS: readonly MessageKind[] = ['photo', 'video', 'audio', 'voice', 'video_note', 'document', 'gif', 'sticker'];

export interface MediaInfo {
  filename?: string;
  mimetype?: string;
  size?: number;
  seconds?: number;
}

export interface MessageInfo {
  id: number;
  chatId: string;
  /** Unix seconds. */
  date: number;
  out: boolean;
  senderName: string;
  senderId?: string;
  kind: MessageKind;
  text?: string;
  media?: MediaInfo;
  replyToId?: number;
  forwardedFrom?: string;
  edited?: boolean;
  /** Inline keyboard (bots): button labels, row by row. */
  buttons?: string[][];
  views?: number;
}

export type FileFilter = 'document' | 'photo' | 'video' | 'audio' | 'voice' | 'media' | 'url';

export interface HistoryOptions {
  limit: number;
  /** Only messages older than this id. */
  beforeId?: number;
  /** Only messages newer than this id. */
  afterId?: number;
  /** Unix seconds bounds. */
  since?: number;
  until?: number;
  /** Oldest first from `since` instead of newest first. */
  fromStart?: boolean;
}

export interface SearchOptions {
  query?: string;
  /** Search in one chat; across all chats when absent. */
  chatId?: string;
  filter?: FileFilter;
  since?: number;
  until?: number;
  limit: number;
  /** Only messages older than this id (paging within one chat). */
  beforeId?: number;
  /** Only messages from this sender (in one chat). */
  fromId?: string;
}

export interface OutgoingFile {
  data: Buffer;
  filename: string;
  mimetype: string;
  caption?: string;
  asDocument?: boolean;
}

export type LinkState =
  | { state: 'needs_api_keys' }
  | { state: 'logged_out' }
  | { state: 'awaiting_code'; phone: string; viaApp: boolean; since: number }
  | { state: 'awaiting_password'; phone: string; hint?: string }
  | { state: 'connecting' }
  | { state: 'open'; since: number; me: { name: string; username?: string; phone?: string } }
  | { state: 'error'; message: string };

/** What tools need from the Telegram connection. */
export interface TelegramPort {
  status(): LinkState;
  /** Every dialog (chat, group, channel, bot), most recent first; cached briefly. */
  dialogs(opts?: { archived?: boolean; refresh?: boolean }): Promise<ChatInfo[]>;
  /** A chat by @username, t.me link or id, also when it is not among the dialogs. */
  resolve(ref: string): Promise<ChatInfo | undefined>;
  history(chatId: string, opts: HistoryOptions): Promise<MessageInfo[]>;
  search(opts: SearchOptions): Promise<MessageInfo[]>;
  /** Some messages of a chat by id. */
  messages(chatId: string, ids: number[]): Promise<MessageInfo[]>;
  download(chatId: string, messageId: number): Promise<{ data: Buffer; filename?: string; mimetype?: string }>;
  sendText(chatId: string, text: string, replyTo?: number): Promise<number>;
  sendFile(chatId: string, file: OutgoingFile, replyTo?: number): Promise<number>;
  markRead(chatId: string): Promise<void>;
  /** Presses an inline button of a bot's message; returns the bot's popup answer, if any. */
  press(chatId: string, messageId: number, button: { text?: string; row?: number; column?: number }): Promise<string | undefined>;
  /** Members of a group (first `limit`). */
  members(chatId: string, limit: number): Promise<{ name: string; username?: string; admin?: boolean }[]>;
}
