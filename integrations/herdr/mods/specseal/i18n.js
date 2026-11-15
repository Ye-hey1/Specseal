// 接口文本跟随系统语系：中文系统用中文，其他系统用英文。
// 面板自己的文本以中文为原文，Herdr 的文本以英文为原文，所以 tr() 查的表看语系决定，查不到就用原文。
// 这支不碰 Herdr API，scripts/herdr/panel-model.test.mjs 直接测，也会检查每句中文都有英文。

let lang = "zh";

export const setLang = (next) => {
  lang = next;
};

// macOS 的 AppleLanguages 长这样：( "zh-Hant-TW" )。其他系统是 zh_TW.UTF-8。第一个语言算数。
export const langFrom = (text) => (text.match(/[A-Za-z]{2,}/)?.[0].toLowerCase() === "zh" ? "zh" : "en");

const READ = 'defaults read -g AppleLanguages 2>/dev/null || echo "$LC_ALL $LC_MESSAGES $LANG"';

// Herdr 的 JS 环境没有 Intl 和 navigator，要问系统。exec 由调用的人传进来，这支才不用碰 Herdr API。
// 先用上次的结果，画面才不会先闪另一种语言。
export function watchLang(exec, cx, ui) {
  lang = localStorage.getItem("lang") ?? lang;
  if (ui) translateHerdr(ui);
  cx.spawn(async (cx) => {
    const r = await exec("sh", ["-c", READ]).catch(() => null);
    const next = langFrom(r?.stdout ?? "");
    localStorage.setItem("lang", next);
    if (next === lang) return;
    lang = next;
    cx.notify();
  });
}

