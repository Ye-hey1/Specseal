// specseal 网址（desktop-app「以 specseal 网址打开详情页」）：解析表逐列对照 spec 的
// 「网址解析」Example。
import { describe, it, expect, vi, beforeEach } from "vitest";

import defaultCapsRaw from "../../src-tauri/capabilities/default.json?raw";
import baseConfRaw from "../../src-tauri/tauri.conf.json?raw";
import { installDeepLinks, parseSpecsealUrl } from "../deepLink";
import { APP_MESSAGES } from "../i18n/messages";

describe("parseSpecsealUrl：合法网址", () => {
  it.each([
    {
      url: "specseal://change/add-search?project=%2FUsers%2Fdev%2Fspecseal",
      link: { kind: "change", name: "add-search", project: "/Users/dev/specseal" },
    },
    {
      url: "specseal://discussion/board-search-bar?project=C%3A%5Cwork%5Capp",
      link: { kind: "discussion", name: "board-search-bar", project: "C:\\work\\app" },
    },
    {
      url: "specseal://change/add-search?project=C%3A%2Fwork%2Fapp",
      link: { kind: "change", name: "add-search", project: "C:/work/app" },
    },
    // 路线图网址（desktop-roadmap）：path 为空或单一 /，不带名称。
    {
      url: "specseal://roadmap?project=%2FUsers%2Fdev%2Fspecseal",
      link: { kind: "roadmap", project: "/Users/dev/specseal" },
    },
    {
      url: "specseal://roadmap/?project=%2Fa",
      link: { kind: "roadmap", project: "/a" },
    },
    // 项目网址：只切项目并显示看板，path 为空或单一 /，不带名称。
    {
      url: "specseal://project?project=%2FUsers%2Fdev%2Fspecseal",
      link: { kind: "project", project: "/Users/dev/specseal" },
    },
    {
      url: "specseal://project/?project=%2Fa",
      link: { kind: "project", project: "/a" },
    },
  ])("$url", ({ url, link }) => {
    expect(parseSpecsealUrl(url)).toEqual({ ok: true, link });
  });
});

describe("parseSpecsealUrl：格式错误", () => {
  it.each([
    { url: "specseal://roadmap/waves?project=%2Fa", reason: "name" }, // 路线图不带名称
    { url: "specseal://project/board?project=%2Fa", reason: "name" }, // 项目网址不带名称
    { url: "specseal://project", reason: "project" }, // 缺 project
    { url: "specseal://spec/desktop-app?project=%2Fa", reason: "kind" }, // 未知种类
    { url: "specseal://change/a/b?project=%2Fa", reason: "name" }, // 名称多于一段
    { url: "specseal://change/?project=%2Fa", reason: "name" }, // 名称为空
    { url: "specseal://change/add-search", reason: "project" }, // 缺 project
    { url: "specseal://change/add-search?project=work%2Fapp", reason: "project" }, // 不是绝对路径
    { url: "https://change/add-search?project=%2Fa", reason: "scheme" }, // 不是 specseal 网址
  ])("$url → $reason", ({ url, reason }) => {
    expect(parseSpecsealUrl(url)).toEqual({ ok: false, reason });
  });
});

