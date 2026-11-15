// 五个设置零件（desktop-settings-mode design D3）：页标题、卡、列、列右侧下拉、群组标题。
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Globe } from "lucide-react";

import {
  SettingsCard,
  SettingsChoice,
  SettingsGroupHeader,
  SettingsLinkRow,
  SettingsPageHeader,
  SettingsRow,
} from "../components/ui/settings";

const classes = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);

describe("SettingsPageHeader", () => {
  it("渲染标题、说明、右侧动作与其下 12px 灰字注记", () => {
    render(
      <SettingsPageHeader
        title="一般"
        description="接口语言、更新与 CLI。"
        actions={<button>检查更新</button>}
        note="此页内容仅存于此设备，不写入版本库"
      />,
    );
    expect(screen.getByRole("heading", { level: 2, name: "一般" })).toBeTruthy();
    expect(screen.getByText("接口语言、更新与 CLI。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "检查更新" })).toBeTruthy();
    const note = screen.getByText("此页内容仅存于此设备，不写入版本库");
    expect(classes(note)).toEqual(expect.arrayContaining(["text-xs", "text-muted-foreground"]));
  });

  it("未给 note 时不渲染注记列", () => {
    const { container } = render(<SettingsPageHeader title="更新" />);
    expect(container.querySelector("[data-settings-note]")).toBeNull();
  });
});

describe("SettingsGroupHeader", () => {
  it("12px 粗体灰字标签，可带图标与计数", () => {
    const { container } = render(
      <SettingsGroupHeader icon={<Globe data-testid="icon" />} label="应用程序" count={5} />,
    );
    const label = screen.getByText("应用程序");
    const root = container.firstElementChild as HTMLElement;
    expect(classes(root)).toEqual(
      expect.arrayContaining(["text-xs", "font-semibold", "text-muted-foreground"]),
    );
    expect(root.contains(label)).toBe(true);
    expect(screen.getByTestId("icon")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
  });

  it("图标与计数皆选配", () => {
    const { container } = render(<SettingsGroupHeader label="项目" />);
    expect(container.querySelector("svg")).toBeNull();
    expect(container.textContent).toBe("项目");
  });
});

describe("SettingsCard", () => {
  it("14px 小标（含计数）在 16px 圆角卡之上，卡以小标为区域名，列间细线", () => {
    render(
      <SettingsCard title="连接" count={2}>
        <SettingsRow label="甲" control={<span />} />
        <SettingsRow label="乙" control={<span />} />
      </SettingsCard>,
    );
    const region = screen.getByRole("region", { name: "连接" });
    const title = within(region).getByText("连接");
    expect(classes(title.parentElement as HTMLElement)).toContain("text-sm");
    expect(within(region).getByText("2")).toBeTruthy();
    const card = region.querySelector("[data-settings-card-body]") as HTMLElement;
    expect(classes(card)).toEqual(expect.arrayContaining(["rounded-2xl", "divide-y"]));
    expect(within(card).getAllByRole("group")).toHaveLength(2);
  });

  // server-web-list-pages design D1：小标同一列的右端槽（链接或 12px 灰字）。
  it("aside 渲染在小标同一列、卡身之外；未给时小标列没有 aside", () => {
    const { unmount } = render(
      <SettingsCard title="系统健康" aside={<a href="/admin/system">系统 ›</a>}>
        <SettingsRow label="甲" control={<span />} />
      </SettingsCard>,
    );
    const region = screen.getByRole("region", { name: "系统健康" });
    const link = within(region).getByRole("link", { name: "系统 ›" });
    const head = region.querySelector("[data-settings-card-head]") as HTMLElement;
    expect(head.contains(link)).toBe(true);
    expect(head.contains(within(region).getByText("系统健康"))).toBe(true);
    expect((region.querySelector("[data-settings-card-body]") as HTMLElement).contains(link)).toBe(false);
    unmount();
    render(
      <SettingsCard title="连接">
        <SettingsRow label="甲" control={<span />} />
      </SettingsCard>,
    );
    expect(screen.getByRole("region", { name: "连接" }).querySelector("[data-settings-card-aside]")).toBeNull();
  });
});

describe("SettingsRow", () => {
  it("左标签＋说明、右控制项；以标签为群组名", () => {
    render(
      <SettingsRow
        label="外观"
        description="跟随系统或固定浅色／深色。"
        control={<button>深色</button>}
      />,
    );
    const row = screen.getByRole("group", { name: "外观" });
    expect(classes(row)).toEqual(expect.arrayContaining(["grid", "grid-cols-[1fr_auto]", "px-4", "py-3"]));
    expect(classes(within(row).getByText("外观"))).toContain("text-sm");
    const description = within(row).getByText("跟随系统或固定浅色／深色。");
    expect(classes(description)).toEqual(expect.arrayContaining(["text-xs", "text-muted-foreground"]));
    expect(within(row).getByRole("button", { name: "深色" })).toBeTruthy();
  });

  it("warning 时说明改警示色", () => {
    render(<SettingsRow label="specseal CLI" description="版本不符" control={null} warning />);
    const description = screen.getByText("版本不符");
    expect(classes(description)).toContain("text-status-warning");
    expect(classes(description)).not.toContain("text-muted-foreground");
  });

  it("htmlFor 让标签对到控制项；children 渲染在列下方", () => {
    render(
      <SettingsRow label="locale" htmlFor="cfg-x" control={<input id="cfg-x" />}>
        <p>展开内容</p>
      </SettingsRow>,
    );
    expect(screen.getByLabelText("locale").id).toBe("cfg-x");
    expect(screen.getByText("展开内容")).toBeTruthy();
  });

  // server-web-list-pages design D1：根节点带 group，列内按钮可用 group-hover: 依列滑过显示。
  it("根节点带 group class", () => {
    render(<SettingsRow label="CI 密钥" control={<button>撤销</button>} />);
    expect(classes(screen.getByRole("group", { name: "CI 密钥" }))).toContain("group");
  });
});

describe("SettingsLinkRow", () => {
  it("整列为按钮（hover 灰底、右端外开图标），点击回呼", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<SettingsLinkRow label="回报问题" description="开新 issue 并带入版本信息" onClick={onClick} />);
    const row = screen.getByRole("button", { name: /回报问题/ });
    expect(classes(row)).toEqual(expect.arrayContaining(["w-full", "text-left", "hover:bg-muted"]));
    expect(row.querySelector("svg.lucide-external-link")).toBeTruthy();
    expect(within(row).getByText("开新 issue 并带入版本信息")).toBeTruthy();
    await user.click(row);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("SettingsChoice", () => {
  const OPTIONS = [
    { value: "system", label: "跟随系统" },
    { value: "light", label: "浅色" },
    { value: "dark", label: "深色" },
  ];

  it("以 aria-label 可选、显示现值、选取后回呼", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SettingsChoice value="system" options={OPTIONS} onChange={onChange} ariaLabel="外观" />);
    const trigger = screen.getByRole("combobox", { name: "外观" });
    expect(trigger.textContent).toContain("跟随系统");
    expect(classes(trigger)).toEqual(expect.arrayContaining(["h-8", "text-[13px]"]));
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: "深色" }));
    expect(onChange).toHaveBeenCalledWith("dark");
  });

  it("停用项不可选、停用时触发钮 disabled", () => {
    render(
      <SettingsChoice
        value="繁体中文"
        options={[{ value: "繁体中文", label: "繁体中文（无效）", disabled: true }, ...OPTIONS]}
        onChange={() => {}}
        ariaLabel="locale"
        disabled
      />,
    );
    const trigger = screen.getByRole("combobox", { name: "locale" }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(trigger.textContent).toContain("繁体中文（无效）");
  });

  // desktop-subagent-model-page design「SettingsChoice 的分组」。
  const separators = () => document.querySelectorAll('[data-slot="select-separator"]');

  it("分组项渲染分组标签，组与组、组与单项之间有分隔线；选分组内的项目回传其值", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <SettingsChoice
        value="__inherit__"
        options={[
          { value: "__inherit__", label: "沿用主对话" },
          { label: "内置", options: [{ value: "sonnet", label: "sonnet" }, { value: "opus", label: "opus" }] },
          { label: "自订清单", options: [{ value: "claude-x", label: "claude-x" }] },
          { value: "__custom__", label: "自行输入…" },
        ]}
        onChange={onChange}
        ariaLabel="审查"
      />,
    );
    await user.click(screen.getByRole("combobox", { name: "审查" }));
    const builtin = await screen.findByRole("group", { name: "内置" });
    expect(within(builtin).getAllByRole("option").map((o) => o.textContent)).toEqual(["sonnet", "opus"]);
    const custom = screen.getByRole("group", { name: "自订清单" });
    expect(within(custom).getAllByRole("option").map((o) => o.textContent)).toEqual(["claude-x"]);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "沿用主对话",
      "sonnet",
      "opus",
      "claude-x",
      "自行输入…",
    ]);
    expect(separators()).toHaveLength(3);
    await user.click(within(builtin).getByRole("option", { name: "opus" }));
    expect(onChange).toHaveBeenCalledWith("opus");
  });

  it("只放单项时不出现分组标签与分隔线", async () => {
    const user = userEvent.setup();
    render(<SettingsChoice value="system" options={OPTIONS} onChange={() => {}} ariaLabel="外观" />);
    await user.click(screen.getByRole("combobox", { name: "外观" }));
    await screen.findByRole("option", { name: "深色" });
    expect(screen.queryByRole("group")).toBeNull();
    expect(separators()).toHaveLength(0);
  });
});
