import express from 'express';
import multer from 'multer';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { Store } from './store.ts';
import { createModelEngine } from './model.ts';
import { createCareerEngine } from './career-engine.ts';
import { SettingsManager } from './model-settings.ts';
import { probeModel, supportsImageInput } from './model-provider.ts';
import { CareerAttachments, ATTACHMENT_MAX_BYTES } from './career-attachments.ts';
import { Workflow, WorkflowError } from './workflow.ts';
import { createJobDiscoverer } from './job-discovery.ts';
import { createCompanyResearcher } from './company-research.ts';
import { actionSchema, sandboxSubmitSchema } from './validation.ts';
import { browserAvailable, fillSandbox, submitSandbox, renderResumePdf, prepareResume, closeBrowser, removeApplicationSession, removeResumeCache } from './browser.ts';
import { removeApplicationFiles } from './application-files.ts';
import { sandboxPage } from './sandbox.ts';
import { BrowserConnections } from './browser-connections.ts';
import { extensionCaptureRouter } from './browser-capture-api.ts';
import { buildExtensionPackage, extensionPackageInfo } from './extension-package.ts';
import { RealApplications, extensionApplicationRouter } from './real-applications.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installationId = createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 16);
if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));
const port = Number(process.env.PORT || 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be between 1024 and 65535');
const baseUrl = `http://127.0.0.1:${port}`;
const dataDir = resolve(process.env.DATA_DIR || resolve(root, 'data'));
const evidenceDir = resolve(dataDir, 'evidence');
mkdirSync(evidenceDir, { recursive: true });
const store = new Store(resolve(dataDir, 'zhihang.sqlite'));
const browserConnections = new BrowserConnections(resolve(dataDir, 'zhihang.sqlite'));
const realApplications = new RealApplications(resolve(dataDir, 'zhihang.sqlite'), store, renderResumePdf);
const modelSettings = new SettingsManager(dataDir, process.env);
let engine = createModelEngine(modelSettings.env());
const careerAttachments = new CareerAttachments();
const workflow = new Workflow(store, engine, {
  fill: args => fillSandbox({ ...args, baseUrl, evidenceDir }),
  submit: args => submitSandbox({ ...args, baseUrl, evidenceDir }),
  removeApplication: async id => { await removeApplicationSession(id); removeApplicationFiles(dataDir, id); },
  removeResume: removeResumeCache,
  resumeInUse: id => realApplications.hasResume(id),
  prepareResume,
}, createCareerEngine(modelSettings.env()), process.env.JOB_DISCOVERY_ENABLED === 'false' ? undefined : createJobDiscoverer(),
  (company, sources) => createCompanyResearcher(modelSettings.env())(company, sources), careerAttachments);
let settingsBusy = false;
function assertSettingsIdle() {
  if (settingsBusy) throw new WorkflowError('模型设置正在验证或更新，请稍后再试。', 409);
}
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  const hostname = req.hostname;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) return res.status(403).json({ error: '此版本仅供本机使用。' });
  // CORS is enabled exclusively on the narrow, authenticated extension router.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use('/extension/v1', extensionCaptureRouter(browserConnections, workflow, assertSettingsIdle));
app.use('/extension/apply/v1', extensionApplicationRouter(realApplications));
app.use((req, res, next) => {
  const origin = req.get('origin');
  const expectedOrigins = [baseUrl, `http://localhost:${port}`];
  if (origin && !expectedOrigins.includes(origin)) return res.status(403).json({ error: '不接受跨站请求。' });
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '5mb' }));

app.get('/api/real-applications', (_req, res) => res.json({ runs: realApplications.list() }));
app.use('/api/real-applications', (req, _res, next) => {
  if (![baseUrl, `http://localhost:${port}`].includes(req.get('origin') || '') || !req.is('application/json') && req.method !== 'DELETE') throw new WorkflowError('请从职航页面管理真实网申授权。', 403);
  assertSettingsIdle();
  if (workflow.isBusy) throw new WorkflowError('请等当前任务完成后再管理网申。', 409);
  next();
});
app.post('/api/real-applications', async (req, res) => res.json(await realApplications.create(req.body, () => {
  assertSettingsIdle();
  if (workflow.isBusy) throw new WorkflowError('工作区正在更新，请完成后重新准备网申。', 409);
})));
function runRevision(body: unknown): number {
  if (!body || typeof body !== 'object' || !('expectedRevision' in body) || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0 || Object.keys(body).length !== 1) throw new WorkflowError('网申记录版本缺失，请刷新后重试。');
  return Number(body.expectedRevision);
}
app.post('/api/real-applications/:id/revoke', (req, res) => res.json(realApplications.revoke(req.params.id, runRevision(req.body))));
app.delete('/api/real-applications/:id', (req, res) => { realApplications.remove(req.params.id, runRevision(req.body)); res.json({ removed: true }); });

