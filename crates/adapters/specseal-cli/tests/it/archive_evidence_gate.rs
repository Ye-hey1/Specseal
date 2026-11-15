//! `specseal archive` 的零证据提示与 @trace 形状 — fs 模式契约
//! (spec verify-evidence「archive trace 注入与零证据提示」)。
//!
//! 四件事在此钉死：批量封存不再要求整洁工作树（其存在理由——脏档会混入每个
//! change 的 @trace code 清单——已随清单移除而消失）、零证据的封存照常成功且
//! stderr 恰一行提示（有证据时一字不印）、正典 @trace 仅 source 与 updated
//! 两栏且一律注入、证据记录随 change 目录进封存区或随 discard 消失。封存从不
//! 因 evidence 被挡——放行旗标与守门在讨论 evidence-gate-false-blocks 后整套
//! 退场，`--help` 亦不得再出现。

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const META: &str = "schema: spec-driven\ncreated: 2026-07-01\n";
/// 新开 capability 的 delta 自带合格 Purpose——缺席会被封存的 Purpose 守门挡下
/// （spec archive-merge「新 capability 的 Purpose 自 delta 带入」）。
const DELTA_SPEC: &str = "## Purpose\n\n本 capability 是测试用的示范能力，涵盖一个可观察行为与其成功路径，供封存流程的守门测试取用。\n\n## ADDED Requirements\n\n### Requirement: Demo works\n\nIt SHALL work.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n";

struct TempProject {
    dir: PathBuf,
}

