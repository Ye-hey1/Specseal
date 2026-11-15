//! 溯源链组装：`specseal trace <capability>` 的领域层。
//!
//! 只读既存事实——封存目录枚举（D1）、`.openspec.yaml` 的 from_discussion、
//! 讨论 frontmatter 的 promoted_to、`.evidence.json` 的逐 task 文件清单、
//! 正式规格的 @trace 归属。进行中 change 不入链（D2）；evidence 是逐 change
//! 的存在性侦测，缺档为 None、绝不回读旧 @trace 的 code 清单（D3）；单环
//! 脏数据不使整链失败。不含 ANSI、不假设保存媒介（D4）。

use crate::model::ChangeMeta;
use crate::store::Store;
use crate::util::strip_date_prefix;
use anyhow::Result;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct TraceReport {
    pub capability: String,
    pub requirements: Vec<RequirementTrace>,
    pub changes: Vec<ChangeTrace>,
    pub discussions: Vec<DiscussionTrace>,
}

/// 正式规格单条 Requirement 的现行 @trace 归属。
#[derive(Debug, Clone, Serialize)]
pub struct RequirementTrace {
    pub name: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChangeTrace {
    pub name: String,
    #[serde(rename = "archivedDir")]
    pub archived_dir: String,
    /// `.openspec.yaml` 的 from_discussion 原文（逗号累加器照录）；缺栏为 null。
    #[serde(rename = "fromDiscussion")]
    pub from_discussion: Option<String>,
    /// `.evidence.json` 的逐 task 文件清单；文件不存在（或不可解析）为 null。
    pub evidence: Option<Vec<EvidenceTask>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EvidenceTask {
    #[serde(rename = "taskId")]
    pub task_id: String,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiscussionTrace {
    pub slug: String,
    pub archived: bool,
    #[serde(rename = "promotedTo")]
    pub promoted_to: Vec<PromotedChange>,
}

/// 讨论扇出的兄弟变更与其触及的 capability 名集合。
#[derive(Debug, Clone, Serialize)]
pub struct PromotedChange {
    pub change: String,
    pub capabilities: Vec<String>,
}

/// 组装 capability 的封存演进链。capability 无正式规格时回错误（近似建议
/// 见 `not_found_message`）；链内单环缺漏一律宽容输出。
pub fn run(store: &dyn Store, capability: &str) -> Result<TraceReport> {
    let Some(spec_text) = store.read_canonical_spec(capability) else {
        return Err(crate::station::NotFound(not_found_message(store, capability)).into());
    };
    let requirements = requirement_sources(&spec_text);

    // 封存目录名清单只枚举一次，链过滤与兄弟变更查找共用。
    let archived = store.list_archived_changes();

    // D1：封存目录含该 capability 的 delta 子目录即入链；`YYYY-MM-DD-` 前缀
    // 的字典序即时序，递增排序＝由旧至新。
    let mut dated: Vec<String> = archived
        .iter()
        .filter(|d| store.archived_delta_capabilities(d).iter().any(|c| c == capability))
        .cloned()
        .collect();
    dated.sort();

    let mut changes = Vec::new();
    let mut slugs: Vec<String> = Vec::new();
    for dated_name in &dated {
        let meta_text = store.read_archived_meta(dated_name);
        let meta = ChangeMeta::from_text(meta_text.as_deref()).unwrap_or_default();
        for slug in meta.from_discussions() {
            if !slugs.contains(&slug) {
                slugs.push(slug);
            }
        }
        let evidence = store
            .read_archived_artifact(dated_name, ".evidence.json")
            .and_then(|text| parse_evidence(&text));
        changes.push(ChangeTrace {
            name: strip_date_prefix(dated_name).to_string(),
            archived_dir: dated_name.clone(),
            from_discussion: meta.from_discussion,
            evidence,
        });
    }

    let mut discussions = Vec::new();
    for slug in slugs {
        let Some(doc) = store.read_discussion(&slug) else {
            continue;
        };
        let promoted_to = crate::discuss::promoted_to(store, &slug)
            .into_iter()
            .map(|change| {
                let capabilities = sibling_capabilities(store, &archived, &change);
                PromotedChange { change, capabilities }
            })
            .collect();
        discussions.push(DiscussionTrace { slug, archived: doc.archived, promoted_to });
    }

    Ok(TraceReport {
        capability: capability.to_string(),
        requirements,
        changes,
        discussions,
    })
}

/// D6：不存在的 capability 依 naming guard 惯例给至多三笔近似名。trace 只
/// 接受有正式规格者，故建议池滤掉 in-flight delta——列出它们等于指路再撞
/// 同一个错误。
fn not_found_message(store: &dyn Store, cap: &str) -> String {
    let pool: Vec<_> = crate::capname::suggestion_pool(store)
        .into_iter()
        .filter(|k| matches!(k.source, crate::capname::Source::Canonical))
        .collect();
    let suggestions = crate::capname::suggest(cap, &pool);
    let mut msg = format!("Capability '{cap}' is not in the canonical specs.\n");
    if suggestions.is_empty() {
        msg.push_str("No similar capability names found.");
    } else {
        msg.push_str(&crate::capname::suggestion_block(&suggestions));
        msg.push_str("Re-run with one of these exact names.");
    }
    msg
}

/// 兄弟变更触及的 capability：优先取其最新封存目录的 delta 集合（`archived`
/// 为降序清单，首个命中即最新），未封存时退回进行中 delta；两者皆无为空
/// 集合（宽容）。
fn sibling_capabilities(store: &dyn Store, archived: &[String], change: &str) -> Vec<String> {
    if let Some(dated) = archived.iter().find(|d| strip_date_prefix(d) == change) {
        return store.archived_delta_capabilities(dated);
    }
    store.delta_capabilities(change)
}

/// 正式规格每条 Requirement 的 @trace source；无 @trace 的 Requirement 无
/// 归属可列，略过。@trace 内 source 以外的键（含历史 code 清单）一律不读。
fn requirement_sources(text: &str) -> Vec<RequirementTrace> {
    let (_, blocks) = crate::archive::parse_canonical(text);
    blocks
        .into_iter()
        .filter_map(|(name, block)| trace_source(&block).map(|source| RequirementTrace { name, source }))
        .collect()
}

fn trace_source(block: &str) -> Option<String> {
    let mut in_trace = false;
    for line in block.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("<!-- @trace") {
            // 单行变体 `<!-- @trace source: x ... -->`：source 值取至下一个
            // 空白（change 名为 kebab token，不含空白）。
            if let Some(inline) = rest.find("source:").map(|i| &rest[i + "source:".len()..]) {
                return inline.split_whitespace().next().map(str::to_string);
            }
            in_trace = !t.ends_with("-->");
            continue;
        }
        if in_trace {
            if t.ends_with("-->") {
                in_trace = false;
                continue;
            }
            if let Some(rest) = t.strip_prefix("source:") {
                return Some(rest.trim().to_string());
            }
        }
    }
    None
}

/// `.evidence.json` 的宽容读取：v2 的 entries 优先、退回 v1 的 touched；
/// 逐笔抽 (taskId, files)，缺栏的单笔略过而非整份作废；整档不可解析视同
/// 无记录（单环宽容）。
fn parse_evidence(text: &str) -> Option<Vec<EvidenceTask>> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let channel = |key: &str, id_key: &str, files_key: &str| -> Vec<EvidenceTask> {
        let Some(arr) = v.get(key).and_then(|a| a.as_array()) else {
            return Vec::new();
        };
        arr.iter()
            .filter_map(|e| {
                let task_id = e.get(id_key)?.as_str()?.to_string();
                let files = e
                    .get(files_key)?
                    .as_array()?
                    .iter()
                    .filter_map(|f| f.as_str().map(str::to_string))
                    .collect();
                Some(EvidenceTask { task_id, files })
            })
            .collect()
    };
    let entries = channel("entries", "taskId", "touchedFiles");
    if entries.is_empty() {
        Some(channel("touched", "task_id", "files"))
    } else {
        Some(entries)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::teststore::TestStore;

    const META_WITH_DISCUSSION: &str =
        "schema: spec-driven\ncreated: 2026-07-01\nfrom_discussion: origin-talk\n";
    const META_PLAIN: &str = "schema: spec-driven\ncreated: 2026-07-01\n";

    fn spec_with_traces() -> String {
        "# x Specification\n\n## Purpose\n\nX lifecycle.\n\n## Requirements\n\n\
         ### Requirement: R1\n\nIt SHALL work.\n\n<!-- @trace\nsource: alpha\nupdated: 2026-07-10\n-->\n\n\
         ### Requirement: R2\n\nIt SHALL also work.\n\n<!-- @trace\nsource: beta\nupdated: 2026-08-02\n-->\n"
            .to_string()
    }

    /// 封存一个含 capability delta 的 change 到测试 store。
    fn put_archived(store: &TestStore, dated: &str, meta: &str, caps: &[&str]) {
        store.archived_metas.borrow_mut().insert(dated.to_string(), meta.to_string());
        for cap in caps {
            store
                .archived_artifacts
                .borrow_mut()
                .insert((dated.to_string(), format!("specs/{cap}/spec.md")), "delta".to_string());
        }
    }

    fn store_with_canon() -> TestStore {
        let store = TestStore::default();
        store.canonical.borrow_mut().insert("x".to_string(), spec_with_traces());
        store
    }

    // --- 溯源链组装：枚举、排序、进行中排除 ---

    #[test]
    fn archived_dirs_with_the_capability_delta_enter_the_chain_oldest_first() {
        let store = store_with_canon();
        put_archived(&store, "2026-08-02-beta", META_PLAIN, &["x"]);
        put_archived(&store, "2026-07-10-alpha", META_PLAIN, &["x", "y"]);
        put_archived(&store, "2026-08-05-other", META_PLAIN, &["y"]);

        let report = run(&store, "x").expect("assembles");
        let names: Vec<&str> = report.changes.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["alpha", "beta"], "含 x delta 的封存依日期由旧至新");
        assert_eq!(report.changes[0].archived_dir, "2026-07-10-alpha");
    }

    #[test]
    fn an_in_flight_change_with_the_capability_delta_stays_out_of_the_chain() {
        let store = store_with_canon();
        store.metas.borrow_mut().insert("wip".to_string(), META_PLAIN.to_string());
        store.put_artifact("wip", "specs/x/spec.md", "delta");
        put_archived(&store, "2026-07-10-alpha", META_PLAIN, &["x"]);

        let report = run(&store, "x").expect("assembles");
        let names: Vec<&str> = report.changes.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["alpha"], "进行中 change 不入链");
    }

