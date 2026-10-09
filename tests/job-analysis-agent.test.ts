import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import type { Job, Profile } from '../shared/types.ts';
import { createJobAgentFixture, numberJobText, runJobAnalysisAgent, type JobAgentRequester, type JobReview, type JobUnderstanding } from '../server/job-analysis-agent.ts';

const profile: Profile = { name: '虚构私密姓名', email: 'private@example.invalid', phone: '13800001234', school: '不应发出的学校字段', education: '本科', major: '法学', graduation: '2027.06', city: '上海', availability: '每周四天，连续三个月', targetRole: '商谈类工作', experienceText: '尚未确认的完整简历正文应保留在本机。', facts: [
  { id: 'negotiation', text: '在学生社团外联中，分别听取赞助方和活动主办方的诉求，让双方接受同一份合作方案。', source: '不应发送的原始材料', confirmed: true },
  { id: 'course', text: '课程项目中检索公开政策并整理比较表，完成课程研究报告。', sourceContext: '政策分析课程｜参与成员', source: '原始课程资料', confirmed: true },
  { id: 'negative', text: '没有企业工作经验，未通过法律职业资格考试。', source: '用户确认', confirmed: true },
  { id: 'missing', text: '尚未提供英语考试成绩。', source: '用户确认', confirmed: true },
  { id: 'pending', text: '待确认秘密：独立带领百人团队。', source: '用户未确认', confirmed: false },
] };
const job = (text: string): Job => ({ company: '虚构公司', title: '合作专员', text, url: '', industry: '互联网' });
const sourceQuote = (input: Job, text: string) => {
  const source = numberJobText(input.text).find(source => source.text.includes(text));
  assert.ok(source, `missing synthetic quote ${text}`); return { sourceId: source.id, quote: text };
};
function understanding(input: Job, items: Array<{ quote: string; requirement: string; category: JobUnderstanding['requirements'][number]['category'] }>): JobUnderstanding {
  return { roleOverview: { text: '岗位核心是理解业务需求并推进工作。', sources: [sourceQuote(input, items[0]?.quote || input.text.split('\n')[0])] }, coreTasks: [], requirements: items.map((item, index) => ({ id: `req_${index + 1}`, requirement: item.requirement, category: item.category, sources: [sourceQuote(input, item.quote)] })) };
}
function reviewed(data: any, changes: Partial<JobReview> = {}) { return createJobAgentFixture(data, changes) as JobReview; }
function matching(item: JobUnderstanding['requirements'][number], changes: Partial<JobReview['requirements'][number]> = {}): JobReview['requirements'][number] {
  return structuredClone({ ...item, evidenceState: 'unknown', transferability: 'none', evidence: '资料中尚未确认该能力，需要核对，不能据此断言没有。', gap: '需要补充真实资料。', evidenceRefs: [], ...changes });
}
function provider(callback: (data: any, index: number) => unknown) {
  const calls: any[] = [];
  const request: JobAgentRequester = async <T>(_instruction: string, data: unknown, schema: z.ZodType<T>) => {
    calls.push(structuredClone(data)); return schema.parse(await callback(data, calls.length));
  };
  request.model = 'synthetic-agent'; return { request, calls };
}

test('numbered JD is lossless and both agent phases see marketing, mixed paragraphs, blank lines and tail', async () => {
  const input = job('欢迎加入，福利丰厚。\r\n\n沟通双方诉求，硕士优先但并非硬性要求。\n末尾：必须持有有效工作许可。');
  assert.equal(numberJobText(input.text).map(source => source.text).join(''), input.text);
  const draft = understanding(input, [{ quote: '沟通双方诉求', requirement: '理解各方需求', category: 'responsibility' }]);
  const mock = provider(data => data.phase === 'understand' ? draft : reviewed(data, {
    requirements: [matching(draft.requirements[0]), matching({ id: 'req_2', requirement: '硕士学历属于优先条件', category: 'preferred', sources: [sourceQuote(input, '硕士优先但并非硬性要求')] }), matching({ id: 'req_3', requirement: '需要有效工作许可', category: 'required', sources: [sourceQuote(input, '必须持有有效工作许可')] })],
  }));
  const result = await runJobAnalysisAgent(profile, input, mock.request);
  assert.equal(mock.calls.length, 2);
  for (const call of mock.calls) assert.equal(call.sources.map((source: { text: string }) => source.text).join(''), input.text);
  assert.deepEqual(result.matches.map(item => item.category), ['responsibility', 'preferred', 'required']);
  assert.doesNotMatch(result.matches.map(item => item.requirement).join(''), /福利/u);
  assert.equal(result.agentRun?.reviewed, true); assert.equal(result.agentRun?.model, 'synthetic-agent');
});

