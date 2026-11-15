// specseal 网址（desktop-app「以 specseal 网址打开详情页」）：外部程序以
// specseal://change/<name>?project=<path> 或 specseal://discussion/<slug>?project=<path>
// 叫桌面 app 打开详情页，以 specseal://roadmap?project=<path> 打开该项目的路线图，
// 以 specseal://project?project=<path> 切到该项目并显示看板。
// 解析与派送都在这里；Tauri 壳只注册插件。
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { toast } from "sonner";

import { appT } from "./i18n/runtime";
import { findChange, findDiscussion, uncancelableOverlayOpen, type AppState } from "./store";
import { openMainWindow } from "./tray";

export type SpecsealLinkKind = "change" | "discussion";
/** 不带名称的网址种类：开项目后切画面，没有找不到目标的情形。 */
type SpecsealViewKind = "roadmap" | "project";

/** 解析后的网址；名称与路径都已百分比解码，`project` 为项目文件夹的绝对路径。 */
export type SpecsealLink =
  | {
      kind: SpecsealLinkKind;
      /** 变更名称或讨论 slug。 */
      name: string;
      project: string;
    }
  | { kind: SpecsealViewKind; project: string };

export type ParsedSpecsealUrl =
  | { ok: true; link: SpecsealLink }
  | { ok: false; reason: "scheme" | "kind" | "name" | "project" };

const KINDS: readonly string[] = ["change", "discussion", "roadmap", "project"];
/** POSIX 以 / 开头；Windows 以磁盘代号加 :\ 或 :/ 开头。 */
const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/])/;

/** 严格解码：无效的百分比编码或解出控制字符时回 null。不用 URLSearchParams——
 * 它把无效编码静默换成替代字符、把 + 读成空白，路径会悄悄变成另一个。 */
function decodeStrict(raw: string): string | null {
  let text: string;
  try {
    text = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return /\p{Cc}/u.test(text) ? null : text;
}

export function parseSpecsealUrl(raw: string): ParsedSpecsealUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "scheme" };
  }
  if (url.protocol !== "specseal:") return { ok: false, reason: "scheme" };
  if (!KINDS.includes(url.host)) return { ok: false, reason: "kind" };
  const segment = url.pathname.replace(/^\//, "");
  if (url.host === "roadmap" || url.host === "project") {
    // 路线图与项目网址不带名称：path 只能为空或单一 /。
    if (segment !== "") return { ok: false, reason: "name" };
    const project = projectParam(url);
    return project === null ? { ok: false, reason: "project" } : { ok: true, link: { kind: url.host, project } };
  }
  const name = segment === "" || segment.includes("/") ? null : decodeStrict(segment);
  if (name === null) return { ok: false, reason: "name" };
  const project = projectParam(url);
  if (project === null) return { ok: false, reason: "project" };
  return { ok: true, link: { kind: url.host as SpecsealLinkKind, name, project } };
}

/** 网址的 project 参数：恰好一个（重复时有歧义，不挑一个用）、解码后为绝对路径；否则 null。 */
function projectParam(url: URL): string | null {
  const values = url.search
    .slice(1)
    .split("&")
    .filter((pair) => pair.startsWith("project="))
    .map((pair) => pair.slice("project=".length));
  const project = values.length === 1 ? decodeStrict(values[0]) : null;
  return project !== null && ABSOLUTE_PATH.test(project) ? project : null;
}

/** 派送所需的最小 store 接口（Zustand bound store 兼容——AppState 的结构子集）。 */
export interface DeepLinkStore {
  getState: () => Pick<
    AppState,
    | "changes"
    | "discussions"
    | "sessions"
    | "migrationRoot"
    | "pendingRemoteConflict"
    | "openProjectAt"
    | "openDetail"
    | "openDiscussion"
    | "setBoardView"
    | "openRoadmap"
    | "openBoard"
  >;
}

type DeepLinkState = ReturnType<DeepLinkStore["getState"]>;

/** 两种网址目标各自的查找、打开与「找不到」消息。 */
const TARGETS: Record<
  SpecsealLinkKind,
  { exists: (s: DeepLinkState, name: string) => boolean; open: (s: DeepLinkState, name: string) => void; notFound: string }
> = {
  change: {
    exists: (s, name) => findChange(s, name) !== undefined,
    open: (s, name) => s.openDetail(name),
    notFound: "deepLink.changeNotFound",
  },
  discussion: {
    exists: (s, slug) => findDiscussion(s, slug) !== undefined,
    open: (s, slug) => s.openDiscussion(slug),
    notFound: "deepLink.discussionNotFound",
  },
};

/** 不带名称的网址各自切到哪个画面。 */
const VIEWS: Record<SpecsealViewKind, (s: DeepLinkState) => void> = {
  roadmap: (s) => s.openRoadmap(),
  project: (s) => s.openBoard(),
};

/** 订阅启动网址与运行中的网址，ready（分页列还原完成）之后依到达顺序一次处理一个。
 * 回传卸载函数：解除订阅，尚未处理的网址也不再处理（StrictMode 会先卸载再重装一次）。 */
export function installDeepLinks(store: DeepLinkStore, ready: Promise<unknown>): () => void {
  let disposed = false;
  // 每个网址接在前一个之后；链头是就绪信号。单一网址失败不挡后面的。
  let queue: Promise<unknown> = ready.catch(() => {});
  const enqueue = (urls: string[] | null) => {
    for (const url of urls ?? []) {
      queue = queue.then(() => (disposed ? undefined : openLink(store, url))).catch(() => {});
    }
  };
  void getCurrent().then(enqueue, () => {});
  const unlisten = onOpenUrl(enqueue).catch(() => null);
  return () => {
    disposed = true;
    void unlisten.then((stop) => stop?.());
  };
}

/** 处理一个网址：先唤起主窗口（后续的确认框才在用户眼前），再开项目，加载完才开详情。
 * 只打开与查看，不调用任何写入动作。 */
async function openLink(store: DeepLinkStore, url: string): Promise<void> {
  // 唤起失败不吞掉网址：窗口也许已在前景，照常处理。
  await openMainWindow().catch(() => {});
  const parsed = parseSpecsealUrl(url);
  if (!parsed.ok) {
    toast.error(appT("deepLink.invalid"));
    return;
  }
  // 不可取消的浮层开着：不切项目、不开详情（与系统匣同语意）。
  if (uncancelableOverlayOpen(store.getState())) return;
  const { link } = parsed;
  // null＝现在不能拿这个项目的清单来用：确认框、选择器或错误已由打开项目流程接手，
  // 或加载失败、加载期间已切走。remote 标记一律走选择器，确认前零写入。
  const key = await store.getState().openProjectAt(link.project, { remoteViaChooser: true });
  if (key === null) return;
  const s = store.getState();
  if (!("name" in link)) {
    VIEWS[link.kind](s);
    return;
  }
  const { kind, name, project } = link;
  const target = TARGETS[kind];
  if (!target.exists(s, name)) {
    s.setBoardView("board");
    const projectName = s.sessions[key]?.descriptor.name ?? project;
    // 一次代入、以函数代入：名称来自外部网址，不得被当成占位符或 $& 取代样式。
    const message = appT(target.notFound).replace(/\{(project|name)\}/g, (_match, slot: string) =>
      slot === "project" ? projectName : name,
    );
    toast.error(message);
    return;
  }
  target.open(s, name);
}
