import { randomUUID, createHash } from 'node:crypto';
import type { ActionRequest, Application, CareerDirection, CompanyCandidate, Job, JobDiscoveryResult, ModelEngine, Profile, ResumeVersion, WorkspaceState } from '../shared/types.ts';
import { Store, ConflictError, emptyProfile } from './store.ts';
import { validateResumeDraft, validateGroundedDocument, previewFactResegmentation } from './model.ts';
import type { CareerAttachments } from './career-attachments.ts';
import { createCareerEngine, discoveryCity } from './career-engine.ts';
import { companyCoverageNotice } from './company-catalog.ts';
import { parseResumeFile, inferProfileFromText } from './resume-import.ts';
import { allocateResumeVersion, createEditedVersion, jobKey, sameTargetJob, markSuperseded, validateModelEdit } from './resume-edit.ts';
import { toResumeDocument } from '../shared/resume-template.ts';
import { captureBatchSchema, captureEditsSchema, resumeDocumentSchema } from './validation.ts';
import type { CompanyResearcher } from './company-research.ts';
import type { CaptureBatch, CaptureImportResult } from '../shared/browser-capture.ts';
import { applyCaptureEdits, captureJob, capturePayloadHash, mergeBrowserCaptures, mergeCaptureCandidates, syncCaptureDecisions } from './browser-capture.ts';
import { candidateJob } from '../shared/job-source.ts';
import { resumeDesignSkillSchema, type ResumeQualityReport } from '../shared/resume-design.ts';
import { applyDesignSkill, previewDesignDemo, preserveEditedDesign, resumeContent } from './resume-design.ts';
import { applicationTarget, resolveResumeTargets, MAX_SHARED_RESUME_JOBS, MAX_BATCH_APPLICATIONS, type ResumeScope } from '../shared/resume-scope.ts';

export class WorkflowError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export interface BrowserTools {
  fill(args: { application: Application; resume: ResumeVersion; token: string }): Promise<{ evidence: string }>;
  submit(args: { application: Application; resume: ResumeVersion; token: string }): Promise<{ receipt: string; evidence: string }>;
  removeApplication?(applicationId: string): Promise<void>;
  removeResume?(resumeId: string): Promise<void>;
  resumeInUse?(resumeId: string): boolean;
  prepareResume?(resume: ResumeVersion): Promise<{ document: import('../shared/types.ts').ResumeDocument; quality: ResumeQualityReport }>;
}
export type JobDiscovery = (input: { profile: Profile; directions: CareerDirection[]; companies: CompanyCandidate[] }) => Promise<JobDiscoveryResult>;
export function event(state: WorkspaceState, title: string, detail: string) {
  state.events.unshift({ id: randomUUID(), at: new Date().toISOString(), title, detail });
  state.events = state.events.slice(0, 100);
}
export function invalidateDraft(state: WorkspaceState) {
  state.factPreview = null;
  state.analysis = null;
  state.activeResumeId = null;
  state.interview = null;
  for (const resume of state.resumes) resume.stale = true;
  if (state.exploration?.directions.length) state.exploration.profileStale = true;
  for (const app of state.applications) {
    if (app.status === 'prepared' || app.status === 'filled') {
      app.status = 'failed'; app.error = '资料或岗位已变更，请重新生成简历并准备申请。'; app.updatedAt = new Date().toISOString();
    }
  }
}
export function currentResume(state: WorkspaceState, resumeId: string, approved = false): ResumeVersion {
  const resume = state.resumes.find(r => r.id === resumeId);
  if (!resume) throw new WorkflowError('未找到这版简历。', 404);
  if (resume.stale) throw new WorkflowError('这份简历已经不是当前草稿，请重新生成并审核。');
  if (approved && !resume.approved) throw new WorkflowError('请先审核并确认这版简历。');
  return resume;
}
const jobContent = (job: Job) => JSON.stringify([jobKey(job.company, job.title), job.candidateId || '', job.text.trim(), job.url.trim(), job.location || '', job.industry || '', job.roleFamily || '', job.sourceKind || 'user_jd', job.jdComplete ?? null]);
const resumeTargets = (resume: ResumeVersion): Job[] => resume.scope ? resume.scope.targetJobs : [resume.job];
function resetResumeDesign(state: WorkspaceState) {
  const design = state.resumeDesign;
  if (design) { design.currentSkillId = design.defaultSkillId; design.preview = null; }
}
function invalidateChangedCapture(state: WorkspaceState, id: string) {
  const record = state.browserCaptures?.[id];
  if (!record) return;
  const next = captureJob(record);
  (state.companyJobs ??= {})[id] = next;
  if (state.job.candidateId === id && jobContent(state.job) !== jobContent(next)) {
    state.job = structuredClone(next); state.analysis = null; state.activeResumeId = null; state.interview = null;
  }
  const staleIds = new Set<string>();
  for (const resume of state.resumes) if (resumeTargets(resume).some(job => job.candidateId === id && jobContent(job) !== jobContent(next))) { resume.stale = true; staleIds.add(resume.id); }
  for (const app of state.applications) if (staleIds.has(app.resumeId) && ['prepared', 'filled'].includes(app.status)) { app.status = 'failed'; app.error = '该岗位资料已更新，请重新生成并审核简历。'; app.updatedAt = new Date().toISOString(); }
}
function requireCompleteCapture(state: WorkspaceState, candidateId = state.job.candidateId) {
  const record = candidateId ? state.browserCaptures?.[candidateId] : undefined;
  if (record && (!record.fields.jdComplete || record.fields.jd.trim().length < 10)) throw new WorkflowError('详情待补充：请在浏览器打开岗位详情后再次导入，或在浏览器导入清单中补充完整 JD，再分析和生成简历。');
  if (record && (!record.fields.company.trim() || !record.fields.title.trim())) throw new WorkflowError('请先在浏览器导入清单中补充公司与岗位名称。');
}
function applicationJob(state: WorkspaceState, application: Application) {
  return applicationTarget(application, state.resumes.find(resume => resume.id === application.resumeId));
}
function assertNoOtherApplication(state: WorkspaceState, application: Application) {
  if (state.applications.some(other => other.id !== application.id && other.status !== 'failed' && sameTargetJob(applicationJob(state, other), applicationJob(state, application)))) {
    throw new WorkflowError('同一企业岗位已有另一条有效申请，请处理已有记录，避免重复投递。');
  }
}
export function validateContact(profile: Profile) {
  for (const [key, label] of Object.entries({ name: '姓名', email: '邮箱', phone: '电话', school: '学校', education: '学历', graduation: '毕业时间', city: '意向城市', availability: '到岗时间' })) {
    if (!profile[key as keyof Profile]) throw new WorkflowError(`请在个人资料中补充${label}，并重新生成、确认简历。`);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)) throw new WorkflowError('请填写有效邮箱，再重新生成简历。');
}
export const exampleProfile: Omit<Profile, 'facts'> = {
  name: '林知夏（示例）', email: 'demo@example.com', phone: '13800000000', school: '示例大学', education: '本科',
  graduation: '2027-06', city: '北京', availability: '每周 4 天，可实习 3 个月', targetRole: '产品运营实习生',
  experienceText: '2025 年 9 月至 12 月，我参与校园二手物品平台课程项目，负责访谈同学，整理需求并绘制页面原型。\n我使用 Excel 汇总访谈反馈，把用户需求整理为功能清单，和开发同学一起确认实现范围。\n在校园读书会活动中，我负责公众号内容排期、报名表维护和活动后的反馈整理。\n我会使用 Excel 和 Figma，正在学习 SQL，尚未在真实业务中使用 SQL。'
};
export const exampleJob = { company: '星帆科技（虚构示例）', title: '产品运营实习生', url: '', text: '岗位职责：协助整理用户反馈和需求，参与内容运营与活动执行，使用 Excel 整理数据，与产品和开发同学协作推进需求。\n任职要求：本科及以上在校生，表达清晰，能使用 Excel；有校园活动或课程项目经历优先。掌握 SQL 加分。工作地点北京，每周至少 4 天，连续实习 3 个月。' };

