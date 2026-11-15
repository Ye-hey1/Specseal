// 更新日志对话框（desktop-app spec「更新日志弹窗」「更新日志依接口语言呈现」）：whatsNew 模式标题
// 「X.Y.Z 更新内容」、主钮「知道了」；browse 模式标题「更新日志」、主钮「关闭」、列出全部条目；
// 空清单显示提示。条目、分组标题与版号小标依接口语言呈现，切换语言后已打开的对话框跟着换。
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { I18nProvider, type UiLocale } from "@specseal/ui";

import { ReleaseNotesDialog } from "../components/ReleaseNotesDialog";
import { APP_MESSAGES } from "../i18n/messages";
import { RELEASE_NOTES, type ReleaseNotesEntry } from "../release-notes/release-notes";

const ENTRIES: ReleaseNotesEntry[] = [
  {
    version: "0.3.1",
    date: "2026-09-20",
    sections: [
      { kind: "features", items: [{ en: "Alpha feature", "zh-CN": "甲功能" }] },
      { kind: "fixes", items: [{ en: "Beta fix", "zh-CN": "乙修正" }] },
    ],
  },
  {
    version: "0.3.0",
    date: "2026-09-10",
    sections: [{ kind: "improvements", items: [{ en: "Gamma improvement", "zh-CN": "丙改善" }] }],
  },
];

type DialogProps = { mode: "whatsNew" | "browse"; entries: ReleaseNotesEntry[]; focusVersion?: string };

function dialogIn(locale: UiLocale, props: DialogProps, onOpenChange: (open: boolean) => void) {
  return (
    <I18nProvider locale={locale} messages={APP_MESSAGES}>
      <ReleaseNotesDialog open {...props} onOpenChange={onOpenChange} />
    </I18nProvider>
  );
}

function renderDialog(props: DialogProps, locale: UiLocale = "zh-CN") {
  const onOpenChange = vi.fn();
  const { rerender } = render(dialogIn(locale, props, onOpenChange));
  return {
    onOpenChange,
    dialog: screen.getByTestId("release-notes-dialog"),
    switchTo: (next: UiLocale) => rerender(dialogIn(next, props, onOpenChange)),
  };
}

