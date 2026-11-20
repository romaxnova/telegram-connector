import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import sharp from 'sharp';
import { call, testConfig, testContext } from '../../test-support.js';
import { makePdf } from '../../test-fixtures.js';
import { listChatsTool, readChatTool, searchTool, markReadTool, statusTool, groupInfoTool } from './chats.js';
import { filesToLinkTool, getFileTool, listFilesTool } from './files.js';
import { botTool, createUploadLinkTool, sendFileTool, sendMessageTool, sendVoiceTool } from './send.js';
import { createMcpServer } from '../server.js';
import { allTools } from './index.js';
import { spawnSync } from 'node:child_process';
import { toneMp3 } from '../../test-fixtures.js';
import { UploadStore } from '../../uploads.js';
import { uploadRouter } from '../../web/upload.js';
import { silentLogger } from '../../log.js';

const GROUP = '-1001111111111';
const ALICE = '222222';
const BOT = '333333';
const CHANNEL = '-1004444444444';

function seeded() {
  const ctx = testContext();
  const tg = ctx.tg;
  tg.chats = [
    { id: GROUP, name: 'Appartements Paris 🏠', kind: 'group', unread: 3, archived: false, pinned: false, lastDate: 1_763_400_300, lastPreview: 'Alice: le salon', members: 42 },
    { id: ALICE, name: 'Alice Martin', kind: 'user', username: 'alicem', phone: '+33611111111', unread: 0, archived: false, pinned: true, lastDate: 1_763_300_000 },
    { id: BOT, name: 'Price Bot', kind: 'bot', username: 'PriceBot', unread: 0, archived: false, pinned: false, lastDate: 1_763_200_000 },
    { id: CHANNEL, name: 'Old news', kind: 'channel', username: 'oldnews', unread: 0, archived: true, pinned: false, lastDate: 1_700_000_000 },
  ];
  tg.add(GROUP, { id: 10, senderName: 'Alice Martin', text: 'Nouveau T2 rue Oberkampf, 1100€' });
  tg.add(GROUP, { id: 11, senderName: 'Bob', kind: 'document', media: { filename: 'dossier-location.pdf', mimetype: 'application/pdf', size: 5000 } });
  tg.add(GROUP, { id: 12, senderName: 'Alice Martin', kind: 'photo', text: 'le salon', media: { mimetype: 'image/jpeg', size: 400_000 }, replyToId: 10 });
  tg.add(ALICE, { id: 20, senderName: 'Alice Martin', text: 'Tu as visité ?' });
  return ctx;
}

test('status and chat list: pinned first, archived hidden unless asked, kinds and usernames', async () => {
  const ctx = seeded();
  const s = JSON.parse((await call(statusTool, {}, ctx)).text) as { state: string; bots_allowed: string[] };
  assert.equal(s.state, 'open');
  assert.deepEqual(s.bots_allowed, ['@pricebot']);
  const list = JSON.parse((await call(listChatsTool, {}, ctx)).text) as { chats: { name: string; kind: string; username?: string }[] };
  assert.deepEqual(list.chats.map((c) => c.name), ['Alice Martin', 'Appartements Paris 🏠', 'Price Bot']);
  assert.equal(list.chats[2]!.username, '@PriceBot');
  const q = JSON.parse((await call(listChatsTool, { query: 'old' }, ctx)).text) as { chats: { name: string }[] };
  assert.deepEqual(q.chats.map((c) => c.name), ['Old news']);
});

