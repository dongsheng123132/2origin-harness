# 2origin-harness · Quickstart

> Get a 2Origin v0.2 machine running in 5 minutes. Zero dependencies — just Node ≥18.

```bash
git clone https://github.com/dongsheng123132/2origin-harness
cd 2origin-harness
node --version   # needs >=18
```

## 1. Create a task state

```bash
node bin/2origin.mjs init --id demo-quick --goal "write a launch doc" --title "Launch"
# ✅ 已建状态: .../demo/demo-quick/task.origin.json (version 2, hash 3fb305aa…)
```

Every task lives in one `task.origin.json` — the **state**, not a transcript.

## 2. Record a verified fact (source must be verifiable)

```bash
node -e "
import('./lib/state.js').then(async ({readState, addFact, saveState}) => {
  const f = 'demo/demo-quick/task.origin.json';
  const s = readState(f);
  addFact(s, 'target release date is Friday', 'docs/launch-plan.md');  // file path = verifiable
  saveState(f, s);
});
"
```

A verified fact's `source` must cite a **file path, command, or test-case ID** — "trust me" is rejected (RFC-0005 §3.2). Try `addFact(s, 'x', 'just trust me')` and watch it throw.

## 3. Write an artifact through the Southbridge (audited)

```bash
node bin/2origin.mjs write --relpath demo/demo-quick/launch.md --content "# Launch v0.1"
# { status: "done", evidence: { exists: true, size_bytes: 14 }, undo_hint: "delete target" }
```

Writes are whitelisted to `demo/` (path-traversal denied), and status is decided by **post-write observation**, not by the write call. Every write is logged to `audit.log`.

## 4. Compile the full benjing bundle (SessionStart load)

```bash
node bin/2origin.mjs bundle
# [本境 bundle · benjing/0.2]
# 装载 1/1 份学历 · 已验证事实 1/1 条
# ✔ 无丢弃
# ── 当前任务 · demo/demo-quick/task.origin.json ──
```

This is what a SessionStart hook injects: current task full + carryover from other tasks, budget-constrained, **and it says what it dropped** (no silent loss).

## 5. Verify by observing reality, not trusting claims

```bash
node bin/2origin.mjs verify --state demo/demo-quick/task.origin.json
# ✅ VERIFIED (通过现实观察确认)
```

`verify` checks: artifacts exist on disk? verified facts have verifiable sources? If a claimed artifact is missing, it fails — it caught a real ghost-artifact bug on day one.

## 6. Distill experience (candidate → verified)

```bash
node bin/2origin.mjs learn --state demo/demo-quick/task.origin.json --lesson "launch docs need a changelog" --confidence 0.8
node bin/2origin.mjs learn --state demo/demo-quick/task.origin.json --promote --lesson "launch docs need a changelog"
```

New lessons start as `candidate`; only explicit promotion makes them `verified`. One success is never a permanent truth.

## 7. Optimistic lock: two writers can't clobber each other

```bash
node bin/2origin.mjs learn --state demo/demo-quick/task.origin.json \
  --lesson "read before you write" --expect <wrong-hash>
# ❌ expect_sha256 不匹配：当前 a77ce3b3… ≠ wrong-hash
```

`saveState` with `{expect}` refuses to write when your hash is stale — a second writer's fact can't be silently eaten.

## What just happened

| Step | 2Origin layer |
|---|---|
| init | State (本境) — create the object, not a transcript |
| addFact | World representation (本象) — State + verified Facts |
| write | Southbridge (行) — audited, observed write |
| bundle | Benjing compilation (RFC-0005 §3.4) |
| verify | C5 — reality over claims |
| learn | Academy (学堂) — candidate → verified |
| --expect | content-hash optimistic lock (RFC-0005 §3.1) |

**That's a 2Origin v0.2 machine.** Model-swappable, state-persistent, audited writes, compounding learning. All in ~7 commands, zero dependencies.

## Run the full test suite

```bash
npm test    # 28 tests, all passing
```
