# 设置说明

**简体中文** · [English](configuration.md)

Speclink 的设置分三层：工作流政策写在 `speclink/config.yaml`，跟着规格走；这个 checkout 接哪些 AI 工具、连哪个远程，写在 `.speclink.yaml`；登录凭证放在用户层，不进项目。环境变量可以在单次运行时盖过政策。

## <a id="layers"></a>设置放在哪里

| 位置 | 放什幺 | 谁会读 | 进版本控制 |
| --- | --- | --- | --- |
| `speclink/config.yaml` | 工作流政策：`schema`、`locale`、`spec_locale`、`tdd`、`audit`、`worktree`、`context`、`rules`、`review`、`subagent_model` | CLI、桌面 app；技能通过 `speclink instructions` 取得生效值 | 是 |
| `.speclink.yaml` | 这个 checkout 的绑定：`tools`、`spec_dir`、`remote` | CLI、桌面 app | 是（里面没有凭证） |
| `.speclink/` | 本机工作数据：封存与品质关卡用的快照、生成工具的记录、远程模式的唯读内容快照 | CLI、桌面 app | 否（`speclink init` 会把它加进 `.gitignore`） |
| 用户层设置目录 | `credentials.yaml`（CLI 用访问密钥登录时存的凭证）、`schemas/`（用户层自订 schema）、`config.yaml`（`speclink config` 的键值） | CLI、桌面 app | 否 |
| 系统钥匙圈 | 设备登录的凭证、桌面 app 存的访问密钥（PAT） | CLI 与桌面 app 共用 | 否 |
| `SPECLINK_*` 环境变量 | 单次运行的覆写 | CLI、Node SDK | 否 |

用户层设置目录的位置：

- macOS：`~/Library/Application Support/speclink/`
- Linux：`$XDG_CONFIG_HOME/speclink/`；没设 `XDG_CONFIG_HOME` 时是 `~/.config/speclink/`
- Windows：`%USERPROFILE%\AppData\Roaming\speclink\`

桌面 app 自己的接口语言与服务器连接清单存在 app 的文档夹，凭证存在系统钥匙圈，都不写进项目。

桌面 app 的「设置」以设置模式打开：左栏列出分类，「应用进程」下有一般、更新、CLI、服务器，「关于」下有「关于 Speclink」。一般与 CLI 页的内容只存在这台机器，「服务器」页管理服务器连接清单。

![桌面 app 的设置模式，左栏是设置分类，右边是「一般」页](assets/screenshots/zh-TW/desktop-settings.png)

新设置该放哪里，照这三条判断：

- 会改变产出内容的设置（语言、TDD、audit、worktree 流程）是**政策**，放 `speclink/config.yaml`，全队读到同一份。
- 只跟这个 checkout 有关的设置（接哪些 AI 工具、连哪个远程）放 `.speclink.yaml`。
- 个人或 CI 的临时差异用环境变量，不改任何文档。

`speclink config` 与 `speclink workflow-config` 是两回事。`speclink config` 管用户层 `config.yaml` 的通用键值，Speclink 的其他指令都不读它。工作流政策一律用 `speclink workflow-config` 改。

## <a id="resolution"></a>解析顺序

政策值由上往下找，先找到的生效：

| 顺序 | 来源 | 说明 |
| --- | --- | --- |
| 1 | `SPECLINK_LOCALE`、`SPECLINK_SPEC_LOCALE`、`SPECLINK_TDD`、`SPECLINK_AUDIT`、`SPECLINK_WORKTREE` | 布尔变量只认 `true`／`false`（不分大小写）。`1`、`yes`、空字符串都当成没设，往下一层找 |
| 2 | `speclink/config.yaml` | 项目的正式值 |
| 3 | 内置缺省 | `locale` 与 `spec_locale` 为 English；`tdd`、`audit`、`worktree` 为关闭；`schema` 为 `spec-driven` |

另外三件事：

- `.speclink.yaml` 里的政策键（`locale`、`tdd` 等）不会生效，也不会警告。请照原值搬到 `speclink/config.yaml`。
- 环境变量只影响你这台机器上运行的 CLI 与 Node SDK。远程模式的指引由 server 依团队设置产生，本机环境变量盖不过团队政策。
- 要不要产生两个 worktree 技能，只看 `speclink/config.yaml` 的 `worktree`。`SPECLINK_WORKTREE` 不影响技能档。

远程连接另有两条顺序：

- **连接网址**：`SPECLINK_STORE_URL` 优先，其次是 `.speclink.yaml` 的 `remote.url`。是不是远程模式只看 `.speclink.yaml` 有没有 `remote:` 区段，`SPECLINK_STORE_URL` 不会把本机项目切成远程模式。有 `remote:` 区段、两边却都没有网址时，指令直接报错，不会退回本机模式。
- **凭证**：依序找 `SPECLINK_TOKEN` → 钥匙圈里的设备登录 → 钥匙圈里的访问密钥 → 用户层的 `credentials.yaml`。凭证以服务器的 origin（`scheme://host:port`）区分，同一台 server 上的项目共用一份登录。`speclink auth status` 会告诉你目前用的是哪一层。

