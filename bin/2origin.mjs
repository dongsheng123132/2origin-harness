#!/usr/bin/env node
// 2origin — 最小参考 harness CLI
// 跑通 2Origin 核心闭环：Observe → Think → Act → Verify → Learn
// 零依赖。用法：
//   node bin/2origin.mjs init --id demo --goal "..."     建任务状态
//   node bin/2origin.mjs ctx --goal "..."               北桥编译 Context
//   node bin/2origin.mjs write --relpath demo/x.md --content "..."  南桥写
//   node bin/2origin.mjs verify --state demo/task.origin.json  验证状态
//   node bin/2origin.mjs learn --state demo/task.origin.json --lesson "..."  沉淀经验
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createState, saveState, readState, findNewestState, addFact, addLearning, promoteLearning } from '../lib/state.js';
import { buildContext } from '../lib/northbridge.js';
import { southbridge } from '../lib/southbridge.js';
import { verify } from '../lib/verify.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const opt = (k) => {
    const i = args.findIndex(a => a === k);
    return i >= 0 ? args[i + 1] : undefined;
  };

  switch (cmd) {
    case 'init': {
      const id = opt('--id') || 'task-' + Date.now();
      const goal = opt('--goal');
      if (!goal) { console.error('需要 --goal'); process.exit(1); }
      const file = path.join(ROOT, 'demo', `${id}`, 'task.origin.json');
      const st = createState({ id, title: opt('--title'), goal });
      saveState(file, st);
      console.log(`✅ 已建状态: ${file}`);
      break;
    }
    case 'ctx': {
      const goal = opt('--goal') || '继续任务';
      const bundle = buildContext(ROOT, goal);
      console.log(JSON.stringify(bundle, null, 2));
      break;
    }
    case 'write': {
      const relpath = opt('--relpath');
      const content = opt('--content');
      const mode = opt('--mode') || 'write';
      if (!relpath || content === undefined) { console.error('需要 --relpath 和 --content'); process.exit(1); }
      const sb = southbridge(ROOT);
      const res = sb({ verb: mode === 'append' ? 'file.append' : 'file.write', relpath, content, mode });
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case 'verify': {
      const stateFile = opt('--state') || findNewestState(ROOT);
      if (!stateFile) { console.error('无状态可验证'); process.exit(1); }
      const res = verify(stateFile);
      console.log(res.verdict);
      if (res.failed.length) { res.failed.forEach(f => console.log('  ✗', f)); process.exit(1); }
      break;
    }
    case 'learn': {
      const stateFile = opt('--state') || findNewestState(ROOT);
      const lesson = opt('--lesson');
      if (!stateFile || !lesson) { console.error('需要 --state 和 --lesson'); process.exit(1); }
      const st = readState(stateFile);
      if (!st) { console.error('状态不可读'); process.exit(1); }
      if (opt('--promote')) promoteLearning(st, lesson);
      else addLearning(st, lesson, parseFloat(opt('--confidence') || '0.5'));
      saveState(stateFile, st);
      console.log(`✅ 已沉淀 learning（${opt('--promote') ? 'verified' : 'candidate'}）: ${lesson}`);
      break;
    }
    default:
      console.log(`用法见文件头。收到命令: ${cmd || '(空)'}`);
  }
}

main();
