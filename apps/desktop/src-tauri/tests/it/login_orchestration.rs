//! 登录／注销编排契约（client-browser-login D7、D9；规格「device login 缺省与
//! PAT fallback」「注销撤销与移除连带清理」「credential 唯一落点为 OS Keychain」）。
//!
//! 假浏览器打开器＋in-process specseal-server（memory identity）＋in-memory
//! CredentialStore：核准/拒绝由假打开器从 verification URL 的 user_code 预填
//! 参数取码、直接对 identity store 动作——仿真 /activate 页的人。登录的等待循环
//! 在 Rust 这一份（specseal-remote）；轮询间隔与逾时的细节由那边以可注入的时钟
//! 钉死，这里只看 Desktop 的委派、阶段事件与取消。

use chrono::{Duration, Utc};
use specseal_desktop_lib::connections::{
    connection_login, logged_in, logout, pat_login, read_registry, refresh_connection,
    upsert_connection, write_registry, ConnectionLogin, DesktopLoginIo, LoginCancels, LoginMethod,
    LoginPhaseEvent,
};
use specseal_remote::credentials::{CredentialKind, CredentialStore, MemoryCredentialStore};
use specseal_server::config::{IdentityConfig, ServerConfig, StoreConfig};
use specseal_server::events::{EventHub, EventSettings};
use specseal_server::identity::{IdentitySqlite, IdentityStore, NewInvitation};
use specseal_server::state::AppState;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

const DISPLAY: &str = "Dev <dev@example.com>";

// --- in-process server harness（memory identity）＋registry 档 ---

struct Harness {
    origin: String,
    identity: Arc<IdentitySqlite>,
    user_id: String,
    registry: PathBuf,
    _dir: tempfile::TempDir,
}

fn harness() -> Harness {
    let identity = Arc::new(IdentitySqlite::open_memory().expect("memory identity"));
    let invite = identity
        .create_invitation(NewInvitation {
            email: "dev@example.com".to_string(),
            display: DISPLAY.to_string(),
            memberships: vec![],
            admin: false,
            expires_at: Utc::now() + Duration::days(1),
        })
        .expect("invite");
    let user_id = identity
        .accept_invitation(&invite, "pw-correct-horse")
        .expect("accept");

    let store: specseal_server::state::SharedStore =
        Arc::new(specseal_store::memory::MemoryStore::new());
    let events = EventHub::new(store.clone(), EventSettings::default());
    let state = AppState::new(
        store,
        identity.clone(),
        Arc::new(ServerConfig {
            store: StoreConfig::Memory,
            identity: IdentityConfig::Memory,
            public_url: "http://127.0.0.1".to_string(),
            events: EventSettings::default(),
        }),
        events,
    );

    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let addr = listener.local_addr().expect("local addr");
    listener.set_nonblocking(true).expect("nonblocking");
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        runtime.block_on(async move {
            let listener = tokio::net::TcpListener::from_std(listener).expect("adopt listener");
            axum::serve(listener, specseal_server::app::router(state))
                .await
                .expect("serve");
        });
    });

    let dir = tempfile::tempdir().expect("tempdir");
    let registry = dir.path().join("connections.json");
    let origin = format!("http://{addr}");
    let mut entries = Vec::new();
    upsert_connection(&mut entries, &origin, "本地").expect("seed entry");
    write_registry(&registry, &entries).expect("write registry");

    Harness {
        origin,
        identity,
        user_id,
        registry,
        _dir: dir,
    }
}

/// 从 verification URL 的 user_code 预填参数取码。
fn code_of(url: &str) -> String {
    url.split("user_code=")
        .nth(1)
        .expect("URL 带 user_code 预填参数")
        .to_string()
}

