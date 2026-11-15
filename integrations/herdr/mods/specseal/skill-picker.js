// 技能跳窗有两页：Specseal 页选技能和搭配的变更或讨论，我的技能页（my-skills.js）列用户自己装的技能。
// 右上角选要给哪个 agent。底部两颗钮：Enter 把指令贴到目前分页的输入框，不送出；
// ⌘Enter 照 herdr-dispatch 技能的做法，用 hc run 开新分页并开工。变更可以勾选，一次开多个分页。
// 由 specseal-new 的 mod.json 打开，main.js 看到 props 的 view 就把画面交给这里。
import { div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { agents, closeOverlay, focused, knownAgents, panes, props, setShared, shared, terminals, theme } from "herdr";
import {
  PICKER_ROWS,
  PICKER_SKILLS,
  PICKER_VARIANTS,
  batchPlan,
  buildBoard,
  defaultAgent,
  isUninitialized,
  joinAgents,
  missingSkillsPlan,
  newTabPlan,
  onlyClaude,
  pickerGroups,
  pickerStep,
  placePlan,
  skillTargets,
  usableAgents,
} from "./model.js";
import { tr } from "./i18n.js";
import MySkillsPage from "./my-skills.js";
import { codeRemaining, location, openTabs, placeInInput, projectRoot, sendError, specsealJson } from "./shared.js";

const STAGE_LABEL = { proposed: "提案中", "in-progress": "进行中", ready: "已就绪" };
// 颜色和 Claude Code 的技能列对应。
const GROUP_TONE = { 规划: "ansi5", 实作: "ansi4", 品质: "ansi3", 收尾: "ansi2", 项目: "dim" };
// 勾选框连同可以点的边。不能勾的列留同样的空位，名称才对得齐。
const TICK_SIZE = 18;
const PAIR_LABEL = { 讨论: "搭配的讨论", 变更: "搭配的变更" };
const PAIR_EMPTY = { 讨论: "目前没有可以搭配的讨论", 变更: "目前没有可以搭配的变更" };

export default class SkillPicker {
  init(cx) {
    this.page = "specseal";
    this.rowName = null;
    this.variants = {};
    this.groupChoices = {};
    this.agentKey = null;
    this.target = null;
    this.checked = new Set();
    this.board = null;
    this.root = null;
    this.known = null;
    this.worktreePolicy = false;
    this.uninitialized = false;
    this.sending = false;
    this.error = null;
    this.handle = cx.focus_handle();
    this.note = InputState.new();
    this.note.on("change", (_e, cx) => cx.notify());
    // ⌘Enter 在输入框里是 secondary 的 submit。
    this.note.on("submit", (e, cx) => (e.secondary ? this.startTabs(cx) : this.putInInput(cx)));
    this.mine = new MySkillsPage(this);
    this.focusKeys();
    // 和 Herdr 内置的跳窗相同：刚开的前几个画面可能还拿不到焦点。
    cx.timer.after(600, () => this.focusKeys());
    this.load(cx);
  }

  groups() {
    return pickerGroups((skill) => this.targets(skill).length, this.groupChoices);
  }

  // 左边选中的列。它被收起来时改选第一个看得到的。
  row() {
    const shown = this.groups().flatMap((g) => g.rows);
    return shown.find((w) => w.skill === this.rowName) ?? shown[0] ?? PICKER_ROWS[0];
  }

  // 真正要送的技能：合成一列的技能看右边选了哪个做法。
  skill() {
    const row = this.row();
    const choices = PICKER_VARIANTS[row.skill];
    if (!choices) return row;
    return PICKER_SKILLS.find((w) => w.skill === choices[this.variants[row.skill] ?? 0].skill);
  }

  agentName() {
    return usableAgents(this.known).find((a) => a.key === this.agentKey)?.name ?? this.agentKey;
  }

  selectAgent(key, cx) {
    this.agentKey = key;
    this.mine.load(key, cx);
  }

  // 搭配变更的技能指令就是全部，要补字可以放到输入框后再打。其他技能才在跳窗里打字。
  hasNote() {
    return !this.uninitialized && this.skill().pair !== "变更";
  }

  // 只有变更能勾：讨论一次接续一场，项目的技能不搭配东西。
  canTick() {
    return this.skill().pair === "变更";
  }

  // 没有输入框时由跳窗本身接按键。
  focusKeys() {
    if (this.page === "mine") this.mine.focus();
    else (this.hasNote() ? this.note : this.handle).focus();
  }

  showPage(page) {
    this.page = page;
    this.focusKeys();
  }

  load(cx) {
    const { cwd, on } = location();
    this.on = on;
    cx.spawn(async (cx) => {
      this.root = await projectRoot(cwd, on).catch(() => cwd);
      this.known = await knownAgents({ on }).catch(() => []);
      const f = focused();
      this.selectAgent(
        defaultAgent({
          known: this.known,
          agents: joinAgents(agents(), terminals(), panes()),
          focus: { tab: f?.tab, terminal: f?.terminal },
          preferred: shared("specseal.agent"),
        }),
        cx,
      );
      cx.notify();
      try {
        const read = (...verb) => specsealJson(verb, this.root, on);
        const [list, plan, discussions, config] = await Promise.all([
          read("list"),
          read("plan"),
          read("discuss", "list"),
          read("workflow-config", "show"),
        ]);
        this.board = buildBoard(list, plan, discussions, await codeRemaining(list, plan, this.root, on));
        this.worktreePolicy = config.worktree === true;
      } catch (e) {
        const message = String(e.message ?? e);
        this.uninitialized = isUninitialized(message);
        if (!this.uninitialized) this.error = message;
        // 还没有 Specseal 时，自己装的技能还是能用。
        if (this.uninitialized) this.page = "mine";
        this.focusKeys();
      }
      cx.notify();
    });
  }

  targets(skill = this.skill().skill) {
    return this.board ? skillTargets(skill, this.board) : [];
  }

  // 开新分页要用的数据。
  tabContext() {
    return {
      skill: this.skill().skill,
      note: "",
      root: this.root,
      agents: joinAgents(agents(), terminals(), panes()),
      known: this.known,
      preferred: this.agentKey,
      worktreePolicy: this.worktreePolicy,
      space: focused()?.space,
      on: this.on,
      board: this.board,
    };
  }

  // 这个变更为什么不能开新分页。可以开时是 null。
  blockedReason(target) {
    const plan = newTabPlan({ ...this.tabContext(), target });
    return plan.kind === "none" ? plan.reason : null;
  }

  // 画面上看得到的勾。从别的技能留下来、在这里不能开的不算，因为那一列没有框可以取消。
  ticked() {
    if (this.page === "mine" || !this.canTick()) return [];
    return this.targets().filter((t) => this.checked.has(t.name) && !this.blockedReason(t));
  }

  // 只勾一个就用它，没勾就用目前选的那一列。
  selection() {
    const ticked = this.ticked();
    return {
      target: ticked.length === 1 ? ticked[0] : this.targets().find((t) => t.name === this.target) ?? null,
      note: this.hasNote() ? this.note.value().trim() : "",
    };
  }

  // 这个项目没有这个 agent 用的 Specseal 技能时，指令送出去也没有用。还没读到时先当作有。
  missingSkills() {
    const found = this.mine.found();
    return found && !found.hasSpecseal ? missingSkillsPlan(this.agentName(), this.agentKey) : null;
  }

  tabPlan() {
    if (this.page === "mine") return this.mine.tabPlan();
    const missing = this.missingSkills();
    if (missing) return missing;
    const ticked = this.ticked();
    if (ticked.length > 1) return batchPlan({ ...this.tabContext(), targets: ticked });
    return newTabPlan({ ...this.tabContext(), ...this.selection() });
  }

  inputPlan() {
    if (this.page === "mine") return this.mine.inputPlan();
    const missing = this.missingSkills();
    if (missing) return missing;
    if (this.ticked().length > 1) return { kind: "none", reason: tr("输入框一次只能放一个。勾两个以上请开新分页") };
    const f = focused();
    return placePlan({
      skill: this.skill().skill,
      ...this.selection(),
      agentKey: this.agentKey,
      agents: joinAgents(agents(), terminals(), panes()),
      focus: { tab: f?.tab, terminal: f?.terminal },
    });
  }

  putInInput(cx) {
    this.submit(this.inputPlan(), cx);
  }

  startTabs(cx) {
    this.submit(this.tabPlan(), cx);
  }

  // 做完才关跳窗：关掉就收不到失败的消息了。
  submit(plan, cx) {
    if (this.sending || plan.kind === "none") return;
    this.sending = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      if (plan.kind === "place") await this.place(plan, cx);
      else await this.open(plan.plans ?? [plan], cx);
    });
  }

  fail(result, cx) {
    this.sending = false;
    this.error = sendError(result);
    cx.notify();
  }

  async place(plan, cx) {
    const failed = await placeInInput(plan);
    if (failed) return this.fail(failed, cx);
    closeOverlay(props().overlay);
  }

  async open(plans, cx) {
    const failed = await openTabs(plans, cx);
    if (failed) return this.fail(failed, cx);
    closeOverlay(props().overlay);
  }

  moveSkill(step) {
    const next = pickerStep(this.groups(), this.row().skill, step);
    if (next.open) this.groupChoices[next.open] = "all";
    this.rowName = next.skill;
    this.focusKeys();
  }

  moveVariant(step) {
    const row = this.row();
    const choices = PICKER_VARIANTS[row.skill];
    if (!choices) return;
    this.variants[row.skill] = ((this.variants[row.skill] ?? 0) + step + choices.length) % choices.length;
  }

  moveTarget(step) {
    const names = [null, ...this.targets().map((t) => t.name)];
    const at = Math.max(names.indexOf(this.target), 0);
    this.target = names[(at + step + names.length) % names.length];
  }

  toggleChecked(target) {
    if (this.blockedReason(target)) return;
    if (this.checked.has(target.name)) this.checked.delete(target.name);
    else this.checked.add(target.name);
  }

  checkAll() {
    const open = this.targets().filter((t) => !this.blockedReason(t));
    const all = open.every((t) => this.checked.has(t.name));
    for (const t of open) {
      if (all) this.checked.delete(t.name);
      else this.checked.add(t.name);
    }
  }

  chevron(open, t) {
    return svg(`mods/specseal/icons/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none().text_color(t.dim);
  }

  searchIcon(t) {
    return svg("mods/specseal/icons/search.svg").size(13).flex_none().text_color(t.dim);
  }

  skillList(t) {
    const current = this.row().skill;
    const rows = [];
    this.groups().forEach((g, i) => {
      rows.push(
        h_flex()
          .id(`group-${g.group}`)
          .flex_none()
          .h(20)
          .px(8)
          .mt(i > 0 ? 5 : 0)
          .gap(5)
          .items_center()
          .rounded(5)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => {
            this.groupChoices[g.group] = g.state === "closed" ? "all" : "closed";
            this.focusKeys();
            cx.notify();
          })
          .child(div().w(7).h(7).flex_none().rounded_full().bg(t[GROUP_TONE[g.group]]))
          .child(div().text_size(10.5).text_color(t.dim).child(tr(g.group)))
          .child(div().text_size(10.5).text_color(t.dim).child(String(g.items.length)))
          .child(div().flex_1())
          .child(this.chevron(g.state !== "closed", t)),
      );
      for (const w of g.rows) {
        const count = this.board && w.pair ? this.targets(w.skill).length : null;
        rows.push(
          h_flex()
            .id(`skill-${w.skill}`)
            .flex_none()
            .h(21)
            .px(8)
            .gap(6)
            .items_center()
            .rounded(5)
            .text_size(12)
            .cursor_pointer()
            // discuss、propose 没有讨论也能打字开工，只有搭配变更的技能才真的用不了。
            .when((count === 0 && w.pair === "变更") || onlyClaude(w.skill, this.agentKey), (el) => el.text_color(t.dim))
            .when(w.skill === current, (el) => el.bg(t.selected).font_medium())
            .when(w.skill !== current, (el) => el.hover((s) => s.bg(t.hover)))
            .on_click((_e, cx) => {
              this.rowName = w.skill;
              this.focusKeys();
              cx.notify();
            })
            .child(div().flex_1().min_w_0().truncate().child(w.skill))
            .when(count !== null, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(String(count)))),
        );
      }
    });
    return v_flex().id("skill-list").w(190).flex_none().h_full().p(6).gap(1).overflow_y_scrollbar().children(rows);
  }

  // 同一件事的不同做法。
  variantChips(t) {
    const row = this.row();
    const at = this.variants[row.skill] ?? 0;
    return h_flex()
      .flex_none()
      .mx(8)
      .mb(8)
      .gap(4)
      .children(
        PICKER_VARIANTS[row.skill].map((v, i) =>
          div()
            .id(`variant-${v.skill}`)
            .flex_none()
            .h(24)
            .px(9)
            .flex()
            .items_center()
            .rounded(6)
            .border_1()
            .border_color(i === at ? t.accent : t.border)
            .text_size(12)
            .cursor_pointer()
            .when(i === at, (el) => el.font_medium())
            .when(i !== at, (el) => el.hover((s) => s.bg(t.hover)))
            .on_click((_e, cx) => {
              this.variants[row.skill] = i;
              this.focusKeys();
              cx.notify();
            })
            .child(tr(v.label)),
        ),
      );
  }

  // 框有自己的点击：点框是勾选，点那一列是选它。
  tickBox(x, t) {
    const on = this.checked.has(x.name);
    return div()
      .id(`tick-${x.name}`)
      .size(TICK_SIZE)
      .flex()
      .flex_none()
      .items_center()
      .justify_center()
      .cursor_pointer()
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.toggleChecked(x);
        this.focusKeys();
        cx.notify();
      })
      .child(
        div()
          .size(14)
          .flex()
          .items_center()
          .justify_center()
          .rounded(3)
          .border_1()
          .border_color(on ? t.accent : t.border)
          .bg(on ? t.accent : t.background)
          .when(on, (el) => el.child(svg("mods/specseal/icons/check.svg").size(11).text_color(t.background))),
      );
  }

  targetRow({ id, name, side, topic, current, box, muted, click }, t) {
    return h_flex()
      .id(`target-${id}`)
      .flex_none()
      .px(8)
      .py(4)
      .gap(7)
      .rounded(5)
      .cursor_pointer()
      .when(current, (el) => el.bg(t.selected))
      .when(!current, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => {
        click();
        this.focusKeys();
        cx.notify();
      })
      .when(box !== undefined, (el) => el.child(box))
      .child(
        v_flex()
          .flex_1()
          .min_w_0()
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .child(div().flex_1().min_w_0().truncate().text_size(12).font_medium().text_color(muted ? t.dim : t.foreground).child(name))
              .when(Boolean(side), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(side))),
          )
          .when(Boolean(topic), (el) => el.child(div().truncate().text_size(11).text_color(t.muted).child(topic))),
      );
  }

  rowFor(x, selected, t) {
    const select = () => (this.target = x.name);
    if (x.kind === "discussion") {
      return this.targetRow({ id: x.name, name: x.name, topic: x.topic, current: selected === x.name, click: select }, t);
    }
    const progress = `${tr(STAGE_LABEL[x.row.stage])} ${x.row.completed}/${x.row.total}`;
    const reason = this.blockedReason(x);
    return this.targetRow(
      {
        id: x.name,
        name: x.name,
        side: reason ?? progress,
        current: selected === x.name,
        muted: Boolean(reason),
        box: reason ? div().size(TICK_SIZE).flex_none() : this.tickBox(x, t),
        click: select,
      },
      t,
    );
  }

  targetList(t) {
    const w = this.skill();
    const targets = this.targets();
    const tickable = this.canTick();
    const selected = targets.find((x) => x.name === this.target)?.name ?? null;
    const label = (text) => div().flex_none().mx(8).text_size(10.5).text_color(t.dim).child(text);
    return v_flex()
      .id("skill-targets")
      .flex_1()
      .min_w_0()
      .h_full()
      .p(6)
      .gap(2)
      .border_l_1()
      .border_color(t.border)
      .overflow_y_scrollbar()
      .child(div().flex_none().mx(8).mb(5).text_size(12).text_color(t.muted).child(tr(w.about)))
      .when(Boolean(PICKER_VARIANTS[this.row().skill]), (el) => el.child(this.variantChips(t)))
      .when(this.hasNote(), (el) =>
        el.child(label(tr(w.skill === "discuss" ? "主题" : "补充说明（可留空）"))).child(
          div()
            .flex_none()
            .mx(8)
            .mb(6)
            .child(
              Input.new(this.note)
                .w_full()
                .h(30)
                .px(8)
                .rounded(6)
                .border_1()
                .border_color(t.accent)
                .bg(t.background)
                .text_size(12)
                .text_color(t.foreground),
            ),
        ),
      )
      .when(!w.pair, (el) => el.child(label(tr("这个技能用在整个项目，不用搭配"))))
      .when(Boolean(w.pair) && targets.length === 0, (el) => el.child(label(tr(PAIR_EMPTY[w.pair]))))
      .when(targets.length > 0, (el) =>
        el
          .child(
            h_flex()
              .flex_none()
              .mr(8)
              .items_center()
              .child(div().flex_1().child(label(tr(PAIR_LABEL[w.pair]))))
              .when(tickable, (row) =>
                row.child(
                  div()
                    .id("check-all")
                    .text_size(11)
                    .text_color(t.muted)
                    .cursor_pointer()
                    .on_click((_e, cx) => {
                      this.checkAll();
                      this.focusKeys();
                      cx.notify();
                    })
                    .child(tr("全选 ⌘A")),
                ),
              ),
          )
          .child(
            this.targetRow(
              {
                id: "none",
                name: tr("不指定"),
                current: selected === null,
                box: tickable ? div().size(TICK_SIZE).flex_none() : undefined,
                click: () => (this.target = null),
              },
              t,
            ),
          )
          .children(targets.map((x) => this.rowFor(x, selected, t))),
      );
  }

  goButton({ id, label, ready, strong, tip, click }, t) {
    return div()
      .id(id)
      .flex_none()
      .px(10)
      .py(4)
      .rounded(6)
      .border_1()
      .border_color(ready && strong ? t.accent : t.border)
      .text_color(ready ? t.foreground : t.dim)
      .when(ready, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)))
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .on_click((_e, cx) => click(cx))
      .child(label);
  }

  hints() {
    if (this.page === "mine") return tr("↑↓ 移动　→ 补充说明　Tab 换页");
    const hints = [tr("↑↓ 技能"), tr("←→ 搭配")];
    if (this.canTick()) hints.push(tr("Space 勾选"));
    if (PICKER_VARIANTS[this.row().skill]) hints.push(tr("⇧←→ 做法"));
    return [...hints, tr("Tab 换页")].join("　");
  }

  footer(t) {
    const count = this.ticked().length;
    const many = count > 1;
    const tabs = this.tabPlan();
    const input = this.inputPlan();
    // 勾两个以上时只有开新分页能用，所以写它会开什么。
    const shown = many ? tabs : input;
    const message = this.sending ? tr("处理中…") : this.error ?? (shown.kind === "none" ? shown.reason : shown.text);
    return v_flex()
      .flex_none()
      .px(12)
      .py(8)
      .gap(7)
      .border_t_1()
      .border_color(t.border)
      .child(
        div()
          .truncate()
          .text_size(11.5)
          .text_color(this.error ? t.blocked : shown.kind === "none" ? t.muted : t.foreground)
          .child(message),
      )
      .child(
        h_flex()
          .gap(10)
          .items_center()
          .child(div().flex_1().min_w_0().truncate().text_size(11).text_color(t.dim).child(this.hints()))
          .child(
            this.goButton(
              {
                id: "skill-go-tab",
                label: many ? tr("开 {0} 个分页并开工 ⌘⏎", count) : tr("开新分页并开工 ⌘⏎"),
                ready: tabs.kind !== "none" && !this.sending,
                strong: many,
                tip: tabs.kind === "none" ? tabs.reason : tr("在目前的工作区开新分页并运行：{0}", tabs.text),
                click: (cx) => this.startTabs(cx),
              },
              t,
            ),
          )
          .child(
            this.goButton(
              {
                id: "skill-go",
                label: tr("放到输入框 ⏎"),
                ready: input.kind !== "none" && !this.sending,
                strong: !many,
                tip: input.kind === "none" ? input.reason : null,
                click: (cx) => this.putInInput(cx),
              },
              t,
            ),
          ),
      );
  }

  onKey(e, cx) {
    if (e.key === "escape") return closeOverlay(props().overlay);
    if (e.key === "tab") {
      this.showPage(this.page === "mine" ? "specseal" : "mine");
      cx.stop_propagation();
      cx.notify();
      return;
    }
    if (e.keystroke === "cmd-enter" && !(this.page === "specseal" && this.uninitialized)) return this.startTabs(cx);
    if (this.page === "mine") {
      if (!this.mine.onKey(e)) return;
      cx.stop_propagation();
      cx.notify();
      return;
    }
    if (this.uninitialized) return;
    // 有输入框时 Enter 由输入框的 submit 处理。
    if (e.key === "enter" && !this.hasNote()) return this.putInInput(cx);
    // 输入框有字时，左右键留给输入框移动光标。
    const typing = this.hasNote() && this.note.value();
    if (e.key === "down") this.moveSkill(1);
    else if (e.key === "up") this.moveSkill(-1);
    else if (e.keystroke === "shift-right") this.moveVariant(1);
    else if (e.keystroke === "shift-left") this.moveVariant(-1);
    else if (e.key === "right" && !typing) this.moveTarget(1);
    else if (e.key === "left" && !typing) this.moveTarget(-1);
    else if (e.key === "space" && this.canTick()) {
      const row = this.targets().find((x) => x.name === this.target);
      if (row) this.toggleChecked(row);
    } else if (e.keystroke === "cmd-a" && this.canTick()) this.checkAll();
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  // 页签和 agent 的选择钮长得一样。
  headerChip({ id, label, count, on, click }, t) {
    return h_flex()
      .id(id)
      .flex_none()
      .h(24)
      .px(9)
      .gap(5)
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .text_color(on ? t.foreground : t.muted)
      .when(on, (el) => el.bg(t.selected).font_medium())
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => click(cx))
      .child(label)
      .when(count !== undefined, (el) => el.child(div().text_size(11).text_color(t.dim).child(String(count))));
  }

  header(t) {
    const usable = usableAgents(this.known);
    const page = (id, label, count) =>
      this.headerChip(
        {
          id: `page-${id}`,
          label,
          count,
          on: this.page === id,
          click: (cx) => {
            this.showPage(id);
            cx.notify();
          },
        },
        t,
      );
    return h_flex()
      .flex_none()
      .h(36)
      .px(12)
      .gap(4)
      .items_center()
      .border_b_1()
      .border_color(t.border)
      .child(page("specseal", "Specseal"))
      .child(page("mine", tr("我的技能"), this.mine.found()?.skills.length))
      .child(div().flex_1())
      // 只有一个 agent 时没得选。
      .when(usable.length > 1, (el) =>
        el
          .child(div().flex_none().mr(2).text_size(11).text_color(t.dim).child(tr("给")))
          .children(
            usable.map((a) =>
              this.headerChip(
                {
                  id: `agent-${a.key}`,
                  label: a.name,
                  on: a.key === this.agentKey,
                  click: (cx) => {
                    this.selectAgent(a.key, cx);
                    setShared("specseal.agent", a.key);
                    this.focusKeys();
                    cx.notify();
                  },
                },
                t,
              ),
            ),
          )
          .child(div().w(8).flex_none()),
      )
      .child(div().flex_none().text_size(11).text_color(t.dim).child("Esc"));
  }

  specsealPage(t) {
    if (this.uninitialized) {
      return div().flex_1().p(12).text_color(t.muted).child(tr("这个项目还没有 Specseal。到面板按「初始化」后再用。"));
    }
    return h_flex().flex_1().min_h(0).items_start().child(this.skillList(t)).child(this.targetList(t));
  }

  render() {
    const t = theme();
    return v_flex()
      .id("skill-picker")
      .size_full()
      .track_focus(this.handle)
      .bg(t.popover)
      .text_size(12.5)
      .text_color(t.foreground)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .child(this.header(t))
      .child(this.page === "mine" ? this.mine.render(t) : this.specsealPage(t))
      .when(this.page === "mine" || !this.uninitialized, (el) => el.child(this.footer(t)));
  }
}
