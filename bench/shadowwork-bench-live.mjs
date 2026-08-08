#!/usr/bin/env node
// shadowwork-bench-live.mjs — ShadowWork Bench（会打真模型的那一个），spec 0.3
//
// 为什么存在：v0.1（shadowwork-bench.mjs / compare-bench.mjs）测的是
// 「buildBundle 能不能把刚写进去的东西读回来」，对照组（传统 harness）的
// transcript 是本脚本自己生成的、且从没把 goal 原文写进去 —— 所以
// 「传统不可续作」是构造出来的，不是观察到的。那是"声明冒充事实"在
// benchmark 层的复发。
//
// 三条硬约束：
//   1. 真实语料：学历取磁盘上真实的 task.origin.json；对照组取真实的
//      harness 会话记录（Claude Code session jsonl），不是生成的。
//   2. 真实模型：各臂用同一个模型端点、同一 prompt、temperature 0，
//      唯一差异是「会话开场喂什么」。
//   3. 客观判分：判据来自磁盘上的真值（goal / next_steps[0] / current_state /
//      facts[].claim），选项和干扰项来自**别的真实任务**的同类字段 ——
//      不是我编的稻草人。是/否 与 ABCD 可机械判分，不需要 judge。
//
// 0.3 相对 0.2 的两处修正（都是「别打稻草人」）：
//   - 加 summary 臂与 rag 臂。0.2 的传统臂只有"尾部截断"一种做法，而真实
//     harness 会 /compact（摘要）或检索。只跟最弱的传统做法比，就是在挑软柿子
//     —— 那正是 v0.1 翻的车，换个地方复发。
//   - 加两跳题（事实↔下一步是否同属一个任务）与计数题。0.2 的题在 bundle 里
//     是字面可抄的，2origin 臂 100% 有开卷天花板，测不出上限。
//
// 用法：
//   node bench/shadowwork-bench-live.mjs --dry-run        # 只看 payload 和探针，不调模型
//   node bench/shadowwork-bench-live.mjs                  # 真跑（会调模型，花钱）
//   node bench/shadowwork-bench-live.mjs --facts 8 --arms 2origin,summary,rag
//
// 退出码：0 = 跑完（结果好坏由报告说话，benchmark 不该 fail-closed）
//         1 = 用法/环境错误

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { buildBundle } = await import('../lib/bundle.js');

// ─────────────────────────── 参数 ───────────────────────────
function flag(k, d) { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; }
function has(k) { return process.argv.includes(k); }

const REPO        = flag('--repo', 'D:/uking编程/ShadowOS = Harness OS');
const TASK        = flag('--task', 'task6');
const PROJECT_DIR = flag('--project-dir', path.join(os.homedir(), '.claude/projects/D--uking---ShadowOS---Harness-OS'));
const TRANSCRIPTS = flag('--transcripts', '');       // 逗号分隔的 jsonl 路径；空则自动发现
const N_FACTS     = parseInt(flag('--facts', '40'), 10);   // 是/否 事实探针总数（真假各半）
const N_MCFACT    = parseInt(flag('--mc-facts', '10'), 10); // 四选一「哪条是本任务的已验证事实」
const N_PAIR      = parseInt(flag('--pairs', '12'), 10);    // 两跳题：事实↔下一步是否同属一个任务
const ARMS        = flag('--arms', '2origin,summary,rag,transcript,transcript-10x,none').split(',').map(s => s.trim()).filter(Boolean);
const MODEL       = flag('--model', '');
const BASE        = flag('--base', '');
const KEY         = flag('--key', process.env.DEEPSEEK_API_KEY || '');
const CONC        = parseInt(flag('--concurrency', '6'), 10);
// 推理模型把 token 花在 reasoning 上；cap 太低会让 content 为空、被误记成"答错"。
// 首轮 2000 就是这么翻的车（finish_reason=length），所以默认给足，并在报告里盯 finish_reason。
const MAXTOK      = parseInt(flag('--max-tokens', '8000'), 10);
const OUT         = flag('--out', path.join(here, 'results-live.json'));
const CACHE       = path.join(here, 'cache');
const DRY         = has('--dry-run');

