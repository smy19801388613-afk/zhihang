import { lstatSync, realpathSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

/** Delete generated files only. Never trust the evidence path saved in workspace data. */
export function removeApplicationFiles(dataDir: string, applicationId: string): void {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(applicationId)) throw new Error('申请标识无效。');
  const root = realpathSync(dataDir);
  for (const [folder, extension] of [['evidence', 'png'], ['sandbox-attachments', 'pdf']]) {
    const directory = resolve(root, folder);
    try {
      const parent = lstatSync(directory);
      if (!parent.isDirectory() || parent.isSymbolicLink() || realpathSync(directory) !== directory) throw new Error('模拟文件目录不符合预期。');
      const target = resolve(directory, `${applicationId}.${extension}`);
      const entry = lstatSync(target);
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('模拟文件不是普通文件。');
      unlinkSync(target);
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
}