    // --- Requirement 归属 ---

    #[test]
    fn each_requirement_reports_its_current_trace_source() {
        let store = store_with_canon();
        let report = run(&store, "x").expect("assembles");
        let pairs: Vec<(&str, &str)> = report
            .requirements
            .iter()
            .map(|r| (r.name.as_str(), r.source.as_str()))
            .collect();
        assert_eq!(pairs, [("R1", "alpha"), ("R2", "beta")]);
    }

    #[test]
    fn a_requirement_without_a_trace_block_is_omitted_from_attribution() {
        let store = TestStore::default();
        store.canonical.borrow_mut().insert(
            "x".to_string(),
            "## Requirements\n\n### Requirement: R1\n\nNo trace here.\n".to_string(),
        );
        let report = run(&store, "x").expect("assembles");
        assert!(report.requirements.is_empty(), "无 @trace 的 Requirement 不列归属");
    }

    #[test]
    fn a_trace_source_pointing_to_a_missing_archive_dir_is_listed_without_change_detail() {
        // 归属照列于 requirements；changes 清单缺其明细（宽容组装）。
        let store = store_with_canon();
        put_archived(&store, "2026-08-02-beta", META_PLAIN, &["x"]);
        // alpha 无封存目录。

        let report = run(&store, "x").expect("dirty link must not fail the chain");
        assert!(report.requirements.iter().any(|r| r.source == "alpha"));
        let names: Vec<&str> = report.changes.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["beta"], "找不到封存目录的归属不进 changes");
    }

    // --- evidence 存在性侦测 ---

    #[test]
    fn an_evidence_file_yields_per_task_files_and_absence_yields_none() {
        let store = store_with_canon();
        put_archived(&store, "2026-07-10-alpha", META_PLAIN, &["x"]);
        put_archived(&store, "2026-08-02-beta", META_PLAIN, &["x"]);
        store.archived_artifacts.borrow_mut().insert(
            ("2026-07-10-alpha".to_string(), ".evidence.json".to_string()),
            r#"{"version":2,"change":"alpha","touched":[{"task_id":"1","task_desc":"d","files":["old.rs"]}],"entries":[{"taskId":"tsk_1","taskDesc":"d","touchedFiles":["a.rs","b.rs"],"recordedAt":"2026-07-10T00:00:00Z"}]}"#
                .to_string(),
        );

        let report = run(&store, "x").expect("assembles");
        let alpha = &report.changes[0];
        let tasks = alpha.evidence.as_ref().expect("evidence 存在则解析");
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].task_id, "tsk_1", "v2 entries 优先");
        assert_eq!(tasks[0].files, ["a.rs", "b.rs"]);
        assert!(report.changes[1].evidence.is_none(), "无 .evidence.json 为 None");
    }

    #[test]
    fn a_v1_only_record_falls_back_to_the_touched_channel() {
        let store = store_with_canon();
        put_archived(&store, "2026-07-10-alpha", META_PLAIN, &["x"]);
        store.archived_artifacts.borrow_mut().insert(
            ("2026-07-10-alpha".to_string(), ".evidence.json".to_string()),
            r#"{"change":"alpha","touched":[{"task_id":"1","task_desc":"d","files":["legacy.rs"]}]}"#.to_string(),
        );

        let report = run(&store, "x").expect("assembles");
        let tasks = report.changes[0].evidence.as_ref().expect("v1 记录仍解析");
        assert_eq!(tasks[0].task_id, "1");
        assert_eq!(tasks[0].files, ["legacy.rs"]);
    }

    #[test]
    fn old_trace_code_lists_are_never_read_into_the_report() {
        let store = TestStore::default();
        store.canonical.borrow_mut().insert(
            "x".to_string(),
            "## Requirements\n\n### Requirement: R1\n\nBody.\n\n<!-- @trace\nsource: alpha\nupdated: 2026-08-03\ncode:\n  - poisoned/path.rs\n-->\n"
                .to_string(),
        );
        put_archived(&store, "2026-08-03-alpha", META_PLAIN, &["x"]);
        // alpha 无 .evidence.json：evidence 必须是 None，而非 @trace 的 code 清单。

        let report = run(&store, "x").expect("assembles");
        assert!(report.changes[0].evidence.is_none(), "@trace code 清单永不回读");
        assert_eq!(report.requirements[0].source, "alpha", "source 照常解析");
        let json = serde_json::to_string(&report).unwrap();
        assert!(!json.contains("poisoned"), "code 清单不得出现在任何输出字段");
    }

    // --- from_discussion 与讨论扇出 ---

    #[test]
    fn from_discussion_flows_through_and_a_missing_field_is_null() {
        let store = store_with_canon();
        put_archived(&store, "2026-07-10-alpha", META_WITH_DISCUSSION, &["x"]);
        put_archived(&store, "2026-08-02-beta", META_PLAIN, &["x"]);

        let report = run(&store, "x").expect("assembles");
        assert_eq!(report.changes[0].from_discussion.as_deref(), Some("origin-talk"));
        assert!(report.changes[1].from_discussion.is_none(), "缺栏为 null");
    }

    #[test]
    fn an_unparseable_archived_meta_degrades_to_null_without_failing() {
        let store = store_with_canon();
        put_archived(&store, "2026-07-10-alpha", "{{not yaml", &["x"]);

        let report = run(&store, "x").expect("脏 meta 不使整链失败");
        assert!(report.changes[0].from_discussion.is_none());
    }

    #[test]
    fn the_source_discussion_carries_its_fanout_with_sibling_capabilities() {
        let store = store_with_canon();
        put_archived(&store, "2026-07-10-alpha", META_WITH_DISCUSSION, &["x"]);
        put_archived(&store, "2026-07-12-cousin", META_PLAIN, &["y", "z"]);
        store.archived_discussions.borrow_mut().insert(
            "origin-talk".to_string(),
            "---\ntopic: t\nslug: origin-talk\nstatus: promoted\npromoted_to: alpha, cousin\ncreated: 2026-07-01\n---\n\n## Conclusion\n\n**Decision**: go\n"
                .to_string(),
        );

        let report = run(&store, "x").expect("assembles");
        assert_eq!(report.discussions.len(), 1);
        let d = &report.discussions[0];
        assert_eq!(d.slug, "origin-talk");
        assert!(d.archived, "封存讨论照样读出");
        let fanout: Vec<(&str, &[String])> = d
            .promoted_to
            .iter()
            .map(|p| (p.change.as_str(), p.capabilities.as_slice()))
            .collect();
        assert_eq!(fanout.len(), 2);
        assert_eq!(fanout[0].0, "alpha");
        assert_eq!(fanout[0].1, ["x"]);
        assert_eq!(fanout[1].0, "cousin");
        assert_eq!(fanout[1].1, ["y", "z"]);
    }

    #[test]
    fn a_missing_discussion_document_drops_silently_while_the_chain_survives() {
        let store = store_with_canon();
        put_archived(&store, "2026-07-10-alpha", META_WITH_DISCUSSION, &["x"]);
        // origin-talk 讨论档不存在。

        let report = run(&store, "x").expect("讨论档缺失不使整链失败");
        assert_eq!(report.changes[0].from_discussion.as_deref(), Some("origin-talk"));
        assert!(report.discussions.is_empty());
    }

    // --- 找不到 capability（近似建议细节属 task 1.2） ---

    #[test]
    fn an_unknown_capability_fails_with_up_to_three_suggestions() {
        let store = TestStore::default();
        for cap in ["user-auth", "auth-session", "auth-token", "billing"] {
            store
                .canonical
                .borrow_mut()
                .insert(cap.to_string(), format!("# {cap}\n\n## Purpose\n\n{cap} purpose.\n"));
        }

        let err = run(&store, "auth").expect_err("无正式规格必须失败");
        let msg = err.to_string();
        assert!(msg.contains("'auth' is not in the canonical specs"), "{msg}");
        let count = msg.matches("  - ").count();
        assert!(count >= 1 && count <= 3, "至多三笔建议: {msg}");
        assert!(!msg.contains("billing"), "无关名称不入建议: {msg}");
    }

    #[test]
    fn an_unknown_capability_with_no_neighbors_reports_plainly() {
        let store = TestStore::default();
        let err = run(&store, "totally-new").expect_err("must fail");
        let msg = err.to_string();
        assert!(msg.contains("not in the canonical specs"), "{msg}");
        assert!(!msg.contains("  - "), "无近似时不列建议: {msg}");
    }

    #[test]
    fn an_in_flight_delta_capability_never_enters_the_suggestions() {
        // trace 只接受有正式规格者：建议若列出 in-flight 名，照做会再撞同一错。
        let store = TestStore::default();
        store
            .canonical
            .borrow_mut()
            .insert("auth-session".to_string(), "# a\n\n## Purpose\n\nAuth sessions.\n".to_string());
        store.metas.borrow_mut().insert("wip".to_string(), META_PLAIN.to_string());
        store.put_artifact("wip", "specs/auth-flow/spec.md", "delta");

        let err = run(&store, "auth").expect_err("must fail");
        let msg = err.to_string();
        assert!(msg.contains("auth-session"), "正典近似名照列: {msg}");
        assert!(!msg.contains("auth-flow"), "in-flight delta 不入建议: {msg}");
    }

    #[test]
    fn a_missing_capability_classifies_as_not_found() {
        let store = TestStore::default();
        let err = run(&store, "nope").expect_err("must fail");
        assert!(
            err.downcast_ref::<crate::station::NotFound>().is_some(),
            "capability 不存在应可分类为 not_found"
        );
    }

    #[test]
    fn a_partially_malformed_evidence_entry_is_skipped_not_nuking_the_record() {
        let store = store_with_canon();
        put_archived(&store, "2026-07-10-alpha", META_PLAIN, &["x"]);
        // 第一笔 entry 缺 taskId：只略过该笔，其余保留（单环宽容）。
        store.archived_artifacts.borrow_mut().insert(
            ("2026-07-10-alpha".to_string(), ".evidence.json".to_string()),
            r#"{"entries":[{"touchedFiles":["lost.rs"]},{"taskId":"tsk_2","touchedFiles":["kept.rs"]}]}"#
                .to_string(),
        );

        let report = run(&store, "x").expect("assembles");
        let tasks = report.changes[0].evidence.as_ref().expect("缺栏不整份退为 null");
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].task_id, "tsk_2");
        assert_eq!(tasks[0].files, ["kept.rs"]);
    }

    #[test]
    fn a_single_line_trace_comment_still_yields_its_source() {
        let store = TestStore::default();
        store.canonical.borrow_mut().insert(
            "x".to_string(),
            "## Requirements\n\n### Requirement: R1\n\nBody.\n\n<!-- @trace source: gamma updated: 2026-08-01 -->\n"
                .to_string(),
        );
        let report = run(&store, "x").expect("assembles");
        assert_eq!(report.requirements[0].source, "gamma", "单行 @trace 变体不得静默失去归属");
    }

    // --- 日期前缀 ---

    #[test]
    fn date_prefix_stripping_tolerates_malformed_names() {
        assert_eq!(strip_date_prefix("2026-07-10-alpha"), "alpha");
        assert_eq!(strip_date_prefix("2026-07-10-a-b-c"), "a-b-c");
        assert_eq!(strip_date_prefix("not-dated"), "not-dated");
        assert_eq!(strip_date_prefix("2026-07-10"), "2026-07-10");
        assert_eq!(strip_date_prefix("20a6-07-10-alpha"), "20a6-07-10-alpha");
    }
}
