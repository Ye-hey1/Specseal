// 面板讨论卡底「已转出」收合列的展开记忆（tray-panel-restyle design D4）：app 本机
// （localStorage）、值为 "true"／"false"。与看板的 specseal.board.promotedExpanded 刻意
// 分键——两个窗口、两个把手，面板的点按不改看板的收合状态。

export const TRAY_PROMOTED_EXPANDED_STORAGE_KEY = "specseal.tray.promotedExpanded";

/** 键缺席、坏值或 localStorage 不可用一律视为收合（false），不抛错。 */
export function readTrayPromotedExpanded(): boolean {
  try {
    return localStorage.getItem(TRAY_PROMOTED_EXPANDED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/** 写入失败静默——记不住只是下次打开回到收合。 */
export function writeTrayPromotedExpanded(expanded: boolean): void {
  try {
    localStorage.setItem(TRAY_PROMOTED_EXPANDED_STORAGE_KEY, String(expanded));
  } catch {
    // localStorage 不可用：不记忆。
  }
}
