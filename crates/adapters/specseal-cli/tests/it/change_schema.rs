//! `specseal change schema` — fs 模式契约（workflow-schemas「change schema 动词切换
//! 变更的 schema」与「schema 没有 specs 产出时拒绝写入 delta spec」）。
//!
//! 每个拒绝都断言 `.meta.yaml` 逐比特不变；worktree 映射的情境在
//! worktree_overlay.rs（要真实 git repo）。user 层 schema 位置导进暂存项目，
//! 开发者的 home 不影响结果。

use std::path::PathBuf;
use std::process::{Command, Output};

const SPEC_META: &str = "schema: spec-driven\ncreated: 2026-10-01\n";
const NO_SPEC_META: &str = "schema: no-spec-change\ncreated: 2026-10-01\n";
const DELTA: &str = "## ADDED Requirements\n\n### Requirement: Login\n\nIt SHALL log in.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n";
const CANON_AUTH: &str = "# auth Specification\n\n## Purpose\n\nAuth session lifecycle used by the change schema tests.\n\n## Requirements\n";

struct TempProject {
    dir: PathBuf,
}

impl TempProject {
    fn new(tag: &str) -> TempProject {
        let dir = std::env::temp_dir().join(format!(
            "specseal-cli-change-schema-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("specseal").join("specs").join("auth")).unwrap();
        std::fs::create_dir_all(dir.join("home")).unwrap();
        std::fs::write(dir.join(".specseal.yaml"), "tools:\n  - claude\n").unwrap();
        std::fs::write(dir.join("specseal").join("specs").join("auth").join("spec.md"), CANON_AUTH)
            .unwrap();
        TempProject { dir }
    }

    /// 一个作用中变更：`.meta.yaml` 与一份 proposal。
    fn change(&self, name: &str, meta: &str) -> PathBuf {
        let dir = self.dir.join("specseal").join("changes").join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".meta.yaml"), meta).unwrap();
        std::fs::write(dir.join("proposal.md"), "## Why\n\nDemo.\n").unwrap();
        dir
    }

    fn meta(&self, name: &str) -> String {
        std::fs::read_to_string(
            self.dir.join("specseal").join("changes").join(name).join(".meta.yaml"),
        )
        .unwrap()
    }

    fn run(&self, args: &[&str]) -> Output {
        self.run_stdin(args, None)
    }

    fn run_stdin(&self, args: &[&str], stdin: Option<&str>) -> Output {
        use std::io::Write;
        let mut child = Command::new(env!("CARGO_BIN_EXE_specseal"))
            .args(args)
            .current_dir(&self.dir)
            .env("NO_COLOR", "1")
            .env("HOME", self.dir.join("home"))
            .env("USERPROFILE", self.dir.join("home"))
            .env_remove("XDG_CONFIG_HOME")
            .env_remove("SPECSEAL_STORE_URL")
            .env_remove("SPECSEAL_TOKEN")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("run specseal binary");
        if let Some(text) = stdin {
            child.stdin.take().unwrap().write_all(text.as_bytes()).unwrap();
        }
        drop(child.stdin.take());
        child.wait_with_output().unwrap()
    }
}

impl Drop for TempProject {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn stdout_of(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).to_string()
}

fn stderr_of(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).to_string()
}

