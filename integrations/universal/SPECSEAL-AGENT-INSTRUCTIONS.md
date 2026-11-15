# Specseal — agent 通用指令

本文档写给任何没有生成式 Specseal 技能的 AI 编码 agent。如果你的工具已用 `specseal init --tools <tools>` 初始化（claude、codex、copilot、pi、cursor），优先用该工具的生成技能；这份文档覆盖其余所有工具。可以复制、链接或粘贴进你的 agent 指令文档。

## Specseal 是什幺

一个规格驱动开发引擎。每个变更都从 repo 里 `specseal/` 下的文本开始：

```
specseal/
  specs/<capability>/spec.md     # 现行规格（需求 + 场景）
  changes/<name>/                # 每个变更一个文档夹：proposal、规格 delta、tasks.md、.meta.yaml
  changes/archive/               # 完成的变更，保留为历史
  discussions/                   # 讨论记录
  config.yaml                    # 工作区配置
```

规格与 delta 是纯 Markdown。delta 使用操作段落（`## ADDED Requirements`、`## MODIFIED Requirements`、`## REMOVED Requirements`）；每条需求带具体场景，写作 `- **WHEN** … - **THEN** …`。

## 你要走的环路

```
propose → apply ⇄ ingest → review? ∥ verify? → archive
```

1. **propose**——创建 `specseal/changes/<name>/`，包含 `proposal.md`（为什幺、问题、摘要）、规格 delta 和 `tasks.md`。任务是复选框：`- [ ] 1.1 短标题`。运行 `specseal validate`，把每个错误都修完再拿给用户看。
2. **apply**——逐个实现任务，每完成一项勾选复选框。如果需求中途变化，记录下来（ingest），绝不悄悄扩大范围。
3. **review**（可选）——记录为审查票据轮次的代码工艺检查。
4. **verify**（可选，建议做）——冻结范围，然后对照规格记录验证轮次：
   - `specseal verify scope <change> --json`
   - 逐项过范围；每轮：`specseal verify add-round <change> --stdin`
   - `specseal verify stamp <change>` 只在所有任务完成且最后一轮 must-fix 集为空时执行。除非用户亲口同意，绝不用 `--accept` 绕过未清的 must-fix。
5. **archive**——只在用户要求的所有站点盖章之后。封存会把 delta 并入 `specseal/specs/`。

## 规则

- 写代码前先读相关的 `specseal/specs/<capability>/spec.md`。如果没有规格覆盖这项工作、且用户没说要无规格修复，先提案。
- 如果 `specseal/principles.md` 存在，propose 或 review 前先读它。违反编号原则的发现是 must-fix；说明违反了哪条、为什幺。
- 需求有歧义就停下提问。不要替用户猜他该做的决定。
- 绝不编辑 `specseal/changes/archive/` 下的文档；那是历史。
- 每个变更都体现在 Git 里。`proposal.md`、delta 和 `tasks.md` 要随手保持真实——它们是记录，不是装饰。
- `specseal plan` 把就绪变更排成依赖波次；多个变更并行时用它。
- 常用只读动词：`specseal list`、`specseal show <change>`、`specseal status`、`specseal trace <capability>`、`specseal manual`、`specseal drift <change>`（暂停后恢复前的漂移检查）。

## 命令名说明

在本 fork 中引擎二进制仍叫 `specseal`（改名 `specseal` 将随项目自有发布渠道一起上线）。如果 PATH 上找不到 `specseal`，直接说明并停止；不要自行绕过。