// ─────────────────── 确定性随机（不用 Math.random）───────────────────
function lcg(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
const rnd = lcg(20260808);
function shuffle(arr) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// ─────────────────────── 读真实学历 ───────────────────────
function loadStates(repo) {
  const demo = path.join(repo, 'demo');
  if (!fs.existsSync(demo)) die(`找不到 ${demo}`);
  const out = [];
  for (const d of fs.readdirSync(demo)) {
    const p = path.join(demo, d, 'task.origin.json');
    if (!fs.existsSync(p)) continue;
    try {
      const s = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (s && s.kind === 'task.origin') out.push({ id: d, file: p, state: s });
    } catch { /* 坏文件跳过，报告里会体现 */ }
  }
  return out;
}
function die(msg) { console.error('✗ ' + msg); process.exit(1); }

// ───────────── payload：2origin 臂 = 真实本境 bundle ─────────────
// 复用 lib/bundle.js（真实的本境编译器），不另写一份 —— 另写一份就是"自证"。
function buildOriginPayload(states, targetId) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swb2-'));
  let targetCopy = null;
  for (const s of states) {
    const dst = path.join(root, 'demo', s.id, 'task.origin.json');
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(s.file, dst);
    if (s.id === targetId) targetCopy = dst;
  }
  // buildBundle 按 mtime 选「当前任务」——把目标那份设成最新，保证可复现
  const now = Date.now();
  for (const s of states) {
    const dst = path.join(root, 'demo', s.id, 'task.origin.json');
    fs.utimesSync(dst, now / 1000 - 3600, now / 1000 - 3600);
  }
  fs.utimesSync(targetCopy, now / 1000, now / 1000);
  const b = buildBundle(root, { budget: 9000 });
  fs.rmSync(root, { recursive: true, force: true });
  return b.text;
}

// ───────── payload：transcript 臂 = 真实会话记录（尾部截断）─────────
function discoverTranscripts(projectDir, taskId) {
  if (!fs.existsSync(projectDir)) return [];
  const hits = [];
  for (const f of fs.readdirSync(projectDir)) {
    if (!f.endsWith('.jsonl')) continue;
    const p = path.join(projectDir, f);
    let txt;
    try { txt = fs.readFileSync(p, 'utf8'); } catch { continue; }
    const n = (txt.match(new RegExp(taskId, 'g')) || []).length;
    if (n > 0) hits.push({ file: p, hits: n, size: txt.length, mtime: fs.statSync(p).mtimeMs });
  }
  hits.sort((a, b) => b.hits - a.hits || b.size - a.size);
  return hits.slice(0, 2).sort((a, b) => a.mtime - b.mtime).map(h => h.file);
}

function renderTranscript(files) {
  const lines = [];
  for (const f of files) {
    let raw;
    try { raw = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const l of raw.split('\n')) {
      if (!l.trim()) continue;
      let j; try { j = JSON.parse(l); } catch { continue; }
      if (!j.message || (j.type !== 'user' && j.type !== 'assistant')) continue;
      const role = j.type;
      const c = j.message.content;
      if (typeof c === 'string') { if (c.trim()) lines.push(`${role}: ${c}`); continue; }
      if (!Array.isArray(c)) continue;
      for (const x of c) {
        if (x.type === 'text' && x.text && x.text.trim()) lines.push(`${role}: ${x.text}`);
        else if (x.type === 'tool_use') lines.push(`${role}[tool:${x.name}]: ${JSON.stringify(x.input).slice(0, 300)}`);
        else if (x.type === 'tool_result') lines.push(`tool_result: ${JSON.stringify(x.content).slice(0, 300)}`);
      }
    }
  }
  return lines.join('\n');
}

// 传统 harness 续作 = 重放对话，预算不够就丢最早的（compaction 保尾部）
function tailChars(text, n) { return text.length <= n ? text : text.slice(text.length - n); }

// ─────── summary 臂：模型生成的摘要（模拟 /compact 这类真实做法）───────
// 分段摘要 → 合并成一份不超过预算的交接摘要。结果缓存到磁盘：
// 重跑不重新花钱，且各次实验用的是同一份摘要（可比）。
async function buildSummaryPayload(ep, transcript, budget, tag) {
  fs.mkdirSync(CACHE, { recursive: true });
  const cacheFile = path.join(CACHE, `summary-${tag}-${budget}.txt`);
  if (fs.existsSync(cacheFile)) return { text: fs.readFileSync(cacheFile, 'utf8'), cached: true, calls: 0 };
  if (!ep.base) throw new Error('summary 臂需要模型端点');

  const CHUNK = 24000;
  const chunks = [];
  for (let i = 0; i < transcript.length; i += CHUNK) chunks.push(transcript.slice(i, i + CHUNK));
  const per = Math.max(400, Math.floor(budget / Math.max(chunks.length, 1)) * 2);

  const parts = await pool(chunks, 4, async (c, i) => {
    const r = await ask(ep,
      '你在给一个新会话做工作记录压缩（相当于 /compact）。只输出要点，不要寒暄。',
      `下面是一段真实的 AI 工作会话记录（第 ${i + 1}/${chunks.length} 段）。把它压缩成要点，` +
      `**优先保留**：任务目标、当前进度、已确认的结论、待办事项、关键决策。丢掉闲聊与重复。` +
      `不超过 ${per} 字。\n\n${c}`, 4000);
    return r.text;
  });
  let calls = chunks.length;

  const merged = parts.filter(Boolean).join('\n---\n');
  const r = await ask(ep,
    '你在为一个新会话写交接摘要。只输出摘要正文，不要寒暄。',
    `下面是同一个任务各段工作记录的要点。合并成**一份**给新会话看的交接摘要，` +
    `明确写出：任务目标、当前状态、已确认的事实、下一步。**严格不超过 ${budget} 字符**。\n\n${merged}`,
    Math.max(4000, Math.floor(budget / 2)));
  calls++;
  const text = tailChars(r.text, budget);
  fs.writeFileSync(cacheFile, text, 'utf8');
  return { text, cached: false, calls };
}

