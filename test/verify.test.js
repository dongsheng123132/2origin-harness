// verify.test.js — 验证层测试（C5：观察现实，不信声称）
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createState, saveState } from '../lib/state.js';
import { verify } from '../lib/verify.js';

function tmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `2o-verify-${tag}-`));
}

test('验证：声称的 artifact 不存在 → NOT VERIFIED', () => {
  const root = tmp('ghost');
  const st = createState({ id: 'x', goal: 'g' });
  st.artifacts = ['demo/ghost.md']; // 声称存在，实际没有
  fs.mkdirSync(path.join(root, 'demo'), { recursive: true });
  saveState(path.join(root, 'demo/x/task.origin.json'), st);

  const res = verify(path.join(root, 'demo/x/task.origin.json'), root);
  assert.equal(res.verdict, '❌ NOT VERIFIED');
  assert.ok(res.failed.some(f => f.includes('ghost.md')));
});

test('验证：artifact 真实存在 → PASS', () => {
  const root = tmp('real');
  const st = createState({ id: 'x', goal: 'g' });
  st.artifacts = ['demo/real.md'];
  st.facts = [{ claim: 'f', verified: true, source: 'src', when: 'now' }];
  fs.mkdirSync(path.join(root, 'demo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'demo/real.md'), 'x');
  saveState(path.join(root, 'demo/x/task.origin.json'), st);

  const res = verify(path.join(root, 'demo/x/task.origin.json'), root);
  assert.equal(res.verdict, '✅ VERIFIED (通过现实观察确认)');
  assert.equal(res.failed.length, 0);
});

test('验证：verified fact 缺 source → FAIL', () => {
  const root = tmp('nosrc');
  const st = createState({ id: 'x', goal: 'g' });
  st.facts = [{ claim: '没有来源的事实', verified: true }]; // 缺 source
  fs.mkdirSync(path.join(root, 'demo'), { recursive: true });
  saveState(path.join(root, 'demo/x/task.origin.json'), st);

  const res = verify(path.join(root, 'demo/x/task.origin.json'), root);
  assert.equal(res.verdict, '❌ NOT VERIFIED');
});
