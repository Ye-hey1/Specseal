//! Phase 2 收官验收：八环节单一剧本连续可走（phase2-acceptance spec）。真实 CLI
//! binary 对真 server binary、SQLite driver、tempdir 隔离，从空数据库依序走完
//! (1) setup 开箱 → (2) invite/PAT → (3) propose → (4) policy → (5) task done
//! （evidence 三连）→ (6) context 投影 → (7) drift → (8) archive，环节共用同一
//! 数据库与帐号。SSE 订阅者自步骤 (3) 前伴随整条工作流，于步骤 (5) 后强制断线、
//! 错过后续事件，再依保留笔数组态走续传（Last-Event-ID 补齐）或 reset（全量收敛
//! 后重订）两条恢复路径各一次剧本配置（design 决策 4）。任一步失败 panic 携步骤
//! 编号/名称并倾印 server stderr 尾段与 workspace 目录树（决策 1）。

use crate::common;

use crate::common::subscriber::Recorder;
use specseal_protocol::context::ContextSnapshotRequest;
use specseal_remote::client::{Client, ContextSnapshotOutcome};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::{Arc, Mutex, Once};
use std::time::{Duration, Instant};

const CHANGE: &str = "chain-demo";
const POSTSCRIPT: &str = "chain-postscript";
const CAP: &str = "payments";

const PROPOSAL: &str = "## Why\n\n八环节剧本的示范 change。\n\n## What Changes\n\n- checkout 流程\n";
// The design anchors `src/app.rs`, a file the git checkout commits — the drift
// workspace side stats it against real code.
const DESIGN: &str = "## Context\n\n实作落在 `src/app.rs`。\n";
const TASKS: &str = "## 1. Work\n\n- [ ] 1.1 First\n- [ ] 1.2 Second\n";
const DELTA_SPEC: &str = "## Purpose\n\n本 capability 是测试用的示范能力，涵盖一个可观察行为与其成功路径，专供伺服端的测试取用。\n\n## ADDED Requirements\n\n### Requirement: Checkout works\nCheckout SHALL work.\n\n#### Scenario: pays\n- **WHEN** paying\n- **THEN** ok\n";
const POST_SPEC: &str = "## ADDED Requirements\n\n### Requirement: Refunds work\nRefunds SHALL work.\n\n#### Scenario: refunds\n- **WHEN** refunding\n- **THEN** ok\n";

const EMAIL: &str = "dev@example.com";
const DISPLAY: &str = "Chain <chain@example.com>";
const PASSWORD: &str = "chain-correct-horse";
const ADMIN_EMAIL: &str = "root@example.com";
const ADMIN_DISPLAY: &str = "Root <root@example.com>";
const ADMIN_PASSWORD: &str = "root-correct-horse";

// --- binaries (same pattern as e2e_cli.rs) ---

static BUILD_CLI: Once = Once::new();

fn cli_bin() -> PathBuf {
    BUILD_CLI.call_once(|| {
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_string());
        let status = Command::new(cargo)
            .args(["build", "-p", "specseal-cli", "--bin", "specseal"])
            .status()
            .expect("spawn cargo build for the CLI");
        assert!(status.success(), "building the specseal CLI failed");
    });
    let server = PathBuf::from(env!("CARGO_BIN_EXE_specseal-server"));
    let dir = server.parent().expect("target dir");
    let exe = if cfg!(windows) { "specseal.exe" } else { "specseal" };
    dir.join(exe)
}

fn server_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_specseal-server"))
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").expect("bind free port").local_addr().unwrap().port()
}

// --- the server child, stdout (setup token) AND stderr (failure dump) captured ---

struct Server {
    child: Arc<Mutex<Child>>,
    addr: String,
    stdout: Arc<Mutex<Vec<String>>>,
    stderr: Arc<Mutex<Vec<String>>>,
}

impl Server {
    fn start(config: &Path) -> Server {
        let port = free_port();
        let addr = format!("127.0.0.1:{port}");
        let mut child = Command::new(server_bin())
            .args(["--config", config.to_str().unwrap(), "--addr", &addr])
            .env_remove("SPECSEAL_LOCALE")
            .env_remove("SPECSEAL_SPEC_LOCALE")
            .env_remove("SPECSEAL_TDD")
            .env_remove("SPECSEAL_AUDIT")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn specseal-server");
        let stdout = capture(child.stdout.take().expect("piped stdout"));
        let stderr = capture(child.stderr.take().expect("piped stderr"));
        let server = Server { child: Arc::new(Mutex::new(child)), addr, stdout, stderr };
        server.wait_ready();
        server
    }

    fn base(&self) -> String {
        format!("http://{}", self.addr)
    }

    fn project_url(&self) -> String {
        format!("{}/api/specseal/v1/projects/demo", self.base())
    }

    fn events_url(&self) -> String {
        format!("{}/api/specseal/v1/projects/demo/events", self.base())
    }

    fn wait_ready(&self) {
        let url = format!("{}/healthz", self.base());
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if ureq::get(&url).call().map(|r| r.status() == 200).unwrap_or(false) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        panic!("server did not become ready at {url}");
    }

