# REBRAND-NOTES

改名前先读这一份。

## 这个仓库是什幺

Specseal 是 [Speclink](https://github.com/MomoChenisMe/speclink)（MIT）的 fork，2026-11-14 从 `main` 浅克隆（depth 1）。MIT 许可证与上游版权声明保留在 `LICENSE` 中——这是许可证的要求；README 的 Acknowledgments 中已致谢上游。

## 已切割上游 dogfood（2026-11-15）

Speclink 上游用自己的引擎管理自己的开发，仓库里带着它的全部工作痕迹。Specseal 作为全新项目，已整体切除：

- **删除** `speclink/`（上游的 1954 份自规格、变更与讨论归档）、`.claude/`、`.agents/`（上游 init 生成的技能实例）、`.speclink.yaml`（上游 init 标记）
- **保留** `.claude-plugin/`——那是插件市场定义（`/plugin install speclink-skills` 面向用户的功能），不是 dogfood
- **重新 `speclink init --tools claude,codex`**：得到一个空白的 `speclink/` 工作区（空 specs/changes + config.yaml）和全新的技能文件，`speclink list --json` 返回空——Herdr 面板从零开始记录 Specseal 自己的变更
- 删除前核对过：测试里的 `speclink/specs` 引用全部是测试在临时目录自建的工作区；CI 不跑引擎自检；无测试读取仓库根的 dogfood 目录

## 命名决策

- **Specseal** = spec + seal（规格 + 封章）。每个 AI 做的变更都盖上「查得到、机器读得到」的验证证据，这就是本项目的一句话定位。
- GitHub 查重结果（2026-11-14）：`specseal`、`sealspec` 均无同名仓库；`specproof`（16 个同名）与 `verispec`（18 个）已被占用，弃用。

## 已经带上 Specseal 品牌的部分

- `README.md`（定位、demo 实录、对比表、证据优先叙事）
- `README.zh-CN.md`（头部与 fork 说明；正文沿用上游译文——下次编辑时顺带同步）
- `docs/comparison.md`、`docs/principles.md`、`docs/ai-setup-prompt.md`（简中）
- `integrations/universal/SPECSEAL-AGENT-INSTRUCTIONS.md`（通用 agent 指令，简中）
- `integrations/ci/specseal-verify.yml`（CI 盖章门禁模板，简中注释）
- `AGENTS.md`（顶部的 fork 说明）

## 刻意仍叫 "speclink" 的部分，以及为什幺

所有**本 fork 还不拥有的发布渠道**相关面：

| 表面 | 当前名字 | 为什幺暂不改 |
| --- | --- | --- |
| 二进制 / CLI 动词 | `speclink …` | 改二进制名会同时打断所有脚本、文档、技能文档与黄金测试——应在一次专门的提交中完成，不搭车 |
| Rust crate | `speclink-core`、`speclink-cli` … | Cargo workspace + lockfile + 导入路径，纯机械改动，在自有渠道创建前没有用户价值 |
| npm 包 | `@speclink/cli`、`@speclink/server`、`@speclink/engine` | npm 上还没有 `@specseal/*`，必须先发布再改名 |
| Homebrew tap | `MomoChenisMe/tap/speclink` | tap 是上游的 |
| 容器镜像 | `ghcr.io/momochenisme/speclink-server` | 镜像仓库是上游的 |
| 工作区文档夹 | `speclink/` | 改名会让所有现存用户项目失效；需要 init 内置导入（参照现有 OpenSpec 单向导入） |
| 技能前缀 | `/speclink-*`、`$speclink-*`、`/skill:speclink-*` | 由引擎生成；改名牵动技能生成与全部黄金测试 |
| 品牌素材 / 截图 | `docs/assets/brand/…speclink…`、`docs/assets/screenshots/zh-TW/…` | 新品牌图与简中界面截图还不存在；截图是应用 UI 的语言版本目录，图片内容无法文本转换 |

## 简中化范围（2026-11-14）

全仓中文已按要求统一为简体，但**刻意分层**：

**已转简中**（OpenCC tw2sp 词汇级转换）：根目录 md（README、CHANGELOG、AGENTS、REBRAND-NOTES 与全部 `*.zh-CN.md`）、`docs/` 全部文档、`integrations/` 全部 md（含 claude-code 插件与 herdr 的 README、通用指令文件）、`.github/workflows/` 与 `deploy/` 的 yml（已核实其中中文仅为注释与输入描述，无功能断言）。

**刻意未转，各有原因**：

| 范围 | 原因 | 处理方式 |
| --- | --- | --- |
| `crates/` 引擎字符串、技能资产（assets/skills）、黄金测试快照 | 引擎运行时输出与快照必须一致；只转资产不转运行时字符串会让测试失败，属代码级变更 | 列入「引擎简中化」专项；本轮曾试转并已回滚（`git restore crates/ .agents/ .claude/`） |
| `skill-evals/` 评测用例 prompt | 评测装置的输入 fixtures，转换可能改变评测语义 | 引擎简中化专项时一并处理并重跑评测 |
| `speclink/`（引擎自规格 + 1954 个历史归档 md） | 上游的工作历史与审计记录，转写历史价值低、体量大 | 保留原样；如需，同一 OpenCC 脚本可批量处理 |
| 桌面应用 `zh-TW` locale 字典与截图（`docs/assets/screenshots/zh-TW/`） | 代码级 i18n 键与图片内容，非文档 | 随改名路线图第 2 步（桌面显示名）处理；截图需用简中界面重新截取 |

**引擎简中化的安全做法**（未来专项）：一次提交内同时转换 `assets/skills/*.md` + Rust 渲染字符串 + 黄金快照 + skill-evals，然后完整跑 `npm test` 与 `cargo test`。不要在任何搭车提交里碰它。

## 分阶段改名路线图

按顺序做，每一步都独立可用。

1. **拥有渠道**（不改代码）：建 GitHub 组织/仓库，向 npm 发布 `@specseal/cli` + `@specseal/server`，建 Homebrew tap，推 `ghcr.io/<org>/specseal-server`。
2. **用户可见品牌，一次提交**：README/文档字符串（本批已完成，渠道除外），随后是桌面 app 的显示名与窗口标题。
3. **二进制改名**：`speclink` → `specseal`，覆盖 CLI crate、全部技能模板、全部黄金测试与每处文档示例。一次提交完成，用 `git grep -w speclink` 扫尾（此阶段 `speclink/` 工作区文件夹名保持不变）。
4. **工作区文件夹改名**：`speclink/` → `specseal/`，在 `init` 中加导入路径（参照现有 OpenSpec 单向导入：`openspec/` → `speclink/`），让存量项目迁移。
5. **crate + npm 改名**：重命名 Rust crate 与 npm scope，更新 lockfile 与工作流，然后归档或重定向旧名。
6. **技能前缀**：最后改 `/speclink-*` → `/specseal-*`——纯属用户肌肉记忆，引擎行为前后完全一致。

## Specseal 自己的路线图（改名之外）

按优先级排列，来自立项时的产品分析：

1. **P0** — MCP server（一个集成面胜过五套手写技能）；verify CI 门禁做成可复用的 GitHub Action（上面的模板是第一步）；AI 安装 prompt 与 demo 优先的 README（已完成）。
2. **P1** — 引擎自动把 `speclink/principles.md` 注入 propose/review/verify 上下文；spec-kit → Specseal 迁移命令（OpenSpec 导入是现成范式）；`init` 生成通用指令模式（当前该文件需手动复制）。
3. **P2** — bug 修复与存量项目流程做成可选站点；verify→修复→再验证的收敛环并记录轮次；桌面远程工作区。
