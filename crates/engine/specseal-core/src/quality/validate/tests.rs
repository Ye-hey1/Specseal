use super::*;
use crate::teststore::TestStore;

/// 一份合格的 Purpose 内容（60 字符以上，spec Scenario「新开 capability 的
/// Purpose 合格则通过」的取值）。
const GOOD_PURPOSE: &str = "本 capability 管理权杖的轮替与撤销，涵盖签发、验证与失效三段生命周期的可观察行为，以及逾期权杖的清理时机。";

fn delta(purpose: Option<&str>, operation: &str) -> String {
    match purpose {
        Some(p) => format!("## Purpose\n\n{p}\n\n{operation}"),
        None => operation.to_string(),
    }
}

const ADDED: &str = "## ADDED Requirements\n\n### Requirement: Fresh\n\nIt SHALL work.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n";
const MODIFIED: &str = "## MODIFIED Requirements\n\n### Requirement: R1\n\nIt SHALL work harder.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n";
const CANON: &str = "# auth Specification\n\n## Purpose\n\nAuth.\n\n## Requirements\n\n### Requirement: R1\n\nIt SHALL work.\n";

fn store_for(deltas: &[(&str, &str)], canon: &[(&str, &str)]) -> TestStore {
    let store = TestStore::with_meta("demo", "schema: spec-driven\ncreated: 2026-07-01\n");
    for (cap, text) in deltas {
        store.put_artifact("demo", &crate::model::delta_spec_artifact(cap), text);
    }
    for (cap, text) in canon {
        store.canonical.borrow_mut().insert((*cap).to_string(), (*text).to_string());
    }
    store
}

fn result_for(deltas: &[(&str, &str)], canon: &[(&str, &str)]) -> ValidationResult {
    let store = store_for(deltas, canon);
    let change = crate::model::find_change(&store, "demo").expect("change resolves");
    validate_change(&store, &change, &crate::schema::spec_driven(), false)
}

// --- 新开 capability 的 Purpose 早期检查（design D2；spec spec-validation
//     「新开 capability 的 change 验证早期检查」）---

#[test]
fn new_capability_without_purpose_is_an_error() {
    // spec Scenario「新开 capability 缺 Purpose 验证报 error」。
    let r = result_for(&[("token", &delta(None, ADDED))], &[]);
    assert!(!r.valid, "验证结果必须 invalid");
    let joined = r.errors.join("\n");
    assert!(joined.contains("token"), "error 指名该 capability: {joined}");
    assert!(joined.contains("## Purpose"), "error 附范例骨架: {joined}");
}

#[test]
fn new_capability_with_a_qualified_purpose_passes() {
    // spec Scenario「新开 capability 的 Purpose 合格则通过」。
    let r = result_for(&[("token", &delta(Some(GOOD_PURPOSE), ADDED))], &[]);
    assert!(r.valid, "合格 Purpose 不得报 error: {:?}", r.errors);
    assert!(r.warnings.is_empty(), "也不得报 warning: {:?}", r.warnings);
}

#[test]
fn new_capability_with_a_too_short_purpose_is_an_error() {
    // 判准三态的第三态：区段在、内容非空但不足门槛——同样挡在 change 验证。
    let r = result_for(&[("token", &delta(Some("管权杖。"), ADDED))], &[]);
    assert!(!r.valid, "过短 Purpose 必须 invalid: {:?}", r.errors);
    let joined = r.errors.join("\n");
    assert!(
        joined.contains(&crate::model::MIN_PURPOSE_LENGTH.to_string()),
        "error 报出门槛字符数: {joined}"
    );
}

#[test]
fn existing_capability_without_purpose_reports_nothing() {
    // spec Scenario「既有 capability 的 delta 不受 Purpose 检查影响」：
    // 既有 capability 的 delta Purpose 属忽略语意，缺席不构成违规。
    let r = result_for(&[("auth", &delta(None, MODIFIED))], &[("auth", CANON)]);
    assert!(r.valid, "既有 capability 不得因 Purpose 报 error: {:?}", r.errors);
    assert!(r.warnings.is_empty(), "也不得报 warning: {:?}", r.warnings);
}

