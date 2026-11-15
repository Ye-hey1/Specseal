//! remote 集成测试共用 harness：in-process specseal-server（memory identity＋
//! memory store）＋registry 档。用户为 demo／multi 两项目成员（multi 供
//! 多 repo 多义案例）；credential 注入一律 in-memory store。

#![allow(dead_code)]

use chrono::{Duration, Utc};
use specseal_server::audit::AuditActor;
use specseal_server::config::{IdentityConfig, ServerConfig, StoreConfig};
use specseal_server::events::{EventHub, EventSettings};
use specseal_server::identity::{IdentitySqlite, IdentityStore, MembershipRole, NewInvitation};
use specseal_server::state::{AppState, SharedStore};
use specseal_store::{CommandContext, DocumentId, ProjectId, RepoId, Scope, TeamStore};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::{Arc, Mutex, MutexGuard, Once};

/// harness 用户的显示名。server 依 `Actor` 契约把它与 email 组成引擎面的
/// 身分字符串，盖章比对看的是 [`ACTOR_IDENTITY`] 而不是这一个。
pub const DISPLAY: &str = "Dev";

/// harness 用户在引擎面的身分字符串：「显示名 <email>」。created_by、
/// started_by、claimed_by 等盖章都写这个值。
pub const ACTOR_IDENTITY: &str = "Dev <dev@example.com>";

/// 同一 test binary 内的 harness 互斥。多个 in-process loopback server 并行
/// 且 CPU 吃紧时，macOS 内核偶发把回应中的连接整条重置——客端读到一半收
/// EINVAL，动词已在 server 提交却回报「server unreachable」（本机以 8 条
/// 忙循环压测可稳定重现；单 harness 串行跑同等压力下不出现）。以 harness
/// 生命周期互斥将 loopback server 串行化即根除触发条件；测试内部的并发
/// （多 session、proxy、worker）不受影响。
static HARNESS_GATE: Mutex<()> = Mutex::new(());

fn acquire_harness_gate() -> MutexGuard<'static, ()> {
    // 前一个测试 panic 只代表该测试失败，poison 不该连坐后续测试。
    HARNESS_GATE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub struct Harness {
    pub origin: String,
    pub identity: Arc<IdentitySqlite>,
    pub user_id: String,
    pub store: SharedStore,
    pub registry: PathBuf,
    pub server: RestartableServer,
    _dir: tempfile::TempDir,
    /// 最后声明：server 完整收束后才释放互斥。
    _gate: MutexGuard<'static, ()>,
}

pub struct RestartableServer {
    addr: std::net::SocketAddr,
    state: AppState,
    running: std::sync::Mutex<
        Option<(
            tokio::sync::oneshot::Sender<()>,
            std::thread::JoinHandle<()>,
        )>,
    >,
}

impl RestartableServer {
    fn from_listener(listener: std::net::TcpListener, state: AppState) -> RestartableServer {
        let addr = listener.local_addr().expect("local addr");
        let server = RestartableServer {
            addr,
            state,
            running: std::sync::Mutex::new(None),
        };
        server.spawn(listener);
        server
    }

    fn spawn(&self, listener: std::net::TcpListener) {
        listener.set_nonblocking(true).expect("nonblocking");
        let state = self.state.clone();
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
        let thread = std::thread::spawn(move || {
            let runtime = tokio::runtime::Runtime::new().expect("runtime");
            runtime.block_on(async move {
                let listener = tokio::net::TcpListener::from_std(listener).expect("adopt listener");
                let server = axum::serve(listener, specseal_server::app::router(state));
                tokio::select! {
                    result = server => result.expect("serve"),
                    _ = shutdown_rx => {}
                }
            });
        });
        *self.running.lock().expect("server lock") = Some((shutdown_tx, thread));
    }

    pub fn stop(&self) {
        let Some((shutdown, thread)) = self.running.lock().expect("server lock").take() else {
            return;
        };
        let _ = shutdown.send(());
        thread.join().expect("server stops");
    }

    pub fn start(&self) {
        if self.running.lock().expect("server lock").is_some() {
            return;
        }
        let listener = std::net::TcpListener::bind(self.addr).expect("rebind loopback");
        self.spawn(listener);
    }
}

