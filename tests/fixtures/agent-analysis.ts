import type { AgentRun, Fact, JobAnalysis, WorkspaceState } from '../../shared/types.ts';
import { emptyState } from '../../server/store.ts';

// Entirely fictional fixture; it is never loaded from a user's workspace.
export function agentAnalysisFixture(): WorkspaceState {
  const state = emptyState();
  const agentRun: AgentRun = { version: 1, kind: 'experience', model: 'synthetic-model', reviewed: true, passes: 2, warnings: ['职责范围仍需本人核对。'] };
  const parent: Fact = { id: 'parent', text: '在校园迎新服务项目中，整理咨询记录并协调不同服务点的信息口径。', source: '校园迎新服务改进｜项目成员。整理咨询记录，协调服务点的信息口径。', sourceQuotes: ['整理咨询记录，协调服务点的信息口径。'], experience: { id: 'welcome', title: '校园迎新服务改进', kind: 'campus', role: '项目成员', date: '2025.09—2025.10' }, confirmed: true };
  const child: Fact = { id: 'child', text: '在迎新项目下整理常见问题，搭建 FAQ 检索原型，并根据同学试用反馈改进分类。', source: '迎新服务项目包含 FAQ 检索原型。整理常见问题，按主题分类，根据试用反馈调整。', sourceQuotes: ['迎新服务项目包含 FAQ 检索原型。', '整理常见问题，按主题分类，根据试用反馈调整。'], experience: { id: 'faq', title: 'FAQ 检索原型', parentId: 'welcome', parentTitle: '校园迎新服务改进', kind: 'project', role: '原型制作', date: '2025.10' }, reviewNote: '请核对原型是否由你独立完成；当前未写入独立负责或量化成果。', confirmed: true };
  state.profile = { ...state.profile, name: '合成测试者', school: '合成大学', education: '本科', major: '信息管理', graduation: '2027.06', availability: '每周 3 天', city: '北京', experienceText: [parent.source, child.source].join('\n'), facts: [parent, child] };
  state.factOrganization = agentRun;
  state.factPreview = { facts: [{ ...child, id: 'preview', confirmed: false }], questions: [], sourceText: state.profile.experienceText, createdAt: '2026-10-06T08:00:00Z', agentRun };
  state.job = { company: '合成科技服务公司', title: '用户研究实习生', industry: '科技服务', text: '负责整理用户反馈和分类。协助访谈并形成研究摘要。本科及以上学历，每周到岗四天。具备独立研究经验优先。', url: 'https://example.com/jobs/synthetic', sourceKind: 'user_jd', jdComplete: true };
  state.analysis = {
    summary: '可迁移资料整理能力，但需核对到岗时间和研究方法。',
    roleOverview: '这个岗位把零散用户反馈转成可用于产品改进的信息，日常工作包括反馈分类、访谈协助和研究摘要整理。',
    coreTasks: [{ task: '整理用户反馈，形成便于团队查阅的主题分类。', sourceQuotes: ['负责整理用户反馈和分类。'] }, { task: '协助访谈，将观察结果写成研究摘要。', sourceQuotes: ['协助访谈并形成研究摘要。'] }],
    applicationAdvice: { recommendation: 'clarify_first', reason: '已有信息整理和反馈分类的可迁移能力，但到岗安排与招聘要求存在差异，需要先沟通清楚。', strengths: ['有整理真实咨询记录与主题分类的经历。', '能用原型呈现信息，并据反馈调整。'], gaps: ['目前每周可到岗三天，岗位要求四天。', '现有材料未体现完整的用户访谈和研究设计过程。'], nextSteps: ['先确认是否能调整到岗安排。', '准备一份 FAQ 分类示例，说明分类逻辑和反馈改进过程。'] },
    agentRun: { ...agentRun, kind: 'job_analysis', warnings: ['建议仅依据这份 JD 和已确认经历，不代表招聘方结论。'] },
    matches: [
      { requirement: '每周到岗四天', category: 'required', sourceQuotes: ['每周到岗四天。'], evidence: '个人资料填写每周三天，与岗位要求有差异。', status: 'missing', evidenceState: 'unmet', factIds: [], profileFields: ['availability'], transferability: 'none', gap: '先确认到岗安排能否调整。' },
      { requirement: '整理信息与反馈分类', category: 'capability', sourceQuotes: ['负责整理用户反馈和分类。'], evidence: '迎新项目中的信息整理与主题分类可以迁移，但还不等同于商业用户研究经验。', status: 'partial', evidenceState: 'partial', factIds: ['child'], transferability: 'transferable', gap: '补充分类方式和一次实际改进的过程。' },
      { requirement: '独立研究经验优先', category: 'preferred', sourceQuotes: ['具备独立研究经验优先。'], evidence: '材料未说明是否独立完成研究。', status: 'missing', evidenceState: 'unknown', factIds: [], transferability: 'none' },
      { requirement: '整理反馈记录', category: 'responsibility', sourceQuotes: ['负责整理用户反馈和分类。'], evidence: '已确认经历中直接包含咨询记录整理。', status: 'supported', evidenceState: 'supported', factIds: ['parent'], transferability: 'direct' },
    ],
    directionAdvice: ['面试时说明已有经历的范围，再解释可以迁移的工作方法。'], questions: [], metadata: { industry: '科技服务', location: '北京', salary: '未披露' },
  } satisfies JobAnalysis;
  return state;
}