test('semantic cross-role transfer survives without keyword overlap and has an explicit limit', async () => {
  const input = job('核心职责：促成多方就合作方案达成一致，并跟进落地。');
  const draft = understanding(input, [{ quote: '促成多方就合作方案达成一致', requirement: '推动多方形成合作共识', category: 'responsibility' }]);
  const mock = provider(data => data.phase === 'understand' ? draft : reviewed(data, { requirements: [matching(draft.requirements[0], {
    evidenceState: 'partial', transferability: 'transferable', evidence: '社团外联中听取双方诉求并推动共同接受方案，可迁移到合作共识形成；商业条件与落地管理仍需核验。', gap: '尚未证明商业合同落地经验。',
    evidenceRefs: [{ kind: 'fact', id: 'negotiation', quote: '让双方接受同一份合作方案', relation: 'supports' }],
  })] }));
  const result = await runJobAnalysisAgent(profile, input, mock.request);
  assert.equal(result.matches[0].evidenceState, 'partial'); assert.equal(result.matches[0].transferability, 'transferable');
  assert.deepEqual(result.matches[0].factIds, ['negotiation']); assert.match(result.matches[0].evidence, /共识/u);
  assert.equal(result.matches[0].requirement, '推动多方形成合作共识');
  assert.deepEqual(result.matches[0].sourceQuotes, ['促成多方就合作方案达成一致']);
  assert.ok(!input.text.includes(result.matches[0].requirement), 'Paraphrase is separate from the exact JD quote');
});

test('review can remove false degree gates and distinguish course-method transfer from real company work', async () => {
  const input = job('公司介绍：团队成员均为博士。\n职责：检索政策并形成研究建议。\n岗位要求：有企业政策研究工作经历。');
  const draft = understanding(input, [{ quote: '团队成员均为博士', requirement: '必须博士学历', category: 'required' }]);
  const corrected = understanding(input, [{ quote: '检索政策并形成研究建议', requirement: '研究政策并提出建议', category: 'responsibility' }, { quote: '有企业政策研究工作经历', requirement: '具备企业政策研究经历', category: 'capability' }]);
  const mock = provider(data => data.phase === 'understand' ? draft : reviewed(data, {
    ...corrected, requirements: [matching(corrected.requirements[0], { evidenceState: 'partial', transferability: 'transferable', evidence: '课程项目有政策检索与比较方法，可迁移到研究任务，但不等于企业场景中的独立建议。', gap: '企业实务与独立交付待核实。', evidenceRefs: [{ kind: 'fact', id: 'course', quote: '课程项目中检索公开政策并整理比较表', relation: 'supports' }] }), matching(corrected.requirements[1], { evidenceState: 'unmet', evidence: '已确认资料明确没有企业工作经验，课程研究不替代企业经历。', gap: '目前没有企业工作经历。', evidenceRefs: [{ kind: 'fact', id: 'negative', quote: '没有企业工作经验', relation: 'contradicts' }] })],
  }));
  const result = await runJobAnalysisAgent(profile, input, mock.request);
  assert.deepEqual(result.matches.map(item => item.evidenceState), ['partial', 'unmet']);
  assert.doesNotMatch(JSON.stringify(result.matches), /博士/u);
  assert.match(result.matches[0].evidence, /课程.*不等于企业/u);
});

