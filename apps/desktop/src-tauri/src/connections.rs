//! connection registry（design 决策 4）与登录／注销编排（决策 3、5、6）。
//!
//! registry：saved servers 的无 secret profile 清单，存 app 设置目录
//! （appConfigDir）下的 connections.json。条目＝{id、origin（baseUrl 范式）、
//! name、lastActorDisplay?}——绝不含任何 token 字段（规格「connection registry
//! 不含 secret 且跨重启保留」）。一 origin 一条目，重复添加即更新显示名。
//! 坏 JSON 归零清单（与分页持久化同一宽容哲学）。
//!
//! 编排：connection_login／pat_login／logout／refresh_connection 收注入的
//! CredentialStore 与 [`DesktopLoginIo`]、无 tauri 类型——tauri 接线在 lib.rs。
//! 探索、选择、三种登录与注销都委派给 specseal-remote 的同一份登录程序
//! （client-browser-login D7），和 CLI 共用；等待浏览器或设备核准的循环也在那边，
//! 这里只把阶段转成送往前端的事件、把取消接到旗标。secret 只在此层与
//! CredentialStore 之间流动，错误消息与事件不夹带 secret。

use serde::{Deserialize, Serialize};
use specseal_remote::credentials::{CredentialKind, CredentialStore};
use specseal_remote::device;
use specseal_remote::login::{
    self as remote_login, LoginOutcome, LoginPhase, LoginTarget, PatLoginOutcome, Plan,
};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub use specseal_remote::login::normalize_origin;

/// registry 的一个 saved server 条目。字段全集即此——串行化测试钉死。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionEntry {
    pub id: String,
    /// 范式后的 server origin（scheme://host[:port]，小写、无路径）。
    pub origin: String,
    pub name: String,
    /// 最后登录身分的显示名；未登录过即省略。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_actor_display: Option<String>,
}

/// registry 档在 app 设置目录下的固定位置。
pub fn registry_path(config_dir: &Path) -> PathBuf {
    config_dir.join("connections.json")
}

/// 读 registry：文件不存在或坏 JSON 一律归零清单、不崩溃。
pub fn read_registry(path: &Path) -> Vec<ConnectionEntry> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// registry 档的行程内互斥：command async 化后 add／remove 的
/// read→modify→write 不再由主线程天然串行化，跨线程并行的整档覆写会
/// 互相盖掉——所有 mutation 先取这把锁（跨行程仍无锁，属既有边界）。
static REGISTRY_MUTATION: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 取得 registry mutation 锁；poisoned（前一持有者 panic）照常放行——
/// registry 操作间无跨调用的内存不变量，锁只管文件串行化。
pub fn registry_guard() -> std::sync::MutexGuard<'static, ()> {
    REGISTRY_MUTATION
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 添加连接的完整交易（锁内 read→upsert→write）：并行调用不互相盖写。
/// 回传刚落地的条目。
pub fn add_connection(
    path: &Path,
    base_url: &str,
    name: &str,
) -> Result<ConnectionEntry, String> {
    let _guard = registry_guard();
    let mut entries = read_registry(path);
    let id = upsert_connection(&mut entries, base_url, name)?;
    write_registry(path, &entries)?;
    Ok(entries
        .into_iter()
        .find(|e| e.id == id)
        .expect("刚 upsert 的条目存在"))
}

/// 移除连接的完整交易（锁内 read→logout→write）：先走注销语意（撤销＋删
/// Keychain entry）再删条目；注销的本机删除失败上抛、不删条目——避免留下
/// 孤儿 credential。回传被移除条目的 origin（无此 id＝`Ok(None)`，幂等）。
pub fn remove_connection(
    path: &Path,
    id: &str,
    credentials: &dyn CredentialStore,
) -> Result<Option<String>, String> {
    let _guard = registry_guard();
    let mut entries = read_registry(path);
    let Some(entry) = entries.iter().find(|e| e.id == id) else {
        return Ok(None);
    };
    let origin = entry.origin.clone();
    logout(&origin, credentials, path)?;
    entries = read_registry(path); // logout 刚清了身分字段
    entries.retain(|e| e.id != id);
    write_registry(path, &entries)?;
    Ok(Some(origin))
}

/// 写 registry：建父目录后整档覆写。
pub fn write_registry(path: &Path, entries: &[ConnectionEntry]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("无法创建设置目录：{e}"))?;
    }
    let text =
        serde_json::to_string_pretty(entries).map_err(|e| format!("无法串行化连接清单：{e}"))?;
    std::fs::write(path, text).map_err(|e| format!("无法写入连接清单：{e}"))
}

/// 添加或更新连接：同 origin 已存在即更新显示名（id 稳定），否则添加条目。
/// 回传该条目的 id。
pub fn upsert_connection(
    entries: &mut Vec<ConnectionEntry>,
    base_url: &str,
    name: &str,
) -> Result<String, String> {
    let origin = normalize_origin(base_url)?;
    if let Some(existing) = entries.iter_mut().find(|e| e.origin == origin) {
        existing.name = name.to_string();
        return Ok(existing.id.clone());
    }
    let id = format!(
        "conn_{}",
        ulid::Ulid::new().to_string().to_ascii_lowercase()
    );
    entries.push(ConnectionEntry {
        id: id.clone(),
        origin,
        name: name.to_string(),
        last_actor_display: None,
    });
    Ok(id)
}

/// `inspect_checkout` 的零写入结果：确认过的 checkout 根路径，以及要在 picker
/// 中预选的既有 built-in 工具选集（claude／codex／copilot／pi／cursor，顺序稳定）。IPC 串行化为
/// camelCase `{ root, tools }`——不携带任何 credential 或 Server 数据。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutInspection {
    pub root: String,
    pub tools: Vec<String>,
}

