import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SettingsManager } from '../server/model-settings.ts';
import { createModelEngine } from '../server/model.ts';
import { captureJob } from '../server/browser-capture.ts';
import { semanticFactSources } from '../server/fact-segmentation.ts';
import type { WorkspaceState } from '../shared/types.ts';

if (!process.argv.includes('--run')) throw new Error('Use --run for the explicitly authorized read-only live model check.');
const response=await fetch('http://127.0.0.1:4317/api/state');
if(!response.ok)throw new Error('Local workspace is unavailable.');
const state=await response.json() as WorkspaceState;
const workspaceHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const before=workspaceHash(state);
const capture=Object.values(state.browserCaptures || {}).find(record=>record.fields.company.includes('丽兹行'));
if(!capture)throw new Error('Target captured company not found.');
const job=captureJob(capture);
const env=new SettingsManager(resolve('data'),{}).env();
const report:any={checkedAt:new Date().toISOString(),readOnly:true,company:'北京丽兹行',confirmedFacts:state.profile.facts.filter(f=>f.confirmed).length,jdCharacters:job.text.length,calls:[]};
const classify=(error:unknown)=>{
  const message=error instanceof Error?error.message:'';
  if(/课程身份/.test(message))return 'missing_course_scope';
  if(/(?:没有依据|尚无依据)的数字/.test(message))return 'unsupported_numeric_claim';
  if(/事实引用/.test(message))return 'invalid_fact_reference';
  if(/负责人|独立|领导|范围|身份|参与/.test(message))return 'unsupported_experience_scope';
  if(error && typeof error==='object' && 'code' in error)return String(error.code);
  return 'validation_or_model_error';
};
const originalFetch=globalThis.fetch;
let rawDraft:any;
globalThis.fetch=async(target,options)=>{
  const result=await originalFetch(target,options);
  const payload=await result.clone().json().catch(()=>null) as any;
  report.calls.push({status:result.status,usage:payload?.usage});
  try{const data=JSON.parse(payload?.choices?.[0]?.message?.content?.replace(/^```(?:json)?\s*|\s*```$/g,'')||'null');if(data?.document)rawDraft=data.document;}catch{/* Do not log raw model or user text. */}
  return result;
};
try {
  const engine=createModelEngine(env);
  let analysis;
  try{analysis=await engine.analyzeJob(state.profile,job);report.analysis={status:'ok',matches:analysis.matches.length,agentRun:analysis.agentRun};}
  catch(error){report.analysis={status:'error',category:classify(error),errorClass:error instanceof Error?error.name:'unknown',location:error instanceof Error?error.stack?.split('\n')[1]?.trim():undefined,...(error instanceof TypeError?{detail:error.message}: {})};}
  if(analysis){
    try{const draft=await engine.draftResume(state.profile,job,analysis);report.draft={status:'ok',items:draft.document?.sections.reduce((n,s)=>n+s.items.length,0),characters:draft.bullets.map(b=>b.text).join('').length};}
    catch(error){
      const title=error instanceof Error?error.message.match(/条目“([^”]+)”/)?.[1]:undefined;
      const item=rawDraft?.sections?.flatMap((section:any)=>section.items||[]).find((candidate:any)=>candidate.title===title);
      const evidence=item?state.profile.facts.filter(fact=>item.factIds?.includes(fact.id)).map(fact=>[fact.sourceContext,fact.text].filter(Boolean).join('\n')).join('\n'):'';
      const output=item?[item.title,item.subtitle,item.content].join('\n'):'';
      report.draft={status:'error',category:classify(error),...(item?{diagnostic:{factCount:item.factIds.length,outputCharacters:output.length,outputHasCourse:/课程|课堂/.test(output),outputHasExternalRole:/外联部|小组长/.test(output),outputHasCampus:/校园|社团|招聘会/.test(output),sourceGroups:semanticFactSources(evidence).map(group=>({kind:group.kind,characters:group.text.length,hasCourse:/课程|课堂/.test(group.text),hasCourseProject:/课程(?:设计|项目|论文|研究|实验)/.test(group.text),hasExternalRole:/外联部|小组长/.test(group.text)}))}}:{})};
    }
  }
}finally{
  globalThis.fetch=originalFetch;
  const after=await originalFetch('http://127.0.0.1:4317/api/state').then(result=>result.json());
  report.productionSnapshotUnchanged=workspaceHash(after)===before;
  const reportDir=resolve('test-results/v09-agent');
  mkdirSync(reportDir,{recursive:true});
  writeFileSync(resolve(reportDir,'captured-resume-live.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  assert.ok(report.productionSnapshotUnchanged,'Read-only live test must retain the saved workspace');
  assert.equal(report.analysis?.status,'ok','Live analysis must succeed');
  assert.equal(report.draft?.status,'ok','Live resume generation must succeed');
}
