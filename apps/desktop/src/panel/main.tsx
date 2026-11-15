// 面板窗口入口（design D5）：薄渲染层——监听主窗口推送的 tray-snapshot、
// 动作以 tray-panel-action 事件回流主窗口运行（不自建 store、不直呼数据查找
// 指令）；拷贝直呼 clipboard 插件（Rust 端，面板常态无焦点仍成功、失败静默）。
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  I18nProvider,
  applyThemePreference,
  readThemePreference,
  type ThemePreference,
} from "@specseal/ui";

import { TrayPanel } from "./TrayPanel";
import { detectPlatform } from "../platform";
import { APP_MESSAGES } from "../i18n/messages";
import { readLocalePreference, resolveUiLocale } from "../i18n/locale";
import type { TraySnapshot } from "../tray";
import "@fontsource-variable/noto-sans-tc";
import "../index.css";

// vibrancy 材质从窗口底透出：文档背景必须透明（index.css 的 body 底色让开）。
document.documentElement.style.background = "transparent";
document.body.style.background = "transparent";

// 外观偏好（desktop-settings-mode design D4）：启动时套用，主窗口切换时经事件重套。原生窗口主题
// 一并设成同一偏好——vibrancy 材质跟原生窗口外观走，不同步就会浅色字叠在深色玻璃上。
const applyPanelTheme = (pref: ThemePreference) => {
  applyThemePreference(pref);
  void getCurrentWindow().setTheme(pref).catch(() => {});
};
applyPanelTheme(readThemePreference());
void listen<ThemePreference>("specseal:theme-changed", (e) => applyPanelTheme(e.payload));

const PANEL_WIDTH = 320;
const PANEL_MAX_HEIGHT = 640;
// 面板根层外观依平台（tray-panel-windows design D2）；平台在行程内不变，侦测一次。
const PLATFORM = detectPlatform();

function PanelRoot() {
  const [snap, setSnap] = useState<TraySnapshot | null>(null);
  useEffect(() => {
    const unlisten = listen<TraySnapshot>("tray-snapshot", (e) => setSnap(e.payload));
    // 面板 lazy 创建：挂好监听后向主窗口请求一次快照，避免首开空窗。
    void emit("tray-panel-ready", {});
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);
  // 窗口高度自适应内容（三段式版面）：root 以 h-screen 撑满窗口，直接量 root
  // 会与 setSize 形成「窗口高⇄root 高」循环——改以「root 现高 − 中段可视高 ＋
  // 中段内容自然高」还原无约束总高（＝页眉＋中段自然内容高＋页脚＋留白），
  // 上限 640 后由中段内部卷动，失败静默。
  useEffect(() => {
    const root = document.getElementById("root");
    if (!root) return;
    const win = getCurrentWindow();
    const fit = () => {
      const scroll = root.querySelector<HTMLElement>('[data-testid="panel-scroll"]');
      if (!scroll) return;
      const natural =
        root.getBoundingClientRect().height - scroll.clientHeight + scroll.scrollHeight;
      const h = Math.min(Math.ceil(natural), PANEL_MAX_HEIGHT);
      if (h > 0) void win.setSize(new LogicalSize(PANEL_WIDTH, h)).catch(() => {});
    };
    const observer = new ResizeObserver(fit);
    // 尺寸会变的是页眉、页脚与中段内容 wrapper——中段容器本身被 flex 约束、
    // 内容增减不改其外框，观察容器会漏掉内容变化；setSize 改的是 root 与
    // 中段容器（皆未被观察），不会自循环。
    for (const testid of ["panel-header", "panel-scroll-content", "panel-footer"]) {
      const el = root.querySelector(`[data-testid="${testid}"]`);
      if (el) observer.observe(el);
    }
    fit();
    return () => observer.disconnect();
  }, []);
  const act = (kind: string, id?: string) => {
    void emit("tray-panel-action", { kind, id });
  };
  return (
    <TrayPanel
      snapshot={snap}
      platform={PLATFORM}
      onOpenProject={(key) => act("open-project", key)}
      onOpenChange={(name) => act("open-change", name)}
      onOpenDiscussion={(slug) => act("open-discussion", slug)}
      onOpenApp={() => act("open-app")}
      onOpenProjectSettings={() => act("open-project-settings")}
      onOpenSettings={() => act("open-settings")}
      onQuit={() => act("quit")}
      onAddProject={() => act("add-project")}
      onRetryWorkspace={(key) => act("retry-workspace", key)}
      onOpenRecovery={(key) => act("open-recovery", key)}
      onOpenServerSettings={(connectionId) => act("open-server-settings", connectionId)}
      onReauthenticate={(connectionId) => act("reauthenticate", connectionId)}
      onCopy={(text) => {
        void writeText(text).catch(() => {});
      }}
    />
  );
}

const root = document.getElementById("root");
if (root) {
  const uiLocale = resolveUiLocale(
    readLocalePreference(),
    typeof navigator !== "undefined" ? navigator.language : undefined,
  );
  createRoot(root).render(
    <StrictMode>
      <I18nProvider locale={uiLocale} messages={APP_MESSAGES}>
        <PanelRoot />
      </I18nProvider>
    </StrictMode>,
  );
}
