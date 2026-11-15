// 技能档提示卡与确认框（desktop-app spec「指令档过期提示」；desktop-notice-relocation
// design D1）：卡在项目栏底部、三态文案带文档数、整张可点开框；框内三列信息、按钮依
// 状态（过期／缺失：稍后、保留现状、更新／安装；较新：保留现状、更新 Specseal）；更新
// 失败的错误留在内容卡下方可重试。原 assetUpdatePrompt.test.tsx 的案例逐条搬到这里。
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render as rtlRender, screen, within } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { I18nProvider, SEMANTIC_TONE } from "@specseal/ui";

import type { AssetPromptState } from "../assetPrompt";
import { AssetNoticeCard } from "../components/AssetNoticeCard";
import { AssetNoticeDialog, type AssetNoticeDialogProps } from "../components/AssetNoticeDialog";
import { APP_MESSAGES } from "../i18n/messages";

const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN" messages={APP_MESSAGES}>
    {children}
  </I18nProvider>
);

function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: zhWrapper });
}

const NONE = { state: "none" } as const;
const STALE: AssetPromptState = { kind: "stale", fileCount: 3, version: "v1.3.0", projectVersion: "v0.9.0", migration: NONE };
const MISSING: AssetPromptState = { kind: "missing", fileCount: 12, version: "v1.3.0", projectVersion: null, migration: NONE };
const NEWER: AssetPromptState = { kind: "newer", fileCount: 2, version: "v1.3.0", projectVersion: "v1.4.0", migration: NONE };

// remote 项目：基准是 Server 提供的技能（version＝Server 的版本）。
const REMOTE_STALE: AssetPromptState = {
  kind: "stale",
  fileCount: 1,
  version: "v1.58.0",
  projectVersion: "v1.56.0",
  migration: NONE,
  server: { appVersion: "v1.57.0", appOlder: false },
};
const REMOTE_MISSING: AssetPromptState = { ...REMOTE_STALE, kind: "missing", fileCount: 19, projectVersion: null };
const REMOTE_OLD_APP: AssetPromptState = { ...REMOTE_STALE, server: { appVersion: "v1.57.0", appOlder: true } };

