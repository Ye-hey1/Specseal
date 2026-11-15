// Spaces 侧栏的阶段徽章：这个项目的变更在各阶段有几个，顺序和颜色都和面板的卡片相同。
// Herdr 内置的 spaces mod 没有扩充点，所以 dock-panel.mjs 拷贝一份，把这个档放进去并接上。
import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec } from "herdr";
import { tr } from "./i18n.js";

const STAGES = [
  { id: "proposed", label: "提案中", tone: "ansi3" },
  { id: "in-progress", label: "进行中", tone: "ansi4" },
  { id: "ready", label: "已就绪", tone: "ansi2" },
];

// repo 对应各阶段的数量。内置 spaces 的 git 信息里，repo 是 JSON.stringify([机器, .git 文件夹])。
const counts = new Map();

async function look(view, cx) {
  const repos = new Set(Object.values(view.git).map((g) => g?.repo).filter(Boolean));
  for (const repo of repos) {
    const [on, gitDir] = JSON.parse(repo);
    // 没有 Specseal 的项目和连不上的机器都当成没有徽章。
    const r = await exec("specseal", ["plan", "--json"], { cwd: gitDir.replace(/\/\.git$/, ""), on }).catch(() => null);
    const changes = r?.code === 0 ? JSON.parse(r.stdout).changes : [];
    const now = STAGES.map((s) => changes.filter((c) => c.stage === s.id).length);
    if (String(counts.get(repo)) !== String(now)) {
      counts.set(repo, now);
      cx.notify();
    }
  }
}

export function watchStages(view, cx) {
  // 内置 spaces 刚启动时还在问 git，稍等才有 repo 可以看。
  cx.timer.after(2000, (cx) => look(view, cx));
  cx.timer.every(30000, (cx) => look(view, cx));
}

// 已就绪是下一步要收尾的变更，所以用底色和勾勾画得比较明显。
function stageMark({ id, tone, n }, t) {
  if (id === "ready") return div().px(5).rounded_full().bg(`${t[tone]}26`).text_color(t[tone]).child(`✓${n}`);
  return h_flex().gap(3).items_center().text_color(t[tone]).child(div().size(6).rounded_full().bg(t[tone])).child(String(n));
}

// 列尾固定不缩的部分：git 的箭头（从内置的 gitTail 搬来）和阶段徽章。回传数组，内置 spaces 用 children 接。
// 徽章只画在项目那一列，worktree 那几列属于同一个项目。
export function rowEnd(g, tree, t) {
  if (!g) return [];
  const shown = STAGES.map((s, i) => ({ ...s, n: counts.get(g.repo)?.[i] ?? 0 })).filter((s) => s.n > 0 && !tree);
  const arrow = (mark, n, color) => div().flex_none().text_size(11.5).text_color(color).child(`${mark}${n}`);
  return [
    ...(g.ahead > 0 ? [arrow("↑", g.ahead, t.ansi2)] : []),
    ...(g.behind > 0 ? [arrow("↓", g.behind, t.ansi1)] : []),
    ...(shown.length > 0
      ? [
          h_flex()
            .id(`specseal-stages-${g.repo}`)
            .flex_none()
            .gap(5)
            .items_center()
            .text_size(10.5)
            .font_semibold()
            .tooltip(shown.map((s) => `${tr(s.label)} ${s.n}`).join("　"))
            .children(shown.map((s) => stageMark(s, t))),
        ]
      : []),
  ];
}
