// southbridge.js — 南桥 Trust 模型（风险分级 + 批准机制）
// 2Origin 铁律：无头 harness 缺的不是状态格式，是"统一的写授权"（Trust 层）。
//
// 三级风险（判据只有客观输入，不看模型怎么说）：
//   low      —— 新建文件（白名单内，不存在）
//   medium   —— 覆盖已存在文件（破坏性写）
//   high     —— 受保护路径（task.origin / 代码 / schemas / .claude）
//
// 批准机制：
//   low       → 自动放行
//   medium    → 需 expect_sha256（乐观锁：证明你读过当前内容）或 approval:"confirm"
//   high      → 需 approval:"confirm"（人在环）
//
// 写后观察：status 由"世界是否真的变了"决定，不由 writeFileSync 决定。
// 覆盖前备份：reversible 有物证，不是形容词。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// 白名单：可配置。默认只允许 demo/ 下写（防路径穿越）。
export function southbridge(root, { whitelist = ['demo'], auditFile = 'audit.log' } = {}) {
  const ALLOWED = whitelist.map(w => path.resolve(root, w));
  const auditPath = path.join(root, auditFile);
  const BACKUP_DIR = path.join(root, '.backups');

  // 受保护路径：即使在白名单内，覆盖也算 high risk
  const PROTECTED = [/task\.origin\.json$/, /\.mjs$/, /\.js$/, /^schemas\//, /^\.claude\//, /^lib\//];

  function observe(abs) {
    try {
      const st = fs.statSync(abs);
      const buf = fs.readFileSync(abs);
      return {
        exists: true, size_bytes: buf.length,
        sha256: crypto.createHash('sha256').update(buf).digest('hex'),
        mtime: st.mtime.toISOString()
      };
    } catch { return { exists: false, size_bytes: 0, sha256: null, mtime: null }; }
  }

  function logAudit(entry) {
    try {
      fs.appendFileSync(auditPath, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
    } catch { /* 审计失败不阻断写 */ }
  }

  // 风险分级：纯函数，看三个客观输入（白名单/存在性/受保护）
  function assessRisk(relpath, target, mode) {
    const norm = relpath.replace(/\\/g, '/');
    const inAllowed = ALLOWED.some(d => target === d || target.startsWith(d + path.sep));
    if (!inAllowed) return { risk: 'denied', reason: '目标不在白名单 demo/ 下' };

    const exists = fs.existsSync(target);
    if (PROTECTED.some(re => re.test(norm)) && exists) {
      return { risk: 'high', reason: '受保护路径（学历/协议/代码），覆盖需显式批准' };
    }
    if (mode === 'write' && exists) {
      return { risk: 'medium', reason: '覆盖已存在文件，属破坏性写' };
    }
    return { risk: 'low', reason: mode === 'append' ? '追加写' : '新建文件' };
  }

  // 批准判定
  function checkApproval(risk, before, args) {
    if (risk === 'low') return { ok: true, approval: 'auto' };
    const { expect_sha256, approval } = args;
    if (expect_sha256) {
      if (expect_sha256 === before.sha256) return { ok: true, approval: 'expect_sha256' };
      return { ok: false, approval: 'expect_sha256', reason: `expect_sha256 不匹配：当前 ${before.sha256?.slice(0,12)}…` };
    }
    if (approval === 'confirm') return { ok: true, approval: 'confirm' };
    return { ok: false, approval: 'none', reason: `risk=${risk} 需要 expect_sha256（乐观锁）或 approval:"confirm"` };
  }

  // 动作：write / append。返回 action.result（2Origin 规范）。
  return function act({ verb, relpath, content, mode = 'write', expect_sha256 = null, approval = null }) {
    const actionId = 'act:' + crypto.randomUUID().slice(0, 8);
    const target = path.resolve(root, relpath || '');
    const base = { spec: '2origin/0.1', kind: 'action.result', action_id: actionId, verb, target: relpath };

    if (!relpath) {
      logAudit({ ...base, status: 'denied', reason: 'relpath 为空' });
      return { ...base, status: 'denied', reason: 'relpath 为空' };
    }

    // —— 风险与批准闸门 ——
    const before = observe(target);
    const { risk, reason: riskReason } = assessRisk(relpath, target, mode);
    if (risk === 'denied') {
      logAudit({ ...base, status: 'denied', risk: 'denied', reason: riskReason });
      return { ...base, status: 'denied', risk: 'denied', reason: riskReason };
    }
    const appr = checkApproval(risk, before, { expect_sha256, approval });
    if (!appr.ok) {
      const r = {
        ...base, status: 'requires_approval', risk, approval: appr.approval,
        reason: appr.reason, riskReason,
        current: { sha256: before.sha256, size_bytes: before.size_bytes, exists: before.exists }
      };
      logAudit({ ...r, current: undefined });
      return r;
    }

    // —— 覆盖前备份（reversible 的物证）——
    let backup = null;
    if (before.exists && mode === 'write') {
      try {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
        backup = path.join(BACKUP_DIR, `${Date.now()}-${path.basename(relpath)}`);
        fs.copyFileSync(target, backup);
      } catch { backup = null; }
    }

    // —— 真正动世界 ——
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (mode === 'append') fs.appendFileSync(target, content, 'utf8');
      else fs.writeFileSync(target, content, 'utf8');
    } catch (e) {
      logAudit({ ...base, status: 'failed', risk, approval: appr.approval, reason: e.message });
      return { ...base, status: 'failed', risk, approval: appr.approval, reason: e.message };
    }

    // —— 写后回头观察：status 由观察决定 ——
    const after = observe(target);
    const expectedBytes = Buffer.byteLength(content, 'utf8');
    const ok = mode === 'append'
      ? after.size_bytes === (before.size_bytes || 0) + expectedBytes
      : after.size_bytes === expectedBytes;
    const status = after.exists && ok ? 'done' : 'failed';

    logAudit({ ...base, status, risk, approval: appr.approval, bytes: expectedBytes, backup: !!backup });
    return {
      ...base, status, risk, approval: appr.approval, riskReason,
      evidence: after,
      state_diff: { before, after },
      bytes_written: expectedBytes,
      reversible: !!backup,
      backup_path: backup ? path.relative(root, backup) : null,
      undo_hint: backup ? 'restore from backup_path' : 'delete target'
    };
  };
}
