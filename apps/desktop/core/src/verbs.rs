//! 动词操作：validate / analyze / archive，经内嵌 core 运行。
//!
//! 可观察结果（成功数据、失败消息与语意）对应 CLI 对应指令；失败回传 `Err` 附消息，
//! 不静默吞掉。park/unpark 不在此——该功能已从 specseal 移除（见 core inprogress.rs）。

use std::path::Path;

use serde_json::Value;
use specseal_core::station::{self, REVIEW, VERIFY};
use specseal_core::store::Store;

use crate::init_core_context;

/// 对应 `specseal validate <change>`：回传该 change 的 `ValidationResult`（valid/errors/warnings）。
pub fn validate_at(root: &Path, change: &str) -> Result<Value, String> {
    let ctx = crate::require_context_for_change(root, change)?;
    let store: &dyn Store = &ctx.store;
    let change = find(store, change)?;
    // 与 CLI 一致：以 change 自己的 schema 验证，解析不到时以 spec-driven 代之。
    let user_dir = specseal_host::context::global_config_dir();
    let schema =
        specseal_core::validate::change_schema(Some(&ctx.workspace), Some(&user_dir), &change);
    let result = specseal_core::validate::validate_change(store, &change, &schema, false);
    serde_json::to_value(&result).map_err(|e| e.to_string())
}

/// 对应 `specseal analyze <change> --json`：回传 `AnalyzeReport`（含 findings 与各维度状态）。
pub fn analyze_at(root: &Path, change: &str) -> Result<Value, String> {
    let ctx = crate::require_context_for_change(root, change)?;
    let store: &dyn Store = &ctx.store;
    let change = find(store, change)?;
    let schema = specseal_core::schema::spec_driven();
    let report = specseal_core::analyzer::analyze(store, &change, &schema);
    serde_json::to_value(&report).map_err(|e| e.to_string())
}

/// 对应 `specseal archive <change>`：以缺省选项归档（先验证）。前置未满足时回传 `Err`
/// 且不标记归档（core::archive 在失败时不搬移 change）。
pub fn archive_at(root: &Path, change: &str) -> Result<Value, String> {
    archive_with(root, change, false, false)
}

/// 对应 `specseal archive <change> [--carry-review] [--carry-verify]`：带未结
/// 工单封存（封存入口三选项的「照样带走」；spec「封存入口三选项扩及验证工单」）。
/// 两个旗标各自独立——双工单并存时用户对两站分别处置，决定在此汇合。
pub fn archive_carry_at(
    root: &Path,
    change: &str,
    carry_review: bool,
    carry_verify: bool,
) -> Result<Value, String> {
    archive_with(root, change, carry_review, carry_verify)
}

/// 对应 `specseal review discard <change>`：删工单、不盖章（三选项的「放弃审查」）。
pub fn discard_review_at(root: &Path, change: &str) -> Result<Value, String> {
    let ctx = crate::require_context_for_change(root, change)?;
    let store: &dyn Store = &ctx.store;
    station::discard(&REVIEW, store, change).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "change": change, "discarded": true }))
}

/// 对应 `specseal verify discard <change>`：删工单、不盖章（三选项的「放弃验证」）。
pub fn discard_verify_at(root: &Path, change: &str) -> Result<Value, String> {
    let ctx = crate::require_context_for_change(root, change)?;
    let store: &dyn Store = &ctx.store;
    station::discard(&VERIFY, store, change).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "change": change, "discarded": true }))
}

fn archive_with(
    root: &Path,
    change: &str,
    carry_review: bool,
    carry_verify: bool,
) -> Result<Value, String> {
    let ctx = open(root)?;
    crate::query::refuse_if_worktree_is_open(&ctx, change)?;
    let store: &dyn Store = &ctx.store;
    let change = find(store, change)?;
    let opts =
        specseal_core::archive::ArchiveOptions { carry_review, carry_verify, ..Default::default() };
    let actor = crate::manage::cached_git_identity(&ctx.workspace.root);
    let outcome = specseal_core::archive::archive(&ctx.workspace, store, &change, &opts, actor.as_deref())
        .map_err(|e| e.to_string())?;
    // ArchiveOutcome 未实作 Serialize；GUI 需要的结果字段以 camelCase 手动组出。
    Ok(serde_json::json!({
        "changeName": outcome.change_name,
        "datedName": outcome.dated_name,
        "snapshotCreated": outcome.snapshot_created,
        "skippedSpecs": outcome.skipped_specs,
    }))
}

pub(crate) fn open(root: &Path) -> Result<crate::ProjectContext, String> {
    init_core_context(root).ok_or_else(|| format!("not a specseal project: {}", root.display()))
}

