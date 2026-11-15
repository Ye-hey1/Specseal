import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";

// 设备核准页（server-device-auth「核准页 session 保护且明确确认」, D3）。需已登录；
// GET 不查授权状态，只预填 URL 带入的设备码。用户提交后才得到明确的核准／拒绝确认
// 步骤；未登录导向登录页并保留设备码。

const MEMBER = {
  authenticated: true,
  user: { id: "u1", email: "member@example.com", display: "Member", admin: false },
  home: "/account",
};
const UNAUTH = { authenticated: false, user: null, home: "/login" };

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    getSession: vi.fn(async () => MEMBER),
    login: vi.fn(),
    logout: vi.fn(),
    getAdminOverview: vi.fn(),
    checkActivation: vi.fn(async () => ({ status: "pending" })),
    decideActivation: vi.fn(async () => ({ status: "approved" })),
    ...overrides,
  };
}

function renderAt(route: string, client: ReturnType<typeof makeClient>) {
  return render(<App client={client as never} initialEntries={[route]} />);
}

beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

describe("设备核准页", () => {
  it("预填 URL 带入的设备码，说明指向桌面 app 或 CLI", async () => {
    renderAt("/activate?user_code=ABCD-EFGH", makeClient());
    expect(await screen.findByDisplayValue("ABCD-EFGH")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "设备登录" })).toBeTruthy();
    expect(screen.getByRole("main").textContent).toContain("桌面 app 或 CLI");
  });

  it("代码无效时错误紧贴字段下方", async () => {
    const client = makeClient({ checkActivation: vi.fn(async () => Promise.reject(new Error("bad"))) });
    renderAt("/activate?user_code=ABCD-EFGH", client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /下一步/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("这个设备代码无法使用。");
    expect(screen.getByLabelText("设备代码").getAttribute("aria-describedby")).toBe(alert.id);
  });

  it("确认步骤显示大字代码与核准后的身分，「拒绝」「核准」在页脚", async () => {
    renderAt("/activate?user_code=ABCD-EFGH", makeClient());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /下一步/ }));
    expect(await screen.findByRole("heading", { level: 1, name: "核准这个设备？" })).toBeTruthy();
    expect(screen.getByText("ABCD-EFGH").className).toContain("text-[22px]");
    expect(screen.getByText("核准后以 Member（member@example.com）的身分登录")).toBeTruthy();
    const footer = screen.getByRole("button", { name: "核准" }).closest("[data-focus-footer]") as HTMLElement;
    expect(within(footer).getByRole("button", { name: "拒绝" })).toBeTruthy();
  });

  it("身分句把显示名称当字面文本代入（含 $& 也原样显示）", async () => {
    const session = { ...MEMBER, user: { ...MEMBER.user, display: "A$&B" } };
    renderAt("/activate?user_code=ABCD-EFGH", makeClient({ getSession: vi.fn(async () => session) }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /下一步/ }));
    expect(await screen.findByText("核准后以 A$&B（member@example.com）的身分登录")).toBeTruthy();
  });

  it("提交后才显示明确的核准／拒绝选项", async () => {
    const client = makeClient();
    renderAt("/activate?user_code=ABCD-EFGH", client);
    const user = userEvent.setup();
    // 核准／拒绝在确认步骤前不显示。
    await screen.findByDisplayValue("ABCD-EFGH");
    expect(screen.queryByRole("button", { name: /核准/ })).toBeNull();
    // 提交下一步：检查该码（不改状态），显示核准／拒绝。
    await user.click(screen.getByRole("button", { name: /下一步|确认/ }));
    await waitFor(() => expect(client.checkActivation).toHaveBeenCalledWith("ABCD-EFGH"));
    expect(await screen.findByRole("button", { name: /核准/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /拒绝/ })).toBeTruthy();
  });

  it("核准调用 decideActivation", async () => {
    const client = makeClient();
    renderAt("/activate?user_code=ABCD-EFGH", client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /下一步|确认/ }));
    await user.click(await screen.findByRole("button", { name: /核准/ }));
    await waitFor(() => expect(client.decideActivation).toHaveBeenCalledWith("ABCD-EFGH", "approve"));
  });

  // 结果页指引（server-device-auth「核准页 session 保护且明确确认」）：核准与拒绝
  // 两种结果都要告知可返回 Specseal app 继续，不止于单行结果。
  it.each([
    ["approve" as const, "approved" as const, /核准/],
    ["deny" as const, "denied" as const, /拒绝/],
  ])("%s 的结果页指引返回 app 继续", async (action, status, label) => {
    const client = makeClient({ decideActivation: vi.fn(async () => ({ status })) });
    renderAt("/activate?user_code=ABCD-EFGH", client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /下一步|确认/ }));
    await user.click(await screen.findByRole("button", { name: label }));
    await waitFor(() => expect(client.decideActivation).toHaveBeenCalledWith("ABCD-EFGH", action));
    expect(await screen.findByText(/回到 Specseal/)).toBeTruthy();
  });

  it("未登录导向登录页", async () => {
    renderAt("/activate?user_code=ABCD-EFGH", makeClient({ getSession: vi.fn(async () => UNAUTH) }));
    expect(await screen.findByRole("button", { name: /登录/ })).toBeTruthy();
  });
});