test('missing documents cannot become unmet and a single repair can correct the diagnosis', async () => {
  const input = job('岗位要求：能够用英语开展工作。');
  const draft = understanding(input, [{ quote: '能够用英语开展工作', requirement: '用英语开展工作', category: 'capability' }]);
  const mock = provider(data => data.phase === 'understand' ? draft : reviewed(data, { requirements: [matching(draft.requirements[0], data.repair ? {} : { evidenceState: 'unmet', evidence: '尚未提供考试成绩。', gap: '需要核实语言能力。', evidenceRefs: [{ kind: 'fact', id: 'missing', quote: '尚未提供英语考试成绩', relation: 'contradicts' }] })] }));
  const result = await runJobAnalysisAgent(profile, input, mock.request);
  assert.equal(result.matches[0].evidenceState, 'unknown'); assert.equal(result.agentRun?.passes, 3);
  assert.equal(mock.calls[2].repair.code, 'unsubstantiated_unmet');
});

test('fabricated job quotes, fabricated numbers, pending facts, and fake fields cannot pass grounding', async () => {
  const input = job('需要沟通协作经验。');
  const draft = understanding(input, [{ quote: '沟通协作经验', requirement: '沟通协作', category: 'capability' }]);
  for (const kind of ['quote', 'number', 'pending', 'field'] as const) {
    const mock = provider(data => {
      if (data.phase === 'understand') return draft;
      const item = matching(draft.requirements[0]);
      if (kind === 'quote') item.sources[0] = { sourceId: 'jd_1', quote: '要求博士及以上' };
      if (kind === 'number') item.requirement = '具备8年沟通经验';
      if (kind === 'pending') item.evidenceRefs = [{ kind: 'fact', id: 'pending', quote: profile.facts.at(-1)!.text, relation: 'supports' }];
      if (kind === 'field') item.evidenceRefs = [{ kind: 'profile', id: '__proto__', quote: '任意引用', relation: 'supports' }];
      return reviewed(data, { requirements: [item] });
    });
    const expected = { quote: /invalid_job_quote/u, number: /unsupported_number/u, pending: /invalid_personal_quote/u, field: /invalid_personal_quote/u };
    await assert.rejects(runJobAnalysisAgent(profile, input, mock.request), expected[kind]);
    assert.ok(mock.calls.length <= 3);
  }
});

test('supported matches require evidence but synonymous confirmed facts are accepted as direct support', async () => {
  const input = job('倾听利益相关方诉求并推动达成共识。');
  const draft = understanding(input, [{ quote: '倾听利益相关方诉求并推动达成共识', requirement: '理解诉求并形成共识', category: 'capability' }]);
  const mock = provider(data => data.phase === 'understand' ? draft : reviewed(data, { requirements: [matching(draft.requirements[0], { evidenceState: 'supported', transferability: 'direct', evidence: '外联经历体现了听取双方诉求并形成共同方案，支撑该通用方法能力。', gap: '', evidenceRefs: [{ kind: 'fact', id: 'negotiation', quote: '分别听取赞助方和活动主办方的诉求，让双方接受同一份合作方案', relation: 'supports' }] })] }));
  assert.equal((await runJobAnalysisAgent(profile, input, mock.request)).matches[0].status, 'supported');
});

test('understanding can use one repair and review cannot request a fourth call', async () => {
  const input = job('职责：核对资料。');
  const mock = provider((_data, index) => index === 1 || index === 3 ? {} : createJobAgentFixture(_data));
  await assert.rejects(runJobAnalysisAgent(profile, input, mock.request), /有限修复已用完/u);
  assert.equal(mock.calls.length, 3); assert.equal(mock.calls[1].phase, 'understand'); assert.equal(mock.calls[2].phase, 'review');
});

test('controlled schema paths reach the single format repair without leaking raw values or exceeding three calls', async () => {
  const mock = provider((data, index) => {
    if (index === 1) throw Object.assign(new Error('private raw output must stay out of repair'), {
      code: 'invalid_json', schemaIssues: [
        { path: '$.requirements[0].category', code: 'invalid_value' },
        { path: '$.[private-email@example.invalid]', code: 'invalid_type' },
        { path: '$.privateUnrecognizedField', code: 'invalid_type' },
      ],
    });
    return createJobAgentFixture(data);
  });
  const result = await runJobAnalysisAgent(profile, job('职责：核对资料。'), mock.request);
  assert.equal(mock.calls.length, 3); assert.equal(result.agentRun?.passes, 3);
  assert.deepEqual(mock.calls[1].repair.schemaIssues, [{ path: '$.requirements[0].category', code: 'invalid_value' }]);
  assert.match(mock.calls[1].repair.message, /\$\.requirements\[0\]\.category: invalid_value/u);
  assert.equal(mock.calls[1].phase, 'understand'); assert.equal(mock.calls[2].phase, 'review');
  assert.equal(mock.calls[2].repair, undefined);
  assert.doesNotMatch(JSON.stringify(mock.calls), /private raw output|private-email|privateUnrecognizedField/u);
});

