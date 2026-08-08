#!/usr/bin/env node
// shadowwork-bench-v2.mjs — ShadowWork Bench v0.2
//
// 为什么有 v0.2：v0.1（shadowwork-bench.mjs / compare-bench.mjs）测的是
// 「buildBundle 能不能把刚写进去的东西读回来」，对照组（传统 harness）的
// transcript 是本脚本自己生成的、且刻意没把 goal 原文写进去 —— 所以
// 「传统不可续作」是构造出来的，不是观察到的。那是"声明冒充事实"在
// benchmark 层的复发。
//
// v0.2 的三条硬约束：
//   1. 真实语料：学历取磁盘上真实的 task.origin.json；对照组取真实的
//      harness 会话记录（Claude Code session jsonl），不是生成的。
//   2. 真实模型：两臂用同一个模型端点、同一 prompt、temperature 0，
//      唯一差异是「会话开场喂什么」。
//   3. 客观判分：判据来自磁盘上的真值（goal / next_steps[0] / current_state /
//      facts[].claim），选项和干扰项来自**别的真实任务**的同类字段 ——
//      不是我编的稻草人。是/否 与 ABCD 可机械判分，不需要 judge。
//
// 用法：
//   node bench/shadowwork-bench-v2.mjs --dry-run          # 只看 payload 和探针，不调模型
//   node bench/shadowwork-bench-v2.mjs                    # 真跑（会调模型，花钱）
//   node bench/shadowwork-bench-v2.mjs --facts 8 --arms 2origin,transcript
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
const ARMS        = flag('--arms', '2origin,transcript,transcript-10x,none').split(',').map(s => s.trim()).filter(Boolean);
const MODEL       = flag('--model', '');
const BASE        = flag('--base', '');
const KEY         = flag('--key', process.env.DEEPSEEK_API_KEY || '');
const CONC        = parseInt(flag('--concurrency', '6'), 10);
// 推理模型把 token 花在 reasoning 上；cap 太低会让 content 为空、被误记成"答错"。
// 首轮 2000 就是这么翻的车（finish_reason=length），所以默认给足，并在报告里盯 finish_reason。
const MAXTOK      = parseInt(flag('--max-tokens', '8000'), 10);
const OUT         = flag('--out', path.join(here, 'results-v2.json'));
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

const tFiles = TRANSCRIPTS ? TRANSCRIPTS.split(',').map(s => s.trim()) : discoverTranscripts(PROJECT_DIR, TASK);
const transcriptText = renderTranscript(tFiles);

const originPayload = buildOriginPayload(states, TASK);
const B = originPayload.length;

const payloads = {
  '2origin':         originPayload,
  'transcript':      tailChars(transcriptText, B),        // 同字节预算
  'transcript-10x':  tailChars(transcriptText, B * 10),   // 给传统 10 倍预算
  'none':            ''
};

const SYSTEM_WITH = ctx =>
  `你是一个接手「进行到一半的任务」的助手。以下是新会话开场时你能看到的全部上下文，除此之外你没有任何记忆。\n\n<<<上下文开始>>>\n${ctx}\n<<<上下文结束>>>`;
const SYSTEM_NONE =
  '你是一个接手「进行到一半的任务」的助手。新会话开场没有给你任何上下文，你没有任何记忆。';

console.log('═══ ShadowWork Bench v0.2 · 真实语料 / 真实模型 / 客观判分 ═══');
console.log(`学历仓库 : ${REPO}`);
console.log(`目标任务 : ${TASK}（${target.state.title || ''}）`);
console.log(`语料     : ${states.length} 份真实学历，${states.reduce((n, s) => n + (s.state.facts || []).filter(f => f.verified).length, 0)} 条已验证事实`);
console.log(`对照语料 : ${tFiles.length} 份真实会话记录 → 渲染 ${transcriptText.length} 字符`);
tFiles.forEach(f => console.log(`           ${path.basename(f)} (${fs.statSync(f).size} B)`));
console.log(`探针     : ${probes.filter(p => p.type === 'mc').length} 道四选一（${probes.filter(p => p.key !== 'mc_fact' && p.type === 'mc').length} 道状态字段 + ${probes.filter(p => p.key === 'mc_fact').length} 道事实归属，瞎猜基线 25%）`);
console.log(`           + ${probes.filter(p => p.type === 'fact').length} 道是/否事实判别（真假各半，瞎猜基线 50%） + 1 道开放续作`);
console.log(`预算基准 : 本境 bundle 实际 ${B} 字符 → transcript 臂截同样字符数，transcript-10x 给 10 倍`);
console.log('');

