// hooks.test.js — hooks 对账测试（RFC-0005 §3.1/§3.4）
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createState, saveState, readState, contentHash } from '../lib/state.js';
import { findStates } from '../lib/bundle.js';

// 复制 reconcile 逻辑（从 session-end.mjs）——保持与 hook 一致的可测函数
import { contentHash as ch } from '../lib/state.js';

function tmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `2o-hook-${tag}-`));
}

// 直接对账一份文件（同 session-end reconcile 逻辑）
function reconcile(file) {
  const s = readState(file);
  if (!s) return { status: 'skipped' };
  const newHash = ch(s);
  if (s.content_hash === newHash) return { status: 'unchanged' };
  s.content_hash = newHash;
  s.version = (s.version || 0) + 1;
  s.updated_at = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(s, null, 2), 'utf8');
  return { status: 'written', version: s.version };
}

test('对账：内容没变 → unchanged，version 不涨', () => {
  const root = tmp('same');
  const f = path.join(root, 'demo/a/task.origin.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const s = createState({ id: 'a', goal: 'x' });
  saveState(f, s);
  const v = readState(f).version;
  const r = reconcile(f);
  assert.equal(r.status, 'unchanged');
  assert.equal(readState(f).version, v, 'version 不该涨');
});

test('对账：裸改内容（不动 hash）→ written，hash 补上', () => {
  const root = tmp('dirty');
  const f = path.join(root, 'demo/a/task.origin.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const s = createState({ id: 'a', goal: 'x' });
  saveState(f, s);
  // 裸改：改 current_state 但不动 content_hash
  const dirty = readState(f);
  dirty.current_state = '被外部改';
  fs.writeFileSync(f, JSON.stringify(dirty, null, 2));
  const before = dirty.content_hash;

  const r = reconcile(f);
  assert.equal(r.status, 'written', '裸改必须被抓出');
  const after = readState(f);
  assert.notEqual(after.content_hash, before, 'hash 要更新');
  assert.ok(after.version > dirty.version, 'version 要涨');
});

test('对账：contentHash 对相同内容稳定', () => {
  const s = createState({ id: 'a', goal: 'x' });
  const h1 = contentHash(s);
  const s2 = { ...s, version: 99, updated_at: '随便' }; // version/updated_at 不影响
  const h2 = contentHash(s2);
  assert.equal(h1, h2, 'content_hash 排除 version/updated_at');
});
