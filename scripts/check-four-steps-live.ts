import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { SettingsManager } from '../server/model-settings.ts';
import { createModelEngine } from '../server/model.ts';
import { createCareerEngine } from '../server/career-engine.ts';
import { createCompanyResearcher } from '../server/company-research.ts';
import { renderResumePdf, closeBrowser } from '../server/browser.ts';
import { Workflow } from '../server/workflow.ts';
import { Store } from '../server/store.ts';
import { toResumeDocument } from '../shared/resume-template.ts';
import type { CompanyCandidate, Profile, Job } from '../shared/types.ts';

if (!process.argv.includes('--run')) { console.log('Synthetic paid live check: use --run explicitly.'); process.exit(0); }
const root=process.cwd();
const env=new SettingsManager(resolve(root,'data'),{}).env();
assert.ok(env.MODEL_API_KEY,'请先在本机设置启用模型。');
const fixtures=JSON.parse(readFileSync(resolve(root,'../benchmarks/fixtures/jobs.json'),'utf8'));
const profile=JSON.parse(readFileSync(resolve(root,'../benchmarks/results/zhihang-model.json'),'utf8')).profile as Profile;
const directory=resolve(root,'test-results/four-steps');mkdirSync(directory,{recursive:true});
const output:{version:string;model?:string;syntheticOnly:boolean;cases:any[];calls:any[];edit?:unknown;research?:unknown;finishedAt?:string}={version:'0.5.0',model:env.MODEL_NAME,syntheticOnly:true,cases:[],calls:[]};
const save=()=>writeFileSync(resolve(directory,'live-model.json'),JSON.stringify(output,null,2));
const originalFetch=globalThis.fetch;
let stage='';
globalThis.fetch=async(input,init)=>{
  const response=await originalFetch(input,init);
  if(new URL(input instanceof Request?input.url:String(input)).hostname===new URL(env.MODEL_BASE_URL!).hostname){
    const payload=await response.clone().json().catch(()=>null) as any;
    output.calls.push({stage,status:response.status,usage:payload?.usage,syntheticReply:payload?.choices?.[0]?.message?.content});save();
  }
  return response;
};
const cleanError=(error:unknown)=>String(error).replaceAll(env.MODEL_API_KEY!,'[REDACTED]');
const engine=createModelEngine(env);const career=createCareerEngine(env);
let editCandidate: any;
try{
  for(const fixture of fixtures.cases){
    const store=new Store(':memory:');const state=store.read();state.profile=structuredClone(profile);
    state.job={company:fixture.company,title:fixture.title,text:fixture.text,url:'',industry:fixture.industry,sourceKind:'user_jd'} as Job;
    let current=store.save(state,state.revision);
    const workflow=new Workflow(store,engine,{fill:async()=>{throw Error('No applications in live check');},submit:async()=>{throw Error('No applications in live check');}},career);
    const result:any={id:fixture.id};output.cases.push(result);const start=performance.now();
    try{
      stage=`${fixture.id}:analyze`;current=await workflow.act({type:'analyze_job',expectedRevision:current.revision});result.analysis=current.analysis;
      if(fixture.id!=='senior-legal-blocker'){
        stage=`${fixture.id}:draft`;current=await workflow.act({type:'generate_resume',expectedRevision:current.revision});
        result.resume=current.resumes.at(-1);if(fixture.id==='law-privacy-intern')editCandidate=result.resume;
        const pdf=await renderResumePdf(result.resume);writeFileSync(resolve(directory,`${fixture.id}.pdf`),pdf);result.pdfBytes=pdf.length;
      }
      result.status='ok';
    }catch(error){result.status='error';result.error=cleanError(error);}
    finally{result.milliseconds=Math.round(performance.now()-start);store.close();save();}
    console.log(JSON.stringify({stage:fixture.id,status:result.status,error:result.error}));
  }
  if(editCandidate){
    stage='resume-edit';try{
      const edited=await career.editResume(editCandidate,'精简表述，突出法律检索和Excel资料整理，保留课程和志愿工作身份，把未参与企业整改等内部限制放审核备注，并改成海军蓝。不要新增经历、英语水平或成果。');
      output.edit={status:'ok',before:toResumeDocument(editCandidate),...edited};
    }catch(error){output.edit={status:'error',error:cleanError(error)};}save();
  }
  stage='company-research';
  const company:CompanyCandidate={id:'synthetic-tencent-privacy',name:'腾讯',industry:'互联网',role:'隐私合规实习方向（未确认具体空缺）',rationale:'',requirements:[],careerUrl:'https://join.qq.com/',sourceLabel:'官网入口',checkedAt:new Date().toISOString(),hiringStatus:'unverified',selected:true};
  output.research=await createCompanyResearcher(env)(company);save();
}finally{globalThis.fetch=originalFetch;await closeBrowser();output.finishedAt=new Date().toISOString();save();}
console.log(JSON.stringify({path:directory,calls:output.calls.length}));
