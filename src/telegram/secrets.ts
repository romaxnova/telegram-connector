/**
 * The Telegram login session (whoever holds it reads and writes as the
 * account) and the API keys entered on the admin page, encrypted in SQLite
 * with a key derived from TOKEN_ENCRYPTION_KEY.
 */
import type { Db } from '../db.js';
import { decrypt, deriveKey, encrypt } from '../crypto.js';

export class SecretStore {
  private readonly keys: Buffer[];

  constructor(
    private readonly db: Db,
    masterKeys: (Buffer | undefined)[],
  ) {
    this.keys = masterKeys.filter((k): k is Buffer => Boolean(k)).map((k) => deriveKey(k, 'telegram-secrets'));
    db.exec('CREATE TABLE IF NOT EXISTS tg_secrets (name TEXT PRIMARY KEY, value_enc TEXT NOT NULL)');
  }

  get(name: string): string | undefined {
    const row = this.db.prepare('SELECT value_enc FROM tg_secrets WHERE name = ?').get(name) as { value_enc: string } | undefined;
    if (!row) return undefined;
    try {
      return decrypt(row.value_enc, this.keys);
    } catch {
      return undefined;
    }
  }

  set(name: string, value: string): void {
    this.db.prepare('INSERT INTO tg_secrets (name, value_enc) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value_enc = excluded.value_enc').run(name, encrypt(value, this.keys[0]!));
  }

  delete(name: string): void {
    this.db.prepare('DELETE FROM tg_secrets WHERE name = ?').run(name);
  }

  /** Re-encrypts every value with the current key (after a key rotation). */
  reencrypt(): number {
    const rows = this.db.prepare('SELECT name, value_enc FROM tg_secrets').all() as { name: string; value_enc: string }[];
    for (const r of rows) this.db.prepare('UPDATE tg_secrets SET value_enc = ? WHERE name = ?').run(encrypt(decrypt(r.value_enc, this.keys), this.keys[0]!), r.name);
    return rows.length;
  }
}
