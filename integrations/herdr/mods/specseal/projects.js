// 项目选择由常驻工作区组件处理，弹出菜单关闭后仍能等待系统文件夹选择器。
import { nextCommand, notify, panes, pickFolder, run, spaces } from "herdr";
import { tr } from "./i18n.js";

export function projectAction(folder, allSpaces, allPanes) {
  const existing = allSpaces.find((space) => {
    if (space.machine) return false;
    const tabs = new Set((space.tabs ?? []).map((tab) => tab.id));
    const cwd = allPanes.find((pane) => tabs.has(pane.tab) && pane.cwd)?.cwd;
    return space.folder === folder || cwd === folder;
  });
  return existing
    ? { command: "space.select", args: { id: existing.id } }
    : { command: "space.new", args: { name: folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || folder, folder, machine: "" } };
}

export function addProject(view, cx) {
  if (view.addingProject) return;
  view.addingProject = true;
  cx.spawn(async (cx) => {
    try {
      const folder = await pickFolder({ prompt: tr("Add project") });
      if (!folder) return;
      const action = projectAction(folder, spaces(), panes());
      run(action.command, action.args);
    } catch (error) {
      notify({ title: tr("Unable to add project"), body: String(error?.message ?? error), level: "error" });
    } finally {
      view.addingProject = false;
      cx.notify();
    }
  });
}

export function watchProjectCommands(view, cx) {
  view.addingProject = false;
  cx.spawn(async (cx) => {
    for (;;) {
      const command = await nextCommand();
      if (command === "add-project") addProject(view, cx);
    }
  });
}
