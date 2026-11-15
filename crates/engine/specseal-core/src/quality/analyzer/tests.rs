use super::*;
use crate::teststore::TestStore;

/// Build an in-memory change out of `(artifact rel path, content)` pairs.
fn store_with(artifacts: &[(&str, &str)]) -> TestStore {
    let store = TestStore::with_meta("demo", "schema: spec-driven\ncreated: 2026-07-01\n");
    for (rel, text) in artifacts {
        store.put_artifact("demo", rel, text);
    }
    store
}

fn report_of(store: &TestStore) -> AnalyzeReport {
    let change = crate::model::find_change(store, "demo").expect("change resolves");
    analyze(store, &change, &crate::schema::spec_driven())
}

fn summaries_of(report: &AnalyzeReport, dimension: &str) -> Vec<String> {
    report
        .findings
        .iter()
        .filter(|f| f.dimension == dimension)
        .map(|f| f.summary.clone())
        .collect()
}

/// Consistency findings for a design/tasks pair (the other dimensions have
/// no prerequisites here, so they stay silent).
fn consistency_of(design: &str, tasks: &str) -> Vec<String> {
    let store = store_with(&[("design.md", design), ("tasks.md", tasks)]);
    summaries_of(&report_of(&store), "Consistency")
}

/// Ambiguity findings for a single delta spec under capability `auth`.
fn ambiguity_report(delta: &str) -> AnalyzeReport {
    report_of(&store_with(&[("specs/auth/spec.md", delta)]))
}

// --- D1：design 标题的编号拆解（spec「Consistency 的 design 标题引用判定」
//     的 Example 表「编号拆解」）---

#[test]
fn a_design_heading_splits_into_ordinal_and_body() {
    let cases: [(&str, Option<&str>, &str); 7] = [
        (
            "决策一：整个移除 listDepthLimit 扩充",
            Some("决策一"),
            "整个移除 listDepthLimit 扩充",
        ),
        ("D3: 搜索列组件化", Some("D3"), "搜索列组件化"),
        (
            "Decision 2 device code 分权责",
            Some("Decision 2"),
            "device code 分权责",
        ),
        (
            "索引 JSON 的形状与推导规则",
            None,
            "索引 JSON 的形状与推导规则",
        ),
        ("D4", Some("D4"), ""),
        // 标题内部多余空白收成一个，tasks 才找得到。
        ("Decision  2 device code", Some("Decision 2"), "device code"),
        // 连续的中文数字是同一个编号。
        ("决策十一：整个移除", Some("决策十一"), "整个移除"),
    ];
    for (heading, label, body) in cases {
        let (got_label, got_body) = split_heading_label(heading);
        assert_eq!(got_label.as_deref(), label, "标题 '{heading}' 的编号");
        assert_eq!(got_body, body, "标题 '{heading}' 的本文");
    }
}

#[test]
fn a_fullwidth_digit_is_not_an_ordinal() {
    // `D<数字>` 只认 ASCII 数字：全角 `D１` 不当编号，整串退回子字符串比对，
    // 所以守卫（只挡 ASCII 英数）与辨识面判准一致。
    let cases: [(&str, Option<&str>, &str); 2] = [
        ("D１ 全角编号", None, "D１ 全角编号"),
        ("决策１：全角编号", None, "决策１：全角编号"),
    ];
    for (heading, label, body) in cases {
        let (got_label, got_body) = split_heading_label(heading);
        assert_eq!(got_label.as_deref(), label, "标题 '{heading}' 的编号");
        assert_eq!(got_body, body, "标题 '{heading}' 的本文");
    }
}

// --- D1：本文或编号任一命中即算引用（spec「Consistency 的 design 标题引用
//     判定」的四个 Scenario）---

#[test]
fn a_heading_body_found_in_tasks_counts_as_referenced() {
    // spec Scenario「本文命中即算引用」。
    let found = consistency_of(
        "### 决策一：整个移除 listDepthLimit 扩充\n",
        "## 2. 实作：整个移除 listDepthLimit 扩充\n",
    );
    assert!(found.is_empty(), "本文命中不得报 finding: {found:?}");
}

#[test]
fn a_heading_ordinal_found_in_tasks_counts_as_referenced() {
    // spec Scenario「编号命中即算引用」。
    let found = consistency_of(
        "### D1 违规清单与聚合错误形状\n",
        "- [ ] 1.1 汇整违规（design D1）\n",
    );
    assert!(found.is_empty(), "编号命中不得报 finding: {found:?}");
}

