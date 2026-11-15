// ProjectSettingsView（spec 需求「设置页图形化读写两层设置」「设置页编辑项目说明与产出规则」
// 的前端面；desktop-settings-mode design D8）：依项目设置分类渲染四页（项目说明、产出规则、
// 产出流程、.specseal.yaml），各页独立编辑态、解析失败页顶说明。
import { describe, it, expect, vi } from "vitest";
import { act, render as rtlRender, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactElement, type ReactNode } from "react";
import { I18nProvider, type ReviewRules } from "@specseal/ui";

import { ProjectSettingsView } from "../views/ProjectSettingsView";
import { APP_MESSAGES } from "../i18n/messages";
import type { SchemaEntry, SettingsSnapshot, SubagentModelConfig } from "../adapter/workspace";
import type { WorkspaceSettingsProvider } from "../session";
import type { ProjectSettingsSection } from "../settingsCatalog";
import { editorText, editorView, pressSave, typeInEditor } from "./helpers/codemirror";

const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN" messages={APP_MESSAGES}>
    {children}
  </I18nProvider>
);
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: zhWrapper });
}

/** 引擎提供的 12 个 smell 名称（快照 reviewBaselineSmells 的测试值）。 */
const SMELLS = ["Mysterious Name", "Duplicated Code", "Feature Envy", "Data Clumps", "Primitive Obsession", "Repeated Switches", "Shotgun Surgery", "Divergent Change", "Speculative Generality", "Message Chains", "Middle Man", "Refused Bequest"];

function snapshot(over: Partial<SettingsSnapshot> = {}): SettingsSnapshot {
  return {
    specDir: over.specDir ?? "specseal",
    app: { tools: ["claude"], customTools: [], parseError: null, ...(over.app ?? {}) },
    workflow: {
      locale: "tw",
      specLocale: null,
      tdd: true,
      audit: false,
      worktree: false,
      context: null,
      rules: {},
      review: { baseline: "extend", critical: [], warning: [], suggestion: [] },
      reviewBaselineSmells: SMELLS,
      subagentModel: { review: {}, verify: {}, choices: {} },
      builtinSubagentModels: { claude: ["sonnet", "opus", "haiku", "fable"] },
      schemaArtifacts: ["proposal", "design", "specs", "tasks"],
      schemaName: "spec-driven",
      schemaKnown: true,
      parseError: null,
      ...(over.workflow ?? {}),
    },
  };
}

/** 活跃 session 的设置面 mock（workspace-session 决策 3：root 已绑定）。 */
function fakeSettings(snap: SettingsSnapshot): WorkspaceSettingsProvider {
  return {
    kind: "local",
    policyWrite: true,
    readSettings: vi.fn().mockResolvedValue(snap),
    writeAppTools: vi.fn().mockResolvedValue(undefined),
    writeWorkflowConfig: vi.fn().mockResolvedValue(undefined),
    writeWorkflowContext: vi.fn().mockResolvedValue(undefined),
    writeWorkflowRules: vi.fn().mockResolvedValue(undefined),
    writeWorkflowReview: vi.fn().mockResolvedValue(undefined),
    writeWorkflowSubagentModel: vi.fn().mockResolvedValue(undefined),
    readSchemas: vi.fn().mockResolvedValue([]),
    writeWorkflowSchema: vi.fn().mockResolvedValue(undefined),
    forkSchema: vi.fn().mockResolvedValue("spec-driven-custom"),
    createSchema: vi.fn().mockResolvedValue(undefined),
    revealSchema: vi.fn().mockResolvedValue(undefined),
    deleteSchema: vi.fn().mockResolvedValue(undefined),
  } as unknown as WorkspaceSettingsProvider;
}

