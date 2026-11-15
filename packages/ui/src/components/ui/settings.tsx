// 设置页的五个零件（desktop-settings-mode design D3）：应用程序设置与项目设置的每一页都以
// 页标题、卡、列、列右侧下拉排版；群组标题由分类栏群组与卡的小标共用。另有外开链接列
// （desktop-about-page design D2），版面同列但整列可点。
import { Fragment, useId, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";

import { cn } from "../../lib/utils";
import { SEMANTIC_TONE } from "../../tone";
import { Card } from "./card";
import { PageHeader } from "./page-header";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "./select";

/** 页标题：包 PageHeader；`note` 为其下一行 12px 灰字（本机页的「仅存于此设备」、
 *  项目设置的等宽文件键或 policy revision）。 */
export function SettingsPageHeader({
  title,
  description,
  actions,
  note,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <PageHeader title={title} description={description} actions={actions} />
      {note && (
        <p data-settings-note className="m-0 text-xs text-muted-foreground">
          {note}
        </p>
      )}
    </div>
  );
}

/** 群组标题：分类栏的群组（12px 粗体灰字）与卡的小标（`size="card"`，14px）共用；
 *  图标与计数徽章选配。 */
export function SettingsGroupHeader({
  icon,
  label,
  count,
  size = "group",
}: {
  icon?: ReactNode;
  label: string;
  count?: number;
  size?: "group" | "card";
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0",
        size === "group"
          ? "px-2.5 text-xs font-semibold text-muted-foreground"
          : "px-1 text-sm font-medium text-foreground",
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
      {count !== undefined && (
        <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1 text-[11px] font-normal tabular-nums text-muted-foreground">
          {count}
        </span>
      )}
    </div>
  );
}

/** 卡：14px 小标＋16px 圆角卡，卡内一列一笔、列间细线；以小标为区域名。`aside` 放在小标同一列
 *  右端（链接或 12px 灰字说明；server-web-list-pages design D1）。 */
export function SettingsCard({
  title,
  count,
  icon,
  aside,
  children,
}: {
  title: string;
  count?: number;
  icon?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <div data-settings-card-head className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <SettingsGroupHeader icon={icon} label={title} count={count} size="card" />
        </div>
        {aside && (
          <div data-settings-card-aside className="shrink-0 px-1 text-xs text-muted-foreground">
            {aside}
          </div>
        )}
      </div>
      <Card data-settings-card-body className="divide-y divide-border">
        {children}
      </Card>
    </section>
  );
}

/** 列：左 14px 标签＋12px 灰字说明、右控制项；`warning` 时说明改警示色；`children` 渲染在
 *  列下方（展开的细节、行内错误）。以标签为群组名，调用端可就列找控制项；给了 `htmlFor`
 *  时标签只标注该控制项，不再兼作群组名（同一个名字不指向两个元素）。根节点带 `group`，
 *  控制项可用 `group-hover:` 依列滑过显示。 */
export function SettingsRow({
  label,
  description,
  control,
  htmlFor,
  warning,
  children,
}: {
  /** 群组名取自标签的文本内容；可放等宽版号之类的行内标记。 */
  label: ReactNode;
  description?: ReactNode;
  control: ReactNode;
  htmlFor?: string;
  warning?: boolean;
  children?: ReactNode;
}) {
  const labelId = useId();
  const Label = htmlFor ? "label" : "span";
  return (
    <div role="group" aria-labelledby={htmlFor ? undefined : labelId} className="group grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <Label id={labelId} htmlFor={htmlFor} className="text-sm">
          {label}
        </Label>
        {description && (
          <p className={cn("m-0 text-xs", warning ? SEMANTIC_TONE.warning : "text-muted-foreground")}>
            {description}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2">{control}</div>
      {children && <div className="col-span-2 min-w-0">{children}</div>}
    </div>
  );
}

/** 外开链接列（desktop-about-page design D2）：版面同 `SettingsRow`，但整列是按钮——hover
 *  灰底、右端固定外开图标，不放控制项。 */
export function SettingsLinkRow({
  label,
  description,
  onClick,
}: {
  label: ReactNode;
  description?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="grid w-full grid-cols-[1fr_auto] items-center gap-x-4 px-4 py-3 text-left transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
    >
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm">{label}</span>
        {description && <span className="text-xs text-muted-foreground">{description}</span>}
      </span>
      <ExternalLink aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}

export interface SettingsChoiceOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/** 下拉的分组项：分组标签＋组内选项。 */
export interface SettingsChoiceGroup {
  label: string;
  options: SettingsChoiceOption[];
}

export const isSettingsChoiceGroup = (
  entry: SettingsChoiceOption | SettingsChoiceGroup,
): entry is SettingsChoiceGroup => "options" in entry;

function ChoiceItem({ option }: { option: SettingsChoiceOption }) {
  return (
    <SelectItem value={option.value} disabled={option.disabled}>
      {option.label}
    </SelectItem>
  );
}

/** 列右侧下拉：包 Select，触发钮 h-8、13px 字。值不得为空字符串（Radix 限制），
 *  「未设置」之类的状态由调用端映射成哨兵值。`options` 可放分组项：每组渲染分组标签，
 *  组与组、组与单项之间以分隔线隔开；值在所有项目间不得重复。 */
export function SettingsChoice({
  value,
  options,
  onChange,
  ariaLabel,
  disabled,
  id,
}: {
  value: string;
  options: (SettingsChoiceOption | SettingsChoiceGroup)[];
  onChange: (value: string) => void;
  ariaLabel?: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} aria-label={ariaLabel} className="w-auto min-w-40 text-[13px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((entry, index) => {
          const separated = index > 0 && (isSettingsChoiceGroup(entry) || isSettingsChoiceGroup(options[index - 1]));
          return (
            <Fragment key={isSettingsChoiceGroup(entry) ? `group:${entry.label}` : entry.value}>
              {separated && <SelectSeparator />}
              {isSettingsChoiceGroup(entry) ? (
                <SelectGroup>
                  <SelectLabel>{entry.label}</SelectLabel>
                  {entry.options.map((option) => (
                    <ChoiceItem key={option.value} option={option} />
                  ))}
                </SelectGroup>
              ) : (
                <ChoiceItem option={entry} />
              )}
            </Fragment>
          );
        })}
      </SelectContent>
    </Select>
  );
}