#[test]
fn an_ordinal_followed_by_a_digit_is_not_a_reference() {
    // spec Scenario「编号后接数字不算命中」：D1 不得被 D12 命中。
    let found = consistency_of("### D1 违规清单与聚合错误形状\n", "- [ ] 1.1 见 D12\n");
    assert_eq!(
        found,
        vec!["Design topic 'd1 违规清单与聚合错误形状' not referenced in tasks".to_string()],
        "D12 不得算 D1 的引用"
    );
    // 对照组：同一份 design，tasks 换成真正的 D1 引用就不报——证明上面那笔
    // 是数字守卫挡下的，不是本文没对上。
    let control = consistency_of("### D1 违规清单与聚合错误形状\n", "- [ ] 1.1 见 D12 与 D1\n");
    assert!(control.is_empty(), "D1 本身仍要算引用: {control:?}");
}

#[test]
fn an_ordinal_inside_an_identifier_is_not_a_reference() {
    // 编号前后都不得是 ASCII 字母或数字：tasks.md 每行都带的 ULID 注解、
    // 文件名 card1 之类都不算 D1 的引用。
    for tasks in [
        "- [ ] 1.1 汇整违规 <!-- specseal-task:tsk_01M22B3PGGD1XQ8R -->\n",
        "- [ ] 1.1 重画 card1 组件\n",
    ] {
        let found = consistency_of("### D1 违规清单与聚合错误形状\n", tasks);
        assert_eq!(found.len(), 1, "识别符内的 d1 不得算引用: {tasks:?} → {found:?}");
    }
}

#[test]
fn a_chinese_numeral_run_is_one_ordinal() {
    // 决策十一 不得被切成 决策十＋一；决策十 也不得被 决策十二 命中。
    let design = "### 决策十一：整个移除 listDepthLimit 扩充\n";
    let hit = consistency_of(design, "- [ ] 1.1 拆除扩充（design 决策十一）\n");
    assert!(hit.is_empty(), "决策十一 要被整个认成编号: {hit:?}");
    let miss = consistency_of("### 决策十：拆分模块\n", "- [ ] 1.1 见决策十二\n");
    assert_eq!(miss.len(), 1, "决策十二 不得算 决策十 的引用: {miss:?}");
}

#[test]
fn a_bare_ordinal_heading_keeps_the_digit_guard() {
    // spec Example 表「编号拆解」第 5 列：本文为空时只比编号，守卫照样生效。
    let missed = consistency_of("### D4\n", "- [ ] 1.1 见 D42\n");
    assert_eq!(missed.len(), 1, "D42 不得算 D4 的引用: {missed:?}");
    let hit = consistency_of("### D4\n", "- [ ] 1.1 见 (design D4)\n");
    assert!(hit.is_empty(), "D4 本身要算引用: {hit:?}");
    // 空本文带冒号的标题也不逼 tasks 抄冒号。
    let colon = consistency_of("### 决策一：\n", "- [ ] 1.1 见决策一）\n");
    assert!(colon.is_empty(), "决策一： 只比编号: {colon:?}");
}

#[test]
fn a_heading_without_an_ordinal_keeps_whole_string_matching() {
    // spec Scenario「无编号标题维持整串比对」。
    let design = "### 索引 JSON 的形状与推导规则\n";
    let partial = consistency_of(design, "- [ ] 1.1 索引 JSON 的形状\n");
    assert_eq!(
        partial,
        vec![
            "Design topic '索引 json 的形状与推导规则' not referenced in tasks".to_string()
        ],
        "只含一半仍要报"
    );
    let whole = consistency_of(design, "- [ ] 1.1 索引 JSON 的形状与推导规则\n");
    assert!(whole.is_empty(), "含整串不得报: {whole:?}");
}

// --- D3：具体值字符集（spec「Ambiguity 的具体值判定」的两个 Scenario 与
//     Example 表）---

/// 一条 ADDED 需求带单一 scenario，内文为 `body`、没有 Example。
fn scenario_is_abstract(body: &str) -> bool {
    let delta = format!(
        "## ADDED Requirements\n\n### Requirement: R\n\nIt SHALL work.\n\n#### Scenario: s\n\n- **THEN** {body}\n"
    );
    ambiguity_report(&delta)
        .findings
        .iter()
        .any(|f| f.summary_msg.key == "ambAbstractScenario.summary")
}

