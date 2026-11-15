//! `specseal archive` 的 fail-closed 合并守门 — fs 模式契约
//! (spec archive-merge「封存合并 fail-closed 守门」「两阶段合并计划与零半套写入」)。
//!
//! 过期或自相矛盾的 delta 以非零 exit code 拒绝:stderr 逐条列明 capability／
//! 操作／需求名／原因并附 drift → ingest 补救动线,正典未动、无 snapshot、
//! change 留在原位。批量封存的预检读同一判定,以拒绝语意提前过滤。

use std::path::PathBuf;
use std::process::{Command, Output};

const META: &str = "schema: spec-driven\ncreated: 2026-07-01\n";
const CANONICAL: &str = "# demo-cap Specification\n\n## Purpose\n\nDemo.\n\n## Requirements\n\n### Requirement: Demo works\n\nIt SHALL work.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n";
/// 撞名的 ADDED:正典已有「Demo works」——旧引擎静默跳过,新引擎拒绝。
const STALE_DELTA: &str = "## ADDED Requirements\n\n### Requirement: Demo works\n\nIt SHALL work.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n";

struct TempProject {
    dir: PathBuf,
}

impl TempProject {
    /// 一份完备的 change `demo`(任务全勾),delta 与正典由调用端给定;无 git,
    /// @trace 探测 fail soft。
    fn new(tag: &str, delta: &str, canonical: Option<&str>) -> TempProject {
        let dir = std::env::temp_dir()
            .join(format!("specseal-cli-merge-gate-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".specseal.yaml"), "tools:\n  - claude\n").unwrap();
        let change = dir.join("specseal").join("changes").join("demo");
        std::fs::create_dir_all(change.join("specs").join("demo-cap")).unwrap();
        std::fs::write(change.join(".meta.yaml"), META).unwrap();
        std::fs::write(change.join("proposal.md"), "## Why\n\nDemo.\n").unwrap();
        std::fs::write(change.join("tasks.md"), "- [x] 1.1 a\n").unwrap();
        std::fs::write(change.join("specs").join("demo-cap").join("spec.md"), delta).unwrap();
        if let Some(text) = canonical {
            let canon = dir.join("specseal").join("specs").join("demo-cap");
            std::fs::create_dir_all(&canon).unwrap();
            std::fs::write(canon.join("spec.md"), text).unwrap();
        }
        TempProject { dir }
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_specseal"))
            .args(args)
            .current_dir(&self.dir)
            .env_remove("SPECSEAL_STORE_URL")
            .env_remove("SPECSEAL_TOKEN")
            .output()
            .expect("run specseal binary")
    }

    fn canonical_spec(&self) -> String {
        std::fs::read_to_string(
            self.dir.join("specseal").join("specs").join("demo-cap").join("spec.md"),
        )
        .unwrap()
    }

    fn change_dir(&self) -> PathBuf {
        self.dir.join("specseal").join("changes").join("demo")
    }

    fn snapshots_dir(&self) -> PathBuf {
        self.dir.join(".specseal").join("snapshots")
    }
}

impl Drop for TempProject {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn stderr_of(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).to_string()
}

#[test]
fn stale_delta_refuses_with_a_named_violation_and_the_remediation_route() {
    // spec Scenario「过期 ADDED 被拒绝」的人眼面:--no-color 下 stderr 逐条列明
    // capability／操作／需求名／原因,并指出 drift → ingest 的补救动线。
    let p = TempProject::new("refuse", STALE_DELTA, Some(CANONICAL));
    let out = p.run(&["archive", "demo", "--no-color"]);
    assert!(!out.status.success(), "a stale delta must refuse archive");
    let stderr = stderr_of(&out);
    assert!(stderr.contains("demo-cap"), "capability named: {stderr}");
    assert!(stderr.contains("ADDED"), "operation named: {stderr}");
    assert!(stderr.contains("Demo works"), "requirement named: {stderr}");
    assert!(stderr.contains("already exists"), "reason given: {stderr}");
    assert!(stderr.contains("specseal drift demo"), "drift remediation named: {stderr}");
    assert!(stderr.contains("specseal-ingest demo"), "ingest remediation named: {stderr}");
    assert!(!stderr.contains("\u{1b}["), "--no-color leaves no ANSI escapes: {stderr}");
}

#[test]
fn a_refused_archive_leaves_zero_file_effect() {
    // spec「两阶段合并计划与零半套写入」:拒绝后正典逐比特不变、无 snapshot 目录、
    // change 仍在进行区原位。
    let p = TempProject::new("zero-effect", STALE_DELTA, Some(CANONICAL));
    let out = p.run(&["archive", "demo"]);
    assert!(!out.status.success());
    assert_eq!(p.canonical_spec(), CANONICAL, "canonical spec byte-identical");
    assert!(p.change_dir().join("tasks.md").is_file(), "change stays in the active area");
    assert!(!p.snapshots_dir().exists(), "no snapshot directory was created");
}

#[test]
fn no_validate_does_not_unlock_the_merge_gate() {
    // spec Scenario「no-validate 不解锁守门」:文档验证略过,合并守门照常拒绝。
    let p = TempProject::new("no-validate", STALE_DELTA, Some(CANONICAL));
    let out = p.run(&["archive", "demo", "--no-validate"]);
    assert!(!out.status.success(), "--no-validate must not unlock the merge gate");
    assert!(stderr_of(&out).contains("already exists"), "gate still speaks: {}", stderr_of(&out));
}

#[test]
fn bulk_archive_prefilters_with_the_same_verdict_in_refusal_wording() {
    // spec「过期判定单源共用」的批量面:预检读引擎的判定,以拒绝语意提前过滤,
    // 该 change 未被封存。
    let p = TempProject::new("bulk", STALE_DELTA, Some(CANONICAL));
    let out = p.run(&["archive", "--all", "--no-color"]);
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("Skipped: demo"), "the change is pre-filtered: {stdout}");
    assert!(stdout.contains("archive would refuse"), "refusal wording, not skip: {stdout}");
    assert!(p.change_dir().join("tasks.md").is_file(), "change stays in the active area");
    assert_eq!(p.canonical_spec(), CANONICAL, "canonical spec untouched");
}

#[test]
fn bulk_archive_names_the_missing_purpose_in_the_skip_reason() {
    // spec archive-merge「新 capability 缺 Purpose 的违规呈现三处一致」的批量面：
    // 略过原因不只给计数，点名缺 `## Purpose` 的 capability。
    const NO_PURPOSE_DELTA: &str = "## ADDED Requirements\n\n### Requirement: Fresh\n\nIt SHALL work.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n";
    let p = TempProject::new("bulk-purpose", NO_PURPOSE_DELTA, None);
    let out = p.run(&["archive", "--all", "--no-color"]);
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("Skipped: demo"), "the change is pre-filtered: {stdout}");
    assert!(stdout.contains("## Purpose"), "the real cause is named: {stdout}");
    assert!(stdout.contains("demo-cap"), "the offending capability is named: {stdout}");
}

