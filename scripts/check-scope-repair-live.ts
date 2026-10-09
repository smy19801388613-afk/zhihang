import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {SettingsManager} from '../server/model-settings.ts';
import {createModelEngine} from '../server/model.ts';
import {emptyProfile} from '../server/store.ts';
import {buildAnalysis} from '../server/matching.ts';
import type {ResumeDocument} from '../shared/types.ts';

if(!process.argv.includes('--run'))throw new Error('Use --run for this paid synthetic-only repair check.');
const profile={...emptyProfile(),facts:[{id:'course',text:'课程项目：检索20份公开政策并记录材料出处。',source:'课程项目：检索20份公开政策并记录材料出处。',confirmed:true},{id:'campus',text:'校园招聘会志愿者，协助参会企业对接与现场安排。',source:'校园招聘会志愿者，协助参会企业对接与现场安排。',confirmed:true}]};
const job={company:'合成测试公司',title:'资料整理实习',text:'协助资料整理。',url:''};
const document:ResumeDocument={headline:'资料整理实习',summary:'',theme:'modern',accent:'navy',sections:[{id:'practice',title:'实践经历',items:[{id:'course_item',title:'公开政策整理',subtitle:'项目实践',date:'',content:'检索20份公开政策并记录材料出处。',factIds:['course']},{id:'campus_item',title:'校园招聘会',subtitle:'志愿者',date:'',content:'协助参会企业对接与现场安排。',factIds:['campus']}]}]};
const settings=new SettingsManager(resolve('data'),{});assert.equal(settings.public().mode,'live');
let intercepted=0;let realRequests=0;
const originalFetch=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
  if(!intercepted++){return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({document,rationale:'仅依据合成事实组织。',reviewNotes:[]})}}]}));}
  realRequests++;return originalFetch(input,init);
};
const report:any={at:new Date().toISOString(),syntheticDataOnly:true,firstDraftResponseInjected:true,repairProvider:settings.public().provider,model:settings.public().model};
try{
  const draft=await createModelEngine(settings.env()).draftResume(profile,job,buildAnalysis(profile,job));
  assert.deepEqual(draft.document!.sections[0].items.find(item=>item.id==='campus_item'),document.sections[0].items[1]);
  report.status='pass';report.items=draft.document!.sections.flatMap(section=>section.items).length;report.scopeRepairReported=draft.reviewNotes?.some(note=>note.includes('一次限定修正'))||false;
}catch(error){report.status='blocked';report.reason=error instanceof Error?(/课程身份/.test(error.message)?'missing_course_identity':/修正改动/.test(error.message)?'repair_exceeded_scope':/数字|日期/.test(error.message)?'numeric_guard':'validation_or_model_error'):'unknown';}
finally{globalThis.fetch=originalFetch;report.actualProviderRequests=realRequests;mkdirSync(resolve('test-results/fact-boundaries'),{recursive:true});writeFileSync(resolve('test-results/fact-boundaries/synthetic-repair-live.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