const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("AssetNoticeCard", () => {
  it.each([
    ["过期", STALE, "技能档是旧版", "更新会改写 3 个文档"],
    ["缺失", MISSING, "还没安装技能档", "安装会新建 12 个文档"],
    ["较新", NEWER, "技能档比 Specseal 新", "更新 Specseal 才能安全改写"],
  ])("%s态：一句标题、一句说明（代入文档数）", (_label, prompt, title, desc) => {
    render(<AssetNoticeCard prompt={prompt} onOpen={vi.fn()} />);
    const card = screen.getByTestId("asset-notice-card");
    expect(card.getAttribute("aria-label")).toBe(title);
    expect(card.textContent).toContain(title);
    expect(card.textContent).toContain(desc);
  });

  it("整张可点：调用 onOpen；琥珀淡底、琥珀图标、非 dialog 语意", () => {
    const onOpen = vi.fn();
    render(<AssetNoticeCard prompt={STALE} onOpen={onOpen} />);
    const card = screen.getByRole("button", { name: "技能档是旧版" });
    fireEvent.click(card);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(card.className).toContain("bg-status-warning/10");
    expect(card.className).toContain("border-status-warning/40");
    expect(card.querySelector("svg")?.getAttribute("class")).toContain(SEMANTIC_TONE.warning);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("remote 项目的过期态：说的是和 Server 不同，不说旧版", () => {
    render(<AssetNoticeCard prompt={REMOTE_STALE} onOpen={vi.fn()} />);
    const card = screen.getByTestId("asset-notice-card");
    expect(card.getAttribute("aria-label")).toBe("技能档和 Server 的不同");
    expect(card.textContent).toContain("更新会改写 1 个文档");
    expect(card.textContent).not.toContain("旧版");
  });

  it("remote 项目的缺失态：和本机项目同一句", () => {
    render(<AssetNoticeCard prompt={REMOTE_MISSING} onOpen={vi.fn()} />);
    expect(screen.getByTestId("asset-notice-card").textContent).toContain("还没安装技能档");
  });

  it("无提示时不渲染任何内容", () => {
    render(<AssetNoticeCard prompt={null} onOpen={vi.fn()} />);
    expect(screen.queryByTestId("asset-notice-card")).toBeNull();
  });
});

function dialogProps(over: Partial<AssetNoticeDialogProps> = {}): AssetNoticeDialogProps {
  return {
    open: true,
    onOpenChange: vi.fn(),
    prompt: STALE,
    busy: false,
    error: null,
    onApply: vi.fn(),
    onDismiss: vi.fn(),
    onOpenSettingsUpdate: vi.fn(),
    migrated: null,
    onDone: vi.fn(),
    ...over,
  };
}

const rowValues = () =>
  within(screen.getByTestId("asset-notice-rows"))
    .getAllByTestId("asset-notice-value")
    .map((el) => el.textContent);

describe("AssetNoticeDialog", () => {
  it("框内三列：这个项目的技能档版本、你的 Specseal 版本、会改写的文档数——前两列同一套技能档版号", () => {
    render(<AssetNoticeDialog {...dialogProps()} />);
    const rows = screen.getByTestId("asset-notice-rows");
    for (const label of ["这个项目的技能档版本", "你的 Specseal 版本", "会改写的文档数"]) {
      expect(rows.textContent).toContain(label);
    }
    // 第二列是 Specseal 这版带的技能档版号（探测的 currentVersion），不是 app 发版号：两列比得出新旧。
    expect(rowValues()).toEqual(["v0.9.0", "v1.3.0", "3"]);
  });

  it("从未安装：项目技能档版本显示「—」", () => {
    render(<AssetNoticeDialog {...dialogProps({ prompt: MISSING })} />);
    expect(rowValues()).toEqual(["—", "v1.3.0", "12"]);
  });

  it("较新态：第三列改为会被换回旧内容的文档数", () => {
    render(<AssetNoticeDialog {...dialogProps({ prompt: NEWER })} />);
    const rows = screen.getByTestId("asset-notice-rows");
    expect(rows.textContent).toContain("会被换回旧内容的文档数");
    expect(rows.textContent).not.toContain("会改写的文档数");
    expect(rowValues()).toEqual(["v1.4.0", "v1.3.0", "2"]);
  });

  it.each([
    ["过期", STALE, ["稍后", "保留现状", "更新技能档"]],
    ["缺失", MISSING, ["稍后", "保留现状", "安装技能档"]],
    ["较新", NEWER, ["保留现状", "更新 Specseal"]],
  ])("%s态的按钮依序", (_label, prompt, labels) => {
    render(<AssetNoticeDialog {...dialogProps({ prompt })} />);
    const footer = screen.getByTestId("asset-notice-actions");
    expect(within(footer).getAllByRole("button").map((b) => b.textContent)).toEqual(labels);
  });

  it("较新态：标题与说明以「app 本体是旧版」语意呈现，无任何改写动作", () => {
    render(<AssetNoticeDialog {...dialogProps({ prompt: NEWER })} />);
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("比你的 Specseal 新");
    expect(dialog.textContent).toContain("你的 Specseal 是旧版");
    expect(dialog.querySelector("svg")?.getAttribute("class")).toContain(SEMANTIC_TONE.warning);
    expect(screen.queryByRole("button", { name: "更新技能档" })).toBeNull();
    expect(screen.queryByRole("button", { name: "安装技能档" })).toBeNull();
  });

  it("「稍后」只关框：调用 onOpenChange(false)，不 dismiss、不 apply", () => {
    const p = dialogProps();
    render(<AssetNoticeDialog {...p} />);
    fireEvent.click(button("稍后"));
    expect(p.onOpenChange).toHaveBeenCalledWith(false);
    expect(p.onDismiss).not.toHaveBeenCalled();
    expect(p.onApply).not.toHaveBeenCalled();
  });

  it("「保留现状」调用 onDismiss 并关框，不触发再生", () => {
    const p = dialogProps();
    render(<AssetNoticeDialog {...p} />);
    fireEvent.click(button("保留现状"));
    expect(p.onDismiss).toHaveBeenCalledTimes(1);
    expect(p.onOpenChange).toHaveBeenLastCalledWith(false);
    expect(p.onApply).not.toHaveBeenCalled();
  });

  it("「更新技能档」调用 onApply；框不自行关闭（成功由提示消失收合、失败留在框内）", () => {
    const p = dialogProps();
    render(<AssetNoticeDialog {...p} />);
    fireEvent.click(button("更新技能档"));
    expect(p.onApply).toHaveBeenCalledTimes(1);
    expect(p.onOpenChange).not.toHaveBeenCalled();
    expect(p.onDismiss).not.toHaveBeenCalled();
  });

  it("缺失态「安装技能档」同样走 onApply（从未安装的项目不以更新称之）", () => {
    const p = dialogProps({ prompt: MISSING });
    render(<AssetNoticeDialog {...p} />);
    expect(screen.queryByRole("button", { name: "更新技能档" })).toBeNull();
    fireEvent.click(button("安装技能档"));
    expect(p.onApply).toHaveBeenCalledTimes(1);
  });

  it("较新态「更新 Specseal」调用 onOpenSettingsUpdate 并关框，不触发再生", () => {
    const p = dialogProps({ prompt: NEWER });
    render(<AssetNoticeDialog {...p} />);
    fireEvent.click(button("更新 Specseal"));
    expect(p.onOpenSettingsUpdate).toHaveBeenCalledTimes(1);
    expect(p.onOpenChange).toHaveBeenLastCalledWith(false);
    expect(p.onApply).not.toHaveBeenCalled();
    expect(p.onDismiss).not.toHaveBeenCalled();
  });

  it("busy：全部动作键 disabled，避免重复触发", () => {
    const p = dialogProps({ busy: true });
    render(<AssetNoticeDialog {...p} />);
    for (const name of ["稍后", "保留现状", "更新技能档"]) expect(button(name).disabled).toBe(true);
    fireEvent.click(button("更新技能档"));
    expect(p.onApply).not.toHaveBeenCalled();
  });

  it("error：错误显示于内容卡下方、红字；主动作仍可重试", () => {
    const p = dialogProps({ error: "CLAUDE.md: permission denied" });
    render(<AssetNoticeDialog {...p} />);
    const rows = screen.getByTestId("asset-notice-rows");
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("permission denied");
    expect(alert.className).toContain("destructive");
    expect(rows.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const actions = screen.getByTestId("asset-notice-actions");
    expect(alert.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(button("更新技能档"));
    expect(p.onApply).toHaveBeenCalledTimes(1);
  });

  it("无提示时不渲染框", () => {
    render(<AssetNoticeDialog {...dialogProps({ prompt: null })} />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

// spec「指令档过期提示」的 remote 情境：确认框多一列「Server 提供的技能版本」；app 比 Server
// 旧时多一句说明与「更新 Specseal」，安装或更新仍然可用。
describe("AssetNoticeDialog：remote 项目", () => {
  it("四列：项目的技能档版本、Server 提供的技能版本、你的 Specseal 版本、会改写的文档数", () => {
    render(<AssetNoticeDialog {...dialogProps({ prompt: REMOTE_STALE })} />);
    const rows = screen.getByTestId("asset-notice-rows");
    const labels = ["这个项目的技能档版本", "Server 提供的技能版本", "你的 Specseal 版本", "会改写的文档数"];
    for (const label of labels) expect(rows.textContent).toContain(label);
    expect(rowValues()).toEqual(["v1.56.0", "v1.58.0", "v1.57.0", "1"]);
  });

  it("本机项目没有「Server 提供的技能版本」一列", () => {
    render(<AssetNoticeDialog {...dialogProps()} />);
    expect(screen.getByTestId("asset-notice-rows").textContent).not.toContain("Server 提供的技能版本");
  });

  it("标题与说明讲的是 Server 提供的内容，不讲「你的 Specseal 这一版」", () => {
    render(<AssetNoticeDialog {...dialogProps({ prompt: REMOTE_STALE })} />);
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("这个项目的技能档和 Server 提供的不同");
    expect(dialog.textContent).toContain("换成 Server 提供的内容");
    expect(dialog.textContent).not.toContain("你的 Specseal 这一版");
  });

  it.each([
    ["和 Server 不同", REMOTE_STALE, ["稍后", "保留现状", "更新技能档"]],
    ["没有技能档", REMOTE_MISSING, ["稍后", "保留现状", "安装技能档"]],
    ["app 比 Server 旧", REMOTE_OLD_APP, ["稍后", "保留现状", "更新 Specseal", "更新技能档"]],
  ])("%s的按钮依序", (_label, prompt, labels) => {
    render(<AssetNoticeDialog {...dialogProps({ prompt })} />);
    const footer = screen.getByTestId("asset-notice-actions");
    expect(within(footer).getAllByRole("button").map((b) => b.textContent)).toEqual(labels);
  });

  it("没有技能档：项目版本显示「—」，说明讲安装 Server 提供的技能档", () => {
    render(<AssetNoticeDialog {...dialogProps({ prompt: REMOTE_MISSING })} />);
    expect(rowValues()).toEqual(["—", "v1.58.0", "v1.57.0", "19"]);
    expect(screen.getByRole("alertdialog").textContent).toContain("Server 提供的技能档");
  });

  it("app 比 Server 旧：多一句说明；「更新 Specseal」开设置的更新页，「更新技能档」照常可用", () => {
    const p = dialogProps({ prompt: REMOTE_OLD_APP });
    render(<AssetNoticeDialog {...p} />);
    expect(screen.getByTestId("asset-notice-app-older").textContent).toContain("你的 Specseal 比这台 Server 旧");
    fireEvent.click(button("更新 Specseal"));
    expect(p.onOpenSettingsUpdate).toHaveBeenCalledTimes(1);
    expect(p.onOpenChange).toHaveBeenLastCalledWith(false);
    expect(p.onApply).not.toHaveBeenCalled();
    fireEvent.click(button("更新技能档"));
    expect(p.onApply).toHaveBeenCalledTimes(1);
  });

  it("app 不比 Server 旧：没有那句说明，也没有「更新 Specseal」", () => {
    render(<AssetNoticeDialog {...dialogProps({ prompt: REMOTE_STALE })} />);
    expect(screen.queryByTestId("asset-notice-app-older")).toBeNull();
    expect(screen.queryByRole("button", { name: "更新 Specseal" })).toBeNull();
  });

  it("英文接口也有这一列与这句说明", () => {
    rtlRender(
      <I18nProvider locale="en" messages={APP_MESSAGES}>
        <AssetNoticeDialog {...dialogProps({ prompt: REMOTE_OLD_APP })} />
      </I18nProvider>,
    );
    expect(screen.getByTestId("asset-notice-rows").textContent).toContain("Skill version the server provides");
    expect(screen.getByTestId("asset-notice-app-older").textContent).toContain("older than this server");
  });
});

// --- 技能档提示承载规格文档夹迁移（desktop-app spec「技能档提示承载规格文档夹迁移」；
// desktop-spec-dir-migration design D2） ---

const PENDING = { state: "pending", folder: "openspec", metaFiles: 4 } as const;
const DEFERRED = {
  state: "deferred",
  folder: "openspec",
  reason: "otherWorktrees",
  worktrees: ["/work/side"],
} as const;
const MIGRATE: AssetPromptState = {
  kind: "migrate",
  fileCount: 0,
  version: "v1.3.0",
  projectVersion: "v1.3.0",
  migration: PENDING,
};

describe("AssetNoticeCard：规格文档夹迁移", () => {
  it("技能档不过期但待迁移：卡片照样出现，写明文档夹会改名", () => {
    render(<AssetNoticeCard prompt={MIGRATE} onOpen={vi.fn()} />);
    const card = screen.getByTestId("asset-notice-card");
    expect(card.getAttribute("aria-label")).toBe("规格文档夹要改名");
    expect(card.textContent).toContain("openspec/ 会改名为 specseal/");
  });

  it("只剩旧文档名的数据档：卡片写文档数", () => {
    render(
      <AssetNoticeCard
        prompt={{ ...MIGRATE, migration: { state: "pending", folder: "specseal", metaFiles: 2 } }}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByTestId("asset-notice-card").textContent).toContain("2 个变更数据档要改名");
  });

});

describe("AssetNoticeDialog：规格文档夹迁移", () => {
  const migration = () => screen.getByTestId("asset-notice-migration").textContent ?? "";

  it("待迁移：按下前写明 openspec/ 会改名为 specseal/、数据档数与不会 commit", () => {
    render(<AssetNoticeDialog {...dialogProps({ prompt: { ...STALE, migration: PENDING } })} />);
    expect(migration()).toContain("openspec/ 会改名为 specseal/");
    expect(migration()).toContain("4 个变更数据档会从 .openspec.yaml 改名为 .meta.yaml");
    expect(migration()).toContain("不会帮你 commit");
  });

  it("暂缓：列出原因与 worktree 路径，说明按更新只更新技能档", () => {
    render(<AssetNoticeDialog {...dialogProps({ prompt: { ...STALE, migration: DEFERRED } })} />);
    expect(migration()).toContain("/work/side");
    expect(migration()).toContain("只更新技能档，文档夹不动");
    expect(migration()).not.toContain("会改名为 specseal/");
  });

  it.each([
    ["linkedWorktree", "请在主目录打开这个项目"],
    ["uncommitted", "openspec/ 有还没 commit 的修改"],
    ["symlinkedFolder", "符号链接"],
    ["specFolderTaken", "已被其他文档或文档夹使用"],
  ] as const)("暂缓原因 %s 有自己的说明", (reason, text) => {
    render(
      <AssetNoticeDialog
        {...dialogProps({ prompt: { ...STALE, migration: { ...DEFERRED, reason, worktrees: [] } } })}
      />,
    );
    expect(migration()).toContain(text);
  });

  it("没有迁移时不显示迁移段落", () => {
    render(<AssetNoticeDialog {...dialogProps()} />);
    expect(screen.queryByTestId("asset-notice-migration")).toBeNull();
  });

  it("技能档不过期但待迁移：不显示版本列，按钮为稍后、保留现状、更新规格文档夹", () => {
    const p = dialogProps({ prompt: MIGRATE });
    render(<AssetNoticeDialog {...p} />);
    expect(screen.getByRole("alertdialog").textContent).toContain("这个项目的规格文档夹要改名");
    expect(screen.queryByTestId("asset-notice-rows")).toBeNull();
    const footer = screen.getByTestId("asset-notice-actions");
    expect(within(footer).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "稍后",
      "保留现状",
      "更新规格文档夹",
    ]);
    fireEvent.click(button("更新规格文档夹"));
    expect(p.onApply).toHaveBeenCalledTimes(1);
  });

  it("更新进行中按 Esc 不关框：完成态与错误都要留在框内", () => {
    const p = dialogProps({ prompt: { ...STALE, migration: PENDING }, busy: true });
    render(<AssetNoticeDialog {...p} />);
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(p.onOpenChange).not.toHaveBeenCalled();
  });

  it("完成：显示要 commit 的路径与两则提醒；提示已消失也照样显示", () => {
    const p = dialogProps({ prompt: null, migrated: { movedFolder: true, renamed: 4 } });
    render(<AssetNoticeDialog {...p} />);
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("规格文档夹已改名");
    expect(dialog.textContent).toContain("4 个变更数据档已改名为 .meta.yaml");
    expect(dialog.textContent).toContain("specseal/（添加）与 openspec/（删除）");
    expect(dialog.textContent).toContain("团队成员要先升级 Specseal 再 pull");
    expect(dialog.textContent).toContain("脚本、CI 设置与 .gitignore");
    fireEvent.click(button("知道了"));
    expect(p.onDone).toHaveBeenCalledTimes(1);
  });

  it("完成（只改名旧文档名的数据档）：只提醒 commit 改名的数据档", () => {
    render(<AssetNoticeDialog {...dialogProps({ prompt: null, migrated: { movedFolder: false, renamed: 2 } })} />);
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("specseal/ 里 2 个变更数据档已改名为 .meta.yaml");
    expect(dialog.textContent).not.toContain("openspec/（删除）");
    expect(dialog.textContent).not.toContain("团队成员");
  });
});
