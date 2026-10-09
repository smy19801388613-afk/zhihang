import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import type { Job, Profile } from '../shared/types.ts';
import { buildAnalysis, parseRequirements, prepareRequirementCuration, validateCuratedRequirements } from '../server/matching.ts';
import MatchAnalysis from '../src/MatchAnalysis.tsx';

const profile: Profile = { name: '虚构测试者', email: '', phone: '', school: '', education: '本科', major: '计算机', graduation: '2027.06', city: '', availability: '每周4天，连续3个月', targetRole: '', experienceText: '', facts: [{ id: 'research', confirmed: true, text: '课程项目中参与用户调研、分析访谈记录，整理需求文档和原型。', source: '课程项目中参与用户调研、分析访谈记录，整理需求文档和原型。' }] };
const makeJob = (text: string): Job => ({ company: '虚构公司', title: '测试岗位', text, url: '', industry: '互联网' });
const quote = (job: Job, search: string) => {
  const source = prepareRequirementCuration(job).sources.find(item => item.text.includes(search));
  assert.ok(source, `missing test source: ${search}`);
  return { sourceId: source.id, quote: source.text };
};

// Constructed job-only fixture reproduces the public posting's structure, including
// repeated content. No production profile or applicant data is persisted here.
const lizihang = makeJob(`行业：房地产中介/租赁\n地点：北京\n薪资：12-15K\n学历要求：本科\n经验要求：经验不限\n少年，你五行缺伯乐。\n公司专注豪宅服务，本科学历占比30%以上，与优秀的人同行！\n【薪酬体系】\n我们提供7000-9000综合底薪，此外有3%-30%提成，月度奖，季度奖，年终奖。\n【工作内容】\n1、向客户提供房地产市场的数据、分析和政策解读\n2、了解客户的需求，并为他们推荐合适的项目\n3、提供全面丰富的产品比较和解决方案\n4、在房地产法律和法规方面提供建议\n5、处理合同的讨论、谈判和签署\n6、提供超出客户期望的专业服务\n【培训体系】\n没经验？不怕我带你飞！入门有师傅带。\n【晋升体系】\n精英大舞台，有梦你就来。期待你的加入！`);

test('Lizhihang-style marketing JD keeps one real degree gate and six duties, deduplicates repeated sections', () => {
  const analysis = buildAnalysis(profile, { ...lizihang, text: `${lizihang.text}\n${lizihang.text}` });
  assert.equal(analysis.matches.length, 7);
  assert.equal(analysis.matches.filter(item => item.category === 'required').length, 1);
  assert.equal(analysis.matches.filter(item => item.category === 'responsibility').length, 6);
  assert.equal(analysis.matches[0].evidenceState, 'supported');
  assert.doesNotMatch(analysis.matches.map(item => item.requirement).join('\n'), /底薪|提成|季度奖|五行|占比|带你飞|大舞台|期待|经验不限/u);
  assert.equal(analysis.metadata?.salary, '12-15K');
  assert.equal(analysis.curation?.mode, 'rules');
  assert.match(analysis.summary, /未进行模型语义判断/u);
});

const normal = makeJob(`岗位职责：\n1、参与用户调研，分析访谈记录。\n2、整理需求文档，绘制产品原型。\n3、跟进项目进度，推动跨团队协作。\n任职要求：\n本科及以上在校生，每周至少3天、连续3个月。\n具备资料分析能力，熟练使用Excel，沟通表达清晰。\n加分项：\n有互联网产品实习经验优先。\n熟悉SQL更加分。\n福利待遇：\n五险一金，免费健身，带薪年假。`);

test('ordinary employer JD separates gates, skills, preferred and responsibilities with exact original quotes', () => {
  const result = parseRequirements(normal);
  assert.deepEqual(new Set(result.requirements.map(item => item.category)), new Set(['required', 'capability', 'preferred', 'responsibility']));
  assert.equal(result.requirements.filter(item => item.category === 'required').length, 2);
  assert.equal(result.requirements.filter(item => item.category === 'responsibility').length, 3);
  assert.equal(result.requirements.filter(item => item.category === 'capability').length, 3);
  assert.equal(result.requirements.filter(item => item.category === 'preferred').length, 2);
  for (const item of result.requirements) {
    assert.deepEqual(item.sourceQuotes, [item.text]);
    assert.ok(normal.text.includes(item.text));
  }
  assert.doesNotMatch(result.requirements.map(item => item.text).join(''), /五险一金|免费健身|带薪年假/u);
});

test('model can semantically merge related sources without free paraphrases or losing original evidence', () => {
  const prepared = prepareRequirementCuration(normal);
  const duties = prepared.sources.filter(item => item.categoryHint === 'responsibility');
  const reply = { requirements: [
    { category: 'responsibility', sources: duties.slice(0, 2).map(item => ({ sourceId: item.id, quote: item.text })) },
    ...prepared.sources.filter(item => !duties.slice(0, 2).includes(item)).map(item => ({ category: item.categoryHint, sources: [{ sourceId: item.id, quote: item.text }] })),
  ] };
  const curated = validateCuratedRequirements(normal, reply);
  assert.equal(curated.requirements.length, prepared.sources.length - 1);
  assert.deepEqual(curated.requirements[0].sourceQuotes, duties.slice(0, 2).map(item => item.text));
  const analysis = buildAnalysis(profile, normal, { summary: '部分职责有可迁移的课程经历。', matches: [{ requirementId: 'req_1', status: 'partial', factIds: ['research'] }], questions: [], directionAdvice: ['补充可核验的项目产出。'] }, curated);
  assert.equal(analysis.curation?.mode, 'model');
  assert.equal(analysis.matches[0].sourceQuotes?.length, 2);
  assert.equal(analysis.matches[0].evidenceState, 'partial');
  assert.deepEqual(analysis.matches[0].factIds, ['research']);
});

