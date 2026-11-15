// 受保护 route 导向登录时保留的站内返回路径。白名单由 Server 再验一次，
// 这里只确保 SPA 不会把外部 URL 塞进 returnTo（server-web-console
// 「导向遵守服务器裁决与安全优先序」）。route guard 与 401 session 失效
// 共用同一份判定，避免两处白名单分歧。

const ALLOWED_FIRST_SEGMENTS = ["account", "activate", "admin"];

/** 通过白名单的站内路径，否则 null。 */
export function safeReturnTo(pathname: string): string | null {
  const first = pathname.replace(/^\//, "").split(/[/?#]/)[0];
  return ALLOWED_FIRST_SEGMENTS.includes(first) ? pathname : null;
}

/** 登录页路径，带上通过白名单的 returnTo（没有就不带）。 */
export function loginRedirect(pathname: string): string {
  const rt = safeReturnTo(pathname);
  return rt ? `/login?returnTo=${encodeURIComponent(rt)}` : "/login";
}
