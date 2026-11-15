import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  CREDENTIALS,
  EMPTY_CREDENTIALS,
  makeAdminClient,
  renderAt,
  setViewport,
} from "./helpers/adminHarness";

// 管理凭证页（server-web-console「管理列表提供搜索、筛选、分页与具引导的空状态」「共用设计系统
// 维持高密度可访问体验」的撤销钮条款；server-web-list-pages design D2、D3、D6、D8）：列表卡顶端
// 以「访问密钥｜设备」两个分页区分（各带总数），页标题区提供关键字搜索与状态筛选；列不可点，
// 列尾是状态签与滑过才出现的撤销钮，撤销经 AlertDialog 确认。空清单以说明用途的空状态呈现，
// 创建入口常驻页眉。

beforeEach(() => setViewport(false));

const tabCount = (name: RegExp) =>
  screen.getByRole("tab", { name }).querySelector("[data-tab-count]")?.textContent;
const patRow = (prefix: string) => screen.getByText(prefix).closest("[data-pat]") as HTMLElement;

describe("凭证页", () => {
  it("卡顶「访问密钥」「设备」两个分页带总数，缺省列出访问密钥的 metadata", async () => {
    renderAt("/admin/credentials", makeAdminClient());
    expect(await screen.findByText("slk_abc")).toBeTruthy();
    expect(tabCount(/^访问密钥/)).toBe("2");
    expect(tabCount(/^设备/)).toBe("1");
  });

  it("访问密钥列不可点：标题为名称、说明为「前缀 · 用户 · 创建 · 到期」", async () => {
    renderAt("/admin/credentials", makeAdminClient());
    await screen.findByText("slk_abc");
    const row = patRow("slk_abc");
    expect(row.getAttribute("role")).toBeNull();
    expect(within(row).getByText("cli")).toBeTruthy();
    expect(row.querySelector("[data-desc]")?.textContent).toBe(
      "slk_abc · 用户 m1 · 创建 2026-01-01 · 到期 永久",
    );
  });

  it("有效列有滑过才出现的撤销钮（键盘聚焦时也出现），已撤销列没有", async () => {
    renderAt("/admin/credentials", makeAdminClient());
    await screen.findByText("slk_abc");
    const revoke = within(patRow("slk_abc")).getByRole("button", { name: "撤销访问密钥 cli" });
    const classes = revoke.className.split(/\s+/);
    // 平时隐藏、列滑过或键盘聚焦时出现；没有鼠标移入能力的设备恒常显示。
    expect(classes).toEqual(
      expect.arrayContaining([
        "opacity-0",
        "group-hover:opacity-100",
        "focus-visible:opacity-100",
        "[@media(hover:none)]:opacity-100",
      ]),
    );
    expect(classes).not.toContain("hidden");
    expect(within(patRow("slk_xyz")).queryByRole("button")).toBeNull();
  });

  it("凭证状态签：有效为绿系、已撤销为中性，两态可区辨", async () => {
    // spec「凭证状态徽章」：撤销是不可逆的事，得一眼看出哪把还活着。
    renderAt("/admin/credentials", makeAdminClient());
    await screen.findByText("slk_abc");
    const valid = within(patRow("slk_abc")).getByText("有效");
    const revoked = within(patRow("slk_xyz")).getByText("已撤销");
    expect(valid.className).toContain("status-success");
    expect(revoked.className).not.toContain("status-success");
    expect(revoked.className).toContain("text-muted-foreground");
  });

  it("关键字搜索只留下相符的访问密钥", async () => {
    renderAt("/admin/credentials", makeAdminClient());
    expect(await screen.findByText("slk_abc")).toBeTruthy();
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "搜索" }), "部署");
    await waitFor(() => expect(screen.queryByText("slk_abc")).toBeNull());
    expect(screen.getByText("slk_xyz")).toBeTruthy();
  });

  it("状态筛选只留下有效或已撤销的项目", async () => {
    renderAt("/admin/credentials", makeAdminClient());
    expect(await screen.findByText("slk_xyz")).toBeTruthy();
    // 状态筛选是 Radix Select：点开 trigger 再点击项（Radix 打开时关闭 body 的
    // pointer-events，jsdom 没有真实命中测试，故关掉 userEvent 的检查）。
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole("combobox", { name: /状态/ }));
    await user.click(await screen.findByRole("option", { name: "有效" }));
    await waitFor(() => expect(screen.queryByText("slk_xyz")).toBeNull());
    expect(screen.getByText("slk_abc")).toBeTruthy();
  });

  // 空状态的创建入口不能只在「一个凭证都没有」时存在——建完第一把之后就再也找不到
  // 添加的地方了。primary action 常驻页眉。
  it("已有凭证时仍提供创建访问密钥的入口", async () => {
    renderAt("/admin/credentials", makeAdminClient());
    await screen.findByText("slk_abc");
    const create = screen.getByRole("link", { name: /创建访问密钥/ });
    expect(create.getAttribute("href")).toBe("/account");
  });

  it("筛选无结果时呈现无符合状态并保留筛选控制项、没有换页列", async () => {
    renderAt("/admin/credentials", makeAdminClient());
    expect(await screen.findByText("slk_abc")).toBeTruthy();
    const user = userEvent.setup();
    const search = screen.getByRole("textbox", { name: "搜索" });
    await user.type(search, "找不到的东西");
    await waitFor(() => expect(screen.queryByText("slk_abc")).toBeNull());
    expect(screen.getByText(/没有符合/)).toBeTruthy();
    // 筛选控制项仍在，用户才能改回来。
    expect(screen.getByRole("textbox", { name: "搜索" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: /状态/ })).toBeTruthy();
    expect(screen.queryByText(/^第 .+ 笔，共 .+ 笔$/)).toBeNull();
  });

  it("空凭证页说明用途并提供创建访问密钥的 primary action，不出现分页", async () => {
    renderAt(
      "/admin/credentials",
      makeAdminClient({ getAdminCredentials: vi.fn(async () => EMPTY_CREDENTIALS) }),
    );
    const empty = await screen.findByText(/远程工作流程/);
    expect(empty).toBeTruthy();
    const action = screen.getByRole("link", { name: /创建访问密钥/ });
    expect(action.getAttribute("href")).toBe("/account");
    expect(screen.queryByRole("tab")).toBeNull();
  });

  // design D2：该类数据完全没有时是说明用途的空状态，与「搜索后没有符合」可区辨。
  it("某一类原本就 0 笔时，该分页呈现说明该类用途的空状态，而不是无符合结果", async () => {
    renderAt(
      "/admin/credentials",
      makeAdminClient({
        getAdminCredentials: vi.fn(async () => ({ ...CREDENTIALS, pats: [] })),
      }),
    );
    expect(await screen.findByText("尚无访问密钥")).toBeTruthy();
    expect(screen.queryByText(/没有符合/)).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: /^设备/ }));
    expect(await screen.findByText("desktop")).toBeTruthy();
  });

  it("没有设备登录时，设备分页呈现说明设备凭证来源的空状态", async () => {
    renderAt(
      "/admin/credentials",
      makeAdminClient({
        getAdminCredentials: vi.fn(async () => ({ ...CREDENTIALS, deviceFamilies: [] })),
      }),
    );
    await screen.findByText("slk_abc");
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: /^设备/ }));
    expect(await screen.findByText("尚无设备登录")).toBeTruthy();
    expect(screen.queryByText(/没有符合/)).toBeNull();
  });

  it("撤销经 AlertDialog 确认后才送出", async () => {
    const client = makeAdminClient();
    renderAt("/admin/credentials", client);
    await screen.findByText("slk_abc");
    const user = userEvent.setup();
    await user.click(within(patRow("slk_abc")).getByRole("button", { name: "撤销访问密钥 cli" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(client.adminRevokeToken).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: /撤销|确认/ }));
    await waitFor(() => expect(client.adminRevokeToken).toHaveBeenCalledWith("p1"));
  });

  it("设备分页的列：标题为来源、说明为「用户 · 创建 · 最近更新」，可撤销", async () => {
    const client = makeAdminClient();
    renderAt("/admin/credentials", client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: /^设备/ }));
    const row = (await screen.findByText("desktop")).closest("[data-device]") as HTMLElement;
    expect(row.getAttribute("role")).toBeNull();
    expect(row.querySelector("[data-desc]")?.textContent).toBe(
      "用户 m1 · 创建 2026-01-01 · 最近更新 2026-01-03",
    );
    await user.click(within(row).getByRole("button", { name: /撤销设备/ }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /撤销|确认/ }));
    await waitFor(() => expect(client.adminRevokeFamily).toHaveBeenCalledWith("d1"));
  });

  it("窄屏幕：说明只留第一段，撤销动作仍在", async () => {
    setViewport(true);
    const client = makeAdminClient();
    renderAt("/admin/credentials", client);
    expect(await screen.findByText("slk_abc")).toBeTruthy();
    expect(patRow("slk_abc").querySelector("[data-desc]")?.textContent).toBe("slk_abc");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "撤销访问密钥 cli" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /撤销|确认/ }));
    await waitFor(() => expect(client.adminRevokeToken).toHaveBeenCalledWith("p1"));
    await user.click(screen.getByRole("tab", { name: /^设备/ }));
    const device = (await screen.findByText("desktop")).closest("[data-device]") as HTMLElement;
    expect(device.querySelector("[data-desc]")?.textContent).toBe("用户 m1");
  });
});
