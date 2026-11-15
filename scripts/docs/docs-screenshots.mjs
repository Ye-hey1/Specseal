#!/usr/bin/env node
// 文档截屏的场景布置（user-documentation spec「用户文档以截屏呈现实际接口」、
// design D1／D2）。本脚本不按快门——版面与时机交给人判断，脚本只负责两件人做
// 容易出错的事：把用户的 desktop 状态安全地移开再放回，以及造出一个内容固定
// 的示范 workspace。
//
// 用法：
//   node scripts/docs/docs-screenshots.mjs --dry-run   只印出会搬什幺、会造什幺，不动任何文档
//   node scripts/docs/docs-screenshots.mjs --setup     备份 → 布置 → 等你拍完按 Enter → 还原
//   node scripts/docs/docs-screenshots.mjs --restore   单独还原（--setup 中途当掉时的救援入口）
//
// desktop 没有数据目录隔离：分页与连接都存在用户层级的状态目录，dev 与安装版
// 共用。要拍到干净的全新状态只能整个移开再放回，因此还原在 Ctrl+C 下也必须运行。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { checkoutCliPath } from '../dev/cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/// tauri.conf.json 的 identifier；macOS 的两处状态落点都以它命名。
export const APP_IDENTIFIER = 'app.specseal.desktop';

/// 拍摄期间必须整个移开的用户状态。两处分属不同层，缺一不可：
/// - appConfigDir：connections.json（Server 连接清单）
/// - WebView 数据目录：localStorage（specseal.projectTabs＝workspace 分页、接口偏好）
///   分页不在 appConfigDir——那里的 tabs.json 是七月的残留、现行代码已不再读写，
///   只搬 appConfigDir 的话截屏仍会带着用户真实的 workspace 名称。
export function stateDirsFor({ home, platform }) {
  if (platform !== 'darwin') {
    throw new Error(`截屏场景脚本目前只支持 macOS，目前平台为 ${platform}`);
  }
  return [
    {
      key: 'app-config',
      label: '设置目录（Server 连接清单）',
      path: path.posix.join(home, 'Library', 'Application Support', APP_IDENTIFIER),
    },
    {
      key: 'webview-data',
      label: 'WebView 数据目录（workspace 分页、接口偏好）',
      path: path.posix.join(home, 'Library', 'WebKit', APP_IDENTIFIER),
    },
  ];
}

/// 脚本自建的两个工作路径。备份刻意放在 home 而非暂存区——暂存区可能被系统清掉
/// 或在重开机后消失，而备份没还原就等于用户的分页与连接设置消失。
export function pathsFor({ home, tmpdir }) {
  return {
    backupRoot: path.posix.join(home, '.specseal-docs-screenshots-backup'),
    // 目录名会出现在分页与窗口标题上，所以用中性的示范项目名。
    workspace: path.posix.join(tmpdir, 'acme-web'),
  };
}

/// 备份清单的落点（--restore 靠它知道哪些目录「原本就不存在」）。
export function manifestPathIn(backupRoot) {
  return path.posix.join(backupRoot, 'manifest.json');
}

/// 每个状态目录对应一个以 key 命名的备份落点——两处的目录名相同，用 basename
/// 会互相覆盖。
export function backupPlanFor({ stateDirs, backupRoot, exists }) {
  return stateDirs.map((dir) => ({
    key: dir.key,
    label: dir.label,
    source: dir.path,
    backup: path.posix.join(backupRoot, dir.key),
    existed: exists(dir.path),
  }));
}

/// 还原步骤：拍摄期间 app 会自行重建状态目录，所以两种情况都要先删掉现场的目录，
/// 差别只在后面搬不搬得回来。原本不存在的不带备份路径——没有东西可搬回。
export function restoreStepsFor(entries) {
  return entries.map((entry) =>
    entry.existed
      ? { key: entry.key, source: entry.source, backup: entry.backup, action: 'restore' }
      : { key: entry.key, source: entry.source, action: 'discard' },
  );
}

/// pgrep 的 exit code 语意：0＝有符合、1＝没有符合、其余＝pgrep 本身失败。
/// 失败绝不可当成「没在跑」——那会让备份在 app 运行中开始，还原结果被 app 退出时
/// 写回的内存状态覆盖掉。
export function appIsRunning(result) {
  if (result.error) {
    throw new Error(`无法确认 desktop app 是否运行中（pgrep：${result.error.message}）`);
  }
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  const how = result.status === null ? `signal ${result.signal}` : `exit ${result.status}`;
  throw new Error(`无法确认 desktop app 是否运行中（pgrep 以 ${how} 结束）`);
}

