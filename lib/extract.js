// extract.js — 经验自动提取器（自动记忆：不遗忘的另一半）
//
// 读取 harness 工作记录（Claude Code transcript / Codex session），
// 提取"教训信号"（error / failed / retry / 成功 / 坑），生成 candidate learnings。
//
// 诚实边界（bugscope 审视自己）：
//   - 产出 **candidate**（不是 verified）——只负责"发现值得记的"，
//     晋升要过学堂门槛（confidence≥0.7 + 可复核证据）。
//   - 证据 = 来源 transcript 行号（可复核物）。
//   - 只做**信号扫描**，不假装读懂语义；原文作为 evidence 交审核。
//
// 用法：
//   extractFromJsonl(transcriptPath)             → [{ lesson, confidence, evidence, kind }]
//   extractAndApply(state, transcriptPath)       → 追加 candidate 到状态对象（返回 added 数）
import fs from 'node:fs';
import { addLearning } from './state.js';

// 教训信号：保守，宁可漏不误报。
// 关键过滤：跳过"讨论性"内容（提到 error 但不构成实际教训的 meta 讨论）。
const DEFAULT_SIGNALS = [
  { re: /\berror\b|\bfailed\b|失败|报错/i, kind: 'error', conf: 0.6 },
  { re: /\bretry\b|重试/i, kind: 'retry', conf: 0.55 },
  { re: /坑|踩坑|注意/i, kind: 'pitfall', conf: 0.65 },
];

// 讨论性内容特征：提到"我们讨论/我们审/上面/这里说/上一条"这类元话术，多半是 meta，不是教训
const META_RE = /\b我们\b|\b上面\b|\b这里说\b|\b上一条\b|\b报告\b|\b简报\b|\b复盘\b/i;

// 从 transcript（JSONL）提取教训信号
export function extractFromJsonl(transcriptPath, { signals = DEFAULT_SIGNALS, maxLines = 5000 } = {}) {
  const hits = [];
  if (!fs.existsSync(transcriptPath)) return hits;

  let lines;
  try { lines = fs.readFileSync(transcriptPath, 'utf8').split('\n'); }
  catch { return hits; }

  const recent = lines.slice(-maxLines);

  for (let i = 0; i < recent.length; i++) {
    const line = recent[i];
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    let text = '';
    try {
      const msg = entry.message;
      if (!msg || !msg.content) continue;
      const c = msg.content;
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) text = c.map(x => (typeof x === 'string' ? x : x.text || '')).join(' ');
    } catch { continue; }

    if (!text || text.length < 20) continue;
    // 跳过讨论性内容（meta 话术多，不是实际教训）
    if (META_RE.test(text)) continue;

    for (const sig of signals) {
      const m = sig.re.exec(text);
      if (m) {
        const start = Math.max(0, (m.index || 0) - 40);
        const snippet = text.slice(start, start + 160).replace(/\s+/g, ' ').trim();
        hits.push({
          kind: sig.kind,
          lesson: `[${sig.kind}] ${snippet.slice(0, 120)}`,
          confidence: sig.conf,
          evidence: `${transcriptPath}:${i}`,
        });
        break; // 每行只记一类，避免刷屏
      }
    }
  }

  // 去重（同 lesson 只留一条）
  const seen = new Set();
  return hits.filter(h => {
    if (seen.has(h.lesson)) return false;
    seen.add(h.lesson);
    return true;
  });
}

// 提取并追加 candidate learnings 到状态对象（不晋升，过学堂门槛是后面的事）
export function extractAndApply(state, transcriptPath, opts = {}) {
  const hits = extractFromJsonl(transcriptPath, opts);
  let added = 0;
  for (const h of hits) {
    const exists = (state.learnings || []).some(l => l.lesson === h.lesson);
    if (!exists) {
      addLearning(state, h.lesson, h.confidence);
      // 附加证据
      const last = state.learnings[state.learnings.length - 1];
      last.evidence = h.evidence;
      added++;
    }
  }
  return { added, hits: hits.length };
}
