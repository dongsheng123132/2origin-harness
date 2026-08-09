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
const N_PAIR      = parseInt(flag('--pairs', '32'), 10);    // 两跳题：事实↔下一步是否同属一个任务
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

// files: 字符串路径，或 {path, bytes}。给了 bytes 就只读前 N 字节——
// 活着的会话文件每几分钟就变长，不钉字节数两次运行就不是同一个实验。
function renderTranscript(files) {
  const lines = [];
  for (const f of files) {
    const fp = typeof f === 'string' ? f : f.path;
    const cap = typeof f === 'string' ? null : f.bytes;
    let raw;
    try {
      if (cap) {
        const fd = fs.openSync(fp, 'r');
        const buf = Buffer.alloc(cap);
        const n = fs.readSync(fd, buf, 0, cap, 0);
        fs.closeSync(fd);
        raw = buf.subarray(0, n).toString('utf8');
        const lastNl = raw.lastIndexOf('\n');
        if (lastNl > 0) raw = raw.slice(0, lastNl);   // 丢掉被截断的半行
      } else {
        raw = fs.readFileSync(fp, 'utf8');
      }
    } catch { continue; }
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
  if (fs.existsSync(cacheFile)) {
    const cached = fs.readFileSync(cacheFile, 'utf8');
    if (cached.length >= budget * 0.3) return { text: cached, cached: true, calls: 0 };
    fs.rmSync(cacheFile);   // 旧版本可能存过空摘要，别继承坏缓存
    console.log(`\n  ⚠ 缓存里的摘要只有 ${cached.length} 字符，判为坏缓存已删除，重新生成`);
  }
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
  // 目标长度要给下界。只说"不超过 N"会让模型写到 N 的三成就收笔——
  // 那等于我替对照组把预算浪费掉了，是另一种打稻草人。
  const mergePrompt =
    `下面是同一个任务各段工作记录的要点。合并成**一份**给新会话看的交接摘要，` +
    `明确写出：任务目标、当前状态、**逐条列出已确认的事实**、下一步。\n` +
    `**长度要求：${Math.floor(budget * 0.85)}～${budget} 字符之间。你有充足预算，不要压缩过头——` +
    `宁可多列几条已确认的事实，也不要为了短而丢掉细节。**\n\n${merged}`;

  // 推理模型要先花一大截 token 想，再输出 ~budget 字符的正文。cap 给不够
  // 就会返回空 content（finish_reason=length）。第一次就是这么翻的车。
  let text = '';
  for (const cap of [Math.max(24000, budget * 3), Math.max(48000, budget * 6)]) {
    const r = await ask(ep, '你在为一个新会话写交接摘要。只输出摘要正文，不要寒暄。', mergePrompt, cap);
    calls++;
    if (r.text.length >= budget * 0.3) { text = tailChars(r.text, budget); break; }
    console.log(`\n  ⚠ 摘要合并只回了 ${r.text.length} 字符（finish_reason=${r.finish_reason}），加大 cap 重试`);
  }
  // 空摘要绝不能落缓存：那会让之后每一次运行都静默地用一个空对照组，
  // 而报告上还写着"summary 臂"。宁可炸，也不要悄悄给出假对照。
  if (text.length < budget * 0.3)
    throw new Error(`summary 臂生成失败：合并结果只有 ${text.length} 字符（要求 ≥${Math.floor(budget * 0.3)}）。未写缓存。`);
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
// ── 四选一的两个防泄题措施 ──
// ① 干扰项按「长度最接近正解」挑：目标任务往往是干得最久的那个，字段最长，
//    于是"挑最长的那条"就能蒙对——空上下文臂 3/3 全中就是这么来的。
// ② 正解位置轮流 A→B→C→D：位置有偏好的瞎猜者被钉死在 25%。
let mcSeq = 0;
function mkMC(question, truth, pool, key) {
  const L = String(truth).length;
  const distract = [...new Set(pool.filter(Boolean).map(String).filter(x => x !== String(truth)))]
    .sort((a, b) => Math.abs(a.length - L) - Math.abs(b.length - L)).slice(0, 3);
  if (distract.length < 3) return null;
  const slot = mcSeq++ % 4;
  const rest = shuffle(distract);
  const opts = []; let ri = 0;
  for (let i = 0; i < 4; i++) opts.push(i === slot ? String(truth) : rest[ri++]);
  return {
    type: 'mc', key, answer: 'ABCD'[slot],
    prompt: `${question}\n只回答一个字母（A/B/C/D），不要解释。\n\n` +
      opts.map((o, i) => `${'ABCD'[i]}. ${o.slice(0, 300)}`).join('\n')
  };
}

function buildProbes(states, targetId, nFacts) {
  const target = states.find(s => s.id === targetId);
  if (!target) die(`找不到任务 ${targetId}`);
  const others = states.filter(s => s.id !== targetId);
  const probes = [];
  mcSeq = 0;

  // ① 三道四选一：目标 / 下一步第一条 / 当前状态。干扰项 = 别的真实任务的同一字段
  const mc = [
    { key: 'goal',          q: '这个任务的目标（goal）是哪一条？', truth: target.state.goal,          pool: others.map(s => s.state.goal) },
    { key: 'next_step',     q: '这个任务「下一步」列表的第一条是哪一条？', truth: (target.state.next_steps || [])[0], pool: others.map(s => (s.state.next_steps || [])[0]) },
    { key: 'current_state', q: '这个任务的当前状态（current_state）是哪一条？', truth: target.state.current_state, pool: others.map(s => s.state.current_state) }
  ];
  for (const m of mc) {
    if (!m.truth) continue;
    const p = mkMC(m.q, m.truth, m.pool, m.key);
    if (p) probes.push(p);
  }

  const trueFacts = (target.state.facts || []).filter(f => f.verified).map(f => f.claim);
  const falseFacts = others.flatMap(s => (s.state.facts || []).filter(f => f.verified).map(f => f.claim));

  // ②a 四选一事实题：1 条真 + 3 条别的真实任务的真事实。随机基线 = 25%，
  //     这一档是为了把「none 臂」压回真正的瞎猜线 —— 三道题的 MC 噪音太大，不能下结论。
  const mcTrue = evenly(trueFacts, N_MCFACT);
  for (let i = 0; i < mcTrue.length; i++) {
    const p = mkMC('下面四条都是真实存在的「已验证事实」，但只有一条属于**当前这个任务**。是哪一条？',
                   mcTrue[i], falseFacts, 'mc_fact');
    if (p) probes.push(p);
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
    const p = mkMC(q, truth, [truth + 2, Math.max(1, truth - 3), truth * 2, truth + 5], 'mc_count');
    if (p) probes.push(p);
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

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ask(ep, system, user, maxTokens, tries = 4) {
  // 网络抖一下不该让一次 400 次调用的实验整个崩掉。重试只针对传输层错误与
  // 5xx/429；4xx（参数错、鉴权错）直接抛，不该靠重试掩盖。
  let last;
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt) await sleep(1000 * 2 ** (attempt - 1));
    let r;
    try {
      r = await fetch(`${ep.base.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.key}` },
        body: JSON.stringify({
          model: ep.model, temperature: 0, max_tokens: maxTokens,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
        })
      });
    } catch (e) { last = e; continue; }               // 传输层错误 → 重试
    if (r.ok) return parseReply(await r.json());
    const body = (await r.text()).slice(0, 200);
    if (r.status === 429 || r.status >= 500) { last = new Error(`HTTP ${r.status} ${body}`); continue; }
    throw new Error(`HTTP ${r.status} ${body}`);      // 4xx → 立刻抛
  }
  throw new Error(`重试 ${tries} 次仍失败：${last && (last.message || last)}`);
}