for (const a of ARMS) {
  if (!(a in payloads)) die(`未知 arm: ${a}`);
  console.log(`  arm ${a.padEnd(15)} payload ${String(payloads[a].length).padStart(7)} 字符`);
}
console.log('');

if (DRY) {
  console.log('── DRY RUN：不调模型。以下是 2origin 臂的 payload 头 800 字符 ──\n');
  console.log(payloads['2origin'].slice(0, 800));
  console.log('\n── transcript 臂 payload 尾 500 字符 ──\n');
  console.log(payloads['transcript'].slice(-500));
  console.log('\n── 探针样例 ──');
  for (const p of [probes[0], probes.find(p => p.key === 'fact_true'), probes.find(p => p.key === 'fact_false')]) {
    if (p) console.log(`\n[${p.type}/${p.key}] 正解=${p.answer}\n${p.prompt.slice(0, 400)}`);
  }
  process.exit(0);
}

const ep = resolveEndpoint();
if (!ep.base || !ep.key || !ep.model) die('缺模型端点：给 --base/--key/--model，或在 ~/.uking/providers.json 里配');
console.log(`模型     : ${ep.model} @ ${ep.base}\n`);

const results = {
  spec: 'shadowwork-bench/0.2', when: new Date().toISOString(),
  repo: REPO, task: TASK, model: ep.model, base: ep.base,
  corpus: { states: states.length, transcripts: tFiles, transcript_chars: transcriptText.length, bundle_chars: B },
  arms: {}
};

for (const arm of ARMS) {
  const ctx = payloads[arm];
  const system = arm === 'none' ? SYSTEM_NONE : SYSTEM_WITH(ctx);
  process.stdout.write(`跑 arm=${arm} …`);
  const rows = await pool(probes, CONC, async (p) => {
    try {
      const r = await ask(ep, system, p.prompt, MAXTOK);
      return { key: p.key, type: p.type, answer: p.answer, reply: r.text.slice(0, 400),
               prompt_tokens: r.prompt_tokens, completion_tokens: r.completion_tokens,
               reasoning_chars: r.reasoning_chars, finish_reason: r.finish_reason,
               no_answer: r.text.length === 0, error: null };
    } catch (e) {
      return { key: p.key, type: p.type, answer: p.answer, reply: '', prompt_tokens: null, error: String(e.message || e) };
    }
  });

  const mc = rows.filter(r => r.type === 'mc');
  const mcField = rows.filter(r => r.type === 'mc' && r.key !== 'mc_fact');
  const mcFact = rows.filter(r => r.key === 'mc_fact');
  const ft = rows.filter(r => r.key === 'fact_true');
  const ff = rows.filter(r => r.key === 'fact_false');
  const open = rows.find(r => r.type === 'open');
  const errs = rows.filter(r => r.error);
  const noAns = rows.filter(r => r.no_answer).length;
  const truncated = rows.filter(r => r.finish_reason === 'length').length;
  const ctoks = rows.map(r => r.completion_tokens).filter(x => x != null);
  const avgThink = ctoks.length ? Math.round(ctoks.reduce((a, b) => a + b, 0) / ctoks.length) : null;

  const acc = rs => rs.length ? rs.reduce((n, r) => n + gradeMC(r.reply, r.answer), 0) / rs.length : null;
  const mcScore = acc(mc), mcFieldScore = acc(mcField), mcFactScore = acc(mcFact);
  const tpr = ft.length ? ft.reduce((n, r) => n + gradeFact(r.reply, r.answer), 0) / ft.length : null;
  const tnr = ff.length ? ff.reduce((n, r) => n + gradeFact(r.reply, r.answer), 0) / ff.length : null;
  const ba = (tpr != null && tnr != null) ? (tpr + tnr) / 2 : null;
  const askedBack = open ? ASK_BACK.test(open.reply) : null;
  const ptoks = rows.map(r => r.prompt_tokens).filter(x => x != null);
  const avgPrompt = ptoks.length ? Math.round(ptoks.reduce((a, b) => a + b, 0) / ptoks.length) : null;

  results.arms[arm] = {
    payload_chars: ctx.length, avg_prompt_tokens: avgPrompt, avg_completion_tokens: avgThink,
    errors: errs.length, no_answer: noAns, truncated,
    mc_accuracy: mcScore, mc_field_accuracy: mcFieldScore, mc_fact_accuracy: mcFactScore,
    mc_n: mc.length, fact_n: ft.length + ff.length,
    mc_detail: mc.map(r => ({ key: r.key, ok: gradeMC(r.reply, r.answer) === 1, reply: r.reply })),
    fact_tpr: tpr, fact_tnr: tnr, fact_balanced_accuracy: ba,
    resume_asked_back: askedBack, resume_reply: open ? open.reply : null,
    rows
  };
  console.log(` 完成（${errs.length} 个调用错误）`);
}