/// 一次验证文件夹与 marker 一致性，回传确认过的 checkout 根路径（display 字符串）。
/// 零写入：`inspect_checkout` 与 `bind_checkout` 共用此边界，因此提交时重做的是
/// 同一组检查。相符 marker 只接受相同 origin/repo；无 marker 时要求 `.git` 存在。
fn validate_checkout(
    root: &Path,
    selected_origin: &str,
    selected_repo: &str,
) -> Result<String, String> {
    if !root.is_dir() {
        return Err(format!(
            "无法连接 checkout：{} 不是现有文件夹",
            root.display()
        ));
    }
    let selected_origin = normalize_origin(selected_origin)?;
    let app =
        specseal_core::config::AppConfig::load(&root.join(".specseal.yaml")).map_err(|e| e.to_string())?;

    if let Some(remote) = app.remote {
        let marker_url = remote
            .url
            .filter(|url| !url.trim().is_empty())
            .ok_or_else(|| "remote marker 缺少 remote.url，无法确认 checkout 绑定".to_string())?;
        let marker_origin = normalize_origin(&marker_url)
            .map_err(|e| format!("remote marker 的 url「{marker_url}」无效：{e}"))?;
        let marker_repo = remote
            .repo
            .filter(|repo| !repo.trim().is_empty())
            .unwrap_or_else(|| "（未指定 repo）".to_string());
        if marker_origin != selected_origin || marker_repo != selected_repo {
            return Err(format!(
                "此文件夹的 remote marker 指向 {marker_origin} / {marker_repo}，与所选 {selected_origin} / {selected_repo} 不一致"
            ));
        }
    } else if !root.join(".git").exists() {
        return Err("选择的文件夹不是 Git repository，无法连接 checkout".to_string());
    }
    Ok(root.display().to_string())
}

/// 决定 picker 的预选：`.specseal.yaml` 记录了 built-in 选集就用它（claude／codex／copilot／
/// pi／cursor，去重、顺序稳定）；缺清单、或清单里没有任何可解析的内置名（只有描述子／未知名）
/// 时，只依实际 Claude／Codex footprint 预选（`.github/`、`.pi/`、`.cursor/` 不算 Copilot、Pi、
/// Cursor 的 footprint），绝不补 Claude fallback。
fn preselected_tools(root: &Path) -> Vec<String> {
    let app = match specseal_core::config::AppConfig::load(&root.join(".specseal.yaml")) {
        Ok(app) => app,
        Err(_) => return Vec::new(),
    };
    // 工具选集的解析只有 core 一份（ToolSelection）：这里不再自写 tools 循环。
    let selection = specseal_core::init::ToolSelection::resolve(root, &app);
    let picked = if selection.legacy_fallback || selection.builtins.is_empty() {
        specseal_core::init::detect_footprint_tools(root)
    } else {
        selection.builtins
    };
    picked.iter().map(|t| t.name().to_string()).collect()
}

/// 先检查阶段（零写入）：验证文件夹与 marker，回传确认过的根路径与要预选的工具选集。
pub fn inspect_checkout(
    root: &Path,
    selected_origin: &str,
    selected_project: &str,
    selected_repo: &str,
) -> Result<CheckoutInspection, String> {
    let _ = selected_project;
    let root_str = validate_checkout(root, selected_origin, selected_repo)?;
    Ok(CheckoutInspection {
        root: root_str,
        tools: preselected_tools(root),
    })
}

/// 提交阶段：重做 marker 边界验证，无 marker 时写入与 CLI init remote 同构的
/// remote section，再对非空 built-in 选集运行 Core reconciliation（生成所选、
/// 清理未选、保留自订描述子与用户内容）。全部成功才回传 checkout 根路径供
/// remote locator 的 checkoutRoot 使用；任一步失败回传单行 Err、不回传 root。
pub fn bind_checkout(
    root: &Path,
    selected_origin: &str,
    selected_project: &str,
    selected_repo: &str,
    tools: &[String],
) -> Result<String, String> {
    // 空选集／未知工具在任何写入之前被拒（fail loud）。
    let selected =
        specseal_core::init::parse_tool_names(tools).map_err(|e| single_line(&e.to_string()))?;
    if selected.is_empty() {
        return Err("请至少选择一个内置工具：claude、codex、copilot、pi、cursor".to_string());
    }
    let root_str = validate_checkout(root, selected_origin, selected_repo)?;

    // 无 marker 时先写入同构 remote section，让后续 reconciliation 认得 remote 模式。
    if specseal_core::config::AppConfig::load(&root.join(".specseal.yaml"))
        .map_err(|e| e.to_string())?
        .remote
        .is_none()
    {
        let normalized = normalize_origin(selected_origin)?;
        let project_url = format!("{normalized}/api/specseal/v1/projects/{selected_project}");
        specseal_core::config::write_remote_section(root, &project_url, Some(selected_repo))
            .map_err(|e| format!("无法写入 remote marker：{e}"))?;
    }

    specseal_core::init::reconcile_builtin_tools(root, &selected)
        .map_err(|e| single_line(&e.to_string()))?;
    Ok(root_str)
}

/// 把多行错误压成单行（IPC 错误在 UI 只呈现一行）。
fn single_line(message: &str) -> String {
    message.split('\n').next().unwrap_or(message).trim().to_string()
}

// --- 登录／注销编排（client-browser-login D7、D9） ---

/// 送往前端的登录阶段事件名称。
pub const LOGIN_PHASE_EVENT: &str = "connection-login-phase";

/// 送往前端的登录阶段（事件 [`LOGIN_PHASE_EVENT`] 的内容）。`kind` 与字段名和
/// 前端的 `ConnectionPhase` 一致，前端收到即可直接显示。只带用户要看的东西：
/// 授权网址，或设备码与验证网址，以及截止时刻（epoch 毫秒）——授权网址含
/// state 与 PKCE challenge，不含授权码、PKCE verifier 或任何 token。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LoginPhaseEvent {
    pub origin: String,
    #[serde(flatten)]
    pub phase: PhaseView,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PhaseView {
    #[serde(rename_all = "camelCase")]
    AwaitingBrowser { url: String, expires_at: u64 },
    #[serde(rename_all = "camelCase")]
    AwaitingApproval {
        user_code: String,
        verification_uri: String,
        expires_at: u64,
    },
}

