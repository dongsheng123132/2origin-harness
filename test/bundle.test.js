// bundle.test.js — 本境 bundle 编译测试（RFC-0005 §3.4）
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createState, saveState, addFact } from '../lib/state.js';
import { buildBundle, findStates } from '../lib/bundle.js';

function tmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `2o-bundle-${tag}-`));
}

test('findStates：找到所有 task.origin.json', () => {
  const root = tmp('find');
  fs.mkdirSync(path.join(root, 'demo/a'), { recursive: true });
  fs.mkdirSync(path.join(root, 'demo/b'), { recursive: true });
  saveState(path.join(root, 'demo/a/task.origin.json'), createState({ id: 'a', goal: 'x' }));
  saveState(path.join(root, 'demo/b/task.origin.json'), createState({ id: 'b', goal: 'y' }));
  assert.equal(findStates(root).length, 2);
});

test('bundle：装载全部学历，无丢弃', () => {
  const root = tmp('all');
  fs.mkdirSync(path.join(root, 'demo/a'), { recursive: true });
  const s = createState({ id: 'a', goal: '分析销售' });
  addFact(s, 'Q2 销售额 800 万', 'reports/Q2.json');
  saveState(path.join(root, 'demo/a/task.origin.json'), s);

  const b = buildBundle(root);
  assert.equal(b.ok, true);
  assert.equal(b.loaded, 1);
  assert.equal(b.totalFacts, 1);
  assert.ok(b.text.includes('Q2 销售额'), '事实要进 bundle');
  assert.ok(!b.text.includes('⚠ 未装载'), '无丢弃');
});

test('bundle：预算耗尽时丢弃透明（铁律）', () => {
  const root = tmp('drop');
  // 当前任务：只有 1 条事实（最新，全量装载）
  fs.mkdirSync(path.join(root, 'demo/cur'), { recursive: true });
  const cur = createState({ id: 'cur', goal: '当前任务' });
  addFact(cur, '当前任务的唯一事实', 'reports/cur.json');
  saveState(path.join(root, 'demo/cur/task.origin.json'), cur);

  // 结转任务：20 条事实（会挤爆预算）
  fs.mkdirSync(path.join(root, 'demo/carry'), { recursive: true });
  const carry = createState({ id: 'carry', goal: '结转任务' });
  for (let i = 0; i < 20; i++) addFact(carry, `结转事实编号 ${i}：这是第 ${i} 条验证过的内容`, `reports/f${i}.json`);
  // 手动给 carry 一个更早的 mtime，确保它是结转不是当前
  saveState(path.join(root, 'demo/carry/task.origin.json'), carry);
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(root, 'demo/carry/task.origin.json'), old, old);

  // 极小预算 → 结转任务的 20 条肯定丢
  const b = buildBundle(root, { budget: 100 });
  assert.ok(b.dropped.length > 0, '预算耗尽必须记录丢弃');
  assert.ok(b.text.includes('⚠ 未装载'), '丢弃必须写在 bundle 开头');
});

test('bundle：source 不可复核的 fact 带标记', () => {
  const root = tmp('mark');
  fs.mkdirSync(path.join(root, 'demo/a'), { recursive: true });
  const s = createState({ id: 'a', goal: 'x' });
  // 直接塞一条不可复核 source 的 fact（绕过 addFact 校验，模拟外部写入）
  s.facts.push({ claim: '没来源的结论', verified: true, source: '我就是知道', when: 'now' });
  saveState(path.join(root, 'demo/a/task.origin.json'), s);

  const b = buildBundle(root);
  assert.ok(b.text.includes('⚠source不可复核'), '不可复核的 source 要标出来');
});
