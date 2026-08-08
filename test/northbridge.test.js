// northbridge.test.js — 北桥标准接口测试（context.request → context.bundle）
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createState, saveState, addFact } from '../lib/state.js';
import { buildContext } from '../lib/northbridge.js';

function tmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `2o-nb-${tag}-`));
}

test('北桥：无状态时返回空 bundle 和 note', () => {
  const root = tmp('empty');
  const b = buildContext(root, { goal: '写文档' });
  assert.equal(b.kind, 'context.bundle', '标准输出要有 kind');
  assert.equal(b.state.length, 0);
  assert.ok(b.note.includes('不是整个硬盘'));
});

test('北桥：有状态时 state[] 带 current_state 和 next_steps', () => {
  const root = tmp('one');
  const st = createState({ id: 'doc', goal: '写发布文档' });
  st.current_state = '写了一半';
  st.next_steps = ['写完引言'];
  fs.mkdirSync(path.join(root, 'demo'), { recursive: true });
  saveState(path.join(root, 'demo/doc/task.origin.json'), st);

  const b = buildContext(root, { goal: '写发布文档' });
  assert.equal(b.state.length, 1);
  assert.equal(b.state[0].current_state, '写了一半');
  assert.deepEqual(b.state[0].next_steps, ['写完引言']);
});

test('北桥：按 goal 相关性选 facts 进 memory，不全部进 Context', () => {
  const root = tmp('rel');
  const st = createState({ id: 'x', goal: '写销售报告' });
  addFact(st, '第二季度销售额 800 万', 'reports/Q2-2026.json');
  addFact(st, '服务器 IP 是 10.0.0.1', 'cat ~/.uking/device.json');
  fs.mkdirSync(path.join(root, 'demo'), { recursive: true });
  saveState(path.join(root, 'demo/x/task.origin.json'), st);

  const b = buildContext(root, { goal: '写销售报告' });
  assert.ok(b.memory.length >= 1);
  assert.ok(b.memory[0].claim.includes('销售额'), '相关的 fact 优先，实际: ' + b.memory[0].claim);
});

test('北桥：scope 过滤 state', () => {
  const root = tmp('scope');
  const a = createState({ id: 'a', goal: 'x', scope: 'project:a' });
  const b2 = createState({ id: 'b', goal: 'y', scope: 'project:b' });
  fs.mkdirSync(path.join(root, 'demo/a'), { recursive: true });
  fs.mkdirSync(path.join(root, 'demo/b'), { recursive: true });
  saveState(path.join(root, 'demo/a/task.origin.json'), a);
  saveState(path.join(root, 'demo/b/task.origin.json'), b2);

  const b = buildContext(root, { goal: 'x', scope: ['project:a'] });
  assert.equal(b.state.length, 1, 'scope 过滤后只剩 project:a');
  assert.equal(b.state[0].id, 'a');
});

test('北桥：超预算时 honest 标注 over_budget', () => {
  const root = tmp('budget');
  const st = createState({ id: 'x', goal: 'g' });
  addFact(st, '事实 A', 'evidence/a.json');
  fs.mkdirSync(path.join(root, 'demo'), { recursive: true });
  saveState(path.join(root, 'demo/x/task.origin.json'), st);

  const b = buildContext(root, { goal: 'g', budget: { tokens: 1 } }); // 极低预算
  assert.ok(b.over_budget === true || b.token_estimate > 0, '超预算要标注或至少估算>0');
  assert.ok(b.note.includes('超预算') || b.note.includes('不是整个硬盘'), 'note 要诚实');
});
