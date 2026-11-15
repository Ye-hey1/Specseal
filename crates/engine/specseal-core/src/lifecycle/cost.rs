//! 一个封存变更的流程成本（process-cost-metrics design D4）：只依赖 [`Store`]，
//! desktop 缓存建表时逐项调用；中位数与 P90 的汇总属呈现层，不在这里。

use crate::keylines::KeyLines;
use crate::store::Store;
use chrono::{DateTime, NaiveDate};

/// 单一封存变更的流程成本。来源缺席或无法解析的字段为 `None`——调用端据此
/// 不输出该字段，不以 0 占位。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ProcessCost {
    pub doc_lines: Option<u64>,
    pub lead_days: Option<i64>,
    pub lead_hours: Option<f64>,
    pub review_rounds: Option<u64>,
    pub verify_rounds: Option<u64>,
}

/// 计算封存目录 `dated_name`（`YYYY-MM-DD-<name>`）的流程成本。metadata 逐键读原文
/// （不经 `ChangeMeta`）：一个键缺席、重复或坏掉只让用到它的字段缺席；归档
/// metadata 不在 fail-closed 范围（同 desktop 缓存）。
pub fn archived_cost(store: &dyn Store, dated_name: &str) -> ProcessCost {
    let raw = store.read_archived_meta(dated_name).unwrap_or_default();
    let meta = KeyLines::whole(&raw);
    let value = |key: &str| meta.get(key).map(crate::util::yaml_unscalar);
    let stamp = |key: &str| value(key).and_then(|v| DateTime::parse_from_rfc3339(&v).ok());
    let archived_date =
        dated_name.get(..10).and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok());
    // 时戳取写入者时区的日期，与 `ChangeMeta` 收敛出的前 10 个字符相同。
    let created_date = value("created").and_then(|v| match DateTime::parse_from_rfc3339(&v) {
        Ok(t) => Some(t.date_naive()),
        Err(_) => NaiveDate::parse_from_str(&v, "%Y-%m-%d").ok(),
    });
    let lead_days = archived_date
        .zip(created_date)
        .map(|(archived, created)| (archived - created).num_days().max(0));
    let lead_hours = stamp("archived_at").zip(stamp("created")).map(|(archived, created)| {
        let hours = (archived - created).num_seconds().max(0) as f64 / 3600.0;
        (hours * 10.0).round() / 10.0
    });
    let rounds = |key: &str| value(key).and_then(|v| v.parse::<u64>().ok());
    ProcessCost {
        doc_lines: doc_lines(store, dated_name),
        lead_days,
        lead_hours,
        review_rounds: rounds("reviewed_rounds"),
        verify_rounds: rounds("verified_rounds"),
    }
}

/// proposal.md、design.md、tasks.md 与每份 delta spec 的行数总和；四类都不存在时 `None`。
fn doc_lines(store: &dyn Store, dated_name: &str) -> Option<u64> {
    let specs = store
        .archived_delta_capabilities(dated_name)
        .into_iter()
        .map(|cap| crate::model::delta_spec_artifact(&cap));
    let docs: Vec<String> = ["proposal.md", "design.md", "tasks.md"]
        .map(String::from)
        .into_iter()
        .chain(specs)
        .filter_map(|artifact| store.read_archived_artifact(dated_name, &artifact))
        .collect();
    (!docs.is_empty()).then(|| docs.iter().map(|text| line_count(text)).sum())
}

/// 换行字符数；最后一行没有换行时也算一行。
fn line_count(text: &str) -> u64 {
    let newlines = text.matches('\n').count() as u64;
    newlines + u64::from(!text.is_empty() && !text.ends_with('\n'))
}

#[cfg(test)]
mod tests {
    use super::{archived_cost, ProcessCost};
    use crate::teststore::TestStore;

    fn lines(n: usize) -> String {
        (1..=n).map(|i| format!("line {i}\n")).collect()
    }