#[test]
fn concrete_values_cover_fullwidth_quotes_and_digits() {
    // spec Example 表「具体值判定」逐列。
    let cases: [(&str, bool); 6] = [
        ("回传 3 笔结果", false),
        ("显示「已封存」", false),
        ("显示『完成』", false),
        ("第１页", false),
        ("回传三笔结果", true),
        ("显示 '完成'", true),
    ];
    for (body, abstract_expected) in cases {
        assert_eq!(
            scenario_is_abstract(body),
            abstract_expected,
            "内文 '{body}' 的抽象判定"
        );
    }
}

#[test]
fn a_fullwidth_quoted_scenario_reports_nothing() {
    // spec Scenario「全角引号内的字符串算具体值」。
    assert!(!scenario_is_abstract("卡片显示「已封存」标签"));
}

#[test]
fn a_plain_narrative_scenario_is_still_abstract() {
    // spec Scenario「纯叙述仍判为抽象」。
    let delta = "## ADDED Requirements\n\n### Requirement: R\n\nIt SHALL work.\n\n#### Scenario: s\n\n- **THEN** 显示成功消息\n";
    let f = ambiguity_report(delta)
        .findings
        .into_iter()
        .find(|f| f.summary_msg.key == "ambAbstractScenario.summary")
        .expect("报一笔 ambAbstractScenario");
    assert_eq!(f.severity, "Suggestion");
    assert_eq!(f.summary, "Scenario 's' has no concrete examples");
}

// --- D6：跨平台换行（design Risks「跨平台」）---

#[test]
fn crlf_line_endings_do_not_break_ordinal_matching() {
    // CRLF 的 design.md 与 tasks.md：`\r` 不得让 D1 判定失准。
    let found = consistency_of(
        "### D1 违规清单与聚合错误形状\r\n",
        "- [ ] 1.1 汇整违规（design D1）\r\n",
    );
    assert!(found.is_empty(), "CRLF 下编号命中不得报: {found:?}");

    let missed = consistency_of("### D1 违规清单与聚合错误形状\r\n", "- [ ] 1.1 见 D12\r\n");
    assert_eq!(
        missed,
        vec!["Design topic 'd1 违规清单与聚合错误形状' not referenced in tasks".to_string()],
        "CRLF 下 D12 仍不得算命中"
    );
}

// --- D5：本次不动的规则的回归网（spec「面向的前置 artifact 与报告形状」、
//     「Coverage 规则」、「Gaps 规则」）---

const ONE_REQ: &str = "## ADDED Requirements\n\n### Requirement: R\n\nIt SHALL work.\n\n#### Scenario: s\n\n- **THEN** 回传 3 笔\n";

fn dimension_status<'a>(report: &'a AnalyzeReport, name: &str) -> &'a DimensionStatus {
    report
        .dimensions
        .iter()
        .find(|d| d.dimension == name)
        .expect("面向存在")
}

#[test]
fn consistency_is_skipped_when_design_is_missing() {
    // spec Scenario「缺 design 时 Consistency 跳过」。
    let store = store_with(&[
        ("proposal.md", "## Why\n\nBecause.\n"),
        ("tasks.md", "- [ ] 1.1 做事\n"),
        ("specs/auth/spec.md", ONE_REQ),
    ]);
    let report = report_of(&store);
    let con = dimension_status(&report, "Consistency");
    assert_eq!(con.status, "Skipped (insufficient artifacts)");
    assert_eq!(con.finding_count, 0);
    assert!(
        report.artifacts_missing.contains(&"design".to_string()),
        "artifacts_missing 含 design: {:?}",
        report.artifacts_missing
    );
}

#[test]
fn an_empty_tasks_file_still_counts_as_present() {
    // spec Scenario「空的 tasks.md 仍算存在」：Consistency 不跳过，每个标题各报一笔。
    let store = store_with(&[
        ("design.md", "### 甲的形状\n\n### 乙的形状\n"),
        ("tasks.md", ""),
    ]);
    let report = report_of(&store);
    assert_eq!(dimension_status(&report, "Consistency").finding_count, 2);
    assert!(
        !report.artifacts_missing.contains(&"tasks".to_string()),
        "空档仍算存在: {:?}",
        report.artifacts_missing
    );
}

