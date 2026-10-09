import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.ts';
import { Workflow, exampleProfile, type BrowserTools } from '../server/workflow.ts';
import { createModelEngine } from '../server/model.ts';
import { createCareerEngine } from '../server/career-engine.ts';
import type { Action, Profile, ResumeVersion, WorkspaceState } from '../shared/types.ts';

const lawProfile: Omit<Profile, 'facts'> = {
  name: '李明', email: 'li.ming@example.com', phone: '13800138000', school: '中国政法大学',
  education: '本科', major: '法学', graduation: '2027-06', city: '上海', availability: '每周四天，可实习三个月', targetRole: '',
  experienceText: '参与课程研究项目，检索整理数据保护法规并撰写比较分析。\n在校园法律服务活动中协助整理咨询问题和合同条款。',
};
const importText = '姓名：李明\n邮箱：li.ming@example.com\n手机：13800138000\n学校：中国政法大学\n学历：本科\n专业：法学\n预计毕业：2027年6月\n意向城市：上海\n到岗时间：每周四天，可实习三个月\n参与课程研究项目，检索整理数据保护法规并撰写比较分析。';

function setup(t: TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  let submissions = 0;
  const browser: BrowserTools = {
    fill: async () => ({ evidence: 'v2-fill.png' }),
    submit: async ({ application }) => { submissions++; return { receipt: store.createReceipt(application.id), evidence: 'v2-submit.png' }; },
  };
  const workflow = new Workflow(store, createModelEngine({}), browser, createCareerEngine({}));
  const act = (action: Action) => workflow.act({ ...action, expectedRevision: store.read().revision });
  const confirmedProfile = async () => {
    let state = await act({ type: 'extract_profile', profile: lawProfile });
    for (const fact of state.profile.facts) state = await act({ type: 'update_fact', factId: fact.id, text: fact.text, confirmed: true });
    return state;
  };
  const companyList = async () => {
    await confirmedProfile();
    let state = await act({ type: 'career_chat', message: '我是法学专业，希望比较互联网与出海制造业的合规岗位，优先成长机会，地点上海。' });
    state = await act({ type: 'select_directions', directionIds: state.exploration!.directions.map(direction => direction.id) });
    return act({ type: 'recommend_companies' });
  };
  const twoCompanyResumes = async () => {
    let state = await companyList();
    const firstCompany = state.exploration!.companies[0];
    const secondCompany = state.exploration!.companies.find(company => company.name !== firstCompany.name)!;
    assert.ok(secondCompany, '跨公司流程至少需要两家独立公司');
    await act({ type: 'select_companies', companyIds: [firstCompany.id, secondCompany.id] });
    state = await act({ type: 'activate_company', companyId: firstCompany.id });
    const firstId = state.activeResumeId!;
    state = await act({ type: 'activate_company', companyId: secondCompany.id });
    return { state, firstId, secondId: state.activeResumeId!, firstCompany, secondCompany };
  };
  const active = (state: WorkspaceState): ResumeVersion => {
    const resume = state.resumes.find(item => item.id === state.activeResumeId);
    assert.ok(resume, '页面应指向已经保存的简历');
    return resume;
  };
  return { store, workflow, act, confirmedProfile, companyList, twoCompanyResumes, active, get submissions() { return submissions; } };
}

