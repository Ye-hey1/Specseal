import { useMemo } from "react";
import { Check, Copy } from "lucide-react";
import remarkBreaks from "remark-breaks";
import {
  defaultRehypePlugins,
  defaultRemarkPlugins,
  Streamdown,
  type StreamdownProps,
} from "streamdown";
import { code } from "@streamdown/code";

import { useI18n } from "../i18n";
import { nameSpans } from "../discussionModel";
import { cn } from "../lib/utils";
import { rehypeSpecKeywords } from "../specSections";
import { SEMANTIC_SURFACE, SEMANTIC_TONE } from "../tone";
import { CALLOUT_BOX_CLS, CALLOUT_TITLE_CLS, CALLOUT_TONE, type CalloutTone } from "./ui/callout";

export interface MarkdownProps {
  content: string | null;
  /** 空状态文案；省略时用 i18n 缺省「（无内容）」。 */
  empty?: string;
  /** 以等宽灰底标示 SHALL／MUST 关键字（规格详情页的需求文与 Scenario）。 */
  specKeywords?: boolean;
  /** 合进外层 `.markdown` 容器（如列内行内排版的 `[&_p]:my-0`）；与缺省冲突的 class 以后者为准。 */
  className?: string;
  /** 文中名称签（讨论背景）：与名单完全相同的字词换成 `span.name-chip[data-name-chip="<kind>:<name>"]`；
   * 款式与点击由调用端容器负责。缺席或空数组时管线不变。 */
  nameChips?: NameChip[];
}

/** 一颗名称签的来源：种类（spec／change／archived／discussion 等，调用端自订）与名称。 */
export interface NameChip {
  kind: string;
  name: string;
}

/** GitHub Alert 四型（desktop-manual-page spec「Markdown 的 GitHub Alert 提示框」）
 * → i18n 标签键；款式与语意色取自 Callout 原语（design D6）。 */
type AlertType = CalloutTone;
const ALERT_LABEL_KEYS: Record<AlertType, string> = {
  note: "markdown.alertNote",
  tip: "markdown.alertTip",
  warning: "markdown.alertWarning",
  caution: "markdown.alertCaution",
};
// 标记须独占首段第一行（与 GitHub 同：`[!NOTE]` 后只能接换行或段落结束；大小写不拘）。
const ALERT_MARKER_RE = /^\[!(NOTE|TIP|WARNING|CAUTION)\][ \t]*(?:\r?\n|$)/i;

/** 提示框用到的全部 class token。Streamdown 的 sanitize 缺省剥掉 div 的 class，这里
 * 只放行这份清单——文档里的 raw HTML 不能借道塞任意 class。 */
const ALERT_CLASS_TOKENS = [
  ...new Set([
    "markdown-alert",
    ...Object.keys(CALLOUT_TONE).map((type) => `markdown-alert-${type}`),
    ...CALLOUT_BOX_CLS.split(" "),
    ...CALLOUT_TITLE_CLS.split(" "),
    ...Object.values(CALLOUT_TONE).flatMap((tone) => [
      ...SEMANTIC_SURFACE[tone].split(" "),
      ...SEMANTIC_TONE[tone].split(" "),
    ]),
  ]),
];

type Pluggable = NonNullable<StreamdownProps["rehypePlugins"]>[number];
type SanitizeSchema = { attributes?: Record<string, unknown[]> };

/** Streamdown 缺省 rehype 管线只取 sanitize 一段，schema 多放行提示框的 class（传自订
 * rehypePlugins 后 Streamdown 不再自动扩充 schema）。不接 raw：原始 HTML 由 remarkDropHtml
 * 整段丢弃。不接 harden：它在没有 defaultOrigin 时把 `editor.md` 这类裸相对链接换成 [blocked]，而手册
 * 的跨页链接正是这种写法；协定把关由 sanitize（挡 javascript: 等）承担。 */
const [sanitize, baseSchema] = defaultRehypePlugins.sanitize as unknown as [Pluggable, SanitizeSchema];
const REHYPE_PLUGINS: Pluggable[] = [
  [
    sanitize,
    {
      ...baseSchema,
      attributes: {
        ...baseSchema.attributes,
        div: [...(baseSchema.attributes?.div ?? []), ["className", ...ALERT_CLASS_TOKENS]],
      },
    },
  ] as Pluggable,
];
// 关键字插件接在 sanitize 之后：它产生的 spec-kw class 不经放行清单。
const SPEC_REHYPE_PLUGINS: Pluggable[] = [...REHYPE_PLUGINS, rehypeSpecKeywords as Pluggable];