impl Drop for RestartableServer {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Phase 3 全链剧本的两个常驻 server。各自持有独立 SQLite store、identity
/// database 与随机 loopback port；第一个 server 有 `pm`／`rd` 两个 scope，
/// 第二个 server 有 `main` scope。
pub struct Phase3Harness {
    pub first: Phase3Server,
    pub second: Phase3Server,
    /// 最后声明：两台 server 都收束后才释放互斥。
    _gate: MutexGuard<'static, ()>,
}

impl Phase3Harness {
    pub fn write_failure_artifacts(
        &self,
        dir: &Path,
        connection_states: &[(&str, &str)],
    ) -> std::io::Result<()> {
        std::fs::create_dir_all(dir)?;
        std::fs::write(
            dir.join("first-server.log"),
            self.first.output_tail(usize::MAX).join("\n"),
        )?;
        std::fs::write(
            dir.join("second-server.log"),
            self.second.output_tail(usize::MAX).join("\n"),
        )?;
        let states = connection_states
            .iter()
            .map(|(connection, state)| format!("{connection}={state}"))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(dir.join("connection-states.log"), states)
    }

    pub fn failure_report(
        &self,
        scenario: &str,
        connection_states: &[(&str, &str)],
        detail: &str,
    ) -> String {
        fn render_tail(lines: Vec<String>) -> String {
            if lines.is_empty() {
                "(no captured output)".to_string()
            } else {
                lines.join("\n")
            }
        }

        let states = connection_states
            .iter()
            .map(|(connection, state)| format!("{connection}={state}"))
            .collect::<Vec<_>>()
            .join("\n");
        let artifact_error = std::env::var_os("PHASE3_E2E_ARTIFACT_DIR").and_then(|dir| {
            self.write_failure_artifacts(Path::new(&dir), connection_states)
                .err()
                .map(|error| format!("\n--- artifact write error ---\n{error}"))
        });
        format!(
            "[{scenario}] {detail}\n\
             --- first server output tail ---\n{}\n\
             --- second server output tail ---\n{}\n\
             --- connection states ---\n{}{}",
            render_tail(self.first.output_tail(20)),
            render_tail(self.second.output_tail(20)),
            if states.is_empty() {
                "(no connection states)"
            } else {
                &states
            },
            artifact_error.unwrap_or_default()
        )
    }
}

#[allow(unused_macros)]
macro_rules! scenario_assert {
    ($harness:expr, $scenario:expr, $states:expr, $condition:expr, $detail:expr $(,)?) => {{
        if !$condition {
            panic!("{}", $harness.failure_report($scenario, $states, $detail));
        }
    }};
}

#[allow(unused_imports)]
pub(crate) use scenario_assert;

pub struct Phase3Server {
    pub label: String,
    pub project: String,
    pub origin: String,
    pub identity: Arc<IdentitySqlite>,
    pub editor_id: String,
    pub reader_id: String,
    pub editor_pat: String,
    pub reader_pat: String,
    pub store: SharedStore,
    pub store_path: PathBuf,
    pub registry: PathBuf,
    diagnostics: Arc<Mutex<Vec<String>>>,
    server: RestartableServer,
    _dir: tempfile::TempDir,
}

impl Phase3Server {
    fn new(label: &str, project: &str, repos: &[&str]) -> Phase3Server {
        let dir = tempfile::tempdir().expect("phase3 server tempdir");
        let store_path = dir.path().join("store.db");
        let identity_path = dir.path().join("identity.db");
        let identity = Arc::new(IdentitySqlite::open(&identity_path).expect("phase3 identity"));
        identity
            .create_project(project, &format!("{label} Project"))
            .expect("seed phase3 project");
        for repo in repos {
            identity
                .create_repo(project, repo, &repo.to_ascii_uppercase())
                .expect("seed phase3 repo");
        }

        let editor_id = seed_phase3_user(&identity, label, project, "editor");
        let reader_id = seed_phase3_user(&identity, label, project, "reader");
        identity
            .admin_set_membership(
                &AuditActor::system_cli(),
                &reader_id,
                project,
                MembershipRole::Reader,
                true,
            )
            .expect("make phase3 reader membership read-only");
        let (_, editor_pat) = identity
            .create_pat(&editor_id, "phase3-editor", None)
            .expect("phase3 editor PAT");
        let (_, reader_pat) = identity
            .create_pat(&reader_id, "phase3-reader", None)
            .expect("phase3 reader PAT");

        let store = specseal_server::build_store(&StoreConfig::Sqlite {
            path: store_path.clone(),
        })
        .expect("phase3 sqlite store");
        let settings = fast_events();
        let events = EventHub::new(store.clone(), settings.clone());
        let state = AppState::new(
            store.clone(),
            identity.clone(),
            Arc::new(ServerConfig {
                store: StoreConfig::Sqlite {
                    path: store_path.clone(),
                },
                identity: IdentityConfig::Sqlite {
                    path: identity_path,
                },
                public_url: "http://127.0.0.1".to_string(),
                events: settings,
            }),
            events,
        );
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("phase3 loopback");
        let addr = listener.local_addr().expect("phase3 local addr");
        let server = RestartableServer::from_listener(listener, state);
        let origin = format!("http://{addr}");
        let registry = dir.path().join("connections.json");
        let mut entries = Vec::new();
        specseal_desktop_lib::connections::upsert_connection(&mut entries, &origin, label)
            .expect("seed phase3 connection");
        specseal_desktop_lib::connections::write_registry(&registry, &entries)
            .expect("write phase3 registry");
        let diagnostics = Arc::new(Mutex::new(vec![format!(
            "{label}: started at http://{addr} (sqlite {})",
            store_path.display()
        )]));
        let result = Phase3Server {
            label: label.to_string(),
            project: project.to_string(),
            origin,
            identity,
            editor_id,
            reader_id,
            editor_pat,
            reader_pat,
            store,
            store_path,
            registry,
            diagnostics,
            server,
            _dir: dir,
        };
        result.wait_ready();
        result
    }

