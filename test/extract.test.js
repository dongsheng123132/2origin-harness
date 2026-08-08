// extract.test.js — 经验自动提取器测试（定位：粗筛信号，非语义理解）
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractFromJsonl, extractAndApply } from '../lib/extract.js';
import { createState } from '../lib/state.js';

function tmpJsonl(lines) {
  const f = path.join(os.tmpdir(), `ext-${Date.now()}-${Math.random().toString(36).slice(2,6)}.jsonl`);
  fs.writeFileSync(f, lines.map(l => JSON.stringify(l)).join('\n'));
  return f;
}

test('提取：从含 error 的 transcript 提取信号', () => {
  const f = tmpJsonl([
    { type: 'assistant', message: { role: 'assistant', content: '任务开始，一切正常，没有遇到任何问题' } },
    { type: 'assistant', message: { role: 'assistant', content: '执行失败：权限不足，我重试一次后成功完成，这是关键教训' } },
  ]);
  const hits = extractFromJsonl(f);
  assert.ok(hits.length >= 1, '应至少提取到 1 条（error 或 retry）');
  assert.ok(hits[0].evidence.includes('.jsonl:'), 'evidence 要指向行号');
  fs.rmSync(f, { force: true });
});

test('去重：同 lesson 只留一条', () => {
  const f = tmpJsonl([
    { type: 'assistant', message: { role: 'assistant', content: '踩坑：路径别用中文' } },
    { type: 'assistant', message: { role: 'assistant', content: '踩坑：路径别用中文（重复）' } },
  ]);
  const hits = extractFromJsonl(f);
  const lessons = hits.map(h => h.lesson);
  assert.equal(new Set(lessons).size, lessons.length, 'lesson 不能重复');
  fs.rmSync(f, { force: true });
});

test('apply：追加 candidate 到状态，不晋升', () => {
  const f = tmpJsonl([
    { type: 'assistant', message: { role: 'assistant', content: '第一次执行失败报错了，加了重试机制之后终于成功了，这是值得记住的教训' } },
  ]);
  const s = createState({ id: 't', goal: 'x' });
  const r = extractAndApply(s, f);
  assert.ok(r.added >= 1, '要追加 candidate');
  assert.ok(s.learnings.length >= 1);
  assert.equal(s.learnings[0].status, 'candidate', '只能是 candidate，不是 verified');
  fs.rmSync(f, { force: true });
});

test('空/不存在文件：不崩溃返回空', () => {
  const hits = extractFromJsonl('nonexistent.jsonl');
  assert.deepEqual(hits, []);
});
