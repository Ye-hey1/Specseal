# 项目能力状态

**简体中文** · [English](product-status.md)

最后查核日期：**2026-10-07**（0.8.0）。

这份文档回答「这项能力现在能不能用」。行为的正式定义在 `specseal/specs/`；还没做的方向在[项目路线图](roadmap.zh-CN.md)。只有代码、crate 或正式规格存在，不代表用户已经用得到。

要实际操作 Remote Server、Desktop 与 CLI，照 [Remote 入门](remote-getting-started.zh-CN.md)做一次。

## <a id="status-model"></a>状态怎幺判定

| 状态 | 意思 |
| --- | --- |
| Available（可用） | 有用户入口，而且有两项互相独立的证据，或一项端到端测试。 |
| Partial（部分可用） | 有一部分可以用，完整流程还有明确的缺口。 |
| Planned（规划中） | 还没有可用的入口。细节见[项目路线图](roadmap.zh-CN.md)。 |
| Deprecated（已弃用） | 进程里还找得到，但已经不是目标架构。目前没有这类项目。 |

## <a id="local-and-remote"></a>本地与远程对照

本地与远程的差异都在这张表。Remote Store 一栏以官方参考 server `specseal-server` 量测；远程模式由 Host 与 Protocol 契约定义，自建 server 同样适用这些字段。

大多数 CLI 动词在本地与远程都能用（Dual）。例外如下，完整清单见[动词与旗标契约](verb-contract.zh-CN.md)：

- 只限本地：`demo`、`trace`、`change rank`、`plan --strict-overlap`。
- 只限远程：`claim`。

在错的模式下运行这些动词，CLI 会明确拒绝，不会改走另一边。

| 能力 | Local Repo | Remote Store | 说明 |
| --- | --- | --- | --- |
| 规格与变更的读写 | 可用 | 可用 | 本地直接读写 `specseal/`；远程一律经 Host 指令写入，不会在本机留第二份可写的数据。 |
| 变更生命周期（`propose` → `apply` → `archive`） | 可用 | 可用 | 远程一次只能封存一个变更。 |
| 讨论（`discuss`） | 可用 | 可用 | 转为变更、并入既有变更与封存，两边相同。 |
| 品质关卡（`review`、`verify`） | 可用 | 可用 | 工单、轮与盖章的规则两边相同。 |
| 运行顺序（`plan`、`change depends`、`change schema`） | 可用 | 可用 | 0.6.0 起远程也能读 plan、写前置。`change rank` 只限本地。远程的 `change schema` 只解析内置 schema。 |
| 溯源（`trace`） | 可用 | 不适用 | 只限本地。 |
| 认领变更（`claim`） | 不适用 | 可用 | 认领人存进变更数据，重启后还在。认领别人持有的变更会回 409，消息写出持有人。 |
| 示范数据（`demo`） | 可用 | 不适用 | 只限本地；远程模式直接拒绝，不送出请求。 |
| Agent 读取背景数据 | 可用 | 可用 | 本地直接读 repo；远程读唯读的 `.specseal/context/`。 |
| 任务的 touched-file 证据 | 可用 | 可用 | 本地写进 `.evidence.json`；远程存进 Store，可经 `GET /changes/{name}/evidence` 读回。 |
| 桌面看板与详情页 | 可用 | 部分可用 | 远程看板在桌面上勾任务时，不回报 touched files。 |
| 帐号、访问密钥与 membership | 不适用 | 可用 | 本地不需要帐号。 |
| 备份还原 | 由 Git 负责 | 可用 | 远程备份目前要停机进行。 |
| 脱机工作 | 可用 | 需连接 | 远程断线时只能读，写入会被拒绝。 |

## <a id="capabilities"></a>能力清单

