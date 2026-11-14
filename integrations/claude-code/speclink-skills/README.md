# speclink-skills：Speclink 的 Claude Code mod

[English](README.en.md)

在 Claude Code 里加上四样东西：

- **技能列**：输入框上方一排 speclink 技能按钮，依工作流程分成「规划／实作／品质／收尾／其他」五页。点一下就把 `/speclink-…` 指令填进输入框，已经打的字留在后面当参数。「收尾」页的 `archive+commit` 一次填入 `/speclink-archive + /speclink-commit`。鼠标移到技能上，技能列右边会显示它的说明（技能本身的 description）。技能列分三列：「speclink」（右边是目前在处理的步骤与 change）、分页与面板钮、技能。终端机太窄、分页和面板钮放不下一列时（中文标签不到 55 栏、英文不到 60 栏），面板钮移到第一列最右边，分页不会从中间拆开；这时右边没有空间，不显示技能说明。
- **侧边面板**：点技能列的「面板」或输入 `/speclink-panel` 开关。上方三个分页：
  - **看板**：下一步，以及提案中／进行中／已就绪的变更（波次、worktree、任务进度、被谁挡住）。按变更前的 ▸ 展开，显示提案／设计／规格／任务四份文档是否完成，以及依 `##` 分组的任务清单（已勾的画暗，`[M]` 标成「手动」）。
  - **讨论**：讨论中与已结论分开列，按 ▸ 展开读讨论内文。
  - **品质**：每个变更未结的审查、验证工单：第几轮、各严重度几条；按 ▸ 展开读每条发现。
  - 每个区块的标题前都有 ▾，按一下收起。点名称会把它填进输入框，成为最前面那个指令的参数。面板只显示，不会勾任务或改任何东西。
- **输入框的 `#` 菜单**：在输入框打 `#`，上方会出现下拉列表，列出提案中的变更；`#` 后面再打字可以筛选名称（不分大小写）。按 Tab 选第一个，或按 ↓ 选一个再按 Tab／Enter，`#` 那个字就换成变更名称，例如打 `/speclink-apply #` 再选一个变更。没有选就按 Enter，会照你打的字送出。句中也可以用，`#` 前面要有空白。
- **目前在处理什么**：技能列的「speclink」右边标出这个 session 正在跑的步骤与 change，例如 `▸ apply · add-auth`，步骤用它所在分页的颜色。session 标题也换成 `apply · add-auth`，Warp 等会显示终端机标题的分页列，从分页名称就分得出每个 session 在做哪个 change。步骤取自你送出的 `/speclink-…` 指令，以及模型自己调用的 speclink 技能（例如 quality 里接着跑的 review）；change 取自指令的参数，以及技能运行 speclink CLI 时带的 change 名称，所以没打名称也认得出来。discuss、improve、audit、trace、manual、baseline、config 不做 change，消息和指令里提到的名称不算；propose 只认它之后创建的 change。在 Herdr 的终端机里，焦点变了会写成 `speclink.focus` 标签，Herdr 面板就和技能列同步。在某个 change 的 worktree 里开的 session，一开始就标出那个 change。封存完成（change 从清单消失）后标上 `✓`，例如 `archive · add-auth ✓`。送出 `/speclink-…` 指令后，模型还没开始跑任何工具就按 Esc 中断，会回到送出前的步骤与 change；已经开始跑工具才中断，就留在新的步骤。`compact` 不影响；`/clear` 会清掉，标题在你下一次送出消息时改回 `Claude Code`；`/resume` 接回的对话，从它的标题或纪录找回步骤与 change，被 compact 过的也找得回来。还没用过 speclink 的 session 不显示，也不改标题。

![Claude Code 输入框上方是技能列，右边开着侧边面板的看板分页](../../../docs/assets/screenshots/zh-TW/claude-code-panel.png)

