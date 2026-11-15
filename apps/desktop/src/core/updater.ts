// 更新状态机（desktop-app spec「桌面自动更新」，design D6）：纯 reducer、不依赖
// Tauri。手动／自动检查的失败与已最新分流在此决定：自动一律静默回闲置，手动
// 才浮出「无法检查」与「已是最新」；签章验证等安装失败转错误态，永不进待重启。
export type UpdaterState =
  | { phase: "idle" }
  | { phase: "checking"; manual: boolean }
  | { phase: "available"; version: string }
  | { phase: "downloading"; version: string }
  | { phase: "restartPending"; version: string }
  | { phase: "upToDate" }
  | { phase: "checkFailed" }
  | { phase: "error"; message: string };

export type UpdaterEvent =
  | { type: "checkStarted"; manual: boolean }
  | { type: "updateFound"; version: string }
  | { type: "noUpdate" }
  | { type: "checkFailed" }
  | { type: "accepted" }
  | { type: "dismissed" }
  | { type: "downloaded" }
  | { type: "installFailed"; message: string };

export const initialUpdaterState: UpdaterState = { phase: "idle" };

/** 前景重检的节流间隔：主窗口回到前景时，距上次检查满此值才再查。 */
export const FOCUS_RECHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * 主窗口回到前景时是否该重检（desktop-app「回到前景未满一小时不重检」）：
 * 从未检查（null）视为逾时；否则距上次检查满 FOCUS_RECHECK_INTERVAL_MS 才重检。
 */
export function focusRecheckDue(lastCheckedAt: number | null, now: number): boolean {
  return lastCheckedAt === null || now - lastCheckedAt >= FOCUS_RECHECK_INTERVAL_MS;
}

/**
 * 目前状态是否容许前景重检（desktop-app「回到前景未满一小时不重检」）：只有
 * 没有东西等用户处置的状态才重检。待同意的提示（available）与安装失败的错误
 * （error）要留到用户处置，不能被自动重检清掉；检查中、下载中、待重启不重入。
 */
export function focusRecheckAllowed(state: UpdaterState): boolean {
  return state.phase === "idle" || state.phase === "upToDate" || state.phase === "checkFailed";
}

/**
 * 图标列更新钮与设置卡「下载与安装」列共用的呈现判断（desktop-app「桌面自动更新」）：待同意、
 * 下载中、待重启与失败要用户看到；闲置、检查中、已最新与检查失败不占画面。
 */
export function updateNeedsAttention(
  state: UpdaterState,
): state is Extract<UpdaterState, { phase: "available" | "downloading" | "restartPending" | "error" }> {
  return (
    state.phase === "available" ||
    state.phase === "downloading" ||
    state.phase === "restartPending" ||
    state.phase === "error"
  );
}

export function reduceUpdater(state: UpdaterState, event: UpdaterEvent): UpdaterState {
  switch (event.type) {
    case "checkStarted":
      // 下载中与待重启不可被重检打断；其余状态（含错误、已最新）都可再检查。
      if (state.phase === "downloading" || state.phase === "restartPending") return state;
      return { phase: "checking", manual: event.manual };
    case "updateFound":
      return state.phase === "checking" ? { phase: "available", version: event.version } : state;
    case "noUpdate":
      if (state.phase !== "checking") return state;
      return state.manual ? { phase: "upToDate" } : { phase: "idle" };
    case "checkFailed":
      if (state.phase !== "checking") return state;
      return state.manual ? { phase: "checkFailed" } : { phase: "idle" };
    case "accepted":
      return state.phase === "available"
        ? { phase: "downloading", version: state.version }
        : state;
    case "dismissed":
      // available＝稍后、error＝关闭错误提示、downloading＝取消（放弃本次同意；插件的下载仍在
      // 背景跑完，store 见同意已失效就不安装，其后的 downloaded／installFailed 在闲置态也被忽略）；皆回闲置。
      return state.phase === "available" || state.phase === "error" || state.phase === "downloading"
        ? { phase: "idle" }
        : state;
    case "downloaded":
      return state.phase === "downloading"
        ? { phase: "restartPending", version: state.version }
        : state;
    case "installFailed":
      return state.phase === "downloading" ? { phase: "error", message: event.message } : state;
  }
}
