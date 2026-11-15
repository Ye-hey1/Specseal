import { describe, it, expect, vi } from "vitest";
import { render as rtlRender, screen, fireEvent } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { I18nProvider } from "../i18n";

// 既有中文断言包 I18nProvider locale zh-CN 后照旧断言（i18n 抽 key 的回归保护）。
const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN">{children}</I18nProvider>
);
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: zhWrapper });
}

import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Card } from "../components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip";
import { Textarea } from "../components/ui/textarea";
import { Input } from "../components/ui/input";
import { Checkbox } from "../components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { cn } from "../lib/utils";

describe("shadcn 设计系统原语", () => {
  it("Button renders children and fires onClick", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>validate</Button>);
    const btn = screen.getByRole("button", { name: "validate" });
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalled();
  });

  it("Button applies variant/size classes via cva", () => {
    render(<Button variant="outline" size="sm">x</Button>);
    const btn = screen.getByRole("button", { name: "x" });
    expect(btn.className).toContain("border");
  });

  it("Badge renders its label", () => {
    render(<Badge>in-progress</Badge>);
    expect(screen.getByText("in-progress")).toBeTruthy();
  });

  it("cn merges and de-duplicates tailwind classes", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });

  it("Tooltip 气泡为白底细框带阴影（design D5），不借主色", () => {
    // spec「接口状态语意色分层」：主色实心气泡与「已就绪」徽章撞色；改为与浮层
    // 同一套白底细框，全域 tooltip 一次生效。
    render(
      <TooltipProvider>
        <Tooltip defaultOpen>
          <TooltipTrigger asChild>
            <button>触发</button>
          </TooltipTrigger>
          <TooltipContent>提示内容</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    const bubble = document.querySelector("[data-side]") as HTMLElement;
    expect(bubble.textContent).toContain("提示内容");
    const cls = bubble.className.split(/\s+/);
    for (const c of ["bg-card", "text-foreground", "border", "shadow-md", "text-xs", "rounded-md"]) {
      expect(cls).toContain(c);
    }
    expect(bubble.className).not.toContain("bg-primary");
    expect(bubble.className).not.toContain("bg-foreground");
  });
});

/** className 拆成 token；不带变体前缀（hover:、data-[…]:）的才是静态样式。 */
const classes = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);
const staticClasses = (el: Element) => classes(el).filter((c) => !c.includes(":"));