#[test]
fn a_refused_archive_leaves_tasks_untouched_even_with_mark_tasks_complete() {
    // 零文件效果涵盖 --mark-tasks-complete 的前置全勾:守门拒绝时 tasks.md
    // 必须逐比特不变——runtime 的守门顺序与 guard_meta 同(先守门、后预写)。
    let p = TempProject::new("mark-gate", STALE_DELTA, Some(CANONICAL));
    const OPEN_TASKS: &str = "- [ ] 1.1 a\n";
    std::fs::write(p.change_dir().join("tasks.md"), OPEN_TASKS).unwrap();
    let out = p.run(&["archive", "demo", "--mark-tasks-complete"]);
    assert!(!out.status.success(), "the merge gate still refuses");
    assert!(stderr_of(&out).contains("already exists"), "gate speaks: {}", stderr_of(&out));
    let tasks = std::fs::read_to_string(p.change_dir().join("tasks.md")).unwrap();
    assert_eq!(tasks, OPEN_TASKS, "tasks.md byte-identical after a refused archive");
}

#[test]
fn bulk_archive_with_skip_specs_is_not_prefiltered_by_the_merge_gate() {
    // --skip-specs 整段跳过规格套用(spec「封存合并 fail-closed 守门」),引擎
    // 守门不会跑,预检也就不得以「archive would refuse」滤掉——否则预检与引擎分歧。
    let p = TempProject::new("bulk-skip", STALE_DELTA, Some(CANONICAL));
    let out = p.run(&["archive", "--all", "--skip-specs", "--no-color"]);
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        !stdout.contains("Skipped: demo"),
        "skip-specs bulk must not pre-filter on the merge gate: {stdout}"
    );
    assert!(!p.change_dir().exists(), "change archived: {stdout}");
    assert_eq!(p.canonical_spec(), CANONICAL, "canonical spec untouched (specs skipped)");
}

#[test]
fn a_clean_delta_still_archives_and_merges() {
    // 回归网:未过期的 delta 照常封存并并入正典——守门只挡不符项。
    const FRESH: &str = "## ADDED Requirements\n\n### Requirement: Demo also logs\n\nIt SHALL log.\n\n#### Scenario: logs\n\n- **WHEN** used\n- **THEN** logs\n";
    let p = TempProject::new("clean", FRESH, Some(CANONICAL));
    let out = p.run(&["archive", "demo"]);
    assert!(out.status.success(), "a clean delta archives: {}", stderr_of(&out));
    let canon = p.canonical_spec();
    assert!(canon.contains("### Requirement: Demo works"), "existing requirement kept: {canon}");
    assert!(canon.contains("### Requirement: Demo also logs"), "delta merged in: {canon}");
    assert!(!p.change_dir().exists(), "change moved into the archive");
}