export const TO_ZH = {
  // Herdr 内置画面：分页列、状态栏
  Files: "文件",
  Changes: "变更",
  commands: "指令",
  // 设置页
  Look: "外观",
  Keyboard: "键盘",
  Machines: "机器",
  MACHINES: "机器",
  Alerts: "提醒",
  Updates: "更新",
  Privacy: "隐私",
  Terminals: "终端机",
  System: "跟随系统",
  Light: "浅色",
  Dark: "深色",
  "Type to search fonts": "输入文本搜索字体",
  "This layout sets its own; yours shows in the others.": "这个版面有自己的设置，你的设置会用在其他版面。",
  LAYOUT: "版面",
  THEME: "主题",
  Appearance: "外观模式",
  "Light or dark, or as your system is now.": "浅色、深色，或跟随系统目前的设置。",
  "For the layout you're in: each layout keeps its own light and dark theme.": "只影响目前的版面：每个版面各自记住浅色和深色主题。",
  "SIZE AND FONTS": "大小与字体",
  Zoom: "缩放",
  "Everything: terminals, panels, text.": "全部一起缩放：终端机、面板和文本。",
  Reset: "重设",
  "Terminal font": "终端机字体",
  "Interface font": "接口字体",
  "Automatic (Alt on US keyboards)": "自动（美式键盘当 Alt）",
  "Types characters": "输入字符",
  "Left Option is Alt": "左 Option 当 Alt",
  "Right Option is Alt": "右 Option 当 Alt",
  "OPTION KEY": "Option 键",
  "Use Option for terminal shortcuts or to type accents and special characters.": "Option 键可以当终端机快捷键，也可以用来输入重音和特殊字符。",
  "Couldn't read machines.": "读不到机器清单。",
  "It didn't work.": "没有成功。",
  "Updating…": "更新中…",
  "Renaming…": "改名中…",
  "Removing…": "移除中…",
  Update: "更新",
  Rename: "重命名",
  Remove: "移除",
  "Copying this computer's herdr-core. Its terminals keep running.": "正在拷贝这台电脑的 herdr-core。它的终端机会继续运行。",
  Cancel: "取消",
  "Remove machine": "移除机器",
  "New name (addresses using the old name stop working)": "新名称（用旧名称的地址会失效）",
  Save: "保存",
  "Your computers, reached over ssh. Their terminals keep running when you disconnect.": "通过 ssh 连接的电脑。中断连接后，它们的终端机会继续运行。",
  "Connected · hc version unknown": "已连接 · 不知道 hc 版本",
  "Reading machines…": "读取机器中…",
  "No other machines yet.": "还没有其他机器。",
  "Add a machine": "添加机器",
  "Herdr's sound": "Herdr 的音效",
  SOUNDS: "音效",
  Sounds: "音效",
  "Play sounds": "播放音效",
  "When an agent needs you, and when one finishes while you're not looking. A note shows in the corner either way.": "agent 需要你时，以及你没在看时有 agent 做完时。不管有没有开，角落都会跳通知。",
  "An agent needs you": "agent 需要你",
  Play: "播放",
  "An agent finished": "agent 做完了",
  "Want your own sounds? Ask your agent to set sounds.done and sounds.blocked in settings.json to an MP3.": "想用自己的音效吗？请 agent 把 settings.json 的 sounds.done 和 sounds.blocked 设成 MP3。",
  "Checking…": "检查中…",
  "Up to date.": "已是最新版本。",
  "No successful check. Check your connection and try again.": "还没有检查成功。请检查网络连接后再试一次。",
  "✓ Up to date": "✓ 已是最新版本",
  "Check now": "立即检查",
  "A build from source: it updates with git, not here.": "这是从原代码建置的版本，要用 git 更新，不在这里更新。",
  "Restart to update": "重新启动并更新",
  "Updating… your terminals keep running.": "更新中…你的终端机会继续运行。",
  "Try again": "再试一次",
  "Update herdr-core": "更新 herdr-core",
  "Not checked: a build from source looks for no updates.": "没有检查：从原代码建置的版本不会找更新。",
  "What's new": "新功能",
  "Herdr looks for both every hour and tells you in the corner. herdr-core runs your terminals, so they keep running through its updates.": "Herdr 每小时检查这两个，有更新时会在角落通知。herdr-core 负责运行你的终端机，所以更新时终端机会继续运行。",
  "USAGE DATA": "使用数据",
  "Share anonymous usage data": "分享匿名使用数据",
  "Once a day: which agents and features you use, how many spaces and tabs, your system and Herdr's version. Never what's in your terminals, never names of files, folders or projects.": "每天一次：你用哪些 agent 和功能、有几个工作区和分页、你的系统和 Herdr 版本。绝不包含终端机内容，也绝不包含文件、文件夹或项目的名称。",
  "What we send": "我们发送的内容",
  "This build never sends: it's built from source. You can still see what a release would send.": "这个版本从原代码建置，不会发送。你还是可以看到正式版会发送什么。",
  "Exactly what leaves your computer, word for word.": "一字不差，就是离开你电脑的内容。",
  Hide: "隐藏",
  Show: "显示",
  "Nothing is collected or sent while it's off.": "关闭时不会收集也不会发送任何数据。",
  "Sent as is, soon.": "很快会原封不动发送。",
  "Today so far": "今天到目前为止",
  "A draft: it changes until the day ends (UTC), then goes out once.": "这是草稿：当天（UTC）结束前都会变动，之后发送一次。",
  "Send feedback": "发送意见回馈",
  // 文件面板
  "Cannot list this folder": "无法列出这个文件夹",
  "This file is no longer available": "这个文件已经不存在",
  "Binary file · no text preview": "二进位文件 · 没有文本预览",
  "Cannot preview this file (binary, too large, or unreadable)": "无法预览这个文件（二进位、太大或读不到）",
  "Loading files…": "加载文件中…",
  "No files": "没有文件",
  "No folder": "没有文件夹",
  "File list limited to 500 entries per folder and 5,000 total": "文件清单最多显示每个文件夹 500 个、总共 5,000 个",
  "Loading file…": "加载文件中…",
  // 变更面板
  "Commit message": "提交消息",
  "Not a git repository": "不是 git 保存库",
  "Cannot preview this diff (too large or unreadable)": "无法预览这个差异（太大或读不到）",
  "Binary file · no text diff": "二进位文件 · 没有文本差异",
  "Binary file changed": "二进位文件有变更",
  "No text diff available": "没有文本差异",
  "Loading changes…": "加载变更中…",
  "No uncommitted changes": "没有未提交的变更",
  "Showing the first 1,000 changed files": "只显示前 1,000 个变更的文件",
  "Select a file to view its changes": "选一个文件来看它的变更",
  "Committing…": "提交中…",
  Commit: "提交",
  // 右键和添加分页的菜单
  "Split right": "向右分割",
  "Split down": "向下分割",
  "Use Herdr right-click menu": "使用 Herdr 的右键菜单",
  "Send right-clicks to pane": "把右键交给窗格里的程序",
  "Close pane": "关闭窗格",
  "New tab": "新分页",
  Close: "关闭",
  "New worktree": "添加 worktree",
  "Open worktree": "打开 worktree",
  "Remove worktree": "移除 worktree",
  "New space": "添加工作区",
  Keybinds: "快捷键",
  Terminal: "终端机",
  "Start an agent": "开一个 agent",
  "not installed": "未安装",
  "Could not load agents": "加载不了 agent",
  "Checking installed agents…": "检查已安装的 agent…",
  "Could not check installed agents": "检查不了已安装的 agent",
  "New worktree…": "添加 worktree…",
  "Open worktree…": "打开 worktree…",
  // 拷贝版的侧栏
  Spaces: "工作区",
  "This computer": "这台电脑",
  "New space there": "在这里添加工作区",
  "New space on this computer": "在这台电脑添加工作区",
  // 机器需要登录时，侧栏、通知和添加机器的对话框会附上指令和拷贝按钮。
  "needs a login: run": "需要登录，请运行",
  Copy: "拷贝",
  Copied: "已拷贝",
  "Loading…": "加载中…",
  Connect: "连接",
  "Connecting…": "连接中…",
  "rebuilt ·": "已重建 ·",
  "This machine was rebuilt or replaced. Click to connect to the new one.": "这台机器重建或换过了。点这里连到新的机器。",
  Agents: "Agent",
  "Sort agents": "排序方式",
  "Sort agents: {0}": "排序方式：{0}",
  Priority: "依状态",
  "Grouped by space": "依工作区分组",
  Pinned: "已钉选",
  "Needs you": "需要你",
  Done: "已完成",
  Working: "运行中",
  Idle: "闲置",
  Unpin: "取消钉选",
  "Pin to the top": "钉到最上面",
  "No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.":
    "还没有 agent 回报状态。agent 回报后会显示在这里。旧版或在 tmux 里的 agent 可能不会回报。",
  Settings: "设置",
  "Add machine": "添加机器",
};