/// 一次登录跑到终态，回传结果与途中送往前端的阶段事件。`cancel_on_phase`＝
/// 收到第一个阶段事件就按取消（等同用户在等待面按下取消）。
fn run_login(
    origin: &str,
    store: &dyn CredentialStore,
    registry: &std::path::Path,
    opener: &(dyn Fn(&str) -> Result<(), String> + Sync),
    cancel_on_phase: bool,
) -> (Result<ConnectionLogin, String>, Vec<LoginPhaseEvent>) {
    let events = Mutex::new(Vec::new());
    let cancel = AtomicBool::new(false);
    let emit = |event: LoginPhaseEvent| {
        events.lock().unwrap().push(event);
        if cancel_on_phase {
            cancel.store(true, Ordering::SeqCst);
        }
    };
    let io = DesktopLoginIo {
        origin,
        emit: &emit,
        open_browser: opener,
        cancel: &cancel,
    };
    let outcome = connection_login(origin, store, registry, &io);
    (outcome, events.into_inner().unwrap())
}

fn approving_opener(h: &Harness) -> impl Fn(&str) -> Result<(), String> + Sync {
    let identity = h.identity.clone();
    let user_id = h.user_id.clone();
    move |url: &str| {
        assert!(identity.approve_device(&code_of(url), &user_id).expect("approve"));
        Ok(())
    }
}

fn no_browser(_url: &str) -> Result<(), String> {
    panic!("这条路径不得开浏览器")
}

fn idle_browser(_url: &str) -> Result<(), String> {
    Ok(())
}

// --- 先试一次安静换新 ---

#[test]
fn a_live_refresh_credential_logs_in_without_opening_the_browser() {
    // 「重启」＝内存 access token 消失、只剩 Keychain 的 refresh credential，此时
    // 按登录应直接换新回已登录，不再开浏览器、不送任何阶段事件。
    let h = harness();
    let store = MemoryCredentialStore::new();
    let (first, _) = run_login(&h.origin, &store, &h.registry, &approving_opener(&h), false);
    assert!(matches!(first, Ok(ConnectionLogin::LoggedIn { .. })), "{first:?}");

    let (again, events) = run_login(&h.origin, &store, &h.registry, &no_browser, false);
    match again.expect("silent refresh") {
        ConnectionLogin::LoggedIn { display, access_token } => {
            assert_eq!(display, DISPLAY, "静默换新后身分即刻可读");
            assert!(access_token.is_some(), "换得的 access token 交给 TokenManager");
        }
        other => panic!("expected LoggedIn, got {other:?}"),
    }
    assert!(events.is_empty(), "没有等待面：{events:?}");
}

// --- device login：Rust 跑完整个等待 ---

#[test]
fn a_device_login_emits_the_approval_phase_and_lands_credential_and_identity() {
    let h = harness();
    let store = MemoryCredentialStore::new();
    let opened: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let approve = approving_opener(&h);
    let sink = opened.clone();
    let opener = move |url: &str| {
        sink.lock().unwrap().push(url.to_string());
        approve(url)
    };

    let (outcome, events) = run_login(&h.origin, &store, &h.registry, &opener, false);

    match outcome.expect("device login") {
        ConnectionLogin::LoggedIn { display, access_token } => {
            assert_eq!(display, DISPLAY);
            assert!(access_token.is_some());
        }
        other => panic!("expected LoggedIn, got {other:?}"),
    }
    // 等待授权面所需的一切都在阶段事件里：设备码、验证网址、截止时刻。
    assert_eq!(events.len(), 1, "{events:?}");
    let event = serde_json::to_value(&events[0]).unwrap();
    assert_eq!(event["origin"], h.origin);
    assert_eq!(event["kind"], "awaitingApproval");
    let user_code = event["userCode"].as_str().expect("userCode").to_string();
    assert!(event["verificationUri"].as_str().unwrap().contains("/activate"), "{event}");
    assert!(event["expiresAt"].as_u64().unwrap() > 0, "{event}");
    // 浏览器开的是同一个验证网址，且带 user_code 预填。
    let urls = opened.lock().unwrap();
    assert_eq!(urls.len(), 1);
    assert_eq!(code_of(&urls[0]), user_code);

    let rt = store.get(&h.origin, CredentialKind::Refresh).expect("get").expect("credential");
    assert!(rt.starts_with("spk_rt_"), "存的是 refresh credential：{rt}");
    assert_eq!(store.get(&h.origin, CredentialKind::Pat).expect("get"), None);
    assert_eq!(read_registry(&h.registry)[0].last_actor_display.as_deref(), Some(DISPLAY));
}

