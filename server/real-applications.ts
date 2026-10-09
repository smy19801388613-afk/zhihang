import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { z, ZodError } from 'zod';
import type { ResumeVersion } from '../shared/types.ts';
import { bytedanceTarget, type AuthorizedApplicationRun, type RealApplicationRun, type RealTarget } from '../shared/real-application.ts';
import { resolveResumeTargets, resumeLabel } from '../shared/resume-scope.ts';
import { EXTENSION_ORIGIN, ConnectionError } from './browser-connections.ts';
import { Store, ConflictError } from './store.ts';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const snapshotHash = (resume: ResumeVersion) => hash(JSON.stringify(resume));
const createSchema = z.object({ resumeId: z.string().min(1).max(100), expectedRevision: z.number().int().nonnegative(), candidateIds: z.array(z.string().max(100)).max(20).default([]), includeCurrentJob: z.boolean().default(false), targetUrls: z.array(z.string().url().max(500)).max(20).default([]) }).strict();
const checkpointSchema = z.object({
  expectedRevision: z.number().int().nonnegative(), targetId: z.string().regex(/^\d{10,24}$/u),
  status: z.enum(['needs_user', 'filled', 'submitting', 'submitted', 'unknown', 'failed']),
  pageUrl: z.string().url().max(600), message: z.string().max(300).optional(),
  evidence: z.string().max(120).optional(), confirmed: z.boolean().optional(),
}).strict();
type Row = { id: string; data: string; resume_hash: string; code_hash: string | null; code_expires: number; token_hash: string | null; origin: string | null };

