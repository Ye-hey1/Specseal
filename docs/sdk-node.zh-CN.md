# Node SDK（@specseal/engine）

**简体中文** · [English](sdk-node.md)

`@specseal/engine` 让你在 Node.js 进程里直接运行 Specseal 的动词、把规格存进自己的数据库，并为任何 AI 工具产生技能档。它就是 CLI 用的那颗 Rust 引擎，通过 [napi-rs](https://napi.rs) 接到 Node，不是另外重写的版本，所以动词行为、`--json` 输出形状与技能内容都和 CLI 一致。

常见的两种用法：

- 把 Specseal 接进既有流程，例如脚本、内部工具，或运行 AI agent 的服务。
- 拿它当**自建 server 的引擎**。官方的 `specseal-server` 只是参考实作；远程模式由 `specseal/specs/` 底下的 `host-runtime` 与 `client-protocol` 两份公开契约定义。你可以照这两份契约，用这个引擎写自己的 server，接上自家的认证、数据库与权限模型，CLI 与桌面 app 一样接得上。官方 server 的用法见 [Remote 入门](remote-getting-started.zh-CN.md)。

## <a id="install"></a>安装

```bash
npm install @specseal/engine
```

0.2.0 起可从 npm 安装，版号跟着 Specseal 的 release 走。需要 Node.js 18 以上。Windows x64、macOS x64 与 arm64、Linux x64 与 arm64（glibc）五个平台都有预先编译好的套件，安装时只下载你的平台那一份，不需要 Rust。Alpine 这类 musl Linux 没有预编译套件。

```js
const { createEngine, skills } = require('@specseal/engine')
```

### 替代路径：自 repo 建置

要改引擎本身，或你的平台没有预编译套件时，从原代码建置（需要 Rust 工具链）：

```bash
git clone https://github.com/MomoChenisMe/speclink.git
cd specseal/crates/adapters/specseal-node
npm ci
npm run build          # 为目前的平台建出 .node 档
```

然后用路径引用：

```js
const { createEngine } = require('/path/to/specseal/crates/adapters/specseal-node')
```

`npm run build` 只建出目前平台的文档，所以要在部署的目标平台上建置。

## <a id="create-engine"></a>创建引擎

`createEngine` 有两种保存方式。

**本机文档**：指向含 `specseal/`（或旧版创建的 `openspec/`）的项目根目录，适合本机工具与测试。

```js
const engine = createEngine({ store: { type: 'fs', root: '/path/to/project' } })
// 选填：specDir（缺省与 CLI 相同：依序取 .specseal.yaml 的 spec_dir、specseal/、openspec/，都没有时为 "specseal"）
```

**自己的 Store**：传入一个实作 Store 接口的对象（见[自己实作 Store](#store)），引擎通过它读写文档。

```js
const engine = createEngine({ store: myStore })
```

对象缺少必要方法时，`createEngine` 会立刻抛错，并列出所有缺少的方法名。

**`actor`（选填）**：这颗引擎的操作者，格式是 `"Name <email>"`。引擎记下的 `created_by`（`new change`）、`reviewed_by`（`review stamp`）与 `verified_by`（`verify stamp`）都是它。

```js
const engine = createEngine({ store: myStore, actor: 'Alice <alice@example.com>' })
```

- 一个实例只有一个身分。`dispatch` 没有身分参数，调用端无法冒用别人。多人系统请每个请求（或每个用户）建一个实例；创建成本只是一个对象。
- 没给 `actor` 时，本机文档形式用该 workspace 的 git 身分（和 CLI 相同）；自己的 Store 则不记身分。只有空白也视同没给。
- 谁可以用哪个身分，由你的系统决定。SDK 只接收结果。

## <a id="dispatch"></a>运行动词

```js
const list = await engine.dispatch(['list', '--json'])
const status = await engine.dispatch(['status', '--change', 'add-auth', '--json'])
await engine.dispatch(
  ['new', 'artifact', 'proposal', '--change', 'add-auth', '--stdin'],
  { stdin: '## Why\n…' },
)
```

- **输入**：字符串数组，和 CLI 的写法一样，只是去掉进程名。CLI 从 stdin 读内容的动词，改用第二个参数 `{ stdin }` 传入。
- **输出**：Promise，结果和 CLI `--json` 的输出相同（字段是 camelCase）。没有 `--json` 形式的动词（例如 `new change`）回传 `{ output: string }`，`output` 是 CLI 印到 stdout 的文本，不带色码。CLI 另有提示印到 stderr 时（例如封存没有任务证据的变更），对象另带 `stderr`。`discuss conclude` 收尾的封存失败时不算错误：结论已经写入，对象另带 `closingError` 说明原因。这时不要再运行一次 `discuss conclude`，改运行 `discuss archive`。TypeScript 类型是 `Promise<unknown>`，字段形状见[动词与旗标契约](verb-contract.zh-CN.md)。
- **不会卡住事件循环**：每次 dispatch 都在背景线程运行，可以同时发出多个。

有引擎命令的动词全部能用。需要 checkout 的动词会以 `invalid_argv` 拒绝：`drift`、`change rank`、`review prepare`、`review scope`、`verify scope`、`instructions --skill`。一次 `archive` 只封存一个变更：给多个名称或 `--all` 会以 `invalid_argv` 拒绝。

失败时 Promise 以 `Error` 拒绝。`message` 和 CLI 印出的消息相同，可以直接交给用户或 agent；`code` 是分类：

| `code` | 意思 |
| --- | --- |
| `invalid_argv` | 参数有误、这个动词需要 checkout，或写入的内容格式不对（例如 tasks 没有 `- [ ]`、审查轮缺 `**Scope**:` 行） |
| `not_found` | 找不到 change 或讨论 |
| `invalid_config` | 设置档存在但无法解析（不会改用默认值） |
| `refused` | 前置条件不成立 |
| `error` | 其他引擎错误。在本机文档形式或没实作 `claim` 的 Store 上运行 `claim`，也会得到这个 |
| Store 自订的 code | Store 方法抛出带 `code` 的错误时原样传回，例如 `ownership_lost` |
| `store_error` | Store 方法抛出没有 `code` 的错误 |
| `panic` | 引擎内部错误 |

## <a id="store"></a>自己实作 Store

Store 是一个对象，引擎通过它读写 change、artifact、规格与讨论。数据要怎幺存（数据表、文档、对象保存）由你决定。完整的方法签名见 [`index.d.ts`](../crates/adapters/specseal-node/index.d.ts)。每个方法可以直接回传值，也可以回传 Promise。

**必要方法**（共 31 个）：

| 分组 | 方法 |
| --- | --- |
| Change | `listChanges`、`findChange`、`changeExists`、`createChange`、`updatedAtSecs` |
| Artifact | `readArtifact`、`writeArtifact`、`artifactExists` |
| Delta 规格 | `deltaCapabilities`、`hasCapabilityDirs` |
| 正式规格 | `listCanonicalCapabilities`、`canonicalSpecExists`、`readCanonicalSpec`、`writeCanonicalSpec`、`canonicalSpecPath` |
| 封存 | `archivedChangeExists`、`archiveChange`、`readArchivedMeta`、`writeArchivedMeta` |
| 讨论 | `liveDiscussionExists`、`archivedDiscussionExists`、`liveDiscussionPath`、`readLiveDiscussion`、`writeLiveDiscussion`、`deleteLiveDiscussion`、`readDiscussion`、`listLiveDiscussions`、`listArchivedDiscussions`、`archiveDiscussion` |
| 设置与词汇 | `readWorkflowConfig`、`readLanguage` |

**选配方法**：

| 方法 | 什幺时候需要 |
| --- | --- |
| `readChangeMeta`、`writeChangeMeta`、`deleteArtifact` | `review stamp`、`verify stamp`。缺任何一个，盖章会在动手前拒绝 |
| `claim` | `claim` 动词。见下方 |
| `deleteChange`、`readEvidence`、`writeEvidence` | 目前接上的动词用不到，可以先不实作 |

实作时要注意：

- **change 的 meta 两边命名不同。** `createChange(name, metaText)` 收到的是 YAML 文本，键名用底线，例如 `created_by: Alice <alice@example.com>`。`listChanges` 与 `findChange` 要回传对象，meta 的键名用驼峰，例如 `createdBy`。
- **回传类型要对。** 布尔、数字、字符串类型不对时，引擎不会报错，而是当成默认值（例如 `changeExists` 回传非布尔会被当成 `false`）。`listChanges`、`findChange` 的形状不对则会报错。
- **`path`、`dir` 这类回传值只是显示用的字符串**，引擎不会拿它去开文档。
- **artifact 的识别码**是相对于 change 的路径：`proposal.md`、`design.md`、`tasks.md`、`specs/<capability>/spec.md`。空文档也算存在。
- **只能用内置 schema。** 自己的 Store 没有本机 workspace，所以项目层与用户层的自订 schema 都读不到。
- **错误处理**：Store 方法抛错或 reject 时，进行中的 `dispatch` 会以 `Error` 拒绝，消息前面加上方法名，例如 `listChanges: connection refused`。
- **不要在 Store 方法里同步等待同一颗引擎的另一个 `dispatch`**，两边会互相等待而卡住。Store 方法回传之后再发新的 dispatch 没有问题。

下面是用 `Map` 存在内存的片段，示范 meta 的两种命名：

```js
const changes = new Map() // name → { metaText, artifacts: Map }

const store = {
  createChange(name, metaText) {
    // metaText 例如 "schema: spec-driven\ncreated: 2026-10-07\ncreated_by: Alice <alice@example.com>\n"
    changes.set(name, { metaText, artifacts: new Map() })
    return `changes/${name}`
  },
  findChange(name) {
    const c = changes.get(name)
    if (!c) return null
    const meta = parseYaml(c.metaText) // 用你惯用的 YAML 套件
    return { name, meta: { schema: meta.schema, created: meta.created, createdBy: meta.created_by } }
  },
  listChanges() {
    return [...changes.keys()].sort().map((name) => store.findChange(name))
  },
  changeExists: (name) => changes.has(name),
  readArtifact: (change, artifact) => changes.get(change)?.artifacts.get(artifact) ?? null,
  writeArtifact(change, artifact, content) {
    changes.get(change).artifacts.set(artifact, content)
    return `changes/${change}/${artifact}`
  },
  // ……其余必要方法依此类推
}
```

### `claim`（选配）

认领（claim）是团队系统的概念，由你的 Store 决定谁可以认领。实作 `claim(name)` 之后，`dispatch(['claim', '<name>'])` 会调用它：

- 成功时回传你自己的数据，例如 `{ claimed: true, claimedBy: 'alice' }`，SDK 原样交给调用端。
- 冲突时抛出带 `code` 的 `Error`（例如 `ownership_lost`），消息写明谁持有这个 change、该怎幺做。SDK 也原样传回。

没有实作 `claim` 时，这个动词以 `error` 失败。

## <a id="stamp"></a>品质关卡：`review` 与 `verify`

两个品质关卡各接上两个动词，参数和 CLI 相同：

```js
// 添加一轮：内容用 stdin 参数传入
await engine.dispatch(['review', 'add-round', 'add-auth', '--stdin'], { stdin: round })
// → { change: 'add-auth', round: 1 }

// 盖章：文档指纹放进 stdin 的 JSON
await engine.dispatch(['review', 'stamp', 'add-auth', '--agent', 'claude', '--stdin'], {
  stdin: JSON.stringify({
    scope: [{ path: 'src/auth.ts', hash: '<sha256>' }],
    missing: [],
  }),
})
// → { change: 'add-auth' }
```

- `scope` 是**你算好的文档指纹**。引擎看不到你的工作目录，所以不会替你计算。要和 CLI 兼容，就用文档内容的 SHA-256（十六进位）；文本档先把 CRLF 换成 LF。
- `missing` 列出工单范围里已经不存在的文档。`scope` 与 `missing` 合起来必须刚好等于工单涵盖的文档、而且不重复，否则拒绝。两个字段都可以省略（视为空清单），多出其他字段会以 `invalid_argv` 拒绝。
- 任务还没做完（标 `[M]` 的手动任务不算），或最后一轮还有 CRITICAL／WARNING 时，盖章会被拒绝。`--accept` 可以略过必修发现；SUGGESTION 本来就不挡。
- `reviewed_by`／`verified_by` 是创建引擎时的 `actor`；`--agent` 记在 `reviewed_with`／`verified_with`。
- 盖章需要 `readChangeMeta`、`writeChangeMeta`、`deleteArtifact` 三个方法，缺一个就在动手前拒绝，工单与 meta 都不会被改。
- 同一个引擎实例里的盖章会自动排队，不会互相覆盖。跨实例、跨进程对同一个 change 盖章时，由你的 Store 负责协调。

## <a id="render"></a>产生技能档

`skills` 用的是和 `specseal init`／`specseal update` 同一份产生进程，内容不会和 CLI 有落差。

```js
skills.list() // [{ name: 'analyze', description: '…' }, …]

const skillMd = skills.render('propose', { target: 'neutral', invocation: 'tool-call' })
```

| 选项 | 值 | 说明 |
| --- | --- | --- |
| `target` | `claude`、`codex`、`copilot`、`pi`、`cursor`、`neutral` | `neutral` 给自订工具用：没有 `/specseal-` 斜线指令，也不提 plan mode |
| `invocation` | `cli`（缺省）、`tool-call` | `tool-call` 把动词写成「调用 specseal 工具，参数是 argv 数组」，搭配以 `dispatch` 实作的工具；`cli` 写成 shell 指令 |
| `specDir` | 字符串 | 技能内文里的规格目录名，缺省 `specseal` |
| `toolName` | 字符串 | 只用于 `neutral`：技能内文里的工具名称，缺省 `specseal` |

把产生的 `SKILL.md` 写进一个目录，交给你的 agent 加载。每个技能的 `description` 说明什幺时候用它，结尾的 Next steps 说明之后建议做什幺，不需要另外的系统提示。前提是你的 agent 会读技能的 description。

## <a id="example"></a>完整范例：接上 Copilot SDK

一个名为 `specseal`、参数是 argv 数组的工具，加上产生好的技能档。Copilot SDK 的 API 以它的官方文档为准；这个范例对照的是 `@github/copilot-sdk` 1.0.16。

```js
const { createEngine, skills } = require('@specseal/engine')
const { CopilotClient, defineTool } = require('@github/copilot-sdk')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const engine = createEngine({ store: myDatabaseStore, actor: 'Alice <alice@example.com>' })

// 1. specseal 工具：argv 进、结果出；错误以文本交回 agent。
const specsealTool = defineTool('specseal', {
  description:
    'Run a specseal verb. Pass the argv array exactly as the skill says, ' +
    "e.g. ['status', '--change', 'add-auth', '--json'].",
  parameters: {
    type: 'object',
    properties: {
      argv: { type: 'array', items: { type: 'string' } },
      stdin: { type: 'string', description: 'Content for verbs that take --stdin' },
    },
    required: ['argv'],
  },
  async handler({ argv, stdin }) {
    try {
      return await engine.dispatch(argv, stdin === undefined ? undefined : { stdin })
    } catch (err) {
      return { error: err.message, code: err.code }
    }
  },
})

// 2. 产生技能档。
const skillsRoot = join(process.cwd(), '.my-agent', 'skills')
for (const { name } of skills.list()) {
  const dir = join(skillsRoot, `specseal-${name}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), skills.render(name, { target: 'neutral', invocation: 'tool-call' }))
}

// 3. 创建 session 时交给它工具与技能目录。
async function startSession() {
  const client = new CopilotClient()
  return client.createSession({ tools: [specsealTool], skillDirectories: [skillsRoot] })
}
```

技能用工具调用的方式描述动词，工具把调用送进同一个进程里的引擎，引擎再通过你的 Store 存盘。整条路上没有 CLI、没有子进程，也不需要本机的 `specseal/` 目录。

## <a id="limits"></a>目前的限制

- 需要 checkout 的动词不能通过 SDK 运行（见[运行动词](#dispatch)）。
- 自己的 Store 只能用内置 schema。
- 没有 musl Linux 的预编译套件。
- Store 方法抛错时，stderr 可能会多印一行 Rust 的 panic 消息；Promise 仍会照上面的规则拒绝。
- `dispatch` 的回传值没有个别的 TypeScript 类型，形状以[动词与旗标契约](verb-contract.zh-CN.md)为准。
