#!/usr/bin/env node
// corpus-availability.mjs — 对照组那一侧缺的地板线检查（spec 0.4 补）
//
// 为什么存在：bench 一直有一条地板线自查——空上下文臂必须贴着瞎猜线，否则说明题目泄题。
// 那查的是**题目对空手者太容易**。但它的镜像一直没人查：
//
//     题目对对照组是不是根本不可能？
//
// 真值取自磁盘上的 task.origin.json，而对照臂看到的是两份**钉死的**会话记录。
// 学历是活文件，被后来的会话继续写过——于是有些"已验证事实"压根不在那两份记录里。
// 不查这一条，「状态赢对话流」里就混着一块「对照组没见过」，而两者的含义完全不同：
//   前者是「同样的信息，结构化表示更好用」——这是我们想证的；
//   后者是「我们给对照组的语料里没有答案」——这是 v0.1 那个构造出来的结论换了个地方复发。
//
// 做法：对每条被抽中的真事实，在语料的 900 字符块里找覆盖它特征词最多的那一块，
// 取覆盖率作为「可得性」。再按可得性把各臂的 TPR 拆成两半，并列出 TNR。
// 分词与切块口径直接抄 bench 主文件，不另立一套（另立一套就是自证）。
//
// 用法：node bench/corpus-availability.mjs [--results bench/results-live-v4.json]
// 退出码：0 = 跑完　1 = 环境/参数错　2 = 学历指纹已变，探针无法重建

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const flag = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const RESULTS = flag('--results', path.join(here, 'results-live-v4.json'));
const REPO = flag('--repo', 'D:/uking编程/ShadowOS = Harness OS');
const THRESH = parseFloat(flag('--threshold', '0.6'));

const die = (m, c = 1) => { console.error('✗ ' + m); process.exit(c); };
if (!fs.existsSync(RESULTS)) die(`找不到结果文件 ${RESULTS}`);
const R = JSON.parse(fs.readFileSync(RESULTS, 'utf8'));

// ── 口径与 bench 主文件一致 ──
function terms(s) {
  const out = [];
  for (const w of String(s).toLowerCase().match(/[a-z0-9_.\-/]+/g) || []) out.push(w);
  for (const run of String(s).match(/[\u4e00-\u9fa5]+/g) || [])
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  return out;
}
const chunkText = (t, size = 900, ov = 200) => {
  const o = []; for (let i = 0; i < t.length; i += (size - ov)) o.push(t.slice(i, i + size)); return o;
};
const evenly = (a, k) => {
  if (a.length <= k) return a.slice();
  const o = [], s = a.length / k; for (let i = 0; i < k; i++) o.push(a[Math.floor(i * s)]); return o;
};
function gradeFact(reply, answer) {
  const t = String(reply).trim();
  const yes = /(^|[^不])是|^yes/i.test(t.slice(0, 12));
  const no = /否|不是|^no/i.test(t.slice(0, 12));
  if (yes === no) return 0;
  return (yes ? '是' : '否') === answer ? 1 : 0;
}
function wilson(k, n) {
  if (!n) return null;
  const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n);
  const m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - m) / d, (c + m) / d];
}
const iv = (k, n) => { const w = wilson(k, n); return `[${(w[0] * 100).toFixed(1)},${(w[1] * 100).toFixed(1)}]`; };

// ── 探针重建：学历指纹变了就不许重建，宁可退出也不拿新学历去解释旧结果 ──
const statePath = path.join(REPO, 'demo', R.task, 'task.origin.json');
if (!fs.existsSync(statePath)) die(`找不到学历 ${statePath}`);
const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const ranHash = (R.corpus.state_hashes || {})[R.task];
const nowHash = String(st.content_hash || '').slice(0, 16);
if (ranHash && nowHash && ranHash !== nowHash)
  die(`学历 ${R.task} 在跑完之后被改过（跑时 ${ranHash} → 现在 ${nowHash}），探针无法忠实重建。` +
      `拿现在的学历去解释当时的结果，就是用新真值给旧答案打分。`, 2);

const corpusFile = path.join(here, 'cache', `corpus-${R.task}-${R.corpus.transcript_chars}.txt`);
if (!fs.existsSync(corpusFile))
  die(`找不到当次对照语料 ${corpusFile}（跑一次带 mem0 臂的 bench 会写出它）`);