## <a id="workflow-config"></a>修改工作流政策

用 `speclink workflow-config`。本机模式改 `speclink/config.yaml`，远程模式改 server 上的那一份。

| 子指令 | 作用 |
| --- | --- |
| `show [--json]` | 显示文档里的值。不套用环境变量 |
| `set <key> <value>` | 改 `locale`、`spec_locale`、`tdd`、`audit`、`worktree` 其中一个 |
| `context --stdin` | 用 stdin 的内容整段取代 `context`。内容只有空白时移除这个键 |
| `rules <artifact> --stdin` | 用 stdin 整段取代一个 artifact 的规则，一行一条，空行略过。stdin 为空时移除这一节。`<artifact>` 必须是目前 schema 的 artifact id |
| `review <list> --stdin` | 用 stdin 整段取代一个审查规则清单，一行一条，空行略过。stdin 为空时移除这个清单。`<list>` 是 `critical`、`warning` 或 `suggestion` |
| `review baseline <mode>` | 设置审查关卡要不要检查内置的 12 条 code smell。`<mode>` 是 `extend`（缺省，写入时移除这个键）或 `replace` |
| `subagent-model <station> <tool> <model>` | 设置一个品质关卡在一个 AI 工具里派出的子代理用哪个模型。`<station>` 是 `review` 或 `verify`；`<tool>` 是 kebab-case 的工具名称，例如 `claude`、`codex`。`<model>` 给空字符串（`""`）时移除这个设置，子代理回到沿用主对话的模型 |
| `subagent-model choices <tool> --stdin` | 用 stdin 整段取代一个 AI 工具的自订模型清单，一行一个名称，空行略过。stdin 为空时移除这个清单 |

写入规则：

- `locale` 只收 `tw`、`ja`、`en`；`spec_locale` 另外收 `auto`（跟着 `locale`）。大小写要相同。写「简体中文」这类名称会被拒绝，错误消息会列出可用的代码。
- `tdd`、`audit`、`worktree` 只收 `true`／`false`。设成 `false`（或把 `locale` 设成空字符串）会删掉那一行，回到默认值。
- 所有写入子指令都有 `--dry-run`：只印出差异，不写档。差异逐行比对新旧内容：只有被删除、添加或移动位置的行会标 `-`／`+`；改动范围内其余没改的行以前后文呈现，夹在两处改动之间的也一样。范围前后另外最多各带三行没改的内容。
- `review` 的写入会整块取代 `review` 区块：`extend` 不写 `baseline` 键、清单清空就移除该键、整块没有内容时移除 `review` 键。`review` 区块内的注解不会保留。
- `review` 或 `subagent-model` 写入后，指令会检查本机项目的技能档。技能档比引擎旧时，写入照样成功，但 stderr 会多一行警告，提示运行 `speclink update`——旧版技能可能不套用审查规则或子代理模型。
- `review` 区块采严格解析：出现不认得的键（例如打错成 `critcal`）、`baseline` 不是 `extend` 或 `replace`、或清单里有不是字符串的条目时，整份文档视为无法解析。读这份文档的指令都会失败并点名出错的键，直到你改正。
- `subagent-model` 的写入会整块取代 `subagent_model` 区块：某一站或某个清单清空就移除该键，整块没有内容时移除 `subagent_model` 键。工具名称依字母序写出，区块内的注解不会保留。写入结果和原本相同时（例如移除一个本来就没有的设置），文档保持原样，并印出 `unchanged`。
- `subagent_model` 区块同样采严格解析：出现不认得的键（例如打错成 `reveiw`）、工具名称不是 kebab-case 或在同一个 map 里重复、或值不是字符串时，整份文档视为无法解析。模型名称不检查：工具不认得某个名称时，品质关卡会停在派出子代理的那一步，并显示工具的错误。
- 只改目标那几行，其他内容与注解原样保留。文档无法解析时读写都会拒绝，不会盖掉你的内容。
- 本机模式下改 `worktree` 会同时产生或移除两个 worktree 技能。还有 worktree 没收尾时，不能从 `true` 改成 `false`；指令会列出那些 worktree，请先用 `speclink-worktree-merge` 收掉。
- 远程模式下，如果别人刚好同时写入，指令会失败并请你重跑，不会盖掉别人的修改。脱机或凭证失效也会直接失败，不会排队。