export class Workflow {
  private busy = false;
  constructor(private store: Store, private engine: ModelEngine, private browser: BrowserTools, private career = createCareerEngine({}), private discover?: JobDiscovery, private research?: CompanyResearcher, private attachments?: CareerAttachments) {}
  get isBusy() { return this.busy; }
  async importBrowserCaptures(input: CaptureBatch): Promise<CaptureImportResult> {
    if (this.busy) throw new WorkflowError('当前任务还在执行，请稍后重试导入。', 409);
    this.busy = true;
    try {
      const batch = captureBatchSchema.parse(input);
      const state = this.store.read();
      const payloadHash = capturePayloadHash(batch);
      const receipt = state.browserCaptureRequests?.find(item => item.requestId === batch.requestId);
      if (receipt) {
        if (receipt.payloadHash !== payloadHash) throw new WorkflowError('此导入请求编号已用于不同内容，请重新确认并生成新请求。', 409);
        return receipt.result;
      }
      syncCaptureDecisions(state);
      const before = new Map(Object.values(state.browserCaptures || {}).map(record => [record.id, JSON.stringify(record.fields)]));
      const now = new Date().toISOString();
      const result = mergeBrowserCaptures(state, batch, now);
      for (const record of Object.values(state.browserCaptures || {})) if (before.get(record.id) !== JSON.stringify(record.fields)) invalidateChangedCapture(state, record.id);
      mergeCaptureCandidates(state);
      if (result.imported && !state.exploration!.directions.length) state.exploration!.stage = 'companies';
      state.browserCaptureRequests = [...(state.browserCaptureRequests || []), { requestId: batch.requestId, payloadHash, completedAt: now, result }].slice(-200);
      event(state, '浏览器岗位已导入', `新增 ${result.imported}，补充 ${result.updated}，重复 ${result.duplicates}；仅保存岗位信息，未执行投递。`);
      this.store.save(state, state.revision);
      return result;
    } finally { this.busy = false; }
  }
  replaceEngines<T>(engine: ModelEngine, career: ReturnType<typeof createCareerEngine>, commit: () => T): T {
    if (this.busy) throw new WorkflowError('当前任务还在执行，请完成后再切换模型设置。', 409);
    const result = commit();
    this.engine = engine; this.career = career;
    return result;
  }
  async importResume(file: { name: string; mimeType: string; buffer: Buffer }, expectedRevision: number): Promise<WorkspaceState> {
    if (this.busy) throw new WorkflowError('上一步还在执行，请稍后再操作。', 409);
    this.busy = true;
    try {
      const state = this.store.read();
      if (state.revision !== expectedRevision) throw new ConflictError();
      const parsed = await parseResumeFile(file);
      const inferred = inferProfileFromText(parsed.text);
      const enriched = await this.career.enrichImport(parsed.text, inferred.fields);
      const { facts: _facts, ...blank } = emptyProfile();
      // A model may return only one valid excerpt. Preserve the full local body
      // so later experience, skills and qualifications cannot disappear on import.
      const proposedProfile = { ...blank, ...inferred.fields, ...enriched.fields, experienceText: inferred.fields.experienceText || parsed.text };
      state.resumeImport = { filename: file.name, importedAt: new Date().toISOString(), text: parsed.text, proposedProfile, warnings: [...parsed.warnings, ...inferred.warnings, ...enriched.warnings] };
      event(state, '基础简历已读取', '已自动对应字段，等待确认导入；原有档案尚未覆盖。');
      return this.store.save(state, state.revision);
    } finally { this.busy = false; }
  }
  private async generateResume(state: WorkspaceState, scope?: ResumeScope): Promise<ResumeVersion> {
    if (!scope) {
      requireCompleteCapture(state);
      if (!state.analysis) throw new WorkflowError('请先完成当前岗位分析。');
    }
    if (!state.profile.name.trim()) throw new WorkflowError('请在个人资料中填写姓名。');
    if (!state.profile.facts.some(fact => fact.confirmed)) throw new WorkflowError('请先确认至少一条经历事实，再制作简历。');
    if (!scope && this.engine.mode === 'live' && state.analysis!.agentRun?.version !== 1) {
      state.analysis = await this.engine.analyzeJob(state.profile, state.job);
    }
    const job = scope ? { company: '', title: scope.name, text: '', url: '' } : state.job;
    const analysis = scope ? { summary: scope.focus, matches: [], questions: [], directionAdvice: [] } : state.analysis!;
    const skill = state.resumeDesign?.skills.find(item => item.id === state.resumeDesign?.currentSkillId);
    const draft = await this.engine.draftResume(state.profile, job, analysis, skill ? structuredClone(skill) : undefined, scope ? structuredClone(scope) : undefined);
    let document = draft.document ? resumeDocumentSchema.parse(draft.document) : undefined;
    if (document) validateGroundedDocument(state.profile, document);
    else validateResumeDraft(state.profile, draft.bullets);
    const bullets = document ? document.sections.flatMap(section => section.items).filter(item => item.content.trim()).map(item => ({ text: [item.title, item.subtitle, item.date, item.content].filter(Boolean).join('\n'), factIds: item.factIds })) : draft.bullets;
    const resume: ResumeVersion = { id: randomUUID(), version: allocateResumeVersion(state), createdAt: new Date().toISOString(), profile: structuredClone(state.profile), job: structuredClone(job), bullets, rationale: draft.rationale, approved: false, stale: false,
      ...(scope ? { scope: structuredClone(scope), collectionId: randomUUID() } : {}),
      generation: { mode: this.engine.mode, model: this.engine.model }, ...(draft.authoredBy ? { authoredBy: draft.authoredBy } : {}), ...(draft.reviewNotes ? { reviewNotes: draft.reviewNotes } : {}) };
    resume.document = document || toResumeDocument(resume);
    if (skill) { resume.designSkill = structuredClone(skill); resume.document = applyDesignSkill(resume.document, skill); }
    await this.prepareResume(resume);
    markSuperseded(state, resume);
    state.resumes.push(resume); state.activeResumeId = resume.id;
    event(state, `简历 V${resume.version} 已生成`, scope ? `${scope.kind === 'general' ? '通用简历' : `${scope.targetJobs.length} 个岗位共用简历`}，等待审核；未执行投递。` : '本版本绑定公司与岗位方向，等待审核。');
    return resume;
  }
  private validateApplicationResume(state: WorkspaceState, resumeId: string): ResumeVersion {
    const resume = currentResume(state, resumeId, true);
    validateContact(resume.profile);
    if (resume.bullets.map(bullet => bullet.text).join('\n').length > 18000) throw new WorkflowError('经历内容超过测试表单 18000 字限制，请精简经历后重新生成简历。');
    return resume;
  }
  private prepareApplication(state: WorkspaceState, resume: ResumeVersion, target: Job): Application | undefined {
    if (!target.company.trim() || !target.title.trim()) throw new WorkflowError('请选择实际投递的公司与岗位。');
    if (state.applications.some(other => other.status !== 'failed' && sameTargetJob(applicationJob(state, other), target))) return undefined;
    const now = new Date().toISOString();
    const application: Application = { id: randomUUID(), resumeId: resume.id, company: target.company, jobTitle: target.title, targetJob: structuredClone(target), status: 'prepared', simulated: true, createdAt: now, updatedAt: now };
    state.applications.unshift(application);
    event(state, '模拟申请已准备', `${target.company} · ${target.title}。仅发往本机测试招聘站，不会投递真实企业。${target.jdComplete === false || target.text.trim().length < 10 ? '岗位详情待补充，尚未核实完整招聘要求。' : ''}`);
    return application;
  }
  private validateApplicationStep(state: WorkspaceState, applicationId: string, phase: 'fill' | 'submit'): { app: Application; resume: ResumeVersion } {
    const app = state.applications.find(application => application.id === applicationId);
    if (!app) throw new WorkflowError('未找到这次申请。', 404);
    if (!app.simulated) throw new WorkflowError('这里只能处理本机模拟申请。');
    assertNoOtherApplication(state, app);
    if (phase === 'fill' && !['prepared', 'filled', 'failed'].includes(app.status)) throw new WorkflowError('该申请当前不能重复填写；结果不明时请先核验。');
    if (phase === 'submit' && app.status !== 'filled') throw new WorkflowError('请先填写并核对表单，再明确确认提交；结果不明时请先核验。');
    if (this.store.receipt(app.id)) throw new WorkflowError('该申请已有回执，请核验结果，勿重复提交。');
    return { app, resume: this.validateApplicationResume(state, app.resumeId) };
  }
  private async fillApplication(state: WorkspaceState, app: Application, resume: ResumeVersion): Promise<WorkspaceState> {
    try {
      const result = await this.browser.fill({ application: app, resume, token: this.store.token(app.id) });
      app.status = 'filled'; app.evidence = result.evidence; app.error = undefined;
      event(state, '模拟表单已填好', `${app.company} · ${app.jobTitle}，等待最终提交确认。`);
    } catch (error) {
      if (error instanceof ConflictError) throw error;
      app.status = 'failed'; app.error = error instanceof Error ? error.message : '浏览器填写失败，请重试。';
      event(state, '模拟填写未完成', app.error);
    }
    app.updatedAt = new Date().toISOString();
    // Persistence is deliberately outside the browser error catch. A failed CAS
    // stops the batch; it must never be mistaken for a recoverable item failure.
    return this.store.save(state, state.revision);
  }
  private async submitApplication(state: WorkspaceState, app: Application, resume: ResumeVersion): Promise<WorkspaceState> {
    app.status = 'submitting'; app.updatedAt = new Date().toISOString();
    event(state, '开始模拟提交', `${app.company} · ${app.jobTitle}，提交前检查点已保存；如中断，将先核验结果。`);
    state = this.store.save(state, state.revision);
    app = state.applications.find(application => application.id === app.id)!;
    try {
      const result = await this.browser.submit({ application: app, resume, token: this.store.token(app.id) });
      const receipt = this.store.receipt(app.id);
      if (!receipt || receipt !== result.receipt) throw new WorkflowError('未获得可核验回执。');
      app.status = 'confirmed'; app.receipt = receipt; app.evidence = result.evidence; app.error = undefined;
      event(state, '模拟提交已核验', `测试站回执：${receipt}。未向真实企业投递。`);
    } catch (error) {
      if (error instanceof ConflictError) throw error;
      app.status = 'unknown'; app.error = '提交结果待核验。请先查询测试站回执，勿重复点击提交。';
      event(state, '模拟提交结果待核验', error instanceof Error ? error.message.slice(0, 300) : app.error);
    }
    app.updatedAt = new Date().toISOString();
    return this.store.save(state, state.revision);
  }
  private async batchApplications(state: WorkspaceState, ids: string[], phase: 'fill' | 'submit'): Promise<WorkspaceState> {
    if (!ids.length || ids.length > MAX_BATCH_APPLICATIONS || new Set(ids).size !== ids.length) throw new WorkflowError('请选择 1 至 20 条不重复的模拟申请。');
    if (ids.some(id => !state.applications.some(application => application.id === id))) throw new WorkflowError('部分申请已不存在，请刷新后重新选择。', 404);
    let succeeded = 0, failed = 0, skipped = 0;
    for (const id of ids) {
      let step: { app: Application; resume: ResumeVersion };
      try { step = this.validateApplicationStep(state, id, phase); }
      catch (error) {
        if (!(error instanceof WorkflowError)) throw error;
        skipped++;
        const app = state.applications.find(application => application.id === id)!;
        event(state, '模拟批次跳过一项', `${app.company} · ${app.jobTitle}：${error.message}`);
        state = this.store.save(state, state.revision);
        continue;
      }
      state = phase === 'fill' ? await this.fillApplication(state, step.app, step.resume) : await this.submitApplication(state, step.app, step.resume);
      const status = state.applications.find(application => application.id === id)!.status;
      if (status === (phase === 'fill' ? 'filled' : 'confirmed')) succeeded++; else failed++;
    }
    event(state, `批量模拟${phase === 'fill' ? '填写' : '提交'}已处理`, `成功 ${succeeded}，${phase === 'fill' ? '未完成' : '待核验'} ${failed}，跳过 ${skipped}；每条结果已分别保存，未向真实企业投递。`);
    return this.store.save(state, state.revision);
  }
  private async prepareResume(resume: ResumeVersion): Promise<void> {
    const original = toResumeDocument(resume);
    delete resume.quality;
    if (!this.browser.prepareResume) {
      resume.quality = { status: 'not_checked', checkedAt: new Date().toISOString(), warnings: ['当前运行环境未执行 PDF 排版检查，请导出后检查页数与内容。'], adjustments: [] };
      return;
    }
    const prepared = await this.browser.prepareResume(structuredClone(resume));
    const document = resumeDocumentSchema.parse(prepared.document);
    if (resumeContent(document) !== resumeContent(original)) throw new WorkflowError('排版检查改变了简历正文，结果未保存；请重新生成。');
    if (prepared.quality.status === 'failed' || prepared.quality.textComplete === false || prepared.quality.overflow === true) {
      const reasons = [
        ...(prepared.quality.textComplete === false ? ['PDF 文字完整性检查未通过'] : []),
        ...(prepared.quality.overflow === true ? ['检测到内容溢出页面范围'] : []),
        ...prepared.quality.warnings.filter(warning => typeof warning === 'string').slice(0, 3).map(warning => warning.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 240)),
      ].filter(Boolean);
      throw new WorkflowError(`简历排版检查未通过，当前版本未保存：${[...new Set(reasons)].slice(0, 3).join('；') || '检查器未返回可保存的排版结果'}。请调整设计要求后重试。`);
    }
    resume.document = document;
    resume.quality = structuredClone(prepared.quality);
  }
  async act(action: ActionRequest): Promise<WorkspaceState> {
    if (this.busy) throw new WorkflowError('上一步还在执行，请稍后再操作。', 409);
    this.busy = true;
    try {
      const next = await this.execute(action);
      // Pending uploads are discarded only after the workspace CAS commits.
      // A storage failure or stale request must leave them available for retry.
      if (action.type === 'clear_profile' || action.type === 'clear_career_chat') this.attachments?.clear();
      if (action.type === 'career_chat') for (const id of action.attachmentIds || []) this.attachments?.remove(id);
      if (action.type === 'delete_application') {
        try { await this.browser.removeApplication?.(action.applicationId); }
        catch { console.warn('模拟投递记录已删除，但临时浏览器资源清理未完成。'); }
      }
      if (action.type === 'delete_resume') {
        try { await this.browser.removeResume?.(action.resumeId); }
        catch { console.warn('简历版本已删除，但临时预览缓存清理未完成。'); }
      }
      return next;
    } finally { this.busy = false; }
  }
  private async discoverCandidates(state: WorkspaceState, seeds: CompanyCandidate[]): Promise<void> {
    const exploration = state.exploration!;
    const old = new Map(exploration.companies.map(company => [company.id, company]));
    const directions = exploration.directions.filter(direction => exploration.selectedDirectionIds.includes(direction.id));
    let candidates = seeds;
    if (this.discover) {
      try {
        const profile = { ...state.profile, city: discoveryCity(state.profile, exploration.messages) };
        const result = await this.discover({ profile, directions, companies: seeds });
        const ids = new Set<string>();
        const found = result.candidates.filter(candidate => {
          if (ids.has(candidate.id) || candidate.id.length > 150 || !/^https:\/\//i.test(candidate.careerUrl)
            || !candidate.jobDescription || candidate.jobDescription.length < 10) return false;
          ids.add(candidate.id); return true;
        }).slice(0, 40);
        // An unsupported company remains a clearly labelled exploration card.
        candidates = [...found, ...seeds.filter(seed => !found.some(job => job.name === seed.name && job.industry === seed.industry))];
        exploration.jobSearch = { fetchedAt: result.fetchedAt, sources: result.sources };
      } catch {
        exploration.jobSearch = { fetchedAt: new Date().toISOString(), sources: [{ id: 'discovery', label: '公开岗位来源', status: 'error', count: 0, message: '岗位来源暂时不可用，已保留探索方向和已有选择，可稍后刷新。' }] };
      }
    }
    // Preserve decisions on refresh, including reviewed posts missing from this response.
    const nextIds = new Set(candidates.map(candidate => candidate.id));
    const retained = [...old.values()].filter(candidate => (candidate.selected || candidate.decision) && !nextIds.has(candidate.id)).map(candidate => ({
      ...candidate, hiringStatus: 'unverified' as const, sourceLabel: `${candidate.sourceLabel.replace(/（本次未重新获取）/g, '')}（本次未重新获取）`,
    }));
    exploration.companies = [...candidates, ...retained].map(candidate => {
      const previous = old.get(candidate.id);
      return { ...candidate, selected: previous?.selected || false, ...(previous?.decision ? { decision: previous.decision } : previous?.selected ? { decision: 'like' as const } : {}) };
    });
    exploration.swipeHistory = (exploration.swipeHistory || []).filter(entry => exploration.companies.some(candidate => candidate.id === entry.companyId));
    exploration.stage = 'companies';
  }
  private async execute(action: ActionRequest): Promise<WorkspaceState> {
    let state = this.store.read();
    if (action.expectedRevision !== state.revision) throw new ConflictError();
    syncCaptureDecisions(state);
    mergeCaptureCandidates(state);
    const getApp = (id: string) => {
      const app = state.applications.find(a => a.id === id);
      if (!app) throw new WorkflowError('未找到这次申请。', 404);
      return app;
    };
    switch (action.type) {
      case 'preview_resume_design': {
        const input = { name: action.name, instructions: action.instructions, preset: action.preset };
        const skill = this.engine.previewResumeDesign ? await this.engine.previewResumeDesign(input) : previewDesignDemo(input);
        state.resumeDesign!.preview = resumeDesignSkillSchema.parse(skill);
        event(state, '设计规范已解析', '请核对已识别与未支持要求，再保存使用；已有简历未修改。');
        break;
      }
      case 'clear_job': {
        resetResumeDesign(state);
        state.job = { company: '', title: '', text: '', url: '' };
        state.analysis = null;
        state.activeResumeId = null;
        state.interview = null;
        event(state, '当前岗位已移除', '仅清空当前准备工作区；来源岗位、喜欢状态、历史简历与模拟投递记录保留。');
        break;
      }
      case 'clear_profile': {
        resetResumeDesign(state);
        invalidateDraft(state);
        state.profile = emptyProfile();
        delete state.factOrganization;
        state.resumeImport = null;
        state.questions = [];
        const previous = state.exploration!;
        state.exploration = {
          messages: [], directions: [], selectedDirectionIds: [],
          companies: previous.companies.map(company => ({ ...company, rationale: '已保留岗位；请填写新档案后重新评估个人匹配情况。' })),
          swipeHistory: previous.swipeHistory || [],
          conversationPhase: 'explore', stage: previous.companies.length ? 'companies' : 'conversation',
        };
        // Current activity details can contain old personal context. Historical
        // resume/application snapshots are deliberately retained separately.
        state.events = [];
        event(state, '当前个人档案已删除', '岗位与喜欢/略过状态保留；历史简历及投递记录保留，旧简历和待处理模拟申请已失效。');
        break;
      }
      case 'save_resume_design': {
        const design = state.resumeDesign!;
        if (!design.preview) throw new WorkflowError('请先解析设计规范并检查预览，再保存。');
        if (design.skills.length >= 30) throw new WorkflowError('最多保存 30 份设计规范，请先删除不需要的规范。');
        const skill = structuredClone(design.preview);
        design.skills.push(skill); design.currentSkillId = skill.id;
        if (action.setDefault) design.defaultSkillId = skill.id;
        design.preview = null;
        event(state, '简历设计规范已保存', '新生成的简历可使用当前规范；已有简历保持原样。');
        break;
      }
      case 'select_resume_design': {
        const design = state.resumeDesign!;
        if (action.skillId && !design.skills.some(skill => skill.id === action.skillId)) throw new WorkflowError('未找到这份设计规范。', 404);
        design.currentSkillId = action.skillId;
        if (action.setDefault) design.defaultSkillId = action.skillId;
        event(state, '当前设计选择已更新', '已有简历保持原样；可生成新简历或将选择应用为新版本。');
        break;
      }
      case 'delete_resume_design': {
        const design = state.resumeDesign!;
        if (!design.skills.some(skill => skill.id === action.skillId)) throw new WorkflowError('未找到这份设计规范。', 404);
        design.skills = design.skills.filter(skill => skill.id !== action.skillId);
        if (design.defaultSkillId === action.skillId) design.defaultSkillId = null;
        if (design.currentSkillId === action.skillId) design.currentSkillId = design.defaultSkillId;
        event(state, '设计规范已删除', '已保存简历中的规范快照保留。');
        break;
      }
      case 'research_company': {
        const company = state.exploration?.companies.find(item => item.id === action.companyId && item.selected);
        if (!company) throw new WorkflowError('请先把岗位加入喜欢清单，再研究这家公司。');
        if (!this.research) throw new WorkflowError('公司研究尚未启用。');
        const previous = state.companyResearch?.[company.id];
        // Omitted links keep the saved choices; an explicit [] clears them.
        const userSourceUrls = [...new Set(action.sourceUrls ?? previous?.userSourceUrls ?? [])];
        const inputKey = createHash('sha256').update(JSON.stringify([company.name,company.role,company.careerUrl,company.jobDescription,company.hiringStatus,company.checkedAt,company.publishedAt,company.sourceKind,company.jdComplete,company.jdUserEdited,userSourceUrls])).digest('hex');
        const age = previous ? Date.now() - Date.parse(previous.generatedAt) : NaN;
        if (!action.refresh && previous?.status !== 'unavailable' && previous?.inputKey === inputKey && age >= 0 && age < 24 * 60 * 60 * 1000) {
          event(state, '已打开公司研究', '使用一天内保存的材料，可点击刷新重新核对来源。'); break;
        }
        const report = await this.research(company, userSourceUrls);
        state.companyResearch ??= {};
        state.companyResearch[company.id] = { ...report, inputKey, userSourceUrls };
        event(state, `${company.name}研究${report.status === 'unavailable' ? '暂未取得材料' : '已更新'}`, `${report.sources.length} 份来源、${report.findings.length} 条原文重点；研究资料与个人简历分别保存。`);
        break;
      }
      case 'load_example': {
        if (state.profile.experienceText || state.resumes.length) throw new WorkflowError('已有个人资料，示例不会覆盖你的内容。');
        state.profile = { ...exampleProfile, facts: [] };
        state.job = { ...exampleJob };
        state.questions = ['这是虚构示例资料。点击整理经历，再逐条审核事实。'];
        event(state, '载入示例', '示例人物与企业均为虚构，仅供审核产品流程。'); break;
      }
      case 'extract_profile': {
        const result = await this.engine.extractProfile(action.profile);
        invalidateDraft(state);
        state.profile = { ...action.profile, facts: result.facts.map(f => ({ ...f, confirmed: false })) };
        state.factOrganization = result.agentRun;
        state.questions = result.questions;
        event(state, '经历已整理', `${result.facts.length} 条事实等待逐条确认。`); break;
      }
      case 'accept_resume_import': {
        if (!state.resumeImport) throw new WorkflowError('请先上传并解析基础简历。');
        const result = await this.engine.extractProfile(action.profile);
        invalidateDraft(state);
        state.profile = { ...action.profile, facts: result.facts.map(f => ({ ...f, confirmed: false })) };
        state.factOrganization = result.agentRun;
        state.questions = result.questions; state.resumeImport = null;
        event(state, '基础简历已导入', '字段已自动填入，经历事实待确认；缺失信息可继续补充。'); break;
      }
      case 'discard_resume_import': {
        state.resumeImport = null; event(state, '导入预览已取消', '原有个人档案保持不变。'); break;
      }
      case 'preview_fact_split': {
        if (!state.profile.experienceText.trim()) throw new WorkflowError('请先保存经历原文，再检查分段。');
        const { facts, questions, agentRun } = this.engine.mode === 'live'
          ? await this.engine.extractProfile(state.profile)
          : { ...previewFactResegmentation(state.profile), agentRun: undefined };
        state.factPreview = { facts: facts.map(fact => ({ ...fact, confirmed: false })), questions, agentRun, sourceText: state.profile.experienceText, createdAt: new Date().toISOString() };
        break;
      }
      case 'discard_fact_split': { state.factPreview = null; break; }
      case 'apply_fact_split': {
        const preview = state.factPreview;
        if (!preview || preview.sourceText !== state.profile.experienceText) throw new WorkflowError('经历原文已变化，请重新检查分段。');
        invalidateDraft(state);
        state.profile.facts = preview.facts.map(fact => ({ ...fact, confirmed: false }));
        state.factOrganization = preview.agentRun;
        state.questions = preview.questions;
        event(state, '经历分段已更新', '已按经历边界重新整理，新事实待确认，历史简历快照保留。'); break;
      }
      case 'clear_career_chat': {
        const exploration = state.exploration!;
        exploration.messages = []; exploration.directions = []; exploration.selectedDirectionIds = [];
        exploration.conversationPhase = 'explore'; delete exploration.decisionSummary;
        exploration.stage = exploration.companies.length ? 'companies' : 'conversation';
        event(state, '方向聊天已清空', '已保存岗位、喜欢清单、个人事实与历史简历保留。'); break;
      }
      case 'finish_career_chat': {
        const exploration = state.exploration!;
        if (!exploration.directions.length || exploration.profileStale) throw new WorkflowError('请先获取基于当前资料的方向建议。');
        exploration.conversationPhase = 'ready';
        exploration.decisionSummary ||= '探索已结束。选择想进一步了解的方向，下一步查找真实公司与岗位。';
        break;
      }
      case 'career_chat': {
        const supplied = action.attachmentIds?.length ? this.attachments?.resolve(action.attachmentIds) : undefined;
        if (action.attachmentIds?.length && !supplied) throw new WorkflowError('当前服务无法读取附件，请重新上传。');
        if (!state.profile.experienceText && !state.profile.major && !supplied) throw new WorkflowError('请先导入基础简历，或补充专业与经历，也可以上传文件开始对话。');
        const exploration = state.exploration!;
        const profileWasStale = !!exploration.profileStale;
        const messages = [...exploration.messages, { role: 'user' as const, content: action.message, ...(supplied ? { attachments: supplied.meta } : {}) }].slice(-80);
        const result = await this.career.chat(state.profile, messages.slice(-24), exploration.profileStale ? [] : exploration.directions, { attachments: supplied?.context, forceReady: exploration.conversationPhase === 'ready' });
        const priorSelected = exploration.directions.filter(direction => exploration.selectedDirectionIds.includes(direction.id));
        exploration.messages = [...messages, { role: 'assistant', content: result.message, sources: result.sources, searchWarning: result.searchWarning }];
        exploration.conversationPhase = result.conversationPhase || (result.directions.length ? 'compare' : 'explore');
        exploration.decisionSummary = result.decisionSummary;
        exploration.directions = result.directions; exploration.profileStale = false;
        const retainedIds = priorSelected.map(previous => result.directions.find(direction => direction.industry === previous.industry && direction.role === previous.role)?.id).filter((id): id is string => !!id);
        if (profileWasStale || retainedIds.length !== priorSelected.length) {
          exploration.selectedDirectionIds = [];
          exploration.companies = profileWasStale ? [] : exploration.companies.filter(company => company.selected || company.decision === 'like');
          exploration.swipeHistory = []; delete exploration.jobSearch;
        }
        else exploration.selectedDirectionIds = retainedIds;
        exploration.stage = exploration.companies.length ? 'companies' : result.directions.length ? 'directions' : 'conversation';
        event(state, '方向探索已更新', '行业与岗位分别比较，候选方向等待用户选择。'); break;
      }
      case 'select_directions': {
        const exploration = state.exploration!;
        if (exploration.profileStale) throw new WorkflowError('经历已更新，请先继续对话重新评估方向。');
        const ids = [...new Set(action.directionIds)];
        if (ids.some(id => !exploration.directions.some(d => d.id === id))) throw new WorkflowError('方向清单已变化，请重新选择。');
        if (JSON.stringify(ids) !== JSON.stringify(exploration.selectedDirectionIds)) {
          // A new search direction must not discard the user's saved shortlist.
          exploration.companies = exploration.companies.filter(company => company.selected || company.decision === 'like');
          exploration.swipeHistory = []; delete exploration.jobSearch;
        }
        exploration.selectedDirectionIds = ids; exploration.stage = 'directions';
        event(state, '探索方向已选择', `已选 ${ids.length} 个行业与岗位组合。`); break;
      }
      case 'recommend_companies': {
        const exploration = state.exploration!;
        if (exploration.profileStale || !exploration.selectedDirectionIds.length) throw new WorkflowError('请先对话并选择你想探索的行业与岗位方向。');
        const directions = exploration.directions.filter(d => exploration.selectedDirectionIds.includes(d.id));
        const seeds = await this.career.recommendCompanies(state.profile, directions, exploration.messages);
        await this.discoverCandidates(state, seeds);
        exploration.conversationPhase = 'ready';
        if (!seeds.length) {
          const notice = companyCoverageNotice(directions);
          exploration.jobSearch ||= { fetchedAt: new Date().toISOString(), sources: [] };
          exploration.jobSearch.sources.push({ id: 'company-directory', label: '公司探索目录', status: 'unsupported', count: 0, message: notice });
        }
        event(state, '岗位卡片已生成', '左滑跳过、右滑喜欢。公开岗位与待核验探索方向分别标注，喜欢不会自动投递。'); break;
      }
      case 'refresh_jobs': {
        const exploration = state.exploration!;
        if (exploration.profileStale || !exploration.selectedDirectionIds.length) throw new WorkflowError('请先对话并选择行业与岗位方向。');
        const directions = exploration.directions.filter(direction => exploration.selectedDirectionIds.includes(direction.id));
        // Refresh sources without spending another model request on company ranking.
        const seeds = await createCareerEngine({}).recommendCompanies(state.profile, directions, exploration.messages);
        await this.discoverCandidates(state, seeds);
        event(state, '公开岗位已刷新', '保留已喜欢的岗位和滑卡选择；本次未重新获取的收藏标为待核验。'); break;
      }
      case 'swipe_company': {
        const exploration = state.exploration!;
        if (exploration.profileStale && !state.browserCaptures?.[action.companyId]) throw new WorkflowError('经历已更新，请先重新评估方向。');
        const company = exploration.companies.find(candidate => candidate.id === action.companyId);
        if (!company) throw new WorkflowError('岗位卡片已变化，请刷新后重新选择。', 404);
        if (company.decision === action.decision && company.selected === (action.decision === 'like')) break;
        (exploration.swipeHistory ??= []).push({ companyId: company.id, previousDecision: company.decision, previousSelected: company.selected });
        exploration.swipeHistory = exploration.swipeHistory.slice(-200);
        company.decision = action.decision; company.selected = action.decision === 'like';
        break;
      }
      case 'undo_company_swipe': {
        const exploration = state.exploration!;
        const history = exploration.swipeHistory ??= [];
        if (exploration.profileStale && !state.browserCaptures?.[history.at(-1)?.companyId || '']) throw new WorkflowError('经历已更新，请先重新评估方向。');
        const entry = history.pop();
        if (!entry) throw new WorkflowError('还没有可以撤销的选择。');
        const company = exploration.companies.find(candidate => candidate.id === entry.companyId);
        if (!company) throw new WorkflowError('岗位卡片已变化，请刷新后重新选择。');
        company.selected = entry.previousSelected;
        if (entry.previousDecision) company.decision = entry.previousDecision;
        else delete company.decision;
        break;
      }
      case 'select_companies': {
        const exploration = state.exploration!;
        if (action.companyIds.some(id => !exploration.companies.some(c => c.id === id))) throw new WorkflowError('公司清单已变化，请重新选择。');
        if (exploration.profileStale) throw new WorkflowError('经历已更新，请先重新评估方向。');
        exploration.companies.forEach(company => {
          const selected = action.companyIds.includes(company.id);
          if (selected || company.selected) company.decision = selected ? 'like' : 'dislike';
          company.selected = selected;
        });
        exploration.swipeHistory = [];
        event(state, '目标公司已确认', `已选 ${action.companyIds.length} 个公司与岗位方向；尚未执行投递。`); break;
      }
      case 'open_company':
      case 'activate_company': {
        const exploration = state.exploration!;
        if (exploration.profileStale && !state.browserCaptures?.[action.companyId]) throw new WorkflowError('经历已更新，请先重新评估方向。');
        const company = exploration.companies.find(c => c.id === action.companyId && c.selected);
        if (!company) throw new WorkflowError('请先右滑喜欢这个岗位，再从喜欢清单中进入简历。');
        if (!sameTargetJob(state.job, { company: company.name, title: company.role, candidateId: company.id })) resetResumeDesign(state);
        const previous = state.resumes.findLast(r => !r.scope && !r.stale && r.job.candidateId === company.id);
        const savedJob = state.companyJobs?.[company.id];
        const officialJob: Job | undefined = company.jobDescription ? candidateJob(company) : undefined;
        const captured = state.browserCaptures?.[company.id];
        if (action.type === 'open_company') {
          state.job = structuredClone((captured ? captureJob(captured) : undefined) || savedJob || candidateJob(company));
          state.analysis = null;
          state.activeResumeId = previous && jobContent(previous.job) === jobContent(state.job) ? previous.id : null;
          event(state, '已打开岗位简历工作区', `${company.name} · ${company.role}`);
          break;
        }
        requireCompleteCapture(state, company.id);
        if (!state.profile.facts.some(f => f.confirmed)) throw new WorkflowError('请先确认至少一条经历事实，再制作简历。');
        state.job = structuredClone((captured ? captureJob(captured) : undefined) || savedJob || officialJob || previous?.job || { company: company.name, title: company.role, industry: company.industry, roleFamily: company.role, url: company.careerUrl, sourceKind: 'exploration', candidateId: company.id,
          text: `行业：${company.industry}\n岗位探索方向：${company.role}\n以下是求职准备参考，不是该企业发布的真实招聘要求。\n${company.requirements.join('\n')}\n${company.rationale}\n具体职位、工作地点、资格要求及薪资需以招聘官网当前信息核实。` });
        state.analysis = await this.engine.analyzeJob(state.profile, state.job);
        if (state.job.sourceKind === 'exploration') state.analysis.summary = `方向探索参考，尚未核验真实在招 JD。${state.analysis.summary}`;
        if (previous && jobContent(previous.job) === jobContent(state.job)) state.activeResumeId = previous.id;
        else await this.generateResume(state);
        event(state, '已切换目标公司', `${company.name} · ${company.role}。其他公司的简历仍保留。`); break;
      }
      case 'update_fact': {
        const fact = state.profile.facts.find(f => f.id === action.factId);
        if (!fact) throw new WorkflowError('未找到该条事实。', 404);
        if (fact.text !== action.text) fact.source = `${fact.source}\n用户修订：${action.text}`;
        fact.text = action.text; fact.confirmed = action.confirmed;
        invalidateDraft(state);
        event(state, action.confirmed ? '事实已确认' : '事实待复核', action.text.slice(0, 160)); break;
      }
      case 'save_job': {
        const captured = action.job.candidateId ? state.browserCaptures?.[action.job.candidateId] : undefined;
        let nextJob: Job = { ...action.job, sourceKind: 'user_jd' as const, sourceLabel: '手动添加 JD', jdComplete: true };
        if (captured) {
          const priorText = captureJob(captured).text;
          const prefix = priorText.endsWith(captured.fields.jd) ? priorText.slice(0, priorText.length - captured.fields.jd.length) : '';
          const jd = prefix && action.job.text.startsWith(prefix) ? action.job.text.slice(prefix.length) : action.job.text;
          applyCaptureEdits(captured, { company: action.job.company, title: action.job.title, jd, jdComplete: true, ...(action.job.industry !== undefined ? { industry: action.job.industry } : {}) }, new Date().toISOString());
          nextJob = captureJob(captured);
        }
        if (!captured && nextJob.candidateId && !state.exploration?.companies.some(c => c.id === nextJob.candidateId && c.name === nextJob.company)) delete nextJob.candidateId;
        if (nextJob.candidateId) (state.companyJobs ??= {})[nextJob.candidateId] = structuredClone(nextJob);
        if (!sameTargetJob(state.job, nextJob)) resetResumeDesign(state);
        state.analysis = null; state.job = nextJob;
        const invalidatedIds = new Set<string>();
        for (const resume of state.resumes) if (resumeTargets(resume).some(job => sameTargetJob(job, nextJob) && jobContent(job) !== jobContent(nextJob))) { resume.stale = true; invalidatedIds.add(resume.id); }
        for (const app of state.applications) if (invalidatedIds.has(app.resumeId) && ['prepared', 'filled'].includes(app.status)) { app.status = 'failed'; app.error = '该岗位资料已更新，请重新生成并审核简历。'; app.updatedAt = new Date().toISOString(); }
        state.activeResumeId = state.resumes.findLast(r => !r.scope && !r.stale && sameTargetJob(r.job, nextJob))?.id || null;
        event(state, '目标岗位已保存', `${state.job.company} · ${state.job.title}`); break;
      }
      case 'save_browser_capture': {
        const captured = state.browserCaptures?.[action.captureId];
        if (!captured) throw new WorkflowError('未找到这个浏览器导入岗位。', 404);
        const edits = captureEditsSchema.parse(action.edits);
        const next = { ...captured.fields, ...edits };
        if (next.jdComplete && next.jd.trim().length < 10) throw new WorkflowError('完整 JD 至少需要 10 个字符；列表摘要请标为详情待补充。');
        applyCaptureEdits(captured, edits, new Date().toISOString());
        invalidateChangedCapture(state, captured.id);
        event(state, '导入岗位修订已保存', '原始采集内容保留，后续重复导入不会覆盖这些手动修订。'); break;
      }
      case 'analyze_job': {
        requireCompleteCapture(state);
        if (!state.job.text.trim()) throw new WorkflowError('请先保存目标岗位和招聘要求。');
        if (!state.profile.facts.some(f => f.confirmed)) throw new WorkflowError('请先确认至少一条经历事实。');
        state.analysis = await this.engine.analyzeJob(state.profile, state.job);
        event(state, '岗位分析已完成', '匹配依据与待核实条件已分别列出。'); break;
      }
      case 'generate_resume': {
        await this.generateResume(state); break;
      }
      case 'generate_general_resume': {
        await this.generateResume(state, { kind: 'general', name: action.name, focus: action.focus, targetJobs: [] }); break;
      }
      case 'generate_multi_resume': {
        let targetJobs: Job[];
        try { targetJobs = resolveResumeTargets(state, action.candidateIds, action.includeCurrentJob, { requireComplete: true }); }
        catch (error) { throw new WorkflowError(error instanceof Error ? error.message : '无法读取所选岗位。'); }
        if (targetJobs.length < 2 || targetJobs.length > MAX_SHARED_RESUME_JOBS) throw new WorkflowError('一份多个岗位的简历需要选择 2 至 8 个不同的具体岗位。');
        if (targetJobs.reduce((length, job) => length + job.text.length, 0) > 48000) throw new WorkflowError('所选岗位 JD 合计超过 48000 字，请减少岗位数量；不会截断招聘要求。');
        await this.generateResume(state, { kind: 'multi', name: action.name, focus: action.focus, targetJobs }); break;
      }
      case 'save_resume_edit': {
        const resume = currentResume(state, action.resumeId);
        const document = resumeDocumentSchema.parse({ ...action.document, ...(action.document.design ? {} : resume.document?.design ? { design: resume.document.design } : {}) });
        const edited = createEditedVersion(state, resume, document, action.profile, { authoredBy: 'user', message: '已保存网页编辑，原版保留；请审核这一版简历。' });
        await this.prepareResume(edited);
        event(state, '简历编辑已保存', '手动编辑生成了待审核的新版本，不覆盖已投递材料。'); break;
      }
      case 'chat_resume_edit': {
        const resume = currentResume(state, action.resumeId);
        const result = await this.career.editResume(resume, action.message);
        const document = resumeDocumentSchema.parse(preserveEditedDesign(toResumeDocument(resume), result.document, action.message));
        validateModelEdit(resume, document);
        if (JSON.stringify(document) === JSON.stringify(toResumeDocument(resume))) {
          resume.editMessages = [...(resume.editMessages || []), { role: 'user' as const, content: action.message }, { role: 'assistant' as const, content: result.message }].slice(-30);
          state.activeResumeId = resume.id;
        } else {
          const { facts: _facts, ...profile } = resume.profile;
          const edited = createEditedVersion(state, resume, document, profile, { authoredBy: 'model', message: result.message, instruction: action.message, reviewNotes: result.reviewNotes });
          edited.generation = { mode: this.engine.mode, model: this.engine.model };
          await this.prepareResume(edited);
          event(state, '对话修改已生成', '修改已保存为新版本，请核对表述及事实后审核。');
        }
        break;
      }
      case 'apply_resume_design': {
        const resume = currentResume(state, action.resumeId);
        const skill = state.resumeDesign?.skills.find(item => item.id === state.resumeDesign?.currentSkillId);
        if (!skill) throw new WorkflowError('请先选择一份已保存的设计规范。');
        const document = applyDesignSkill(toResumeDocument(resume), skill);
        const { facts: _facts, ...profile } = resume.profile;
        const edited = createEditedVersion(state, resume, document, profile, { authoredBy: 'user', message: '已应用设计规范，正文和事实引用保持不变。', reviewNotes: ['本次仅调整排版，仍需审核新版本的分页与阅读效果。'] });
        edited.designSkill = structuredClone(skill);
        await this.prepareResume(edited);
        event(state, '设计规范已应用', '已另存新版本，正文与事实引用保持不变；原简历保留。');
        break;
      }
      case 'approve_resume': {
        const resume = currentResume(state, action.resumeId);
        resume.approved = true;
        event(state, `简历 V${resume.version} 已确认`, '本次确认绑定当前岗位和经历快照。'); break;
      }
      case 'delete_resume': {
        const resume = state.resumes.find(item => item.id === action.resumeId);
        if (!resume) throw new WorkflowError('未找到这版简历。', 404);
        if (state.applications.some(application => application.resumeId === resume.id)) throw new WorkflowError('这版简历仍有关联的模拟投递记录，请先删除对应投递记录，再删除简历。', 409);
        if (this.browser.resumeInUse?.(resume.id)) throw new WorkflowError('这版简历仍有关联的真实网申记录，请先删除对应真实网申记录，再删除简历。', 409);
        state.resumes = state.resumes.filter(item => item.id !== resume.id);
        if (state.activeResumeId === resume.id) state.activeResumeId = null;
        if (state.interview?.resumeId === resume.id) state.interview = null;
        event(state, `简历 V${resume.version} 已删除`, '只删除此版本；当前档案、岗位和其他简历版本保留。');
        break;
      }
      case 'prepare_application': {
        const resume = this.validateApplicationResume(state, action.resumeId);
        if (resume.scope) throw new WorkflowError('通用或多岗位简历需要明确选择实际投递岗位，请使用批量模拟申请的岗位选择入口。');
        if (!this.prepareApplication(state, resume, resume.job)) throw new WorkflowError('该企业岗位已有申请记录，请处理现有申请，避免重复投递。');
        break;
      }
      case 'prepare_applications': {
        const resume = this.validateApplicationResume(state, action.resumeId);
        let targets: Job[];
        try { targets = resolveResumeTargets(state, action.candidateIds, action.includeCurrentJob); }
        catch (error) { throw new WorkflowError(error instanceof Error ? error.message : '无法读取所选岗位。'); }
        let prepared = 0, skipped = 0;
        for (const target of targets) {
          if (this.prepareApplication(state, resume, target)) {
            prepared++;
            state = this.store.save(state, state.revision);
          } else skipped++;
        }
        event(state, '批量模拟申请已准备', `新增 ${prepared}，已有有效申请而跳过 ${skipped}；仅本机模拟，不会投递真实企业。`);
        break;
      }
      case 'fill_application': {
        const step = this.validateApplicationStep(state, action.applicationId, 'fill');
        return this.fillApplication(state, step.app, step.resume);
      }
      case 'fill_applications': {
        return this.batchApplications(state, action.applicationIds, 'fill');
      }
      case 'submit_application': {
        if (!action.confirmed) throw new WorkflowError('请先填写并核对表单，再明确确认提交。');
        const step = this.validateApplicationStep(state, action.applicationId, 'submit');
        return this.submitApplication(state, step.app, step.resume);
      }
      case 'submit_applications': {
        if (!action.confirmed) throw new WorkflowError('请先核对全部模拟表单，再明确确认批量提交。');
        return this.batchApplications(state, action.applicationIds, 'submit');
      }
      case 'verify_application': {
        const app = getApp(action.applicationId);
        if (!['unknown', 'submitting', 'confirmed'].includes(app.status)) throw new WorkflowError('只有提交后的申请需要核验结果。');
        const receipt = this.store.receipt(app.id);
        if (receipt) { app.status = 'confirmed'; app.receipt = receipt; app.error = undefined; }
        else { app.status = 'failed'; app.error = '本地测试站确认没有接收记录，可以重新填写。'; }
        app.updatedAt = new Date().toISOString();
        event(state, '模拟申请核验完成', receipt ? `测试站回执：${receipt}` : '本地测试站无接收记录。'); break;
      }
      case 'delete_application': {
        const app = getApp(action.applicationId);
        if (!app.simulated) throw new WorkflowError('这里只能删除本机模拟投递记录。');
        if (app.status === 'submitting') throw new WorkflowError('这次模拟投递仍在提交中，请等待完成或核验结果后再删除。', 409);
        state.applications = state.applications.filter(item => item.id !== app.id);
        event(state, '模拟投递记录已删除', '已删除所选本机记录并撤销其测试站授权；关联简历和其他投递记录保留。');
        break;
      }
      case 'start_interview': {
        const resume = state.resumes.find(r => r.id === action.resumeId);
        if (!resume || !resume.approved) throw new WorkflowError('请选择一份已确认的简历。');
        const content = await this.engine.interview(resume, []);
        state.interview = { resumeId: resume.id, messages: [{ role: 'assistant', content }] };
        event(state, '面试练习已开始', `基于 ${resume.job.title} · 简历 V${resume.version}。`); break;
      }
      case 'answer_interview': {
        if (!state.interview) throw new WorkflowError('请先开始一次面试练习。');
        if (state.interview.messages.length >= 40) throw new WorkflowError('本轮练习已达 20 次回答，请重新开始一轮练习。');
        const resume = state.resumes.find(r => r.id === state.interview!.resumeId)!;
        const messages = [...state.interview.messages, { role: 'user' as const, content: action.answer }];
        const content = await this.engine.interview(resume, messages);
        state.interview.messages = [...messages, { role: 'assistant', content }]; break;
      }
    }
    syncCaptureDecisions(state);
    mergeCaptureCandidates(state);
    return this.store.save(state, state.revision);
  }
}
