//! `[M]` 手动测试标记的端到端契约 — fs 模式(manual-task-marker spec 全条文、
//! review-station／verify-station 的守门与失效判定、change-lifecycle
//! 「封存的章失效守门」)。
//!
//! 覆盖 design Implementation Contract 的行为 1–5:payload 曝光、verify
//! add-round 的放行与拒绝、两站 stamp 的放行与拒绝、失效判定四情境、封存的
//! 章失效守门(含任务守门先拒的顺序)。守门的判准一律是「写码任务」——`[M]`
//! 任务不计入,但封存仍要求全勾(手测强制力保留)。

use std::path::PathBuf;
use std::process::{Command, Output};

const META: &str = "schema: spec-driven\ncreated: 2026-07-01\n";
/// 新开 capability 的 delta 自带合格 Purpose——缺席会被封存的 Purpose 守门挡下
/// （spec archive-merge「新 capability 的 Purpose 自 delta 带入」）。
const DELTA_SPEC: &str = "## Purpose\n\n本 capability 是测试用的示范能力，涵盖一个可观察行为与其成功路径，供封存流程的守门测试取用。\n\n## ADDED Requirements\n\n### Requirement: Demo works\n\nIt SHALL work.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n";
/// 两个写码任务全勾＋一个未勾的 `[M]`:写码任务全完成、全量 2/3。
const CODE_DONE_MANUAL_OPEN: &str = "- [x] 1.1 a\n- [x] 1.2 b\n- [ ] [M] 1.3 手动验证\n";
/// 一个写码任务未勾＋一个未勾的 `[M]`:写码任务 1/2,守门该拒。
const CODE_OPEN: &str = "- [x] 1.1 a\n- [ ] 1.2 b\n- [ ] [M] 1.3 手动验证\n";
/// 全勾(含 `[M]`)——封存的任务完成度守门要求的状态。
const ALL_DONE: &str = "- [x] 1.1 a\n- [x] 1.2 b\n- [x] [M] 1.3 手动验证\n";

/// 审查／验证轮的 scope 指向这支受审档——内容锚的判定对象。
const SCOPE_FILE: &str = "src/lib.rs";
const SCOPE_BODY: &str = "pub fn a() {}\n";

struct TempProject {
    dir: PathBuf,
}

