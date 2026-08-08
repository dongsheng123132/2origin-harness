// state.test.js — 状态层测试
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createState, saveState, readState, addFact, addLearning, promoteLearning } from '../lib/state.js';

function tmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `2o-state-${tag}-`));
}

test('createState 需要 id 和 goal', () => {
  assert.throws(() => createState({ id: 'x' }), /goal/);
  assert.throws(() => createState({ goal: 'x' }), /id/);
});

test('createState 产出符合 2Origin 铁律的空状态', () => {
  const s = createState({ id: 't1', goal: '测试' });
  assert.equal(s.spec, '2origin/0.1');
  assert.equal(s.kind, 'task.origin');
  assert.equal(s.version, 1);
  assert.deepEqual(s.facts, []);
  assert.deepEqual(s.learnings, []);
});

test('saveState 版本递增 + 刷 updated_at', () => {
  const dir = tmp('ver');
  const file = path.join(dir, 'task.origin.json');
  const s = createState({ id: 't2', goal: 'x' });
  saveState(file, s);
  assert.equal(s.version, 2, '第一次保存 version 1→2');
  const t = readState(file);
  assert.equal(t.version, 2);
});

test('addFact 必须带 source，verified 默认 true', () => {
  const s = createState({ id: 't3', goal: 'x' });
  addFact(s, '地球是圆的', '实验');
  assert.equal(s.facts[0].verified, true);
  assert.equal(s.facts[0].source, '实验');
});

test('addLearning 默认 candidate，promote 才 verified', () => {
  const s = createState({ id: 't4', goal: 'x' });
  addLearning(s, '一次成功不是真理', 0.5);
  assert.equal(s.learnings[0].status, 'candidate', '新经验必须是 candidate');
  promoteLearning(s, '一次成功不是真理', 0.9);
  assert.equal(s.learnings[0].status, 'verified');
  assert.equal(s.learnings[0].confidence, 0.9);
});