/** 最小 hast 节点视图。 */
interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** 名称签插件（design D10）：接在 sanitize 之后，产生的 class 与 data 属性不经放行清单（与 rehypeSpecKeywords
 * 同一路）。名单以选项对象传入——Streamdown 以「插件函数名＋选项 JSON」缓存 processor，闭包式插件会让不同
 * 文档共用同一份。行内 code、代码区块与链接内不处理；命中规则与 matchNames 同一条边界、长名优先。 */
function rehypeNameChips({ names }: { names: NameChip[] }) {
  const kindOf = new Map<string, string>();
  for (const chip of names) if (!kindOf.has(chip.name)) kindOf.set(chip.name, chip.kind);
  const list = [...kindOf.keys()];
  const split = (value: string): HastNode[] | null => {
    const spans = nameSpans(value, list);
    if (spans.length === 0) return null;
    const out: HastNode[] = [];
    let last = 0;
    for (const { name, start, end } of spans) {
      if (start > last) out.push({ type: "text", value: value.slice(last, start) });
      out.push({
        type: "element",
        tagName: "span",
        properties: { className: ["name-chip"], dataNameChip: `${kindOf.get(name)}:${name}`, role: "button", tabIndex: 0 },
        children: [{ type: "text", value: name }],
      });
      last = end;
    }
    if (last < value.length) out.push({ type: "text", value: value.slice(last) });
    return out;
  };
  const walk = (node: HastNode) => {
    if (!node.children) return;
    if (node.type === "element" && (node.tagName === "code" || node.tagName === "pre" || node.tagName === "a")) return;
    node.children = node.children.flatMap((child) => {
      if (child.type === "text" && child.value) return split(child.value) ?? [child];
      walk(child);
      return [child];
    });
  };
  return walk;
}

const PLUGINS: StreamdownProps["plugins"] = { code };
const CONTROLS: StreamdownProps["controls"] = { code: { copy: true, download: false }, table: false, mermaid: false };
const ICONS: StreamdownProps["icons"] = { CopyIcon: Copy, CheckIcon: Check };
const LINK_SAFETY: StreamdownProps["linkSafety"] = { enabled: false };
const SHIKI_THEME: StreamdownProps["shikiTheme"] = ["github-light", "github-dark"];
/** Streamdown 内置控制钮（代码拷贝钮、图片下载钮）写死手指与停用禁止光标的 class，属 utilities 层、
 * 盖过 theme.css 的 base 层全域规则。容器的任意变体选择器权重较高，把光标盖回共用设置；代码区块的
 * 无外框图标钮另补圆角与 hover 淡底，图片下载钮自带底色、保留它的 hover 底色
 * （desktop-app「可点元素的光标与 hover 回馈」）。 */
const CONTROL_BUTTON_CLS =
  "[&_button]:cursor-(--cursor-interaction) [&_button:disabled]:cursor-default [&_[data-streamdown=code-block-actions]_button]:rounded-md [&_[data-streamdown=code-block-actions]_button:enabled]:hover:bg-foreground/5";

/** 最小 mdast 节点视图——只用到 type／value／children 与 hast 覆写数据，不引入
 * 类型套件相依。 */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

/** 原始 HTML（含注解）整段丢弃，与改版前的 skipHtml 一致：文档正文常把 `<summary>`、
 * `<template>` 这类占位字当字面写，解析成标签会把后文藏进收合区块或整段吞掉。
 * 必须在 mdast 阶段拿掉——rehype 管线不含 raw 时，Streamdown 会把 html 节点转成字面文本。 */
function remarkDropHtml() {
  const walk = (node: MdNode) => {
    if (!node.children) return;
    node.children = node.children.filter((child) => child.type !== "html");
    node.children.forEach(walk);
  };
  return walk;
}

/** 拆成单一 class token：sanitize 逐 token 比对放行清单，含空白的整串会被整个剥掉。 */
const classTokens = (...classes: string[]) => classes.flatMap((cls) => cls.split(" "));

/** 内置 remark 转换（design：三十行内、不添加相依）：首段以四型标记开头的
 * blockquote 改渲染为带类型 class 与类型标签的提示框、移除标记文本；其余
 * blockquote 不触碰。标签以 unified 插件选项传入（`[remarkGithubAlerts, labels]`）：
 * Streamdown 以「插件函数名＋选项 JSON」缓存 processor，闭包式插件会让不同语系共用同一份。 */
