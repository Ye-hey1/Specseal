# 完整 SDD 工作流

**简体中文** · [English](workflow.md)

这份文档说明 Speclink 的每一站：做什幺、用哪个技能、什幺时候可以跳过、怎样算完成、完成后去哪里。

第一次用，先照 [Local Repo 入门](getting-started.zh-CN.md)走一轮。想知道某项能力现在能不能用，查[项目能力状态](product-status.zh-CN.md)。

## <a id="mental-model"></a>整体流程

```text
baseline? → discuss?/improve? → propose → apply ⇄ ingest → (quality? | review? ∥ verify?) → archive
                                            ↑
                                    闲置后续作：先 drift

worktree：apply-with-worktree ⇄ ingest → (quality? | review? ∥ verify?) → worktree-merge → archive
      或：apply-with-worktree ⇄ ingest → worktree-merge → (quality? | review? ∥ verify?) → archive

工具：validate / analyze / audit / commit / config / manual / trace / plan
```

- 带 `?` 的站是选用的。
- `propose → apply → archive` 是每个变更都会走的主线。实作途中需求改变，就在 `apply` 与 `ingest` 之间来回。
- 封存前有两道选用的品质关卡：`review` 看代码写得好不好，`verify` 看交付是否符合规格。两道互不依赖，依风险决定要跑哪几道。低风险的变更两道都跳过也可以。
- 工具类的站在需要时才用，不是每个变更都要经过。

桌面 app 把这条路线画成看板：讨论、提案中、进行中、已就绪四栏，每张卡片就是一个变更或一份讨论。已封存的变更在另一个页面。

![Speclink 桌面 app 的看板，分成讨论、提案中、进行中与已就绪四栏](assets/screenshots/zh-TW/desktop-board.png)

## <a id="entry"></a>从哪一站开始

依序问下面的问题，第一个答「是」的就是入口：

| 问题 | 入口 |
| --- | --- |
| 只是想了解某件事，没有要做决定？ | 直接问 Agent，不要建讨论记录。 |
| 既有进程还没有任何规格？ | 先 `baseline`。它只描述现在的行为，不创建变更。 |
| 已经有相关的变更？ | 继续实作用 `apply`；新的背景会改到文档，用 `ingest`。 |
| 变更停了一阵子，规划时的假设可能已经不对？ | 先 `drift`，再依结果回 `apply` 或 `ingest`。 |
| 想改善代码，但讲不出要改哪里？ | `improve`，请模型扫描并提出候选。 |
| 新需求已经清楚？ | 清楚就 `propose`；还要取舍就 `discuss`。 |

## <a id="stage-types"></a>站的种类

| 种类 | 站 | 说明 |
| --- | --- | --- |
| 主线 | `propose`、`apply`、`ingest`、`archive` | 变更从规划、实作、更新需求，到合并进正式规格。 |
| 视情况 | `baseline`、`discuss`、`improve`、`drift`、worktree 流程 | 既有进程第一次建规格、需求要收敛、停了一阵子再继续，或要平行推多个变更时才用。 |
| 品质关卡 | `review`、`verify`、`quality` | 封存前的两道选用检查，各自记工单、盖章。 |
| 工具 | `validate`、`analyze`、`audit`、`commit`、`config`、`manual`、`trace`、`plan` | 检查文档、安全检查、提交、设置、手册、溯源与运行顺序。 |

## <a id="how-to-call"></a>怎幺调用

| 层 | 负责什幺 | 例子 |
| --- | --- | --- |
| 技能 | 写给 Agent 读的流程知识：什幺时候读什幺、怎幺产生与检查文档、什幺时候停下来问你。 | Claude、GitHub Copilot 与 Cursor `/speclink-propose`、Codex `$speclink-propose`、pi `/skill:speclink-propose` |
| `speclink` CLI | 真正运行动作的命令行。本地与远程都用它。 | `speclink status --change add-csv-export` |
| Host | 把引擎、Store、认证、版本、交易与事件组在一起。CLI、server 与 Node SDK 都经过它。 | 内嵌在 CLI 里，或 `speclink-server` |

下面的技能名都用 Claude 的写法，GitHub Copilot 与 Cursor 的写法相同。Codex 把开头的 `/` 换成 `$`，也可以输入 `/skills` 从清单挑。pi 把开头的 `/` 换成 `/skill:`。`analyze` 是例外：只有 Claude 有这个技能，Codex、GitHub Copilot、pi 与 Cursor 直接用 CLI。