// sharp-edges 稽核（网址来自任何本机进程或网页，一律视为不可信）。
describe("parseSpecsealUrl：不可信网址", () => {
  it.each([
    { url: "specseal://change/%E0%A4?project=%2Fa", reason: "name" }, // 无效的百分比编码不得抛例外
    { url: "specseal://change/x?project=%2Fa%E0%A4", reason: "project" }, // 不得静默换成替代字符
    { url: "specseal://change/a%00b?project=%2Fa", reason: "name" }, // 控制字符
    { url: "specseal://change/x?project=%2Fa%0Ab", reason: "project" }, // 控制字符
    { url: "specseal://change/x?project=%2Fa&project=%2Fb", reason: "project" }, // 重复 project 有歧义，不挑一个
    // 判定：host 大小写不放宽——spec 只收 change／discussion，CHANGE 照未知种类出 toast，不会静默误开。
    { url: "specseal://CHANGE/x?project=%2Fa", reason: "kind" },
    // 判定：.. 不构成缺口——URL 解析先把它收成空名称；名称只拿来比对清单，从不当文档路径。
    { url: "specseal://change/..?project=%2Fa", reason: "name" },
    // 路线图网址的稽核（desktop-roadmap 任务 5.3）——五项都没有缺口：
    // 判定：host 大小写不放宽，与 CHANGE 同理——ROADMAP 照未知种类出 toast。
    { url: "specseal://ROADMAP?project=%2Fa", reason: "kind" },
    // 判定：path 为 // 时剩下的 / 算一段名称，照「路线图不带名称」挡下，不当成空 path。
    { url: "specseal://roadmap//?project=%2Fa", reason: "name" },
    // 判定：重复的 project 与其他种类同样有歧义，不挑一个用。
    { url: "specseal://roadmap?project=%2Fa&project=%2Fb", reason: "project" },
    // 判定：project 含控制字符走同一个严格解码，挡下。
    { url: "specseal://roadmap?project=%2Fa%0Ab", reason: "project" },
    // 项目网址的稽核：与路线图走同一条解析分支，五项都没有缺口。
    // 判定：重复的 project 有歧义，不挑一个用；不是绝对路径的 project 不开。
    { url: "specseal://project?project=%2Fa&project=%2Fb", reason: "project" },
    { url: "specseal://project?project=work%2Fapp", reason: "project" },
    // 判定：无效编码与控制字符走同一个严格解码，挡下。
    { url: "specseal://project?project=%2Fa%E0%A4", reason: "project" },
    { url: "specseal://project?project=%2Fa%0Ab", reason: "project" },
    // 判定：host 大小写不放宽——PROJECT 照未知种类出 toast。
    { url: "specseal://PROJECT?project=%2Fa", reason: "kind" },
  ])("$url → $reason", ({ url, reason }) => {
    expect(parseSpecsealUrl(url)).toEqual({ ok: false, reason });
  });

  // 判定：多余的 query 参数不构成缺口——只读 project，其他参数不影响开哪个项目，也不触发
  // 任何写入；与变更、讨论网址同一规则。
  it("路线图网址带多余的 query 参数时只读 project", () => {
    expect(parseSpecsealUrl("specseal://roadmap?view=waves&project=%2Fa&x=1")).toEqual({
      ok: true,
      link: { kind: "roadmap", project: "/a" },
    });
  });

  // + 照字面保留（RFC 3986 的 query 不是表单编码）：路径 /a+b 不得被读成 /a b。
  it("project 内的 + 不转成空白", () => {
    expect(parseSpecsealUrl("specseal://change/x?project=%2Fa+b")).toEqual({
      ok: true,
      link: { kind: "change", name: "x", project: "/a+b" },
    });
  });
});

// 派送（design「启动时的网址排队到分页还原之后」「项目一律走 openProjectAt，详情等加载后再开」）：
// 插件、sonner 与 tray.ts 的 openMainWindow 换成假模块，假 store 记下调用顺序。
const { plugin, toastError, openMainWindow } = vi.hoisted(() => ({
  plugin: {
    launch: null as string[] | null,
    emit: (_urls: string[]) => {},
    unlisten: (() => {}) as () => void,
  },
  toastError: vi.fn(),
  openMainWindow: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-deep-link", () => ({
  getCurrent: async () => plugin.launch,
  onOpenUrl: async (handler: (urls: string[]) => void) => {
    plugin.emit = handler;
    return () => plugin.unlisten();
  },
}));
vi.mock("sonner", () => ({ toast: { error: toastError } }));
vi.mock("../tray", () => ({ openMainWindow }));

const PROJECT = "/Users/dev/specseal";
const PROJECT_KEY = `local:${PROJECT}`;
const CHANGE_URL = "specseal://change/add-search?project=%2FUsers%2Fdev%2Fspecseal";
const DISCUSSION_URL = "specseal://discussion/board-search-bar?project=%2FUsers%2Fdev%2Fspecseal";
const ROADMAP_URL = "specseal://roadmap?project=%2FUsers%2Fdev%2Fspecseal";
const PROJECT_URL = "specseal://project?project=%2FUsers%2Fdev%2Fspecseal";

const flush = () => new Promise((r) => setTimeout(r, 0));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let log: string[] = [];
beforeEach(() => {
  log = [];
  plugin.launch = null;
  plugin.emit = () => {};
  plugin.unlisten = vi.fn();
  openMainWindow.mockReset().mockImplementation(async () => {
    log.push("openMainWindow");
  });
  toastError.mockReset().mockImplementation((message: string) => log.push(`toast:${message}`));
});

