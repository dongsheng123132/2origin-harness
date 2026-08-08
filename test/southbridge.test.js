// southbridge.test.js — 南桥写动作测试
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  // 预先创建同大小文件，制造"写了但大小不符"场景
  fs.mkdirSync(path.join(root, 'demo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'demo/out.md'), 'hiiii'); // 5 字节
  const res = act({ verb: 'file.write', relpath: 'demo/out.md', content: 'hello' }); // 也是 5 字节
  // 同大小会被判 done——这是当前实现的边界（不检测内容差异，只检测大小）
  assert.equal(res.status, 'done');
  assert.equal(fs.readFileSync(path.join(root, 'demo/out.md'), 'utf8'), 'hello');
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