/// 备份：拒绝条件全部在任何搬移之前判定，被拒绝的路径上一个文档都不会动。
export function prepareBackup({ platform, home, backupRoot, isRunning, ops }) {
  const stateDirs = stateDirsFor({ home, platform });

  if (isRunning) {
    throw new Error(
      'Specseal desktop 正在运行——请先完全结束 app 再重跑（不代为结束 app：你可能正在里面工作）',
    );
  }

  // 备份路径还在，代表上一次拍摄没有还原完成。覆盖它就等于把用户真正的设置
  // 换成拍摄期间的空白状态，这是本脚本最不能犯的错。
  if (ops.exists(backupRoot)) {
    throw new Error(
      `备份路径已存在：${backupRoot}\n上一次拍摄没有还原完成。先运行 --restore 把它搬回原位，再重跑 --setup。`,
    );
  }

  const plan = backupPlanFor({ stateDirs, backupRoot, exists: ops.exists });
  ops.mkdir(backupRoot);
  for (const entry of plan) {
    if (entry.existed) ops.rename(entry.source, entry.backup);
  }
  ops.writeFile(manifestPathIn(backupRoot), `${JSON.stringify({ entries: plan }, null, 2)}\n`);
  return plan;
}

/// 待拍清单（readme-open-source-refresh design「截屏依语言分目录、文档名相同」）。
/// 每个文档名在 SHOT_LOCALES 的每个语言目录各拍一张：英文文档引用 en/、繁中文档引用 zh-CN/。
export const SHOT_LIST = [
  { file: 'desktop-board.png', what: '看板四栏都有卡片' },
  { file: 'desktop-change-detail.png', what: '变更详情页（文档树、内容、信息三栏）' },
  { file: 'desktop-discussion.png', what: '讨论详情页' },
  { file: 'desktop-spec.png', what: '规格详情页' },
  { file: 'desktop-archived.png', what: '已封存列表' },
  { file: 'desktop-manual.png', what: '手册页' },
  { file: 'desktop-settings.png', what: '设置模式' },
  { file: 'server-setup.png', what: 'server 初始设置第二步（创建项目与保存库）' },
  { file: 'server-overview.png', what: '后台总览（含「开始使用」区块）' },
  { file: 'server-members.png', what: '用户详情页的成员资格' },
  { file: 'server-project.png', what: '项目详情页（保存库与成员）' },
  { file: 'desktop-tray.png', what: '系统匣面板（只截取面板窗口，不含菜单列）' },
  { file: 'claude-code-panel.png', what: 'Claude Code 技能列与侧边面板的看板分页' },
  { file: 'claude-code-quality.png', what: 'Claude Code 侧边面板的品质分页（列出示范审查工单）' },
  { file: 'claude-code-hash-menu.png', what: 'Claude Code 输入框打 # 跳出的变更菜单' },
  { file: 'herdr-panel.png', what: 'Herdr 窗口：左边的阶段徽章与 Agents 清单、右边的 Specseal 面板，要看得到章的图标和 ⋯ 展开的技能（用隔离窗口和假 agent 拍）' },
  { file: 'herdr-skill-picker.png', what: 'Herdr 的技能跳窗（只裁跳窗）' },
];

/// 截屏的接口语言，也是 SHOT_DIR 底下的子目录名。
export const SHOT_LOCALES = ['en', 'zh-CN'];

/// 截屏存放位置（相对 repo root）。
export const SHOT_DIR = 'docs/assets/screenshots';

const TEAM_INVITES = {
  name: 'add-team-invites',
  state: 'proposed',
  capability: 'team-invites',
  description: 'Let team leads invite members by email',
  completedTasks: 0,
  artifacts: {
    proposal: `## Why

Adding someone to a shared store means asking a maintainer to run a CLI command. Team leads cannot grow their own team, so onboarding stalls on whoever holds the terminal.

## What Changes

- Send an invitation email carrying a single-use join link
- Let the lead pick the member role before the invitation goes out
- Expire unaccepted invitations so stale links cannot be redeemed

## Capabilities

### New Capabilities

- \`team-invites\`: Invite members by email and let them join without a maintainer

### Modified Capabilities

（None）

## Impact

- **Code**: server membership routes, settings UI
- **Behavior**: an invited member reaches the store without touching the CLI
`,
    design: `## Context

Membership is written directly by maintainers today. The store already knows every role, so the missing piece is a way to hand out a scoped, expiring token that a newcomer can redeem themselves.

## Goals / Non-Goals

**Goals:**
- One invitation link redeems exactly once
- The role is fixed when the invitation is issued, not when it is accepted
- An unaccepted invitation stops working on its own

**Non-Goals:**
- Bulk import from an external directory
- Self-service signup without an invitation

## Decisions

### Single-use tokens over shareable links

A shareable link cannot tell two people apart, so the audit trail loses who joined with which grant. Single-use tokens keep one row per member.

## Risks / Trade-offs

- A lost invitation email needs a reissue rather than a resend; accepted as the cost of single use.
`,
    tasks: `## 1. Invitation lifecycle

- [ ] 1.1 Issue an invitation with a fixed role and an expiry
- [ ] 1.2 Redeem an invitation exactly once
- [ ] 1.3 Reject expired and already-redeemed tokens

## 2. Surfaces

- [ ] 2.1 Add the invite form to the members screen
- [ ] 2.2 Show pending invitations with their expiry
`,
    spec: `## Purpose

Invite members to a shared store by email so a team lead can grow the team without a maintainer running CLI commands, with every grant traceable to a single redeemed invitation.

## ADDED Requirements

### Requirement: Invitation issuing

The system SHALL issue an invitation bound to one email address, one role and one expiry moment.

#### Scenario: Role is fixed at issue time
- **WHEN** a team lead issues an invitation with the editor role
- **THEN** the redeemed membership SHALL carry the editor role regardless of when it is accepted

### Requirement: Single redemption

The system SHALL allow each invitation to be redeemed at most once.

#### Scenario: Second redemption is refused
- **WHEN** an already-redeemed invitation link is opened again
- **THEN** the system SHALL refuse the redemption and SHALL NOT create a second membership
`,
  },
};