test('fabricated, cropped, unknown and duplicate model citations are rejected', () => {
  const actual = quote(normal, '本科');
  for (const source of [{ ...actual, quote: '硕士及以上在校生' }, { ...actual, quote: '本科' }, { sourceId: 'source_999', quote: actual.quote }]) {
    assert.throws(() => validateCuratedRequirements(normal, { requirements: [{ category: 'required', sources: [source] }] }), /岗位原文引用|岗位引文与原文不一致/u);
  }
  assert.throws(() => validateCuratedRequirements(normal, { requirements: [{ category: 'required', sources: [actual, actual] }] }), /重复/u);
  assert.throws(() => validateCuratedRequirements(normal, { requirements: [{ category: 'required', text: '硕士', sources: [actual] }] }));
});

test('missing hard gates and omitted duties are restored, even if that exceeds fifteen conditions', () => {
  const job = makeJob(`任职要求：本科及以上。必须持有有效工作许可。\n岗位职责：${Array.from({ length: 17 }, (_, index) => `整理第${index + 1}类业务材料。`).join('')}`);
  const curated = validateCuratedRequirements(job, { requirements: [] });
  assert.equal(curated.requirements.length, 19);
  assert.equal(curated.requirements.filter(item => item.category === 'required').length, 2);
  assert.equal(curated.requirements.filter(item => item.category === 'responsibility').length, 17);
  assert.match(curated.curation.warnings.join(''), /补回.*2.*硬门槛/u);
  assert.match(curated.curation.warnings.join(''), /15 项/u);
});

test('preferred conditions cannot become hard gates or be merged into required restrictions', () => {
  const job = makeJob('任职要求：本科及以上。加分项：硕士优先。有SQL项目经验优先。');
  const sources = prepareRequirementCuration(job).sources;
  const curated = validateCuratedRequirements(job, { requirements: [{ category: 'required', sources: sources.map(item => ({ sourceId: item.id, quote: item.text })) }] });
  assert.equal(curated.requirements.length, 2);
  assert.equal(curated.requirements[0].category, 'required');
  assert.equal(curated.requirements[1].category, 'preferred');
  assert.doesNotMatch(curated.requirements[0].text, /硕士|SQL/u);
  assert.equal(curated.requirements[1].sourceQuotes?.length, 2);
});

test('mandatory conditions hidden beside perks survive without promoting unlimited experience', () => {
  const job = makeJob('福利待遇：五险一金，但应聘者必须持有有效工作许可。岗位要求：学历不限，经验不限。本科以上，每周至少四天。');
  const result = parseRequirements(job);
  assert.equal(result.requirements.length, 3);
  assert.ok(result.requirements.every(item => item.category === 'required'));
  assert.match(result.requirements.map(item => item.text).join(''), /工作许可/u);
  assert.doesNotMatch(result.requirements.map(item => item.text).join(''), /学历不限|经验不限|五险一金/u);
});

test('colleague education and degree-named work audiences are not applicant degree gates', () => {
  const job = makeJob('公司介绍：团队成员均为博士。岗位职责：负责本科课程辅导。岗位要求：本科及以上。');
  const result = buildAnalysis(profile, job);
  assert.equal(result.matches.length, 2);
  assert.equal(result.matches[0].category, 'responsibility');
  assert.deepEqual(result.matches[0].profileFields, []);
  assert.equal(result.matches[1].category, 'required');
});

test('curation is rebound to the selected JD and cannot borrow another job or invented text', () => {
  const curated = validateCuratedRequirements(normal, { requirements: [] });
  assert.throws(() => buildAnalysis(profile, lizihang, undefined, curated), /原文引用/u);
  const tampered = structuredClone(curated);
  tampered.requirements[0].sourceQuotes = ['博士学历且十年经验'];
  assert.throws(() => buildAnalysis(profile, normal, undefined, tampered), /原文引用/u);
});

test('UI distinguishes JD quotes from personal evidence and marks old analyses', () => {
  const analysis = buildAnalysis(profile, normal);
  const html = renderToStaticMarkup(createElement(MatchAnalysis, { analysis, profile, job: normal }));
  assert.match(html, /工作能力/u);
  assert.match(html, /查看招聘原文依据/u);
  assert.match(html, /查看个人资料与经历依据/u);
  assert.match(html, /规则提炼/u);
  const old = structuredClone(analysis); delete old.curation;
  const oldHtml = renderToStaticMarkup(createElement(MatchAnalysis, { analysis: old, profile, job: normal }));
  assert.match(oldHtml, /旧版分析，可重新分析/u);
});
