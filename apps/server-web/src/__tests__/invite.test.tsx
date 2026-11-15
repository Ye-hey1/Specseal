import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";
import { WebApiError } from "../api/client";

// 邀请接受流程（server-identity「邀请一次性且到期失效」, D2／D3）。token 由 URL path
// 带入；有效邀请显示设置密码表单，提交后由 typed client 建帐号并自动登录，SPA 依
// Server 回传的 destination 导向；无效邀请显示不可区分的「邀请无效」且无表单。

const UNAUTH = { authenticated: false, user: null, home: "/login" };

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    getSession: vi.fn(async () => UNAUTH),
    login: vi.fn(),
    logout: vi.fn(),
    getAdminOverview: vi.fn(),
    getInvitation: vi.fn(async () => ({ email: "invitee@example.com", display: "Invitee", admin: false })),
    acceptInvitation: vi.fn(async () => ({ destination: "/account" })),
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

describe("邀请接受流程", () => {
  it("有效邀请显示 email 与设置密码表单", async () => {
    renderAt("/invite/tok123", makeClient());
    expect(await screen.findByRole("heading", { level: 1, name: "接受邀请" })).toBeTruthy();
    expect(screen.getByText("为 invitee@example.com 设置登录密码；创建后会直接登录。")).toBeTruthy();
    // 密码栏上方两列唯读信息：电子邮件与服务器。
    const info = screen.getByText("服务器").closest("dl") as HTMLElement;
    expect(within(info).getByText("电子邮件")).toBeTruthy();
    expect(within(info).getByText("invitee@example.com")).toBeTruthy();
    expect(within(info).getByText(window.location.host)).toBeTruthy();
    expect(screen.getByLabelText(/密码|password/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /创建帐号|接受邀请|设置密码/ })).toBeTruthy();
  });

  it("提交密码调用 acceptInvitation 并带 token 与密码", async () => {
    const acceptInvitation = vi.fn(async () => ({ destination: "/account" }));
    const client = makeClient({ acceptInvitation });
    renderAt("/invite/tok123", client);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/密码|password/i), "hunter2password");
    await user.click(screen.getByRole("button", { name: /创建帐号|接受邀请|设置密码/ }));
    await waitFor(() => expect(acceptInvitation).toHaveBeenCalledOnce());
    expect(acceptInvitation).toHaveBeenCalledWith(
      "tok123",
      expect.objectContaining({ password: "hunter2password" }),
    );
  });

  it("无效邀请显示邀请无效，且无设置密码表单", async () => {
    const client = makeClient({
      getInvitation: vi.fn(async () => {
        throw new WebApiError(404, "invalid_invitation", "邀请无效");
      }),
    });
    renderAt("/invite/bad", client);
    const notice = await screen.findByRole("alert");
    expect(within(notice).getByRole("heading", { level: 1, name: "邀请无效" })).toBeTruthy();
    expect(notice.querySelector("svg")?.getAttribute("class")).toContain("text-status-warning");
    expect(document.querySelectorAll("input")).toHaveLength(0);
  });

  it("接受失败的字段错误以 role=alert 声明", async () => {
    const client = makeClient({
      acceptInvitation: vi.fn(async () => {
        throw new WebApiError(400, "validation_error", "密码太短", { password: "密码至少 8 码" });
      }),
    });
    renderAt("/invite/tok123", client);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/密码|password/i), "x");
    await user.click(screen.getByRole("button", { name: /创建帐号|接受邀请|设置密码/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("密码至少 8 码");
  });
});