function harness(
  over: {
    ready?: Promise<void>;
    launch?: string[];
    openKey?: string | null;
    projectName?: string;
    migrationRoot?: string | null;
  } = {},
) {
  plugin.launch = over.launch ?? null;
  const state = {
    changes: [{ name: "add-search" }],
    discussions: { active: [{ slug: "board-search-bar" }], archived: [] },
    sessions: { [PROJECT_KEY]: { descriptor: { name: over.projectName ?? "specseal" } } },
    migrationRoot: over.migrationRoot ?? null,
    pendingRemoteConflict: null,
    openProjectAt: vi.fn(async (path: string, _options?: { remoteViaChooser?: boolean }) => {
      log.push(`openProjectAt:${path}`);
      return over.openKey === undefined ? PROJECT_KEY : over.openKey;
    }),
    openDetail: vi.fn((name: string) => log.push(`openDetail:${name}`)),
    openDiscussion: vi.fn((slug: string) => log.push(`openDiscussion:${slug}`)),
    setBoardView: vi.fn((view: string) => log.push(`setBoardView:${view}`)),
    openRoadmap: vi.fn(() => log.push("openRoadmap")),
    openBoard: vi.fn(() => log.push("openBoard")),
  };
  const dispose = installDeepLinks({ getState: () => state as never }, over.ready ?? Promise.resolve());
  return { state, dispose, emit: (urls: string[]) => plugin.emit(urls) };
}