// 原语扁平化（desktop-design-foundation design D5）。
describe("原语扁平化：button／card／badge／tabs", () => {
  it("Button 圆角 rounded-md、焦点为 2px ring", () => {
    render(<Button>go</Button>);
    const btn = screen.getByRole("button", { name: "go" });
    expect(classes(btn)).toContain("rounded-md");
    expect(classes(btn)).toContain("focus-visible:ring-2");
  });

  it("secondary 变体为 bg-primary/10 text-primary", () => {
    render(<Button variant="secondary">s</Button>);
    const cls = classes(screen.getByRole("button", { name: "s" }));
    expect(cls).toContain("bg-primary/10");
    expect(cls).toContain("text-primary");
  });

  it("subtle 变体静态无底、hover 有底", () => {
    render(<Button variant="subtle" size="icon-sm" aria-label="more" />);
    const btn = screen.getByRole("button", { name: "more" });
    expect(staticClasses(btn).some((c) => c.startsWith("bg-"))).toBe(false);
    expect(classes(btn)).toContain("hover:bg-foreground/5");
  });

  it("destructive 为实心红、danger 为淡红底红字", () => {
    render(
      <>
        <Button variant="destructive">del</Button>
        <Button variant="danger">warn</Button>
      </>,
    );
    expect(classes(screen.getByRole("button", { name: "del" }))).toContain("bg-destructive");
    const danger = classes(screen.getByRole("button", { name: "warn" }));
    expect(danger).toContain("bg-destructive/10");
    expect(danger).toContain("text-destructive");
  });

  it.each([
    ["default", "h-9"],
    ["sm", "h-7"],
    ["toolbar", "h-8"],
    ["icon", "h-8 w-8"],
    ["icon-sm", "h-7 w-7"],
    ["icon-xs", "h-6 w-6"],
  ] as const)("Button size=%s 为 %s", (size, expected) => {
    render(<Button size={size}>{size}</Button>);
    const cls = classes(screen.getByRole("button", { name: size }));
    for (const c of expected.split(" ")) expect(cls).toContain(c);
  });

  it("Card 为 rounded-2xl 细框白底、无阴影", () => {
    render(<Card data-testid="card" />);
    const cls = classes(screen.getByTestId("card"));
    expect(cls).toEqual(expect.arrayContaining(["rounded-2xl", "border", "bg-card"]));
    expect(cls.some((c) => c.startsWith("shadow"))).toBe(false);
  });

  it("card nested 变体为 rounded-xl", () => {
    render(<Card size="nested" data-testid="card" />);
    const cls = classes(screen.getByTestId("card"));
    expect(cls).toContain("rounded-xl");
    expect(cls).not.toContain("rounded-2xl");
  });

  it("card attached=top 变体去上圆角与上框线，接在卡片标头分页列下方", () => {
    render(<Card attached="top" data-testid="card" />);
    const cls = classes(screen.getByTestId("card"));
    expect(cls).toEqual(expect.arrayContaining(["rounded-t-none", "border-t-0"]));
  });

  it("card interactive 变体 hover 框变深、底微灰", () => {
    render(<Card interactive data-testid="card" />);
    const hover = classes(screen.getByTestId("card")).filter((c) => c.startsWith("hover:"));
    expect(hover.some((c) => c.startsWith("hover:border-"))).toBe(true);
    expect(hover.some((c) => c.startsWith("hover:bg-"))).toBe(true);
  });

  it("Badge 全圆、11px 字", () => {
    render(<Badge>b</Badge>);
    const cls = classes(screen.getByText("b"));
    expect(cls).toContain("rounded-full");
    expect(cls).toContain("text-[11px]");
  });

  // desktop-subagent-model-page：次要信息的小签（「未激活」、名称清单）用灰字变体，调用端不盖字色。
  it("Badge muted 变体为灰底灰字", () => {
    render(<Badge variant="muted">m</Badge>);
    const cls = classes(screen.getByText("m"));
    expect(cls).toEqual(expect.arrayContaining(["rounded-full", "bg-muted", "text-muted-foreground"]));
    expect(cls).not.toContain("text-foreground");
  });

  const renderTabs = (variant?: "underline" | "card" | "segmented") =>
    render(
      <Tabs defaultValue="a">
        <TabsList variant={variant} actions={<button>打开</button>}>
          <TabsTrigger value="a">甲</TabsTrigger>
          <TabsTrigger value="b">乙</TabsTrigger>
        </TabsList>
        <TabsContent value="a">内容</TabsContent>
      </Tabs>,
    );

  it("分页作用中带 border-primary 底线且无底色、List 的 actions slot 渲染在右端", () => {
    renderTabs();
    const active = screen.getByRole("tab", { name: "甲" });
    expect(active.getAttribute("data-state")).toBe("active");
    const cls = classes(active);
    expect(cls).toContain("data-[state=active]:border-primary");
    expect(cls).toContain("data-[state=active]:text-primary");
    expect(cls).toContain("border-b-2");
    expect(cls.some((c) => c.startsWith("data-[state=active]:bg-"))).toBe(false);
    expect(cls.some((c) => c.startsWith("data-[state=active]:shadow"))).toBe(false);
    // actions 不进 tablist（tablist 只容纳分页），放在同一列的右端。
    const tablist = screen.getByRole("tablist");
    const action = screen.getByRole("button", { name: "打开" });
    expect(tablist.contains(action)).toBe(false);
    const bar = tablist.parentElement as HTMLElement;
    expect(bar.lastElementChild!.contains(action)).toBe(true);
    expect(classes(bar.lastElementChild!)).toContain("ml-auto");
  });

  it("分页列缺省为整列底线：只有底边框，没有外框、圆角与底色", () => {
    // 卡片标头式要有内容卡接在下方才成立；各页版面尚未接上前，缺省不画外框。
    renderTabs();
    const bar = classes(screen.getByRole("tablist").parentElement!);
    expect(bar).toEqual(expect.arrayContaining(["w-full", "border-b", "border-border"]));
    expect(bar).not.toContain("border");
    expect(bar).not.toContain("bg-card");
    expect(bar.some((c) => c.startsWith("rounded"))).toBe(false);
  });

  it("variant=card 为内容卡的标头：外框、上方 16px 圆角、卡片底色", () => {
    renderTabs("card");
    const bar = classes(screen.getByRole("tablist").parentElement!);
    expect(bar).toEqual(expect.arrayContaining(["rounded-t-2xl", "bg-card", "border", "px-2"]));
  });

  it("variant=segmented 为胶囊切换：列为灰底圆角、作用中分页为卡片底加阴影、没有底线", () => {
    renderTabs("segmented");
    const bar = classes(screen.getByRole("tablist").parentElement!);
    expect(bar).toEqual(expect.arrayContaining(["w-auto", "h-7", "rounded-lg", "bg-muted"]));
    expect(bar).not.toContain("w-full");
    expect(bar).not.toContain("border-b");
    const active = classes(screen.getByRole("tab", { name: "甲" }));
    expect(active).toEqual(
      expect.arrayContaining(["h-6", "rounded-md", "data-[state=active]:bg-card", "data-[state=active]:shadow-sm"]),
    );
    expect(active).not.toContain("border-b-2");
    expect(active).not.toContain("data-[state=active]:text-primary");
  });
});

