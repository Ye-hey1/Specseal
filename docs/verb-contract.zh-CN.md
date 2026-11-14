# 动词与旗标契约

**简体中文** · [English](verb-contract.md)

## <a id="audience"></a>这份文档给谁

要自己写客户端、自己架 server，或想用 HTTP 直接接 Speclink 的开发者看这份。只用桌面 app 或 CLI 的话可以跳过，日常操作看[完整 SDD 工作流](workflow.zh-CN.md)就够。

这份文档回答三件事：

- CLI 的每个动词在本机模式与远程模式能不能用、输出哪里不同。本机模式指文档存在 repo 里的 `speclink/`（或旧版创建的 `openspec/`）；远程模式指 `.speclink.yaml` 有 `remote:` 区段、文档存在 server 上。
- 远程 HTTP API 的共同规则、错误码与全部端点。
- 需要送 body 的端点，请求与回应长什幺样子。

官方 `speclink-server` 是参考实作，你可以照这份文档自建 server。这份文档与正式规格有出入时，以正式规格为准：

- [动词契约正式规格](../speclink/specs/verb-contract/spec.md)
- [客户端协定正式规格](../speclink/specs/client-protocol/spec.md)

架 server、创建访问密钥（PAT）的步骤见 [Remote 入门](remote-getting-started.zh-CN.md)。

## <a id="mode-assignment"></a>动词的模式归属

除了下表「只限本机」与「只限远程」两列，其他动词两种模式都能用。

| 归属 | 动词 | 在不支持的模式下运行 |
| --- | --- | --- |
| 只限本机 | `demo`、`trace`、`change rank`、`plan --strict-overlap` | 远程模式直接拒绝、非零结束，连一个请求都不送（脱机也一样拒绝） |
| 只限远程 | `claim` | 本机模式直接拒绝、非零结束，stderr 说明需要远程保存后端 |
| 两种模式都可用 | `list`、`show`、`validate`、`analyze`、`drift`、`archive`、`discard`、`artifact`、`language`、`status`、`instructions`、`new`、`workflow-config`、`task`、`in-progress`、`discuss`、`review`、`verify`、`plan`、`change`（`change depends` 与 `change schema`；`change rank` 除外） | 不适用。远程模式只读写 server，不会偷偷改用本机文档 |
| 不分模式 | `init`、`update`、`link`、`unlink`、`auth`、`schemas`、`templates`、`feedback`、`schema`、`config`、`completion` | 不适用。这些动词不碰保存后端 |

为什幺只限本机：

- `demo` 把示范变更写进本机的 `speclink/`。
- `trace` 从本机 `speclink/` 的封存变更与讨论档组出溯源链。
- `change rank` 写本机卡片的排序；远程的看板顺序存在 `/board-order`。
- `plan --strict-overlap` 依目录判断重叠；server 只依 requirement 判断。

`claim` 只限远程，因为「认领」记录的是团队里谁在做这个变更，本机没有这个状态。

## <a id="output-differences"></a>两种模式的输出差异

两种模式都可用的动词，给人看的输出（含 `--no-color`）应该一字不差。已知的差异只有下表。

| # | 动词 | 远程模式的不同 |
| --- | --- | --- |
| 1 | `new change` | 不印 `Path:` 行（server 上的路径对你没有意义） |
| 2 | `list` | 不出现 worktree 标示（worktree 属于本机 checkout） |
| 3 | `status --schema` | 拒绝；schema 由 server 的工作流设置决定 |
| 4 | `workflow-config` | 文档标签固定是 `config.yaml` |
| 5 | `discuss promote` | 不印 `Path:` 行，也不印它下一行的提示 |
| 6 | `plan --strict-overlap` | 拒绝，原因见上一节 |
| 7 | `list` | 本机缺省依最近修改排序；远程依名称排序。`--sort created` 与 `--sort modified` 在远程也是名称顺序 |
| 8 | `validate`（一次验多个变更） | 本机依最近修改排列结果；远程依名称排列。远程验变更时一律不严格，`--strict` 只对 `--specs` 有效 |
| 9 | `instructions --schema` | 拒绝，原因同第 3 项 |
| 10 | `archive` | 一次只封存一个，而且要写名字；`--all` 或多个名字会被拒绝。`--skip-specs`、`--no-validate`、`--mark-tasks-complete` 在远程不生效 |

第 1–6 项是正式规格明列的差异。第 7–10 项是目前进程的实际行为，正式规格还没列入。

