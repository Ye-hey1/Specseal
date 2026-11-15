// CodeMirror 的测试辅助（desktop-settings-editors design D1）：读写编辑器内容与按快捷键。
// jsdom 缺的 Range 量测补在 vitest.setup.ts。
import { act, fireEvent } from "@testing-library/react";
import { EditorView } from "@codemirror/view";

/** container 内第一个（或唯一的）编辑器。 */
export function editorView(container: HTMLElement): EditorView {
  const dom = container.querySelector<HTMLElement>(".cm-editor");
  const view = dom && EditorView.findFromDOM(dom);
  if (!view) throw new Error("no CodeMirror editor in container");
  return view;
}

export const editorText = (container: HTMLElement) => editorView(container).state.doc.toString();

/** 用户输入事件：缺省整份换成 text；`append` 时接在文档尾端。 */
export function typeInEditor(container: HTMLElement, text: string, { append = false } = {}) {
  const view = editorView(container);
  const to = view.state.doc.length;
  act(() =>
    view.dispatch({ changes: { from: append ? to : 0, to, insert: text }, userEvent: "input.type" }),
  );
}

/** 在编辑器内按 Mod-s（jsdom 非 macOS，Mod＝Ctrl）；回传事件供检查 defaultPrevented。 */
export function pressSave(container: HTMLElement): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true });
  act(() => {
    fireEvent(editorView(container).contentDOM, event);
  });
  return event;
}