升级 Speclink 之后，运行 `speclink update` 重新产生技能档。

## <a id="stages"></a>各站说明

每一站用同样的格式：第一句是用途，下面的清单是细节。

### <a id="baseline"></a>baseline：创建规格基准

从现有的代码与测试，为系统现在的行为创建正式规格。旧称 onboard。

- **什幺时候用**：既有项目刚导入 Speclink、还没有规格，或只想补上没涵盖的能力。**跳过**：已经有足够的规格，或你要写的是新需求。
- **输入 → 产物**：README、进程入口、原代码、测试、`speclink/config.yaml` 的项目说明与产出规则，以及你确认过的 capability 清单 → 直接写进 `speclink/specs/<capability>/spec.md`，不创建变更。
- **技能**：`/speclink-baseline [范围]`
- **底层 CLI**：没有 `speclink baseline` 指令。Agent 写完规格后，用 `speclink validate --specs --all --strict` 检查。
- **完成**：你确认了能力的边界，每份规格都有代码证据，strict 检查通过。
- **下一步**：新需求走 `propose`；还模糊就先 `discuss`。
- **出状况**：发现既有规格要改，不要在 baseline 里改，另开一个变更。

### <a id="discuss"></a>discuss：讨论

把需要取舍的问题一轮一轮谈清楚，留下有来源的结论。