describe("原语扁平化：表单与浮层（design D5）", () => {
  it("Textarea 8px 圆角、无阴影、聚焦为 ring 框", () => {
    render(<Textarea aria-label="t" />);
    const cls = classes(screen.getByRole("textbox", { name: "t" }));
    for (const c of ["rounded-lg", "focus-visible:border-ring", "focus-visible:ring-2", "focus-visible:ring-ring/30"]) {
      expect(cls).toContain(c);
    }
    expect(cls.some((c) => c.includes("shadow"))).toBe(false);
  });

  it("Checkbox 为 4px 圆角", () => {
    render(<Checkbox aria-label="c" />);
    expect(classes(screen.getByRole("checkbox", { name: "c" }))).toContain("rounded-[4px]");
  });

  it("Popover 12px 圆角、p-3、shadow-md", () => {
    render(
      <Popover defaultOpen>
        <PopoverTrigger>开</PopoverTrigger>
        <PopoverContent>浮层内容</PopoverContent>
      </Popover>,
    );
    const cls = classes(screen.getByText("浮层内容"));
    for (const c of ["rounded-xl", "p-3", "shadow-md"]) expect(cls).toContain(c);
  });

  it("确认框：30% 中性遮罩、28rem 宽 12px 圆角、标题 15px、说明 13px、取消为 ghost", () => {
    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTitle>标题</AlertDialogTitle>
          <AlertDialogDescription>说明</AlertDialogDescription>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction>确认</AlertDialogAction>
        </AlertDialogContent>
      </AlertDialog>,
    );
    const content = screen.getByRole("alertdialog");
    for (const c of ["w-[28rem]", "rounded-xl", "p-5", "shadow-lg"]) {
      expect(classes(content)).toContain(c);
    }
    const overlay = content.previousElementSibling as HTMLElement;
    expect(classes(overlay)).toContain("bg-foreground/30");
    expect(classes(screen.getByText("标题"))).toEqual(
      expect.arrayContaining(["text-[15px]", "font-medium"]),
    );
    expect(classes(screen.getByText("说明"))).toEqual(
      expect.arrayContaining(["text-[13px]", "text-muted-foreground"]),
    );
    const cancel = classes(screen.getByRole("button", { name: "取消" }));
    expect(cancel).toContain("hover:bg-accent");
    expect(cancel).not.toContain("border");
  });
});

