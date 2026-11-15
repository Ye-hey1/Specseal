//! HTTP router assembly. The project routes and the scope list go through
//! the host kit's HTTP door (`forward`, design D8); the server keeps its own
//! routes: login and accounts, the admin surfaces, the static assets, the
//! import and the event stream.

use crate::admin;
use crate::assets;
use crate::auth::Binding;
use crate::device;
use crate::error::ApiError;
use crate::forward;
use crate::routes;
use crate::setup;
use crate::state::AppState;
use crate::web;
use axum::body::Body;
use axum::extract::{DefaultBodyLimit, FromRequestParts, Request, State};
use axum::http::{Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use axum::Router;
use specseal_host::http::write_refused;

/// Workspace migration uploads a complete local `openspec/` snapshot in one
/// atomic request. Keep the larger allowance scoped to `/import`; ordinary API
/// routes retain Axum's conservative default body limit.
const IMPORT_BODY_LIMIT_BYTES: usize = forward::READ_LIMIT_BYTES;

/// Build the HTTP router over the shared application state.
pub fn router(state: AppState) -> Router {
    // The two project routes the server keeps for itself; every other path
    // under the project goes to the door.
    let project = Router::new()
        .route(
            "/import",
            post(routes::import_bundle).layer(DefaultBodyLimit::max(IMPORT_BODY_LIMIT_BYTES)),
        )
        .route("/events", get(routes::events))
        // 写入检查（fail-closed）：以上每条路由的非 GET／HEAD 方法都要 editor。
        .route_layer(middleware::from_fn_with_state(state.clone(), require_editor))
        .layer(middleware::from_fn(read_body_before_routing));
    Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        // 唯一保留的 /admin HTML route：scope export bundle 下载（session-admin gated）。
        // 其余 setup／invite／login／account／activate／admin 页面与 form 已由内嵌 SPA
        // 与 `/api/specseal/v1/web` browser API 取代（D8 第六阶段）。
        .route(
            "/admin/data/export/{project}/{repo}",
            get(admin::web_export_scope),
        )
        .route("/auth/device", post(device::initiate))
        .route("/auth/device/token", post(device::poll_token))
        .route("/auth/refresh", post(device::refresh))
        .route("/auth/revoke", post(device::revoke))
        .route("/auth/whoami", get(crate::auth::auth_whoami))
        .route("/api/specseal/v1/auth-methods", any(forward::root))
        .route("/api/specseal/v1/whoami", any(forward::root))
        .route("/api/specseal/v1/scopes", any(forward::root))
        .nest(
            "/api/specseal/v1/web",
            web::api_router()
                .merge(setup::web_router())
                .merge(admin::web_router()),
        )
        .nest("/api/specseal/v1/admin", admin::api_router())
        .nest("/api/specseal/v1/projects/{key}", project)
        .route("/api/specseal/v1/projects/{key}/{*rest}", any(forward::project))
        // 内嵌 SPA（D5）：内容哈希资产与 browser-route fallback shell。fallback 只在
        // 上方任何明确 route 都未命中时运行，故永不吞掉 API／auth／health／下载 route。
        .route("/assets/{*path}", get(assets::asset))
        .fallback(assets::spa_fallback)
        .with_state(state)
}

/// 进路由前先把 request body 收满再放行（project API 家族）。
///
/// `Binding` 这类 `FromRequestParts` extractor 跑在 body extractor 之前，401/403
/// 的早回应会让 hyper 对还没到的 body close_read；晚到的 body 段使 kernel 以
/// RST 收线，已送出的错误回应在对端缓冲区被整包丢弃——客户端间歇读到空 body
///（高负载下 context_api 测试 403 envelope 断言的间歇红）。body 先收满，早回应
/// 永远走在 body 之后，连接以 FIN 收场。
///
/// 收满上限取本 route 家族的最大允量（`/import` 的 32MB）；各 route 的实际内容
/// 上限仍由其 `DefaultBodyLimit` 在 extractor 层把关，不因此放宽。转交入口的
/// 路由（`forward`）自己先收满本文，理由相同。
async fn read_body_before_routing(req: Request, next: Next) -> Response {
    let (parts, body) = req.into_parts();
    match forward::read_whole(body).await {
        Ok(bytes) => next.run(Request::from_parts(parts, Body::from(bytes))).await,
        Err(e) => e.into_response(),
    }
}

/// 留在 server 的项目路由（导入与事件串流）的写入检查（server-verb-api「写入端点
/// 一律要求 editor 角色」）：GET／HEAD 放行，其他方法要求 editor 角色，否则 403、
/// 处理函数不运行。转交入口的路由由入口依 `can_write` 把关，消息相同。解析好的
/// [`Binding`] 放进 request extensions，处理函数的 extractor 直接取用，不再解析第二次。
///
/// `route_layer` 也包住每条路由「方法不支持」的 405 处理：对既有路径送没有
/// 注册的非 GET 方法（例如 `POST /changes/{name}/drift`），reader 先收到 403、
/// 没带凭证收到 401，只有 editor 会看到 405。写入一样挡下，只是状态码不同。
async fn require_editor(State(state): State<AppState>, req: Request, next: Next) -> Response {
    if matches!(*req.method(), Method::GET | Method::HEAD) {
        return next.run(req).await;
    }
    let (mut parts, body) = req.into_parts();
    let binding = match Binding::from_request_parts(&mut parts, &state).await {
        Ok(binding) => binding,
        Err(e) => return e.into_response(),
    };
    if !binding.editor {
        return ApiError(write_refused(&binding.project.key)).into_response();
    }
    parts.extensions.insert(binding);
    next.run(Request::from_parts(parts, body)).await
}

/// `GET /healthz` — process liveness. Answers as long as the process serves,
/// independent of store health.
async fn healthz() -> StatusCode {
    StatusCode::OK
}

/// `GET /readyz` — readiness gated on the store backend. A store that cannot
/// serve answers non-2xx so a load balancer stops routing to this instance.
async fn readyz(State(state): State<AppState>) -> StatusCode {
    match state.store.health() {
        Ok(()) => StatusCode::OK,
        Err(_) => StatusCode::SERVICE_UNAVAILABLE,
    }
}
