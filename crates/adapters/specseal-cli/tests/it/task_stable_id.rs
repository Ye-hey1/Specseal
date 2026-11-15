//! `specseal task done` / `task undone` 的 tsk_ stable ID 值域（task-identity
//! spec、verb-contract 值域扩充）：--json 形状与数字值域一致、行尾注解原文
//! 保留、非法值错误叙述修订、查无此 ID 与超界对称。
//! 数字值域的冻结输出由 task_done_stamps.rs／task_undone.rs 钉住。

use std::path::PathBuf;
use std::process::{Command, Output};

const META: &str = "schema: spec-driven\ncreated: 2026-07-01\ncreated_by: Base Line <base@example.com>\ncreated_with: claude\n";
const TID_A: &str = "tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TID_B: &str = "tsk_01BX5ZZKBKACTAV9WEVGEMMVRZ";

/// 带 ID 的任务档：第 1 任务未勾（供 done）、第 2 任务已勾（供 undone）。
fn tasks_md() -> String {
    format!(
        "## 1. Group\n\n- [ ] 1.1 First <!-- specseal-task:{TID_A} -->\n- [x] 1.2 Second <!-- specseal-task:{TID_B} -->\n"
    )
}

struct TempProject {
    dir: PathBuf,
}

impl TempProject {
    fn new(tag: &str, tasks_md: &str) -> TempProject {
        let dir = std::env::temp_dir().join(format!(
            "specseal-cli-taskstableid-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let change = dir.join("specseal").join("changes").join("demo");
        std::fs::create_dir_all(&change).unwrap();
        std::fs::write(change.join(".meta.yaml"), META).unwrap();
        std::fs::write(change.join("tasks.md"), tasks_md).unwrap();
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

    fn tasks(&self) -> String {
        std::fs::read_to_string(
            self.dir.join("specseal").join("changes").join("demo").join("tasks.md"),
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
fn done_by_stable_id_json_shape_matches_numeric_domain() {
    let p = TempProject::new("donejson", &tasks_md());
    let out = p.run(&["task", "done", TID_A, "--change", "demo", "--json"]);

    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    // Compact 单行 JSON、键序与数字值域一致；task_id 原样回填 argv。
    assert_eq!(
        String::from_utf8_lossy(&out.stdout),
        format!(
            "{{\"change\":\"demo\",\"status\":\"done\",\"task_desc\":\"1.1 First\",\"task_id\":\"{TID_A}\"}}\n"
        )
    );
    // 仅目标行翻转，行尾注解原文保留。
    assert_eq!(
        p.tasks(),
        format!(
            "## 1. Group\n\n- [x] 1.1 First <!-- specseal-task:{TID_A} -->\n- [x] 1.2 Second <!-- specseal-task:{TID_B} -->\n"
        )
    );
}

#[test]
fn undone_by_stable_id_json_shape_and_comment_preserved() {
    let p = TempProject::new("undonejson", &tasks_md());
    let out = p.run(&["task", "undone", TID_B, "--change", "demo", "--json"]);

    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(
        String::from_utf8_lossy(&out.stdout),
        format!(
            "{{\"change\":\"demo\",\"status\":\"undone\",\"task_desc\":\"1.2 Second\",\"task_id\":\"{TID_B}\"}}\n"
        )
    );
    assert_eq!(
        p.tasks(),
        format!(
            "## 1. Group\n\n- [ ] 1.1 First <!-- specseal-task:{TID_A} -->\n- [ ] 1.2 Second <!-- specseal-task:{TID_B} -->\n"
        )
    );
}

#[test]
fn stable_id_human_output_echoes_the_id() {
    let p = TempProject::new("human", &tasks_md());
    let out = p.run(&["task", "done", TID_A, "--change", "demo"]);

    assert!(out.status.success());
    assert_eq!(
        String::from_utf8_lossy(&out.stdout),
        format!("✓ Task {TID_A} marked as done: 1.1 First\n"),
        "human output echoes the typed stable id (piped stdout → no color)"
    );
}

#[test]
fn neither_numeric_nor_tsk_prefixed_value_errors() {
    let p = TempProject::new("badvalue", &tasks_md());
    let before = p.tasks();
    let out = p.run(&["task", "done", "abc", "--change", "demo"]);

    assert!(!out.status.success());
    assert_eq!(
        String::from_utf8_lossy(&out.stderr),
        "Error: Invalid task ID 'abc': must be a number or a tsk_-prefixed stable ID\n"
    );
    assert_eq!(p.tasks(), before, "error paths must leave tasks.md untouched");
}

#[test]
fn unknown_stable_id_errors_symmetric_to_out_of_range() {
    let p = TempProject::new("unknown", &tasks_md());
    let before = p.tasks();
    let out = p.run(&["task", "done", "tsk_01ZZZZZZZZZZZZZZZZZZZZZZZZZZ", "--change", "demo"]);

    assert!(!out.status.success());
    assert_eq!(
        String::from_utf8_lossy(&out.stderr),
        "Error: Task tsk_01ZZZZZZZZZZZZZZZZZZZZZZZZZZ not found (total: 2)\n"
    );
    assert_eq!(p.tasks(), before);
}
