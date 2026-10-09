import assert from 'node:assert/strict';
import test from 'node:test';
import type { Profile, ResumeDocument, ResumeVersion } from '../shared/types.ts';
import { buildAnalysis, parseRequirements } from '../server/matching.ts';
import { validateGroundedDocument } from '../server/model.ts';
import { separateAuditNotes, validateExperienceScope, validateNumbers } from '../server/resume-grounding.ts';
import { validateModelEdit } from '../server/resume-edit.ts';
import { diffResumeDocuments, summarizeResumeChanges } from '../shared/resume-diff.ts';

const fact = (id: string, text: string) => ({ id, text, source: text, confirmed: true });
const profile: Profile = {
  name: '虚构学生', email: '', phone: '', school: '示例大学', education: '本科', major: '法学', graduation: '2027.06',
  city: '上海、杭州', availability: '每周4天，连续3个月', targetRole: '', experienceText: '未经确认的内容不可进入匹配',
  facts: [fact('course', '隐私政策课程项目，2025.03—2025.06。检索20份公开隐私政策，按5个维度整理Excel对比表，完成8页课程研究报告。'),
    fact('volunteer', '社团志愿工作，在3人团队中整理120条匿名反馈，撰写反馈摘要供社团负责人讨论。'),
    fact('skills', '法律资料检索、中文写作与Excel。英语可阅读简单资料，未提供专业英语能力证明。'),
    fact('limits', '没有法律职业资格证；没有正式企业实习。'), fact('preference', '职业偏好：喜欢法律研究与写作，希望探索互联网。')],
};
const job = { company: '虚构公司', title: '隐私合规实习', url: '', industry: '互联网', text: '行业：互联网。地点：上海。岗位职责：检索隐私政策；协助整理比较表、会议纪要和研究摘要。必要条件：法学相关本科及以上在校生，具备资料检索与中文写作能力，会使用Excel，每周至少3天、连续3个月。加分项：能阅读英文政策材料；有企业合规实习。薪资未披露。' };
const document: ResumeDocument = { headline: '隐私合规实习', summary: '', theme: 'modern', accent: 'forest', sections: [{ id: 'practice', title: '项目实践', items: [{ id: 'course', title: '隐私政策课程研究', subtitle: '课程项目', date: '2025年3月至6月', content: '检索二十份公开隐私政策，按五个维度整理Excel对比表，完成八页课程研究报告。', factIds: ['course'] }] }] };

test('comma-rich 1429-character JD retains every duty and final hard condition without overflowing 80 items', () => {
  const duties=Array.from({length:90},(_,i)=>`核对第${i+1}类业务资料`);
  const body=`岗位职责：${duties.join('，')}。\n必要条件：本科及以上，每周至少四天，连续三个月。\n加分项：有资料整理经验优先。\n必要条件：必须持有有效工作许可。`;
  assert.ok(body.length<1429);
  const text=`工作说明：${'按流程协作'.repeat(Math.floor((1429-body.length-6)/5))}${'。'.repeat((1429-body.length-6)%5)}\n${body}`;
  assert.equal(text.length,1429);
  const parsed=parseRequirements({...job,text});
  assert.ok(parsed.requirements.length<=80);
  assert.ok(parsed.requirements.every(requirement=>text.includes(requirement.text)));
  for(const duty of duties) assert.ok(parsed.requirements.some(requirement=>requirement.text.includes(duty)));
  assert.equal(parsed.requirements.find(requirement=>requirement.text.includes('资料整理经验优先'))!.category,'preferred');
  assert.equal(parsed.requirements.at(-1)!.category,'required');
  assert.match(parsed.requirements.at(-1)!.text,/必须持有有效工作许可/);
});

test('law fixture separates metadata and preserves required, preferred and duty categories', t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-05T00:00:00Z') });
  const analysis = buildAnalysis(profile, job);
  assert.deepEqual(analysis.metadata, { industry: '互联网', location: '上海', salary: '未披露' });
  assert.ok(analysis.matches.every(m => !/行业：|地点：|薪资/u.test(m.requirement)));
  const school = analysis.matches.find(m => /本科/u.test(m.requirement))!;
  assert.equal(school.evidenceState, 'supported');
  assert.deepEqual(school.profileFields, ['education', 'major', 'graduation']);
  assert.ok(analysis.matches.filter(m => /每周|连续/u.test(m.requirement)).every(m => m.evidenceState === 'supported' && m.profileFields?.[0] === 'availability'));
  assert.equal(analysis.matches.find(m => /企业合规实习/u.test(m.requirement))?.evidenceState, 'unmet');
  assert.equal(analysis.matches.find(m => /企业合规实习/u.test(m.requirement))?.category, 'preferred');
  assert.ok(analysis.matches.every(m => !m.factIds.includes('preference')));
});

