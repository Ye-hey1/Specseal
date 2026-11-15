# @specseal/mcp — Specseal 的 MCP server

把 Specseal 引擎的白名单动词暴露给任意支持 MCP（Model Context Protocol）的编码 agent。一个 server 覆盖所有 MCP 工具（Claude Code、Cursor、Codex、Windsurf、Gemini CLI…），不再逐家生成技能文件。

工作方式：agent 调用 MCP 工具 → 本进程 spawn `speclink <动词> [--json]` → 把输出透传回去。**引擎代码零改动**；盖章规则（must-fix 未清不许 stamp）由引擎强制，协议层绕不过去。

## 前置

- `speclink` CLI（0.12+）在 PATH 上——server 由它干所有实际的活
- Node.js ≥ 20
- 项目跑过 `speclink init`

## 接入配置

包安装后（`npm i -g @specseal/mcp`，发布渠道建立前可从仓库目录直接用 node 启动）：

**Claude Code：**

```bash
claude mcp add specseal -- node <路径>/packages/mcp-npm/specseal-mcp.mjs
```

**Cursor / Codex（`mcp.json`）：**

```json
{
  "mcpServers": {
    "specseal": {
      "command": "node",
      "args": ["<路径>/packages/mcp-npm/specseal-mcp.mjs"]
    }
  }
}
```

工作目录就是 agent 所在的项目目录——server 对哪个项目生效，取决于 agent 在哪个项目里启动它。

## 工具清单（v0.1，13 个）

| 工具 | CLI 动词 | 说明 |
| --- | --- | --- |
| `specseal_workflow_guide` | — | SDD 工作流指南（环路、各阶段职责、纪律）；不确定怎么走时先调它 |
| `specseal_status` | `status` | 工作区状态（文本） |
| `specseal_list_changes` | `list --json` | 全部变更：阶段、任务进度、站点章 |
| `specseal_show_change` | `show <name> --json` | 单个变更的 proposal/delta/tasks |
| `specseal_plan` | `plan --json` | 依赖波次 + 下一个就绪变更 |
| `specseal_validate` | `validate --json` | 工作区结构校验，`[]` 即通过 |
| `specseal_register_change` | `new change` | agent 写完 proposal/delta/tasks 后登记变更 |
| `specseal_trace` | `trace` | 能力溯源链（归档变更、讨论、证据） |
| `specseal_drift` | `drift` | 暂停后恢复的漂移检查 |
| `specseal_verify_scope` | `verify scope --json` | 冻结验证范围 |
| `specseal_verify_add_round` | `verify add-round --stdin` | 追加验证轮次 |
| `specseal_verify_show` | `verify show --json` | 验证票据：范围、轮次、发现、盖章状态 |
| `specseal_verify_stamp` | `verify stamp` | 盖章（引擎强制：任务全勾 + must-fix 清空；`accept` 需用户明确同意） |

## 安全边界

- 子进程 `spawn` 不走 shell，argv 由工具表构造，参数有名字合法性校验——没有命令注入入口
- 只暴露白名单动词；`discard`、`auth`、`config`、`archive` 等写权限大或面向人的动词不暴露（封存请让用户在 CLI/面板做）
- 默认 120 秒超时；非零退出以 `isError` 返回 stderr
- server 不发起任何网络请求（stdio + 本地子进程）

## 开发

```bash
cd packages/mcp-npm
npm install
npm test                # node --test：工具表与参数构造单测
SPECSEAL_MCP_SELFTEST=1 node specseal-mcp.mjs   # 冒烟：打印注册的工具数
```

## v0.2 计划

- review 站点工具（scope/add-round/stamp），与 verify 对称
- `archive`/`archive+commit`（需与面板的按钮语义对齐后暴露）
- 资源（resources）：`specs/<capability>/spec.md` 作为 MCP resources 暴露，agent 可直接订阅
- 发布物化：接入 `scripts/npm/` 发布脚本（当前 `private: true` 挡误发布）
