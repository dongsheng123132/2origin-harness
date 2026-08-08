// northbridge.js — 北桥：把"此刻该知道的世界"编译进 Context
// 2Origin 铁律：本境负责存，北桥负责"当前任务该调什么"。不把整个硬盘塞进 RAM。
// 输入 goal（一句话任务），输出 context.bundle（当前状态 + 相关 facts + 相关 skills 指针）。
import fs from 'node:fs';
import path from 'node:path';
import { findNewestState, readState } from './state.js';

// 简单相关性：goal 里出现的事实关键字优先；按 verified 排序
function relevantFacts(state, goal) {
  const words = (goal || '').toLowerCase().split(/\W+/).filter(w => w.length > 2);
  const facts = (state.facts || []).filter(f => f.verified);
  const scored = facts.map(f => {
    const hit = words.filter(w => (f.claim || '').toLowerCase().includes(w)).length;
    return { f, hit };
  });
  return scored
    .sort((a, b) => b.hit - a.hit)
    .slice(0, 10)
    .map(x => x.f);
}

// 北桥入口：给一个 goal，产出 context.bundle
export function buildContext(root, goal, { maxFacts = 10, tokenBudget = 30000 } = {}) {
  const stateFile = findNewestState(root);
  if (!stateFile) {
    return { goal, state: null, facts: [], skills: [], next_steps: [], token_estimate: 0, note: 'no state yet' };
  }
  const state = readState(stateFile);
  if (!state) {
    return { goal, state: null, facts: [], skills: [], next_steps: [], token_estimate: 0, note: 'state unreadable' };
  }

  const facts = relevantFacts(state, goal).slice(0, maxFacts);

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

  // 粗略 token 估算：JSON 字符串长 / 4（中文）粗估
  const bundle = {
    goal,
    state: stateFile,
    current_state: state.current_state || '',
    facts,
    skills,
    next_steps: state.next_steps || [],
    token_estimate: Math.round(JSON.stringify({ current_state: state.current_state, facts }).length / 4),
    note: '本境只进了"此刻相关"的部分，不是整个硬盘'
  };
  return bundle;
}