test('manufacturing English, missing technology evidence and actual qualification denial stay distinct', () => {
  const target = { ...job, text: '必要条件：法学或相关专业，能独立阅读英文法规。加分项：具备RoHS经验。已取得法律职业资格证。' };
  const parsed = parseRequirements(target);
  const analysis = buildAnalysis(profile, target, { summary: 'req_2需进一步核验。', questions: ['请补充req_3的证据。'], directionAdvice: [], matches: parsed.requirements.map(r => ({ requirementId: r.id, status: 'supported', factIds: ['skills'] })) });
  assert.equal(analysis.matches[0].evidenceState, 'supported');
  assert.equal(analysis.matches[1].evidenceState, 'partial');
  assert.equal(analysis.matches[2].evidenceState, 'unknown');
  assert.deepEqual(analysis.matches[2].factIds, []);
  assert.equal(analysis.matches[3].evidenceState, 'unmet');
  assert.doesNotMatch(JSON.stringify([analysis.summary, analysis.questions]), /req_\d+/u);
});

test('senior degree mismatch cannot be cured by irrelevant evidence or student volunteering', () => {
  const senior = buildAnalysis(profile, { ...job, text: '必要条件：法学硕士及以上，已取得法律职业资格证，至少5年企业数据合规工作经验，独立领导过个人信息出境项目。职责：带领团队制定合规制度。' });
  assert.equal(senior.matches[0].evidenceState, 'unmet');
  assert.equal(senior.matches[1].evidenceState, 'unmet');
  assert.equal(senior.matches[2].evidenceState, 'unknown'); // no internship is not proof of no employment
  assert.equal(senior.matches[3].evidenceState, 'unknown');
  assert.equal(senior.matches[4].evidenceState, 'unknown'); // "给负责人讨论" is not leadership
});

test('combined duties are not fully supported by a comparison table without meeting minutes', () => {
  const target = { ...job, text: '职责：协助整理比较表和会议纪要。' };
  const analysis = buildAnalysis(profile, target, { summary: '待核验。', matches: [{ requirementId: 'req_1', status: 'supported', factIds: ['course'] }], questions: [], directionAdvice: [] });
  assert.equal(analysis.matches[0].evidenceState, 'partial');
  assert.deepEqual(analysis.matches[0].factIds, ['course']);
});

test('attendance shortfall and absent profile fields are not the same state', () => {
  const target = { ...job, text: '必要条件：每周至少3天、连续3个月。' };
  assert.equal(buildAnalysis({ ...profile, availability: '每周2天，连续2个月' }, target).matches[0].evidenceState, 'unmet');
  assert.equal(buildAnalysis({ ...profile, availability: '' }, target).matches[0].evidenceState, 'unknown');
});

test('multi-city metadata remains intact and compound conditions cannot borrow a degree match', t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-05T00:00:00Z') });
  const result = buildAnalysis(profile, { ...job, text: '地点：上海、杭州。薪资：100—200元/天。必要条件：本科且有五年企业经验。本科毕业。本科并熟练使用SQL。' });
  assert.equal(result.metadata?.location, '上海、杭州');
  assert.equal(result.matches.length, 3);
  assert.equal(result.matches[0].evidenceState, 'partial');
  assert.equal(result.matches[1].evidenceState, 'unmet');
  assert.equal(result.matches[2].evidenceState, 'partial');
  assert.ok(result.matches.every(m => m.evidenceState !== 'supported'));
  const actualRequirement = parseRequirements({ ...job, text: '任职要求：企业数据合规工作经验。本科以上。' });
  assert.equal(actualRequirement.requirements[0].text, '企业数据合规工作经验。');
});

test('date formats, abbreviated ranges and Chinese quantities are equivalent with per-item grounding', () => {
  assert.doesNotThrow(() => validateGroundedDocument(profile, document));
  assert.doesNotThrow(() => validateNumbers('2025.03—.06 整理20份材料。', '2025年3月至6月 整理二十份材料。', '课程'));
  assert.doesNotThrow(() => validateNumbers('二〇二五年三月至六月，百分之二十。', '2025.03—2025.06，20%。', '课程'));
  const wrongMonth = structuredClone(document); wrongMonth.sections[0].items[0].date = '2025.04—2025.06';
  assert.throws(() => validateGroundedDocument(profile, wrongMonth), /隐私政策课程研究.*2025.04/u);
  const borrowedNumber = structuredClone(document); borrowedNumber.sections[0].items[0].content += '整理120条反馈。';
  assert.throws(() => validateGroundedDocument(profile, borrowedNumber), /120/u);
  assert.throws(() => validateNumbers('整理20份材料。', '整理二十一份材料。', '课程'), /二十一/u);
});

