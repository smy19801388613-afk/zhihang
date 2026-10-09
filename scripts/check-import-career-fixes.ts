import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { parseResumeFile, inferProfileFromText } from '../server/resume-import.ts';
import { emptyProfile } from '../server/store.ts';
import { SettingsManager } from '../server/model-settings.ts';
import { createModelEngine } from '../server/model.ts';
import { createCareerEngine } from '../server/career-engine.ts';

const file = process.argv.find(value => value.startsWith('--file='))?.slice(7);
if (!file) throw new Error('Pass the authorized local DOCX via --file=path. No document text is printed or persisted.');
const parsed = await parseResumeFile({name: basename(file), mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: readFileSync(file)});
const inferred = inferProfileFromText(parsed.text);
const {facts: _facts, ...blank} = emptyProfile();
const input = {...blank, ...inferred.fields};
const report: any = {checkedAt: new Date().toISOString(), mode: process.argv.includes('--baseline') ? 'baseline' : 'fixed', source: 'user-authorized-local-docx', sourceCharacters: parsed.text.length, experienceCharacters: input.experienceText.length, paragraphs: input.experienceText.split(/\n\s*\n/).filter(Boolean).length, parseWarnings: parsed.warnings.length, modelCalls: []};
if (process.argv.includes('--live')) {
  const env = new SettingsManager(resolve('data'), {}).env();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (target, options) => {
    const response = await originalFetch(target, options);
    const content = await response.clone().json().catch(() => null) as any;
    const item: any = {status: response.status, usage: content?.usage};
    try {
      const result = JSON.parse(content?.choices?.[0]?.message?.content || '{}');
      if (Array.isArray(result.facts)) {
        const compact = (value: string) => value.replace(/\s+/gu, '');
        item.factCount = result.facts.length;
        item.unmatchedCopiedSources = result.facts.filter((fact: any) => typeof fact.source === 'string' && !input.experienceText.includes(fact.source)).length;
        item.whitespaceOnlySourceMismatches = result.facts.filter((fact: any) => typeof fact.source === 'string' && !input.experienceText.includes(fact.source) && compact(input.experienceText).includes(compact(fact.source))).length;
      }
    } catch { /* Never persist response prose or private source excerpts. */ }
    report.modelCalls.push(item);
    return response;
  };
  try {
    const extracted = await createModelEngine(env).extractProfile(input);
    report.extraction = {status: 'ok', facts: extracted.facts.length, allAnchored: extracted.facts.every(fact => input.experienceText.includes(fact.source) && fact.source.includes(fact.text)), allPending: extracted.facts.every(fact => !fact.confirmed), questions: extracted.questions.length};
    if (process.argv.includes('--chat')) {
      // Career live checks use synthetic confirmed evidence, not the private resume.
      const career = createCareerEngine(env);
      const profile = {...emptyProfile(), major:'法学', education:'本科', city:'上海', targetRole:'', facts:[{id:'synthetic-law', text:'参与课程法律案例检索，整理研究资料并汇总为报告。', source:'synthetic', confirmed:true}]};
      let messages: any[] = []; let directions: any[] = [];
      report.chat = [];
      for (const message of ['我还不清楚行业和岗位区别，请从互联网合规和出海制造产品合规解释适合如何判断。我优先考虑成长和薪资。', '先详细介绍互联网数据隐私岗位的日常任务、入门差距和可以准备的作品，不要再问城市和优先项。', '上海，刚才已经说过。给我下一步具体行动。']) {
        messages.push({role:'user', content:message});
        const answer = await career.chat(profile, messages, directions);
        report.chat.push({responseCharacters:answer.message.length, directionCount:answer.directions.length, questionMarks:(answer.message.match(/[?？]/g)||[]).length, repeatedCityQuestion:/你.{0,8}(希望|想|考虑).{0,10}(城市|哪里)/u.test(answer.message), stableIds: directions.filter(d => answer.directions.some(n => n.industry === d.industry && n.role === d.role)).every(d => answer.directions.find(n => n.industry === d.industry && n.role === d.role)?.id === d.id)});
        messages.push({role:'assistant',content:answer.message}); directions=answer.directions;
      }
    }
  } catch(error) {report.error = error instanceof Error ? error.message.replaceAll(env.MODEL_API_KEY || '\0', '[REDACTED]') : 'Unknown test failure';}
  finally {globalThis.fetch=originalFetch;}
}
mkdirSync(resolve('test-results/import-career-fixes'), {recursive:true});
writeFileSync(resolve('test-results/import-career-fixes',`${report.mode}.json`),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
