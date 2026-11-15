import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";

export const Tabs = TabsPrimitive.Root;

const tabsListVariants = cva("flex w-full items-center", {
  variants: {
    variant: {
      /** 整列底线：缺省。各页版面尚未把内容放进卡片时用这款，不画外框。 */
      underline: "border-b border-border",
      /** 卡片标头：作为内容卡的顶部，内容卡以 Card 的 attached="top" 接在下方。 */
      card: "px-2 bg-card border border-border rounded-t-2xl",
      /** 胶囊切换：页标题右侧的小型两段切换（项目说明的「编辑／预览」）。 */
      segmented: "w-auto h-7 rounded-lg bg-muted p-0.5",
      /** 文档树：详情页左栏的直向整宽节点清单（design D2）；Tabs 根要给 orientation="vertical"。 */
      tree: "flex-col items-stretch",
    },
  },
  defaultVariants: { variant: "underline" },
});

type TabsListVariant = NonNullable<VariantProps<typeof tabsListVariants>["variant"]>;

/** 分页的样式跟着所在 TabsList 的变体走，调用端不必逐个分页指定。 */
const TabsVariantContext = React.createContext<TabsListVariant>("underline");

const UNDERLINE_TRIGGER =
  "inline-flex h-10 items-center gap-1.5 px-3.5 text-sm font-medium text-muted-foreground border-b-2 border-transparent -mb-px transition-colors hover:text-foreground data-[state=active]:text-primary data-[state=active]:border-primary";
const SEGMENTED_TRIGGER =
  "inline-flex h-6 items-center gap-1.5 rounded-md px-3 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-sm";
/** 文档树节点：与项目栏导览项同款（主色淡底＝选取），徽章以 ml-auto 靠右。手册目录树的页列共用
 * 同一串（以 data-state 标作用中），样式只改这里。 */
export const TREE_NODE_CLS =
  "flex h-[30px] w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] text-foreground transition-colors hover:bg-foreground/5 data-[state=active]:bg-primary/12 data-[state=active]:font-medium data-[state=active]:text-primary [&_svg]:shrink-0";

const TRIGGER_CLS: Record<TabsListVariant, string> = {
  underline: UNDERLINE_TRIGGER,
  card: UNDERLINE_TRIGGER,
  segmented: SEGMENTED_TRIGGER,
  tree: TREE_NODE_CLS,
};

/**
 * 分页列。`actions` 放页级动作，渲染在同一列右端、tablist 之外（tablist 只容纳分页）。
 */
export const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> &
    VariantProps<typeof tabsListVariants> & { actions?: React.ReactNode }
>(({ className, actions, variant, ...props }, ref) => (
  <TabsVariantContext.Provider value={variant ?? "underline"}>
    <div className={cn(tabsListVariants({ variant }), className)}>
      <TabsPrimitive.List
        ref={ref}
        className={variant === "tree" ? "flex w-full flex-col items-stretch gap-0.5" : "flex items-center"}
        {...props}
      />
      {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
    </div>
  </TabsVariantContext.Provider>
));
TabsList.displayName = "TabsList";

/** 分页标签后的计数签（已封存页、server 用户页与凭证页）。 */
const COUNT_PILL_CLS =
  "inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-muted text-muted-foreground text-xs font-medium tabular-nums";

/** 分页。`count` 给了就在标签后渲染计数签（0 也渲染）。 */
export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger> & { count?: number }
>(({ className, count, children, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(TRIGGER_CLS[React.useContext(TabsVariantContext)], className)}
    {...props}
  >
    {count === undefined ? (
      // 没有计数签时子节点原样交出：asChild 的 Slot 只接受单一子元素。
      children
    ) : (
      <>
        {children}
        <span data-tab-count className={COUNT_PILL_CLS}>
          {count}
        </span>
      </>
    )}
  </TabsPrimitive.Trigger>
));
TabsTrigger.displayName = "TabsTrigger";

export const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content ref={ref} className={cn("focus-visible:outline-none", className)} {...props} />
));
TabsContent.displayName = "TabsContent";
