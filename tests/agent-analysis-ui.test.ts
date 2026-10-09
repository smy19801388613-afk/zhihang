import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MatchAnalysis from '../src/MatchAnalysis.tsx';
import FactSplitReview from '../src/FactSplitReview.tsx';
import { AgentReviewStatus, FactContext, FactSources } from '../src/FactEvidence.tsx';
import { agentAnalysisFixture } from './fixtures/agent-analysis.ts';

test('experience preview preserves parent context and quotations without applying facts', () => {
  const state = agentAnalysisFixture(), before = structuredClone(state);
  const html = renderToStaticMarkup(createElement(FactSplitReview, { state, busy: '', act: async () => { throw new Error('Rendering must never apply the preview'); } }));
  assert.match(html, /所属经历.*校园迎新服务改进/u);
  assert.match(html, /FAQ 检索原型/u);
  assert.match(html, /尚未替换现有事实/u);
  assert.match(html, /查看原文引用 · 2 段引用/u);
  assert.match(html, /请核对原型是否由你独立完成/u);
  assert.match(html, /确认替换，重新审核/u);
  assert.deepEqual(state, before);
});

test('matching starts with work and advice, and distinguishes transferable evidence from direct experience', () => {
  const state = agentAnalysisFixture();
  const html = renderToStaticMarkup(createElement(MatchAnalysis, { analysis: state.analysis!, profile: state.profile, job: state.job }));
  assert.ok(html.indexOf('这个岗位主要做什么') < html.indexOf('申请建议'));
  assert.ok(html.indexOf('申请建议') < html.indexOf('逐项核对证据'));
  for (const label of ['能带去的优势', '需要补足或核对', '先核对关键条件', '能力可迁移', '直接经验', '招聘原文依据', '查看个人资料与经历依据', '待核对']) assert.ok(html.includes(label), label);
  for (const group of ['required', 'capability', 'preferred', 'responsibility']) assert.ok(html.includes(`data-testid="match-${group}"`));
  assert.doesNotMatch(html, /录用概率|成功率|匹配率/u);
});

test('legacy facts and analyses remain readable without agent metadata', () => {
  const state = agentAnalysisFixture(), old = { id: 'old', text: '旧事实', source: '旧来源原文', sourceContext: '旧项目上下文', confirmed: true };
  assert.match(renderToStaticMarkup(createElement(FactContext, { fact: old })), /旧项目上下文/u);
  assert.match(renderToStaticMarkup(createElement(FactSources, { fact: old })), /旧来源原文/u);
  const analysis = { summary: '历史摘要', matches: [], questions: [], directionAdvice: [] };
  const html = renderToStaticMarkup(createElement(MatchAnalysis, { analysis, profile: state.profile, job: state.job }));
  assert.match(html, /历史摘要/u);
  assert.match(html, /旧版分析，可重新分析/u);
});

test('explicit non-restrictions remain readable as context rather than candidate gates', () => {
  const state = agentAnalysisFixture();
  state.analysis!.contextNotes = [{ note: '招聘方未限制工作经验，不作为能力门槛。', sourceQuotes: ['经验要求：经验不限'] }];
  const html = renderToStaticMarkup(createElement(MatchAnalysis, { analysis: state.analysis!, profile: state.profile, job: state.job }));
  assert.match(html, /data-testid="job-context-notes"[^]*经验要求：经验不限/u);
  const groupHtml = html.slice(html.indexOf('data-testid="match-required"'));
  assert.doesNotMatch(groupHtml, /经验不限/u);
});

test('evidence markup escapes untrusted text and separates demonstration from reviewed agent output', () => {
  const state = agentAnalysisFixture();
  const fact = { ...state.profile.facts[0], sourceQuotes: ['<img src=x onerror=alert(1)>'] };
  const html = renderToStaticMarkup(createElement(FactSources, { fact }));
  assert.doesNotMatch(html, /<img /u);
  assert.match(html, /&lt;img/u);
  const run = { ...state.factOrganization!, model: 'local-demo', reviewed: true };
  const status = renderToStaticMarkup(createElement(AgentReviewStatus, { run }));
  assert.match(status, /规则演示/u);
  assert.match(status, /待你核对/u);
  assert.doesNotMatch(status, /已检查依据/u);
});
