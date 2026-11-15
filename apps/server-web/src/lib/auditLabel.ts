/** 稽核动作与来源的显示名称（稽核纪录页与总览的最近活动共用）。两者是服务器的封闭集合；未知值
 *  原样呈现而不猜——那代表服务器添加了这里还没跟上的种类，显示原始字符串比显示空白诚实。 */
export function auditLabel(t: (key: string) => string, namespace: "action" | "source", value: string): string {
  const key = `audit.${namespace}.${value}`;
  const text = t(key);
  return text === key ? value : text;
}
