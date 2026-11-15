// Specseal 面板：目前 space 的项目有哪些变更与讨论、各自做到哪里，以及按一下把技能交给对的
// agent。数据只来自 specseal CLI 的 --json；判断逻辑都在 model.js。
import { View, div, image, svg } from "gpui-kit";
import { InputState, h_flex, v_flex } from "gpui-base";
import {
  agents,
  closeOverlay,
  exec,
  focused,
  hc,
  knownAgents,
  notify,
  panes,
  props,
  run,
  shared,
  spaces,
  terminals,
  theme,
  watchFolder,
} from "herdr";
import {
  attachPlan,
  buildBoard,
  canOpenProject,
  changeActions,
  changeAgents,
  deliveryHint,
  discussionActions,
  discussionAgents,
  unrecordedDiscussions,
  isUninitialized,
  joinAgents,
  lastOpenError,
  logoOpenAttempts,
  rowChoices,
  specsealUrl,
  startChoices,
  stationViews,
  waveToStart,
} from "./model.js";
import ColumnSync from "./column-sync.js";
import { tr, watchLang } from "./i18n.js";
import SkillPicker from "./skill-picker.js";
import { codeRemaining, firstLine, location, openTabs, placeInInput, projectRoot, sendError, spaceFor, specsealJson, stationFacts } from "./shared.js";

// 这个 mod 的其他画面。specseal-new 开跳窗、dock-panel.mjs 放浮动区块时，用 props 的 view 指定。
const VIEWS = { "skill-picker": SkillPicker, "column-sync": ColumnSync };
const ICONS = "mods/specseal/icons";
// 溢出折叠的门槛与桌面 app 的系统匣面板相同。
const OVERFLOW_LIMIT = 5;
const STAGES = [
  { id: "proposed", label: "提案中", tone: "ansi3" },
  { id: "in-progress", label: "进行中", tone: "ansi4" },
  { id: "ready", label: "已就绪", tone: "ansi2" },
];
const AGENT_STATE = { working: "运行中", blocked: "在等你回答", done: "已完成", idle: "闲置" };
// 图标和文本与桌面 app 的看板卡片相同：形状分站别（徽章是 review，盾牌是 verify），颜色分状态。
const STATION_BADGE = {
  review: {
    stamped: ["badge-check", "已审查"],
    stale: ["badge-alert", "已审查·其后有变动"],
    open: ["stamp", "审查中"],
    running: ["stamp", "审查中"],
  },
  verify: {
    stamped: ["shield-check", "已验证"],
    stale: ["shield-alert", "已验证·其后有变动"],
    open: ["shield", "验证中"],
    running: ["shield", "验证中"],
  },
};
const STATION_TONE = { stamped: "ansi5", stale: "ansi3", open: "ansi4", running: "ansi4" };

const icon = (name, size, color) => svg(`${ICONS}/${name}.svg`).size(size).flex_none().text_color(color);
const baseName = (path) => path.split("/").filter(Boolean).pop() ?? path;

// program.icon 是相对于 Herdr 设置文件夹的路径：tint 表示单色图标，其余是图片。
function programIcon(program, size, color) {
  if (!program?.icon) return div();
  return program.tint
    ? svg(program.icon).size(size).flex_none().text_color(color)
    : image(program.icon).w(size).h(size).flex_none();
}

export default class SpecsealPanel extends View {
  init(_props, cx) {
    watchLang(exec, cx, { div, InputState });
    const Other = VIEWS[props()?.view];
    if (Other) {
      this.other = new Other();
      this.other.init(cx);
      return;
    }
    this.place = location();
    this.root = null;
    this.board = null;
    this.error = null;
    this.uninitialized = false;
    this.known = null;
    this.copied = null;
    this.attaching = new Map();
    this.choosing = null;
    this.expanded = null;
    this.more = new Set();
    this.sending = new Set();
    this.starting = new Set();
    this.worktreePolicy = false;
    this.collapsed = new Set(JSON.parse(localStorage.getItem("collapsed") ?? "[]"));
    this.promotedOpen = localStorage.getItem("promotedOpen") === "true";
    this.reload(cx);
    this.loadKnown(cx);
    // worktree 里的任务进度不在主文件夹的监看范围内，要靠计时重抓。
    cx.timer.every(10000, (cx) => {
      this.follow(cx);
      this.reload(cx);
    });
  }

