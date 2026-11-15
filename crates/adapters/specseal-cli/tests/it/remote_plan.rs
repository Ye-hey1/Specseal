//! `plan` 与 `change depends` 的 remote 臂（change-plan「plan 与 change depends 的
//! remote 臂」、verb-contract「模式分岔的单点声明」）：remote 模式打 server 端点、
//! 回应转回引擎类型后走 fs 模式同一渲染——同一份内容两模式 stdout、stderr 与
//! exit code 逐比特一致，且 remote 模式不读本机 specseal/。沿 remote_verb_parity
//! 的 capturing mock server 模式。

use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::{Arc, Mutex};

// --- capturing mock verb-contract server ---

#[derive(Clone, Debug)]
struct Captured {
    method: String,
    path: String,
    body: String,
}

pub(crate) struct MockServer {
    server: Arc<tiny_http::Server>,
    pub(crate) base: String,
    captured: Arc<Mutex<Vec<Captured>>>,
}

const BINDING_BODY: &str = r#"{"actor":{"id":"u_1","name":"Tester"},"project":{"id":"prj_1","key":"demo","name":"Demo"},"repo":{"id":"repo_1","key":"backend","name":"Backend"},"apiVersion":"1","engineVersion":"0.1.0","capabilities":{"events":{"transports":[],"polling":{"url":"/sync-state","etag":true}}}}"#;

pub(crate) fn mock_server(mut routes: Vec<(&'static str, String, u16, String)>) -> MockServer {
    routes.push(("GET", "/binding".to_string(), 200, BINDING_BODY.to_string()));
    let server = Arc::new(tiny_http::Server::http("127.0.0.1:0").expect("bind mock server"));
    let port = server.server_addr().to_ip().expect("ip").port();
    let base = format!("http://127.0.0.1:{port}/api/specseal/v1/projects/demo");
    let captured = Arc::new(Mutex::new(Vec::new()));
    let looper = Arc::clone(&server);
    let sink = Arc::clone(&captured);
    std::thread::spawn(move || {
        for mut req in looper.incoming_requests() {
            let mut body = String::new();
            let _ = req.as_reader().read_to_string(&mut body);
            let path = req.url().split('?').next().unwrap_or_default().to_string();
            sink.lock().unwrap().push(Captured {
                method: req.method().to_string(),
                path: path.clone(),
                body,
            });
            let hit = routes.iter().find(|(m, suffix, _, _)| {
                req.method().to_string() == *m
                    && path == format!("/api/specseal/v1/projects/demo{suffix}")
            });
            let (status, body) = match hit {
                Some((_, _, status, body)) => (*status, body.clone()),
                None => (404, r#"{"reason":"not_found","message":"no route"}"#.to_string()),
            };
            let resp = tiny_http::Response::from_string(body)
                .with_status_code(status)
                .with_header(
                    tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                        .unwrap(),
                );
            let _ = req.respond(resp);
        }
    });
    MockServer { server, base, captured }
}

impl MockServer {
    /// Every captured request except the handshake, as `METHOD suffix`.
    pub(crate) fn verb_calls(&self) -> Vec<String> {
        let prefix = "/api/specseal/v1/projects/demo";
        self.captured
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.path != format!("{prefix}/binding"))
            .map(|c| format!("{} {}", c.method, c.path.trim_start_matches(prefix)))
            .collect()
    }

    pub(crate) fn body_of(&self, method: &str, suffix: &str) -> String {
        let path = format!("/api/specseal/v1/projects/demo{suffix}");
        let caps = self.captured.lock().unwrap();
        caps.iter()
            .find(|c| c.method == method && c.path == path)
            .unwrap_or_else(|| panic!("no captured {method} {suffix}; got {caps:?}"))
            .body
            .clone()
    }
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.server.unblock();
    }
}

pub(crate) struct TempProject {
    pub(crate) dir: PathBuf,
}

