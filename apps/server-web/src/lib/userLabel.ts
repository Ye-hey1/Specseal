// 用户的显示文本：帐号菜单、设备核准的身分句与帐号页说明共用同一条规则。
type Person = { display: string; email: string };

/** 显示名称；空字符串时退回 email，头像字与名称列都不留白。 */
export function userLabel(user: Person): string {
  return user.display || user.email;
}

/** 一次代入 `{display}`／`{email}`：值以字面文本放入（`$&` 之类不展开），也不会被下一个占位符再扫到。 */
export function fillUser(template: string, user: Person): string {
  return template.replace(/\{(display|email)\}/g, (_, key: string) => (key === "email" ? user.email : userLabel(user)));
}
