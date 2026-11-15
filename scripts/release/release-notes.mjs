#!/usr/bin/env node
// Release 说明开头的下载指南（desktop-release spec「Release 说明含下载指南」）。输入
// --tag vX.Y.Z，双语说明输出至 stdout：英文指南接该版英文更新日志片段在前，其后是缺省
// 收合的「繁体中文」区块（繁中指南接繁中片段）。片段由 release-notes.json 经同一份渲染
// 逻辑画出（与两份更新日志共用）；release job 落档后以 body_path 传入 action-gh-release，
// 自动产生的比较链接接续于最后。
// 文档名清单即资产命名契约——与 Tauri bundler 的产出逐字一致，两种语言共用同一份，对错由
// release-notes.test.mjs 看守。
import { readReleaseNotes, renderEntry } from './release-notes-render.mjs';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const tagIndex = args.indexOf('--tag');
const tag = tagIndex >= 0 ? args[tagIndex + 1] : undefined;
if (!tag) fail('用法：release-notes.mjs --tag vX.Y.Z');
const match = /^v(\d+\.\d+\.\d+)$/.exec(tag);
if (!match) fail(`tag「${tag}」不符 vX.Y.Z 格式`);
const version = match[1];

// 先找条目再输出：JSON 缺该版时 stdout 保持空，release job 不会拿到半份说明。
let entries;
try {
  entries = readReleaseNotes();
} catch (error) {
  fail(error.message);
}
const entry = entries.find((candidate) => candidate.version === version);
if (!entry) fail(`release-notes.json 没有 ${version} 的条目——先运行 /release 技能补上更新日志再发 tag`);

const assets = {
  dmg: `Specseal_${version}_universal.dmg`,
  exe: `Specseal_${version}_x64-setup.exe`,
  appImageX64: `Specseal_${version}_amd64.AppImage`,
  appImageArm64: `Specseal_${version}_aarch64.AppImage`,
  dockerImage: `ghcr.io/momochenisme/speclink-server:${version}`,
};
const NPM_INSTALL = 'npm i -g @specseal/cli';
const SH_INSTALL = 'curl -fsSL https://raw.githubusercontent.com/MomoChenisMe/speclink/main/scripts/install.sh | sh';
const BREW_INSTALL = 'brew install MomoChenisMe/tap/specseal';
const NPX_SERVER = 'npx @specseal/server';
const DOCKER_SERVER = `docker run -d -p 8080:8080 -v specseal-data:/data ${assets.dockerImage}`;

const guideEn = `## 📦 Which file should I download?

| Your system | Download this (in Assets below) |
| --- | --- |
| macOS (Apple Silicon and Intel use the same file) | \`${assets.dmg}\` |
| Windows (x64) | \`${assets.exe}\` |
| Linux desktop (x64) | \`${assets.appImageX64}\` |
| Linux desktop (arm64) | \`${assets.appImageArm64}\` |
| Linux server or no graphical interface | No download — use the one-line CLI install below |

**One-line CLI install** (for people who want only the CLI, without the desktop app; pick one of three):

\`\`\`sh
# With Node.js (any platform)
${NPM_INSTALL}

# macOS/Linux without Node.js (servers, WSL, CI)
${SH_INSTALL}

# Homebrew (macOS/Linux)
${BREW_INSTALL}
\`\`\`

**One-line server start** (npx to try it locally, Docker to deploy):

\`\`\`sh
# Node.js 18+ starts a local server (SQLite by default, data in ./specseal-data, prints a /setup link)
${NPX_SERVER}

# Deploy with Docker (the deployment docs show the SQLite/PostgreSQL compose files)
${DOCKER_SERVER}
\`\`\`

> The desktop app uses \`.app.tar.gz\` and \`latest.json\` for automatic updates. You do not need to download them.
`;

const guideZh = `## 📦 我该下载哪个文档？

| 你的环境 | 下载这个（在下方 Assets 区） |
| --- | --- |
| macOS（Apple Silicon 与 Intel 同一档） | \`${assets.dmg}\` |
| Windows（x64） | \`${assets.exe}\` |
| Linux 桌面机（x64） | \`${assets.appImageX64}\` |
| Linux 桌面机（arm64） | \`${assets.appImageArm64}\` |
| Linux 服务器或无图形接口 | 不用下载——用下方的 CLI 一行安装 |

**CLI 一行安装**（只要 CLI、不装桌面 app 的人；三种择一）：

\`\`\`sh
# 有 Node.js（任何平台）
${NPM_INSTALL}

# 没有 Node.js 的 macOS／Linux（服务器、WSL、CI）
${SH_INSTALL}

# Homebrew（macOS／Linux）
${BREW_INSTALL}
\`\`\`

**Server 一行启动**（本机试用 npx、部署用 Docker）：

\`\`\`sh
# 有 Node.js 18+ 就能起本机 server（缺省 SQLite、数据在 ./specseal-data、印出 /setup 链接）
${NPX_SERVER}

# 部署走 Docker（SQLite／PostgreSQL compose 见部署文档）
${DOCKER_SERVER}
\`\`\`

> \`.app.tar.gz\` 与 \`latest.json\` 是桌面 App 自动更新机制用的，毋须手动下载。
`;

// <details> 里的 Markdown 前后都要空一行，GitHub 才会渲染。
process.stdout.write(`${guideEn}
---

${renderEntry(entry, 'en')}
<details>
<summary>繁体中文</summary>

${guideZh}
---

${renderEntry(entry, 'zh-CN')}
</details>
`);