impl TempProject {
    /// 用后即丢的项目:一个结构完整的 change `demo`(proposal + delta spec +
    /// 指定的 tasks.md)与一支受审程序档;无 git——@trace 探测 fail soft。
    fn new(tag: &str, tasks_md: &str) -> TempProject {
        let dir = std::env::temp_dir()
            .join(format!("specseal-cli-manual-gates-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".specseal.yaml"), "tools:\n  - claude\n").unwrap();
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join(SCOPE_FILE), SCOPE_BODY).unwrap();
        let change = dir.join("specseal").join("changes").join("demo");
        std::fs::create_dir_all(change.join("specs").join("demo-cap")).unwrap();
        std::fs::write(change.join(".meta.yaml"), META).unwrap();
        std::fs::write(change.join("proposal.md"), "## Why\n\nDemo.\n").unwrap();
        std::fs::write(change.join("tasks.md"), tasks_md).unwrap();
        std::fs::write(change.join("specs").join("demo-cap").join("spec.md"), DELTA_SPEC).unwrap();
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

    /// 自 stdin 落一轮干净(零 findings)的工单。
    fn add_clean_round(&self, station: &str) -> Output {
        let mut child = Command::new(env!("CARGO_BIN_EXE_specseal"))
            .args([station, "add-round", "demo", "--stdin"])
            .current_dir(&self.dir)
            .env_remove("SPECSEAL_STORE_URL")
            .env_remove("SPECSEAL_TOKEN")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn specseal");
        use std::io::Write;
        child
            .stdin
            .as_mut()
            .expect("stdin")
            .write_all(format!("**Scope**: {SCOPE_FILE}\n").as_bytes())
            .expect("write round");
        child.wait_with_output().expect("round output")
    }

    fn change_dir(&self) -> PathBuf {
        self.dir.join("specseal").join("changes").join("demo")
    }

    fn meta(&self) -> String {
        std::fs::read_to_string(self.change_dir().join(".meta.yaml")).expect("meta")
    }

    fn write_tasks(&self, tasks_md: &str) {
        std::fs::write(self.change_dir().join("tasks.md"), tasks_md).expect("write tasks");
    }

    /// 改动受审档的内容——打破章的内容锚。
    fn touch_scope_file(&self) {
        std::fs::write(self.dir.join(SCOPE_FILE), format!("{SCOPE_BODY}pub fn b() {{}}\n"))
            .expect("modify scope file");
    }

    fn archived_demo_exists(&self) -> bool {
        let archive = self.dir.join("specseal").join("changes").join("archive");
        std::fs::read_dir(archive).is_ok_and(|entries| {
            entries.filter_map(|e| e.ok()).any(|e| {
                e.path().file_name().and_then(|n| n.to_str()).is_some_and(|n| n.ends_with("-demo"))
            })
        })
    }

    /// 两站都落一轮干净工单并盖章——封存守门测试的前置。
    fn stamp_both(&self) {
        for station in ["review", "verify"] {
            assert!(self.add_clean_round(station).status.success(), "{station} round");
            let out = self.run(&[station, "stamp", "demo", "--agent", "claude"]);
            assert!(out.status.success(), "{station} stamp: {:?}", String::from_utf8_lossy(&out.stderr));
        }
    }
}

impl Drop for TempProject {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

// --- 行为 1:payload 曝光(manual-task-marker spec「任务 payload 的 manual 字段与写码进度」)---

#[test]
fn apply_payload_exposes_manual_flag_and_code_progress() {
    // spec Scenario「手动任务上线 payload」:[M] 任务 manual=true,progress 的
    // code 三栏排除该任务;描述不含标记。
    let p = TempProject::new("payload", CODE_DONE_MANUAL_OPEN);
    let out = p.run(&["instructions", "apply", "--change", "demo", "--json"]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let v: serde_json::Value =
        serde_json::from_slice(&out.stdout).expect("apply payload is valid JSON");
    assert_eq!(v["progress"]["total"], 3);
    assert_eq!(v["progress"]["complete"], 2);
    assert_eq!(v["progress"]["codeTotal"], 2, "[M] task is out of the code counts");
    assert_eq!(v["progress"]["codeComplete"], 2);
    assert_eq!(v["progress"]["codeRemaining"], 0, "code work is finished");
    assert_eq!(v["tasks"][2]["manual"], true);
    assert_eq!(v["tasks"][2]["description"], "1.3 手动验证", "description drops the marker");
    assert_eq!(v["tasks"][0]["manual"], false);
}

#[test]
fn code_counts_equal_full_counts_without_manual_tasks() {
    // spec Scenario「无手动任务时字段一致」:无 [M] 时 code 三栏＝全量三栏。
    let p = TempProject::new("nomanual", "- [x] 1.1 a\n- [ ] 1.2 b\n");
    let out = p.run(&["instructions", "apply", "--change", "demo", "--json"]);
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).expect("valid JSON");
    for (full, code) in [("total", "codeTotal"), ("complete", "codeComplete"), ("remaining", "codeRemaining")] {
        assert_eq!(v["progress"][full], v["progress"][code], "{full} vs {code}");
    }
}

// --- 行为 2:verify add-round 的落工单守门(verify-station spec「验证工单的创建与追加」)---

#[test]
fn verify_add_round_lands_when_only_manual_tasks_remain() {
    // spec Scenario「仅余手动任务可落工单」:写码全勾 → 放行、工单创建。
    let p = TempProject::new("vround-ok", CODE_DONE_MANUAL_OPEN);
    let out = p.add_clean_round("verify");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(p.change_dir().join("verify.md").is_file(), "ticket must be created");
}

#[test]
fn verify_add_round_refuses_while_a_code_task_is_open() {
    // spec Scenario「写码任务未完成即拒绝落工单」:1/2 → 拒绝、无工单、点名写码任务。
    let p = TempProject::new("vround-no", CODE_OPEN);
    let out = p.add_clean_round("verify");
    assert!(!out.status.success(), "open code task must refuse");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("1/2"), "counts exclude the [M] task: {stderr}");
    assert!(stderr.contains("code task"), "message names code tasks: {stderr}");
    assert!(!p.change_dir().join("verify.md").exists(), "no ticket may appear");
}

// --- 行为 3:两站盖章守门(review-station／verify-station 的盖章条文)---

#[test]
fn both_stations_stamp_when_only_manual_tasks_remain() {
    // spec Scenario「仅余手动任务可盖章」＋Example「盖章写入的任务锚」:
    // 盖章成功、工单删除,锚记全任务总数 3(含未勾的 [M])。
    let p = TempProject::new("stamp-ok", CODE_DONE_MANUAL_OPEN);
    p.stamp_both();
    let meta = p.meta();
    for field in ["reviewed_at:", "reviewed_tasks_total: 3", "verified_at:", "verified_tasks_total: 3"] {
        assert!(meta.contains(field), "meta must carry {field}: {meta}");
    }
    assert!(!p.change_dir().join("review.md").exists(), "review ticket deleted");
    assert!(!p.change_dir().join("verify.md").exists(), "verify ticket deleted");
}

#[test]
fn stamping_refuses_while_a_code_task_is_open() {
    // 写码任务未完成 → 两站盖章皆拒,消息点名写码任务计数,meta 不变。
    let p = TempProject::new("stamp-no", CODE_DONE_MANUAL_OPEN);
    assert!(p.add_clean_round("review").status.success(), "round lands while code is done");
    p.write_tasks(CODE_OPEN); // 工单开立后退勾一个写码任务
    let out = p.run(&["review", "stamp", "demo", "--agent", "claude"]);
    assert!(!out.status.success(), "open code task must refuse the stamp");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("1/2"), "counts exclude the [M] task: {stderr}");
    assert_eq!(p.meta(), META, "refusal leaves metadata byte-identical");
    assert!(p.change_dir().join("review.md").is_file(), "ticket survives refusal");
}

// --- 行为 4 + 5:失效判定与封存的章失效守门(change-lifecycle spec 的 Example 表)---

#[test]
fn checking_a_manual_task_after_the_stamp_still_archives() {
    // Example 表第二列:两章齐备、补勾 [M]、scope 档零改动 → 封存放行。
    let p = TempProject::new("arch-manual", CODE_DONE_MANUAL_OPEN);
    p.stamp_both();
    p.write_tasks(ALL_DONE);
    let out = p.run(&["archive", "demo"]);
    assert!(out.status.success(), "manual toggle must not stale the stamps: {}", String::from_utf8_lossy(&out.stderr));
    assert!(p.archived_demo_exists(), "change must land in the archive");
}

#[test]
fn touching_a_scope_file_after_the_stamp_refuses_archive() {
    // Example 表第一列:章齐备、scope 档内容改变 → 拒绝、点名站别与文件,零文件效果。
    let p = TempProject::new("arch-stale", CODE_DONE_MANUAL_OPEN);
    p.stamp_both();
    p.write_tasks(ALL_DONE);
    p.touch_scope_file();
    let out = p.run(&["archive", "demo"]);
    assert!(!out.status.success(), "stale stamps must refuse archive");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("review") && stderr.contains("verify"), "both stations named: {stderr}");
    assert!(stderr.contains(SCOPE_FILE), "the changed file is named: {stderr}");
    assert!(!p.archived_demo_exists(), "no archived directory appears");
    assert!(p.change_dir().join("tasks.md").is_file(), "change stays in place");
}

