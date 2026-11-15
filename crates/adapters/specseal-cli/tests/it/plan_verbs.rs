//! `specseal plan` 与 `specseal change depends` 的 fs 模式契约（change-plan spec
//! 「plan 动词输出波次与阻挡清单」「change depends 动词写入声明依赖」）。
//!
//! 两条输出路径都是契约：`--json` 的 payload 形状（camelCase、类型）与
//! `--no-color` 的人眼行；守门失败一律 exit code 非零、meta 逐比特不变。

use std::path::PathBuf;
use std::process::{Command, Output};

const PROPOSED: &str = "schema: spec-driven\ncreated: 2026-09-01\n";

struct TempProject {
    dir: PathBuf,
}

impl TempProject {
    /// 空项目：只有 specseal/changes/ 目录，change 由测试逐一放入。
    fn new(tag: &str) -> TempProject {
        let dir =
            std::env::temp_dir().join(format!("specseal-cli-plan-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("specseal").join("changes")).unwrap();
        TempProject { dir }
    }

    fn change_dir(&self, name: &str) -> PathBuf {
        self.dir.join("specseal").join("changes").join(name)
    }

    /// 放入一个 change：meta 原文＋（可选）delta capability 名。
    fn put_change(&self, name: &str, meta: &str, caps: &[&str]) {
        let dir = self.change_dir(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".meta.yaml"), meta).unwrap();
        for cap in caps {
            let spec = dir.join("specs").join(cap);
            std::fs::create_dir_all(&spec).unwrap();
            std::fs::write(spec.join("spec.md"), "## ADDED Requirements\n").unwrap();
        }
    }

    fn put_tasks(&self, name: &str, tasks_md: &str) {
        std::fs::write(self.change_dir(name).join("tasks.md"), tasks_md).unwrap();
    }

    /// 写入（或覆写）一份 delta spec 的原文。
    fn put_delta(&self, name: &str, cap: &str, text: &str) {
        let spec = self.change_dir(name).join("specs").join(cap);
        std::fs::create_dir_all(&spec).unwrap();
        std::fs::write(spec.join("spec.md"), text).unwrap();
    }

    /// 放入一份已写结论的未封存讨论：`promoted_to` 为空时不写这一行，
    /// `cuts` 为 Decision 定论句之后的列点。
    fn put_discussion(&self, slug: &str, promoted_to: &str, cuts: &str) {
        let dir = self.dir.join("specseal").join("discussions");
        std::fs::create_dir_all(&dir).unwrap();
        let promoted = if promoted_to.is_empty() {
            String::new()
        } else {
            format!("promoted_to: {promoted_to}\n")
        };
        let doc = format!(
            "---\ntopic: {slug}\nslug: {slug}\nstatus: promoted\n{promoted}created: 2026-09-01\n---\n\n\
             # Discussion: {slug}\n\n## Context\n\n背景。\n\n## Rounds\n\n\
             ### Round 1 — assumptions (2026-09-01)\n\n**Focus**: scope\n\n\
             ## Conclusion\n\n**Decision**: 定案。\n\n{cuts}\n"
        );
        std::fs::write(dir.join(format!("{slug}.md")), doc).unwrap();
    }

    fn archive(&self, dated_name: &str, meta: &str) {
        let dir = self
            .dir
            .join("specseal")
            .join("changes")
            .join("archive")
            .join(dated_name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".meta.yaml"), meta).unwrap();
    }

    fn meta(&self, name: &str) -> Vec<u8> {
        std::fs::read(self.change_dir(name).join(".meta.yaml")).unwrap()
    }

    fn run(&self, args: &[&str]) -> Output {
        self.run_env(args, &[])
    }

    /// 同上，外加调用端指定的环境变量——宿主的 SPECSEAL_*／色彩变量一律先清掉，
    /// 再套上测试要的那几个。
    fn run_env(&self, args: &[&str], envs: &[(&str, &str)]) -> Output {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_specseal"));
        cmd.args(args).current_dir(&self.dir);
        for key in [
            "SPECSEAL_STORE_URL",
            "SPECSEAL_TOKEN",
            "SPECSEAL_WORKTREE",
            "NO_COLOR",
            "CLICOLOR",
            "CLICOLOR_FORCE",
        ] {
            cmd.env_remove(key);
        }
        cmd.envs(envs.iter().copied());
        cmd.output().expect("run specseal binary")
    }
}

impl Drop for TempProject {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// `list --json` text without its `modifiedAt` lines: that time belongs to the
/// files, and two projects (or one project before and after a write) never
/// share it.
fn without_modified_at(text: &str) -> String {
    text.lines().filter(|line| !line.trim_start().starts_with("\"modifiedAt\"")).collect::<Vec<_>>().join("\n")
}

fn stdout_of(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).to_string()
}

fn stderr_of(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).to_string()
}

fn json_of(out: &Output) -> serde_json::Value {
    serde_json::from_slice(&out.stdout)
        .unwrap_or_else(|e| panic!("stdout is JSON ({e}): {}", stdout_of(out)))
}

// --- plan：查找动词 ---

/// 一份只 MODIFIED 一个 requirement 的 delta 原文。
fn modified(requirement: &str) -> String {
    format!("## MODIFIED Requirements\n\n### Requirement: {requirement}\n\nbody\n")
}

