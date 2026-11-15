// 服务器页（desktop-settings-mode design D7；spec「服务器管理最小面」）：页标题右侧「添加连接」
// 展开添加卡；连接卡一列一个 server（状态签、右侧动作与「⋯」）；缺省卡；登录方式卡。
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { I18nProvider } from "@specseal/ui";

import { ServersPage } from "../views/settings/ServersPage";
import type { ConnectionView } from "../adapter/connections";
import { APP_MESSAGES } from "../i18n/messages";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));

const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN" messages={APP_MESSAGES}>
    {children}
  </I18nProvider>
);
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: zhWrapper });

const A: ConnectionView = { id: "c1", origin: "https://a.example", name: "甲站", lastActorDisplay: "Momo", loggedIn: true };
const B: ConnectionView = { id: "c2", origin: "https://b.example", name: "乙站", lastActorDisplay: null, loggedIn: true };
const C: ConnectionView = { id: "c3", origin: "https://c.example", name: "丙站", lastActorDisplay: null, loggedIn: false };

type Props = ComponentProps<typeof ServersPage>;
function page(over: Partial<Props> = {}) {
  return (
    <ServersPage
      connections={[A, B]}
      phases={{}}
      onAdd={vi.fn().mockResolvedValue(undefined)}
      onLogin={vi.fn()}
      onSubmitPat={vi.fn()}
      onLogout={vi.fn()}
      onRemove={vi.fn()}
      onOpenWorkspace={vi.fn()}
      defaultConnectionId={null}
      onDefaultConnectionChange={vi.fn()}
      {...over}
    />
  );
}
const serverRow = (origin: string) => screen.getByTestId(`server-row-${origin}`);

describe("ServersPage", () => {
  it("页标题「服务器」；「添加连接」展开添加卡，送出成功后收起", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    render(page({ onAdd }));
    expect(screen.getByRole("heading", { level: 2, name: "服务器" })).toBeTruthy();
    expect(screen.queryByPlaceholderText("服务器地址（http://…）")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "添加连接" }));
    const card = screen.getByRole("region", { name: "添加连接" });
    fireEvent.change(within(card).getByPlaceholderText("服务器地址（http://…）"), { target: { value: "https://new.example" } });
    fireEvent.change(within(card).getByPlaceholderText("显示名"), { target: { value: "新站" } });
    fireEvent.click(within(card).getByRole("button", { name: "添加" }));
    expect(onAdd).toHaveBeenCalledWith("https://new.example", "新站");
    await waitFor(() => expect(screen.queryByRole("region", { name: "添加连接" })).toBeNull());
  });

  it("添加卡的取消收起卡片", () => {
    render(page());
    fireEvent.click(screen.getByRole("button", { name: "添加连接" }));
    fireEvent.click(within(screen.getByRole("region", { name: "添加连接" })).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("region", { name: "添加连接" })).toBeNull();
  });

  it("连接卡：已登录列为「已登录」签＋注销、登录过期列为警示签＋重新登录；两列皆有等宽网址与「⋯」", () => {
    render(page({ connections: [A, B], focusConnectionId: "c2" }));
    const rowA = serverRow("https://a.example");
    expect(within(rowA).getByText("已登录").className).toContain("bg-status-success/12");
    expect(within(rowA).getByText("https://a.example").className).toContain("font-mono");
    expect(within(rowA).getByText("Momo")).toBeTruthy();
    expect(within(rowA).getByRole("button", { name: "注销" })).toBeTruthy();
    expect(within(rowA).getByRole("button", { name: "更多动作" })).toBeTruthy();
    const rowB = serverRow("https://b.example");
    expect(within(rowB).getByText("登录过期").className).toContain("bg-status-warning/12");
    expect(within(rowB).getByRole("button", { name: "重新登录" })).toBeTruthy();
    expect(within(rowB).queryByRole("button", { name: "注销" })).toBeNull();
    expect(within(rowB).getByRole("button", { name: "更多动作" })).toBeTruthy();
  });

  it("连接失效（session 回报需重新登录）时不经导向也呈现登录过期＋重新登录，且不抢焦点", () => {
    render(page({ connections: [A, B], expiredConnectionIds: ["c2"] }));
    const rowB = serverRow("https://b.example");
    expect(within(rowB).getByText("登录过期")).toBeTruthy();
    const reauth = within(rowB).getByRole("button", { name: "重新登录" });
    expect(document.activeElement).not.toBe(reauth);
    expect(within(serverRow("https://a.example")).getByRole("button", { name: "注销" })).toBeTruthy();
  });

  it("未登录列为「未登录」签＋登录", () => {
    render(page({ connections: [C] }));
    const row = serverRow("https://c.example");
    expect(within(row).getByText("未登录")).toBeTruthy();
    expect(within(row).getByRole("button", { name: "登录" })).toBeTruthy();
  });

  it("「⋯」菜单含打开项目与移除", async () => {
    const onOpenWorkspace = vi.fn();
    const onRemove = vi.fn();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(page({ onOpenWorkspace, onRemove }));
    await user.click(within(serverRow("https://a.example")).getByRole("button", { name: "更多动作" }));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["打开项目", "移除"]);
    await user.click(screen.getByRole("menuitem", { name: "打开项目" }));
    expect(onOpenWorkspace).toHaveBeenCalledWith("c1");
    await user.click(within(serverRow("https://a.example")).getByRole("button", { name: "更多动作" }));
    await user.click(screen.getByRole("menuitem", { name: "移除" }));
    expect(onRemove).toHaveBeenCalledWith("c1");
  });

  it("无连接时显示空状态", () => {
    render(page({ connections: [] }));
    expect(screen.getByTestId("servers-empty")).toBeTruthy();
  });

  it("缺省卡：下拉只列已登录连接与「不预选」，选取回呼", async () => {
    const onDefaultConnectionChange = vi.fn();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(page({ connections: [A, C], defaultConnectionId: null, onDefaultConnectionChange }));
    const trigger = within(screen.getByRole("region", { name: "缺省" })).getByRole("combobox", { name: "添加远程项目时缺省使用" });
    expect(trigger.textContent).toContain("不预选");
    await user.click(trigger);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["不预选", "甲站"]);
    await user.click(screen.getByRole("option", { name: "甲站" }));
    expect(onDefaultConnectionChange).toHaveBeenCalledWith("c1");
  });

  it("缺省指向已注销的连接时下拉显示「不预选」", () => {
    render(page({ connections: [A, C], defaultConnectionId: "c3" }));
    const trigger = screen.getByRole("combobox", { name: "添加远程项目时缺省使用" });
    expect(trigger.textContent).toContain("不预选");
  });

  it("登录方式卡：依序是浏览器登录、设备登录、访问密钥三列，无按钮", () => {
    render(page());
    const card = screen.getByRole("region", { name: "登录方式" });
    const rows = within(card).getAllByRole("group");
    expect(rows).toEqual(["浏览器登录", "设备登录", "访问密钥"].map((name) => within(card).getByRole("group", { name })));
    expect(rows[0].textContent).toContain("优先");
    expect(within(card).queryAllByRole("button")).toHaveLength(0);
  });

  it("登录方式卡在接口语言为 en 时以英文呈现三列", () => {
    rtlRender(page(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <I18nProvider locale="en" messages={APP_MESSAGES}>
          {children}
        </I18nProvider>
      ),
    });
    const card = screen.getByRole("region", { name: "Sign-in methods" });
    expect(within(card).getAllByRole("group")).toEqual(
      ["Browser login", "Device login", "Access key"].map((name) => within(card).getByRole("group", { name })),
    );
  });
});