// --- 新开 capability 的近似名 warning（design D5；spec spec-validation
//     「新开 capability 的近似名 warning」）---

#[test]
fn a_near_named_new_capability_warns_but_still_passes() {
    // spec Scenario「近似新名报 warning 且验证仍通过」。
    let r = result_for(
        &[("authentication", &delta(Some(GOOD_PURPOSE), ADDED))],
        &[("auth", CANON)],
    );
    assert!(r.valid, "warning 不改变验证结果: {:?}", r.errors);
    assert_eq!(r.warnings.len(), 1, "一笔近似名 warning: {:?}", r.warnings);
    let w = &r.warnings[0];
    assert!(w.contains("authentication"), "点名新目录: {w}");
    assert!(w.contains("auth"), "含近似名: {w}");
    assert!(w.contains("existing name"), "指引一：沿用既有名: {w}");
    assert!(w.contains("ignore"), "指引二：确为新 capability 可忽略: {w}");
}

#[test]
fn the_warning_pool_includes_in_flight_deltas_of_other_changes() {
    // spec：建议池＝正典＋其他未封存 change 的 delta，与主闸同一份。
    let store = TestStore::with_meta("demo", "schema: spec-driven\ncreated: 2026-07-01\n");
    store.metas.borrow_mut().insert(
        "add-sso".to_string(),
        "schema: spec-driven\ncreated: 2026-07-01\n".to_string(),
    );
    store.put_artifact(
        "add-sso",
        &crate::model::delta_spec_artifact("user-auth"),
        &delta(Some(GOOD_PURPOSE), ADDED),
    );
    store.put_artifact(
        "demo",
        &crate::model::delta_spec_artifact("user-authentication"),
        &delta(Some(GOOD_PURPOSE), ADDED),
    );
    let change = crate::model::find_change(&store, "demo").expect("change resolves");
    let r = validate_change(&store, &change, &crate::schema::spec_driven(), false);
    assert!(r.valid, "warning 不改变验证结果: {:?}", r.errors);
    let joined = r.warnings.join("\n");
    assert!(joined.contains("user-auth"), "in-flight delta 进建议: {joined}");
    assert!(joined.contains("add-sso"), "标注来源 change: {joined}");
}

#[test]
fn sibling_new_capabilities_in_the_same_change_warn_each_other() {
    // 池含本 change 的其他 delta：同一个 change 内同时新开两个近似名，
    // 两笔 warning 互相点名——滤掉的只有受检 capability 自身。
    let r = result_for(
        &[
            ("user-auth", &delta(Some(GOOD_PURPOSE), ADDED)),
            ("user-authentication", &delta(Some(GOOD_PURPOSE), ADDED)),
        ],
        &[],
    );
    assert!(r.valid, "warning 不改变验证结果: {:?}", r.errors);
    assert_eq!(r.warnings.len(), 2, "两个新名各得一笔: {:?}", r.warnings);
    let joined = r.warnings.join("\n");
    assert!(
        joined.contains("user-authentication (in-flight: demo)")
            && joined.contains("user-auth (in-flight: demo)"),
        "互相出现在对方的建议里: {joined}"
    );
}

#[test]
fn a_case_variant_delta_counts_as_new_and_warns() {
    // 正典收录与否是清单逐字比对——`Auth` 是新 capability：Purpose 早
    // 检查照跑（合格即过），naming warning 折叠大小写后点名 `auth`。
    let r = result_for(&[("Auth", &delta(Some(GOOD_PURPOSE), ADDED))], &[("auth", CANON)]);
    assert!(r.valid, "合格 Purpose 不报 error: {:?}", r.errors);
    assert_eq!(r.warnings.len(), 1, "近似名 warning 一笔: {:?}", r.warnings);
    assert!(r.warnings[0].contains("auth (canonical)"), "折叠后建议 auth: {:?}", r.warnings);
}

