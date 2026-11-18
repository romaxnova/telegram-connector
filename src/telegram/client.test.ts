import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Api } from 'telegram';
import bigInt from 'big-integer';
import { explain, internationalNumber, TelegramService } from './client.js';
import { SecretStore } from './secrets.js';
import { openDatabase } from '../db.js';
import { silentLogger } from '../log.js';
import { TEST_KEY } from '../test-support.js';

function service() {
  const db = openDatabase(':memory:');
  return { db, secrets: new SecretStore(db, [TEST_KEY]), svc: new TelegramService(new SecretStore(db, [TEST_KEY]), silentLogger, undefined) };
}

test('GramJS messages become plain messages: documents, replies, buttons, edits, service lines', () => {
  const { svc } = service();
  const doc = new Api.Message({
    id: 7,
    peerId: new Api.PeerChannel({ channelId: bigInt(111) }),
    date: 1_763_400_000,
    message: 'le bail signé',
    replyTo: new Api.MessageReplyHeader({ replyToMsgId: 5 }),
    editDate: 1_763_400_100,
    media: new Api.MessageMediaDocument({
      document: new Api.Document({
        id: bigInt(1),
        accessHash: bigInt(2),
        fileReference: Buffer.alloc(0),
        date: 1_763_400_000,
        mimeType: 'application/pdf',
        size: bigInt(230_000),
        dcId: 4,
        attributes: [new Api.DocumentAttributeFilename({ fileName: 'bail.pdf' })],
      }),
    }),
    replyMarkup: new Api.ReplyInlineMarkup({ rows: [new Api.KeyboardButtonRow({ buttons: [new Api.KeyboardButtonCallback({ text: 'OK', data: Buffer.from('ok') })] })] }),
  });
  const m = svc.toMessage(doc, '-100111');
  assert.equal(m.kind, 'document');
  assert.equal(m.text, 'le bail signé');
  assert.deepEqual(m.media, { filename: 'bail.pdf', mimetype: 'application/pdf', size: 230_000, seconds: undefined });
  assert.equal(m.replyToId, 5);
  assert.equal(m.edited, true);
  assert.deepEqual(m.buttons, [['OK']]);

  const service_ = new Api.MessageService({ id: 8, peerId: new Api.PeerChat({ chatId: bigInt(9) }), date: 1, action: new Api.MessageActionChatEditTitle({ title: 'Appart' }) });
  assert.equal(svc.toMessage(service_, '-9').text, 'Renamed to "Appart"');
  const noise = new Api.MessageService({ id: 9, peerId: new Api.PeerChat({ chatId: bigInt(9) }), date: 1, action: new Api.MessageActionHistoryClear() });
  assert.equal(svc.toMessage(noise, '-9').text, undefined);
});

test('login steps: API keys validated and kept encrypted; phone numbers must be international', () => {
  const { db, svc } = service();
  assert.equal(svc.apiKeys(), undefined);
  assert.throws(() => svc.setApiKeys('abc', '0123456789abcdef0123456789abcdef'), /api_id is a number/);
  assert.throws(() => svc.setApiKeys('123456', 'nothex'), /api_hash/);
  svc.setApiKeys('123456', '0123456789abcdef0123456789abcdef');
  assert.deepEqual(svc.apiKeys(), { apiId: 123456, apiHash: '0123456789abcdef0123456789abcdef' });
  const raw = db.prepare("SELECT value_enc FROM tg_secrets WHERE name = 'api_hash'").get() as { value_enc: string };
  assert.ok(!raw.value_enc.includes('0123456789abcdef'));
  assert.equal(internationalNumber('+33 6 12 34 56 78'), '+33612345678');
  assert.equal(internationalNumber('0033 (0)6 12 34 56 78'), '+33612345678');
  assert.throws(() => internationalNumber('06 12 34 56 78'), /country code/);
});

test('Telegram errors in words', () => {
  assert.match(explain({ errorMessage: 'PHONE_CODE_INVALID' }), /code is wrong/);
  assert.match(explain({ errorMessage: 'FLOOD_WAIT_42' }), /wait 42 seconds/);
  assert.match(explain({ errorMessage: 'PASSWORD_HASH_INVALID' }), /cloud password/);
});
