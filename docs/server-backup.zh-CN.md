# Server 备份与还原

**简体中文** · [English](server-backup.md)

官方 `speclink-server` 内置三个子命令，负责备份、验证与还原：

| 子命令 | 做什幺 | server 要停吗 |
| --- | --- | --- |
| `backup` | 把项目数据与帐号数据打包成一个备份档 | 要停 |
| `verify-backup` | 只检查备份档是否完整，不还原 | 不用 |
| `restore` | 把备份还原到**空的**目标，并逐项核对结果 | 要停 |

备份档与保存后端无关：从 `sqlite` 备份，可以还原到 `serverfs` 或 `postgres`。更换保存后端的步骤见 [Server 保存后端](server-store-drivers.zh-CN.md#switch)。

## <a id="rules"></a>两条规则

**一、备份前先停 server。** 备份期间不能有任何写入，否则备份可能前后不一致。目前不支持对运行中的 server 做在线备份。流程固定是：停 server → `backup` → 启动 server。

**二、还原只接受空目标。** 「空」的意思是：

- 帐号数据库里还没有任何用户；而且
- 备份里的每个项目／保存库，在目标的保存后端里都没有内容。

目标不是空的，`restore` 会直接拒绝、列出目标里已有的东西，一个比特都不写。没有「强制覆盖」的选项。最简单的做法是准备全新的数据目录或空数据库，还原前不要完成 `/setup`。还原时，目标的 server 也要停着。

## <a id="contents"></a>备份档里有什幺

备份是一个没有压缩的 tar 档，里面有：

- `manifest.json`：备份格式版本、UTC 创建时间、引擎版本、来源保存后端、帐号数据库版本、每个项目／保存库的文档数，以及每个成员档的哈希值。
- `manifest.json.sha256`：`manifest.json` 自己的哈希值，用来确认清单没被改过。
- `bundles/<n>.json`：每个项目／保存库一份导出档。它来自保存后端的导出功能，不是数据库文档的直接拷贝。
- `identity.db`：帐号数据库在备份当下的完整快照。

备份档里没有任何密码或密钥的明文：密码以 argon2id 哈希保存，访问密钥与工作阶段只存 SHA-256 哈希。即使如此，备份档仍含帐号与项目数据，请当成机密文档保管。

管理主控台「系统」页的「导出」区，可以逐一下载某个项目／保存库的导出档。它不含帐号数据，不能取代 `backup`。

## <a id="backup"></a>备份

```bash
speclink-server backup \
  --config /etc/speclink/server.yaml \
  --output /var/backups/speclink/speclink-$(date -u +%Y%m%dT%H%M%SZ).tar
```

`--config` 用来找到保存后端与帐号数据库；帐号数据库必须是 `sqlite`。输出文档名由你决定，本文的范例都用 UTC 时间戳命名。

**预期输出**：

```text
备份完成：1 个 scope、2 个成员 → /var/backups/speclink/speclink-20261007T084144Z.tar
```

「scope」是项目／保存库的组合，「成员」是 tar 里的数据档数。备份成功后，server 会在帐号数据库留一笔纪录；在主控台的 `/admin/audit` 用动作「备份纪录」筛选就看得到。

## <a id="verify"></a>验证备份

`verify-backup` 只读备份档，不需要停 server，也不需要空目标。它会比对清单与每个成员档的哈希值、检查导出档的结构，并确认备份格式版本是这个 server 认得的。

```bash
speclink-server verify-backup --input /var/backups/speclink/speclink-20261007T084144Z.tar
```

**预期输出**：

```text
备份完整：格式版本 1、2 个成员、1 个 scope
```

全部通过就回 0。文档被改过任何一个比特，或格式版本不认得，它会回非零并说明原因，例如：

```text
backup integrity check failed: digest mismatch for bundles/0.json
```

加上 `--config` 时，验证结果也会写进那个帐号数据库的备份纪录。

每次例行备份之后，建议都跑一次 `verify-backup`。

## <a id="restore"></a>还原

先确认目标是空的（见[两条规则](#rules)），而且目标的 server 停着。

```bash
speclink-server restore \
  --config /etc/speclink/target.yaml \
  --input /var/backups/speclink/speclink-20261007T084144Z.tar
```

`restore` 依序做四件事：

1. 检查备份档是否完整，等同 `verify-backup`。被改过或格式不认得的备份，在这一步就会被挡下。
2. 把帐号数据库快照放到目标位置。
3. 把每个项目／保存库的内容导入目标的保存后端。
4. 逐项核对：每个项目／保存库的内容哈希值与文档数，以及帐号数据的笔数与版本，都要和备份一致。

**预期输出**：

```text
还原完成且验证通过：1 个 scope 全数比对一致
```

核对有任何一项不符，`restore` 会回非零、逐项列出差异，并说明这个目标不能拿来使用。

目标不是空的时，输出像这样，而且目标完全没被改动：

```text
restore target is not empty (restore only into an empty target): 1 user(s) exist
```

还原完成后启动 server。帐号数据已经还原，所以 server 不会印设置链接，原本的帐号可以直接登录。

## <a id="docker"></a>在 Docker 里备份与还原

映像的进入点就是 `speclink-server`，所以 `docker compose run` 后面接的参数就是子命令。下面的范例在 `deploy/` 目录、用 SQLite 版的 compose 档运行。

容器以 uid 10001 运行。挂进去的主机目录必须让这个 uid 写得进去，否则会看到 `backup io failed: Permission denied (os error 13)`。在 Linux 主机上，先运行一次：

```bash
mkdir -p backups && sudo chown 10001:10001 backups
```

备份（中间会短暂停机）：

```bash
docker compose stop server
docker compose run --rm -v ./backups:/backups server \
  backup --config /etc/speclink/config.yaml \
  --output /backups/speclink-$(date -u +%Y%m%dT%H%M%SZ).tar
docker compose start server
```

验证（不需要停机）：

```bash
docker compose run --rm -v ./backups:/backups server \
  verify-backup --input /backups/speclink-20261007T084144Z.tar
```

还原到全新的环境：先创建容器与空的 volume，但不要启动 server，也不要走 `/setup`。

```bash
docker compose create server
docker compose run --rm -v ./backups:/backups server \
  restore --config /etc/speclink/config.yaml \
  --input /backups/speclink-20261007T084144Z.tar
docker compose start server
```

## <a id="schedule"></a>调度备份

因为备份要停机，调度的流程固定是：停 server → 备份 → 验证 → 启动 server。下面把流程写成一个脚本，再交给 systemd timer 或 cron 运行。脚本假设 server 是名为 `speclink-server` 的 systemd 服务。

`/usr/local/bin/speclink-backup.sh`：

```sh
#!/bin/sh
set -eu
CONFIG=/etc/speclink/server.yaml
DIR=/var/backups/speclink
F="$DIR/speclink-$(date -u +%Y%m%dT%H%M%SZ).tar"

systemctl stop speclink-server
# 不论备份成功或失败，脚本结束时都把 server 启动回来。
trap 'systemctl start speclink-server' EXIT
speclink-server backup --config "$CONFIG" --output "$F"
speclink-server verify-backup --input "$F" --config "$CONFIG"
# 只保留 14 天内的备份。
find "$DIR" -name 'speclink-*.tar' -mtime +14 -delete
```

记得 `chmod +x /usr/local/bin/speclink-backup.sh`。任何一步失败，脚本会以非零结束，server 仍会被启动回来。

### systemd timer

`/etc/systemd/system/speclink-backup.service`：

```ini
[Unit]
Description=Speclink server offline backup

[Service]
Type=oneshot
ExecStart=/usr/local/bin/speclink-backup.sh
```

`/etc/systemd/system/speclink-backup.timer`：

```ini
[Unit]
Description=Nightly Speclink backup

[Timer]
OnCalendar=*-*-* 03:30:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
```

激活：`systemctl enable --now speclink-backup.timer`。

### cron

在 root 的 crontab（`crontab -e`）加一行，每天 03:30 运行。时间以主机的时区为准：

```cron
30 3 * * * /usr/local/bin/speclink-backup.sh
```

### 异地保存与还原演练

备份档只写在本机。搬到另一台主机或异地保存，请用你既有的部署工具处理。也请定期在另一台主机上，把备份还原到空目标一次，确认备份真的能用。