test('upload previews mapped law-profile fields without overwriting existing facts until accepted', async t => {
  const s = setup(t);
  const original = await s.act({ type: 'extract_profile', profile: exampleProfile });
  const oldProfile = structuredClone(s.store.read().profile);
  const preview = await s.workflow.importResume({ name: '原有简历.txt', mimeType: 'text/plain', buffer: Buffer.from(importText) }, original.revision);
  assert.deepEqual(preview.profile, oldProfile);
  assert.equal(preview.resumeImport?.proposedProfile.name, '李明');
  assert.equal(preview.resumeImport?.proposedProfile.major, '法学');
  assert.equal(preview.resumeImport?.proposedProfile.school, '中国政法大学');
  assert.equal(preview.resumeImport?.proposedProfile.email, 'li.ming@example.com');
  assert.equal(preview.resumeImport?.proposedProfile.targetRole, '');
  assert.equal(preview.resumeImport?.text, importText);
  assert.ok(preview.resumeImport?.warnings.length);
  const accepted = await s.act({ type: 'accept_resume_import', profile: preview.resumeImport!.proposedProfile });
  assert.equal(accepted.profile.major, '法学');
  assert.equal(accepted.profile.name, '李明');
  assert.equal(accepted.profile.experienceText, '参与课程研究项目，检索整理数据保护法规并撰写比较分析。');
  assert.equal(accepted.resumeImport, null);
  assert.ok(accepted.profile.facts.length > 0);
  assert.ok(accepted.profile.facts.every(fact => !fact.confirmed), '导入的事实仍需用户审核');
});

test('discarding an import preserves the prior profile and generated resume history', async t => {
  const s = setup(t);
  const ready = await s.twoCompanyResumes();
  const before = s.store.read();
  await s.workflow.importResume({ name: 'replacement.txt', mimeType: 'text/plain', buffer: Buffer.from('姓名：王小明\n学校：清华大学\n专业：计算机科学与技术') }, before.revision);
  const discarded = await s.act({ type: 'discard_resume_import' });
  assert.equal(discarded.resumeImport, null);
  assert.deepEqual(discarded.profile, before.profile);
  assert.deepEqual(discarded.resumes, before.resumes);
  assert.equal(discarded.activeResumeId, ready.secondId);
});

test('failed or outdated import leaves existing profile and pending preview unchanged', async t => {
  const s = setup(t);
  await s.confirmedProfile();
  const before = s.store.read();
  await assert.rejects(s.workflow.importResume({ name: 'fake.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not a PDF') }, before.revision), /扩展名不符/);
  assert.deepEqual(s.store.read(), before);
  await assert.rejects(s.workflow.importResume({ name: 'resume.txt', mimeType: 'text/plain', buffer: Buffer.from(importText) }, before.revision - 1), /页面版本已过期/);
  assert.deepEqual(s.store.read(), before);
});

test('law career conversation separates industry from function and responds to exclusions', async t => {
  const s = setup(t);
  await s.confirmedProfile();
  let state = await s.act({ type: 'career_chat', message: '我读法学，尚未确定行业和岗位，想知道律师以外还能做什么。' });
  const directions = state.exploration!.directions;
  assert.ok(directions.some(direction => /互联网/.test(direction.industry) && /合规/.test(direction.role)));
  assert.ok(directions.some(direction => /制造业/.test(direction.industry) && /产品合规/.test(direction.role)));
  assert.ok(new Set(directions.map(direction => direction.industry)).size >= 2);
  assert.ok(directions.every(direction => direction.industry !== direction.role));
  assert.ok(directions.every(direction => direction.entryRequirements && direction.gaps.length));
  assert.equal(state.job.company, '', '方向探索阶段不能替用户确定公司');
  assert.equal(state.resumes.length, 0);
  state = await s.act({ type: 'career_chat', message: '不考虑互联网，我更想研究出海制造业，优先成长。' });
  assert.ok(state.exploration!.directions.every(direction => !direction.industry.includes('互联网')));
  assert.match(state.exploration!.messages.at(-1)!.content, /出海制造业/);
});