#[test]
fn a_browser_denial_reports_denied_and_leaves_no_credential() {
    let h = harness();
    let store = MemoryCredentialStore::new();
    let identity = h.identity.clone();
    let user_id = h.user_id.clone();
    let opener = move |url: &str| {
        assert!(identity.deny_device(&code_of(url), &user_id).expect("deny"));
        Ok(())
    };

    let (outcome, _) = run_login(&h.origin, &store, &h.registry, &opener, false);

    assert!(
        matches!(outcome, Ok(ConnectionLogin::Denied(LoginMethod::Device))),
        "拒绝是可读状态，并带出登录方式：{outcome:?}"
    );
    assert_eq!(store.get(&h.origin, CredentialKind::Refresh).expect("get"), None);
    assert!(read_registry(&h.registry)[0].last_actor_display.is_none());
}

#[test]
fn cancelling_a_device_wait_ends_it_and_stores_nothing() {
    let h = harness();
    let store = MemoryCredentialStore::new();

    let (outcome, events) = run_login(&h.origin, &store, &h.registry, &idle_browser, true);

    assert!(matches!(outcome, Ok(ConnectionLogin::Cancelled)), "{outcome:?}");
    assert_eq!(events.len(), 1);
    for kind in [CredentialKind::Refresh, CredentialKind::Bearer, CredentialKind::Pat] {
        assert_eq!(store.get(&h.origin, kind).expect("get"), None, "{kind:?}");
    }
    assert!(read_registry(&h.registry)[0].last_actor_display.is_none());
}

// --- 浏览器登录：阶段事件只带授权网址与期限 ---

