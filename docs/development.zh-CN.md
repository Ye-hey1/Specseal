# 开发环境

**简体中文** · [English](development.md)

这份文档给 clone 原代码的开发者。它说明 repo 根目录的五个一键入口、怎幺跑测试、repo 的结构，最后附上下载安装档时的未签章放行步骤。

只想在 checkout 之外自架 server，不需要这份文档：用 `npx @speclink/server`，见 [Remote 入门](remote-getting-started.zh-CN.md)。

## <a id="prerequisites"></a>前置需求

- stable Rust 工具链（`cargo` 可用）。
- Node.js 21 以上与 npm。CI 用 Node 20 分开跑各项测试；`npm run test:all` 的写法要 Node 21 以上（见[测试](#tests)）。
- 第一次 clone 后，在 repo 根目录安装前端依赖：

  ```bash
  npm install
  ```

- 会启动 `speclink-server` 的入口（`npm run dev`、`npm run dev:server`）与 Rust 测试，需要先建一次 server 网页后台：

  ```bash
  npm run build -w apps/server-web
  ```

  `speclink-server` 编译时要求 `apps/server-web/dist` 文档夹存在，开发模式下也直接读这个文档夹。改了 `apps/server-web` 的代码要重建，否则后台显示的是旧画面。

- 会开桌面窗口的入口（`npm run dev`、`npm run dev:desktop`）需要 Tauri 的系统依赖：macOS 是 Xcode Command Line Tools；Linux 要装 GTK 与 WebKit 套件（清单见 `.github/workflows/ci.yml` 的 Install Tauri system dependencies 步骤）；其他情况见 [Tauri 的前置需求说明](https://v2.tauri.app/start/prerequisites/)。

## <a id="dev"></a>`npm run dev`：整套开发环境

- **用途**：一次启动完整的开发环境。它先建置当前 checkout 的 `speclink-cli`，成功后同时启动 `speclink-server` 与桌面 app（tauri dev）。桌面前端由 Vite dev server 提供，改前端会即时重载。
- **前置条件**：上面全部的前置需求。设置来自 repo 根目录的 `.env`（可以拷贝 `.env.example` 修改）。没有 `.env` 时全用默认值：sqlite、数据放在 `.dev/`、server 在 `127.0.0.1:8080`。`.env` 不合法时（例如 `SPECLINK_STORE_DRIVER=postgres` 却没设 `SPECLINK_POSTGRES_URL`），指令以非零结束，什幺都不启动。
- **预期可观察结果**：
  1. 终端先印出 `speclink dev: 建置当前 checkout 的 speclink-cli…`。建置失败就以非零结束，不留下任何背景进程。
  2. 第一次启动时，server 印出一行 `Speclink 首次启动：打开 http://localhost:8080/setup?token=… 完成初始设置（此链接 24 小时内有效，且仅显示这一次）。`。打开这个链接完成初始设置。
  3. 桌面那一侧先放好 sidecar（桌面 app 内附的 CLI，见 [`npm run dev:desktop`](#dev-desktop)），再打开桌面 app 窗口。
  4. 按 Ctrl+C 会同时停止 server 与桌面 app，不留背景进程。任一边先结束时，另一边也会跟着停止。数据存在 `.dev/`（不进版本控制）。

先建 CLI 是刻意的：你接着用 [`npm run cli`](#cli) 核对时，CLI 与 server 来自同一份原代码。

## <a id="dev-server"></a>`npm run dev:server`：只跑 server

- **用途**：只启动 `speclink-server`，用来在这个 checkout 做后端开发。不建置 CLI，也不开桌面窗口。
- **前置条件**：Rust、`npm install`，以及建好的 `apps/server-web/dist`。`.env` 的检查与 `npm run dev` 相同，不合法就以非零结束。
- **预期可观察结果**：第一次运行时 cargo 会先编译 server，要等一阵子。`.dev/` 是全新的时候，终端印出含 `/setup?token=` 的链接。没有桌面窗口。按 Ctrl+C 后不留背景进程；`.dev/` 的数据与 `npm run dev` 共用。

## <a id="dev-desktop"></a>`npm run dev:desktop`：只跑桌面 app

- **用途**：只启动桌面 app（tauri dev），用于桌面开发与试用本机模式。不启动 server，也不需要任何远程设置。
- **前置条件**：Rust、`npm install`、Tauri 系统依赖。`.env` 的检查与 `npm run dev` 相同。
- **预期可观察结果**：
  1. 先建置 `speclink-cli`，再把它放到桌面 app 需要的位置。这个内附在桌面 app 里的 CLI 叫做 sidecar。终端会印出 `sidecar 布署完成（debug）：…`，或内容没变时印出 `sidecar 内容未变，跳过拷贝：…`。这一步失败就以非零结束，不开窗口。
  2. Vite dev server 启动后打开桌面窗口。画面来自目前的原代码，改前端会就地重载。
  3. 窗口以本机模式运作，可以直接开这个 repo 的 `speclink/` 看板。机器上没有 server 也能用。

## <a id="dev-reset"></a>`npm run dev:reset`：清掉本机开发状态

- **用途**：删掉 `.dev/`，也就是开发用的 server 设置与数据库，让下次 `npm run dev` 回到全新的 `/setup`。不建置任何东西，不碰 `.env` 与 `deploy/`。
- **前置条件**：无。`.dev/` 不存在也会成功。
- **预期可观察结果**：终端印出 `speclink dev: .dev/ 已清空，下次 npm run dev 回到全新 /setup。` 后立即结束。postgres 的数据在外部数据库，不会被清掉；要重来请自己删掉并重建数据库。

## <a id="cli"></a>`npm run cli -- <args>`：用这个 checkout 的 CLI

- **用途**：运行这个 checkout 的 `target/debug/speclink`，绝不使用 PATH 上的 `speclink`。这样「启动环境」与「用同版 CLI 核对」用的是同一份原代码。
- **前置条件**：Rust 工具链。binary 还不存在时，wrapper 先在 checkout 根目录运行 `cargo build -p speclink-cli` 再运行；建置失败就以非零结束，不运行任何 CLI。binary 已经存在时**不会**重建，所以改了 Rust 代码后，先自己跑一次 `cargo build -p speclink-cli`，否则运行的是旧版。
- **预期可观察结果**：

  ```bash
  npm run cli -- --version
  ```

  ```text
  > speclink-workspace@0.1.3 cli
  > node scripts/dev/cli.mjs --version

  speclink 0.8.0 (arm64, engine v1.41.0)
  ```

  版号与架构依你的 checkout 与机器而定。第一次运行（或删掉 binary 之后）会先在 stderr 看到 cargo 的建置过程。

需要干净的 stdout（例如让进程读 JSON）时加 `--silent`，npm 自己的消息就不会混进来：

```bash
npm run --silent cli -- list --json
```

在别的文档夹（例如测试用的 repo）使用这个 checkout 的 CLI：

```bash
npm --prefix <speclink-checkout> run cli -- list
```

CLI 会在你下指令的文档夹运行。exit code、stdin、stdout、stderr 都原样转送。

### 核对远程环境

在 checkout 里核对远程环境时（例如 `auth status`、`list --json`），一律用 `npm run cli -- <args>`，不要用 PATH 上的 `speclink`。PATH 上那颗可能来自另一个 checkout，或是没跟上的旧安装版。用这两行比对引擎版号：

```bash
speclink --version
npm run --silent cli -- --version
```

两行的 `engine v…` 不一样，就表示 PATH 上的 `speclink` 不是这份原代码建出来的。

## <a id="tests"></a>测试

全新 clone 要先备好三样建置产物，Rust 测试才编译得过。顺序和 CI 相同：

```bash
npm install
npm run build -w apps/desktop                              # 桌面 crate 编译时要 apps/desktop/dist
npm run build -w apps/server-web                           # speclink-server 编译时要 apps/server-web/dist
node scripts/desktop/desktop-sidecar.mjs --profile debug   # 桌面 crate 编译时要 sidecar
npm run test:all
```

`npm run test:all` 依序跑 repo 脚本、三个前端 package、Rust workspace 与 Node SDK（安装、建置、测试）。它自己会重建 `apps/server-web/dist`，但不建 `apps/desktop/dist`，也不放 sidecar，所以全新 clone 要先跑上面三行。之后只要没删掉这些产物，就不必重跑。

只跑其中一块：

```bash
node --test "scripts/**/*.test.mjs"                     # repo 脚本（Node 21 以上）
node --test scripts/*.test.mjs scripts/*/*.test.mjs     # 同上，Node 20 用这行
npm test -w packages/ui                                 # 共用 UI
npm test -w apps/desktop                                # 桌面前端
npm test -w apps/server-web                             # server 网页后台
cargo test --workspace                                  # Rust：引擎、CLI、Host、保存后端、server、桌面 app
npm --prefix crates/adapters/speclink-node ci           # Node SDK：先安装依赖
npm --prefix crates/adapters/speclink-node run build    #           再建置 .node
npm --prefix crates/adapters/speclink-node test         #           再跑测试
```

- `cargo test --workspace` 很久。只改了某个 crate 时，用 `cargo test -p <crate>`。
- PostgreSQL 保存后端的测试在没设 `SPECLINK_TEST_POSTGRES_URL` 时会自动跳过。要跑就把它指向一个可用的数据库（CI 用 PostgreSQL 15）。
- Node SDK 不是 npm workspace 的成员，所以要用 `npm --prefix` 指定路径；用 `-w` 找不到它。

## <a id="layout"></a>repo 结构

| 路径 | 内容 |
| --- | --- |
| `apps/desktop/` | 桌面 app（Tauri）：`src/` 是前端，`core/` 与 `src-tauri/` 是两个 Rust crate |
| `apps/server-web/` | server 的网页后台（React），建置后内嵌进 `speclink-server` |
| `crates/engine/` | 引擎内核：`speclink-core`（动词、工作流、技能产生）与 `speclink-fs`（读写本机 `speclink/`） |
| `crates/protocol/` | 远程协定：`speclink-protocol`（client 与 server 共用的数据类型）与 `speclink-remote`（CLI 与桌面 app 用的远程 client 与登录） |
| `crates/store/` | server 的保存后端（Store driver）：共用接口 `speclink-store`，以及 sqlite、文档（serverfs）、postgres 三种实作 |
| `crates/host/` | `speclink-host`（引擎与 CLI、桌面 app、server 之间的共用层）与 `speclink-server`（官方参考 server） |
| `crates/adapters/` | 对外入口：`speclink-cli`（`speclink` 指令）与 `speclink-node`（Node SDK `@speclink/engine`） |
| `packages/ui/` | 桌面 app 与网页后台共用的 UI 组件 |
| `packages/cli-npm/`、`packages/server-npm/` | npm 套件 `@speclink/cli` 与 `@speclink/server` 的外壳；各平台的 binary 另外发布 |
| `integrations/claude-code/` | Claude Code 的 mod（`speclink-skills`：技能列与侧边面板） |
| `integrations/herdr/` | Herdr 的 mod（`speclink`：面板与技能跳窗），以及 `scripts/herdr/dock-panel.mjs` 放进侧栏拷贝版的文档 |
| `scripts/` | 开发入口、文档守门、桌面建置、npm 打包与发版用的脚本 |
| `deploy/` | Docker Compose 部署档（sqlite 与 postgres 各一份） |
| `docs/` | 用户文档 |
| `speclink/` | Speclink 自己的规格、变更与讨论 |

## <a id="unsigned"></a>下载安装档的未签章放行

桌面安装档都在 [Releases](https://github.com/MomoChenisMe/speclink/releases/latest)：

| 平台 | 文档名 | 要不要放行 |
| --- | --- | --- |
| macOS（Apple Silicon 与 Intel 同一档） | `Speclink_<版本>_universal.dmg` | 不用：已签章并经 Apple 公证 |
| Windows（x64） | `Speclink_<版本>_x64-setup.exe` | 要：安装器没有代码签章 |
| Linux（x86_64） | `Speclink_<版本>_amd64.AppImage` | 不用：加上运行权限即可 |
| Linux（aarch64） | `Speclink_<版本>_aarch64.AppImage` | 不用：加上运行权限即可 |

### macOS

打开 dmg，把 Speclink 拖进「应用进程」就好，不需要放行。只有你自己在本机建置、没有签章的 app 才会被挡：

1. 先打开一次 app，看到无法打开的提示后关掉。
2. 到「系统设置 > 隐私权与安全性」，在安全性区块找到 Speclink，按「强制打开」。

### Windows

1. 运行 `Speclink_<版本>_x64-setup.exe`，SmartScreen 显示「Windows 已保护您的电脑」。
2. 按「其他信息」，再按「仍要运行」，继续安装。

### Linux

```bash
chmod +x Speclink_<版本>_amd64.AppImage
./Speclink_<版本>_amd64.AppImage
```

aarch64 机器换成 `Speclink_<版本>_aarch64.AppImage`。AppImage 运行时需要 FUSE；出现 FUSE 相关错误时，先安装 `libfuse2`（Ubuntu 24.04 起叫 `libfuse2t64`）。
