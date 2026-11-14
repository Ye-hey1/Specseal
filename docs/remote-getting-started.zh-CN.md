# Remote 入门：Server、Desktop 与 CLI

**简体中文** · [English](remote-getting-started.md)

照这份文档做一次，你会在自己的电脑上起一台 Speclink server，再用 Desktop 和 CLI 连上同一个项目。每一步都附上你该看到的结果。不需要 server 的本地路径见 [Local Repo 入门](getting-started.zh-CN.md)；哪些能力现在能用，以[项目能力状态](product-status.zh-CN.md)为准。

这里用的 `speclink-server` 是官方的**参考实作**，让你开箱即用、试远程功能。远程模式不绑这一份 server：它由 `speclink/specs/` 底下的两份公开契约 `host-runtime` 与 `client-protocol` 定义。你可以用 Speclink 引擎自己写 server，接上自家的认证、数据库与权限模型，CLI 与 Desktop 一样接得上。下面的画面与指令属于官方 server；连上之后 CLI 与 Desktop 的行为由契约决定，换成自建 server 也一样。

## <a id="before-you-begin"></a>开始前

你需要：

- Node.js 18 以上，用来运行 `npx @speclink/server`。不需要 clone 这个 repo。
- `speclink` CLI，安装方式见 [README](../README.zh-CN.md#install)。
- Desktop app（选用）。

接上远程之后，规格与变更都存在 server 上。本机不会留一份可写的副本，所有写入都经过 server。

全文会用到三种网址。它们的用途不同，不要混用：

| 名称 | 范例 | 用在哪里 |
| --- | --- | --- |
| Server base URL | `http://localhost:8080` | Desktop 添加连接、`curl` 健康检查 |
| 浏览器页面网址 | `http://localhost:8080/account`、`http://localhost:8080/admin/users` | 用浏览器开，登录后操作 |
| project-scoped URL | `http://localhost:8080/api/speclink/v1/projects/demo` | CLI 的 `speclink link` |

project-scoped URL 等于 Server base URL 加上 `/api/speclink/v1/projects/<项目代号>`。

## <a id="start-server"></a>1. 启动 server

找一个空文档夹，运行：

```bash
npx @speclink/server
```

**预期输出**：一行首次启动消息，里面有一次性的设置链接。

```text
Speclink 首次启动：打开 http://localhost:8080/setup?token=spk_setup_… 完成初始设置（此链接 24 小时内有效，且仅显示这一次）。
```

这个链接只印这一次，24 小时内有效。先把它拷贝下来。

目前文档夹同时多了 `speclink-data/`，所有数据都在里面：

- `config.yaml`：启动器依环境变量产生的组态档。每次不带参数启动都会重新产生，手改的内容会被盖掉。
- `store.db`：项目数据（规格、变更等）。旁边的 `store.db-wal` 与 `store.db-shm` 是 SQLite 的工作档。
- `identity.db`：帐号、成员资格与凭证。

server 缺省只听 `127.0.0.1:8080`，只有这台电脑连得到。要换端口就用 `SPECLINK_PORT=8090 npx @speclink/server`，后面所有网址的端口也跟着换。其他设置与给团队用的部署方式，见 [Server 部署](server-deployment.zh-CN.md)。

让这个终端机保持运行。按 `Ctrl+C` 会正常停止 server。

开另一个终端机，确认 server 活着：

```bash
curl -o /dev/null -w "%{http_code}\n" http://localhost:8080/healthz
```

**预期输出**：`200`。

## <a id="first-run-setup"></a>2. 完成初始设置

用浏览器开刚才的设置链接。网址列的主机要和链接一样是 `localhost`，不要改成 `127.0.0.1`；不一样的话，送出表单会被当成跨来源请求拒绝。

画面分两步：

1. 创建管理员帐号：填 email、显示名称与密码。
2. 创建第一组项目与保存库：本文的项目代号用 `demo`，保存库代号用 `backend`。代号创建后不能改；名称留空会沿用代号。

![Speclink server 的初始设置画面，第二步创建项目与保存库](assets/screenshots/zh-TW/server-setup.png)

完成后，浏览器会以管理员身分进入管理主控台的总览。最上面的「开始使用」区块列出服务网址、项目代号与保存库代号。这个区块只在刚完成设置时出现这一次，可以顺手记下来。

依本文的范例，CLI 要用的 project-scoped URL 是 `http://localhost:8080/api/speclink/v1/projects/demo`。

## <a id="grant-membership"></a>3. 把自己加进项目（必做）

初始设置创建了你的管理员帐号和 `demo` 项目，但**没有**让你成为 `demo` 的成员。成员资格（membership）是另一层权限，管理员身分也不会略过它。

没有成员资格时，你会看到：

- 读取项目资源得到 `403`（`permission_denied`），不是 404。404 只代表项目代号不存在。
- Desktop 的 Project／Repo 清单是空的。
- CLI 的 `speclink auth login` 或 `speclink auth status` 回 `access denied`。

所以这一步一定要做：

1. 用浏览器开 `http://localhost:8080/admin/users`。
2. 点你自己的帐号，进入用户详情页，切到「成员资格」分页。
3. 在最后一列「加入项目」的下拉列表选 `demo`，角色维持 `editor`，按「加入」。

角色只有两种：

- `editor`：可以读，也可以写。
- `reader`：只能读。

成员资格以项目为单位，项目里的每个保存库都适用。`/admin/registry` 的项目详情页列出这个项目的保存库与成员：

![Server 后台的项目详情页，列出项目的保存库](assets/screenshots/zh-TW/server-project.png)

要让同事加入，在同一页按「邀请用户」，在对话框填电子邮件与显示名称，从「加入项目」下拉列表逐一选要加入的项目，再按「送出邀请」。对话框会显示一次性的邀请链接，关掉前先拷贝，交给对方完成注册；对方接受后就是那些项目的 `editor`。命令行的做法见 [Server 部署](server-deployment.zh-CN.md#manage)。

## <a id="access-key"></a>4. 创建访问密钥（给 CI 用）

日常登录用不到访问密钥（PAT，Personal Access Token）。Desktop 与 CLI 缺省走设备登录：在浏览器按一次「核准」就好。访问密钥是给 CI 或没有浏览器的环境用的；现在用不到的话，可以直接跳到下一步。

创建方式：

1. 用浏览器开 `http://localhost:8080/account`。
2. 按页面上方的「创建访问密钥」，在对话框填名称。到期日可以留空，代表永久有效。
3. 按「创建」，立刻拷贝对话框里的密钥。它只显示这一次，关掉对话框就拿不回来。

按下创建时，页面在背景送出 POST `/api/speclink/v1/web/account/tokens`。这个网址只接受 POST，不是可以直接开的页面；用浏览器直接开它，会得到 `405 Method Not Allowed`。

使用时记住三件事：

- 密钥没有自己的权限范围。用它连接时，权限等于你的帐号在各项目的成员资格。
- 只把密钥贴进 app 的输入框，或从标准输入（stdin）交给 CLI。不要放进网址、`.speclink.yaml`、repo 或文档范例，也不要写成带值的 shell 参数。
- 弄丢了就到 `/account` 撤销，再建一把新的。

## <a id="desktop"></a>5. 用 Desktop 连上

1. 在 Desktop 左侧图标列按「＋」（添加项目），选「Server」来源卡，再按「下一步」。
2. 在「选择 Server」下方填服务器地址 `http://localhost:8080`（Server base URL），按「添加并登录」。
3. Desktop 会开浏览器到设备登录页 `/activate`。还没登录就先登录。页面已带入代码，按「下一步」，确认代码和 Desktop 上的一样，再按「核准」。
4. 回到 Desktop，在「选择 Project 与 Repo」选 `demo` 与 `backend`。
5. 在「连接本机 checkout？」选一种开法，见下方说明。
6. 按「打开项目」。

清单是空的，代表第 3 节还没做。补上成员资格后，回 Desktop 重新加载清单。

两种开法：

- **「略过（规格模式）」**：spec-only。只读写远程的规格与变更，不连本机文档夹。适合只看规格的人。
- **「选择本机文档夹」**：checkout。把远程项目绑到一个本机 Git 文档夹。这个文档夹必须已经绑同一个远程，或是还没绑定的 Git repo。你至少要勾一个 AI 工具；打开前，Desktop 会把 Speclink 技能档写进这个文档夹。任何一步失败，画面会停在那一步让你重试。

登录凭证存在系统钥匙圈，不会写进项目文档。在同一台电脑上，Desktop 与 CLI 共用同一份设备登录。

只有在 server 不支持设备登录时，Desktop 才会改显示访问密钥的输入框。官方 server 支持设备登录，所以你不会看到它；接自建 server 时如果出现，就粘贴从 `/account` 拷贝的密钥。

远程看板和本地看板还有哪些差异，逐项见[项目能力状态](product-status.zh-CN.md)。

## <a id="cli"></a>6. 用 CLI 连上

**请在一个独立的测试文档夹里做这一步。** `speclink link` 会把连接写进目前项目的 `.speclink.yaml`。在产品 repo 的根目录运行，会把那个 repo 改成连到这台测试 server。

```bash
mkdir speclink-remote-test
cd speclink-remote-test
speclink link http://localhost:8080/api/speclink/v1/projects/demo --repo backend
```

**预期输出**（这台电脑还没登录过这台 server 时）：

```text
✓ Linked to http://localhost:8080/api/speclink/v1/projects/demo
  No credentials yet — run `speclink auth login` to connect
```

`--repo` 填保存库代号。代号对不上时，`link` 会列出可用的代号并结束，不写入任何东西。

Desktop 与 CLI 共用设备登录。如果第 5 节已经用 Desktop 登录，输出会多一行 `✓ Repo 'backend' is registered in this project`，下面的 `auth login` 可以略过。否则，登录并确认：

```bash
speclink auth login
speclink auth status
```

`auth login` 会印出一个网址和代码，并开浏览器到 `/activate`。页面已带入代码，按「下一步」再按「核准」就完成登录。`auth status` 会印出你的身分；最后一行是 `Repo 'backend' is registered in this project`，代表保存库代号对得上。

做一次读写测试：

```bash
speclink new change smoke-test
speclink list
```

**预期输出**（`list` 的部分）：

```text
Changes:
  • smoke-test
```

Desktop 的看板也会出现 `smoke-test`。测完用 `speclink discard smoke-test` 删掉它。

### 在 CI 或没有终端机的环境

设备登录需要交互终端机；不在终端机里运行时，`speclink auth login` 会直接拒绝。这时改用访问密钥，择一：

- 设环境变量 `SPECLINK_TOKEN`，由 CI 的秘密管理功能注入。CLI 会优先使用它。
- 运行 `speclink auth login --token-stdin`，从标准输入读密钥。要手动粘贴，则用 `speclink auth login --pat`。

用密钥登录时，密钥存在用户设置目录下的凭证档，只有你的帐号读得到，不在 repo 里。`speclink auth logout` 只清掉本机这份；server 上的密钥仍然有效，要到 `/account` 撤销。

### 动词在远程的差异

大多数动词在远程照常可用，结果写到 server。例外如下；在错的模式下运行，CLI 会直接拒绝：

- 只限本地：`demo`、`trace`、`change rank`、`plan --strict-overlap`。
- 只限远程：`claim`。

完整清单见[动词与旗标契约](verb-contract.zh-CN.md)。用 checkout 开法时，AI 工具读的是唯读的 `.speclink/context/`。不要手改它；要更新，就重新运行 `speclink instructions`。

## <a id="restart"></a>7. 重启后数据还在

在 server 的终端机按 `Ctrl+C`，然后在同一个文档夹再运行一次 `npx @speclink/server`。

这次**不会**印出设置链接。这是正常的：设置已经完成，数据都在 `speclink-data/`。接着确认：

- `speclink list` 仍然列出 `smoke-test`。
- Desktop 的远程分页还在，server 回来后会自动接上。
- 再开一次设置链接，画面显示「设置链接无效」，因为设置已经关闭。

设置还没做完就重启，server 也不会印新链接。第一次印的链接在 24 小时内仍然有效；找不到它的话，等它过期后重启就会印新的，或照第 9 节重置。

## <a id="offline"></a>8. server 脱机时

值得刻意试一次：开着 Desktop 的远程分页，在 server 的终端机按 `Ctrl+C`。分页会进入脱机（offline）状态：

- Desktop 显示「连接中断」，画面保留最后一次成功加载的内容，可以照常阅读。
- 所有写入动作（勾任务、存文档、改设置）都停用。它们不会排队等之后补送。
- CLI 指令直接失败，消息是 `Error: server unreachable — …`。

再启动 server，Desktop 会自己重新连接、重新查找并更新画面，不必手动刷新。脱机期间别人做的变更也会出现。

## <a id="reset"></a>9. 完全重置

npx 跑法的所有数据都在 `speclink-data/`。要从头来过：

1. 在测试文档夹运行 `speclink auth logout`，清掉这台电脑对这台 server 的登录。
2. 停掉 server，删掉数据目录：

   ```bash
   rm -rf ./speclink-data
   ```

3. 删掉测试文档夹 `speclink-remote-test`，并在 Desktop 的「设置 → 服务器」移除这个连接。

下次运行 `npx @speclink/server`，会印出新的设置链接，一切从头开始。

要保留数据的搬家或定期备份，见 [Server 备份与还原](server-backup.zh-CN.md)。在 Speclink 原代码 checkout 里开发时用 `npm run dev`，重置用 `npm run dev:reset`，见[开发环境](development.zh-CN.md)。

## <a id="troubleshooting"></a>故障排除

| 症状 | 原因与处理 |
| --- | --- |
| 找不到设置链接，重启也不再印 | 链接只印一次。设置还没完成时，第一次的链接在 24 小时内有效；过期后重启就会印新的。不需要保留数据的话，照第 9 节重置。 |
| 设置已完成后，设置链接显示「设置链接无效」 | 这是正常的：设置完成后就永久关闭。直接到 `/admin` 登录。 |
| 送出表单时出现「跨来源请求被拒绝」 | 网址列的协定、主机与端口，要和 server 的 `public_url` 完全一样。例如用 `localhost`，不要用 `127.0.0.1`。 |
| Desktop 的 Project／Repo 清单是空的、CLI 回 `access denied`，或 API 回 `403`（`permission_denied`） | 已登录，但这个帐号没有成员资格，管理员也一样。到 `/admin/users` 给它 `reader` 或 `editor`，再回 Desktop 重新加载清单。 |
| 用浏览器开 `/api/speclink/v1/web/account/tokens` 得到 `405` | 这个网址只接受 POST。到 `/account` 页面按「创建访问密钥」。 |
| 访问密钥弄丢了 | 拿不回来。到 `/account` 撤销，再建一把新的。 |
| `speclink auth login` 说需要终端机 | 目前不在交互终端机里。改用 `--token-stdin` 或 `SPECLINK_TOKEN`，见第 6 节。 |
| `link` 或 `auth status` 说 `repo '…' is not registered in this project` | `--repo` 的值和保存库代号对不上。消息会列出可用的代号；用正确的代号重跑 `speclink link`。 |
| server 换了网址 | 在测试文档夹运行 `speclink unlink`，再用新网址 `link`。Desktop 则添加一个连接。 |
| server 起不来，或 `/healthz` 不回 `200` | 看 server 终端机的错误消息。组态有错时，server 会直接结束，不会带着错误启动。 |
| 直接运行 `speclink-server` 出现 `missing required argument --config` | binary 一定要带 `--config`。改用 `npx @speclink/server`，或自己指定组态档，见 [Server 部署](server-deployment.zh-CN.md)。 |
| CLI 行为和文档对不上 | 多半是 PATH 上有一份旧版 `speclink`。用 `speclink --version` 确认版本。在 Speclink 原代码 checkout 里，改用 `npm run cli -- <args>`，它一定运行这个 checkout 建出来的 CLI。 |
