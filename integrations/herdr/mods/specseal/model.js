// 面板的纯逻辑：CLI 输出怎么变成面板的列、每一列有哪些技能钮、技能要送给谁。
// 不碰 Herdr API，scripts/herdr/panel-model.test.mjs 直接测。
//
// 阶段、波次、依赖、尚未转出的刀都取自 CLI 的 --json，这里不重算。

import { tr } from "./i18n.js";

// 有 specseal 技能的 agent（program.key）与叫用技能的前缀。Pi 有自己的 .pi/skills，Cursor 有自己的 .cursor/skills。
const SKILL_PREFIX = { claude: "/", copilot: "/", codex: "$", pi: "/skill:", cursor: "/" };
const PREFIX = Object.fromEntries(Object.entries(SKILL_PREFIX).map(([key, prefix]) => [key, `${prefix}specseal-`]));
// specseal init --tools 的名称。
const SPECSEAL_TOOL = { claude: "claude", copilot: "copilot", codex: "codex", pi: "pi", cursor: "cursor" };
// sending：hc send 要等 agent 开工才回来（约两秒），这段时间再按一次会重复送出。
const BUSY = { working: "正在做事", blocked: "在等你回答", error: "出错了", sending: "正在收指令" };

// 这些技能要在主文件夹跑；其余技能跟着变更走，有 worktree 就在 worktree 里跑。
const MAIN_FOLDER = new Set(["archive", "archive+commit", "worktree-merge", "apply-with-worktree"]);
const CLAUDE_ONLY = new Set(["analyze"]);

// 第一个是建议的下一步。这里只放合理的选项，技能本身没有阶段限制的（ingest、drift、commit）每个阶段都有。
const STAGE_SKILLS = {
  proposed: ["apply", "analyze", "ingest", "drift", "commit"],
  "in-progress": ["apply", "ingest", "drift", "verify", "quality", "review", "analyze", "commit"],
  ready: ["quality", "review", "verify", "archive", "archive+commit", "ingest", "drift", "commit"],
};
// 这些技能要等程序任务都做完才能跑，手动任务（[M]）不算。没做完时技能也会自己停下来。
const NEEDS_CODE_DONE = new Set(["quality", "review"]);
// 技能跳窗的技能。前四组依工作流程，pair 是可以搭配的东西；「项目」用在整个项目，不搭配。
export const PICKER_SKILLS = [
  { skill: "discuss", group: "规划", pair: "讨论", about: "把模糊的需求谈清楚" },
  { skill: "propose", group: "规划", pair: "讨论", about: "创建变更与文档" },
  { skill: "ingest", group: "规划", pair: "变更", about: "把新需求并进变更" },
  { skill: "apply", group: "实作", pair: "变更", about: "照任务清单实作" },
  { skill: "apply-with-worktree", group: "实作", pair: "变更", about: "在独立的 worktree 里实作" },
  { skill: "analyze", group: "实作", pair: "变更", about: "实作前交叉检查文档" },
  { skill: "drift", group: "实作", pair: "变更", about: "查代码离变更的假设多远" },
  { skill: "quality", group: "品质", pair: "变更", about: "跑 review 和 verify 两站" },
  { skill: "review", group: "品质", pair: "变更", about: "检查实作的品质" },
  { skill: "verify", group: "品质", pair: "变更", about: "对照文档检查实作" },
  { skill: "archive", group: "收尾", pair: "变更", about: "把变更并进规格并封存" },
  { skill: "archive+commit", group: "收尾", pair: "变更", about: "封存后接着提交这个变更" },
  { skill: "worktree-merge", group: "收尾", pair: "变更", about: "把 worktree 合回主分支" },
  { skill: "commit", group: "收尾", pair: "变更", about: "只提交这个变更的文件" },
  { skill: "improve", group: "项目", pair: null, about: "扫描代码找改善点" },
  { skill: "bugfix", group: "项目", pair: null, about: "复现并修复一个缺陷" },
  { skill: "audit", group: "项目", pair: null, about: "找出代码的安全问题" },
  { skill: "trace", group: "项目", pair: null, about: "查一项能力的来龙去脉" },
  { skill: "manual", group: "项目", pair: null, about: "从规格产生操作手册" },
  { skill: "baseline", group: "项目", pair: null, about: "从现有代码产生初始规格" },
  { skill: "config", group: "项目", pair: null, about: "整理项目说明与产出规则" },
];

// 真正存在的技能。叠加的 archive+commit 是两个技能。
export const ALL_SKILLS = new Set(PICKER_SKILLS.map((w) => w.skill).filter((skill) => !skill.includes("+")));

// 跳窗清单里合成一列的技能：同一件事的不同做法，选中后在右边挑。第一个是缺省，也是那一列的名字。
export const PICKER_VARIANTS = {
  apply: [
    { label: "主文件夹", skill: "apply" },
    { label: "worktree", skill: "apply-with-worktree" },
  ],
  quality: [
    { label: "两站都跑", skill: "quality" },
    { label: "只 review", skill: "review" },
    { label: "只 verify", skill: "verify" },
  ],
  archive: [
    { label: "只封存", skill: "archive" },
    { label: "封存后提交", skill: "archive+commit" },
  ],
};
const MERGED = new Set(Object.values(PICKER_VARIANTS).flatMap((list) => list.slice(1).map((v) => v.skill)));
export const PICKER_ROWS = PICKER_SKILLS.filter((w) => !MERGED.has(w.skill));
const PICKER_GROUPS = [...new Set(PICKER_ROWS.map((w) => w.group))];

// 左边清单每一组怎么显示：closed 收合，open 只列现在能做的，all 全列。choices 是用户点过的。
// 没有变更可以搭配的技能现在做不了，所以藏起来；discuss、propose 没有讨论也能打字开工；「项目」不常用，缺省收合。
export function pickerGroups(countOf, choices = {}) {
  const canDo = (w) => w.pair === "讨论" || (w.pair === "变更" && countOf(w.skill) > 0);
  return PICKER_GROUPS.map((group) => {
    const items = PICKER_ROWS.filter((w) => w.group === group);
    const state = choices[group] ?? (items.some(canDo) ? "open" : "closed");
    return { group, items, state, rows: state === "closed" ? [] : state === "all" ? items : items.filter(canDo) };
  });
}