- **什幺时候用**：需求模糊、有好几个合理做法、需要做决定。**跳过**：只是想了解某件事；或需求已经清楚，直接 `propose`。
- **输入 → 产物**：一个主题，或一份文档的路径（自己写的计划、plan mode 的产出）→ `speclink/discussions/<slug>.md`，含背景、每一轮与结论。
- **技能**：`/speclink-discuss <主题或文档路径>`。开场会先搜索旧讨论，不重提已否决的方向。
- **底层 CLI**：`speclink discuss new`、`context`、`add-round`、`conclude`、`search`。
- **完成**：结论写明决定、理由、否决的方案、暂缓的事与下一步。
- **下一步**：见[讨论结论怎幺走](#discussion-outcomes)。
- **出状况**：已经谈出内容的讨论，写结论后封存。什幺都还没谈出来，才用 `speclink discuss discard` 删掉。

在桌面 app 的看板点一则讨论，会打开它的详情页。左栏文档树列出结论、讨论过程、背景与衍生变更四份文档；没有分段的旧讨论只有一份「记录」。

![讨论的详情页，左栏是文档树，中间是结论](assets/screenshots/zh-TW/desktop-discussion.png)

### <a id="improve"></a>improve：找改进点

请模型扫描代码，提出可以改进的候选，写成一份讨论。

- **什幺时候用**：想改善代码，但讲不出要改哪里。**跳过**：你已经知道要改什幺，那是 `discuss` 或 `propose` 的题目。
- **限制**：只有你可以发起，模型不会自己跑。它只产生讨论记录，不改代码。
- **输入 → 产物**：你指定的方向（最好有），或依 Git 历史的热点推测范围 → 一份标记为改进讨论的讨论记录，每个候选附文档、问题、解法、好处与建议强度。
- **技能**：`/speclink-improve [范围]`
- **底层 CLI**：`speclink discuss new <主题> --kind improve`，之后和 `discuss` 相同。
- **完成**：候选都列出来，你挑一个谈完，结论也写下了。候选全部不采用也要写结论并封存，下次扫描才不会重提。
- **下一步**：采用的候选走 `propose`；全部不采用就封存讨论。
- **出状况**：模型重提已否决的候选时，会指出是哪一份讨论否决的。

### <a id="propose"></a>propose：提案

创建一个可以交给实作的变更。

- **什幺时候用**：需求已经清楚，或一份已写结论的讨论要变成完整提案。**跳过**：只是问问题、只要整理现有规格（用 `baseline`），或变更已经存在只需要更新（用 `ingest`）。
- **输入 → 产物**：需求描述、讨论（`--from-discussion <slug>`）或一份文档（`--from-doc <path>`）→ `proposal.md`、delta 规格、`tasks.md`，需要时加上 `design.md`。实际要哪几份，由产出流程决定。
- **技能**：`/speclink-propose <变更名称>`。写完文档后，它会跑 `analyze` 修正问题（最多两轮），再跑 `validate`，最后用 `speclink change depends` 记下这个变更要等哪些变更先做完。
- **底层 CLI**：`speclink new change`、`instructions`、`new artifact`、`analyze`、`validate`、`change depends`。
- **完成**：`speclink status --change <名称>` 显示开工需要的文档都完成，`validate` 通过。
- **下一步**：由你决定何时 `apply`。
- **出状况**：需求还不清楚，回 `discuss`。

### <a id="apply"></a>apply：实作

照任务清单实作，每完成一项就勾掉。

- **什幺时候用**：开工需要的文档都齐了。**跳过**：文档还没齐、需求正在变，或变更停了一阵子还没跑 `drift`。
- **输入 → 产物**：提案、规格、设计（如果有）与任务 → 代码与测试的修改、勾好的任务，以及每项任务动到哪些文档的证据。证据写在 `speclink/changes/<名称>/.evidence.json`，跟着变更一起提交。
- **技能**：`/speclink-apply <变更名称>`
- **底层 CLI**：开工前先跑 `speclink plan`，被其他变更挡住就停下来。接着 `speclink review prepare`（记下品质关卡要用的起点）与 `speclink in-progress add`。实作时用 `speclink instructions apply --change <名称> --json` 取得背景，每完成一项跑 `speclink task done --change <名称> <编号>`。
- **完成**：每项任务的行为与该过的测试都通过，`instructions apply` 回报 `state: all_done`。标着 `[M]` 的手动任务由你确认，Agent 不会代勾。
- **下一步**：依风险决定要不要跑品质关卡，然后 `archive`。需求改变就先 `ingest`。
- **出状况**：
  - 勾错或实作回滚：`speclink task undone --change <名称> <编号>`。
  - 误开工而且还没动任何东西：`speclink in-progress remove <名称>`，退回提案中。
  - 不做了：`speclink discard <名称>`，开工后要加 `--force`。

实作期间，变更的详情页最好用：左栏文档树列出提案、设计、任务、规格与调度；有未结的审查或验证工单时，另会出现「审查」「验证」。「状态」区的「任务进度」列就是 `speclink task done` 的结果。

![变更的详情页，左栏是文档树，中间是提案内容](assets/screenshots/zh-TW/desktop-change-detail.png)

### <a id="ingest"></a>ingest：更新需求

把新的需求、计划或讨论结论，并进已经存在的变更。

- **什幺时候用**：实作途中需求或背景改变，或一份讨论的结论要并进既有变更。**跳过**：只是继续实作、文档不用改（用 `apply`）；还没有变更（用 `propose`）。
- **输入 → 产物**：既有的变更，加上对话内容或一份计划档 → 更新后的提案、设计、规格与任务。已完成的任务不会被改写。
- **技能**：三种写法。
  - `/speclink-ingest <变更名称>`：技能用目前对话的内容，更新这个进行中的变更。技能不会再问你要更新哪一个。
  - `/speclink-ingest`：用目前对话的内容。要更新哪个变更，技能会从对话判断或问你。
  - `/speclink-ingest <计划档>`：用一份计划档。参数同时是进行中的变更名称和计划文档名称时，技能用变更；要用计划档，请写完整路径。
- **底层 CLI**：`speclink instructions <artifact> --json`、`analyze`、`validate`。讨论并入时，内容写进去之后再跑 `speclink discuss seal <slug> <变更名称>`。
- **完成**：新背景都反映到受影响的文档，已完成的任务没被改写，`analyze` 与 `validate` 通过。有 link 的话也已经 seal。
- **下一步**：回 `apply`。
- **出状况**：不要先 seal 再补内容。seal 代表内容已经写进去了。参数打错时，技能会说明两件事：参数不是进行中的变更，也找不到同名计划档。消息也会提醒你：要指定变更，参数只写变更名称，说明放在对话里。然后技能会停下，不改任何文档。

### <a id="drift"></a>drift：检查漂移

检查一个停了一阵子的变更，和现在的代码差多远。

- **什幺时候用**：变更暂停后要继续，或怀疑别人的 commit 改到同一块。**跳过**：一路连续在做，基准没变。变更创建超过 5 天，而且最近 3 天没有人动它，`apply` 会建议先跑 drift。
- **输入 → 产物**：变更的文档、Git 历史、目前的代码与证据 → 一份报告：漂移程度（light、medium、heavy）、失效的参照、任务冲突，以及一个建议的下一步。
- **技能**：`/speclink-drift <变更名称>`
- **底层 CLI**：`speclink drift <变更名称> --json`
- **完成**：报告列出时间差、失效参照、任务冲突与建议，你选好了下一步。
- **下一步**：light 回 `apply`；medium 用 `ingest` 更新计划；heavy 建议用 `speclink archive <名称> --skip-specs` 收掉重来，也可以先试 `ingest`。
- **出状况**：看不懂的外部修改先保留，不要用重置或覆写解决。

### <a id="worktree"></a>worktree：平行实作

同时推多个互不相干的变更，每个变更在自己的 git worktree 里做，彼此不干扰。

- **什幺时候用**：手上有两个以上互不冲突的变更。**跳过**：只有一个变更，或几个变更会改到同一批文档（排队做比较快）。
- **前置**：先打开 worktree 设置：`speclink workflow-config set worktree true`。两个 worktree 技能只在设置打开时才会产生。
- **输入 → 产物**：一个可以开工的变更 → 一个 worktree 与分支。实作与提交在里面完成。提交后分支会先追上主分支，之后合并就是直线前进（fast-forward）。
- **技能**：`/speclink-apply-with-worktree <变更名称>`，收尾用 `/speclink-worktree-merge <变更名称>`。一次只处理一个变更；要平行就另开窗口，每个 session 各跑一个。
- **底层 CLI**：`speclink plan` 判断哪些变更可以并行；`speclink list` 用 `[worktree]` 标出在 worktree 里的变更。品质关卡的起点由技能代为移动：分支追上主分支后跑 `speclink review prepare <change> --base <commit>`；合并时跑 `speclink review prepare <change> --base <commit> --from <worktree-path>`，同时把品质关卡的快照带进主 checkout。
- **完成**：worktree 里的任务做完、变更已提交。接着品质关卡有两条路：
  - 没有未完成的手动任务：在 worktree 里跑品质关卡，提交盖章的异动，再跑 `worktree-merge`。
  - 还有手动任务没做，或想在盖章前先看到 CI 结果（worktree 分支只在你的电脑上，CI 看不到）：先跑 `worktree-merge`，再到主 checkout 跑品质关卡。

  `worktree-merge` 把分支并回主分支、把品质关卡的起点带进主 checkout，并清掉 worktree。
- **下一步**：回主 checkout 运行 `archive`。封存只能在主 checkout 跑，在 worktree 里会被拒绝。
- **出状况**：worktree 里的 `tasks.md` 和主 checkout 的是两份，只改 worktree 那份。用旧版 worktree-merge 技能合并的变更，主 checkout 没有起点：跑品质关卡时，用 `--base` 指定一次变更第一个 commit 的上一个 commit。现在的合并技能会在合并时写入起点，不管 apply 用的是哪一版技能。

### <a id="quality"></a>quality：两道关卡一起跑

同一个变更要跑两道品质关卡时，用它一次安排好。

- **什幺时候用**：改动大，代码品质与是否符合规格都在意。**跳过**：只想跑一道，直接用 `/speclink-review` 或 `/speclink-verify`。
- **输入 → 产物**：进程任务都完成的变更 → 两张工单（`review.md`、`verify.md`），最后是两枚章。
- **技能**：`/speclink-quality <变更名称>`
- **底层 CLI**：`speclink review` 与 `speclink verify` 的 `scope`、`add-round`、`show`、`stamp`。
- **完成**：两道都先检查、先不盖章，每一轮停下来等你决定：全修、挑着修，或不修。你说可以了，才依序盖章：先审查，再验证。
- **下一步**：`archive`（worktree 流程先 `worktree-merge`）。
- **出状况**：没有问题的一轮也会停下来，不会自己盖章或封存。检查途中不要提交，提交会让修改离开检查的范围。

### <a id="review"></a>review：审查

检查代码写得好不好，发现的问题分级记在工单里。

- **什幺时候用**：改动大、跨模块，或是会长期维护的代码。**跳过**：低风险的小改动。跳过是正当选择，不是欠帐。
- **输入 → 产物**：从 apply 开工时记下的起点到现在的修改 → `review.md` 工单。问题分 CRITICAL、WARNING、SUGGESTION 三级。判准是 repo 自己的惯例文档，加上常见的代码坏味道与找 bug。
- **技能**：`/speclink-review <变更名称>`
- **底层 CLI**：`speclink review prepare`（`--base` 与 `--from` 移动起点，worktree 技能会用到）、`scope`、`add-round`、`show`、`stamp`、`discard`。
- **完成**：进程任务都完成，最后一轮没有必修问题（CRITICAL、WARNING），就可以盖章。SUGGESTION 不挡章。
- **下一步**：也要跑 `verify` 就接着跑，否则 `archive`。
- **出状况**：有必修问题但你决定接受，用 `speclink review stamp --accept` 带着问题盖章。

### <a id="verify"></a>verify：验证

逐条对照这个变更的规格，判断交付是否符合。

- **什幺时候用**：规格条款多，或符合规格本身就是交付重点。**跳过**：低风险的小改动。
- **输入 → 产物**：变更的全部文档，以及冻结下来的修改内容 → `verify.md` 工单。
- **技能**：`/speclink-verify <变更名称>`。任务还没做完时也能跑，当作进度盘点。
- **底层 CLI**：`speclink verify scope`、`add-round`、`show`、`stamp`、`discard`。
- **完成**：进程任务都完成，最后一轮没有必修问题。SUGGESTION 不挡章。
- **下一步**：`archive`。
- **出状况**：第一轮做完整检查。之后每一轮只看上一轮没解决的问题，以及修正造成的新问题。必修问题每一轮都要变少；没有变少就以「未通过」停下，保留工单、不盖章。

### <a id="quality-rules"></a>品质关卡的共同规则

| | `review` 审查 | `verify` 验证 |
| --- | --- | --- |
| 回答的问题 | 代码写得好不好 | 交付是否符合规格 |
| 看什幺 | 修改的代码，对照 repo 惯例 | 变更的规格，逐条对照修改 |
| 产物 | `review.md` 工单 | `verify.md` 工单 |
| 盖章顺序 | 先 | 后 |

- **前提**：只看进程任务。标着 `[M]` 的手动任务没勾，也可以检查与盖章；但封存前要完成。
- **两道都跑时，先修完再一起盖**：章记录的是范围内文档的内容。先盖的章会被另一道关卡的修正弄成「其后有变动」。
- **盖章会消耗工单**：盖章时，同一次写入会写上章，并删掉工单（`review.md`、`verify.md`）。所以已盖章的变更封存后没有工单档，盖章后 `show` 回报「没有工单」是正常的。本地模式的工单文本只留在 Git 历史；远程模式盖章后读不回工单文本。
- **只有没结的工单会跟着封存**：要用 `--carry-review` 或 `--carry-verify` 明确带走。
- **盖章后文档又被改**：卡片显示「已审查·其后有变动」或「已验证·其后有变动」，封存也会被挡。工单在盖章时已经删掉，所以重新盖章要从第一轮重跑；两道都盖过章时，两道关卡都要从第一轮重跑。
- **先把最新的主分支合进来，再跑关卡**：主分支前进时若改到这个变更范围内的档，而你在盖章后才合进来，即使没有冲突，章也会失效，又得从第一轮重跑。做法：先 commit 这个变更的档（含新档），再 rebase 或合并主分支；接着用 `speclink review prepare <变更名称> --base <新的分岔点>` 把关卡的起点移到新的分岔点，否则第一轮会把主分支的修改算成这个变更的。要先 commit，是因为没 commit 的档会被 `prepare` 当成开工前就有的修改。
- **项目有 CI 时，先等 CI 在所有平台通过再盖章**：章记录的是范围内文档的内容。盖章后为了让 CI 通过再改任何一行，章都会失效。
- **封存遇到没结的工单会被挡**：回去盖章、用 `discard` 放弃这道关卡，或用 `--carry-*` 带着走。

卡片与系统匣面板上，审查章与验证章并排显示，审查在前。系统匣面板从 macOS 菜单列的 Speclink 图标打开，不开主窗口也能看到各项目的变更与品质关卡。

<img src="assets/screenshots/zh-TW/desktop-tray.png" width="280" alt="Speclink 系统匣面板，依提案中、进行中、已就绪与讨论分组列出变更" />

### <a id="archive"></a>archive：封存

把 delta 规格合并进正式规格，并把完成的变更移进封存区。

- **什幺时候用**：任务全部完成（含 `[M]` 手动任务）、文档检查通过、假设没有过期，而且选择要跑的品质关卡都结束了。**跳过**：还有任务没做完、`validate` 没过，或需求还在变。
- **输入 → 产物**：可以封存的变更 → 更新后的正式规格，以及 `speclink/changes/archive/<日期>-<名称>/`。
- **技能**：`/speclink-archive <变更名称>`。封存前会依 `plan` 提醒封存顺序，封存后点名下一个可以开工的变更。
- **底层 CLI**：`speclink archive <名称>`。可以一次列多个名称，或用 `--all` 封存所有可以封存的变更。远程一次只能封存一个。
- **完成**：指令成功，印出合并进正式规格的统计，变更已移进封存区。如果变更来自一份已写结论的讨论，而且它是那份讨论最后一个还没封存的变更，讨论也会一起封存（讨论标了 `hold` 的除外）。
- **下一步**：用 `/speclink-commit` 或你自己的方式提交。
- **出状况**：
  - 不要用 `--no-validate` 或 `--mark-tasks-complete` 跳过没做完的事。
  - 规划时的假设已经过期：回 `drift` 或 `ingest`，不要硬封存。
  - 被章失效或没结的工单挡下：见[品质关卡的共同规则](#quality-rules)。

封存后的变更与讨论都在桌面 app 的「已封存」页，分成已封存的变更与已封存的讨论两个分页。

已封存的变更列表上方有「流程成本（中位数）」摘要，列出全部已封存变更的中位数：文档行数（附 P90）、任务数、创建到封存的天数，以及品质关卡轮数。每个数字都标出用了几笔变更。搜索不会改变摘要。小时数与轮数只有这个版本之后封存的变更才有。远程模式不显示这个摘要。

![桌面 app 的已封存页，分成已封存的变更与已封存的讨论两个分页](assets/screenshots/zh-TW/desktop-archived.png)

### <a id="validate"></a>validate：格式检查

检查变更或规格的格式、必要段落与规则。封存时会被拒收的 delta（目标需求不存在、撞名、少声明移除的 scenario），也会在这里提早抓出来。

- **什幺时候用**：提案完成、文档更新后、封存前。交付前不要跳过。
- **技能**：没有独立技能，`propose`、`ingest` 与 `archive` 会调用它。
- **CLI**：`speclink validate <名称>`；检查全部正式规格用 `speclink validate --specs --all --strict`。
- **完成**：exit code 为 0，显示 valid。
- **下一步**：`analyze`、实作，或 `archive`。
- **出状况**：照错误消息修文档，再跑一次。

### <a id="analyze"></a>analyze：交叉比对

交叉比对提案、设计、规格与任务，找出涵盖、一致、模糊与缺漏四类问题。

- **什幺时候用**：提案或 ingest 完成后（技能会自动跑）。它不是进程测试。
- **技能**：`/speclink-analyze <变更名称>`（只有 Claude 有；Codex、GitHub Copilot、pi 与 Cursor 直接用 CLI）。
- **CLI**：`speclink analyze <名称> [--json]`
- **完成**：没有 CRITICAL；WARNING 与 SUGGESTION 看过并决定是否处理。
- **下一步**：修文档，或 `apply`。
- **出状况**：有 CRITICAL 就先修文档，不要开始实作。

### <a id="audit"></a>audit：安全检查

从安全的角度检查还没提交的进程修改：危险的默认值、类型混淆、静默失败。

- **什幺时候用**：碰到认证、权限、设置、外部输入或对外置口时。`speclink/config.yaml` 设了 `audit: true` 时，`apply` 实作时也会套用精简版的检查。**跳过**：只改文档。
- **输入 → 产物**：`git diff HEAD`（目前还没提交的修改）→ 依严重度排序的问题清单。它不改变变更的状态，也不是每个变更都要跑。
- **技能**：`/speclink-audit`（不带变更名称）
- **CLI**：没有 `speclink audit` 指令。
- **完成**：每个问题都附位置、可能被怎幺误用、怎幺修；或明确回报没有问题。
- **下一步**：修正后回 `apply` 或跑测试。

### <a id="commit"></a>commit：限定范围的提交

只挑出属于某一个变更的文档来提交。

- **什幺时候用**：想要一个只含单一变更的 commit。**跳过**：你有自己的提交方式。它不是每个变更都要经过的一站。
- **输入 → 产物**：变更名称、Git 状态与任务证据 → 经你确认的文档清单，以及一个 commit。
- **技能**：`/speclink-commit <变更名称>`。也支持「先封存再一起提交」。
- **CLI**：技能用 `speclink list --json`、`.evidence.json`、`speclink artifact cat`、`speclink plan` 与 Git 判断文档，不用 `git add .`。
- **完成**：commit 只含你确认过的文档，并回报 hash 与消息。
- **下一步**：继续 `apply`，或 `archive`。提交不能取代封存。
- **出状况**：清单里有无关的文档就排除，不要覆写或删掉它们。

### <a id="config"></a>config：工作流设置

从代码整理出项目说明与产出规则，写进 `speclink/config.yaml`，让 Agent 写出的文档贴合这个 repo。

- **什幺时候用**：刚导入时，或项目惯例改变后。**跳过**：缺省已经够用。
- **输入 → 产物**：代码、套件设置、README 与测试 → 经你核可的 diff。
- **技能**：`/speclink-config`
- **CLI**：`speclink workflow-config show`、`set`、`context`、`rules`。字段见[设置说明](configuration.zh-CN.md)。
- **完成**：diff 经你核可并写入。
- **下一步**：回任何一站；之后产生的文档都会套用新设置。
- **出状况**：写错就再跑一次改回来，不影响既有变更。

### <a id="manual"></a>manual：手册

从正式规格产生给人读的操作手册（`speclink/manual/`），或在对话中带你导览系统。

- **什幺时候用**：需要一份手册、要带新人认识系统，或封存后想知道哪些手册页可能过期。**跳过**：没有用户面的规格，或没人要读手册。
- **输入 → 产物**：只读正式规格，不读 README、docs 或代码 → 手册页（含首页与来源页）。导览模式不写档。
- **技能**：`/speclink-manual`（产生）、`/speclink-manual 导览`（导览）
- **CLI**：没有 `speclink manual` 指令。桌面 app 的「手册」页可以浏览手册。
- **完成**：摘要列出添加、重写、没动的页数，以及可能过期的页。
- **下一步**：提交手册的修改。远程项目目前不能产生手册，导览可以。

![桌面 app 的手册页，左栏是页面清单，中间是内容与出处规格](assets/screenshots/zh-TW/desktop-manual.png)
- **出状况**：手册页是一般文档，删掉或还原即可。

### <a id="trace"></a>trace：溯源

回答「这个功能怎幺来的、为什幺这样设计」。它沿着正式规格、封存的变更、讨论与代码往回找。

- **什幺时候用**：接手不熟的功能，或要改一个设计之前。只限本地。
- **输入 → 产物**：一个 capability 名称或一个问题 → 溯源链：哪些变更、哪些讨论、动过哪些文档，每一段都附来源。
- **技能**：`/speclink-trace <capability 或问题>`
- **CLI**：`speclink trace <capability> [--json]`
- **下一步**：要改就 `discuss` 或 `propose`。

### <a id="plan"></a>plan：运行顺序

排出所有未封存变更的运行顺序。

- **什幺时候用**：手上有多个变更，不知道先做哪个。技能也会自动用它：propose 收尾记下依赖、apply 开工前检查、archive 前后提醒顺序。
- **输入 → 产物**：所有未封存的变更与声明的依赖 → 一份顺序，内容有：
  - 一波一波的顺序。同一波的变更可以并行。
  - 每个变更被谁挡住。
  - 下一个可以开工的变更。
  - 两个变更改到同一条需求时的封存顺序。
- **技能**：没有独立技能。
- **CLI**：
  - `speclink plan [--json]`
  - 声明依赖：`speclink change depends <变更> --on <前置变更>`（加 `--remove` 取消）
  - 调整同一栏里的顺序：`speclink change rank <变更> --before <另一个变更>`（或 `--after`；只限本地）
- **下一步**：从 `next` 指出的变更开工。桌面变更详情页文档树的「调度」文档与「状态」区的「调度」列显示同一份信息。

## <a id="discussion-outcomes"></a>讨论结论怎幺走

| 结论 | 什幺时候用 | 怎幺做 | 结果 | 下一步 |
| --- | --- | --- | --- | --- |
| 创建新变更，一次写完 | 结论明确，想直接拿到全部文档 | `/speclink-propose --from-discussion <slug>` | 创建并链接变更，写完开工需要的全部文档 | 文档检查通过后，由你决定何时 `apply` |
| 创建新变更，先占位 | 只想先创建变更，稍后再写完整提案 | `speclink discuss promote <slug> [--name <变更名称>]` | 创建变更，用结论（没有结论时用主题）预填 proposal 的 Why，讨论标为已转出变更。**还不能开工** | 对这个变更再跑一次 `propose`，补齐文档 |
| 并入既有变更 | 结论要修正一个进行中的变更 | `speclink discuss link <slug> <变更>` → `/speclink-ingest <变更>` → `speclink discuss seal <slug> <变更>` | `link` 只创建来源链接；`ingest` 把内容写进文档；`seal` 才把讨论标为已转出变更 | 回 `apply` |
| 决定不做 | 谈出了内容，但结论是不做 | `speclink discuss archive <slug>` | 保留结论与理由，不创建空的变更 | 无 |

- 转为变更不一定要等讨论结束：讨论还在进行时，就可以先转出一部分。
- 一份讨论可以转出好几个变更。要分批转出时，用 `speclink discuss conclude --hold` 保留讨论；转出最后一批时加 `--last`（`discuss promote`、`new change --from-discussion` 与 `discuss seal` 都接受）。
- 讨论已写结论、没有标 `hold`，而且最后一个关联的变更封存时，讨论会自动一起封存。
- `link` 之后不能先 `seal` 再补内容。seal 代表决定已经写进文档了。
- 想找以前的决定：`speclink discuss search <关键字>` 会搜索进行中与已封存的讨论。

## <a id="recovery"></a>出状况时

| 状况 | 怎幺办 |
| --- | --- |
| 转为变更后只有 proposal 的骨架 | 对同一个变更跑 `propose`，不要直接 `apply`。 |
| 讨论结论要并进既有变更 | `link` → `ingest` → `seal`，三步都要。 |
| 变更停了一阵子 | 先 `drift`；light 回 `apply`，假设过期走 `ingest`。 |
| 实作途中需求改变 | `ingest` 更新文档，再跑 `analyze` 与 `validate`，然后回 `apply`。 |
| `apply` 说缺文档 | 回 `propose` 补齐。 |
| `apply` 说被其他变更挡住 | 先做挡住它的变更，或用 `speclink change depends --remove` 取消不需要的依赖。 |
| 任务勾错或实作回滚 | `speclink task undone --change <名称> <编号>`。 |
| 误开工、想退回提案中 | `speclink in-progress remove <名称>`，只有还没动任何东西时可以。 |
| 远程的唯读投影标成可能过期或被改动 | 不要直接改投影；重新取得 instructions 让它更新。 |
| `analyze` 有 CRITICAL | 先修文档的涵盖、一致与缺漏问题，再实作。 |
| 盖章后文档又被改 | 从第一轮重跑失效的关卡再盖章；两道都盖过章时两道都要重跑。 |
| 封存被没结的工单挡下 | 回去盖章、放弃这道关卡，或用 `--carry-*` 带着走。 |
| 在 worktree 里封存被拒 | 先 `worktree-merge` 回主分支，在主 checkout 封存。 |
| 封存说 delta 过期或不完整 | 回 `drift` 或 `ingest` 修正 delta，再跑 `validate`。 |

## <a id="limits"></a>目前限制

- `validate` 与 `analyze` 只检查文档，不是进程测试，也不代表实作符合规格。实作面由品质关卡负责。
- 桌面 app 的远程看板勾任务时，不回报动到的文档（CLI 会）。其他限制见[项目能力状态](product-status.zh-CN.md)。

## <a id="related"></a>相关文档

- [Local Repo 入门](getting-started.zh-CN.md)
- [Remote 入门](remote-getting-started.zh-CN.md)
- [设置说明](configuration.zh-CN.md)
- [项目能力状态](product-status.zh-CN.md)
- [动词与旗标契约](verb-contract.zh-CN.md)
