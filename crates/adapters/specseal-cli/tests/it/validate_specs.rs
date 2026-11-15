//! `specseal validate --specs` 的正式规格验证 — fs 模式契约
//! (spec spec-validation「validate --specs 验证正式规格」)。
//!
//! 缺 `## Purpose` 区段或内容为空以 error 呈现并非零收尾；残留的 archive 占位
//! 以 warning 显形（不依附 --strict）；内容过短只在 --strict 下报 warning。
//! `--specs` 单独传入时不验 changes，两旗标皆缺席时行为与接线前一致。

use std::path::PathBuf;
use std::process::{Command, Output};

const META: &str = "schema: spec-driven\ncreated: 2026-07-01\n";
/// archive 占位文案：长度恒超过门槛，只有前缀判准抓得到它。
const PLACEHOLDER_PURPOSE: &str =
    "TBD - created by archiving change 'old-one'. Update Purpose after archive.";
const GOOD_PURPOSE: &str =
    "本 capability 负责搜索结果的排序与分页，涵盖查找改写、排序权重与空结果的可观察行为。";

struct TempProject {
    dir: PathBuf,
}

impl TempProject {
    /// 一个 change `demo`（供「只验规格」对照）＋调用端指定的正式规格。
    fn new(tag: &str, specs: &[(&str, Option<&str>)]) -> TempProject {
        let dir = std::env::temp_dir()
            .join(format!("specseal-cli-validate-specs-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".specseal.yaml"), "tools:\n  - claude\n").unwrap();
        let change = dir.join("specseal").join("changes").join("demo");
        std::fs::create_dir_all(&change).unwrap();
        std::fs::write(change.join(".meta.yaml"), META).unwrap();
        std::fs::write(change.join("proposal.md"), "## Why\n\nDemo.\n").unwrap();
        std::fs::write(change.join("tasks.md"), "- [ ] 1.1 a\n").unwrap();
        for (cap, purpose) in specs {
            let dir_cap = dir.join("specseal").join("specs").join(cap);
            std::fs::create_dir_all(&dir_cap).unwrap();
            let body = match purpose {
                Some(p) => format!("# {cap} Specification\n\n## Purpose\n\n{p}\n\n## Requirements\n\n### Requirement: R1\n\nIt SHALL work.\n"),
                None => format!("# {cap} Specification\n\n## Requirements\n\n### Requirement: R1\n\nIt SHALL work.\n"),
            };
            std::fs::write(dir_cap.join("spec.md"), body).unwrap();
        }
        TempProject { dir }
    }

    /// 写入 change `demo` 的一份 delta spec（守门案例用）。
    fn put_delta(&self, cap: &str, text: &str) {
        let dir = self
            .dir
            .join("specseal")
            .join("changes")
            .join("demo")
            .join("specs")
            .join(cap);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("spec.md"), text).unwrap();
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
}

impl Drop for TempProject {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn stdout_of(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).to_string()
}

#[test]
fn placeholder_purpose_surfaces_as_a_warning_without_strict() {
    // spec Scenario「占位 Purpose 以 warning 显形」：非 strict 也报，且占位句
    // 长于门槛——拦下它的是前缀判准，不是长度。
    let p = TempProject::new("placeholder", &[("search", Some(PLACEHOLDER_PURPOSE))]);
    let out = p.run(&["validate", "--specs", "--no-color"]);
    let stdout = stdout_of(&out);
    assert!(out.status.success(), "占位只是 warning，不得非零收尾: {stdout}");
    assert!(stdout.contains("search"), "点名该规格: {stdout}");
    assert!(stdout.contains("warn:"), "以 warning 呈现: {stdout}");
}

#[test]
fn a_short_purpose_is_silent_until_strict() {
    // spec Scenario「过短 Purpose 仅 strict 报 warning」。
    let p = TempProject::new("short", &[("search", Some("太短。"))]);
    let lenient = p.run(&["validate", "--specs", "--no-color"]);
    assert!(lenient.status.success(), "非 strict 零收尾");
    assert!(!stdout_of(&lenient).contains("warn:"), "非 strict 不报过短: {}", stdout_of(&lenient));

    let strict = p.run(&["validate", "--specs", "--strict", "--no-color"]);
    let stdout = stdout_of(&strict);
    assert!(strict.status.success(), "过短是 warning，仍零收尾: {stdout}");
    assert!(stdout.contains("warn:") && stdout.contains("50"), "strict 报门槛: {stdout}");
}

#[test]
fn a_missing_purpose_section_fails_the_command() {
    // spec Scenario「缺 Purpose 区段报 error」：该规格 invalid、命令非零收尾。
    let p = TempProject::new("missing", &[("search", None), ("net", Some(GOOD_PURPOSE))]);
    let out = p.run(&["validate", "--specs", "--no-color"]);
    let stdout = stdout_of(&out);
    assert!(!out.status.success(), "任一 error 非零收尾: {stdout}");
    assert!(stdout.contains("✗ search — invalid"), "缺段的规格 invalid: {stdout}");
    assert!(stdout.contains("✓ net — valid"), "合格的规格照常通过: {stdout}");
    assert!(stdout.contains("specs/search/spec.md"), "error 带逻辑路径: {stdout}");
}

#[test]
fn specs_flag_with_an_item_name_is_rejected() {
    // spec Scenario「--specs 与 change 名称同传被拒」：组合语意不连贯（--specs
    // 无法指定单一规格），大声拒绝并指路 --specs 单独或 --all。
    let p = TempProject::new("conflict", &[("search", Some(GOOD_PURPOSE))]);
    let out = p.run(&["validate", "demo", "--specs", "--no-color"]);
    assert!(!out.status.success(), "the combination must refuse");
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    assert!(stderr.contains("--specs"), "the flag is named: {stderr}");
    assert!(stderr.contains("--all"), "the way out is named: {stderr}");
}

#[test]
fn specs_flag_alone_does_not_validate_changes() {
    // spec：`--specs` 单独传入时仅验规格；缺省（皆缺席）维持只验 changes。
    let p = TempProject::new("scope", &[("search", Some(GOOD_PURPOSE))]);
    let specs_only = stdout_of(&p.run(&["validate", "--specs", "--no-color"]));
    assert!(specs_only.contains("search"), "规格有验: {specs_only}");
    assert!(!specs_only.contains("demo"), "change 不该出现: {specs_only}");

    let default = stdout_of(&p.run(&["validate", "--no-color"]));
    assert!(default.contains("demo"), "缺省验 change: {default}");
    assert!(!default.contains("search"), "缺省不验规格: {default}");

    let all = stdout_of(&p.run(&["validate", "--all", "--no-color"]));
    assert!(all.contains("demo") && all.contains("search"), "--all 两边都验: {all}");
}

// --- change 验证纳入合并守门（spec spec-validation「change 验证纳入合并守门」）---

/// 正典只有 `R1`，delta 却 MODIFIED 一个已不存在的 `R9`——archive 会拒收的形状。
const STALE_MODIFIED: &str = "## MODIFIED Requirements\n\n### Requirement: R9\n\nIt SHALL work harder.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n";
/// 守门 error 的冻结组字（design D2）。
const GATE_ERROR: &str = "specs/auth/spec.md: MODIFIED 'R9': target requirement no longer exists in the canonical spec (see: specseal drift demo)";

#[test]
fn a_stale_modified_delta_fails_change_validation() {
    // spec Scenario「MODIFIED 目标不存在时 validate 报 error」：人眼与 --json
    // 两条输出都是契约，两边都验。
    let p = TempProject::new("gate", &[("auth", Some(GOOD_PURPOSE))]);
    p.put_delta("auth", STALE_MODIFIED);

    let out = p.run(&["validate", "demo", "--no-color"]);
    let stdout = stdout_of(&out);
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    assert!(!out.status.success(), "守门违规非零收尾: {stdout}");
    assert!(stdout.contains("✗ demo — invalid"), "change 列为 invalid: {stdout}");
    assert!(stdout.contains(GATE_ERROR), "error 行逐字列出: {stdout}");
    assert!(stderr.contains("Validation failed."), "以 Validation failed. 收尾: {stderr}");

    let out = p.run(&["validate", "demo", "--json"]);
    let stdout = stdout_of(&out);
    assert!(!out.status.success(), "--json 同样非零收尾: {stdout}");
    let v: serde_json::Value = serde_json::from_str(&stdout).expect("stdout is JSON");
    let first = &v[0];
    for field in ["change", "errors", "valid", "warnings"] {
        assert!(!first[field].is_null(), "四栏齐备，缺 {field}: {v}");
    }
    assert_eq!(first["valid"], serde_json::json!(false), "valid 为 false: {v}");
    assert!(
        first["errors"].as_array().expect("errors 是数组").iter().any(|e| e == GATE_ERROR),
        "errors 含守门字符串: {v}"
    );
}

#[test]
fn validate_and_drift_name_the_same_stale_operation() {
    // spec archive-merge「过期判定单源共用」：validate 与 drift 读同一支判定，
    // 对同一 delta 指向同一 capability 与需求名。
    let p = TempProject::new("gate-drift", &[("auth", Some(GOOD_PURPOSE))]);
    p.put_delta("auth", STALE_MODIFIED);

    let validated = stdout_of(&p.run(&["validate", "demo", "--no-color"]));
    assert!(validated.contains(GATE_ERROR), "validate 报守门 error: {validated}");

    let drifted = stdout_of(&p.run(&["drift", "demo", "--no-color"]));
    assert!(
        drifted.contains("MODIFIED 'R9' in auth"),
        "drift 的 spec assumption 指向同一 capability 与需求名: {drifted}"
    );
    assert!(
        drifted.contains("target requirement no longer exists in the canonical spec"),
        "reason 同一份字符串: {drifted}"
    );

    // 四处判定一致的另外两条腿，同一个 fixture 上成立：bulk 预检以拒绝语意
    // 提前过滤，单笔 archive 逐栏拒绝。
    let bulk = stdout_of(&p.run(&["archive", "--all", "--no-color"]));
    assert!(
        bulk.contains("Skipped: demo — 1 delta operation(s) archive would refuse"),
        "bulk 预检读同一判定: {bulk}"
    );
    // 单笔封存的守门序只在 archive() 一份（任务完成度先于 merge 守门）：先把任务
    // 勾齐，让 merge 守门成为唯一的拒绝理由。
    std::fs::write(
        p.dir.join("specseal").join("changes").join("demo").join("tasks.md"),
        "- [x] 1.1 a\n",
    )
    .unwrap();
    let single = p.run(&["archive", "demo", "--no-color"]);
    let stderr = String::from_utf8_lossy(&single.stderr).to_string();
    assert!(!single.status.success(), "单笔 archive 拒绝: {stderr}");
    assert!(
        stderr.contains("auth / MODIFIED / R9: target requirement no longer exists"),
        "单笔 archive 指向同一 capability 与需求名: {stderr}"
    );
}
