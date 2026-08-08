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
  st.facts = [{ claim: 'f', verified: true, source: 'evidence/real.md', when: 'now' }];
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

// ── D2/C6：learning 生命周期检查（能打穿故意造假才算判据）──

test('D2：伪造 verified learning（无 promoted_at）→ 打穿 FAIL', () => {
  const root = tmp('c6fake');
  const st = createState({ id: 'x', goal: 'g' });
  // 一上来就写 verified，从没当过 candidate（D2 的病）
  st.learnings = [{ lesson: '伪造的已验证经验', confidence: 0.99, status: 'verified' }];
  fs.mkdirSync(path.join(root, 'demo'), { recursive: true });
  saveState(path.join(root, 'demo/x/task.origin.json'), st);

  const res = verify(path.join(root, 'demo/x/task.origin.json'), root);
  assert.equal(res.verdict, '❌ NOT VERIFIED');
  assert.ok(res.failed.some(f => f.includes('无晋升事件')), '要抓出没走过 candidate 的 verified');
});

test('D2：正常晋升（有 promoted_at）→ PASS', () => {
  const root = tmp('c6ok');
  const st = createState({ id: 'x', goal: 'g' });
  st.learnings = [{
    lesson: '真验证过的经验', confidence: 0.9, status: 'verified',
    promoted_at: '2026-08-08T10:00:00Z', promoted_by: 'claude-code', promotion_evidence: 'docs/guide.md'
  }];
  fs.mkdirSync(path.join(root, 'demo'), { recursive: true });
  saveState(path.join(root, 'demo/x/task.origin.json'), st);

  const res = verify(path.join(root, 'demo/x/task.origin.json'), root);
  assert.ok(res.passed.some(p => p.includes('有晋升事件')), '正常晋升要 PASS');
  assert.equal(res.failed.length, 0);
});