test('scope markers remain and standalone audit limitations move to review notes', () => {
  const draft = structuredClone(document);
  draft.sections[0].items[0].content += '未参与真实企业的合规整改，也未证明业务效率提升。Python正在学习中，尚未在真实业务中使用。';
  const separated = separateAuditNotes(draft);
  assert.match(separated.document.sections[0].items[0].content, /课程研究报告/u);
  assert.match(separated.document.sections[0].items[0].content, /Python正在学习中，尚未/u);
  assert.doesNotMatch(separated.document.sections[0].items[0].content, /未参与真实企业|未证明业务/u);
  assert.equal(separated.reviewNotes.length, 2);
  assert.match(draft.sections[0].items[0].content, /未参与真实企业/u);
  const promoted = structuredClone(document); promoted.sections[0].items[0].title = '企业合规研究'; promoted.sections[0].items[0].subtitle = '公司实习'; promoted.sections[0].items[0].content = '检索20份隐私政策并完成报告。';
  assert.throws(() => validateGroundedDocument(profile, promoted), /课程身份/u);
  assert.throws(() => validateExperienceScope('参与社团工作，没有担任团队负责人。', '担任团队负责人，带领团队整理资料。', '志愿工作'), /升级为负责人/u);
  assert.doesNotThrow(() => validateExperienceScope('参与社团工作，没有担任团队负责人。', '参与社团工作，未担任团队负责人。', '志愿工作'));
});

test('model edits use the same quantity guard and cannot borrow numbers from another experience', () => {
  const resume: ResumeVersion = { id: 'r1', version: 1, createdAt: '', profile, job, document, rationale: '', approved: false, bullets: [] };
  const changed = structuredClone(document); changed.sections[0].items[0].content = '检索20份隐私政策，完成8页课程研究报告。';
  assert.doesNotThrow(() => validateModelEdit(resume, changed));
  changed.sections[0].items[0].content += '整理120条反馈。';
  assert.throws(() => validateModelEdit(resume, changed), /120/u);
});

test('missing exam evidence moves to review notes while actual English ability limits remain', () => {
  for (const content of ['英语可阅读简单资料，未提供考试成绩或专业英语能力证明。', '可阅读简单英文资料；尚未提供英语成绩及英语能力证明。']) {
    const draft = structuredClone(document); draft.sections[0].items[0].content = content;
    const result = separateAuditNotes(draft);
    assert.match(result.document.sections[0].items[0].content, /(?:简单资料|简单英文资料)。$/u);
    assert.doesNotMatch(result.document.sections[0].items[0].content, /未提供/u);
    assert.equal(result.reviewNotes.length, 1);
    assert.match(result.reviewNotes[0], /成绩/u);
    assert.equal(draft.sections[0].items[0].content, content);
  }
  for (const content of ['仅能阅读简单资料，无独立工作能力。', '尚未具备独立阅读英文法规的能力。', '未提供考试成绩且不能用英语独立工作。', '未参与真实企业且无独立工作能力。', '英语正在学习中，尚未在真实业务中使用。']) {
    const draft = structuredClone(document); draft.sections[0].items[0].content = content;
    const result = separateAuditNotes(draft);
    assert.equal(result.document.sections[0].items[0].content, content);
    assert.deepEqual(result.reviewNotes, []);
  }
});

test('actual diff reports text, deletions and styles separately without false completion claims', () => {
  assert.deepEqual(diffResumeDocuments(document, structuredClone(document)), []);
  const styled = structuredClone(document); styled.accent = 'navy';
  assert.equal(diffResumeDocuments(document, styled)[0].field, 'accent');
  assert.match(summarizeResumeChanges(document, styled), /正文未变化/u);
  styled.sections[0].items[0].content = '仅保留一段真实内容。';
  const changes = diffResumeDocuments(document, styled);
  const content = changes.find(c => c.field.endsWith('.content'))!;
  assert.equal(content.before, document.sections[0].items[0].content);
  assert.equal(content.after, '仅保留一段真实内容。');
  assert.equal(content.type, 'changed');
  assert.doesNotMatch(summarizeResumeChanges(document, styled), /正文未变化/u);
  const removed = structuredClone(document); removed.sections = [];
  assert.equal(diffResumeDocuments(document, removed)[0].type, 'removed');
});