test('network, authentication, timeout and truncation never trigger a repair call', async () => {
  for (const code of ['network', 'authentication', 'timeout', 'truncated']) {
    let calls = 0;
    const request: JobAgentRequester = async () => { calls++; throw Object.assign(new Error('controlled provider failure'), { code }); };
    await assert.rejects(runJobAnalysisAgent(profile, job('负责资料整理。'), request), /controlled provider failure/u);
    assert.equal(calls, 1);
  }
});

test('tail omission in review coverage must be repaired and no paragraph is silently dropped', async () => {
  const input = job('职责：处理资料。\n福利：五险一金。\n必须持有有效工作许可。');
  const mock = provider(data => {
    const result = createJobAgentFixture(data);
    if (data.phase === 'review' && !data.repair) (result as JobReview).coverage.pop();
    return result;
  });
  const result = await runJobAnalysisAgent(profile, input, mock.request);
  assert.equal(result.agentRun?.passes, 3); assert.equal(mock.calls[2].repair.code, 'incomplete_review');
});

test('review can recognize duplicated requirement paragraphs without citing both copies', async () => {
  const input = job('职责：处理资料。\n职责：处理资料。');
  const draft = understanding(input, [{ quote: '处理资料', requirement: '整理并处理资料', category: 'responsibility' }]);
  const mock = provider(data => data.phase === 'understand' ? draft : reviewed(data, { coverage: data.sources.map((source: { id: string }) => ({ sourceId: source.id, treatment: 'requirements', reason: '重复职责，已合并为同一项。' })) }));
  const result = await runJobAnalysisAgent(profile, input, mock.request);
  assert.equal(result.matches.length, 1); assert.equal(result.agentRun?.passes, 2);
});

test('the reviewing agent can discard unrestricted experience instead of preserving a mechanical hard gate', async () => {
  const input = job('学历要求：本科\n经验要求：经验不限\n职责：处理资料。');
  const draft = understanding(input, [{ quote: '本科', requirement: '本科学历', category: 'required' }, { quote: '经验不限', requirement: '没有经验限制', category: 'required' }, { quote: '处理资料', requirement: '整理并处理资料', category: 'responsibility' }]);
  const mock = provider(data => data.phase === 'understand' ? draft : reviewed(data, { requirements: draft.requirements.filter(item => item.id !== 'req_2').map(item => matching(item)) }));
  const result = await runJobAnalysisAgent(profile, input, mock.request);
  assert.equal(result.matches.filter(item => item.category === 'required').length, 1);
  assert.doesNotMatch(JSON.stringify(result.matches), /经验不限|没有经验限制/u);
  assert.ok(mock.calls.every(call => call.sources.some((source: { text: string }) => source.text.includes('经验不限'))), 'Both agents still read the unfiltered original');
});

test('whole-paragraph non-restrictions become cited context with a transparent warning and no repair call', async () => {
  for (const unrestricted of ['经验要求：经验不限', '学历要求：学历不限']) {
    const input = job(`${unrestricted}\n职责：处理资料。\n经验不限，但须持有有效工作许可。`);
    const draft = understanding(input, [
      { quote: unrestricted, requirement: '没有学历或经验限制', category: 'required' },
      { quote: '处理资料', requirement: '整理资料', category: 'responsibility' },
      { quote: '经验不限，但须持有有效工作许可', requirement: '持有有效工作许可', category: 'required' },
    ]);
    const mock = provider(data => data.phase === 'understand' ? draft : reviewed(data, { requirements: draft.requirements.filter(item => !data.repair || item.id !== 'req_1').map(item => matching(item)) }));
    const result = await runJobAnalysisAgent(profile, input, mock.request);
    assert.equal(mock.calls.length, 2); assert.equal(result.agentRun?.passes, 2);
    assert.deepEqual(result.matches.map(item => item.requirement), ['整理资料', '持有有效工作许可']);
    assert.deepEqual(result.contextNotes, [{ note: unrestricted, sourceQuotes: [unrestricted] }]);
    assert.ok(result.agentRun?.warnings.some(warning => warning.includes('透明展示校正')));
    assert.ok(mock.calls[1].sources.some((source: { text: string }) => source.text.includes(unrestricted)), 'Non-restriction is still in the complete original context');
  }
});