#[test]
fn a_same_named_delta_does_not_trigger_the_naming_warning() {
    // spec Scenario「既有 capability 的 delta 不触发」。
    let r = result_for(&[("auth", &delta(None, MODIFIED))], &[("auth", CANON)]);
    assert!(r.valid, "同名 delta 照常通过: {:?}", r.errors);
    assert!(r.warnings.is_empty(), "同名不报近似 warning: {:?}", r.warnings);
}

#[test]
fn a_new_capability_without_near_names_stays_silent() {
    // spec Scenario「无近似名的新 capability 不报」：建议池空即不报，
    // 既有的 Purpose 早检查照常运行。
    let clean = result_for(
        &[("zzz-unrelated", &delta(Some(GOOD_PURPOSE), ADDED))],
        &[("auth", CANON)],
    );
    assert!(clean.valid, "毫无交集不报: {:?}", clean.errors);
    assert!(clean.warnings.is_empty(), "无近似零 warning: {:?}", clean.warnings);

    let broken = result_for(&[("zzz-unrelated", &delta(None, ADDED))], &[("auth", CANON)]);
    assert!(!broken.valid, "Purpose 早检查照常: {:?}", broken.errors);
}

// --- validate --specs 的正式规格验证（design D4；spec spec-validation
//     「validate --specs 验证正式规格」）---

fn canonical(purpose: Option<&str>) -> String {
    let head = "# auth Specification\n\n";
    let tail = "## Requirements\n\n### Requirement: R1\n\nIt SHALL work.\n";
    match purpose {
        Some(p) => format!("{head}## Purpose\n\n{p}\n\n{tail}"),
        None => format!("{head}{tail}"),
    }
}

#[test]
fn canonical_spec_missing_purpose_is_an_error() {
    // spec Scenario「缺 Purpose 区段报 error」。
    for text in [canonical(None), canonical(Some("   "))] {
        let r = validate_canonical_spec("auth", &text, false);
        assert!(!r.valid, "缺段／空内容必须 invalid: {text}");
        assert!(
            r.errors.iter().any(|e| e.contains("specs/auth/spec.md")),
            "error 带逻辑路径: {:?}",
            r.errors
        );
    }
}

#[test]
fn canonical_spec_too_short_purpose_only_warns_under_strict() {
    // spec Scenario「过短 Purpose 仅 strict 报 warning」。
    let text = canonical(Some("短短一句。"));
    let lenient = validate_canonical_spec("auth", &text, false);
    assert!(lenient.valid && lenient.warnings.is_empty(), "非 strict 不报过短: {lenient:?}");
    let strict = validate_canonical_spec("auth", &text, true);
    assert!(strict.valid, "过短只是 warning，不使规格 invalid: {:?}", strict.errors);
    assert_eq!(strict.warnings.len(), 1, "strict 报一笔 warning: {:?}", strict.warnings);
}

#[test]
fn canonical_spec_placeholder_purpose_warns_regardless_of_strict() {
    // spec Scenario「占位 Purpose 以 warning 显形」：占位句长度恒超过门槛，
    // 长度判准拦不到它，需独立的前缀判准；且不依附 strict。
    let placeholder = format!(
        "{} change 'demo'. Update Purpose after archive.",
        crate::model::PURPOSE_TBD_PREFIX
    );
    assert!(
        placeholder.chars().count() >= crate::model::MIN_PURPOSE_LENGTH,
        "前提：占位句本身长于门槛"
    );
    for strict in [false, true] {
        let r = validate_canonical_spec("auth", &canonical(Some(&placeholder)), strict);
        assert!(r.valid, "占位不是 error: {:?}", r.errors);
        assert_eq!(r.warnings.len(), 1, "占位报 warning（strict={strict}）: {:?}", r.warnings);
    }
}

#[test]
fn canonical_spec_with_a_qualified_purpose_is_clean() {
    let r = validate_canonical_spec("auth", &canonical(Some(GOOD_PURPOSE)), true);
    assert!(r.valid && r.warnings.is_empty(), "合格规格零报: {r:?}");
}