    fn put(store: &TestStore, dated: &str, artifact: &str, text: &str) {
        store
            .archived_artifacts
            .borrow_mut()
            .insert((dated.to_string(), artifact.to_string()), text.to_string());
    }

    #[test]
    fn new_format_item_carries_every_cost_field() {
        // spec client-protocol scenario「新格式封存项带齐流程成本字段」。delta spec 的
        // 最后一行没有换行，也算一行。
        let store = TestStore::default();
        let dated = "2026-10-22-demo";
        store.archived_metas.borrow_mut().insert(
            dated.to_string(),
            "schema: spec-driven\ncreated: 2026-10-21T10:00:00+08:00\nreviewed_rounds: 2\nverified_rounds: 3\narchived_at: 2026-10-22T16:30:00+08:00\n".to_string(),
        );
        put(&store, dated, "proposal.md", &lines(120));
        put(&store, dated, "tasks.md", &lines(80));
        put(&store, dated, "specs/auth/spec.md", lines(50).trim_end_matches('\n'));
        assert_eq!(
            archived_cost(&store, dated),
            ProcessCost {
                doc_lines: Some(250),
                lead_days: Some(1),
                lead_hours: Some(30.5),
                review_rounds: Some(2),
                verify_rounds: Some(3),
            }
        );
    }

    #[test]
    fn old_format_item_carries_only_what_it_has() {
        // spec client-protocol scenario「旧格式封存项只带得出的字段」。
        let store = TestStore::default();
        let dated = "2026-08-14-old";
        store
            .archived_metas
            .borrow_mut()
            .insert(dated.to_string(), "schema: spec-driven\ncreated: 2026-08-12\narchived_at: 2026-08-14\n".to_string());
        put(&store, dated, "proposal.md", &lines(10));
        put(&store, dated, "tasks.md", &lines(5));
        assert_eq!(
            archived_cost(&store, dated),
            ProcessCost { doc_lines: Some(15), lead_days: Some(2), ..ProcessCost::default() }
        );
    }

    #[test]
    fn item_without_metadata_or_documents_has_no_cost_fields() {
        // spec client-protocol scenario「没有 metadata 与文档时字段全部缺席」。
        let store = TestStore::default();
        assert_eq!(archived_cost(&store, "2026-08-15-empty"), ProcessCost::default());
    }

    #[test]
    fn a_broken_key_only_drops_its_own_field() {
        // spec client-protocol「来源缺席或无法解析时，该字段 SHALL 缺席」是逐栏的：
        // 手改坏的轮数与旧版追加的第二行 archived_at 都不连带清掉其他字段。
        let store = TestStore::default();
        let dated = "2026-10-22-hand-edited";
        store.archived_metas.borrow_mut().insert(
            dated.to_string(),
            "created: 2026-10-21T10:00:00+08:00\nreviewed_rounds: many\nverified_rounds: 3\narchived_at: 2026-10-22T16:30:00+08:00\narchived_at: 2026-10-22\n".to_string(),
        );
        assert_eq!(
            archived_cost(&store, dated),
            ProcessCost {
                lead_days: Some(1),
                lead_hours: Some(30.5),
                verify_rounds: Some(3),
                ..ProcessCost::default()
            }
        );
    }

    #[test]
    fn lead_time_never_goes_negative_and_skips_unrecognised_dates() {
        let store = TestStore::default();
        store.archived_metas.borrow_mut().insert(
            "2026-08-10-early".to_string(),
            "created: 2026-08-12T09:00:00+08:00\narchived_at: 2026-08-12T08:00:00+08:00\n".to_string(),
        );
        store
            .archived_metas
            .borrow_mut()
            .insert("2026-08-10-odd".to_string(), "created: someday\n".to_string());
        let early = archived_cost(&store, "2026-08-10-early");
        assert_eq!((early.lead_days, early.lead_hours), (Some(0), Some(0.0)));
        assert_eq!(archived_cost(&store, "2026-08-10-odd"), ProcessCost::default());
    }
}
