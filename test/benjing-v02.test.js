// benjing-v02.test.js — 本境 v0.2 机制测试（RFC-0005）
// 覆盖：content_hash 乐观锁 / recheckSource / bundle 一致性
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createState, saveState, readState, contentHash, recheckSource, detectActor, addFact } from '../lib/state.js';

function tmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `2o-v02-${tag}-`));
}

test('content_hash：内容不变则 hash 不变，version 不涨', () => {
  const dir = tmp('ch');
  const file = path.join(dir, 'task.origin.json');
  const s = createState({ id: 't', goal: 'x' });
  // 第一次落盘 → written
  const r0 = saveState(file, s);
  assert.equal(r0.status, 'written');
  const v0 = r0.version;
  // 内容没变，重复保存 → status unchanged，version 不涨
  const r1 = saveState(file, s);
  assert.equal(r1.status, 'unchanged', '内容未变不该重写');
  assert.equal(r1.version, v0, 'version 不涨');
  const r2 = saveState(file, s);
  assert.equal(r2.status, 'unchanged');
});

test('content_hash：内容变了则 hash 变，version 涨', () => {
  const dir = tmp('ch2');
  const file = path.join(dir, 'task.origin.json');
  const s = createState({ id: 't', goal: 'x' });
  const r1 = saveState(file, s);
  s.current_state = '推进了';
  const r2 = saveState(file, s);
  assert.equal(r2.status, 'written');
  assert.equal(r2.version, r1.version + 1);
});

test('乐观锁：expect 不匹配则拒绝写（conflict）', () => {
  const dir = tmp('lock');
  const file = path.join(dir, 'task.origin.json');
  const s = createState({ id: 't', goal: 'x' });
  saveState(file, s);
  // 持错误 hash 想写
  const r = saveState(file, { ...s, current_state: '被篡改' }, { expect: 'wrong-hash' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'conflict');
  // 磁盘仍是原样
  const onDisk = readState(file);
  assert.equal(onDisk.current_state, '刚创建。');
});

test('recheckSource：文件路径可复核', () => {
  assert.equal(recheckSource('evidence/real.json').ok, true);
  assert.equal(recheckSource('git log -S x').ok, true);
  assert.equal(recheckSource('T3.2').ok, true);
});

test('recheckSource：散文断言不可复核', () => {
  assert.equal(recheckSource('实测过').ok, false);
  assert.equal(recheckSource('我说的，不信拉倒').ok, false);
  assert.equal(recheckSource('').ok, false);
});

test('addFact：verified fact 的 source 不可复核则拒绝', () => {
  const s = createState({ id: 't', goal: 'x' });
  assert.throws(() => addFact(s, '地球是圆的', '就是我说的'), /不可复核/);
});

test('detectActor：观测不到 model 就写 unobserved，不许编', () => {
  const a = detectActor('sess-1');
  assert.equal(a.session_id, 'sess-1');
  assert.ok(a.at, 'actor 要有时间');
  // model 字段存在（可能是 unobserved 或真实观测值），但绝不能空
  assert.ok(typeof a.model === 'string' && a.model.length > 0);
});

test('createState 带 content_hash 和 actor', () => {
  const s = createState({ id: 't', goal: 'x' });
  assert.ok(s.content_hash && s.content_hash.length === 64, 'content_hash 是 sha256 hex');
  assert.ok(s.actor && s.actor.harness, 'actor 必须有 harness');
});