  // 焦点或文件夹变了就改跟新的项目。render 会随 Herdr 的即时数据重跑，所以平常立刻跟上；
  // 窗口没有画面更新时（被其他窗口完全盖住）render 不会跑，由计时补上。
  follow(cx) {
    const { cwd, on } = this.place;
    this.place = location();
    if (this.place.cwd === cwd && this.place.on === on) return;
    if (this.place.on !== on) this.loadKnown(cx);
    this.reload(cx);
  }

  // 检查失败时 knownAgents 会丢错，Herdr 也不记住这次结果，所以过 10 秒再查；查到之前面板显示「还在确认」。
  loadKnown(cx) {
    this.retryKnown?.cancel();
    cx.spawn(async (cx) => {
      this.known = await knownAgents({ on: this.place.on }).catch(() => null);
      if (!this.known) this.retryKnown = cx.timer.after(10000, (cx) => this.loadKnown(cx));
      cx.notify();
    });
  }

  reload(cx) {
    if (this.loading) {
      this.again = true;
      return;
    }
    const { cwd, on } = this.place;
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const root = await projectRoot(cwd, on);
        if (root !== this.root) {
          this.root = root;
          this.board = null;
          this.uninitialized = false;
          this.watch(root, on, cx);
        }
        const read = (...verb) => specsealJson(verb, root, on);
        const [list, plan, discussions, config] = await Promise.all([
          read("list"),
          read("plan"),
          read("discuss", "list"),
          read("workflow-config", "show"),
        ]);
        const [remaining, facts] = await Promise.all([codeRemaining(list, plan, root, on), stationFacts(list, plan, root, on)]);
        this.board = buildBoard(list, plan, discussions, remaining, facts);
        this.worktreePolicy = config.worktree === true;
        this.error = null;
        this.uninitialized = false;
      } catch (e) {
        const message = String(e.message ?? e);
        this.uninitialized = isUninitialized(message);
        this.error = this.uninitialized ? null : message;
        // 切到没有 Specseal 的分支时，旧的变更清单不能留着。
        if (this.uninitialized) this.board = null;
      }
      this.loading = false;
      cx.notify();
      if (this.again) {
        this.again = false;
        this.reload(cx);
      }
    });
  }

  // 规格文件夹有动静就重抓。内容问 CLI，只有章 CLI 不给（见 stationFacts）。watchFolder 只看得到本机。
  watch(root, on, cx) {
    if (on) return;
    cx.spawn(async (cx) => {
      const found = await exec("ls", ["-d", "specseal", "openspec"], { cwd: root }).catch(() => null);
      const dir = found?.stdout.trim().split("\n")[0];
      if (!dir) return;
      try {
        while (this.root === root) {
          await watchFolder(`${root}/${dir}`);
          if (this.root === root) this.reload(cx);
        }
      } catch {
        // 监看失败时还有计时重抓。
      }
    });
  }

  context() {
    const f = focused();
    return {
      root: this.root,
      agents: joinAgents(agents(), terminals(), panes()).map((a) =>
        this.sending.has(a.address) ? { ...a, status: "sending" } : a,
      ),
      focus: { tab: f?.tab ?? null, terminal: f?.terminal ?? null },
      space: f?.space ?? null,
      on: this.place.on,
      board: this.board,
      known: this.known,
      preferred: shared("specseal.agent") ?? null,
      worktreePolicy: this.worktreePolicy,
      starting: this.starting,
    };
  }

  deliver(delivery, cx) {
    this.expanded = null;
    if (delivery.kind === "send") {
      const { address } = delivery.agent;
      this.sending.add(address);
      cx.notify();
      cx.spawn(async (cx) => {
        const r = await hc(delivery.hc);
        this.sending.delete(address);
        if (r.code === 0) {
          // 面板才知道这个 agent 接下来在做什么。
          hc(["label", address, ...delivery.labels]);
          run("pane.focus", { terminal: address });
        } else notify({ title: tr("技能没有送出"), body: sendError(r), level: "warning" });
        cx.notify();
      });
    } else if (delivery.kind === "new") {
      const before = new Set(terminals().map((t) => t.address));
      run("tab.new", {
        folder: delivery.folder,
        argv: delivery.argv,
        task: delivery.text,
        name: delivery.tabName,
        space: spaceFor(delivery.folder)?.id,
      });
      this.labelNew(before, delivery, cx, 10);
      if (delivery.change) this.markStarting(delivery.change, cx);
    }
  }

  // 开工和技能跳窗的开新分页相同：开在目前的工作区，画面留在原分页。
  startTabs(plans, cx) {
    this.choosing = null;
    for (const plan of plans) this.markStarting(plan.change, cx);
    cx.spawn(async (cx) => {
      const failed = await openTabs(plans, cx);
      if (failed) notify({ title: tr("开工失败"), body: sendError(failed), level: "warning" });
    });
  }

  // agent 开好并回报状态要几秒，这段时间列上还看不到它，再按一次开工会多开一个。
  markStarting(change, cx) {
    this.starting.add(change);
    cx.notify();
    cx.timer.after(15000, (cx) => {
      this.starting.delete(change);
      cx.notify();
    });
  }

  // 新分页粘贴标签，之后按这个变更的技能才认得它。tab.new 不回传终端机地址，要等它出现。
  labelNew(before, delivery, cx, tries) {
    cx.timer.after(300, (cx) => {
      const tabs = new Map(spaces().flatMap((s) => s.tabs).map((t) => [t.id, t]));
      const pane = panes().find((p) => p.terminal && !before.has(p.terminal) && tabs.get(p.tab)?.name === delivery.tabName);
      if (pane) {
        hc(["label", pane.terminal, ...delivery.labels]);
      } else if (tries > 1) {
        this.labelNew(before, delivery, cx, tries - 1);
      }
    });
  }

  // 叫 Specseal 桌面 app。open 只有 macOS 有；没装 app 时 open 也会失败。
  openInApp(args, cx) {
    this.openFirstInApp([args], cx);
  }

  // 依序试 open，成功就停；全部失败才跳通知，内文是最后一次有内容的错误。
  openFirstInApp(attempts, cx) {
    cx.spawn(async () => {
      const error = await lastOpenError(attempts, exec);
      if (error !== null) notify({ title: tr("开不了 Specseal"), body: firstLine(error), level: "warning" });
    });
  }

  // 判断这个 space 的项目能不能用网址开时看的两件事。
  projectTarget() {
    return { hasBoard: Boolean(this.board), on: this.place.on };
  }

  copy(text, cx) {
    cx.write_to_clipboard(text);
    this.copied = text;
    cx.notify();
    cx.timer.after(1200, (cx) => {
      if (this.copied === text) this.copied = null;
      cx.notify();
    });
  }

  toggleSection(id, cx) {
    if (id === "promoted") {
      this.promotedOpen = !this.promotedOpen;
      localStorage.setItem("promotedOpen", String(this.promotedOpen));
    } else {
      if (this.collapsed.has(id)) this.collapsed.delete(id);
      else this.collapsed.add(id);
      localStorage.setItem("collapsed", JSON.stringify([...this.collapsed]));
    }
    cx.notify();
  }

  copyButton(id, text, label, t) {
    return div()
      .id(`copy-${id}`)
      .flex_none()
      .p(3)
      .rounded(4)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .tooltip(label)
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.copy(text, cx);
      })
      .child(icon(this.copied === text ? "check" : "copy", 12, t.muted));
  }

  chip({ id, label, ready, primary, tip, click }, t) {
    return h_flex()
      .id(id)
      .h(22)
      .px(7)
      .items_center()
      .rounded(5)
      .text_size(11.5)
      .when(primary, (el) => el.border_2().border_color(t.accent).font_semibold())
      .when(!primary, (el) => el.border_1().border_color(t.input))
      .when(ready, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)))
      .when(!ready, (el) => el.opacity(0.45))
      // 灰掉的钮也要挡下点击，否则会变成点到列本身。
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (ready) click(cx);
      })
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .child(label);
  }

  skillButton(id, action, t) {
    const d = action.delivery;
    const tip = action.waitingFor
      ? tr("等 {0} 先完成", action.waitingFor.join(tr("、")))
      : d.text
        ? `${deliveryHint(d)}：${d.text}`
        : deliveryHint(d);
    return this.chip(
      {
        id: `skill-${id}-${action.skill}`,
        // 写实际会送出的技能。有 worktree 时 apply 会换成 apply-with-worktree。
        label: tr(d?.skill ?? action.skill),
        ready: d && (d.kind === "send" || d.kind === "new"),
        primary: action.primary,
        tip,
        click: (cx) => this.deliver(d, cx),
      },
      t,
    );
  }

  // 开工的一种做法。
  startChoice(id, { label, plan }, t) {
    const ready = plan.kind === "tab";
    return this.chip(
      {
        id: `start-${id}-${label}`,
        label: tr(label),
        ready,
        tip: ready ? tr("在目前的工作区开新分页并运行：{0}", plan.text) : plan.reason,
        click: (cx) => this.startTabs([plan], cx),
      },
      t,
    );
  }

  // 只有一种做法就直接开工，有两种时按下去才展开选项。
  startButton(id, target, choices, t) {
    if (choices.length === 1) return this.startChoice(id, choices[0], t);
    return this.chip(
      {
        id: `start-${id}`,
        label: tr("开工"),
        ready: true,
        tip: tr("选择用 worktree 或直接 apply"),
        click: (cx) => {
          this.choosing = target;
          cx.notify();
        },
      },
      t,
    );
  }

  // 粘贴要约 0.7 秒，所以按下去要先有反应。粘贴中再按一次不算，否则名称会贴两次。
  attach(plan, name, cx) {
    if (this.attaching.has(name)) return;
    this.attaching.set(name, "pasting");
    cx.notify();
    cx.spawn(async (cx) => {
      const failed = await placeInInput(plan);
      if (failed) {
        this.attaching.delete(name);
        notify({ title: tr("没有放进输入框"), body: sendError(failed), level: "warning" });
      } else {
        this.attaching.set(name, "done");
        cx.timer.after(1200, (cx) => {
          this.attaching.delete(name);
          cx.notify();
        });
      }
      cx.notify();
    });
  }

  // 把名称接到目前分页的输入框，不送出。
  attachButton(id, name, ctx, t) {
    const plan = attachPlan({ name, agents: ctx.agents, focus: ctx.focus });
    const ready = plan.kind !== "none";
    const state = this.attaching.get(name);
    return div()
      .id(`attach-${id}`)
      .flex_none()
      .p(3)
      .rounded(4)
      .when(ready, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)))
      .when(!ready && !state, (el) => el.opacity(0.45))
      .tooltip(ready ? tr("附加到目前分页的输入框") : plan.reason)
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (ready) this.attach(plan, name, cx);
      })
      .child(
        state === "pasting"
          ? icon("spinner", 12, t.working).spin(900)
          : icon(state === "done" ? "check" : "message-plus", 12, t.muted),
      );
  }

  // 展开这一列其他能用的技能。没有其他技能的列不放这颗钮。
  moreButton(id, target, t) {
    const open = this.expanded === target;
    return h_flex()
      .id(`more-${id}`)
      .flex_none()
      .h(22)
      .px(5)
      .items_center()
      .rounded(5)
      .text_color(t.muted)
      .cursor_pointer()
      .when(open, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .tooltip(tr("其他技能"))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.expanded = open ? null : target;
        cx.notify();
      })
      .child("⋯");
  }

  // 每列只留建议的下一步，其他的按 ⋯ 才展开。能开工的列多一颗开工。
  skillRow({ id, actions, start, target, hint }, t) {
    // 开工要选做法时，这一列只放选项。
    if (start?.length > 1 && this.choosing === target) {
      return h_flex()
        .gap(4)
        .items_center()
        .children(start.map((choice) => this.startChoice(id, choice, t)))
        .child(
          this.chip(
            {
              id: `start-${id}-cancel`,
              label: tr("取消"),
              ready: true,
              click: (cx) => {
                this.choosing = null;
                cx.notify();
              },
            },
            t,
          ),
        );
    }
    const { next, beside, others } = rowChoices(actions, start);
    return v_flex()
      .gap(4)
      .child(
        h_flex()
          .gap(4)
          .items_center()
          .when(Boolean(start), (el) => el.child(this.startButton(id, target, start, t)))
          .child(this.skillButton(id, next, t))
          .children(beside.map((action) => this.skillButton(id, action, t)))
          .when(others.length > 0, (el) => el.child(this.moreButton(id, target, t)))
          .when(Boolean(hint), (el) =>
            el.child(div().flex_1().min_w_0().truncate().text_size(11).text_color(t.dim).child(hint)),
          ),
      )
      .when(this.expanded === target && others.length > 0, (el) =>
        el.child(h_flex().flex_wrap().gap(4).items_center().children(others.map((action) => this.skillButton(id, action, t)))),
      );
  }

  // 和 Herdr 内置的 Agents 清单同一套：做事中是转动的圆弧，闲置是空心圈，做完是实心点，等回答是胶囊。
  agentStatus(view, t) {
    if (view === "working") return icon("spinner", 12, t.working).mx(1).spin(900);
    if (view === "blocked") {
      return div()
        .flex()
        .flex_none()
        .h(18)
        .px(6)
        .items_center()
        .rounded(5)
        .bg(`${t.blocked}26`)
        .text_size(10.5)
        .font_semibold()
        .text_color(t.blocked)
        .child(tr(AGENT_STATE.blocked));
    }
    if (view === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle);
    return div().size(7).mx(3).flex_none().rounded(4).bg(t[view] ?? t.dim);
  }

  // 目前分页对应的那一列：左边一条色带和淡淡的底色。
  markCurrent(el, t) {
    return el.pl(7).border_l(3).border_color(t.accent).bg(`${t.accent}12`);
  }

  agentChip(id, a, here, t) {
    return h_flex()
      .id(`agent-${id}-${a.address}`)
      .gap(5)
      .px(5)
      .py(2)
      .items_center()
      .rounded(5)
      .text_size(11)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .tooltip(tr("切到这个 agent（{0}）", tr(AGENT_STATE[a.view] ?? a.view)))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run("agent.focus", { terminal: a.address });
      })
      .child(programIcon(a.program, 12, t.muted))
      .child(div().flex_1().min_w_0().truncate().text_color(here ? t.foreground : t.muted).child(`${a.space_name} / ${a.tab_name}`))
      .when(here, (el) =>
        el.child(div().flex_none().px(5).rounded(4).bg(`${t.accent}26`).text_size(10).text_color(t.accent).child(tr("目前分页"))),
      )
      .child(this.agentStatus(a.view, t));
  }

  // 点列本身叫 Specseal 开详情。列上的钮都会挡下点击。别台机器的项目路径在这台开不了。
  openOnClick(el, url, t) {
    if (this.place.on) return el;
    return el
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.openInApp([url], cx));
  }

  waveNumber(row, t) {
    const number = div()
      .id(`wave-${row.name}`)
      .flex_none()
      .text_size(11)
      .font_semibold()
      .text_color(t.accent)
      .child(String(row.wave));
    if (this.place.on) return number;
    return number
      .px(3)
      .rounded(3)
      .cursor_pointer()
      .hover((s) => s.bg(t.raised))
      .tooltip(tr("在 Specseal 开路线图"))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.openInApp([specsealUrl("roadmap", this.root)], cx);
      });
  }

  // agent 正在跑的站会呼吸，和工单开着但没人在跑的站分得开。
  stationBadges(row, ctx, t) {
    return stationViews(row, ctx.agents).map(({ station, state }) => {
      const [name, label] = STATION_BADGE[station][state];
      return div()
        .id(`station-${row.name}-${station}`)
        .flex_none()
        .when(state === "running", (el) => el.loop("opacity", { from: 0.35, to: 1, period: 1400 }))
        .tooltip(tr(label))
        .child(icon(name, 13, t[STATION_TONE[state]]));
    });
  }

  changeRow(row, stage, ctx, t) {
    const actions = changeActions(row, ctx);
    const start = startChoices(row, ctx);
    const blocked = row.blockedBy.length > 0;
    const hint = blocked ? tr("等 {0}", row.blockedBy.join(tr("、"))) : "";
    const percent = row.total > 0 ? Math.round((row.completed / row.total) * 100) : 0;
    const working = changeAgents(row, ctx.agents);
    const el = v_flex()
      .id(`change-${row.name}`)
      .px(10)
      .py(8)
      .gap(5)
      .when(working.some((a) => a.tab === ctx.focus.tab), (el) => this.markCurrent(el, t))
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .when(blocked, (el) => el.opacity(0.6))
          .child(this.waveNumber(row, t))
          .child(div().flex_1().min_w_0().truncate().child(row.name))
          .children(this.stationBadges(row, ctx, t))
          .when(Boolean(row.worktree), (el) =>
            el.child(
              div()
                .id(`branch-${row.name}`)
                .flex_none()
                .tooltip(`worktree：${row.worktree?.branch}`)
                .child(icon("branch", 12, t.ansi4)),
            ),
          )
          .when(row.total > 0, (el) =>
            el.child(div().flex_none().text_size(11).text_color(t.muted).child(`${row.completed}/${row.total}`)),
          )
          .child(this.attachButton(`change-${row.name}`, row.name, ctx, t))
          .child(this.copyButton(`change-${row.name}`, row.name, tr("拷贝名称"), t)),
      )
      .when(row.total > 0, (el) =>
        el.child(
          div()
            .h(4)
            .rounded(2)
            .bg(t.raised)
            .overflow_hidden()
            .when(blocked, (bar) => bar.opacity(0.6))
            .child(div().h_full().rounded(2).w(`${percent}%`).bg(t[stage.tone])),
        ),
      )
      .children(working.map((a) => this.agentChip(`change-${row.name}`, a, a.tab === ctx.focus.tab, t)))
      .child(this.skillRow({ id: `change-${row.name}`, actions, start, target: row.name, hint }, t));
    return this.openOnClick(el, specsealUrl("change", this.root, row.name), t);
  }

  discussionRow(d, ctx, t) {
    const actions = discussionActions(d, ctx);
    const hint = d.cuts.length > 0 ? tr("还有 {0} 刀没转出", d.cuts.length) : "";
    const working = discussionAgents(d, ctx.agents);
    const el = v_flex()
      .id(`discussion-${d.slug}`)
      .px(10)
      .py(8)
      .gap(5)
      .when(working.some((a) => a.tab === ctx.focus.tab), (el) => this.markCurrent(el, t))
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(
            v_flex()
              .flex_1()
              .min_w_0()
              .child(div().truncate().child(d.slug))
              .child(div().truncate().text_size(11).text_color(t.muted).child(d.topic)),
          )
          .child(this.attachButton(`discussion-${d.slug}`, d.slug, ctx, t))
          .child(this.copyButton(`discussion-${d.slug}`, d.slug, tr("拷贝 slug"), t)),
      )
      .children(working.map((a) => this.agentChip(`discussion-${d.slug}`, a, a.tab === ctx.focus.tab, t)))
      .child(this.skillRow({ id: `discussion-${d.slug}`, actions, target: d.slug, hint }, t));
    return this.openOnClick(el, specsealUrl("discussion", this.root, d.slug), t);
  }

  // 还没记录的讨论。名称用 agent 的标题；记录创建后，agent 会移到正式的那一列。
  unrecordedRow(a, ctx, t) {
    const here = a.tab === ctx.focus.tab;
    return v_flex()
      .id(`discussion-unrecorded-${a.address}`)
      .px(10)
      .py(8)
      .gap(5)
      .when(here, (el) => this.markCurrent(el, t))
      .child(
        v_flex()
          .min_w_0()
          .child(div().truncate().child(a.title || a.tab_name))
          .child(div().truncate().text_size(11).text_color(t.muted).child(tr("讨论中，还没记录"))),
      )
      .child(this.agentChip(`discussion-unrecorded-${a.address}`, a, here, t));
  }

  // 超过门槛的列收进「还有 N 个…」。
  overflow(id, rows, t) {
    if (rows.length <= OVERFLOW_LIMIT) return rows;
    const open = this.more.has(id);
    return [
      ...(open ? rows : rows.slice(0, OVERFLOW_LIMIT)),
      div()
        .id(`more-${id}`)
        .px(10)
        .py(6)
        .text_size(12)
        .text_color(t.muted)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => {
          if (open) this.more.delete(id);
          else this.more.add(id);
          cx.notify();
        })
        .child(open ? tr("收合") : tr("还有 {0} 个…", rows.length - OVERFLOW_LIMIT)),
    ];
  }

  card({ id, tone, label, rows, open }, t) {
    return v_flex()
      .flex_none()
      .rounded(10)
      .border_1()
      .border_color(t.border)
      .bg(t.surface)
      .overflow_hidden()
      .child(
        h_flex()
          .id(`card-${id}`)
          .h(30)
          .px(10)
          .gap(6)
          .items_center()
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .when(open && rows.length > 0, (el) => el.border_b_1().border_color(t.border))
          .on_click((_e, cx) => this.toggleSection(id, cx))
          .child(div().w(8).h(8).flex_none().rounded_full().bg(tone))
          .child(div().font_semibold().text_size(12).child(tr(label)))
          .child(div().px(6).rounded_full().bg(t.raised).text_size(11).text_color(t.muted).child(String(rows.length)))
          .child(div().flex_1())
          .child(icon(open ? "chevron-down" : "chevron-right", 13, t.muted)),
      )
      .when(open, (el) => el.children(this.roundLast(this.overflow(id, rows, t))));
  }

  // 卡片的 overflow_hidden 只裁矩形。最后一列要自己圆角，底色才不会从卡片的圆角露出来。
  roundLast(rows) {
    return rows.map((row, i) => (i === rows.length - 1 ? row.rounded_b(9) : row));
  }

  // 整波开工不再多问一次：同一列已经写出会开哪些变更。
  waveBar({ wave, plans }, t) {
    return h_flex()
      .flex_none()
      .gap(8)
      .px(10)
      .py(6)
      .items_center()
      .rounded(10)
      .border_1()
      .border_color(t.border)
      .bg(t.surface)
      .child(
        div()
          .flex_1()
          .min_w_0()
          .text_size(11.5)
          .text_color(t.muted)
          .child(tr("第 {0} 波可以一起开工：{1}", wave, plans.map((p) => p.change).join(tr("、")))),
      )
      .child(
        h_flex()
          .id("start-wave")
          .flex_none()
          .h(22)
          .px(7)
          .items_center()
          .rounded(5)
          .border_1()
          .border_color(t.input)
          .text_size(11.5)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .tooltip(tr("开 {0} 个新分页，各跑一个 agent", plans.length))
          .on_click((_e, cx) => this.startTabs(plans, cx))
          .child(tr("整波开工")),
      );
  }

  // 开新分页跑 specseal init，不交给 agent：它要在真的终端机逐题问装哪些技能，答完才写入文件。
  // 写出文件夹，按之前看得到会装在哪里。
  initCard(t) {
    return v_flex()
      .flex_none()
      .px(10)
      .py(8)
      .gap(6)
      .rounded(10)
      .border_1()
      .border_color(t.border)
      .bg(t.surface)
      .child(div().font_semibold().text_size(12).child(tr("这个项目还没有 Specseal")))
      .child(div().text_size(11).text_color(t.muted).child(this.root))
      .child(
        h_flex().child(
          h_flex()
            .id("init")
            .h(22)
            .px(7)
            .items_center()
            .rounded(5)
            .border_2()
            .border_color(t.accent)
            .font_semibold()
            .text_size(11.5)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .tooltip(tr("在新分页运行 specseal init"))
            .on_click(() => run("tab.new", { name: "specseal init", folder: this.root, argv: ["specseal", "init"] }))
            .child(tr("初始化")),
        ),
      );
  }

  body(ctx, t) {
    const { stages, discussions, promoted, skipped } = this.board;
    const wave = waveToStart(stages, ctx);
    const cards = wave ? [this.waveBar(wave, t)] : [];
    for (const stage of STAGES) {
      cards.push(
        this.card(
          {
            id: stage.id,
            tone: t[stage.tone],
            label: stage.label,
            rows: stages[stage.id].map((row) => this.changeRow(row, stage, ctx, t)),
            open: !this.collapsed.has(stage.id),
          },
          t,
        ),
      );
    }
    cards.push(
      this.card(
        {
          id: "discussions",
          tone: t.ansi5,
          label: "讨论",
          rows: [
            ...unrecordedDiscussions(this.board, ctx.agents, ctx.root).map((a) => this.unrecordedRow(a, ctx, t)),
            ...discussions.map((d) => this.discussionRow(d, ctx, t)),
          ],
          open: !this.collapsed.has("discussions"),
        },
        t,
      ),
    );
    if (promoted.length > 0) {
      cards.push(
        this.card(
          {
            id: "promoted",
            tone: t.muted,
            label: "已转出",
            rows: promoted.map((d) => this.discussionRow(d, ctx, t)),
            open: this.promotedOpen,
          },
          t,
        ),
      );
    }
    if (skipped.length > 0) {
      cards.push(
        div()
          .flex_none()
          .px(4)
          .text_size(11)
          .text_color(t.blocked)
          .child(tr("这些变更读不到 metadata：{0}", skipped.map((s) => s.change).join(tr("、")))),
      );
    }
    return cards;
  }

  headerButton(id, iconName, label, t, onClick) {
    return h_flex()
      .id(id)
      .h(24)
      .px(7)
      .gap(4)
      .items_center()
      .rounded(5)
      .border_1()
      .border_color(t.input)
      .text_size(11.5)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => onClick(cx))
      .child(icon(iconName, 12, t.foreground))
      .child(label);
  }

  // Logo 也是叫出 Specseal app 的钮，读得到这台机器上的项目时会切过去。别台机器的 space 和
  // 没初始化的项目也能按，只叫出 app。
  logoButton(t) {
    const target = this.projectTarget();
    const attempts = logoOpenAttempts({ root: this.root, ...target });
    return div()
      .id("open-app")
      .flex_none()
      .p(3)
      .rounded(5)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .tooltip(canOpenProject(target) ? tr("在 Specseal app 打开这个项目") : tr("打开 Specseal app"))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => this.openFirstInApp(attempts, cx))
      .child(image(`${ICONS}/logo.svg`).w(21).h(24));
  }

  render(cx) {
    if (this.other) return this.other.render(cx);
    const t = theme();
    this.follow(cx);
    const ctx = this.context();
    const overlay = props()?.overlay;
    return v_flex()
      .id("specseal-panel")
      .size_full()
      // 没有 overlay 就是停靠在版面里，底色和侧栏一样，卡片才浮得出来。
      .bg(overlay ? t.popover : t.chrome)
      .text_size(12.5)
      .text_color(t.foreground)
      .child(
        h_flex()
          .flex_none()
          .h(46)
          .px(10)
          .gap(6)
          .items_center()
          .child(this.logoButton(t))
          .child(
            v_flex()
              .flex_1()
              .min_w_0()
              .child(div().truncate().font_semibold().child(this.root ? baseName(this.root) : "Specseal"))
              .child(
                div()
                  .truncate()
                  .text_size(11)
                  .text_color(t.muted)
                  .child([tr("目前的工作区"), this.place.branch].filter(Boolean).join(" · ")),
              ),
          )
          // 读不到项目（文件夹没有 specseal）时不给钮：网址会跳到桌面 app 的初始化确认框。
          .when(canOpenProject(this.projectTarget()), (el) =>
            el.child(
              this.headerButton("roadmap", "roadmap", tr("路线图"), t, (cx) =>
                this.openInApp([specsealUrl("roadmap", this.root)], cx),
              ),
            ),
          )
          // 还没初始化时，自己装的技能还是能用。
          .child(this.headerButton("skills", "zap", tr("技能"), t, () => run("mod.open", { name: "specseal-new" })))
          .when(Boolean(overlay), (el) =>
            el.child(
              div()
                .id("close")
                .p(4)
                .rounded(5)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                .on_click(() => closeOverlay(overlay))
                .child(icon("x", 13, t.muted)),
            ),
          ),
      )
      .child(
        v_flex()
          .id("specseal-body")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .px(8)
          .pb(8)
          .gap(8)
          // 窗口只能从标头拖，内容区的按压留给卷动与按钮。
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .when(Boolean(this.error), (el) =>
            el.child(div().flex_none().px(4).text_size(11.5).text_color(t.blocked).child(this.error)),
          )
          .when(this.uninitialized, (el) => el.child(this.initCard(t)))
          .when(!this.board && !this.error && !this.uninitialized, (el) =>
            el.child(div().flex_none().px(4).text_size(11.5).text_color(t.dim).child(tr("加载中…"))),
          )
          .when(Boolean(this.board), (el) => el.children(this.body(ctx, t))),
      );
  }
}
