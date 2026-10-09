import { z } from 'zod';
import { resumeDesignSpecSchema } from '../shared/resume-design.ts';
import { isTrustedCaptureLogo, normalizeCaptureUrl } from './browser-capture.ts';
const short = z.string().trim().max(200);
const id = z.string().uuid();
export const profileSchema = z.object({
  name: short.max(80), email: short.max(160), phone: short.max(40), school: short.max(160), education: z.enum(['', '本科', '硕士', '博士', '专科', '其他']), major: short.optional(),
  graduation: short.max(80), city: short.max(100), availability: short.max(120), targetRole: short,
  experienceText: z.string().trim().min(1, '请先填写经历。').max(30000)
});
export const jobSchema = z.object({ company: short.min(1), title: short.min(1), text: z.string().trim().min(10).max(16000), url: z.string().trim().max(2000), location: short.optional(), industry: short.optional(), roleFamily: short.optional(), sourceKind: z.enum(['user_jd', 'exploration', 'official_job', 'jobspy', 'browser_capture', 'public_job']).optional(), sourceLabel: short.optional(), candidateId: short.optional(), jdComplete: z.boolean().optional() });
const captureFieldsShape = { company: z.string().max(200), title: z.string().max(200), city: z.string().max(120), salary: z.string().max(200), education: z.string().max(200), experience: z.string().max(200), jd: z.string().max(16000), jdComplete: z.boolean(), industry: z.string().max(200).optional() };
export const captureEditsSchema = z.object(captureFieldsShape).partial().strict();
const captureFieldsSchema = z.object({ ...captureFieldsShape, logoUrl: z.string().max(2000).url().refine(value => { try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port; } catch { return false; } }, 'Logo 必须是 HTTPS 地址。').optional() }).strict();
// Incoming imports only. Historical records retain their original platform in Store.
export const captureBatchSchema = z.object({
  protocolVersion: z.literal(1), requestId: z.string().uuid(), jobs: z.array(z.object({
    platform: z.literal('boss', { error: '当前仅支持 BOSS直聘岗位导入。' }), sourceUrl: z.string().max(2000), capturedAt: z.string().datetime({ offset: true }).refine(value => Date.parse(value) <= Date.now() + 5 * 60 * 1000, '采集时间不能在未来。'),
    pageKind: z.enum(['detail', 'list', 'manual']), fields: captureFieldsSchema, edits: captureEditsSchema.optional()
  }).strict().superRefine((job, context) => {
    try { normalizeCaptureUrl(job.platform, job.sourceUrl); } catch (error) { context.addIssue({ code: 'custom', path: ['sourceUrl'], message: error instanceof Error ? error.message : '岗位链接无效。' }); }
    if (job.fields.logoUrl && !isTrustedCaptureLogo(job.platform, job.fields.logoUrl)) context.addIssue({ code: 'custom', path: ['fields', 'logoUrl'], message: 'Logo 仅接受来源平台公开图片域中的地址；不可靠的 Logo 请留空。' });
    const effective = { ...job.fields, ...job.edits };
    if (effective.jdComplete && effective.jd.trim().length < 10) context.addIssue({ code: 'custom', path: ['fields', 'jdComplete'], message: '完整 JD 至少需要 10 个字符；列表摘要请标为详情待补充。' });
  })).min(1).max(20)
}).strict();
export const resumeDocumentSchema = z.object({
  headline: z.string().trim().max(200), summary: z.string().trim().max(2000),
  theme: z.enum(['modern', 'classic']), accent: z.enum(['forest', 'navy', 'plum', 'ink']), design: resumeDesignSpecSchema.optional(),
  sections: z.array(z.object({ id: z.string().min(1).max(100), title: z.string().trim().min(1).max(100), items: z.array(z.object({ id: z.string().min(1).max(100), title: z.string().max(200), subtitle: z.string().max(200), date: z.string().max(100), content: z.string().max(5000), factIds: z.array(z.string().min(1).max(100)).max(40) })).max(30) })).min(1).max(12)
}).superRefine((doc, context) => {
  if (doc.sections.reduce((sum, section) => sum + section.items.reduce((n, item) => n + item.content.length, 0), 0) > 20000) context.addIssue({ code: 'custom', message: '简历正文请控制在 20000 字以内。' });
  const ids = [...doc.sections.map(s => s.id), ...doc.sections.flatMap(s => s.items.map(i => i.id))];
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', message: '简历段落标识不能重复。' });
});
const revision = { expectedRevision: z.number().int().nonnegative() };
const resumeScopeInput = { name: z.string().trim().min(1).max(80), focus: z.string().trim().max(2000) };
const candidateIds = z.array(z.string().min(1).max(150)).max(20).refine(ids => new Set(ids).size === ids.length, '岗位不能重复。');
const applicationIds = z.array(id).min(1).max(20).refine(ids => new Set(ids).size === ids.length, '申请编号不能重复。');
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('load_example'), ...revision }),
  z.object({ type: z.literal('clear_profile'), ...revision }).strict(),
  z.object({ type: z.literal('clear_job'), ...revision }).strict(),
  z.object({ type: z.literal('preview_resume_design'), name: z.string().trim().min(1).max(80), instructions: z.string().trim().max(12000), preset: z.enum(['clean', 'compact', 'classic']), ...revision }).strict(),
  z.object({ type: z.literal('save_resume_design'), setDefault: z.boolean(), ...revision }).strict(),
  z.object({ type: z.literal('select_resume_design'), skillId: id.nullable(), setDefault: z.boolean().optional(), ...revision }).strict(),
  z.object({ type: z.literal('delete_resume_design'), skillId: id, ...revision }).strict(),
  z.object({ type: z.literal('apply_resume_design'), resumeId: id, ...revision }).strict(),
  z.object({ type: z.literal('extract_profile'), profile: profileSchema, ...revision }),
  z.object({ type: z.literal('accept_resume_import'), profile: profileSchema, ...revision }),
  z.object({ type: z.literal('discard_resume_import'), ...revision }),
  z.object({ type: z.literal('career_chat'), message: z.string().trim().min(1).max(4000), attachmentIds: z.array(z.string().uuid()).max(3).optional(), ...revision }),
  z.object({ type: z.literal('clear_career_chat'), ...revision }),
  z.object({ type: z.literal('finish_career_chat'), ...revision }),
  z.object({ type: z.literal('preview_fact_split'), ...revision }),
  z.object({ type: z.literal('apply_fact_split'), ...revision }),
  z.object({ type: z.literal('discard_fact_split'), ...revision }),
  z.object({ type: z.literal('select_directions'), directionIds: z.array(z.string().min(1).max(100)).min(1).max(4), ...revision }),
  z.object({ type: z.literal('recommend_companies'), ...revision }),
  z.object({ type: z.literal('select_companies'), companyIds: z.array(z.string().min(1).max(150)).max(20), ...revision }),
  z.object({ type: z.literal('swipe_company'), companyId: z.string().min(1).max(150), decision: z.enum(['like', 'dislike']), ...revision }),
  z.object({ type: z.literal('undo_company_swipe'), ...revision }),
  z.object({ type: z.literal('refresh_jobs'), ...revision }),
  z.object({ type: z.literal('research_company'), companyId: z.string().min(1).max(150), refresh: z.boolean().optional(), sourceUrls: z.array(z.string().trim().url().max(2000).refine(value => value.startsWith('https://'), '研究来源请使用 HTTPS 链接。')).max(3).optional(), ...revision }),
  z.object({ type: z.literal('activate_company'), companyId: z.string().min(1).max(150), ...revision }),
  z.object({ type: z.literal('open_company'), companyId: z.string().min(1).max(150), ...revision }),
  z.object({ type: z.literal('update_fact'), factId: z.string().min(1).max(100), text: z.string().trim().min(1).max(3000), confirmed: z.boolean(), ...revision }),
  z.object({ type: z.literal('save_job'), job: jobSchema, ...revision }),
  z.object({ type: z.literal('save_browser_capture'), captureId: z.string().min(1).max(150), edits: captureEditsSchema, ...revision }),
  z.object({ type: z.literal('analyze_job'), ...revision }),
  z.object({ type: z.literal('generate_resume'), ...revision }),
  z.object({ type: z.literal('generate_general_resume'), ...resumeScopeInput, ...revision }).strict(),
  z.object({ type: z.literal('generate_multi_resume'), ...resumeScopeInput, candidateIds, includeCurrentJob: z.boolean().optional(), ...revision }).strict(),
  z.object({ type: z.literal('save_resume_edit'), resumeId: id, document: resumeDocumentSchema, profile: profileSchema, ...revision }),
  z.object({ type: z.literal('chat_resume_edit'), resumeId: id, message: z.string().trim().min(1).max(4000), ...revision }),
  z.object({ type: z.literal('approve_resume'), resumeId: id, ...revision }),
  z.object({ type: z.literal('delete_resume'), resumeId: id, ...revision }).strict(),
  z.object({ type: z.literal('prepare_application'), resumeId: id, ...revision }),
  z.object({ type: z.literal('prepare_applications'), resumeId: id, candidateIds, includeCurrentJob: z.boolean().optional(), ...revision }).strict(),
  z.object({ type: z.literal('fill_application'), applicationId: id, ...revision }),
  z.object({ type: z.literal('fill_applications'), applicationIds, ...revision }).strict(),
  z.object({ type: z.literal('submit_application'), applicationId: id, confirmed: z.literal(true), ...revision }),
  z.object({ type: z.literal('submit_applications'), applicationIds, confirmed: z.literal(true), ...revision }).strict(),
  z.object({ type: z.literal('verify_application'), applicationId: id, ...revision }),
  z.object({ type: z.literal('delete_application'), applicationId: id, ...revision }).strict(),
  z.object({ type: z.literal('start_interview'), resumeId: id, ...revision }),
  z.object({ type: z.literal('answer_interview'), answer: z.string().trim().min(1).max(4000), ...revision })
]);
export const sandboxSubmitSchema = z.object({
  applicationId: id, token: z.string().length(64),
  fields: z.object({ name: short, email: short, phone: short, school: short, education: short, graduation: short, city: short, availability: short, experience: z.string().max(20000) }),
  resumeName: z.string().max(100), resumeData: z.string().min(1).max(4 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/), consent: z.literal(true)
});