const SEARCH_RANKING = {
  name: 'improve-search-ranking',
  state: 'in-progress',
  capability: 'search-ranking',
  description: 'Rank search results by relevance instead of file order',
  completedTasks: 2,
  artifacts: {
    proposal: `## Why

Search walks files in directory order, so the match you want is rarely the first one you see. On a store with a few hundred specs, people scroll instead of read.

## What Changes

- Score matches by field weight, with titles above body text
- Break ties by recency so live work floats above archived work
- Show why a result matched

## Capabilities

### New Capabilities

- \`search-ranking\`: Order search results by relevance rather than by file order

### Modified Capabilities

（None）

## Impact

- **Code**: search index, results list
- **Behavior**: the first result is the one people actually open
`,
    design: `## Context

The index already stores every field separately, so ranking needs no new data — only a scoring pass between the match and the result list.

## Goals / Non-Goals

**Goals:**
- A title match outranks a body match for the same term
- Two equally scored results order by most recently touched
- The reason for a match is visible in the result row

**Non-Goals:**
- Fuzzy or phonetic matching
- Learning from click behaviour

## Decisions

### Static field weights over a learned model

Weights are readable and arguable in review; a learned model would need click data the product does not collect.

## Risks / Trade-offs

- Weights need retuning when new fields join the index; the ranking test suite pins the current expectations.
`,
    tasks: `## 1. Scoring

- [ ] 1.1 Score matches per field with static weights
- [ ] 1.2 Break score ties by last-touched time
- [ ] 1.3 Pin the ordering with a ranking test suite

## 2. Result list

- [ ] 2.1 Show the matched field on each result row
- [ ] 2.2 Keep keyboard navigation on the ranked order
`,
    spec: `## Purpose

Order search results by how well they match rather than by where the file sits on disk, so the most relevant spec, change or discussion is the first one a reader sees.

## ADDED Requirements

### Requirement: Relevance ordering

The system SHALL order search results by a relevance score computed from per-field weights.

#### Scenario: Title match outranks body match
- **WHEN** one document matches a term in its title and another matches the same term in its body
- **THEN** the title match SHALL appear above the body match

### Requirement: Stable tie-breaking

The system SHALL order equally scored results by the most recently touched document first.

#### Scenario: Equal scores order by recency
- **WHEN** two results carry the same relevance score
- **THEN** the more recently touched document SHALL appear first
`,
  },
};

const KEYBOARD_SHORTCUTS = {
  name: 'add-keyboard-shortcuts',
  state: 'ready',
  capability: 'keyboard-shortcuts',
  description: 'Reach the most used actions without the mouse',
  completedTasks: null,
  artifacts: {
    proposal: `## Why

Power users switch between the board, search and the editor dozens of times an hour. Every switch is a trip to the mouse.

## What Changes

- Add shortcuts for search, new item and switching views
- Show the shortcut next to each menu entry
- List every shortcut on one help sheet

## Capabilities

### New Capabilities

- \`keyboard-shortcuts\`: Reach the most used actions from the keyboard

### Modified Capabilities

（None）

## Impact

- **Code**: menu definitions, help sheet
- **Behavior**: the common actions work without the mouse
`,
    design: `## Context

The menu already names every action, so shortcuts can hang off the same action table instead of a second registry.

## Goals / Non-Goals

**Goals:**
- One table defines the action, its label and its shortcut
- The help sheet is generated from that table

**Non-Goals:**
- User-defined key bindings

## Decisions

### One action table

Labels and shortcuts that live in two places drift; one table keeps the menu and the help sheet in step.

## Risks / Trade-offs

- A shortcut can collide with a browser default; the table test rejects known collisions.
`,
    tasks: `## 1. Actions

- [ ] 1.1 Add shortcuts to the action table
- [ ] 1.2 Reject shortcuts that collide with browser defaults

## 2. Surfaces

- [ ] 2.1 Show the shortcut next to each menu entry
- [ ] 2.2 Generate the help sheet from the action table
`,
    spec: `## Purpose

Let readers reach the most used actions from the keyboard, with every shortcut discoverable from the menu and from one help sheet.

## ADDED Requirements

### Requirement: Shortcuts for common actions

The system SHALL provide keyboard shortcuts for search, new item and view switching.

#### Scenario: Search from anywhere
- **WHEN** a reader presses the search shortcut on any screen
- **THEN** the search field SHALL receive focus

### Requirement: Discoverable shortcuts

The system SHALL show each shortcut next to its menu entry and on the help sheet.

#### Scenario: Help sheet lists every shortcut
- **WHEN** a reader opens the help sheet
- **THEN** every action with a shortcut SHALL be listed with its key combination
`,
  },
};

