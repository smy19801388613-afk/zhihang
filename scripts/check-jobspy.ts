/** Bounded live public smoke test; no profile, model API or application action. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createJobSpyDiscoverer } from '../server/jobspy.ts';
import type { CareerDirection } from '../shared/types.ts';
const directions: CareerDirection[] = ['法务与合规', '产品经理', '算法工程师'].map((role, index) => ({ id: `test_${index}`, role, industry: '', rationale: '', transferableSkills: [], gaps: [], entryRequirements: '', salaryContext: '' }));
const start = Date.now();
const result = await createJobSpyDiscoverer()({ city: '上海 / 杭州', directions });
mkdirSync('test-results', { recursive: true });
writeFileSync('test-results/jobspy-live.json', JSON.stringify({ testedAt: new Date().toISOString(), elapsedMs: Date.now() - start, criteria: { city: '上海 / 杭州', roles: directions.map(item => item.role) }, ...result }, null, 2));
console.log(JSON.stringify({ elapsedMs: Date.now() - start, count: result.candidates.length, sources: result.sources, samples: result.candidates.map(item => ({ name: item.name, role: item.role, location: item.location, salary: item.salary, url: item.careerUrl, jdLength: item.jobDescription?.length })) }, null, 2));