const corpus = fs.readFileSync(corpusFile, 'utf8');
const chunks = chunkText(corpus).map(c => new Set(terms(c)));

const trueFacts = (st.facts || []).filter(f => f.verified).map(f => f.claim);
const nTrue = (R.arms[Object.keys(R.arms)[0]].rows || []).filter(r => r.key === 'fact_true').length;
const pickT = evenly(trueFacts, nTrue);
if (pickT.length !== nTrue) die(`真事实数对不上（结果里 ${nTrue} 条，重建出 ${pickT.length} 条）`, 2);

const avail = pickT.map(f => {
  const T = [...new Set(terms(f))];
  let best = 0;
  for (const c of chunks) { let h = 0; for (const t of T) if (c.has(t)) h++; if (h / T.length > best) best = h / T.length; }
  return best;
});
const IN = avail.map(a => a >= THRESH);
const nIn = IN.filter(Boolean).length, nOut = nTrue - nIn;

console.log('═══ 对照语料可得性检查（spec 0.4）═══');
console.log(`结果文件 : ${path.basename(RESULTS)}　任务 ${R.task}　学历指纹 ${nowHash}（与跑时一致）`);
console.log(`对照语料 : ${corpus.length} 字符 → ${chunks.length} 个 900 字符块`);
console.log(`可得性阈 : 单块特征词覆盖 ≥ ${(THRESH * 100).toFixed(0)}%`);
const srt = avail.slice().sort((a, b) => a - b);
console.log(`可得性分布：中位 ${(srt[Math.floor(nTrue / 2)] * 100).toFixed(0)}%　最低 ${(srt[0] * 100).toFixed(0)}%　最高 ${(srt[nTrue - 1] * 100).toFixed(0)}%`);
console.log(`→ 答案在语料里 ${nIn}/${nTrue} 条，不在 ${nOut}/${nTrue} 条\n`);

if (nOut === 0) {
  console.log('✔ 全部真事实都能在对照语料里找到，「对照组没见过」这个替代解释不成立。');
} else {
  console.log(`⚠ 有 ${nOut}/${nTrue} 条真事实在对照语料里覆盖不足 ${(THRESH * 100).toFixed(0)}%。`);
  console.log('  学历是活文件、而对照语料是钉死的两份会话记录，后写进学历的事实不可能在里面。');
  console.log('  这些题上的差距**不能**读成「结构化表示更好用」，只能读成「对照组没有这条信息」。\n');
}

console.log(`arm             真事实TPR·在语料(n=${nIn})       ·不在语料(n=${nOut})      假事实TNR(n=?)          均衡·仅在语料`);
for (const a of Object.keys(R.arms)) {
  const rows = R.arms[a].rows || [];
  const ft = rows.filter(r => r.key === 'fact_true');
  const ff = rows.filter(r => r.key === 'fact_false');
  if (ft.length !== nTrue) { console.log(`${a.padEnd(15)} 行数不符（${ft.length}）`); continue; }
  const kIn = ft.filter((r, i) => IN[i]).reduce((n, r) => n + gradeFact(r.reply, r.answer), 0);
  const kOut = ft.filter((r, i) => !IN[i]).reduce((n, r) => n + gradeFact(r.reply, r.answer), 0);
  const kN = ff.reduce((n, r) => n + gradeFact(r.reply, r.answer), 0);
  const bal = (kIn / Math.max(nIn, 1) + kN / Math.max(ff.length, 1)) / 2;
  console.log(
    a.padEnd(15) +
    `${(kIn / nIn * 100).toFixed(1)}% ${iv(kIn, nIn)}`.padEnd(26) +
    (nOut ? `${(kOut / nOut * 100).toFixed(1)}% ${iv(kOut, nOut)}` : 'n/a').padEnd(26) +
    `${(kN / ff.length * 100).toFixed(1)}% ${iv(kN, ff.length)}`.padEnd(24) +
    `${(bal * 100).toFixed(1)}%`);
}
console.log('\n读法：「在语料」列比的是**同样的信息谁更找得到**；「不在语料」列比的不是表示形式，' +
            '\n      是对照组有没有这条信息，不该用来支持任何关于表示形式的结论。' +
            '\n      TNR 列问的是另一件事：别的任务的已验证事实，你会不会认成自己的。');