const DARK_MODE = {
  name: 'add-dark-mode',
  state: 'archived',
  capability: 'dark-mode',
  description: 'Follow the system appearance and offer a manual override',
  completedTasks: null,
  artifacts: {
    proposal: `## Why

The app is bright white at every hour. People working in a dark room either squint or leave the app off screen.

## What Changes

- Follow the operating system appearance by default
- Offer a manual light or dark override in settings
- Keep the chosen appearance across restarts

## Capabilities

### New Capabilities

- \`dark-mode\`: Follow the system appearance with a manual override

### Modified Capabilities

（None）

## Impact

- **Code**: theme tokens, settings screen
- **Behavior**: the window matches the system appearance on first launch
`,
    design: `## Context

Colours are already expressed as tokens, so a second palette is a token swap rather than a restyle of every component.

## Goals / Non-Goals

**Goals:**
- First launch matches the system appearance with no configuration
- A manual override wins over the system setting until it is cleared
- Switching appearance does not reload the window

**Non-Goals:**
- User-authored themes
- Per-workspace appearance

## Decisions

### Token swap over a parallel stylesheet

Two stylesheets drift apart the moment a component ships a one-off colour; one token set keeps both appearances honest.

## Risks / Trade-offs

- Contrast has to be checked twice, once per appearance; covered by the token contrast test.
`,
    tasks: `## 1. Palette

- [ ] 1.1 Add the dark values to the colour token set
- [ ] 1.2 Check contrast in both appearances

## 2. Selection

- [ ] 2.1 Follow the system appearance on first launch
- [ ] 2.2 Persist the manual override across restarts
`,
    spec: `## Purpose

Render the desktop app in the appearance the reader expects: matching the operating system by default and honouring a manual light or dark choice, with the choice surviving a restart.

## ADDED Requirements

### Requirement: System appearance by default

The system SHALL adopt the operating system appearance when no manual override is set.

#### Scenario: First launch in a dark system
- **WHEN** the app launches with no stored appearance preference on a system set to dark
- **THEN** the window SHALL render in the dark appearance

### Requirement: Manual override wins

The system SHALL honour a manual appearance choice over the operating system setting until the choice is cleared.

#### Scenario: Override survives a restart
- **WHEN** a reader picks the light appearance and restarts the app
- **THEN** the window SHALL render in the light appearance even if the system is set to dark
`,
  },
};

const AUDIT_LOG = {
  name: 'add-audit-log',
  state: 'archived',
  capability: 'audit-log',
  description: 'Record who changed what and when',
  completedTasks: null,
  artifacts: {
    proposal: `## Why

When a setting changes unexpectedly, nobody can tell who changed it or when. Support tickets end in guesses.

## What Changes

- Record every settings and membership change with its actor and time
- Let admins filter the log by actor and by date
- Keep entries for 90 days

## Capabilities

### New Capabilities

- \`audit-log\`: Record who changed what and when, and let admins search it

### Modified Capabilities

（None）

## Impact

- **Code**: settings and membership writes, admin screen
- **Behavior**: every change leaves an entry an admin can find
`,
    design: `## Context

Settings and membership writes already go through one service, so the log can be written in the same transaction as the change it describes.

## Goals / Non-Goals

**Goals:**
- No change lands without its log entry
- Admins find an entry by actor or date in one step

**Non-Goals:**
- Logging read access

## Decisions

### Same transaction as the change

A log written after the fact can miss an entry when the process stops in between; one transaction cannot.

## Risks / Trade-offs

- The log grows with every change; entries older than 90 days are removed nightly.
`,
    tasks: `## 1. Recording

- [ ] 1.1 Write a log entry in the same transaction as each change
- [ ] 1.2 Remove entries older than 90 days

## 2. Admin screen

- [ ] 2.1 List entries newest first
- [ ] 2.2 Filter entries by actor and by date
`,
    spec: `## Purpose

Record every settings and membership change with its actor and time, and let admins find any entry from the last 90 days by actor or by date.

## ADDED Requirements

### Requirement: Every change is recorded

The system SHALL write a log entry with the actor, the time and the changed item in the same transaction as each settings or membership change.

#### Scenario: Change and entry land together
- **WHEN** an admin changes a member role
- **THEN** the log SHALL contain one entry naming the admin, the member and the new role

### Requirement: Admins can search the log

The system SHALL let admins filter log entries by actor and by date range.

#### Scenario: Filter by actor
- **WHEN** an admin filters the log by one actor
- **THEN** the system SHALL list only that actor's entries, newest first
`,
  },
};