app.get('/api/status', (_req, res) => res.json({ application: 'zhihang', installationId, mode: engine.mode, model: engine.model, modelConfigured: engine.mode === 'live', browserAvailable: browserAvailable(), imageInput: supportsImageInput(modelSettings.env()), version: '0.12.1' }));
app.get('/api/browser-connections', async (_req, res) => {
  const extensionPath = resolve(root, 'extensions', 'zhihang-capture');
  res.json({ connections: browserConnections.list(), extensionPath, ...await extensionPackageInfo(extensionPath) });
});
app.get('/api/browser-extension/download', async (req, res) => {
  if (req.get('sec-fetch-site') === 'cross-site') throw new WorkflowError('请从职航的浏览器扩展页面下载安装包。', 403);
  const packaged = await buildExtensionPackage(resolve(root, 'extensions', 'zhihang-capture'));
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${packaged.filename}"`);
  res.send(packaged.buffer);
});
app.post('/api/browser-connections/pairing-code', (req, res) => {
  if (![baseUrl, `http://localhost:${port}`].includes(req.get('origin') || '') || !req.is('application/json')) throw new WorkflowError('请在职航的浏览器扩展连接页面生成配对码。', 403);
  res.json(browserConnections.createPairingCode());
});
app.delete('/api/browser-connections/:id', (req, res) => {
  if (![baseUrl, `http://localhost:${port}`].includes(req.get('origin') || '')) throw new WorkflowError('请在职航中断开扩展连接。', 403);
  browserConnections.revoke(req.params.id); res.json({ revoked: true });
});
app.get('/api/model-settings', (_req, res) => res.json(modelSettings.public()));
app.post('/api/model-settings/test', async (req, res) => {
  assertSettingsIdle();
  if (workflow.isBusy) throw new WorkflowError('当前任务还在执行，请完成后再测试模型连接。', 409);
  settingsBusy = true;
  try {
    const candidate = modelSettings.prepare(req.body);
    res.json(await probeModel(candidate.env));
  } finally { settingsBusy = false; }
});
app.put('/api/model-settings', async (req, res) => {
  assertSettingsIdle();
  if (workflow.isBusy) throw new WorkflowError('当前任务还在执行，请完成后再切换模型。', 409);
  settingsBusy = true;
  try {
    const candidate = modelSettings.prepare(req.body);
    const nextEngine = createModelEngine(candidate.env);
    const nextCareer = createCareerEngine(candidate.env);
    const test = await probeModel(candidate.env);
    const saved = workflow.replaceEngines(nextEngine, nextCareer, () => modelSettings.commit(candidate, test));
    engine = nextEngine;
    res.json(saved);
  } finally { settingsBusy = false; }
});
app.post('/api/model-settings/disable', (req, res) => {
  assertSettingsIdle();
  if (!Number.isSafeInteger(req.body?.expectedRevision) || req.body.expectedRevision < 0) throw new WorkflowError('设置版本缺失，请重新打开模型设置。');
  const nextEngine = createModelEngine({});
  const saved = workflow.replaceEngines(nextEngine, createCareerEngine({}), () => modelSettings.disable(req.body.expectedRevision));
  engine = nextEngine;
  res.json(saved);
});
app.get('/api/state', (_req, res) => res.json(store.read()));
const careerUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: ATTACHMENT_MAX_BYTES, files: 1, fields: 0, parts: 1 } });
app.post('/api/career-attachments', careerUpload.single('file'), async (req, res) => {
  assertSettingsIdle();
  if (!req.file) throw new WorkflowError('请选择文件或图片。');
  const decoded = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  try { res.json(await careerAttachments.add({ name: decoded.includes('\uFFFD') ? req.file.originalname : decoded, mimeType: req.file.mimetype, buffer: req.file.buffer }, supportsImageInput(modelSettings.env()))); }
  catch (error) { throw new WorkflowError(error instanceof Error ? error.message : '附件无法读取。'); }
});
app.delete('/api/career-attachments/:id', (req, res) => { careerAttachments.remove(req.params.id); res.json({ removed: true }); });
const resumeUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 1, parts: 2, fieldSize: 100 } });
app.post('/api/resume-import', resumeUpload.single('file'), async (req, res) => {
  assertSettingsIdle();
  if (!req.file) throw new WorkflowError('请选择 PDF、DOCX 或 TXT 基础简历。');
  const expectedRevision = Number(req.body.expectedRevision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || req.body.expectedRevision === undefined) throw new WorkflowError('页面版本缺失，请刷新重试。');
  const decoded = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  const name = decoded.includes('\uFFFD') ? req.file.originalname : decoded;
  try {
    res.json(await workflow.importResume({ name: name.slice(0, 200), mimeType: req.file.mimetype, buffer: req.file.buffer }, expectedRevision));
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error) throw error;
    throw new WorkflowError(error instanceof Error ? error.message : '未能读取该简历，请换用文字版 PDF 或 DOCX。');
  }
});
app.post('/api/actions', async (req, res) => {
  assertSettingsIdle();
  const action = actionSchema.parse(req.body);
  res.json(await workflow.act(action));
});
app.get('/api/resumes/:id/pdf', async (req, res) => {
  const resume = store.read().resumes.find(r => r.id === req.params.id);
  if (!resume) throw new WorkflowError('未找到这份简历。', 404);
  const pdf = await renderResumePdf(resume);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="resume-v${resume.version}.pdf"`);
  res.send(pdf);
});
app.get('/api/applications/:id/evidence', (req, res) => {
  const application = store.read().applications.find(a => a.id === req.params.id);
  if (!application?.evidence) throw new WorkflowError('还没有操作截图。', 404);
  const target = resolve(application.evidence);
  if (dirname(target) !== evidenceDir || !existsSync(target)) throw new WorkflowError('未找到该操作截图。', 404);
  res.type('png').sendFile(target);
});
app.get('/sandbox', (_req, res) => res.type('html').send(sandboxPage()));
app.get('/api/sandbox/context', (req, res) => {
  const applicationId = typeof req.query.applicationId === 'string' ? req.query.applicationId : '';
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!store.validToken(applicationId, token)) throw new WorkflowError('请从投递记录启动模拟填表。', 403);
  const application = store.read().applications.find(a => a.id === applicationId);
  if (!application) throw new WorkflowError('未找到这次模拟申请。', 404);
  res.json({ company: application.company, jobTitle: application.jobTitle });
});
app.post('/api/sandbox/submit', async (req, res) => {
  const input = sandboxSubmitSchema.parse(req.body);
  if (!store.validToken(input.applicationId, input.token)) throw new WorkflowError('模拟申请校验失败。', 403);
  const state = store.read();
  const application = state.applications.find(a => a.id === input.applicationId);
  if (!application || !['submitting', 'confirmed'].includes(application.status)) throw new WorkflowError('请先在职航中确认这次模拟提交。', 409);
  const resume = state.resumes.find(r => r.id === application.resumeId);
  if (!resume?.approved || !input.consent) throw new WorkflowError('简历或提交尚未确认。');
  const expected = { name: resume.profile.name, email: resume.profile.email, phone: resume.profile.phone, school: resume.profile.school, education: resume.profile.education, graduation: resume.profile.graduation, city: resume.profile.city, availability: resume.profile.availability, experience: resume.bullets.map(b => b.text).join('\n') };
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (input.fields[key] !== expected[key]) throw new WorkflowError(`表单字段 ${key} 与已确认简历不一致，请重新填写。`);
  }
  if (input.resumeName !== `${resume.id}.pdf` || basename(input.resumeName) !== input.resumeName) throw new WorkflowError('上传文件与当前简历版本不一致。');
  const uploaded = Buffer.from(input.resumeData, 'base64');
  if (uploaded.length > 3 * 1024 * 1024 || uploaded.subarray(0, 5).toString() !== '%PDF-') throw new WorkflowError('请上传不超过 3 MB 的有效 PDF。');
  const expectedPdf = await renderResumePdf(resume);
  const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
  if (digest(uploaded) !== digest(expectedPdf)) throw new WorkflowError('附件内容与已确认简历不一致，请重新填写。');
  // PDF rendering yields control: a deletion or profile change may have committed meanwhile.
  const latest = store.read();
  const latestApplication = latest.applications.find(item => item.id === input.applicationId);
  const latestResume = latest.resumes.find(item => item.id === application.resumeId);
  if (!store.validToken(input.applicationId, input.token) || !latestApplication || !['submitting', 'confirmed'].includes(latestApplication.status) || !latestResume?.approved || latestResume.stale) {
    throw new WorkflowError('这次模拟申请已删除或失效，请返回职航查看。', 409);
  }
  const attachments = resolve(dataDir, 'sandbox-attachments');
  mkdirSync(attachments, { recursive: true });
  writeFileSync(resolve(attachments, `${application.id}.pdf`), uploaded);
  res.json({ receipt: store.createReceipt(application.id) });
});
app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在。' }));

if (existsSync(resolve(root, 'dist', 'index.html'))) {
  app.use(express.static(resolve(root, 'dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve(root, 'dist', 'index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ root, server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof multer.MulterError) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? '基础简历请控制在 8 MB 以内。' : '一次请选择一个 PDF、DOCX 或 TXT 文件。' });
  if (error instanceof ZodError) return res.status(400).json({ error: `输入需要调整：${error.issues.map(i => `${i.path.join('.')} ${i.message}`).slice(0, 3).join('；')}` });
  const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : 500;
  const message = error instanceof Error ? error.message : '操作未完成，请稍后再试。';
  res.status(status >= 400 && status < 600 ? status : 500).json({ error: message });
});
const server = app.listen(port, '127.0.0.1', () => console.log(`职航已启动：${baseUrl} | ${engine.mode === 'demo' ? '规则演示模式' : '真实模型模式'} | 仅本机访问`));
async function shutdown() { await closeBrowser(); server.close(() => { realApplications.close(); browserConnections.close(); store.close(); process.exit(0); }); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('message', message => { if (message === 'shutdown') void shutdown(); });