/// Desktop 的登录 IO：阶段经 `emit` 送往前端、浏览器经 opener 插件打开、
/// 取消读 `cancel` 旗标（由 connection_login_cancel 设置）。
pub struct DesktopLoginIo<'a> {
    pub origin: &'a str,
    pub emit: &'a (dyn Fn(LoginPhaseEvent) + Sync),
    pub open_browser: &'a (dyn Fn(&str) -> Result<(), String> + Sync),
    pub cancel: &'a AtomicBool,
}

/// 取消的反应时间：等待被切成这么长的片段，每段之间看一次旗标。
const CANCEL_POLL: std::time::Duration = std::time::Duration::from_millis(100);

fn expires_at_ms(expires_in: u64) -> u64 {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    now + expires_in * 1000
}

impl remote_login::LoginIo for DesktopLoginIo<'_> {
    fn phase(&self, phase: LoginPhase) {
        let phase = match phase {
            LoginPhase::AwaitingBrowser { url, expires_in } => PhaseView::AwaitingBrowser {
                url,
                expires_at: expires_at_ms(expires_in),
            },
            LoginPhase::AwaitingDevice { verification_uri, user_code, expires_in } => {
                PhaseView::AwaitingApproval {
                    user_code,
                    verification_uri,
                    expires_at: expires_at_ms(expires_in),
                }
            }
        };
        (self.emit)(LoginPhaseEvent { origin: self.origin.to_string(), phase });
    }

    /// 开不了也继续等：等待面有可拷贝的网址。
    fn open_browser(&self, url: &str) -> bool {
        (self.open_browser)(url).is_ok()
    }

    fn sleep_secs(&self, secs: u64) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(secs);
        while !self.cancelled() && std::time::Instant::now() < deadline {
            std::thread::sleep(CANCEL_POLL);
        }
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }
}

/// 被拒或逾时的那一轮用的是哪一种登录：两种的说法不同，前端照它选文案。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LoginMethod {
    Browser,
    Device,
}

/// 一次登录的可读结果。连接错误走 Err、绝不进 PAT fallback。
pub enum ConnectionLogin {
    /// 已登录。`access_token` 是登录当下缓存的短效 token，交给 TokenManager
    /// 在内存持有；不落盘、不过境 TS。
    LoggedIn {
        display: String,
        access_token: Option<String>,
    },
    /// server 没有 device flow（没有声明时）或只收访问密钥：就地改收 PAT。
    PatRequired,
    Denied(LoginMethod),
    Expired(LoginMethod),
    Cancelled,
}

impl ConnectionLogin {
    /// 回给前端的内容：状态，加上显示名（已登录）或登录方式（被拒、逾时）。
    /// access token 不在里面。
    pub fn view(&self) -> serde_json::Value {
        match self {
            ConnectionLogin::LoggedIn { display, .. } => {
                serde_json::json!({ "status": "loggedIn", "display": display })
            }
            ConnectionLogin::PatRequired => serde_json::json!({ "status": "patRequired" }),
            ConnectionLogin::Denied(method) => serde_json::json!({ "status": "denied", "method": method }),
            ConnectionLogin::Expired(method) => serde_json::json!({ "status": "expired", "method": method }),
            ConnectionLogin::Cancelled => serde_json::json!({ "status": "cancelled" }),
        }
    }
}

/// 印出时不带 access token，`{:?}` 进了 log 也不会泄漏。
impl std::fmt::Debug for ConnectionLogin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConnectionLogin::LoggedIn { display, access_token } => f
                .debug_struct("LoggedIn")
                .field("display", display)
                .field("access_token", &access_token.as_ref().map(|_| "<redacted>"))
                .finish(),
            ConnectionLogin::PatRequired => f.write_str("PatRequired"),
            ConnectionLogin::Denied(method) => write!(f, "Denied({method:?})"),
            ConnectionLogin::Expired(method) => write!(f, "Expired({method:?})"),
            ConnectionLogin::Cancelled => f.write_str("Cancelled"),
        }
    }
}

/// 登录（D7）：先以 Keychain 既有 refresh credential 静默换新（规格「rotation 后
/// 旧 credential 失效仍可用」——重启后无需重新登录）；没有或已失效才探索
/// server 声明的方式、依固定顺序选择并跑到终态。Desktop 不指定方式。
pub fn connection_login(
    origin: &str,
    credentials: &dyn CredentialStore,
    registry_path: &Path,
    io: &DesktopLoginIo,
) -> Result<ConnectionLogin, String> {
    if credentials.get(origin, CredentialKind::Refresh)?.is_some() {
        match refresh_connection(origin, credentials) {
            Ok(access) => {
                let display = record_identity_from_server(origin, &access, registry_path)?;
                return Ok(ConnectionLogin::LoggedIn { display, access_token: Some(access) });
            }
            // 明确被拒＝credential 已死：清掉残骸、走完整登录。
            Err(RefreshFailure::Rejected(_)) => {
                specseal_remote::auth::clear_keychain_login(origin, credentials);
            }
            // 生死未卜（5xx／不可达／Keychain 故障）：credential 原封不动，
            // 回报连接错误——暂时性失败不是语意信号。
            Err(RefreshFailure::Unavailable(message)) => return Err(message),
        }
    }

    let discovery = remote_login::discover(origin).map_err(|e| e.message)?;
    let plan = remote_login::choose(&discovery, None).map_err(|e| e.to_string())?;
    let method = if matches!(plan, Plan::Browser(_)) { LoginMethod::Browser } else { LoginMethod::Device };
    let lock_dir = specseal_remote::auth::specseal_config_dir();
    let target = LoginTarget { origin, credentials, lock_dir: &lock_dir };
    Ok(match remote_login::login(&target, &plan, io) {
        LoginOutcome::LoggedIn { display, .. } => {
            record_identity(registry_path, origin, Some(&display))?;
            ConnectionLogin::LoggedIn {
                display,
                access_token: specseal_remote::refresh::cached_bearer(origin, credentials),
            }
        }
        // credential 已存好、只是查不到身分：照样是已登录，身分栏留空。
        LoginOutcome::LoggedInWithoutIdentity { .. } => ConnectionLogin::LoggedIn {
            display: String::new(),
            access_token: specseal_remote::refresh::cached_bearer(origin, credentials),
        },
        LoginOutcome::Denied => ConnectionLogin::Denied(method),
        LoginOutcome::Expired => ConnectionLogin::Expired(method),
        LoginOutcome::Cancelled => ConnectionLogin::Cancelled,
        LoginOutcome::Unsupported | LoginOutcome::TokenRequired => ConnectionLogin::PatRequired,
        LoginOutcome::KeychainUnavailable => {
            return Err("无法安全保存登录凭证：系统 Keychain 无法使用".to_string())
        }
        LoginOutcome::Failed(message) => return Err(message),
    })
}