/** Separate, one-run authorization. Capture credentials never authorize resume access. */
export class RealApplications {
  private db: DatabaseSync;
  constructor(path: string, private store: Store, private pdf: (resume: ResumeVersion) => Promise<Buffer>, private now = () => Date.now()) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS real_application_runs (
      id TEXT PRIMARY KEY, data TEXT NOT NULL, resume_hash TEXT NOT NULL,
      code_hash TEXT UNIQUE, code_expires INTEGER NOT NULL, token_hash TEXT UNIQUE, origin TEXT
    );`);
    // A service interruption during a click is never a reason to repeat submission.
    for (const row of this.rows()) {
      const run = this.parse(row); let changed = false;
      for (const target of run.targets) if (target.status === 'submitting') { target.status = 'unknown'; target.message = '服务在提交时中断，请在官网核验，勿重复提交。'; changed = true; }
      if (changed) { run.revision++; this.save(run); }
    }
  }
  private rows(): Row[] { return this.db.prepare('SELECT * FROM real_application_runs ORDER BY rowid DESC').all() as unknown as Row[]; }
  private parse(row: Row): RealApplicationRun { return JSON.parse(row.data); }
  private row(id: string): Row { const row = this.db.prepare('SELECT * FROM real_application_runs WHERE id=?').get(id) as unknown as Row; if (!row) throw new ConnectionError('未找到真实网申记录。', 404); return row; }
  private save(run: RealApplicationRun) {
    const result = this.db.prepare("UPDATE real_application_runs SET data=? WHERE id=? AND json_extract(data, '$.revision')=?")
      .run(JSON.stringify(run), run.id, run.revision - 1);
    if (result.changes !== 1) throw new ConflictError();
  }
  list(): RealApplicationRun[] { return this.rows().map(row => this.parse(row)); }
  hasResume(id: string) { return this.list().some(run => run.resume.id === id); }
  private activeResume(row: Row): ResumeVersion {
    const run = this.parse(row);
    if (run.revokedAt || Date.parse(run.expiresAt) <= this.now()) throw new ConnectionError('本次网申授权已撤销或过期，请回到职航重新准备。', 401);
    const resume = this.store.read().resumes.find(item => item.id === run.resume.id);
    if (!resume?.approved || resume.stale || snapshotHash(resume) !== row.resume_hash) throw new ConnectionError('本次授权的简历已变更或失效，请重新审核并准备。', 409);
    return resume;
  }
  async create(input: unknown, assertCommitAllowed: () => void = () => {}) {
    const data = createSchema.parse(input); const state = this.store.read();
    if (state.revision !== data.expectedRevision) throw new ConflictError();
    const resume = state.resumes.find(item => item.id === data.resumeId);
    if (!resume?.approved || resume.stale) throw new ConnectionError('请先审核一份有效简历，再准备真实网申。', 409);
    const jobs = data.candidateIds.length || data.includeCurrentJob ? resolveResumeTargets(state, data.candidateIds, data.includeCurrentJob) : [];
    const targets = new Map<string, RealTarget>();
    for (const job of jobs) {
      const target = bytedanceTarget(job.url);
      if (!target) throw new ConnectionError('首个真实渠道只接受字节跳动校招官网岗位链接。BOSS 等来源请在下方提供对应的官网链接。', 400);
      targets.set(target.id, { ...target, company: '字节跳动', title: job.title, status: 'pending' });
    }
    for (const url of data.targetUrls) {
      const target = bytedanceTarget(url);
      if (!target) throw new ConnectionError('请填写 jobs.bytedance.com 的校招岗位详情或简历填写链接。', 400);
      if (!targets.has(target.id)) targets.set(target.id, { ...target, company: '字节跳动', title: `校招岗位 ${target.id}`, status: 'pending' });
    }
    if (!targets.size || targets.size > 20) throw new ConnectionError('请选择或填写 1 至 20 个不同的字节官网岗位。', 400);
    const bytes = await this.pdf(resume);
    if (bytes.length > 8 * 1024 * 1024 || bytes.subarray(0, 5).toString() !== '%PDF-') throw new ConnectionError('简历 PDF 无效或超过 8 MB。', 400);
    // Rendering yields: all state and duplicate checks are repeated before committing.
    const at = new Date(this.now()).toISOString();
    const run: RealApplicationRun = { id: randomUUID(), revision: 0, createdAt: at, expiresAt: new Date(this.now() + 60 * 60_000).toISOString(),
      resume: { id: resume.id, version: resume.version, label: resumeLabel(resume), sha256: hash(bytes) }, targets: [...targets.values()] };
    const code = randomBytes(8).toString('hex').toUpperCase();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      assertCommitAllowed();
      // Both stores use this same SQLite file. Hold its write lock while checking
      // the workspace revision so a concurrent process cannot slip a change
      // between the post-render check and authorization creation.
      if (this.store.read().revision !== data.expectedRevision) throw new ConflictError();
      const existing = this.list().flatMap(item => item.targets.filter(target => ['submitting', 'submitted', 'unknown'].includes(target.status) || (!item.revokedAt && Date.parse(item.expiresAt) > this.now())).map(target => target.id));
      if (run.targets.some(target => existing.includes(target.id))) throw new ConnectionError('部分岗位已有网申记录或未结束的授权，请先核对已有记录，避免重复投递。', 409);
      this.db.prepare('INSERT INTO real_application_runs(id,data,resume_hash,code_hash,code_expires) VALUES(?,?,?,?,?)').run(run.id, JSON.stringify(run), snapshotHash(resume), hash(code), this.now() + 5 * 60_000);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { run, code, codeExpiresAt: new Date(this.now() + 5 * 60_000).toISOString() };
  }
  claim(code: string, origin: string) {
    if (!EXTENSION_ORIGIN.test(origin)) throw new ConnectionError('扩展来源未获授权。', 403);
    const normalized = code.trim().toUpperCase();
    if (!/^[A-F0-9]{16}$/u.test(normalized)) throw new ConnectionError('授权码无效、已使用或已过期。');
    const row = this.db.prepare('SELECT * FROM real_application_runs WHERE code_hash=? AND code_expires>?').get(hash(normalized), this.now()) as unknown as Row;
    if (!row) throw new ConnectionError('授权码无效、已使用或已过期。');
    this.activeResume(row);
    const token = randomBytes(32).toString('base64url');
    const result = this.db.prepare("UPDATE real_application_runs SET code_hash=NULL, token_hash=?, origin=? WHERE id=? AND code_hash=? AND code_expires>? AND json_extract(data, '$.revision')=?")
      .run(hash(token), origin, row.id, row.code_hash, this.now(), this.parse(row).revision);
    if (result.changes !== 1) throw new ConnectionError('授权码已使用。');
    return { token, expiresAt: this.parse(row).expiresAt, run: this.authorized(token, origin) };
  }
  private tokenRow(token: string, origin: string): Row {
    if (!EXTENSION_ORIGIN.test(origin)) throw new ConnectionError('扩展来源未获授权。', 403);
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) throw new ConnectionError('网申授权无效。');
    const row = this.db.prepare('SELECT * FROM real_application_runs WHERE token_hash=? AND origin=?').get(hash(token), origin) as unknown as Row;
    if (!row) throw new ConnectionError('网申授权无效，采集凭证不能用于投递。');
    this.activeResume(row); return row;
  }
  authorized(token: string, origin: string): AuthorizedApplicationRun {
    const row = this.tokenRow(token, origin); const resume = this.activeResume(row); const p = resume.profile;
    return { ...this.parse(row), fields: { name: p.name, email: p.email, phone: p.phone, school: p.school, education: p.education, major: p.major || '', graduation: p.graduation, city: p.city, availability: p.availability } };
  }
  async resumePdf(token: string, origin: string) {
    const row = this.tokenRow(token, origin); const bytes = await this.pdf(this.activeResume(row));
    this.tokenRow(token, origin);
    if (hash(bytes) !== this.parse(row).resume.sha256) throw new ConnectionError('PDF 与授权版本不一致，请重新准备。', 409);
    return bytes;
  }
  checkpoint(token: string, origin: string, input: unknown) {
    const data = checkpointSchema.parse(input); const row = this.tokenRow(token, origin); const run = this.parse(row);
    if (run.revision !== data.expectedRevision) throw new ConflictError();
    const target = run.targets.find(item => item.id === data.targetId);
    if (!target) throw new ConnectionError('该岗位不在本次授权清单内。', 403);
    const page = bytedanceTarget(data.pageUrl);
    if (page?.id !== target.id) throw new ConnectionError('页面岗位与授权目标不一致，请重新点击扩展。', 409);
    if (target.status === 'submitted') throw new ConnectionError('此岗位已记录投递成功，请勿重复操作。', 409);
    if (['submitting', 'unknown'].includes(target.status) && !['submitted', 'unknown'].includes(data.status)) throw new ConnectionError('投递结果尚未核验，不能重新填写或提交。', 409);
    if (data.status === 'submitting' && (target.status !== 'filled' || data.confirmed !== true)) throw new ConnectionError('请在扩展核对表单后明确确认这次真实提交。', 409);
    if (data.status === 'submitted' && (!['submitting', 'unknown'].includes(target.status) || !data.evidence || !/^(投递成功|申请成功|已成功投递|已投递|申请已提交)$/u.test(data.evidence))) throw new ConnectionError('没有可识别的成功页面证据，结果应保持待核验。', 409);
    target.status = data.status; target.message = data.message; target.pageUrl = data.pageUrl.split(/[?#]/u)[0]; target.evidence = data.evidence;
    run.revision++; this.save(run); return this.authorized(token, origin);
  }
  revoke(id: string, expectedRevision?: number) {
    const run = this.parse(this.row(id));
    if (expectedRevision !== undefined && run.revision !== expectedRevision) throw new ConflictError();
    run.revokedAt = new Date(this.now()).toISOString(); run.revision++; this.save(run); return run;
  }
  remove(id: string, expectedRevision?: number) {
    const run = this.parse(this.row(id));
    if (expectedRevision !== undefined && run.revision !== expectedRevision) throw new ConflictError();
    if (!run.revokedAt && Date.parse(run.expiresAt) > this.now()) throw new ConnectionError('请先撤销本次网申授权，再删除本地记录。删除记录不会撤回官网申请。', 409);
    const result = this.db.prepare("DELETE FROM real_application_runs WHERE id=? AND json_extract(data, '$.revision')=?").run(id, run.revision);
    if (result.changes !== 1) throw new ConflictError();
  }
  close() { this.db.close(); }
}

export function extensionApplicationRouter(runs: RealApplications) {
  const router = express.Router(); let attempts = 0; let since = Date.now();
  const bearer = (req: express.Request) => {
    const match = (req.get('authorization') || '').match(/^Bearer ([A-Za-z0-9_-]{43})$/u);
    if (!match) throw new ConnectionError('网申授权无效。');
    return match[1];
  };
  router.use((req, res, next) => {
    const origin = req.get('origin') || '';
    if (!EXTENSION_ORIGIN.test(origin) || !['/claim', '/run', '/resume.pdf', '/checkpoint'].includes(req.path)) return res.status(403).json({ error: '仅接受授权扩展的专用网申请求。' });
    res.setHeader('Access-Control-Allow-Origin', origin); res.vary('Origin'); res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') {
      if (req.get('access-control-request-method') !== 'POST' || (req.get('access-control-request-headers') || '').split(',').some(header => header.trim() && !['authorization', 'content-type'].includes(header.trim().toLowerCase()))) return res.status(403).end();
      res.setHeader('Access-Control-Allow-Methods', 'POST'); res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      if (req.get('access-control-request-private-network') === 'true') res.setHeader('Access-Control-Allow-Private-Network', 'true');
      return res.status(204).end();
    }
    if (req.method !== 'POST') return res.status(405).json({ error: '只支持 POST。' });
    if (!req.is('application/json')) return res.status(415).json({ error: '请求必须为 JSON。' });
    next();
  });
  router.use(express.json({ limit: '8kb', strict: true }));
  router.post('/claim', (req, res) => {
    if (Date.now() - since > 300000) { attempts = 0; since = Date.now(); }
    if (++attempts > 12) throw new ConnectionError('授权尝试过于频繁，请稍后重试。', 429);
    const { code } = z.object({ code: z.string().max(32) }).strict().parse(req.body);
    res.json(runs.claim(code, req.get('origin')!));
  });
  router.post('/run', (req, res) => { z.object({}).strict().parse(req.body); res.json(runs.authorized(bearer(req), req.get('origin')!)); });
  router.post('/resume.pdf', async (req, res) => { z.object({}).strict().parse(req.body); const bytes = await runs.resumePdf(bearer(req), req.get('origin')!); res.type('pdf').send(bytes); });
  router.post('/checkpoint', (req, res) => res.json(runs.checkpoint(bearer(req), req.get('origin')!, req.body)));
  router.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof ZodError || error instanceof SyntaxError) return res.status(400).json({ error: '网申请求字段不符合要求。' });
    const status = (error as { status?: number })?.status || 500;
    res.status(status >= 400 && status < 600 ? status : 500).json({ error: status >= 500 ? '网申操作未完成，请回到职航查看。' : error instanceof Error ? error.message : '网申请求过大或无效。' });
  });
  return router;
}
