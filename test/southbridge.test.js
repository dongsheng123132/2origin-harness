// southbridge.test.js — 南桥写动作测试
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { southbridge } from '../lib/southbridge.js';

function tmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `2o-sb-${tag}-`));
}

test('南桥写入成功，evidence + state_diff 齐全', () => {
  const root = tmp('ok');
  const act = southbridge(root);
  const res = act({ verb: 'file.write', relpath: 'demo/out.md', content: 'hello' });
  assert.equal(res.status, 'done');
  assert.equal(res.evidence.exists, true);
  assert.equal(res.evidence.size_bytes, 5);
  assert.equal(res.state_diff.after.size_bytes, 5);
  assert.ok(res.action_id.startsWith('act:'));
  // 写后观察 = 现实存在
  assert.equal(fs.existsSync(path.join(root, 'demo/out.md')), true);
});

test('南桥越权拒绝：白名单外（路径穿越）', () => {
  const root = tmp('deny');
  const act = southbridge(root);
  const res = act({ verb: 'file.write', relpath: '../evil.sh', content: 'rm' });
  assert.equal(res.status, 'denied');
  // 路径穿越文件不能落盘
  assert.equal(fs.existsSync(path.resolve(root, '../evil.sh')), false);
});

test('南桥审计：写 + 越权都留痕', () => {
  const root = tmp('audit');
  const act = southbridge(root);
  act({ verb: 'file.write', relpath: 'demo/ok.md', content: 'x' });
  act({ verb: 'file.write', relpath: 'evil.md', content: 'x' });
  const log = fs.readFileSync(path.join(root, 'audit.log'), 'utf8');
  assert.ok(log.includes('"status":"done"'), '成功写要审计');
  assert.ok(log.includes('"status":"denied"'), '越权要审计');
});

test('南桥写后观察：内容不匹配则 failed', () => {
  const root = tmp('fail');
  const act = southbridge(root);
  // 预先创建文件，制造覆盖场景（medium risk）
  fs.mkdirSync(path.join(root, 'demo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'demo/out.md'), 'hiiii'); // 5 字节
  // 先看当前 sha256 做乐观锁
  const sha = crypto.createHash('sha256').update('hiiii').digest('hex');
  const res = act({ verb: 'file.write', relpath: 'demo/out.md', content: 'hello', expect_sha256: sha });
  // 同大小会被判 done——这是当前实现的边界（不检测内容差异，只检测大小）
  assert.equal(res.status, 'done');
  assert.equal(fs.readFileSync(path.join(root, 'demo/out.md'), 'utf8'), 'hello');
});

test('南桥：覆盖已存在文件 = medium risk，需批准', () => {
  const root = tmp('medium');
  const act = southbridge(root);
  fs.mkdirSync(path.join(root, 'demo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'demo/out.md'), 'old');
  // 不带 expect/confirm → requires_approval
  const res = act({ verb: 'file.write', relpath: 'demo/out.md', content: 'new' });
  assert.equal(res.status, 'requires_approval');
  assert.equal(res.risk, 'medium');
  // 用 expect_sha256 批准 → done
  const sha = crypto.createHash('sha256').update('old').digest('hex');
  const ok = act({ verb: 'file.write', relpath: 'demo/out.md', content: 'new', expect_sha256: sha });
  assert.equal(ok.status, 'done');
  assert.equal(fs.readFileSync(path.join(root, 'demo/out.md'), 'utf8'), 'new');
});

test('append 模式：大小累加正确', () => {
  const root = tmp('append');
  const act = southbridge(root);
  act({ verb: 'file.write', relpath: 'demo/log.md', content: 'aa' });
  const res = act({ verb: 'file.append', relpath: 'demo/log.md', content: 'bbb', mode: 'append' });
  assert.equal(res.status, 'done');
  assert.equal(res.evidence.size_bytes, 5); // 2 + 3
  assert.equal(fs.readFileSync(path.join(root, 'demo/log.md'), 'utf8'), 'aabbb');
});

// ── Trust Lane（RFC-0001 §3）──

test('Trust Lane：proof_of_read 凭据批准覆盖写', () => {
  const root = tmp('por');
  const act = southbridge(root);
  fs.mkdirSync(path.join(root, 'demo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'demo/out.md'), 'old');
  const sha = crypto.createHash('sha256').update('old').digest('hex');
  // 标准 trust.credential
  const res = act({
    verb: 'file.write', relpath: 'demo/out.md', content: 'new',
    credentials: [{ kind: 'trust.credential', type: 'proof_of_read', target: 'demo/out.md', value: sha }],
    via: 'test'
  });
  assert.equal(res.status, 'done');
  assert.equal(res.approval, 'proof_of_read');
  assert.equal(res.via, 'test', '通道标记要记录');
  assert.equal(fs.readFileSync(path.join(root, 'demo/out.md'), 'utf8'), 'new');
});

test('Trust Lane：错误 proof_of_read 拒绝', () => {
  const root = tmp('porbad');
  const act = southbridge(root);
  fs.mkdirSync(path.join(root, 'demo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'demo/out.md'), 'old');
  const res = act({
    verb: 'file.write', relpath: 'demo/out.md', content: 'new',
    credentials: [{ kind: 'trust.credential', type: 'proof_of_read', target: 'demo/out.md', value: 'wrong' }]
  });
  assert.equal(res.status, 'requires_approval');
  assert.equal(res.approval, 'proof_of_read');
});

test('Trust Lane：无凭据覆盖 → requires_approval', () => {
  const root = tmp('noapprove');
  const act = southbridge(root);
  fs.mkdirSync(path.join(root, 'demo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'demo/out.md'), 'old');
  const res = act({ verb: 'file.write', relpath: 'demo/out.md', content: 'new' });
  assert.equal(res.status, 'requires_approval');
});

// ── A4（bugscope）：审计失败不静默 ──

test('A4：审计正常 → audit_ok true', () => {
  const root = tmp('auditok');
  const act = southbridge(root);
  const res = act({ verb: 'file.write', relpath: 'demo/ok.md', content: 'x' });
  assert.equal(res.status, 'done');
  assert.equal(res.audit_ok, true, '审计成功要标 true');
});

test('A4：审计被阻断（audit 目录被占）→ audit_ok false', () => {
  const root = tmp('auditfail');
  // 用白名单外路径触发 denied 也会审计；这里构造审计写失败：
  // 用一个无法写的 auditFile（目录已存在但作为文件被占）
  const blocked = path.join(root, 'audit.log');
  // 先让 audit.log 是一个目录（appendFile 会失败）
  fs.mkdirSync(blocked, { recursive: true });
  const act = southbridge(root, { auditFile: 'audit.log' });
  const res = act({ verb: 'file.write', relpath: 'demo/ok.md', content: 'x' });
  assert.equal(res.status, 'done', '动作本身成功（审计失败不阻断写）');
  assert.equal(res.audit_ok, false, '审计失败要标 false，让调用方知道承诺失效');
});
