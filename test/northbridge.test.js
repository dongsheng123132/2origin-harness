// northbridge.test.js — 北桥 Context 编译测试
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

test('北桥：无状态时返回 note', () => {
  const root = tmp('empty');
  const b = buildContext(root, '写文档');
  assert.equal(b.state, null);
  assert.ok(b.note.includes('no state'));
});

test('北桥：有状态时返回 current_state 和 next_steps', () => {
  const root = tmp('one');
  const st = createState({ id: 'doc', goal: '写发布文档' });
  st.current_state = '写了一半';
  st.next_steps = ['写完引言'];
  fs.mkdirSync(path.join(root, 'demo'), { recursive: true });
  saveState(path.join(root, 'demo/doc/task.origin.json'), st);

  const b = buildContext(root, '写发布文档');
  assert.equal(b.state, path.join(root, 'demo/doc/task.origin.json'));
  assert.equal(b.current_state, '写了一半');
  assert.deepEqual(b.next_steps, ['写完引言']);
});

test('北桥：按 goal 相关性选 facts，不全部进 Context', () => {
  const root = tmp('rel');
  const st = createState({ id: 'x', goal: '写销售报告' });
  addFact(st, '第二季度销售额 800 万', '报表');
  addFact(st, '服务器 IP 是 10.0.0.1', '运维');
  fs.mkdirSync(path.join(root, 'demo'), { recursive: true });
  saveState(path.join(root, 'demo/x/task.origin.json'), st);

  const b = buildContext(root, '写销售报告');
  // 相关性打分：销售报告 goal 下，"销售额" fact 应排前面（"销售"命中）
  assert.ok(b.facts.length >= 1);
  assert.ok(b.facts[0].claim.includes('销售额'), '相关的 fact 优先，实际: ' + b.facts[0].claim);
});
