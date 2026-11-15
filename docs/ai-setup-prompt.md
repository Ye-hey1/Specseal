# AI 安装 prompt

把下面的 prompt 粘贴进你的 AI 编码助手（Claude Code、Codex、Copilot、Cursor、pi，或任何能跑 shell 命令的 agent）。它会安装 CLI、初始化工作区并验证结果。先通读一遍——它假定有可用的稳定版 Rust 工具链；如果没有，prompt 会回退到 npm 渠道（安装的是同一引擎的上游 Specseal 构建）。

---

```text
在这个仓库里帮我配置 Specseal（一个规格驱动开发引擎）。一步步来，每一步先给我看结果再继续。

1. 检查 `specseal` 命令是否存在（`specseal --version`）。
   - 存在：打印版本号，继续。
   - 不存在：
     a. 如果有 `cargo`：运行 `cargo install --path <Specseal-checkout-路径>/crates/adapters/specseal-cli`。
        如果我没告诉你 Specseal 检出目录在哪，先问我，等我的回答。
     b. 如果没有 `cargo` 但有 `npm`：运行 `npm i -g @specseal/cli`，并告诉我这装的是同一引擎的上游 Specseal 构建。

2. 按我使用的 agent 工具初始化工作区。如果我没说，先问我用哪几个：claude、codex、copilot、pi、cursor。然后运行：
   specseal init --tools <逗号分隔列表>

3. 验证安装：
   - 运行 `specseal status` 和 `specseal validate`，两者都必须成功。
   - 列出 `specseal/` 下新建的文档，以及为我工具写入的 agent 指令文档（CLAUDE.md、AGENTS.md、.github/copilot-instructions.md 和技能文档）。

4. 如果我的工具不在第 2 步的列表里，把 Specseal 检出目录里的通用指令文档
   integrations/universal/SPECSEAL-AGENT-INSTRUCTIONS.md 复制进我的 agent 指令文档
   （或告诉我该粘贴到哪里）。

5. 不要开始任何变更、不要写规格、不要改动 specseal/ 里 init 创建之外的东西。全部完成后总结：
   - 引擎版本
   - 已初始化的工具
   - 我该用什幺命令或斜杠命令开始第一个变更
```

---

## 这个 prompt 做了什幺

| 步骤 | 效果 |
| --- | --- |
| 1 | 安装引擎：从本 fork 源码用 cargo，或上游 npm 构建 |
| 2 | `specseal init`——创建 `specseal/` 与逐工具技能 |
| 3 | 证明安装可用（`status`、`validate`）并展示创建了什幺 |
| 4 | 覆盖五个内置工具之外的 agent |
| 5 | 防止 AI 在你发话之前就跳进真实开发 |

## 安装完成后

用你的工具的提案命令开始第一个变更，例如 Claude Code / Copilot / Cursor 里的 `/specseal-propose <变更名>`。完整环路（propose、apply、check、archive）见[快速开始](getting-started.zh-CN.md)。
