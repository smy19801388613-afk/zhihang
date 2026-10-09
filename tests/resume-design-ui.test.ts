import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ResumeDesignStatus from '../src/ResumeDesignStatus.tsx';
import { diffResumeDocuments, summarizeResumeChanges } from '../shared/resume-diff.ts';
import { DEFAULT_RESUME_DESIGN } from '../shared/resume-design.ts';
import { emptyProfile } from '../server/store.ts';
import type { ResumeDocument, ResumeVersion } from '../shared/types.ts';

const document: ResumeDocument = { headline: '合成测试岗位', summary: '', sections: [], theme: 'modern', accent: 'ink' };
const resume: ResumeVersion = { id: 'synthetic', version: 1, createdAt: '2026-10-07T00:00:00Z', profile: emptyProfile(), job: { company: '合成公司', title: '测试岗位', text: '', url: '' }, document, bullets: [], rationale: '', approved: false };

test('design differences preserve unknown legacy parameters and identify style-only edits', () => {
  assert.deepEqual(diffResumeDocuments(document, document), []);
  assert.ok(diffResumeDocuments(document, { ...document, design: DEFAULT_RESUME_DESIGN }).every(change => change.before === '历史模板未记录'));
  const next = { ...document, design: { ...DEFAULT_RESUME_DESIGN, marginMm: 14, educationPosition: 'last' as const } };
  assert.deepEqual(diffResumeDocuments({ ...document, design: DEFAULT_RESUME_DESIGN }, next).map(change => change.field), ['design.marginMm', 'design.educationPosition']);
  assert.match(summarizeResumeChanges(document, next), /正文未变化/);
});
test('unchecked, warning, and edited drafts cannot appear as PDF quality passed', () => {
  for (const quality of [undefined, { status: 'not_checked' as const, checkedAt: '2026-10-07', warnings: [], adjustments: [] }, { status: 'warning' as const, checkedAt: '2026-10-07', pageCount: 2, warnings: ['超过一页目标，全部内容保留。'], adjustments: [] }]) {
    const markup = renderToStaticMarkup(createElement(ResumeDesignStatus, { resume: { ...resume, quality }, dirty: false }));
    assert.doesNotMatch(markup, /tag green|PDF 排版检查通过/);
    if (quality?.pageCount) assert.match(markup, /2 页/);
  }
  const markup = renderToStaticMarkup(createElement(ResumeDesignStatus, { resume: { ...resume, quality: { status: 'passed', checkedAt: '2026-10-07', pageCount: 1, warnings: [], adjustments: [] } }, dirty: true }));
  assert.match(markup, /草稿尚未检查/); assert.doesNotMatch(markup, /tag green/);
  assert.match(markup, /历史内置模板；未记录受控排版参数/); assert.doesNotMatch(markup, /10.5 pt|17 mm/);
});