test('clipped non-restriction citations cannot hide a true gate from the same original paragraph', async () => {
  const input = job('经验不限，但须持有有效工作许可。');
  const draft = understanding(input, [{ quote: '经验不限', requirement: '经验没有限制', category: 'required' }]);
  const corrected = understanding(input, [{ quote: '但须持有有效工作许可', requirement: '持有有效工作许可', category: 'required' }]);
  const mock = provider(data => data.phase === 'understand' ? draft : reviewed(data, { requirements: (data.repair ? corrected : draft).requirements.map(item => matching(item)) }));
  const result = await runJobAnalysisAgent(profile, input, mock.request);
  assert.equal(mock.calls.length, 3); assert.equal(mock.calls[2].repair.code, 'non_limiting_condition');
  assert.equal(result.contextNotes, undefined); assert.equal(result.matches[0].requirement, '持有有效工作许可');
});

test('normalization never masks a fabricated source ID or a quote missing from the cited paragraph', async () => {
  const input = job('学历要求：本科。');
  const draft = understanding(input, [{ quote: '本科', requirement: '本科学历', category: 'required' }]);
  const mock = provider(data => data.phase === 'understand' ? draft : reviewed(data, { requirements: [matching({ id: 'req_1', requirement: '没有学历限制', category: 'required', sources: [{ sourceId: 'jd_1', quote: '学历不限' }] })] }));
  await assert.rejects(runJobAnalysisAgent(profile, input, mock.request), /invalid_job_quote/u);
  assert.equal(mock.calls.length, 3);
});

test('a bare unspecified scope cannot be relabelled as education or experience context', async () => {
  const input = job('不限');
  const draft = understanding(input, [{ quote: '不限', requirement: '适用范围未明确限定', category: 'responsibility' }]);
  const mock = provider(data => data.phase === 'understand' ? draft : reviewed(data));
  const result = await runJobAnalysisAgent(profile, input, mock.request);
  assert.equal(mock.calls.length, 2); assert.equal(result.contextNotes, undefined);
  assert.equal(result.matches.length, 1); assert.deepEqual(result.agentRun?.warnings, []);
});

test('private fields, raw sources and pending experiences are absent from both requests', async () => {
  const personal = structuredClone(profile);
  personal.facts[0].text += ` 联系${profile.name}：${profile.phone}，${profile.email}`;
  const mock = provider(data => createJobAgentFixture(data));
  await runJobAnalysisAgent(personal, job('职责：处理资料。'), mock.request);
  for (const call of mock.calls) {
    const sent = JSON.stringify(call);
    for (const secret of [profile.name, profile.phone, profile.email, profile.school, profile.experienceText, profile.facts.at(-1)!.text, profile.facts[0].source]) assert.ok(!sent.includes(secret));
  }
  assert.equal(mock.calls[0].profile, undefined);
  assert.equal(mock.calls[1].facts.length, profile.facts.filter(fact => fact.confirmed).length);
});