// ─────────── rag 臂：按题检索（词法 BM25-lite，不需要 embedding）───────────
// 每道题各自检索，payload 逐题不同 —— 这是 RAG 的真实优势，给足它。
function chunkText(text, size = 900, overlap = 200) {
  const out = [];
  for (let i = 0; i < text.length; i += (size - overlap)) out.push(text.slice(i, i + size));
  return out;
}
// CJK 取字符二元组，拉丁取小写词 —— 中英混排语料上够用且不引依赖
function terms(s) {
  const out = [];
  for (const w of String(s).toLowerCase().match(/[a-z0-9_.\-/]+/g) || []) out.push(w);
  const cjk = String(s).match(/[一-龥]+/g) || [];
  for (const run of cjk) for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  return out;
}
function buildIndex(chunks) {
  const df = new Map(); const docs = chunks.map(c => {
    const tf = new Map();
    for (const t of terms(c)) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    return { tf, len: Math.max(1, [...tf.values()].reduce((a, b) => a + b, 0)) };
  });
  const avg = docs.reduce((n, d) => n + d.len, 0) / Math.max(docs.length, 1);
  return { chunks, docs, df, avg, N: chunks.length };
}
function retrieve(idx, query, budget) {
  const k1 = 1.2, b = 0.75;
  const q = [...new Set(terms(query))];
  const scored = idx.docs.map((d, i) => {
    let s = 0;
    for (const t of q) {
      const f = d.tf.get(t); if (!f) continue;
      const n = idx.df.get(t) || 0;
      const idf = Math.log(1 + (idx.N - n + 0.5) / (n + 0.5));
      s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / idx.avg));
    }
    return { i, s };
  }).filter(x => x.s > 0).sort((a, b2) => b2.s - a.s);

  const picked = []; let used = 0;
  for (const { i } of scored) {
    const c = idx.chunks[i];
    if (used + c.length + 8 > budget) continue;
    picked.push(i); used += c.length + 8;
    if (used >= budget * 0.98) break;
  }
  picked.sort((a, b3) => a - b3);   // 还原时间顺序，别让检索把因果打乱
  return picked.map(i => idx.chunks[i]).join('\n…\n');
}

