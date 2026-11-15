import { describe, it, expect, beforeEach, vi } from "vitest";
import { render } from "@testing-library/react";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";
import { APP_MESSAGES } from "../i18n/messages";
import { makeAdminClient, setViewport } from "./helpers/adminHarness";

// spec 需求「首次进入提供可略过的分步导览」：首次打开管理面自动启动、每一步指向画面上
// 实际存在的元素并附一句说明、可上一步／下一步／略过、看过后不再自动启动、系统页保留
// 重新启动入口、目标元素缺席时跳过该步。
//
// 这里不用 adminHarness 的 renderAt——它刻意把「看过了」预先写进去，好让其他页的测试
// 不被导览盖住。导览自己的测试要从「没看过」开始。

const TOUR_KEY = "specseal.tourSeen";

beforeEach(() => {
  setViewport(false);
  localStorage.clear();
});

function renderFresh(route: string) {
  return render(<App client={makeAdminClient() as never} initialEntries={[route]} />);
}

/** 导览叠层；未启动时为 null。 */
function tour(): HTMLElement | null {
  return screen.queryByRole("region", { name: "导览" });
}

describe("首次进入自动启动", () => {
  it("尚未看过时打开 /admin 自动启动，第一步指向总览并提供下一步与略过", async () => {
    renderFresh("/admin");
    const panel = await screen.findByRole("region", { name: "导览" });
    expect(within(panel).getByText("总览")).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "下一步" })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "略过" })).toBeTruthy();
    // 第一步没有上一步可回。
    expect(
      (within(panel).getByRole("button", { name: "上一步" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("已看过时不自动启动", async () => {
    localStorage.setItem(TOUR_KEY, "1");
    renderFresh("/admin");
    await screen.findByRole("heading", { level: 1, name: "总览" });
    expect(tour()).toBeNull();
  });

  it("略过后刷新不再自动启动", async () => {
    const user = userEvent.setup();
    const { unmount } = renderFresh("/admin");
    await user.click(within(await screen.findByRole("region", { name: "导览" })).getByRole("button", { name: "略过" }));
    await waitFor(() => expect(tour()).toBeNull());
    unmount();

    renderFresh("/admin");
    await screen.findByRole("heading", { level: 1, name: "总览" });
    expect(tour()).toBeNull();
  });

  it("走完最后一步后刷新不再自动启动", async () => {
    const user = userEvent.setup();
    const { unmount } = renderFresh("/admin");
    let panel = await screen.findByRole("region", { name: "导览" });
    while (within(panel).queryByRole("button", { name: "下一步" })) {
      await user.click(within(panel).getByRole("button", { name: "下一步" }));
      panel = screen.getByRole("region", { name: "导览" });
    }
    await user.click(within(panel).getByRole("button", { name: "完成" }));
    await waitFor(() => expect(tour()).toBeNull());
    unmount();

    renderFresh("/admin");
    await screen.findByRole("heading", { level: 1, name: "总览" });
    expect(tour()).toBeNull();
  });
});

describe("重新启动入口", () => {
  it("系统页的重看导览可再次启动", async () => {
    localStorage.setItem(TOUR_KEY, "1");
    const user = userEvent.setup();
    renderFresh("/admin/system");
    await screen.findByRole("heading", { level: 1, name: "系统" });
    expect(tour()).toBeNull();
    await user.click(screen.getByRole("button", { name: "重看导览" }));
    expect(await screen.findByRole("region", { name: "导览" })).toBeTruthy();
  });
});

describe("目标元素缺席时跳过该步", () => {
  it("总览页没有列表 primary action，该步不出现且导览不中断", async () => {
    const user = userEvent.setup();
    renderFresh("/admin");
    let panel = await screen.findByRole("region", { name: "导览" });
    const seen: string[] = [];
    while (within(panel).queryByRole("button", { name: "下一步" })) {
      seen.push(panel.getAttribute("data-tour-step") ?? "");
      await user.click(within(panel).getByRole("button", { name: "下一步" }));
      panel = screen.getByRole("region", { name: "导览" });
    }
    seen.push(panel.getAttribute("data-tour-step") ?? "");
    // 六个侧栏目的地都走到，指向列表 primary action 的那一步被跳过。
    expect(seen).toEqual([
      "nav-overview",
      "nav-users",
      "nav-registry",
      "nav-credentials",
      "nav-system",
      "nav-audit",
    ]);
    expect(within(panel).getByRole("button", { name: "完成" })).toBeTruthy();
  });

  it("用户页存在该元素时该步出现在最后", async () => {
    const user = userEvent.setup();
    renderFresh("/admin/users");
    let panel = await screen.findByRole("region", { name: "导览" });
    while (within(panel).queryByRole("button", { name: "下一步" })) {
      await user.click(within(panel).getByRole("button", { name: "下一步" }));
      panel = screen.getByRole("region", { name: "导览" });
    }
    expect(panel.getAttribute("data-tour-step")).toBe("list-primary");
  });
});

describe("叠层贴着它正在指的元素", () => {
  it("卡片以目标的座标定位，而不是固定在画面底部", async () => {
    renderFresh("/admin");
    const panel = await screen.findByRole("region", { name: "导览" });
    // 定位由目标的 rect 决定：卡片带 inline 座标，而非写死的 bottom-4 left-1/2。
    expect(panel.style.top, "卡片应有依目标算出的 top").not.toBe("");
    expect(panel.style.left, "卡片应有依目标算出的 left").not.toBe("");
    expect(panel.className).not.toContain("bottom-4");
  });
});

describe("键盘与降级", () => {
  it("导览进行中按 Escape 离开", async () => {
    const user = userEvent.setup();
    renderFresh("/admin");
    await screen.findByRole("region", { name: "导览" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(tour()).toBeNull());
  });

  it("上一步回到前一步", async () => {
    const user = userEvent.setup();
    renderFresh("/admin");
    let panel = await screen.findByRole("region", { name: "导览" });
    await user.click(within(panel).getByRole("button", { name: "下一步" }));
    panel = screen.getByRole("region", { name: "导览" });
    expect(panel.getAttribute("data-tour-step")).toBe("nav-users");
    await user.click(within(panel).getByRole("button", { name: "上一步" }));
    expect(screen.getByRole("region", { name: "导览" }).getAttribute("data-tour-step")).toBe(
      "nav-overview",
    );
  });

  it("localStorage 读写丢例外时导览照常运作，只是不持久化", async () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("localStorage disabled");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("localStorage disabled");
    });
    try {
      const user = userEvent.setup();
      renderFresh("/admin");
      // 读取失败＝视为未看过，导览照常启动。
      const panel = await screen.findByRole("region", { name: "导览" });
      // 写入失败不得让略过丢例外。
      await user.click(within(panel).getByRole("button", { name: "略过" }));
      await waitFor(() => expect(tour()).toBeNull());
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});

// 情境「导览说明符合现行的列表交互」：列表改成详情页与置中对话框后，说明曾停在旧的
// 右侧面板。字符串比对只抓得到已知的旧字眼，抓不到新的不实描述——后者靠第二条钉住两个
// 描述交互的键。
describe("导览说明符合现行的列表交互", () => {
  const STALE_WORDS = ["右侧面板", "滑出", "抽屉", "drawer", "slides"];

  it("两种语言的导览说明都不提已不存在的接口", () => {
    const hits = Object.entries(APP_MESSAGES).flatMap(([locale, dict]) => {
      const hints = Object.entries(dict).filter(([key]) => /^tour\..+\.hint$/.test(key));
      // Tour.tsx 的 STEPS 共七步；筛不出七个键代表键名变了，下面的比对会空转。
      expect(hints, `${locale} 的导览说明键数`).toHaveLength(7);
      return hints.flatMap(([key, value]) =>
        STALE_WORDS.filter((word) => value.toLowerCase().includes(word.toLowerCase())).map(
          (word) => `${locale} ${key}：${word}`,
        ),
      );
    });
    expect(hits).toEqual([]);
  });

  it("「用户」提到用户列与详情页，「创建」只讲这一页的主要动作与置中的对话框", () => {
    const zh = APP_MESSAGES["zh-CN"];
    const en = APP_MESSAGES.en;
    // 「邀请中」分页的列点了没反应，只有用户列会进详情页。
    expect(zh["tour.navUsers.hint"]).toContain("点用户那一列进入详情页");
    expect(en["tour.navUsers.hint"]).toContain("click a user's row");
    expect(en["tour.navUsers.hint"]).toContain("detail page");
    // 编辑已移到详情页，这一步指的按钮只负责创建。
    expect(zh["tour.listPrimary.title"]).toBe("创建");
    expect(en["tour.listPrimary.title"]).toBe("Create");
    // 凭证页的主要动作连到帐号页，「每个列表页都开对话框」不成立；这一步只出现在带目标元素的页面。
    expect(zh["tour.listPrimary.hint"]).toMatch(/^这一页/);
    expect(en["tour.listPrimary.hint"]).toMatch(/^This page/);
    expect(zh["tour.listPrimary.hint"]).toContain("置中的对话框");
    expect(en["tour.listPrimary.hint"]).toContain("centered dialog");
  });
});
