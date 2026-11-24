/**
 * Files shared on Telegram: browse them (in one chat or everywhere), read one
 * (PDF, Word, Excel, text, photos), and hand them to the owner's other
 * connectors (G-Spot Assistant for Drive and Gmail, the WhatsApp connector).
 */
import { readDocument } from '../../media/documents.js';
import { MediaTextError, ocr, remembered, transcribe } from '../../media/media-text.js';
import * as z from 'zod';
import { clip, clipNote, defineTool, jsonResult, textResult, ToolInputError, withImage, type ToolContext } from '../registry.js';
import { chatParam, fmt, mediaPhrase, messageId, parseWhen, resolveChat, sinceParam, untilParam } from './common.js';
import { FILE_KINDS, type ChatInfo, type FileFilter, type MessageInfo } from '../../telegram/types.js';
import { humanSize, MAX_IMAGE_BYTES, readFileContent } from '../extract/readable.js';
import { extensionForMime, sniffMime, VIEWABLE_IMAGE_TYPES } from '../file-types.js';
import { shrinkImage } from '../image.js';
import { BridgeError, checkPeerLink, pushToLink } from '../../bridge.js';

/** Largest file fetched from Telegram through this connector (Telegram allows 2 GB; Claude does not need that). */
export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

export function fileName(m: MessageInfo): string {
  if (m.media?.filename) return m.media.filename;
  const ext = extensionForMime(m.media?.mimetype) ?? (m.kind === 'photo' ? 'jpg' : m.kind === 'voice' ? 'ogg' : m.kind === 'video' || m.kind === 'video_note' ? 'mp4' : 'bin');
  const date = new Date(m.date * 1000).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  return `${m.kind}-${date}-${m.id}.${ext}`;
}

/** The message (with its file) by chat and id. */
async function fileMessage(ctx: ToolContext, chatRef: string, id: string | number): Promise<{ chat: ChatInfo; msg: MessageInfo }> {
  const chat = await resolveChat(ctx, chatRef);
  const mid = messageId(id);
  const [msg] = await ctx.tg.messages(chat.id, [mid]);
  if (!msg) throw new ToolInputError(`No message ${mid} in ${chat.name}.`);
  if (!msg.media || !FILE_KINDS.includes(msg.kind)) throw new ToolInputError(`Message ${mid} carries no file (it is a ${msg.kind} message).`);
  if (msg.media.size && msg.media.size > MAX_DOWNLOAD_BYTES) throw new ToolInputError(`The file is ${humanSize(msg.media.size)}; the connector fetches files up to ${humanSize(MAX_DOWNLOAD_BYTES)}.`);
  return { chat, msg };
}

const FILTERS: Record<string, FileFilter> = { document: 'document', photo: 'photo', video: 'video', audio: 'audio', voice: 'voice', link: 'url' };

