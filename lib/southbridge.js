// southbridge.js — 南桥：受审计的写动作
// 2Origin 铁律：无头 harness 缺的不是状态格式，是"统一的写授权"（Trust 层）。
// 这里实现最小南桥：白名单目录 + 写后回头观察（stat） + 审计日志。
// 写后观察是关键：status 由"世界是否真的变了"决定，不由 writeFileSync 决定。
import fs from 'node:fs';
import path from 'node:path';

// 白名单：可配置。默认只允许 demo/ 下写（防路径穿越）。
export function southbridge(root, { whitelist = ['demo'], auditFile = 'audit.log' } = {}) {
  const ALLOWED = whitelist.map(w => path.resolve(root, w));
  const auditPath = path.join(root, auditFile);

  function observe(abs) {
    try {
      const st = fs.statSync(abs);
      return { exists: true, size_bytes: st.size, mtime: st.mtime.toISOString() };
    } catch { return { exists: false, size_bytes: 0, mtime: null }; }
  }

  function logAudit(entry) {
    try {
      fs.appendFileSync(auditPath, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
    } catch { /* 审计失败不阻断写 */ }
  }

  // 动作：write / append。返回 action.result（2Origin 规范）。
  return function act({ verb, relpath, content, mode = 'write' }) {
    const actionId = 'act:' + Math.random().toString(36).slice(2, 10);
    const target = path.resolve(root, relpath || '');
    const base = { spec: '2origin/0.1', kind: 'action.result', action_id: actionId, verb, target: relpath };

    // 白名单检查（防路径穿越）
    const inAllowed = ALLOWED.some(d => target === d || target.startsWith(d + path.sep));
    if (!inAllowed) {
      logAudit({ ...base, status: 'denied', reason: 'not-in-whitelist' });
      return { ...base, status: 'denied', reason: '目标不在白名单' };
    }

    const before = observe(target);

    // 写前备份（reversible 依据）
    let backup = null;
    if (before.exists && mode === 'write') {
      try {
        fs.mkdirSync(path.join(root, '.backups'), { recursive: true });
        backup = path.join(root, '.backups', `${Date.now()}-${path.basename(relpath)}`);
        fs.copyFileSync(target, backup);
      } catch { backup = null; }
    }

    // 真正动世界
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (mode === 'append') fs.appendFileSync(target, content, 'utf8');
      else fs.writeFileSync(target, content, 'utf8');
    } catch (e) {
      logAudit({ ...base, status: 'failed', reason: e.message });
      return { ...base, status: 'failed', reason: e.message };
    }

    // 写后回头观察：status 由观察决定
    const after = observe(target);
    const expectedBytes = Buffer.byteLength(content, 'utf8');
    const ok = mode === 'append'
      ? after.size_bytes === (before.size_bytes || 0) + expectedBytes
      : after.size_bytes === expectedBytes;
    const status = after.exists && ok ? 'done' : 'failed';

    logAudit({ ...base, status, bytes: expectedBytes, backup: !!backup });
    return {
      ...base, status,
      evidence: after,
      state_diff: { before, after },
      bytes_written: expectedBytes,
      reversible: !!backup,
      backup_path: backup ? path.relative(root, backup) : null,
      undo_hint: backup ? 'restore from backup_path' : 'delete target'
    };
  };
}
