// verify.js — 验证层：通过观察现实验证，不信任"我说我完成了"
// 2Origin 铁律：Verify 不是看工具返回值，是重新观察现实状态。
// 检查：
//   1. artifacts[] 真实存在（相对状态文件目录 / 仓库根 都试）
//   2. verified facts 都有 source，且 source 可复核（RFC-0005 §3.2）
//   3. current_state 与 next_steps 自洽
import fs from 'node:fs';
import path from 'node:path';
import { readState, recheckSource } from './state.js';

export function verify(stateFile, root) {
  const state = readState(stateFile);
  if (!state) return { verdict: '❌ NOT VERIFIED', passed: [], failed: ['状态不可读'], missing: [] };

  const passed = [], failed = [], missing = [];
  const stateDir = path.dirname(path.resolve(stateFile));
  const base = root || stateDir;

  // CHECK 1: artifacts 真实存在
  for (const a of (state.artifacts || [])) {
    if (path.isAbsolute(a)) {
      if (fs.existsSync(a)) passed.push(`artifact存在: ${a}`);
      else failed.push(`artifact缺失: ${a}`);
      continue;
    }
    const fromRoot = path.resolve(base, a);
    const fromState = path.resolve(stateDir, a);
    if (fs.existsSync(fromRoot)) passed.push(`artifact存在: ${a}`);
    else if (fs.existsSync(fromState)) passed.push(`artifact存在: ${a} (相对状态目录)`);
    else failed.push(`artifact缺失: ${a}`);
  }

  // CHECK 2: verified facts 必须有 source，且 source 可复核（RFC-0005 §3.2）
  for (const f of (state.facts || [])) {
    if (!f.verified) continue;
    if (!f.source) { failed.push(`verified fact 缺 source: ${(f.claim || '').slice(0, 40)}`); continue; }
    const rc = recheckSource(f.source);
    if (rc.ok) passed.push(`fact source可复核: ${(f.claim || '').slice(0, 30)}`);
    else failed.push(`verified fact source 不可复核(${rc.kind}): ${(f.claim || '').slice(0, 40)}`);
  }

  // CHECK 3 (C6/D2): verified learning 必须走过 candidate（有 promoted_at）。
  // 否则是"一上来就写 verified"——存在性冒充生命周期（bugscope A1 审视规范债务 D2）。
  for (const l of (state.learnings || [])) {
    if (l.status === 'verified' && !l.promoted_at) {
      failed.push(`verified learning 无晋升事件(未走过 candidate): ${(l.lesson || '').slice(0, 40)}`);
    } else if (l.status === 'verified' && l.promoted_at) {
      passed.push(`learning 有晋升事件: ${(l.lesson || '').slice(0, 30)}`);
    }
  }

  // CHECK 4: current_state 提到"完成"但 next_steps 仍多 → 提示
  const cs = state.current_state || '';
  if ((cs.includes('完成') || cs.includes('验收')) && (state.next_steps || []).length > 0) {
    missing.push(`提示: current_state 似已完成，但 next_steps 仍有 ${state.next_steps.length} 项`);
  }

  const verdict = failed.length === 0 ? '✅ VERIFIED (通过现实观察确认)' : '❌ NOT VERIFIED';
  return { verdict, passed, failed, missing };
}
