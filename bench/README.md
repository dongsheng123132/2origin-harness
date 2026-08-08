# ShadowWork Bench

> **先读这段**：本目录有两代东西，身份不同，别混用。
>
> | 文件 | 是什么 | 能证明什么 |
> |---|---|---|
> | **`shadowwork-bench-live.mjs`** | **真 benchmark**：真实语料 + 真实模型 + 真值取自磁盘 | 「状态优于对话流」——见 **[RESULTS-v2.md](./RESULTS-v2.md)** |
> | `shadowwork-bench.mjs`（v0.1） | **机制单元测试**：验 `buildBundle` 不丢事实 | 只证机制通，**不**证"更有效" |
> | `compare-bench.mjs`（v0.1） | 同上，且**对照组由脚本自己生成** | ⚠️ 其"传统不可续作"结论恒真，不构成证据 |
>
> v0.1 的对照组 transcript 由 `genTranscript` 自己生成、且从没把 `goal` / `next_steps[0]`
> 原文写进去，于是 `tradCanResume` 恒为 `false`，而 `success` 的条件正是 `!tradCanResume`
> ——「传统 harness 续不了」是**构造出来的**，不是观察到的。那是本仓库哲学透镜第一条
> **「声明冒充事实」在 benchmark 层的复发**。真正的对照实验在 v0.2，请以那份为准。
>
> v0.1 保留为机制单元测试（它在这个身份上合格），继续挂在 conformance C8/C9。

---

## v0.1 · 学历跨会话保留率（机制单元测试）

> 测 2Origin 的核心主张：**多年不遗忘**。
> 传统 harness 的保留率是 **0%**（每个会话都是新的第一天）；
> 2Origin 通过本境跨会话积累，保留率接近 **100%**。
>
> ⚠️ 注意："传统 harness = 0%" 在本脚本里是**写死的常数，从未测量**。
> 真实测量见 v0.2——真实对话流在同预算下不是 0%，而是"贴着瞎猜线且自信答错"。

### 为什么这个指标存在

现有 AI 榜单（SWE-bench、GAIA、LiveBench）全测"单任务得分"——模型单次多聪明。
**没有人测"时间维度"**，因为传统 harness 活不过会话，没人想到要测。

ShadowWork Bench 填补这个空位：**同一台机器，用很多年后，还记得多少？**

### 指标

```
retention_rate = 新会话自动装载的事实数 / 学历事实总数
```

- **2Origin**：SessionStart 用本境 bundle 编译 → 学历跨会话保留（预期 ≈ 100%）
- **传统 harness**：无本境，每会话从零 → **0%**

### 跑法

```bash
node bench/shadowwork-bench.mjs              # 默认 50 facts, 30 sessions
node bench/shadowwork-bench.mjs --facts 100 --sessions 50 --budget 500000
```

### 实测结果（2026-08-08）

```
学历: 50 条已验证事实 + 5 条经验
模拟会话: 30 次关闭/重开
新会话自动装载: 50/50 条事实
── 保留率: 100.0% ──
对照（传统 harness，无本境）: 0%
```

### 诚实边界

- 这测的是**机制能力**（本境能保留），不是**语义质量**（保留的内容对不对——那个由晋升门槛 + 自动遗忘管）。
- 数值是"模拟会话"（buildBundle 反复跑），不是真实日历时间。真实"用几年"需要长期运行，但机制是同一套。

---

## v0.2 · 状态 vs 对话流（真 benchmark）

完整方法与结果：**[RESULTS-v2.md](./RESULTS-v2.md)**

```bash
node bench/shadowwork-bench-live.mjs --dry-run                        # 不花钱，只看 payload 和题
node bench/shadowwork-bench-live.mjs --facts 40 --mc-facts 10 --max-tokens 8000
```

三条硬约束（v0.1 就是缺了这三条才不算 benchmark）：

1. **真实语料** — 学历取磁盘上真实的 `task.origin.json`；对照组取**真实的 Claude Code 会话记录**，不是生成的。
2. **真实模型** — 两臂同端点、同 prompt、temperature 0，唯一变量是"开场喂什么"。
3. **客观判分** — 真值取自磁盘字段，干扰项取自**别的真实任务**的同类字段；四选一/是否可机械判分，不需要 judge。

结论一句话：同预算下**重放对话流 ≈ 什么都不喂**（都贴瞎猜线），给 10 倍预算也追不平；
而且**对话流不会说"我不知道"，它会自信地续错任务**——只有"什么都不喂"那一臂是诚实的。