#[test]
fn purpose_error_carries_the_repair_guidance() {
    // spec 需求段：error 消息自带修复指引与范例骨架，不得只报缺失。
    let r = result_for(&[("token", &delta(None, ADDED))], &[]);
    let joined = r.errors.join("\n");
    for key in ["## Purpose", "50"] {
        assert!(joined.contains(key), "修复指引缺关键内容 {key:?}: {joined}");
    }
    assert!(
        joined.lines().count() > 1,
        "范例骨架应以独立行呈现，而非塞成一行: {joined}"
    );
}

// --- 手动标记位置检查（design D3；spec manual-task-marker
//     「标记位置的 change 验证检查」）---

fn result_with_tasks(tasks_md: &str) -> ValidationResult {
    let store = TestStore::with_meta("demo", "schema: spec-driven\ncreated: 2026-08-12\n");
    store.put_artifact("demo", "tasks.md", tasks_md);
    store.put_artifact("demo", &crate::model::delta_spec_artifact("auth"), MODIFIED);
    store.canonical.borrow_mut().insert("auth".to_string(), CANON.to_string());
    let change = crate::model::find_change(&store, "demo").expect("change resolves");
    validate_change(&store, &change, &crate::schema::spec_driven(), false)
}

#[test]
fn task_number_before_the_marker_is_an_error() {
    // spec Scenario「编号在前报 error」。
    let r = result_with_tasks("- [ ] 6.2 [M] 手动验收\n");
    assert!(!r.valid, "误置必须使验证 invalid: {r:?}");
    let joined = r.errors.join("\n");
    // design D3:路径是含 change 目录的逻辑路径(正斜线),与零操作 parse error
    // 的 spec_path 同惯例——TestStore 的 change.dir 为 changes/demo。
    for key in ["changes/demo/tasks.md", "Task 1", "6.2 [M] 手动验收", "- [ ] [M] 6.2 手动验收"]
    {
        assert!(joined.contains(key), "error 缺 {key:?}: {joined}");
    }
}

#[test]
fn guidance_keeps_the_checkbox_state_and_stable_id_of_the_original_line() {
    // 已勾误置行的修复例须忠实重建原行:`- [x]` 不得退成 `- [ ]`,尾部
    // ID 注解不得被抹掉——照消息逐字改行是代理的常态。
    let r = result_with_tasks(
        "- [x] 5.2 [M] 手动验收 <!-- specseal-task:tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV -->\n",
    );
    assert!(!r.valid);
    let joined = r.errors.join("\n");
    for key in [
        "- [x] [M] 5.2 手动验收 <!-- specseal-task:tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV -->",
        "- [x] 5.2 [M] 手动验收 <!-- specseal-task:tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV -->",
    ] {
        assert!(joined.contains(key), "修复例缺 {key:?}: {joined}");
    }
    assert!(!joined.contains("- [ ]"), "不得出现退勾的 checkbox: {joined}");
}

#[test]
fn guidance_for_a_bare_marker_skips_the_example_lines() {
    // 描述仅为 [M](无内文)时,正误例两行重建不出有意义的内容——
    // 略去两行,留下规则句本身。
    let r = result_with_tasks("- [ ]  [M]\n");
    assert!(!r.valid, "空内文的行首残留仍须报 error: {r:?}");
    let joined = r.errors.join("\n");
    assert!(joined.contains("exactly one space"), "规则句仍在: {joined}");
    assert!(!joined.contains("Write:"), "空内文不给重建例: {joined}");
}

#[test]
fn marker_that_missed_the_prefix_slot_names_the_single_space_rule() {
    // spec Scenario「行首残留报 error」：checkbox 后两个空格,前缀槽漏接。
    let r = result_with_tasks("- [ ]  [M] 手测导入\n");
    assert!(!r.valid, "误置必须使验证 invalid: {r:?}");
    let joined = r.errors.join("\n");
    assert!(joined.contains("exactly one space"), "error 须点名恰一个空格: {joined}");
}

