import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {basename,resolve} from 'node:path';
import {parseResumeFile,inferProfileFromText} from '../server/resume-import.ts';
import {createModelEngine,previewFactResegmentation} from '../server/model.ts';
import {SettingsManager} from '../server/model-settings.ts';
import {emptyProfile} from '../server/store.ts';
import type {WorkspaceState} from '../shared/types.ts';

// Explicit opt-in. All model inputs stay in memory; only anonymized statistics
// are saved. This script has no workflow action, DB writer or settings mutation.
const path=process.argv.find(value=>value.startsWith('--file='))?.slice(7);
if(!path||!process.argv.includes('--run'))throw new Error('Requires --run and an authorized local --file= path.');
const settings=new SettingsManager(resolve('data'),{});
assert.equal(settings.public().mode,'live');
const engine=createModelEngine(settings.env());
const before=await(await fetch('http://127.0.0.1:4317/api/state')).json() as WorkspaceState;
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const beforeDigest=digest(before);
const parsed=await parseResumeFile({name:basename(path),mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:readFileSync(path)});
const inferred=inferProfileFromText(parsed.text).fields;
const input={...emptyProfile(),...inferred};
const preview=previewFactResegmentation(input);
const report:any={at:new Date().toISOString(),model:settings.public().model,originalCharacters:input.experienceText.length,previewFacts:preview.facts.length,previewExperiences:preview.groups.filter(group=>group.kind==='experience').length,previewAllPending:preview.facts.every(fact=>!fact.confirmed),productionConfirmedFacts:before.profile.facts.filter(fact=>fact.confirmed).length,checks:[]};
const failureType=(error:unknown)=>{const text=error instanceof Error?error.message:'';return /课程身份/.test(text)?'course_scope_guard':/数字|日期/.test(text)?'numeric_grounding_guard':/无法对应/.test(text)?'source_alignment_guard':/无效的事实引用/.test(text)?'fact_reference_guard':/超时/.test(text)?'model_timeout':/结构|长度|Schema|schema/.test(text)?'model_structure':'other_model_error';};
for(const stage of ['extract','legacy_confirmed_draft'] as const){
  const started=Date.now();
  try{
    if(stage==='extract'){
      const result=await engine.extractProfile(input);
      assert.ok(result.facts.every(fact=>!fact.confirmed&&input.experienceText.includes(fact.text)&&fact.source.includes(fact.text)));
      const external=result.facts.filter(fact=>fact.text.includes('外联部小组长'));
      assert.equal(external.length,1);assert.ok(!/课程论文|课程设计/.test(external[0].text));
      report.checks.push({stage,result:'pass',facts:result.facts.length,questions:result.questions.length,externalScopeSeparate:true,seconds:(Date.now()-started)/1000});
    }else{
      const job=before.job;
      assert.ok(job.text.trim());
      const draft=await engine.draftResume(structuredClone(before.profile),structuredClone(job),before.analysis||undefined);
      report.checks.push({stage,result:'pass',items:draft.document?.sections.flatMap(section=>section.items).length||draft.bullets.length,externalRolePresent:JSON.stringify(draft.document||draft.bullets).includes('外联部小组长'),reviewNotes:draft.reviewNotes?.length||0,seconds:(Date.now()-started)/1000});
    }
  }catch(error){report.checks.push({stage,result:'blocked',reason:failureType(error),seconds:(Date.now()-started)/1000});}
}
const after=await(await fetch('http://127.0.0.1:4317/api/state')).json();
report.productionSnapshotUnchanged=digest(after)===beforeDigest;
mkdirSync(resolve('test-results/fact-boundaries'),{recursive:true});
writeFileSync(resolve('test-results/fact-boundaries/live-report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
