# Server 保存后端

**简体中文** · [English](server-store-drivers.md)

保存后端（Store driver）决定 server 把项目数据（规格、变更、讨论等）放在哪里。大多数情况用缺省的 `sqlite` 就好。

几件先知道的事：

- 帐号、成员资格与凭证放在另一个 SQLite 档（组态档的 `identity` 段），不跟着保存后端换。
- 三种保存后端都通过同一套一致性测试，所以 API 与 CLI 的行为完全相同，换后端不影响使用方式。
- 每种保存后端都只支持**一个** server instance。

部署方式与完整的组态字段见 [Server 部署](server-deployment.zh-CN.md)。

## <a id="choose"></a>怎幺选

| 保存后端 | 数据放哪 | 适合 | 要注意 |
| --- | --- | --- | --- |
| `sqlite`（缺省） | 一个数据库档 | 大多数情况 | 只能放在本机磁盘。不会挡第二个 instance。 |
| `serverfs` | 一个数据目录 | 想用纯文档保存数据、不想维运数据库 | 文档系统要支持 `flock` 文档锁。 |
| `postgres` | PostgreSQL 数据库 | 已经有 PostgreSQL 维运与备份的团队 | PostgreSQL 15 以上；不支持 TLS 连接。不会挡第二个 instance。 |
| `memory` | 内存 | 只供测试 | 进程结束数据就消失。npx 启动器不接受它。 |

组态里写了不认得的保存后端名称，server 不会启动，错误消息会列出支持的名称。拼错 `serverfs` 不会默默改用别的后端。

npx 用环境变量 `SPECLINK_STORE` 选后端；其他跑法在组态档的 `store` 段设置，见下面各节。

## <a id="sqlite"></a>sqlite（缺省）

```yaml
store:
  driver: sqlite
  path: /var/lib/speclink/store.db
identity:
  driver: sqlite
  path: /var/lib/speclink/identity.db
```

- 数据库用 SQLite 的 WAL 模式，旁边会多出 `store.db-wal` 与 `store.db-shm` 工作档。搬移或拷贝数据时要一起处理，或者直接用 [`backup`](server-backup.zh-CN.md)。
- 请放在本机磁盘。WAL 模式不支持 NFS、SMB 这类网络文档系统。
- 只能有一个 server 使用这个文档。server **不会**挡第二个指向同一个文档的 instance，所以要靠你自己避免。

## <a id="serverfs"></a>serverfs

```yaml
store:
  driver: serverfs
  path: /var/lib/speclink/store     # 这是目录，不是文档
identity:
  driver: sqlite
  path: /var/lib/speclink/identity.db
```

`path` 指向一个**数据目录**。目录不存在时，server 会创建它；空目录会被初始化成新的保存区。

### 文档锁

serverfs 用操作系统的文档锁（`flock`）保证同一时间只有一个 server 写入。锁由操作系统持有：server 被强制结束、当掉或断电时，锁会自动释放，下一个 server 可以直接接手，不需要手动清锁。

第二个 server 指向同一个目录时，它会启动失败并回报 `unavailable`，不会等待也不会抢走锁。

部署前请确认数据目录所在的文档系统支持 `flock`。本机磁盘都支持；NFS 等网络文档系统在部分设置下不可靠，不建议使用。

### 拒绝启动的情况

下列情况 server 不会启动，而且不改动目录里的任何内容：

- 目录不是空的，也不是 serverfs 创建的（例如路径打错，指到别的文档夹）。
- 目录里的版本信息损坏，或版本比这个 server 支持的还新。
- 目录被别的保存后端标记过。

### 其他限制

- 目录格式是 serverfs 私有的。不要手动编辑；要人看得懂的导出，用 [`backup`](server-backup.zh-CN.md)。
- 文档的修改时间不代表任何意义。备份工具改写修改时间，不影响任何行为。
- 每次写入都会为改动的文档写一个新版本档。被取代的旧版本档要等**下次启动**时才清掉，所以长时间不重启，磁盘用量会随写入量增加。目前没有压缩或历史裁剪。

## <a id="postgres"></a>postgres

```yaml
store:
  driver: postgres
  url: postgres://speclink@db.internal:5432/speclink   # 不放密码，见下方
identity:
  driver: sqlite
  path: /var/lib/speclink/identity.db
```

server 会在连接的目前 schema 建四张数据表：`documents`、`history`、`outbox` 与 `meta`。所以用不同的 `search_path`，就能让多个保存区共用一个数据库。空的 schema 会被初始化。

### 密码

密码请放在环境变量 `SPECLINK_POSTGRES_PASSWORD`。连接 URL 不含密码时，server 会用这个变量补上。

URL 里直接写密码也能启动，但 server 会在 stderr 印一行警告：组态档常被拷贝、比对、贴进 issue，不该放密码。URL 已经带密码时，环境变量不会覆盖它。

### 限制

- **最低版本 PostgreSQL 15。** CI 用这个版本跑完整测试。
- **不支持 TLS 连接。** server 一律用不加密的连接。只接受 TLS 的托管 PostgreSQL 会连不上；请把数据库放在受信任的内部网络。
- **只能有一个 server。** 同一范围的写入会依序运行，数据不会损坏，但 server **不会**拒绝第二个指向同一个数据库的 instance。多台 server 共用一个数据库不在支持范围内。
- **数据表格式是私有的。** 不要手动编辑；要人看得懂的导出，用 [`backup`](server-backup.zh-CN.md)。

### 拒绝启动的情况

下列情况 server 不会启动，也不改动数据库的内容：

- schema 里已经有数据表，但不是 Speclink 创建的（例如 URL 打错，指到别的数据库）。
- `meta` 记录的版本比这个 server 支持的还新。
- 认证失败或数据库不存在。错误消息会附上 PostgreSQL 的原文。

运行中断线不算数据损坏：请求回 `unavailable`，`/readyz` 回 `503`。连接恢复后，同一个 server 会直接续用，不需要重启。

## <a id="switch"></a>更换保存后端

保存后端之间不能直接搬文档，要经过备份档：

1. 停掉 server，用旧组态运行 `backup`。
2. 准备新组态，指向一个空的新保存区。
3. 用新组态运行 `restore`，再用新组态启动 server。

备份档的内容与保存后端无关，`restore` 会逐项比对还原结果。指令与规则见 [Server 备份与还原](server-backup.zh-CN.md)。