fn find(store: &dyn Store, change: &str) -> Result<specseal_core::model::Change, String> {
    store
        .find_change(change)
        .ok_or_else(|| format!("change not found: {change}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testfixture::FixtureRoot;

    fn valid_fixture(tag: &str) -> FixtureRoot {
        let fx = FixtureRoot::new(tag);
        fx.add_change("demo", "schema: spec-driven\ncreated: 2026-07-01\n");
        fx.write(
            "specseal/changes/demo/specs/cap-x/spec.md",
            "## Purpose\n\n本 capability 是测试用的示范能力，涵盖一个可观察行为与其成功路径，专供桌面动词的测试取用。\n\n## ADDED Requirements\n\n### Requirement: Demo works\n\nIt SHALL work.\n\n#### Scenario: works\n\n- **WHEN** used\n- **THEN** it works\n",
        );
        fx
    }

    #[test]
    fn validate_reports_valid_for_a_valid_change() {
        let fx = valid_fixture("v-valid");
        let v = validate_at(fx.root(), "demo").expect("validate ok");
        assert_eq!(v["valid"], true);
        assert!(v.get("errors").is_some() && v.get("warnings").is_some());
    }

    #[test]
    fn validate_unknown_change_errors() {
        let fx = valid_fixture("v-unknown");
        assert!(validate_at(fx.root(), "no-such-change-xyz").is_err());
    }

    #[test]
    fn analyze_returns_report_with_findings_array() {
        let fx = valid_fixture("v-analyze");
        let v = analyze_at(fx.root(), "demo").expect("analyze ok");
        assert!(v["findings"].is_array(), "report exposes findings array");
    }

    #[test]
    fn archive_is_refused_while_the_change_has_a_worktree() {
        // spec worktree-overlay「worktree 挂着时的 desktop 动词防护」Scenario
        // 「封存被挡」：动词拒绝、消息指出收尾方式、change 仍在原处。
        let fx = valid_fixture("v-archive-wt");
        fx.attach_worktree("demo");

        let err = archive_at(fx.root(), "demo").expect_err("有 worktree 映射时必须拒绝");
        assert!(err.contains("worktree-merge"), "须指出收尾方式: {err}");
        assert!(err.contains("demo"), "须指名 change: {err}");

        let ctx = crate::init_core_context(fx.root()).unwrap();
        assert!(
            specseal_core::store::Store::change_exists(&ctx.store, "demo"),
            "拒绝时 change 不得被搬走"
        );
        // 「照样带走」入口走同一守门。
        assert!(archive_carry_at(fx.root(), "demo", true, true).is_err());
    }

    #[test]
    fn the_guard_lifts_once_the_worktree_is_removed() {
        // Scenario「收尾后解禁」：worktree 移除后守门退场，动词照常走既有前置。
        let fx = valid_fixture("v-archive-wt-gone");
        fx.attach_worktree("demo");
        assert!(archive_at(fx.root(), "demo").is_err());

        let out = std::process::Command::new("git")
            .args(["worktree", "remove", "--force", "wt"])
            .current_dir(fx.root())
            .output()
            .expect("run git");
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));

        let err = archive_at(fx.root(), "demo").expect_err("仍受既有前置挡（任务未完成）");
        assert!(!err.contains("worktree-merge"), "worktree 守门须已退场: {err}");
    }

    #[test]
    fn validate_and_analyze_read_the_worktree_copy() {
        // spec worktree-overlay Scenario「分析报告反映 worktree 现值」：验证与分析
        // 吃的是 worktree 副本的 artifact——主 checkout 的旧内容不该左右结果。
        let fx = valid_fixture("v-analyze-wt");
        // 主 checkout 的 delta spec 退化成无场景版（validate 判不合格、零 Ambiguity）。
        fx.write(
            "specseal/changes/demo/specs/cap-x/spec.md",
            "## Purpose\n\n本 capability 是测试用的示范能力，涵盖一个可观察行为与其成功路径，专供桌面动词的测试取用。\n\n## ADDED Requirements\n\n### Requirement: Demo works\n\nIt SHALL work.\n",
        );
        let wt = fx.attach_worktree("demo");
        std::fs::write(
            wt.change_dir("demo")
                .join("specs")
                .join("cap-x")
                .join("spec.md"),
            "## Purpose\n\n本 capability 是测试用的示范能力，涵盖一个可观察行为与其成功路径，专供桌面动词的测试取用。\n\n## ADDED Requirements\n\n### Requirement: Demo works\n\nIt SHALL work.\n\n#### Scenario: works\n\n- **WHEN** used\n- **THEN** it works\n\n#### Scenario: also works\n\n- **WHEN** used again\n- **THEN** it still works\n",
        )
        .unwrap();

        let v = validate_at(fx.root(), "demo").expect("validate ok");
        assert_eq!(v["valid"], true, "验证须读副本的合格版本: {v}");

        let report = analyze_at(fx.root(), "demo").expect("analyze ok");
        let ambiguity = report["findings"]
            .as_array()
            .expect("findings array")
            .iter()
            .filter(|f| f["dimension"] == "Ambiguity")
            .count();
        assert_eq!(ambiguity, 2, "分析报告须依副本的两个场景产出: {report}");
    }

    #[test]
    fn read_only_verbs_are_unaffected_by_a_worktree() {
        // 唯读面不挡：抽屉与查看在 worktree 挂着时照常。
        let fx = valid_fixture("v-readonly-wt");
        fx.attach_worktree("demo");
        assert!(validate_at(fx.root(), "demo").is_ok());
        assert!(analyze_at(fx.root(), "demo").is_ok());
    }

    #[test]
    fn archive_unmet_prerequisite_errors_and_does_not_archive() {
        // 不存在的 change 无法归档——安全地验证失败语意，不触碰 fixture change 文件。
        let fx = valid_fixture("v-archive");
        assert!(archive_at(fx.root(), "no-such-change-xyz").is_err());
        let ctx = crate::init_core_context(fx.root()).unwrap();
        assert!(specseal_core::store::Store::change_exists(&ctx.store, "demo"));
    }
}