`--json` 的字段集合与 camelCase 命名是冻结的契约：不改名、不删除既有字段，而且工单原文不会出现在任何 `--json` 输出里。

## <a id="request-rules"></a>请求的共同规则

### 网址

每个项目的 API 都在这个网址底下：

```text
https://<server>/api/speclink/v1/projects/<项目代号>
```

下文端点表的路径都接在它后面。CLI 的 `.speclink.yaml` 里 `remote.url` 存的就是这个网址（由 `speclink link <url>` 写入）。

### 每个请求都要带的标头

| 标头 | 值 | 缺少或错误时 |
| --- | --- | --- |
| `Authorization` | `Bearer <凭证>` | 401 `permission_denied` |
| `X-Speclink-Api-Version` | `1` | 409 `refused`（版本不兼容） |
| `X-Speclink-Repo` | 保存库代号 | 项目只有一个 repo 时可省略；有多个 repo 却省略回 409 `refused`；写了没注册的 repo 回 404 `not_found` |
| `Content-Type` | `application/json`（有 body 时） | 415，回应是纯文本 |

凭证有两种：访问密钥（PAT，`spk_pat_` 开头，在 server 的帐号页创建），或 `speclink auth login` 取得的设备登录凭证（`spk_at_` 开头）。凭证有效但帐号不是这个项目的成员，回 403。

### 角色

项目成员有 `reader` 与 `editor` 两种角色。reader 只能读：所有写入端点（方法不是 GET 的端点）都要 editor，reader 调用会收到 403 `permission_denied`，`message` 为 `your role in project '<代号>' is reader; this action needs the editor role`，server 什幺都不写。唯一的例外是 `POST /context`：它用 POST 发送查找条件，但只读数据，reader 照常可用。

### 握手

连上之后先调用 `GET /binding`。它告诉你目前是谁、绑到哪个项目与 repo、server 版本，以及依角色开放的能力：

```json
{
  "actor": { "id": "usr_…", "name": "Demo" },
  "project": { "id": "prj_acme", "key": "acme", "name": "acme" },
  "repo": { "id": "repo_backend", "key": "backend", "name": "backend" },
  "apiVersion": "1",
  "engineVersion": "0.8.0",
  "capabilities": {
    "contextSnapshots": true,
    "policyWrite": true,
    "validate": true,
    "analyze": true,
    "deleteChange": true,
    "moveTask": true,
    "authentication": [],
    "events": {
      "transports": [{ "type": "sse", "url": "/events", "resume": true }],
      "polling": { "url": "/sync-state", "etag": true }
    }
  }
}
```

- `apiVersion` 与你送出的版本不同时，客户端应该停下来，不要继续调用其他端点。
- `policyWrite`、`deleteChange`、`moveTask` 只有 editor 是 `true`；`validate`、`analyze` 对所有角色都是 `true`。
- `capabilities` 只是让画面停用按钮的提示。真正的权限检查发生在每个请求上。

### ETag 与写入前的版本检查

ETag 是 HTTP 回应标头，用来判断数据有没有变。

- 成功回应大多带 `ETag`，值是项目修订号，例如 `"16"`。项目里任何一次写入都会让它变大。`GET /binding` 与 `GET /events` 不带 `ETag`。
- 想知道数据有没有变：调用 `GET /sync-state` 并带 `If-None-Match: <ETag>`，没变回 304。`POST /context` 也接受 `If-None-Match`。
- 写入前要附版本的端点只有三个，而且带法不同：

| 端点 | 版本放在哪里 | 版本从哪里来 |
| --- | --- | --- |
| `PUT /changes/{name}/artifacts/{artifact}` | `If-Match: <数字>`，不加引号 | 同一份 artifact 的 `GET` 回应里的 `version`；`0` 代表「只能新建」 |
| `PUT /board-order` | `If-Match: <ETag>`，引号可有可无 | 任一回应的 `ETag`，例如 `GET /board-order` |
| `PUT /config` | body 的 `expectedRevision` | `GET /config` 回应里的 `revision` |

版本对不上时回 409 `revision_conflict`，什幺都不写。前两个端点缺 `If-Match` 时回 400 `invalid_argument`。其他写入端点不检查版本。

## <a id="repo-ownership"></a>变更的 repo 归属

每个变更恰好属于一个 repo；同时牵涉两个 repo 的需求，要拆成多个变更。

