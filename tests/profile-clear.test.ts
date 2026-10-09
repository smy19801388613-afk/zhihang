import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import type {ApplicationStatus,CompanyCandidate,ModelEngine,WorkspaceState} from '../shared/types.ts';
import {Store,emptyProfile} from '../server/store.ts';
import {Workflow,exampleProfile} from '../server/workflow.ts';
import {createModelEngine} from '../server/model.ts';
import {CareerAttachments} from '../server/career-attachments.ts';
import {BrowserConnections} from '../server/browser-connections.ts';
import {SettingsManager,type SecretProtector} from '../server/model-settings.ts';
import {actionSchema} from '../server/validation.ts';
import {captureJob} from '../server/browser-capture.ts';

const browser={fill:async()=>{throw new Error('Clearing a profile must not operate a browser.');},submit:async()=>{throw new Error('Clearing a profile must not submit an application.');}};
function workflowFor(store:Store,attachments:CareerAttachments,engine=createModelEngine({})){return new Workflow(store,engine,browser,undefined,undefined,undefined,attachments);}

async function seeded(path=':memory:') {
  const store=new Store(path);const attachments=new CareerAttachments();const workflow=workflowFor(store,attachments);
  await workflow.importBrowserCaptures({protocolVersion:1,requestId:randomUUID(),jobs:['ClearLike01','ClearDislike02'].map((id,index)=>({platform:'boss' as const,sourceUrl:`https://www.zhipin.com/job_detail/${id}.html`,capturedAt:'2026-10-01T00:00:00Z',pageKind:'detail' as const,fields:{company:`合成招聘公司${index}`,title:'资料研究实习',city:'杭州',salary:'150元/天',education:'本科',experience:'不限',jd:'协助整理公开资料并维护内部文档，要求本科在读。',jdComplete:true}}))});
  const ids=Object.keys(store.read().browserCaptures!);
  await workflow.act({type:'swipe_company',companyId:ids[0],decision:'like',expectedRevision:store.read().revision});
  await workflow.act({type:'swipe_company',companyId:ids[1],decision:'dislike',expectedRevision:store.read().revision});
  const attachment=await attachments.add({name:'待发送个人资料.txt',mimeType:'text/plain',buffer:Buffer.from('仅在当前聊天使用的合成个人经历。')},false);
  const state=store.read();
  state.profile={...exampleProfile,name:'合成待删除档案',experienceText:'当前个人原文SECRET。',facts:[{id:'current_fact',text:'当前已确认事实SECRET。',source:'当前个人原文SECRET。',confirmed:true}]};
  state.factOrganization={version:1,kind:'experience',model:'test-only',reviewed:true,passes:2,warnings:['当前经历整理细节SECRET']};
  state.factPreview={facts:[{id:'preview_fact',text:'待确认修订SECRET',source:'原文',confirmed:false}],questions:['待核对SECRET'],sourceText:state.profile.experienceText,createdAt:'2026-10-01T00:00:00Z',agentRun:state.factOrganization};
  state.resumeImport={filename:'当前简历SECRET.txt',importedAt:'2026-10-01T00:00:00Z',text:'完整导入原文SECRET',proposedProfile:{...exampleProfile},warnings:['导入问题SECRET']};
  state.questions=['当前个人问题SECRET'];
  state.analysis={summary:'当前个人匹配SECRET',matches:[],questions:['匹配问题SECRET'],directionAdvice:['个人方向SECRET']};
  state.job=captureJob(state.browserCaptures![ids[0]]);
  const savedPublic:CompanyCandidate={id:'public-like',name:'公开岗位公司',industry:'制造业',role:'流程助理',rationale:'根据你的个人原文SECRET推荐',requirements:['整理岗位文档'],careerUrl:'https://example.test/jobs/1',sourceLabel:'公开岗位',sourceKind:'public_job',checkedAt:'2026-10-01T00:00:00Z',hiringStatus:'unverified',selected:true,decision:'like'};
  const savedSkipped:CompanyCandidate={...savedPublic,id:'public-dislike',name:'略过的公开岗位',selected:false,decision:'dislike'};
  state.exploration!.companies.push(savedPublic,savedSkipped);
  state.exploration!.messages=[{role:'user',content:'当前个人聊天SECRET',attachments:[attachment]},{role:'assistant',content:'根据个人经历的答复SECRET'}];
  state.exploration!.directions=[{id:'old-direction',industry:'互联网',role:'资料研究',rationale:'当前个人理由SECRET',transferableSkills:['个人技能SECRET'],gaps:['个人缺口SECRET'],entryRequirements:'个人门槛SECRET',salaryContext:'个人偏好SECRET'}];
  state.exploration!.selectedDirectionIds=['old-direction'];state.exploration!.conversationPhase='ready';state.exploration!.decisionSummary='当前偏好总结SECRET';state.exploration!.profileStale=true;
  state.exploration!.jobSearch={fetchedAt:'2026-10-01T00:00:00Z',sources:[{id:'search',label:'旧偏好来源SECRET',status:'ok',count:4,message:'旧方向SECRET'}]};
  state.exploration!.swipeHistory!.push({companyId:'public-dislike',previousSelected:false});
  state.companyResearch!['public-like']={companyId:'public-like',companyName:'公开岗位公司',role:'流程助理',generatedAt:'2026-10-01T00:00:00Z',mode:'demo',status:'ready',summary:'已保存的公开公司研究',findings:[],questions:[],sources:[],warnings:[]};
  const statuses:ApplicationStatus[]=['prepared','filled','confirmed','unknown','failed','submitting'];
  state.resumes=statuses.map((_,index)=>({id:randomUUID(),version:index+1,createdAt:'2026-10-01T00:00:00Z',profile:structuredClone(state.profile),job:structuredClone(state.job),bullets:[{text:'历史简历正文SECRET',factIds:['current_fact']}],rationale:'历史组织理由SECRET',approved:true,stale:false}));
  state.activeResumeId=state.resumes[0].id;
  state.applications=statuses.map((status,index)=>({id:randomUUID(),resumeId:state.resumes[index].id,company:'历史申请公司',jobTitle:'实习岗位',status,createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-01T00:00:00Z',simulated:true,...(status==='confirmed'?{receipt:'DEMO-SYNTHETIC-RECEIPT'}:{}),...(status==='failed'?{error:'原有失败原因'}:{})}));
  state.interview={resumeId:state.resumes[0].id,messages:[{role:'user',content:'当前面试回答SECRET'}]};
  state.events=[{id:randomUUID(),at:'2026-10-01T00:00:00Z',title:'旧当前任务SECRET',detail:'可能含个人信息的旧记录SECRET'}];
  store.save(state,state.revision);
  return {store,workflow,attachments,attachment,ids};
}

function assertCleared(after:WorkspaceState,before:WorkspaceState){
  assert.deepEqual(after.profile,emptyProfile());assert.equal(after.factOrganization,undefined);assert.equal(after.factPreview,null);assert.equal(after.resumeImport,null);assert.deepEqual(after.questions,[]);assert.equal(after.analysis,null);assert.equal(after.activeResumeId,null);assert.equal(after.interview,null);
  assert.deepEqual(after.exploration!.messages,[]);assert.deepEqual(after.exploration!.directions,[]);assert.deepEqual(after.exploration!.selectedDirectionIds,[]);assert.equal(after.exploration!.conversationPhase,'explore');assert.equal(after.exploration!.decisionSummary,undefined);assert.equal(after.exploration!.profileStale,undefined);assert.equal(after.exploration!.jobSearch,undefined);assert.equal(after.exploration!.stage,'companies');
  assert.deepEqual(after.exploration!.swipeHistory,before.exploration!.swipeHistory);
  const decisions=(state:WorkspaceState)=>state.exploration!.companies.map(({id,selected,decision})=>({id,selected,decision})).sort((a,b)=>a.id.localeCompare(b.id));
  assert.deepEqual(decisions(after),decisions(before));
  assert.deepEqual(after.browserCaptures,before.browserCaptures);assert.deepEqual(after.browserCaptureRequests,before.browserCaptureRequests);assert.deepEqual(after.companyJobs,before.companyJobs);assert.deepEqual(after.companyResearch,before.companyResearch);assert.deepEqual(after.job,before.job);
  assert.deepEqual(after.resumes,before.resumes.map(resume=>({...resume,stale:true})));
  for(const [index,application]of after.applications.entries()){
    const previous=before.applications[index];
    if(['prepared','filled'].includes(previous.status)){assert.equal(application.status,'failed');assert.match(application.error!,/资料或岗位已变更/);assert.equal(application.resumeId,previous.resumeId);}
    else assert.deepEqual(application,previous);
  }
  const {resumes:_historicalResumes,...current}=after;assert.doesNotMatch(JSON.stringify(current),/SECRET/);
  assert.equal(after.events.length,1);assert.equal(after.events[0].title,'当前个人档案已删除');
}

test('clear_profile has a narrow revision-checked action schema',()=>{
  assert.deepEqual(actionSchema.parse({type:'clear_profile',expectedRevision:4}),{type:'clear_profile',expectedRevision:4});
  for(const payload of [{type:'clear_profile'},{type:'clear_profile',expectedRevision:-1},{type:'clear_profile',expectedRevision:1.5},{type:'clear_profile',expectedRevision:0,deleteResumes:true}])assert.equal(actionSchema.safeParse(payload).success,false);
});

test('clearing the current profile preserves jobs, decisions, public research and historical snapshots',async t=>{
  const s=await seeded();t.after(()=>s.store.close());const before=s.store.read();
  const result=await s.workflow.act({type:'clear_profile',expectedRevision:before.revision});
  assert.equal(result.revision,before.revision+1);assertCleared(result,before);
  assert.throws(()=>s.attachments.resolve([s.attachment.id]),/过期/);
  await assert.rejects(s.workflow.act({type:'generate_resume',expectedRevision:result.revision}),/确认至少一条|先完成/);
  await assert.rejects(s.workflow.act({type:'prepare_application',resumeId:result.resumes[0].id,expectedRevision:result.revision}),/不是当前草稿/);
});

test('stale clear requests preserve current data and pending uploads',async t=>{
  const s=await seeded();t.after(()=>s.store.close());const before=s.store.read();
  await assert.rejects(s.workflow.act({type:'clear_profile',expectedRevision:before.revision-1}),/页面版本已过期/);
  assert.deepEqual(s.store.read(),before);assert.equal(s.attachments.resolve([s.attachment.id]).meta.length,1);assert.equal(s.workflow.isBusy,false);
});

test('failed saves never discard profile data or pending attachments for either clearing action',async t=>{
  for(const type of ['clear_profile','clear_career_chat'] as const){
    const s=await seeded();const before=s.store.read();const save=t.mock.method(s.store,'save',()=>{throw new Error('synthetic storage failure');});
    await assert.rejects(s.workflow.act({type,expectedRevision:before.revision}),/storage failure/);
    assert.deepEqual(s.store.read(),before);assert.equal(s.attachments.resolve([s.attachment.id]).meta.length,1);assert.equal(s.workflow.isBusy,false);
    save.mock.restore();await s.workflow.act({type,expectedRevision:before.revision});assert.throws(()=>s.attachments.resolve([s.attachment.id]),/过期/);s.store.close();
  }
});

test('clear rejects while work is active and a completed clear cannot be overwritten by a concurrent old extraction',async t=>{
  const s=await seeded();t.after(()=>s.store.close());const before=s.store.read();
  let release!:()=>void;let started!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const running=new Promise<void>(resolve=>{started=resolve;});
  const demo=createModelEngine({});const slow:ModelEngine={...demo,extractProfile:async profile=>{started();await gate;return demo.extractProfile(profile);}};
  const busy=workflowFor(s.store,s.attachments,slow);
  const extraction=busy.act({type:'extract_profile',profile:{...exampleProfile,name:'过期的后台整理'},expectedRevision:before.revision});
  await running;
  await assert.rejects(busy.act({type:'clear_profile',expectedRevision:before.revision}),/上一步还在执行/);
  assert.deepEqual(s.store.read(),before);assert.equal(s.attachments.resolve([s.attachment.id]).meta.length,1);
  const cleared=await s.workflow.act({type:'clear_profile',expectedRevision:before.revision});
  release();await assert.rejects(extraction,/页面版本已过期/);assert.deepEqual(s.store.read(),cleared);assert.equal(busy.isBusy,false);
});

test('concurrent clear requests cannot both commit the same revision',async t=>{
  const s=await seeded();t.after(()=>s.store.close());const revision=s.store.read().revision;
  const results=await Promise.allSettled([s.workflow.act({type:'clear_profile',expectedRevision:revision}),s.workflow.act({type:'clear_profile',expectedRevision:revision})]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.filter(result=>result.status==='rejected').length,1);assert.equal(s.store.read().revision,revision+1);assert.deepEqual(s.store.read().profile,emptyProfile());
});

test('cleared profile and preserved jobs survive restart without changing model or extension credentials',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'zhihang-profile-clear-'));const path=join(directory,'workspace.sqlite');
  let store:Store|undefined;let connections:BrowserConnections|undefined;
  try{
    const s=await seeded(path);store=s.store;
    const protector:SecretProtector={kind:'synthetic-test',protect:value=>Buffer.from(value).toString('base64'),unprotect:value=>Buffer.from(value,'base64').toString('utf8')};
    const settings=new SettingsManager(directory,{},protector);
    settings.commit(settings.prepare({expectedRevision:0,provider:'deepseek',baseUrl:'https://api.deepseek.com',model:'deepseek-flash',apiKey:'test-only-profile-clear-key',jsonMode:true,timeoutMs:90000}),{at:'2026-10-01T00:00:00Z',latencyMs:1});
    const modelFile=readFileSync(join(directory,'model-settings.json'));
    connections=new BrowserConnections(path);const origin=`chrome-extension://${'a'.repeat(32)}`;
    const credential=connections.pair(connections.createPairingCode().code,origin,'Synthetic browser');const connectionBefore=connections.authorize(credential.token,origin);
    const before=store.read();const cleared=await s.workflow.act({type:'clear_profile',expectedRevision:before.revision});
    assertCleared(cleared,before);assert.deepEqual(connections.authorize(credential.token,origin),connectionBefore);assert.deepEqual(readFileSync(join(directory,'model-settings.json')),modelFile);
    connections.close();connections=undefined;store.close();store=undefined;
    store=new Store(path);connections=new BrowserConnections(path);const restored=store.read();
    assert.deepEqual(restored.profile,emptyProfile());assert.equal(restored.factOrganization,undefined);assert.equal(restored.factPreview,null);assert.equal(restored.resumeImport,null);assert.equal(restored.analysis,null);assert.equal(restored.interview,null);
    assert.deepEqual(restored.browserCaptures,cleared.browserCaptures);assert.deepEqual(restored.companyJobs,cleared.companyJobs);assert.deepEqual(restored.exploration,cleared.exploration);assert.deepEqual(restored.resumes,cleared.resumes);
    assert.deepEqual(restored.applications.find(app=>app.status==='confirmed'),cleared.applications.find(app=>app.status==='confirmed'));
    assert.deepEqual(connections.authorize(credential.token,origin),connectionBefore);assert.deepEqual(new SettingsManager(directory,{},protector).public(),settings.public());assert.deepEqual(readFileSync(join(directory,'model-settings.json')),modelFile);
  }finally{
    connections?.close();store?.close();const target=resolve(directory);if(dirname(target)!==resolve(tmpdir())||!basename(target).startsWith('zhihang-profile-clear-'))throw new Error('Unsafe temporary cleanup');rmSync(target,{recursive:true,force:true});
  }
});

test('an empty profile can be cleared without inventing jobs or changing configuration',async t=>{
  const store=new Store(':memory:');t.after(()=>store.close());const workflow=workflowFor(store,new CareerAttachments());
  const state=await workflow.act({type:'clear_profile',expectedRevision:0});assert.deepEqual(state.profile,emptyProfile());assert.equal(state.exploration!.stage,'conversation');assert.deepEqual(state.exploration!.companies,[]);assert.deepEqual(state.resumes,[]);assert.deepEqual(state.applications,[]);
});