#[test]
fn correct_prefix_and_mid_description_mentions_report_nothing() {
    // spec Scenario「正确前缀与中段字面提及不报」。
    let r = result_with_tasks(
        "- [ ] [M] 手测导入\n- [x] 1.1 前缀剥除循环同时接受 `[P]` 与 `[M]` 的说明文本\n",
    );
    assert!(r.valid, "正确写法不得报 error: {:?}", r.errors);
    assert!(r.warnings.is_empty(), "也不得报 warning: {:?}", r.warnings);
}

#[test]
fn a_change_without_tasks_validates_exactly_as_before() {
    // tasks.md 缺席时本检查零输出——既有验证结果逐比特不变。
    let with_empty = result_with_tasks("");
    let store = TestStore::with_meta("demo", "schema: spec-driven\ncreated: 2026-08-12\n");
    store.put_artifact("demo", &crate::model::delta_spec_artifact("auth"), MODIFIED);
    store.canonical.borrow_mut().insert("auth".to_string(), CANON.to_string());
    let change = crate::model::find_change(&store, "demo").expect("change resolves");
    let absent = validate_change(&store, &change, &crate::schema::spec_driven(), false);
    assert_eq!(
        (absent.valid, absent.errors, absent.warnings),
        (with_empty.valid, with_empty.errors, with_empty.warnings),
        "有无 tasks.md 的验证结果须全等"
    );
}

#[test]
fn existing_errors_are_listed_before_the_marker_ones() {
    // 冻结顺序惯例同 Purpose 检查：既有错误先列,本检查后附。
    let store = TestStore::with_meta("demo", "schema: spec-driven\ncreated: 2026-08-12\n");
    store.put_artifact("demo", "tasks.md", "- [ ] 6.2 [M] 手动验收\n");
    store.put_artifact("demo", &crate::model::delta_spec_artifact("token"), &delta(None, ADDED));
    let change = crate::model::find_change(&store, "demo").expect("change resolves");
    let r = validate_change(&store, &change, &crate::schema::spec_driven(), false);
    assert_eq!(r.errors.len(), 2, "两类错误各一笔: {:?}", r.errors);
    assert!(r.errors[0].contains("## Purpose"), "既有 Purpose 错误在前: {:?}", r.errors);
    assert!(r.errors[1].contains("tasks.md"), "标记错误在后: {:?}", r.errors);
}
// --- change 验证纳入合并守门（design D1–D3；spec spec-validation
//     「change 验证纳入合并守门」）---

/// 正典 `R1` 带两个 scenario，用来验「未声明的 scenario 移除」。
const CANON_TWO_SCENARIOS: &str = "# auth Specification\n\n## Purpose\n\nAuth.\n\n## Requirements\n\n### Requirement: R1\n\nIt SHALL work.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n\n#### Scenario: fine\n\n- **WHEN** idle\n- **THEN** rests\n";
/// 正典只有 `R1`，delta 却 MODIFIED 一个已不存在的 `R9`。
const MODIFIED_R9: &str = "## MODIFIED Requirements\n\n### Requirement: R9\n\nIt SHALL work harder.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n";

#[test]
fn the_structural_entry_point_carries_no_merge_gate_errors() {
    // spec Scenario「archive 的拒绝输出不变」对应的引擎面：archive 家族的
    // 前置只看结构层，同一份会被守门拒收的 change 在那里零报。
    let store = store_for(&[("auth", MODIFIED_R9)], &[("auth", CANON)]);
    let change = crate::model::find_change(&store, "demo").expect("change resolves");
    let schema = crate::schema::spec_driven();
    let structural = validate_change_structural(&store, &change, false);
    let full = validate_change(&store, &change, &schema, false);
    assert!(structural.valid, "结构层对守门违规零报: {:?}", structural.errors);
    assert!(structural.errors.is_empty(), "结构层 error 全空: {:?}", structural.errors);
    assert!(!full.valid, "validate 必须因守门违规而 invalid: {full:?}");
    assert_eq!(full.errors.len(), 1, "恰一条守门 error: {:?}", full.errors);
}

