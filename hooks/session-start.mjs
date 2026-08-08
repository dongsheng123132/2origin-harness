#!/usr/bin/env node
// session-start.mjs — 开会续上：编译本境 bundle 注入新会话（RFC-0005 §3.4）
//
// 设计：跨 harness 通用，不绑 Claude Code / Codex。
//   - 如果检测到 Claude Code 的 SessionStart hook 环境（CLAUDE_PROJECT_DIR），
//     输出 additionalContext JSON（它认得）。
//   - 否则输出纯文本 bundle 到 stdout（任何 harness 都能读到）。
//
// 这是「关窗再开，任务靠学历续上」的参考实现侧。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBundle } from '../lib/bundle.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// 输出方式：
//  1. Claude Code SessionStart → hookSpecificOutput JSON
//  2. 其它 → 纯文本
function main() {
  const b = buildBundle(root);
  const text = b.text || '[本境 bundle · benjing/0.2] 无学历可加载';

  if (process.env.CLAUDE_PROJECT_DIR || process.env.CLAUDE_CODE_SESSION_ID) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text }
    }));
  } else {
    process.stdout.write(text + '\n');
  }
}

main();
