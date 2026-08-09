# 2origin-harness

**A minimal, dependency-free reference harness for the [2Origin Computer Architecture](https://github.com/dongsheng123132/2origin-computer).**

> Model-swappable. State-persistent. Audited writes. Zero dependencies.

This is a **reference implementation** of the 2Origin architecture — not a clone of any commercial harness (like U-King). It exists to prove the spec is *implementable*: anyone can clone it, point it at any model endpoint, and get a machine that resumes across sessions, survives harness/model swaps, and persists task state.

> **Terminology.** `task state` (`task.origin.json`) is the durable record of one task — state, verified facts, decisions, next steps. It is deliberately *not* called a "credential": in this repo `credential` means one thing only, the `trust.credential` / `proof_of_read` authorization token in the Trust Lane below.

## Why

The 2Origin spec says a computer should be *"model-swappable, state-persistent, action-portable, learning-compounding."* This repo is the smallest thing that does all of that, with **zero dependencies** (pure Node, stdlib only) so it's auditable and portable.

## Benchmark: does structured state actually beat a transcript?

`bench/shadowwork-bench-live.mjs` — same model, same endpoint, same prompt. The **only** variable is what the context window is preloaded with. The corpus is real: 9 real task states (131 verified facts) on one side, 5.5 MB of the real session transcripts that actually did the work on the other. Ground truth is read from disk fields; distractors are drawn from *other real tasks*, never invented.

`deepseek-v4-flash`, temperature 0, 2026-08-09. 474 calls, 0 errors, 0 truncations. Full write-up with Wilson 95% intervals: **[`bench/RESULTS-v3.md`](bench/RESULTS-v3.md)**

| arm | input tokens | multiple choice<br>n=15, chance 25% | fact true/false<br>n=40, chance 50% | two-hop<br>n=23, chance 50% | asks back? |
|---|---|---|---|---|---|
| **2origin** (state bundle) | **5,191** | **100.0%** | **97.5%** | 64.3% | no |
| summary (simulated `/compact`) | 5,611 | 60.0% | 45.0% | 58.0% | no |
| rag (lexical retrieval over transcript) | 4,586 | 46.7% | 60.0% | 71.4% | no |
| transcript (tail-truncated, equal budget) | 4,083 | 46.7% | 47.5% | 62.1% | no |
| transcript-10x (7.8× the budget) | 40,397 | 53.3% | 35.0% | 61.2% | no |
| none (empty context — the floor) | 231 | 33.3% | 47.5% | 63.8% | **yes** |

**What this shows**

- **Factual recall: state 97.5% [87.1, 99.6] vs the strongest control (rag) 60.0% [44.6, 73.7] — Wilson 95% intervals do not overlap.** At 1/8 the tokens of the 10× transcript arm.
- **Summarization loses the half you need.** The `/compact`-style summary arm scores 45.0% on fact attribution — below chance, and below feeding the model *nothing at all* (47.5%). It keeps "what we were doing" and drops "which conclusion was already verified".
- **More transcript is worse, not merely wasteful.** 7.8× the input tokens scores 35.0% [22.1, 50.5] — significantly *below* chance. The model reliably surfaces stale, retracted, or other-task assertions from the pile. That is worse than missing information, because it comes with confidence.
- **Only the empty-context arm asks a clarifying question.** All five context-fed arms answer straight away. Missing information does not surface as uncertainty; it surfaces as confident wrong answers about whatever was most recently being worked on.

**What this does NOT show** — stated here because a benchmark that hides its own limits is a defect, not a result:

- **Nothing about reasoning — the two-hop probe failed and is retracted.** It was added to break the open-book ceiling. All six arms land within 58.0–71.4%, intervals overlapping, and the empty-context floor (63.8%) is 0.5pp from the state arm (64.3%). Diagnosis: the question is answerable by topical similarity — facts and next-steps of the same task share vocabulary — so it measures topic overlap, not state attribution. It stays in the table for transparency and supports no conclusion. The open-book ceiling remains unsolved.
- **The 100% is open-book.** The facts are written verbatim in the bundle. This measures *whether state survives delivery intact*, not whether the model is smart. The information is in the controls' low scores, not the state arm's high one.
- **Single model, single target task, single run.** At near-identical payload the transcript arm moved 13.3 points between two runs (60.0% → 46.7%). Small differences are unreadable without resampling and confidence intervals.
- **The controls are ours.** Tail-truncation, a self-made summary and a hand-written lexical RAG are not mem0 / Letta / LangMem / Zep. "Beats a transcript" is the claim; "beats memory systems" is not.
- **The corpus is this project's own task states.** External validity is untested.

**Four bugs we caught in our own scorer this round.** Nobody writes a scorer for the scorer, so we publish ours:

1. **Leakage — the floor arm scored 3/3.** Not position bias: *length*. The target task had the longest fields, so "pick the longest option" won. Fixed by length-matching distractors and rotating the correct position; the floor fell to 0%. An automatic check now declares any metric unusable if the empty-context arm beats chance by more than 25pp.
2. **We throttled our own control group.** The summary arm was told "at most N characters" and wrote 2,735 of its 9,635 budget. Given a lower bound too, it filled the budget and jumped 26.7% → 60.0%. We nearly declared victory over a control we had gagged.
3. **An empty summary got cached.** One merge call returned empty content; the empty string was written to cache, so every later run silently used a blank control while the report still said "summary arm". Now short outputs throw, and bad caches are rejected and deleted.
4. **One `ECONNRESET` killed a 474-call experiment.** Now: exponential backoff on transport errors and 5xx/429; 4xx throws immediately, because retrying an auth error only hides it.

Plus one inherited from v0.2: the scorer counted its own `max_tokens` truncation as a wrong answer. Truncated calls are now re-run at 3× cap and the repair count is printed — **repairing without saying so is the same disease as truncating without saying so.**

```bash
node bench/shadowwork-bench-live.mjs --dry-run   # free, offline: shows the payloads and questions
node bench/shadowwork-bench-live.mjs             # needs a model endpoint; one full run is ~4.7M input tokens
```

`bench/corpus.json` pins each transcript by byte count, so a re-run on the same machine is byte-identical. Neither the transcripts nor `corpus.json` itself are committed — the transcripts contain private working content, and `corpus.json` holds local absolute paths. Copy [`bench/corpus.example.json`](bench/corpus.example.json) and point it at your own sessions. The `summary` arm's cache (`bench/cache/`) is likewise ignored: it is distilled *from* those transcripts, so it inherits their sensitivity. This makes the transcript / summary / rag arms unreproducible off this machine — a deliberate trade, not an oversight, and now enforced by `.gitignore` rather than merely stated in prose.

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
| Observer (本象) | **not implemented here.** World-observation (`existsSync` / `statSync` / `createHash`) is scattered across all six `lib/*.js` files, each looking at the world its own way. The ShadowOS reference factored this into a single observer that *never receives an expectation* — an observer that accepts "what you think it should be" degrades into a confirmation-bias machine. Having no single observer is the structural cause of self-attestation defects, not a cosmetic gap |
| Context compiler (北桥, 知) | `lib/northbridge.js` — compiles relevant state into context, not the whole disk |
| Action kernel + channel (影核 / 南桥, 行) | `lib/southbridge.js` — whitelisted, audited write; **risk-tiered (low/medium/high) + approval (auto / expect_sha256 optimistic lock / human confirm)**; status decided by post-write observation. The *kernel* decides and acts; a *channel* (CLI, MCP) only carries the request to it, and channel parity is verified rather than assumed |
| Verify | `lib/verify.js` — artifacts exist? facts sourced **and verifiable** (recheckSource) |
| Learning (学堂) | `learn` — candidate → verified, one success is not a permanent truth |

## Bugscope (philosophy → executable)

The "bug 透视镜" as a runnable checker: examines claims for shadow/object confusion.

```bash
# Audit a claim with/without evidence
node bin/2origin.mjs bugscope --claim "标记存在=>崩溃"                 # → ⚠️ A1 hit
node bin/2origin.mjs bugscope --claim "文件已写" --evidence "stat+sha256"  # → ✅ clean
# Audit a whole state file's facts
node bin/2origin.mjs bugscope --state demo/.../task.origin.json
```

Five axioms (see `philosophy/bugscope.md` in 2origin-computer): A1 existence≠verification, A2 self-proof invalid, A3 judge/decider separation, A4 absence doesn't speak (promises fail silently), A5 verification decays (world changes, verified doesn't revert). Also `bugscope({ promises })` and `bugscope({ worldChanged })`.