test('directions lead to a selectable company list; only a selected company can generate a pending resume', async t => {
  const s = setup(t);
  let state = await s.companyList();
  assert.ok(state.exploration!.companies.length >= 2);
  assert.ok(state.exploration!.companies.every(company => !company.selected && company.hiringStatus === 'unverified'));
  assert.equal(state.resumes.length, 0);
  const company = state.exploration!.companies[0];
  await assert.rejects(s.act({ type: 'activate_company', companyId: company.id }), /右滑/);
  await s.act({ type: 'select_companies', companyIds: [company.id] });
  state = await s.act({ type: 'activate_company', companyId: company.id });
  const resume = s.active(state);
  assert.equal(resume.job.company, company.name);
  assert.equal(resume.job.title, company.role);
  assert.equal(resume.job.industry, company.industry);
  assert.equal(resume.approved, false);
  assert.ok(resume.document?.sections.some(section => section.items.some(item => item.content)));
  assert.match(state.analysis!.summary, /尚未核验/);
  assert.equal(state.applications.length, 0);
  assert.equal(s.submissions, 0);
});

test('switching target companies retains each company resume and reuses its latest current version', async t => {
  const s = setup(t);
  const ready = await s.twoCompanyResumes();
  const first = ready.state.resumes.find(resume => resume.id === ready.firstId)!;
  const second = ready.state.resumes.find(resume => resume.id === ready.secondId)!;
  assert.equal(first.stale, false);
  assert.equal(second.stale, false);
  assert.notEqual(first.job.company, second.job.company);
  await s.act({ type: 'approve_resume', resumeId: first.id });
  const prepared = await s.act({ type: 'prepare_application', resumeId: first.id });
  assert.equal(prepared.applications[0].resumeId, first.id, '当前页面为另一公司时，第一份已确认简历仍可独立使用');
  const switched = await s.act({ type: 'activate_company', companyId: ready.firstCompany.id });
  assert.equal(switched.activeResumeId, first.id);
  assert.equal(switched.resumes.length, 2);
  assert.equal(switched.applications[0].status, 'prepared');
});

test('switching away and back restores the company real JD and reuses its matching resume', async t => {
  const s = setup(t);
  const ready = await s.twoCompanyResumes();
  let state = await s.act({ type: 'activate_company', companyId: ready.firstCompany.id });
  const realJob = {
    ...state.job, title: '数据保护合规实习生（真实岗位资料）',
    text: '岗位职责：检索整理数据保护法规，协助撰写比较分析，并整理合同条款。任职要求：法学本科在校生，能够每周到岗四天。',
  };
  state = await s.act({ type: 'save_job', job: realJob });
  const savedJob = structuredClone(state.job);
  await s.act({ type: 'analyze_job' });
  state = await s.act({ type: 'generate_resume' });
  const realResume = structuredClone(s.active(state));
  const resumeCount = state.resumes.length;
  await s.act({ type: 'activate_company', companyId: ready.secondCompany.id });
  const restored = await s.act({ type: 'activate_company', companyId: ready.firstCompany.id });
  assert.deepEqual(restored.job, savedJob, '切回公司应恢复用户保存的真实 JD，不覆盖为探索资料');
  assert.equal(restored.job.sourceKind, 'user_jd');
  assert.equal(restored.activeResumeId, realResume.id, '应复用该真实 JD 的当前简历');
  assert.deepEqual(s.active(restored).job, restored.job, '当前岗位与当前简历绑定的岗位必须一致');
  assert.equal(restored.resumes.length, resumeCount, '切换不应额外生成简历版本');
  assert.ok(restored.analysis?.matches.some(match => savedJob.text.includes(match.requirement)), '分析应依据恢复的真实 JD');
});