#[test]
fn a_modified_target_that_is_gone_reads_as_the_gate_worded_error() {
    // spec Scenario「MODIFIED 目标不存在时 validate 报 error」与 Example 表第一列。
    let r = result_for(&[("auth", MODIFIED_R9)], &[("auth", CANON)]);
    assert_eq!(
        r.errors,
        vec![
            "specs/auth/spec.md: MODIFIED 'R9': target requirement no longer exists in \
the canonical spec (see: specseal drift demo)"
                .to_string()
        ],
        "组字逐字对应 Example 表"
    );
    assert!(!r.valid, "守门违规使结果 invalid");
}

#[test]
fn an_added_name_the_canon_already_carries_reads_as_the_gate_worded_error() {
    // Example 表第二列。
    const ADDED_R1: &str = "## ADDED Requirements\n\n### Requirement: R1\n\nIt SHALL work.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n";
    let r = result_for(&[("auth", ADDED_R1)], &[("auth", CANON)]);
    assert_eq!(
        r.errors,
        vec![
            "specs/auth/spec.md: ADDED 'R1': already exists in the canonical spec — \
archive would refuse it (see: specseal drift demo)"
                .to_string()
        ]
    );
}

#[test]
fn a_renamed_without_a_to_target_reads_as_the_gate_worded_error() {
    // Example 表第三列。ADDED 一并写着，delta 才有可套用的操作——本例要测的
    // 是悬空 RENAMED 的组字，不是零操作的 parse error。
    const DANGLING_RENAME: &str = "## ADDED Requirements\n\n### Requirement: Fresh\n\nIt SHALL work.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n\n## RENAMED Requirements\n\n- FROM: `### Requirement: R1`\n";
    let r = result_for(&[("auth", DANGLING_RENAME)], &[("auth", CANON)]);
    assert_eq!(
        r.errors,
        vec![
            "specs/auth/spec.md: RENAMED 'R1': RENAMED operation names no TO: target \
(see: specseal drift demo)"
                .to_string()
        ]
    );
}

#[test]
fn an_undeclared_scenario_removal_is_caught_and_clears_once_declared() {
    // spec Scenario「未声明的 scenario 移除被 validate 抓到」。
    let dropped = result_for(&[("auth", MODIFIED)], &[("auth", CANON_TWO_SCENARIOS)]);
    assert_eq!(dropped.errors.len(), 1, "恰一条守门 error: {:?}", dropped.errors);
    assert!(
        dropped.errors[0].starts_with(
            "specs/auth/spec.md: MODIFIED 'R1': drops canonical scenario(s) fine"
        ),
        "reason 逐字沿用守门字符串: {}",
        dropped.errors[0]
    );
    assert!(
        dropped.errors[0].ends_with("(see: specseal drift demo)"),
        "每行自带补救指向: {}",
        dropped.errors[0]
    );

    let declared = format!("{MODIFIED}\n<!-- REMOVED-SCENARIO: fine -->\n");
    let r = result_for(&[("auth", &declared)], &[("auth", CANON_TWO_SCENARIOS)]);
    assert!(r.valid, "补上声明后通过: {:?}", r.errors);
}

#[test]
fn the_purpose_gate_and_duplicate_names_are_not_listed_twice() {
    // spec Scenario「Purpose 与重复需求名不重复列」：errors 恰 2 条。
    const DUP_ADDED: &str = "## ADDED Requirements\n\n### Requirement: Fresh\n\nIt SHALL work.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n\n### Requirement: Fresh\n\nIt SHALL work twice.\n\n#### Scenario: again\n\n- **WHEN** reused\n- **THEN** works\n";
    let r = result_for(&[("token", DUP_ADDED)], &[]);
    assert_eq!(r.errors.len(), 2, "Purpose 与重复名各一条，无第三条: {:?}", r.errors);
    assert!(r.errors[0].contains("## Purpose"), "既有 Purpose error: {:?}", r.errors);
    assert!(
        r.errors[1].contains("Duplicate requirement 'Fresh' in ADDED section"),
        "既有重复名 error: {:?}",
        r.errors
    );

    // 跨区段同名走同一条去重规则：结构层已报 appears in both，守门不再补刀。
    const CROSS_SECTION: &str = "## MODIFIED Requirements\n\n### Requirement: R1\n\nIt SHALL work harder.\n\n## REMOVED Requirements\n\n### Requirement: R1\n\nIt SHALL go.\n";
    let cross = result_for(&[("auth", CROSS_SECTION)], &[("auth", CANON)]);
    assert_eq!(cross.errors.len(), 1, "只留结构层那一条: {:?}", cross.errors);
    assert!(
        cross.errors[0].contains("appears in both MODIFIED and REMOVED sections"),
        "留下的是结构层的文本: {:?}",
        cross.errors
    );
}

