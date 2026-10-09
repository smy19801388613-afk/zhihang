import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// This utility never opens the mutating Store constructor or prints workspace contents.
const mode = process.argv[2];
assert.ok(mode === 'backup' || mode === 'verify', 'Use backup or verify');
const version = process.argv[3] || JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version;
assert.match(version, /^\d+\.\d+\.\d+$/, 'Use a semantic release version');
const data = resolve('data');
const reportPath = resolve('test-results', `upgrade-${version}.json`);
mkdirSync(resolve('test-results'), { recursive: true });
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const db = new DatabaseSync(resolve(data, 'zhihang.sqlite'), { readOnly: true });
const raw = (db.prepare('SELECT data FROM workspace WHERE id=1').get() as { data: string }).data;
const state = JSON.parse(raw);
const configPath = resolve(data, 'model-settings.json');
const protectedFields = ['profile', 'job', 'resumes', 'applications', 'exploration', 'companyJobs', 'companyResearch', 'browserCaptures', 'resumeImport', 'interview', 'factPreview', 'factOrganization', 'resumeDesign'];
const tables = ['sandbox_tokens', 'sandbox_receipts', 'browser_pairing_codes', 'browser_connections', 'real_application_runs'];
const snapshot = {
  revision: state.revision,
  workspaceHash: hash(raw),
  fields: Object.fromEntries(protectedFields.map(key => [key, hash(JSON.stringify(state[key] ?? null))])),
  modelSettingsHash: existsSync(configPath) ? hash(readFileSync(configPath)) : null,
  auxiliaryTableHashes: Object.fromEntries(tables.map(table => [table, hash(JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) ? db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all() : []))])),
};
try {
  if (mode === 'backup') {
    const folder = resolve(data, 'backups', `v${version}-${Date.now()}`);
    mkdirSync(folder, { recursive: true });
    await backup(db, resolve(folder, 'zhihang.sqlite'));
    if (existsSync(configPath)) copyFileSync(configPath, resolve(folder, 'model-settings.json'));
    writeFileSync(reportPath, JSON.stringify({ backedUpAt: new Date().toISOString(), folder, before: snapshot }, null, 2));
    console.log(JSON.stringify({ result: 'BACKED_UP', folder, revision: state.revision }));
  } else {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.deepEqual(snapshot, report.before, 'Saved workspace and model configuration must remain unchanged across deployment');
    writeFileSync(reportPath, JSON.stringify({ ...report, verifiedAt: new Date().toISOString(), result: 'PASS', after: snapshot }, null, 2));
    console.log(JSON.stringify({ result: 'PASS', unchanged: protectedFields, modelSettingsUnchanged: true, revision: state.revision }));
  }
} finally { db.close(); }