test('saving an unchanged company A JD while company B is active preserves A resume and pending application', async t => {
  const s = setup(t);
  const ready = await s.twoCompanyResumes();
  let state = await s.act({ type: 'activate_company', companyId: ready.firstCompany.id });
  state = await s.act({ type: 'save_job', job: {
    ...state.job, title: '企业合规研究实习生',
    text: '岗位职责：检索研究相关法规，整理咨询问题和合同条款。希望候选人能够清晰表达分析结论，并参与团队沟通。',
  } });
  const savedJob = structuredClone(state.job);
  await s.act({ type: 'analyze_job' });
  state = await s.act({ type: 'generate_resume' });
  const firstId = state.activeResumeId!;
  await s.act({ type: 'approve_resume', resumeId: firstId });
  state = await s.act({ type: 'prepare_application', resumeId: firstId });
  const originalResume = structuredClone(state.resumes.find(resume => resume.id === firstId)!);
  const pendingApplication = structuredClone(state.applications.find(application => application.resumeId === firstId)!);
  await s.act({ type: 'activate_company', companyId: ready.secondCompany.id });
  const savedAgain = await s.act({ type: 'save_job', job: savedJob });
  assert.deepEqual(savedAgain.resumes.find(resume => resume.id === firstId), originalResume, '另一公司作为当前目标不应使未修改的 A 简历失效');
  assert.deepEqual(savedAgain.applications.find(application => application.id === pendingApplication.id), pendingApplication, '未修改的 JD 不应取消待投递申请');
  assert.equal(savedAgain.activeResumeId, firstId);
  assert.deepEqual(savedAgain.job, savedJob);
});

test('saved real JD survives a company switch even before generating its resume', async t => {
  const s = setup(t);
  const ready = await s.twoCompanyResumes();
  let state = await s.act({ type: 'activate_company', companyId: ready.firstCompany.id });
  state = await s.act({ type: 'save_job', job: {
    ...state.job, title: '海外业务合规研究实习生',
    text: '岗位职责：协助收集海外业务法规，整理研究资料，与团队沟通法规比较分析。任职要求以招聘页面为准。',
  } });
  const savedJob = structuredClone(state.job);
  assert.ok(!state.resumes.some(resume => !resume.stale && resume.job.text === savedJob.text), '测试前提：真实 JD 尚无对应简历');
  await s.act({ type: 'activate_company', companyId: ready.secondCompany.id });
  const restored = await s.act({ type: 'activate_company', companyId: ready.firstCompany.id });
  assert.deepEqual(restored.job, savedJob, '真实 JD 必须独立于简历版本保存');
  assert.equal(restored.job.sourceKind, 'user_jd');
  if (restored.activeResumeId) assert.deepEqual(s.active(restored).job, savedJob, '如果切换生成或激活简历，必须绑定已保存的真实 JD');
});

test('manual editing creates a pending version and invalidates only drafts for the same company and role', async t => {
  const s = setup(t);
  const ready = await s.twoCompanyResumes();
  for (const id of [ready.firstId, ready.secondId]) {
    await s.act({ type: 'approve_resume', resumeId: id });
    await s.act({ type: 'prepare_application', resumeId: id });
  }
  const before = s.store.read();
  const original = before.resumes.find(resume => resume.id === ready.firstId)!;
  const unaffected = before.resumes.find(resume => resume.id === ready.secondId)!;
  const document = structuredClone(original.document!);
  document.summary = '法学专业，关注法规研究与跨部门协作。';
  document.sections[0].items[0].content = '检索整理数据保护法规，形成比较分析。';
  const { facts: _facts, ...profile } = original.profile;
  const edited = await s.act({ type: 'save_resume_edit', resumeId: original.id, document, profile });
  const latest = s.active(edited);
  assert.equal(edited.resumes.length, 3);
  assert.notEqual(latest.id, original.id);
  assert.equal(latest.parentId, original.id);
  assert.equal(latest.approved, false);
  assert.equal(latest.stale, false);
  assert.equal(latest.authoredBy, 'user');
  assert.equal(latest.document!.summary, document.summary);
  const retained = edited.resumes.find(resume => resume.id === original.id)!;
  assert.equal(retained.stale, true);
  assert.deepEqual(retained.document, original.document);
  assert.deepEqual(retained.profile, original.profile);
  assert.deepEqual(retained.bullets, original.bullets);
  assert.deepEqual(edited.resumes.find(resume => resume.id === unaffected.id), unaffected);
  assert.equal(edited.applications.find(application => application.resumeId === original.id)!.status, 'failed');
  assert.equal(edited.applications.find(application => application.resumeId === unaffected.id)!.status, 'prepared');
  assert.deepEqual(edited.profile, before.profile);
  await assert.rejects(s.act({ type: 'prepare_application', resumeId: latest.id }), /先审核/);
});