#[test]
fn a_requirement_name_inside_a_task_description_is_covered() {
    // spec Scenario「需求名以子字符串命中任务描述」。
    let store = store_with(&[
        ("proposal.md", "## Why\n\nBecause.\n"),
        (
            "specs/auth/spec.md",
            "## ADDED Requirements\n\n### Requirement: CSV Export\n\nIt SHALL work.\n\n#### Scenario: s\n\n- **THEN** 回传 3 笔\n",
        ),
        ("tasks.md", "- [ ] 1.1 Implement CSV exporter\n"),
    ]);
    let found = summaries_of(&report_of(&store), "Coverage");
    assert!(found.is_empty(), "命中不得报 covMissingTask: {found:?}");
}

#[test]
fn requirement_names_match_task_descriptions_as_contiguous_substrings() {
    // spec Example 表「命中判定」逐列。
    let cases: [(&str, bool); 3] = [
        ("Implement csv export", true),
        ("Implement csv-export", false),
        ("Export CSV", false),
    ];
    for (task, covered) in cases {
        assert_eq!(
            req_covered("CSV Export", &[task.to_string()]),
            covered,
            "任务描述 '{task}' 对 'CSV Export' 的命中"
        );
    }
}

#[test]
fn a_requirement_name_only_in_a_group_heading_is_not_covered() {
    // spec Scenario「需求名只出现在群组标题不算命中」。
    let store = store_with(&[
        ("proposal.md", "## Why\n\nBecause.\n"),
        (
            "specs/auth/spec.md",
            "## ADDED Requirements\n\n### Requirement: CSV Export\n\nIt SHALL work.\n\n#### Scenario: s\n\n- **THEN** 回传 3 笔\n",
        ),
        ("tasks.md", "## 2. CSV Export\n"),
    ]);
    let report = report_of(&store);
    let f = report
        .findings
        .iter()
        .find(|f| f.summary_msg.key == "covMissingTask.summary")
        .expect("报一笔 covMissingTask");
    assert_eq!(f.severity, "Warning");
    assert_eq!(f.summary, "Requirement 'CSV Export' has no matching task");
    assert_eq!(f.location, "specs/auth/spec.md");
}

#[test]
fn a_modified_requirement_absent_from_the_canonical_spec_is_a_gap() {
    // spec Scenario「MODIFIED 需求不在正式规格」。
    let store = store_with(&[
        ("proposal.md", "## Why\n\nBecause.\n"),
        (
            "specs/auth/spec.md",
            "## MODIFIED Requirements\n\n### Requirement: R9\n\nIt SHALL work harder.\n\n#### Scenario: s\n\n- **THEN** 回传 3 笔\n",
        ),
    ]);
    store.canonical.borrow_mut().insert(
        "auth".to_string(),
        "# auth Specification\n\n## Requirements\n\n### Requirement: R1\n\nIt SHALL work.\n".to_string(),
    );
    let report = report_of(&store);
    let f = report
        .findings
        .iter()
        .find(|f| f.summary_msg.key == "gapModifiedNotFound.summary")
        .expect("报一笔 gapModifiedNotFound");
    assert_eq!(f.summary, "MODIFIED requirement 'R9' not found in main spec");
    assert_eq!(f.recommendation_msg.params.get("spec").map(String::as_str), Some("auth"));
}

#[test]
fn a_missing_canonical_spec_is_reported_once_per_capability() {
    // spec Scenario「无正式规格时每 capability 一笔」。
    let store = store_with(&[
        ("proposal.md", "## Why\n\nBecause.\n"),
        (
            "specs/auth/spec.md",
            "## MODIFIED Requirements\n\n### Requirement: R1\n\nIt SHALL work.\n\n#### Scenario: s\n\n- **THEN** 回传 3 笔\n\n### Requirement: R2\n\nIt SHALL work.\n\n#### Scenario: t\n\n- **THEN** 回传 4 笔\n",
        ),
    ]);
    let report = report_of(&store);
    let hits: Vec<&Finding> = report
        .findings
        .iter()
        .filter(|f| f.summary_msg.key == "gapNoMainSpec.summary")
        .collect();
    assert_eq!(hits.len(), 1, "2 条 MODIFIED 只报 1 笔: {hits:?}");
    assert_eq!(
        hits[0].summary,
        "MODIFIED requirements reference capability 'auth' but no main spec found"
    );
}

// --- D4：英文弱语气词改字边界（spec「Ambiguity 的弱语气词侦测——英文样式
//     should、may、might、consider、possibly 以字边界比对」）---