#[test]
fn adding_a_task_after_the_stamp_refuses_archive() {
    // Example 表第三列:任务总数自 3 变 4 → 任务锚破 → 拒绝。
    let p = TempProject::new("arch-recount", CODE_DONE_MANUAL_OPEN);
    p.stamp_both();
    p.write_tasks(&format!("{ALL_DONE}- [x] 1.4 late\n"));
    let out = p.run(&["archive", "demo"]);
    assert!(!out.status.success(), "task anchor break must refuse archive");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("3 at stamp time, 4 now"), "counts explain the break: {stderr}");
    assert!(!p.archived_demo_exists(), "no archived directory appears");
}

#[test]
fn an_unstamped_change_archives_exactly_as_before() {
    // Example 表第四列:无章 → 放行,行为与守门引入前一致(scope 档改过也无妨)。
    let p = TempProject::new("arch-nostamp", ALL_DONE);
    p.touch_scope_file();
    let out = p.run(&["archive", "demo"]);
    assert!(out.status.success(), "no stamp → no stale gate: {}", String::from_utf8_lossy(&out.stderr));
    assert!(p.archived_demo_exists(), "change must land in the archive");
}

#[test]
fn the_task_readiness_gate_refuses_before_the_stale_gate() {
    // 顺序契约:未勾的 [M] 让任务完成度守门先拒——消息维持既有样式,不提章失效。
    let p = TempProject::new("arch-order", CODE_DONE_MANUAL_OPEN);
    p.stamp_both();
    p.touch_scope_file(); // 章同时已失效
    let out = p.run(&["archive", "demo"]);
    assert!(!out.status.success(), "incomplete tasks must refuse");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("2/3 tasks complete"), "既有任务守门消息: {stderr}");
    assert!(stderr.contains("--mark-tasks-complete"), "既有出路: {stderr}");
    assert!(!stderr.contains("no longer holds"), "章失效消息不得抢先: {stderr}");
}

#[test]
fn mark_tasks_complete_leaves_tasks_untouched_when_stale_refuses() {
    // 拒绝路径零写入:--mark-tasks-complete 的前置全勾写入之前先判章失效,
    // stale 拒绝时 tasks.md 逐比特不变——未手测的 [M] 不得被代勾。
    let p = TempProject::new("arch-prewrite", CODE_DONE_MANUAL_OPEN);
    p.stamp_both();
    p.touch_scope_file(); // 内容锚破 → 两章 stale
    let out = p.run(&["archive", "demo", "--mark-tasks-complete"]);
    assert!(!out.status.success(), "stale stamps must refuse archive");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("no longer holds"), "拒绝来自章失效守门: {stderr}");
    let tasks = std::fs::read_to_string(p.change_dir().join("tasks.md")).expect("tasks");
    assert_eq!(tasks, CODE_DONE_MANUAL_OPEN, "refusal leaves tasks.md byte-identical");
    assert!(!p.archived_demo_exists(), "no archived directory appears");
}