describe("ReleaseNotesDialog", () => {
  it("whatsNew 模式：标题「0.3.1 更新内容」，主钮「知道了」按下调用 onOpenChange(false)", () => {
    const { onOpenChange, dialog } = renderDialog({ mode: "whatsNew", entries: ENTRIES });
    expect(within(dialog).getByText("0.3.1 更新内容")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "关闭" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "知道了" }));
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("browse 模式：标题「更新日志」、主钮「关闭」、列出全部条目的「版号（日期）」小标与三类分组", () => {
    const { onOpenChange, dialog } = renderDialog({ mode: "browse", entries: ENTRIES });
    expect(within(dialog).getByText("更新日志")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "知道了" })).toBeNull();
    const text = dialog.textContent ?? "";
    expect(text.indexOf("0.3.1（2026-09-20）")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("0.3.0（2026-09-10）")).toBeGreaterThan(text.indexOf("0.3.1（2026-09-20）"));
    for (const heading of ["新功能", "修正", "改善"]) {
      expect(within(dialog).getByText(heading)).toBeTruthy();
    }
    for (const item of ["甲功能", "乙修正", "丙改善"]) {
      expect(within(dialog).getByText(item)).toBeTruthy();
    }
    expect(text).not.toContain("Alpha feature");
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("英文接口 whatsNew：标题「What's new in 0.3.1」、英文条目与英文分组标题、主钮「Got it」", () => {
    const { dialog } = renderDialog({ mode: "whatsNew", entries: ENTRIES.slice(0, 1) }, "en");
    expect(within(dialog).getByText("What's new in 0.3.1")).toBeTruthy();
    for (const heading of ["New features", "Fixes"]) {
      expect(within(dialog).getByText(heading)).toBeTruthy();
    }
    for (const item of ["Alpha feature", "Beta fix"]) {
      expect(within(dialog).getByText(item)).toBeTruthy();
    }
    expect(dialog.textContent).not.toMatch(/甲功能|乙修正|新功能|修正/);
    expect(within(dialog).getByRole("button", { name: "Got it" })).toBeTruthy();
  });

  it("英文接口 browse：版号小标「0.3.1 (2026-09-20)」、分组 New features／Fixes／Improvements、全部英文条目", () => {
    const { dialog } = renderDialog({ mode: "browse", entries: ENTRIES }, "en");
    const text = dialog.textContent ?? "";
    expect(text.indexOf("0.3.1 (2026-09-20)")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("0.3.0 (2026-09-10)")).toBeGreaterThan(text.indexOf("0.3.1 (2026-09-20)"));
    expect(text).not.toContain("（");
    for (const heading of ["New features", "Fixes", "Improvements"]) {
      expect(within(dialog).getByText(heading)).toBeTruthy();
    }
    for (const item of ["Alpha feature", "Beta fix", "Gamma improvement"]) {
      expect(within(dialog).getByText(item)).toBeTruthy();
    }
    expect(text).not.toMatch(/甲功能|乙修正|丙改善/);
  });

  it("切换接口语言后，已打开的对话框改以新语言呈现", () => {
    const { dialog, switchTo } = renderDialog({ mode: "browse", entries: ENTRIES });
    expect(within(dialog).getByText("甲功能")).toBeTruthy();
    switchTo("en");
    const reopened = screen.getByTestId("release-notes-dialog");
    expect(within(reopened).getByText("Alpha feature")).toBeTruthy();
    expect(within(reopened).getByText("Improvements")).toBeTruthy();
    expect(reopened.textContent).not.toContain("甲功能");
    switchTo("zh-CN");
    expect(within(screen.getByTestId("release-notes-dialog")).getByText("甲功能")).toBeTruthy();
  });

  it("browse 带 focusVersion：打开后把该版小标所在的条目卷到顶端一次（desktop-about-page design D8）", () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    try {
      const { dialog } = renderDialog({ mode: "browse", entries: ENTRIES, focusVersion: "0.3.0" });
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(scroll).toHaveBeenCalledWith({ block: "start" });
      const target = scroll.mock.contexts[0] as HTMLElement;
      expect(dialog.contains(target)).toBe(true);
      expect(target.getAttribute("data-version")).toBe("0.3.0");
    } finally {
      scroll.mockRestore();
    }
  });

  it.each<[string, string | undefined]>([
    ["不带 focusVersion", undefined],
    ["focusVersion 不在清单内", "0.0.1"],
  ])("browse %s 时不卷动", (_name, focusVersion) => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    try {
      renderDialog({ mode: "browse", entries: ENTRIES, focusVersion });
      expect(scroll).not.toHaveBeenCalled();
    } finally {
      scroll.mockRestore();
    }
  });

  it("entries 为空时显示 releaseNotes.empty 文案", () => {
    const { dialog } = renderDialog({ mode: "browse", entries: [] });
    expect(within(dialog).getByText(APP_MESSAGES["zh-CN"]["releaseNotes.empty"])).toBeTruthy();
  });
});

// release-notes spec「更新日志 JSON 为唯一真相」Scenario「条目形状」：打包进 app 的真 JSON。
describe("release-notes.json 形状", () => {
  const KINDS = ["features", "fixes", "improvements"];

  it("每笔 version 为 X.Y.Z、date 为 YYYY-MM-DD；kind 为三值之一且依序不重复；每个条目的 en 与 zh-CN 都是非空字符串", () => {
    expect(RELEASE_NOTES.length).toBeGreaterThan(0);
    for (const entry of RELEASE_NOTES) {
      expect(entry.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const order = entry.sections.map((section) => KINDS.indexOf(section.kind));
      expect(order.every((index) => index >= 0), `${entry.version} 的 kind`).toBe(true);
      expect([...order].sort((a, b) => a - b), `${entry.version} 的分组顺序`).toEqual([...new Set(order)]);
      for (const section of entry.sections) {
        expect(section.items.length, `${entry.version} ${section.kind}`).toBeGreaterThan(0);
        for (const item of section.items) {
          expect(typeof item.en === "string" && item.en.trim().length > 0, `${entry.version} 的 en`).toBe(true);
          expect(typeof item["zh-CN"] === "string" && item["zh-CN"].trim().length > 0, `${entry.version} 的 zh-CN`).toBe(
            true,
          );
        }
      }
    }
  });
});
