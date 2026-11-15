// Agents 清单拷贝版的 Specseal 部分：每个 agent 在做哪个变更、那个变更做到哪里。
// 内置的 agents mod 没有扩充点，所以 dock-panel.mjs 拷贝一份，把这个档和面板的 model.js、shared.js
// 放进去并接上。比对用面板的规则，两边才不会说法不同。
import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { agents, panes, terminals } from "herdr";
import { tr } from "./i18n.js";
import { agentChange, buildBoard, joinAgents } from "./model.js";
import { projectRoot, specsealJson } from "./shared.js";

const STAGE = {
  proposed: { label: "提案中", tone: "ansi3" },
  "in-progress": { label: "进行中", tone: "ansi4" },
  ready: { label: "已就绪", tone: "ansi2" },
};

// 别台机器的 agent，地址会带机器名称（vps/t7）。
const machineOf = (a) => (a.address.includes("/") ? a.address.split("/")[0] : null);
const placeKey = (on, folder) => `${on}\u0000${folder}`;

// 项目文件夹不会变，查过就记住。没有 Specseal 的项目，board 是 null。
const roots = new Map();
const boards = new Map();

async function look(cx) {
  const projects = new Map();
  for (const a of joinAgents(agents(), terminals(), panes())) {
    if (!a.cwd) continue;
    const on = machineOf(a);
    const place = placeKey(on, a.cwd);
    if (!roots.has(place)) roots.set(place, await projectRoot(a.cwd, on).catch(() => a.cwd));
    const root = roots.get(place);
    projects.set(placeKey(on, root), { on, root });
  }
  for (const [key, { on, root }] of projects) {
    const read = (verb) => specsealJson([verb], root, on);
    const [list, plan] = await Promise.all([read("list"), read("plan")]).catch(() => [null, null]);
    boards.set(key, list ? buildBoard(list, plan, { discussions: [] }) : null);
  }
  cx.notify();
}

export function watchPlans(cx) {
  cx.timer.after(1000, (cx) => look(cx));
  cx.timer.every(30000, (cx) => look(cx));
}

// 这个 agent 在做的变更。查不到时是 null。
export function changeOf(a) {
  const [agent] = joinAgents([a], terminals(), panes());
  const on = machineOf(a);
  const board = boards.get(placeKey(on, roots.get(placeKey(on, agent.cwd))));
  return board ? agentChange(agent, board) : null;
}

// 列尾的阶段颜色和任务进度。回传数组，内置的列用 children 接：没在做变更时什么都不画。
export function planMark(a, t) {
  const row = changeOf(a);
  if (!row) return [];
  const { label, tone } = STAGE[row.stage];
  const progress = row.total > 0 ? `${row.completed}/${row.total}` : "";
  return [
    h_flex()
      .id(`plan-${a.address}`)
      .ml_auto()
      .flex_none()
      .gap(3)
      .items_center()
      .text_size(10.5)
      .text_color(t[tone])
      .tooltip(tr("{0}：{1}", row.name, `${tr(label)} ${progress}`.trim()))
      .child(div().size(6).rounded_full().bg(t[tone]))
      .when(Boolean(progress), (el) => el.child(progress)),
  ];
}
