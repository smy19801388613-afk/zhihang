import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const CODE_LIFETIME = 5 * 60_000;
const TOKEN_LIFETIME = 30 * 86400_000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export class ConnectionError extends Error {
  constructor(message: string, public status = 401) { super(message); }
}
export interface BrowserConnection {
  id: string; clientName: string; origin: string; createdAt: string;
  lastUsedAt: string | null; expiresAt: string; revokedAt: string | null;
}
/** Import-only credentials are independent from workspace revisions and model settings. */
export class BrowserConnections {
  private db: DatabaseSync;
  constructor(path: string, private now = () => Date.now()) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS browser_pairing_codes (hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL, used_at TEXT);
      CREATE TABLE IF NOT EXISTS browser_connections (
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, origin TEXT NOT NULL, client_name TEXT NOT NULL,
        created_at TEXT NOT NULL, last_used_at TEXT, expires_at TEXT NOT NULL, revoked_at TEXT
      );`);
  }
  createPairingCode() {
    const raw = randomBytes(6).toString('hex').toUpperCase();
    const expiresAt = new Date(this.now() + CODE_LIFETIME).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Only the newest displayed code can pair; previously issued codes cannot linger.
      this.db.prepare('DELETE FROM browser_pairing_codes').run();
      this.db.prepare('INSERT INTO browser_pairing_codes (hash, expires_at) VALUES (?, ?)').run(digest(raw), expiresAt);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { code: `${raw.slice(0, 6)}-${raw.slice(6)}`, expiresAt };
  }
  pair(code: string, origin: string, clientName: string) {
    if (!EXTENSION_ORIGIN.test(origin)) throw new ConnectionError('扩展来源未获授权。', 403);
    const normalized = code.replace(/[-\s]/g, '').toUpperCase();
    if (!/^[A-F0-9]{12}$/.test(normalized)) throw new ConnectionError('配对码无效、已使用或已过期。');
    const at = new Date(this.now()).toISOString();
    const token = randomBytes(32).toString('base64url');
    const id = randomUUID(); const expiresAt = new Date(this.now() + TOKEN_LIFETIME).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare('UPDATE browser_pairing_codes SET used_at=? WHERE hash=? AND used_at IS NULL AND expires_at>?').run(at, digest(normalized), at);
      if (result.changes !== 1) throw new ConnectionError('配对码无效、已使用或已过期。');
      this.db.prepare('INSERT INTO browser_connections (id,token_hash,origin,client_name,created_at,expires_at) VALUES (?,?,?,?,?,?)')
        .run(id, digest(token), origin, clientName, at, expiresAt);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { token, connectionId: id, expiresAt };
  }
  authorize(token: string, origin: string): BrowserConnection {
    if (!EXTENSION_ORIGIN.test(origin)) throw new ConnectionError('扩展来源未获授权。', 403);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ConnectionError('扩展未连接或凭证已失效，请重新配对。');
    const row = this.db.prepare(`SELECT id,origin,client_name AS clientName,created_at AS createdAt,last_used_at AS lastUsedAt,expires_at AS expiresAt,revoked_at AS revokedAt
      FROM browser_connections WHERE token_hash=?`).get(digest(token)) as unknown as BrowserConnection | undefined;
    if (!row || row.revokedAt || Date.parse(row.expiresAt) <= this.now()) throw new ConnectionError('扩展未连接或凭证已失效，请重新配对。');
    if (row.origin !== origin) throw new ConnectionError('此凭证不属于当前扩展来源。', 403);
    return row;
  }
  used(id: string) { this.db.prepare('UPDATE browser_connections SET last_used_at=? WHERE id=? AND revoked_at IS NULL').run(new Date(this.now()).toISOString(), id); }
  list(): BrowserConnection[] {
    return this.db.prepare(`SELECT id,origin,client_name AS clientName,created_at AS createdAt,last_used_at AS lastUsedAt,expires_at AS expiresAt,revoked_at AS revokedAt
      FROM browser_connections ORDER BY created_at DESC LIMIT 100`).all() as unknown as BrowserConnection[];
  }
  revoke(id: string) {
    const result = this.db.prepare('UPDATE browser_connections SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').run(new Date(this.now()).toISOString(), id);
    if (!result.changes) throw new ConnectionError('未找到该扩展连接。', 404);
  }
  close() { this.db.close(); }
}
