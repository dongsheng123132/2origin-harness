// state.js — 本境/状态层 v0.2（符合 RFC-0005）
// 2Origin 铁律：
//   - 不存聊天记录，存 State + Facts
//   - facts 必须带 verified，且 source 必须可复核（文件/命令/测试用例，非自然语言断言）
//   - learning 先 candidate 后 verified
// v0.2 增量（RFC-0005）：content_hash 乐观锁 / recheckSource / actor provenance
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SPEC = '2origin/0.2';

// ───────── content_hash：内容指纹（RFC-0005 §3.1）─────────
// canonical：深度排序键，排除 version/updated_at/content_hash/actor。
// 内容没变 → hash 不变 → version 不该涨。这就是乐观锁凭据。
export function contentHash(state) {
  const { version, updated_at, content_hash, actor, ...rest } = state;
  const canon = canonicalize(rest);
  return crypto.createHash('sha256').update(canon).digest('hex');
}

function canonicalize(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalize).join(',') + ']';
  return '{' + Object.keys(obj).sort()
    .filter(k => !['version', 'updated_at', 'content_hash', 'actor'].includes(k))
    .map(k => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

// ───────── actor：写入者 provenance（RFC-0005 §3.3）─────────
// harness 由环境变量观测；model 观测不到就写 unobserved，不许编。
export function detectActor(sessionId) {
  let harness = 'unknown';
  if (process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_PROJECT_DIR) harness = 'claude-code';
  else if (process.env.CODEX_HOME || process.env.CLAUDE_CODE_ENTRYPOINT) { /* codex 无可靠 env，保守 */ }
  const model = process.env.ANTHROPIC_MODEL || process.env.ANTHROPIC_SMALL_FAST_MODEL || 'unobserved';
  return { harness, model, session_id: sessionId || process.env.CLAUDE_CODE_SESSION_ID || null, at: new Date().toISOString() };
}

// ───────── recheckSource：source 可复核判定（RFC-0005 §3.2）─────────
// 判据是「引没引可复核物」，不是「可复核物现在还在不在」。
export function recheckSource(source) {
  const s = String(source || '');
  if (!s.trim()) return { ok: false, kind: 'missing', hint: 'source 为空' };
  const hits = [];
  const pathRe = /[\w./\\-]+\.(mjs|js|json|md|log|jsonl|txt|toml|yaml|yml|sh|ps1)\b/g;
  const cmdRe = /\b(node|npm|npx|git|ls|cat|wc|tail|head|grep|rm|touch|find|curl|codex|claude|python|cargo)\b/;
  const caseRe = /\bT\d+(\.\d+)?\b/;
  const p = s.match(pathRe);
  if (p) hits.push({ kind: 'path', refs: [...new Set(p)] });
  if (cmdRe.test(s)) hits.push({ kind: 'command', refs: [s.match(cmdRe)[0]] });
  if (caseRe.test(s)) hits.push({ kind: 'testcase', refs: [s.match(caseRe)[0]] });
  if (!hits.length) return { ok: false, kind: 'unverifiable', hint: '未引用可复核物（文件/命令/测试用例编号），只是一句自然语言断言' };
  return { ok: true, kind: hits.map(h => h.kind).join('+'), refs: hits.flatMap(h => h.refs) };
}

// ───────── 读 ─────────
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

export function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

// ───────── 写 ─────────
export function createState({ id, title, goal, scope = 'default', sessionId } = {}) {
  if (!id || !goal) throw new Error('createState 需要 id 和 goal');
  const now = new Date().toISOString();
  const st = {
    spec: SPEC, kind: 'task.origin', id, title: title || '', goal,
    version: 1, scope,
    created_at: now, updated_at: now,
    current_state: '刚创建。', facts: [], decisions: [], actions: [],
    artifacts: [], verification: '', next_steps: [], learnings: [],
    actor: detectActor(sessionId)
  };
  st.content_hash = contentHash(st);
  return st;
}

// 保存：带乐观锁。expect 存在时必须匹配当前 content_hash，否则拒绝写（RFC-0005 §3.1）。
// 内容没变则一字节不写、version 不涨。
export function saveState(file, state, { expect = null, sessionId } = {}) {
  const current = readState(file);
  if (expect && current && current.content_hash !== expect) {
    return { ok: false, status: 'conflict', reason: `expect_sha256 不匹配：当前 ${current.content_hash?.slice(0,12)}… ≠ ${expect.slice(0,12)}…` };
  }
  const newHash = contentHash(state);
  if (current && current.content_hash === newHash) {
    return { ok: true, status: 'unchanged', version: current.version, reason: '内容未变，一字节不写' };
  }
  state.version = (state.version || 0) + 1;
  state.updated_at = new Date().toISOString();
  state.content_hash = newHash;
  if (sessionId || !state.actor) state.actor = detectActor(sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
  return { ok: true, status: 'written', version: state.version };
}

// ───────── 事实与学习 ─────────
// 加 fact：verified 的 source 必须可复核，否则拒收（RFC-0005 §3.2）
export function addFact(state, claim, source, verified = true) {
  if (verified) {
    const rc = recheckSource(source);
    if (!rc.ok) throw new Error(`fact source 不可复核: ${rc.hint}`);
  }
  state.facts = state.facts || [];
  state.facts.push({ claim, verified, source, when: new Date().toISOString() });
}

export function addLearning(state, lesson, confidence = 0.5) {
  state.learnings = state.learnings || [];
  state.learnings.push({ lesson, confidence, status: 'candidate' });
}

// 晋升门槛（RFC-0000 §10 问题 4）：candidate → verified 不是无条件的。
// 门槛：
//   1. confidence >= minConfidence（默认 0.7）——置信度不够不晋升
//   2. 有可复核证据（lesson 可选带 [evidence: <source>]，source 须可复核）
//   3. 明确确认才晋升（调用方显式 promote）
// 返回值：{ ok, status, reason }。失败不抛错，返回说明。
export function promoteLearning(state, lesson, { confidence = null, evidence = null, minConfidence = 0.7 } = {}) {
  const l = (state.learnings || []).find(x => x.lesson === lesson);
  if (!l) return { ok: false, status: 'not_found', reason: '无此 learning' };

  const effConf = confidence != null ? confidence : l.confidence;
  if (effConf < minConfidence) {
    return { ok: false, status: 'low_confidence', reason: `置信度 ${effConf} < 门槛 ${minConfidence}` };
  }

  if (evidence != null) {
    const rc = recheckSource(evidence);
    if (!rc.ok) return { ok: false, status: 'no_evidence', reason: `evidence 不可复核: ${rc.hint}` };
    l.evidence = evidence;
  }

  l.status = 'verified';
  if (confidence != null) l.confidence = confidence;
  // D2 修复（bugscope A1 审视规范债务）：记录晋升事件——何时从 candidate 变 verified、凭什么。
  // 否则无从区分"验证过的"和"一上来就写 verified 的"（存在性冒充生命周期）。
  l.promoted_at = new Date().toISOString();
  l.promoted_by = detectActor().harness;
  l.promotion_evidence = evidence || l.evidence || null;
  return { ok: true, status: 'verified', reason: '通过晋升门槛' };
}

// 过时：标记 deprecated（不硬删——保留历史，但不再作为学历使用）
export function deprecateLearning(state, lesson) {
  const l = (state.learnings || []).find(x => x.lesson === lesson);
  if (l) { l.status = 'deprecated'; return { ok: true }; }
  return { ok: false };
}

// 自动遗忘（bugscope A5「验证会衰减」驱动）：
// 世界会变，verified 标记不会自己变回去。这里给一个"保鲜期"机制——
// 超过 maxAge 且没有 refresh 的 verified 项，自动降级为 deprecated。
// 不硬删（保留历史与证据），但不再作为有效学历被 bundle 装载。
// 返回被降级的项列表。
//
// 使用方式：
//   autoDeprecate(state, { maxAgeMs: 30*24*3600*1000 })   // 30 天保鲜
//   refreshFact(state, claim)                              // 验证/复用了就刷新保鲜期
export function autoDeprecate(state, { maxAgeMs = 30 * 24 * 3600 * 1000, now = Date.now() } = {}) {
  const deprecated = [];

  // 处理 learnings：verified 且有 promoted_at 的，超过保鲜期且无 refresh 降级
  for (const l of (state.learnings || [])) {
    if (l.status !== 'verified') continue;
    const ageRef = l.refreshed_at || l.promoted_at;
    if (!ageRef) continue; // 无时间戳的无法判定，跳过（保守）
    const age = now - new Date(ageRef).getTime();
    if (age > maxAgeMs) {
      l.status = 'deprecated';
      l.deprecated_at = new Date(now).toISOString();
      l.deprecated_reason = `超过保鲜期 ${Math.round(age / (24*3600*1000))} 天未刷新`;
      deprecated.push({ kind: 'learning', lesson: l.lesson, reason: l.deprecated_reason });
    }
  }

  // 处理 facts：verified 且有 when 的，超过保鲜期降级（deprecated 标记在事实上加字段，保留 verified 历史）
  for (const f of (state.facts || [])) {
    if (!f.verified || f.deprecated) continue;
    const ageRef = f.refreshed_at || f.when;
    if (!ageRef) continue;
    const age = now - new Date(ageRef).getTime();
    if (age > maxAgeMs) {
      f.deprecated = true;
      f.deprecated_at = new Date(now).toISOString();
      f.deprecated_reason = `超过保鲜期 ${Math.round(age / (24*3600*1000))} 天未刷新`;
      deprecated.push({ kind: 'fact', claim: f.claim, reason: f.deprecated_reason });
    }
  }

  return deprecated;
}

// 刷新保鲜期：验证/复用了就更新 refreshed_at（A5 的"世界没变，我确认过"）
export function refreshFact(state, claim) {
  const f = (state.facts || []).find(x => x.claim === claim);
  if (f) { f.refreshed_at = new Date().toISOString(); f.deprecated = false; return { ok: true }; }
  return { ok: false };
}
