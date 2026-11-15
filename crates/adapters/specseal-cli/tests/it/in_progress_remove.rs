//! `specseal in-progress remove` — 退回提案中动词的 fs 模式契约
//! (change-lifecycle spec「in-progress 标记可自 change meta 移除(零工作痕迹守门)」)。
//!
//! 与 `in-progress add` 刻意不对称:add 对未知名称静默成功(parity 冻结),
//! remove 是修正动词、打错名字必须明确报错。add 的既有输出与 exit code 不变。

use std::path::PathBuf;
use std::process::{Command, Output};

const META: &str = "schema: spec-driven\ncreated: 2026-07-01\ncreated_by: Base Line <base@example.com>\ncreated_with: claude\n";
const STARTED_LINES: &str = "started_at: 2026-07-28\nstarted_by: Sandbox Tester <sandbox@example.com>\nstarted_with: claude\n";

struct TempProject {
    dir: PathBuf,
}

impl TempProject {
    /// Throwaway project: one change with the given meta, rooted in a git repo
    /// with a deterministic local identity.
    fn new(tag: &str, meta: &str) -> TempProject {
        let dir = std::env::temp_dir().join(format!(
            "specseal-cli-inprogressremove-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let change = dir.join("specseal").join("changes").join("demo");
        std::fs::create_dir_all(&change).unwrap();
        std::fs::write(change.join(".meta.yaml"), meta).unwrap();
        let git = |args: &[&str]| {
            let ok = Command::new("git")
                .args(args)
                .current_dir(&dir)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            assert!(ok, "git {args:?} failed");
        };
        git(&["init", "-q"]);
        git(&["config", "user.name", "Sandbox Tester"]);
        git(&["config", "user.email", "sandbox@example.com"]);
        TempProject { dir }
    }

    fn put_tasks(&self, tasks_md: &str) {
        std::fs::write(
            self.dir.join("specseal").join("changes").join("demo").join("tasks.md"),
            tasks_md,
        )
        .unwrap();
    }

    fn put_touched(&self, json: &str) {
        let dir = self.dir.join(".specseal").join("touched");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("demo.json"), json).unwrap();
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_specseal"))
            .args(args)
            .current_dir(&self.dir)
            .env_remove("SPECSEAL_STORE_URL")
            .env_remove("SPECSEAL_TOKEN")
            .env_remove("NO_COLOR")
            .env_remove("CLICOLOR")
            .env_remove("CLICOLOR_FORCE")
            .output()
            .expect("run specseal binary")
    }

    fn meta(&self) -> String {
        std::fs::read_to_string(
            self.dir
                .join("specseal")
                .join("changes")
                .join("demo")
                .join(".meta.yaml"),
        )
        .unwrap()
    }
}

impl Drop for TempProject {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn zero_trace_change_removes_marker_and_prints_confirmation() {
    let p = TempProject::new("clean", &format!("{META}{STARTED_LINES}"));
    let out = p.run(&["in-progress", "remove", "demo"]);

    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(
        String::from_utf8_lossy(&out.stdout),
        "✓ Removed the in-progress marker from 'demo' — back to proposed\n"
    );
    assert_eq!(p.meta(), META, "started_* removed, every other line byte-identical");
}

#[test]
fn not_started_change_is_idempotent_success() {
    let p = TempProject::new("idempotent", META);
    let out = p.run(&["in-progress", "remove", "demo"]);

    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(
        String::from_utf8_lossy(&out.stdout),
        "Change 'demo' has no in-progress marker — already proposed\n"
    );
    assert_eq!(p.meta(), META, "idempotent pass must not write");
}

#[test]
fn checked_tasks_block_with_count_and_way_out_on_stderr() {
    let p = TempProject::new("checked", &format!("{META}{STARTED_LINES}"));
    p.put_tasks("## 1. Group\n\n- [x] 1.1 First\n- [x] 1.2 Second\n- [ ] 1.3 Third\n");
    let out = p.run(&["in-progress", "remove", "demo"]);

    assert!(!out.status.success(), "work traces must exit non-zero");
    assert_eq!(String::from_utf8_lossy(&out.stdout), "");
    assert_eq!(
        String::from_utf8_lossy(&out.stderr),
        "Error: cannot remove the in-progress marker for 'demo': work traces exist\n  checked tasks: 2 — uncheck them (specseal task undone) and retry\n"
    );
    assert_eq!(p.meta(), format!("{META}{STARTED_LINES}"), "refusal must not touch the meta");
}

#[test]
fn touched_record_blocks_with_file_list_and_way_out_on_stderr() {
    let p = TempProject::new("touched", &format!("{META}{STARTED_LINES}"));
    p.put_touched(
        "{\"version\":2,\"change\":\"demo\",\"touched\":[{\"task_id\":\"1\",\"task_desc\":\"1.1 First\",\"files\":[\"src/a.rs\",\"src/b.ts\"]}]}",
    );
    let out = p.run(&["in-progress", "remove", "demo"]);

    assert!(!out.status.success(), "touched records must exit non-zero");
    assert_eq!(
        String::from_utf8_lossy(&out.stderr),
        "Error: cannot remove the in-progress marker for 'demo': work traces exist\n  touched files: src/a.rs, src/b.ts\n  touched records may mix work from other changes — have an agent or a human judge them (no mechanical cleanup)\n"
    );
    assert_eq!(p.meta(), format!("{META}{STARTED_LINES}"), "refusal must not touch the meta");
}

#[test]
fn unknown_change_errors_not_found() {
    let p = TempProject::new("unknown", META);
    let out = p.run(&["in-progress", "remove", "ghost"]);

    assert!(!out.status.success(), "unknown change must exit non-zero");
    assert_eq!(
        String::from_utf8_lossy(&out.stderr),
        "Error: Change 'ghost' not found.\n"
    );
}

#[test]
fn in_progress_add_keeps_its_frozen_silent_shape() {
    // add 的 parity 冻结不受新子指令影响:静默 exit 0、无输出,未知名称同样静默。
    let p = TempProject::new("addparity", META);
    let out = p.run(&["in-progress", "add", "demo"]);

    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), "");
    assert_eq!(String::from_utf8_lossy(&out.stderr), "");
    assert!(p.meta().contains("started_at: "), "add still stamps");

    let out = p.run(&["in-progress", "add", "ghost"]);
    assert!(out.status.success(), "unknown-name add keeps the silent success");
    assert_eq!(String::from_utf8_lossy(&out.stdout), "");
}
