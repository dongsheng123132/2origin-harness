#!/usr/bin/env node
// session-end.mjs — 退出归档：逐份学历 content_hash 对账（RFC-0005 §3.1/§3.4）
//
// 与 v0.1 的关键区别：**内容没变一个字节都不写、version 不涨**。
// 实测缺陷：v0.1 每次 SessionEnd 无脑 version+1，内容一字未变从 1 涨到 4，
// 版本号既判断不了状态是否变化、也不能当乐观锁。
//
// 跨 harness 通用：任何 harness 在会话结束时调用它，对账所有学历。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { findStates } from '../lib/bundle.js';
import { contentHash, readState } from '../lib/state.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// 对账一份学历：content_hash 变了才写，内容没变跳过。
function reconcile(file) {
  const state = readState(file);
  if (!state) return { file, status: 'skipped', reason: '不可读' };

  const currentHash = state.content_hash;
  const newHash = contentHash(state);

  if (currentHash === newHash) {
    return { file, status: 'unchanged', reason: '内容未变，一字节不写' };
  }

  // 内容变了：写回新 hash + version+1 + 刷 updated_at
  state.content_hash = newHash;
  state.version = (state.version || 0) + 1;
  state.updated_at = new Date().toISOString();
  try {
    fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
    return { file, status: 'written', version: state.version };
  } catch (e) {
    return { file, status: 'failed', reason: e.message };
  }
}

function main() {
  const results = findStates(root).map(x => reconcile(x.file));
  for (const r of results) {
    console.log(`[${r.status}] ${path.relative(root, r.file)}${r.version ? ` v${r.version}` : ''}${r.reason ? ` — ${r.reason}` : ''}`);
  }
}

main();