#[test]
fn change_schema_switches_to_no_spec_change() {
    // Scenario「切到不改规格」。
    let p = TempProject::new("switch");
    p.change("tidy", SPEC_META);
    let out = p.run(&["change", "schema", "tidy", "no-spec-change"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(stdout_of(&out), "✓ tidy schema: spec-driven → no-spec-change\n");
    assert_eq!(p.meta("tidy"), NO_SPEC_META, "only the schema line changes");
}

#[test]
fn change_schema_json_reports_the_switch() {
    // Scenario「切回 spec-driven 并输出 JSON」。
    let p = TempProject::new("json");
    p.change("tidy", NO_SPEC_META);
    let out = p.run(&["change", "schema", "tidy", "spec-driven", "--json"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    let json: serde_json::Value = serde_json::from_slice(&out.stdout).expect("json stdout");
    assert_eq!(
        json,
        serde_json::json!({"change": "tidy", "schema": "spec-driven", "previous": "no-spec-change", "changed": true})
    );
}

#[test]
fn change_schema_refusals_exit_non_zero_and_leave_the_meta_untouched() {
    // Scenario「有 delta 时拒绝切到不改规格」「解析不到的 schema 拒绝」「未结验证工单时拒绝」。
    let p = TempProject::new("refusals");
    let c = p.change("c", SPEC_META);
    std::fs::create_dir_all(c.join("specs").join("auth")).unwrap();
    std::fs::write(c.join("specs").join("auth").join("spec.md"), DELTA).unwrap();
    let out = p.run(&["change", "schema", "c", "no-spec-change"]);
    assert!(!out.status.success());
    // 逐字：server 的 409 message（plan_api.rs）与这一行是同一句引擎原文。
    assert_eq!(
        stderr_of(&out),
        "Error: cannot switch 'c' to 'no-spec-change': 'no-spec-change' has no specs, but the change \
         has delta specs (auth) — remove them first\n"
    );
    assert_eq!(p.meta("c"), SPEC_META);

    let out = p.run(&["change", "schema", "c", "no-such-flow"]);
    assert!(!out.status.success());
    assert_eq!(
        stderr_of(&out),
        "Error: Schema not found: Schema 'no-such-flow' not found in project, user, or built-in locations\n"
    );
    assert_eq!(p.meta("c"), SPEC_META);

    // Scenario「不合法的 schema 名称在解析前拒绝」。
    for bad in ["../evil", "Spec-Driven"] {
        let out = p.run(&["change", "schema", "c", bad]);
        assert!(!out.status.success(), "{bad}");
        assert_eq!(
            stderr_of(&out),
            format!("Error: Invalid schema name '{bad}': must be lowercase kebab-case (e.g. my-flow)\n")
        );
        assert_eq!(p.meta("c"), SPEC_META);
    }

    std::fs::write(c.join("verify.md"), "# Verify\n").unwrap();
    let out = p.run(&["change", "schema", "c", "spec-driven"]);
    assert!(!out.status.success());
    assert!(stderr_of(&out).contains("specseal verify discard c"), "{}", stderr_of(&out));
    assert_eq!(p.meta("c"), SPEC_META);
    assert_eq!(std::fs::read_to_string(c.join("verify.md")).unwrap(), "# Verify\n", "ticket stays");
}

#[test]
fn change_schema_clears_the_verify_stamp_and_says_so() {
    // Scenario「切换时移除验证章、保留审查章与轮数」。
    let p = TempProject::new("clear-stamp");
    let stamps = "reviewed_at: 2026-10-02T10:00:00+08:00\nreviewed_rounds: 1\n\
verified_at: 2026-10-02T11:00:00+08:00\nverified_by: V <v@example.com>\nverified_with: claude\n\
verified_tasks_total: 3\nverified_rounds: 2\nverified_scope:\n  - path: src/a.rs\n    hash: bb\n";
    p.change("c", &format!("{NO_SPEC_META}{stamps}"));
    let out = p.run(&["change", "schema", "c", "spec-driven"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(
        stdout_of(&out),
        "✓ c schema: no-spec-change → spec-driven\n  verify stamp cleared — re-run verify under spec-driven\n"
    );
    assert_eq!(
        p.meta("c"),
        format!("{SPEC_META}reviewed_at: 2026-10-02T10:00:00+08:00\nreviewed_rounds: 1\nverified_rounds: 2\n")
    );
}

#[test]
fn change_schema_same_value_is_unchanged() {
    // Scenario「同一个 schema 不写档」。
    let p = TempProject::new("same");
    p.change("c", SPEC_META);
    let out = p.run(&["change", "schema", "c", "spec-driven"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(stdout_of(&out), "✓ c schema: spec-driven (unchanged)\n");
    assert_eq!(p.meta("c"), SPEC_META);
}

#[test]
fn change_schema_unknown_change_is_an_error() {
    // Scenario「变更不存在」。
    let p = TempProject::new("ghost");
    p.change("c", SPEC_META);
    let out = p.run(&["change", "schema", "ghost", "spec-driven"]);
    assert!(!out.status.success());
    assert!(stderr_of(&out).contains("ghost"), "{}", stderr_of(&out));
    assert!(!p.dir.join("specseal").join("changes").join("ghost").exists(), "nothing written");
    assert_eq!(p.meta("c"), SPEC_META);
}

#[test]
fn change_schema_refuses_a_change_folder_without_metadata() {
    // 名册列得出目录、却没有 `.meta.yaml`：拒绝且不凭空建出 meta。
    let p = TempProject::new("no-meta");
    let dir = p.dir.join("specseal").join("changes").join("bare");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("proposal.md"), "## Why\n\nDemo.\n").unwrap();
    let out = p.run(&["change", "schema", "bare", "no-spec-change"]);
    assert!(!out.status.success());
    assert_eq!(
        stderr_of(&out),
        "Error: cannot write schema for 'bare': specseal/changes/bare/.meta.yaml is missing\n"
    );
    assert!(!dir.join(".meta.yaml").exists(), "nothing written");
}

#[test]
fn change_schema_gate_on_new_artifact_spec() {
    // Scenario「不改规格变更写 delta 被拒」与「spec-driven 变更照常写入」。
    let p = TempProject::new("new-spec");
    let tidy = p.change("tidy", NO_SPEC_META);
    let out = p.run_stdin(&["new", "artifact", "spec", "auth", "--change", "tidy", "--stdin"], Some(DELTA));
    assert!(!out.status.success());
    let err = stderr_of(&out);
    assert!(
        err.contains("no-spec-change") && err.contains("specseal change schema tidy spec-driven"),
        "{err}"
    );
    assert!(!tidy.join("specs").exists(), "no specs/ appears");

    let c = p.change("c", SPEC_META);
    let out = p.run_stdin(&["new", "artifact", "spec", "auth", "--change", "c", "--stdin"], Some(DELTA));
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert!(c.join("specs").join("auth").join("spec.md").is_file());
}
