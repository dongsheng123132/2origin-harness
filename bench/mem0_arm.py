#!/usr/bin/env python
"""mem0_arm.py — ShadowWork Bench 的「真实 memory 系统」对照臂（spec 0.4）

为什么存在：spec 0.3 的三个对照臂（尾部截断 / 自制 summary / 自写词法 RAG）
全是我们自己写的。审稿人第一句就会问「你为什么不跟真的 memory 系统比」——
在那之前，「2origin 更有效」这个结论都只是跟自己的实现比出来的。
这个文件把 mem0（被引用最多的开源 memory 层）接进来，作为同预算对照。

公平性约定（每一条都是为了不打稻草人）：
  1. 同语料：吃的是 bench 渲染出来的**同一份** transcript 文本（由 Node 侧
     写到 --corpus，字节级与 rag/transcript 臂看到的一致）。
  2. 同模型：mem0 抽取/更新记忆用的 LLM = bench 问答用的同一个端点同一个模型。
  3. 同预算：search 出来的记忆拼到 ≤ --budget 字符，和别的臂一样的字节预算。
  4. 按 mem0 自己的设计喂：还原成 role 标注的多轮消息再 add()，
     不是把一坨纯文本硬塞给它——那会人为削弱对照组。
  5. 成本照实记：ingest 的 LLM 调用次数与 token 全部计入，报告里算在对照组头上。

embedder 用本地 HuggingFace 模型，不是 mem0 默认的 OpenAI embedding —— 因为
本机两个可用网关（api.deepseek.com / api.u-claw.org.cn）都没有 embeddings 接口
（实测 404 / 503）。这是一处与 mem0 默认配置的偏离，必须写进结果文档的诚实边界。

用法：
  python mem0_arm.py ingest --corpus corpus.txt --store ./cache/mem0-task6 \
      --base https://api.deepseek.com/v1 --key ... --model deepseek-v4-flash \
      --stats ./cache/mem0-task6.stats.json
  python mem0_arm.py search --store ./cache/mem0-task6 --queries q.json \
      --budget 9635 --out payloads.json --base ... --key ... --model ...

退出码：0 成功　1 用法/环境错　2 ingest 或 search 失败
"""
import argparse
import json
import os
import re
import sys
import time

UID = "shadowwork-bench"

# ─────────────────── 调用计数（照实记账，别让对照组的成本消失）───────────────────
STATS = {"llm_calls": 0, "prompt_tokens": 0, "completion_tokens": 0, "llm_errors": 0}
LAST = {"finish_reason": None, "content": ""}      # 最后一次 LLM 原始回复


def install_counter():
    """在 openai SDK 层面计数：mem0 内部无论怎么调，都跑不掉这一层。"""
    from openai.resources.chat import completions as _c

    orig = _c.Completions.create

    def counted(self, *a, **kw):
        STATS["llm_calls"] += 1
        try:
            r = orig(self, *a, **kw)
        except Exception:
            STATS["llm_errors"] += 1
            raise
        u = getattr(r, "usage", None)
        if u is not None:
            STATS["prompt_tokens"] += getattr(u, "prompt_tokens", 0) or 0
            STATS["completion_tokens"] += getattr(u, "completion_tokens", 0) or 0
        try:                                    # 留一份原始回复，供"这批 0 条"时定责
            ch0 = r.choices[0]
            LAST["finish_reason"] = ch0.finish_reason
            LAST["content"] = ch0.message.content or ""
        except Exception:
            pass
        return r

    _c.Completions.create = counted


