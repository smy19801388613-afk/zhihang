import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, lstat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import JSZip from 'jszip';
import { EXTENSION_PACKAGE_FILES, buildExtensionPackage } from '../server/extension-package.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert.equal(process.platform, 'win32', 'Build the Windows release on Windows');
assert.equal(process.arch, 'x64', 'This release targets Windows x64');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const output = join(root, 'releases');
await mkdir(output, { recursive: true });
const stageParent = await mkdtemp(join(output, '.build-'));
const folderName = `zhihang-${manifest.version}-windows-x64`;
const stage = join(stageParent, folderName);
await mkdir(stage);
const copied: string[] = [];
async function copy(source: string, name: string) {
  const target = join(stage, name);
  assert.ok(relative(stage, target) && !relative(stage, target).startsWith('..'));
  const info = await lstat(source);
  assert.ok(info.isFile() && !info.isSymbolicLink(), 'Only ordinary release files can be copied');
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target); copied.push(name.replaceAll('\\', '/'));
}
async function files(directory: string, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), 'Release cannot contain a symlink or junction');
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await files(join(directory, entry.name), name));
    else if (entry.isFile()) result.push(name);
  }
  return result;
}
// Only source required by the runtime and the already-built browser application.
for (const directory of ['server', 'shared', 'dist']) {
  const paths = await files(join(root, directory));
  for (const name of paths) {
    if (directory !== 'dist' && !name.endsWith('.ts')) continue;
    await copy(join(root, directory, name), `${directory}/${name}`);
  }
}
for (const name of ['package.json', 'package-lock.json', 'THIRD_PARTY_NOTICES.txt', '启动职航.cmd', '停止职航.cmd']) await copy(join(root, name), name);
for (const name of ['start.ps1', 'stop.ps1', 'jobspy-bridge.py', 'setup-jobspy.ps1', 'requirements-jobspy.txt']) await copy(join(root, 'scripts', name), `scripts/${name}`);
for (const name of EXTENSION_PACKAGE_FILES) await copy(join(root, 'extensions', 'zhihang-capture', name), `extensions/zhihang-capture/${name}`);
const extension = await buildExtensionPackage(join(stage, 'extensions', 'zhihang-capture'));
await writeFile(join(stage, extension.filename), extension.buffer);
await writeFile(join(output, extension.filename), extension.buffer);

// Verify the installed runtime against the exact official release before reuse.
const nodeVersion = process.version;
async function publicText(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'error' });
  assert.ok(response.ok, `Release resource unavailable: HTTP ${response.status}`);
  return response.text();
}
const checksums = await publicText(`https://nodejs.org/dist/${nodeVersion}/SHASUMS256.txt`);
const expectedHash = checksums.split(/\r?\n/u).find(line => /\swin-x64\/node\.exe$/u.test(line))?.split(/\s+/u)[0];
assert.match(expectedHash || '', /^[a-f0-9]{64}$/u, 'Official runtime checksum missing');
const nodeHash = createHash('sha256').update(await readFile(process.execPath)).digest('hex');
assert.equal(nodeHash, expectedHash, 'Installed runtime differs from the official binary; do not distribute it');
const runtimeZipName = `node-${nodeVersion}-win-x64.zip`;
const runtimeZipHash = checksums.split(/\r?\n/u).find(line => line.endsWith(`  ${runtimeZipName}`))?.split(/\s+/u)[0];
assert.match(runtimeZipHash || '', /^[a-f0-9]{64}$/u, 'Official runtime ZIP checksum missing');
const cache = join(output, '.runtime-cache');
await mkdir(cache, { recursive: true });
const runtimeZipPath = join(cache, runtimeZipName);
let runtimeZip: Buffer;
try { runtimeZip = await readFile(runtimeZipPath); }
catch {
  const response = await fetch(`https://nodejs.org/dist/${nodeVersion}/${runtimeZipName}`, { signal: AbortSignal.timeout(120000), redirect: 'error' });
  assert.ok(response.ok, `Runtime distribution unavailable: HTTP ${response.status}`);
  runtimeZip = Buffer.from(await response.arrayBuffer());
}
assert.equal(createHash('sha256').update(runtimeZip).digest('hex'), runtimeZipHash, 'Runtime distribution checksum mismatch');
await writeFile(runtimeZipPath, runtimeZip);
const officialRuntime = await JSZip.loadAsync(runtimeZip);
const license = await officialRuntime.file(`node-${nodeVersion}-win-x64/LICENSE`)?.async('string') || '';
assert.ok(license.includes('Node.js') && license.length > 10000, 'Complete runtime license required');
await copy(process.execPath, 'runtime/node.exe');
await writeFile(join(stage, 'runtime', 'LICENSE'), license);
await writeFile(join(stage, 'runtime', 'SHASUMS256.txt'), checksums);