```bash
speclink workflow-config set tdd true --dry-run   # 先看差异
speclink workflow-config set tdd true             # 再写入
cat CONTEXT.md | speclink workflow-config context --stdin
```

在刚 `speclink init` 完的项目跑第一行，**预期输出**：

```text
--- a/speclink/config.yaml
+++ b/speclink/config.yaml
@@ -1,5 +1,7 @@
 schema: spec-driven
 
+tdd: true
+
 # Workflow policy (optional)
 # Personal/CI overrides: SPECLINK_LOCALE, SPECLINK_SPEC_LOCALE, SPECLINK_TDD, SPECLINK_AUDIT, SPECLINK_WORKTREE
 #
```

`workflow-config set` 不收 `schema`。要换 schema，用下列任一种方式：

- 直接编辑 `speclink/config.yaml` 的 `schema:` 那一行。
- `speclink schema init <name> --default`：创建一个新的自订 schema，并设成项目缺省。
- 桌面 app「项目设置」的「产出流程」页。

桌面 app 的「项目设置」改的是同一份文档，规则也相同；其中「项目设置 › 品质关卡 › 子代理模型」页改的是同一个 `subagent_model` 区块。内置技能 `speclink-config` 会从代码整理出 `context` 与 `rules`，先给你看差异，你同意后才写入。政策字段（含 `worktree`）它会用一张表列出现值，只问你要不要改。审查规则是选用的：可以不设置、附加在内置检查之后（`extend`），或取代内置检查（`replace`）。你可以交给它一份提醒清单（粘贴或给文档路径），它会逐条判断要放进审查规则、某个 artifact 的产出规则（`rules`），还是不收，并说明理由。审查规则只收你给的，不从代码推导。

审查关卡要套用 `review` 区块，需要这个版本以后的 CLI 与技能档；升级后请运行 `speclink update`。旧版 CLI 会略过这个区块。

审查与验证两站在运行时通过 `speclink workflow-config show --json` 读取 `subagent_model`，改了设置不必跑 `speclink update` 就生效；但旧版的技能档不会读它，升级后请运行 `speclink update`。工具没办法替子代理指定模型时，该站沿用主对话的模型并写明这一点。Codex 要在 `~/.codex/config.toml` 设 `expose_spawn_agent_model_overrides = true` 才能指定。

## <a id="tools"></a>AI 工具与自订工具

`.speclink.yaml` 的 `tools` 决定要为哪些 AI 工具产生技能档：

| 值 | 技能档位置 |
| --- | --- |
| `claude` | `.claude/skills/` |
| `codex`（`agents` 是它的别名） | `.agents/skills/` |
| `copilot` | `.github/skills/` |
| `pi` | `.pi/skills/` |
| `cursor` | `.cursor/skills/` |
| 自订工具描述子 | 描述子的 `skills_dir` |