<table>
  <tr>
    <td width="50%"><img src="../../../docs/assets/screenshots/zh-TW/claude-code-quality.png" alt="侧边面板的品质分页，列出未结的审查工单与两条发现" /><br /><sub>品质分页</sub></td>
    <td width="50%"><img src="../../../docs/assets/screenshots/zh-TW/claude-code-hash-menu.png" alt="在 /speclink-apply 后面打 #，输入框上方跳出提案中的变更菜单" /><br /><sub>输入框的 <code>#</code> 菜单</sub></td>
  </tr>
</table>

## 需求

- Claude Code 2.1.290 以上（以这一版测试）。mod 的 API 目前是 early access，Claude Code 改版时，这个 mod 可能要跟着更新。
- `speclink` CLI 在 PATH 上。`#` 菜单读的是 `speclink plan` 的 `--json` 输出（5 秒内重用同一份）。面板读的是 `speclink list`、`speclink plan`、`speclink discuss list` 的 `--json` 输出；展开变更时读 `show`、`status`，展开讨论时读 `discuss show`，切到品质分页时读每个变更的 `review show`、`verify show`。worktree 里的变更在它的 worktree 文件夹读。
- 项目运行过 `speclink init`。技能列只显示项目里实际装好的 speclink 技能；没有技能的项目不显示技能列。
- 用鼠标点按钮需要 Claude Code 的全屏幕版面（settings.json 的 `"tui": "fullscreen"`）。

## 安装

在 Claude Code 的输入框输入：

```
/plugin install speclink-skills --marketplace MomoChenisMe/speclink
```

第一次会问要不要加入 `github:MomoChenisMe/speclink` 这个 marketplace，回答 `y`；范围选 user，每个项目都会加载。

更新：运行 `claude plugin update speclink-skills`，再重开 Claude Code。

## 设置

`/config` 里的 **speclink-skills → Language**：

| 值 | 效果 |
| --- | --- |
| `auto`（缺省） | 跟着 Claude Code 的 `language` 设置：写的是中文就用繁体中文，其余用英文 |
| `en` | 英文 |
| `zh-TW` | 繁体中文 |

## 已知限制

- **面板不显示 review、verify 的章**（品质分页只列未结的工单）：CLI 的输出没有盖章状态。`list --json` 刻意不放这些字段；盖章时工单会被删掉，所以盖过章的 `review show` 也会失败。盖章纪录只在变更的 `.meta.yaml` 里，要看章请用桌面 app。
- **`archive+commit`**：Claude Code 只把第一个斜线指令当成指令。实际运行的是 `/speclink-archive`，后面的 `+ /speclink-commit …` 成为它的参数，由模型在封存后接着提交。
- **session 标题要等下一次送出才更新**：Claude Code 只在送出消息与开 session 时让 mod 改标题，所以技能中途才认出（或换了）的 change、封存的 `✓`、`/clear` 后改回 `Claude Code`、按 Esc 后回到原本的步骤，技能列会立刻更新，标题要等你下一次送出消息。设置了焦点之后，你用 `/rename` 取的名字也会在下一次送出时被换掉；`/clear` 时只改回这个 mod 设的标题，你自己取的不动。
- **Windows**：面板经 `cmd.exe /d /c speclink …` 运行 CLI。npm 装的 `speclink` 是 `.cmd` 壳，而 mod 运行指令时不经过 shell，直接运行会失败。这条路径还没有在实机 Windows 上验证。

## 开发

```bash
claude plugin validate integrations/claude-code/speclink-skills
claude plugin test integrations/claude-code/speclink-skills
```

本机开发时，把这个 repo 加成本地 marketplace 再安装。Claude Code 会直接读工作目录，改完运行 `/reload-plugins` 就生效：

```bash
claude plugin marketplace add <speclink repo 的路径>
claude plugin install speclink-skills@speclink
```

Claude Code 加载 mod 后，会在 `.claude-plugin/types/` 产生类型档（已列入 `.gitignore`）。之后在 repo 根目录运行 `npx tsc -p integrations/claude-code/speclink-skills` 就能做类型检查。

技能分页表在 `hooks/groups.ts`。`scripts/claude-code/skill-groups.test.mjs` 会拿它对照 repo 里的 `.claude/skills/speclink-*`：speclink 添加或移除技能时，这个测试会提醒你同步分页表。