/// 声明浏览器登录的假 server：探索回 browser，登录服务的标准文档也由它供应。
fn browser_server() -> (Arc<tiny_http::Server>, String) {
    let server = Arc::new(tiny_http::Server::http("127.0.0.1:0").expect("bind"));
    let origin = format!("http://{}", server.server_addr());
    let issuer = format!("{origin}/idp");
    let looper = Arc::clone(&server);
    std::thread::spawn(move || {
        for req in looper.incoming_requests() {
            let path = req.url().split('?').next().unwrap_or_default().to_string();
            let (status, body) = match path.as_str() {
                "/api/specseal/v1/auth-methods" => (
                    200,
                    format!(r#"{{"methods":["browser","device"],"browser":{{"issuer":"{issuer}","clientId":"specseal-desktop"}}}}"#),
                ),
                "/.well-known/oauth-authorization-server/idp" => (
                    200,
                    format!(r#"{{"issuer":"{issuer}","authorization_endpoint":"{issuer}/authorize","token_endpoint":"{issuer}/token"}}"#),
                ),
                _ => (404, "{}".to_string()),
            };
            let _ = req.respond(tiny_http::Response::from_string(body).with_status_code(status));
        }
    });
    (server, origin)
}

#[test]
fn a_browser_login_phase_carries_the_url_and_deadline_and_no_secret() {
    let (server, origin) = browser_server();
    let store = MemoryCredentialStore::new();
    let dir = tempfile::tempdir().expect("tempdir");
    let registry = dir.path().join("connections.json");
    let opened: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = opened.clone();
    let opener = move |url: &str| {
        sink.lock().unwrap().push(url.to_string());
        Ok(())
    };

    let (outcome, events) = run_login(&origin, &store, &registry, &opener, true);

    assert!(matches!(outcome, Ok(ConnectionLogin::Cancelled)), "{outcome:?}");
    assert_eq!(events.len(), 1, "{events:?}");
    let event = serde_json::to_value(&events[0]).unwrap();
    assert_eq!(event["kind"], "awaitingBrowser");
    assert_eq!(event["origin"], origin);
    let url = event["url"].as_str().expect("url");
    assert!(url.starts_with(&format!("{origin}/idp/authorize?")), "{url}");
    assert!(url.contains("code_challenge_method=S256"), "{url}");
    assert!(event["expiresAt"].as_u64().unwrap() > 0, "{event}");
    assert!(event.get("userCode").is_none(), "没有设备码：{event}");
    let text = event.to_string();
    for secret in ["code_verifier", "verifier", "access_token", "refresh_token", "\"code\""] {
        assert!(!text.contains(secret), "事件不得带 {secret}：{text}");
    }
    assert_eq!(opened.lock().unwrap().as_slice(), &[url.to_string()], "开的就是事件里的网址");
    // 取消后：Keychain 无任何添加条目，而且回呼的端口已关闭——之后浏览器端完成登录也没用。
    for kind in [CredentialKind::Refresh, CredentialKind::Bearer, CredentialKind::Pat] {
        assert_eq!(store.get(&origin, kind).expect("get"), None, "{kind:?}");
    }
    let redirect = url
        .split("redirect_uri=")
        .nth(1)
        .and_then(|rest| rest.split('&').next())
        .expect("redirect_uri")
        .replace("%3A", ":")
        .replace("%2F", "/");
    let port = redirect.trim_start_matches("http://127.0.0.1:").trim_end_matches("/callback");
    assert!(std::net::TcpStream::connect(format!("127.0.0.1:{port}")).is_err(), "回呼的端口已关闭");
    server.unblock();
}

// --- 探索与探测：未声明时先试 device，404 才改收 PAT；5xx 是连接错误 ---

/// 以固定状态回应所有请求的假 server——探测案例需要「没有 device 端点」的对象。
fn fixed_server(status: u16) -> (Arc<tiny_http::Server>, String) {
    let server = Arc::new(tiny_http::Server::http("127.0.0.1:0").expect("bind"));
    let port = server.server_addr().to_ip().expect("ip").port();
    let looper = Arc::clone(&server);
    std::thread::spawn(move || {
        for req in looper.incoming_requests() {
            let _ = req.respond(tiny_http::Response::from_string("").with_status_code(status));
        }
    });
    (server, format!("http://127.0.0.1:{port}"))
}

#[test]
fn an_undeclared_server_without_a_device_flow_asks_for_a_pat() {
    let (server, origin) = fixed_server(404);
    let store = MemoryCredentialStore::new();
    let dir = tempfile::tempdir().expect("tempdir");
    let registry = dir.path().join("connections.json");

    let (outcome, events) = run_login(&origin, &store, &registry, &no_browser, false);

    assert!(matches!(outcome, Ok(ConnectionLogin::PatRequired)), "{outcome:?}");
    assert!(events.is_empty());
    server.unblock();
}

#[test]
fn a_token_only_server_asks_for_a_pat_without_trying_the_device_flow() {
    let server = Arc::new(tiny_http::Server::http("127.0.0.1:0").expect("bind"));
    let origin = format!("http://{}", server.server_addr());
    let paths: Arc<Mutex<Vec<String>>> = Arc::default();
    let (looper, log) = (Arc::clone(&server), paths.clone());
    std::thread::spawn(move || {
        for req in looper.incoming_requests() {
            log.lock().unwrap().push(req.url().to_string());
            let (status, body) = if req.url() == "/api/specseal/v1/auth-methods" {
                (200, r#"{"methods":["token"]}"#)
            } else {
                (404, "{}")
            };
            let _ = req.respond(tiny_http::Response::from_string(body).with_status_code(status));
        }
    });
    let store = MemoryCredentialStore::new();
    let dir = tempfile::tempdir().expect("tempdir");

    let (outcome, _) = run_login(&origin, &store, &dir.path().join("connections.json"), &no_browser, false);

    assert!(matches!(outcome, Ok(ConnectionLogin::PatRequired)), "{outcome:?}");
    assert_eq!(paths.lock().unwrap().as_slice(), &["/api/specseal/v1/auth-methods".to_string()]);
    server.unblock();
}

#[test]
fn a_5xx_is_a_connection_error_not_a_fallback() {
    let (server, origin) = fixed_server(503);
    let store = MemoryCredentialStore::new();
    let dir = tempfile::tempdir().expect("tempdir");
    let registry = dir.path().join("connections.json");

    let (outcome, _) = run_login(&origin, &store, &registry, &no_browser, false);

    assert!(outcome.is_err(), "5xx 是错误、绝不进 PAT fallback：{outcome:?}");
    assert_eq!(store.get(&origin, CredentialKind::Refresh).expect("get"), None);
    server.unblock();
}

// --- pat_login：身分查找验证后才入 store ---

#[test]
fn pat_login_validates_via_whoami_before_storing() {
    let h = harness();
    let store = MemoryCredentialStore::new();
    let (_, pat) = h.identity.create_pat(&h.user_id, "desktop", None).expect("pat");

    let display = pat_login(&h.origin, &pat, &store, &h.registry).expect("pat login");
    assert_eq!(display, DISPLAY);
    assert_eq!(
        store.get(&h.origin, CredentialKind::Pat).expect("get").as_deref(),
        Some(pat.as_str()),
        "验证通过后 PAT 才入 store"
    );
    assert_eq!(read_registry(&h.registry)[0].last_actor_display.as_deref(), Some(DISPLAY));
}

#[test]
fn an_invalid_pat_is_refused_and_never_stored() {
    let h = harness();
    let store = MemoryCredentialStore::new();
    pat_login(&h.origin, "spk_pat_nope", &store, &h.registry).expect_err("无效 PAT 拒绝");
    assert_eq!(store.get(&h.origin, CredentialKind::Pat).expect("get"), None, "无效 PAT 不落任何盘");
    assert!(read_registry(&h.registry)[0].last_actor_display.is_none());
}

// --- rotation：新 refresh credential 覆写 ---

#[test]
fn rotation_overwrites_the_stored_refresh_credential() {
    let h = harness();
    let store = MemoryCredentialStore::new();
    run_login(&h.origin, &store, &h.registry, &approving_opener(&h), false).0.expect("login");
    let old_rt = store.get(&h.origin, CredentialKind::Refresh).expect("get").expect("rt");

    let access = refresh_connection(&h.origin, &store).expect("rotation");
    assert!(access.starts_with("spk_at_"), "rotation 换得新 access token");
    let new_rt = store.get(&h.origin, CredentialKind::Refresh).expect("get").expect("rt");
    assert_ne!(new_rt, old_rt, "新 refresh credential 覆写 Keychain slot");

    // 再 rotation 一次成功——证明 store 里是活的最新 credential（旧 rt 重用
    // 会被 server 以 family revocation 拒绝）。
    refresh_connection(&h.origin, &store).expect("再次 rotation 走最新 credential");
}

#[test]
fn a_transient_server_failure_never_discards_a_live_refresh_credential() {
    // 5xx／不可达是连接错误，不是「credential 已失效」的语意信号——抹掉有效
    // credential 会让 server 一次短暂抖动就逼用户重新登录。
    let (server, origin) = fixed_server(503);
    let store = MemoryCredentialStore::new();
    store.set(&origin, CredentialKind::Refresh, "spk_rt_live").expect("set");
    let dir = tempfile::tempdir().expect("tempdir");
    let registry = dir.path().join("connections.json");

    let (outcome, _) = run_login(&origin, &store, &registry, &no_browser, false);

    assert!(outcome.is_err(), "5xx 是连接错误");
    assert_eq!(
        store.get(&origin, CredentialKind::Refresh).expect("get").as_deref(),
        Some("spk_rt_live"),
        "server 暂时不可达不得抹除有效 credential"
    );
    server.unblock();
}

#[test]
fn a_rejected_refresh_credential_is_cleared_and_the_full_device_flow_takes_over() {
    // 对照组：server 明确拒绝才是「credential 已死」——清掉残骸、走完整登录。
    let h = harness();
    let store = MemoryCredentialStore::new();
    store.set(&h.origin, CredentialKind::Refresh, "spk_rt_dead").expect("set");

    let (outcome, _) = run_login(&h.origin, &store, &h.registry, &approving_opener(&h), false);

    assert!(matches!(outcome, Ok(ConnectionLogin::LoggedIn { .. })), "残骸不挡重新核准：{outcome:?}");
    let rt = store.get(&h.origin, CredentialKind::Refresh).expect("get").expect("credential");
    assert_ne!(rt, "spk_rt_dead", "残骸已被新核准的 refresh credential 取代");
}

// --- logout：尽力撤销＋清掉和 CLI 相同的三个条目 ---

#[test]
fn logout_revokes_the_family_and_clears_every_keyring_entry() {
    let h = harness();
    let store = MemoryCredentialStore::new();
    let access = match run_login(&h.origin, &store, &h.registry, &approving_opener(&h), false).0 {
        Ok(ConnectionLogin::LoggedIn { access_token: Some(access), .. }) => access,
        other => panic!("expected LoggedIn, got {other:?}"),
    };
    assert!(store.get(&h.origin, CredentialKind::Bearer).expect("get").is_some(), "登录时缓存了 access token");

    let result = logout(&h.origin, &store, &h.registry).expect("logout");
    assert!(result.revoked_on_server, "refresh 走 /auth/revoke 撤了 device family");
    assert!(!result.pat_notice);
    for kind in [CredentialKind::Refresh, CredentialKind::Bearer, CredentialKind::Pat] {
        assert_eq!(store.get(&h.origin, kind).expect("get"), None, "{kind:?} 已删");
    }
    assert!(read_registry(&h.registry)[0].last_actor_display.is_none(), "registry 身分已清");
    assert!(
        h.identity.authenticate_access_token(&access).expect("authenticate").is_none(),
        "server 端 family 已撤——access token 一并失效"
    );
}

#[test]
fn logout_against_an_unreachable_server_still_cleans_up_locally() {
    let origin = "http://127.0.0.1:1".to_string(); // 无人监听——server 不可达
    let dir = tempfile::tempdir().expect("tempdir");
    let registry = dir.path().join("connections.json");
    let mut entries = Vec::new();
    upsert_connection(&mut entries, &origin, "脱机").expect("seed");
    entries[0].last_actor_display = Some(DISPLAY.to_string());
    write_registry(&registry, &entries).expect("write");
    let store = MemoryCredentialStore::new();
    store.set(&origin, CredentialKind::Refresh, "spk_rt_orphan").expect("set");
    store.set(&origin, CredentialKind::Bearer, "{}").expect("set");

    let result = logout(&origin, &store, &registry).expect("撤销失败不阻挡本机删除");
    assert!(!result.revoked_on_server, "尽力撤销失败如实回报");
    assert_eq!(store.get(&origin, CredentialKind::Refresh).expect("get"), None, "本机 entry 仍被清除");
    assert_eq!(store.get(&origin, CredentialKind::Bearer).expect("get"), None);
    assert!(read_registry(&registry)[0].last_actor_display.is_none());
}

#[test]
fn pat_logout_deletes_locally_and_hints_at_the_account_page() {
    let h = harness();
    let store = MemoryCredentialStore::new();
    let (_, pat) = h.identity.create_pat(&h.user_id, "desktop", None).expect("pat");
    pat_login(&h.origin, &pat, &store, &h.registry).expect("pat login");

    let result = logout(&h.origin, &store, &h.registry).expect("logout");
    assert!(result.pat_notice, "PAT 无自助撤销端点——提示至 /account 页撤销");
    assert!(!result.revoked_on_server);
    assert_eq!(store.get(&h.origin, CredentialKind::Pat).expect("get"), None);
}

// --- 取消旗标 ---

#[test]
fn a_new_login_cancels_the_one_still_running_for_the_same_origin() {
    let cancels = LoginCancels::default();
    let first = cancels.begin("https://a.example");
    let second = cancels.begin("https://a.example");
    assert!(first.load(Ordering::SeqCst), "重按登录＝取消前一轮");
    assert!(!second.load(Ordering::SeqCst));

    // 前一轮收尾时不得清掉新一轮的旗标。
    cancels.end("https://a.example", &first);
    cancels.cancel("https://a.example");
    assert!(second.load(Ordering::SeqCst), "取消命中仍在跑的那一轮");

    let other = cancels.begin("https://b.example");
    cancels.cancel("https://a.example");
    assert!(!other.load(Ordering::SeqCst), "取消只作用于该 origin");
}

// --- 回给前端的内容与调试输出都不带 token ---

#[test]
fn a_login_result_shows_its_status_and_method_but_never_the_token() {
    let logged_in = ConnectionLogin::LoggedIn {
        display: DISPLAY.to_string(),
        access_token: Some("spk_at_secret".to_string()),
    };
    assert_eq!(logged_in.view(), serde_json::json!({ "status": "loggedIn", "display": DISPLAY }));
    assert!(!format!("{logged_in:?}").contains("spk_at_secret"), "{logged_in:?}");

    assert_eq!(
        ConnectionLogin::Denied(LoginMethod::Browser).view(),
        serde_json::json!({ "status": "denied", "method": "browser" })
    );
    assert_eq!(
        ConnectionLogin::Expired(LoginMethod::Device).view(),
        serde_json::json!({ "status": "expired", "method": "device" })
    );
    assert_eq!(ConnectionLogin::PatRequired.view(), serde_json::json!({ "status": "patRequired" }));
    assert_eq!(ConnectionLogin::Cancelled.view(), serde_json::json!({ "status": "cancelled" }));
}

// --- 已登录的判断：和 CLI 看同一组 Keychain 条目 ---

#[test]
fn a_connection_counts_as_logged_in_with_a_refresh_or_a_pat_entry() {
    let store = MemoryCredentialStore::new();
    let origin = "https://team.example.com";
    assert!(!logged_in(origin, &store), "没有任何条目＝未登录");

    store.set(origin, CredentialKind::Bearer, "{}").expect("set");
    assert!(!logged_in(origin, &store), "只有 access token 缓存不算登录");

    store.set(origin, CredentialKind::Pat, "spk_pat_x").expect("set");
    assert!(logged_in(origin, &store), "访问密钥条目＝已登录");

    store.delete(origin, CredentialKind::Pat).expect("delete");
    store.set(origin, CredentialKind::Refresh, "spk_rt_x").expect("set");
    assert!(logged_in(origin, &store), "refresh 条目＝已登录");
}

/// 规格情境「CLI 以 PAT 登录后 desktop 视为已登录」：CLI 走的是共用的 pat_login
/// （带凭证档退路），写进同一个 Keychain 条目，Desktop 的清单就看得到。
#[test]
fn a_pat_login_made_by_the_cli_shows_as_logged_in_on_the_desktop() {
    let h = harness();
    let store = MemoryCredentialStore::new();
    let (_, pat) = h.identity.create_pat(&h.user_id, "cli", None).expect("pat");
    let dir = tempfile::tempdir().expect("tempdir");
    let origin = specseal_remote::auth::origin_of(&format!("{}/api/specseal/v1/projects/demo", h.origin));
    let cli = specseal_remote::login::LoginTarget { origin: &origin, credentials: &store, lock_dir: dir.path() };

    let outcome = specseal_remote::login::pat_login(&cli, &pat, Some(dir.path()));

    assert!(matches!(outcome, specseal_remote::login::PatLoginOutcome::LoggedIn { .. }), "{outcome:?}");
    assert!(logged_in(&h.origin, &store), "Desktop 以 registry 的 origin 查同一个条目");
}
