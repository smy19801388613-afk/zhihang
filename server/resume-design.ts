import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DESIGN_PRESETS, resumeDesignSpecSchema, type ResumeDesignPreset, type ResumeDesignSkill, type ResumeDesignSpec } from '../shared/resume-design.ts';
import type { ResumeDocument } from '../shared/types.ts';

export type DesignInput = { name: string; instructions: string; preset: ResumeDesignPreset };
export const designPlanSchema = z.object({
  design: resumeDesignSpecSchema, theme: z.enum(['modern', 'classic']), accent: z.enum(['forest', 'navy', 'plum', 'ink']),
  recognized: z.array(z.string().trim().min(1).max(500)).max(30), unsupported: z.array(z.string().trim().min(1).max(500)).max(30),
}).strict();
export type DesignPlan = z.infer<typeof designPlanSchema>;
export function designSnapshot(input: DesignInput, plan: DesignPlan, mode: 'demo' | 'live', model: string): ResumeDesignSkill {
  return { id: randomUUID(), name: input.name, version: 1, instructions: input.instructions, preset: input.preset, ...designPlanSchema.parse(plan), mode, model, createdAt: new Date().toISOString() };
}

/** Deliberately small offline grammar; never evaluates Markdown, code or URLs. */
export function previewDesignDemo(input: DesignInput): ResumeDesignSkill {
  const preset = DESIGN_PRESETS[input.preset];
  const plan: DesignPlan = { design: structuredClone(preset.design), theme: preset.theme, accent: preset.accent, recognized: [`已选择“${preset.name}”预设。`], unsupported: ['规则演示仅识别明确的字体、配色、位置与数值要求；未使用模型理解自由文本。'] };
  const clauses = input.instructions.split(/[，,。；;\n]/u);
  const negative = /不要|不使用|不采用|无需|禁止|不把|不将|不放|不改/u;
  const instruction = clauses.filter(clause => !negative.test(clause)).join('\n');
  if (clauses.some(clause => negative.test(clause))) plan.unsupported.push('含否定要求的句子未由规则演示自动应用，请在参数预览中核对。');
  const adopt = (pattern: RegExp, text: string, update: () => void) => { if (pattern.test(instruction)) { update(); plan.recognized.push(text); } };
  adopt(/(?:使用|采用|改为|字体[:：]?)\s*(?:无衬线|sans)/iu, '使用无衬线字体。', () => { plan.design.fontFamily = 'sans'; });
  adopt(/(?:使用|采用|改为|字体[:：]?)\s*(?:衬线|serif)/iu, '使用衬线字体。', () => { plan.design.fontFamily = 'serif'; });
  adopt(/(?:使用|采用|改为|配色[:：]?)\s*(?:黑白|纯黑|黑色|ink)|黑白配色/iu, '使用黑白配色。', () => { plan.accent = 'ink'; });
  adopt(/(?:使用|采用|改为|配色[:：]?)\s*(?:海军蓝|深蓝|navy)/iu, '使用海军蓝配色。', () => { plan.accent = 'navy'; });
  adopt(/(?:使用|采用|改为|配色[:：]?)\s*(?:森林绿|绿色|forest)/iu, '使用森林绿配色。', () => { plan.accent = 'forest'; });
  adopt(/(?:使用|采用|改为|配色[:：]?)\s*(?:梅紫|紫色|plum)/iu, '使用梅紫配色。', () => { plan.accent = 'plum'; });
  adopt(/教育(?:背景|经历)?(?:放在|置于|移到|放到|放)?(?:最后|底部|后面|末尾)/u, '教育背景放在最后。', () => { plan.design.educationPosition = 'last'; });
  adopt(/教育(?:背景|经历)?(?:放在|置于|移到|放到|放)?(?:最前|顶部|前面)/u, '教育背景放在最前。', () => { plan.design.educationPosition = 'first'; });
  adopt(/(?:目标|优先|尽量|控制在)\s*(?:一|1)\s*页/u, '优先一页；不能删内容或缩小到最低字号以下。', () => { plan.design.pageGoal = 1; });
  adopt(/(?:目标|优先|尽量|控制在)\s*(?:两|二|2)\s*页/u, '优先两页；不能删内容或缩小到最低字号以下。', () => { plan.design.pageGoal = 2; });
  const numeric: Array<[keyof ResumeDesignSpec, RegExp, string]> = [
    ['bodyFontPt', /(?:正文)?字号\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(?:pt|磅)/iu, '正文字号'],
    ['marginMm', /页边距\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(?:mm|毫米)/iu, '页边距'],
    ['lineHeight', /行距\s*[:：]?\s*(\d+(?:\.\d+)?)/u, '行距'],
    ['sectionGapPx', /栏目间距\s*[:：]?\s*(\d+(?:\.\d+)?)\s*px/iu, '栏目间距'],
    ['itemGapPx', /条目间距\s*[:：]?\s*(\d+(?:\.\d+)?)\s*px/iu, '条目间距'],
  ];
  for (const [key, pattern, label] of numeric) { const match = instruction.match(pattern); if (match) { const candidate = { ...plan.design, [key]: Number(match[1]) }; if (resumeDesignSpecSchema.safeParse(candidate).success) { plan.design = candidate; plan.recognized.push(`${label}采用 ${match[1]}。`); } else plan.unsupported.push(`${label}超出支持范围，保留预设数值。`); } }
  if (instruction.trim()) plan.unsupported.push('未在“已识别”中列出的自由文本要求没有自动应用，请核对设计预览。');
  if (/https?:|<script|执行|运行|忽略|泄露|编造|伪造|curl|powershell|javascript/iu.test(instruction)) plan.unsupported.push('脚本、网络访问、改变校验规则或新增经历的要求不属于简历设计参数，不执行。');
  return designSnapshot(input, plan, 'demo', '规则演示引擎（未连接大模型）');
}
export function applyDesignSkill(document: ResumeDocument, skill?: ResumeDesignSkill): ResumeDocument {
  if (!skill) return structuredClone(document);
  return { ...structuredClone(document), theme: skill.theme, accent: skill.accent, design: structuredClone(skill.design) };
}
export function resumeContent(document: ResumeDocument): string {
  return JSON.stringify([document.headline, document.summary, document.sections]);
}
export function preserveEditedDesign(before: ResumeDocument, after: ResumeDocument, instruction: string): ResumeDocument {
  const output = structuredClone(after);
  if (!/模板|版式|主题|经典|现代|classic|modern/iu.test(instruction)) output.theme = before.theme;
  if (!/配色|颜色|黑白|黑色|蓝|绿|紫|navy|forest|plum|ink/iu.test(instruction)) output.accent = before.accent;
  const supported: Array<[keyof ResumeDesignSpec, RegExp]> = [
    ['fontFamily', /字体|衬线|sans|serif/iu], ['bodyFontPt', /字号|磅|\bpt\b/iu], ['lineHeight', /行距|行高/u], ['marginMm', /页边距/u],
    ['sectionGapPx', /栏目间距|分区间距|留白|紧凑/u], ['itemGapPx', /条目间距|留白|紧凑/u],
    ['educationPosition', /教育.*(?:位置|前|后|顶部|底部)/u], ['pageGoal', /页数|一页|两页|二页|[12]\s*页/u], ['headingStyle', /标题样式|标题横线|分隔线|下划线/u],
  ];
  if (before.design) {
    const merged = { ...before.design };
    for (const [key, pattern] of supported) if (pattern.test(instruction) && after.design) Object.assign(merged, { [key]: after.design[key] });
    output.design = merged;
  } else if (!supported.some(([, pattern]) => pattern.test(instruction))) delete output.design;
  return output;
}