#[test]
fn english_weak_language_matches_on_word_boundaries() {
    // spec Example 表「字边界判定」逐列。
    let cases: [(&str, Option<&str>); 9] = [
        ("it should lock", Some("should")),
        ("Should lock", Some("should")),
        ("the shoulder strap", None),
        ("a considerable delay", None),
        ("the mayor", None),
        ("outbdoor", Some("TBD")),
        // 字边界的代价（design D4 刻意接受）：maybe／considered 不再命中。
        ("maybe lock", None),
        ("considered done", None),
        // 撇号不是字母，shouldn't 的 should 照样命中。
        ("it shouldn't lock", Some("should")),
    ];
    for (line, pattern) in cases {
        assert_eq!(
            weak_pattern_in(line).as_deref(),
            pattern,
            "行 '{line}' 的弱语气词"
        );
    }
}

#[test]
fn a_boundary_blocked_line_reports_no_weak_language() {
    // spec Scenario「字边界挡住 shoulder」。
    let delta = "## ADDED Requirements\n\n### Requirement: R\n\nThe shoulder strap SHALL lock.\n\n#### Scenario: s\n\n- **THEN** 回传 3 笔\n";
    let found = summaries_of(&ambiguity_report(delta), "Ambiguity");
    assert!(found.is_empty(), "shoulder 不得命中: {found:?}");
}

#[test]
fn a_standalone_should_still_reports() {
    // spec Scenario「独立的 should 仍命中」。
    let delta = "## ADDED Requirements\n\n### Requirement: R\n\nThe strap should lock.\n\n#### Scenario: s\n\n- **THEN** 回传 3 笔\n";
    let f = ambiguity_report(delta)
        .findings
        .into_iter()
        .find(|f| f.summary_msg.key == "ambWeakLanguage.summary")
        .expect("报一笔 ambWeakLanguage");
    assert_eq!(f.severity, "Suggestion");
    assert_eq!(f.summary, "Vague language 'should' found");
    assert_eq!(f.location, "specs/auth/spec.md:5");
}

#[test]
fn cjk_weak_language_keeps_substring_matching() {
    // spec Scenario「CJK 样式维持子字符串——可能、应该、考虑」。
    assert_eq!(weak_pattern_in("系统尽可能锁定").as_deref(), Some("可能"));
    assert_eq!(weak_pattern_in("这不可能发生"), None);
}

// --- D2：REMOVED 需求改查 Reason／Migration（spec「Ambiguity 的 scenario
//     缺席与 REMOVED 需求检查」的三个 Scenario）---

const REMOVED_COMPLETE: &str = "## REMOVED Requirements\n\n### Requirement: Legacy export\n\n**Reason**: Replaced by v2\n**Migration**: Use /api/v2/export\n";

#[test]
fn a_removed_requirement_with_reason_and_migration_is_clean() {
    // spec Scenario「REMOVED 需求齐备时零 finding」。
    let report = ambiguity_report(REMOVED_COMPLETE);
    let found = summaries_of(&report, "Ambiguity");
    assert!(found.is_empty(), "齐备的 REMOVED 需求不得报 finding: {found:?}");
}

#[test]
fn removal_note_lines_accept_colon_variants() {
    // `**Reason:**` 与全角 `**Migration：**` 都是本 repo 实际出现的写法。
    let report = ambiguity_report(
        "## REMOVED Requirements\n\n### Requirement: Legacy export\n\n**Reason:** Replaced by v2\n**Migration：** Use v2\n",
    );
    let found = summaries_of(&report, "Ambiguity");
    assert!(found.is_empty(), "冒号在粗体内也要认: {found:?}");
    // 但 `**Reasoning**` 不算。
    let report = ambiguity_report(
        "## REMOVED Requirements\n\n### Requirement: Legacy export\n\n**Reasoning** Replaced by v2\n**Migration**: Use v2\n",
    );
    let f = report
        .findings
        .iter()
        .find(|f| f.summary_msg.key == "ambRemovedNoNotes.summary")
        .expect("Reasoning 不算 Reason");
    assert_eq!(f.summary_msg.params.get("missing").map(String::as_str), Some("Reason"));
}