GitHub Copilot 也会读 `.claude/skills/` 与 `.agents/skills/`，但它先读 `.github/skills/`。所以选了 `copilot`，Copilot 用的就是写给它的那一份。pi 也会读 `.agents/skills/`，但它先读 `.pi/skills/`，同名技能用先读到的那一份；所以同时选 `codex` 与 `pi` 时，pi 启动会对每个同名技能显示一则警告，用的仍是 pi 版。pi 要先信任项目才读项目里的技能。Cursor 也会读 `.agents/skills/`、`.claude/skills/` 与 `.codex/skills/`。

改完 `tools` 后运行 `speclink update`。新加的工具会产生技能档；从清单拿掉的工具，它的 `speclink-*` 技能目录会被删除，因此变空的目录也一并移除。在桌面 app「项目设置」的「AI 工具」页勾选内置工具时，会自动做同样的同步。

升级到支持 pi 与 Cursor 的版本后，如果 `tools` 没有列 `pi` 或 `cursor`，第一次同步会把 `.pi/skills/`、`.cursor/skills/` 下名称以 `speclink-` 开头的目录当成取消勾选的工具删除，即使那是你以前手动放的。要保留，请在 `tools` 加上 `pi` 或 `cursor`。

已勾选工具的 skills 目录不能经 symlink 和另一个工具共用同一个目录（例如把 `.cursor/skills` 连到 `.claude/skills`）：两个工具会互相覆写或删掉对方的技能，所以同步会在写入任何文档前以一行错误拒绝。请拿掉链接，或取消勾选其中一个工具。连到项目外共用文档夹的 symlink 不受影响。

其他 AI 工具用描述子接上：

```yaml
tools:
  - claude
  - name: my-harness
    skills_dir: .my-harness/skills
    invocation: tool-call
```

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `name` | 是 | kebab-case，2–50 个字符，只能用 `a-z`、`0-9`、`-`。不能是 `claude`、`codex`、`agents`、`copilot`、`pi`、`cursor` |
| `skills_dir` | 是 | 项目根目录下的相对路径。不能跑出项目、不能是项目根目录本身，也不能是 `.claude/skills`、`.agents/skills`、`.github/skills`、`.pi/skills` 或 `.cursor/skills`（不分大小写） |
| `invocation` | 否 | `cli`（缺省）：技能写「运行 `speclink <动词>`」。`tool-call`：技能写「调用 speclink 工具，参数是 argv 数组」 |
| `instructions_file` | 否，已弃用 | 不再产生任何内容，只用来让 `speclink update` 清掉旧版留下的 `SPECLINK` 区块。留着会在 stderr 印一行弃用提示 |

字段不合法时，指令印出一行指出字段的错误，并以非零结束。描述子产生的技能没有 `/speclink-` 斜线指令，也不提 plan mode；内置的 claude、codex、copilot、pi、cursor 不受影响。

旧版允许名为 `copilot`、或 `skills_dir` 是 `.github/skills` 的描述子。升级后 `speclink update` 会拒绝它并以非零结束。删掉这个描述子，改在 `tools` 写 `copilot` 即可。名为 `pi` 或 `cursor`、或 `skills_dir` 是 `.pi/skills`、`.cursor/skills` 的描述子也一样：删掉描述子，改在 `tools` 写 `pi` 或 `cursor`。

## <a id="remote"></a>远程模式

接上远程后，设置的归属不变，只是「规格放在哪里」换成 server：

- `speclink link <url> --repo <name>` 在 `.speclink.yaml` 写入 `remote:` 区段（`url` 与 `repo`），`speclink unlink` 移除它。有这个区段就是远程模式。
- 工作流政策改存在 server 上。`speclink workflow-config` 读写 server 那一份，本机的 `speclink/config.yaml` 不再生效。
- `.speclink/context/` 是远程内容的唯读快照。不要手改，下一个指令会发现它被改过而拒绝运行；要刷新就重新运行 `speclink instructions`。
- 凭证不写进任何项目文档，所以 `.speclink.yaml` 可以放心 commit。