    /// The one-time setup token off the fresh server's stdout.
    fn setup_token(&self) -> String {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(token) =
                self.stdout.lock().expect("stdout lock").iter().find_map(|l| parse_setup_token(l))
            {
                return token;
            }
            if Instant::now() > deadline {
                panic!("no setup token on stdout: {:?}", self.stdout.lock().expect("stdout lock"));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let mut child = self.child.lock().expect("child lock");
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn capture(out: impl std::io::Read + Send + 'static) -> Arc<Mutex<Vec<String>>> {
    let sink = Arc::new(Mutex::new(Vec::new()));
    let clone = sink.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            clone.lock().expect("capture lock").push(line);
        }
    });
    sink
}

fn parse_setup_token(line: &str) -> Option<String> {
    if !line.contains("/setup") {
        return None;
    }
    let token: String = line
        .split("token=")
        .nth(1)?
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();
    (!token.is_empty()).then_some(token)
}

/// Server config: SQLite store + identity in `dir`, and the explicit event
/// retention that steers which recovery path the scenario walks. The 1s
/// heartbeat keeps disconnected-subscriber teardown prompt on both sides (the
/// server only notices a dead socket on its next write).
fn write_config(dir: &Path, db: &Path, retention: u64) -> PathBuf {
    let path = dir.join("server.yaml");
    let identity_db = dir.join("identity.db");
    let mut file = std::fs::File::create(&path).expect("create config");
    write!(
        file,
        "store:\n  driver: sqlite\n  path: {}\nidentity:\n  driver: sqlite\n  path: {}\nevents:\n  retention: {}\n  heartbeat_secs: 1\n",
        db.display(),
        identity_db.display(),
        retention,
    )
    .expect("write config");
    path
}

// --- web flows: /setup, invite, PAT (same shapes as e2e_cli.rs) ---

fn agent() -> ureq::Agent {
    ureq::builder().redirects(0).build()
}

fn complete_setup(base: &str, token: &str) {
    let http = agent();
    let admin = http
        .post(&format!("{base}/api/specseal/v1/web/setup/admin?token={token}"))
        .send_json(serde_json::json!({ "email": ADMIN_EMAIL, "display": ADMIN_DISPLAY, "password": ADMIN_PASSWORD }))
        .expect("setup: create the first admin");
    assert_eq!(admin.status(), 200, "the setup admin section succeeds");
    let project = http
        .post(&format!("{base}/api/specseal/v1/web/setup/registry?token={token}"))
        .send_json(serde_json::json!({
            "projectKey": "demo",
            "projectName": "Demo",
            "repoKey": "backend",
            "repoName": "Backend",
        }))
        .expect("setup: register the first project/repo");
    assert_eq!(project.status(), 200, "the setup project/repo section succeeds");
}

fn invite(config: &Path) -> String {
    let out = Command::new(server_bin())
        .arg("invite")
        .args(["--config", config.to_str().unwrap()])
        .args(["--email", EMAIL, "--display", DISPLAY, "--project", "demo"])
        .output()
        .expect("run invite subcommand");
    assert!(out.status.success(), "invite failed: {}", String::from_utf8_lossy(&out.stderr));
    let stdout = String::from_utf8_lossy(&out.stdout);
    stdout
        .split_whitespace()
        .find(|w| w.contains("/invite/"))
        .and_then(|url| url.rsplit("/invite/").next())
        .unwrap_or_else(|| panic!("invite printed a URL: {stdout}"))
        .trim()
        .to_string()
}

fn create_pat_via_web(base: &str, token: &str) -> String {
    let http = agent();
    let accept = http
        .post(&format!("{base}/api/specseal/v1/web/invite/{token}"))
        .send_json(serde_json::json!({ "password": PASSWORD }))
        .expect("accept invitation");
    assert_eq!(accept.status(), 200, "accepting the invitation succeeds");
    let login = http
        .post(&format!("{base}/api/specseal/v1/web/login"))
        .send_json(serde_json::json!({ "email": EMAIL, "password": PASSWORD }))
        .expect("login");
    assert_eq!(login.status(), 200, "login succeeds");
    let session = login
        .header("set-cookie")
        .and_then(|c| c.split(';').next())
        .and_then(|c| c.trim().strip_prefix("specseal_session="))
        .expect("a session cookie")
        .to_string();
    let created: serde_json::Value = http
        .post(&format!("{base}/api/specseal/v1/web/account/tokens"))
        .set("Cookie", &format!("specseal_session={session}"))
        .send_json(serde_json::json!({ "name": "cli" }))
        .expect("create PAT")
        .into_json()
        .expect("create PAT json");
    created["data"]["plaintext"]
        .as_str()
        .unwrap_or_else(|| panic!("PAT plaintext in response: {created}"))
        .to_string()
}

// --- the CLI, run from a real git checkout ---

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args(["-c", "user.name=Chain", "-c", "user.email=chain@example.com"])
        .args(args)
        .current_dir(dir)
        .output()
        .expect("run git");
    assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
}