// ─────────────────────────── 报告 ───────────────────────────
const pct = x => x == null ? '  n/a' : `${(x * 100).toFixed(1)}%`;
console.log('\n════════════════════════ 结果 ════════════════════════');
const N_MC = results.arms[ARMS[0]].mc_n, N_FA = results.arms[ARMS[0]].fact_n;
console.log(`（四选一 n=${N_MC}，瞎猜基线 25% · 是/否 n=${N_FA}，瞎猜基线 50%）`);
console.log('arm              payload字符  输入token  四选一总  ·字段  ·事实归属  TPR  TNR  均衡准确率  反问  空答/错');
for (const arm of ARMS) {
  const a = results.arms[arm];
  console.log(
    arm.padEnd(16) +
    String(a.payload_chars).padStart(10) +
    String(a.avg_prompt_tokens ?? '-').padStart(11) +
    pct(a.mc_accuracy).padStart(10) +
    pct(a.mc_field_accuracy).padStart(7) +
    pct(a.mc_fact_accuracy).padStart(11) +
    pct(a.fact_tpr).padStart(7) +
    pct(a.fact_tnr).padStart(7) +
    pct(a.fact_balanced_accuracy).padStart(11) +
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
const o = results.arms['2origin'], t = results.arms['transcript'];
if (o && t) {
  console.log(`同预算对照：2origin 四选一 ${pct(o.mc_accuracy)} vs transcript ${pct(t.mc_accuracy)}；` +
              `事实均衡准确率 ${pct(o.fact_balanced_accuracy)} vs ${pct(t.fact_balanced_accuracy)}`);
}
const t10 = results.arms['transcript-10x'];
if (o && t10 && o.avg_prompt_tokens && t10.avg_prompt_tokens) {
  console.log(`10 倍预算对照：transcript-10x 用 ${(t10.avg_prompt_tokens / o.avg_prompt_tokens).toFixed(1)}x 输入 token，` +
              `四选一 ${pct(t10.mc_accuracy)}，事实均衡准确率 ${pct(t10.fact_balanced_accuracy)}`);
}
fs.writeFileSync(OUT, JSON.stringify(results, null, 2), 'utf8');
console.log(`\n明细已写入 ${OUT}`);
console.log('诚实边界：单模型单任务单次；判据来自磁盘真值，干扰项来自别的真实任务；未做多次重采样。');
