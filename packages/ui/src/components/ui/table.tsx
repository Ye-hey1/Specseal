import * as React from "react";

import { cn } from "../../lib/utils";

// shadcn Table（Tailwind v4）：语意 <table> 结构＋themed 边框。外层 div 提供窄容器
// 横向卷动，避免宽表格撑破版面。列边框明确用 border-border——裸 border 于 Tailwind v4
// 会落到 currentColor（≈黑框）。`wrapped={false}` 不包外层：调用端自己就是卷动区（列表卡）时，
// 外层的 overflow-x-auto 会自成卷动容器，sticky 表头就黏在那层、随卷动区卷走。
export const Table = React.forwardRef<
  HTMLTableElement,
  React.HTMLAttributes<HTMLTableElement> & { wrapped?: boolean }
>(({ className, wrapped = true, ...props }, ref) => {
  const table = <table ref={ref} className={cn("w-full caption-bottom text-sm", className)} {...props} />;
  return wrapped ? <div className="relative w-full overflow-x-auto">{table}</div> : table;
});
Table.displayName = "Table";

/** `sticky`：表头固定在卷动区顶端并带卡片底色盖住底下的列（列表卡内的表格；搭配 `Table wrapped={false}`）。 */
export const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement> & { sticky?: boolean }
>(({ className, sticky = false, ...props }, ref) => (
  <thead ref={ref} className={cn(sticky && "sticky top-0 z-10 bg-card", className)} {...props} />
));
TableHeader.displayName = "TableHeader";

export const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody ref={ref} className={cn("[&_tr:last-child]:border-0", className)} {...props} />
));
TableBody.displayName = "TableBody";

/** `hoverable={false}`：滑过不加底色（列里放下拉、输入框等控制项的表格，底色会干扰操作）。 */
export const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement> & { hoverable?: boolean }
>(({ className, hoverable = true, ...props }, ref) => (
  <tr
    ref={ref}
    className={cn("border-b border-border transition-colors", hoverable && "hover:bg-muted/50", className)}
    {...props}
  />
));
TableRow.displayName = "TableRow";

export const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      "h-10 px-3 text-left align-middle text-xs font-medium text-muted-foreground",
      className,
    )}
    {...props}
  />
));
TableHead.displayName = "TableHead";

export const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td ref={ref} className={cn("px-3 py-2.5 align-middle", className)} {...props} />
));
TableCell.displayName = "TableCell";

export const TableCaption = React.forwardRef<
  HTMLTableCaptionElement,
  React.HTMLAttributes<HTMLTableCaptionElement>
>(({ className, ...props }, ref) => (
  <caption ref={ref} className={cn("mt-3 text-sm text-muted-foreground", className)} {...props} />
));
TableCaption.displayName = "TableCaption";