怎幺启动 server、登录、断线后怎幺恢复，见 [Remote 入门](remote-getting-started.zh-CN.md)。启动 server 用的环境变量（例如 `SPECLINK_PORT`）也在那里。

## <a id="reference"></a>完整键值参考

### `speclink/config.yaml`

| 键 | 值 | 缺省 | 用途 |
| --- | --- | --- | --- |
| `schema` | schema 名称 | `spec-driven` | 新变更使用的产出流程（产出哪些文档、什幺顺序） |
| `locale` | `tw`、`ja`、`en` | English | AI 产出文档与报告的语言；review、verify 也用它呈现结果。其余时候 Agent 用你的语言跟你对话 |
| `spec_locale` | `tw`、`ja`、`en`、`auto` | English | 规格档的语言；`auto` 跟着 `locale` |
| `tdd` | `true`／`false` | `false` | 实作时先写会失败的测试，再写进程（红→绿） |
| `audit` | `true`／`false` | `false` | 实作时对新 API 与参数处理做 sharp-edges 安全检查 |
| `worktree` | `true`／`false` | `false` | 打开 worktree 平行实作流程，并产生两个 worktree 技能 |
| `context` | 多行文本 | 无 | 产生 artifact 时提供给 AI 的项目背景 |
| `rules` | artifact id → 规则清单 | 无 | 各 artifact 的撰写规则 |
| `review.baseline` | `extend`、`replace` | `extend` | 审查关卡检查内置 12 条 code smell 再加上项目规则（`extend`），或只用项目规则（`replace`） |
| `review.critical`、`review.warning`、`review.suggestion` | 规则清单 | 无 | 审查关卡 Standards 轴的项目审查规则。规则放在哪个清单，违反时就记成那个严重度 |
| `subagent_model.review.<tool>`、`subagent_model.verify.<tool>` | 模型名称 | 无（沿用主对话的模型） | 在该 AI 工具里跑审查关卡时两个子代理用的模型，或跑验证关卡时子代理用的模型。`/speclink-quality` 沿用这两个值。Claude Code 收 `sonnet`、`opus`、`haiku`、`fable` |
| `subagent_model.choices.<tool>` | 模型名称清单 | 无 | 项目共用的某个 AI 工具的自订模型清单。`speclink workflow-config show --json` 会连同内置清单一起带出 |

其他键会被忽略。

### `.speclink.yaml`

| 键 | 值 | 缺省 | 用途 |
| --- | --- | --- | --- |
| `spec_dir` | 相对路径 | `speclink` | 规格目录的位置，相对于项目根目录。没写时，旧版创建、只有 `openspec/` 的项目照常读 `openspec/`，直到 `speclink update` 把它搬到 `speclink/`；搬移与 OpenSpec 导入都不会写入这个键。写明这个键的项目不会自动搬移 |
| `tools` | 清单 | 无 | 要产生技能档的 AI 工具：`claude`、`codex`、`copilot`、`pi`、`cursor` 或自订工具描述子 |
| `remote.url` | 网址 | 无 | 远程项目的连接网址（project-scoped URL） |
| `remote.repo` | 名称 | 无 | 这个 repo 在远程项目里的注册名称；只有一个 repo 的项目可以省略 |

### 环境变量

| 变量 | 值 | 作用 |
| --- | --- | --- |
| `SPECLINK_LOCALE` | 语言代码 | 覆写 `locale` |
| `SPECLINK_SPEC_LOCALE` | 语言代码或 `auto` | 覆写 `spec_locale` |
| `SPECLINK_TDD` | `true`／`false` | 覆写 `tdd` |
| `SPECLINK_AUDIT` | `true`／`false` | 覆写 `audit` |
| `SPECLINK_WORKTREE` | `true`／`false` | 覆写 `worktree`；不影响技能档要不要产生 |
| `SPECLINK_STORE_URL` | 网址 | 取代 `remote.url`；不会把本机项目切成远程模式 |
| `SPECLINK_TOKEN` | 访问密钥 | 远程凭证，优先于钥匙圈与 `credentials.yaml`，适合 CI |