/// 这个 origin 在 Keychain 有没有登录：浏览器或设备登录的 refresh 条目，或
/// 访问密钥的条目。CLI 写的是同一组条目，所以在 CLI 以访问密钥登录后，这里
/// 也算已登录，反过来也一样。
pub fn logged_in(origin: &str, credentials: &dyn CredentialStore) -> bool {
    [CredentialKind::Refresh, CredentialKind::Pat]
        .into_iter()
        .any(|kind| matches!(credentials.get(origin, kind), Ok(Some(_))))
}

/// 进行中的登录的取消旗标（keyed by origin）。同一 origin 再按登录＝取消前一轮。
#[derive(Default)]
pub struct LoginCancels(Mutex<HashMap<String, Arc<AtomicBool>>>);

impl LoginCancels {
    /// 开始一轮登录，回传它的取消旗标；同 origin 前一轮仍在跑就先取消它。
    pub fn begin(&self, origin: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        let previous = self
            .0
            .lock()
            .expect("login cancel lock")
            .insert(origin.to_string(), flag.clone());
        if let Some(previous) = previous {
            previous.store(true, Ordering::SeqCst);
        }
        flag
    }

    /// 取消该 origin 正在跑的那一轮（没有就什么都不做）。
    pub fn cancel(&self, origin: &str) {
        if let Some(flag) = self.0.lock().expect("login cancel lock").get(origin) {
            flag.store(true, Ordering::SeqCst);
        }
    }

    /// 一轮结束：只移除自己的旗标，不动之后开始的那一轮。
    pub fn end(&self, origin: &str, flag: &Arc<AtomicBool>) {
        let mut map = self.0.lock().expect("login cancel lock");
        if map.get(origin).is_some_and(|current| Arc::ptr_eq(current, flag)) {
            map.remove(origin);
        }
    }
}

/// PAT 登录（规格「PAT 登录 SHALL 以身分查找验证有效后才存入 Keychain」）：
/// 委派共用的 pat_login，Desktop 不退到凭证档（credential 只在 Keychain）。
/// PAT 仅单次过境此参数，不回读、不入 log。
pub fn pat_login(
    origin: &str,
    pat: &str,
    credentials: &dyn CredentialStore,
    registry_path: &Path,
) -> Result<String, String> {
    let lock_dir = specseal_remote::auth::specseal_config_dir();
    let target = LoginTarget { origin, credentials, lock_dir: &lock_dir };
    match remote_login::pat_login(&target, pat, None) {
        PatLoginOutcome::LoggedIn { display, .. } => {
            record_identity(registry_path, origin, Some(&display))?;
            Ok(display)
        }
        PatLoginOutcome::Denied => Err("PAT 无效或已被撤销".to_string()),
        PatLoginOutcome::KeychainUnavailable => Err("无法存入系统 Keychain".to_string()),
        PatLoginOutcome::Failed(message) => Err(message),
    }
}

/// 注销结果：撤销是尽力语意（server 不可达不阻挡本机删除）；PAT 无自助撤销
/// 端点，回报提示请用户至 server 帐号页撤销。
#[derive(Debug)]
pub struct LogoutOutcome {
    pub revoked_on_server: bool,
    pub pat_notice: bool,
}

/// 注销：委派共用的 logout（清掉的 Keychain 范围与 CLI 相同：refresh、access
/// token 缓存、PAT），再清 registry 身分。
pub fn logout(
    origin: &str,
    credentials: &dyn CredentialStore,
    registry_path: &Path,
) -> Result<LogoutOutcome, String> {
    let outcome = remote_login::logout(origin, credentials, None)?;
    record_identity(registry_path, origin, None)?;
    Ok(LogoutOutcome {
        revoked_on_server: outcome.revoked,
        pat_notice: outcome.removed_pat,
    })
}

/// rotation 失败的两种语意（实作下沉至 specseal-remote，与 CLI 共用）——
/// 调用端据此决定「清掉 credential 要求重登录」还是「原封保留、稍后再试」。
/// 决策 3 的原则不只适用于登录前探测：任何暂时性失败都不得被读成
/// 「credential 已失效」。
pub use specseal_remote::refresh::RefreshFailure;

/// 换发全程持跨行程文件锁（cli-desktop-credential-sharing）：CLI 与 desktop
/// 共用同一个 credential family，两边同时换发会撞上 server 的 reuse 侦测而
/// 整族撤销。新 refresh credential 与 access token 缓存由下沉层一并回写。
pub fn refresh_connection(
    origin: &str,
    credentials: &dyn CredentialStore,
) -> Result<String, RefreshFailure> {
    specseal_remote::refresh::rotate(
        origin,
        credentials,
        &specseal_remote::auth::specseal_config_dir(),
    )
}

/// 查身分（API 根的 whoami，没有时退回 /auth/whoami）并把显示名写回 registry。
fn record_identity_from_server(
    origin: &str,
    bearer: &str,
    registry_path: &Path,
) -> Result<String, String> {
    let who = device::identity(origin, bearer).map_err(|e| e.to_string())?;
    record_identity(registry_path, origin, Some(&who.user.name))?;
    Ok(who.user.name)
}

