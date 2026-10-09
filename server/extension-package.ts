import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import JSZip from 'jszip';

export const EXTENSION_SERVICE_URL = 'http://127.0.0.1:4317';
export const EXTENSION_DOWNLOAD_URL = '/api/browser-extension/download';
// Explicit release files only. Never recurse into the directory: runtime data,
// screenshots, site diagnostics, credentials and newly added files stay outside.
export const EXTENSION_PACKAGE_FILES = [
  'manifest.json', 'background.js', 'preview.html', 'preview.js', 'preview.css',
  'adapters/common.js', 'adapters/boss.js', 'adapters/capture.js', 'README.md',
  'application.html', 'application.js', 'application.css', 'application-background.js', 'adapters/bytedance-application.js',
] as const;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024;
const unavailable = () => new Error('扩展安装包暂不可用，请检查安装文件是否完整后重试。');

async function readReleaseFile(directory: string, name: typeof EXTENSION_PACKAGE_FILES[number]): Promise<Buffer> {
  try {
    const base = await realpath(directory);
    const file = resolve(directory, name);
    const stats = await lstat(file);
    const actual = await realpath(file);
    const inside = relative(base, actual);
    if (!stats.isFile() || stats.isSymbolicLink() || inside.startsWith('..') || isAbsolute(inside) || stats.size > MAX_FILE_BYTES) throw unavailable();
    const bytes = await readFile(file);
    if (bytes.length > MAX_FILE_BYTES) throw unavailable();
    return bytes;
  } catch { throw unavailable(); }
}

function releaseVersion(bytes: Buffer): string {
  try {
    const manifest = JSON.parse(bytes.toString('utf8'));
    if (manifest.manifest_version !== 3 || typeof manifest.version !== 'string' || !/^\d{1,5}(?:\.\d{1,5}){1,3}$/u.test(manifest.version)
      || JSON.stringify([...(manifest.permissions || [])].sort()) !== JSON.stringify(['activeTab', 'scripting', 'storage'])
      || JSON.stringify(manifest.host_permissions) !== JSON.stringify([`${EXTENSION_SERVICE_URL}/*`])) throw unavailable();
    return manifest.version;
  } catch { throw unavailable(); }
}

export async function extensionPackageInfo(directory: string) {
  return { extensionVersion: releaseVersion(await readReleaseFile(directory, 'manifest.json')), extensionDownloadUrl: EXTENSION_DOWNLOAD_URL, serviceUrl: EXTENSION_SERVICE_URL };
}

export async function buildExtensionPackage(directory: string) {
  const files = await Promise.all(EXTENSION_PACKAGE_FILES.map(async name => ({ name, bytes: await readReleaseFile(directory, name) })));
  const version = releaseVersion(files.find(file => file.name === 'manifest.json')!.bytes);
  if (files.reduce((size, file) => size + file.bytes.length, 0) > MAX_PACKAGE_BYTES) throw unavailable();
  const zip = new JSZip();
  for (const file of files) zip.file(`zhihang-capture/${file.name}`, file.bytes, { date: new Date('2026-01-01T00:00:00Z'), createFolders: false });
  return {
    filename: `zhihang-capture-v${version}.zip`, version,
    buffer: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } }),
  };
}