#[test]
fn a_renamed_endpoint_collision_is_only_visible_to_the_gate() {
    // spec Scenario「RENAMED 端点撞名只有守门看得到」：结构层的重复名扫描
    // 不看 RENAMED 区段，这条撞名只有守门报得出来。
    const RENAME_COLLIDES: &str = "## ADDED Requirements\n\n### Requirement: R2\n\nIt SHALL work.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n\n## RENAMED Requirements\n\n- FROM: `### Requirement: R1`\n- TO: `### Requirement: R2`\n";
    let r = result_for(&[("auth", RENAME_COLLIDES)], &[("auth", CANON)]);
    // 撞名违规的 operation 是逗号串——这是守门唯一偏离「单一 operation」
    // 形状的组字，整行冻结。
    assert_eq!(
        r.errors,
        vec![
            "specs/auth/spec.md: ADDED, RENAMED 'R2': appears more than once across this \
delta's operation sections (see: specseal drift demo)"
                .to_string()
        ]
    );
}

#[test]
fn a_name_written_twice_that_also_collides_with_the_canon_lists_one_gate_line() {
    // 守门逐笔扫描 delta 的需求：同名在同一区段写两次、又撞正典时会产出两笔
    // 相同的 ADDED_EXISTS 违规——validate 同字只列一行。
    const ADDED_R1_TWICE: &str = "## ADDED Requirements\n\n### Requirement: R1\n\nIt SHALL work.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n\n### Requirement: R1\n\nIt SHALL work twice.\n\n#### Scenario: again\n\n- **WHEN** reused\n- **THEN** works\n";
    let r = result_for(&[("auth", ADDED_R1_TWICE)], &[("auth", CANON)]);
    assert_eq!(
        r.errors,
        vec![
            "specs/auth/spec.md: Duplicate requirement 'R1' in ADDED section".to_string(),
            "specs/auth/spec.md: ADDED 'R1': already exists in the canonical spec — \
archive would refuse it (see: specseal drift demo)"
                .to_string(),
        ],
        "结构层一条、守门一条，没有重复行"
    );
}

#[test]
fn a_duplicated_name_that_is_also_a_rename_endpoint_keeps_the_gate_line() {
    // spec「未被结构检查涵盖的撞名（含 RENAMED 端点）仍 SHALL 列出」：同名既在
    // ADDED 重复、又是 RENAMED 的 TO 端点——结构层只报得出 ADDED 那一半，
    // 守门那笔 `ADDED, RENAMED` 撞名不得被去重吞掉。
    const DUP_AND_RENAME: &str = "## ADDED Requirements\n\n### Requirement: R2\n\nIt SHALL work.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n\n### Requirement: R2\n\nIt SHALL work twice.\n\n#### Scenario: again\n\n- **WHEN** reused\n- **THEN** works\n\n## RENAMED Requirements\n\n- FROM: `### Requirement: R1`\n- TO: `### Requirement: R2`\n";
    let r = result_for(&[("auth", DUP_AND_RENAME)], &[("auth", CANON)]);
    assert_eq!(
        r.errors,
        vec![
            "specs/auth/spec.md: Duplicate requirement 'R2' in ADDED section".to_string(),
            "specs/auth/spec.md: ADDED, RENAMED 'R2': appears more than once across this \
delta's operation sections (see: specseal drift demo)"
                .to_string(),
        ]
    );
}