/// 更新 registry 中该 origin 条目的身分显示名（None＝清除）。条目不存在时
/// 静默略过——登录流程由 connection_add 先建条目。
fn record_identity(
    registry_path: &Path,
    origin: &str,
    display: Option<&str>,
) -> Result<(), String> {
    let mut entries = read_registry(registry_path);
    if let Some(entry) = entries.iter_mut().find(|e| e.origin == origin) {
        entry.last_actor_display = display.map(str::to_string);
        write_registry(registry_path, &entries)?;
    }
    Ok(())
}

#[cfg(test)]
mod checkout_tests {
    //! spec「checkout 绑定验证与 marker 写入」、design「Desktop checkout 采先检查、
    //! 后同步的两阶段 IPC」与 Implementation Contract 的「Desktop IPC and UI contract」。
    use super::*;

    const ORIGIN: &str = "https://spec.example.test";
    const PROJECT: &str = "acme";
    const REPO: &str = "desktop";

    fn git_checkout() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("temp checkout");
        std::fs::create_dir(dir.path().join(".git")).expect("git marker");
        dir
    }

    fn write(root: &Path, rel: &str, content: &str) {
        let path = root.join(rel.split('/').collect::<PathBuf>());
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("parent dir");
        }
        std::fs::write(path, content).expect("write file");
    }

    fn write_marker(root: &Path, url: &str, repo: &str) {
        write(root, ".specseal.yaml", &format!("remote:\n  url: {url}\n  repo: {repo}\n"));
    }

    /// 带 built-in 选集、custom descriptor 与未知顶层键的相符 marker。
    fn write_full_marker(root: &Path, builtins: &[&str]) {
        let listed: String = builtins.iter().map(|t| format!("  - {t}\n")).collect();
        write(
            root,
            ".specseal.yaml",
            &format!(
                "tools:\n{listed}  - name: wad-harness\n    skills_dir: .wad/skills\n    instructions_file: WAD.md\nremote:\n  url: {ORIGIN}/api/specseal/v1/projects/{PROJECT}\n  repo: {REPO}\nfuture_top_level: keep me\n"
            ),
        );
    }

    fn exists(root: &Path, rel: &str) -> bool {
        root.join(rel.split('/').collect::<PathBuf>()).exists()
    }

    fn read(root: &Path, rel: &str) -> String {
        std::fs::read_to_string(root.join(rel.split('/').collect::<PathBuf>())).expect("read file")
    }

    /// 目录快照，供「零写入」逐字节比对。
    fn snapshot(root: &Path) -> Vec<(String, Vec<u8>)> {
        fn walk(dir: &Path, prefix: &str, out: &mut Vec<(String, Vec<u8>)>) {
            let mut entries: Vec<_> = std::fs::read_dir(dir).unwrap().flatten().collect();
            entries.sort_by_key(|e| e.file_name());
            for entry in entries {
                let name = entry.file_name().to_string_lossy().to_string();
                let rel = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
                if entry.path().is_dir() {
                    out.push((format!("{rel}/"), Vec::new()));
                    walk(&entry.path(), &rel, out);
                } else {
                    out.push((rel, std::fs::read(entry.path()).unwrap()));
                }
            }
        }
        let mut out = Vec::new();
        walk(root, "", &mut out);
        out
    }

    fn inspect(root: &Path) -> Result<CheckoutInspection, String> {
        inspect_checkout(root, ORIGIN, PROJECT, REPO)
    }

    fn bind(root: &Path, tools: &[&str]) -> Result<String, String> {
        let owned: Vec<String> = tools.iter().map(|t| t.to_string()).collect();
        bind_checkout(root, ORIGIN, PROJECT, REPO, &owned)
    }

    // --- inspect_checkout：零写入的先检查阶段 ---

    #[test]
    fn inspect_matching_marker_reports_root_and_recorded_tools_without_writing() {
        let dir = git_checkout();
        write_full_marker(dir.path(), &["codex"]);
        let before = snapshot(dir.path());

        let seen = inspect(dir.path()).expect("matching origin and repo");

        assert_eq!(seen.root, dir.path().display().to_string());
        assert_eq!(seen.tools, vec!["codex".to_string()], "只回报既有 built-in 选集");
        assert_eq!(snapshot(dir.path()), before, "检查阶段必须零写入");
    }

    #[test]
    fn inspect_mismatched_marker_origin_reports_where_the_marker_points() {
        let dir = git_checkout();
        write_marker(dir.path(), "https://other.example.test/team", REPO);
        let before = snapshot(dir.path());

        let err = inspect(dir.path()).expect_err("origin mismatch");

        assert!(err.contains("https://other.example.test"), "{err}");
        assert!(err.contains(REPO), "{err}");
        assert_eq!(snapshot(dir.path()), before, "拒绝时磁盘不变");
    }

    #[test]
    fn inspect_mismatched_marker_repo_reports_where_the_marker_points() {
        let dir = git_checkout();
        write_marker(dir.path(), ORIGIN, "api");
        let before = snapshot(dir.path());

        let err = inspect(dir.path()).expect_err("repo mismatch");

        assert!(err.contains(ORIGIN), "{err}");
        assert!(err.contains("api"), "{err}");
        assert_eq!(snapshot(dir.path()), before, "拒绝时磁盘不变");
    }

    #[test]
    fn inspect_non_git_directory_without_a_marker_is_rejected() {
        let dir = tempfile::tempdir().expect("plain directory");
        let before = snapshot(dir.path());

        let err = inspect(dir.path()).expect_err("not a git checkout");

        assert!(err.contains("Git"), "{err}");
        assert_eq!(snapshot(dir.path()), before, "拒绝时磁盘不变");
    }

    #[test]
    fn inspect_unparseable_config_is_rejected_fail_closed() {
        let dir = git_checkout();
        write(dir.path(), ".specseal.yaml", "tools: [unclosed\n");
        let before = snapshot(dir.path());

        let err = inspect(dir.path()).expect_err("bad yaml");

        assert!(err.contains(".specseal.yaml"), "错误须指名文件：{err}");
        assert_eq!(snapshot(dir.path()), before, "拒绝时磁盘不变");
    }

    #[test]
    fn inspect_without_a_tools_list_preselects_only_actual_footprints() {
        // marker 缺 tools 清单时只依实际 footprint 预选——不再补 Claude fallback。
        let bare = git_checkout();
        write_marker(bare.path(), ORIGIN, REPO);
        assert!(
            inspect(bare.path()).expect("bare checkout").tools.is_empty(),
            "没有任何 footprint 时不得预选 Claude"
        );

        let codex = git_checkout();
        write_marker(codex.path(), ORIGIN, REPO);
        write(codex.path(), "AGENTS.md", "用户文本\n");
        assert_eq!(
            inspect(codex.path()).expect("codex footprint").tools,
            vec!["codex".to_string()]
        );
    }

    #[test]
    fn inspect_without_a_tools_list_never_preselects_copilot() {
        // spec Scenario「勾选 Copilot 绑定 checkout」：.github/ 的存在不预选 Copilot。
        let dir = git_checkout();
        write_marker(dir.path(), ORIGIN, REPO);
        write(dir.path(), ".github/workflows/ci.yml", "on: push\n");
        write(
            dir.path(),
            ".github/skills/my-skill/SKILL.md",
            "---\nname: my-skill\n---\n",
        );

        assert!(inspect(dir.path())
            .expect("github checkout")
            .tools
            .is_empty());
    }

    #[test]
    fn inspect_reports_a_copilot_only_marker() {
        // spec Scenario「只选 Copilot 的 checkout 直达 remote tab」的判定面：
        // [copilot] 是有效的 built-in 选集。
        let dir = git_checkout();
        write_full_marker(dir.path(), &["copilot"]);

        assert_eq!(
            inspect(dir.path()).expect("copilot marker").tools,
            vec!["copilot"]
        );
    }

    #[test]
    fn bind_claude_and_copilot_generates_both_skill_sets() {
        let dir = git_checkout();
        write(dir.path(), ".github/workflows/ci.yml", "on: push\n");

        bind(dir.path(), &["claude", "copilot"]).expect("new binding");

        assert!(exists(
            dir.path(),
            ".claude/skills/specseal-propose/SKILL.md"
        ));
        assert!(exists(
            dir.path(),
            ".github/skills/specseal-propose/SKILL.md"
        ));
        for absent in [".github/copilot-instructions.md", "AGENTS.md", "CLAUDE.md"] {
            assert!(!exists(dir.path(), absent), "{absent} 不得生成");
        }
        assert_eq!(read(dir.path(), ".github/workflows/ci.yml"), "on: push\n");
        assert_eq!(
            inspect(dir.path()).expect("re-inspect").tools,
            vec!["claude", "copilot"]
        );
    }

    #[test]
    fn inspect_reports_a_pi_only_marker() {
        // spec Scenario「只选 Pi 的 checkout 直达 remote tab」的判定面：
        // [pi] 是有效的 built-in 选集。
        let dir = git_checkout();
        write_full_marker(dir.path(), &["pi"]);

        assert_eq!(inspect(dir.path()).expect("pi marker").tools, vec!["pi"]);
    }

    #[test]
    fn inspect_without_a_tools_list_never_preselects_pi_or_cursor() {
        // spec「checkout 绑定验证与 marker 写入」：`.pi/`、`.cursor/` 的存在不预选 Pi、Cursor。
        let dir = git_checkout();
        write_marker(dir.path(), ORIGIN, REPO);
        write(dir.path(), ".cursor/rules/style.mdc", "---\nalwaysApply: true\n---\n");
        write(dir.path(), ".pi/settings.json", "{}\n");
        // 两个工具的 skills 目录本身存在（放着用户自己的技能）也不预选。
        for skills in [".cursor/skills", ".pi/skills"] {
            write(dir.path(), &format!("{skills}/my-skill/SKILL.md"), "---\nname: my-skill\n---\n");
        }

        assert!(inspect(dir.path()).expect("cursor checkout").tools.is_empty());
    }

    #[test]
    fn bind_claude_and_cursor_generates_both_skill_sets() {
        // spec Scenario「勾选 Cursor 绑定 checkout」。
        let dir = git_checkout();
        write(dir.path(), ".cursor/rules/style.mdc", "---\nalwaysApply: true\n---\n");

        bind(dir.path(), &["claude", "cursor"]).expect("new binding");

        for skill in [
            ".claude/skills/specseal-propose/SKILL.md",
            ".cursor/skills/specseal-propose/SKILL.md",
        ] {
            assert!(exists(dir.path(), skill), "{skill} 须生成");
        }
        for absent in [".cursor/agents", "AGENTS.md", "CLAUDE.md"] {
            assert!(!exists(dir.path(), absent), "{absent} 不得生成");
        }
        assert_eq!(
            read(dir.path(), ".cursor/rules/style.mdc"),
            "---\nalwaysApply: true\n---\n"
        );
        assert_eq!(
            inspect(dir.path()).expect("re-inspect").tools,
            vec!["claude", "cursor"]
        );
    }

    #[test]
    fn inspect_with_a_descriptor_only_tools_list_falls_back_to_footprints() {
        // 清单存在但没有任何可解析的内置名：与缺清单同样只依实际 footprint 预选。
        let dir = git_checkout();
        write_full_marker(dir.path(), &[]);
        write(dir.path(), "AGENTS.md", "用户文本\n");

        assert_eq!(
            inspect(dir.path()).expect("descriptor-only list").tools,
            vec!["codex".to_string()]
        );
    }

    #[test]
    fn inspect_reports_only_builtins_from_a_mixed_tools_list() {
        let dir = git_checkout();
        write_full_marker(dir.path(), &["codex"]);

        let seen = inspect(dir.path()).expect("mixed tools list");

        assert_eq!(seen.tools, vec!["codex".to_string()], "自订描述子不进入 picker");
    }

    // --- bind_checkout：提交阶段 ---

    #[test]
    fn bind_rejects_an_empty_tool_selection_without_writing() {
        let dir = git_checkout();
        let before = snapshot(dir.path());

        let err = bind(dir.path(), &[]).expect_err("空选集必须被拒");

        // `pi` 是 `copilot` 的子字符串：比对完整清单，逐名比对测不到漏列。
        assert!(err.contains("claude、codex、copilot、pi、cursor"), "must list the five tools: {err}");
        assert_eq!(snapshot(dir.path()), before, "拒绝时磁盘不变");
    }

    #[test]
    fn bind_rejects_an_unknown_tool_name_without_writing() {
        let dir = git_checkout();
        let before = snapshot(dir.path());

        let err = bind(dir.path(), &["claude", "vscode"]).expect_err("未知工具必须被拒");

        assert!(err.contains("vscode"), "须指出违规名称：{err}");
        assert_eq!(snapshot(dir.path()), before, "拒绝时磁盘不变");
    }

    #[test]
    fn bind_markerless_git_checkout_writes_cli_compatible_marker_and_syncs_tools() {
        let dir = git_checkout();

        let bound = bind(dir.path(), &["claude", "codex"]).expect("new binding");
        assert_eq!(bound, dir.path().display().to_string());

        let workspace = specseal_core::workspace::Workspace::discover(dir.path())
            .expect("CLI discovery succeeds")
            .expect("marker creates workspace");
        let resolution = workspace
            .resolve_mode_with(None)
            .expect("CLI mode resolution succeeds");
        match resolution.mode {
            specseal_core::workspace::StoreMode::Remote(remote) => {
                assert_eq!(
                    remote.url,
                    format!("{ORIGIN}/api/specseal/v1/projects/{PROJECT}")
                );
                assert_eq!(remote.repo.as_deref(), Some(REPO));
            }
            specseal_core::workspace::StoreMode::Fs => panic!("written marker must select remote"),
        }
        for (md, skill) in [
            ("CLAUDE.md", ".claude/skills/specseal-propose/SKILL.md"),
            ("AGENTS.md", ".agents/skills/specseal-propose/SKILL.md"),
        ] {
            // 指令档已退出受管（change: remove-marker-injection）：只生成技能档。
            assert!(!exists(dir.path(), md), "{md} 不得生成");
            assert!(exists(dir.path(), skill), "{skill} 应生成");
        }
        assert!(!exists(dir.path(), "openspec"), "Remote checkout 不建本机规格树");
        assert_eq!(inspect(dir.path()).expect("re-inspect").tools, vec!["claude", "codex"]);
    }

    #[test]
    fn bind_existing_matching_marker_backfills_missing_artifacts() {
        let dir = git_checkout();
        write_full_marker(dir.path(), &["codex"]);
        write(dir.path(), "AGENTS.md", "只剩用户文本\n");

        bind(dir.path(), &["codex"]).expect("既有相符 marker 仍须同步");

        let agents = read(dir.path(), "AGENTS.md");
        assert_eq!(agents, "只剩用户文本\n", "指令档须比特级不变:\n{agents}");
        assert!(exists(dir.path(), ".agents/skills/specseal-propose/SKILL.md"));
        let config = read(dir.path(), ".specseal.yaml");
        assert!(config.contains(&format!("projects/{PROJECT}")), "remote 值不变:\n{config}");
        assert!(config.contains("keep me"), "未知顶层键须保留:\n{config}");
        assert!(!exists(dir.path(), "openspec"));
    }

    #[test]
    fn bind_switches_claude_to_codex_preserving_user_text_and_descriptors() {
        let dir = git_checkout();
        write_full_marker(dir.path(), &["claude"]);
        write(dir.path(), "CLAUDE.md", "用户写的段落\n");
        bind(dir.path(), &["claude"]).expect("先收敛到 claude");
        assert!(exists(dir.path(), ".claude/skills/specseal-propose/SKILL.md"), "precondition");

        bind(dir.path(), &["codex"]).expect("切换为 codex");

        assert_eq!(inspect(dir.path()).expect("re-inspect").tools, vec!["codex"]);
        let claude_md = read(dir.path(), "CLAUDE.md");
        assert!(!claude_md.contains("<!-- SPECSEAL:START"), "Claude 区块须移除:\n{claude_md}");
        assert!(claude_md.contains("用户写的段落"), "用户文本须保留:\n{claude_md}");
        assert!(!exists(dir.path(), ".claude/skills/specseal-propose/SKILL.md"));
        assert!(exists(dir.path(), ".agents/skills/specseal-propose/SKILL.md"));
        let config = read(dir.path(), ".specseal.yaml");
        assert!(config.contains("wad-harness"), "custom descriptor 须保留:\n{config}");
        assert!(!exists(dir.path(), "openspec"));
    }

    #[test]
    fn bind_failure_returns_no_root_and_leaves_the_folder_untouched() {
        let dir = tempfile::tempdir().expect("plain directory");
        let before = snapshot(dir.path());

        let err = bind(dir.path(), &["claude"]).expect_err("not a git checkout");

        assert!(err.contains("Git"), "{err}");
        assert_eq!(snapshot(dir.path()), before, "失败不得留下任何写入");
    }

    // --- 3.3 AUDIT：sharp-edges 负向锁定（无 silent success、无危险缺省） ---

    /// Lazy Developer：纯空白的工具值不是「有效选集」——收敛为空并被拒，零写入。
    #[test]
    fn bind_whitespace_only_tools_collapse_to_empty_and_are_rejected() {
        let dir = git_checkout();
        let before = snapshot(dir.path());

        let err = bind(dir.path(), &[" ", ""]).expect_err("纯空白视为空选集");

        assert!(err.contains("claude") && err.contains("codex"), "{err}");
        assert_eq!(snapshot(dir.path()), before, "拒绝时磁盘不变");
    }

    /// Confused／Scoundrel：重复工具名去重，不写出重复的 tools 条目。
    #[test]
    fn bind_duplicate_tool_names_do_not_duplicate_markers_or_entries() {
        let dir = git_checkout();

        bind(dir.path(), &["codex", "codex", "codex"]).expect("重复名须被吸收");

        assert_eq!(inspect(dir.path()).expect("re-inspect").tools, vec!["codex"]);
        assert!(!exists(dir.path(), "AGENTS.md"), "指令档不得生成");
        let config = read(dir.path(), ".specseal.yaml");
        assert_eq!(config.matches("- codex").count(), 1, "tools 条目不得重复:\n{config}");
    }

    /// Scoundrel：marker 不一致时 bind 必须在任何 reconciliation／marker 写入之前 fail loud，
    /// 既有的 Specseal 受管产物与自订描述子逐字节不动。
    #[test]
    fn bind_mismatched_marker_fails_loud_without_reconciling() {
        let dir = git_checkout();
        write_marker(dir.path(), "https://other.example.test", REPO);
        write(dir.path(), "CLAUDE.md", "用户段落\n");
        let before = snapshot(dir.path());

        let err = bind(dir.path(), &["claude", "codex"]).expect_err("origin 不符必须被拒");

        assert!(err.contains("https://other.example.test"), "{err}");
        assert!(!exists(dir.path(), ".claude/skills/specseal-propose/SKILL.md"), "不得生成");
        assert!(!exists(dir.path(), ".agents"), "不得生成");
        assert_eq!(snapshot(dir.path()), before, "拒绝时磁盘逐字节不变");
    }

    /// 可交换字符串语意：marker 相符时 `project` 参数不参与验证（只在写新 marker 时使用），
    /// 因此传入任意 project 仍成功——锁住「别把 project 误当一致性检查的一部分」。
    #[test]
    fn bind_ignores_project_when_an_existing_marker_matches() {
        let dir = git_checkout();
        write_full_marker(dir.path(), &["codex"]);

        let owned = vec!["codex".to_string()];
        let bound = bind_checkout(dir.path(), ORIGIN, "a-totally-different-project", REPO, &owned)
            .expect("marker 相符时 project 不影响验证");

        assert_eq!(bound, dir.path().display().to_string());
        // remote 值仍是 marker 原本的 project，未被传入的 project 覆写。
        let config = read(dir.path(), ".specseal.yaml");
        assert!(config.contains(&format!("projects/{PROJECT}")), "remote 值不变:\n{config}");
        assert!(!config.contains("a-totally-different-project"), "不得改写 remote:\n{config}");
    }

    /// 最简调用也不得跳过 custom descriptor 保留——单一工具 bind 后描述子仍在。
    #[test]
    fn bind_preserves_custom_descriptor_on_the_simplest_call() {
        let dir = git_checkout();
        write_full_marker(dir.path(), &["codex"]);

        bind(dir.path(), &["codex"]).expect("最简 bind");

        let config = read(dir.path(), ".specseal.yaml");
        assert!(config.contains("wad-harness"), "custom descriptor 须保留:\n{config}");
        assert!(config.contains(".wad/skills"), "descriptor 字段须保留:\n{config}");
    }

    // --- 6.1 跨入口一致性（spec「Remote Workspace bootstrap 跨入口一致性」） ---

    /// Desktop bind 与 CLI Remote init（`specseal_core::init::init_remote`——CLI
    /// `cmd_init_remote` 调用的正是它）对等价的新 Git checkout 选取相同 Codex，
    /// SHALL 产生同构的 built-in tools、Remote marker 与 Skills，两者皆不建 `openspec/`
    /// 也不建任何指令档。此测试把「一致性」钉在共用 Core 上。
    #[test]
    fn desktop_bind_and_cli_remote_init_produce_isomorphic_artifacts() {
        use specseal_core::skills::Tool;

        // 两入口收敛到相同的最终 project URL，remote section 才可能同构。
        let project_url = format!("{ORIGIN}/api/specseal/v1/projects/{PROJECT}");

        let desktop = git_checkout();
        bind(desktop.path(), &["codex"]).expect("Desktop bind");

        let cli = git_checkout();
        specseal_core::init::init_remote(cli.path(), &[Tool::Codex], false, &project_url, Some(REPO))
            .expect("CLI Remote init");

        // 两入口都不生成指令档。
        assert!(!exists(desktop.path(), "AGENTS.md"), "Desktop bind 不得生成指令档");
        assert!(!exists(cli.path(), "AGENTS.md"), "CLI Remote init 不得生成指令档");
        // Skills 正典逐字节同构。
        for skill in ["specseal-apply", "specseal-archive", "specseal-propose"] {
            let rel = format!(".agents/skills/{skill}/SKILL.md");
            assert_eq!(read(desktop.path(), &rel), read(cli.path(), &rel), "{rel} 须同构");
        }
        // built-in tools 选集同构。
        assert_eq!(inspect(desktop.path()).unwrap().tools, vec!["codex"]);
        assert_eq!(
            preselected_tools(cli.path()),
            vec!["codex".to_string()],
            "CLI init 的 tools 同构"
        );
        // 两者都不建本机规格树。
        assert!(!exists(desktop.path(), "openspec"));
        assert!(!exists(cli.path(), "openspec"));
    }

    /// 重试幂等：相同选集再次 bind SHALL 收敛到逐字节相同的受管产物，不重复 marker。
    #[test]
    fn bind_retry_with_the_same_selection_is_byte_identical() {
        let dir = git_checkout();
        bind(dir.path(), &["codex"]).expect("first bind");
        let after_first = snapshot(dir.path());

        bind(dir.path(), &["codex"]).expect("retry bind");

        assert_eq!(snapshot(dir.path()), after_first, "相同选集重试须幂等");
    }
}
