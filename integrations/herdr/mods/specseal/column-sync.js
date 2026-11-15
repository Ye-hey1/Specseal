// 右边那一栏每个 space 各自记住开或关，做法和内置的 Files／Changes 相同：切 space 就还原它的选择，
// 手动开关就记下来。没记过的 space 默认收起。
//
// 这件事不能放在那一栏的面板里：收起来后面板不会重画，Herdr 重开时停在收起的 space 面板还不会启动。
// 所以 dock-panel.mjs 在版面放一个不画东西的浮动区块，它一直活着，由它来做。
import { div } from "gpui-kit";
import { layout, run, spaces } from "herdr";

const COLUMN = "specseal";

const findNode = (node, id) =>
  node?.id === id ? node : (node?.children ?? []).map((c) => findNode(c, id)).find(Boolean);

export default class ColumnSync {
  init() {
    this.open = JSON.parse(localStorage.getItem("columnOpen") ?? "{}");
  }

  render() {
    this.sync();
    return div();
  }

  sync() {
    const space = spaces().find((s) => s.active);
    const column = findNode(layout(), COLUMN);
    if (!space || !column) return;
    const open = !column.hidden;
    if (space.id !== this.space) {
      this.space = space.id;
      const want = this.open[space.id] ?? false;
      if (want !== open) {
        this.pending = { want, until: Date.now() + 1000 };
        run(want ? "layout.show" : "layout.hide", { id: COLUMN });
        return;
      }
    }
    // 还原还没生效前，旧的开关状态不算用户的选择。
    if (this.pending) {
      if (this.pending.want !== open && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if ((this.open[space.id] ?? false) === open) return;
    this.open[space.id] = open;
    localStorage.setItem("columnOpen", JSON.stringify(this.open));
  }
}