## Trust Lane (RFC-0001 §3)

Southbridge accepts standard `trust.credential` (`proof_of_read`) for medium/high risk writes:

```js
act({
  verb: 'file.write', relpath: 'demo/out.md', content: 'new',
  credentials: [{ kind: 'trust.credential', type: 'proof_of_read', target: 'demo/out.md', value: sha256ofCurrent }],
  via: 'cli'   // channel marker (RFC-0001 §3.3)
})
// → status: 'done', approval: 'proof_of_read', via: 'cli'
```

The credential proves *you read the current content* — not "someone approved you". A headless agent can produce it itself; a stale hash is auto-rejected.

## Session hooks (RFC-0005 §3.4)

Cross-harness, no binding to Claude Code / Codex:

```bash
# On session start: compile the benjing bundle (inject task state)
node hooks/session-start.mjs    # outputs Claude Code additionalContext JSON if detected, else plain text

# On session end: reconcile every task state by content_hash (no change = no write)
node hooks/session-end.mjs      # [unchanged]/[written] per state file
```

`session-end` catches "dirty" writes — content changed without updating `content_hash` → it writes the new hash and bumps version.

## Benjing v0.2 (RFC-0005)

Implements the measured v0.2 mechanisms:

- **content-hash optimistic lock** — `saveState(file, state, {expect})` refuses writes when `expect` doesn't match the current hash; content unchanged → no write, version doesn't rise.
- **Verifiable sources** — `recheckSource` rejects natural-language assertions ("trust me"); a verified fact's source must cite a file path, command, or test-case ID.
- **Actor provenance** — every state records `actor {harness, model, session_id, at}`; model is `unobserved` when it can't be observed (never fabricated).
- **Learning lifecycle** — candidate → verified, gated: confidence ≥ 0.7 AND verifiable evidence, never auto-promoted. Deprecated is marked, not hard-deleted.
- **Auto-forgetting (bugscope A5)** — `autoDeprecate` downgrades verified facts/learnings past their freshness window; `refreshFact` renews one when re-validated. Correct forgetting is what makes long-term accumulation trustworthy.

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
