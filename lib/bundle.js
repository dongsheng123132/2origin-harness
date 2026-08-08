// bundle.js — 本境 bundle 编译（RFC-0005 §3.4）
// SessionStart 加载：当前任务全量 + 其余任务已验证事实结转，受预算约束。
// 铁律：丢了什么必须写在开头——宁可说"丢了 2 条"，不能让人以为全装上了。
import fs from 'node:fs';
import path from 'node:path';
import { readState, recheckSource } from './state.js';

// 找出 root 下所有 task.origin.json（含嵌套）
export function findStates(dir, { depth = 6 } = {}) {
  const SKIP = new Set(['.git', 'node_modules', '.claude', '.backups']);
  const out = [];
  function walk(d, lvl) {
    if (lvl > depth) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        walk(full, lvl + 1);
      } else if (e.name === 'task.origin.json') {
        const s = readState(full);
        if (s && s.kind === 'task.origin') out.push({ file: full, state: s });
      }
    }
  }
  walk(dir, 0);
  return out;
}

// 编译 bundle：当前任务（mtime 最新）全量 + 其余结转，逐条计预算，丢弃透明。
// budget 是字符预算（RFC-0005 当前 9000）。
export function buildBundle(root, { budget = 9000 } = {}) {
  const states = findStates(root);
  if (!states.length) return { ok: false, loaded: 0, total: 0, text: '', dropped: ['无学历'] };

  // 按 mtime 排序，最新的当"当前任务"
  const withMtime = states.map(x => {
    try { return { ...x, mtime: fs.statSync(x.file).mtimeMs }; } catch { return { ...x, mtime: 0 }; }
  });
  withMtime.sort((a, b) => b.mtime - a.mtime);

  const totalFacts = withMtime.reduce((n, x) => n + (x.state.facts || []).filter(f => f.verified).length, 0);
  const [active, ...carry] = withMtime;
  const dropped = [];

  function factLine(f) {
    const rc = recheckSource(f.source);
    const mark = rc.ok ? '' : ' ⚠source不可复核';
    return `- ${f.claim}${f.source ? `（${f.source}）` : ''}${mark}`;
  }

  // 当前任务：全量
  const activeBlock = [
    `── 当前任务 · ${path.relative(root, active.file)} ──`,
    `任务：${active.state.title || '(未命名)'}`,
    `目标：${active.state.goal || ''}`,
    `当前状态：${active.state.current_state || ''}`,
    `已验证事实：`,
    (active.state.facts || []).filter(f => f.verified).map(factLine).join('\n') || '（暂无）',
    `下一步：`,
    (active.state.next_steps || []).map((x, i) => `${i + 1}. ${x}`).join('\n') || '（暂无）'
  ].filter(Boolean).join('\n');

  let factsLoaded = (active.state.facts || []).filter(f => f.verified).length;
  let used = activeBlock.length;
  const carryBlocks = [];

  // 其余任务：只结转已验证事实 + 前 2 条下一步，逐条计预算
  for (const t of carry) {
    const vf = (t.state.facts || []).filter(f => f.verified);
    const steps = (t.state.next_steps || []).slice(0, 2);
    if (!vf.length && !steps.length) continue;
    const head = `\n[${t.state.title || t.state.id || path.relative(root, t.file)}]`;
    const lines = [];
    let dropHere = 0;
    for (const f of vf) {
      const line = factLine(f);
      if (used + head.length + line.length + 200 < budget) { lines.push(line); used += line.length; factsLoaded++; }
      else dropHere++;
    }
    const stepLines = steps.map(x => `  ↳待办: ${x}`).join('\n');
    if (lines.length && used + stepLines.length + 200 < budget) { used += stepLines.length; }
    if (dropHere) dropped.push(`${path.relative(root, t.file)} 的 ${dropHere} 条已验证事实（预算耗尽）`);
    if (lines.length) carryBlocks.push([head, ...lines, stepLines].filter(Boolean).join('\n'));
    else if (vf.length) dropped.push(`${path.relative(root, t.file)} 整份未装载（预算耗尽）`);
  }

  const header = [
    `[本境 bundle · benjing/0.2]`,
    `装载 ${loadedCount(states, withMtime)}/${states.length} 份学历 · 已验证事实 ${factsLoaded}/${totalFacts} 条`,
    dropped.length ? `⚠ 未装载：${dropped.join('；')}` : `✔ 无丢弃`
  ].join('\n');

  const text = [header, '', activeBlock, ...carryBlocks].join('\n');
  return { ok: true, loaded: states.length, total: states.length, text, dropped, factsLoaded, totalFacts };
}

function loadedCount(states, withMtime) { return withMtime.length; }