export const TO_EN = {
  我的技能: "My skills",
  给: "To",
  主文件夹: "Main folder",
  两站都跑: "Both stations",
  "只 review": "Review only",
  "只 verify": "Verify only",
  只封存: "Archive only",
  封存后提交: "Archive, then commit",
  开发: "Development",
  设计: "Design",
  提交与发版: "Commit and release",
  视频: "Video",
  动画: "Animation",
  内容: "Content",
  工具: "Tools",
  其他: "Other",
  个人: "Personal",
  插件: "Plugin",
  "插件 {0}": "Plugin {0}",
  "{0} 个": "{0}",
  "找技能：名称或说明": "Find a skill by name or description",
  找不到符合的技能: "No matching skill",
  "{0} 目前没有 Specseal 以外的技能": "{0} has no skills other than Specseal",
  选一个技能: "Select a skill",
  "目前分页是 {0}，要放到输入框请选它": "The current tab runs {0}. Select it to put the command in the input box",
  "这个项目没有 {0} 的 Specseal 技能。先运行 specseal init --tools {1}": "This project has no Specseal skills for {0}. Run specseal init --tools {1} first",
  目前分页: "Current tab",
  "perl 结束码 {0}": "perl exit code {0}",
  "↑↓ 移动　→ 补充说明　Tab 换页": "↑↓ Move　→ Note　Tab Page",
  "↑↓ 技能": "↑↓ Skill",
  "←→ 搭配": "←→ Pair",
  "Space 勾选": "Space Check",
  "⇧←→ 做法": "⇧←→ Method",
  "Tab 换页": "Tab Page",
  "、": ", ",
  "{0}：{1}": "{0}: {1}",
  // 阶段与状态
  提案中: "Proposed",
  进行中: "In progress",
  已就绪: "Ready",
  运行中: "Working",
  在等你回答: "Waiting for you",
  已完成: "Done",
  闲置: "Idle",
  正在做事: "Working",
  出错了: "Error",
  正在收指令: "Taking a command",
  // 面板
  技能没有送出: "The skill was not sent",
  "开不了 Specseal": "Could not open Specseal",
  "等 {0} 先完成": "Waiting for {0} to finish",
  没有放进输入框: "Not put in the input box",
  附加到目前分页的输入框: "Attach to the input box of the current tab",
  其他技能: "Other skills",
  "切到这个 agent（{0}）": "Go to this agent ({0})",
  "在 Specseal 开路线图": "Open the roadmap in Specseal",
  "等 {0}": "Waiting for {0}",
  拷贝名称: "Copy name",
  "拷贝 slug": "Copy slug",
  "还有 {0} 刀没转出": "{0} cuts not promoted yet",
  收合: "Show less",
  "还有 {0} 个…": "{0} more…",
  "第 {0} 波可以一起开工：{1}": "Wave {0} can start together: {1}",
  "开 {0} 个新分页，各跑一个 agent": "Open {0} new tabs, one agent each",
  开工失败: "Could not start",
  "用 worktree": "Use a worktree",
  "直接 apply": "Apply directly",
  取消: "Cancel",
  "选择用 worktree 或直接 apply": "Choose a worktree or a direct apply",
  整波开工: "Start the wave",
  "这个项目还没有 Specseal": "This project has no Specseal yet",
  "在新分页运行 specseal init": "Run specseal init in a new tab",
  初始化: "Initialize",
  讨论: "Discussions",
  已转出: "Promoted",
  "这些变更读不到 metadata：{0}": "Could not read metadata for these changes: {0}",
  "打开 Specseal app": "Open the Specseal app",
  "在 Specseal app 打开这个项目": "Open this project in the Specseal app",
  目前的工作区: "Current space",
  路线图: "Roadmap",
  技能: "Skills",
  "加载中…": "Loading…",
  // 技能跳窗
  "输入框一次只能放一个。勾两个以上请开新分页": "The input box takes one at a time. With two or more checks, open new tabs",
  主题: "Topic",
  "补充说明（可留空）": "Notes (optional)",
  "这个技能用在整个项目，不用搭配": "This skill works on the whole project. It needs no pairing",
  目前没有可以搭配的讨论: "No discussion to pair with",
  目前没有可以搭配的变更: "No change to pair with",
  搭配的讨论: "Pair with a discussion",
  搭配的变更: "Pair with a change",
  "全选 ⌘A": "All ⌘A",
  不指定: "None",
  "处理中…": "Working on it…",
  "开 {0} 个分页并开工 ⌘⏎": "Start {0} tabs ⌘⏎",
  "开新分页并开工 ⌘⏎": "Start new tab ⌘⏎",
  "在目前的工作区开新分页并运行：{0}": "Open a new tab in the current space and run: {0}",
  "放到输入框 ⏎": "Put in input ⏎",
  "这个项目还没有 Specseal。到面板按「初始化」后再用。": "This project has no Specseal yet. Press Initialize in the panel first.",
  // 共用
  "specseal {0} 结束码 {1}": "specseal {0} exit code {1}",
  "贴不进 {0}（结束码 {1}）": "Could not paste into {0} (exit code {1})",
  "hc 结束码 {0}": "hc exit code {0}",
  // 技能表
  规划: "Plan",
  实作: "Build",
  品质: "Quality",
  收尾: "Finish",
  项目: "Project",
  变更: "Change",
  把模糊的需求谈清楚: "Talk through a fuzzy requirement",
  创建变更与文档: "Create a change and its documents",
  把新需求并进变更: "Add new requirements to a change",
  照任务清单实作: "Implement from the task list",
  "在独立的 worktree 里实作": "Implement in a separate worktree",
  实作前交叉检查文档: "Cross-check the documents before you implement",
  查代码离变更的假设多远: "Check how far the code moved from the change",
  "跑 review 和 verify 两站": "Run the review and verify stations",
  检查实作的品质: "Check the quality of the implementation",
  对照文档检查实作: "Check the implementation against the documents",
  把变更并进规格并封存: "Merge the change into the specs and archive it",
  封存后接着提交这个变更: "Archive the change, then commit it",
  "一次只能跑一个 archive+commit，同时提交会互相影响": "Run one archive+commit at a time. Commits at the same time affect each other",
  审查中: "In review",
  已审查: "Reviewed",
  "已审查·其后有变动": "Reviewed · changed since",
  验证中: "In verification",
  已验证: "Verified",
  "已验证·其后有变动": "Verified · changed since",
  "把 worktree 合回主分支": "Merge the worktree back into the main branch",
  只提交这个变更的文件: "Commit only the files of this change",
  扫描代码找改善点: "Scan the code for improvements",
  找出代码的安全问题: "Find security problems in the code",
  查一项能力的来龙去脉: "Trace how a capability came to be",
  从规格产生操作手册: "Generate a manual from the specs",
  从现有代码产生初始规格: "Generate initial specs from the code",
  整理项目说明与产出规则: "Organize project context and artifact rules",
  // 送达与开新分页的原因
  "还在确认可用的 agent": "Checking which agents are available",
  "找不到有 specseal 技能的 agent": "No agent has the specseal skills",
  开工: "Start",
  这个变更: "this change",
  这场讨论: "this discussion",
  "送给这场讨论的 agent": "Send to the agent on this discussion",
  "目前分页的 agent {0}": "Agent on the current tab: {0}",
  "讨论中，还没记录": "Discussing, not recorded yet",
  "{0}的 agent {1}": "Agent on {0}: {1}",
  开新分页: "Open a new tab",
  "送给这个变更的 agent": "Send to the agent on this change",
  "送给目前分页的 agent": "Send to the agent in the current tab",
  "目前分页的 agent 在等你回答": "The agent in the current tab waits for your answer",
  "目前分页没有 agent。可以改开新分页": "The current tab has no agent. You can open a new tab",
  "目前分页没有 agent": "The current tab has no agent",
  "{0} 只有 Claude Code 能用": "{0} works only in Claude Code",
  "已经有 agent 在做": "An agent already works on it",
  "要等 {0} 落地": "Waiting for {0} to land",
  "还有 {0} 个程序任务没做完": "{0} code tasks are not done",
  "这个项目没开 worktree 流程": "This project has no worktree flow",
  "{0} 的 apply 还没做完": "The apply of {0} is not finished",
  勾选要开工的变更: "Check the changes to start",
  "主文件夹一次只能跑一个 apply。可以改选 apply-with-worktree": "The main folder runs one apply at a time. You can use apply-with-worktree",
};

