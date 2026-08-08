// bugscope.test.js — bug 透视镜测试
import { test } from 'node:test';
import assert from 'node:assert';
import { bugscope, audit } from '../lib/bugscope.js';

test('A1：claim 无 evidence → 命中', () => {
  const r = bugscope({ events: [{ id: 'x', claim: '标记存在=>崩溃', evidence: null, label: 'x' }] });
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].axiom, 'A1');
  assert.ok(r.verdict.includes('认知越界'));
});

test('A1：claim 有 evidence → 不命中', () => {
  const r = bugscope({ events: [{ id: 'x', claim: '文件已写', evidence: 'stat+sha256', label: 'x' }] });
  assert.equal(r.hits.length, 0);
  assert.ok(r.verdict.includes('未发现'));
});

test('A1：verified fact 缺 source → 命中', () => {
  const r = bugscope({ state: { facts: [{ claim: '结论', verified: true, source: null }] } });
  assert.equal(r.hits.length, 1);
});

test('A2：producer===observer → 命中自证', () => {
  const r = bugscope({ report: { producer: 's', observer: 's', label: '自证' } });
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].axiom, 'A2');
});

test('A3：judge 有依据 decider 无 → 命中', () => {
  const r = bugscope({ report: { judgeHasBasis: true, deciderHasBasis: false, judgeName: '南桥', deciderName: 'harness' } });
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].axiom, 'A3');
});

test('audit 便捷函数：单条审', () => {
  const hit = audit('没证据的声明', null);
  assert.equal(hit.hits.length, 1);
  const clean = audit('有证据', 'evidence/file.md');
  assert.equal(clean.hits.length, 0);
});