/// A remote-mode CLI project that is also a git checkout: `src/app.rs` (the
/// design's anchor) is committed, so drift has real code to stat and task done
/// has a repo to collect touched files from.
fn git_checkout(dir: &Path, project_url: &str) -> PathBuf {
    let project = dir.join("checkout");
    std::fs::create_dir_all(project.join("src")).unwrap();
    std::fs::write(
        project.join(".specseal.yaml"),
        format!("remote:\n  url: {project_url}\n  repo: backend\n"),
    )
    .unwrap();
    std::fs::write(project.join("src").join("app.rs"), "fn main() {}\n").unwrap();
    git(&project, &["init", "-q"]);
    git(&project, &["add", "."]);
    git(&project, &["commit", "-q", "-m", "init"]);
    project
}

fn cli_cmd(project: &Path, args: &[&str], token: &str) -> Command {
    let mut cmd = Command::new(cli_bin());
    cmd.args(args)
        .current_dir(project)
        .env_remove("SPECSEAL_STORE_URL")
        .env_remove("SPECSEAL_LOCALE")
        .env_remove("SPECSEAL_SPEC_LOCALE")
        .env_remove("SPECSEAL_TDD")
        .env_remove("SPECSEAL_AUDIT")
        .env("SPECSEAL_TOKEN", token);
    cmd
}

/// Run the CLI and assert success; returns stdout.
fn cli(project: &Path, args: &[&str], token: &str) -> String {
    let out = cli_cmd(project, args, token).output().expect("run specseal CLI");
    expect_ok(&out, &format!("specseal {}", args.join(" ")))
}

/// Run the CLI feeding `content` on stdin (artifact writes); asserts success.
fn cli_stdin(project: &Path, args: &[&str], token: &str, content: &str) -> String {
    let mut child = cli_cmd(project, args, token)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn specseal CLI");
    child.stdin.as_mut().expect("piped stdin").write_all(content.as_bytes()).unwrap();
    drop(child.stdin.take());
    let out = child.wait_with_output().expect("CLI output");
    expect_ok(&out, &format!("specseal {}", args.join(" ")))
}

fn expect_ok(out: &Output, what: &str) -> String {
    assert!(
        out.status.success(),
        "{what} failed\nstderr: {}\nstdout: {}",
        String::from_utf8_lossy(&out.stderr),
        String::from_utf8_lossy(&out.stdout),
    );
    String::from_utf8_lossy(&out.stdout).to_string()
}

fn json(stdout: &str) -> serde_json::Value {
    serde_json::from_str(stdout).unwrap_or_else(|e| panic!("stdout is JSON ({e}): {stdout}"))
}

/// The `locale` the apply instructions render — the observable policy face
/// (design 决策 2): workflow config's locale key → this field.
fn apply_locale(project: &Path, token: &str) -> String {
    let out = cli(project, &["instructions", "apply", "--change", CHANGE, "--json"], token);
    json(&out)["locale"].as_str().expect("apply instructions carry a locale").to_string()
}

// --- direct store access (the second SQLite connection; WAL makes it safe) ---

fn scope() -> specseal_store::Scope {
    specseal_store::Scope::new(
        specseal_store::ProjectId::new("demo"),
        specseal_store::RepoId::new("backend"),
    )
}

fn open_store(db: &Path) -> specseal_store_sqlite::SqliteTeamStore {
    specseal_store_sqlite::SqliteTeamStore::open(db).expect("open store on a second connection")
}

/// Write the workflow config document directly on a second store connection —
/// remote mode has no CLI/wire config write surface today (design 决策 2); the
/// seam under test (store → policy → instructions rendering) is unchanged.
fn write_workflow_config(db: &Path, content: &str) {
    use specseal_store::{CommandContext, DocumentId, TeamStore};
    let store = open_store(db);
    let current = store
        .snapshot(&scope())
        .expect("snapshot")
        .read(&DocumentId::WorkflowConfig)
        .expect("read workflow config");
    let mut uow = store
        .begin_unit_of_work(
            &scope(),
            CommandContext { command: "chain-policy".into(), actor: "chain".into() },
        )
        .expect("begin config uow");
    match current {
        Some(doc) => uow.update(DocumentId::WorkflowConfig, content, doc.revision),
        None => uow.create(DocumentId::WorkflowConfig, content),
    }
    store.commit(uow, Vec::new()).expect("commit config write");
}

/// The retained outbox tail as (seq, event name, payload).
fn outbox_records(db: &Path) -> Vec<(u64, String, serde_json::Value)> {
    use specseal_store::{OutboxCursor, TeamStore};
    open_store(db)
        .read_outbox(&scope(), OutboxCursor(0))
        .expect("read outbox")
        .into_iter()
        .map(|e| (e.seq, e.record.name.clone(), e.record.payload.clone()))
        .collect()
}

fn outbox_acked(db: &Path) -> u64 {
    use specseal_store::TeamStore;
    open_store(db).outbox_acked(&scope()).expect("read acked floor").0
}