// Herdr 内置画面里带变量的句子。要整句符合，名称是用户取的。{n} 是第 n 个括号。
const ZH_PATTERNS = [
  [/^(\d+) agents$/, "{0} 个 agent"],
  [/^· (\d+) needs you$/, "· {0} 个需要你"],
  [/^(.+) {2}commands$/, "{0}  指令"],
  [/^([\d,]+) files$/, "{0} 个文件"],
  [/^Theme: (.+)$/, "主题：{0}"],
  [/^Send back to (.+)$/, "送回 {0}"],
  [/^Default \((.+)\)$/, "缺省（{0}）"],
  [/^Updated (.+) to hc (.+); its terminals kept running\.$/, "已更新 {0} 到 hc {1}，它的终端机继续运行。"],
  [/^Updated (.+); its terminals kept running\.$/, "已更新 {0}，它的终端机继续运行。"],
  [/^Renamed (.+) to (.+)\.$/, "已把 {0} 改名为 {1}。"],
  [/^Removed (.+); its terminals keep running there\.$/, "已移除 {0}，它的终端机会在那台机器上继续运行。"],
  [/^Remove (.+)\? Its terminals keep running there\.$/, "要移除 {0} 吗？它的终端机会在那台机器上继续运行。"],
  [/^Connected · (.+)$/, "已连接 · {0}"],
  [/^Up to date\. Checked at (.+)\.$/, "已是最新版本。检查时间 {0}。"],
  // 侧栏收起时，机器那一格的提示。
  [/^New space on (.+)$/, "在 {0} 添加工作区"],
  // 侧栏收起时那一格的提示：按下去会开设置的机器页，那里有拷贝按钮。
  [/^(.+) needs a login: run (.+)\. Click for Copy\.$/, "{0} 需要登录，请运行 {1}。按一下到设置拷贝指令。"],
  [/^(.+) needs a login: run$/, "{0} 需要登录，请运行"],
  [/^(.+) is ready\. Restart to switch now; it also switches when you quit\.$/, "{0} 已经准备好。重新启动就会切换，结束 Herdr 时也会切换。"],
  [/^(.+) is ready\. Your terminals keep running through it\.$/, "{0} 已经准备好。更新时你的终端机会继续运行。"],
  [/^Managed by (.+): update it there\.$/, "由 {0} 管理，请在那里更新。"],
  [/^The update failed: (.+)$/, "更新失败：{0}"],
  [/^Off for now: (.+) is set where Herdr started\.$/, "目前关闭：启动 Herdr 的环境设置了 {0}。"],
  [/^Waiting to send: (.+)$/, "等待发送：{0}"],
  [/^Last sent: (.+)$/, "上次发送：{0}"],
  [/^Sent (.+)\.$/, "发送于 {0}。"],
  [/^Cannot preview this diff \(too large or unreadable\): (.+)$/, "无法预览这个差异（太大或读不到）：{0}"],
  [/^Commit failed: (.+)$/, "提交失败：{0}"],
];