- 远程模式创建变更（`POST /changes`）时，归属取自请求的 `X-Speclink-Repo`。项目只有一个 repo 时自动用那一个。回应的 `repo` 字段会回报归属。
- 枚举变更（`GET /changes`）只回请求那个 repo 的变更，其他 repo 的变更不会出现。
- 一个需求要同时改两个 repo（例如 backend 与 frontend）时，拆成两个变更，各自在自己的 repo 创建。契约没有「跨 repo 的变更」。
- 不只变更：讨论、正式规格、封存、工作流设置与看板顺序也都分 repo 存放。
- CLI 送出的 repo 名称来自 `.speclink.yaml` 的 `remote.repo`，用 `speclink link <url> --repo <名称>` 设置。

## <a id="errors"></a>错误封套与错误码

非 2xx 的回应都是同一个 JSON 形状，叫作错误封套：

```json
{ "status": 409, "reason": "refused", "message": "change 'add-login' has started work (started_at set or tasks checked) — discard refuses to delete it; pass --force to discard anyway" }
```

- `reason` 给进程判断，`message` 给人看（与本机 CLI 印的是同一句）。
- `reason` 只有下表八个值。收到不认得的值，当成一般错误、显示 `message` 即可。
- `DELETE /changes/{name}/in-progress` 被拒时，封套会多带 `checkedTasks` 与 `touchedFiles` 两个字段。
- 例外：请求 body 本身格式错误时，回应是纯文本而不是封套。例如缺 `Content-Type: application/json` 回 415，缺必填字段回 422。