// ↑↓ 的下一列。收合的组也走得到，走进去就展开（open 是要展开的组），这样用键盘也摸得到每个技能。
export function pickerStep(groups, skill, step) {
  const path = groups.flatMap((g) => {
    if (g.state !== "closed") return g.rows.map((w) => ({ skill: w.skill, open: null }));
    return [{ skill: g.items[step > 0 ? 0 : g.items.length - 1].skill, open: g.group }];
  });
  const at = path.findIndex((x) => x.skill === skill);
  const from = at === -1 && step < 0 ? 0 : at;
  return path[(from + step + path.length) % path.length];
}

// 品质关卡的两站，值是 .meta.yaml 里字段的开头。
const STATIONS = { review: "reviewed", verify: "verified" };

function readStamp(meta, prefix) {
  const field = (name) => meta.match(new RegExp(`^${prefix}_${name}:[ \\t]*(\\S.*)$`, "m"))?.[1];
  const block = meta.match(new RegExp(`^${prefix}_scope:\\n((?:[ \\t-].*\\n?)*)`, "m"))?.[1] ?? "";
  const scope = [...block.matchAll(/path:[ \t]*(.+)\n\s*hash:[ \t]*(\S+)/g)].map(([, path, hash]) => ({
    path: path.replace(/^["']|["']$/g, ""),
    hash,
  }));
  const total = Number(field("tasks_total"));
  // 字段不全不算章，和引擎的 is_stamped 相同。
  return field("at") && Number.isInteger(total) && scope.length > 0 ? { total, scope } : null;
}

// 读 shared.js 的 stationFacts 拿到的文本：.meta.yaml 加上 open_ticket: 列。CLI 的 list --json 刻意不带章，所以要自己读。
export function parseStations(text) {
  return Object.fromEntries(
    Object.entries(STATIONS).map(([station, prefix]) => [
      station,
      { ticket: new RegExp(`^open_ticket: ${station}$`, "m").test(text), stamp: readStamp(text, prefix) },
    ]),
  );
}

export const stampedPaths = (stations) => [
  ...new Set(Object.keys(STATIONS).flatMap((station) => stations[station].stamp?.scope.map((f) => f.path) ?? [])),
];

// 每一站的状态：none、open（工单开着）、stamped（章有效）或 stale（章过期）。判断和引擎的封存守门相同：
// 工单开着的站不看章；章要任务数没变、程序任务都做完、范围内的文件内容没变。hashes 查不到时只看任务。
export function stationStates(facts, row) {
  const state = (station) => {
    const { ticket, stamp } = facts?.[station] ?? {};
    if (ticket) return "open";
    if (!stamp) return "none";
    if (stamp.total !== row.total || row.codeRemaining > 0) return "stale";
    return facts.hashes && stamp.scope.some((f) => facts.hashes[f.path] !== f.hash) ? "stale" : "stamped";
  };
  return Object.fromEntries(Object.keys(STATIONS).map((station) => [station, state(station)]));
}

// remaining 是每个变更还剩几个程序任务（见 shared.js 的 codeRemaining），facts 是章和工单（见 stationFacts），
// 查不到的不放。
export function buildBoard(list, plan, discussions, remaining = {}, facts = {}) {
  const listed = new Map(list.changes.map((c) => [c.name, c]));
  const stages = { proposed: [], "in-progress": [], ready: [] };
  for (const c of plan.changes) {
    const l = listed.get(c.name);
    const row = {
      name: c.name,
      stage: c.stage,
      wave: c.wave,
      blockedBy: c.blockedBy,
      completed: l?.completedTasks ?? 0,
      total: l?.totalTasks ?? 0,
      codeRemaining: c.stage === "ready" ? 0 : remaining[c.name] ?? null,
      worktree: l?.worktree ?? null,
      restale: (l?.restaleFrom ?? []).length > 0,
    };
    stages[c.stage].push({ ...row, stations: stationStates(facts[c.name], row) });
  }
  const cuts = new Map();
  for (const cut of plan.unpromotedCuts ?? []) {
    cuts.set(cut.discussion, [...(cuts.get(cut.discussion) ?? []), ...cut.unpromoted]);
  }
  const rows = discussions.discussions.map((d) => ({
    slug: d.slug,
    topic: d.topic,
    status: d.status,
    cuts: cuts.get(d.slug) ?? [],
  }));
  // 已转出但还有刀没转出的讨论留在讨论卡，下一步的 propose 才不会收在缺省收合的卡里。
  const finished = (d) => d.status === "promoted" && d.cuts.length === 0;
  return {
    stages,
    discussions: rows.filter((d) => !finished(d)),
    promoted: rows.filter(finished),
    skipped: plan.skipped ?? [],
  };
}

// 文件夹没有 Specseal 项目时，CLI 所有动词都回这句，而且不是 JSON。设置档坏掉是另一句，要照常当错误。
export const isUninitialized = (message) => message.includes("Not initialized");

// specseal 网址（正式规格 desktop-app「以 specseal 网址打开详情页」）。kind 是 change、
// discussion、roadmap 或 project；roadmap 与 project 不带名称。
export function specsealUrl(kind, project, name) {
  const path = name ? `/${encodeURIComponent(name)}` : "";
  return `specseal://${kind}${path}?project=${encodeURIComponent(project)}`;
}

// 桌面 app 的 bundle id。
export const APP_ID = "app.specseal.desktop";

// 这个 space 的项目能不能用网址在桌面 app 开：读得到项目，而且项目在这台机器上。
// Logo 和「路线图」钮用同一个门槛。
export const canOpenProject = ({ hasBoard, on }) => hasBoard && !on;

// Logo 依序尝试的 open 参数。能用网址开时先送网址切过去；没有注册 specseal 网址的旧版 app 会让
// 网址送不出去，这时退回只叫出 app。
export function logoOpenAttempts({ root, hasBoard, on }) {
  const bringUp = ["-b", APP_ID];
  return canOpenProject({ hasBoard, on }) ? [[specsealUrl("project", root)], bringUp] : [bringUp];
}

// 依序跑 open，成功就停并回传 null；全部失败回传最后一次有内容的错误。exec 由调用端传入。
export async function lastOpenError(attempts, exec) {
  let error = "";
  for (const args of attempts) {
    const r = await exec("open", args).catch((e) => ({ code: 1, stderr: String(e.message ?? e) }));
    if (r.code === 0) return null;
    error = r.stderr || error;
  }
  return error;
}

// 叠加的技能（archive+commit）依序跑，标签和 hook 一样算第一个。
const skillLabel = (skill) => `specseal.skill=specseal-${skill.split("+")[0]}`;

// 这个 agent 接下来在做什么。name 是技能搭配的变更或讨论。变更的技能没指定时不动 specseal.change，
// 那通常是同一个变更的下一步；其他情况清掉用不到的标签（hc label k= 是移除）。
export function skillLabels(skill, name) {
  const pair = PICKER_SKILLS.find((w) => w.skill === skill)?.pair;
  const labels = [skillLabel(skill)];
  if (pair === "变更") return [...labels, ...(name ? [`specseal.change=${name}`] : []), "specseal.discussion="];
  return [...labels, "specseal.change=", `specseal.discussion=${pair === "讨论" && name ? name : ""}`];
}

// hook 用：送出的消息是 specseal 技能指令时，回传要贴的标签，其他消息回传 null。名称只认第一个参数。
// 变更名称只有英数，所以中文不算；讨论的 slug 可能有中文。叠加的指令（/specseal-archive + /specseal-commit x）算第一个技能。
export function promptLabels(prompt) {
  const match = prompt.trimStart().match(/^(?:\/skill:|\/|\$)specseal-([a-z-]+)(?:\s+\+\s+(?:\/skill:|\/|\$)specseal-[a-z-]+)?(?:\s+(?:--from-discussion\s+)?(\S+))?/);
  if (!match || !ALL_SKILLS.has(match[1])) return null;
  const [, skill, name] = match;
  const isChange = PICKER_SKILLS.find((w) => w.skill === skill).pair === "变更";
  return skillLabels(skill, isChange && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name ?? "") ? undefined : name);
}

// 从 specseal 指令看出 agent 在做哪个变更或讨论。只认会动到它的指令，show、status 这类可能只是查一下。
// 指令要在开头，或接在 ; & | ( 后面，所以 commit 消息里提到的不算；heredoc 的内文也不看。
const NAME = String.raw`"?([A-Za-z0-9][^\s"';&|]*)"?`;
// specseal 可能带路径（~/.local/bin/specseal）。
const BIN = String.raw`["']?(?:[^\s;&|()"']*/)?specseal["']?`;
const specsealAt = (verb) => new RegExp(String.raw`(?:^|[;&|(]\s*)(?:\w+=\S*\s+)*${BIN}\s+${verb}\s+${NAME}`, "m");
const CHANGE_COMMANDS = [
  "new\\s+change",
  "instructions\\s+apply\\s+--change",
  "task\\s+done\\s+--change",
  "in-progress\\s+add",
  "(?:review|verify)\\s+prepare",
  "archive",
].map(specsealAt);
const DISCUSSION_COMMANDS = ["discuss\\s+new\\s+.*--slug", "discuss\\s+(?:context|add-round|conclude)"].map(specsealAt);

// 也可能先存进变量：S=~/.local/bin/specseal; $S discuss …
function expandAlias(text) {
  const alias = text.match(new RegExp(String.raw`(?:^|[;&|(\s])(\w+)=${BIN}(?=[\s;&|)]|$)`, "m"))?.[1];
  return alias ? text.replace(new RegExp(String.raw`["']?\$\{?${alias}\}?["']?(?=\s)`, "g"), "specseal") : text;
}

// 从讨论创建变更：写提案的 agent 还属于那场讨论，讨论标签要留着。同一段指令（到 ; & | 为止）里的才算。
const FROM_DISCUSSION = new RegExp(String.raw`${BIN}\s+new\s+change\s+[^;&|\n]*--from-discussion[\s=]+${NAME}`);

export function commandLabels(command) {
  const text = expandAlias(command.split("<<")[0]);
  const change = CHANGE_COMMANDS.map((pattern) => text.match(pattern)?.[1]).find(Boolean);
  if (change) return [`specseal.change=${change}`, `specseal.discussion=${text.match(FROM_DISCUSSION)?.[1] ?? ""}`];
  const discussion = DISCUSSION_COMMANDS.map((pattern) => text.match(pattern)?.[1]).find(Boolean);
  return discussion ? ["specseal.change=", `specseal.discussion=${discussion}`] : null;
}

// Claude Code hook 收到的事件要贴哪些标签，不用贴时是 null。
// /clear 和 /resume 换了对话，旧的标签不算数。模型自己叫用技能时，Skill 工具带着技能和参数。
export function hookLabels({ hook_event_name: event, source, prompt, tool_name: tool, tool_input: input }) {
  if (event === "UserPromptSubmit") return promptLabels(prompt ?? "");
  if (event === "SessionStart") {
    return source === "clear" || source === "resume" ? ["specseal.change=", "specseal.discussion=", "specseal.skill="] : null;
  }
  if (tool === "Skill") return promptLabels(`/${input?.skill} ${input?.args ?? ""}`);
  if (tool === "Bash") return commandLabels(input?.command ?? "");
  return null;
}

// 建议的下一步。有 worktree 时，程序任务做完就先合并，回主文件夹再跑品质关卡。
// 没有 worktree 时，两站都盖章就是收尾；手动任务还没做完时还不能封存，交给 apply 处理。
// 没盖章时，只剩手动任务的下一步是品质关卡，不是 apply。
function suggestedSkill(row, skills) {
  if (row.restale) return "ingest";
  if (row.worktree && (row.stage === "ready" || row.codeRemaining === 0)) return "worktree-merge";
  const stamped = row.stations?.review === "stamped" && row.stations?.verify === "stamped";
  if (stamped && row.stage === "ready") return "archive+commit";
  if (!stamped && row.stage === "in-progress" && row.codeRemaining === 0) return "quality";
  return skills[0];
}

// 没被挡、还有程序任务、讨论也没有重新定案，才能开始做。
const canStart = (row) => row.stage !== "ready" && row.codeRemaining !== 0 && row.blockedBy.length === 0 && !row.restale;

// 还没开始做的变更，可以选在主文件夹或 worktree 做。已有 worktree 时，apply 钮会接续它。
const choosesWorktree = (row, worktreePolicy) => worktreePolicy && row.stage === "proposed" && !row.worktree && canStart(row);

export function changeSkills(row, worktreePolicy = false) {
  // 有 worktree 就要先合并才能封存。合并不看任务做到哪里，所以每个阶段都能选。
  const stageSkills = row.worktree
    ? [...STAGE_SKILLS[row.stage].filter((skill) => !skill.startsWith("archive")), "worktree-merge"]
    : STAGE_SKILLS[row.stage];
  const skills = choosesWorktree(row, worktreePolicy) ? [stageSkills[0], "apply-with-worktree", ...stageSkills.slice(1)] : stageSkills;
  const suggested = suggestedSkill(row, skills);
  return skills.map((skill) => {
    const waiting = skill === "apply" && row.blockedBy.length > 0;
    return {
      skill,
      args: row.name,
      primary: skill === suggested && !waiting,
      ...(waiting ? { waitingFor: row.blockedBy } : {}),
    };
  });
}

// 列上放建议的那一颗，其他的按 ⋯ 才展开。apply 被挡时没有建议，放第一颗。
// apply-with-worktree 是 apply 的另一种做法，也放列上。有开工钮时不放，因为开工已经能选 worktree。
export function rowChoices(actions, start = null) {
  const next = actions.find((a) => a.primary) ?? actions[0];
  const beside = start ? [] : actions.filter((a) => a.skill === "apply-with-worktree");
  return { next, beside, others: actions.filter((a) => a !== next && !beside.includes(a)) };
}

export function discussionSkills(d) {
  const discuss = (primary) => ({ skill: "discuss", args: d.slug, primary });
  const propose = { skill: "propose", args: `--from-discussion ${d.slug}`, primary: true };
  if (d.status === "open") return [discuss(true)];
  if (d.status === "concluded" || d.cuts.length > 0) return [propose, discuss(false)];
  return [discuss(false)];
}

// 叠加的技能和 Claude Code mod 的写法相同：/specseal-archive + /specseal-commit x。
// agent 只把第一个当指令，后面的是它的参数，模型做完第一个会接着做。
export const commandText = (key, skill, args) => {
  const command = skill.split("+").map((part) => `${PREFIX[key]}${part}`).join(" + ");
  return `${command}${args ? ` ${args}` : ""}`;
};

// `--if idle` 只认 idle：agent 做完一轮后 core 的状态是 done（Herdr 看过后才显示 idle），
// 所以 done 改用不带旗标的 send。不带旗标时 hc 仍会拒绝 blocked，但 working 会照送，所以
// working 在这里就要挡下来。
export function sendArgs(agent, text) {
  if (agent.status === "idle") return ["send", "--if", "idle", agent.address, text];
  if (agent.status === "done") return ["send", agent.address, text];
  return null;
}


export const inside = (path, folder) => Boolean(path) && (path === folder || path.startsWith(`${folder}/`));

// agents() 的 done 看过就变 idle，送达要看 core 的原始状态（terminals()）。
// 这个 agent 在做 board 里的哪个变更，比对规则和面板的 changeAgents 相同。查不到时是 null。
export function agentChange(agent, board) {
  return Object.values(board.stages).flat().find((row) => changeAgents(row, [agent]).length > 0) ?? null;
}

// 内置 agents mod 的 RANK：等你回答的最急。
const NEEDS_YOU = 4;
const STATUS_ORDER = ["blocked", "done", "working", "idle"];

// Agents 清单的顺序：等你回答的不分 space 放最前面，其他照 Spaces 清单的顺序。
// 同一个 space 里，急的在前面，再来是最近变动的。
export function groupedOrder(list, spaces, rankOf, since) {
  const at = new Map(spaces.map((s, i) => [s.id, i]));
  const key = (a) => (rankOf(a) === NEEDS_YOU ? -1 : at.get(a.space) ?? spaces.length);
  return [...list].sort((x, y) => key(x) - key(y) || rankOf(y) - rankOf(x) || since(y) - since(x) || y.seq - x.seq);
}

// 一组 agent 里各状态有几个，最急的在前面，没有的不列。收起的 space 标题用它。
export function statusCounts(members) {
  return STATUS_ORDER.map((status) => [status, members.filter((a) => a.status === status).length]).filter(([, n]) => n > 0);
}

// 把一个 space 的 agent 依状态分段。members 已经排好，状态相同的会相邻。
export function statusSections(members, rankOf) {
  const sections = [];
  for (const a of members) {
    const rank = rankOf(a);
    if (sections.at(-1)?.rank === rank) sections.at(-1).members.push(a);
    else sections.push({ rank, members: [a] });
  }
  return sections;
}

export function joinAgents(agents, terminals, panes) {
  const byAddress = new Map(terminals.map((t) => [t.address, t]));
  const byPane = new Map(panes.map((p) => [p.pane, p]));
  return agents.map((a) => {
    const t = byAddress.get(a.address);
    return {
      ...a,
      status: t?.status ?? a.status,
      view: a.status,
      name: t?.name ?? null,
      key: a.program?.key,
      cwd: byPane.get(a.pane)?.cwd ?? t?.cwd ?? null,
      labels: t?.labels ?? {},
    };
  });
}

// 正在做这个变更的 agent，依标签、worktree 路径、插件回报的焦点的顺序。
// specseal.change 由开工、面板、技能跳窗和 hook 粘贴。贴了标签的 agent 专做那个变更，焦点提到别的变更不算。
// 正在做这场讨论的 agent。讨论没有 worktree，只看标签。
export const discussionAgents = (d, agents) => agents.filter((a) => a.labels["specseal.discussion"] === d.slug);

// 在讨论、但讨论还没记录的 agent：discuss 技能先查数据、问完问题才创建记录，这段期间没有那一列可以放它。
// 标签上的名称对不到任何一场讨论就算，只看这个项目文件夹里的 agent。
export function unrecordedDiscussions(board, agents, root) {
  const slugs = new Set([...board.discussions, ...board.promoted].map((d) => d.slug));
  return agents.filter(
    (a) => a.labels["specseal.skill"] === "specseal-discuss" && inside(a.cwd, root) && !slugs.has(a.labels["specseal.discussion"]),
  );
}

// 写完提案停下来的 agent 不算在做这个变更：它属于提案来源的讨论，实作要另外开工。
// 还在写或在等回答时才算，文档写到一半时才不会出现开工钮。
const doneProposing = (a) => a.labels["specseal.skill"] === "specseal-propose" && sendable(a);

export function changeAgents(row, agents) {
  const byLabel = agents.filter((a) => a.labels["specseal.change"] === row.name && !doneProposing(a));
  const byPath = row.worktree ? agents.filter((a) => inside(a.cwd, row.worktree.path)) : [];
  const byFocus = agents.filter((a) => !a.labels["specseal.change"] && a.labels["specseal.focus"] === row.name);
  return [...new Set([...byLabel, ...byPath, ...byFocus])];
}

const STATION_SKILLS = {
  "specseal-quality": Object.keys(STATIONS),
  "specseal-review": ["review"],
  "specseal-verify": ["verify"],
};

// 列上要画的站。agent 正在跑的站是 running（第一轮做完前还没有工单），盖好章的站不管 agent 还在不在跑都算盖好了。
export function stationViews(row, agents) {
  const running = new Set(
    changeAgents(row, agents)
      .filter((a) => a.status === "working")
      .flatMap((a) => STATION_SKILLS[a.labels["specseal.skill"]] ?? []),
  );
  return Object.keys(STATIONS)
    .map((station) => {
      const state = row.stations?.[station] ?? "none";
      return { station, state: state !== "stamped" && running.has(station) ? "running" : state };
    })
    .filter((view) => view.state !== "none");
}

const sendable = (a) => a.status === "idle" || a.status === "done";

function pickAgent({ change, discussion, folder, root, agents, focus }) {
  const pool = agents.filter((a) => Object.hasOwn(PREFIX, a.key));
  if (discussion) {
    const mine = discussionAgents(discussion, pool);
    if (mine.length > 0) return { agent: mine.find(sendable) ?? mine[0], where: "discussion" };
  }
  if (change) {
    const mine = changeAgents(change, pool);
    const here = mine.filter((a) => inside(a.cwd, folder));
    // agent 用 cd 进 worktree 时，终端机回报的文件夹还是主文件夹；标签已标明它在做这个变更。
    const moved = folder === root ? [] : mine.filter((a) => inside(a.cwd, root));
    const group = here.length > 0 ? here : moved;
    if (group.length > 0) return { agent: group.find(sendable) ?? group[0], where: "change" };
  }
  const tab = pool.filter((a) => a.tab === focus?.tab && inside(a.cwd, folder));
  const current = tab.find((a) => a.address === focus?.terminal) ?? tab[0];
  return current ? { agent: current, where: "tab" } : null;
}

export function planDelivery({ skill, change = null, discussion = null, args, root, agents, focus, known, preferred }) {
  let name = skill;
  let folder = change?.worktree && !MAIN_FOLDER.has(skill) ? change.worktree.path : root;
  let target = pickAgent({ change, discussion, folder, root, agents, focus });
  // 有 worktree 但 agent 不在里面：apply 改走 apply-with-worktree，它会接续原本的 worktree。
  if (skill === "apply" && change?.worktree && !inside(target?.agent.cwd, folder)) {
    name = "apply-with-worktree";
    folder = root;
    target ??= pickAgent({ change, folder, root, agents, focus });
  }
  if (target) {
    const { agent, where } = target;
    // skill 是实际送出的技能，按钮写它：有 worktree 时 apply 可能换成 apply-with-worktree。
    if (!sendable(agent)) return { kind: "busy", where, agent, skill: name, reason: BUSY[agent.status] ?? agent.status };
    const text = commandText(agent.key, name, args);
    return { kind: "send", where, agent, skill: name, text, hc: sendArgs(agent, text), labels: skillLabels(name, change?.name ?? discussion?.slug) };
  }
  return newAgent({ name, args, folder, change, discussion, known, preferred });
}

// 已安装、有 specseal 技能的 agent，Herdr 依最常用排序。
export const usableAgents = (known) => (known ?? []).filter((a) => a.installed && Object.hasOwn(PREFIX, a.key));

// 跳窗一打开要给哪个 agent：目前分页的 agent，再来是上次选的，最后是最常用的。
export function defaultAgent({ known, agents, focus, preferred }) {
  const keys = usableAgents(known).map((a) => a.key);
  return [inputAgent(agents, focus)?.key, preferred].find((key) => keys.includes(key)) ?? keys[0] ?? null;
}

// hc --skill：Codex 要带 --no-daemon，否则它的指令跑在 hc 之外。
const agentArgv = (pick) => (pick.key === "codex" ? [...pick.run, "--no-daemon"] : pick.run);

// 新开一个 agent：选用户选的那一个，没有就选最常用的。
function newAgent({ name, args, folder, change, discussion, known, preferred }) {
  if (!known) return { kind: "none", where: "none", reason: tr("还在确认可用的 agent") };
  const usable = usableAgents(known);
  const pick = usable.find((a) => a.key === preferred) ?? usable[0];
  if (!pick) return { kind: "none", where: "none", reason: tr("找不到有 specseal 技能的 agent") };
  return {
    kind: "new",
    where: "new",
    key: pick.key,
    folder,
    argv: agentArgv(pick),
    text: commandText(pick.key, name, args),
    tabName: change || discussion ? `${name} · ${change?.name ?? discussion.slug}` : name,
    change: change?.name ?? null,
    skill: name,
    labels: skillLabels(name, change?.name ?? discussion?.slug),
  };
}

// 开工：开一个专门做这个变更的新 agent，开在目前的工作区。没被挡、任务还没做完、没有 agent 在做才有这个钮；
// 讨论重新定案的变更要先 ingest，不直接开工。回传可以选的做法，没有钮时是 null。
// 已有 worktree 就接续，没开 worktree 流程就只能直接 apply，这两种不用问；其他情况要问用 worktree 还是直接 apply。
export function startChoices(row, ctx) {
  if (!canStart(row) || ctx.starting?.has(row.name) || changeAgents(row, ctx.agents).length > 0) return null;
  const target = { kind: "change", name: row.name, args: row.name, row };
  const choice = (label, skill) => ({ label, plan: newTabPlan({ ...ctx, skill, target, note: "" }) });
  if (row.worktree) return [choice("开工", "apply-with-worktree")];
  if (!ctx.worktreePolicy) return [choice("开工", "apply")];
  return [choice("用 worktree", "apply-with-worktree"), choice("直接 apply", "apply")];
}

// 整波开工：最前面那一波能开工的变更。一律用 worktree，因为主文件夹一次只能跑一个 apply。
export function waveToStart(stages, ctx) {
  if (!ctx.worktreePolicy) return null;
  const startable = Object.values(stages)
    .flat()
    .map((row) => ({ wave: row.wave, plan: startChoices(row, ctx)?.[0].plan }))
    .filter((s) => s.plan?.kind === "tab");
  const wave = Math.min(...startable.map((s) => s.wave));
  const plans = startable.filter((s) => s.wave === wave).map((s) => s.plan);
  return plans.length >= 2 ? { wave, plans } : null;
}

const deliveryKey = (d) => d?.agent?.key ?? d?.key;

export function changeActions(row, ctx) {
  return changeSkills(row, ctx.worktreePolicy)
    .map((s) => ({
      ...s,
      delivery: s.waitingFor ? null : planDelivery({ ...ctx, skill: s.skill, change: row, args: s.args }),
    }))
    .filter((a) => !CLAUDE_ONLY.has(a.skill) || !deliveryKey(a.delivery) || deliveryKey(a.delivery) === "claude");
}

export function discussionActions(d, ctx) {
  return discussionSkills(d).map((s) => ({ ...s, delivery: planDelivery({ ...ctx, skill: s.skill, discussion: d, args: s.args }) }));
}

const WHERE = { change: "这个变更", discussion: "这场讨论" };
const SEND_TO = { change: "送给这个变更的 agent", discussion: "送给这场讨论的 agent" };

// 技能钮旁边的说明：会送去哪里，或为什么不能送。
export function deliveryHint(delivery) {
  if (delivery.kind === "busy") {
    const where = WHERE[delivery.where];
    return where ? tr("{0}的 agent {1}", tr(where), tr(delivery.reason)) : tr("目前分页的 agent {0}", tr(delivery.reason));
  }
  if (delivery.kind === "none") return delivery.reason;
  if (delivery.kind === "new") return tr("开新分页");
  return tr(SEND_TO[delivery.where] ?? "送给目前分页的 agent");
}

// 技能跳窗可以搭配的变更与讨论。哪个阶段能用哪个技能，规则和面板的技能钮相同。
export function skillTargets(skill, board) {
  const name = skill === "apply-with-worktree" ? "apply" : skill;
  const changes = Object.values(board.stages)
    .flat()
    .filter((row) => changeSkills(row).some((s) => s.skill === name))
    .map((row) => ({ kind: "change", name: row.name, args: row.name, row }));
  const discussions = board.discussions.flatMap((d) =>
    discussionSkills(d)
      .filter((s) => s.skill === skill)
      .map((s) => ({ kind: "discussion", name: d.slug, args: s.args, topic: d.topic })),
  );
  return [...changes, ...discussions];
}

const none = (reason, ...args) => ({ kind: "none", reason: tr(reason, ...args) });
export const onlyClaude = (skill, key) => CLAUDE_ONLY.has(skill) && key !== "claude";
const joinArgs = (target, note) => [target?.args, note].filter(Boolean).join(" ");
// 控制字符会被终端机当成按键（换行就送出了），一律换成空白。
const pasteable = (text) => text.replace(/[\u0000-\u001f\u007f]/g, " ");
const codeLeft = (skill, change) => (NEEDS_CODE_DONE.has(skill) && change?.codeRemaining > 0 ? change.codeRemaining : 0);

// 放进输入框的对象：目前分页的 agent，焦点所在的优先。
function inputAgent(agents, focus) {
  const here = agents.filter((a) => a.tab === focus?.tab && Object.hasOwn(PREFIX, a.key));
  return here.find((a) => a.address === focus?.terminal) ?? here[0] ?? null;
}

// agent 在等回答时不放，粘贴可能答掉对话框。在做事可以放，因为不会送出。
const WAITING = "目前分页的 agent 在等你回答";

// 技能跳窗：把指令放到输入框。
export function placePlan({ skill, target, note, agents, focus, agentKey }) {
  const left = codeLeft(skill, target?.row);
  if (left) return none("还有 {0} 个程序任务没做完", left);
  const agent = placeTarget(agents, focus, agentKey);
  if (agent.kind === "none") return agent;
  if (onlyClaude(skill, agent.key)) return none("{0} 只有 Claude Code 能用", skill);
  return {
    kind: "place",
    agent,
    text: pasteable(`${commandText(agent.key, skill, joinArgs(target, note))} `),
    labels: skillLabels(skill, target?.name),
  };
}

// 能放进输入框的 agent。跳窗选了别的 agent 时不放：指令的写法和技能都对不上。
function placeTarget(agents, focus, agentKey) {
  const agent = inputAgent(agents, focus);
  if (!agent) return none("目前分页没有 agent。可以改开新分页");
  if (agent.status === "blocked") return none(WAITING);
  if (agentKey && agent.key !== agentKey) return none("目前分页是 {0}，要放到输入框请选它", agent.program?.name ?? agent.key);
  return agent;
}

// 面板的附加钮：把变更或讨论的名称接在输入框现有的文本后面。读不到输入框，所以前后都留空白。
export function attachPlan({ name, agents, focus }) {
  const agent = inputAgent(agents, focus);
  if (!agent) return none("目前分页没有 agent");
  if (agent.status === "blocked") return none(WAITING);
  return { kind: "place", agent, text: pasteable(` ${name} `) };
}

// 主文件夹哪个变更的 apply 还没做完。标签在分页关掉前都留着，所以要看变更本身：
// 任务做完或已经封存就不算，不管那个分页还开着。查不到时是 null。
function unfinishedApply(agents, board) {
  const open = Object.values(board?.stages ?? {}).flat().filter((row) => row.stage !== "ready").map((row) => row.name);
  const applying = agents.filter((a) => a.labels["specseal.skill"] === "specseal-apply").map((a) => a.labels["specseal.change"]);
  return applying.find((name) => open.includes(name)) ?? null;
}

// 开新分页：做法和检查都跟 herdr-dispatch 技能相同。分页开在目前的 space，画面留在原地。
export function newTabPlan({ skill, target, note, root, agents, known, preferred, worktreePolicy, space, on, board }) {
  const change = target?.kind === "change" ? target.row : null;
  const applying = skill === "apply" || skill === "apply-with-worktree";
  // 只挡正在忙的 agent。标签在分页关掉前都留着，做完停着的不算，例如 apply 做完后开新分页 merge。
  if (change && changeAgents(change, agents).some((a) => !sendable(a))) return none("已经有 agent 在做");
  if (change && applying && change.blockedBy.length > 0) return none("要等 {0} 落地", change.blockedBy.join(tr("、")));
  const left = codeLeft(skill, change);
  if (left) return none("还有 {0} 个程序任务没做完", left);
  // 有 worktree 的变更，apply 要从主文件夹接续 worktree。
  const name = skill === "apply" && change?.worktree ? "apply-with-worktree" : skill;
  // 政策没开时这个技能会自己停下来。
  if (name === "apply-with-worktree" && !worktreePolicy) return none("这个项目没开 worktree 流程");
  // 主文件夹一次只能跑一个 apply，两个一起跑会互相踩到文件。
  const unfinished = name === "apply" ? unfinishedApply(agents, board) : null;
  if (unfinished) return none("{0} 的 apply 还没做完", unfinished);
  const folder = change?.worktree && !MAIN_FOLDER.has(name) ? change.worktree.path : root;
  const discussion = target?.kind === "discussion" ? { slug: target.name } : null;
  const d = newAgent({ name, args: joinArgs(target, note), folder, change, discussion, known, preferred });
  if (d.kind === "none") return d;
  if (onlyClaude(skill, d.key)) return none("{0} 只有 Claude Code 能用", skill);
  return {
    ...d,
    kind: "tab",
    hc: [
      "run",
      "--bg",
      "--json",
      "--no-parent",
      ...(on ? ["--on", on] : []),
      "--cwd",
      folder,
      "--label",
      `herdr.space=${space}`,
      // 只有变更才取名。hc 的名称不能重复（name_taken），已经被占用时就不取名。
      ...(change
        ? [
            ...(agents.some((a) => a.name === change.name.slice(0, 32)) ? [] : ["--name", change.name.slice(0, 32)]),
            "--label",
            `specseal.change=${change.name}`,
            "--label",
            skillLabel(name),
          ]
        : []),
      ...(discussion ? ["--label", `specseal.discussion=${discussion.slug}`, "--label", `specseal.skill=specseal-${name}`] : []),
      ...d.argv,
      d.text,
    ],
  };
}

// 一次开多个分页，一个变更一个分页。不能开的变更略过，两个都要在主文件夹跑的 apply 整批挡下。
export function batchPlan({ skill, targets, ...context }) {
  const plans = targets.map((target) => newTabPlan({ ...context, skill, target, note: "" })).filter((p) => p.kind === "tab");
  if (plans.length === 0) return none("勾选要开工的变更");
  if (plans.filter((p) => p.skill === "apply").length > 1) {
    return none("主文件夹一次只能跑一个 apply。可以改选 apply-with-worktree");
  }
  if (plans.filter((p) => p.skill === "archive+commit").length > 1) {
    return none("一次只能跑一个 archive+commit，同时提交会互相影响");
  }
  return { kind: "tabs", plans, text: plans.map((p) => p.text).join("　") };
}

// 这个项目没有这个 agent 用的 Specseal 技能时，技能钮送出去也没有用。
export const missingSkillsPlan = (agentName, key) =>
  none("这个项目没有 {0} 的 Specseal 技能。先运行 specseal init --tools {1}", agentName, SPECSEAL_TOOL[key]);

// 我的技能：用户自己装的技能。Specseal 的在另一页；内置的不是文件，也不会扫到。

// 每个 agent 读哪些文件夹，取自各自的文档。插件另外算，见 pluginFolders。
const SKILL_FOLDERS = {
  claude: [
    ["project", ".claude/skills"],
    ["personal", "~/.claude/skills"],
  ],
  copilot: [["project", ".github/skills"]],
  codex: [
    ["project", ".agents/skills"],
    ["personal", "~/.agents/skills"],
    ["personal", "~/.codex/skills"],
  ],
  pi: [
    ["project", ".pi/skills"],
    ["project", ".agents/skills"],
    ["personal", "~/.pi/agent/skills"],
    ["personal", "~/.agents/skills"],
  ],
  cursor: [
    ["project", ".cursor/skills"],
    ["project", ".agents/skills"],
    ["project", ".claude/skills"],
    ["project", ".codex/skills"],
    ["personal", "~/.cursor/skills"],
    ["personal", "~/.agents/skills"],
    ["personal", "~/.claude/skills"],
    ["personal", "~/.codex/skills"],
  ],
};
export const skillFolders = (key) => (SKILL_FOLDERS[key] ?? []).map(([source, dir]) => ({ source, prefix: "", dir }));

// Claude Code 插件的技能文件夹。缓存里有旧版本，所以照安装纪录和激活设置找，不能扫缓存。
// settings 由低到高：用户、项目、本机。项目范围的插件只算这个项目。
export function pluginFolders(installed, settings, root) {
  const enabled = Object.assign({}, ...settings.map((s) => s?.enabledPlugins ?? {}));
  return Object.entries(installed?.plugins ?? {}).flatMap(([key, entries]) => {
    if (!enabled[key]) return [];
    const entry = entries.find((e) => e.scope === "user" || e.projectPath === root);
    return entry ? [{ source: "plugin", prefix: `${key.split("@")[0]}:`, dir: `${entry.installPath}/skills` }] : [];
  });
}

// 依名称猜用途，画面用来分组。比对顺序照这张表（remotion 含 motion，视频要排在动画前面），对不到的是「其他」。
const SKILL_USES = [
  ["3d", /three|webgl/],
  ["video", /remotion|video|film|youtube|shotcraft/],
  ["anim", /gsap|motion|cinematic|cinetic|anim/],
  ["content", /social|publish|writing|article|blog/],
  ["design", /design|\bui\b|\bux\b|theme|style|shadcn|image/],
  ["ship", /commit|release|changelog/],
  ["dev", /tdd|test|debug|refactor|lint/],
  ["tool", /skill-creator|dispatch|mcp|automation/],
];
export const skillUse = (name) => SKILL_USES.find(([, pattern]) => pattern.test(name))?.[0] ?? "other";
export const SKILL_GROUPS = [
  { id: "dev", label: "开发", tone: "ansi4" },
  { id: "design", label: "设计", tone: "ansi5" },
  { id: "ship", label: "提交与发版", tone: "ansi2" },
  { id: "video", label: "视频", tone: "ansi1" },
  { id: "anim", label: "动画", tone: "ansi3" },
  { id: "3d", label: "3D", tone: "ansi6" },
  { id: "content", label: "内容", tone: "foreground" },
  { id: "tool", label: "工具", tone: "dim" },
  { id: "other", label: "其他", tone: "dim" },
];

const SKILL_ABOUT_LIMIT = 200;
const isSpecsealSkill = (name) => name.startsWith("specseal-");

// 扫到的 SKILL.md 变成清单。不列 Specseal 的和不能手动叫用的，同名的只留第一个。
export function skillEntries(found) {
  const seen = new Set();
  const skills = [];
  for (const x of found) {
    if (isSpecsealSkill(x.name) || x.invocable === "false" || seen.has(x.name)) continue;
    seen.add(x.name);
    const about = (x.description ?? "").replace(/^[>|][-+]?\s*/, "").replace(/^["']|["']$/g, "").trim();
    skills.push({
      name: x.name,
      source: x.source,
      path: x.source === "plugin" ? x.name.split(":")[0] : x.path,
      about: about.length > SKILL_ABOUT_LIMIT ? `${about.slice(0, SKILL_ABOUT_LIMIT).trimEnd()}…` : about,
      use: skillUse(x.name),
    });
  }
  return skills.sort((a, b) => (a.name < b.name ? -1 : 1));
}

export const hasSpecsealSkills = (found) => found.some((x) => isSpecsealSkill(x.name));

// 同一组里三个以上开头相同的技能收成一列（系列）。整组都同一系列时不用多一层，但整组太长就缺省收合。
const FAMILY_MIN = 3;
const GROUP_OPEN_LIMIT = 12;
const skillStem = (name) => name.split(/[-:]/)[0];

function familiesIn(items) {
  const count = new Map();
  for (const x of items) count.set(skillStem(x.name), (count.get(skillStem(x.name)) ?? 0) + 1);
  return new Set([...count].filter(([, n]) => n >= FAMILY_MIN && n < items.length).map(([stem]) => stem));
}

// 我的技能页的列。有搜索字时全部摊开，不分系列。
export function skillRows({ skills, query = "", groupOpen = {}, familyOpen = {} }) {
  const words = query.trim().toLowerCase();
  const matched = words ? skills.filter((x) => `${x.name} ${x.about}`.toLowerCase().includes(words)) : skills;
  const rows = [];
  const skillRow = (skill, nested) => ({ kind: "skill", key: `s:${skill.name}`, skill, nested });
  for (const group of SKILL_GROUPS) {
    const items = matched.filter((x) => x.use === group.id);
    if (items.length === 0) continue;
    const families = words ? new Set() : familiesIn(items);
    const inFamily = (x) => families.has(skillStem(x.name));
    const lines = items.filter((x) => !inFamily(x)).length + families.size;
    const open = words ? true : groupOpen[group.id] ?? lines <= GROUP_OPEN_LIMIT;
    rows.push({ kind: "group", key: `g:${group.id}`, id: group.id, group, count: items.length, open });
    if (!open) continue;
    const done = new Set();
    for (const x of items) {
      if (!inFamily(x)) {
        rows.push(skillRow(x, false));
        continue;
      }
      const stem = skillStem(x.name);
      if (done.has(stem)) continue;
      done.add(stem);
      const members = items.filter((y) => skillStem(y.name) === stem);
      const id = `${group.id}/${stem}`;
      const hint = members.slice(0, 4).map((y) => y.name.slice(stem.length + 1)).join(tr("、"));
      rows.push({ kind: "family", key: `f:${id}`, id, name: stem, count: members.length, open: Boolean(familyOpen[id]), hint: members.length > 4 ? `${hint}…` : hint });
      if (familyOpen[id]) rows.push(...members.map((y) => skillRow(y, true)));
    }
  }
  return rows;
}

const customCommand = (key, name, note) => `${SKILL_PREFIX[key]}${name}${note ? ` ${note}` : ""}`;

export function customPlacePlan({ name, note, agents, focus, agentKey }) {
  const agent = placeTarget(agents, focus, agentKey);
  if (agent.kind === "none") return agent;
  return { kind: "place", agent, text: pasteable(`${customCommand(agent.key, name, note)} `) };
}

export function customTabPlan({ name, note, root, known, agentKey, space, on }) {
  if (!known || !root) return none("还在确认可用的 agent");
  const usable = usableAgents(known);
  const pick = usable.find((a) => a.key === agentKey) ?? usable[0];
  if (!pick) return none("找不到有 specseal 技能的 agent");
  const text = customCommand(pick.key, name, note);
  return {
    kind: "tab",
    key: pick.key,
    text,
    tabName: name,
    hc: ["run", "--bg", "--json", "--no-parent", ...(on ? ["--on", on] : []), "--cwd", root, "--label", `herdr.space=${space}`, ...agentArgv(pick), text],
  };
}
