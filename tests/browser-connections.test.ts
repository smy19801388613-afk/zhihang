import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BrowserConnections } from '../server/browser-connections.ts';

const origin = 'chrome-extension://' + 'a'.repeat(32);
const other = 'chrome-extension://' + 'b'.repeat(32);
test('pairing codes are short-lived, single-use and superseded by the latest code', () => {
  let now = Date.parse('2026-10-05T10:00:00Z');
  const auth = new BrowserConnections(':memory:', () => now);
  try {
    const old = auth.createPairingCode(); const fresh = auth.createPairingCode();
    assert.throws(() => auth.pair(old.code, origin, 'Edge'), /配对码/);
    const paired = auth.pair(fresh.code, origin, 'Edge');
    assert.equal(paired.token.length, 43);
    assert.throws(() => auth.pair(fresh.code, origin, 'Edge'), /配对码/);
    const expired = auth.createPairingCode(); now += 5 * 60_000;
    assert.throws(() => auth.pair(expired.code, origin, 'Edge'), /配对码/);
  } finally { auth.close(); }
});
test('import credential is origin-bound, revocable and expires after thirty days', () => {
  let now = Date.parse('2026-10-05T10:00:00Z');
  const auth = new BrowserConnections(':memory:', () => now);
  try {
    const pair = auth.pair(auth.createPairingCode().code, origin, 'My Edge');
    assert.equal(auth.authorize(pair.token, origin).clientName, 'My Edge');
    assert.throws(() => auth.authorize(pair.token, other), /不属于/);
    assert.throws(() => auth.authorize(pair.token, 'https://www.zhipin.com'), /未获授权/);
    assert.throws(() => auth.authorize('bad', origin), /失效/);
    auth.used(pair.connectionId); assert.ok(auth.list()[0].lastUsedAt);
    auth.revoke(pair.connectionId); assert.throws(() => auth.authorize(pair.token, origin), /失效/);
    const fresh = auth.pair(auth.createPairingCode().code, origin, 'Chrome');
    now += 30 * 86400_000;
    assert.throws(() => auth.authorize(fresh.token, origin), /失效/);
  } finally { auth.close(); }
});
test('connections survive restart, store hashes only, and list never exposes credentials', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'zhihang-capture-auth-')), 'auth.sqlite');
  let auth = new BrowserConnections(path);
  const code = auth.createPairingCode(); const pair = auth.pair(code.code, origin, 'Edge');
  auth.close(); auth = new BrowserConnections(path);
  try {
    assert.equal(auth.authorize(pair.token, origin).id, pair.connectionId);
    const publicData = JSON.stringify(auth.list());
    assert.ok(!publicData.includes(pair.token)); assert.ok(!publicData.includes('token_hash'));
    const db = new DatabaseSync(path, { readOnly: true });
    const rows = JSON.stringify([db.prepare('SELECT * FROM browser_connections').all(), db.prepare('SELECT * FROM browser_pairing_codes').all()]);
    assert.ok(!rows.includes(pair.token)); assert.ok(!rows.includes(code.code.replace('-', '')));
    db.close(); auth.revoke(pair.connectionId);
  } finally { auth.close(); }
});