/** 分类栏的替身：所在分类放在 state，goto 切页（状态与草稿跨页保留）。 */
const nav = { goto: (_section: ProjectSettingsSection) => {} };
function Harness({
  settings,
  initial = "context",
  onParseErrors,
  onDirtyChange,
}: {
  settings: WorkspaceSettingsProvider;
  initial?: ProjectSettingsSection;
  onParseErrors?: (errors: { config: boolean; specseal: boolean }) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [section, setSection] = useState<ProjectSettingsSection>(initial);
  nav.goto = setSection;
  return (
    <ProjectSettingsView
      settings={settings}
      section={section}
      onParseErrors={onParseErrors}
      onDirtyChange={onDirtyChange}
    />
  );
}
function goto(section: ProjectSettingsSection) {
  act(() => nav.goto(section));
}

function renderView(snap: SettingsSnapshot, initial: ProjectSettingsSection = "context") {
  const ws = fakeSettings(snap);
  render(<Harness settings={ws} initial={initial} />);
  return ws;
}

function projectSnap(over: Partial<SettingsSnapshot["workflow"]> = {}) {
  return snapshot({
    workflow: {
      locale: "tw",
      specLocale: null,
      tdd: true,
      audit: false,
      worktree: false,
      context: "# 项目简介\n\n这是一段说明",
      rules: { proposal: ["提案必须列出影响的 crates"], tasks: ["先写失败测试", "更新文档"] },
      schemaArtifacts: ["proposal", "design", "specs", "tasks"],
      parseError: null,
      ...over,
    },
  });
}

describe("ProjectSettingsView 加载", () => {
  it("呈现两档现值：产出流程页的政策字段、.specseal.yaml 页的 tools 开关；未设置字段呈缺省状态", async () => {
    renderView(snapshot(), "workflow");
    // 下拉是 Radix Select（非原生 select），现值读 trigger 上显示的文本。
    expect((await screen.findByLabelText("locale")).textContent).toContain("tw");
    // 未设置的 spec_locale 呈默认值状态（空字符串＝未设置）。
    expect(screen.getByLabelText("spec_locale").textContent).toContain("未设置");
    // tdd／audit 为列右侧开关（role="switch"）。
    expect(screen.getByRole("switch", { name: "tdd" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: "audit" }).getAttribute("aria-checked")).toBe("false");
    goto("specseal");
    expect(screen.getByLabelText("claude").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByLabelText("codex").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByLabelText("copilot").getAttribute("aria-checked")).toBe("false");
    // AI 工具卡的五个开关依 claude、codex、copilot、pi、cursor 顺序出现。
    const tools = ["claude", "codex", "copilot", "pi", "cursor"].map((name) => screen.getByLabelText(name));
    expect(tools.map((el) => el.getAttribute("aria-checked"))).toEqual(["true", "false", "false", "false", "false"]);
    for (let i = 1; i < tools.length; i += 1) {
      expect(
        tools[i - 1].compareDocumentPosition(tools[i]) & Node.DOCUMENT_POSITION_FOLLOWING,
        `${tools[i].getAttribute("aria-label") ?? i} 排在前一个工具之后`,
      ).toBeTruthy();
    }
  });

  it("自订工具描述子呈现为不可编辑项", async () => {
    renderView(snapshot({ app: { tools: ["claude"], customTools: ["wad-harness"], parseError: null } }), "specseal");
    const custom = await screen.findByText("wad-harness");
    // 不可编辑：非表单输入（无对应开关）。
    expect(screen.queryByRole("switch", { name: "wad-harness" })).toBeNull();
    expect(custom).toBeTruthy();
  });
});

describe("政策下拉未知值显性呈现", () => {
  // spec 需求「设置页政策下拉的未知值显性呈现」（workflow-config-locale-validation）：
  // 选项集外的保存值不得静默空白，也不得于读取时被改写。
  it("保存值不在选项集 → 下拉显示原始值与无效标注、字段下方浮出引导提示", async () => {
    const ws = renderView(projectSnap({ locale: "繁体中文", specLocale: "zh-Hant" }), "workflow");
    const locale = await screen.findByLabelText("locale");
    expect(locale.textContent).toContain("繁体中文");
    expect(locale.textContent).toContain("无效");
    const specLocale = screen.getByLabelText("spec_locale");
    expect(specLocale.textContent).toContain("zh-Hant");
    expect(specLocale.textContent).toContain("无效");
    const localeHint = screen.getByTestId("locale-invalid-hint");
    for (const code of ["tw", "ja", "en"]) {
      expect(localeHint.textContent).toContain(code);
    }
    expect(screen.getByTestId("spec-locale-invalid-hint").textContent).toContain("auto");
    // 读取不改写：未按保存前不得有任何写入。
    expect(ws.writeWorkflowConfig).not.toHaveBeenCalled();
  });

  it("合法值与未设置 → 无任何无效标注或提示", async () => {
    renderView(projectSnap({ locale: "tw", specLocale: null }), "workflow");
    expect((await screen.findByLabelText("locale")).textContent).not.toContain("无效");
    expect(screen.getByLabelText("spec_locale").textContent).not.toContain("无效");
    expect(screen.queryByTestId("locale-invalid-hint")).toBeNull();
    expect(screen.queryByTestId("spec-locale-invalid-hint")).toBeNull();
  });
});

describe("ProjectSettingsView 写入", () => {
  it("tools 加选 codex 后保存 → writeAppTools 收到完整选集", async () => {
    const ws = renderView(snapshot(), "specseal");
    fireEvent.click(await screen.findByLabelText("codex"));
    fireEvent.click(screen.getByTestId("save-app"));
    await waitFor(() => expect(ws.writeAppTools).toHaveBeenCalledWith(["claude", "codex"]));
  });

  it("tools 加选 copilot 后保存 → writeAppTools 收到完整选集", async () => {
    // spec「设置页图形化读写两层设置」：AI 工具卡多选含 copilot。
    const ws = renderView(snapshot(), "specseal");
    fireEvent.click(await screen.findByLabelText("copilot"));
    fireEvent.click(screen.getByTestId("save-app"));
    await waitFor(() => expect(ws.writeAppTools).toHaveBeenCalledWith(["claude", "copilot"]));
  });

  it("tools 加选 pi 与 cursor 后保存 → writeAppTools 收到完整选集", async () => {
    // spec「设置页图形化读写两层设置」：AI 工具卡多选含 pi、cursor。
    const ws = renderView(snapshot(), "specseal");
    fireEvent.click(await screen.findByLabelText("pi"));
    fireEvent.click(screen.getByLabelText("cursor"));
    fireEvent.click(screen.getByTestId("save-app"));
    await waitFor(() => expect(ws.writeAppTools).toHaveBeenCalledWith(["claude", "pi", "cursor"]));
  });

  it("audit 切开后保存 → writeWorkflowConfig 收到完整目标状态（含读入现值）", async () => {
    const ws = renderView(snapshot(), "workflow");
    fireEvent.click(await screen.findByLabelText("audit"));
    fireEvent.click(screen.getByTestId("save-workflow"));
    await waitFor(() =>
      expect(ws.writeWorkflowConfig).toHaveBeenCalledWith({
        locale: "tw",
        specLocale: null,
        tdd: true,
        audit: true,
        worktree: false,
      }),
    );
  });

  it("worktree 开关切开后保存 → writeWorkflowConfig 收到实值（不再恒为 false）", async () => {
    const ws = renderView(snapshot(), "workflow");
    fireEvent.click(await screen.findByLabelText("worktree"));
    fireEvent.click(screen.getByTestId("save-workflow"));
    await waitFor(() =>
      expect(ws.writeWorkflowConfig).toHaveBeenCalledWith({
        locale: "tw",
        specLocale: null,
        tdd: true,
        audit: false,
        worktree: true,
      }),
    );
  });

  it("worktree 开关加载时反映 config 现值", async () => {
    renderView(snapshot({ workflow: { worktree: true } } as Partial<SettingsSnapshot>), "workflow");
    const box = (await screen.findByLabelText("worktree")) as HTMLElement;
    await waitFor(() => expect(box.getAttribute("data-state")).toBe("checked"));
  });

  it("关闭遇活跃 worktree → 挡下消息浮出且开关回复打开", async () => {
    const ws = renderView(snapshot({ workflow: { worktree: true } } as Partial<SettingsSnapshot>), "workflow");
    const blocked =
      "add-auth 正在 worktree（specseal/add-auth）中进行，请先运行 specseal-worktree-merge 收尾再操作。";
    (ws.writeWorkflowConfig as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error(blocked));

    const box = (await screen.findByLabelText("worktree")) as HTMLElement;
    fireEvent.click(box);
    fireEvent.click(screen.getByTestId("save-workflow"));

    expect(await screen.findByText(new RegExp("specseal-worktree-merge"))).toBeTruthy();
    await waitFor(() => expect(box.getAttribute("data-state")).toBe("checked"));
  });

  it("技能同步失败（config 已写入）→ 开关维持新值，再存不回写旧值", async () => {
    // 同步失败的半套状态：config 为正典（新值已落档）、技能足迹过期。画面
    // 不得退回旧快照——否则下次保存会静默把政策写回去（连技能一起收走）。
    const ws = renderView(snapshot(), "workflow");
    (ws.writeWorkflowConfig as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("workflow config written, but the skill footprint did not sync — run `specseal update` to rebuild"),
    );
    (ws.readSettings as ReturnType<typeof vi.fn>).mockResolvedValue(
      snapshot({ workflow: { worktree: true } } as Partial<SettingsSnapshot>),
    );

    const box = (await screen.findByLabelText("worktree")) as HTMLElement;
    fireEvent.click(box);
    fireEvent.click(screen.getByTestId("save-workflow"));

    expect(await screen.findByText(/did not sync/)).toBeTruthy();
    await waitFor(() => expect(box.getAttribute("data-state")).toBe("checked"));

    fireEvent.click(screen.getByTestId("save-workflow"));
    await waitFor(() =>
      expect(ws.writeWorkflowConfig).toHaveBeenLastCalledWith(
        expect.objectContaining({ worktree: true }),
      ),
    );
  });

  it("remote 存盘失败（非 conflict）→ 不重读设置，revision 维持旧值", async () => {
    // remote adapter 的 readSettings 会静默采纳最新 revision；失败后重读等于
    // 让下一次保存带最新 revision 提交过期字段值，绕过 409 冲突对话框静默
    // 覆盖他人并发修改。失败重读是 local 的 worktree 半套语意，remote 不适用。
    const snap = snapshot();
    const ws = {
      kind: "remote",
      policyWrite: true,
      readSettings: vi.fn().mockResolvedValue(snap),
      writeAppTools: vi.fn().mockResolvedValue(undefined),
      writeWorkflowConfig: vi.fn().mockRejectedValueOnce(new Error("server unreachable")),
      writeWorkflowContext: vi.fn().mockResolvedValue(undefined),
      writeWorkflowRules: vi.fn().mockResolvedValue(undefined),
      readSchemas: vi.fn().mockResolvedValue([]),
      writeWorkflowSchema: vi.fn().mockResolvedValue(undefined),
      forkSchema: vi.fn().mockRejectedValue(new Error("远程工作区尚不支持 fork 产出流程")),
      createSchema: vi.fn().mockRejectedValue(new Error("远程工作区尚不支持创建产出流程")),
      revealSchema: vi.fn().mockRejectedValue(new Error("远程工作区没有本机文档可显示")),
      deleteSchema: vi.fn().mockRejectedValue(new Error("远程工作区尚不支持删除产出流程")),
    } as unknown as WorkspaceSettingsProvider;
    render(<Harness settings={ws} initial="workflow" />);

    fireEvent.click(await screen.findByLabelText("audit"));
    fireEvent.click(screen.getByTestId("save-workflow"));

    expect(await screen.findByText(/server unreachable/)).toBeTruthy();
    expect(ws.readSettings).toHaveBeenCalledTimes(1);
  });

  it("locale 下拉改值后保存 → 新值进完整目标状态；设回未设置送 null", async () => {
    const ws = renderView(snapshot(), "workflow");
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(await screen.findByLabelText("locale"));
    await user.click(await screen.findByRole("option", { name: /未设置/ }));
    fireEvent.click(screen.getByTestId("save-workflow"));
    await waitFor(() =>
      expect(ws.writeWorkflowConfig).toHaveBeenCalledWith({
        locale: null,
        specLocale: null,
        tdd: true,
        audit: false,
        worktree: false,
      }),
    );
  });

  it("写入失败：显示单行错误消息", async () => {
    const ws = renderView(snapshot(), "workflow");
    (ws.writeWorkflowConfig as ReturnType<typeof vi.fn>).mockRejectedValue(
      "specseal/config.yaml: write failed: denied",
    );
    fireEvent.click(await screen.findByLabelText("tdd"));
    fireEvent.click(screen.getByTestId("save-workflow"));
    expect(await screen.findByText(/write failed/)).toBeTruthy();
  });
});

// ---- 分类页组织（spec 需求「设置页图形化读写两层设置」；desktop-settings-mode design D8）----

describe("文档注记依实际规格文档夹（spec「画面依实际规格文档夹与数据文档名显示」）", () => {
  it("暂缓迁移的旧布局项目：产出规则页注记为 openspec/config.yaml · rules", async () => {
    const ws = fakeSettings({ ...projectSnap(), specDir: "openspec" });
    render(<Harness settings={ws} initial="rules" />);
    await screen.findByTestId("rules-page");
    expect(screen.getByTestId("file-note-config").textContent).toBe("openspec/config.yaml · rules");
  });

  it("明写 spec_dir：注记为该路径", async () => {
    renderView({ ...projectSnap(), specDir: "docs/specs" }, "workflow");
    await screen.findByTestId("file-note-config");
    expect(screen.getByTestId("file-note-config").textContent).toMatch(/^docs\/specs\/config\.yaml · /);
  });
});

describe("项目设置分类页（spec Scenario「两种设置模式与缺省分类」）", () => {
  it("项目说明页标题下等宽注记文档与键；产出流程页依序为产出政策卡与产出流程卡；.specseal.yaml 页有文档列与 AI 工具卡", async () => {
    renderView(projectSnap());
    const page = await screen.findByTestId("context-page");
    expect(within(page).getByRole("heading", { level: 2, name: "项目说明" })).toBeTruthy();
    // spec Scenario「新布局项目的文档注记」。
    const note = screen.getByTestId("file-note-config");
    expect(note.textContent).toBe("specseal/config.yaml · context");
    expect(note.className).toContain("font-mono");
    // 其他页的内容不在画面上。
    expect(screen.queryByTestId("policy-card")).toBeNull();
    expect(screen.queryByLabelText("claude")).toBeNull();

    goto("rules");
    expect(screen.getByTestId("file-note-config").textContent).toBe("specseal/config.yaml · rules");

    goto("workflow");
    const regions = screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));
    expect(regions).toEqual(["产出政策", "产出流程"]);
    expect(screen.getByRole("heading", { level: 2, name: "产出流程" })).toBeTruthy();
    // 项目说明页与产出规则页不含产出流程内容（spec「产出流程页」）。
    expect(screen.queryByTestId("context-page")).toBeNull();

    goto("specseal");
    expect(screen.getByRole("region", { name: "AI 工具" })).toBeTruthy();
    expect(screen.getByLabelText("claude").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("file-note-specseal").className).toContain("font-mono");
  });

  it("AI 工具页：页标题「AI 工具」、注记 .specseal.yaml · tools，没有「设置档」卡与「文档」列", async () => {
    // spec「设置页图形化读写两层设置」：设置档路径只留在页标题下的等宽注记。
    renderView(projectSnap(), "specseal");
    expect(await screen.findByRole("heading", { level: 2, name: "AI 工具" })).toBeTruthy();
    expect(screen.getByTestId("file-note-specseal").textContent).toBe(".specseal.yaml · tools");
    expect(screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(["AI 工具"]);
    expect(screen.queryByTestId("specseal-file-path")).toBeNull();
    expect(screen.queryByRole("group", { name: "文档" })).toBeNull();
  });

  it("tdd 以开关呈现，切换后存盘写回 true", async () => {
    const ws = renderView(snapshot({ workflow: { tdd: false } } as Partial<SettingsSnapshot>), "workflow");
    const tdd = await screen.findByRole("switch", { name: "tdd" });
    expect(tdd.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(tdd);
    fireEvent.click(screen.getByTestId("save-workflow"));
    await waitFor(() =>
      expect(ws.writeWorkflowConfig).toHaveBeenCalledWith(expect.objectContaining({ tdd: true })),
    );
  });

  it("config.yaml 解析失败：回报分类栏警示、三页浮出解析失败说明（红）、表单与编辑钮停用", async () => {
    const onParseErrors = vi.fn();
    const ws = fakeSettings(
      projectSnap({ context: null, rules: {}, schemaArtifacts: [], parseError: "invalid yaml at line 3" }),
    );
    render(<Harness settings={ws} onParseErrors={onParseErrors} />);
    await waitFor(() => expect(onParseErrors).toHaveBeenLastCalledWith({ config: true, specseal: false }));
    // spec「错误态以红呈现」：解析失败是错误（表单因此停用），不是琥珀提醒。
    const banner = (await screen.findByText(/invalid yaml at line 3/)).closest("p") as HTMLElement;
    expect(banner.className).toContain("destructive");
    expect(banner.className).not.toContain("status-warning");
    expect((screen.getByTestId("context-edit") as HTMLButtonElement).disabled).toBe(true);
    goto("rules");
    expect(screen.getByText(/invalid yaml at line 3/)).toBeTruthy();
    expect((screen.getByTestId("rules-edit") as HTMLButtonElement).disabled).toBe(true);
    goto("workflow");
    expect(screen.getByText(/invalid yaml at line 3/)).toBeTruthy();
    expect((screen.getByTestId("save-workflow") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("tdd") as HTMLButtonElement).disabled).toBe(true);
  });

  it("卸载时清掉回报：分类栏不沿用上一个项目的警示点，返回也不再问未存修改", async () => {
    const onParseErrors = vi.fn();
    const onDirtyChange = vi.fn();
    const ws = fakeSettings(projectSnap({ parseError: "invalid yaml at line 3" }));
    const { unmount } = render(<Harness settings={ws} onParseErrors={onParseErrors} onDirtyChange={onDirtyChange} />);
    await waitFor(() => expect(onParseErrors).toHaveBeenLastCalledWith({ config: true, specseal: false }));
    unmount();
    expect(onParseErrors).toHaveBeenLastCalledWith({ config: false, specseal: false });
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it(".specseal.yaml 解析失败：回报分类栏警示、AI 工具表单停用；产出流程页表单照常可用", async () => {
    const onParseErrors = vi.fn();
    const ws = fakeSettings(snapshot({ app: { tools: [], customTools: [], parseError: "bad tools yaml" } }));
    render(<Harness settings={ws} initial="workflow" onParseErrors={onParseErrors} />);
    await waitFor(() => expect(onParseErrors).toHaveBeenLastCalledWith({ config: false, specseal: true }));
    expect((screen.getByTestId("save-workflow") as HTMLButtonElement).disabled).toBe(false);
    goto("specseal");
    expect(await screen.findByText(/bad tools yaml/)).toBeTruthy();
    expect((screen.getByTestId("save-app") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("claude") as HTMLButtonElement).disabled).toBe(true);
  });
});

// ---- 项目说明卡／产出规则卡（spec 需求「设置页编辑项目说明与产出规则」；design D2）----

// 未存修改回报（App 的返回动作据此先问要不要舍弃）：表单值对照文档现值，
// 文本卡只看编辑中的草稿；保存成功即回到 false。
describe("未存修改回报", () => {
  const dirtyHarness = (initial: ProjectSettingsSection) => {
    const onDirtyChange = vi.fn();
    const ws = fakeSettings(projectSnap());
    render(<Harness settings={ws} initial={initial} onDirtyChange={onDirtyChange} />);
    return onDirtyChange;
  };

  it("改政策开关即 true，保存成功后回 false", async () => {
    const onDirtyChange = dirtyHarness("workflow");
    await screen.findByTestId("save-workflow");
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByLabelText("tdd"));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    fireEvent.click(screen.getByTestId("save-workflow"));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });

  it("勾选 AI 工具即 true，保存成功后回 false", async () => {
    const onDirtyChange = dirtyHarness("specseal");
    fireEvent.click(await screen.findByLabelText("codex"));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    fireEvent.click(screen.getByTestId("save-app"));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });

  it("项目说明只开编辑为 false，改了草稿为 true，取消后回 false", async () => {
    const onDirtyChange = dirtyHarness("context");
    fireEvent.click(await screen.findByTestId("context-edit"));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    typeInEditor(screen.getByTestId("context-input"), "改过");
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    fireEvent.click(screen.getByTestId("context-cancel"));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });

  it("产出规则改了草稿为 true", async () => {
    const onDirtyChange = dirtyHarness("rules");
    fireEvent.click(await screen.findByTestId("rules-edit"));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    typeInEditor(screen.getByTestId("rules-input-tasks"), "只留一条");
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
  });
});

describe("两卡唯读优先（spec Scenario「唯读优先与各卡就地编辑」）", () => {
  it("打开项目说明页：唯读 markdown 渲染、无文本区、页标题右侧仅编辑", async () => {
    renderView(projectSnap());
    const card = await screen.findByTestId("context-page");
    expect(within(card).getByText("项目说明")).toBeTruthy();
    // markdown 渲染：# 标题成为 heading，而非 raw 文本区。
    expect(within(card).getByRole("heading", { name: "项目简介" })).toBeTruthy();
    expect(within(card).queryAllByRole("textbox")).toHaveLength(0);
    // 唯读态按钮列：仅编辑，无取消/保存。
    expect(within(card).getByTestId("context-edit")).toBeTruthy();
    expect(within(card).queryByTestId("context-save")).toBeNull();
    expect(within(card).queryByTestId("context-cancel")).toBeNull();
  });

  it("超长项目说明呈现全文、无显示更多（项目说明自成一页，不收合）", async () => {
    const longContext = Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 段说明`).join("\n\n");
    renderView(projectSnap({ context: longContext }));
    const card = await screen.findByTestId("context-page");
    expect(within(card).getByText("第 20 段说明")).toBeTruthy();
    expect(within(card).queryByText("显示更多")).toBeNull();
    expect(card.querySelector(".overflow-hidden")).toBeNull();
  });

  it("未设置项目说明显示空状态提示", async () => {
    renderView(projectSnap({ context: null }));
    const card = await screen.findByTestId("context-page");
    expect(within(card).getByText(/尚未设置项目说明/)).toBeTruthy();
  });

  it("产出规则卡唯读仅列有条目键，键名为小节标题、条目为清单", async () => {
    renderView(projectSnap(), "rules");
    const card = await screen.findByTestId("rules-page");
    expect(within(card).getByRole("heading", { level: 2, name: "产出规则" })).toBeTruthy();
    expect(within(card).getByTestId("rules-readonly-proposal")).toBeTruthy();
    // 键名等宽，旁附条数。
    expect(within(card).getByTestId("rules-readonly-tasks").textContent).toContain("2 条");
    const tasks = within(card).getByTestId("rules-readonly-tasks");
    expect(within(tasks).getByText("先写失败测试")).toBeTruthy();
    expect(within(tasks).getByText("更新文档")).toBeTruthy();
    // 无条目的键不列出；唯读态无任何输入框。
    expect(within(card).queryByTestId("rules-readonly-design")).toBeNull();
    expect(within(card).queryByTestId("rules-readonly-specs")).toBeNull();
    expect(within(card).queryAllByRole("textbox")).toHaveLength(0);
  });
});

describe("拆卡独立编辑态（spec 需求「设置页编辑项目说明与产出规则」；design D2）", () => {
  it("点编辑就地切换：按钮列变「编辑／预览」切换＋取消＋保存 ⌘S，内容卡换成 markdown 编辑器（spec Scenario「唯读优先与各页独立编辑」）", async () => {
    renderView(projectSnap());
    const card = await screen.findByTestId("context-page");
    fireEvent.click(within(card).getByTestId("context-edit"));
    expect(within(card).queryByTestId("context-edit")).toBeNull();
    expect(within(card).getByTestId("context-cancel")).toBeTruthy();
    expect(within(within(card).getByTestId("context-save")).getByText("Ctrl+S")).toBeTruthy();
    expect(within(card).getByRole("tab", { name: "编辑" }).getAttribute("aria-selected")).toBe("true");
    expect(within(card).getByRole("tab", { name: "预览" })).toBeTruthy();
    const input = within(card).getByTestId("context-input");
    expect(input.querySelector(".cm-editor")).not.toBeNull();
    expect(input.querySelector(".cm-lineNumbers")).not.toBeNull();
    expect(within(card).getByText("markdown · 自动换行")).toBeTruthy();
    expect(editorText(input)).toBe("# 项目简介\n\n这是一段说明");
  });

  it("编辑与预览切换保留草稿与光标，期间不写入（spec Scenario「编辑与预览切换保留草稿」）", async () => {
    const ws = renderView(projectSnap());
    const card = await screen.findByTestId("context-page");
    fireEvent.click(within(card).getByTestId("context-edit"));
    const input = within(card).getByTestId("context-input");
    typeInEditor(input, "# 草稿标题\n- 第一项\n- 第二项");
    const view = editorView(input);
    act(() => view.dispatch({ selection: { anchor: 4 } }));
    const user = userEvent.setup();
    await user.click(within(card).getByRole("tab", { name: "预览" }));
    expect(input.hidden).toBe(true);
    const preview = within(card).getByTestId("context-preview");
    expect(within(preview).getByRole("heading", { name: "草稿标题" })).toBeTruthy();
    expect(within(preview).getByText("第二项")).toBeTruthy();
    await user.click(within(card).getByRole("tab", { name: "编辑" }));
    expect(input.hidden).toBe(false);
    expect(editorText(input)).toBe("# 草稿标题\n- 第一项\n- 第二项");
    expect(view.state.selection.main.head).toBe(4);
    expect(ws.writeWorkflowContext).not.toHaveBeenCalled();
  });

  it("⌘S 保存写入原字符串：两层缩进与档尾换行保留，只写一次（spec Scenario「编辑项目说明并保存」）", async () => {
    const ws = renderView(projectSnap());
    const card = await screen.findByTestId("context-page");
    fireEvent.click(within(card).getByTestId("context-edit"));
    const draft = "# 规范\n\n- 第一层\n  - 第二层\n    - 第三层\n";
    typeInEditor(within(card).getByTestId("context-input"), draft);
    pressSave(within(card).getByTestId("context-input"));
    await waitFor(() => expect(ws.writeWorkflowContext).toHaveBeenCalledWith(draft));
    expect(ws.writeWorkflowContext).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(within(card).getByTestId("context-edit")).toBeTruthy());
  });

  it("焦点在编辑器外（预览中）按 ⌘S 也触发保存", async () => {
    const ws = renderView(projectSnap());
    const card = await screen.findByTestId("context-page");
    fireEvent.click(within(card).getByTestId("context-edit"));
    typeInEditor(within(card).getByTestId("context-input"), "预览中保存");
    await userEvent.setup().click(within(card).getByRole("tab", { name: "预览" }));
    fireEvent.keyDown(document.body, { key: "s", ctrlKey: true });
    await waitFor(() => expect(ws.writeWorkflowContext).toHaveBeenCalledWith("预览中保存"));
    expect(ws.writeWorkflowContext).toHaveBeenCalledTimes(1);
  });

  it("保存进行中保存钮停用，再按 ⌘S 不重送", async () => {
    const ws = renderView(projectSnap());
    (ws.writeWorkflowContext as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    const card = await screen.findByTestId("context-page");
    fireEvent.click(within(card).getByTestId("context-edit"));
    fireEvent.click(within(card).getByTestId("context-save"));
    await waitFor(() =>
      expect((within(card).getByTestId("context-save") as HTMLButtonElement).disabled).toBe(true),
    );
    expect(editorView(within(card).getByTestId("context-input")).state.readOnly).toBe(true);
    pressSave(within(card).getByTestId("context-input"));
    expect(ws.writeWorkflowContext).toHaveBeenCalledTimes(1);
  });

  it("保存中切到别页再切回，⌘S 与保存钮都不重送（写入中状态跨页保留）", async () => {
    const ws = renderView(projectSnap());
    (ws.writeWorkflowContext as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    const card = await screen.findByTestId("context-page");
    fireEvent.click(within(card).getByTestId("context-edit"));
    fireEvent.click(within(card).getByTestId("context-save"));
    goto("rules");
    goto("context");
    pressSave(screen.getByTestId("context-input"));
    fireEvent.click(screen.getByTestId("context-save"));
    expect(ws.writeWorkflowContext).toHaveBeenCalledTimes(1);
  });

  it("产出规则保存中编辑器唯读、保存钮停用，再按 ⌘S 不重送", async () => {
    const ws = renderView(projectSnap(), "rules");
    (ws.writeWorkflowRules as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    const card = await screen.findByTestId("rules-page");
    fireEvent.click(within(card).getByTestId("rules-edit"));
    pressSave(within(card).getByTestId("rules-input-tasks"));
    await waitFor(() =>
      expect((within(card).getByTestId("rules-save") as HTMLButtonElement).disabled).toBe(true),
    );
    expect(editorView(within(card).getByTestId("rules-input-tasks")).state.readOnly).toBe(true);
    pressSave(within(card).getByTestId("rules-input-tasks"));
    expect(ws.writeWorkflowRules).toHaveBeenCalledTimes(1);
  });

  // spec「表单控制项与按钮以主题化组件呈现」Scenario「设置页编辑器主题化」
  it("设置页编辑器外壳取用设计 token（边框、底色、focus 环）", async () => {
    renderView(projectSnap());
    const ctxCard = await screen.findByTestId("context-page");
    fireEvent.click(within(ctxCard).getByTestId("context-edit"));
    const ctxShell = within(ctxCard).getByTestId("context-input").querySelector('[data-slot="code-editor"]')!;
    expect(ctxShell.className).toContain("border-border");
    expect(ctxShell.className).toContain("bg-card");
    expect(ctxShell.className).toContain("focus-within:ring");
    goto("rules");
    const rulesCard = screen.getByTestId("rules-page");
    fireEvent.click(within(rulesCard).getByTestId("rules-edit"));
    const rulesInput = within(rulesCard).getByTestId("rules-input-tasks");
    const rulesShell = rulesInput.querySelector('[data-slot="code-editor"]')!;
    expect(rulesShell.className).toContain("border-border");
    expect(rulesShell.className).toContain("bg-card");
    expect(rulesShell.className).toContain("focus-within:ring");
    expect(within(rulesInput).getByText("纯文本 · 自动换行")).toBeTruthy();
  });

  it("一页编辑中另一页唯读可用；各页取消仅还原本页且草稿重设（spec Scenario「唯读优先与各页独立编辑」）", async () => {
    const ws = renderView(projectSnap());
    const ctxPage = () => screen.getByTestId("context-page");
    const rulesPage = () => screen.getByTestId("rules-page");
    await screen.findByTestId("context-page");
    fireEvent.click(within(ctxPage()).getByTestId("context-edit"));
    typeInEditor(within(ctxPage()).getByTestId("context-input"), "编辑中的说明");
    // 切到产出规则页：维持唯读且编辑钮仍可用。
    goto("rules");
    expect(within(rulesPage()).queryAllByRole("textbox")).toHaveLength(0);
    const rulesEdit = within(rulesPage()).getByTestId("rules-edit") as HTMLButtonElement;
    expect(rulesEdit.disabled).toBe(false);
    // 两页可同时各持编辑态。
    fireEvent.click(rulesEdit);
    typeInEditor(within(rulesPage()).getByTestId("rules-input-tasks"), "被放弃");
    // 取消产出规则：仅该页还原，项目说明页编辑态与草稿不受影响。
    fireEvent.click(within(rulesPage()).getByTestId("rules-cancel"));
    expect(within(rulesPage()).queryAllByRole("textbox")).toHaveLength(0);
    goto("context");
    expect(editorText(within(ctxPage()).getByTestId("context-input"))).toBe("编辑中的说明");
    expect(ws.writeWorkflowContext).not.toHaveBeenCalled();
    expect(ws.writeWorkflowRules).not.toHaveBeenCalled();
    // 重进产出规则编辑：草稿为读入值，非被放弃的修改。
    goto("rules");
    fireEvent.click(within(rulesPage()).getByTestId("rules-edit"));
    expect(editorText(within(rulesPage()).getByTestId("rules-input-tasks"))).toBe(
      "先写失败测试\n更新文档",
    );
  });

  it("编辑态产出规则文本区恰为活跃 schema 固定键各一、值为条目换行串接、无自由键输入", async () => {
    // spec Scenario「固定键分节不可自由输入」。
    renderView(projectSnap(), "rules");
    const card = await screen.findByTestId("rules-page");
    fireEvent.click(within(card).getByTestId("rules-edit"));
    for (const id of ["proposal", "design", "specs", "tasks"]) {
      expect(within(card).getByTestId(`rules-input-${id}`)).toBeTruthy();
    }
    expect(within(card).getAllByRole("textbox")).toHaveLength(4);
    expect(editorText(within(card).getByTestId("rules-input-tasks"))).toBe(
      "先写失败测试\n更新文档",
    );
    expect(editorText(within(card).getByTestId("rules-input-design"))).toBe("");
  });

  it("编辑态每个固定键一张小卡：等宽键名＋「N 条」计数＋纯文本编辑器，保存钮标示 ⌘S", async () => {
    renderView(projectSnap(), "rules");
    const card = await screen.findByTestId("rules-page");
    fireEvent.click(within(card).getByTestId("rules-edit"));
    const expected = { proposal: "1 条", design: "0 条", specs: "0 条", tasks: "2 条" };
    for (const [id, count] of Object.entries(expected)) {
      const section = within(card).getByTestId(`rules-input-${id}`);
      expect(within(section).getByText(id).className).toContain("font-mono");
      expect(within(section).getByTestId(`rules-count-${id}`).textContent).toBe(count);
      expect(section.querySelector(".cm-editor")).not.toBeNull();
    }
    expect(within(within(card).getByTestId("rules-save")).getByText("Ctrl+S")).toBeTruthy();
  });

  it("产出规则条数即时计数，空行不计；⌘S 写回恰为三条（spec Scenario「产出规则条数即时计数」）", async () => {
    const ws = renderView(projectSnap(), "rules");
    const card = await screen.findByTestId("rules-page");
    fireEvent.click(within(card).getByTestId("rules-edit"));
    const tasks = within(card).getByTestId("rules-input-tasks");
    typeInEditor(tasks, "先写失败测试\n\n更新文档");
    expect(within(card).getByTestId("rules-count-tasks").textContent).toBe("2 条");
    typeInEditor(tasks, "先写失败测试\n\n更新文档\n补上文档链接");
    expect(within(card).getByTestId("rules-count-tasks").textContent).toBe("3 条");
    pressSave(tasks);
    await waitFor(() => expect(ws.writeWorkflowRules).toHaveBeenCalled());
    expect(ws.writeWorkflowRules).toHaveBeenCalledTimes(1);
    expect((ws.writeWorkflowRules as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContainEqual([
      "tasks",
      ["先写失败测试", "更新文档", "补上文档链接"],
    ]);
  });

  it("产出规则卡保存：逐行 trim、空行涤除、行序即顺序（spec Example 行对调）；仅写 rules、context 逐字符不变", async () => {
    // spec Scenario「各卡保存仅写对应键」——仅存产出规则时不触碰 context。
    const ws = renderView(projectSnap(), "rules");
    const card = await screen.findByTestId("rules-page");
    fireEvent.click(within(card).getByTestId("rules-edit"));
    typeInEditor(within(card).getByTestId("rules-input-tasks"), "  更新文档  \n\n先写失败测试\n");
    fireEvent.click(within(card).getByTestId("rules-save"));
    await waitFor(() => expect(ws.writeWorkflowRules).toHaveBeenCalled());
    expect((ws.writeWorkflowRules as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual([
      ["proposal", ["提案必须列出影响的 crates"]],
      ["design", []],
      ["specs", []],
      ["tasks", ["更新文档", "先写失败测试"]],
    ]);
    expect(ws.writeWorkflowContext).not.toHaveBeenCalled();
  });

  it("以保留字符开头的条目原文进 payload（spec Example 保留字符条目自动加引号的前端面）", async () => {
    const ws = renderView(projectSnap(), "rules");
    const card = await screen.findByTestId("rules-page");
    fireEvent.click(within(card).getByTestId("rules-edit"));
    typeInEditor(within(card).getByTestId("rules-input-tasks"), "先写失败测试\n更新文档\n@完成后运行全部测试");
    fireEvent.click(within(card).getByTestId("rules-save"));
    await waitFor(() => expect(ws.writeWorkflowRules).toHaveBeenCalled());
    const payload = (ws.writeWorkflowRules as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload).toContainEqual(["tasks", ["先写失败测试", "更新文档", "@完成后运行全部测试"]]);
    expect(payload).toContainEqual(["proposal", ["提案必须列出影响的 crates"]]);
  });

  it("清空某键文本区＝该键送空清单、其余键保留（spec Example 键移除第二列）", async () => {
    const ws = renderView(projectSnap(), "rules");
    const card = await screen.findByTestId("rules-page");
    fireEvent.click(within(card).getByTestId("rules-edit"));
    typeInEditor(within(card).getByTestId("rules-input-tasks"), "");
    fireEvent.click(within(card).getByTestId("rules-save"));
    await waitFor(() => expect(ws.writeWorkflowRules).toHaveBeenCalled());
    const payload = (ws.writeWorkflowRules as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload).toContainEqual(["tasks", []]);
    expect(payload).toContainEqual(["proposal", ["提案必须列出影响的 crates"]]);
  });

  it("全部键清空＝全空 payload（触发后端移除 rules 键；spec Example 键移除第三列）", async () => {
    const ws = renderView(projectSnap(), "rules");
    const card = await screen.findByTestId("rules-page");
    fireEvent.click(within(card).getByTestId("rules-edit"));
    typeInEditor(within(card).getByTestId("rules-input-tasks"), "");
    typeInEditor(within(card).getByTestId("rules-input-proposal"), "  \n ");
    fireEvent.click(within(card).getByTestId("rules-save"));
    await waitFor(() => expect(ws.writeWorkflowRules).toHaveBeenCalled());
    expect((ws.writeWorkflowRules as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual([
      ["proposal", []],
      ["design", []],
      ["specs", []],
      ["tasks", []],
    ]);
  });

  it("清空项目说明保存 → 送空字符串（键移除）；仅写 context、产出规则不被触碰（spec Example 键移除第一列）", async () => {
    const ws = renderView(projectSnap());
    const card = await screen.findByTestId("context-page");
    fireEvent.click(within(card).getByTestId("context-edit"));
    typeInEditor(within(card).getByTestId("context-input"), "");
    fireEvent.click(within(card).getByTestId("context-save"));
    await waitFor(() => expect(ws.writeWorkflowContext).toHaveBeenCalledWith(""));
    expect(ws.writeWorkflowRules).not.toHaveBeenCalled();
  });

  it("编辑项目说明并保存：回唯读渲染新内容；仅写 context（spec Scenario 编辑项目说明并保存）", async () => {
    const ws = renderView(projectSnap());
    const card = await screen.findByTestId("context-page");
    fireEvent.click(within(card).getByTestId("context-edit"));
    typeInEditor(within(card).getByTestId("context-input"), "# 新标题\n\n新的说明");
    fireEvent.click(within(card).getByTestId("context-save"));
    await waitFor(() => expect(ws.writeWorkflowContext).toHaveBeenCalledWith("# 新标题\n\n新的说明"));
    expect(ws.writeWorkflowRules).not.toHaveBeenCalled();
    // 卡片回唯读并渲染新内容。
    await waitFor(() => expect(within(card).getByTestId("context-edit")).toBeTruthy());
    expect(within(card).getByRole("heading", { name: "新标题" })).toBeTruthy();
    expect(within(card).queryAllByRole("textbox")).toHaveLength(0);
  });

  it("取消放弃编辑：还原唯读且不触发写入，重进编辑草稿已重设；产出规则卡全程不受影响（spec Scenario 取消放弃编辑）", async () => {
    const ws = renderView(projectSnap());
    const card = await screen.findByTestId("context-page");
    fireEvent.click(within(card).getByTestId("context-edit"));
    typeInEditor(within(card).getByTestId("context-input"), "被放弃的修改");
    fireEvent.click(within(card).getByTestId("context-cancel"));
    // 还原唯读呈现、零写入。
    expect(within(card).getByTestId("context-edit")).toBeTruthy();
    expect(ws.writeWorkflowContext).not.toHaveBeenCalled();
    expect(ws.writeWorkflowRules).not.toHaveBeenCalled();
    // 产出规则页全程唯读不受影响。
    goto("rules");
    expect(within(screen.getByTestId("rules-page")).queryAllByRole("textbox")).toHaveLength(0);
    // 重进编辑：草稿为读入值，非被放弃的修改。
    goto("context");
    const page = screen.getByTestId("context-page");
    fireEvent.click(within(page).getByTestId("context-edit"));
    expect(editorText(within(page).getByTestId("context-input"))).toBe(
      "# 项目简介\n\n这是一段说明",
    );
  });

  it("写入失败：显示单行错误并维持编辑态不遗失输入（design 契约失败模式）", async () => {
    const ws = renderView(projectSnap());
    (ws.writeWorkflowContext as ReturnType<typeof vi.fn>).mockRejectedValue(
      "specseal/config.yaml: write failed: denied",
    );
    const card = await screen.findByTestId("context-page");
    fireEvent.click(within(card).getByTestId("context-edit"));
    typeInEditor(within(card).getByTestId("context-input"), "改到一半的内容");
    fireEvent.click(within(card).getByTestId("context-save"));
    expect(await within(card).findByText(/write failed/)).toBeTruthy();
    // 仍在编辑态、输入未遗失。
    expect(within(card).getByTestId("context-save")).toBeTruthy();
    expect(editorText(within(card).getByTestId("context-input"))).toBe(
      "改到一半的内容",
    );
  });

  it("页名采正典词；编辑态说明载明一行一条规则、头尾空白不保留，以及产出规则区块内的注解不保留", async () => {
    renderView(projectSnap());
    const ctxCard = await screen.findByTestId("context-page");
    expect(within(ctxCard).getByRole("heading", { level: 2, name: "项目说明" })).toBeTruthy();
    fireEvent.click(within(ctxCard).getByTestId("context-edit"));
    expect(within(ctxCard).getByText(/清空保存即移除该键/)).toBeTruthy();
    goto("rules");
    const rulesCard = screen.getByTestId("rules-page");
    expect(within(rulesCard).getByRole("heading", { level: 2, name: "产出规则" })).toBeTruthy();
    fireEvent.click(within(rulesCard).getByTestId("rules-edit"));
    expect(within(rulesCard).getByText(/一行一条规则（头尾空白不保留）/)).toBeTruthy();
    expect(within(rulesCard).getByText(/保存只改动产出规则：产出规则区块内的注解不会保留，config.yaml 的其他内容与注解会保留/)).toBeTruthy();
  });
});

describe("remote Workflow 设置（remote-workflow-policy 决策 5/6）", () => {
  function remoteSettings(
    snap: SettingsSnapshot,
    policyWrite: boolean,
    nextRevision = 42,
  ): WorkspaceSettingsProvider {
    return {
      kind: "remote",
      policyWrite,
      readSettings: vi.fn().mockResolvedValue(snap),
      writeAppTools: vi.fn().mockRejectedValue(new Error("remote 无 tools 设置")),
      writeWorkflowConfig: vi.fn().mockResolvedValue(nextRevision),
      writeWorkflowContext: vi.fn().mockResolvedValue(nextRevision),
      writeWorkflowRules: vi.fn().mockResolvedValue(nextRevision),
      readSchemas: vi.fn().mockResolvedValue([]),
      writeWorkflowSchema: vi.fn().mockResolvedValue(nextRevision),
      forkSchema: vi.fn().mockRejectedValue(new Error("远程工作区尚不支持 fork 产出流程")),
      createSchema: vi.fn().mockRejectedValue(new Error("远程工作区尚不支持创建产出流程")),
      revealSchema: vi.fn().mockRejectedValue(new Error("远程工作区没有本机文档可显示")),
      deleteSchema: vi.fn().mockRejectedValue(new Error("远程工作区尚不支持删除产出流程")),
    } as unknown as WorkspaceSettingsProvider;
  }

  it("editor 于产出流程页见 mono revision，政策可存且成功后 revision 前进（spec Scenario「远程项目的项目设置分类」）", async () => {
    const snap = projectSnap({ revision: 41 } as Partial<SettingsSnapshot["workflow"]>);
    const ws = remoteSettings(snap, true);
    render(<Harness settings={ws} initial="workflow" />);

    const revision = await screen.findByTestId("policy-revision");
    expect(revision.textContent).toContain("41");
    expect(revision.className).toContain("font-mono");

    fireEvent.click(screen.getByLabelText("audit"));
    fireEvent.click(screen.getByTestId("save-workflow"));
    await waitFor(() =>
      expect(ws.writeWorkflowConfig).toHaveBeenCalledWith({
        locale: "tw",
        specLocale: null,
        tdd: true,
        audit: true,
        worktree: false,
      }),
    );
    await waitFor(() => expect(screen.getByTestId("policy-revision").textContent).toContain("42"));
  });

  it("remote 工作区不显示 worktree 开关（worktree facts 是 host-local 观察）", async () => {
    // spec desktop-config「产出政策的 worktree 开关」Scenario「remote 工作区
    // 不显示开关」：其余政策字段照常。
    const ws = remoteSettings(projectSnap({ revision: 7 } as Partial<SettingsSnapshot["workflow"]>));
    render(<Harness settings={ws} initial="workflow" />);

    await screen.findByTestId("policy-card");
    expect(screen.queryByLabelText("worktree")).toBeNull();
    expect(screen.getByLabelText("tdd")).toBeTruthy();
    expect(screen.getByLabelText("audit")).toBeTruthy();
  });

  it("reader 看得到五页现值但全唯读，存盘停用并附繁中角色说明", async () => {
    const ws = remoteSettings(
      projectSnap({ revision: 9 } as Partial<SettingsSnapshot["workflow"]>),
      false,
    );
    render(<Harness settings={ws} />);

    await screen.findByTestId("context-page");
    expect(screen.getByTestId("policy-reader-note").textContent).toContain("你的角色为查看者");
    expect((screen.getByTestId("context-edit") as HTMLButtonElement).disabled).toBe(true);
    goto("rules");
    expect(screen.getByTestId("policy-reader-note")).toBeTruthy();
    expect((screen.getByTestId("rules-edit") as HTMLButtonElement).disabled).toBe(true);
    goto("review");
    expect(screen.getByTestId("policy-reader-note")).toBeTruthy();
    expect((screen.getByTestId("review-edit") as HTMLButtonElement).disabled).toBe(true);
    goto("subagent");
    expect(screen.getByTestId("policy-reader-note")).toBeTruthy();
    expect((screen.getByTestId("subagent-edit") as HTMLButtonElement).disabled).toBe(true);
    goto("workflow");
    expect(screen.getByTestId("policy-reader-note")).toBeTruthy();
    expect((screen.getByLabelText("locale") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("tdd") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId("save-workflow") as HTMLButtonElement).disabled).toBe(true);
    expect(ws.writeWorkflowConfig).not.toHaveBeenCalled();
  });

  it("409 保留原始输入、重读最新 revision 逐栏对照，且只提供两个知情出口", async () => {
    const initial = projectSnap({ revision: 41 } as Partial<SettingsSnapshot["workflow"]>);
    const latest = projectSnap({
      revision: 42,
      context: "server 较新的说明",
      rules: { tasks: ["server rule"] },
    } as Partial<SettingsSnapshot["workflow"]>);
    const ws = remoteSettings(initial, true);
    (ws.readSettings as ReturnType<typeof vi.fn>)
      .mockReset()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(latest);
    (ws.writeWorkflowContext as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      message: "policy revision conflict",
      reason: "revision_conflict",
      status: 409,
    });
    render(<Harness settings={ws} />);

    const contextCard = await screen.findByTestId("context-page");
    fireEvent.click(within(contextCard).getByTestId("context-edit"));
    typeInEditor(within(contextCard).getByTestId("context-input"), "我的原始输入\n保留换行");
    fireEvent.click(within(contextCard).getByTestId("context-save"));

    const panel = await screen.findByTestId("policy-conflict-panel");
    // 政策冲突是警示（要人决定，不是坏掉）：琥珀边框，不用主色（主色＝可点的东西）。
    expect(panel.className).toContain("status-warning");
    expect(panel.className).not.toContain("border-primary");
    expect(editorText(within(contextCard).getByTestId("context-input"))).toBe(
      "我的原始输入\n保留换行",
    );
    expect(ws.readSettings).toHaveBeenCalledTimes(2);
    expect(within(panel).getByTestId("conflict-revision").textContent).toContain("42");
    const contextRow = within(panel).getByTestId("conflict-row-context");
    expect(within(contextRow).getByTestId("conflict-server").textContent).toContain(
      "server 较新的说明",
    );
    expect(within(contextRow).getByTestId("conflict-mine").textContent).toContain(
      "我的原始输入",
    );
    expect(within(panel).getByTestId("conflict-row-rules-tasks")).toBeTruthy();
    expect(within(panel).getByTestId("conflict-row-audit")).toBeTruthy();
    expect(within(panel).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "以 server 版重载",
      "查看后以最新 revision 重新提交",
    ]);
    expect(screen.queryByText(/强制覆写/)).toBeNull();

    fireEvent.click(within(panel).getByRole("button", { name: "以 server 版重载" }));
    await waitFor(() => expect(screen.queryByTestId("policy-conflict-panel")).toBeNull());
    expect(screen.getByTestId("context-readonly").textContent).toContain("server 较新的说明");
    expect(screen.getByTestId("policy-revision").textContent).toContain("42");
    expect(ws.writeWorkflowContext).toHaveBeenCalledTimes(1);
  });

  it("冲突对照卡开着时 ⌘S 不写入、编辑器转唯读（不绕过对照卡盖掉 server 版）", async () => {
    const initial = projectSnap({ revision: 41 } as Partial<SettingsSnapshot["workflow"]>);
    const latest = projectSnap({ revision: 42, context: "server 较新的说明" } as Partial<SettingsSnapshot["workflow"]>);
    const ws = remoteSettings(initial, true);
    (ws.readSettings as ReturnType<typeof vi.fn>)
      .mockReset()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(latest);
    (ws.writeWorkflowContext as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      message: "policy revision conflict",
      reason: "revision_conflict",
      status: 409,
    });
    render(<Harness settings={ws} />);
    const page = await screen.findByTestId("context-page");
    fireEvent.click(within(page).getByTestId("context-edit"));
    const input = within(page).getByTestId("context-input");
    typeInEditor(input, "我的输入");
    pressSave(input);
    await screen.findByTestId("policy-conflict-panel");
    expect(editorView(input).state.readOnly).toBe(true);
    pressSave(input);
    fireEvent.keyDown(document.body, { key: "s", ctrlKey: true });
    await act(async () => {});
    expect(ws.writeWorkflowContext).toHaveBeenCalledTimes(1);
  });

  it("以最新 revision 重送仍遇 409 时递归重读对照，输入不变且无 force 路径", async () => {
    const initial = projectSnap({ revision: 41 } as Partial<SettingsSnapshot["workflow"]>);
    const latest42 = projectSnap({
      revision: 42,
      locale: "ja",
    } as Partial<SettingsSnapshot["workflow"]>);
    const latest43 = projectSnap({
      revision: 43,
      locale: "tw",
    } as Partial<SettingsSnapshot["workflow"]>);
    const ws = remoteSettings(initial, true, 44);
    (ws.readSettings as ReturnType<typeof vi.fn>)
      .mockReset()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(latest42)
      .mockResolvedValueOnce(latest43);
    (ws.writeWorkflowConfig as ReturnType<typeof vi.fn>)
      .mockReset()
      .mockRejectedValueOnce({ reason: "revision_conflict", status: 409, message: "conflict 41" })
      .mockRejectedValueOnce({ reason: "revision_conflict", status: 409, message: "conflict 42" })
      .mockResolvedValueOnce(44);
    render(<Harness settings={ws} initial="workflow" />);

    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(await screen.findByLabelText("locale"));
    await user.click(await screen.findByRole("option", { name: /^en/ }));
    fireEvent.click(screen.getByTestId("save-workflow"));
    let panel = await screen.findByTestId("policy-conflict-panel");
    let localeRow = within(panel).getByTestId("conflict-row-locale");
    expect(within(localeRow).getByTestId("conflict-server").textContent).toContain("ja");
    expect(within(localeRow).getByTestId("conflict-mine").textContent).toContain("en");

    fireEvent.click(
      within(panel).getByRole("button", { name: "查看后以最新 revision 重新提交" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("conflict-revision").textContent).toContain("43"),
    );
    panel = screen.getByTestId("policy-conflict-panel");
    localeRow = within(panel).getByTestId("conflict-row-locale");
    expect(within(localeRow).getByTestId("conflict-server").textContent).toContain("tw");
    expect(within(localeRow).getByTestId("conflict-mine").textContent).toContain("en");
    // 输入不变：冲突面板来回后，下拉仍停在用户选的值。
    expect(screen.getByLabelText("locale").textContent).toContain("en");
    expect(ws.readSettings).toHaveBeenCalledTimes(3);
    expect(ws.writeWorkflowConfig).toHaveBeenCalledTimes(2);

    fireEvent.click(
      within(panel).getByRole("button", { name: "查看后以最新 revision 重新提交" }),
    );
    await waitFor(() => expect(screen.queryByTestId("policy-conflict-panel")).toBeNull());
    expect(screen.getByTestId("policy-revision").textContent).toContain("44");
    expect(screen.getByLabelText("locale").textContent).toContain("en");
    expect(ws.writeWorkflowConfig).toHaveBeenCalledTimes(3);
    for (const call of (ws.writeWorkflowConfig as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[0]).toMatchObject({ locale: "en" });
    }
    expect(screen.queryByText(/强制覆写/)).toBeNull();
  });
});

// ---- 产出流程页（desktop-schema-panel design D4／D5；desktop-settings-mode design D8）----

describe("产出流程页（spec「产出流程页」）", () => {
  const BUILTIN_ENTRY: SchemaEntry = {
    name: "spec-driven",
    source: "package",
    artifactIds: ["proposal", "design", "specs", "tasks"],
    artifacts: [
      { id: "proposal", description: "提案文档", instruction: "写提案", template: "# Proposal template" },
      { id: "design", description: "设计文档", instruction: "写设计", template: "# Design template" },
      { id: "specs", description: "规格文档", instruction: "写规格", template: "# Spec template" },
      { id: "tasks", description: "任务清单", instruction: "写任务", template: "# Tasks template" },
    ],
    path: null,
    error: null,
  };
  const NO_SPEC_CHANGE_ENTRY: SchemaEntry = {
    name: "no-spec-change",
    source: "package",
    artifactIds: ["proposal", "design", "tasks"],
    artifacts: [
      { id: "proposal", description: "提案文档", instruction: "写提案", template: "# Proposal template" },
      { id: "design", description: "设计文档", instruction: "写设计", template: "# Design template" },
      { id: "tasks", description: "任务清单", instruction: "写任务", template: "# Tasks template" },
    ],
    path: null,
    error: null,
  };
  const CUSTOM_ENTRY: SchemaEntry = {
    name: "my-flow",
    source: "project",
    artifactIds: ["plan"],
    artifacts: [
      { id: "plan", description: "计划文档", instruction: "先写计划", template: "# 计划模板" },
    ],
    path: "/proj/specseal/schemas/my-flow",
    error: null,
  };

  function schemaSettings(
    snap: SettingsSnapshot,
    schemas: SchemaEntry[] = [BUILTIN_ENTRY, CUSTOM_ENTRY],
    over: Record<string, unknown> = {},
  ): WorkspaceSettingsProvider {
    return {
      kind: "local",
      policyWrite: true,
      readSettings: vi.fn().mockResolvedValue(snap),
      writeAppTools: vi.fn().mockResolvedValue(undefined),
      writeWorkflowConfig: vi.fn().mockResolvedValue(undefined),
      writeWorkflowContext: vi.fn().mockResolvedValue(undefined),
      writeWorkflowRules: vi.fn().mockResolvedValue(undefined),
      readSchemas: vi.fn().mockResolvedValue(schemas),
      writeWorkflowSchema: vi.fn().mockResolvedValue(undefined),
      forkSchema: vi.fn().mockResolvedValue("spec-driven-custom"),
      createSchema: vi.fn().mockResolvedValue(undefined),
      revealSchema: vi.fn().mockResolvedValue(undefined),
      deleteSchema: vi.fn().mockResolvedValue(undefined),
      ...over,
    } as unknown as WorkspaceSettingsProvider;
  }

  /** 加载后切到产出流程页。 */
  async function openSchemasTab() {
    await screen.findByTestId("context-page");
    goto("workflow");
  }

  it("产出流程自成一页：项目说明页与产出规则页无此内容（spec Scenario「产出流程自成一页」）", async () => {
    const ws = schemaSettings(projectSnap());
    render(<Harness settings={ws} />);
    await screen.findByTestId("context-page");
    expect(screen.queryByTestId("schema-card")).toBeNull();
    goto("rules");
    expect(screen.queryByTestId("schema-card")).toBeNull();
    goto("workflow");
    expect(await screen.findByTestId("schema-card")).toBeTruthy();
    expect(screen.getByTestId("policy-card")).toBeTruthy();
  });

  it("清单列出可解析项（名称、来源层级、artifact 图），点入唯读详情含全文且无编辑入口", async () => {
    // spec Scenario「清单列出可解析的 schema」＋「详情唯读呈现内容」＋
    // Example「清单一列的形状」。
    const ws = schemaSettings(projectSnap());
    render(<Harness settings={ws} />);
    await openSchemasTab();
    const card = await screen.findByTestId("schema-card");
    expect(card.textContent).toContain("产出流程");
    const item = await screen.findByTestId("schema-item-spec-driven");
    expect(item.textContent).toContain("spec-driven");
    expect(item.textContent).toContain("内置");
    // spec Example「清单一列的形状」：artifact 图整串钉死（引擎显示序）。
    expect(item.textContent).toContain("proposal → design → specs → tasks");
    const custom = screen.getByTestId("schema-item-my-flow");
    expect(custom.textContent).toContain("项目");
    expect(custom.textContent).toContain("plan");

    fireEvent.click(screen.getByTestId("schema-toggle-spec-driven"));
    const detail = await screen.findByTestId("schema-detail-spec-driven");
    for (const text of ["提案文档", "写提案", "# Proposal template", "任务清单", "# Tasks template"]) {
      expect(detail.textContent).toContain(text);
    }
    expect(within(detail).queryByRole("textbox")).toBeNull();
  });

  it("下拉切换触发写入，成功后重读快照且产出规则分节固定键更新", async () => {
    // spec Scenario「切换写入且其余内容保留」的前端面。
    const first = projectSnap();
    const after = projectSnap({ schemaName: "my-flow", schemaArtifacts: ["plan"], rules: {} });
    const ws = schemaSettings(first);
    (ws.readSettings as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(first)
      .mockResolvedValue(after);
    render(<Harness settings={ws} />);
    await openSchemasTab();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const select = await screen.findByLabelText("使用中的产出流程");
    expect(select.textContent).toContain("spec-driven");
    await user.click(select);
    await user.click(await screen.findByRole("option", { name: /my-flow/ }));
    await waitFor(() => expect(ws.writeWorkflowSchema).toHaveBeenCalledWith("my-flow"));
    // 固定键随新 schema 更新：切到产出规则页，编辑分节只剩 plan。
    await waitFor(() => expect(screen.getByLabelText("使用中的产出流程").textContent).toContain("my-flow"));
    goto("rules");
    fireEvent.click(await screen.findByTestId("rules-edit"));
    await waitFor(() => expect(screen.getByTestId("rules-input-plan")).toBeTruthy());
    expect(screen.queryByTestId("rules-input-proposal")).toBeNull();
  });

  it("切换写入失败：错误浮出于表单，不静默", async () => {
    const ws = schemaSettings(projectSnap());
    (ws.writeWorkflowSchema as ReturnType<typeof vi.fn>).mockRejectedValue(
      "specseal/config.yaml: write failed: denied",
    );
    render(<Harness settings={ws} />);
    await openSchemasTab();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(await screen.findByLabelText("使用中的产出流程"));
    await user.click(await screen.findByRole("option", { name: /my-flow/ }));
    expect(await screen.findByText(/write failed/)).toBeTruthy();
  });

  it("fork 仅 local 渲染，按下后清单反映新项目层项目", async () => {
    // spec Scenario「fork 产出项目层副本」的前端面。
    const forked: SchemaEntry = { ...BUILTIN_ENTRY, name: "spec-driven-custom", source: "project" };
    const ws = schemaSettings(projectSnap());
    (ws.readSchemas as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([BUILTIN_ENTRY, CUSTOM_ENTRY])
      .mockResolvedValue([BUILTIN_ENTRY, forked, CUSTOM_ENTRY]);
    render(<Harness settings={ws} />);
    await openSchemasTab();
    await screen.findByTestId("schema-item-spec-driven");
    fireEvent.click(screen.getByTestId("schema-fork-spec-driven"));
    await waitFor(() => expect(ws.forkSchema).toHaveBeenCalledWith("spec-driven"));
    await screen.findByTestId("schema-item-spec-driven-custom");
  });

  it("存产出规则保留非固定键的既有分节（review R3：切换后旧 schema 分节不被静默删除）", async () => {
    const snap = projectSnap({
      schemaName: "my-flow",
      schemaArtifacts: ["plan"],
      rules: { plan: ["p1"], proposal: ["旧 schema 的规则"] },
    });
    const ws = schemaSettings(snap);
    render(<Harness settings={ws} initial="rules" />);
    fireEvent.click(await screen.findByTestId("rules-edit"));
    await screen.findByTestId("rules-input-plan");
    fireEvent.click(screen.getByTestId("rules-save"));
    await waitFor(() =>
      expect(ws.writeWorkflowRules).toHaveBeenCalledWith([
        ["plan", ["p1"]],
        ["proposal", ["旧 schema 的规则"]],
      ]),
    );
  });

  it("切换 schema 不重设另一卡的编辑态与草稿（review R4）", async () => {
    const first = projectSnap();
    const after = projectSnap({ schemaName: "my-flow", schemaArtifacts: ["plan"], rules: {} });
    const ws = schemaSettings(first);
    (ws.readSettings as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(first)
      .mockResolvedValue(after);
    render(<Harness settings={ws} />);
    // 项目说明页：开编辑并输入未存草稿。
    fireEvent.click(await screen.findByTestId("context-edit"));
    typeInEditor(screen.getByTestId("context-input"), "还没存的草稿");
    // 切到产出流程页做切换。
    goto("workflow");
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(await screen.findByLabelText("使用中的产出流程"));
    await user.click(await screen.findByRole("option", { name: /my-flow/ }));
    await waitFor(() => expect(ws.writeWorkflowSchema).toHaveBeenCalledWith("my-flow"));
    // 切回项目说明页：编辑态仍开、草稿仍在。
    goto("context");
    expect(editorText(await screen.findByTestId("context-input"))).toBe("还没存的草稿");
  });

  it("remote 切换撞 revision_conflict → 开对照对话框（review R5）", async () => {
    const initial = projectSnap({ revision: 41 } as Partial<SettingsSnapshot["workflow"]>);
    const latest = projectSnap({ revision: 42 } as Partial<SettingsSnapshot["workflow"]>);
    const ws = schemaSettings(initial, [BUILTIN_ENTRY, CUSTOM_ENTRY], { kind: "remote" });
    (ws.readSettings as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(initial)
      .mockResolvedValue(latest);
    (ws.writeWorkflowSchema as ReturnType<typeof vi.fn>).mockRejectedValue({
      reason: "revision_conflict",
      message: "policy revision conflict",
    });
    render(<Harness settings={ws} />);
    await openSchemasTab();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(await screen.findByLabelText("使用中的产出流程"));
    await user.click(await screen.findByRole("option", { name: /my-flow/ }));
    expect(await screen.findByTestId("policy-conflict-panel")).toBeTruthy();
    expect(screen.getByTestId("conflict-revision").textContent).toContain("42");
  });

  it("切换进行中停用政策表单与各页编辑，完成后恢复（等待期间的改动不会被重读盖回；review-rules-config 品质关卡第 2 轮）", async () => {
    const snap = projectSnap({ revision: 41 } as Partial<SettingsSnapshot["workflow"]>);
    let finish: (revision: number) => void = () => {};
    const ws = schemaSettings(snap, [BUILTIN_ENTRY, CUSTOM_ENTRY], {
      kind: "remote",
      writeWorkflowSchema: vi.fn().mockReturnValue(new Promise<number>((resolve) => (finish = resolve))),
    });
    render(<Harness settings={ws} />);
    await openSchemasTab();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(await screen.findByLabelText("使用中的产出流程"));
    await user.click(await screen.findByRole("option", { name: /my-flow/ }));
    await waitFor(() => expect((screen.getByLabelText("tdd") as HTMLButtonElement).disabled).toBe(true));
    goto("review");
    expect((screen.getByTestId("review-edit") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish(42));
    await waitFor(() => expect((screen.getByTestId("review-edit") as HTMLButtonElement).disabled).toBe(false));
    goto("workflow");
    expect((screen.getByLabelText("tdd") as HTMLButtonElement).disabled).toBe(false);
  });

  it("下拉现值不在选项集时仍显示名称（review R6：remote 非内置）", async () => {
    const snap = projectSnap({
      revision: 7,
      schemaName: "their-flow",
      schemaKnown: false,
      schemaArtifacts: [],
      rules: {},
    } as Partial<SettingsSnapshot["workflow"]>);
    const ws = schemaSettings(snap, [BUILTIN_ENTRY], { kind: "remote" });
    render(<Harness settings={ws} />);
    await openSchemasTab();
    const trigger = await screen.findByLabelText("使用中的产出流程");
    expect(trigger.textContent).toContain("their-flow");
  });

  it("readSchemas 失败：错误浮出而非静默空白（review R7）", async () => {
    const ws = schemaSettings(projectSnap());
    (ws.readSchemas as ReturnType<typeof vi.fn>).mockRejectedValue(
      "not a specseal project: /gone",
    );
    render(<Harness settings={ws} />);
    await openSchemasTab();
    expect(await screen.findByText(/not a specseal project/)).toBeTruthy();
  });

  it("同名跨层项目只有解析命中的那层有 fork 按钮（review R8）", async () => {
    // 引擎 fork 以 project→user 第一命中解析：被 shadow 的 user 层项若给 fork，
    // 拷贝到的会是项目层同名内容——不给入口。
    const dupProject: SchemaEntry = { ...CUSTOM_ENTRY, name: "dup", path: "/proj/specseal/schemas/dup" };
    const dupUser: SchemaEntry = {
      ...CUSTOM_ENTRY,
      name: "dup",
      source: "user",
      path: "/home/userdir/schemas/dup",
    };
    const ws = schemaSettings(projectSnap(), [BUILTIN_ENTRY, dupProject, dupUser]);
    render(<Harness settings={ws} />);
    await openSchemasTab();
    await waitFor(() => expect(screen.getAllByTestId("schema-item-dup")).toHaveLength(2));
    expect(screen.getAllByTestId("schema-fork-dup")).toHaveLength(1);
  });

  it("创建表单仅 local 渲染：输入名称送出后 createSchema 被调用且清单反映新项", async () => {
    // spec Scenario「创建产出项目层骨架」＋ Example「创建输入与结果」row 1。
    const created: SchemaEntry = {
      name: "my-new-flow",
      source: "project",
      artifactIds: ["plan", "tasks"],
      artifacts: [],
      path: "/proj/specseal/schemas/my-new-flow",
      error: null,
    };
    const ws = schemaSettings(projectSnap());
    (ws.readSchemas as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([BUILTIN_ENTRY, CUSTOM_ENTRY])
      .mockResolvedValue([BUILTIN_ENTRY, CUSTOM_ENTRY, created]);
    render(<Harness settings={ws} />);
    await openSchemasTab();
    await screen.findByTestId("schema-item-spec-driven");
    fireEvent.change(screen.getByTestId("schema-create-name"), {
      target: { value: "my-new-flow" },
    });
    fireEvent.click(screen.getByTestId("schema-create"));
    await waitFor(() => expect(ws.createSchema).toHaveBeenCalledWith("my-new-flow"));
    await screen.findByTestId("schema-item-my-new-flow");
  });

  it("有磁盘路径的项目带打开所在文档夹按钮，内置项无（产出流程的编辑入口）", async () => {
    // spec Scenario「项目层项目打开所在文档夹」＋「内置项无编辑入口」。
    const ws = schemaSettings(projectSnap());
    render(<Harness settings={ws} />);
    await openSchemasTab();
    await screen.findByTestId("schema-item-my-flow");
    expect(screen.queryByTestId("schema-reveal-spec-driven")).toBeNull();
    fireEvent.click(screen.getByTestId("schema-reveal-my-flow"));
    await waitFor(() =>
      expect(ws.revealSchema).toHaveBeenCalledWith("/proj/specseal/schemas/my-flow"),
    );
  });

  it("项目层项目带删除按钮：确认后调用且清单反映，内置项无此按钮", async () => {
    // spec Scenario「删除经确认后移除项目层目录」。
    const ws = schemaSettings(projectSnap());
    (ws.readSchemas as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([BUILTIN_ENTRY, CUSTOM_ENTRY])
      .mockResolvedValue([BUILTIN_ENTRY]);
    render(<Harness settings={ws} />);
    await openSchemasTab();
    await screen.findByTestId("schema-item-my-flow");
    expect(screen.queryByTestId("schema-delete-spec-driven")).toBeNull();
    fireEvent.click(screen.getByTestId("schema-delete-my-flow"));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(ws.deleteSchema).toHaveBeenCalledWith("my-flow"));
    await waitFor(() => expect(screen.queryByTestId("schema-item-my-flow")).toBeNull());
  });

  it("删除确认对话框取消：零调用零变动", async () => {
    // spec Scenario「取消确认零变动」。
    const ws = schemaSettings(projectSnap());
    render(<Harness settings={ws} />);
    await openSchemasTab();
    await screen.findByTestId("schema-item-my-flow");
    fireEvent.click(screen.getByTestId("schema-delete-my-flow"));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "取消" }));
    expect(ws.deleteSchema).not.toHaveBeenCalled();
    expect(screen.getByTestId("schema-item-my-flow")).toBeTruthy();
  });

  it("删除失败（使用中的 schema 拒删）：错误浮出于表单", async () => {
    const ws = schemaSettings(projectSnap());
    (ws.deleteSchema as ReturnType<typeof vi.fn>).mockRejectedValue(
      "'my-flow' 是使用中的产出流程（config.yaml 的 schema 键正指着它）——请先切换到其他项目再删除",
    );
    render(<Harness settings={ws} />);
    await openSchemasTab();
    await screen.findByTestId("schema-item-my-flow");
    fireEvent.click(screen.getByTestId("schema-delete-my-flow"));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "删除" }));
    expect(await screen.findByText(/使用中的产出流程/)).toBeTruthy();
    expect(screen.getByTestId("schema-item-my-flow")).toBeTruthy();
  });

  it("fork／创建／删除不重设产出规则的编辑态与草稿（review N1）", async () => {
    const ws = schemaSettings(projectSnap());
    render(<Harness settings={ws} initial="rules" />);
    // 产出规则页：开编辑并输入未存草稿。
    fireEvent.click(await screen.findByTestId("rules-edit"));
    typeInEditor(screen.getByTestId("rules-input-proposal"), "还没存的规则草稿");
    // 产出流程页做 fork。
    goto("workflow");
    await screen.findByTestId("schema-item-spec-driven");
    fireEvent.click(screen.getByTestId("schema-fork-spec-driven"));
    await waitFor(() => expect(ws.forkSchema).toHaveBeenCalled());
    // 切回：编辑态仍开、草稿仍在。
    goto("rules");
    expect(editorText(await screen.findByTestId("rules-input-proposal"))).toBe("还没存的规则草稿");
  });

  it("编辑中换固定键集：编辑面冻结在开编辑当下的分节，保存不清掉新 schema 的既有规则（review N4）", async () => {
    const first = projectSnap(); // 固定键 proposal/design/specs/tasks
    const after = projectSnap({
      schemaName: "my-flow",
      schemaArtifacts: ["plan"],
      rules: { plan: ["新 schema 的既有规则"], proposal: ["提案必须列出影响的 crates"] },
    });
    const ws = schemaSettings(first);
    (ws.readSettings as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(first)
      .mockResolvedValue(after);
    render(<Harness settings={ws} initial="rules" />);
    // 开产出规则编辑并改草稿。
    fireEvent.click(await screen.findByTestId("rules-edit"));
    typeInEditor(screen.getByTestId("rules-input-proposal"), "编辑中的提案规则");
    // 产出流程页 fork → refreshSchemaFacts 换集（schemaArtifacts 变 ["plan"]）。
    goto("workflow");
    await screen.findByTestId("schema-item-spec-driven");
    fireEvent.click(screen.getByTestId("schema-fork-spec-driven"));
    await waitFor(() => expect(ws.forkSchema).toHaveBeenCalled());
    // 切回：编辑面仍是开编辑当下的分节与草稿（不是新键的空白 textarea）。
    goto("rules");
    expect(editorText(await screen.findByTestId("rules-input-proposal"))).toBe("编辑中的提案规则");
    expect(screen.queryByTestId("rules-input-plan")).toBeNull();
    // 保存：payload 以冻结键集送出草稿，新固定键 plan 的既有规则以兜底原样保留。
    fireEvent.click(screen.getByTestId("rules-save"));
    await waitFor(() => expect(ws.writeWorkflowRules).toHaveBeenCalled());
    const payload = (ws.writeWorkflowRules as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as Array<[string, string[]]>;
    expect(payload).toContainEqual(["proposal", ["编辑中的提案规则"]]);
    expect(payload).toContainEqual(["plan", ["新 schema 的既有规则"]]);
  });

  it("切换失败后下拉退回现值，不谎报活跃 schema（review N2）", async () => {
    const ws = schemaSettings(projectSnap());
    (ws.writeWorkflowSchema as ReturnType<typeof vi.fn>).mockRejectedValue(
      "specseal/config.yaml: write failed: denied",
    );
    render(<Harness settings={ws} />);
    await openSchemasTab();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(await screen.findByLabelText("使用中的产出流程"));
    await user.click(await screen.findByRole("option", { name: /my-flow/ }));
    await screen.findByText(/write failed/);
    expect(screen.getByLabelText("使用中的产出流程").textContent).toContain("spec-driven");
  });

  it("被坏档前层 shadow 的项也不给 fork 入口（review R8 残留）", async () => {
    // 引擎 sources 只看 schema.yaml 文档存在——前层坏档仍是解析命中层。
    const brokenProject: SchemaEntry = {
      name: "dup",
      source: "project",
      artifactIds: [],
      artifacts: [],
      path: "/proj/specseal/schemas/dup",
      error: "Schema parse error: bad yaml",
    };
    const dupUser: SchemaEntry = {
      ...CUSTOM_ENTRY,
      name: "dup",
      source: "user",
      path: "/home/userdir/schemas/dup",
    };
    const ws = schemaSettings(projectSnap(), [BUILTIN_ENTRY, brokenProject, dupUser]);
    render(<Harness settings={ws} />);
    await openSchemasTab();
    await waitFor(() => expect(screen.getAllByTestId("schema-item-dup")).toHaveLength(2));
    expect(screen.queryAllByTestId("schema-fork-dup")).toHaveLength(0);
  });

  it("创建失败（不合法名称／已存在）：引擎错误浮出于表单", async () => {
    // spec Scenario「不合法名称显性失败」＋ Example「创建输入与结果」row 2/3。
    const ws = schemaSettings(projectSnap());
    (ws.createSchema as ReturnType<typeof vi.fn>).mockRejectedValue(
      "Invalid schema name 'My Flow': must be lowercase kebab-case (e.g. my-flow)",
    );
    render(<Harness settings={ws} />);
    await openSchemasTab();
    fireEvent.change(await screen.findByTestId("schema-create-name"), {
      target: { value: "My Flow" },
    });
    fireEvent.click(screen.getByTestId("schema-create"));
    expect(await screen.findByText(/kebab-case/)).toBeTruthy();
  });

  it("remote：无 .specseal.yaml 页、无 fork 与创建入口、下拉仅内置、非内置显示远程自订尚不支持且不猜固定键", async () => {
    // spec Scenario「remote 模式无 fork 入口」「remote 模式无创建入口」「remote
    // 下拉仅内置」「remote 快照不读本机 user 层」的前端面。
    const snap = projectSnap({
      revision: 7,
      schemaName: "their-flow",
      schemaKnown: false,
      schemaArtifacts: [],
      rules: {},
    } as Partial<SettingsSnapshot["workflow"]>);
    const ws = schemaSettings(snap, [BUILTIN_ENTRY, NO_SPEC_CHANGE_ENTRY], { kind: "remote" });
    render(<Harness settings={ws} />);
    await screen.findByTestId("context-page");
    // 不猜固定键：产出规则页无任何分节内容。
    goto("rules");
    expect(screen.queryByTestId("rules-readonly-proposal")).toBeNull();

    goto("workflow");
    await screen.findByTestId("schema-card");
    expect(screen.queryByTestId("schema-fork-spec-driven")).toBeNull();
    expect(screen.queryByTestId("schema-create")).toBeNull();
    expect(screen.queryByTestId("schema-reveal-spec-driven")).toBeNull();
    expect(screen.queryByTestId("schema-delete-spec-driven")).toBeNull();
    expect(screen.getByTestId("schema-unknown-note").textContent).toContain("远程自订尚不支持");

    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByLabelText("使用中的产出流程"));
    const options = await screen.findAllByRole("option");
    // 沿 locale 未知值模式：现值以停用项显示（不可选），可选的切换目标仅内置。
    expect(
      options.map((o) => [o.textContent, o.getAttribute("aria-disabled") === "true"]),
    ).toEqual([
      ["their-flow", true],
      ["spec-driven", false],
      ["no-spec-change", false],
    ]);
  });
});

// ---- 审查规则页（spec 需求「设置页编辑审查规则」；review-rules-config）----

describe("审查规则页（spec 需求「设置页编辑审查规则」）", () => {
  const RULES: ReviewRules = {
    baseline: "extend",
    critical: ["所有 SQL 一律用参数化查找，不得用字符串拼接", "不得把密钥或密码写死在代码里"],
    warning: ["添加的公开 API 要有对应的测试"],
    suggestion: ["函数超过 50 行时宜拆分"],
  };
  const reviewSnap = (review = RULES) => projectSnap({ review } as Partial<SettingsSnapshot["workflow"]>);
  /** 从缺省清单下拉选一个模式（Radix Select，与产出流程页 locale 同一组件）。 */
  async function chooseBaseline(page: HTMLElement, mode: string) {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(within(page).getByLabelText("12 条 code smell"));
    await user.click(await screen.findByRole("option", { name: mode }));
  }

  it("唯读呈现：缺省清单卡显示模式，项目规则卡依三节列出规则、条数与效果说明（spec Scenario「唯读呈现」）", async () => {
    renderView(reviewSnap(), "review");
    const page = await screen.findByTestId("review-page");
    expect(within(page).getByRole("heading", { level: 2, name: "审查规则" })).toBeTruthy();
    expect(screen.getByTestId("file-note-config").textContent).toBe("specseal/config.yaml · review");
    expect(within(page).getByTestId("review-baseline-mode").textContent).toBe("沿用并追加");
    const expected = {
      critical: ["CRITICAL", "2 条", "挡盖章；要接受放行须逐条再确认"],
      warning: ["WARNING", "1 条", "挡盖章；偶有正当例外可接受放行"],
      suggestion: ["SUGGESTION", "1 条", "只记在工单，不挡盖章"],
    };
    for (const [list, texts] of Object.entries(expected)) {
      const section = within(page).getByTestId(`review-section-${list}`);
      for (const text of texts) expect(within(section).getByText(text)).toBeTruthy();
    }
    expect(within(page).getByTestId("review-section-critical").textContent).toContain(
      "不得把密钥或密码写死在代码里",
    );
    // 唯读：没有编辑器、页标题右侧只有编辑钮。
    expect(page.querySelector(".cm-editor")).toBeNull();
    expect(within(page).getByTestId("review-edit")).toBeTruthy();
  });

  it("三节皆空时项目规则卡显示空状态；整份换掉的模式名称照实呈现", async () => {
    renderView(reviewSnap({ baseline: "replace", critical: [], warning: [], suggestion: [] }), "review");
    const page = await screen.findByTestId("review-page");
    expect(within(page).getByTestId("review-baseline-mode").textContent).toBe("整份换掉");
    expect(within(page).getByTestId("review-empty")).toBeTruthy();
    expect(within(page).queryByTestId("review-section-critical")).toBeNull();
  });

  it("查看 12 条展开引擎提供的名称（spec Scenario「展开 12 条名称」）；远程项目同样可展开", async () => {
    renderView(reviewSnap(), "review");
    const page = await screen.findByTestId("review-page");
    expect(within(page).queryByTestId("review-smells")).toBeNull();
    const toggle = within(page).getByRole("button", { name: "查看 12 条" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    // 与产出流程页的「查看内容／收合」同一种展开钮：展开后改为收合。
    expect(toggle.textContent).toBe("收合");
    const names = within(within(page).getByTestId("review-smells")).getAllByRole("listitem");
    expect(names.map((n) => n.textContent)).toEqual(SMELLS);
  });

  it("远程项目的审查规则页同样可展开 12 条，名称与本机一致", async () => {
    const ws = { ...fakeSettings(reviewSnap()), kind: "remote" } as WorkspaceSettingsProvider;
    render(<Harness settings={ws} initial="review" />);
    const page = await screen.findByTestId("review-page");
    fireEvent.click(within(page).getByRole("button", { name: "查看 12 条" }));
    const names = within(within(page).getByTestId("review-smells")).getAllByRole("listitem");
    expect(names.map((n) => n.textContent)).toEqual(SMELLS);
  });

  it("编辑态：缺省清单为列右侧的两选项下拉、项目规则恰为三个固定节（严重度签＋即时条数），无添加节的输入（spec Scenario「固定三节不可自由添加」）", async () => {
    renderView(reviewSnap(), "review");
    const page = await screen.findByTestId("review-page");
    fireEvent.click(within(page).getByTestId("review-edit"));
    // 与产出流程页 locale 同一个共用下拉；列说明写所选模式的效果。
    expect(within(page).queryAllByRole("radio")).toHaveLength(0);
    const baseline = within(page).getByLabelText("12 条 code smell");
    expect(baseline.textContent).toContain("沿用并追加");
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(baseline);
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(["沿用并追加", "整份换掉"]);
    await user.keyboard("{Escape}");
    expect(within(page).getAllByRole("textbox")).toHaveLength(3);
    for (const [list, count] of [["critical", "2 条"], ["warning", "1 条"], ["suggestion", "1 条"]]) {
      const section = within(page).getByTestId(`review-input-${list}`);
      expect(within(section).getByText(list.toUpperCase())).toBeTruthy();
      expect(within(section).getByTestId(`review-count-${list}`).textContent).toBe(count);
      expect(section.querySelector(".cm-editor")).not.toBeNull();
    }
    expect(editorText(within(page).getByTestId("review-input-critical"))).toBe(RULES.critical.join("\n"));
    expect(within(within(page).getByTestId("review-save")).getByText("Ctrl+S")).toBeTruthy();
  });

  it("编辑并以 ⌘S 保存只写 review：逐行修剪、空行不写；回唯读并显示新内容（spec Scenario「编辑并保存仅写 review」）", async () => {
    const ws = renderView(reviewSnap(), "review");
    const page = await screen.findByTestId("review-page");
    fireEvent.click(within(page).getByTestId("review-edit"));
    const warning = within(page).getByTestId("review-input-warning");
    typeInEditor(warning, "添加的公开 API 要有对应的测试\n\n  错误消息要指出出错的文档  ");
    expect(within(page).getByTestId("review-count-warning").textContent).toBe("2 条");
    pressSave(warning);
    await waitFor(() => expect(ws.writeWorkflowReview).toHaveBeenCalledTimes(1));
    expect(ws.writeWorkflowReview).toHaveBeenCalledWith({
      ...RULES,
      warning: ["添加的公开 API 要有对应的测试", "错误消息要指出出错的文档"],
    });
    expect(ws.writeWorkflowContext).not.toHaveBeenCalled();
    expect(ws.writeWorkflowRules).not.toHaveBeenCalled();
    expect(ws.writeWorkflowConfig).not.toHaveBeenCalled();
    await waitFor(() => expect(page.querySelector(".cm-editor")).toBeNull());
    expect(within(page).getByTestId("review-section-warning").textContent).toContain("错误消息要指出出错的文档");
  });

  it("整份换掉且三节皆空：显示提示但可保存（spec Scenario「整份换掉且无规则时提示但可保存」）", async () => {
    const ws = renderView(reviewSnap(), "review");
    const page = await screen.findByTestId("review-page");
    fireEvent.click(within(page).getByTestId("review-edit"));
    await chooseBaseline(page, "整份换掉");
    expect(within(page).queryByTestId("review-replace-empty")).toBeNull();
    for (const list of ["critical", "warning", "suggestion"]) {
      typeInEditor(within(page).getByTestId(`review-input-${list}`), "");
    }
    expect(within(page).getByTestId("review-replace-empty").textContent).toContain(
      "Standards 轴只依 repo 文档审查",
    );
    const save = within(page).getByTestId("review-save") as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() =>
      expect(ws.writeWorkflowReview).toHaveBeenCalledWith({
        baseline: "replace",
        critical: [],
        warning: [],
        suggestion: [],
      }),
    );
  });

  it("切回沿用并追加、清空某节：payload 带 extend 与空清单（移除语意由引擎落实；spec Scenario「清空即移除键」）", async () => {
    const ws = renderView(reviewSnap({ ...RULES, baseline: "replace" }), "review");
    const page = await screen.findByTestId("review-page");
    fireEvent.click(within(page).getByTestId("review-edit"));
    await chooseBaseline(page, "沿用并追加");
    typeInEditor(within(page).getByTestId("review-input-suggestion"), "");
    fireEvent.click(within(page).getByTestId("review-save"));
    await waitFor(() =>
      expect(ws.writeWorkflowReview).toHaveBeenCalledWith({ ...RULES, baseline: "extend", suggestion: [] }),
    );
  });

  it("取消：还原唯读且不写入；重进编辑草稿已重设；未存修改回报随草稿起落", async () => {
    const onDirtyChange = vi.fn();
    const ws = fakeSettings(reviewSnap());
    render(<Harness settings={ws} initial="review" onDirtyChange={onDirtyChange} />);
    const page = await screen.findByTestId("review-page");
    fireEvent.click(within(page).getByTestId("review-edit"));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    typeInEditor(within(page).getByTestId("review-input-critical"), "改掉");
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    fireEvent.click(within(page).getByTestId("review-cancel"));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
    expect(ws.writeWorkflowReview).not.toHaveBeenCalled();
    fireEvent.click(within(page).getByTestId("review-edit"));
    expect(editorText(within(page).getByTestId("review-input-critical"))).toBe(RULES.critical.join("\n"));
  });

  it("审查规则页编辑中，产出规则页照常唯读可用（一页进入编辑不影响其他页）", async () => {
    renderView(reviewSnap(), "review");
    const page = await screen.findByTestId("review-page");
    fireEvent.click(within(page).getByTestId("review-edit"));
    goto("rules");
    const rulesPage = screen.getByTestId("rules-page");
    expect(rulesPage.querySelector(".cm-editor")).toBeNull();
    expect((within(rulesPage).getByTestId("rules-edit") as HTMLButtonElement).disabled).toBe(false);
  });

  it("config.yaml 解析失败：页内浮出解析原因、编辑钮停用（spec Scenario「解析失败时停用编辑」）", async () => {
    const ws = fakeSettings(
      projectSnap({ context: null, rules: {}, schemaArtifacts: [], parseError: "review: unknown field `critcal`" }),
    );
    render(<Harness settings={ws} initial="review" />);
    const page = await screen.findByTestId("review-page");
    expect(within(page).getByText(/critcal/)).toBeTruthy();
    expect((within(page).getByTestId("review-edit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("远程项目：保存带 expected revision 的写入、成功后 revision 前进；409 时输入保留并浮出 review 对照（spec Scenario「远程项目保存带 revision」）", async () => {
    const initial = projectSnap({ revision: 41, review: RULES } as Partial<SettingsSnapshot["workflow"]>);
    const latest = projectSnap({
      revision: 42,
      review: { ...RULES, critical: ["server 端的规则"] },
    } as Partial<SettingsSnapshot["workflow"]>);
    const ws = {
      ...fakeSettings(initial),
      kind: "remote",
      writeWorkflowReview: vi
        .fn()
        .mockRejectedValueOnce({ message: "conflict", reason: "revision_conflict", status: 409 })
        .mockResolvedValueOnce(43),
    } as unknown as WorkspaceSettingsProvider;
    (ws.readSettings as ReturnType<typeof vi.fn>)
      .mockReset()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(latest);
    render(<Harness settings={ws} initial="review" />);
    const page = await screen.findByTestId("review-page");
    expect(screen.getByTestId("policy-revision").textContent).toContain("41");
    fireEvent.click(within(page).getByTestId("review-edit"));
    typeInEditor(within(page).getByTestId("review-input-critical"), "我添加的 CRITICAL 规则");
    fireEvent.click(within(page).getByTestId("review-save"));

    const panel = await screen.findByTestId("policy-conflict-panel");
    const row = within(panel).getByTestId("conflict-row-review-critical");
    expect(within(row).getByTestId("conflict-server").textContent).toContain("server 端的规则");
    expect(within(row).getByTestId("conflict-mine").textContent).toContain("我添加的 CRITICAL 规则");
    expect(editorText(within(page).getByTestId("review-input-critical"))).toBe("我添加的 CRITICAL 规则");

    fireEvent.click(within(panel).getByRole("button", { name: "查看后以最新 revision 重新提交" }));
    await waitFor(() => expect(screen.queryByTestId("policy-conflict-panel")).toBeNull());
    expect(ws.writeWorkflowReview).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("policy-revision").textContent).toContain("43");
  });

  it("只改模式时，没编辑的多行规则原样写回不拆开；进入编辑未改动不算未存修改（review R3／R7）", async () => {
    const multi: ReviewRules = { ...RULES, critical: ["第一行\n第二行", ...RULES.critical] };
    const onDirtyChange = vi.fn();
    const ws = fakeSettings(reviewSnap(multi));
    render(<Harness settings={ws} initial="review" onDirtyChange={onDirtyChange} />);
    const page = await screen.findByTestId("review-page");
    fireEvent.click(within(page).getByTestId("review-edit"));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    await chooseBaseline(page, "整份换掉");
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    fireEvent.click(within(page).getByTestId("review-save"));
    await waitFor(() => expect(ws.writeWorkflowReview).toHaveBeenCalledWith({ ...multi, baseline: "replace" }));
  });

  it("产出规则只改一节时，其他节的多行规则原样写回不拆开（review R3 同类位置）", async () => {
    const ws = renderView(
      projectSnap({ rules: { proposal: ["提案必须列出影响的 crates"], tasks: ["第一行\n第二行"] } }),
      "rules",
    );
    const page = await screen.findByTestId("rules-page");
    fireEvent.click(within(page).getByTestId("rules-edit"));
    typeInEditor(within(page).getByTestId("rules-input-proposal"), "新的提案规则");
    fireEvent.click(within(page).getByTestId("rules-save"));
    await waitFor(() => expect(ws.writeWorkflowRules).toHaveBeenCalledTimes(1));
    const payload = Object.fromEntries((ws.writeWorkflowRules as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(payload.proposal).toEqual(["新的提案规则"]);
    expect(payload.tasks).toEqual(["第一行\n第二行"]);
  });

  it("别区的冲突重送后，审查规则采纳 server 最新值，之后保存不盖掉别人的修改（review R8）", async () => {
    const initial = projectSnap({ revision: 41, review: RULES } as Partial<SettingsSnapshot["workflow"]>);
    const serverReview: ReviewRules = { ...RULES, warning: ["别人刚加的 WARNING"] };
    const latest = projectSnap({
      revision: 42,
      context: "server 较新的说明",
      review: serverReview,
    } as Partial<SettingsSnapshot["workflow"]>);
    const ws = {
      ...fakeSettings(initial),
      kind: "remote",
      writeWorkflowContext: vi
        .fn()
        .mockRejectedValueOnce({ message: "conflict", reason: "revision_conflict", status: 409 })
        .mockResolvedValueOnce(43),
      writeWorkflowReview: vi.fn().mockResolvedValue(44),
    } as unknown as WorkspaceSettingsProvider;
    (ws.readSettings as ReturnType<typeof vi.fn>)
      .mockReset()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(latest);
    render(<Harness settings={ws} initial="context" />);
    const contextPage = await screen.findByTestId("context-page");
    fireEvent.click(within(contextPage).getByTestId("context-edit"));
    typeInEditor(within(contextPage).getByTestId("context-input"), "我的说明");
    fireEvent.click(within(contextPage).getByTestId("context-save"));
    const panel = await screen.findByTestId("policy-conflict-panel");
    fireEvent.click(within(panel).getByRole("button", { name: "查看后以最新 revision 重新提交" }));
    await waitFor(() => expect(screen.queryByTestId("policy-conflict-panel")).toBeNull());

    goto("review");
    const page = screen.getByTestId("review-page");
    expect(within(page).getByTestId("review-section-warning").textContent).toContain("别人刚加的 WARNING");
    fireEvent.click(within(page).getByTestId("review-edit"));
    typeInEditor(within(page).getByTestId("review-input-suggestion"), "我的 SUGGESTION");
    fireEvent.click(within(page).getByTestId("review-save"));
    await waitFor(() =>
      expect(ws.writeWorkflowReview).toHaveBeenCalledWith({ ...serverReview, suggestion: ["我的 SUGGESTION"] }),
    );
  });
});

describe("子代理模型页（spec 需求「设置页编辑子代理模型」）", () => {
  /** spec Scenario「唯读呈现」的 config。 */
  const MODEL: SubagentModelConfig = {
    review: { claude: "opus", codex: "gpt-6.1-sol" },
    verify: { claude: "sonnet" },
    choices: { codex: ["gpt-6.1-sol", "gpt-6-astra"] },
  };
  const modelSnap = (subagentModel = MODEL, workflow: Partial<SettingsSnapshot["workflow"]> = {}) =>
    snapshot({
      app: { tools: ["claude", "codex"], customTools: [], parseError: null },
      workflow: { subagentModel, ...workflow } as SettingsSnapshot["workflow"],
    });
  const user = () => userEvent.setup({ pointerEventsCheck: 0 });
  /** 从某格的下拉选一个选项（Radix Select，与产出流程页 locale 同一组件）。 */
  async function choose(cell: string, option: string) {
    await user().click(screen.getByRole("combobox", { name: cell }));
    await user().click(await screen.findByRole("option", { name: option }));
  }
  async function openOptions(cell: string) {
    await user().click(screen.getByRole("combobox", { name: cell }));
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    await user().keyboard("{Escape}");
    return options;
  }
  async function openPage(ws: WorkspaceSettingsProvider) {
    render(<Harness settings={ws} initial="subagent" />);
    return screen.findByTestId("subagent-page");
  }
  const cellText = (station: string, tool: string) => screen.getByTestId(`subagent-cell-${station}-${tool}`).textContent;
  const written = (ws: WorkspaceSettingsProvider) =>
    (ws.writeWorkflowSubagentModel as ReturnType<typeof vi.fn>).mock.calls;

  it("唯读呈现：五列、来源小字、未激活、pi 说明、自订清单计数与文档注记（spec Scenario「唯读呈现」）", async () => {
    const page = await openPage(fakeSettings(modelSnap()));
    expect(within(page).getByRole("heading", { level: 2, name: "子代理模型" })).toBeTruthy();
    expect(screen.getByTestId("file-note-config").textContent).toBe("specseal/config.yaml · subagent_model");
    const rows = within(page).getAllByTestId(/^subagent-row-/);
    expect(rows.map((row) => row.getAttribute("data-testid"))).toEqual(
      ["claude", "codex", "copilot", "pi", "cursor"].map((tool) => `subagent-row-${tool}`),
    );
    expect(rows.map((row) => within(row).getByTestId("subagent-tool-name").textContent)).toEqual([
      "Claude Code",
      "Codex",
      "Copilot",
      "pi",
      "Cursor",
    ]);
    expect(cellText("review", "claude")).toBe("opus内置");
    expect(cellText("verify", "claude")).toBe("sonnet内置");
    expect(cellText("review", "codex")).toBe("gpt-6.1-sol自订清单");
    expect(cellText("verify", "codex")).toBe("沿用主对话");
    for (const tool of ["copilot", "pi", "cursor"]) {
      const row = within(page).getByTestId(`subagent-row-${tool}`);
      expect(within(row).getByText("未激活")).toBeTruthy();
      expect(cellText("review", tool)).toBe("沿用主对话");
      expect(cellText("verify", tool)).toBe("沿用主对话");
    }
    for (const tool of ["claude", "codex"]) {
      expect(within(within(page).getByTestId(`subagent-row-${tool}`)).queryByText("未激活")).toBeNull();
    }
    expect(within(within(page).getByTestId("subagent-row-pi")).getByText(/pi 本身不派子代理/)).toBeTruthy();
    const codexList = within(page).getByTestId("subagent-list-codex");
    expect(within(codexList).getByText("gpt-6.1-sol")).toBeTruthy();
    expect(within(codexList).getByText("gpt-6-astra")).toBeTruthy();
    expect(within(codexList).getByText("自订 2 个")).toBeTruthy();
    expect(within(within(page).getByTestId("subagent-list-copilot")).getByText("没有自订名称")).toBeTruthy();
    const claudeList = within(page).getByTestId("subagent-list-claude");
    for (const name of ["sonnet", "opus", "haiku", "fable"]) expect(within(claudeList).getByText(name)).toBeTruthy();
    expect(within(page).getByText(/模型名称不预先检查/)).toBeTruthy();
    expect(within(page).queryAllByRole("combobox")).toHaveLength(0);
  });

  it("各工具的下拉选项依内置清单与编辑中的自订清单组成（spec Example「各工具的下拉选项」）", async () => {
    const page = await openPage(fakeSettings(modelSnap()));
    fireEvent.click(within(page).getByTestId("subagent-edit"));
    expect(await openOptions("Claude Code · 审查")).toEqual(["沿用主对话", "sonnet", "opus", "haiku", "fable", "自行输入…"]);
    expect(await openOptions("Codex · 审查")).toEqual(["沿用主对话", "gpt-6.1-sol", "gpt-6-astra", "自行输入…"]);
    expect(await openOptions("Copilot · 审查")).toEqual(["沿用主对话", "自行输入…"]);
    typeInEditor(within(page).getByTestId("subagent-list-input-claude"), "opus\nclaude-x");
    expect(await openOptions("Claude Code · 审查")).toEqual([
      "沿用主对话",
      "sonnet",
      "opus",
      "haiku",
      "fable",
      "claude-x",
      "自行输入…",
    ]);
    await user().click(screen.getByRole("combobox", { name: "Claude Code · 审查" }));
    expect(screen.getByRole("group", { name: "内置" })).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "自订清单" })).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "claude-x",
    ]);
  });

  it("自行输入的模型名称去头尾空白、不加进清单；回唯读显示「自行输入」（spec Scenario「自行输入的模型名称」）", async () => {
    const ws = fakeSettings(modelSnap());
    const page = await openPage(ws);
    fireEvent.click(within(page).getByTestId("subagent-edit"));
    expect(screen.queryByLabelText("Copilot · 验证 · 模型名称")).toBeNull();
    await choose("Copilot · 验证", "自行输入…");
    const input = screen.getByLabelText("Copilot · 验证 · 模型名称");
    expect(within(screen.getByTestId("subagent-cell-verify-copilot")).getByText("输入的名称不会加进自订清单")).toBeTruthy();
    fireEvent.change(input, { target: { value: " gpt-5.6 " } });
    fireEvent.keyDown(input, { key: "s", ctrlKey: true });
    await waitFor(() => expect(written(ws)).toHaveLength(1));
    expect(written(ws)[0][0]).toEqual({ ...MODEL, verify: { claude: "sonnet", copilot: "gpt-5.6" } });
    await waitFor(() => expect(within(page).queryAllByRole("combobox")).toHaveLength(0));
    expect(cellText("verify", "copilot")).toBe("gpt-5.6自行输入");
  });

  it("编辑并保存仅写 subagent_model（spec Scenario「编辑并保存仅写 subagent_model」）", async () => {
    const ws = fakeSettings(modelSnap());
    const page = await openPage(ws);
    fireEvent.click(within(page).getByTestId("subagent-edit"));
    await choose("Codex · 验证", "gpt-6-astra");
    fireEvent.click(within(page).getByTestId("subagent-save"));
    await waitFor(() => expect(written(ws)).toHaveLength(1));
    expect(written(ws)[0][0]).toEqual({ ...MODEL, verify: { claude: "sonnet", codex: "gpt-6-astra" } });
    expect(ws.writeWorkflowReview).not.toHaveBeenCalled();
    expect(ws.writeWorkflowContext).not.toHaveBeenCalled();
    expect(ws.writeWorkflowRules).not.toHaveBeenCalled();
    expect(ws.writeWorkflowConfig).not.toHaveBeenCalled();
    await waitFor(() => expect(cellText("verify", "codex")).toBe("gpt-6-astra自订清单"));
  });

  // spec Example「移除语意」——逐列对应：起始区块与操作照表，断言送出的 payload（文档效果由引擎落实）。
  it.each<{ row: string; before: SubagentModelConfig; act: () => Promise<void>; after: SubagentModelConfig }>([
    {
      row: "claude 的验证格选「沿用主对话」",
      before: { review: { claude: "opus" }, verify: { claude: "sonnet" }, choices: {} },
      act: () => choose("Claude Code · 验证", "沿用主对话"),
      after: { review: { claude: "opus" }, verify: {}, choices: {} },
    },
    {
      row: "清空 Codex 的自订清单",
      before: { review: { claude: "opus" }, verify: {}, choices: { codex: ["gpt-6.1-sol", "gpt-6-astra"] } },
      act: async () => typeInEditor(screen.getByTestId("subagent-list-input-codex"), ""),
      after: { review: { claude: "opus" }, verify: {}, choices: {} },
    },
    {
      row: "该格选「自行输入…」并清空输入框",
      before: { review: { claude: "opus" }, verify: {}, choices: {} },
      act: async () => {
        await choose("Claude Code · 审查", "自行输入…");
        fireEvent.change(screen.getByLabelText("Claude Code · 审查 · 模型名称"), { target: { value: "" } });
      },
      after: { review: {}, verify: {}, choices: {} },
    },
  ])("清空即移除键：$row（spec Scenario「清空即移除键」）", async ({ before, act, after }) => {
    const ws = fakeSettings(modelSnap(before));
    const page = await openPage(ws);
    fireEvent.click(within(page).getByTestId("subagent-edit"));
    await act();
    fireEvent.click(within(page).getByTestId("subagent-save"));
    await waitFor(() => expect(written(ws)).toHaveLength(1));
    expect(written(ws)[0][0]).toEqual(after);
  });

  it("删掉已选用的名称：该格改显示自行输入并保留原值（spec Scenario「删掉已选用的名称改显示为自行输入」）", async () => {
    const ws = fakeSettings(modelSnap());
    const page = await openPage(ws);
    fireEvent.click(within(page).getByTestId("subagent-edit"));
    typeInEditor(within(page).getByTestId("subagent-list-input-codex"), "gpt-6-astra");
    expect(screen.getByRole("combobox", { name: "Codex · 审查" }).textContent).toContain("自行输入…");
    expect((screen.getByLabelText("Codex · 审查 · 模型名称") as HTMLInputElement).value).toBe("gpt-6.1-sol");
    fireEvent.click(within(page).getByTestId("subagent-save"));
    await waitFor(() => expect(written(ws)).toHaveLength(1));
    expect(written(ws)[0][0]).toEqual({ ...MODEL, choices: { codex: ["gpt-6-astra"] } });
    await waitFor(() => expect(cellText("review", "codex")).toBe("gpt-6.1-sol自行输入"));
  });

  it("内置工具以外的工具名称不列出、保存时原样保留（spec Scenario「内置工具以外的工具名称原样保留」）", async () => {
    const withAgent: SubagentModelConfig = {
      review: { "my-agent": "model-a" },
      verify: {},
      choices: { "my-agent": ["model-a"] },
    };
    const ws = fakeSettings(modelSnap(withAgent));
    const page = await openPage(ws);
    expect(within(page).queryByText("my-agent")).toBeNull();
    expect(within(page).queryByTestId("subagent-row-my-agent")).toBeNull();
    fireEvent.click(within(page).getByTestId("subagent-edit"));
    await choose("Claude Code · 审查", "opus");
    fireEvent.click(within(page).getByTestId("subagent-save"));
    await waitFor(() => expect(written(ws)).toHaveLength(1));
    expect(written(ws)[0][0]).toEqual({ ...withAgent, review: { "my-agent": "model-a", claude: "opus" } });
  });

  it("内容未变时不调用写入、直接回唯读（spec Scenario「内容未变时不写入」）", async () => {
    const ws = fakeSettings(modelSnap());
    const page = await openPage(ws);
    fireEvent.click(within(page).getByTestId("subagent-edit"));
    fireEvent.click(within(page).getByTestId("subagent-save"));
    await waitFor(() => expect(within(page).queryAllByRole("combobox")).toHaveLength(0));
    expect(ws.writeWorkflowSubagentModel).not.toHaveBeenCalled();
  });

  it("取消：回唯读显示原值且不写入；未存修改回报随草稿起落（spec Scenario「取消不写入」）", async () => {
    const onDirtyChange = vi.fn();
    const ws = fakeSettings(modelSnap());
    render(<Harness settings={ws} initial="subagent" onDirtyChange={onDirtyChange} />);
    const page = await screen.findByTestId("subagent-page");
    fireEvent.click(within(page).getByTestId("subagent-edit"));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    await choose("Claude Code · 审查", "haiku");
    await choose("Cursor · 验证", "自行输入…");
    typeInEditor(within(page).getByTestId("subagent-list-input-copilot"), "gpt-5.6");
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    fireEvent.click(within(page).getByTestId("subagent-cancel"));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
    expect(ws.writeWorkflowSubagentModel).not.toHaveBeenCalled();
    expect(cellText("review", "claude")).toBe("opus内置");
    expect(within(within(page).getByTestId("subagent-list-copilot")).getByText("没有自订名称")).toBeTruthy();
  });

  it(".specseal.yaml 解析失败时不标「未激活」（不知道勾了哪些工具，review R8）", async () => {
    const page = await openPage(
      fakeSettings(snapshot({ app: { tools: [], customTools: [], parseError: "tools: invalid" }, workflow: { subagentModel: MODEL } as SettingsSnapshot["workflow"] })),
    );
    expect(within(page).queryByText("未激活")).toBeNull();
  });

  it("本机写入失败：单行错误、停在编辑态、输入保留（设计失败模式「本机写入失败」）", async () => {
    const ws = {
      ...fakeSettings(modelSnap()),
      writeWorkflowSubagentModel: vi.fn().mockRejectedValue("specseal/config.yaml: write failed: permission denied"),
    } as unknown as WorkspaceSettingsProvider;
    const page = await openPage(ws);
    fireEvent.click(within(page).getByTestId("subagent-edit"));
    await choose("Claude Code · 审查", "haiku");
    fireEvent.click(within(page).getByTestId("subagent-save"));
    expect(await within(page).findByText("specseal/config.yaml: write failed: permission denied")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Claude Code · 审查" }).textContent).toContain("haiku");
  });

  it("冲突对照遇到 constructor 这类与对象内置属性同名的工具名称照常列出（review R9）", async () => {
    const remoteSnap = (subagentModel: SubagentModelConfig, revision: number) =>
      snapshot({
        app: { tools: [], customTools: [], parseError: null },
        workflow: { subagentModel, revision } as SettingsSnapshot["workflow"],
      });
    const initial = remoteSnap({ review: {}, verify: {}, choices: {} }, 41);
    const latest = remoteSnap({ review: { constructor: "model-x" }, verify: {}, choices: { constructor: ["model-x"] } }, 42);
    const ws = {
      ...fakeSettings(initial),
      kind: "remote",
      writeWorkflowSubagentModel: vi.fn().mockRejectedValueOnce({ message: "conflict", reason: "revision_conflict", status: 409 }),
    } as unknown as WorkspaceSettingsProvider;
    (ws.readSettings as ReturnType<typeof vi.fn>).mockReset().mockResolvedValueOnce(initial).mockResolvedValueOnce(latest);
    const page = await openPage(ws);
    fireEvent.click(within(page).getByTestId("subagent-edit"));
    await choose("Claude Code · 审查", "opus");
    fireEvent.click(within(page).getByTestId("subagent-save"));
    const panel = await screen.findByTestId("policy-conflict-panel");
    for (const key of ["subagent_model.review.constructor", "subagent_model.choices.constructor"]) {
      const row = within(panel).getByTestId(`conflict-row-${key}`);
      expect(within(row).getByTestId("conflict-server").textContent).toBe("model-x");
      expect(within(row).getByTestId("conflict-mine").textContent).toBe("—");
    }
  });

  it("子代理模型页编辑中，审查规则页照常唯读可用（一页进入编辑不影响其他页）", async () => {
    const page = await openPage(fakeSettings(modelSnap()));
    fireEvent.click(within(page).getByTestId("subagent-edit"));
    goto("review");
    const reviewPage = screen.getByTestId("review-page");
    expect((within(reviewPage).getByTestId("review-edit") as HTMLButtonElement).disabled).toBe(false);
  });

  it("config.yaml 解析失败：页内浮出解析原因、编辑钮停用（spec Scenario「解析失败时停用编辑」）", async () => {
    const ws = fakeSettings(
      modelSnap({ review: {}, verify: {}, choices: {} }, { parseError: "subagent_model: unknown field `reveiw`" }),
    );
    const page = await openPage(ws);
    expect(within(page).getByText(/reveiw/)).toBeTruthy();
    expect((within(page).getByTestId("subagent-edit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("远程项目：不显示未激活；保存带 revision，409 时输入保留并浮出 subagent_model 对照（spec Scenario「远程项目保存带 revision」）", async () => {
    const remoteSnap = (subagentModel: SubagentModelConfig, revision: number) =>
      snapshot({
        app: { tools: [], customTools: [], parseError: null },
        workflow: { subagentModel, revision } as SettingsSnapshot["workflow"],
      });
    const initial = remoteSnap({ review: {}, verify: {}, choices: {} }, 41);
    const latest = remoteSnap({ review: { claude: "haiku" }, verify: {}, choices: {} }, 42);
    const ws = {
      ...fakeSettings(initial),
      kind: "remote",
      writeWorkflowSubagentModel: vi
        .fn()
        .mockRejectedValueOnce({ message: "conflict", reason: "revision_conflict", status: 409 })
        .mockResolvedValueOnce(43),
    } as unknown as WorkspaceSettingsProvider;
    (ws.readSettings as ReturnType<typeof vi.fn>).mockReset().mockResolvedValueOnce(initial).mockResolvedValueOnce(latest);
    const page = await openPage(ws);
    expect(screen.getByTestId("policy-revision").textContent).toContain("41");
    expect(within(page).queryByText("未激活")).toBeNull();
    fireEvent.click(within(page).getByTestId("subagent-edit"));
    await choose("Claude Code · 审查", "opus");
    fireEvent.click(within(page).getByTestId("subagent-save"));

    const panel = await screen.findByTestId("policy-conflict-panel");
    const row = within(panel).getByTestId("conflict-row-subagent_model.review.claude");
    expect(within(row).getByText("subagent_model.review.claude")).toBeTruthy();
    expect(within(row).getByTestId("conflict-server").textContent).toBe("haiku");
    expect(within(row).getByTestId("conflict-mine").textContent).toBe("opus");
    expect(screen.getByRole("combobox", { name: "Claude Code · 审查" }).textContent).toContain("opus");

    fireEvent.click(within(panel).getByRole("button", { name: "查看后以最新 revision 重新提交" }));
    await waitFor(() => expect(screen.queryByTestId("policy-conflict-panel")).toBeNull());
    expect(ws.writeWorkflowSubagentModel).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("policy-revision").textContent).toContain("43");
    expect(cellText("review", "claude")).toBe("opus内置");
  });
});

describe("编辑中被别的写入带到较新的 revision（review R3）", () => {
  const RULES0: ReviewRules = { baseline: "extend", critical: [], warning: ["旧的 WARNING"], suggestion: [] };
  const initial = projectSnap({
    revision: 41,
    review: RULES0,
    subagentModel: { review: { "my-agent": "model-a" }, verify: {}, choices: {} },
  } as Partial<SettingsSnapshot["workflow"]>);
  // server 上四块内容都被别人改过。
  const latest = projectSnap({
    revision: 42,
    context: "server 较新的说明",
    rules: { proposal: ["提案必须列出影响的 crates"], tasks: ["别人改的任务规则"] },
    review: { ...RULES0, warning: ["别人加的 WARNING"] },
    subagentModel: { review: { "my-agent": "model-b" }, verify: {}, choices: {} },
  } as Partial<SettingsSnapshot["workflow"]>);
  const user = () => userEvent.setup({ pointerEventsCheck: 0 });

  type Card = {
    section: ProjectSettingsSection;
    edit: () => Promise<void>;
    save: string;
    writer: keyof WorkspaceSettingsProvider;
    row: string;
  };
  const CARDS: Record<string, Card> = {
    subagent: {
      section: "subagent",
      edit: async () => {
        fireEvent.click(screen.getByTestId("subagent-edit"));
        await user().click(screen.getByRole("combobox", { name: "Claude Code · 审查" }));
        await user().click(await screen.findByRole("option", { name: "opus" }));
      },
      save: "subagent-save",
      writer: "writeWorkflowSubagentModel",
      row: "subagent_model.review.my-agent",
    },
    review: {
      section: "review",
      edit: async () => {
        fireEvent.click(screen.getByTestId("review-edit"));
        typeInEditor(screen.getByTestId("review-input-critical"), "我的 CRITICAL 规则");
      },
      save: "review-save",
      writer: "writeWorkflowReview",
      row: "review-warning",
    },
    rules: {
      section: "rules",
      edit: async () => {
        fireEvent.click(screen.getByTestId("rules-edit"));
        typeInEditor(screen.getByTestId("rules-input-proposal"), "我的提案规则");
      },
      save: "rules-save",
      writer: "writeWorkflowRules",
      row: "rules-tasks",
    },
    context: {
      section: "context",
      edit: async () => {
        fireEvent.click(screen.getByTestId("context-edit"));
        typeInEditor(screen.getByTestId("context-input"), "我的说明");
      },
      save: "context-save",
      writer: "writeWorkflowContext",
      row: "context",
    },
  };

  it.each([
    ["subagent", "context"],
    ["review", "context"],
    ["rules", "context"],
    ["context", "review"],
  ])("%s 页编辑中、%s 页撞 409 后重送成功：保存先浮出对照、不直接写入", async (editing, other) => {
    const card = CARDS[editing];
    const otherCard = CARDS[other];
    const ws = {
      ...fakeSettings(initial),
      kind: "remote",
      writeWorkflowContext: vi.fn().mockResolvedValue(50),
      writeWorkflowRules: vi.fn().mockResolvedValue(50),
      writeWorkflowReview: vi.fn().mockResolvedValue(50),
      writeWorkflowSubagentModel: vi.fn().mockResolvedValue(50),
    } as unknown as WorkspaceSettingsProvider;
    (ws[otherCard.writer] as ReturnType<typeof vi.fn>)
      .mockReset()
      .mockRejectedValueOnce({ message: "conflict", reason: "revision_conflict", status: 409 })
      .mockResolvedValueOnce(43);
    (ws.readSettings as ReturnType<typeof vi.fn>).mockReset().mockResolvedValueOnce(initial).mockResolvedValue(latest);
    render(<Harness settings={ws} initial={card.section} />);
    await screen.findByTestId(`${card.save.replace("-save", "")}-edit`);
    await card.edit();

    goto(otherCard.section);
    await otherCard.edit();
    fireEvent.click(screen.getByTestId(otherCard.save));
    const first = await screen.findByTestId("policy-conflict-panel");
    fireEvent.click(within(first).getByRole("button", { name: "查看后以最新 revision 重新提交" }));
    await waitFor(() => expect(screen.queryByTestId("policy-conflict-panel")).toBeNull());

    goto(card.section);
    fireEvent.click(screen.getByTestId(card.save));
    const panel = await screen.findByTestId("policy-conflict-panel");
    expect(ws[card.writer]).not.toHaveBeenCalled();
    const row = within(panel).getByTestId(`conflict-row-${card.row}`);
    expect(within(row).getByTestId("conflict-server").textContent).not.toBe(within(row).getByTestId("conflict-mine").textContent);

    fireEvent.click(within(panel).getByRole("button", { name: "查看后以最新 revision 重新提交" }));
    await waitFor(() => expect(ws[card.writer]).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId("policy-conflict-panel")).toBeNull());
  });
});