/// The canonical spec content for `cap`, queried over the wire (a scope-wide
/// context snapshot) — the "直接查找正典" side of the convergence assertions.
fn canonical_spec(project_url: &str, token: &str, cap: &str) -> Option<String> {
    let client = Client::new(project_url, token, Some("backend"));
    let request = ContextSnapshotRequest { change: None, flow: None };
    let snapshot = match client.context_snapshot(&request, None).expect("context snapshot") {
        ContextSnapshotOutcome::Fresh(s) => s,
        ContextSnapshotOutcome::Unchanged => panic!("a fresh request is never unchanged"),
    };
    let path = format!("specseal/specs/{cap}/spec.md");
    snapshot.documents.into_iter().find(|d| d.path == path).map(|d| d.content)
}

/// The projection root, canonicalized off macOS's /var → /private/var symlink
/// (Windows keeps the raw path — same handling as context_api.rs).
fn projection_root(project: &Path) -> PathBuf {
    if cfg!(windows) {
        project.to_path_buf()
    } else {
        project.canonicalize().expect("canonicalize checkout dir")
    }
}

// --- the step engine: failure names the step and dumps the scene (决策 1) ---

struct Scene {
    server_stderr: Arc<Mutex<Vec<String>>>,
    server_child: Arc<Mutex<Child>>,
    health_url: String,
    workdir: PathBuf,
}

impl Scene {
    /// Server liveness at failure time: the child's exit status (if it died)
    /// plus a fresh `/healthz` probe — tells a dead server apart from a
    /// transient connection failure at a glance.
    fn server_state(&self) -> String {
        let exit = match self.server_child.lock().expect("child lock").try_wait() {
            Ok(Some(status)) => format!("exited: {status}"),
            Ok(None) => "running".to_string(),
            Err(e) => format!("unknown ({e})"),
        };
        let health = match ureq::get(&self.health_url).call() {
            Ok(resp) => format!("healthz {}", resp.status()),
            Err(e) => format!("healthz unreachable ({e})"),
        };
        format!("{exit}; {health}")
    }
}

/// Run one named scenario step. On failure the panic carries the step number
/// and name, the server stderr tail, and the workspace directory tree.
fn step<T>(scene: &Scene, n: u32, name: &str, f: impl FnOnce() -> T) -> T {
    use std::panic::{catch_unwind, AssertUnwindSafe};
    eprintln!("▶ step ({n}) {name}");
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(value) => value,
        Err(cause) => {
            let msg = cause
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| cause.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_else(|| "non-string panic payload".to_string());
            panic!(
                "step ({n}) {name} failed: {msg}\n\n--- server state ---\n{}\n--- server stderr (tail) ---\n{}\n--- workspace tree ---\n{}",
                scene.server_state(),
                stderr_tail(scene, 40),
                dir_tree(&scene.workdir),
            );
        }
    }
}

fn stderr_tail(scene: &Scene, lines: usize) -> String {
    let all = scene.server_stderr.lock().expect("stderr lock");
    let start = all.len().saturating_sub(lines);
    if all.is_empty() {
        "(empty)".to_string()
    } else {
        all[start..].join("\n")
    }
}

fn dir_tree(root: &Path) -> String {
    let mut out = String::new();
    let mut count = 0usize;
    walk(root, root, &mut out, &mut count);
    if out.is_empty() {
        "(empty)".to_string()
    } else {
        out
    }
}

fn walk(dir: &Path, root: &Path, out: &mut String, count: &mut usize) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut paths: Vec<PathBuf> = entries.map_while(Result::ok).map(|e| e.path()).collect();
    paths.sort();
    for path in paths {
        if *count >= 200 {
            out.push_str("… (truncated)\n");
            return;
        }
        let rel = path.strip_prefix(root).unwrap_or(&path);
        let name = rel.to_string_lossy();
        if name.contains(".git") {
            continue;
        }
        out.push_str(&format!("{name}\n"));
        *count += 1;
        if path.is_dir() {
            walk(&path, root, out, count);
        }
    }
}

// --- the chain ---

/// Which recovery path this scenario configuration exercises (design 决策 4).
enum Recovery {
    /// retention 1024：远大于剧本事件数 → 断线期间序号不被清理 →
    /// Last-Event-ID 续传补齐（spec「续传路径收敛」）。
    Resume,
    /// retention 1：断线期间的两笔写入把 acked 底线推过订阅者光标 →
    /// 重连收 reset、全量收敛后重订（spec「reset 路径收敛」）。
    Reset,
}

