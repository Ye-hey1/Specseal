# Principles — 仓库级项目宪法

Principles（项目原则）是一份短清单：本仓库中每一份规格、每一轮 review、每一轮 verify 都对照它检查。想法、计划、变更来了又走；原则很少变，改一条原则需要讨论，而不是顺手一改。

这是 Specseal 的约定层。这个想法来自 spec-kit 的 "constitution"：一小份稳定的原则胜过一份又长又漂移的。

**注入现状**：propose / apply / review / verify 四个技能文件已内置「读 `speclink/principles.md`」的指引（资产版本 v1.58.2 起）——agent 在这些阶段会被技能提示去读原则，违反编号原则即 must-fix。引擎指令上下文级的自动注入（把原则内容直接拼进指令）仍是路线图项（[REBRAND-NOTES.md](../REBRAND-NOTES.md)）。

## 快速上手

1. 把下面的模板复制成 `speclink/principles.md`。
2. 删掉每一条你不会真正执行的原则。五条真规则胜过十五条愿望。
3. 让 agent 去读它：在你的 agent 指令文档里加一句（「propose 或 review 之前先读 `speclink/principles.md`；违反编号原则的发现是 must-fix」）。如果你用[通用指令文档](../integrations/universal/SPECSEAL-AGENT-INSTRUCTIONS.md)，里面已经写了这条。
4. 在 review 和 verify 轮次里引用它：一条引用了原则编号的发现是 must-fix，不是 suggestion。

## 模板

````markdown
# Principles

本仓库的每份规格、每轮 review、每轮 verify 都对照这些规则检查。
编号，让发现可以引用它们。改一条需要讨论，不是顺手一改。

## P1 — 正确性优先

每个行为变更都要带一个「没有这个变更就会失败」的测试。
规格场景没有对应测试，是 must-fix 发现，不是建议。

## P2 — 小而诚实的范围

变更只做提案里说的事。中途扩大范围必须记录（ingest），绝不悄悄加戏。

## P3 — 依赖

添加运行时依赖必须在提案里写明理由：做什幺、替代了什幺、许可证、谁在维护。

## P4 — 边界处验证错误

校验用户输入与外部响应；内部调用视为可信。
不为不可能出现的状态写防御代码。

## P5 — 平实胜过聪明

选无聊的方案。如果审查者不能用一句话讲清一个函数，那就是 must-fix 发现。

## 变更记录

- 2026-11-14 — 初始集（P1–P5）。
````

## 三道站点怎幺用它

| 站点 | 用法 |
| --- | --- |
| propose | agent 在把规格交给你之前先对照原则自查。违反原则的设计在这里抓住最便宜。 |
| review | 发现要引用原则编号。引用了原则的是 must-fix；没引用的风格意见保持为 suggestion。 |
| verify | 轮次记录检查了哪些原则、发现了什幺；盖章的证据链里因此包含它们。 |

## 什幺该进 principles——什幺不该

该进：你愿意为之 block 变更的规则（测试、范围纪律、依赖政策、错误哲学、命名）。

不该进：格式化工具已经管掉的风格规则（交给工具）、目标式表述（「要快」）、以及任何你不愿用它拦下变更的东西。如果你不会因它拒绝盖章，那是 suggestion，suggestion 留在 review 轮次里，不进这里。