// desktop-board-reskin 品质关卡 round 1（review CRITICAL）：openspec/config.yaml rules.design 规定
// 「调用端不得以 className 覆盖变体的颜色、圆角与阴影」——搜索列要的全圆输入与筛选开关钮
// 改由原语变体提供，调用端只选变体。
describe("原语变体：全圆输入与开关图标钮", () => {
  it("Input 缺省 8px 圆角；shape=pill 为全圆、不残留 rounded-lg", () => {
    render(
      <>
        <Input aria-label="plain" />
        <Input aria-label="pill" shape="pill" />
      </>,
    );
    expect(classes(screen.getByLabelText("plain"))).toContain("rounded-lg");
    const pill = classes(screen.getByLabelText("pill"));
    expect(pill).toContain("rounded-full");
    expect(pill).not.toContain("rounded-lg");
  });

  it("Button toggle 变体：8px 圆角、静态无底灰字，展开态（aria-expanded）浅灰底深字", () => {
    render(<Button variant="toggle" size="icon" aria-label="filters" aria-expanded={false} />);
    const btn = screen.getByRole("button", { name: "filters" });
    expect(classes(btn)).toEqual(
      expect.arrayContaining(["rounded-lg", "text-muted-foreground", "aria-expanded:bg-muted", "aria-expanded:text-foreground"]),
    );
    expect(classes(btn)).not.toContain("rounded-md");
    expect(staticClasses(btn).some((c) => c.startsWith("bg-"))).toBe(false);
  });
});

// 菜单项与下拉选项取用光标变量（design D5）：网页是手指、桌面是箭头，不写死箭头。
describe("原语光标：菜单项与下拉选项", () => {
  it("下拉列表项目为变量光标、不带 cursor-default", async () => {
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>打开</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const item = classes(await screen.findByRole("menuitem", { name: "打开" }));
    expect(item).toContain("cursor-(--cursor-interaction)");
    expect(item).not.toContain("cursor-default");
  });

  it("下拉选项为变量光标；卷动钮（hover 即卷动、非点击）维持 cursor-default", async () => {
    // jsdom 没有版面：撑出可卷动的高度，Radix 才会渲染卷动钮。
    const scrollHeight = vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(1000);
    const clientHeight = vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(100);
    try {
      render(
        <Select defaultValue="a" defaultOpen>
          <SelectTrigger aria-label="状态">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="a">有效</SelectItem>
            <SelectItem value="b">已停权</SelectItem>
          </SelectContent>
        </Select>,
      );
      const option = classes(await screen.findByRole("option", { name: "有效" }));
      expect(option).toContain("cursor-(--cursor-interaction)");
      expect(option).not.toContain("cursor-default");
      const scrollButtons = [...screen.getByRole("listbox").querySelectorAll<HTMLElement>(":scope > [aria-hidden=true]")];
      expect(scrollButtons.length).toBeGreaterThan(0);
      for (const button of scrollButtons) expect(classes(button)).toContain("cursor-default");
    } finally {
      scrollHeight.mockRestore();
      clientHeight.mockRestore();
    }
  });
});

describe("数据档解析失败的提示（spec「画面依实际规格文档夹与数据文档名显示」）", () => {
  it("以「变更数据档」称呼并附原因，不带写死的文档名", async () => {
    const { translatorFor } = await import("../i18n");
    const zh = translatorFor("zh-CN").t("card.invalidMetaTitle");
    const en = translatorFor("en").t("card.invalidMetaTitle");
    expect(zh).toContain("变更数据档解析失败");
    expect(en).toContain("change data file");
    for (const text of [zh, en]) {
      expect(text).toContain("{reason}");
      expect(text).not.toContain(".openspec.yaml");
    }
  });
});