# ─────────────────────────────── mem0 配置 ───────────────────────────────
# mem0 2.0.17 的抽取走 ADDITIVE_EXTRACTION_PROMPT，且 generate_additive_extraction_prompt
# 里 use_input_language 被**硬编码成 False**（memory/main.py:938 不传该参数），于是中文
# 语料会被翻成英文存。实测：「影核 v0.2 有 43 条判据」被存成 "User's 影核 (Yinghe) v0.2
# has a total of 43 criteria"。题目是中文原句判别，翻译会平白给对照组添一层损耗——
# 那就又是一个我亲手削弱的稻草人。用 mem0 自己支持的 custom_instructions 字段纠正：
# 这是任何一个中文语料用户都会做的部署配置，不是给它开小灶。
KEEP_LANG = (
    "CRITICAL — language and fidelity requirements for every extracted memory:\n"
    "1. Record each fact in the SAME language and script as the source message. "
    "Chinese input MUST stay in Chinese. Do NOT translate or transliterate into English.\n"
    "2. Preserve identifiers verbatim: file paths, commands, hashes, version numbers, "
    "exit codes, percentages and counts must be copied exactly as written.\n"
    "3. Preserve whether a claim was stated as verified/confirmed versus merely proposed."
)


def build_memory(args, dims):
    from mem0 import Memory

    cfg = {
        "custom_instructions": None if args.default_prompt else KEEP_LANG,
        "llm": {
            "provider": "openai",
            "config": {
                "model": args.model,
                "openai_base_url": args.base,
                "api_key": args.key,
                "temperature": 0,
                "max_tokens": args.max_tokens,
            },
        },
        "embedder": {
            "provider": "huggingface",
            "config": {"model": args.embed_model, "embedding_dims": dims},
        },
        "vector_store": {
            "provider": "qdrant",
            "config": {
                "collection_name": "swb",
                "path": os.path.join(args.store, "qdrant"),
                "embedding_model_dims": dims,
                "on_disk": True,
            },
        },
        "history_db_path": os.path.join(args.store, "history.db"),
    }
    os.makedirs(args.store, exist_ok=True)
    return Memory.from_config(cfg)


# mem0 的 get_all(top_k=...) 默认只给 20 条 —— 那是一页，不是总数。
# 直接拿它当"记忆库有多少条"会把 380 条报成 20 条：自报数字与磁盘真相脱节，
# 正是本仓库反复犯的那个病。所以计数必须显式要一个大到不可能被截断的 top_k，
# 并在逼近上限时喊出来，而不是默默返回一个页大小。
COUNT_CAP = 100000


def store_count(mem):
    n = len(mem.get_all(filters={"user_id": UID}, top_k=COUNT_CAP).get("results", []))
    if n >= COUNT_CAP:
        print(f"⚠ 记忆条数达到查询上限 {COUNT_CAP}，这个数字是被截断的", file=sys.stderr)
    return n


def embed_dims(model_name):
    from sentence_transformers import SentenceTransformer

    return SentenceTransformer(model_name).get_sentence_embedding_dimension()


# ───────────────── 把渲染文本还原成 role 标注的多轮消息 ─────────────────
# bench 的 renderTranscript 出来的每行形如：
#   user: ...
#   assistant: ...
#   assistant[tool:Read]: {...}
#   tool_result: ...
# mem0 是给对话设计的，喂它一坨纯文本等于人为削弱对照组，所以还原角色。
LINE = re.compile(r"^(user|assistant|tool_result)(\[tool:[^\]]*\])?:\s?(.*)$", re.S)


def to_messages(text):
    msgs = []
    for line in text.split("\n"):
        m = LINE.match(line)
        if m:
            role = "user" if m.group(1) == "user" else "assistant"
            content = (m.group(2) or "") + m.group(3)
            msgs.append({"role": role, "content": content})
        elif msgs:
            msgs[-1]["content"] += "\n" + line          # 续行归到上一条
    return [m for m in msgs if m["content"].strip()]