// 只查对照表和上面的句子，查不到就是原文。英文系统不用翻，内置画面本来就是英文。
export function autoTr(text) {
  if (lang !== "zh") return text;
  if (Object.hasOwn(TO_ZH, text)) return TO_ZH[text];
  for (const [pattern, zh] of ZH_PATTERNS) {
    const found = text.match(pattern);
    if (found) return zh.replace(/\{(\d)\}/g, (_match, i) => found[Number(i) + 1]);
  }
  return text;
}

const TRANSLATE = Symbol.for("specseal.translate");

// Herdr 所有 mod 共用同一份 JS 环境，所以改一次组件的原型，内置画面（设置页、菜单、分页列、状态栏）的文本也会查对照表，
// 不用拷贝那些 mod，从哪个入口开都一样。文档没有保证这件事：Herdr 改掉后这段不会生效，画面回到英文，不会坏。
// 用户的内容不能经过这里：文件树和差异由 dock-panel.mjs 的拷贝版排除。ui 由调用的人传进来，这支才不用碰 Herdr API。
export function translateHerdr({ div, InputState }) {
  const proto = Object.getPrototypeOf(div());
  const installed = TRANSLATE in proto;
  // mod 重新加载后要用新的这份 lang，但不能包两层。
  proto[TRANSLATE] = autoTr;
  if (installed) return;
  const text = (value) => (typeof value === "string" ? proto[TRANSLATE](value) : value);
  const { child, children, tooltip } = proto;
  proto.child = function (value) {
    return child.call(this, text(value));
  };
  proto.children = function (values) {
    return children.call(this, Array.from(values, text));
  };
  proto.tooltip = function (value) {
    return tooltip.call(this, text(value));
  };
  // 输入框的提示文本不是 child。
  const make = InputState?.new;
  if (!make) return;
  InputState.new = function (options) {
    return make.call(this, options?.placeholder ? { ...options, placeholder: text(options.placeholder) } : options);
  };
}

export function tr(text, ...args) {
  const table = lang === "zh" ? TO_ZH : TO_EN;
  return (table[text] ?? text).replace(/\{(\d)\}/g, (_match, i) => args[i]);
}
