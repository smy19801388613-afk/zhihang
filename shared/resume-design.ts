import { z } from 'zod';

export const resumeDesignSpecSchema = z.object({
  fontFamily: z.enum(['sans', 'serif']),
  bodyFontPt: z.number().min(10).max(12),
  lineHeight: z.number().min(1.35).max(1.8),
  marginMm: z.number().min(12).max(22),
  sectionGapPx: z.number().min(6).max(18),
  itemGapPx: z.number().min(4).max(14),
  educationPosition: z.enum(['first', 'last']),
  pageGoal: z.union([z.literal('auto'), z.literal(1), z.literal(2)]),
  headingStyle: z.enum(['line', 'plain']),
}).strict();
export type ResumeDesignSpec = z.infer<typeof resumeDesignSpecSchema>;
export type ResumeDesignPreset = 'clean' | 'compact' | 'classic';
export const DEFAULT_RESUME_DESIGN: ResumeDesignSpec = {
  fontFamily: 'sans', bodyFontPt: 10.5, lineHeight: 1.5, marginMm: 17,
  sectionGapPx: 14, itemGapPx: 10, educationPosition: 'first', pageGoal: 'auto', headingStyle: 'line',
};
export const DESIGN_PRESETS: Record<ResumeDesignPreset, { name: string; description: string; theme: 'modern' | 'classic'; accent: 'forest' | 'navy' | 'plum' | 'ink'; design: ResumeDesignSpec }> = {
  clean: { name: '清晰通用', description: '简洁单栏，突出经历与成果', theme: 'modern', accent: 'navy', design: { ...DEFAULT_RESUME_DESIGN } },
  compact: { name: '紧凑一页', description: '收紧留白，优先尝试一页', theme: 'modern', accent: 'ink', design: { ...DEFAULT_RESUME_DESIGN, lineHeight: 1.4, marginMm: 14, sectionGapPx: 10, itemGapPx: 6, pageGoal: 1 } },
  classic: { name: '经典正式', description: '居中页眉，黑白印刷友好', theme: 'classic', accent: 'ink', design: { ...DEFAULT_RESUME_DESIGN, fontFamily: 'serif', headingStyle: 'plain' } },
};
export const resumeDesignSkillSchema = z.object({
  id: z.string().min(1).max(100), name: z.string().min(1).max(80), version: z.number().int().positive(),
  instructions: z.string().max(12000), preset: z.enum(['clean', 'compact', 'classic']),
  design: resumeDesignSpecSchema, theme: z.enum(['modern', 'classic']), accent: z.enum(['forest', 'navy', 'plum', 'ink']),
  recognized: z.array(z.string().max(500)).max(30), unsupported: z.array(z.string().max(500)).max(30),
  mode: z.enum(['demo', 'live']), model: z.string().optional(), createdAt: z.string(),
}).strict();
export type ResumeDesignSkill = z.infer<typeof resumeDesignSkillSchema>;
export interface ResumeDesignState {
  skills: ResumeDesignSkill[]; currentSkillId: string | null; defaultSkillId: string | null; preview: ResumeDesignSkill | null;
}
export interface ResumeQualityReport {
  status: 'passed' | 'warning' | 'failed' | 'not_checked'; checkedAt: string;
  pageCount?: number; textComplete?: boolean; overflow?: boolean;
  warnings: string[]; adjustments: string[]; engine?: 'chromium'; contentHash?: string;
}