| 能力 | 状态 | 用户入口 | 证据 | 限制与下一步 | 查核 |
| --- | --- | --- | --- | --- | --- |
| Local Repo CLI | 可用 | `specseal init`、`list`、`show`、`status`、`validate`、`analyze`、`drift`、`archive`、`discuss` 等 | [CLI 入口](../crates/adapters/specseal-cli/src/main.rs)<br>[CLI 集成测试](../crates/adapters/specseal-cli/tests/it/doc_verbs.rs) | 不需要 server。旗标以各子指令的 `--help` 为准。 | 2026-10-07 |
| Agent 技能 | 可用 | Claude、GitHub Copilot 与 Cursor `/specseal-*`、Codex `$specseal-*`、pi `/skill:specseal-*` | [生成的 apply 技能](../.agents/skills/specseal-apply/SKILL.md)<br>[生成的 manual 技能](../.claude/skills/specseal-manual/SKILL.md)<br>[自订工具描述子测试](../crates/adapters/specseal-cli/tests/it/tools_descriptor.rs)<br>[Copilot 技能快照](../crates/engine/specseal-core/tests/golden/copilot.snapshot.md)<br>[pi 技能快照](../crates/engine/specseal-core/tests/golden/pi.snapshot.md)<br>[Cursor 技能快照](../crates/engine/specseal-core/tests/golden/cursor.snapshot.md) | `analyze` 技能只有 Claude 有，Codex、GitHub Copilot、pi 与 Cursor 直接用 CLI。技能数量：`worktree` 政策关闭时 Claude 17 个，Codex、GitHub Copilot、pi 与 Cursor 各 16 个；打开时各多 2 个。其他 AI 工具可用自订工具描述子产生技能。 | 2026-11-10 |
| 品质关卡 | 可用 | `/specseal-review`、`/specseal-verify`、`/specseal-quality`；CLI `specseal review`、`specseal verify` | [关卡的盖章与工单规则](../crates/engine/specseal-core/src/quality/station.rs)<br>[review 动词测试](../crates/adapters/specseal-cli/tests/it/review_verbs.rs) | SUGGESTION 不挡章。盖章后范围内的文档再被改，章会降级为「其后有变动」。 | 2026-10-07 |
| 运行顺序 | 可用 | `specseal plan`、`specseal change depends`、`specseal change rank`、`specseal change schema`；桌面变更详情页的「调度」文档 | [plan 动词测试](../crates/adapters/specseal-cli/tests/it/plan_verbs.rs)<br>[change schema 测试](../crates/adapters/specseal-cli/tests/it/change_schema.rs)<br>[server 的 plan API 测试](../crates/host/specseal-server/tests/it/api/plan_api.rs) | `change rank` 与 `plan --strict-overlap` 只限本地。 | 2026-10-22 |
| 手册与溯源 | 可用 | `/specseal-manual`、桌面「手册」页；`specseal trace`、`/specseal-trace` | [手册页测试](../packages/ui/src/__tests__/manualPage.test.tsx)<br>[trace 测试](../crates/adapters/specseal-cli/tests/it/trace.rs) | 远程项目还不能生成手册（导览可以）。`trace` 只限本地。 | 2026-10-07 |
| Local 桌面 app | 可用 | 看板、详情页、规格、已封存、手册、设置模式（应用进程设置、项目设置与「关于 Specseal」页）与系统匣 | [Desktop scripts](../apps/desktop/package.json)<br>[Desktop UI 测试](../apps/desktop/src/__tests__/App.test.tsx)<br>[设置模式测试](../apps/desktop/src/__tests__/settingsColumn.test.tsx)<br>[关于页测试](../apps/desktop/src/__tests__/aboutPage.test.tsx)<br>[自动更新测试](../apps/desktop/src/__tests__/updater.test.ts) | 远程项目的状态另列在下面。 | 2026-10-15 |
| 以网址打开详情页 | 可用 | 外部进程送出 `specseal://change/<变更名称>?project=<项目路径>` 或 `specseal://discussion/<讨论 slug>?project=<项目路径>`，桌面 app 打开该项目的详情页；送出 `specseal://project?project=<项目路径>` 时，桌面 app 切到该项目并显示看板 | [网址解析与派送测试](../apps/desktop/src/__tests__/deepLink.test.ts) | 只打开与查看，只限本机项目（带 remote 标记的文档夹改开「添加项目」对话框）。Windows、Linux 只能开一个 app，再次启动会把既有窗口带到前景。 | 2026-11-04 |
| 安装通路 | 可用 | 桌面安装档（macOS universal dmg、Windows 安装器、Linux AppImage）；CLI 的 npm、安装脚本、Homebrew；server 的 npx 与 Docker | [npm 启动器测试](../scripts/npm/npm-cli-launcher.test.mjs)<br>[安装脚本测试](../scripts/install.test.mjs)<br>[Homebrew formula 产生器](../scripts/release/homebrew-formula.mjs) | Windows 安装档没有代码签章，第一次运行要放行 SmartScreen。 | 2026-10-07 |
| Node SDK（`@specseal/engine`） | 可用 | `npm install @specseal/engine` | [套件入口](../crates/adapters/specseal-node/package.json)<br>[dispatch 契约测试](../crates/adapters/specseal-node/__test__/dispatch-contract.spec.ts)<br>[版号测试](../scripts/npm/npm-engine-package.test.mjs) | 0.2.0 起在 npm 上，含五个平台子套件。还没有：类型化的 JS 方法、JS 版远程 client、Agent 工具层。见[路线图](roadmap.zh-CN.md)。 | 2026-10-07 |
| Command Runtime、Host 与 Protocol | 可用 | CLI、server 与 Node SDK 共用的 Rust crates | [Host 双路径测试](../crates/host/specseal-host/tests/bridge_dual_path.rs)<br>[Client Protocol 正式规格](../specseal/specs/client-protocol/spec.md) | 给 Agent 用的工具包装还没做。 | 2026-10-07 |
| SQLite TeamStore | 可用 | `specseal-server` 缺省的 `sqlite` | [SQLite 一致性测试](../crates/store/specseal-store-sqlite/tests/conformance.rs)<br>[保存后端选择](server-store-drivers.zh-CN.md) | 只支持单一 server instance。 | 2026-10-07 |
| Server FS TeamStore | 可用 | server 设置的 `serverfs` | [Server FS 一致性测试](../crates/store/specseal-store-fs/tests/it/conformance.rs)<br>[原子发布测试](../crates/store/specseal-store-fs/tests/it/atomic_publish.rs) | 需要可靠的文档锁（flock）；一个数据目录只能有一个 server。 | 2026-10-07 |
| PostgreSQL TeamStore | 可用 | server 设置的 `postgres` | [PostgreSQL 一致性测试](../crates/store/specseal-store-postgres/tests/it/conformance.rs)<br>[韧性测试](../crates/store/specseal-store-postgres/tests/it/resilience.rs) | server 仍是单一 instance。 | 2026-10-07 |
| `specseal-server` | 可用 | npx、Docker、Compose；自原代码建置 native binary | [server 入口](../crates/host/specseal-server/src/main.rs)<br>[CLI 到 server 端到端测试](../crates/host/specseal-server/tests/it/e2e_cli.rs) | Release 不附 native binary。 | 2026-10-07 |
| Server 后台、设置与帐号 | 可用 | `/setup`、`/admin`、`/account`、访问密钥、device 登录、邀请与命令行管理指令 | [后台端到端测试](../crates/host/specseal-server/tests/it/admin/e2e.rs)<br>[device 登录端到端测试](../crates/host/specseal-server/tests/it/identity/device_e2e.rs) | 没有 SSO，见[路线图](roadmap.zh-CN.md)。 | 2026-10-07 |
| Server 营运 | 可用 | 部署、健康检查、`backup`、`verify-backup`、`restore` | [部署文档](server-deployment.zh-CN.md)<br>[备份端到端测试](../crates/host/specseal-server/tests/it/admin/backup_e2e.rs) | 备份要停机；没有滚动升级与多节点。 | 2026-10-07 |
| Remote CLI 与唯读投影 | 可用 | `specseal link`、`auth`、`artifact`；唯读的 `.specseal/context/` | [Remote CLI 测试](../crates/adapters/specseal-cli/tests/it/remote_read_path.rs)<br>[投影实作](../crates/host/specseal-host/src/projection.rs) | — | 2026-10-07 |
| 远程任务证据 | 可用 | 远程的 `specseal task done` 把 touched files 存进 Store | [证据实作](../crates/engine/specseal-core/src/lifecycle/tasks.rs)<br>[远程证据端到端测试](../crates/host/specseal-server/tests/it/phase2_chain.rs) | 桌面远程看板勾任务时不送 touched files。 | 2026-10-07 |
| 桌面 Server 连接 | 可用 | 设置的「服务器」页、device 登录、访问密钥、注销与 OS Keychain | [连接流程](../apps/desktop/src-tauri/src/connections.rs)<br>[Servers 面板测试](../apps/desktop/src/__tests__/serversPanel.test.tsx) | — | 2026-10-15 |
| 桌面远程项目 | 部分可用 | 「添加项目」对话框的远程打开：只看规格，或绑本机 checkout；详情页可认领 | [添加项目对话框](../apps/desktop/src/components/WorkspaceChooser.tsx)<br>[远程打开测试](../apps/desktop/src/__tests__/remoteOpen.test.ts) | 可浏览、勾任务、读写 artifact。缺口：勾任务不回报 touched files；认领没有释放或接手的动词。 | 2026-10-07 |
| Claude Code 插件（`specseal-skills`） | 部分可用 | `/plugin install specseal-skills --marketplace MomoChenisMe/speclink` | [插件测试](../integrations/claude-code/specseal-skills/tests/register.test.tsx)<br>[技能分组测试](../scripts/claude-code/skill-groups.test.mjs) | 创建在 Claude Code 的 early-access 插件接口上，Claude Code 改版时可能要跟着更新。Windows 尚未实机测试。 | 2026-10-07 |
| Herdr mod（`specseal`） | 部分可用 | `cp -R integrations/herdr/mods/specseal integrations/herdr/mods/specseal-new ~/.config/herdr-app/mods/` | [面板逻辑测试](../scripts/herdr/panel-model.test.mjs)<br>[安装说明](../integrations/herdr/README.md) | 停靠的版面、侧栏清单、文档和变更面板是 Herdr 内置版面与 mod 的拷贝版，Herdr 更新后要重做停靠。内置画面的翻译靠文档没写的行为，Herdr 改掉后会回到英文。贴进输入框和开页面只有 macOS。没有用 Codex 测试过。 | 2026-11-04 |
| MCP 与 Agent 工具套件 | 规划中 | 没有入口 | [方向与下一步](roadmap.zh-CN.md) | 见路线图的「Agent 工具集成」。 | 2026-10-07 |
| SSO、runtime plugin 与多节点 | 规划中 | 没有入口 | [方向与下一步](roadmap.zh-CN.md) | 见路线图的「系统集成」。 | 2026-10-07 |

