// 代码编辑器（desktop-settings-editors design D1）：包 CodeMirror 6——markdown／纯文本两模式、
// 行号、自动换行、Mod-s 保存与底部状态栏；配色只取设计 token，盖掉套件基底主题的每个颜色
// （spec「表单控制项与按钮以主题化组件呈现」）。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Annotation, Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { tags } from "@lezer/highlight";
import { useI18n } from "@specseal/ui";

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  mode: "markdown" | "plain";
  readOnly?: boolean;
  onSave?: () => void;
  /** 内容区最小高度（行数）。 */
  minLines?: number;
  ariaLabel: string;
  autoFocus?: boolean;
}

const LINE_HEIGHT = 1.7;

const tokenTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "var(--foreground)", fontSize: "13px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: String(LINE_HEIGHT) },
  ".cm-content": { caretColor: "var(--foreground)", padding: "6px 0" },
  ".cm-line": { padding: "0 16px 0 12px" },
  ".cm-gutters": {
    backgroundColor: "var(--muted)",
    color: "var(--muted-foreground)",
    borderRight: "1px solid var(--border)",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 12px" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--primary) 6%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--foreground)" },
  ".cm-specialChar": { color: "var(--destructive)" },
});

const markdownHighlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "600", color: "var(--foreground)" },
  { tag: tags.monospace, backgroundColor: "var(--muted)", borderRadius: "3px" },
  { tag: [tags.link, tags.url], color: "var(--primary)" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
]);

/** 外部 value 同步的 transaction 标记：这类变动不回送 onChange。 */
const syncFromProps = Annotation.define<boolean>();

const cursorOf = (state: EditorState) => {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  return { line: line.number, col: head - line.from + 1 };
};

export function CodeEditor({
  value,
  onChange,
  mode,
  readOnly = false,
  onSave,
  minLines,
  ariaLabel,
  autoFocus,
}: CodeEditorProps) {
  const { t } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // 唯读只设 EditorState.readOnly：输入被忽略，但内容区仍可聚焦——关掉 editable 会让
  // WebView 把焦点移走，保存失败恢复可编辑后焦点也回不来。
  const readOnlyMode = useRef(new Compartment()).current;
  // 编辑器只建一次，扩充内的回呼经 ref 取最新 props。
  const latest = useRef({ onChange, onSave });
  latest.current = { onChange, onSave };
  const [cursor, setCursor] = useState({ line: 1, col: 1 });

  useEffect(() => {
    const created = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          EditorView.lineWrapping,
          history(),
          keymap.of([
            {
              key: "Mod-s",
              // 唯读时不拦：事件交给页层，由它决定是否保存。
              run: (view) => {
                if (!latest.current.onSave || view.state.readOnly) return false;
                latest.current.onSave();
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
          ]),
          readOnlyMode.of(EditorState.readOnly.of(readOnly)),
          EditorView.contentAttributes.of({
            "aria-label": ariaLabel,
            ...(minLines ? { style: `min-height: ${minLines * LINE_HEIGHT}em` } : {}),
          }),
          mode === "markdown" ? [markdownLanguage, syntaxHighlighting(markdownHighlight)] : [],
          tokenTheme,
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !update.transactions.some((tr) => tr.annotation(syncFromProps))) {
              latest.current.onChange(update.state.doc.toString());
            }
            if (update.docChanged || update.selectionSet) setCursor(cursorOf(update.state));
          }),
        ],
      }),
    });
    view.current = created;
    if (autoFocus) created.focus();
    return () => {
      created.destroy();
      view.current = null;
    };
    // 只在挂载时创建：mode／ariaLabel／minLines／autoFocus 由调用端固定，value 与 readOnly 由下方同步。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // layout effect：commit 后立刻同步，不留让新按键插进来、再被旧 value 盖掉的空档。
  useLayoutEffect(() => {
    const current = view.current;
    if (!current || current.state.doc.toString() === value) return;
    current.dispatch({
      changes: { from: 0, to: current.state.doc.length, insert: value },
      selection: { anchor: Math.min(current.state.selection.main.head, value.length) },
      annotations: syncFromProps.of(true),
    });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: readOnlyMode.reconfigure(EditorState.readOnly.of(readOnly)) });
  }, [readOnly, readOnlyMode]);

  return (
    <div
      data-slot="code-editor"
      className="flex flex-col overflow-hidden rounded-xl border border-border bg-card font-mono transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30"
    >
      <div ref={host} />
      <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        <span>
          {t(mode === "markdown" ? "settings.editor.markdownMode" : "settings.editor.plainMode")} ·{" "}
          {t("settings.editor.wrap")}
        </span>
        <span>
          {t("settings.editor.cursor")
            .replace("{line}", String(cursor.line))
            .replace("{col}", String(cursor.col))}
        </span>
      </div>
    </div>
  );
}