// ─────────────────────── 探针（判据来自磁盘）───────────────────────
function buildProbes(states, targetId, nFacts) {
  const target = states.find(s => s.id === targetId);
  if (!target) die(`找不到任务 ${targetId}`);
  const others = states.filter(s => s.id !== targetId);
  const probes = [];

  // ① 三道四选一：目标 / 下一步第一条 / 当前状态。干扰项 = 别的真实任务的同一字段
  const mc = [
    { key: 'goal',          q: '这个任务的目标（goal）是哪一条？', truth: target.state.goal,          pool: others.map(s => s.state.goal) },
    { key: 'next_step',     q: '这个任务「下一步」列表的第一条是哪一条？', truth: (target.state.next_steps || [])[0], pool: others.map(s => (s.state.next_steps || [])[0]) },
    { key: 'current_state', q: '这个任务的当前状态（current_state）是哪一条？', truth: target.state.current_state, pool: others.map(s => s.state.current_state) }
  ];
  for (const m of mc) {
    if (!m.truth) continue;
    const distract = shuffle(m.pool.filter(Boolean).filter(x => x !== m.truth)).slice(0, 3);
    if (distract.length < 3) continue;
    const opts = shuffle([m.truth, ...distract]);
    const answer = 'ABCD'[opts.indexOf(m.truth)];
    probes.push({
      type: 'mc', key: m.key, answer,
      prompt: `${m.q}\n只回答一个字母（A/B/C/D），不要解释。\n\n` +
        opts.map((o, i) => `${'ABCD'[i]}. ${String(o).slice(0, 300)}`).join('\n')
    });
  }

  const trueFacts = (target.state.facts || []).filter(f => f.verified).map(f => f.claim);
  const falseFacts = others.flatMap(s => (s.state.facts || []).filter(f => f.verified).map(f => f.claim));

  // ②a 四选一事实题：1 条真 + 3 条别的真实任务的真事实。随机基线 = 25%，
  //     这一档是为了把「none 臂」压回真正的瞎猜线 —— 三道题的 MC 噪音太大，不能下结论。
  const mcTrue = evenly(trueFacts, N_MCFACT);
  for (let i = 0; i < mcTrue.length; i++) {
    const distract = shuffle(falseFacts.filter(c => c !== mcTrue[i])).slice(0, 3);
    if (distract.length < 3) break;
    const opts = shuffle([mcTrue[i], ...distract]);
    probes.push({
      type: 'mc', key: 'mc_fact', answer: 'ABCD'[opts.indexOf(mcTrue[i])],
      prompt: `下面四条都是真实存在的「已验证事实」，但只有一条属于**当前这个任务**。是哪一条？\n只回答一个字母（A/B/C/D），不要解释。\n\n` +
        opts.map((o, j) => `${'ABCD'[j]}. ${String(o).slice(0, 300)}`).join('\n')
    });
  }

  // ②b 是/否 事实判别：真假各半。真 = 本任务 verified facts；假 = 别的真实任务的 verified facts
  const k = Math.max(1, Math.floor(nFacts / 2));
  const pickT = evenly(trueFacts, k);
  const pickF = evenly(shuffle(falseFacts), k);
  for (const [claim, isTrue] of [...pickT.map(c => [c, true]), ...pickF.map(c => [c, false])]) {
    probes.push({
      type: 'fact', key: isTrue ? 'fact_true' : 'fact_false', answer: isTrue ? '是' : '否',
      prompt: `下面这句话，是不是**当前这个任务**已经确认（verified）的事实？\n只回答「是」或「否」，不要解释。\n\n「${String(claim).slice(0, 400)}」`
    });
  }

  // ②c 两跳题：一条已验证事实 + 一条"下一步"，问是否同属一个任务。
  //     字面抄不出来——必须把两个条目挂到同一个任务标题下才能答。
  //     这是为了突破 2origin 臂的"开卷天花板"：0.2 的题在 bundle 里是字面可查的。
  const allSteps = states.flatMap(s => (s.state.next_steps || []).map(x => ({ id: s.id, step: x })));
  const tgtSteps = allSteps.filter(x => x.id === targetId);
  const othSteps = allSteps.filter(x => x.id !== targetId);
  const half = Math.max(1, Math.floor(N_PAIR / 2));
  const posF = evenly(trueFacts, half), negF = evenly(trueFacts.slice().reverse(), half);
  const posS = evenly(tgtSteps, half), negS = evenly(shuffle(othSteps), half);
  for (let i = 0; i < half; i++) {
    if (posF[i] && posS[i]) probes.push({
      type: 'pair', key: 'pair_same', answer: '是',
      prompt: `下面这条「已验证事实」和这条「下一步」，是不是**属于同一个任务**？\n只回答「是」或「否」，不要解释。\n\n` +
        `已验证事实：${String(posF[i]).slice(0, 300)}\n下一步：${String(posS[i].step).slice(0, 300)}`
    });
    if (negF[i] && negS[i]) probes.push({
      type: 'pair', key: 'pair_diff', answer: '否',
      prompt: `下面这条「已验证事实」和这条「下一步」，是不是**属于同一个任务**？\n只回答「是」或「否」，不要解释。\n\n` +
        `已验证事实：${String(negF[i]).slice(0, 300)}\n下一步：${String(negS[i].step).slice(0, 300)}`
    });
  }

  // ②d 计数题：要把 bundle 里的条目数出来，也不是字面可抄的
  const nVer = trueFacts.length, nStep = (target.state.next_steps || []).length;
  for (const [q, truth] of [['当前这个任务一共有多少条已验证事实？', nVer],
                            ['当前这个任务的「下一步」列表一共有几条？', nStep]]) {
    const cand = shuffle([...new Set([truth, truth + 2, Math.max(1, truth - 3), truth * 2])]).slice(0, 4);
    if (cand.length < 4 || !cand.includes(truth)) continue;
    probes.push({
      type: 'mc', key: 'mc_count', answer: 'ABCD'[cand.indexOf(truth)],
      prompt: `${q}\n只回答一个字母（A/B/C/D），不要解释。\n\n` + cand.map((c, i) => `${'ABCD'[i]}. ${c}`).join('\n')
    });
  }

  // ③ 开放式续作：测「会不会反问」
  probes.push({
    type: 'open', key: 'resume', answer: null,
    prompt: '你现在接手这个进行到一半的任务。用两句话说明：(1) 任务目标是什么；(2) 你接下来第一件事做什么。如果上下文不足以判断，就直接说「信息不足，请告诉我任务是什么」。'
  });

  return { probes, target };
}
function evenly(arr, k) {
  if (arr.length <= k) return arr.slice();
  const out = []; const step = arr.length / k;
  for (let i = 0; i < k; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

// ─────────────────────────── 模型调用 ───────────────────────────
function resolveEndpoint() {
  if (BASE && KEY && MODEL) return { base: BASE, key: KEY, model: MODEL };
  const pf = path.join(os.homedir(), '.uking/providers.json');
  if (fs.existsSync(pf)) {
    try {
      const arr = JSON.parse(fs.readFileSync(pf, 'utf8'));
      const p = arr.find(x => x.openai_base && x.api_key);
      if (p) return { base: BASE || p.openai_base, key: KEY || p.api_key, model: MODEL || p.model };
    } catch { /* fallthrough */ }
  }
  return { base: BASE, key: KEY, model: MODEL };
}

async function ask(ep, system, user, maxTokens) {
  const r = await fetch(`${ep.base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.key}` },
    body: JSON.stringify({
      model: ep.model, temperature: 0, max_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
    })
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const m = j.choices?.[0]?.message || {};
  // 推理模型（deepseek-v4-*）会把 token 花在 reasoning_content 上，content 可能为空。
  // 空 content 不当成"答错"——单独记 no_answer，否则截断会被静默算成低分。
  return {
    text: (m.content || '').trim(),
    reasoning_chars: (m.reasoning_content || '').length,
    finish_reason: j.choices?.[0]?.finish_reason ?? null,
    prompt_tokens: j.usage?.prompt_tokens ?? null,
    completion_tokens: j.usage?.completion_tokens ?? null
  };
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// ─────────────────────────── 判分 ───────────────────────────
const ASK_BACK = /(信息不足|请告诉我|无法确定|不清楚|没有.{0,4}上下文|缺少.{0,6}信息|请提供|你能.{0,6}说明|需要.{0,4}更多信息)/;
function gradeMC(reply, answer) { const m = String(reply).match(/[ABCD]/); return m ? (m[0] === answer ? 1 : 0) : 0; }
function gradeFact(reply, answer) {
  const t = String(reply).trim();
  const yes = /(^|[^不])是|^yes/i.test(t.slice(0, 12));
  const no = /否|不是|^no/i.test(t.slice(0, 12));
  if (yes === no) return 0;                       // 两可 / 都没答 → 不给分
  return (yes ? '是' : '否') === answer ? 1 : 0;
}

// ─────────────────────────── 主流程 ───────────────────────────
const states = loadStates(REPO);
if (!states.length) die(`${REPO}/demo 下没有 task.origin.json`);
const { probes, target } = buildProbes(states, TASK, N_FACTS);

// 对照语料的来源顺序：命令行 > corpus.json（钉死）> 自动发现（会漂移，要警告）
const corpusFile = path.join(here, 'corpus.json');
let tFiles, corpusSource;
if (TRANSCRIPTS) {
  tFiles = TRANSCRIPTS.split(',').map(s => s.trim()); corpusSource = '命令行 --transcripts';
} else if (fs.existsSync(corpusFile)) {
  const c = JSON.parse(fs.readFileSync(corpusFile, 'utf8'));
  tFiles = (c.transcripts || []).filter(f => fs.existsSync(f)); corpusSource = 'corpus.json（钉死）';
  const missing = (c.transcripts || []).filter(f => !fs.existsSync(f));
  if (missing.length) console.log(`⚠ corpus.json 里有 ${missing.length} 份会话记录在盘上找不到，本次实验与历史结果不可比：\n  ${missing.join('\n  ')}`);
} else {
  tFiles = discoverTranscripts(PROJECT_DIR, TASK); corpusSource = '自动发现（⚠ 会漂移，跨次不可比）';
}
const transcriptText = renderTranscript(tFiles);

const originPayload = buildOriginPayload(states, TASK);
const B = originPayload.length;

const ragIndex = buildIndex(chunkText(transcriptText));

// 各臂的 payload。summary 臂要先打模型生成（下面 ensureSummary 填进来）；
// rag 臂逐题不同，所以是函数——给检索它该有的优势，别为了好看削弱对照组。
const payloads = {
  '2origin':         originPayload,
  'transcript':      tailChars(transcriptText, B),        // 同字节预算
  'transcript-10x':  tailChars(transcriptText, B * 10),   // 给传统 10 倍预算
  'summary':         null,                                // 运行时填（可缓存）
  'rag':             (p) => retrieve(ragIndex, p.prompt, B), // 同字节预算，按题检索
  'none':            ''
};
const ARM_NOTE = {
  '2origin': '本境 bundle（结构化状态）',
  'transcript': '真实对话流尾部截断（等预算）',
  'transcript-10x': '真实对话流尾部截断（10 倍预算）',
  'summary': '模型生成的摘要（模拟 /compact，等预算）',
  'rag': '按题词法检索真实对话流（等预算）',
  'none': '空上下文（地板线）'
};
const payloadLen = a => {
  const v = payloads[a];
  if (typeof v === 'function') return `逐题 ≤${B}`;
  if (v === null) return '待生成';
  return String(v.length);
};

const SYSTEM_WITH = ctx =>
  `你是一个接手「进行到一半的任务」的助手。以下是新会话开场时你能看到的全部上下文，除此之外你没有任何记忆。\n\n<<<上下文开始>>>\n${ctx}\n<<<上下文结束>>>`;
const SYSTEM_NONE =
  '你是一个接手「进行到一半的任务」的助手。新会话开场没有给你任何上下文，你没有任何记忆。';

console.log('═══ ShadowWork Bench · spec 0.3 · 真实语料 / 真实模型 / 客观判分 ═══');
console.log(`学历仓库 : ${REPO}`);
console.log(`目标任务 : ${TASK}（${target.state.title || ''}）`);
console.log(`语料     : ${states.length} 份真实学历，${states.reduce((n, s) => n + (s.state.facts || []).filter(f => f.verified).length, 0)} 条已验证事实`);
console.log(`对照语料 : ${tFiles.length} 份真实会话记录 → 渲染 ${transcriptText.length} 字符　来源=${corpusSource}`);
tFiles.forEach(f => console.log(`           ${path.basename(f)} (${fs.statSync(f).size} B)`));
const nOf = k => probes.filter(p => p.key === k).length;
console.log(`探针     : ${probes.filter(p => p.type === 'mc').length} 道四选一（瞎猜 25%）= 状态字段 ${nOf('goal') + nOf('next_step') + nOf('current_state')} + 事实归属 ${nOf('mc_fact')} + 计数 ${nOf('mc_count')}`);
console.log(`           ${probes.filter(p => p.type === 'fact').length} 道是/否事实判别（真假各半，瞎猜 50%）`);
console.log(`           ${probes.filter(p => p.type === 'pair').length} 道两跳题·事实↔下一步是否同任务（瞎猜 50%，字面抄不出来）`);
console.log(`           1 道开放续作　共 ${probes.length} 题/臂`);
console.log(`预算基准 : 本境 bundle 实际 ${B} 字符 → 除 transcript-10x 外各臂同预算`);
console.log('');

for (const a of ARMS) {
  if (!(a in payloads)) die(`未知 arm: ${a}（可选：${Object.keys(payloads).join(' / ')}）`);
  console.log(`  arm ${a.padEnd(15)} payload ${payloadLen(a).padStart(9)} 字符   ${ARM_NOTE[a]}`);
}
console.log('');

if (DRY) {
  console.log('── DRY RUN：不调模型。以下是 2origin 臂的 payload 头 800 字符 ──\n');
  console.log(payloads['2origin'].slice(0, 800));
  console.log('\n── rag 臂对「事实归属」题检索到的片段（头 500 字符）──\n');
  const sample = probes.find(p => p.key === 'mc_fact') || probes[0];
  console.log(retrieve(ragIndex, sample.prompt, B).slice(0, 500));
  console.log('\n── 探针样例 ──');
  for (const k of ['goal', 'fact_true', 'pair_same', 'pair_diff', 'mc_count']) {
    const p = probes.find(x => x.key === k);
    if (p) console.log(`\n[${p.type}/${p.key}] 正解=${p.answer}\n${p.prompt.slice(0, 350)}`);
  }
  const cached = fs.existsSync(path.join(CACHE, `summary-${TASK}-${B}.txt`));
  console.log(`\nsummary 臂缓存：${cached ? '已有（重跑不再花钱）' : '未生成（真跑时会打模型生成一次并缓存）'}`);
  process.exit(0);
}

const ep = resolveEndpoint();
if (!ep.base || !ep.key || !ep.model) die('缺模型端点：给 --base/--key/--model，或在 ~/.uking/providers.json 里配');
console.log(`模型     : ${ep.model} @ ${ep.base}\n`);

const results = {
  spec: 'shadowwork-bench/0.3', when: new Date().toISOString(),
  repo: REPO, task: TASK, model: ep.model, base: ep.base,
  corpus: { states: states.length, state_ids: states.map(s => s.id), corpus_source: corpusSource,
            transcripts: tFiles, transcript_chars: transcriptText.length, bundle_chars: B },
  arms: {}
};

// summary 臂：先把摘要生成出来（或读缓存）。这笔钱算在对照组头上，报告里写明。
if (ARMS.includes('summary')) {
  process.stdout.write('生成 summary 臂的摘要（模拟 /compact）…');
  const s = await buildSummaryPayload(ep, transcriptText, B, TASK);
  payloads['summary'] = s.text;
  results.summary_arm = { chars: s.text.length, cached: s.cached, build_calls: s.calls };
  console.log(` ${s.cached ? '命中缓存' : `${s.calls} 次调用`}，${s.text.length} 字符`);
}

for (const arm of ARMS) {
  const ctx = payloads[arm];
  const system = arm === 'none' ? SYSTEM_NONE : (typeof ctx === 'function' ? null : SYSTEM_WITH(ctx));
  process.stdout.write(`跑 arm=${arm} …`);
  const rows = await pool(probes, CONC, async (p) => {
    try {
      const sys = system !== null ? system : SYSTEM_WITH(ctx(p));
      const r = await ask(ep, sys, p.prompt, MAXTOK);
      return { key: p.key, type: p.type, answer: p.answer, reply: r.text.slice(0, 400),
               prompt_tokens: r.prompt_tokens, completion_tokens: r.completion_tokens,
               reasoning_chars: r.reasoning_chars, finish_reason: r.finish_reason,
               no_answer: r.text.length === 0, error: null };
    } catch (e) {
      return { key: p.key, type: p.type, answer: p.answer, reply: '', prompt_tokens: null, error: String(e.message || e) };
    }
  });

  const mc = rows.filter(r => r.type === 'mc');
  const mcField = rows.filter(r => r.type === 'mc' && r.key !== 'mc_fact' && r.key !== 'mc_count');
  const mcFact = rows.filter(r => r.key === 'mc_fact');
  const mcCount = rows.filter(r => r.key === 'mc_count');
  const ft = rows.filter(r => r.key === 'fact_true');
  const ff = rows.filter(r => r.key === 'fact_false');
  const pSame = rows.filter(r => r.key === 'pair_same');
  const pDiff = rows.filter(r => r.key === 'pair_diff');
  const open = rows.find(r => r.type === 'open');
  const errs = rows.filter(r => r.error);
  const noAns = rows.filter(r => r.no_answer).length;
  const truncated = rows.filter(r => r.finish_reason === 'length').length;
  const ctoks = rows.map(r => r.completion_tokens).filter(x => x != null);
  const avgThink = ctoks.length ? Math.round(ctoks.reduce((a, b) => a + b, 0) / ctoks.length) : null;

  const acc = rs => rs.length ? rs.reduce((n, r) => n + gradeMC(r.reply, r.answer), 0) / rs.length : null;
  const mcScore = acc(mc), mcFieldScore = acc(mcField), mcFactScore = acc(mcFact), mcCountScore = acc(mcCount);
  const rate = rs => rs.length ? rs.reduce((n, r) => n + gradeFact(r.reply, r.answer), 0) / rs.length : null;
  const tpr = rate(ft), tnr = rate(ff);
  const ba = (tpr != null && tnr != null) ? (tpr + tnr) / 2 : null;
  const psr = rate(pSame), pdr = rate(pDiff);
  const pairBa = (psr != null && pdr != null) ? (psr + pdr) / 2 : null;
  const askedBack = open ? ASK_BACK.test(open.reply) : null;
  const ptoks = rows.map(r => r.prompt_tokens).filter(x => x != null);
  const avgPrompt = ptoks.length ? Math.round(ptoks.reduce((a, b) => a + b, 0) / ptoks.length) : null;

  results.arms[arm] = {
    payload_chars: typeof ctx === 'function' ? `逐题≤${B}` : ctx.length,
    avg_prompt_tokens: avgPrompt, avg_completion_tokens: avgThink,
    errors: errs.length, no_answer: noAns, truncated,
    mc_accuracy: mcScore, mc_field_accuracy: mcFieldScore, mc_fact_accuracy: mcFactScore,
    mc_count_accuracy: mcCountScore,
    mc_n: mc.length, fact_n: ft.length + ff.length, pair_n: pSame.length + pDiff.length,
    mc_detail: mc.map(r => ({ key: r.key, ok: gradeMC(r.reply, r.answer) === 1, reply: r.reply })),
    fact_tpr: tpr, fact_tnr: tnr, fact_balanced_accuracy: ba,
    pair_same_rate: psr, pair_diff_rate: pdr, pair_balanced_accuracy: pairBa,
    resume_asked_back: askedBack, resume_reply: open ? open.reply : null,
    rows
  };
  console.log(` 完成（${errs.length} 个调用错误）`);
}

// ─────────────────────────── 报告 ───────────────────────────
const pct = x => x == null ? '  n/a' : `${(x * 100).toFixed(1)}%`;
console.log('\n════════════════════════ 结果 ════════════════════════');
const A0 = results.arms[ARMS[0]];
console.log(`（四选一 n=${A0.mc_n} 瞎猜 25% · 是/否事实 n=${A0.fact_n} 瞎猜 50% · 两跳题 n=${A0.pair_n} 瞎猜 50%）`);
console.log('arm             输入token  四选一  ·字段 ·事实归属 ·计数  事实均衡  两跳均衡  反问  空答/错');
for (const arm of ARMS) {
  const a = results.arms[arm];
  console.log(
    arm.padEnd(15) +
    String(a.avg_prompt_tokens ?? '-').padStart(10) +
    pct(a.mc_accuracy).padStart(8) +
    pct(a.mc_field_accuracy).padStart(7) +
    pct(a.mc_fact_accuracy).padStart(10) +
    pct(a.mc_count_accuracy).padStart(7) +
    pct(a.fact_balanced_accuracy).padStart(10) +
    pct(a.pair_balanced_accuracy).padStart(10) +
    (a.resume_asked_back === null ? '   n/a' : (a.resume_asked_back ? '    是' : '    否')) +
    `   ${a.no_answer}/${a.errors}`
  );
}
const trunc = ARMS.filter(a => results.arms[a].truncated > 0);
if (trunc.length)
  console.log(`⚠ 有 ${trunc.map(a => `${a}:${results.arms[a].truncated}`).join(' ')} 条 finish_reason=length —— 是 --max-tokens(${MAXTOK}) 截断，不是模型答错。` +
              `这一列不为 0 时该臂分数不可用，请调大 --max-tokens 重跑。`);
else
  console.log('✔ 无截断（所有调用 finish_reason≠length），分数不受 max-tokens 影响。');
console.log('');
const o = results.arms['2origin'];
if (o) {
  // 同预算里最强的那个对照臂——报最强的，不报最弱的。挑软柿子就是打稻草人。
  const rivals = ARMS.filter(a => a !== '2origin' && a !== 'transcript-10x' && a !== 'none')
    .map(a => ({ a, m: results.arms[a] })).filter(x => x.m.mc_accuracy != null);
  if (rivals.length) {
    const best = rivals.reduce((x, y) => (y.m.mc_accuracy + (y.m.fact_balanced_accuracy || 0)) >
                                         (x.m.mc_accuracy + (x.m.fact_balanced_accuracy || 0)) ? y : x);
    console.log(`同预算最强对照臂是 ${best.a}：四选一 ${pct(best.m.mc_accuracy)}、事实均衡 ${pct(best.m.fact_balanced_accuracy)}、` +
                `两跳 ${pct(best.m.pair_balanced_accuracy)}`);
    console.log(`对比 2origin：              四选一 ${pct(o.mc_accuracy)}、事实均衡 ${pct(o.fact_balanced_accuracy)}、` +
                `两跳 ${pct(o.pair_balanced_accuracy)}`);
  }
  const t10 = results.arms['transcript-10x'];
  if (t10 && o.avg_prompt_tokens && t10.avg_prompt_tokens)
    console.log(`10 倍预算对照：transcript-10x 用 ${(t10.avg_prompt_tokens / o.avg_prompt_tokens).toFixed(1)}x 输入 token，` +
                `四选一 ${pct(t10.mc_accuracy)}、事实均衡 ${pct(t10.fact_balanced_accuracy)}`);
  if (results.summary_arm)
    console.log(`注：summary 臂的摘要另花了 ${results.summary_arm.build_calls} 次调用生成` +
                `${results.summary_arm.cached ? '（本次命中缓存，未重复花钱）' : ''}——这笔成本算在对照组头上。`);
}
fs.writeFileSync(OUT, JSON.stringify(results, null, 2), 'utf8');
console.log(`\n明细已写入 ${OUT}`);
console.log('诚实边界：单模型单任务单次；判据来自磁盘真值，干扰项来自别的真实任务；未做多次重采样。');
