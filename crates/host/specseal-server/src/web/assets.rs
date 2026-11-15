//! 内嵌 SPA 资产服务与 browser fallback 安全边界（server-web-console spec「SPA
//! 资产与 fallback 具可验证的安全边界」, 设计决策 D5）。
//!
//! `apps/server-web` 的 Vite production build 于编译期内嵌（release）／debug 由
//! dist 动态读取。`/assets/*` 服务内容哈希档并带 immutable 缓存与正确 MIME；
//! router fallback 对固定的 browser GET allowlist 回传 SPA shell（no-cache 与
//! self-only CSP），其余一律真 404——fallback 永不吞掉 `/api/*`、`/auth/*`、
//! health／readiness、下载、未知资产或未知 browser path。

use axum::extract::Path;
use axum::http::{header, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;

/// Vite production bundle，内嵌自 `apps/server-web/dist`。缺 dist 时 release build
/// 于编译期失败（fail closed）。
#[derive(RustEmbed)]
#[folder = "../../../apps/server-web/dist"]
struct WebAssets;

/// Release fail-closed：release（非 debug）build 于编译期要求 production `index.html`
/// 存在，否则以编译错误中止——绝不产生只有 API、没有内嵌 SPA 的 server artifact
/// （server-release「缺少 Web build 使 release build 失败」）。debug build 由 dist
/// 动态读取，不套用此门槛。路径相对于本源码档（`crates/host/specseal-server/src/web/`）。
#[cfg(not(debug_assertions))]
const _EMBEDDED_SPA_INDEX: &[u8] =
    include_bytes!("../../../../../apps/server-web/dist/index.html");

/// SPA shell 的 self-only Content Security Policy。不从 CDN 或 Google Fonts 加载；
/// script／font／img／xhr 皆限同源。`unsafe-inline` 只放宽给 style——Radix UI 原语
/// 于运行期设置 inline 定位样式；script 维持严格。
const SHELL_CSP: &str = "default-src 'self'; \
script-src 'self'; \
style-src 'self' 'unsafe-inline'; \
img-src 'self' data:; \
font-src 'self'; \
connect-src 'self'; \
base-uri 'self'; \
form-action 'self'; \
frame-ancestors 'none'";

/// SPA 拥有的 browser GET route。这些 path 直接打开或刷新回传 shell；其余
/// 落到真 404（D5 的 allowlist）。
///
/// admin 面只枚举六个管理目的地，不 blanket `/admin/*`——`/admin/changes`、
/// `/admin/specs`、`/admin/discussions` 等 SHALL 维持 404（Non-Goal：管理面不提供
/// changes／specs／discussions 的查看或编辑）。`/admin/data` 已不是目的地，但仍留在
/// 清单里：旧书签要拿到 shell 才能由 SPA 导向 `/admin/system`，回 404 只会是死链接。
///
/// 用户与项目列表另有详情页 `/admin/users/<id>`、`/admin/registry/<代号>`：列表路径
/// 之后恰好一段非空片段才算，`/admin/users/a/b` 与 `/admin/users/` 仍是 404。id 是否
/// 存在由 SPA 判断，server 只回 shell。
fn is_browser_route(path: &str) -> bool {
    matches!(
        path,
        "/" | "/setup"
            | "/login"
            | "/activate"
            | "/account"
            | "/admin"
            | "/admin/users"
            | "/admin/registry"
            | "/admin/credentials"
            | "/admin/data"
            | "/admin/system"
            | "/admin/audit"
    ) || path.starts_with("/invite/")
        || ["/admin/users/", "/admin/registry/"].iter().any(|list| {
            path.strip_prefix(list)
                .is_some_and(|id| !id.is_empty() && !id.contains('/'))
        })
}

/// 服务内嵌的 SPA shell（`index.html`），带 no-cache 与 self-only CSP。bundle
/// 不存在时回 404（fail-closed，不回白屏）。
fn serve_shell() -> Response {
    match WebAssets::get("index.html") {
        Some(file) => (
            [
                (
                    header::CONTENT_TYPE,
                    HeaderValue::from_static("text/html; charset=utf-8"),
                ),
                (header::CACHE_CONTROL, HeaderValue::from_static("no-cache")),
                (
                    header::CONTENT_SECURITY_POLICY,
                    HeaderValue::from_static(SHELL_CSP),
                ),
            ],
            file.data.into_owned(),
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// `GET /assets/{*path}` — 内容哈希 immutable 资产。只服务内嵌 manifest 中的文件；
/// 未知资产回真 404，永不回 shell。
pub async fn asset(Path(path): Path<String>) -> Response {
    let key = format!("assets/{path}");
    match WebAssets::get(&key) {
        Some(file) => {
            let mime = mime_guess::from_path(&key).first_or_octet_stream();
            let content_type = HeaderValue::from_str(mime.as_ref())
                .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"));
            (
                [
                    (header::CONTENT_TYPE, content_type),
                    (
                        header::CACHE_CONTROL,
                        HeaderValue::from_static("public, max-age=31536000, immutable"),
                    ),
                ],
                file.data.into_owned(),
            )
                .into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Router fallback——只对 allowlist 的 browser GET route 回 shell，其余回真 404。
/// 只在无明确 route 命中时运行，故 `/api/*`、`/auth/*`、`/healthz`、`/readyz` 与
/// 下载 route 永不到此。
///
/// 404 走与其他 API 错误同一个 `{error:{code,message}}` JSON 外壳（spec「拼错 API
/// 不被 SPA fallback 吞掉」要求 JSON 404）——裸的 `StatusCode::NOT_FOUND` 不带
/// body 也不带 content type，client 无从分辨「路径不存在」与「代理层吞掉了回应」。
pub async fn spa_fallback(method: Method, uri: Uri) -> Response {
    if method == Method::GET && is_browser_route(uri.path()) {
        serve_shell()
    } else {
        crate::web::web_err(StatusCode::NOT_FOUND, "not_found", "找不到该路径")
    }
}
