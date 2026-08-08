// northbridge.js — 北桥标准接口：context.request → context.bundle（RFC-0000 §7）
//
// 2Origin 铁律：本境负责存，北桥负责"当前任务该调什么"。不把整个硬盘塞进 RAM。
//
// 标准接口（协议层，任何 harness 都能用统一格式调）：
//   输入 context.request：{ kind, goal, scope[], budget{ tokens }, freshness }
//   输出 context.bundle：{ kind, state[], memory[], skills[], evidence[], token_estimate }
//
// 参考实现支持两种调用：
//   - 直接函数：buildContext(root, request)
//   - CLI 参数：northbridge --goal "..." [--budget 30000]
import fs from 'node:fs';
import path from 'node:path';
import { findStates, buildBundle } from './bundle.js';
import { recheckSource } from './state.js';

// 按 request.goal 对 state 里的 facts 打分，取最相关（RFC §7 "北桥负责知"）
function relevantFacts(states, goal, maxFacts) {
  const words = (goal || '').toLowerCase().split(/\W+/).filter(w => w.length > 2);
  const all = [];
  for (const { file, state } of states) {
    for (const f of (state.facts || [])) {
      if (!f.verified) continue;
      const hit = words.filter(w => (f.claim || '').toLowerCase().includes(w)).length;
      all.push({ f, hit, source: file });
    }
  }
  return all
    .sort((a, b) => b.hit - a.hit)
    .slice(0, maxFacts)
    .map(x => x.f);
}

// 北桥入口：context.request → context.bundle（标准接口）
export function buildContext(root, request = {}) {
  // —— 解析标准 context.request ——
  const goal = request.goal || '继续任务';
  const maxFacts = request.maxFacts || request.budget?.facts || 10;
  const tokenBudget = request.budget?.tokens || 30000;
  const scope = request.scope || [];

  const states = findStates(root);

  // state[]：按 scope 过滤 + 只进"此刻相关"的部分
  const scoped = scope.length
    ? states.filter(({ state }) => scope.some(s => (state.scope || '').startsWith(s)))
    : states;

  const facts = relevantFacts(scoped, goal, maxFacts);

  // skills 指针：按 goal 扫 2origin 约定目录（skills/）
  const skills = [];
  const skillsDir = path.join(root, 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const d of fs.readdirSync(skillsDir)) {
      const name = d.toLowerCase();
      if (goal && name && goal.toLowerCase().includes(name.slice(0, 4))) {
        skills.push(`skills/${d}`);
      }
    }
  }

  // evidence：相关 facts 的 source（可复核物）
  const evidence = facts
    .map(f => { const rc = recheckSource(f.source); return rc.ok ? f.source : null; })
    .filter(Boolean);

  // token 估算（粗估）
  const tokenEstimate = Math.round(
    (goal.length + JSON.stringify(facts).length + skills.join('').length) / 4
  );

  // —— 标准 context.bundle ——
  const bundle = {
    kind: 'context.bundle',
    goal,
    scope,
    state: scoped.map(({ file, state }) => ({
      id: state.id, file, current_state: state.current_state || '', next_steps: state.next_steps || []
    })),
    memory: facts,          // 相关已核实事实
    skills,
    evidence,
    token_estimate: tokenEstimate,
    budget: tokenBudget,
    note: '本境只进了"此刻相关"的部分，不是整个硬盘'
  };

  // 超出预算 → 降级（诚实标注，不是静默截断）
  if (tokenEstimate > tokenBudget) {
    bundle.over_budget = true;
    bundle.note = `估算 ${tokenEstimate} tokens 超预算 ${tokenBudget}，已截断 facts 到 ${maxFacts} 条`;
  }

  return bundle;
}
