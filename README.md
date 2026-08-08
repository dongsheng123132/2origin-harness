# 2origin-harness

**A minimal, dependency-free reference harness for the [2Origin Computer Architecture](https://github.com/dongsheng123132/2origin-computer).**

> Model-swappable. State-persistent. Audited writes. Zero dependencies.

This is a **reference implementation** of the 2Origin architecture — not a clone of any commercial harness (like U-King). It exists to prove the spec is *implementable*: anyone can clone it, point it at any model endpoint, and get a machine that resumes across sessions, survives harness/model swaps, and persists credentials.

## Why

The 2Origin spec says a computer should be *"model-swappable, state-persistent, action-portable, learning-compounding."* This repo is the smallest thing that does all of that, with **zero dependencies** (pure Node, stdlib only) so it's auditable and portable.

## Core loop

```
Observe → Think → Act → Verify → Learn
```

```
init      create a task.origin.json (the state, not a transcript)
ctx       Northbridge: compile "what's relevant right now" into context
write     Southbridge: audited write action (whitelist + post-write observation)
verify    C5: confirm artifacts exist on disk, facts have sources
learn     Learning: distill experience as candidate → verified
```

## Quick start

**5-minute walkthrough: [QUICKSTART.md](QUICKSTART.md)** — runs the full v0.2 loop with real output.

```bash
# No install — just Node >=18

# 1. Create a task state
node bin/2origin.mjs init --id my-task --goal "write a release doc" --title "Release"

# 2. Northbridge: what should be in context for this goal?
node bin/2origin.mjs ctx --goal "write a release doc"

# 3. Southbridge: audited write (whitelisted to demo/; denies outside)
node bin/2origin.mjs write --relpath demo/my-task/release.md --content "# v0.1"

# 4. Verify by observing reality, not by trusting claims
node bin/2origin.mjs verify --state demo/my-task/task.origin.json

# 5. Distill experience (candidate → verified)
node bin/2origin.mjs learn --state demo/my-task/task.origin.json --lesson "releases need a changelog" --confidence 0.8
node bin/2origin.mjs learn --state demo/my-task/task.origin.json --promote --lesson "releases need a changelog"

# 6. Compile the full benjing bundle (SessionStart load, RFC-0005 §3.4)
node bin/2origin.mjs bundle          # current task full + carryover, says what dropped
```

## Architecture (mapped to 2Origin)

| 2Origin layer | This repo |
|---|---|
| State (本境) | `lib/state.js` — task.origin read/write, **v0.2: content-hash optimistic lock + verifiable sources + actor provenance** (RFC-0005) |
| World representation (本象) | the `task.origin.json` itself — State + Facts, not transcripts |
| Northbridge (知) | `lib/northbridge.js` — compiles relevant state into context, not the whole disk |
| Southbridge (行) | `lib/southbridge.js` — whitelisted, audited write; status decided by post-write observation |
| Verify | `lib/verify.js` — artifacts exist? facts sourced **and verifiable** (recheckSource) |
| Learning (学堂) | `learn` — candidate → verified, one success is not a permanent truth |

## Session hooks (RFC-0005 §3.4)

Cross-harness, no binding to Claude Code / Codex:

```bash
# On session start: compile the benjing bundle (inject credentials)
node hooks/session-start.mjs    # outputs Claude Code additionalContext JSON if detected, else plain text

# On session end: reconcile every credential by content_hash (no change = no write)
node hooks/session-end.mjs      # [unchanged]/[written] per state file
```

`session-end` catches "dirty" writes — content changed without updating `content_hash` → it writes the new hash and bumps version.

## Benjing v0.2 (RFC-0005)

Implements the measured v0.2 mechanisms:

- **content-hash optimistic lock** — `saveState(file, state, {expect})` refuses writes when `expect` doesn't match the current hash; content unchanged → no write, version doesn't rise.
- **Verifiable sources** — `recheckSource` rejects natural-language assertions ("trust me"); a verified fact's source must cite a file path, command, or test-case ID.
- **Actor provenance** — every state records `actor {harness, model, session_id, at}`; model is `unobserved` when it can't be observed (never fabricated).
- **Learning lifecycle** — candidate → verified, never auto-promoted.

Run `npm test` (24 tests) to see all of it verified.

## Conformance status

This repo demonstrates, with real commands, the 2Origin conformance items:

- **Cross-Session**: create state → close → reopen → `ctx` reloads it (no transcript)
- **Portable actions**: `write` works via one audited action, observable result
- **Verifiable results**: `verify` checks disk reality, not exit codes
- **No auto-permanent learning**: `learn` starts as candidate, `--promote` makes it verified
- **Auditable**: every southbridge write is logged

## License

Apache-2.0. See [LICENSE](LICENSE).
