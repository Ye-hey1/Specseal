// CodeEditor（desktop-settings-editors design D1；spec「表单控制项与按钮以主题化组件呈现」）：
// 测组件外壳行为——初值、onChange 全文、外部 value 同步、Mod-s、唯读、状态栏、行号；不测算绘。
import { describe, it, expect, vi } from "vitest";
import { render as rtlRender, screen, act } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { I18nProvider } from "@specseal/ui";

import { CodeEditor } from "../components/CodeEditor";
import { APP_MESSAGES } from "../i18n/messages";
import { editorText, editorView, pressSave, typeInEditor } from "./helpers/codemirror";

const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN" messages={APP_MESSAGES}>
    {children}
  </I18nProvider>
);
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: zhWrapper });

function mount(over: Partial<Parameters<typeof CodeEditor>[0]> = {}) {
  const onChange = vi.fn();
  const onSave = vi.fn();
  const props = {
    value: "# 标题\n\n第二段",
    onChange,
    onSave,
    mode: "markdown" as const,
    ariaLabel: "项目说明",
    ...over,
  };
  const utils = render(
    <div data-testid="host">
      <CodeEditor {...props} />
    </div>,
  );
  return { ...utils, onChange, onSave, host: screen.getByTestId("host"), props };
}

describe("CodeEditor", () => {
  it("挂载后呈现初值，内容区为带名称的 textbox", () => {
    const { host } = mount();
    expect(editorText(host)).toBe("# 标题\n\n第二段");
    expect(screen.getByRole("textbox", { name: "项目说明" })).toBeTruthy();
  });

  it("输入后 onChange 收到全文", () => {
    const { host, onChange } = mount();
    typeInEditor(host, "\n加一行", { append: true });
    expect(onChange).toHaveBeenLastCalledWith("# 标题\n\n第二段\n加一行");
  });

  it("value 外部变动反映到编辑器，且不回送 onChange", () => {
    const { host, onChange, rerender, props } = mount();
    rerender(
      <div data-testid="host">
        <CodeEditor {...props} value="外部换掉的内容" />
      </div>,
    );
    expect(editorText(host)).toBe("外部换掉的内容");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Mod-s 调用 onSave 并拦下浏览器缺省", () => {
    const { host, onSave } = mount();
    const event = pressSave(host);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("readOnly 时 Mod-s 不调用 onSave，也不拦下事件（交给页层处理）", () => {
    const { host, onSave } = mount({ readOnly: true });
    const event = pressSave(host);
    expect(onSave).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("readOnly 不可输入，但内容区仍可聚焦（焦点不被移走）", () => {
    const { host } = mount({ readOnly: true });
    const view = editorView(host);
    expect(view.state.readOnly).toBe(true);
    expect(view.contentDOM.getAttribute("aria-readonly")).toBe("true");
    expect(view.contentDOM.getAttribute("contenteditable")).toBe("true");
  });

  it("状态栏显示模式、自动换行与光标行栏", () => {
    const { host } = mount();
    expect(host.textContent).toContain("markdown · 自动换行");
    expect(host.textContent).toContain("第 1 行，第 1 栏");
    const view = editorView(host);
    act(() => view.dispatch({ selection: { anchor: view.state.doc.line(3).from + 2 } }));
    expect(host.textContent).toContain("第 3 行，第 3 栏");
  });

  it("纯文本模式的状态栏标示纯文本", () => {
    const { host } = mount({ mode: "plain", value: "一行" });
    expect(host.textContent).toContain("纯文本 · 自动换行");
  });

  it("markdown 模式有行号节点", () => {
    const { host } = mount();
    expect(host.querySelector(".cm-lineNumbers .cm-gutterElement")).not.toBeNull();
  });

  it("markdown 模式的标题行带语法上色节点，纯文本模式没有", () => {
    const { host, unmount } = mount();
    expect(host.querySelector(".cm-line span")).not.toBeNull();
    unmount();
    const plain = mount({ mode: "plain" });
    expect(plain.host.querySelector(".cm-line span")).toBeNull();
  });
});