function parseReply(j) {
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

// 把一臂的逐题结果算成指标。抽成函数是为了 --repair-only 能复用同一套算法——
// 两份算法迟早会不一致，那时候没人知道该信哪个。
function scoreRows(rows, payloadChars, repaired = 0) {
  const by = k => rows.filter(r => r.key === k);
  const mc = rows.filter(r => r.type === 'mc');
  const mcField = mc.filter(r => r.key !== 'mc_fact' && r.key !== 'mc_count');
  const ft = by('fact_true'), ff = by('fact_false');
  const pSame = by('pair_same'), pDiff = by('pair_diff');
  const open = rows.find(r => r.type === 'open');
  const acc = rs => rs.length ? rs.reduce((n, r) => n + gradeMC(r.reply, r.answer), 0) / rs.length : null;
  const rate = rs => rs.length ? rs.reduce((n, r) => n + gradeFact(r.reply, r.answer), 0) / rs.length : null;
  const tpr = rate(ft), tnr = rate(ff), psr = rate(pSame), pdr = rate(pDiff);
  const avg = xs => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
  return {
    payload_chars: payloadChars,
    avg_prompt_tokens: avg(rows.map(r => r.prompt_tokens).filter(x => x != null)),
    avg_completion_tokens: avg(rows.map(r => r.completion_tokens).filter(x => x != null)),
    errors: rows.filter(r => r.error).length,
    no_answer: rows.filter(r => r.no_answer).length,
    truncated: rows.filter(r => r.finish_reason === 'length').length,
    repaired,
    mc_accuracy: acc(mc), mc_field_accuracy: acc(mcField),
    mc_fact_accuracy: acc(by('mc_fact')), mc_count_accuracy: acc(by('mc_count')),
    mc_n: mc.length, mc_field_n: mcField.length, mc_fact_n: by('mc_fact').length, mc_count_n: by('mc_count').length,
    fact_n: ft.length + ff.length, pair_n: pSame.length + pDiff.length,
    mc_detail: mc.map(r => ({ key: r.key, ok: gradeMC(r.reply, r.answer) === 1, reply: r.reply })),
    fact_tpr: tpr, fact_tnr: tnr,
    fact_balanced_accuracy: (tpr != null && tnr != null) ? (tpr + tnr) / 2 : null,
    pair_same_rate: psr, pair_diff_rate: pdr,
    pair_balanced_accuracy: (psr != null && pdr != null) ? (psr + pdr) / 2 : null,
    resume_asked_back: open ? ASK_BACK.test(open.reply) : null,
    resume_reply: open ? open.reply : null,
    rows
  };
}

// 地板线自查：空上下文那一臂本该贴着瞎猜线。它明显高于瞎猜，只有一种解释——
// **题目本身泄题**（选项风格/长度就能猜出答案）。那个指标不能用来下结论。
const CHANCE = { mc_accuracy: 0.25, mc_field_accuracy: 0.25, mc_fact_accuracy: 0.25, mc_count_accuracy: 0.25,
                 fact_balanced_accuracy: 0.5, pair_balanced_accuracy: 0.5 };
// n 太小的时候「高于瞎猜」本身就是噪音（n=2 时答对 1 道就是 50%）。
// 少于 MIN_N 的指标不参与泄题判定，也不该用来下任何结论。
const MIN_N = 8;
const METRIC_N = { mc_accuracy: 'mc_n', mc_field_accuracy: 'mc_field_n', mc_fact_accuracy: 'mc_fact_n',
                   mc_count_accuracy: 'mc_count_n', fact_balanced_accuracy: 'fact_n', pair_balanced_accuracy: 'pair_n' };
function leakCheck(noneArm, margin = 0.25) {
  if (!noneArm) return [];
  return Object.entries(CHANCE)
    .filter(([k, c]) => noneArm[k] != null && (noneArm[METRIC_N[k]] ?? 0) >= MIN_N && noneArm[k] >= c + margin)
    .map(([k, c]) => ({ metric: k, none: noneArm[k], chance: c, n: noneArm[METRIC_N[k]] }));
}
function tooSmall(arm) {
  return Object.entries(METRIC_N).filter(([k, nk]) => arm[k] != null && (arm[nk] ?? 0) < MIN_N).map(([k]) => k);
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
  const want = (c.transcripts || []).map(t => typeof t === 'string' ? { path: t, bytes: null } : t);
  tFiles = want.filter(t => fs.existsSync(t.path));
  corpusSource = 'corpus.json（钉死）';
  const missing = want.filter(t => !fs.existsSync(t.path));
  if (missing.length) console.log(`⚠ corpus.json 里有 ${missing.length} 份会话记录在盘上找不到，本次实验与历史结果不可比：\n  ${missing.map(t => t.path).join('\n  ')}`);
  const short = tFiles.filter(t => t.bytes && fs.statSync(t.path).size < t.bytes);
  if (short.length) console.log(`⚠ ${short.length} 份会话记录比钉死的字节数还短（被截断/替换过），与历史结果不可比`);
} else {
  // corpus.json 不进仓库（含本机绝对路径）。没有它就退回自动发现，
  // 但必须明说"这次的分数跨机器/跨次不可比"，而不是静默照跑。
  tFiles = discoverTranscripts(PROJECT_DIR, TASK); corpusSource = '自动发现（⚠ 会漂移，跨次不可比）';
  console.log(`⚠ 没有 bench/corpus.json，退回自动发现。要可复现请照 bench/corpus.example.json 建一份。`);
  console.log(`  自动发现会把「正在做 benchmark 的这个会话」也捞进对照组——那是泄题。`);
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
tFiles.forEach(f => { const fp = typeof f === "string" ? f : f.path; const cap = typeof f === "string" ? null : f.bytes; console.log(`           ${path.basename(fp)} (盘上 ${fs.statSync(fp).size} B${cap ? `，只读前 ${cap} B` : ""})`); });
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
  // 学历也在被别的会话实时改动。语料不能拷进公开仓库（含私人工作内容），
  // 那就至少把每份的 content_hash 记下来：这次跑的到底是哪一版，事后可辨认。
  corpus: { states: states.length, corpus_source: corpusSource,
            state_hashes: Object.fromEntries(states.map(s => [s.id, (s.state.content_hash || '').slice(0, 16)])),
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

  // 截断修复：finish_reason=length 说明是我给的 max_tokens 不够，不是模型答错。
  // temperature=0 下重跑同一条只是把被砍掉的尾巴补出来，所以只补截断的那几条，
  // 等价于全程用更大的 cap 跑——但便宜得多。补了几条要记账，不能悄悄补。
  const need = rows.map((r, i) => ({ r, i })).filter(x => x.r.finish_reason === 'length');
  if (need.length) {
    process.stdout.write(` 修复 ${need.length} 条截断…`);
    await pool(need, CONC, async ({ r, i }) => {
      const p = probes[i];
      try {
        const sys = system !== null ? system : SYSTEM_WITH(ctx(p));
        const r2 = await ask(ep, sys, p.prompt, MAXTOK * 3);
        Object.assign(rows[i], {
          reply: r2.text.slice(0, 400), prompt_tokens: r2.prompt_tokens,
          completion_tokens: r2.completion_tokens, finish_reason: r2.finish_reason,
          no_answer: r2.text.length === 0, repaired_at_maxtok: MAXTOK * 3
        });
      } catch (e) { rows[i].repair_error = String(e.message || e); }
    });
  }

  results.arms[arm] = scoreRows(rows, typeof ctx === 'function' ? `逐题≤${B}` : ctx.length, need.length);
  console.log(` 完成（${results.arms[arm].errors} 个调用错误，修复 ${need.length} 条）`);
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
const leaks = leakCheck(results.arms['none']);
if (leaks.length) {
  console.log(`⚠ 地板线异常：空上下文臂在 ${leaks.map(l => `${l.metric}=${(l.none * 100).toFixed(1)}%（瞎猜 ${(l.chance * 100).toFixed(0)}%）`).join('、')}`);
  console.log(`  没有上下文却明显高于瞎猜，只有一种解释：**这些题泄题**（光看选项就能猜）。这几个指标不能用来下结论。`);
} else if (results.arms['none']) {
  console.log(`✔ 地板线正常：空上下文臂在 n≥${MIN_N} 的指标上均贴近瞎猜线，题目未泄题。`);
}
const small = tooSmall(results.arms[ARMS[0]]);
if (small.length) console.log(`ℹ 题量不足（n<${MIN_N}）故不作结论的指标：${small.join('、')} —— 列在表里只为透明，别拿它比高低。`);
const rep = ARMS.filter(a => results.arms[a].repaired > 0);
if (rep.length) console.log(`ℹ 截断修复：${rep.map(a => `${a}:${results.arms[a].repaired}`).join(' ')} 条曾触 max_tokens(${MAXTOK})，已用 ${MAXTOK * 3} 重跑补齐（temperature=0，等价于全程用大 cap）。`);
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