fn run_chain(recovery: Recovery) {
    let workdir = tempfile::tempdir().expect("workdir");
    let db = workdir.path().join("store.db");
    let retention = match recovery {
        Recovery::Resume => 1024,
        Recovery::Reset => 1,
    };
    let config = write_config(workdir.path(), &db, retention);
    let server = Server::start(&config);
    let scene = Scene {
        server_stderr: server.stderr.clone(),
        server_child: server.child.clone(),
        health_url: format!("{}/healthz", server.base()),
        workdir: workdir.path().to_path_buf(),
    };

    // (1) 全新数据库开箱：stdout 取一次性 token，HTTP 走完 /setup。
    step(&scene, 1, "setup 开箱（token → Admin ＋ Project/Repo）", || {
        let token = server.setup_token();
        complete_setup(&server.base(), &token);
    });

    // (2) invite 子命令 → 接受页设密码 → 登录 → 建 PAT。
    let pat = step(&scene, 2, "invite → 接受 → 登录 → PAT", || {
        create_pat_via_web(&server.base(), &invite(&config))
    });

    let project = git_checkout(workdir.path(), &server.project_url());

    // 订阅者于步骤 (3) 前挂上，伴随整条工作流（决策 4）。
    let mut sub = Recorder::connect(&server.events_url(), &pat, "backend");

    // (3) propose：new change 与全部 artifacts，change 清单可见。
    step(&scene, 3, "propose：new change 与全部 artifacts", || {
        cli(&project, &["new", "change", CHANGE], &pat);
        cli_stdin(&project, &["new", "artifact", "proposal", "--change", CHANGE, "--stdin"], &pat, PROPOSAL);
        cli_stdin(&project, &["new", "artifact", "design", "--change", CHANGE, "--stdin"], &pat, DESIGN);
        cli_stdin(&project, &["new", "artifact", "tasks", "--change", CHANGE, "--stdin"], &pat, TASKS);
        cli_stdin(&project, &["new", "artifact", "spec", CAP, "--change", CHANGE, "--stdin"], &pat, DELTA_SPEC);
        let list = cli(&project, &["list", "--json"], &pat);
        assert!(list.contains(CHANGE), "the new change is listed: {list}");
        // propose 的事件（change-created ＋ 4×artifact-created）到齐且不重复。
        sub.drain(Duration::from_secs(1));
        assert_eq!(sub.events.len(), 5, "propose pushes five invalidations: {:?}", sub.seqs());
        assert!(
            sub.events.iter().all(|e| e.scope == "change" && e.resource == CHANGE),
            "every propose hint points at the change: {:?}",
            sub.events,
        );
    });

    // (4) policy：写入 workflow config 一条可观察政策差异（locale）→ instructions
    // 反映 → 改回 → 恢复。写入走第二条 store 连接（决策 2——今日无 CLI/wire 写入面）。
    step(&scene, 4, "policy：config 变化可观察于 instructions", || {
        let before = apply_locale(&project, &pat);
        assert_eq!(before, "English", "no locale policy renders the default");
        write_workflow_config(&db, "schema: spec-driven\nlocale: ja\n");
        assert_eq!(
            apply_locale(&project, &pat),
            "Japanese (日本语)",
            "instructions reflect the policy change",
        );
        write_workflow_config(&db, "schema: spec-driven\n");
        assert_eq!(apply_locale(&project, &pat), before, "reverting the policy restores the output");
    });

    // (5) task done 携 touched files：写入面与事件面（evidence 三连的两面）。
    let task_done_seq = step(&scene, 5, "task done：写入与事件", || {
        // 一个新脏档让 CLI 在 wire 上带 touchedFiles（remote_task_done 取自 git status）。
        std::fs::write(project.join("notes.txt"), "dirty for evidence").unwrap();
        cli(&project, &["task", "done", "1", "--change", CHANGE], &pat);
        // 写入面：tasks.md 的勾选落地。
        let tasks = cli(&project, &["artifact", "cat", "tasks", "--change", CHANGE], &pat);
        assert_eq!(tasks.matches("- [x]").count(), 1, "the completion is committed: {tasks}");
        // outbox 有 task-completed 事件（proposal 步骤 5 字面）。
        let records = outbox_records(&db);
        let (seq, _, payload) = records
            .iter()
            .rev()
            .find(|(_, name, _)| name == "task-completed")
            .unwrap_or_else(|| panic!("outbox carries task-completed: {records:?}"));
        assert_eq!(payload["change"], CHANGE, "the event names the change");
        // 事件面：订阅者收到同一序号的 invalidation hint。
        let event = sub.await_resource(CHANGE, Duration::from_secs(3));
        assert_eq!(event.seq, *seq, "the subscriber's hint is the task-completed outbox entry");
        assert_eq!(event.scope, "change");
        *seq
    });

    // (5b) 证据面 — 剧本揭露的缝隙缺陷，依本刀纪律显性跳过、不留假绿（tasks 4.2）：
    // remote task done 的 touchedFiles 在 server 路由被丢弃（routes::task_done 的
    // `Json(_req)`），server 端无 evidence 记录可查（taskId/actor/touchedFiles）。
    // 红色断言见下方 #[ignore] 测试；待开 change：remote-task-evidence。
    eprintln!("⚠ step (5b) evidence 记录可查 — SKIPPED：产品缺陷，待开 change 'remote-task-evidence'");

    // (6) context：apply 阶段动词后投影完整、manifest 验证通过。
    step(&scene, 6, "context：投影完整且 manifest 验证通过", || {
        let out = cli(&project, &["instructions", "apply", "--change", CHANGE, "--json"], &pat);
        let projection = projection_root(&project).join(".specseal").join("context");
        for rel in [
            &format!("specseal/changes/{CHANGE}/proposal.md"),
            &format!("specseal/changes/{CHANGE}/design.md"),
            &format!("specseal/changes/{CHANGE}/tasks.md"),
            &format!("specseal/changes/{CHANGE}/specs/{CAP}/spec.md"),
            "INDEX.md",
            "manifest.json",
        ] {
            assert!(projection.join(rel).is_file(), "{rel} is in the projection");
        }
        // 此刻尚未 archive，正式规格为空——其进投影的断言在步骤 (10) 收口。
        assert!(
            !projection.join(format!("specseal/specs/{CAP}/spec.md")).exists(),
            "no canonical spec exists before archive",
        );
        let ws = specseal_core::workspace::Workspace {
            root: projection_root(&project),
            spec_dir_name: "openspec".to_string(),
        };
        specseal_host::projection::verify_projection(&ws).expect("the projection verifies");
        // contextFiles 指向投影内存在的文件（glob 除外）。
        let payload = json(&out);
        for (key, value) in payload["contextFiles"].as_object().expect("contextFiles object") {
            let value = value.as_str().unwrap();
            if !value.contains('*') {
                assert!(PathBuf::from(value).is_file(), "{key} exists under the projection: {value}");
            }
        }
    });

    // (7) drift：有 checkout 的完整报告（server-drift-api 刀的整链消费）。
    step(&scene, 7, "drift：有 checkout 的完整报告", || {
        let out = cli(&project, &["drift", CHANGE, "--json"], &pat);
        let report = json(&out);
        assert!(
            report.get("coverage").is_none(),
            "a checkout yields full coverage (the marker only appears spec-only): {report}"
        );
        assert!(report.get("stale").is_none(), "one snapshot basis is never stale: {report}");
        let kinds: Vec<&str> = report["dimensions"]
            .as_array()
            .expect("dimensions array")
            .iter()
            .map(|d| d["kind"].as_str().unwrap_or_default())
            .collect();
        assert_eq!(
            kinds,
            vec!["Time", "Structure", "Tasks", "Specs", "Environment"],
            "the full report scores every dimension",
        );
        assert!(!report["severity"].as_str().unwrap_or_default().is_empty(), "a severity is stated");
    });

    // --- 断线窗口：订阅者于步骤 (5) 后强制断线，错过后续事件（决策 4）。 ---
    sub.disconnect();

    // (8) 断线期间收尾任务并 archive：正式规格更新、change 入 archive、清单如实。
    step(&scene, 8, "archive：正式规格更新、清单如实（断线窗口内）", || {
        cli(&project, &["task", "done", "2", "--change", CHANGE], &pat);
        // 等断线订阅者两侧的 socket 拆除完成（客端 reader 于下一帧退出、server 端
        // 于下一次 heartbeat 写入失败时退出）再走 archive——半关 socket 的拆除与
        // archive 回应在 loopback 上交错时，观测到暂时性连接失败。
        sub.await_teardown(Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(1500));
        let out = cli(&project, &["archive", CHANGE], &pat);
        // remote 走 fs 同一支渲染（cli-render-unification）：报的是封存目的地，
        // 不再是旧 remote 专属的 "Archived change" 短句。
        assert!(
            out.contains(&format!("Archived: {CHANGE} →")),
            "the archive verb reports the destination: {out}"
        );
        assert!(out.contains(CAP), "the promoted capability is named: {out}");
        let list = cli(&project, &["list", "--json"], &pat);
        assert!(!list.contains(CHANGE), "the archived change leaves the active list: {list}");
        let specs = cli(&project, &["list", "--specs", "--json"], &pat);
        assert!(specs.contains(CAP), "the canonical spec is listed: {specs}");
        let canon = canonical_spec(&server.project_url(), &pat, CAP)
            .expect("the canonical spec exists after archive");
        assert!(
            canon.contains("Requirement: Checkout works"),
            "the canon carries this scenario's delta: {canon}"
        );
    });

    // (9) 恢复路径：续传或 reset（保留笔数组态决定，见 Recovery 注解）。
    let recovered_by_reset = match recovery {
        Recovery::Resume => step(&scene, 9, "续传：Last-Event-ID 补齐无重复", || {
            let seen_before = sub.seqs();
            let reset = sub.reconnect_from_last();
            assert!(!reset, "within retention the reconnect resumes, no reset");
            sub.drain(Duration::from_secs(1));
            let seqs = sub.seqs();
            assert_eq!(
                seqs.len(),
                seen_before.len() + 2,
                "exactly the two missed events (task 2 done, archived) backfill: {seqs:?}"
            );
            assert!(seqs.windows(2).all(|w| w[0] < w[1]), "in order, no repeats: {seqs:?}");
            // 无漏失：订阅者的序号集合与 outbox 完整一致（retention 远大于事件数）。
            let outbox: Vec<u64> = outbox_records(&db).iter().map(|(s, _, _)| *s).collect();
            assert_eq!(seqs, outbox, "the deduplicated view misses nothing the outbox has");
            let last = sub.events.last().expect("events recorded");
            assert_eq!(last.scope, "spec", "the archive hint points at the canonical specs");
            assert_eq!(last.resource, CHANGE);
            false
        }),
        Recovery::Reset => step(&scene, 9, "reset：全量收敛后重订", || {
            // 等 pump 的 ack 把底线推过订阅者光标（retention 1；ack 异步）。
            let cursor = sub.last_seq().expect("the subscriber saw live events");
            let deadline = Instant::now() + Duration::from_secs(5);
            while outbox_acked(&db) <= cursor {
                assert!(Instant::now() < deadline, "the acked floor passes the cursor");
                std::thread::sleep(Duration::from_millis(50));
            }
            let reset = sub.reconnect_from_last();
            assert!(reset, "a cleaned cursor gets a reset signal first");
            // 全量收敛：/sync-state 的 ETag ＋ 查找面重读正典。
            let etag = sync_state_etag(&server.base(), &pat);
            assert!(!etag.is_empty(), "sync-state advertises an ETag");
            let list = cli(&project, &["list", "--json"], &pat);
            assert!(!list.contains(CHANGE), "the full re-read shows the change archived: {list}");
            let canon = canonical_spec(&server.project_url(), &pat, CAP)
                .expect("the full re-read reaches the canon");
            assert!(canon.contains("Requirement: Checkout works"));
            // 重新订阅（自最新序号起）。
            sub.resubscribe_fresh();
            true
        }),
    };

    // (10) postscript：archive 之后的投影与事件如实反映——第二个 change 对同一
    // capability 的 apply 投影 SHALL 带上刚升格的正典；恢复后的串流听得到新写入。
    step(&scene, 10, "postscript：正典入投影、恢复后事件可听", || {
        cli(&project, &["new", "change", POSTSCRIPT], &pat);
        cli_stdin(&project, &["new", "artifact", "proposal", "--change", POSTSCRIPT, "--stdin"], &pat, PROPOSAL);
        cli_stdin(&project, &["new", "artifact", "tasks", "--change", POSTSCRIPT, "--stdin"], &pat, TASKS);
        cli_stdin(&project, &["new", "artifact", "spec", CAP, "--change", POSTSCRIPT, "--stdin"], &pat, POST_SPEC);
        cli(&project, &["instructions", "apply", "--change", POSTSCRIPT, "--json"], &pat);
        let projection = projection_root(&project).join(".specseal").join("context");
        let canon_path = projection.join(format!("specseal/specs/{CAP}/spec.md"));
        assert!(canon_path.is_file(), "the promoted canonical spec enters the projection");
        let canon = std::fs::read_to_string(&canon_path).unwrap();
        assert!(
            canon.contains("Requirement: Checkout works"),
            "the projected canon is the archived delta: {canon}"
        );
        let ws = specseal_core::workspace::Workspace {
            root: projection_root(&project),
            spec_dir_name: "openspec".to_string(),
        };
        specseal_host::projection::verify_projection(&ws).expect("the post-archive projection verifies");
        // 恢复后的串流是活的：postscript 的写入到达订阅者。
        sub.drain(Duration::from_secs(1));
        assert!(
            sub.events.iter().any(|e| e.resource == POSTSCRIPT),
            "the recovered stream hears new writes: {:?}",
            sub.events,
        );
    });

    // (11) 结尾收敛：订阅者累积视角（去重后）与直接查找的正典一致。
    step(&scene, 11, "结尾：订阅者视角与直接查找一致", || {
        // 去重后严格递增：无重复、无乱序。
        let seqs = sub.seqs();
        assert!(seqs.windows(2).all(|w| w[0] < w[1]), "the deduplicated log never repeats: {seqs:?}");
        // 视角的每一项认知对直接查找验证：
        // archive —— 续传路径靠补齐的 spec-scope 事件、reset 路径靠全量重读得知。
        let knows_archive = recovered_by_reset
            || sub.events.iter().any(|e| e.scope == "spec" && e.resource == CHANGE);
        assert!(knows_archive, "the subscriber's view covers the archive: {:?}", sub.events);
        let list = cli(&project, &["list", "--json"], &pat);
        assert!(!list.contains(&format!("\"{CHANGE}\"")), "direct query agrees: archived");
        assert!(list.contains(POSTSCRIPT), "direct query agrees: the postscript change is active");
        // task done 的完成状态在断线与恢复之后仍与正典一致（通过事件序号锚定）。
        assert!(sub.events.iter().any(|e| e.seq == task_done_seq), "the task completion stays in view");
        let canon = canonical_spec(&server.project_url(), &pat, CAP).expect("canon readable");
        assert!(canon.contains("Requirement: Checkout works"), "the final canon matches the view");
    });
}

