import type { HTMLInputTypeAttribute } from "react";
import { Input, Label } from "@specseal/ui";

// 一致的表单字段：label ＋ input ＋ 选配的灰字说明 ＋ 邻近字段且以 role=alert 声明的错误（D6）。
// setup、invite 与登录等专注流程表单共用，避免重复 label／aria 接线。
export function Field({
  id,
  label,
  value,
  onChange,
  type = "text",
  autoComplete,
  hint,
  error,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: HTMLInputTypeAttribute;
  autoComplete?: string;
  hint?: string;
  error?: string;
}) {
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy}
      />
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