/// 示范变更：看板四栏各至少一张卡，另有两个已封存（规格页才有两份正式规格）。
/// 内容全部由本脚本产生，不引用任何真实数据。
export const DEMO_CHANGES = [TEAM_INVITES, SEARCH_RANKING, KEYBOARD_SHORTCUTS, DARK_MODE, AUDIT_LOG];

/// 已就绪变更上的一张未结审查工单（docs-tray-and-mod-screenshots design D2）。不盖章，
/// 让桌面详情页与 Claude Code 插件的品质分页都有内容。finding 为虚构，路径只能是
/// 示范档——审查范围由 evidence 推出，add-round 拒收范围外的路径。
export const DEMO_REVIEW = {
  change: KEYBOARD_SHORTCUTS.name,
  file: {
    path: 'src/actions.ts',
    body: `// One table defines each action, its menu label and its shortcut.
export const actions = [
  { id: 'search', label: 'Search', shortcut: 'Mod+K' },
  { id: 'new-item', label: 'New item', shortcut: 'Mod+N' },
  { id: 'switch-view', label: 'Switch view', shortcut: 'Mod+1' },
];
`,
  },
  findings: [
    {
      severity: 'WARNING',
      path: 'src/actions.ts',
      text: 'Correctness: Mod+N opens a new browser window, and the collision check does not list it, so the shortcut never reaches the app.',
    },
    {
      severity: 'SUGGESTION',
      path: 'src/actions.ts',
      text: 'Standards: Export the action ids as a union type so a menu entry cannot name an action that does not exist.',
    },
  ],
};

/// 示范讨论：已结论，让讨论页不是空的。
export const DEMO_DISCUSSION = {
  slug: 'background-exports',
  topic: 'Should large exports run in the background?',
  status: 'concluded',
  context: 'Exporting a large store freezes the window until it finishes, so people assume the app has crashed and force-quit it.\n',
  rounds: [
    'Option A: run the export as a background job and report progress in a toast.\nOption B: keep it blocking but refuse exports above a size cap.\n\nOption B is cheaper, but the cap has to be guessed and the people it blocks are exactly the ones who need the export most.\n',
    'The import path already runs on the job queue, so Option A reuses it instead of adding a second mechanism.\nA 1,000-item threshold keeps small exports instant; above it the job takes over.\n',
  ],
  // 结论照 discuss 技能现行的写法：Decision 一句起头、其后一点一行，再接 Rationale 与 Rejected alternatives。
  conclusion: `**Decision**: Run large exports as a background job and report progress in a toast.
- Exports above 1,000 items move to the job queue; smaller exports stay instant.
- The toast shows progress and links to the file when it is ready.
- The import path reuses the same toast later.
**Rationale**: A size cap only moves the pain onto the largest stores, and those stores need the export most. A background job keeps the window responsive for everyone, and the job queue already exists for imports.
**Rejected alternatives**:
- Refuse exports above a size cap — the cap has to be guessed, and it blocks the largest stores
- Keep the export blocking with a spinner — the window still freezes, so people still force-quit
`,
};

/// 示范用的 git 身分：示范 workspace 内的 .meta.yaml 会记下 created_by，
/// 沿用用户的全域 git 设置就会把真名与 email 拍进截屏里。
const DEMO_IDENTITY = { name: 'Specseal Demo', email: 'demo@specseal.invalid' };