#[test]
fn a_reopened_ticket_escapes_the_stale_gate_via_carry() {
    // 工单开立中的站,其旧章不入失效判定——该站的封存处置由未结工单守门
    // (--carry-*)承载,已被重开工单取代的章不得把 carry 堵成死路。
    let p = TempProject::new("arch-carry", CODE_DONE_MANUAL_OPEN);
    p.stamp_both();
    p.write_tasks(ALL_DONE);
    p.touch_scope_file(); // 两章内容锚皆破
    for station in ["review", "verify"] {
        assert!(p.add_clean_round(station).status.success(), "reopen the {station} ticket");
    }
    let out = p.run(&["archive", "demo", "--carry-review", "--carry-verify"]);
    assert!(
        out.status.success(),
        "open tickets own the disposal — stale superseded stamps must not block: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(p.archived_demo_exists(), "change must land in the archive");
}

#[test]
fn bulk_archive_fails_fast_on_a_stale_stamp() {
    // change-lifecycle spec:批量封存沿既有 fail-fast 样式——stale 章的拒绝
    // 中止批量并点名该 change,SHALL NOT 静默跳过;后续 change 原地不动。
    let p = TempProject::new("arch-bulk", ALL_DONE);
    p.stamp_both();
    p.touch_scope_file(); // demo 的两章 stale
    let later = p.dir.join("specseal").join("changes").join("later");
    std::fs::create_dir_all(later.join("specs").join("later-cap")).unwrap();
    std::fs::write(later.join(".meta.yaml"), "schema: spec-driven\ncreated: 2026-07-02\n")
        .unwrap();
    std::fs::write(later.join("proposal.md"), "## Why\n\nLater.\n").unwrap();
    std::fs::write(later.join("tasks.md"), "- [x] 1.1 a\n").unwrap();
    std::fs::write(
        later.join("specs").join("later-cap").join("spec.md"),
        DELTA_SPEC.replace("Demo works", "Later works"),
    )
    .unwrap();
    let out = p.run(&["archive", "--all"]);
    assert!(!out.status.success(), "a stale stamp must abort the bulk run");
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("Bulk archive aborted at 'demo'"), "fail-fast names the change: {stdout}");
    assert!(!stdout.contains("Skipped: demo"), "stale is a refusal, never a skip: {stdout}");
    assert!(!p.archived_demo_exists(), "demo stays active");
    assert!(later.join("tasks.md").is_file(), "the later change stays untouched");
}

// --- 标记位置的 change 验证检查(manual-task-marker spec)---

#[test]
fn validate_refuses_a_task_whose_marker_sits_after_the_number() {
    // spec Scenario「编号在前报 error」:误置在 validate 就显形,不必等 station
    // 守门卡死才发现。
    let p = TempProject::new("lint-after-number", "- [x] 1.1 a\n- [ ] 6.2 [M] 手动验收\n");
    let out = p.run(&["validate", "demo", "--no-color"]);
    assert!(!out.status.success(), "误置必须让 validate 失败");
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    // design D3:路径是含 change 目录的逻辑路径,渲染统一正斜线(Windows 亦然)。
    for key in ["specseal/changes/demo/tasks.md", "Task 2", "6.2 [M] 手动验收", "- [ ] [M] 6.2 手动验收"]
    {
        assert!(text.contains(key), "消息缺 {key:?}: {text}");
    }
}

#[test]
fn validate_names_the_single_space_rule_when_the_prefix_slot_was_missed() {
    // spec Scenario「行首残留报 error」:checkbox 后两个空格。
    let p = TempProject::new("lint-slot-missed", "- [x] 1.1 a\n- [ ]  [M] 手测导入\n");
    let out = p.run(&["validate", "demo", "--no-color"]);
    assert!(!out.status.success(), "误置必须让 validate 失败");
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    assert!(text.contains("exactly one space"), "消息须点名恰一个空格: {text}");
}

#[test]
fn validate_output_is_unchanged_for_correctly_marked_tasks() {
    // spec Scenario「正确前缀与中段字面提及不报」:无误置时输出逐比特不变。
    let p = TempProject::new(
        "lint-clean",
        "- [ ] [M] 手测导入\n- [x] 1.1 前缀剥除循环同时接受 `[P]` 与 `[M]` 的说明文本\n",
    );
    let out = p.run(&["validate", "demo", "--no-color"]);
    assert!(out.status.success(), "正确写法不得失败: {}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        "✓ demo — valid",
        "干净 change 的输出维持既有单行"
    );
}