#[test]
fn plan_json_has_nine_keys_and_requirement_overlap_shape() {
    // Scenario JSON 输出形状：两个提案中 change（b 依赖 a），各自 MODIFIED
    // desktop-app 的同一个 requirement。
    let p = TempProject::new("json-shape");
    p.put_change("a", PROPOSED, &[]);
    p.put_change(
        "b",
        "schema: spec-driven\ncreated: 2026-09-02\ndepends_on: a\n",
        &[],
    );
    for name in ["a", "b"] {
        p.put_delta(name, "desktop-app", &modified("看板与任务"));
    }
    p.put_discussion("talk-a", "add-a", TWO_CUTS);
    let out = p.run(&["plan", "--json"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    let json = json_of(&out);
    let keys = |v: &serde_json::Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
    assert_eq!(
        keys(&json),
        ["changes", "next", "skipped", "unpromotedCuts", "waves"]
    );
    assert_eq!(json["skipped"], serde_json::json!([]));
    let cuts = json["unpromotedCuts"].as_array().unwrap();
    assert_eq!(cuts.len(), 1, "got: {cuts:?}");
    for cut in cuts {
        assert_eq!(
            keys(cut),
            ["changes", "cut", "discussion", "title", "unpromoted"]
        );
        assert!(cut["discussion"].is_string() && cut["cut"].is_string() && cut["title"].is_string());
        for list in [&cut["changes"], &cut["unpromoted"]] {
            assert!(list.as_array().unwrap().iter().all(serde_json::Value::is_string));
        }
    }
    assert_eq!(
        cuts[0],
        serde_json::json!({
            "discussion": "talk-a",
            "cut": "cut 2",
            "title": "第二刀",
            "changes": ["add-b"],
            "unpromoted": ["add-b"]
        })
    );
    assert_eq!(json["next"], "a");
    assert_eq!(
        json["waves"],
        serde_json::json!([{ "index": 1, "changes": ["a"] }, { "index": 2, "changes": ["b"] }])
    );
    let changes = json["changes"].as_array().unwrap();
    assert_eq!(changes.len(), 2);
    for c in changes {
        assert_eq!(
            keys(c),
            [
                "archiveAfter",
                "blockedBy",
                "dependsOn",
                "name",
                "overlaps",
                "ready",
                "requirementOverlap",
                "stage",
                "wave"
            ]
        );
        assert!(c["name"].is_string() && c["wave"].is_u64() && c["stage"].is_string());
        assert!(c["dependsOn"].is_array() && c["overlaps"].is_array());
        assert!(c["blockedBy"].is_array() && c["ready"].is_boolean());
        assert!(c["requirementOverlap"].is_array() && c["archiveAfter"].is_array());
        for o in c["requirementOverlap"].as_array().unwrap() {
            assert_eq!(
                keys(o),
                [
                    "capability",
                    "change",
                    "conflict",
                    "otherOperation",
                    "ownOperation",
                    "requirement"
                ]
            );
            assert!(o["conflict"].is_boolean() && o["ownOperation"].is_string());
        }
    }
    let b = &changes[1];
    assert_eq!(b["name"], "b");
    assert_eq!(b["stage"], "proposed");
    assert_eq!(b["wave"], 2);
    assert_eq!(b["dependsOn"], serde_json::json!(["a"]));
    assert_eq!(b["blockedBy"], serde_json::json!(["a"]));
    assert_eq!(b["ready"], false);
    assert_eq!(
        b["overlaps"],
        serde_json::json!([{ "change": "a", "capabilities": ["desktop-app"] }])
    );
    assert_eq!(b["archiveAfter"], serde_json::json!(["a"]));
    assert_eq!(
        b["requirementOverlap"],
        serde_json::json!([{
            "change": "a",
            "capability": "desktop-app",
            "requirement": "看板与任务",
            "ownOperation": "MODIFIED",
            "otherOperation": "MODIFIED",
            "conflict": false
        }])
    );
    assert_eq!(changes[0]["archiveAfter"], serde_json::json!([]));
}

#[test]
fn plan_strict_overlap_reproduces_old_waves() {
    // Scenario strict-overlap 退回目录级推波：a、b 共用 desktop-app 但动到不同
    // requirement——缺省同波；--strict-overlap 时 b 第 2 波、被 a 挡住。
    let p = TempProject::new("strict");
    p.put_change("a", PROPOSED, &[]);
    p.put_change("b", "schema: spec-driven\ncreated: 2026-09-02\n", &[]);
    p.put_delta("a", "desktop-app", &modified("Run rewind point"));
    p.put_delta("b", "desktop-app", &modified("Conversation pin"));
    let default = json_of(&p.run(&["plan", "--json"]));
    assert_eq!(
        default["waves"],
        serde_json::json!([{ "index": 1, "changes": ["a", "b"] }])
    );
    let out = p.run(&["plan", "--strict-overlap", "--json"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    let strict = json_of(&out);
    assert_eq!(
        strict["waves"],
        serde_json::json!([{ "index": 1, "changes": ["a"] }, { "index": 2, "changes": ["b"] }])
    );
    let b = &strict["changes"][1];
    assert_eq!(b["blockedBy"], serde_json::json!(["a"]));
    assert_eq!(b["ready"], false);
    assert_eq!(b["archiveAfter"], serde_json::json!([]));
    let human = stdout_of(&p.run(&["plan", "--strict-overlap", "--no-color"]));
    assert!(
        human.contains("Wave 2") && human.contains("blocked by: a"),
        "got: {human}"
    );
}

#[test]
fn plan_human_output_prints_waves_and_next_without_ansi_under_no_color() {
    // Scenario 人眼输出与 --no-color：CLICOLOR_FORCE 逼出有色路径，--no-color 仍胜。
    let p = TempProject::new("human");
    p.put_change("a", PROPOSED, &[]);
    p.put_change("b", "schema: spec-driven\ncreated: 2026-09-02\n", &[]);
    p.put_change(
        "c",
        "schema: spec-driven\ncreated: 2026-09-03\ndepends_on: a\n",
        &[],
    );
    let out = p.run_env(&["plan", "--no-color"], &[("CLICOLOR_FORCE", "1")]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    let text = stdout_of(&out);
    assert!(
        !text.contains('\u{1b}'),
        "no ANSI under --no-color: {text:?}"
    );
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines[0], "Wave 1 (parallel)", "got: {text}");
    assert!(
        lines
            .iter()
            .any(|l| l.contains("Wave 2") && !l.contains("parallel")),
        "got: {text}"
    );
    assert!(
        lines
            .iter()
            .any(|l| l.contains("a") && l.contains("proposed")),
        "got: {text}"
    );
    assert!(
        lines
            .iter()
            .any(|l| l.contains("c") && l.contains("blocked by: a")),
        "got: {text}"
    );
    assert_eq!(lines.last().copied(), Some("next: a"), "got: {text}");
}

/// 讨论结论的两把刀：cut 1 `add-a`、cut 2 `add-b`。
const TWO_CUTS: &str = "- **cut 1 `add-a`**: 第一刀\n- **cut 2 `add-b`**: 第二刀";

#[test]
fn plan_human_output_lists_unpromoted_cuts_before_next() {
    // Scenario 人眼输出的 Unpromoted cuts 段：CLICOLOR_FORCE 逼出有色路径，--no-color 仍胜。
    let p = TempProject::new("human-cuts");
    p.put_change("add-a", PROPOSED, &[]);
    p.put_discussion("talk-a", "add-a", TWO_CUTS);
    let out = p.run_env(&["plan", "--no-color"], &[("CLICOLOR_FORCE", "1")]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    let text = stdout_of(&out);
    assert_eq!(
        text.lines().collect::<Vec<_>>(),
        [
            "Wave 1",
            "  • add-a [proposed]",
            "Unpromoted cuts",
            "  • talk-a cut 2: add-b — 第二刀",
            "next: add-a"
        ],
        "got: {text:?}"
    );
}

#[test]
fn plan_human_output_is_unchanged_when_every_cut_is_promoted() {
    // Scenario 没有尚未转出的刀时人眼输出不变：与没有讨论时逐比特相同。
    let p = TempProject::new("human-cuts-done");
    p.put_change("add-a", PROPOSED, &[]);
    let before = p.run(&["plan", "--no-color"]);
    p.put_discussion("talk-a", "add-a, add-b", TWO_CUTS);
    let after = p.run(&["plan", "--no-color"]);
    assert!(after.status.success(), "stderr: {}", stderr_of(&after));
    assert!(!stdout_of(&after).contains("Unpromoted cuts"), "got: {}", stdout_of(&after));
    assert_eq!(after.stdout, before.stdout);
}

/// 一份只 ADDED 一个 requirement 的 delta 原文。
fn added(requirement: &str) -> String {
    format!("## ADDED Requirements\n\n### Requirement: {requirement}\n\nbody\n")
}

/// 人眼输出里某个 change 那一行（去掉行首缩进）。
fn human_line(text: &str, name: &str) -> String {
    text.lines()
        .map(str::trim_start)
        .find(|l| l.starts_with(&format!("• {name} ")))
        .unwrap_or_else(|| panic!("no line for {name}: {text}"))
        .to_string()
}

#[test]
fn plan_human_output_orders_three_suffixes() {
    // Example「一个 change 三种尾注的顺序」：e 依赖 a、与 b MODIFIED 同一个
    // requirement、与 c ADDED 同名 requirement。行首沿用既有 `• <名称> [<阶段>]`。
    let p = TempProject::new("three-suffixes");
    p.put_change("a", PROPOSED, &[]);
    p.put_change("b", "schema: spec-driven\ncreated: 2026-09-02\n", &[]);
    p.put_change("c", "schema: spec-driven\ncreated: 2026-09-03\n", &[]);
    p.put_change(
        "e",
        "schema: spec-driven\ncreated: 2026-09-04\ndepends_on: a\n",
        &[],
    );
    p.put_delta("b", "desktop-app", &modified("看板与任务"));
    p.put_delta("c", "export", &added("导出"));
    p.put_delta("e", "desktop-app", &modified("看板与任务"));
    p.put_delta("e", "export", &added("导出"));
    let out = p.run_env(&["plan", "--no-color"], &[("CLICOLOR_FORCE", "1")]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    let text = stdout_of(&out);
    assert!(!text.contains('\u{1b}'), "no ANSI under --no-color: {text:?}");
    assert_eq!(
        human_line(&text, "e"),
        "• e [proposed] — blocked by: a — archive after: b — conflicts with: c"
    );
    assert_eq!(human_line(&text, "c"), "• c [proposed] — conflicts with: e");
    assert_eq!(human_line(&text, "b"), "• b [proposed]", "b archives first: no suffix");
}

#[test]
fn plan_human_output_marks_archive_order_and_conflicts_without_blockers() {
    // Scenario 人眼输出的封存顺序与冲突尾注：b 的 archiveAfter 为 [a]、c 与 d 互为
    // ADDED 同名冲突，两者都没有声明前置。
    let p = TempProject::new("archive-and-conflict");
    p.put_change("a", PROPOSED, &[]);
    p.put_change("b", "schema: spec-driven\ncreated: 2026-09-02\n", &[]);
    p.put_change("c", "schema: spec-driven\ncreated: 2026-09-03\n", &[]);
    p.put_change("d", "schema: spec-driven\ncreated: 2026-09-04\n", &[]);
    p.put_delta("a", "desktop-app", &modified("看板与任务"));
    p.put_delta("b", "desktop-app", &modified("看板与任务"));
    p.put_delta("c", "export", &added("导出"));
    p.put_delta("d", "export", &added("导出"));
    let text = stdout_of(&p.run(&["plan", "--no-color"]));
    let b = human_line(&text, "b");
    let c = human_line(&text, "c");
    assert!(b.ends_with("archive after: a") && !b.contains("blocked by:"), "{b}");
    assert!(c.ends_with("conflicts with: d") && !c.contains("blocked by:"), "{c}");
    assert_eq!(text.lines().next(), Some("Wave 1 (parallel)"), "all four start together");
}

#[test]
fn plan_refuses_a_dependency_cycle_with_an_empty_stdout() {
    // Scenario 依赖成环：a↔b，--json 与人眼皆非零、stdout 空。
    let p = TempProject::new("cycle");
    p.put_change("a", "schema: spec-driven\ndepends_on: b\n", &[]);
    p.put_change("b", "schema: spec-driven\ndepends_on: a\n", &[]);
    for args in [&["plan", "--json"][..], &["plan"][..]] {
        let out = p.run(args);
        assert!(!out.status.success(), "{args:?} must fail on a cycle");
        assert!(
            stderr_of(&out).contains("dependency cycle: a -> b -> a"),
            "{args:?} stderr: {}",
            stderr_of(&out)
        );
        assert!(
            out.stdout.is_empty(),
            "{args:?} stdout must be empty: {}",
            stdout_of(&out)
        );
    }
}

#[test]
fn plan_lists_corrupt_meta_under_skipped_and_still_plans_the_rest() {
    // Scenario 坏 metadata 列入 skipped。
    let p = TempProject::new("skipped");
    p.put_change("bad", ": : :\n\t bad yaml [unclosed\n", &["desktop-app"]);
    p.put_change("good", PROPOSED, &["desktop-app"]);
    let out = p.run(&["plan", "--json"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    let json = json_of(&out);
    assert_eq!(
        json["waves"],
        serde_json::json!([{ "index": 1, "changes": ["good"] }])
    );
    assert_eq!(json["changes"].as_array().unwrap().len(), 1);
    assert_eq!(json["changes"][0]["blockedBy"], serde_json::json!([]));
    let skipped = json["skipped"].as_array().unwrap();
    assert_eq!(skipped.len(), 1);
    assert_eq!(skipped[0]["change"], "bad");
    assert!(skipped[0]["reason"].as_str().is_some_and(|r| !r.is_empty()));
    assert_eq!(json["next"], "good");
}

#[test]
fn plan_with_no_changes_yields_empty_waves_and_a_null_next() {
    let p = TempProject::new("empty");
    let out = p.run(&["plan", "--json"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    let json = json_of(&out);
    assert_eq!(json["waves"], serde_json::json!([]));
    assert_eq!(json["changes"], serde_json::json!([]));
    assert_eq!(json["next"], serde_json::Value::Null);
    assert_eq!(json["skipped"], serde_json::json!([]));
    let human = p.run(&["plan", "--no-color"]);
    assert!(human.status.success());
    assert!(
        stdout_of(&human).lines().any(|l| l == "next: none"),
        "got: {}",
        stdout_of(&human)
    );
}

#[test]
fn plan_reflects_stage_and_archived_prerequisites() {
    // 已就绪→进行中→提案中的基底顺序；指向已封存的依赖视为满足。
    let p = TempProject::new("stages");
    p.put_change("ready", "schema: spec-driven\ncreated: 2026-09-09\n", &[]);
    p.put_tasks("ready", "- [x] 1.1 a\n");
    p.put_change(
        "started",
        "schema: spec-driven\ncreated: 2026-09-05\nstarted_at: 2026-09-06\n",
        &[],
    );
    p.put_change(
        "later",
        "schema: spec-driven\ncreated: 2026-09-01\ndepends_on: old\n",
        &[],
    );
    p.archive("2026-08-01-old", PROPOSED);
    let json = json_of(&p.run(&["plan", "--json"]));
    let names: Vec<&str> = json["changes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["ready", "started", "later"]);
    let stages: Vec<&str> = json["changes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["stage"].as_str().unwrap())
        .collect();
    assert_eq!(stages, ["ready", "in-progress", "proposed"]);
    assert_eq!(json["changes"][2]["dependsOn"], serde_json::json!(["old"]));
    assert_eq!(json["changes"][2]["blockedBy"], serde_json::json!([]));
    assert_eq!(json["next"], "later");
}

// --- change depends：写入动词 ---

const STAMPED: &str = "schema: spec-driven\ncreated: 2026-09-01\ncreated_by: Base Line <base@example.com>\ncreated_with: claude\n";

#[test]
fn depends_appends_one_line_and_keeps_every_other_byte() {
    // Scenario 写入单一前置。
    let p = TempProject::new("depends-add");
    p.put_change("a", PROPOSED, &[]);
    p.put_change("c", STAMPED, &[]);
    let out = p.run(&["change", "depends", "c", "--on", "a"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(stdout_of(&out), "✓ c depends on: a\n");
    assert_eq!(
        p.meta("c"),
        format!("{STAMPED}depends_on: a\n").into_bytes()
    );
    assert_eq!(
        p.meta("a"),
        PROPOSED.as_bytes(),
        "the prerequisite's meta is untouched"
    );
}

#[test]
fn depends_appends_then_removes_within_the_comma_list() {
    // Scenario 追加与移除：`--on b` 后为 `a, b`，`--on a --remove` 后为 `b`。
    let p = TempProject::new("depends-list");
    p.put_change("a", PROPOSED, &[]);
    p.put_change("b", PROPOSED, &[]);
    p.put_change("c", &format!("{STAMPED}depends_on: a\n"), &[]);
    let out = p.run(&["change", "depends", "c", "--on", "b"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(stdout_of(&out), "✓ c depends on: a, b\n");
    assert_eq!(
        p.meta("c"),
        format!("{STAMPED}depends_on: a, b\n").into_bytes()
    );
    let out = p.run(&["change", "depends", "c", "--on", "a", "--remove"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(stdout_of(&out), "✓ c no longer depends on: a\n");
    assert_eq!(
        p.meta("c"),
        format!("{STAMPED}depends_on: b\n").into_bytes()
    );
}

#[test]
fn depends_remove_to_empty_drops_the_whole_line() {
    // Scenario 移除至空即整行移除。
    let p = TempProject::new("depends-empty");
    p.put_change("a", PROPOSED, &[]);
    p.put_change("c", &format!("{STAMPED}depends_on: a\n"), &[]);
    let out = p.run(&["change", "depends", "c", "--on", "a", "--remove"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(p.meta("c"), STAMPED.as_bytes());
}

#[test]
fn depends_guards_refuse_with_zero_writes() {
    // Scenario 守门拒绝零写入：自己、不存在、已封存、成环，四次 meta 逐比特不变。
    let p = TempProject::new("depends-guards");
    p.put_change("a", &format!("{PROPOSED}depends_on: c\n"), &[]);
    p.put_change("c", STAMPED, &[]);
    p.archive("2026-08-01-old", PROPOSED);
    let cases: [(&[&str], &str); 4] = [
        (&["change", "depends", "c", "--on", "c"], "itself"),
        (
            &["change", "depends", "c", "--on", "ghost"],
            "no active change",
        ),
        (&["change", "depends", "c", "--on", "old"], "archived"),
        (
            &["change", "depends", "c", "--on", "a"],
            "dependency cycle: c -> a -> c",
        ),
    ];
    for (args, needle) in cases {
        let out = p.run(args);
        assert!(!out.status.success(), "{args:?} must refuse");
        assert!(
            stderr_of(&out).contains(needle),
            "{args:?} stderr: {}",
            stderr_of(&out)
        );
        assert!(out.stdout.is_empty(), "{args:?} stdout must be empty");
        assert_eq!(p.meta("c"), STAMPED.as_bytes(), "{args:?} must not write");
    }
    // 目标本身不是作用中 change：同样拒绝。
    let out = p.run(&["change", "depends", "ghost", "--on", "a"]);
    assert!(!out.status.success());
    assert!(
        stderr_of(&out).contains("not found"),
        "stderr: {}",
        stderr_of(&out)
    );
}

#[test]
fn depends_re_adding_an_existing_edge_is_an_idempotent_success() {
    let p = TempProject::new("depends-idempotent");
    p.put_change("a", PROPOSED, &[]);
    p.put_change("c", &format!("{STAMPED}depends_on: a\n"), &[]);
    let out = p.run(&["change", "depends", "c", "--on", "a"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(stdout_of(&out), "✓ c depends on: a\n");
    assert_eq!(
        p.meta("c"),
        format!("{STAMPED}depends_on: a\n").into_bytes()
    );
}

#[test]
fn depends_keeps_crlf_line_endings() {
    // Scenario CRLF meta 档保留行尾。
    let p = TempProject::new("depends-crlf");
    let crlf = STAMPED.replace('\n', "\r\n");
    p.put_change("a", PROPOSED, &[]);
    p.put_change("c", &crlf, &[]);
    let out = p.run(&["change", "depends", "c", "--on", "a"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(p.meta("c"), format!("{crlf}depends_on: a\r\n").into_bytes());
}

#[test]
fn depends_json_reports_the_change_and_its_full_list() {
    let p = TempProject::new("depends-json");
    p.put_change("a", PROPOSED, &[]);
    p.put_change("b", PROPOSED, &[]);
    p.put_change("c", &format!("{STAMPED}depends_on: a\n"), &[]);
    let out = p.run(&["change", "depends", "c", "--on", "b", "--json"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(
        json_of(&out),
        serde_json::json!({ "change": "c", "dependsOn": ["a", "b"] })
    );
}

#[test]
fn depends_writes_several_prerequisites_in_one_go() {
    // 多个 --on 于单次写入完成。
    let p = TempProject::new("depends-multi");
    p.put_change("a", PROPOSED, &[]);
    p.put_change("b", PROPOSED, &[]);
    p.put_change("c", STAMPED, &[]);
    let out = p.run(&["change", "depends", "c", "--on", "a", "b"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(
        p.meta("c"),
        format!("{STAMPED}depends_on: a, b\n").into_bytes()
    );
    let json = json_of(&p.run(&["plan", "--json"]));
    assert_eq!(
        json["changes"][2]["blockedBy"],
        serde_json::json!(["a", "b"])
    );
}

#[test]
fn depends_matches_change_names_exactly_not_by_directory_probe() {
    // 守门以作用中 change 的名称逐字比对：文档夹探针在大小写不分的文档系统
    // （macOS、Windows）会放行 `Add-Auth`，而 plan 只认 `add-auth`；空字符串与
    // `archive`（changes/archive/ 永远存在）同样不是 change 名。四次皆零写入。
    let p = TempProject::new("depends-exact-names");
    p.put_change("add-auth", PROPOSED, &[]);
    p.put_change("c", STAMPED, &[]);
    p.archive("2026-08-01-old", PROPOSED);
    let cases: [(&[&str], &str); 3] = [
        (
            &["change", "depends", "c", "--on", "Add-Auth"],
            "no active change",
        ),
        (&["change", "depends", "c", "--on", ""], "no active change"),
        (
            &["change", "depends", "c", "--on", "archive"],
            "no active change",
        ),
    ];
    for (args, needle) in cases {
        let out = p.run(args);
        assert!(!out.status.success(), "{args:?} must refuse");
        assert!(
            stderr_of(&out).contains(needle),
            "{args:?} stderr: {}",
            stderr_of(&out)
        );
        assert_eq!(p.meta("c"), STAMPED.as_bytes(), "{args:?} must not write");
    }
    // 目标名称同样逐字：`C` 不是 `c`。
    let out = p.run(&["change", "depends", "C", "--on", "add-auth"]);
    assert!(!out.status.success());
    assert!(
        stderr_of(&out).contains("Change 'C' not found."),
        "stderr: {}",
        stderr_of(&out)
    );
    assert_eq!(p.meta("c"), STAMPED.as_bytes());
    // 对照：逐字正确的名称照常写入。
    let out = p.run(&["change", "depends", "c", "--on", "add-auth"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(
        p.meta("c"),
        format!("{STAMPED}depends_on: add-auth\n").into_bytes()
    );
}

#[test]
fn depends_remove_clears_a_prerequisite_that_is_archived_or_unknown() {
    // Scenario 移除指向已封存名称的残留项：前置封存后（或名称已不存在）
    // `--remove` 照样清掉，清空即整行移除；加边仍照守门。
    let p = TempProject::new("depends-remove-residue");
    p.put_change("c", &format!("{STAMPED}depends_on: old, ghost\n"), &[]);
    p.archive("2026-08-01-old", PROPOSED);
    let out = p.run(&["change", "depends", "c", "--on", "old", "--remove"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(stdout_of(&out), "✓ c no longer depends on: old\n");
    assert_eq!(
        p.meta("c"),
        format!("{STAMPED}depends_on: ghost\n").into_bytes()
    );
    let out = p.run(&["change", "depends", "c", "--on", "ghost", "--remove"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(p.meta("c"), STAMPED.as_bytes());
    let out = p.run(&["change", "depends", "c", "--on", "old"]);
    assert!(
        !out.status.success(),
        "adding an archived prerequisite still refuses"
    );
    assert!(
        stderr_of(&out).contains("already archived"),
        "stderr: {}",
        stderr_of(&out)
    );
    assert_eq!(p.meta("c"), STAMPED.as_bytes());
}

#[test]
fn list_and_status_json_ignore_depends_on_byte_for_byte() {
    // change-lifecycle Scenario depends_on 不影响既有输出：同一 change 加／不加
    // `depends_on:` 行，list --json 与 status --change c --json 的 stdout 逐比特一致。
    let p = TempProject::new("list-status-unchanged");
    p.put_change("other", PROPOSED, &[]);
    p.put_change("c", STAMPED, &[]);
    p.put_tasks("c", "## 1. Group\n\n- [x] 1.1 first\n- [ ] 1.2 second\n");
    let before = (
        p.run(&["list", "--json"]),
        p.run(&["status", "--change", "c", "--json"]),
    );
    p.put_change("c", &format!("{STAMPED}depends_on: other\n"), &[]);
    let after = (
        p.run(&["list", "--json"]),
        p.run(&["status", "--change", "c", "--json"]),
    );
    for (label, a, b) in [
        ("list --json", &before.0, &after.0),
        ("status --json", &before.1, &after.1),
    ] {
        assert!(a.status.success() && b.status.success(), "{label} runs");
        assert!(!a.stdout.is_empty(), "{label} has output");
        // Writing the metadata moves the change's `modifiedAt`; nothing else may move.
        assert_eq!(
            without_modified_at(&stdout_of(a)),
            without_modified_at(&stdout_of(b)),
            "{label} must not change with depends_on"
        );
        assert!(
            !stdout_of(b).contains("depends"),
            "{label} must not leak the field: {}",
            stdout_of(b)
        );
    }
}

// --- change rank：看板顺序键写入动词（spec「change rank 动词写入看板顺序键」）---

/// meta 原文里 `board_rank:` 那一行的值。
fn rank_line(meta: &[u8]) -> Option<String> {
    String::from_utf8_lossy(meta)
        .lines()
        .find_map(|l| l.strip_prefix("board_rank: ").map(str::to_string))
}

fn plan_names(p: &TempProject) -> Vec<String> {
    json_of(&p.run(&["plan", "--json"]))["changes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn change_rank_before_writes_board_rank_and_reorders_plan() {
    // Scenario 无 rank 的 change 排到另一个之前：栏内只有 a（rank n）与 c。
    const RANKED: &str = "schema: spec-driven\ncreated: 2026-09-01\nboard_rank: n\n";
    let p = TempProject::new("rank-before");
    p.put_change("a", RANKED, &[]);
    p.put_change("c", STAMPED, &[]);
    assert_eq!(plan_names(&p), ["a", "c"]);
    let out = p.run(&["change", "rank", "c", "--before", "a"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(stdout_of(&out), "✓ c ranked before a\n");
    let rank = rank_line(&p.meta("c")).expect("c gained a board_rank line");
    assert!(rank.as_str() < "n", "{rank} sorts before n");
    assert_eq!(
        p.meta("c"),
        format!("{STAMPED}board_rank: {rank}\n").into_bytes(),
        "every other byte is kept"
    );
    assert_eq!(p.meta("a"), RANKED.as_bytes(), "the anchor is untouched");
    assert_eq!(plan_names(&p), ["c", "a"]);
}

#[test]
fn change_rank_json_shape_has_no_rank_value() {
    let p = TempProject::new("rank-json");
    p.put_change("a", "schema: spec-driven\nboard_rank: n\n", &[]);
    p.put_change("c", PROPOSED, &[]);
    let out = p.run(&["change", "rank", "c", "--after", "a", "--json"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(
        json_of(&out),
        serde_json::json!({ "change": "c", "anchor": "a", "position": "after" })
    );
    // 写入后 list --json 照旧不带 rank（board_rank 不进 CLI 输出）。
    let list = stdout_of(&p.run(&["list", "--json"]));
    assert!(!list.contains("board_rank") && !list.contains("boardRank"), "{list}");
}

#[test]
fn change_rank_refuses_already_ranked_and_force_overwrites() {
    // Scenario 已有 rank 未带 --force 被拒／带 --force 覆写既有 rank。
    let p = TempProject::new("rank-force");
    p.put_change("a", "schema: spec-driven\nboard_rank: n\n", &[]);
    p.put_change("c", "schema: spec-driven\nboard_rank: b\n", &[]);
    let out = p.run(&["change", "rank", "c", "--after", "a"]);
    assert!(!out.status.success(), "an existing rank refuses without --force");
    let err = stderr_of(&out);
    assert!(
        err.contains("already has a board rank") && err.contains("--force"),
        "stderr: {err}"
    );
    assert!(out.stdout.is_empty());
    assert_eq!(p.meta("c"), b"schema: spec-driven\nboard_rank: b\n", "zero writes");
    let out = p.run(&["change", "rank", "c", "--after", "a", "--force"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert!(rank_line(&p.meta("c")).unwrap().as_str() > "n");
    assert_eq!(plan_names(&p), ["a", "c"]);
}

#[test]
fn change_rank_refuses_dependency_cross() {
    // Scenario 跨声明依赖被拒：c 依赖 a，c --before a → 两份 meta 都不动。
    let p = TempProject::new("rank-dependency");
    p.put_change("a", PROPOSED, &[]);
    p.put_change("c", &format!("{STAMPED}depends_on: a\n"), &[]);
    let out = p.run(&["change", "rank", "c", "--before", "a"]);
    assert!(!out.status.success(), "crossing a prerequisite refuses");
    let err = stderr_of(&out);
    assert!(
        err.contains("cannot move 'c' there") && err.contains("it depends on a"),
        "stderr: {err}"
    );
    assert_eq!(p.meta("a"), PROPOSED.as_bytes());
    assert_eq!(
        p.meta("c"),
        format!("{STAMPED}depends_on: a\n").into_bytes()
    );
}

#[test]
fn change_rank_refuses_different_stage() {
    // Scenario 不同阶段被拒：a 进行中、c 提案中。
    let p = TempProject::new("rank-stage");
    const STARTED: &str = "schema: spec-driven\ncreated: 2026-09-01\nstarted_at: 2026-09-02\n";
    p.put_change("a", STARTED, &[]);
    p.put_change("c", PROPOSED, &[]);
    let out = p.run(&["change", "rank", "c", "--before", "a"]);
    assert!(!out.status.success(), "a rank only orders one stage");
    let err = stderr_of(&out);
    assert!(err.contains("in-progress") && err.contains("proposed"), "stderr: {err}");
    assert_eq!(p.meta("a"), STARTED.as_bytes());
    assert_eq!(p.meta("c"), PROPOSED.as_bytes());
}

#[test]
fn change_rank_needs_exactly_one_side() {
    // --before 与 --after 互斥且必择一：两者皆缺或皆给都是 argv 错误、零写入。
    let p = TempProject::new("rank-side");
    p.put_change("a", PROPOSED, &[]);
    p.put_change("c", PROPOSED, &[]);
    for args in [
        &["change", "rank", "c"][..],
        &["change", "rank", "c", "--before", "a", "--after", "a"][..],
    ] {
        let out = p.run(args);
        assert!(!out.status.success(), "{args:?} must be refused");
        assert!(out.stdout.is_empty(), "{args:?}");
    }
    assert_eq!(p.meta("c"), PROPOSED.as_bytes());
}

#[test]
fn plan_strict_overlap_remote_mode_asks_the_server() {
    // Scenario「plan --strict-overlap 于 remote 模式走 server」（改写自
    // plan_strict_overlap_remote_mode_still_refuses_without_request：严格重叠不再只限
    // 本机）。印出的是 server 的计划，本机那一份没有被读也没有被改。
    let fake = crate::fake_server::Fake::new();
    fake.route(
        "/api/specseal/v1/projects/demo/binding",
        200,
        r#"{"actor":{"id":"u_1","name":"Tester"},"project":{"id":"prj_1","key":"demo","name":"Demo"},"repo":{"id":"repo_1","key":"backend","name":"Backend"},"apiVersion":"1","engineVersion":"0.1.0","capabilities":{"events":{"transports":[],"polling":{"url":"/sync-state","etag":true}}}}"#,
    )
    .route(
        "/api/specseal/v1/projects/demo/plan",
        200,
        r#"{"waves":[{"index":1,"changes":["x"]},{"index":2,"changes":["y"]}],"changes":[{"name":"x","wave":1,"stage":"proposed","ready":true},{"name":"y","wave":2,"stage":"proposed","blockedBy":["x"],"ready":false}],"next":"x","skipped":[],"strictOverlap":true}"#,
    );
    let p = TempProject::new("strict-remote");
    p.put_change("a", PROPOSED, &[]);
    p.put_change("c", PROPOSED, &[]);
    std::fs::write(p.dir.join(".specseal.yaml"), format!("remote:\n  url: {}\n", fake.project_url())).unwrap();
    let out = p.run_env(&["plan", "--strict-overlap", "--json"], &[("SPECSEAL_TOKEN", "tok")]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert!(!stderr_of(&out).contains("not available in remote mode"), "{}", stderr_of(&out));
    let plan = json_of(&out);
    assert_eq!(
        plan["waves"],
        serde_json::json!([{ "index": 1, "changes": ["x"] }, { "index": 2, "changes": ["y"] }]),
        "the server's plan, not the local changes a and c"
    );
    assert!(fake.paths().contains(&"/api/specseal/v1/projects/demo/plan".to_string()), "{:?}", fake.paths());
    assert_eq!(p.meta("c"), PROPOSED.as_bytes(), "the local copy is untouched");
}

#[test]
fn spec_example_soft_dependency_declared_after_propose() {
    // propose-skill Example「软依赖落档后的 plan 呈现」——两列各一组值。
    // 列 1：add-b 创建在 add-a 的成果上 → change depends add-b --on add-a →
    // add-a 第 1 波、add-b 第 2 波。
    let p = TempProject::new("spec-example-propose");
    p.put_change("add-a", PROPOSED, &["cap-a"]);
    p.put_change(
        "add-b",
        "schema: spec-driven\ncreated: 2026-09-02\n",
        &["cap-b"],
    );
    let out = p.run(&["change", "depends", "add-b", "--on", "add-a"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    let json = json_of(&p.run(&["plan", "--json"]));
    assert_eq!(
        json["waves"],
        serde_json::json!([
            { "index": 1, "changes": ["add-a"] },
            { "index": 2, "changes": ["add-b"] }
        ])
    );
    // 列 2：add-a 与 add-c 无关 → 不下指令 → 同为第 1 波（可平行）。
    let p = TempProject::new("spec-example-propose-parallel");
    p.put_change("add-a", PROPOSED, &["cap-a"]);
    p.put_change(
        "add-c",
        "schema: spec-driven\ncreated: 2026-09-02\n",
        &["cap-c"],
    );
    let json = json_of(&p.run(&["plan", "--json"]));
    assert_eq!(
        json["waves"],
        serde_json::json!([{ "index": 1, "changes": ["add-a", "add-c"] }])
    );
    // 列 3：add-d 只有 5 个 task、add-a 有 40 个且无人依赖；add-a 已有 board_rank，
    // 所以排在 add-d 前面 → change rank add-d --before add-a → 同为第 1 波，
    // 配置顺序 add-d 在前。
    queue_jump_example("spec-example-propose-rank", ("add-a", 40), ("add-d", 5));
}

/// `n` 个未勾选任务的 tasks.md。
fn open_tasks(n: usize) -> String {
    (1..=n).map(|i| format!("- [ ] 1.{i} t\n")).collect()
}

/// propose／ingest 的插队例子：`big` 已有 board_rank（用户拖排过，所以排在前面），
/// 小的 `small` 没有 rank——技能运行 `change rank <small> --before <big>` 后两者
/// 同为第 1 波、small 在前。两者都没有 rank 时新 tie-break 本就让小的在前，
/// 技能不会插队，所以这个前提是例子的一部分。
fn queue_jump_example(tag: &str, big: (&str, usize), small: (&str, usize)) {
    let p = TempProject::new(tag);
    p.put_change(big.0, "schema: spec-driven\ncreated: 2026-09-01\nboard_rank: n\n", &[]);
    p.put_tasks(big.0, &open_tasks(big.1));
    p.put_change(small.0, "schema: spec-driven\ncreated: 2026-09-20\n", &[]);
    p.put_tasks(small.0, &open_tasks(small.1));
    assert_eq!(plan_names(&p), [big.0, small.0], "the ranked big change sits in front");
    let out = p.run(&["change", "rank", small.0, "--before", big.0]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    let json = json_of(&p.run(&["plan", "--json"]));
    assert_eq!(
        json["waves"],
        serde_json::json!([{ "index": 1, "changes": [small.0, big.0] }])
    );
}

#[test]
fn spec_example_ingest_shrunk_change_jumps_the_queue() {
    // ingest-skill Example「中途改需求后添加前置」列 5：add-b（提案中、无 rank）缩到
    // 4 个 task，add-a 有 30 个且无人依赖、已有 board_rank → change rank add-b
    // --before add-a → 两者同波，配置顺序 add-b 在前。
    queue_jump_example("spec-example-ingest-rank", ("add-a", 30), ("add-b", 4));
}

#[test]
fn change_rank_refuses_a_change_without_metadata_before_any_write() {
    // 缺 .meta.yaml 的 change 仍在 plan 里，但没有地方写 rank：不论它是被移动
    // 的那个、还是栏内要补章的那个，都在第一笔写入前拒绝，零写入。
    let p = TempProject::new("rank-no-meta");
    p.put_change("p1", "schema: spec-driven\ncreated: 2026-09-01\n", &[]);
    std::fs::create_dir_all(p.change_dir("p2")).unwrap();
    std::fs::write(p.change_dir("p2").join("proposal.md"), "## Why\nx\n").unwrap();
    p.put_change("p3", "schema: spec-driven\ncreated: 2026-09-03\n", &[]);
    assert_eq!(plan_names(&p), ["p1", "p3", "p2"], "the metadata-less change is planned");

    let out = p.run(&["change", "rank", "p2", "--before", "p1"]);
    assert!(!out.status.success(), "the moved change has no metadata");
    let err = stderr_of(&out);
    assert!(err.contains("specseal/changes/p2/.meta.yaml is missing"), "stderr: {err}");

    let out = p.run(&["change", "rank", "p3", "--before", "p1"]);
    assert!(!out.status.success(), "a change to stamp has no metadata");
    let err = stderr_of(&out);
    assert!(err.contains("specseal/changes/p2/.meta.yaml is missing"), "stderr: {err}");

    for change in ["p1", "p3"] {
        assert_eq!(rank_line(&p.meta(change)), None, "{change} is not stamped");
    }
    assert!(!p.change_dir("p2").join(".meta.yaml").exists());
}