## <a id="recheck"></a>怎幺重新查核

之后要更新这份文档时，用当下的 checkout 重做判断，不要沿用旧日期的结论：

1. 运行 `specseal --help` 与各子指令的 `--help`，核对 CLI 入口。
2. 运行 `specseal-server --help`，核对 server、帐号与备份的入口。
3. 比较 `.claude/skills/` 与 `.agents/skills/` 的目录清单。两边只差 `specseal-analyze`（只有 Claude 有）。
4. 用[动词契约的正式规格](../specseal/specs/verb-contract/spec.md)核对本地与远程对照表。
5. 用 `npm view @specseal/engine version` 等指令核对 npm 上的版本。
6. 交叉核对 `Cargo.toml`、各 package 的 scripts、集成与端到端测试，以及正式规格。没有用户入口的能力，不能因为 crate 存在就标成可用。

## <a id="doc-gaps"></a>已知文档缺口

- 还没有「从零做一个客户端」的文档。方向见[路线图](roadmap.zh-CN.md)的「以引擎自建客户端」。

## <a id="related"></a>相关文档

- [完整 SDD 工作流](workflow.zh-CN.md)：每一站的用途、技能、完成判准与下一站。
- [项目路线图](roadmap.zh-CN.md)：还没做的方向。
- [Server 部署](server-deployment.zh-CN.md)、[保存后端](server-store-drivers.zh-CN.md)、[备份与还原](server-backup.zh-CN.md)：server 的营运方式。