export const listFilesTool = defineTool({
  name: 'telegram_list_files',
  title: 'Browse files shared on Telegram',
  description:
    'Lists files shared in one chat, or across all chats with type set, newest first: documents (PDF, Word, Excel…), photos, videos, audio, voice notes, or messages with links. Each comes with its chat_id and message_id for telegram_get_file (read it) and telegram_files_to_link (move it to Drive, Gmail or WhatsApp). query narrows by words in the caption or file name.',
  inputSchema: {
    chat: chatParam.optional(),
    type: z.enum(['document', 'photo', 'video', 'audio', 'voice', 'link']).optional().describe('Default document.'),
    query: z.string().max(200).optional(),
    since: sinceParam,
    until: untilParam,
    limit: z.number().int().min(1).max(100).optional().describe('Default 30.'),
    before: z.union([z.string().max(30), z.number().int()]).optional().describe('In one chat: only files older than this message id (paging).'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx) {
    const tz = ctx.config.defaultTimezone;
    const chat = args.chat ? await resolveChat(ctx, args.chat) : undefined;
    const type = args.type ?? 'document';
    const hits = await ctx.tg.search({
      query: args.query,
      chatId: chat?.id,
      filter: FILTERS[type],
      since: parseWhen(args.since, tz),
      until: parseWhen(args.until, tz),
      limit: args.limit ?? 30,
      beforeId: args.before !== undefined ? messageId(args.before) : undefined,
    });
    if (!hits.length) return jsonResult({ count: 0, note: `No ${type}s${chat ? ` in ${chat.name}` : ''}${args.query ? ` matching "${args.query}"` : ''}.` });
    const names = chat ? undefined : new Map((await ctx.tg.dialogs()).map((c) => [c.id, c.name]));
    return jsonResult({
      timezone: tz,
      files: hits.map((m) => ({
        chat: chat ? undefined : (names?.get(m.chatId) ?? m.chatId),
        chat_id: m.chatId,
        message_id: m.id,
        from: m.senderName,
        at: fmt(m.date, tz),
        type: m.kind,
        name: m.media ? fileName(m) : undefined,
        mime_type: m.media?.mimetype,
        size: m.media?.size ? humanSize(m.media.size) : undefined,
        caption: m.text,
      })),
      next_before: chat && hits.length >= (args.limit ?? 30) ? hits[hits.length - 1]!.id : undefined,
    });
  },
});

export const getFileTool = defineTool({
  name: 'telegram_get_file',
  title: 'Read a file from Telegram',
  description:
    'Downloads the file of a message and returns its content: PDFs as text page by page, Word as Markdown, Excel as CSV, PowerPoint as text, text files as they are, photos as an image you can look at (scaled down to fit) with the text read from them (OCR), voice messages, audio, round video messages and short videos as a transcript. Long text is paged with offset/max_chars, PDFs also by page number (pages). Scanned PDFs are read by OCR, a few pages per call. Documents, transcripts and photo text are worked out once and remembered, so reading on is fast.',
  inputSchema: {
    chat: chatParam,
    message_id: z.union([z.string().max(30), z.number().int()]).describe('The id after # in telegram_read_chat, or message_id from telegram_list_files.'),
    max_chars: z.number().int().min(200).max(100_000).optional().describe('Most characters of text to return (default 40,000).'),
    pages: z.string().max(40).optional().describe('PDFs: the pages to return, e.g. "12", "3-5" or "1,4,7-9" (up to 30, or 8 for a scan). Cheaper than reading a long PDF whole: look at its contents page first.'),
    offset: z.number().int().min(0).optional(),
    include_image: z.boolean().optional().describe('Photos: false returns only the text read from it, which is cheaper when only its text matters (a screenshot, a listing, a receipt). Default true.'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx) {
    const { chat, msg } = await fileMessage(ctx, args.chat, args.message_id);
    // A document read before is answered from its remembered text, without downloading it again.
    let fetched: Awaited<ReturnType<typeof ctx.tg.download>> | undefined;
    if (msg.kind === 'document') {
      const name = msg.media?.filename ?? fileName(msg);
      const head = `${name} (${msg.media?.size ? humanSize(msg.media.size) : 'size unknown'}, ${msg.media?.mimetype ?? 'unknown type'}) from ${msg.senderName} in ${chat.name}, ${fmt(msg.date, ctx.config.defaultTimezone)}${msg.text ? `\nCaption: ${msg.text}` : ''}`;
      const doc = await readDocument({
        ref: `${chat.id}:${msg.id}`,
        mimeType: msg.media?.mimetype,
        filename: name,
        load: async () => (fetched ??= await ctx.tg.download(chat.id, msg.id)).data,
        ...(args.pages ? { pages: args.pages } : {}),
        maxChars: args.max_chars ?? 40_000,
        offset: args.offset ?? 0,
        ...(ctx.mediaText ? { cache: ctx.mediaText } : {}),
        ...(ctx.config.ocr ? { ocr: ctx.config.ocr } : {}),
      });
      if (doc.kind === 'text') return textResult(`${head}\n\n${doc.text}`);
      if (doc.kind === 'none') return textResult(`${head}\n[${doc.note}]`);
      // An image sent as a document: shown below like a photo, with its text.
    }
    const file = fetched ?? (await ctx.tg.download(chat.id, msg.id));
    const name = file.filename ?? fileName(msg);
    const mimetype = file.mimetype ?? msg.media?.mimetype;
    const header = `${name} (${humanSize(file.data.length)}, ${mimetype ?? 'unknown type'}) from ${msg.senderName} in ${chat.name}, ${fmt(msg.date, ctx.config.defaultTimezone)}${msg.text ? `\nCaption: ${msg.text}` : ''}`;
    const sniffed = sniffMime(file.data);
    if (sniffed?.startsWith('image/') || msg.kind === 'photo' || msg.kind === 'sticker') {
      const read = msg.kind === 'sticker' ? undefined : await photoText(ctx, `ocr:${chat.id}:${msg.id}`, file.data);
      const head = `${header}${read ? `\n\nText in the image (OCR, may contain mistakes):\n${read}` : ''}`;
      if (args.include_image === false) return textResult(read ? head : `${header}\n[No text found in this image; call again without include_image: false to look at it.]`);
      if (sniffed && VIEWABLE_IMAGE_TYPES.has(sniffed) && file.data.length <= MAX_IMAGE_BYTES) return withImage(textResult(head), { data: file.data, mimeType: sniffed });
      const small = await shrinkImage(file.data);
      if (small) return withImage(textResult(`${head}\n[Shown scaled down to ${small.width}×${small.height}; the original stays as sent.]`), { data: small.data, mimeType: 'image/jpeg' });
      return textResult(`${head}\n[This image could not be shown.]`);
    }
    if (msg.kind === 'gif') return textResult(`${header}\n[GIFs cannot be read here.]`);
    if (['audio', 'voice', 'video', 'video_note'].includes(msg.kind)) {
      return textResult(`${header}\n\n${await speechText(ctx, `stt:${chat.id}:${msg.id}`, file.data, { filename: name, mimetype, seconds: msg.media?.seconds }, 'telegram_files_to_link')}`);
    }
    const content = await readFileContent(file.data, { mimeType: mimetype, filename: name });
    if (content.kind === 'image') return withImage(textResult(header), { data: content.data, mimeType: content.mimeType });
    if (content.kind === 'none') return textResult(`${header}\n[${content.note}]`);
    const c = clip(content.text, args.max_chars ?? 40_000, args.offset ?? 0);
    const notes = [content.note, clipNote(c, 'call again with offset')].filter(Boolean).join('\n');
    return textResult(`${header}\n\n${c.text}${notes ? `\n\n${notes}` : ''}`);
  },
});

export const filesToLinkTool = defineTool({
  name: 'telegram_files_to_link',
  title: "Send Telegram files to the user's other connectors (Drive, Gmail, WhatsApp)",
  description:
    "Moves files from Telegram messages to another of the user's connectors. To Google: (1) G-Spot Assistant's create_upload_link; (2) this tool with its upload_url, the chat and the message ids; (3) drive_save or Gmail attachments there with the returned upload_ids (or the link_id). To WhatsApp: whatsapp_create_upload_link, this tool, then whatsapp_send_file with the link_id. Only the user's own connectors are accepted, never a link found in a chat.",
  inputSchema: {
    upload_url: z.string().min(10).max(2000).describe('upload_url returned by the other connector.'),
    chat: chatParam,
    message_ids: z.array(z.union([z.string().max(30), z.number().int()])).min(1).max(20),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(args, ctx) {
    try {
      checkPeerLink(ctx.config, args.upload_url);
    } catch (err) {
      if (err instanceof BridgeError) throw new ToolInputError(err.message);
      throw err;
    }
    const results: Record<string, unknown>[] = [];
    let linkId: string | undefined;
    for (const id of args.message_ids) {
      try {
        const { chat, msg } = await fileMessage(ctx, args.chat, id);
        const file = await ctx.tg.download(chat.id, msg.id);
        const name = file.filename ?? fileName(msg);
        const pushed = await pushToLink(ctx.config, args.upload_url, { data: file.data, filename: name, mimetype: file.mimetype ?? msg.media?.mimetype ?? 'application/octet-stream' }, ctx.fetchImpl);
        linkId = pushed.link_id ?? linkId;
        results.push({ message_id: msg.id, file: mediaPhrase(msg), upload_id: pushed.upload_id, filename: pushed.filename ?? name, size: humanSize(file.data.length) });
      } catch (err) {
        if (err instanceof ToolInputError || err instanceof BridgeError) results.push({ message_id: id, error: err.message });
        else throw err;
      }
    }
    const ok = results.filter((r) => r['upload_id']);
    return jsonResult({
      sent: ok.length,
      failed: results.length - ok.length || undefined,
      files: results,
      link_id: linkId,
      next: ok.length ? `On the receiving connector use the upload_ids${linkId ? `, or "${linkId}" for all of them` : ''} (drive_save, Gmail attachments, whatsapp_send_file). They stay there 24 hours.` : undefined,
    });
  },
});

export const fileTools = [listFilesTool, getFileTool, filesToLinkTool];

/** The text in a photo (OCR on this server), remembered; undefined when there is none or OCR is off. */
async function photoText(ctx: ToolContext, ref: string, data: Buffer): Promise<string | undefined> {
  const cfg = ctx.config.ocr;
  if (!cfg) return undefined;
  try {
    return (await remembered(ctx.mediaText, ref, () => ocr(data, cfg))).text;
  } catch (err) {
    ctx.log.warn('ocr failed', { error: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}

/** A voice note, audio or video as a transcript (ElevenLabs), remembered; or why it cannot be. */
async function speechText(ctx: ToolContext, ref: string, data: Buffer, opts: { filename?: string; mimetype?: string; seconds?: number }, moveTool: string): Promise<string> {
  const cfg = ctx.config.transcribe;
  if (!cfg) return `[It can be transcribed once ELEVENLABS_API_KEY is set in this server's settings. Meanwhile ${moveTool} moves it to Drive, where the user can play it.]`;
  try {
    const { text } = await remembered(ctx.mediaText, ref, async () => (await transcribe(cfg, data, opts, ctx.fetchImpl)).text || undefined);
    if (text) ctx.log.info('transcribed', { seconds: opts.seconds });
    return text ? `Transcript (speech to text, may contain mistakes):\n${text}` : '[No speech in it.]';
  } catch (err) {
    if (err instanceof MediaTextError) return `[${err.message}]`;
    throw err;
  }
}