describe("installDeepLinks", () => {
  it("(a) 就绪前的启动网址与事件网址都排队，就绪后依到达顺序逐一处理", async () => {
    const ready = deferred<void>();
    const h = harness({ ready: ready.promise, launch: [CHANGE_URL] });
    await flush();
    h.emit([DISCUSSION_URL]);
    await flush();
    expect(log).toEqual([]);

    // 第一个网址的开项目卡住时，第二个网址不得开始。
    const slow = deferred<string | null>();
    h.state.openProjectAt.mockImplementationOnce(async (path: string) => {
      log.push(`openProjectAt:${path}`);
      return slow.promise;
    });
    ready.resolve();
    await flush();
    expect(log).toEqual(["openMainWindow", `openProjectAt:${PROJECT}`]);

    slow.resolve(PROJECT_KEY);
    await flush();
    expect(log).toEqual([
      "openMainWindow",
      `openProjectAt:${PROJECT}`,
      "openDetail:add-search",
      "openMainWindow",
      `openProjectAt:${PROJECT}`,
      "openDiscussion:board-search-bar",
    ]);
  });

  it("(b) 变更网址依序唤起主窗口、开项目（remote 标记改走选择器）、开变更详情", async () => {
    const h = harness({ launch: [CHANGE_URL] });
    await flush();
    expect(log).toEqual(["openMainWindow", `openProjectAt:${PROJECT}`, "openDetail:add-search"]);
    expect(h.state.openProjectAt).toHaveBeenCalledWith(PROJECT, { remoteViaChooser: true });
    expect(toastError).not.toHaveBeenCalled();
  });

  it("(c) 讨论网址开讨论详情", async () => {
    const h = harness();
    await flush();
    h.emit([DISCUSSION_URL]);
    await flush();
    expect(log).toEqual(["openMainWindow", `openProjectAt:${PROJECT}`, "openDiscussion:board-search-bar"]);
  });

  it("(d) openProjectAt 回传 null（对话框或选择器接手）时不开详情、不出 toast", async () => {
    harness({ launch: [CHANGE_URL], openKey: null });
    await flush();
    expect(log).toEqual(["openMainWindow", `openProjectAt:${PROJECT}`]);
  });

  it.each([
    ["变更", "specseal://change/no-such-change?project=%2FUsers%2Fdev%2Fspecseal", "deepLink.changeNotFound", "no-such-change"],
    ["讨论", "specseal://discussion/no-such-topic?project=%2FUsers%2Fdev%2Fspecseal", "deepLink.discussionNotFound", "no-such-topic"],
  ])("(e) 找不到%s：主区切回看板（关掉详情页），toast 含项目名称与目标名称", async (_label, url, key, target) => {
    const h = harness({ launch: [url] });
    await flush();
    const message = APP_MESSAGES["zh-CN"][key].replace("{project}", "specseal").replace("{name}", target);
    expect(log).toEqual(["openMainWindow", `openProjectAt:${PROJECT}`, "setBoardView:board", `toast:${message}`]);
    expect(h.state.openDetail).not.toHaveBeenCalled();
    expect(h.state.openDiscussion).not.toHaveBeenCalled();
  });

  it("(e2) 项目名称含 {name} 字样时照原字显示，不被当成占位符", async () => {
    harness({ launch: ["specseal://change/x?project=%2FUsers%2Fdev%2Fspecseal"], projectName: "a{name}b" });
    await flush();
    expect(toastError).toHaveBeenCalledWith("在 a{name}b 找不到变更 x");
  });

  it("(f) 格式错误：只唤起主窗口并出 toast，不开项目", async () => {
    const h = harness({ launch: ["specseal://spec/desktop-app?project=%2FUsers%2Fdev%2Fspecseal"] });
    await flush();
    expect(log).toEqual(["openMainWindow", `toast:${APP_MESSAGES["zh-CN"]["deepLink.invalid"]}`]);
    expect(h.state.openProjectAt).not.toHaveBeenCalled();
  });

  it("(g) 卸载函数解除 onOpenUrl 订阅，之后排队的网址也不再处理", async () => {
    const ready = deferred<void>();
    const h = harness({ ready: ready.promise, launch: [CHANGE_URL] });
    await flush();
    h.dispose();
    await flush();
    expect(plugin.unlisten).toHaveBeenCalledTimes(1);
    ready.resolve();
    await flush();
    expect(log).toEqual([]);
  });

  it("(h) 不可取消的浮层开着：唤起主窗口，但不切项目、不开详情、不出 toast", async () => {
    const h = harness({ launch: [CHANGE_URL], migrationRoot: "/Users/dev/legacy" });
    await flush();
    expect(log).toEqual(["openMainWindow"]);
    expect(h.state.openProjectAt).not.toHaveBeenCalled();
  });

  // 不带名称的网址：开项目后切画面（store 测试验 openRoadmap、openBoard 本身）；没有找不到目标
  // 的情形，不出 toast。
  describe.each([
    { label: "路线图网址", url: ROADMAP_URL, open: "openRoadmap", other: "openBoard" },
    { label: "项目网址", url: PROJECT_URL, open: "openBoard", other: "openRoadmap" },
  ] as const)("$label", ({ url, open, other }) => {
    it("依序唤起主窗口、开项目、切画面，不出 toast", async () => {
      const h = harness({ launch: [url] });
      await flush();
      expect(log).toEqual(["openMainWindow", `openProjectAt:${PROJECT}`, open]);
      expect(h.state.openProjectAt).toHaveBeenCalledWith(PROJECT, { remoteViaChooser: true });
      expect(h.state.openDetail).not.toHaveBeenCalled();
      expect(h.state[other]).not.toHaveBeenCalled();
      expect(toastError).not.toHaveBeenCalled();
    });

    it("openProjectAt 回传 null 时不切画面、不出 toast", async () => {
      harness({ launch: [url], openKey: null });
      await flush();
      expect(log).toEqual(["openMainWindow", `openProjectAt:${PROJECT}`]);
    });

    it("遇到不可取消的浮层：只唤起主窗口", async () => {
      const h = harness({ launch: [url], migrationRoot: "/Users/dev/legacy" });
      await flush();
      expect(log).toEqual(["openMainWindow"]);
      expect(h.state.openProjectAt).not.toHaveBeenCalled();
    });
  });

  it("(i) 唤起主窗口失败时照常处理网址", async () => {
    openMainWindow.mockRejectedValueOnce(new Error("window gone"));
    harness({ launch: [CHANGE_URL] });
    await flush();
    expect(log).toEqual([`openProjectAt:${PROJECT}`, "openDetail:add-search"]);
  });
});

// 网址格式的注册与权限（design「网址格式的注册与权限」）：bundler 依 tauri.conf.json 写进
// Info.plist／NSIS 登录；主窗口要有插件缺省权限才能调用 getCurrent、onOpenUrl。
describe("deep-link 插件设置", () => {
  it("tauri.conf.json 的 desktop schemes 含 specseal", () => {
    const conf = JSON.parse(baseConfRaw);
    expect(conf.plugins["deep-link"].desktop.schemes).toContain("specseal");
  });

  it("主窗口的 capabilities 含 deep-link 缺省权限", () => {
    const caps = JSON.parse(defaultCapsRaw);
    expect(caps.windows).toContain("main");
    expect(caps.permissions).toContain("deep-link:default");
  });
});
