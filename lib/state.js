// state.js — 本境/状态层：task.origin 的读写、版本递增、learnings 候选
// 2Origin 铁律：
//   - 不存聊天记录，存 State + Facts
//   - facts 必须带 verified
//   - learning 先 candidate 后 verified（一次成功不是永久真理）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SPEC = '2origin/0.1';

// ───────── 读 ─────────
// 在 dir 下找最新的 task.origin.json（递归，depth<=5）
export function findNewestState(dir) {
  const SKIP = new Set(['.git', 'node_modules', '.claude']);
  let newest = null, newestMtime = 0;

  function walk(d, depth) {
    if (depth > 5) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        walk(full, depth + 1);
      } else if (e.name === 'task.origin.json') {
        const m = fs.statSync(full).mtimeMs;
        if (m > newestMtime) { newestMtime = m; newest = full; }
      }
    }
  }
  walk(dir, 0);
  return newest;
}

// 读一个状态文件，解析失败返回 null（不 throw）
export function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

// ───────── 写 ─────────
// 新建状态：id 必须唯一、跨会话不变；goal 一句话（换模型也能看懂）
export function createState({ id, title, goal, scope = 'default' }) {
  if (!id || !goal) throw new Error('createState 需要 id 和 goal');
  const now = new Date().toISOString();
  return {
    spec: SPEC, kind: 'task.origin', id, title: title || '', goal,
    version: 1, scope,
    created_at: now, updated_at: now,
    current_state: '刚创建。', facts: [], decisions: [], actions: [],
    artifacts: [], verification: '', next_steps: [], learnings: []
  };
}

// 保存：version +1，刷 updated_at。原样覆盖。
export function saveState(file, state) {
  state.version = (state.version || 0) + 1;
  state.updated_at = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
  return state;
}

// ───────── 事实与学习 ─────────
// 加一条 fact：必须 verified，否则是假设不是事实
export function addFact(state, claim, source, verified = true) {
  state.facts = state.facts || [];
  state.facts.push({ claim, verified, source, when: new Date().toISOString() });
}

// 加一条 learning：一律先 candidate
export function addLearning(state, lesson, confidence = 0.5) {
  state.learnings = state.learnings || [];
  state.learnings.push({ lesson, confidence, status: 'candidate' });
}

// 晋升 verified：只有明确确认后才调
export function promoteLearning(state, lesson, confidence = null) {
  const l = (state.learnings || []).find(x => x.lesson === lesson);
  if (l) { l.status = 'verified'; if (confidence != null) l.confidence = confidence; }
}