function remarkGithubAlerts(labels: Record<AlertType, string>) {
  const transform = (quote: MdNode) => {
    const first = quote.children?.[0];
    const text = first?.type === "paragraph" ? first.children?.[0] : undefined;
    if (!first || text?.type !== "text" || typeof text.value !== "string") return;
    const match = ALERT_MARKER_RE.exec(text.value);
    if (!match) return;
    const type = match[1].toLowerCase() as AlertType;
    const tone = CALLOUT_TONE[type];
    text.value = text.value.slice(match[0].length);
    if (!text.value) {
      first.children!.shift();
      // 标记行以硬换行结尾（行尾两空格）时，剩下的 break 节点也一并拿掉。
      if (first.children![0]?.type === "break") first.children!.shift();
    }
    if (first.children!.length === 0) quote.children!.shift();
    quote.data = {
      hName: "div",
      hProperties: {
        className: classTokens("markdown-alert", `markdown-alert-${type}`, CALLOUT_BOX_CLS, SEMANTIC_SURFACE[tone]),
      },
    };
    quote.children!.unshift({
      type: "paragraph",
      data: {
        hName: "div",
        hProperties: { className: classTokens(CALLOUT_TITLE_CLS, SEMANTIC_TONE[tone]) },
      },
      children: [{ type: "text", value: labels[type] }],
    });
  };
  const walk = (node: MdNode) => {
    for (const child of node.children ?? []) {
      if (child.type === "blockquote") transform(child);
      walk(child);
    }
  };
  return walk;
}

/** 富文本 markdown 渲染（Streamdown static 模式；GFM：表格、checkbox 任务清单、删除线；
 * 单换行＝换行）。原始 HTML（含注解）整段丢弃、不以原文呈现，code fence 内文本照常。代码区块以 Shiki 上色（浅色 github-light、深色 github-dark）并带
 * 拷贝钮；表格与代码区块不设高度上限（维持整份展开阅读）。.markdown 为薄覆写挂钩。
 * 行宽上限 96ch（≈48 全角字 @16px）——抽屉全屏幕时行宽不随之增长（spec
 * 「markdown 文档内容行宽有上限」）；宽表格由 Streamdown 的表格容器横卷。
 * GitHub Alert（`> [!NOTE]` 等四型）恒开、对所有 Markdown 查看生效。 */
export function Markdown({ content, empty, specKeywords = false, className, nameChips }: MarkdownProps) {
  const { t } = useI18n();
  // Streamdown 的区块 memo 逐一比对属性对象是否同一个：固定设置放模块层，随语系变动的用 useMemo。
  const remarkPlugins = useMemo(
    () => [
      ...Object.values(defaultRemarkPlugins),
      remarkDropHtml,
      [
        remarkGithubAlerts,
        {
          note: t(ALERT_LABEL_KEYS.note),
          tip: t(ALERT_LABEL_KEYS.tip),
          warning: t(ALERT_LABEL_KEYS.warning),
          caution: t(ALERT_LABEL_KEYS.caution),
        },
      ] as Pluggable,
      remarkBreaks,
    ],
    [t],
  );
  const translations = useMemo(() => ({ copyCode: t("markdown.copyCode"), copied: t("markdown.copied") }), [t]);
  // 名单以内容为键：调用端每次渲染给新数组时不重建管线。
  const chipKey = JSON.stringify(nameChips ?? []);
  const rehypePlugins = useMemo(() => {
    const base = specKeywords ? SPEC_REHYPE_PLUGINS : REHYPE_PLUGINS;
    const names = JSON.parse(chipKey) as NameChip[];
    return names.length > 0 ? [...base, [rehypeNameChips, { names }] as Pluggable] : base;
  }, [specKeywords, chipKey]);
  if (!content || !content.trim()) {
    return <div className="text-muted-foreground text-sm py-6">{empty ?? t("common.noContent")}</div>;
  }
  return (
    <div className={cn("markdown max-w-[96ch]", CONTROL_BUTTON_CLS, className)}>
      <Streamdown
        mode="static"
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        plugins={PLUGINS}
        controls={CONTROLS}
        translations={translations}
        icons={ICONS}
        linkSafety={LINK_SAFETY}
        shikiTheme={SHIKI_THEME}
        tableMaxHeight={0}
        codeBlockMaxHeight={0}
      >
        {content}
      </Streamdown>
    </div>
  );
}