/// 示范手册：符合 manual-pages 契约的最小一份（index、about 与取材自已封存规格的内容页）。
/// generated 在写档当下才填——要晚于封存写下的规格时戳，手册页才不会被标成可能过期。
export const DEMO_MANUAL = [
  {
    file: 'index.md',
    title: 'Acme Web manual',
    section: 'Getting started',
    order: 10,
    keywords: ['overview', 'getting started'],
    sources: [],
    body: `# Acme Web manual

Acme Web is the browser app the team ships to customers. This manual describes what it does today, page by page.

Three ideas carry the whole app:

- **Workspace**: the place where a team keeps its data and settings.
- **Appearance**: the app follows your system theme unless you pick one.
- **Audit log**: every settings and membership change leaves an entry.

Start with [Appearance and dark mode](appearance.md). Admins go to [Audit log](audit-log.md).`,
  },
  {
    file: 'appearance.md',
    title: 'Appearance and dark mode',
    section: 'Using the app',
    order: 20,
    keywords: ['dark mode', 'theme', 'appearance'],
    sources: ['dark-mode'],
    body: `# Appearance and dark mode

The app matches your operating system appearance the first time it opens. You do not need to set anything.

## Pick an appearance yourself

1. Open **Settings**.
2. Under **Appearance**, choose **Light** or **Dark**.
3. The window switches at once. It does not reload.

Your choice stays after a restart. Choose **System** to follow the operating system again.

> [!TIP]
> If the colours look wrong after a system change, check that **System** is selected.`,
  },
  {
    file: 'audit-log.md',
    title: 'Audit log',
    section: 'Administration',
    order: 30,
    keywords: ['audit', 'history', 'admin'],
    sources: ['audit-log'],
    body: `# Audit log

The audit log answers one question: who changed what, and when.

- Every settings change and every membership change writes one entry.
- An entry names the person, the time and the item that changed.
- Entries stay for 90 days.

## Find an entry

1. Open **Admin** → **Audit log**.
2. Filter by person, by date, or both.
3. The newest entries show first.

> [!NOTE]
> The log records changes only. Opening a page does not write an entry.`,
  },
  {
    file: 'about.md',
    title: 'About this manual',
    section: 'Reference',
    order: 90,
    keywords: ['sources', 'scope'],
    sources: [],
    body: `# About this manual

## Scope

Every page comes from the specs in \`specseal/specs/\`. The manual does not read the code.

## Contradictions in the specs

None found.

## Known limits

- The manual has no screenshots. When the app and the manual differ, trust the app.`,
  },
];

/// 一页手册的完整文档内容：六栏 frontmatter、内文、页脚出处行。
export function renderManualPage(page, generated) {
  const list = (items) => `[${items.join(', ')}]`;
  const sources =
    page.sources.length > 0
      ? page.sources.map((source) => `\`${source}\``).join('、')
      : 'this page introduces the manual; each page lists its own sources.';
  return [
    '---',
    `title: ${page.title}`,
    `section: ${page.section}`,
    `order: ${page.order}`,
    `keywords: ${list(page.keywords)}`,
    `sources: ${list(page.sources)}`,
    `generated: ${generated}`,
    '---',
    '',
    page.body.trim(),
    '',
    `**出处**：${sources}`,
    '',
  ].join('\n');
}