// Install a fresh production dependency tree, never copy a developer's data/cache.
const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
await new Promise<void>((done, reject) => {
  const child = spawn(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stage, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' } });
  let diagnostic = '';
  child.stdout.on('data', chunk => { diagnostic = (diagnostic + String(chunk)).slice(-500); });
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + String(chunk)).slice(-500); });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? done() : reject(new Error(`Production dependency installation failed (${code}). ${diagnostic}`)));
});
const guide = `职航 ${manifest.version} · Windows x64 本地版

1. 将整个 ZIP 解压到你自己电脑的可写文件夹，不要直接在压缩包里运行。
2. 双击“启动职航.cmd”。已包含 Node.js 和运行依赖，无需安装 Node.js、npm 或编程工具。
3. 浏览器会打开 http://127.0.0.1:4317。第一次是空白档案与规则演示模式；在“模型设置”填写你自己的 API Key 后启用真实模型。
4. 在“浏览器扩展”下载扩展 ZIP，解压后在 Chrome / Edge 扩展管理页启用开发者模式，加载包含 manifest.json 的文件夹。也可直接选择本包 extensions/zhihang-capture 文件夹。
5. 在职航生成一次性配对码，填入扩展完成配对。使用你自己日常浏览器的招聘账号；密码、Cookie 不需要提供给职航。
6. 双击“停止职航.cmd”关闭这一份后台服务。个人资料保存在这一份文件夹的 data 中，关闭网页不会自动停止后台。

整理已有内容：在“投递记录”中可删除单条模拟记录；在“岗位简历”中可移除当前岗位或删除选中的简历版本。
移除当前岗位仍保留来源清单和历史简历；简历存在关联模拟记录时，先删除对应记录。页面会说明范围，确认后才执行。

简历设计：进入“岗位简历”的“简历设计 Skills”，选择预设并填写要求，也可导入 .md / .txt 设计规范。
先解析并核对排版参数，再保存为本岗位使用或默认规范。新生成的简历会采用选中的规范；已有简历可应用设计并另存新版本。
输入规范不会执行脚本或访问其中的链接。不支持的要求会单独列出；复杂布局、外部字体和头像暂不支持。
生成或修改后会检查实际 PDF 的页数、文字完整性和边界。页数目标无法达到时会保留内容并提示；请在导出后自行复核阅读效果。

浏览器：Chrome 或 Edge 桌面版。网页、模型调用和招聘搜索需要网络；PDF 导出使用已安装的浏览器。
扩展仍需用户在浏览器中自行安装，这是尚未上架应用商店的分发方式；不能把 ZIP 当成自动安装器。
127.0.0.1 指各自电脑，分享时发送原始 ZIP 文件。此版本不是通过公共网址访问的多人云服务。
本分享包不包含开发者的个人档案、简历、API Key、配对授权、Cookie 或浏览器会话。开始使用后不要直接打包整个运行目录分享，以免附带你自己的 data。
模型服务费用由你自己的服务商账号承担。BOSS直聘采集只读取岗位。字节校招网申需在职航单独授权所选简历和官网岗位，再在本人已登录的浏览器中核对执行；学校下拉、日期等未知字段由本人填写。真实提交结果的验收状态见 README，不将附件选择、页面跳转或模拟回执当成真实投递成功。
JobSpy 是可选项，需要另行安装 Python 3.10+，再执行 scripts/setup-jobspy.ps1；扩展导入、手动 JD 和官网来源不依赖它。

端口冲突：同一电脑一次启动一份职航。如果 4317 被其他副本占用，请先从原副本停止；启动器不会替你打开其他副本的资料。
如果下载的文件被 Windows 或单位设备策略阻止，请按系统提示处理；本包未作 Windows 代码签名，不能保证所有组织管理的设备允许运行。

安装参考：
https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world
https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/extension-sideloading
`;
await writeFile(join(stage, '使用说明.txt'), '\uFEFF' + guide);
await writeFile(join(stage, 'RELEASE.json'), JSON.stringify({ application: 'zhihang', version: manifest.version, platform: 'win32-x64', node: nodeVersion, nodeSha256: nodeHash, extensionVersion: extension.version, includesUserData: false, bundledRuntime: true }, null, 2));
const payload = await files(stage);
assert.ok(!payload.some(name => /^(?:data|test-results|\.git|\.codex|\.venv-jobspy)(?:\/|$)/u.test(name) || /^\.env(?:$|\.)/u.test(name)), 'Private runtime files cannot enter release');
const zip = new JSZip();
for (const name of payload) zip.file(`${folderName}/${name}`, await readFile(join(stage, name)), { createFolders: false, date: new Date('2026-01-01T00:00:00Z') });
const zipPath = join(output, `${folderName}.zip`);
await pipeline(zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE', compressionOptions: { level: 6 } }), createWriteStream(zipPath));
const archive = await readFile(zipPath);
const report = { result: 'BUILT', version: manifest.version, zipPath, stage, filename: `${folderName}.zip`, bytes: archive.length, sha256: createHash('sha256').update(archive).digest('hex'), files: payload.length, noUserData: true, node: nodeVersion, nodeSha256: nodeHash, extensionFilename: extension.filename };
await writeFile(join(output, 'latest-build.json'), JSON.stringify(report, null, 2));
await writeFile(`${zipPath}.sha256`, `${report.sha256}  ${report.filename}\n`);
console.log(JSON.stringify(report));