impl TempProject {
    fn bare(tag: &str) -> TempProject {
        let dir = std::env::temp_dir().join(format!(
            "specseal-cli-remote-plan-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        TempProject { dir }
    }

    /// fs 项目：只有 specseal/changes/，change 由测试逐一放入。
    pub(crate) fn at(tag: &str) -> TempProject {
        let p = TempProject::bare(tag);
        std::fs::create_dir_all(p.dir.join("specseal").join("changes")).unwrap();
        p
    }

    /// remote 项目：只有指向 mock 的连接设置。
    pub(crate) fn remote(tag: &str, url: &str) -> TempProject {
        let p = TempProject::bare(tag);
        std::fs::write(
            p.dir.join(".specseal.yaml"),
            format!("remote:\n  url: {url}\n  repo: backend\n"),
        )
        .unwrap();
        p
    }

    pub(crate) fn put_change(&self, name: &str, meta: &str) {
        let dir = self.dir.join("specseal").join("changes").join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".meta.yaml"), meta).unwrap();
    }

    /// 给 change 一份 capability delta，MODIFIED 一个 requirement。
    fn put_modified(&self, change: &str, cap: &str, requirement: &str) {
        let dir = self.dir.join("specseal").join("changes").join(change).join("specs").join(cap);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("spec.md"),
            format!("## MODIFIED Requirements\n\n### Requirement: {requirement}\n\nbody\n"),
        )
        .unwrap();
    }

    /// 放入一份已写结论的未封存讨论：只转出了 cut 1 `add-a`，cut 2 `add-b` 尚未转出。
    fn put_half_promoted_discussion(&self, slug: &str) {
        let dir = self.dir.join("specseal").join("discussions");
        std::fs::create_dir_all(&dir).unwrap();
        let doc = format!(
            "---\ntopic: {slug}\nslug: {slug}\nstatus: promoted\npromoted_to: add-a\n\
             created: 2026-09-01\n---\n\n# Discussion: {slug}\n\n## Context\n\n背景。\n\n\
             ## Rounds\n\n### Round 1 — assumptions (2026-09-01)\n\n**Focus**: scope\n\n\
             ## Conclusion\n\n**Decision**: 定案。\n\n\
             - **cut 1 `add-a`**: 第一刀\n- **cut 2 `add-b`**: 第二刀\n"
        );
        std::fs::write(dir.join(format!("{slug}.md")), doc).unwrap();
    }

    pub(crate) fn run(&self, args: &[&str]) -> Output {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_specseal"));
        cmd.args(args).current_dir(&self.dir);
        for key in [
            "SPECSEAL_LOCALE",
            "SPECSEAL_SPEC_LOCALE",
            "SPECSEAL_STORE_URL",
            "SPECSEAL_WORKTREE",
            "NO_COLOR",
            "CLICOLOR",
            "CLICOLOR_FORCE",
        ] {
            cmd.env_remove(key);
        }
        cmd.env("SPECSEAL_TOKEN", "tok");
        cmd.output().expect("run specseal binary")
    }
}

impl Drop for TempProject {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

pub(crate) fn stdout_of(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).to_string()
}

pub(crate) fn stderr_of(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).to_string()
}

/// fs 对照组：add-a 为前置、add-b 依赖它。
fn fs_pair(tag: &str) -> TempProject {
    let p = TempProject::at(tag);
    p.put_change("add-a", "schema: spec-driven\ncreated: 2026-09-01\n");
    p.put_change("add-b", "schema: spec-driven\ncreated: 2026-09-02\ndepends_on: add-a\n");
    p
}

// --- plan ---