#[test]
fn a_removed_requirement_with_scenarios_is_still_held_to_its_notes() {
    // REMOVED 需求带 scenario 不违规，也不需要 scenario；但 Reason／Migration
    // 只认需求本文（scenario 之前）的行。
    let clean = ambiguity_report(
        "## REMOVED Requirements\n\n### Requirement: Legacy export\n\n**Reason**: Replaced\n**Migration**: Use v2\n\n#### Scenario: s\n\n- **THEN** 回传 3 笔\n",
    );
    let found = summaries_of(&clean, "Ambiguity");
    assert!(found.is_empty(), "带 scenario 的 REMOVED 需求齐备时零 finding: {found:?}");
    let inside = ambiguity_report(
        "## REMOVED Requirements\n\n### Requirement: Legacy export\n\n**Migration**: Use v2\n\n#### Scenario: s\n\n**Reason**: 回传 3 笔\n",
    );
    let f = inside
        .findings
        .iter()
        .find(|f| f.summary_msg.key == "ambRemovedNoNotes.summary")
        .expect("scenario 内的 **Reason** 不算");
    assert_eq!(f.summary_msg.params.get("missing").map(String::as_str), Some("Reason"));
}

#[test]
fn a_removed_requirement_missing_migration_is_flagged() {
    // spec Scenario「REMOVED 需求缺 Migration」。
    let report = ambiguity_report(
        "## REMOVED Requirements\n\n### Requirement: Legacy export\n\n**Reason**: Replaced by v2\n",
    );
    let f = report
        .findings
        .iter()
        .find(|f| f.summary_msg.key == "ambRemovedNoNotes.summary")
        .expect("报一笔 ambRemovedNoNotes");
    assert_eq!(f.severity, "Warning");
    assert_eq!(f.summary, "REMOVED requirement 'Legacy export' has no **Migration**");
    assert_eq!(
        f.recommendation,
        "Add **Reason**: and **Migration**: lines under 'Legacy export'"
    );
    assert_eq!(f.summary_msg.params.get("req").map(String::as_str), Some("Legacy export"));
    assert_eq!(f.summary_msg.params.get("missing").map(String::as_str), Some("Migration"));
    assert_eq!(f.recommendation_msg.key, "ambRemovedNoNotes.recommendation");
    assert_eq!(f.recommendation_msg.params, f.summary_msg.params);
}

#[test]
fn a_removed_requirement_missing_both_lists_them_together() {
    let report = ambiguity_report("## REMOVED Requirements\n\n### Requirement: Legacy export\n\nGone.\n");
    let f = report
        .findings
        .iter()
        .find(|f| f.summary_msg.key == "ambRemovedNoNotes.summary")
        .expect("报一笔 ambRemovedNoNotes");
    assert_eq!(
        f.summary,
        "REMOVED requirement 'Legacy export' has no **Reason** and **Migration**"
    );
    assert_eq!(
        f.summary_msg.params.get("missing").map(String::as_str),
        Some("Reason and Migration")
    );
}

#[test]
fn an_added_requirement_without_scenarios_still_reports_no_scenario() {
    // spec Scenario「ADDED 需求无 scenario 仍报」。
    let report = ambiguity_report("## ADDED Requirements\n\n### Requirement: Fresh\n\nIt SHALL work.\n");
    let f = report
        .findings
        .iter()
        .find(|f| f.summary_msg.key == "ambNoScenario.summary")
        .expect("报一笔 ambNoScenario");
    assert_eq!(f.summary, "Requirement 'Fresh' has no scenarios");
}

#[test]
fn the_removed_finding_serializes_both_params() {
    // `--json` 契约：summary_msg.params 带 req 与 missing 两键。
    let report = ambiguity_report("## REMOVED Requirements\n\n### Requirement: Legacy export\n\n**Migration**: Use v2\n");
    let json = serde_json::to_value(&report).expect("报告可串行化");
    let params = json["findings"]
        .as_array()
        .expect("findings 是数组")
        .iter()
        .find(|f| f["summary_msg"]["key"] == "ambRemovedNoNotes.summary")
        .expect("找得到该 finding")["summary_msg"]["params"]
        .clone();
    assert_eq!(params["req"], "Legacy export");
    assert_eq!(params["missing"], "Reason");
}

#[test]
fn the_wadpilot_false_positive_is_gone() {
    // 回溯来源：本文与编号同时出现在一行群组标题里。
    let found = consistency_of(
        "### 决策一：整个移除 listDepthLimit 扩充\n",
        "## 2. 实作：整个移除 listDepthLimit 扩充（design 决策一）\n",
    );
    assert!(found.is_empty(), "wadpilot 实例必须零 finding: {found:?}");
}
