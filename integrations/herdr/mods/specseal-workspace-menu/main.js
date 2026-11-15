import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { closeOverlay, props, run, theme } from "herdr";

export function menuItems(labels = []) {
  return [
    { label: labels[0] ?? "新建工作区", icon: "terminal", command: "space.new" },
    { label: labels[1] ?? "添加项目…", icon: "folder-plus", command: "specseal-spaces.add-project" },
  ];
}

export default class WorkspaceMenu extends View {
  init(_props, cx) {
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  choose(index) {
    const item = menuItems(props()?.labels)[index];
    if (!item) return;
    closeOverlay(props()?.overlay);
    run(item.command);
  }

  render() {
    const t = theme();
    const items = menuItems(props()?.labels);
    return v_flex().id("workspace-create-menu").w_full().p(4).bg(t.popover).text_size(12.5)
      .track_focus(this.handle)
      .on_key_down((event, cx) => {
        if (event.key === "escape") return closeOverlay(props()?.overlay);
        if (event.key === "enter") return this.choose(this.at);
        if (event.key === "down") this.at = (this.at + 1) % items.length;
        else if (event.key === "up") this.at = (this.at + items.length - 1) % items.length;
        else return;
        cx.notify();
      })
      .children(items.map((item, index) => h_flex().id(`workspace-create-${index}`).h(30).px(8).gap(8)
        .items_center().rounded(6).text_color(t.foreground).cursor_pointer()
        .when(index === this.at, el => el.bg(t.selected)).hover(el => el.bg(t.hover))
        .on_click(() => this.choose(index))
        .child(svg(`mods/workspace-chrome/${item.icon}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(item.label))));
  }
}
