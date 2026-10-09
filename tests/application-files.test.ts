import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { removeApplicationFiles } from '../server/application-files.ts';

test('application cleanup removes only exact generated files and tolerates repeat cleanup', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'zhihang-remove-files-'));
  for (const folder of ['evidence', 'sandbox-attachments']) mkdirSync(resolve(root, folder));
  const own = [resolve(root, 'evidence', 'synthetic-app.png'), resolve(root, 'sandbox-attachments', 'synthetic-app.pdf')];
  const other = [resolve(root, 'evidence', 'other.png'), resolve(root, 'sandbox-attachments', 'other.pdf')];
  for (const file of [...own, ...other]) writeFileSync(file, 'synthetic');
  removeApplicationFiles(root, 'synthetic-app');
  assert.ok(own.every(file => !existsSync(file))); assert.ok(other.every(existsSync));
  assert.doesNotThrow(() => removeApplicationFiles(root, 'synthetic-app'));
  assert.throws(() => removeApplicationFiles(root, '../other'), /标识/);
});

test('application cleanup refuses junction folders instead of touching external files', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'zhihang-remove-junction-'));
  const external = mkdtempSync(resolve(tmpdir(), 'zhihang-keep-files-'));
  writeFileSync(resolve(external, 'synthetic-app.png'), 'keep');
  symlinkSync(external, resolve(root, 'evidence'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => removeApplicationFiles(root, 'synthetic-app'), /目录/);
  assert.ok(existsSync(resolve(external, 'synthetic-app.png')));
});