test('confirmed experience scope and parent hierarchy reach only review with contact details redacted', async () => {
  const personal = structuredClone(profile);
  personal.facts[0].experience = {
    id: 'campus-child', kind: 'campus', title: `外联协商子项目 ${profile.name}`,
    parentId: 'campus-parent', parentTitle: `社团活动 ${profile.email}`,
    role: `参与成员 ${profile.phone}`, date: '2026.01',
  };
  personal.facts.at(-1)!.experience = { id: 'pending-work', kind: 'work', title: '尚未确认的企业负责人经历' };
  const mock = provider(data => createJobAgentFixture(data));
  await runJobAnalysisAgent(personal, job('职责：推进合作。'), mock.request);
  assert.equal(mock.calls[0].facts, undefined);
  const facts = mock.calls[1].facts;
  const scope = facts.find((fact: { id: string }) => fact.id === 'negotiation').experience;
  assert.equal(scope.kind, 'campus');
  assert.equal(scope.id, 'campus-child'); assert.equal(scope.parentId, 'campus-parent');
  assert.match(scope.title, /外联协商子项目/u); assert.match(scope.parentTitle, /社团活动/u);
  assert.match(scope.role, /参与成员/u); assert.equal(scope.date, '2026.01');
  assert.equal(facts.find((fact: { id: string }) => fact.id === 'course').experience, undefined, 'Legacy facts remain compatible');
  const sent = JSON.stringify(mock.calls);
  for (const secret of [profile.name, profile.email, profile.phone, '尚未确认的企业负责人经历', 'pending-work']) assert.ok(!sent.includes(secret));
});

test('objective degree mismatch cannot be supported, while the model may correct it to a quoted contradiction', async () => {
  const input = job('岗位要求：硕士及以上学历。');
  const draft = understanding(input, [{ quote: '硕士及以上学历', requirement: '硕士及以上', category: 'required' }]);
  const mock = provider(data => data.phase === 'understand' ? draft : reviewed(data, { requirements: [matching(draft.requirements[0], { evidenceState: data.repair ? 'unmet' : 'supported', transferability: 'none', evidence: data.repair ? '目前填写为本科，与硕士及以上条件不符。' : '具备学历资料。', gap: data.repair ? '当前学历低于该门槛。' : '', evidenceRefs: [{ kind: 'profile', id: 'education', quote: '本科', relation: data.repair ? 'contradicts' : 'supports' }] })] }));
  const result = await runJobAnalysisAgent(profile, input, mock.request);
  assert.equal(result.matches[0].evidenceState, 'unmet'); assert.deepEqual(result.matches[0].profileFields, ['education']);
});

test('model-extracted salary and location preserve exact currency units and never become ability gaps', async () => {
  const input = job('地点：上海、杭州\n薪资：USD 30–40/hour\n职责：处理合作事项。');
  const draft = understanding(input, [{ quote: '处理合作事项', requirement: '推进合作事项', category: 'responsibility' }]);
  draft.metadata = { location: { value: '上海、杭州', sources: [sourceQuote(input, '地点：上海、杭州')] }, salary: { value: 'USD 30–40/hour', sources: [sourceQuote(input, '薪资：USD 30–40/hour')] } };
  const mock = provider(data => data.phase === 'understand' ? draft : reviewed(data));
  const result = await runJobAnalysisAgent(profile, input, mock.request);
  assert.equal(result.metadata?.salary, 'USD 30–40/hour'); assert.equal(result.metadata?.location, '上海、杭州');
  assert.doesNotMatch(JSON.stringify(result.matches), /USD|上海|杭州/u);
});

test('explicit attendance and graduation conflicts can be unmet with exact profile citations', async () => {
  const personal = { ...profile, availability: '每周三天，连续两个月', graduation: '2027.06' };
  const input = job('每周至少四天，连续三个月。\n仅限2026届毕业生。');
  const draft = understanding(input, [{ quote: '每周至少四天，连续三个月', requirement: '达到指定出勤和持续时间', category: 'required' }, { quote: '仅限2026届毕业生', requirement: '毕业届别符合限制', category: 'required' }]);
  const mock = provider(data => data.phase === 'understand' ? draft : reviewed(data, { requirements: draft.requirements.map((item, index) => matching(item, { evidenceState: 'unmet', evidence: index ? '填写的毕业年份与指定届别不同。' : '填写的每周到岗天数和连续时间均低于最低要求。', gap: '当前资料与明确限制不符，需要先核对。', evidenceRefs: [{ kind: 'profile', id: index ? 'graduation' : 'availability', quote: index ? '2027.06' : '每周三天，连续两个月', relation: 'contradicts' }] })) }));
  const result = await runJobAnalysisAgent(personal, input, mock.request);
  assert.deepEqual(result.matches.map(item => item.evidenceState), ['unmet', 'unmet']);
  assert.equal(mock.calls.length, 2);
});
