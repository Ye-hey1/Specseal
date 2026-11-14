# 项目路线图

**简体中文** · [English](roadmap.md)

这份文档收集 Speclink 还没做完的方向。它写方向，不写调度，所以不会出现版本号或交付日期。

每条方向回答三件事：

- **要解决什幺**：这条方向存在的理由。
- **目前到哪**：今天已经做到的部分。是否可用以[项目能力状态](product-status.zh-CN.md)为准。
- **可观察的下一步**：做完之后，你可以亲手确认的事。

## <a id="sdk"></a>SDK

**要解决什幺**

想在自己的进程里驱动 Speclink 引擎的人，应该只要装一个套件，不必准备一套编译环境。装好之后，调用方式也要好写、出错时要说得清楚。

**目前到哪**

- `npm install @speclink/engine` 就装得起来，不需要 Rust 工具链。npm 上有五个平台的原生套件。
- 引擎、Store bridge 与 `dispatch` 契约都有测试守着。用法见 [Node SDK](sdk-node.zh-CN.md)。
- 还没做：
  - 类型化的 JS 方法。目前所有动词都经 `dispatch` 以字符串参数调用。
  - 契约版本握手：JS 套件与原生 binary 的版本不合时，直接拒绝而不是静默出错。
  - Store bridge 的并行上限、逾时与取消。目前没有这三项限制。
  - Rust 用户只能用 git 依赖 `speclink-core`；crates.io 上没有这个 crate。

**可观察的下一步**

用类型化的方法列出变更与读取规格，编辑器能自动补完参数。JS 套件与原生 binary 版本不合时，错误消息直接写出两边的版本。

## <a id="own-client"></a>以引擎自建客户端与 server

**要解决什幺**

桌面 app 只是引擎的其中一个前端。同一套指令、查找与背景数据的路径，CLI、server 与 Node SDK 都在用。你应该也能用它做出自己的东西：贴合团队流程的桌面 app、VS Code 扩充、内部网页看板，或接上自家认证与数据库的 server。

**目前到哪**

- 规则只在 `speclink-core` 实作一次。Host 负责认证、版本、交易与事件。
- [Client Protocol 正式规格](../speclink/specs/client-protocol/spec.md)定义跨客户端的在线契约。[动词与旗标契约](verb-contract.zh-CN.md)写下每个动词在本地与远程的归属与输出格式。
- 还缺：
  - 一份「从零做一个客户端」的文档。
  - JS 版的远程 HTTP client。目前只有 Rust 的 `speclink-remote`。
  - 可供第三方使用的 UI 组件与集成契约。`@speclink/ui` 目前是私有套件。

**可观察的下一步**

只读公开文档、不读 Speclink 原代码，就能做出一个最小客户端：列出变更、读一份规格、勾掉一个任务。做不出来的地方，就是还缺的文档或接口。

## <a id="remote"></a>远程协作

**要解决什幺**

一个人在自己的 repo 里用 Speclink 已经完整。多人共用一份正式规格时，还有几段路没铺平。

**目前到哪**

- Remote CLI 可用：`link`、`auth`、唯读投影，绝大多数动词都有远程版本，包括 `plan` 与前置声明。
- 桌面 app 可以开远程看板：浏览变更、勾任务、读写 artifact，看到创建者、认领人与 capability 清单。
- 认领会存进 Store；认领到别人持有的变更会被拒绝，消息写出持有人。
- 断线时看板变成唯读 snapshot，写入一律被拒，重连后自动收敛。
- 还没做：
  - 在桌面远程看板勾任务时，回报动到的文档（CLI 已经会）。
  - 认领的释放与接手。
  - 稽核历史的查找接口。Store 已保存每份文档的不可变历史，但还没有 API 或画面可以查「谁在什幺时候用哪个指令改了什幺」。
  - 本机投影缓存的清理：逾期清除、注销或切换项目时清除，以及只限本人读取。目前投影已是唯读，并排除在 Git 之外。
  - PM 到 RD 的交接关卡（核准后被改动就失效），以及 apply 时记下依据的规格版本。品质关卡与认领已涵盖一部分，还要重新决定是否需要。

**可观察的下一步**

在桌面远程看板勾掉一个任务之后，查得到它动了哪些文档，和在 CLI 上勾一样。持有人离开之后，有办法释放或接手认领。

## <a id="agent-tools"></a>Agent 工具集成

**要解决什幺**

Speclink 目前通过生成的技能档与 Agent 协作。技能档是「把流程知识写给模型读」，不是「把能力当成工具给模型调用」。只有后者能让 Agent 在对话中直接查规格、开变更、勾任务，不必每次重读一整份技能说明。

**目前到哪**

- 技能这一侧已经成熟：Claude Code 与 Codex 涵盖每一站，见[完整 SDD 工作流](workflow.zh-CN.md)。其他 AI 工具可以用自订工具描述子产生技能，见[设置说明](configuration.zh-CN.md)。
- Claude Code 插件 `speclink-skills` 提供技能按钮列与侧边面板。
- Herdr mod `speclink` 提供面板，并把侧栏清单接上 Speclink。
- 工具这一侧还没有入口：没有可安装的工具套件，也没有 MCP adapter。
- 目前讨论中的方向（尚未定案）：
  - 先在 `@speclink/engine` 提供一个通用工具，接收 CLI 参数与 stdin，并附上接到 Agent SDK 的范例。
  - 工具调用的身分绑在宿主那一端，模型不能自己带入身分。
  - MCP adapter 排在后面；没有 checkout 时，用 MCP resources 提供背景数据。

**可观察的下一步**

在一个 Agent 框架里把 Speclink 挂成工具，直接以工具调用列出变更与读取规格，不必请模型去跑 CLI。工具调用用的帐号与可写的 Store，和 CLI 走同一套判定。

## <a id="system"></a>系统集成

**要解决什幺**

Speclink 进到一间公司之后不会是孤岛。帐号要接既有的身分系统，规格的变动要能通知别的工具，部署要跟着既有的维运方式走。

**目前到哪**

- Server 的营运已经可用：安装、帐号管理、访问密钥、device 登录、备份还原都有入口与端到端测试。
- Server 提供 SSE 事件串流（`/events`），客户端可以即时收到变动。
- 还没做：
  - 企业 SSO（OIDC）。目前只有 server 自己管理的帐号。
  - 对外通知，例如 webhook。
  - runtime plugin：不改代码就换 Store 或挂上自订行为。
  - 多节点部署。目前定位是单一 instance。
  - 不停机的在线备份。
  - WebSocket 传输（优先度低）。

**可观察的下一步**

用公司既有的身分提供者登录 Speclink server，不必另建帐号。其余项目目前没有可观察的入口，也没有排定先后；有进展时会先反映在项目能力状态。

## <a id="related"></a>相关文档

- [项目能力状态](product-status.zh-CN.md)：现在哪些能用，附证据与查核日期。
- [Node SDK](sdk-node.zh-CN.md)：引擎目前的接口与加载方式。
- [动词与旗标契约](verb-contract.zh-CN.md)：动词的归属、输出格式与端点。