    pub fn project_url(&self) -> String {
        format!("{}/api/specseal/v1/projects/{}", self.origin, self.project)
    }

    pub fn scope(&self, repo: &str) -> Scope {
        Scope::new(ProjectId::new(&self.project), RepoId::new(repo))
    }

    pub fn seed_change(&self, repo: &str, change: &str, tasks: &str) {
        let mut uow = self
            .store
            .begin_unit_of_work(
                &self.scope(repo),
                CommandContext {
                    command: "phase3-seed".into(),
                    actor: "phase3-seed".into(),
                },
            )
            .expect("begin phase3 seed");
        uow.create(
            DocumentId::ChangeMeta {
                change: change.into(),
            },
            "schema: spec-driven\n",
        );
        uow.create(
            DocumentId::ChangeArtifact {
                change: change.into(),
                artifact: "tasks.md".into(),
            },
            tasks,
        );
        self.store
            .commit(uow, Vec::new())
            .expect("commit phase3 seed");
        self.record(format!("seeded {}/{repo}/{change}", self.project));
    }

    pub fn remote_checkout(&self, repo: &str, token: &str, tag: &str) -> RemoteCheckout {
        RemoteCheckout::new(
            &self.project_url(),
            repo,
            token,
            tag,
            Arc::clone(&self.diagnostics),
        )
    }

    pub fn device_login_editor(
        &self,
        store: &dyn specseal_remote::credentials::CredentialStore,
    ) -> String {
        let identity = self.identity.clone();
        let user_id = self.editor_id.clone();
        let opener = move |url: &str| {
            let code = url
                .split("user_code=")
                .nth(1)
                .expect("phase3 user_code parameter")
                .to_string();
            assert!(identity.approve_device(&code, &user_id).expect("approve"));
            Ok(())
        };
        let access_token = approved_device_login(&self.origin, store, &self.registry, &opener)
            .expect("phase3 device login");
        self.record("editor device login approved".to_string());
        access_token
    }

    pub fn revoke_editor_device_family(&self) {
        let family = self
            .identity
            .list_device_families(&self.editor_id)
            .expect("list phase3 device families")
            .into_iter()
            .find(|family| family.revoked_at.is_none())
            .expect("live phase3 device family");
        self.identity
            .revoke_family(&self.editor_id, &family.id)
            .expect("revoke phase3 device family");
        self.record(format!("revoked device family {}", family.id));
    }

    pub fn stop(&self) {
        self.server.stop();
        self.record("stopped".to_string());
    }