| `reason` | HTTP | 什幺时候发生 |
| --- | --- | --- |
| `permission_denied` | 401 | 没带凭证，或凭证无效、过期、已撤销，或帐号已停用 |
| `permission_denied` | 403 | 帐号不是这个项目的成员；reader 调用写入端点 |
| `not_found` | 404 | 项目或 repo 没有注册；变更、讨论、artifact 或规格不存在 |
| `invalid_argument` | 400 | 参数值不对：slug 格式错、缺 `If-Match`、`If-Match` 不是数字、未知的 artifact、搜索关键字是空的；或写入的内容格式不对：`tasks.md` 没有 `- [ ]` 核取方块、proposal 缺 `## Why`／`## Problem`／`## Summary`、design 缺 `## Context`、delta spec 没有操作区段、审查站或验证站的轮缺 `**Scope**:` 行、轮的 `**Phase**:` 与工单状态不符，或套用规则记录有误（`**Rules**:`／`**Rule**:` 行格式错误，或出现在首轮以外的轮） |
| `invalid_config` | 422 | 变更的 metadata 坏掉；工作流设置文档解析不了 |
| `refused` | 409 | 前置条件不成立：API 版本不符、多 repo 却没指定 repo、需要 `force`、任务序号超出范围、变更已被别人认领、依赖成环、导入的目标不是空的 |
| `refused` | 413 | 请求 body 超过 32 MiB，或看板顺序内容超过 1 MiB |
| `revision_conflict` | 409 | 写入时附的版本已经不是最新（见[请求的共同规则](#request-rules)） |
| `unavailable` | 503 | 保存后端暂时无法服务 |
| `internal` | 500 | 其他失败 |

## <a id="endpoints"></a>端点总表

路径都接在[项目网址](#request-rules)后面。`{name}` 是变更名称，`{slug}` 是讨论代号，`{artifact}` 是 `proposal`、`design`、`tasks` 或 `specs/<capability>`。「最低角色」写 `reader` 代表所有成员都能调用。

### 连接与同步

| 方法 | 路径 | 最低角色 | 用途 |
| --- | --- | --- | --- |
| GET | `/binding` | reader | 握手：身分、项目、repo、版本与能力 |
| GET | `/whoami` | reader | 目前用户，以及这个项目的所有 repo |
| GET | `/sync-state` | reader | 只回 `ETag`；带 `If-None-Match` 且没变时回 304 |
| GET | `/events` | reader | SSE 事件流，见下方[事件流](#events) |
| POST | `/context` | reader | 一次取回一致的文档快照；body 可带 `change` 缩小范围 |

### 变更

| 方法 | 路径 | 最低角色 | 用途 |
| --- | --- | --- | --- |
| GET | `/changes` | reader | 列出这个 repo 的变更（`speclink list`） |
| POST | `/changes` | editor | 创建变更（`speclink new change`） |
| GET | `/changes/{name}` | reader | 单一变更的状态与 metadata（`speclink status`、`show`） |
| DELETE | `/changes/{name}?force=<bool>` | editor | 舍弃变更（`speclink discard`） |
| GET | `/changes/{name}/drift` | reader | 规格那一侧的偏移数据（`speclink drift`） |
| GET | `/changes/{name}/validate` | reader | 验证单一变更（`speclink validate`） |
| GET | `/changes/{name}/analyze` | reader | 交叉分析报告（`speclink analyze`） |
| GET | `/changes/{name}/instructions/{kind}` | reader | 产出指示；`{kind}` 是 `proposal`、`design`、`specs` 或 `tasks`，写 `apply` 时回实作进度（`speclink instructions`） |
| GET | `/changes/{name}/artifacts/{artifact}` | reader | 读 artifact 内容与 `version`（`speclink artifact cat`） |
| PUT | `/changes/{name}/artifacts/{artifact}` | editor | 写 artifact，需带 `If-Match` |
| GET | `/changes/{name}/evidence` | reader | 完成证据：勾选任务时记下的文档 |
| POST | `/changes/{name}/in-progress` | editor | 标记开工（`speclink in-progress add`） |
| DELETE | `/changes/{name}/in-progress` | editor | 移除开工标记（`speclink in-progress remove`） |
| POST | `/changes/{name}/claim` | editor | 认领（`speclink claim`） |
| POST | `/changes/{name}/depends` | editor | 声明或移除前置变更（`speclink change depends`） |
| POST | `/changes/{name}/schema` | editor | 切换变更的 schema（`speclink change schema`） |
| POST | `/changes/{name}/archive?carryReview=<bool>&carryVerify=<bool>` | editor | 封存（`speclink archive`） |

### 任务

| 方法 | 路径 | 最低角色 | 用途 |
| --- | --- | --- | --- |
| POST | `/changes/{name}/tasks/{taskId}/done` | editor | 勾选任务（`speclink task done`）；`{taskId}` 是序号或 `tsk_` 开头的稳定 ID |
| POST | `/changes/{name}/tasks/{taskId}/undone` | editor | 取消勾选（`speclink task undone`） |
| POST | `/changes/{name}/tasks/move` | editor | 搬移任务并重排编号（桌面 app 的拖曳） |

### 品质关卡

`{station}` 是 `review`（审查）或 `verify`（验证），两站的端点与 payload 相同。

| 方法 | 路径 | 最低角色 | 用途 |
| --- | --- | --- | --- |
| GET | `/changes/{name}/{station}` | reader | 读工单（`speclink review show`） |
| POST | `/changes/{name}/{station}/rounds` | editor | 添加一轮（`speclink review add-round`） |
| POST | `/changes/{name}/{station}/stamp` | editor | 盖章（`speclink review stamp`） |
| DELETE | `/changes/{name}/{station}` | editor | 丢弃工单（`speclink review discard`） |

### 讨论

| 方法 | 路径 | 最低角色 | 用途 |
| --- | --- | --- | --- |
| GET | `/discussions?archived=<bool>` | reader | 列出讨论；`archived=true` 列出封存的讨论 |
| POST | `/discussions` | editor | 创建讨论（`speclink discuss new`） |
| GET | `/discussions/search?q=<关键字>` | reader | 搜索讨论，多个关键字以空白分隔（`speclink discuss search`） |
| GET | `/discussions/{slug}` | reader | 读单一讨论与全文（`speclink discuss show`） |
| DELETE | `/discussions/{slug}?force=<bool>` | editor | 删除讨论（`speclink discuss discard`） |
| PUT | `/discussions/{slug}/context` | editor | 写背景段（`speclink discuss context`） |
| POST | `/discussions/{slug}/rounds` | editor | 添加一轮（`speclink discuss add-round`） |
| POST | `/discussions/{slug}/conclude` | editor | 写结论（`speclink discuss conclude`） |
| POST | `/discussions/{slug}/archive` | editor | 封存讨论（`speclink discuss archive`） |
| POST | `/discussions/{slug}/promote` | editor | 转为变更（`speclink discuss promote`） |
| POST | `/discussions/{slug}/link` | editor | 把既有变更连到这个讨论（`speclink discuss link`） |
| POST | `/discussions/{slug}/seal` | editor | 内容写好后，把讨论标为已转出变更（`speclink discuss seal`） |

### 项目层数据

| 方法 | 路径 | 最低角色 | 用途 |
| --- | --- | --- | --- |
| GET | `/plan` | reader | 变更的运行顺序（`speclink plan`） |
| GET | `/specs` | reader | 正式规格清单 |
| GET | `/specs/{capability}/document` | reader | 一份正式规格的全文 |
| GET | `/archived` | reader | 已封存变更清单 |
| GET | `/archived/{datedName}/artifacts/{path}` | reader | 已封存变更里的一份文档，`{path}` 例如 `proposal.md` |
| GET | `/archived/{datedName}/capabilities` | reader | 该次封存动到的 capability 名称 |
| GET | `/search?q=<文本>` | reader | 桌面 app 的全文搜索（只搜在途的变更与讨论） |
| GET | `/language` | reader | 共用词汇文档（`speclink language show`） |
| GET | `/config` | reader | 工作流设置原文与修订号 |
| PUT | `/config` | editor | 写工作流设置（`speclink workflow-config set`） |
| GET | `/board-order` | reader | 看板顺序 |
| PUT | `/board-order` | editor | 整份取代看板顺序，需带 `If-Match` |
| POST | `/import` | editor | 把本机项目整包搬上 server（桌面 app 使用）；目标 repo 必须是空的 |

### 项目网址以外的端点

这几个端点直接接在 `https://<server>` 后面：

| 方法 | 路径 | 需要什幺 | 用途 |
| --- | --- | --- | --- |
| GET | `/healthz` | 不需要 | 进程在运行就回 200 |
| GET | `/readyz` | 不需要 | 保存后端可用才回 200，否则 503 |
| GET | `/auth/whoami` | 只需凭证 | 凭证属于谁（还没选项目时用） |
| GET | `/api/speclink/v1/scopes` | 只需凭证 | 这个帐号看得到的项目与 repo |

`/auth/device`、`/auth/device/token`、`/auth/refresh` 与 `/auth/revoke` 是 `speclink auth login` 用的设备登录流程。

### <a id="events"></a>事件流

`GET /events` 是 SSE（Server-Sent Events：server 通过一条长连接持续推送事件）。

- `invalidate` 事件：某个资源变了。`data` 例如 `{"eventId":"42","scope":"change","resourceId":"add-login","revision":42}`，`scope` 是 `change`、`discussion` 或 `spec`。收到后重新读取对应资源。
- `reset` 事件：你的续传位置已被清掉，请重新读取全部数据。
- 断线重连时带 `Last-Event-ID`，可以补收中间漏掉的事件。
- 闲置时 server 会送 heartbeat 注解行，维持连接。

## <a id="payload-examples"></a>请求与回应范例

以下范例的字段形状取自官方 server 的实际回应。请求 body 栏写「无」的端点，送 `{}` 或不送都可以；其他端点一定要送 JSON body，并带 `Content-Type: application/json`。

### 变更与任务

| 端点 | 请求 body | 成功回应 |
| --- | --- | --- |
| `POST /changes` | `{"name":"add-login","agent":"claude"}` | `{"name":"add-login","schema":"spec-driven","repo":"backend"}` |
| `DELETE /changes/{name}?force=true` | 无 | `{"change":"add-search-bar","unlinkedDiscussions":[{"slug":"board-search-bar","status":"concluded"}]}` |
| `POST /changes/{name}/claim` | 无 | `{"claimedBy":"Demo <demo@example.com>"}` |
| `POST /changes/{name}/depends` | `{"on":["add-login"],"remove":false}` | `{"change":"add-logout","dependsOn":["add-login"]}` |
| `POST /changes/{name}/schema` | `{"schema":"no-spec-change"}` | `{"change":"tidy","schema":"no-spec-change","previous":"spec-driven","changed":true,"verifyStampCleared":false}` |
| `POST /changes/{name}/in-progress` | 无 | `{}` |
| `DELETE /changes/{name}/in-progress` | 无 | `{"removed":true}`；本来就没开工时是 `{"removed":false}` |
| `POST /changes/{name}/archive` | 无 | `{"specs":[],"datedName":"2026-10-07-fix-typo","snapshotCreated":false,"archivedDiscussions":[],"evidenceRecorded":false}` |
| `POST /changes/{name}/tasks/{taskId}/done` | `{"touchedFiles":["src/login.rs"],"headCommit":"0123…"}` | `{"taskDesc":"1.1 Add the login form","alreadyDone":false}` |
| `POST /changes/{name}/tasks/{taskId}/undone` | 无 | `{"taskDesc":"1.1 Add the login form","alreadyUndone":false}` |
| `POST /changes/{name}/tasks/move` | `{"from":2,"to":1}` | `{"change":"add-login","description":"1.1 Add the session check"}` |

补充：

- `POST /changes` 的选填字段：`schema`、`description`、`agent`、`fromDiscussion`（来源讨论代号）、`last`（搭配 `fromDiscussion`，表示这是结论规划的最后一个变更）。
- `DELETE /changes/{name}` 的 `force` 缺省 `false`。变更已开工（有开工标记或任一任务已勾）时，不带 `force=true` 会回 409 `refused`，什幺都不删。metadata 坏掉时，即使 `force=true` 也回 422 `invalid_config`。回应的 `unlinkedDiscussions` 列出被解除链接的来源讨论，以及解除后的状态。
- `POST /changes/{name}/claim`：同一个人重复认领，照样成功、不重写；别人已认领时回 409 `refused`，`message` 写出目前的持有人。
- `POST /changes/{name}/depends`：`on` 必填，`remove` 缺省 `false`。自己依赖自己、目标不存在或已封存、依赖成环，都回 409 `refused`。
- `POST /changes/{name}/schema`：server 只解析内置的 schema。schema 找不到、要切到没有 specs 的 schema 而变更带着 delta spec、有未结的验证工单，都回 409 `refused`。切到同一个 schema 时回 200、`changed` 为 `false`，server 不写入。这次切换移除了验证章时，`verifyStampCleared` 为 `true`。
- `POST /changes/{name}/in-progress`：重复调用，或变更名称不存在，照样回 200 `{}`，什幺都不写。
- `DELETE /changes/{name}/in-progress`：还有勾选的任务或记录过的文档时回 409 `refused`，封套多带 `"checkedTasks":1,"touchedFiles":["src/login.rs"]`。
- `POST /changes/{name}/archive`：`specs` 的每一项有 `capability`，以及 `added`、`modified`、`removed`、`renamed` 四个 requirement 数量。`carryReview=true`、`carryVerify=true` 表示即使该站还有未结的工单也封存，工单跟着变更一起搬进封存区。
- `tasks/{taskId}/done`：`touchedFiles` 是这个任务动到的文档，`headCommit` 是你看到那些文档时的 commit；两者都可省略，但 body 至少要送 `{}`。任务已勾时照样回 200，`alreadyDone` 为 `true`。
- `tasks/move`：`from`、`to` 是从 1 起算的任务序号；选填的 `before` 为 `true` 时插在目标任务之前，`false` 插在之后，省略时依搬移方向判断。序号超出范围回 409 `refused`。

### 写入 artifact

先读，拿到 `version`：

```text
GET /changes/add-login/artifacts/tasks
→ {"artifact":"tasks","content":"## 1. Login\n\n- [ ] 1.1 Add the login form <!-- speclink-task:tsk_01M4… -->\n…","version":2}
```

再带着 `version` 写回：

```text
PUT /changes/add-login/artifacts/tasks
If-Match: 2
{"content":"## 1. Login\n\n- [ ] 1.1 Add the login form\n…"}
→ {"artifact":"tasks","version":<新的版本号>}
```

- 新建一份还不存在的 artifact 时用 `If-Match: 0`。
- 写入 `tasks.md` 时，server 会在每个任务行尾补上稳定 ID 注解（`<!-- speclink-task:tsk_… -->`）。

### 品质关卡

| 端点 | 请求 body | 成功回应 |
| --- | --- | --- |
| `POST /changes/{name}/review/rounds` | `{"content":"<一轮工单的 Markdown>"}` | `{"round":1}` |
| `POST /changes/{name}/review/stamp` | `{"accept":false,"agent":"claude-code","scope":[{"path":"src/login.rs","hash":"<64 字符>"}],"missing":[]}` | `{"change":"add-login"}` |
| `DELETE /changes/{name}/review` | 无 | `{"change":"add-login"}` |

- 一轮的内容格式与 `speclink review add-round` 从 stdin 收的内容相同，必须有 `**Scope**:` 行。
- `GET /changes/{name}/review` 回 `change`、`rounds`、`lastRound` 与 `content`（工单原文）。每一轮有 `index`、`phase`、`patchHash`、`rules`、`scope` 与 `findings`（每项 `severity`、`path`、`text`）。`rules` 为 null，或是带 `baseline`（`extend` 或 `replace`）与 `critical`、`warning`、`suggestion` 三个清单的对象；只有记录了套用规则的首轮才有对象。
- 盖章的 `scope` 是工单各轮 Scope 列过的文档，在你工作目录里的内容指纹。`hash` 是文档内容的 SHA-256（小写十六进位）；UTF-8 文本档先把 CRLF 换成 LF 再算。
- 工作目录里已经不存在的文档放进 `missing`。`scope` 加 `missing` 必须刚好等于工单列过的文档；server 不重算指纹，只检查文档集合。
- 盖章前，变更的写码任务必须全部完成。`accept: true` 表示最后一轮还有必须修的发现（CRITICAL／WARNING）也照样盖章。

### 讨论

| 端点 | 请求 body | 成功回应 |
| --- | --- | --- |
| `POST /discussions` | `{"topic":"看板搜索列","slug":"board-search-bar"}` | `{"slug":"board-search-bar","topic":"看板搜索列","path":"discussions/board-search-bar.md"}` |
| `PUT /discussions/{slug}/context` | `{"content":"…"}` | `{}` |
| `POST /discussions/{slug}/rounds` | `{"mode":"interview","content":"…"}` | `{"round":1}` |
| `POST /discussions/{slug}/conclude` | `{"content":"…","hold":true}` | `{"restaleFlagged":[],"held":true}` |
| `POST /discussions/{slug}/promote` | `{"name":"add-search-bar"}` | `{"change":"add-search-bar"}` |
| `POST /discussions/{slug}/link` | `{"change":"add-auth"}` | `{"slug":"auth-scope","change":"add-auth"}` |
| `POST /discussions/{slug}/seal` | `{"change":"add-auth"}` | `{"slug":"auth-scope","change":"add-auth"}` |
| `POST /discussions/{slug}/archive` | 无 | `{"archivedTo":"discussions/archive/<文档名>"}` |
| `DELETE /discussions/{slug}?force=true` | 无 | `{"slug":"board-search-bar"}` |

- `POST /discussions`：`slug` 选填，省略时由 `topic` 推导；必须是小写英数字以单一连字号分隔，不合格回 400 `invalid_argument`。选填 `kind` 目前只接受 `improve`。
- `conclude`：`hold: true` 表示结论之后记录保留在途，还欠尚未创建的变更。回应的 `restaleFlagged` 列出因重写结论而被打回的变更；`autoArchived: true` 只在结论顺便封存了记录时出现。
- `promote`：`name` 选填。`promote` 与 `seal` 都接受选填的 `last: true`，表示这是结论规划的最后一个变更，会解除记录的保留旗标。
- `seal`：变更必须先用 `link` 连到这个讨论，否则回 409 `refused`。
- `DELETE /discussions/{slug}`：`force` 缺省 `false`。已有轮的讨论不带 `force=true` 会回 409 `refused`；封存的讨论不能删，也回 409 `refused`。

### 项目层数据

| 端点 | 请求 body | 成功回应 |
| --- | --- | --- |
| `PUT /config` | `{"content":"schema: spec-driven\n","expectedRevision":16}` | `{"revision":17}` |
| `PUT /board-order`（加 `If-Match: "16"`） | `{"content":"{\"changes\":{\"add-logout\":\"a\"}}"}` | `{"revision":17}` |

- `PUT /config` 收整份设置文档；server 先解析，解析不了回 422 `invalid_config`。
- `POST /context` 的 body 可带 `change`，只取这个变更的文档；送 `{}` 就取全部。回应有 `snapshotId`、`digest` 与 `documents`，每份文档有 `path`、`content`、`revision` 与 `digest`。CLI 用它把 server 上的文档镜像到本机的唯读目录 `.speclink/context/`。
- 看板顺序的 `content` 是一段 JSON 文本，形如 `{"changes":{"<变更>":"<排序键>"},"discussions":{…}}`。server 只存不解析；`GET /plan` 读取时看不懂的内容一律当作没有排序。

`GET /changes/{name}/validate` 的回应：

```json
{ "change": "add-login", "valid": true, "errors": [], "warnings": ["No delta specs found"] }
```

端点一次只验一个变更。想一次验多个，先 `GET /changes` 再逐一调用，CLI 的 `validate --all` 就是这样做。

`GET /plan` 的回应：

```json
{
  "waves": [{ "index": 1, "changes": ["add-login"] }, { "index": 2, "changes": ["add-logout"] }],
  "changes": [
    { "name": "add-login", "wave": 1, "stage": "in-progress", "dependsOn": [], "overlaps": [], "blockedBy": [], "ready": true, "requirementOverlap": [], "archiveAfter": [] },
    { "name": "add-logout", "wave": 2, "stage": "proposed", "dependsOn": ["add-login"], "overlaps": [], "blockedBy": ["add-login"], "ready": false, "requirementOverlap": [], "archiveAfter": [] }
  ],
  "next": null,
  "skipped": []
}
```

依赖成环时回 409 `refused`，`message` 例如 `dependency cycle: add-login -> add-logout -> add-login`。

## <a id="response-fields"></a>清单与详情的选填字段

下列选填字段没有值时，整个键都不出现。客户端遇到缺席的字段，不要自己补默认值。

### `GET /changes` 的每一项

必定出现：`name`、`summary`、`status`、`completedTasks`、`totalTasks`。

选填：

| 字段 | 内容 |
| --- | --- |
| `startedAt` | 开工日期，格式 `YYYY-MM-DD`；没开工就不出现 |
| `createdBy`、`created` | 创建者与创建日期 |
| `fromDiscussions` | 来源讨论代号清单 |
| `claimedBy` | 认领人；没人认领就不出现 |
| `deltaCapabilities` | 这个变更的 delta 规格动到的 capability |
| `restaleFrom` | 重写了结论、需要这个变更重新吸收内容的来源讨论代号 |
| `metaError` | metadata 坏掉时的原因 |

```json
{ "name": "add-login", "summary": "", "status": "in-progress", "completedTasks": 0, "totalTasks": 2, "startedAt": "2026-10-07", "createdBy": "Demo <demo@example.com>", "created": "2026-10-07" }
```

### `GET /changes/{name}`

必定出现：`changeName`、`schemaName`、`isComplete`、`applyRequires`、`artifacts`（每项 `id`、`outputPath`、`status`，被挡住时多 `missingDeps`）。

八个选填字段：`created`（只有 metadata 同时记了 schema 与创建日期时才出现）、`fromDiscussions`、`deltaCapabilities`、`createdBy`、`createdWith`、`startedAt`、`startedBy`、`claimedBy`。CLI 远程模式的 `show` 与桌面 app 的详情页都靠这些字段。

```json
{ "changeName": "add-login", "schemaName": "spec-driven", "isComplete": false, "applyRequires": ["tasks"], "artifacts": [{ "id": "tasks", "outputPath": "tasks.md", "status": "done" }], "created": "2026-10-07", "createdBy": "Demo <demo@example.com>", "createdWith": "claude", "startedAt": "2026-10-07", "startedBy": "Demo <demo@example.com>" }
```

### `GET /discussions` 的每一项

必定出现：`slug`、`topic`、`status`、`rounds`、`created`、`path`、`archived`。官方 server 也一定会填 `concluded`（结论段是否已写）与 `hold`（是否保留在途）。

选填：`createdBy`、`kind`（改进讨论为 `improve`），以及 `promotedTo`——这则讨论已转出的变更名称，依转出先后排列。`promotedTo` 直接取自讨论记录，没有转出过就不出现。

```json
{ "slug": "board-search-bar", "topic": "看板搜索列", "status": "promoted", "rounds": 1, "created": "2026-10-07", "createdBy": "Demo <demo@example.com>", "promotedTo": ["add-search-bar"], "concluded": true, "hold": true, "path": "discussions/board-search-bar.md", "archived": false }
```

### `speclink list --json` 的本机 `worktree` 字段

本机模式的 `list --json` 可能在某个变更上多一个 `worktree` 对象，表示这个变更正在某个 git worktree 里实作：

```json
{ "completedTasks": 3, "name": "add-dark-mode", "status": "in-progress", "totalTasks": 5, "worktree": { "path": "/path/to/speclink.worktrees/add-dark-mode", "branch": "speclink/add-dark-mode" } }
```

- `path` 是 worktree 目录的绝对路径，`branch` 是完整分支名（`speclink/<变更>`）。
- 只在这些条件都成立时出现：本机模式、从主 checkout 运行、工作流设置打开 `worktree`，而且找得到这个变更对应的 worktree。其他情况整个键都不出现。
- 远程模式的 `list` 永远不带这个字段，因为 server 不知道你本机的 checkout。所以没有 worktree 时，两种模式的输出逐栏一致。
- 字段出现时，这一项的 `completedTasks`、`totalTasks`、`status` 与 `metaError` 取自 worktree 里的副本，不是主 checkout 的。