#[test]
fn remote_plan_prints_the_fs_output_for_the_same_content() {
    // Scenario「remote plan 同形」：fs 的 --json 就是 server 对同内容的回应形状；
    // remote 臂把它转回引擎类型再渲染，--json 与人眼行都要与 fs 逐比特一致——
    // 含 requirement 级重叠与封存顺序（两者 MODIFIED 同一个 requirement）。
    let fs = fs_pair("plan-fs");
    fs.put_modified("add-a", "auth", "Login");
    fs.put_modified("add-b", "auth", "Login");
    let fs_json = fs.run(&["plan", "--json"]);
    assert!(fs_json.status.success(), "fs stderr: {}", stderr_of(&fs_json));
    let fs_human = fs.run(&["plan", "--no-color"]);
    assert!(fs_human.status.success(), "fs stderr: {}", stderr_of(&fs_human));

    let mock = mock_server(vec![("GET", "/plan".into(), 200, stdout_of(&fs_json))]);
    let remote = TempProject::remote("plan-remote", &mock.base);
    // 只存在本机的 change 当诱饵：remote 臂若读了本机 specseal/，输出就会多出它
    //（本机树与 remote 设置并存时 stderr 另有一行并存警告，这里只比 stdout）。
    remote.put_change("local-only", "schema: spec-driven\ncreated: 2026-01-01\n");
    let out = remote.run(&["plan", "--json"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(stdout_of(&out), stdout_of(&fs_json), "remote --json matches fs byte for byte");
    let payload: serde_json::Value = serde_json::from_str(&stdout_of(&out)).expect("JSON");
    let mut keys: Vec<&str> = payload.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort();
    assert_eq!(keys, ["changes", "next", "skipped", "unpromotedCuts", "waves"]);
    let add_b = &payload["changes"][1];
    assert_eq!(add_b["name"], "add-b");
    assert_eq!(add_b.as_object().unwrap().len(), 9, "nine keys per change: {add_b}");
    assert_eq!(add_b["archiveAfter"], serde_json::json!(["add-a"]));
    assert_eq!(add_b["requirementOverlap"][0]["ownOperation"], "MODIFIED");

    let human = remote.run(&["plan", "--no-color"]);
    assert!(human.status.success(), "stderr: {}", stderr_of(&human));
    assert_eq!(stdout_of(&human), stdout_of(&fs_human), "remote human lines match fs");
    assert!(stdout_of(&human).contains("archive after: add-a"), "{}", stdout_of(&human));
    assert!(!stdout_of(&human).contains("local-only"), "the local specseal/ tree is never read");
    assert_eq!(mock.verb_calls(), ["GET /plan", "GET /plan"]);
}

#[test]
fn remote_plan_prints_the_unpromoted_cuts_like_fs_mode() {
    // 规格「plan 回应 payload」：unpromotedCuts 五键逐栏搬回，渲染与 fs 模式共用。
    let fs = fs_pair("cuts-fs");
    fs.put_half_promoted_discussion("talk-a");
    let fs_json = fs.run(&["plan", "--json"]);
    assert!(fs_json.status.success(), "fs stderr: {}", stderr_of(&fs_json));
    let fs_human = fs.run(&["plan", "--no-color"]);
    assert!(fs_human.status.success(), "fs stderr: {}", stderr_of(&fs_human));

    let mock = mock_server(vec![("GET", "/plan".into(), 200, stdout_of(&fs_json))]);
    let remote = TempProject::remote("cuts-remote", &mock.base);
    let out = remote.run(&["plan", "--json"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    let payload: serde_json::Value = serde_json::from_str(&stdout_of(&out)).expect("JSON");
    let response: serde_json::Value = serde_json::from_str(&stdout_of(&fs_json)).expect("JSON");
    assert_eq!(payload["unpromotedCuts"], response["unpromotedCuts"]);
    assert_eq!(payload["unpromotedCuts"][0]["unpromoted"], serde_json::json!(["add-b"]));

    let human = remote.run(&["plan", "--no-color"]);
    assert!(human.status.success(), "stderr: {}", stderr_of(&human));
    assert_eq!(stdout_of(&human), stdout_of(&fs_human), "remote human lines match fs");
    assert!(stdout_of(&human).contains("Unpromoted cuts"), "{}", stdout_of(&human));
}

#[test]
fn remote_plan_reads_an_old_server_without_unpromoted_cuts() {
    // 规格「plan 回应 payload」Scenario「旧 server 缺尚未转出的刀」：读作空，人眼不印该段。
    let old = r#"{"waves":[{"index":1,"changes":["add-a"]}],"changes":[{"name":"add-a","wave":1,"stage":"proposed","dependsOn":[],"overlaps":[],"blockedBy":[],"ready":true,"requirementOverlap":[],"archiveAfter":[]}],"next":"add-a","skipped":[]}"#;
    let mock = mock_server(vec![("GET", "/plan".into(), 200, old.to_string())]);
    let remote = TempProject::remote("cuts-old", &mock.base);
    let out = remote.run(&["plan", "--json"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    let payload: serde_json::Value = serde_json::from_str(&stdout_of(&out)).expect("JSON");
    assert_eq!(payload["unpromotedCuts"], serde_json::json!([]));
    let human = remote.run(&["plan", "--no-color"]);
    assert!(human.status.success(), "stderr: {}", stderr_of(&human));
    assert!(!stdout_of(&human).contains("Unpromoted cuts"), "{}", stdout_of(&human));
}

#[test]
fn remote_plan_cycle_exits_non_zero_with_the_engine_line() {
    // Scenario「remote 成环」：server 回 409 refused，stderr 与 fs 模式同一句。
    let fs = TempProject::at("cycle-fs");
    fs.put_change("add-a", "schema: spec-driven\ncreated: 2026-09-01\ndepends_on: add-b\n");
    fs.put_change("add-b", "schema: spec-driven\ncreated: 2026-09-01\ndepends_on: add-a\n");
    let fs_out = fs.run(&["plan", "--json"]);
    assert!(!fs_out.status.success());

    let mock = mock_server(vec![(
        "GET",
        "/plan".into(),
        409,
        r#"{"status":409,"reason":"refused","message":"dependency cycle: add-a -> add-b -> add-a"}"#
            .into(),
    )]);
    let remote = TempProject::remote("cycle-remote", &mock.base);
    let out = remote.run(&["plan", "--json"]);
    assert!(!out.status.success(), "a cycle exits non-zero");
    assert!(
        stderr_of(&out).contains("dependency cycle: add-a -> add-b -> add-a"),
        "stderr: {}",
        stderr_of(&out)
    );
    assert_eq!(stderr_of(&out), stderr_of(&fs_out), "the same line as fs mode");
    assert!(stdout_of(&out).is_empty(), "stdout stays empty");
}

#[test]
fn remote_plan_strict_overlap_asks_the_server() {
    // verb-contract「plan 的 --strict-overlap 于 remote 同形」（改写自
    // remote_plan_refuses_strict_overlap_without_a_request）：旗标不再被拒绝，remote
    // 臂握手后打 GET /plan，把 server 的计划照本机同一个输出函数印出。带上的查找参数
    // 与两模式逐比特相同由 remote_read_verbs 对真的入口验证。
    let mock = mock_server(vec![(
        "GET",
        "/plan".into(),
        200,
        r#"{"waves":[{"index":1,"changes":["add-a"]},{"index":2,"changes":["add-b"]}],"changes":[{"name":"add-a","wave":1,"stage":"proposed","ready":true},{"name":"add-b","wave":2,"stage":"proposed","blockedBy":["add-a"],"ready":false}],"next":"add-a","skipped":[],"strictOverlap":true}"#
            .into(),
    )]);
    let remote = TempProject::remote("strict-remote", &mock.base);
    let out = remote.run(&["plan", "--strict-overlap", "--json"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    let plan: serde_json::Value = serde_json::from_str(&stdout_of(&out)).expect("plan --json is JSON");
    assert_eq!(plan["changes"][1]["blockedBy"], serde_json::json!(["add-a"]));
    assert_eq!(mock.verb_calls(), ["GET /plan"]);
}

#[test]
fn remote_plan_strict_overlap_refuses_a_server_that_does_not_know_the_flag() {
    // 旧版 server 不认得 strictOverlap，照样回一般的计划（没有 strictOverlap 键）。CLI
    // 不能把它当成严格重叠的结果印出来：非 0 结束、stdout 空、stderr 说明原因。
    let mock = mock_server(vec![(
        "GET",
        "/plan".into(),
        200,
        r#"{"waves":[{"index":1,"changes":["add-a","add-b"]}],"changes":[{"name":"add-a","wave":1,"stage":"proposed","ready":true},{"name":"add-b","wave":1,"stage":"proposed","ready":true}],"next":"add-a","skipped":[]}"#
            .into(),
    )]);
    let remote = TempProject::remote("strict-old-server", &mock.base);
    for args in [&["plan", "--strict-overlap"][..], &["plan", "--strict-overlap", "--json"]] {
        let out = remote.run(args);
        assert!(!out.status.success(), "{args:?}");
        assert!(stdout_of(&out).is_empty(), "{args:?}: {}", stdout_of(&out));
        assert!(
            stderr_of(&out).contains("this server does not support plan --strict-overlap"),
            "{args:?}: {}",
            stderr_of(&out)
        );
    }
    // Without the flag the same server's plan prints as before.
    assert!(remote.run(&["plan", "--json"]).status.success());
}

// --- change depends ---

#[test]
fn remote_change_depends_posts_the_body_and_prints_the_fs_line() {
    // Scenario「remote 写入前置」：body 为 {"on":[…],"remove":false}，成功行与
    // --json 皆与 fs 模式同形。
    let fs = TempProject::at("depends-fs");
    fs.put_change("add-a", "schema: spec-driven\ncreated: 2026-09-01\n");
    fs.put_change("add-b", "schema: spec-driven\ncreated: 2026-09-02\n");
    let fs_line = fs.run(&["change", "depends", "add-b", "--on", "add-a", "--no-color"]);
    assert!(fs_line.status.success(), "fs stderr: {}", stderr_of(&fs_line));
    let fs_json = fs.run(&["change", "depends", "add-b", "--on", "add-a", "--json"]);
    let fs_removed =
        fs.run(&["change", "depends", "add-b", "--on", "add-a", "--remove", "--no-color"]);
    assert!(fs_removed.status.success(), "fs stderr: {}", stderr_of(&fs_removed));

    let added = mock_server(vec![(
        "POST",
        "/changes/add-b/depends".into(),
        200,
        r#"{"change":"add-b","dependsOn":["add-a"]}"#.into(),
    )]);
    let remote = TempProject::remote("depends-remote", &added.base);
    let out = remote.run(&["change", "depends", "add-b", "--on", "add-a", "--no-color"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(stdout_of(&out), "✓ add-b depends on: add-a\n");
    assert_eq!(stdout_of(&out), stdout_of(&fs_line));
    assert_eq!(added.body_of("POST", "/changes/add-b/depends"), r#"{"on":["add-a"],"remove":false}"#);
    let json = remote.run(&["change", "depends", "add-b", "--on", "add-a", "--json"]);
    assert_eq!(stdout_of(&json), stdout_of(&fs_json), "--json matches fs");

    let removed = mock_server(vec![(
        "POST",
        "/changes/add-b/depends".into(),
        200,
        r#"{"change":"add-b","dependsOn":[]}"#.into(),
    )]);
    let remote = TempProject::remote("depends-remote-rm", &removed.base);
    let out =
        remote.run(&["change", "depends", "add-b", "--on", "add-a", "--remove", "--no-color"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(stdout_of(&out), stdout_of(&fs_removed));
    assert_eq!(removed.body_of("POST", "/changes/add-b/depends"), r#"{"on":["add-a"],"remove":true}"#);
}

#[test]
fn remote_change_depends_refusals_print_the_engine_line() {
    // 404 与守门 409 的 message 为引擎原文：stderr 与 fs 模式同一句、exit 非零。
    let fs = TempProject::at("refuse-fs");
    fs.put_change("add-b", "schema: spec-driven\ncreated: 2026-09-02\n");
    let fs_self = fs.run(&["change", "depends", "add-b", "--on", "add-b"]);
    let fs_ghost = fs.run(&["change", "depends", "ghost", "--on", "add-b"]);
    assert!(!fs_self.status.success() && !fs_ghost.status.success());

    let mock = mock_server(vec![
        (
            "POST",
            "/changes/add-b/depends".into(),
            409,
            r#"{"status":409,"reason":"refused","message":"'add-b' cannot depend on itself"}"#.into(),
        ),
        (
            "POST",
            "/changes/ghost/depends".into(),
            404,
            r#"{"status":404,"reason":"not_found","message":"Change 'ghost' not found."}"#.into(),
        ),
    ]);
    let remote = TempProject::remote("refuse-remote", &mock.base);
    let out = remote.run(&["change", "depends", "add-b", "--on", "add-b"]);
    assert!(!out.status.success());
    assert_eq!(stderr_of(&out), stderr_of(&fs_self));
    assert!(stdout_of(&out).is_empty());
    let out = remote.run(&["change", "depends", "ghost", "--on", "add-b"]);
    assert!(!out.status.success());
    assert_eq!(stderr_of(&out), stderr_of(&fs_ghost));
}