    pub fn start(&self) {
        self.server.start();
        self.wait_ready();
        self.record("restarted".to_string());
    }

    pub fn is_ready(&self) -> bool {
        self.origin
            .trim_start_matches("http://")
            .parse::<std::net::SocketAddr>()
            .ok()
            .and_then(|addr| {
                std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(100))
                    .ok()
            })
            .is_some()
    }

    pub fn output_tail(&self, limit: usize) -> Vec<String> {
        let output = self.diagnostics.lock().expect("phase3 diagnostic lock");
        output[output.len().saturating_sub(limit)..].to_vec()
    }

    fn wait_ready(&self) {
        for _ in 0..100 {
            if self.is_ready() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        panic!(
            "{} server did not become ready at {}",
            self.label, self.origin
        );
    }

    fn record(&self, line: String) {
        self.diagnostics
            .lock()
            .expect("phase3 diagnostic lock")
            .push(format!("{}: {line}", self.label));
    }
}

pub struct RemoteCheckout {
    dir: tempfile::TempDir,
    root: PathBuf,
    token: String,
    diagnostics: Arc<Mutex<Vec<String>>>,
}

impl RemoteCheckout {
    fn new(
        project_url: &str,
        repo: &str,
        token: &str,
        tag: &str,
        diagnostics: Arc<Mutex<Vec<String>>>,
    ) -> RemoteCheckout {
        let dir = tempfile::Builder::new()
            .prefix(&format!("specseal-phase3-{tag}-"))
            .tempdir()
            .expect("phase3 checkout tempdir");
        let root = dir.path().join("checkout");
        std::fs::create_dir_all(&root).expect("create phase3 checkout");
        std::fs::write(
            root.join(".specseal.yaml"),
            format!("remote:\n  url: {project_url}\n  repo: {repo}\n"),
        )
        .expect("write phase3 remote config");
        RemoteCheckout {
            dir,
            root,
            token: token.to_string(),
            diagnostics,
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn write_git_marker(&self, name: &str, content: &str) {
        std::fs::write(self.root.join(name), content).expect("write phase3 checkout marker");
        for args in [
            vec!["init", "-q"],
            vec!["add", "."],
            vec![
                "-c",
                "user.name=Phase3",
                "-c",
                "user.email=phase3@example.com",
                "commit",
                "-q",
                "-m",
                "phase3 marker",
            ],
        ] {
            let output = Command::new("git")
                .args(&args)
                .current_dir(&self.root)
                .output()
                .expect("run git for phase3 checkout");
            assert!(
                output.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        self.diagnostics
            .lock()
            .expect("phase3 diagnostic lock")
            .push(format!("checkout marker committed: {name}"));
    }

    pub fn run(&self, args: &[&str]) -> Output {
        let output = Command::new(phase3_cli_bin())
            .args(args)
            .current_dir(&self.root)
            .env_remove("SPECSEAL_STORE_URL")
            .env_remove("SPECSEAL_LOCALE")
            .env_remove("SPECSEAL_SPEC_LOCALE")
            .env_remove("SPECSEAL_TDD")
            .env_remove("SPECSEAL_AUDIT")
            .env("SPECSEAL_TOKEN", &self.token)
            .env("HOME", self.dir.path())
            .env("USERPROFILE", self.dir.path())
            .env("XDG_CONFIG_HOME", self.dir.path())
            .output()
            .expect("run phase3 CLI");
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        self.diagnostics
            .lock()
            .expect("phase3 diagnostic lock")
            .push(format!(
                "cli {:?}: status={} stdout={stdout:?} stderr={stderr:?}",
                args, output.status
            ));
        output
    }

    pub fn run_stdin(&self, args: &[&str], content: &str) -> Output {
        let mut child = Command::new(phase3_cli_bin())
            .args(args)
            .current_dir(&self.root)
            .env_remove("SPECSEAL_STORE_URL")
            .env_remove("SPECSEAL_LOCALE")
            .env_remove("SPECSEAL_SPEC_LOCALE")
            .env_remove("SPECSEAL_TDD")
            .env_remove("SPECSEAL_AUDIT")
            .env("SPECSEAL_TOKEN", &self.token)
            .env("HOME", self.dir.path())
            .env("USERPROFILE", self.dir.path())
            .env("XDG_CONFIG_HOME", self.dir.path())
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn phase3 CLI with stdin");
        child
            .stdin
            .as_mut()
            .expect("phase3 CLI stdin")
            .write_all(content.as_bytes())
            .expect("write phase3 CLI stdin");
        drop(child.stdin.take());
        let output = child.wait_with_output().expect("wait phase3 CLI");
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        self.diagnostics
            .lock()
            .expect("phase3 diagnostic lock")
            .push(format!(
                "cli {:?} with stdin: status={} stdout={stdout:?} stderr={stderr:?}",
                args, output.status
            ));
        output
    }
}

pub fn phase3_harness() -> Phase3Harness {
    let gate = acquire_harness_gate();
    Phase3Harness {
        first: Phase3Server::new("first", "alpha", &["pm", "rd"]),
        second: Phase3Server::new("second", "beta", &["main"]),
        _gate: gate,
    }
}

fn seed_phase3_user(
    identity: &Arc<IdentitySqlite>,
    label: &str,
    project: &str,
    kind: &str,
) -> String {
    let invite = identity
        .create_invitation(NewInvitation {
            email: format!("{kind}-{label}@example.com"),
            display: format!("Phase3 {kind} {label}"),
            memberships: vec![project.to_string()],
            admin: false,
            expires_at: Utc::now() + Duration::days(1),
        })
        .expect("phase3 invite");
    identity
        .accept_invitation(&invite, "phase3-correct-horse")
        .expect("accept phase3 invitation")
}

static BUILD_PHASE3_CLI: Once = Once::new();

fn phase3_cli_bin() -> PathBuf {
    BUILD_PHASE3_CLI.call_once(|| {
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_string());
        let status = Command::new(cargo)
            .args(["build", "-p", "specseal-cli", "--bin", "specseal"])
            .status()
            .expect("spawn cargo build for phase3 CLI");
        assert!(status.success(), "building the phase3 CLI failed");
    });
    // 测试运行档在输出文件夹底下第几层，随 cargo 版本而变（1.100 起从 deps/ 改到
    // build/<套件>/<哈希>/out/）：往上找第一个放有 CLI 的文件夹，不写死层数。
    let name = if cfg!(windows) {
        "specseal.exe"
    } else {
        "specseal"
    };
    let test_bin = std::env::current_exe().expect("phase3 test executable");
    test_bin
        .ancestors()
        .skip(1)
        .map(|dir| dir.join(name))
        .find(|bin| bin.is_file())
        .expect("the built phase3 CLI above the test executable")
}

/// demo project 的 scope（repo backend）。
pub fn scope() -> Scope {
    Scope::new(ProjectId::new("demo"), RepoId::new("backend"))
}

/// 事件测试用的快节奏设置：短心跳、充足 live buffer。
pub fn fast_events() -> EventSettings {
    EventSettings {
        retention: 1024,
        buffer: 64,
        heartbeat: std::time::Duration::from_millis(100),
    }
}

/// 起 in-process server：demo（repo backend）＋multi（repos web、api）入
/// registry，用户为两者成员。store 空白——各测试自行 seed。
pub fn harness() -> Harness {
    harness_with_events(EventSettings::default())
}

/// 同 [`harness`]，但以指定的 EventSettings 起 server（SSE／retention 测试用）。
pub fn harness_with_events(settings: EventSettings) -> Harness {
    let gate = acquire_harness_gate();
    let identity = Arc::new(IdentitySqlite::open_memory().expect("memory identity"));
    identity
        .create_project("demo", "Demo")
        .expect("seed demo project");
    identity
        .create_repo("demo", "backend", "backend")
        .expect("seed demo repo");
    identity
        .create_project("multi", "Multi")
        .expect("seed multi project");
    identity
        .create_repo("multi", "web", "web")
        .expect("seed multi web repo");
    identity
        .create_repo("multi", "api", "api")
        .expect("seed multi api repo");
    let invite = identity
        .create_invitation(NewInvitation {
            email: "dev@example.com".to_string(),
            display: DISPLAY.to_string(),
            memberships: vec!["demo".to_string(), "multi".to_string()],
            admin: false,
            expires_at: Utc::now() + Duration::days(1),
        })
        .expect("invite");
    let user_id = identity
        .accept_invitation(&invite, "pw-correct-horse")
        .expect("accept");

    let store: SharedStore = Arc::new(specseal_store::memory::MemoryStore::new());
    let state = AppState::new(
        store.clone(),
        identity.clone(),
        Arc::new(ServerConfig {
            store: StoreConfig::Memory,
            identity: IdentityConfig::Memory,
            public_url: "http://127.0.0.1".to_string(),
            events: EventSettings::default(),
        }),
        EventHub::new(store.clone(), settings),
    );

    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let addr = listener.local_addr().expect("local addr");
    let server = RestartableServer::from_listener(listener, state);

    let dir = tempfile::tempdir().expect("tempdir");
    let registry = dir.path().join("connections.json");
    let origin = format!("http://{addr}");
    let mut entries = Vec::new();
    specseal_desktop_lib::connections::upsert_connection(&mut entries, &origin, "本地")
        .expect("seed entry");
    specseal_desktop_lib::connections::write_registry(&registry, &entries).expect("write registry");

    Harness {
        origin,
        identity,
        user_id,
        store,
        registry,
        server,
        _dir: dir,
        _gate: gate,
    }
}

/// 种 change `demo`（schema＋给定的 tasks.md 内容）进 demo/backend scope。
pub fn seed_change(store: &dyn TeamStore, tasks: &str) {
    seed_named_change(store, "demo", tasks);
}

/// 在 demo/backend scope 种指定名称的 change，供重启期间外部写入情境使用。
pub fn seed_named_change(store: &dyn TeamStore, change: &str, tasks: &str) {
    let mut uow = store
        .begin_unit_of_work(
            &scope(),
            CommandContext {
                command: "seed".into(),
                actor: "seed".into(),
            },
        )
        .expect("begin uow");
    uow.create(
        DocumentId::ChangeMeta {
            change: change.into(),
        },
        "schema: spec-driven\n",
    );
    uow.create(
        DocumentId::ChangeArtifact {
            change: change.into(),
            artifact: "tasks.md".into(),
        },
        tasks,
    );
    store.commit(uow, Vec::new()).expect("seed commit");
}

/// 以 device flow（假浏览器直接核准）登录，让 credential store 只留下 refresh
/// credential——登录会连 access token 一起缓存，这里把缓存清掉，仿真「重启后
/// 缓存已过期」：下一个请求要靠 refresh credential 换发。
pub fn device_login_approved(
    h: &Harness,
    store: &dyn specseal_remote::credentials::CredentialStore,
) {
    let identity = h.identity.clone();
    let user_id = h.user_id.clone();
    let opener = move |url: &str| {
        let code = url
            .split("user_code=")
            .nth(1)
            .expect("user_code 预填参数")
            .to_string();
        assert!(identity.approve_device(&code, &user_id).expect("approve"));
        Ok(())
    };
    approved_device_login(&h.origin, store, &h.registry, &opener).expect("device login");
    specseal_remote::refresh::clear_cached_bearer(&h.origin, store);
}

/// 走完一次 device login（假打开器就地核准，等待循环在 Rust 这一份）。回传
/// 登录当下缓存的 access token。
fn approved_device_login(
    origin: &str,
    store: &dyn specseal_remote::credentials::CredentialStore,
    registry: &std::path::Path,
    opener: &(dyn Fn(&str) -> Result<(), String> + Sync),
) -> Result<String, String> {
    use specseal_desktop_lib::connections::{connection_login, ConnectionLogin, DesktopLoginIo};
    let cancel = std::sync::atomic::AtomicBool::new(false);
    let io = DesktopLoginIo {
        origin,
        emit: &|_| {},
        open_browser: opener,
        cancel: &cancel,
    };
    match connection_login(origin, store, registry, &io)? {
        ConnectionLogin::LoggedIn { access_token: Some(access), .. } => Ok(access),
        other => Err(format!("device login did not complete: {other:?}")),
    }
}

/// 给用户签一枚 PAT（数据面测试最短的 credential 路径）。
pub fn pat_of(h: &Harness) -> String {
    let (_, pat) = h
        .identity
        .create_pat(&h.user_id, "test", None)
        .expect("pat");
    pat
}