def batches(msgs, max_chars):
    """按字符预算切成一批批对话再 add()。mem0 单次 add 的输入不能太长，
    否则事实抽取那一步会被自己的 max_tokens 截断——那也是一种静默削弱对照组。"""
    cur, n = [], 0
    for m in msgs:
        c = len(m["content"])
        if cur and n + c > max_chars:
            yield cur
            cur, n = [], 0
        # 单条超长的就地截断（照实记，不静默丢）
        if c > max_chars:
            m = {"role": m["role"], "content": m["content"][:max_chars]}
            c = max_chars
        cur.append(m)
        n += c
    if cur:
        yield cur


# ─────────────────────────────── ingest ───────────────────────────────
def cmd_ingest(args):
    text = open(args.corpus, encoding="utf-8").read()
    msgs = to_messages(text)
    chunks = list(batches(msgs, args.chunk))
    print(f"语料 {len(text)} 字符 → {len(msgs)} 条消息 → {len(chunks)} 批", flush=True)

    dims = embed_dims(args.embed_model)
    print(f"embedder {args.embed_model} dims={dims}", flush=True)
    install_counter()
    mem = build_memory(args, dims)

    t0 = time.time()
    added = 0
    failed = []
    empty = []
    retried = 0
    for i, ch in enumerate(chunks, 1):
        chars = sum(len(m["content"]) for m in ch)
        got, err = 0, None
        # 一批返回 0 条 = 这 6000 字语料从对照组的记忆里凭空消失了。可能是模型
        # 那次回了不合法 JSON（mem0 内部吞掉），也可能是这批真没事实。不重试就是
        # 让对照组白白少一块语料；重试而不记账，就是偷偷给对照组开小灶。两样都要。
        for attempt in (1, 2):
            try:
                r = mem.add(ch, user_id=UID)
                got = len((r or {}).get("results", []) or [])
            except Exception as e:
                err = str(e)[:300]
                got = 0
            if got or attempt == 2:
                break
            print(f"  [{i}/{len(chunks)}] 0 条，原始回复 finish_reason={LAST['finish_reason']} "
                  f"len={len(LAST['content'])}：{LAST['content'][:160]!r} → 重试", flush=True)
            retried += 1
        added += got
        if err:
            failed.append({"batch": i, "error": err})
            print(f"  [{i}/{len(chunks)}] ✗ {err[:160]}", flush=True)
        else:
            if got == 0:
                empty.append({"batch": i, "chars": chars,
                              "finish_reason": LAST["finish_reason"],
                              "reply_head": LAST["content"][:200]})
            print(f"  [{i}/{len(chunks)}] {chars}字符 → +{got} 条记忆　"
                  f"累计 {added}　{time.time()-t0:.0f}s", flush=True)

    total = store_count(mem)
    stats = {
        "corpus_chars": len(text), "messages": len(msgs), "batches": len(chunks),
        "chunk_chars": args.chunk, "memories_returned": added, "memories_in_store": total,
        "failed_batches": failed, "empty_batches": empty, "retried_batches": retried,
        "keep_source_language": not args.default_prompt,
        "seconds": round(time.time() - t0, 1),
        "embed_model": args.embed_model, "embed_dims": dims,
        "llm_model": args.model, "llm_base": args.base,
        "mem0_version": __import__("importlib.metadata", fromlist=["x"]).version("mem0ai"),
        **STATS,
    }
    if args.stats:
        json.dump(stats, open(args.stats, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(json.dumps({k: v for k, v in stats.items() if k != "failed_batches"},
                     ensure_ascii=False), flush=True)
    # 一条记忆都没建起来 = 对照组是空的，绝不能静默通过（这正是 summary 臂翻过的车）
    if total == 0:
        print("✗ 记忆库为空，mem0 臂无效", file=sys.stderr)
        return 2
    return 0


# ─────────────────────────────── search ───────────────────────────────
def cmd_search(args):
    queries = json.load(open(args.queries, encoding="utf-8"))
    dims = embed_dims(args.embed_model)
    install_counter()
    mem = build_memory(args, dims)

    total = store_count(mem)
    if total == 0:
        print("✗ 记忆库为空（先跑 ingest）", file=sys.stderr)
        return 2
    print(f"记忆库 {total} 条，检索 {len(queries)} 道题，预算 {args.budget} 字符", flush=True)

    out = []
    for q in queries:
        try:
            r = mem.search(q["q"], top_k=args.top_k, filters={"user_id": UID},
                           threshold=args.threshold)
            hits = (r or {}).get("results", []) or []
        except Exception as e:
            out.append({"i": q["i"], "payload": "", "n": 0, "error": str(e)[:300]})
            continue
        # 按相关度依次装到预算满为止——和 rag 臂同样的装载规则。
        # 预算按**最终字符串的真实长度**算，不是按记忆正文长度：漏掉 "- " 前缀
        # 和换行，mem0 就会拿到比别的臂多几十字符的预算。占便宜的对照也是坏对照。
        payload, n = "", 0
        for h in hits:
            s = str(h.get("memory", "")).strip()
            if not s:
                continue
            cand = f"{payload}\n- {s}" if payload else f"- {s}"
            if len(cand) > args.budget:
                continue
            payload, n = cand, n + 1
        out.append({"i": q["i"], "payload": payload,
                    "n": n, "hits": len(hits), "error": None})

    json.dump({"memories_in_store": total, "top_k": args.top_k,
               "threshold": args.threshold, "budget": args.budget,
               "search_llm_calls": STATS["llm_calls"], "results": out},
              open(args.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    avg = sum(len(o["payload"]) for o in out) / max(len(out), 1)
    print(f"写入 {args.out}　平均 payload {avg:.0f} 字符　"
          f"平均命中 {sum(o['n'] for o in out)/max(len(out),1):.1f} 条", flush=True)
    return 0


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("ingest", "search"):
        p = sub.add_parser(name)
        p.add_argument("--store", required=True)
        # 端点默认从环境变量取：密钥放命令行会进 shell 历史和进程表。
        p.add_argument("--base", default=os.environ.get("MEM0_BASE", ""))
        p.add_argument("--key", default=os.environ.get("MEM0_KEY", ""))
        p.add_argument("--model", default=os.environ.get("MEM0_MODEL", ""))
        p.add_argument("--embed-model", default="sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2")
        # 24000 不是拍脑袋：deepseek-v4-flash 是推理模型，token 先花在 reasoning 上，
        # cap=4000 时抽取结果被 finish_reason=length 截断 → mem0 内部 JSON 解析失败 →
        # 静默返回 0 条记忆，整批语料从对照组的记忆里消失。这跟 summary 臂当初翻的
        # 是同一个车（见 shadowwork-bench-live.mjs 里 buildSummaryPayload 的注释）。
        p.add_argument("--max-tokens", type=int, default=24000)
        # 留一个开关跑 mem0 的原始默认（会把中文翻成英文），用来证明
        # 「保留原语言」这条配置到底帮了对照组多少 —— 不留开关就没法自证没作弊。
        p.add_argument("--default-prompt", action="store_true")
        if name == "ingest":
            p.add_argument("--corpus", required=True)
            p.add_argument("--chunk", type=int, default=6000)
            p.add_argument("--stats", default="")
        else:
            p.add_argument("--queries", required=True)
            p.add_argument("--out", required=True)
            p.add_argument("--budget", type=int, required=True)
            p.add_argument("--top-k", type=int, default=30)
            p.add_argument("--threshold", type=float, default=0.0)
    args = ap.parse_args()
    missing = [k for k in ("base", "key", "model") if not getattr(args, k)]
    if missing:
        print(f"✗ 缺端点参数：{missing}（用 --{missing[0]} 或环境变量 MEM0_{missing[0].upper()}）",
              file=sys.stderr)
        return 1
    return cmd_ingest(args) if args.cmd == "ingest" else cmd_search(args)


if __name__ == "__main__":
    sys.exit(main())
