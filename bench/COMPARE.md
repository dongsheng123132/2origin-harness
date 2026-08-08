# 对照实验：2Origin vs 传统 harness

> 回答"2Origin 是不是更有效"的诚实方式——同一场景，两种架构对照。
> 场景：**任务进行到一半 → 会话关闭 → 新会话续作**（这是 harness 最常遇到的真实场景）。

## 跑法

```bash
node bench/compare-bench.mjs [rounds]   # 默认 30 轮工作后续作
```

## 实测（2026-08-08，30 轮工作后续作）

```
续作成本：2Origin bundle 2915 bytes vs 传统 transcript 8907 bytes（3.1x 压缩）
可续作性：2Origin ✓（目标/下一步在 bundle，无追问）
          传统 ✗（transcript 是对话流，无结构化状态 → 无法无追问续作）
```

## 三个发现

1. **省 token**：2Origin 用浓缩 bundle 续作，省 ~3x 字节（token）。
2. **能续 vs 不能续**（最本质）：传统 harness 的 transcript 是**对话流**，不含结构化的"目标/状态/下一步"——新会话**无法无追问续作**，只能靠人重述。2Origin 的 bundle 含这些，能续。
3. **噪音 vs 密度**：transcript 夹带大量聊天噪音（"今天天气不错"这类），bundle 只含有效状态。

## 为什么这重要

- 传统 harness 的"续作"实际是"重读对话"——token 贵、噪音多、还续不准。
- 2Origin 的"续作"是"读状态"——token 少、密度高、无需追问。
- 这正是 RFC-0000 核心洞察的量化：**状态（本象）优于影子（对话流）**。

## 诚实边界

- 这是**模拟场景**（生成的 transcript），不是真实生产 transcript。
- 测的是"续作成本"维度，不是"任务成功率"（那个需要真实模型跑）。
- 真实 transcript 更大（几 MB），压缩比可能更高——此处是保守下界。