#[test]
fn a_requirement_under_a_purpose_headed_section_is_not_swallowed() {
    // Purpose 类的去重只认真正的 Purpose 守门（operation 与 requirement 都要
    // 对上）：新 capability 的 delta 若写了 `## PURPOSE Requirements` 标头，
    // 底下的需求拿到的是 CANON_ABSENT 违规，validate 必须照列——否则
    // validate 全绿而 archive 仍拒收。
    const PURPOSE_HEADED: &str = "## PURPOSE Requirements\n\n### Requirement: X\n\nIt SHALL.\n\n## ADDED Requirements\n\n### Requirement: Fresh\n\nIt SHALL work.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n";
    let r = result_for(
        &[("token", &delta(Some(GOOD_PURPOSE), PURPOSE_HEADED))],
        &[],
    );
    assert_eq!(
        r.errors,
        vec![
            "specs/token/spec.md: PURPOSE 'X': canonical spec for this capability does not \
exist (see: specseal drift demo)"
                .to_string()
        ]
    );
}

#[test]
fn gate_errors_are_listed_after_every_structural_one() {
    // design D2：守门 error 一律排在既有 error 之后，含 `[M]` 标记 error。
    let store = TestStore::with_meta("demo", "schema: spec-driven\ncreated: 2026-08-12\n");
    store.put_artifact("demo", "tasks.md", "- [ ] 6.2 [M] 手动验收\n");
    store.put_artifact("demo", &crate::model::delta_spec_artifact("auth"), MODIFIED_R9);
    store.canonical.borrow_mut().insert("auth".to_string(), CANON.to_string());
    let change = crate::model::find_change(&store, "demo").expect("change resolves");
    let r = validate_change(&store, &change, &crate::schema::spec_driven(), false);
    assert_eq!(r.errors.len(), 2, "标记与守门各一条: {:?}", r.errors);
    assert!(r.errors[0].contains("tasks.md"), "既有标记 error 在前: {:?}", r.errors);
    assert!(r.errors[1].contains("MODIFIED 'R9'"), "守门 error 在后: {:?}", r.errors);
}

#[test]
fn the_gate_reports_regardless_of_strict() {
    // design Non-Goals：守门违规不依附 `--strict`，两种模式都是 error。
    let store = TestStore::with_meta("demo", "schema: spec-driven\ncreated: 2026-08-12\n");
    store.put_artifact("demo", &crate::model::delta_spec_artifact("auth"), MODIFIED_R9);
    store.canonical.borrow_mut().insert("auth".to_string(), CANON.to_string());
    let change = crate::model::find_change(&store, "demo").expect("change resolves");
    for strict in [false, true] {
        let r = validate_change(&store, &change, &crate::schema::spec_driven(), strict);
        assert_eq!(r.errors.len(), 1, "strict={strict} 一样报: {:?}", r.errors);
    }
}

// --- 缺 delta 警告依变更的 schema 决定（spec workflow-schemas「no-spec-change 内置
//     schema 的组成」；design D3）---

const MISSING_DELTA: &str = "No delta specs found";

fn result_without_deltas(schema: &str) -> ValidationResult {
    let store = TestStore::with_meta("demo", &format!("schema: {schema}\ncreated: 2026-10-21\n"));
    let change = crate::model::find_change(&store, "demo").expect("change resolves");
    validate_change(&store, &change, &change_schema(None, None, &change), false)
}

#[test]
fn a_no_spec_change_change_without_deltas_has_no_missing_delta_warning() {
    let r = result_without_deltas("no-spec-change");
    assert!(r.valid, "结构检查有效: {:?}", r.errors);
    assert!(!r.warnings.iter().any(|w| w == MISSING_DELTA), "不得警告缺 delta: {:?}", r.warnings);
}

#[test]
fn a_spec_driven_change_without_deltas_keeps_the_warning() {
    let r = result_without_deltas("spec-driven");
    assert_eq!(r.warnings, [MISSING_DELTA]);
}

#[test]
fn an_unresolvable_schema_keeps_the_missing_delta_warning() {
    let r = result_without_deltas("ghost-flow");
    assert_eq!(r.warnings, [MISSING_DELTA]);
}