/// 带本机时区偏移的 RFC 3339 秒级时戳（manual-pages 契约的 generated 格式）。
function localTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const hours = pad(Math.floor(Math.abs(offset) / 60));
  const minutes = pad(Math.abs(offset) % 60);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${hours}:${minutes}`
  );
}

export function dryRunReport({ plan, workspace }) {
  const lines = ['[dry-run] 不会搬移、创建或删除任何文档。', '', '将备份的状态目录：'];
  for (const entry of plan) {
    const note = entry.existed ? '' : '（目前不存在，还原阶段改为删除拍摄期间产生的目录）';
    lines.push(`  - ${entry.label}${note}`);
    lines.push(`      来源：${entry.source}`);
    lines.push(`      落点：${entry.backup}`);
  }
  lines.push('', `将创建的示范 workspace：${workspace}`, '', '示范内容：');
  for (const change of DEMO_CHANGES) {
    lines.push(`  - [${STATE_LABEL[change.state]}] ${change.name} — ${change.description}`);
  }
  lines.push(`  - [已结论的讨论] ${DEMO_DISCUSSION.topic}`);
  const severities = DEMO_REVIEW.findings.map((f) => f.severity).join('、');
  lines.push(`  - [审查工单] ${DEMO_REVIEW.change} — 第一轮 ${severities}，不盖章`);
  for (const page of DEMO_MANUAL) {
    lines.push(`  - [手册页] ${page.title}（${page.file}）`);
  }
  lines.push('', `待拍清单（每个文档名在 ${SHOT_LOCALES.map((l) => `${SHOT_DIR}/${l}/`).join(' 与 ')} 各一张）：`);
  for (const shot of SHOT_LIST) {
    lines.push(`  - ${shot.file} — ${shot.what}`);
  }
  return lines;
}

const STATE_LABEL = { proposed: '提案中', 'in-progress': '进行中', ready: '已就绪', archived: '已封存' };

// ---------------------------------------------------------------------------
// 以下为实际运行路径（测试以注入的假 ops 覆盖上方的纯函数，不进入这一段）
// ---------------------------------------------------------------------------

const realOps = {
  exists: existsSync,
  mkdir: (target) => mkdirSync(target, { recursive: true }),
  rename: renameSync,
  writeFile: (target, body) => writeFileSync(target, body),
};

function detectAppRunning() {
  // 涵盖安装版与 dev 两种运行形态：两者的运行文档名相同，只有路径不同。
  return appIsRunning(spawnSync('pgrep', ['-x', 'specseal-desktop']));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) {
    throw new Error(`${command} ${args.join(' ')} 无法运行：${result.error.message}`);
  }
  if (result.status !== 0) {
    const how = result.status === null ? `signal ${result.signal}` : result.status;
    throw new Error(`${command} ${args.join(' ')} 以非零结束（${how}）`);
  }
}

function cli(workspace, args, options = {}) {
  const binary = checkoutCliPath();
  if (!existsSync(binary)) {
    throw new Error(`找不到 checkout 的 CLI：${binary}——先运行 cargo build -p specseal-cli`);
  }
  run(binary, args, { cwd: workspace, ...options });
}

function cliJson(workspace, args) {
  const binary = checkoutCliPath();
  const result = spawnSync(binary, args, { cwd: workspace, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`specseal ${args.join(' ')} 失败：${result.error?.message ?? result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

/// 造出示范 workspace。全新目录——既有内容一律先清掉，避免上一次拍摄的残留混进画面。
/// 对外开放是为了能单独验证示范内容，不必连带搬动用户的状态目录。
export function createDemoWorkspace(workspace) {
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });

  run('git', ['init', '-q', '.'], { cwd: workspace });
  // local 设置盖过全域：created_by 会被写进每个 .meta.yaml。
  run('git', ['config', 'user.name', DEMO_IDENTITY.name], { cwd: workspace });
  run('git', ['config', 'user.email', DEMO_IDENTITY.email], { cwd: workspace });

  cli(workspace, ['init', '--tools', 'claude']);
  // 先 commit：task done 把当下的脏档记进 evidence，不 commit 的话每个变更都会记到
  // init 产生的 .specseal.yaml，审查范围就会跨变更撞名而解析不出来。
  run('git', ['add', '-A'], { cwd: workspace });
  run('git', ['commit', '-q', '-m', 'Initialize Specseal'], { cwd: workspace });

  for (const change of DEMO_CHANGES) {
    cli(workspace, ['new', 'change', change.name, '--description', change.description]);
    writeChangeArtifacts(workspace, change);

    if (change.state === 'proposed') continue;

    const reviewed = change.name === DEMO_REVIEW.change;
    // 审查基准要在标记进行中之前取，否则 review scope 会判定基准太晚。
    if (reviewed) cli(workspace, ['review', 'prepare', change.name]);
    cli(workspace, ['in-progress', 'add', change.name]);
    // 示范档在 task done 之前写好，才会记进 evidence、成为审查范围。
    if (reviewed) writeDemoFile(workspace, DEMO_REVIEW.file);
    const ids = cliJson(workspace, ['instructions', 'apply', '--change', change.name, '--json']).tasks.map(
      (task) => task.id,
    );
    const done = change.completedTasks ?? ids.length;
    for (const id of ids.slice(0, done)) {
      cli(workspace, ['task', 'done', '--change', change.name, id]);
    }
    if (change.state === 'archived') cli(workspace, ['archive', change.name]);
    if (reviewed) openReviewTicket(workspace);
  }

  const { slug, topic, context, rounds, conclusion } = DEMO_DISCUSSION;
  cli(workspace, ['discuss', 'new', topic, '--slug', slug]);
  cli(workspace, ['discuss', 'context', slug], { input: context, stdio: ['pipe', 'inherit', 'inherit'] });
  for (const round of rounds) {
    cli(workspace, ['discuss', 'add-round', slug], { input: round, stdio: ['pipe', 'inherit', 'inherit'] });
  }
  cli(workspace, ['discuss', 'conclude', slug], {
    input: conclusion,
    stdio: ['pipe', 'inherit', 'inherit'],
  });

  const manualDir = path.join(workspace, 'specseal', 'manual');
  mkdirSync(manualDir, { recursive: true });
  const generated = localTimestamp();
  for (const page of DEMO_MANUAL) {
    writeFileSync(path.join(manualDir, page.file), renderManualPage(page, generated));
  }
}

function writeChangeArtifacts(workspace, change) {
  const dir = path.join(workspace, 'specseal', 'changes', change.name);
  writeFileSync(path.join(dir, 'proposal.md'), change.artifacts.proposal);
  writeFileSync(path.join(dir, 'design.md'), change.artifacts.design);
  writeFileSync(path.join(dir, 'tasks.md'), change.artifacts.tasks);
  const specDir = path.join(dir, 'specs', change.capability);
  mkdirSync(specDir, { recursive: true });
  writeFileSync(path.join(specDir, 'spec.md'), change.artifacts.spec);
}

function writeDemoFile(workspace, file) {
  const target = path.join(workspace, file.path);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, file.body);
}