test('chat edits theme and colour in a new unapproved version while retaining historical content', async t => {
  const s = setup(t);
  const ready = await s.twoCompanyResumes();
  await s.act({ type: 'approve_resume', resumeId: ready.secondId });
  const before = s.store.read();
  const original = before.resumes.find(resume => resume.id === ready.secondId)!;
  const result = await s.act({ type: 'chat_resume_edit', resumeId: original.id, message: '请使用经典版式和深蓝色配色，保持经历内容不变。' });
  const latest = s.active(result);
  assert.notEqual(latest.id, original.id);
  assert.equal(latest.approved, false);
  assert.equal(latest.document!.theme, 'classic');
  assert.equal(latest.document!.accent, 'navy');
  assert.deepEqual(latest.document!.sections, original.document!.sections);
  assert.deepEqual(result.resumes.find(resume => resume.id === original.id)!.document, original.document);
  assert.equal(result.resumes.find(resume => resume.id === ready.firstId)!.stale, false);
  assert.ok(latest.editMessages?.some(message => message.role === 'user' && message.content.includes('经典')));
  assert.ok(latest.editMessages?.some(message => message.role === 'assistant'));
});

test('changed profile marks career exploration stale and blocks reuse until the user discusses new directions', async t => {
  const s = setup(t);
  const ready = await s.twoCompanyResumes();
  const state = await s.act({ type: 'extract_profile', profile: { ...lawProfile, major: '计算机科学与技术', experienceText: '参与课程软件开发项目，编写前端页面并测试交互。' } });
  assert.equal(state.exploration!.profileStale, true);
  assert.equal(state.activeResumeId, null);
  await assert.rejects(s.act({ type: 'select_directions', directionIds: ready.state.exploration!.selectedDirectionIds }), /重新评估/);
  await assert.rejects(s.act({ type: 'recommend_companies' }), /先对话/);
  await assert.rejects(s.act({ type: 'activate_company', companyId: ready.firstCompany.id }), /重新评估/);
  assert.equal(s.store.read().resumes.length, ready.state.resumes.length);
  const reviewed = await s.act({ type: 'career_chat', message: '资料已更新，请根据现在的专业和经历重新评估。' });
  assert.equal(reviewed.exploration!.profileStale, false);
  assert.ok(reviewed.exploration!.directions.some(direction => /软件|开发|测试/.test(direction.role)), '当前明确的专业变化应优先于历史对话中的旧专业');
});

test('a city-only profile change requires fresh company selection after direction reassessment', async t => {
  const s = setup(t);
  const ready = await s.twoCompanyResumes();
  const oldFact = ready.state.profile.facts[0];
  // Confirming revised source material keeps the same direction wording but requires a new review.
  await s.act({ type: 'extract_profile', profile: { ...lawProfile, city: '深圳' } });
  let current = s.store.read();
  for (const fact of current.profile.facts) current = await s.act({ type: 'update_fact', factId: fact.id, text: fact.text, confirmed: true });
  assert.equal(current.profile.facts[0].text, oldFact.text);
  const reviewed = await s.act({ type: 'career_chat', message: '我现在只考虑深圳，请按新的地点重新评估这些方向。' });
  assert.equal(reviewed.exploration!.profileStale, false);
  assert.deepEqual(reviewed.exploration!.selectedDirectionIds, [], '复核后的方向需要用户重新选择');
  assert.deepEqual(reviewed.exploration!.companies, [], '旧地点的公司清单不能自动继续使用');
  await assert.rejects(s.act({ type: 'activate_company', companyId: ready.firstCompany.id }), /勾选|清单|选择/);
});
