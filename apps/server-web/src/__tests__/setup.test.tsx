import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";
import { WebApiError } from "../api/client";

// Setup 开箱流程（server-setup「setup 流程完成开箱四要素」, D2／D3／D8 第三阶段）。
// token 由 URL query 带入；两个提交节点（创建管理员、创建 Project／Repo）由 typed
// client 完成，最后节点回 `/admin?welcome=1` 与 connection，SPA 站内导向。

const UNAUTH = { authenticated: false, user: null, home: "/login" };

const STORE = {
  driver: "memory",
  contractVersion: 1,
  level: "full",
  capabilities: ["read", "write"],
  healthy: true,
  identitySchemaVersion: 1,
};

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    getSession: vi.fn(async () => UNAUTH),
    login: vi.fn(),
    logout: vi.fn(),
    getAdminOverview: vi.fn(),
    getSetupState: vi.fn(async () => ({ step: "admin", store: STORE })),
    submitSetupAdmin: vi.fn(async () => ({ step: "registry", store: STORE })),
    submitSetupRegistry: vi.fn(async () => ({
      destination: "/admin?welcome=1",
      connection: { publicUrl: "http://127.0.0.1", projectKey: "demo", repoKey: "backend" },
    })),
    ...overrides,
  };
}

function renderAt(route: string, client: ReturnType<typeof makeClient>) {
  return render(<App client={client as never} initialEntries={[route]} />);
}

/** 步骤条（design D7）：已到的段为主色。 */
function filledSteps() {
  const bar = screen.getByTestId("step-bar");
  return Array.from(bar.children).filter((seg) => seg.className.includes("bg-primary")).length;
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

describe("setup 开箱流程", () => {
  it("token 有效时显示创建管理员表单，卡片顶端标示步骤 1 / 2", async () => {
    renderAt("/setup?token=boot", makeClient());
    expect(await screen.findByRole("heading", { level: 1, name: "创建管理员帐号" })).toBeTruthy();
    expect(screen.getByText("初始设置 · 步骤 1 / 2")).toBeTruthy();
    expect(filledSteps()).toBe(1);
    expect(screen.getByLabelText(/email|电子邮件/i)).toBeTruthy();
    expect(screen.getByLabelText(/显示名称|display/i)).toBeTruthy();
    expect(screen.getByLabelText(/密码|password/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /创建管理员|下一步/ })).toBeTruthy();
  });

  it("创建管理员后进入 registry 步骤", async () => {
    const client = makeClient();
    renderAt("/setup?token=boot", client);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/email|电子邮件/i), "root@example.com");
    await user.type(screen.getByLabelText(/显示名称|display/i), "Root");
    await user.type(screen.getByLabelText(/密码|password/i), "hunter2password");
    await user.click(screen.getByRole("button", { name: /创建管理员|下一步/ }));
    await waitFor(() => expect(client.submitSetupAdmin).toHaveBeenCalledOnce());
    expect(client.submitSetupAdmin).toHaveBeenCalledWith(
      "boot",
      expect.objectContaining({ email: "root@example.com", display: "Root", password: "hunter2password" }),
    );
    // The registry step's project/repo fields appear.
    expect(await screen.findByRole("heading", { level: 1, name: "创建第一组项目与保存库" })).toBeTruthy();
    expect(screen.getByText("初始设置 · 步骤 2 / 2")).toBeTruthy();
    expect(filledSteps()).toBe(2);
    // 两个代号栏下方灰字说明「创建后不可变更。」，并以 aria-describedby 接到字段。
    for (const label of [/项目代号/, /保存库代号/]) {
      const input = screen.getByLabelText(label);
      const hint = document.getElementById(input.getAttribute("aria-describedby") ?? "");
      expect(hint?.textContent).toBe("创建后不可变更。");
    }
  });

  it("完成 registry 调用 submitSetupRegistry 并带正确参数", async () => {
    const client = makeClient({ getSetupState: vi.fn(async () => ({ step: "registry", store: STORE })) });
    renderAt("/setup?token=boot", client);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/项目代号/), "demo");
    await user.type(screen.getByLabelText(/保存库代号/), "backend");
    await user.click(screen.getByRole("button", { name: /创建|完成/ }));
    await waitFor(() => expect(client.submitSetupRegistry).toHaveBeenCalledOnce());
    expect(client.submitSetupRegistry).toHaveBeenCalledWith(
      "boot",
      expect.objectContaining({ projectKey: "demo", repoKey: "backend" }),
    );
  });

  it("字段验证失败以 role=alert 声明且保留非秘密输入", async () => {
    const client = makeClient({
      submitSetupAdmin: vi.fn(async () => {
        throw new WebApiError(400, "validation_error", "字段有误", { email: "email 格式不正确" });
      }),
    });
    renderAt("/setup?token=boot", client);
    const user = userEvent.setup();
    const email = await screen.findByLabelText(/email|电子邮件/i);
    await user.type(email, "bad");
    await user.type(screen.getByLabelText(/显示名称|display/i), "Root");
    await user.type(screen.getByLabelText(/密码|password/i), "pw");
    await user.click(screen.getByRole("button", { name: /创建管理员|下一步/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("email 格式不正确");
    expect((email as HTMLInputElement).value).toBe("bad");
  });

  it("无效 token 显示设置链接无效，不显示表单", async () => {
    const client = makeClient({
      getSetupState: vi.fn(async () => {
        throw new WebApiError(401, "invalid_setup_token", "设置链接无效");
      }),
    });
    renderAt("/setup?token=bad", client);
    // 提示卡只有警示图标、标题与说明，整块 role=alert，没有任何输入栏。
    const notice = await screen.findByRole("alert");
    expect(within(notice).getByRole("heading", { level: 1, name: "设置链接无效" })).toBeTruthy();
    expect(notice.querySelector("svg")?.getAttribute("class")).toContain("text-status-warning");
    expect(document.querySelectorAll("input")).toHaveLength(0);
  });
});
