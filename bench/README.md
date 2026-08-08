# ShadowWork Bench — 学历跨会话保留率

> 测 2Origin 的核心主张：**多年不遗忘**。
> 传统 harness 的保留率是 **0%**（每个会话都是新的第一天）；
> 2Origin 通过本境跨会话积累，保留率接近 **100%**。

## 为什么这个指标存在

现有 AI 榜单（SWE-bench、GAIA、LiveBench）全测"单任务得分"——模型单次多聪明。
**没有人测"时间维度"**，因为传统 harness 活不过会话，没人想到要测。

ShadowWork Bench 填补这个空位：**同一台机器，用很多年后，还记得多少？**

## 指标

```
retention_rate = 新会话自动装载的事实数 / 学历事实总数
```

- **2Origin**：SessionStart 用本境 bundle 编译 → 学历跨会话保留（预期 ≈ 100%）
- **传统 harness**：无本境，每会话从零 → **0%**

## 跑法

```bash
node bench/shadowwork-bench.mjs              # 默认 50 facts, 30 sessions
node bench/shadowwork-bench.mjs --facts 100 --sessions 50 --budget 500000
```

## 实测结果（2026-08-08）

```
学历: 50 条已验证事实 + 5 条经验
模拟会话: 30 次关闭/重开
新会话自动装载: 50/50 条事实
── 保留率: 100.0% ──
对照（传统 harness，无本境）: 0%
```

## 诚实边界

- 这测的是**机制能力**（本境能保留），不是**语义质量**（保留的内容对不对——那个由晋升门槛 + 自动遗忘管）。
- 数值是"模拟会话"（buildBundle 反复跑），不是真实日历时间。真实"用几年"需要长期运行，但机制是同一套。
