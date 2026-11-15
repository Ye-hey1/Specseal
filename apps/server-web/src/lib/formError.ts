import { WebApiError } from "../api/client";

// 表单提交失败的一致读取：WebApiError 带出可公开的 message 与 fieldErrors；其他错误
// 退回 fallback 消息。调用端保留输入并以 role=alert 声明（D6）。
export function readFormError(
  error: unknown,
  fallback: string,
): { message: string; fieldErrors: Record<string, string> } {
  if (error instanceof WebApiError) {
    return { message: error.message, fieldErrors: error.fieldErrors ?? {} };
  }
  return { message: fallback, fieldErrors: {} };
}