/// The scope's current ETag from `/sync-state` (the polling convergence bedrock).
fn sync_state_etag(base: &str, token: &str) -> String {
    ureq::get(&format!("{base}/api/specseal/v1/projects/demo/sync-state"))
        .set("Authorization", &format!("Bearer {token}"))
        .set("X-Specseal-Api-Version", "1")
        .set("X-Specseal-Repo", "backend")
        .call()
        .expect("sync-state")
        .header("etag")
        .unwrap_or_default()
        .to_string()
}

// --- the two scenario configurations (两条恢复路径各一次, 决策 4) ---

#[test]
fn phase2_chain_walks_all_stages_with_resume_recovery() {
    let _gate = crate::common::acquire_process_gate();
    run_chain(Recovery::Resume);
}

#[test]
fn phase2_chain_walks_all_stages_with_reset_recovery() {
    let _gate = crate::common::acquire_process_gate();
    run_chain(Recovery::Reset);
}

// --- 远程 task done 的证据三连（事件面＋文档面）---

/// remote task done 的 touchedFiles 一路走到 store：outbox 的 task-completed
/// payload 带着同一份清单（事件面），evidence 端点读得回这笔 entry（文档面）。
/// Remote Store 保存 task completion 回报的 touched-file evidence。
#[test]
fn task_done_with_touched_files_leaves_queryable_evidence_on_the_server() {
    let _gate = crate::common::acquire_process_gate();
    use specseal_store::{CommandContext, DocumentId, OutboxCursor, TeamStore};
    let store = std::sync::Arc::new(specseal_store::memory::MemoryStore::new());
    let mut uow = store
        .begin_unit_of_work(
            &scope(),
            CommandContext { command: "seed".into(), actor: "seed".into() },
        )
        .expect("begin uow");
    uow.create(DocumentId::ChangeMeta { change: "demo".into() }, "schema: spec-driven\n");
    uow.create(
        DocumentId::ChangeArtifact { change: "demo".into(), artifact: "tasks.md".into() },
        "- [ ] 1.1 First\n",
    );
    store.commit(uow, Vec::new()).expect("seed commit");

    let state = common::state_with(store.clone());
    let (pat, _user) = common::seed_pat(&state.identity, &["demo"]);
    let store_state_identity = state.identity.clone();
    let base = common::start(state);

    let client = Client::new(&format!("{base}/api/specseal/v1/projects/demo"), &pat, Some("backend"));
    client
        .task_done(
            "demo",
            "1",
            &["src/app.rs".to_string()],
            Some("0123456789012345678901234567890123456789"),
        )
        .expect("task done with touched files");

    // 事件面：outbox 的 task-completed 记录带 actor 与 touchedFiles。
    let entries = store.read_outbox(&scope(), OutboxCursor(0)).expect("read outbox");
    let done = entries
        .iter()
        .find(|e| e.record.name == "task-completed")
        .expect("task-completed lands in the outbox");
    assert!(!done.record.actor.is_empty(), "the actor face already works");
    assert_eq!(
        done.record.payload["touchedFiles"],
        serde_json::json!(["src/app.rs"]),
        "the reported touchedFiles stay queryable on the event face: {}",
        done.record.payload,
    );

    // 文档面：evidence 端点读得回这笔 entry，字段为 camelCase。以 Reader 角色
    // 读取——spec server-verb-api「viewer 以上角色可读」的角色分工实测。
    let (reader_pat, reader_id) = common::seed_named_pat(
        &store_state_identity,
        "reader@example.com",
        "Reader",
        &["demo"],
    );
    store_state_identity
        .admin_set_membership(
            &specseal_server::audit::AuditActor::system_cli(),
            &reader_id,
            "demo",
            specseal_server::identity::MembershipRole::Reader,
            true,
        )
        .expect("set reader role");
    let reader = Client::new(
        &format!("{base}/api/specseal/v1/projects/demo"),
        &reader_pat,
        Some("backend"),
    );
    let evidence = reader.change_evidence("demo").expect("read evidence");
    assert_eq!(evidence.entries.len(), 1, "one completion, one entry: {evidence:?}");
    let entry = &evidence.entries[0];
    assert_eq!(entry.touched_files, vec!["src/app.rs".to_string()]);
    assert_eq!(entry.task_desc, "1.1 First");
    assert!(!entry.task_id.is_empty(), "the entry names the task it belongs to");
    assert!(entry.actor.is_some(), "the acting identity travels with the record");
    assert_eq!(
        entry.head_commit.as_deref(),
        Some("0123456789012345678901234567890123456789"),
        "the wire-reported commit travels into the entry"
    );
    assert!(!entry.recorded_at.is_empty());

    let raw = serde_json::to_value(entry).expect("entry serializes");
    for field in ["taskId", "taskDesc", "touchedFiles", "recordedAt"] {
        assert!(raw.get(field).is_some(), "wire fields are camelCase, missing {field}: {raw}");
    }
}

/// 缺席是正常状态：从未落过 evidence 的 change 回成功的空集合，而非 not_found
/// ——读取端不必以错误码区分「change 不存在」与「还没有证据」。
#[test]
fn a_change_without_evidence_reads_back_an_empty_set() {
    let _gate = crate::common::acquire_process_gate();
    use specseal_store::{CommandContext, DocumentId, TeamStore};
    let store = std::sync::Arc::new(specseal_store::memory::MemoryStore::new());
    let mut uow = store
        .begin_unit_of_work(
            &scope(),
            CommandContext { command: "seed".into(), actor: "seed".into() },
        )
        .expect("begin uow");
    uow.create(DocumentId::ChangeMeta { change: "demo".into() }, "schema: spec-driven\n");
    store.commit(uow, Vec::new()).expect("seed commit");

    let state = common::state_with(store.clone());
    let (pat, _user) = common::seed_pat(&state.identity, &["demo"]);
    let base = common::start(state);

    let client = Client::new(&format!("{base}/api/specseal/v1/projects/demo"), &pat, Some("backend"));
    let evidence = client.change_evidence("demo").expect("absence is not an error");
    assert!(evidence.entries.is_empty(), "no evidence yet reads as an empty set: {evidence:?}");
}