/// 冻结审查范围后写入第一轮，不盖章。
function openReviewTicket(workspace) {
  const { change, findings } = DEMO_REVIEW;
  const { patchHash, paths } = cliJson(workspace, ['review', 'scope', change, '--json']);
  const round = [
    '**Phase**: discovery',
    `**Patch**: ${patchHash}`,
    '**Rules**: extend',
    `**Scope**: ${paths.join(', ')}`,
    ...findings.map((f) => `- [${f.severity}] ${f.path} — ${f.text}`),
  ];
  cli(workspace, ['review', 'add-round', change, '--stdin'], {
    input: `${round.join('\n')}\n`,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
}

/// 还原：先删掉现场的目录，再把备份搬回。任一步失败都印出备份路径——用户至少
/// 知道自己的设置还完整地躺在哪里。
function restoreAll({ backupRoot, workspace }) {
  const manifest = manifestPathIn(backupRoot);
  if (!existsSync(manifest)) {
    console.log(`没有待还原的备份（${manifest} 不存在）。`);
    rmSync(workspace, { recursive: true, force: true });
    return;
  }

  const { entries } = JSON.parse(readFileSync(manifest, 'utf8'));
  for (const step of restoreStepsFor(entries)) {
    try {
      rmSync(step.source, { recursive: true, force: true });
      if (step.action === 'restore') renameSync(step.backup, step.source);
    } catch (error) {
      throw new Error(
        `还原 ${step.source} 失败：${error.message}\n备份完整保留在 ${backupRoot}，手动把 ${step.backup ?? '（原本不存在）'} 搬回 ${step.source} 即可。`,
      );
    }
  }

  rmSync(manifestPathIn(backupRoot), { force: true });
  rmSync(backupRoot, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
  console.log('✓ 已还原原本的 desktop 状态，示范 workspace 已清除。');
}

function printHandoff(workspace) {
  console.log('');
  console.log('─'.repeat(72));
  console.log('状态已备份，示范 workspace 已就绪：');
  console.log(`  ${workspace}`);
  console.log('');
  console.log('接着请你手动完成：');
  console.log('  1. 打开 Specseal desktop（此时它是全新状态，没有任何分页与连接）');
  console.log('  2. 把上面这个路径加入为项目');
  console.log('  3. 每种接口语言各拍一轮（在设置切换语言），只截取 app 窗口：');
  for (const locale of SHOT_LOCALES) {
    console.log(`     ${locale} → ${SHOT_DIR}/${locale}/`);
  }
  for (const shot of SHOT_LIST.filter((s) => s.file.startsWith('desktop-'))) {
    console.log(`       ${shot.file} — ${shot.what}`);
  }
  console.log('     系统匣面板从菜单列的 Specseal 图标打开；它不在 layer 0，取窗口 ID 时别只找 layer 0');
  console.log('     （server 四张另外用一次性的 server 截取，数据目录放在暂存区，不碰 .dev/）');
  console.log('     （claude-code 三张不需要 desktop：在 Terminal 新窗口对示范 workspace 开 Claude Code，');
  console.log('       用 --settings 只开 specseal-skills、清空 statusLine；只开面板、点分页、打 #，');
  console.log('       不按 Enter 送出提示。画面会显示项目路径，示范 workspace 要建在 /Users/Shared/acme-web）');
  console.log('  4. 拍完先完全结束 desktop app，再回到这里按 Enter 还原');
  console.log('');
  console.log('中途 Ctrl+C 也会还原；若脚本整个当掉，改跑 --restore。');
  console.log('─'.repeat(72));
  console.log('');
}

async function waitForEnter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    await new Promise((resolve) => rl.question('拍完并关闭 app 后按 Enter 还原…', resolve));
  } finally {
    rl.close();
  }
}

async function main(argv) {
  const paths = pathsFor({ home: os.homedir(), tmpdir: os.tmpdir() });

  if (argv.includes('--restore')) {
    restoreAll(paths);
    return;
  }

  if (argv.includes('--dry-run')) {
    const stateDirs = stateDirsFor({ home: os.homedir(), platform: process.platform });
    const plan = backupPlanFor({ stateDirs, backupRoot: paths.backupRoot, exists: existsSync });
    console.log(dryRunReport({ plan, workspace: paths.workspace }).join('\n'));
    return;
  }

  if (!argv.includes('--setup')) {
    throw new Error('用法：node scripts/docs/docs-screenshots.mjs [--setup | --restore | --dry-run]');
  }

  prepareBackup({
    platform: process.platform,
    home: os.homedir(),
    backupRoot: paths.backupRoot,
    isRunning: detectAppRunning(),
    ops: realOps,
  });

  // 备份已经落地：从这一刻起，任何离开路径都必须还原。
  let restored = false;
  const restoreOnce = () => {
    if (restored) return;
    restored = true;
    try {
      restoreAll(paths);
    } catch (error) {
      console.error(`docs-screenshots: ${error.message}`);
      process.exitCode = 1;
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      console.log(`\n收到 ${signal}，还原中…`);
      restoreOnce();
      process.exit(1);
    });
  }

  try {
    createDemoWorkspace(paths.workspace);
    printHandoff(paths.workspace);
    await waitForEnter();
  } finally {
    restoreOnce();
  }
}

// node --test 导入本模块时只取函数，不运行任何搬移。
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`docs-screenshots: ${error.message}`);
    process.exit(1);
  });
}

export { ROOT };
