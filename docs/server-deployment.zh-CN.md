# Server 部署

**简体中文** · [English](server-deployment.md)

这份文档说明怎幺把官方 `speclink-server` 跑起来给团队用：选跑法、设置、HTTPS、管理指令，以及升级与回退。第一次试用请先照 [Remote 入门](remote-getting-started.zh-CN.md)走一次；那份文档带你完成初始设置、成员资格与 Desktop、CLI 的连接。

## <a id="reference-implementation"></a>官方 server 是参考实作

`speclink-server` 是 Speclink 官方的**参考实作**，让你开箱即用、试远程功能。远程模式不绑这一份 server：它由 `speclink/specs/` 底下的两份公开契约 `host-runtime` 与 `client-protocol` 定义。你可以用 Speclink 引擎自己写 server，接上自家的认证、数据库与权限模型，CLI 与 Desktop 一样接得上。本文只讲官方这一份怎幺部署。

## <a id="choose"></a>选一种跑法

| 跑法 | 适合 | 数据位置 |
| --- | --- | --- |
| [npx](#npx) | 有 Node.js 的单机试用 | `./speclink-data/` |
| [Docker](#docker) | 单一容器 | 容器内 `/data` |
| [Docker Compose（SQLite）](#compose) | 正式部署的缺省选择 | named volume |
| [Docker Compose（PostgreSQL）](#compose) | 已经有 PostgreSQL 维运的团队 | PostgreSQL＋named volume |
| [从原代码建置](#build-from-source) | 需要自己的 binary | 组态档指定的位置 |

不论哪种跑法，都是同一支 binary。浏览器主控台（`apps/server-web`）在编译时就内嵌进 `speclink-server`，和 API 由同一个网址提供。运行时不需要 Node.js、外部的 `dist` 文档夹、CDN，也不需要另一个静态档服务。

每种保存后端都只支持**一个** server instance。不要 `--scale`，也不要让两个 server 指向同一份数据；SQLite 与 PostgreSQL 不会挡第二个 instance，详见 [Server 保存后端](server-store-drivers.zh-CN.md)。

启动后，每种跑法的行为都一样：

- `GET /healthz` 回 `200` 代表进程活着；`GET /readyz` 回 `200` 代表保存后端可用，不可用时回 `503`。
- 第一次启动（还没有管理员）时，stdout 印出一次性的 `/setup?token=…` 链接，24 小时内有效。完成设置后，设置就永久关闭。
- 组态有错（文档读不到、格式不对、未知的保存后端）时，server 不开端口，直接以非零 exit code 结束。

## <a id="npx"></a>npx

需要 Node.js 18 以上。支持 macOS（arm64、x64）、Linux（x64、arm64）与 Windows（x64）。

```bash
npx @speclink/server
```

不带参数时，启动器做三件事：

1. 依[环境变量](#configuration)产生 `speclink-data/config.yaml`。每次启动都重新产生，手改的内容会被盖掉。
2. 缺省用 SQLite，数据放在 `./speclink-data/`。
3. 启动 server，只听 `127.0.0.1:<SPECLINK_PORT>`。

带了参数时，启动器把参数原封不动交给 server binary，例如 `npx @speclink/server invite --config ./speclink-data/config.yaml …`。想要固定的 `speclink-server` 指令，可以 `npm i -g @speclink/server`。

npx 缺省只有本机连得到。要给团队用，建议改用 Docker Compose，并在前面架 [HTTPS 反向代理](#https)。如果一定要用 npx，请自己维护一份组态档，用 `npx @speclink/server --config <文档> --addr 0.0.0.0:8080` 启动；带 `--config` 时，启动器不会改写你的组态档。

## <a id="docker"></a>Docker

官方映像是 `ghcr.io/momochenisme/speclink-server`，支持 `linux/amd64` 与 `linux/arm64`。每次发版会推三个 tag：完整版号（例如 `0.8.0`）、`主.次` 版号（例如 `0.8`）与 `latest`。

```bash
docker run -d --name speclink \
  -p 8080:8080 \
  -v speclink-data:/data \
  ghcr.io/momochenisme/speclink-server:latest
docker logs speclink        # 取得一次性设置链接
```

映像内置一份组态：store 与 identity 两个 SQLite 档都放在 `/data`，`public_url` 是缺省的 `http://localhost:8080`。server 以 uid 10001 的非 root 用户运行，容器的健康检查打 `/healthz`。

组态档不展开环境变量。要改 `public_url` 或换保存后端，就挂载自己的组态档，盖掉映像内的那一份：

```bash
docker run -d --name speclink \
  -p 8080:8080 \
  -v speclink-data:/data \
  -v ./server.yaml:/etc/speclink/config.yaml:ro \
  ghcr.io/momochenisme/speclink-server:latest
```

端口映射不是 `8080:8080`，或对外网址不是 `http://localhost:8080` 时，一定要改 `public_url`。否则设置链接的网址不对，浏览器送出的表单也会因为来源不符而被拒。

## <a id="compose"></a>Docker Compose

repo 的 `deploy/` 有两份 compose 档。两份都用 named volume 保存 `/data`，并由环境变量产生组态。

SQLite（缺省）：

```bash
cd deploy
docker compose pull          # 先拉官方映像
docker compose up -d
docker compose logs server   # 取得一次性设置链接
```

PostgreSQL（server＋postgres 两个服务）：

```bash
cd deploy
cp .env.example .env         # 填入 SPECLINK_POSTGRES_PASSWORD；.env 不进版本控制
docker compose -f docker-compose.postgres.yml pull
docker compose -f docker-compose.postgres.yml up -d
```

PostgreSQL 版的 server 会等 postgres 健康后才启动；帐号数据（identity）仍是 `/data` 底下的 SQLite 档。保存后端的限制见 [Server 保存后端](server-store-drivers.zh-CN.md#postgres)。

compose 档同时写了 `image:` 与 `build:`。没有先 `pull` 而本机也没有映像时，`up` 会从原代码建置映像；这需要完整的 repo，Rust 编译要几分钟。

容器重启后，数据留在 volume 里，设置链接不会再印。

## <a id="build-from-source"></a>从原代码建置

从原代码建置的顺序是 `npm ci`、`npm run build -w apps/server-web`，再编译 `speclink-server`。在 repo 的 checkout 里运行：

```bash
npm ci
npm run build -w apps/server-web
cargo build --release -p speclink-server
```

产物是 `target/release/speclink-server`。第二步产出的 `apps/server-web/dist` 会在第三步内嵌进 binary。少了 `apps/server-web/dist/index.html`，release 建置会直接编译失败，不会产出只有 API、没有主控台的 binary。Docker 映像用多阶段建置走同一个顺序，最终映像里没有 Node.js。

准备好组态档后启动：

```bash
./target/release/speclink-server --config /etc/speclink/server.yaml --addr 0.0.0.0:8080
```

binary 一定要带 `--config`。`--addr` 缺省是 `127.0.0.1:8080`，只有本机连得到；要对外服务，就明确指定绑定地址。用 systemd 等进程管理器时，设 `Restart=on-failure` 即可。

## <a id="configuration"></a>环境变量与组态档

### 环境变量

| 变量 | 适用跑法 | 缺省 | 说明 |
| --- | --- | --- | --- |
| `SPECLINK_STORE` | npx | `sqlite` | 保存后端：`sqlite`、`serverfs` 或 `postgres`。 |
| `SPECLINK_DATA_DIR` | npx | `./speclink-data` | 数据目录，组态档、数据库都放这里。 |
| `SPECLINK_PORT` | npx、Compose | `8080` | npx：server 在 `127.0.0.1` 上听的端口。Compose：主机对外的端口（容器内固定是 8080）。 |
| `SPECLINK_PUBLIC_URL` | npx、Compose | `http://localhost:<SPECLINK_PORT>` | 对外网址，也就是用户浏览器网址列上的协定、主机与端口。设置链接、邀请链接与同源检查都以它为准。正式部署一定要设。 |
| `SPECLINK_POSTGRES_URL` | npx | 无（`postgres` 时必填） | PostgreSQL 连接 URL，建议不含密码。 |
| `SPECLINK_POSTGRES_PASSWORD` | 所有跑法 | 无（Compose 的 PostgreSQL 版必填） | PostgreSQL 密码。server 进程自己读这个变量，补进不含密码的连接 URL。 |
| `SPECLINK_CONFIG` | npx | 无 | 改用一份既有的组态档。设了之后，上面 npx 专用的变量都不作用，也不带 `--addr`，所以 server 听 `127.0.0.1:8080`。这时 `invite` 这类子命令仍要自己带 `--config`。 |

直接运行 binary 或 `docker run` 时，只有 `SPECLINK_POSTGRES_PASSWORD` 会被读取；其他设置都写在组态档里。

### 组态档

server 只读一份 YAML 组态档：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `store` | 是 | 保存后端（`driver` 加上 `path` 或 `url`），见 [Server 保存后端](server-store-drivers.zh-CN.md)。 |
| `identity` | 是 | 帐号数据库：`driver: sqlite` 加上 `path`。 |
| `public_url` | 否 | 对外网址，缺省 `http://localhost:8080`。 |
| `events` | 否 | 即时事件串流的调整值：`retention`（每个范围保留的事件数，缺省 1024）、`buffer`（每条连接的缓冲，缺省 256）、`heartbeat_secs`（心跳间隔秒数，缺省 15）。 |

范例：

```yaml
store:
  driver: sqlite
  path: /var/lib/speclink/store.db
identity:
  driver: sqlite
  path: /var/lib/speclink/identity.db
public_url: https://speclink.example.com
```

旧版组态里的 `tokens` 或 `projects` 段已经废除。留着它们，server 会拒绝启动，并说明替代做法。

## <a id="https"></a>HTTPS 与反向代理

server 本身不处理 TLS。给团队用时，请在前面架一层反向代理，由它提供 HTTPS。

这是必要的：登录用的 cookie 一律带 `Secure` 属性，浏览器只在 HTTPS 或 `http://localhost` 下保存它。用 `http://` 加上非 localhost 的网址部署时，浏览器不会保存登录状态，主控台与设备登录的核准页都登不进去。

反向代理要做到这几件事：

- 提供 HTTPS，把请求转给 server 的端口。
- 把 `public_url` 设成用户实际开的 HTTPS 网址。协定、主机或端口不一致时，浏览器送出的写入请求会被拒（`403`，`same_origin_required`）。
- 不要缓冲 `/api/speclink/v1/projects/<项目代号>/events`。这是长时间开着的事件串流（Server-Sent Events），server 每 15 秒送一次心跳；代理的闲置逾时要比这个长。

## <a id="manage"></a>管理指令

管理主控台能做的事，大多也有命令行版本，适合写成脚本。每个子命令都要用 `--config` 指向 server 的组态档：

| 指令 | 用途 |
| --- | --- |
| `invite --email <email> --display <名称>` | 创建一次性邀请，印出接受网址。`--project <项目代号>` 可重复，对方接受后成为该项目的 `editor`；`--admin` 给管理员身分；`--expires-in-days` 缺省 7 天。 |
| `user suspend --email <email>`／`user reactivate --email <email>` | 停权或复权。最后一位有效的管理员不能停权。 |
| `token revoke --token-id <id>` | 撤销一把访问密钥。id 以 `pat_` 开头，不是密钥明文；主控台只显示前缀，所以一般在 `/admin/credentials` 撤销比较方便。 |
| `project create --key <项目代号> [--name <名称>]` | 创建项目。 |
| `repo create --project <项目代号> --key <保存库代号> [--name <名称>]` | 在项目里创建保存库。 |

没有替既有帐号加成员资格的命令行指令；请用 `/admin/users`。

依跑法不同，指令的开头也不同：

```bash
# npx（在数据目录的上一层运行）
npx @speclink/server invite --config ./speclink-data/config.yaml \
  --email dev@example.com --display "Dev" --project demo

# Docker Compose（server 运行中）
docker compose exec server speclink-server invite \
  --config /etc/speclink/config.yaml \
  --email dev@example.com --display "Dev" --project demo
```

备份、验证与还原的指令见 [Server 备份与还原](server-backup.zh-CN.md)。

## <a id="verify-deployment"></a>部署后检查

部署好、完成 `/setup` 之后，用下面三项确认 server 真的能用。

第一，看主控台总览。刚完成设置时，总览最上面会出现一次「开始使用」区块，列出服务网址、项目代号与保存库代号：

![Server 主控台总览，显示服务网址、项目与保存库代号、计数与系统健康](assets/screenshots/zh-TW/server-overview.png)

- 服务网址要和用户实际开的网址一样。不一样就改 `public_url`。
- 「系统健康」显示「正常」，数据结构版本有值。
- 「需要处理」写着「尚无有效凭证——远程工作流程无法连接」是正常的。有人用 Desktop 或 CLI 登录、或创建访问密钥之后，它就会消失。

第二，看用户页，确认成员资格。能登录不等于看得到项目；管理员身分和项目成员资格是分开的。初始设置创建的管理员一开始没有成员资格，用户页上那一列显示「尚无项目」。加了成员资格之后，用户详情页的「成员资格」分页会列出每个项目与角色：

![Server 后台的用户详情页，「成员资格」分页列出项目与角色](assets/screenshots/zh-TW/server-members.png)

每位要用远程的人，点进他的用户详情页，「成员资格」分页里都要有目标项目。加成员资格的步骤见 [Remote 入门](remote-getting-started.zh-CN.md#grant-membership)。

第三，从另一台电脑打一次健康检查：

```bash
curl -o /dev/null -w "%{http_code}\n" https://<你的网址>/healthz
```

回 `200` 才算通过。

## <a id="upgrade"></a>升级

升级就是换新版重启。server 只跑一个 instance，所以没有滚动更新。

1. 先备份，并确认 `verify-backup` 通过。做法见 [Server 备份与还原](server-backup.zh-CN.md)。
2. 换成新版并重启：
   - Docker Compose：`docker compose pull && docker compose up -d`。volume 不受影响。
   - npx：`npx @speclink/server@<新版号>`。
   - 自建 binary：换掉 binary 后重启。
3. 确认 `/healthz` 与 `/readyz` 都回 `200`。

新版需要较新的帐号数据库（identity）结构时，server 启动时会自动升级它。组态或数据不兼容时，server 直接以非零 exit code 结束，不会带着错误启动。

## <a id="rollback"></a>回退

回退就是部署**上一版**的 binary 或映像：

- Docker Compose：把 compose 档的 `image:` 改成上一版的 tag（例如 `ghcr.io/momochenisme/speclink-server:0.7.0`），再 `docker compose up -d`。volume 不受影响。
- npx：`npx @speclink/server@<上一版号>`。
- 自建 binary：checkout 上一版的 tag 重新建置，或改用上一版的映像。

到 0.8.0 为止，各版的数据格式都相同（帐号数据库结构版本 6、保存格式版本 1），回退不需要动数据。主控台「系统」页的「数据结构版本」显示目前的帐号数据库版本。

之后如果有新版提高帐号数据库的版本，升级时会自动改写数据库，而旧版 server 会拒绝打开较新的数据库。那时要回退，就得用升级前的备份，还原到空的目标。所以升级前一定要先备份。

## <a id="related"></a>相关文档

- [Remote 入门](remote-getting-started.zh-CN.md)：第一次设置、成员资格、Desktop 与 CLI 连接。
- [Server 保存后端](server-store-drivers.zh-CN.md)：SQLite、serverfs、PostgreSQL 怎幺选。
- [Server 备份与还原](server-backup.zh-CN.md)：`backup`、`verify-backup`、`restore` 与调度。
