// bugscope.js — bug 透视镜：审视"影子冒充对象"的可执行检查器
// 哲学基础：2origin-computer/philosophy/bugscope.md
//   A1 存在≠验证 / A2 自证不成立 / A3 判断与决策分离
// 用法：
//   import { bugscope } from './bugscope.js'
//   bugscope({ events: [...] })          // 审视一组事件/日志
//   bugscope({ state })                  // 审视一个状态对象
//   bugscope({ report })                 // 审视一份诊断报告
//
// 输出：{ hits: [{ axiom, question, evidence, suspicion }],  verdict }
// 结论是"怀疑"，不是"判决"——只指出"可能把声明当事实"，要人去验证。

export function bugscope(input) {
  const hits = [];

  // ── Q1/Q2: 存在性检查被当成验证？ ──
  // 审视一个"声明/标记"是否配了独立的观察证据
  function auditClaim(claim, evidence, label) {
    if (claim && !evidence) {
      hits.push({
        axiom: 'A1',
        question: 'Q2 存在性检查被当成验证？',
        evidence: label,
        suspicion: `「${label}」只有${claim}，没有独立观察证据——存在≠验证`
      });
    }
    return hits;
  }

  // ── Q3: 自证？证明者==被证明者？ ──
  // 审视"生成物"是否由同一个系统声称。只有两者都提供了才审视（undefined===undefined 不是自证）。
  function auditSelfProve({ producer, observer, label }) {
    if (producer == null || observer == null) return;
    if (producer === observer) {
      hits.push({
        axiom: 'A2',
        question: 'Q3 谁在证明？证明者==被证明者？',
        evidence: label,
        suspicion: `「${label}」生成者与观察者相同（${producer}）——自证不成立`
      });
    }
  }

  // ── Q4: 判断依据 vs 决策权分离？ ──
  function auditSeparation({ judgeHasBasis, deciderHasBasis, deciderName, judgeName }) {
    if (judgeHasBasis && !deciderHasBasis) {
      hits.push({
        axiom: 'A3',
        question: 'Q4 判断与决策分离？',
        evidence: `${judgeName}有判断依据，${deciderName}没有`,
        suspicion: `决策方(${deciderName})无判断依据，判断方(${judgeName})无决策权——表象替身事实`
      });
    }
  }

  // ── Q5/A4: 缺席不会自己发声——承诺失效时谁会知道？ ──
  // 审视承诺：它有没有"失效时让调用方知道"的机制？空 catch / 静默路径 = 命中。
  function auditPromise({ what, silent_failure, has_observer }) {
    if (silent_failure || (has_observer === false)) {
      hits.push({
        axiom: 'A4',
        question: 'Q5 这里承诺过什么？承诺失效时谁会知道？',
        evidence: `承诺「${what}」${silent_failure ? '失败路径静默' : '没有观察者'}`,
        suspicion: `「${what}」承诺可能悄悄失效且无人知晓——缺席不会自己发声`
      });
    }
  }

  // ── Q6/A5: 验证会衰减——这条结论什么时候成立的？世界变了谁去改它？ ──
  // 审视 verified fact：有 when 但没有"再验证机制"，或世界已变但 verified 没被撤销。
  function auditDecay({ claim, verified, when, world_changed }) {
    if (verified && world_changed && !when) {
      hits.push({
        axiom: 'A5',
        question: 'Q6 这条结论什么时候成立的？世界变了谁去改它？',
        evidence: `「${claim}」世界已变但标记仍 verified`,
        suspicion: `验证已过期：「${claim}」世界变了，verified 不会自己变回去`
      });
    }
    if (verified && world_changed && when) {
      // 有 when 但世界变了——需要有人再验证（依赖事实被推翻的 case）
      hits.push({
        axiom: 'A5',
        question: 'Q6 世界变了，谁去改这条结论？',
        evidence: `「${claim}」于 ${when} 成立，世界已变`,
        suspicion: `「${claim}」验证可能已过期（${when} 成立，世界已变），需要再验证`
      });
    }
  }

  // ── 主入口：审视各种输入 ──
  if (input.events) {
    for (const ev of input.events) {
      auditClaim(ev.claim, ev.evidence, ev.label || ev.id);
    }
  }
  if (input.state) {
    const s = input.state;
    for (const f of (s.facts || [])) {
      auditClaim(f.verified ? 'verified:true' : null, f.source, f.claim?.slice(0, 40));
    }
  }
  if (input.report) {
    const r = input.report;
    auditSelfProve({ producer: r.producer, observer: r.observer, label: r.label });
    if (r.judgeHasBasis != null) {
      auditSeparation({ judgeHasBasis: r.judgeHasBasis, deciderHasBasis: r.deciderHasBasis, deciderName: r.deciderName, judgeName: r.judgeName });
    }
  }
  if (input.claim && input.observer) {
    auditSelfProve({ producer: input.producer, observer: input.observer, label: input.label });
  }
  if (input.promises) {
    for (const p of input.promises) {
      auditPromise({ what: p.what, silent_failure: p.silent_failure, has_observer: p.has_observer });
    }
  }
  if (input.worldChanged) {
    // A5：世界已变，审视所有 verified fact 是否过期
    for (const f of (input.state?.facts || input.facts || [])) {
      if (f.verified) auditDecay({ claim: f.claim, verified: true, when: f.when, world_changed: true });
    }
  }

  const verdict = hits.length === 0
    ? '✅ 未发现影子/对象混淆（或该输入不适用）'
    : `⚠️ 发现 ${hits.length} 处可能的认知越界，需人验证`;

  return { hits, verdict };
}

// 便捷：一条命令审一个 claim 有没有配 evidence
export function audit(claim, evidence) {
  const r = bugscope({ events: [{ claim, evidence, label: '入参' }] });
  return r;
}