impl TempProject {
    /// 项目根是 git repo 且带一个脏的程序档：`task done` 需要可归属的脏档才会
    /// 写证据，而脏工作树本身已不再是封存的前提。
    fn new(tag: &str) -> TempProject {
        let dir = std::env::temp_dir()
            .join(format!("specseal-cli-evidence-gate-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".specseal.yaml"), "tools:\n  - claude\n").unwrap();
        git(&dir, &["init", "-q"]);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src").join("dirty.rs"), "fn dirty() {}\n").unwrap();
        TempProject { dir }
    }

    /// 一份结构完备、任务全勾的 change。
    fn add_change(&self, name: &str, capability: &str) {
        let change = self.dir.join("specseal").join("changes").join(name);
        std::fs::create_dir_all(change.join("specs").join(capability)).unwrap();
        std::fs::write(change.join(".meta.yaml"), META).unwrap();
        std::fs::write(change.join("proposal.md"), "## Why\n\nDemo.\n").unwrap();
        std::fs::write(change.join("tasks.md"), "- [x] 1.1 a\n").unwrap();
        std::fs::write(change.join("specs").join(capability).join("spec.md"), DELTA_SPEC).unwrap();
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

    fn change_dir(&self, name: &str) -> PathBuf {
        self.dir.join("specseal").join("changes").join(name)
    }

    fn canonical_spec(&self, capability: &str) -> String {
        std::fs::read_to_string(
            self.dir.join("specseal").join("specs").join(capability).join("spec.md"),
        )
        .unwrap()
    }
}

impl Drop for TempProject {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn git(root: &Path, args: &[&str]) {
    let ok = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    assert!(ok, "git {args:?} failed");
}

fn stderr_of(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).to_string()
}

fn stdout_of(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).to_string()
}

/// 让 change 带上真实的证据记录——走引擎自己的写入路径（需要可归属的脏档）。
fn record_real_evidence(p: &TempProject, change: &str) {
    let out = p.run(&["task", "undone", "--change", change, "1"]);
    assert!(out.status.success(), "undone: {}", stderr_of(&out));
    let out = p.run(&["task", "done", "--change", change, "1"]);
    assert!(out.status.success(), "done: {}", stderr_of(&out));
    assert!(
        p.change_dir(change).join(".evidence.json").is_file(),
        "task done must write the evidence record into the change directory"
    );
}

#[test]
fn a_change_without_evidence_archives_and_gets_exactly_one_note() {
    // spec Scenario「零证据照常封存并提示」：纯规格 change 挣不到证据——封存照常
    // 成功（exit 0），stderr 恰一行提示点名该 change，且不含任何守门或旗标字眼。
    let p = TempProject::new("note-missing");
    p.add_change("demo", "demo-cap");
    let out = p.run(&["archive", "demo", "--no-color"]);
    assert!(out.status.success(), "zero evidence must not block: {}", stderr_of(&out));
    let stderr = stderr_of(&out);
    let notes: Vec<&str> =
        stderr.lines().filter(|l| l.contains("no task evidence recorded")).collect();
    assert_eq!(notes.len(), 1, "exactly one note line: {stderr}");
    assert!(notes[0].contains("demo"), "the note names the change: {stderr}");
    assert!(!stderr.contains("\u{1b}["), "--no-color leaves no ANSI escapes: {stderr}");
    assert!(!stderr.contains("waive"), "no flag is offered — there is nothing to waive: {stderr}");
    assert!(!p.change_dir("demo").exists(), "the change still archives");
    let canon = p.canonical_spec("demo-cap");
    assert!(canon.contains("<!-- @trace\nsource: demo\nupdated: "), "trace shape: {canon}");
    assert!(!canon.contains("code:"), "no file list in the canon: {canon}");
}

#[test]
fn archive_help_offers_no_evidence_waiver() {
    // 讨论 evidence-gate-false-blocks：门拆了，放行旗标就没有存在的理由——
    // 接口上不得留下任何残迹。
    let p = TempProject::new("help");
    let out = p.run(&["archive", "--help"]);
    assert!(out.status.success(), "help exits zero: {}", stderr_of(&out));
    let text = format!("{}{}", stdout_of(&out), stderr_of(&out));
    assert!(!text.contains("waive"), "no waiver flag survives in help: {text}");
}

#[test]
fn a_recorded_change_archives_and_the_canon_gets_a_two_field_trace() {
    // spec Scenario「trace 两栏一律注入」的端对端面：走 task done 产生证据后封存，
    // 正典的 @trace 只有 source 与 updated，且证据随目录搬进封存区。
    let p = TempProject::new("trace-two-field");
    p.add_change("demo", "demo-cap");
    record_real_evidence(&p, "demo");

    let out = p.run(&["archive", "demo", "--no-color"]);
    assert!(out.status.success(), "archive succeeds: {}", stderr_of(&out));
    assert!(
        !stderr_of(&out).contains("no task evidence recorded"),
        "spec Scenario「有证据时一字不印」: {}",
        stderr_of(&out)
    );
    let canon = p.canonical_spec("demo-cap");
    assert!(canon.contains("<!-- @trace"), "trace injected: {canon}");
    assert!(canon.contains("source: demo"), "{canon}");
    assert!(canon.contains("updated: "), "{canon}");
    assert!(!canon.contains("code:"), "no file list in the canon: {canon}");
    assert!(!canon.contains("src/a.rs"), "no file list in the canon: {canon}");

    let archived = std::fs::read_dir(p.dir.join("specseal").join("changes").join("archive"))
        .expect("archive dir")
        .filter_map(|e| e.ok())
        .find(|e| e.file_name().to_string_lossy().ends_with("-demo"))
        .expect("archived change dir");
    assert!(
        archived.path().join(".evidence.json").is_file(),
        "the evidence record rides the directory move into the archive"
    );
}

#[test]
fn discard_takes_the_evidence_record_and_the_legacy_orphan_with_it() {
    // spec Scenario「证据随 change 生命周期移动」的 discard 半边：记录住在 change
    // 目录里，废弃即随目录消失——这里直接断言新位置的路径不存在，而不是仰赖
    // 「目录被删」的副作用。旧路径的残档同时被扫掉：留着会被日后重用同名的
    // change 经回退读取误认为自己的记录。
    let p = TempProject::new("discard-evidence");
    p.add_change("demo", "demo-cap");
    record_real_evidence(&p, "demo");
    let evidence = p.change_dir("demo").join(".evidence.json");
    let legacy = p.dir.join(".specseal").join("touched").join("demo.json");
    std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
    std::fs::write(&legacy, "{\"change\":\"demo\",\"touched\":[]}").unwrap();

    let out = p.run(&["discard", "demo", "--force", "--no-color"]);
    assert!(out.status.success(), "discard succeeds: {}", stderr_of(&out));
    assert!(!p.change_dir("demo").exists(), "the change directory is gone");
    assert!(!evidence.exists(), "the evidence record dies with the change: {evidence:?}");
    assert!(!legacy.exists(), "no legacy orphan survives the discard: {legacy:?}");
}

#[test]
fn bulk_archive_runs_with_a_dirty_work_tree() {
    // design「bulk 整洁工作树守门移除」：脏工作树不再是批量封存的前置条件，
    // 因为脏档早已不会进入任何 change 的 @trace。
    let p = TempProject::new("bulk-dirty");
    p.add_change("alpha", "alpha-cap");
    p.add_change("beta", "beta-cap");

    let out = p.run(&["archive", "--all", "--no-color"]);
    let stdout = stdout_of(&out);
    assert!(out.status.success(), "a dirty work tree must not block bulk archive: {}", stderr_of(&out));
    assert!(
        !stderr_of(&out).contains("clean work tree"),
        "the clean-work-tree requirement is gone: {}",
        stderr_of(&out)
    );
    assert!(!p.change_dir("alpha").exists(), "alpha archived: {stdout}");
    assert!(!p.change_dir("beta").exists(), "beta archived: {stdout}");
    assert!(
        p.dir.join("src").join("dirty.rs").is_file(),
        "the dirty file is none of archive's business"
    );
}