test('read chat by name: transcript with replies quoted, files, ids, paging hint', async () => {
  const ctx = seeded();
  const r = await call(readChatTool, { chat: 'appartements paris' }, ctx);
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Appartements Paris 🏠 \(group, 42 members\) · chat_id -1001111111111 · 3 unread/);
  assert.match(r.text, /Bob: \[document "dossier-location\.pdf", 5 KB\] #11/);
  assert.match(r.text, /Alice Martin: \(reply to #10 "Nouveau T2 rue Oberkampf, 1100€"\) \[photo, 391 KB\] le salon #12/);
  const page = await call(readChatTool, { chat: GROUP, limit: 2 }, ctx);
  assert.match(page.text, /before 11/);
  const older = await call(readChatTool, { chat: GROUP, before: 11 }, ctx);
  assert.match(older.text, /#10/);
  assert.doesNotMatch(older.text, /#11/);
});

test('chats by @username and t.me link; ambiguous names are listed back', async () => {
  const ctx = seeded();
  assert.match((await call(readChatTool, { chat: '@alicem' }, ctx)).text, /Tu as visité/);
  assert.match((await call(readChatTool, { chat: 'https://t.me/alicem' }, ctx)).text, /Tu as visité/);
  ctx.tg.chats.push({ id: '-1009999', name: 'Appartements Lyon', kind: 'group', unread: 0, archived: false, pinned: false });
  const amb = await call(readChatTool, { chat: 'appartements' }, ctx);
  assert.equal(amb.isError, true);
  assert.match(amb.text, /Several chats match/);
  const none = await call(readChatTool, { chat: '@nobodyhere' }, ctx);
  assert.match(none.text, /no user, group, channel or bot @nobodyhere/);
});

test('search across chats names each hit\'s chat', async () => {
  const ctx = seeded();
  const r = await call(searchTool, { query: 'oberkampf' }, ctx);
  assert.match(r.text, /Appartements Paris 🏠 \(chat_id -1001111111111\) · Alice Martin: Nouveau T2/);
});

test('files: list documents, read a PDF, look at a large photo scaled down', async () => {
  const ctx = seeded();
  const files = JSON.parse((await call(listFilesTool, { chat: GROUP }, ctx)).text) as { files: { message_id: number; name: string }[] };
  assert.deepEqual(files.files.map((f) => f.message_id), [11]);
  ctx.tg.files.set(`${GROUP}/11`, makePdf([['Dossier de location', 'Revenus: 3x le loyer']]));
  const pdf = await call(getFileTool, { chat: GROUP, message_id: '#11' }, ctx);
  assert.match(pdf.text, /Revenus: 3x le loyer/);
  ctx.tg.files.set(`${GROUP}/12`, await sharp({ create: { width: 1400, height: 1000, channels: 3, noise: { type: 'gaussian' as const, mean: 128, sigma: 60 }, background: '#000' } }).jpeg({ quality: 95 }).toBuffer());
  const photo = await call(getFileTool, { chat: GROUP, message_id: 12 }, ctx);
  const image = photo.result.content.find((c) => c.type === 'image') as { data: string } | undefined;
  assert.ok(image, photo.text);
  assert.ok(Buffer.from(image.data, 'base64').length <= 96 * 1024);
  const notFile = await call(getFileTool, { chat: GROUP, message_id: 10 }, ctx);
  assert.match(notFile.text, /carries no file/);
});

test('send message: replies, blanks refused, bots redirected to telegram_bot', async () => {
  const ctx = seeded();
  const ok = await call(sendMessageTool, { chat: 'Alice Martin', text: 'Oui, samedi', reply_to: '#20' }, ctx);
  assert.equal(ok.isError, false, ok.text);
  assert.deepEqual(ctx.tg.sent[0], { chatId: ALICE, text: 'Oui, samedi', replyTo: 20 });
  assert.equal((await call(sendMessageTool, { chat: ALICE, text: 'Appelle [téléphone]' }, ctx)).isError, true);
  const bot = await call(sendMessageTool, { chat: '@PriceBot', text: '/start' }, ctx);
  assert.match(bot.text, /use telegram_bot/);
});

test('mark read', async () => {
  const ctx = seeded();
  await call(markReadTool, { chat: GROUP }, ctx);
  assert.deepEqual(ctx.tg.read, [GROUP]);
});

test('group info lists members; a person is not a group', async () => {
  const ctx = seeded();
  const g = JSON.parse((await call(groupInfoTool, { chat: GROUP }, ctx)).text) as { members: { name: string; admin?: boolean }[] };
  assert.equal(g.members[0]!.admin, true);
  assert.equal((await call(groupInfoTool, { chat: ALICE }, ctx)).isError, true);
});

test('bot bridge: only allowlisted bots; sends, waits for the answer, presses buttons', async () => {
  const ctx = seeded();
  ctx.tg.botScript = (chatId, input) => {
    if (input.text === '/price btc') ctx.tg.add(chatId, { senderName: 'Price Bot', text: 'BTC: 61 234 €', buttons: [['Refresh', 'ETH']] });
    if (input.press === 'ETH') ctx.tg.add(chatId, { senderName: 'Price Bot', text: 'ETH: 2 345 €' });
  };
  const r = await call(botTool, { bot: '@PriceBot', text: '/price btc', wait_seconds: 3 }, ctx);
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /BTC: 61 234 € \{buttons: Refresh \| ETH\}/);
  const msgId = /#(\d+)/.exec(r.text.split('BTC')[1]!)![1]!;
  const p = await call(botTool, { bot: 'PriceBot', press: { message_id: msgId, button: 'ETH' }, wait_seconds: 3 }, ctx);
  assert.match(p.text, /ETH: 2 345 €/);
  assert.equal(ctx.tg.pressed[0]!.messageId, Number(msgId));

  ctx.tg.chats.push({ id: '555', name: 'Other Bot', kind: 'bot', username: 'OtherBot', unread: 0, archived: false, pinned: false });
  const refused = await call(botTool, { bot: '@OtherBot', text: '/start' }, ctx);
  assert.equal(refused.isError, true);
  assert.match(refused.text, /not one of the bots/);
  assert.equal((await call(botTool, { bot: '@alicem', text: 'hi' }, ctx)).isError, true);
});

async function peer() {
  const uploads = new UploadStore();
  const app = express();
  app.use('/upload', uploadRouter(uploads, silentLogger));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as AddressInfo).port;
  return { uploads, host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, close: () => server.close() };
}

test('files to link: Telegram files land in another connector as upload_ids; foreign hosts refused', async () => {
  const p = await peer();
  try {
    const ctx = seeded();
    ctx.config = testConfig({ PEER_UPLOAD_HOSTS: p.host });
    const pdf = makePdf([['Bail']]);
    ctx.tg.files.set(`${GROUP}/11`, pdf);
    const link = p.uploads.createLink();
    const out = JSON.parse((await call(filesToLinkTool, { upload_url: `${p.origin}/upload/${link.token}`, chat: GROUP, message_ids: [11, 10] }, ctx)).text) as { sent: number; files: { upload_id?: string; error?: string }[] };
    assert.equal(out.sent, 1);
    assert.match(out.files[1]!.error!, /carries no file/);
    const staged = p.uploads.get(out.files[0]!.upload_id!)!;
    assert.equal(staged.filename, 'dossier-location.pdf');
    assert.deepEqual(staged.data, pdf);
    const evil = await call(filesToLinkTool, { upload_url: 'https://evil.example/upload/AAAAAAAAAAAAAAAAAAAAAAAA', chat: GROUP, message_ids: [11] }, ctx);
    assert.match(evil.text, /not one of the connectors/);
  } finally {
    p.close();
  }
});

test('upload link then send file', async () => {
  const ctx = seeded();
  const link = JSON.parse((await call(createUploadLinkTool, {}, ctx)).text) as { upload_url: string; link_id: string };
  ctx.uploads.consumeLinkFiles(link.upload_url.split('/upload/')[1]!, [{ data: makePdf([['Quittance']]), filename: 'quittance.pdf', mimeType: 'application/pdf' }]);
  const r = await call(sendFileTool, { chat: 'Alice Martin', upload_ids: [link.link_id], caption: 'La quittance' }, ctx);
  assert.equal(r.isError, false, r.text);
  assert.equal(ctx.tg.sent[0]!.file?.filename, 'quittance.pdf');
  assert.equal(ctx.tg.sent[0]!.file?.caption, 'La quittance');
});

test('not logged in: tools say so', async () => {
  const ctx = seeded();
  ctx.tg.state = { state: 'logged_out' };
  const s = JSON.parse((await call(statusTool, {}, ctx)).text) as { note: string };
  assert.match(s.note, /logs in on https:\/\/tg\.test\/admin/);
});

test('voice: offered only when ElevenLabs is set up; sends a voice note with a packed waveform, as a reply', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 && 'ffmpeg not installed' }, async () => {
  const listed = (c: ReturnType<typeof seeded>) => Object.keys((createMcpServer(c, allTools) as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
  assert.ok(!listed(seeded()).includes('telegram_send_voice'));
  const ctx = seeded();
  ctx.config = testConfig({ ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE_ID: 'abcdefgh12', VOICE_MAX_CHARS: '40' });
  ctx.fetchImpl = (async () => new Response(toneMp3(), { status: 200 })) as typeof fetch;
  assert.ok(listed(ctx).includes('telegram_send_voice'));
  const r = await call(sendVoiceTool, { chat: 'Alice Martin', text: 'Oui, samedi ça marche', reply_to: 20 }, ctx);
  assert.equal(r.isError, false, r.text);
  const sent = ctx.tg.sent[0]!;
  assert.equal(sent.chatId, ALICE);
  assert.equal(sent.replyTo, 20);
  assert.equal(sent.voice!.ogg.subarray(0, 4).toString(), 'OggS');
  assert.equal(sent.voice!.seconds, 2);
  assert.equal(sent.voice!.waveform.length, 63); // 100 levels × 5 bits
  assert.match((await call(sendVoiceTool, { chat: ALICE, text: 'x'.repeat(41) }, ctx)).text, /limited to 40/);
  assert.equal((await call(sendVoiceTool, { chat: '@PriceBot', text: 'hi' }, ctx)).isError, true);
});
