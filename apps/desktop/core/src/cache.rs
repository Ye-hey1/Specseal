//! 归档清单的 SQLite 衍生缓存。
//!
//! 缓存限缩于归档（archived）change 清单——归档量随时间无上限成长，每次全量重解析浪费。
//! active change／spec 清单不经此缓存（见 [`crate::query`]），一律即时经 core 读取文件。
//!
//! 缓存为衍生数据：可删除后由归档目录重建、带 schema 版本标记；版本不符时重建。
//! 文件系统（`changes/archive/`）恒为真相，缓存每次读取都对照目录收敛。

use std::path::Path;

use rusqlite::Connection;
use serde_json::{json, Value};
use specseal_core::station::{ArchivedOutcome, Station, REVIEW, VERIFY};
use specseal_core::store::Store;

use crate::init_core_context;
use crate::query::archived_status_str;

/// 缓存 schema 版本。改动缓存表结构时递增——旧版本会被丢弃重建。
/// v2：archived_changes 加 tasks_total／tasks_done（清单徽章，首次收敛后零解析）。
/// v3：加 spec_count／created_by／from_discussions（封存卡收合信息，spec-archive-drawer design D5）。
/// v4：加 review_status（封存时的审查结局，spec client-protocol「已封存清单的审查结局字段」）。
/// v5：加 verify_status（封存时的验证结局，spec client-protocol「已封存清单的验证结局字段」）。
/// v6：加 why_excerpt／created（封存卡描述列与抽屉出身列，spec client-protocol
///     「已封存清单的呈现辅助字段」）。
/// v7：加 doc_lines／lead_days／lead_hours／review_rounds／verify_rounds（已封存页的
///     流程成本摘要，spec client-protocol「已封存清单的流程成本字段」）。
/// v8：表结构不变；审查与验证的结局改成「有工单优先」，存下的旧结局要重算。
const CACHE_VERSION: i64 = 8;

/// 回传归档 change 清单：`{ "archived": [ { datedName, date, name } ] }`，按 datedName 排序。
/// 非项目回传 `{ "archived": [] }`。
pub fn archived_changes_at(root: &Path) -> Value {
    let Some(ctx) = init_core_context(root) else {
        return json!({ "archived": [] });
    };
    let archive_dir = ctx.workspace.spec_dir().join("changes").join("archive");
    let mut names = read_archive_dir_names(&archive_dir);
    names.sort();
    let db_path = ctx.workspace.work_dir().join("desktop-cache.db");
    // 缓存失败（如磁盘/锁问题）时退回直接以目录数据回应——真相恒为文件。
    let items = match reconcile(&db_path, &ctx.store, &names) {
        Ok(items) => items,
        Err(_) => names.iter().map(|n| item_for(n)).collect(),
    };
    json!({ "archived": items })
}

/// 列出归档目录下的子目录名（各为一个 dated_name）。目录不存在时回传空。
fn read_archive_dir_names(archive_dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(archive_dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect()
}

/// 以目前归档目录为准收敛缓存，回传排序后的清单项。
fn reconcile(db_path: &Path, store: &dyn Store, names: &[String]) -> rusqlite::Result<Vec<Value>> {
    if let Some(parent) = db_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(db_path)?;
    ensure_schema(&conn)?;

    // 只为尚未缓存的名称读 meta 与解析任务计数——这是缓存相对「每次全量重解析」
    // 的省力点；之后清单读取零解析。
    for name in names {
        let cached: bool = conn.query_row(
            "SELECT 1 FROM archived_changes WHERE dated_name = ?1",
            [name],
            |_| Ok(true),
        )
        .unwrap_or(false);
        if !cached {
            let meta = store.read_archived_meta(name).unwrap_or_default();
            let counts = store.read_archived_artifact(name, "tasks.md").map(|text| {
                let tasks = specseal_core::tasks::parse(&text);
                let (total, complete, _) = specseal_core::tasks::progress(&tasks);
                (total as i64, complete as i64)
            });
            // 封存卡收合信息（design D4/D5）：入库使清单读取零解析。from_discussions
            // 以逗号串存放（与 meta 累积器同格式），读出时同语意拆分。
            // 归档 metadata 的坏档语意不在 fail-closed 范围（仅活跃 change）——
            // 历史纪录照旧宽松读取。
            let parsed = specseal_core::model::ChangeMeta::from_text(Some(&meta)).unwrap_or_default();
            let spec_count = store.archived_delta_capabilities(name).len() as i64;
            // 审查结局（封存即定格，不重算冻结度）：含工单 → reviewedNotPassed；否则
            // 含章 → reviewed；皆无 → none（顺序是引擎的 ArchivedOutcome）。入库后清单
            // 读取零解析。验证结局同构且独立判定：同一项可以是「审查通过」却「曾验证未通过」。
            let outcome = |st: &Station, stamped: bool| {
                let ticket_archived = store.read_archived_artifact(name, st.doc).is_some();
                archived_status_str(st, ArchivedOutcome::of(ticket_archived, stamped))
            };
            let review_status = outcome(&REVIEW, parsed.reviewed_at.is_some());
            let verify_status = outcome(&VERIFY, parsed.verified_at.is_some());
            // 呈现辅助字段（desktop-archived-parity D2）：封存卡描述列的 Why 首句与
            // 抽屉出身列的创建日期。来源不可读／缺席时存 NULL，读出时不插 key。
            let why_excerpt = store
                .read_archived_artifact(name, "proposal.md")
                .as_deref()
                .and_then(crate::query::why_excerpt);
            // 流程成本（process-cost-metrics D4）：单项由 core 算，缺席存 NULL；
            // 存不进 SQLite 整数的超大轮数一样存 NULL（读出时不插 key）。
            let cost = specseal_core::cost::archived_cost(store, name);
            let int = |n: Option<u64>| n.and_then(|n| i64::try_from(n).ok());
            conn.execute(
                "INSERT OR REPLACE INTO archived_changes (dated_name, meta, tasks_total, tasks_done, spec_count, created_by, from_discussions, review_status, verify_status, why_excerpt, created, doc_lines, lead_days, lead_hours, review_rounds, verify_rounds) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
                rusqlite::params![
                    name,
                    meta,
                    counts.map(|c| c.0),
                    counts.map(|c| c.1),
                    spec_count,
                    parsed.created_by,
                    parsed.from_discussions().join(","),
                    review_status,
                    verify_status,
                    why_excerpt,
                    parsed.created,
                    int(cost.doc_lines),
                    cost.lead_days,
                    cost.lead_hours,
                    int(cost.review_rounds),
                    int(cost.verify_rounds),
                ],
            )?;
        }
    }

    // 移除已不在归档目录中的残留列（真相是目录）。
    let keep: std::collections::HashSet<&str> = names.iter().map(|s| s.as_str()).collect();
    let mut stmt = conn.prepare("SELECT dated_name FROM archived_changes")?;
    let existing: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .flatten()
        .collect();
    drop(stmt);
    for name in &existing {
        if !keep.contains(name.as_str()) {
            conn.execute("DELETE FROM archived_changes WHERE dated_name = ?1", [name])?;
        }
    }

    let mut stmt = conn.prepare(
        "SELECT dated_name, tasks_total, tasks_done, spec_count, created_by, from_discussions, review_status, verify_status, why_excerpt, created, doc_lines, lead_days, lead_hours, review_rounds, verify_rounds FROM archived_changes ORDER BY dated_name",
    )?;
    let items: Vec<Value> = stmt
        .query_map([], |r| {
            // 流程成本字段：JSON 键与 SELECT 字段编号写在同一处，缺席（NULL）时为 None。
            let cost = [
                ("docLines", r.get::<_, Option<i64>>(10)?.map(Value::from)),
                ("leadDays", r.get::<_, Option<i64>>(11)?.map(Value::from)),
                ("leadHours", r.get::<_, Option<f64>>(12)?.map(Value::from)),
                ("reviewRounds", r.get::<_, Option<i64>>(13)?.map(Value::from)),
                ("verifyRounds", r.get::<_, Option<i64>>(14)?.map(Value::from)),
            ];
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<i64>>(1)?,
                r.get::<_, Option<i64>>(2)?,
                r.get::<_, Option<i64>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, Option<String>>(7)?,
                r.get::<_, Option<String>>(8)?,
                r.get::<_, Option<String>>(9)?,
                cost,
            ))
        })?
        .flatten()
        .map(|row| {
            let (
                n,
                total,
                done,
                spec_count,
                created_by,
                from_discussions,
                review_status,
                verify_status,
                why_excerpt,
                created,
                cost,
            ) = row;
            let mut item = item_for(&n);
            // 无 tasks.md 的封存项徽章字段缺席（前端据此不显示徽章）。
            if let (Some(total), Some(done)) = (total, done) {
                item["tasksTotal"] = json!(total);
                item["tasksDone"] = json!(done);
            }
            // 封存卡收合信息恒存在 key：缺席语意为 0／null／空数组（design D4）。
            item["specCount"] = json!(spec_count.unwrap_or(0));
            item["createdBy"] = json!(created_by);
            let discussions: Vec<&str> = from_discussions
                .as_deref()
                .map(|v| v.split(',').map(str::trim).filter(|s| !s.is_empty()).collect())
                .unwrap_or_default();
            item["fromDiscussions"] = json!(discussions);
            item["reviewStatus"] = json!(review_status.as_deref().unwrap_or("none"));
            item["verifyStatus"] = json!(verify_status.as_deref().unwrap_or("none"));
            // 呈现辅助字段缺席时不插 key（spec：不以空字符串或 null 占位）。
            if let Some(excerpt) = why_excerpt {
                item["whyExcerpt"] = json!(excerpt);
            }
            if let Some(created) = created {
                item["created"] = json!(created);
            }
            // 流程成本字段同规则：缺席不插 key。
            for (key, value) in cost {
                if let Some(value) = value {
                    item[key] = value;
                }
            }
            item
        })
        .collect();
    Ok(items)
}

/// 确保缓存 schema 存在且版本相符；版本不符或缺失时丢弃重建。
fn ensure_schema(conn: &Connection) -> rusqlite::Result<()> {
    let version: Option<i64> = conn
        .query_row(
            "SELECT version FROM schema_version LIMIT 1",
            [],
            |r| r.get(0),
        )
        .ok();
    if version != Some(CACHE_VERSION) {
        conn.execute_batch(
            "DROP TABLE IF EXISTS archived_changes;
             DROP TABLE IF EXISTS schema_version;
             CREATE TABLE schema_version (version INTEGER);
             CREATE TABLE archived_changes (dated_name TEXT PRIMARY KEY, meta TEXT, tasks_total INTEGER, tasks_done INTEGER, spec_count INTEGER, created_by TEXT, from_discussions TEXT, review_status TEXT, verify_status TEXT, why_excerpt TEXT, created TEXT, doc_lines INTEGER, lead_days INTEGER, lead_hours REAL, review_rounds INTEGER, verify_rounds INTEGER);",
        )?;
        conn.execute(
            "INSERT INTO schema_version (version) VALUES (?1)",
            [CACHE_VERSION],
        )?;
    }
    Ok(())
}

/// 由 dated_name（`YYYY-MM-DD-<name>`）廉价拆出显示字段，不读档。
fn item_for(dated_name: &str) -> Value {
    let (date, name) = split_dated_name(dated_name);
    json!({ "datedName": dated_name, "date": date, "name": name })
}

/// 拆 `YYYY-MM-DD-<name>`：前 10 字为日期、第 12 字起为名称；不符格式时 date 空、name 为全名。
fn split_dated_name(dated: &str) -> (&str, &str) {
    let bytes = dated.as_bytes();
    let looks_dated = bytes.len() > 11
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'-'
        && bytes[..10].iter().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                *b == b'-'
            } else {
                b.is_ascii_digit()
            }
        });
    if looks_dated {
        (&dated[..10], &dated[11..])
    } else {
        ("", dated)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// 创建一个含归档 change 的暂存 fixture 项目（specseal/ 使 discover 成功）。
    fn fixture_project(tag: &str, archived: &[&str]) -> PathBuf {
        let root = std::env::temp_dir().join(format!("specseal-cache-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let archive = root.join("specseal").join("changes").join("archive");
        for name in archived {
            let dir = archive.join(name);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("proposal.md"), "## Why\narchived\n").unwrap();
        }
        fs::create_dir_all(root.join("specseal").join("specs")).unwrap();
        root
    }

    fn dated_names(v: &Value) -> Vec<String> {
        v["archived"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["datedName"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn archived_list_carries_review_outcome_three_states() {
        // spec client-protocol「已封存清单的审查结局字段」：封存目录含工单 →
        // reviewedNotPassed（章还在也一样：重开的工单取代了旧章）；否则含章 → reviewed；
        // 皆无 → none。已封存侧不重算冻结度（封存即定格）——此处的假 hash 不得使
        // reviewed 降级。
        let root = fixture_project(
            "review",
            &["2026-01-01-plain", "2026-01-02-passed", "2026-01-03-carried", "2026-01-04-reopened"],
        );
        let archive = root.join("specseal").join("changes").join("archive");
        const STAMPED: &str = "schema: spec-driven\ncreated: 2026-01-01\nreviewed_at: 2026-01-02\nreviewed_by: Rev <r@example.com>\nreviewed_with: claude\nreviewed_tasks_total: 1\nreviewed_scope:\n  - path: src/lib.rs\n    hash: dead\n";
        const TICKET: &str = "# Review — carried\n\n## Round 1\n\n**Scope**: src/lib.rs\n\n- [CRITICAL] src/lib.rs — broken\n";
        fs::write(archive.join("2026-01-02-passed").join(".meta.yaml"), STAMPED).unwrap();
        fs::write(archive.join("2026-01-03-carried").join("review.md"), TICKET).unwrap();
        fs::write(archive.join("2026-01-04-reopened").join(".meta.yaml"), STAMPED).unwrap();
        fs::write(archive.join("2026-01-04-reopened").join("review.md"), TICKET).unwrap();
        let v = archived_changes_at(&root);
        let by_name = |n: &str| {
            v["archived"]
                .as_array()
                .unwrap()
                .iter()
                .find(|i| i["datedName"] == n)
                .unwrap()
                .clone()
        };
        assert_eq!(by_name("2026-01-01-plain")["reviewStatus"], "none");
        assert_eq!(by_name("2026-01-02-passed")["reviewStatus"], "reviewed");
        assert_eq!(by_name("2026-01-03-carried")["reviewStatus"], "reviewedNotPassed");
        assert_eq!(by_name("2026-01-04-reopened")["reviewStatus"], "reviewedNotPassed");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn archived_list_carries_verify_outcome_three_states() {
        // spec client-protocol「已封存清单的验证结局字段」：封存目录含工单 →
        // verifiedNotPassed（章还在也一样）；否则含章 → verified；皆无 → none。
        // 已封存侧不重算冻结度（封存即定格）——假 hash 不得使 verified 降级。
        // 两站在同一项上独立判定：末项同时是「审查通过」与「曾验证未通过」。
        let root = fixture_project(
            "verify",
            &["2026-02-01-plain", "2026-02-02-passed", "2026-02-03-carried", "2026-02-04-reopened"],
        );
        let archive = root.join("specseal").join("changes").join("archive");
        const STAMPED: &str = "schema: spec-driven\ncreated: 2026-02-01\nverified_at: 2026-02-02\nverified_by: Ver <v@example.com>\nverified_with: claude\nverified_tasks_total: 1\nverified_scope:\n  - path: src/lib.rs\n    hash: dead\n";
        fs::write(archive.join("2026-02-02-passed").join(".meta.yaml"), STAMPED).unwrap();
        fs::write(archive.join("2026-02-04-reopened").join(".meta.yaml"), STAMPED).unwrap();
        fs::write(
            archive.join("2026-02-04-reopened").join("verify.md"),
            "# Verify — reopened\n\n## Round 1\n\n**Scope**: src/lib.rs\n\n- [WARNING] src/lib.rs — reopened after the stamp\n",
        )
        .unwrap();
        fs::write(
            archive.join("2026-02-03-carried").join(".meta.yaml"),
            "schema: spec-driven\ncreated: 2026-02-01\nreviewed_at: 2026-02-02\nreviewed_by: Rev <r@example.com>\nreviewed_tasks_total: 1\nreviewed_scope:\n  - path: src/lib.rs\n    hash: dead\n",
        )
        .unwrap();
        fs::write(
            archive.join("2026-02-03-carried").join("verify.md"),
            "# Verify — carried\n\n## Round 1\n\n**Scope**: src/lib.rs\n\n- [CRITICAL] src/lib.rs — requirement R2 has no implementation\n",
        )
        .unwrap();
        let v = archived_changes_at(&root);
        let by_name = |n: &str| {
            v["archived"]
                .as_array()
                .unwrap()
                .iter()
                .find(|i| i["datedName"] == n)
                .unwrap()
                .clone()
        };
        assert_eq!(by_name("2026-02-01-plain")["verifyStatus"], "none");
        assert_eq!(by_name("2026-02-02-passed")["verifyStatus"], "verified");
        let carried = by_name("2026-02-03-carried");
        assert_eq!(carried["verifyStatus"], "verifiedNotPassed");
        assert_eq!(carried["reviewStatus"], "reviewed", "the two outcomes stay independent");
        assert_eq!(by_name("2026-02-04-reopened")["verifyStatus"], "verifiedNotPassed");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn archived_list_matches_archive_dir() {
        let root = fixture_project("match", &["2026-01-02-beta", "2026-01-01-alpha"]);
        let got = dated_names(&archived_changes_at(&root));
        assert_eq!(got, vec!["2026-01-01-alpha", "2026-01-02-beta"]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rebuilds_when_cache_file_missing() {
        let root = fixture_project("missing", &["2026-03-03-gamma"]);
        // 第一次读创建缓存
        let _ = archived_changes_at(&root);
        // 删掉缓存档，仍应由归档目录重建
        let _ = fs::remove_file(root.join(".specseal").join("desktop-cache.db"));
        let got = dated_names(&archived_changes_at(&root));
        assert_eq!(got, vec!["2026-03-03-gamma"]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rebuilds_on_schema_version_mismatch() {
        let root = fixture_project("ver", &["2026-04-04-delta"]);
        let db_dir = root.join(".specseal");
        fs::create_dir_all(&db_dir).unwrap();
        // 预先写入一个版本不符的缓存
        let conn = Connection::open(db_dir.join("desktop-cache.db")).unwrap();
        conn.execute("CREATE TABLE schema_version (version INTEGER)", []).unwrap();
        conn.execute("INSERT INTO schema_version (version) VALUES (999)", []).unwrap();
        drop(conn);
        let got = dated_names(&archived_changes_at(&root));
        assert_eq!(got, vec!["2026-04-04-delta"], "stale-version cache is rebuilt");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn active_list_does_not_create_cache_db() {
        let root = fixture_project("active", &["2026-05-05-epsilon"]);
        let _ = crate::query::list_changes_at(&root);
        let _ = crate::query::list_specs_at(&root);
        assert!(
            !root.join(".specseal").join("desktop-cache.db").exists(),
            "active listing must not touch the archived cache"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn task_counts_converge_once_and_read_zero_parse_afterwards() {
        let root = fixture_project("counts", &["2026-06-06-zeta"]);
        let dir = root.join("specseal").join("changes").join("archive").join("2026-06-06-zeta");
        fs::write(dir.join("tasks.md"), "## 1. G\n\n- [x] 1.1 a\n- [x] 1.2 b\n- [ ] 1.3 c\n").unwrap();

        let v = archived_changes_at(&root);
        let item = &v["archived"].as_array().unwrap()[0];
        assert_eq!(item["tasksTotal"], 3, "first read converges counts into the cache: {item}");
        assert_eq!(item["tasksDone"], 2);

        // 首次收敛后清单读取零解析：改动文件不影响已缓存的计数
        //（封存内容本就不再变动，这证明读取路径不再碰 tasks.md）。
        fs::write(dir.join("tasks.md"), "- [ ] only one\n").unwrap();
        let v2 = archived_changes_at(&root);
        let item2 = &v2["archived"].as_array().unwrap()[0];
        assert_eq!(item2["tasksTotal"], 3, "cached counts must be served without re-parsing");
        assert_eq!(item2["tasksDone"], 2);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn archived_change_without_tasks_md_has_no_badge_fields() {
        let root = fixture_project("nocounts", &["2026-06-07-eta"]);
        let v = archived_changes_at(&root);
        let item = &v["archived"].as_array().unwrap()[0];
        assert!(item.get("tasksTotal").is_none(), "no tasks.md → badge fields absent: {item}");
        assert!(item.get("tasksDone").is_none());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn v1_cache_is_dropped_and_rebuilt_with_counts() {
        let root = fixture_project("v1", &["2026-06-08-theta"]);
        let dir = root.join("specseal").join("changes").join("archive").join("2026-06-08-theta");
        fs::write(dir.join("tasks.md"), "- [x] 1.1 done\n").unwrap();
        // 预写一个 v1 缓存（旧表结构、已含该列）——版本升级须整表重建。
        let db_dir = root.join(".specseal");
        fs::create_dir_all(&db_dir).unwrap();
        let conn = Connection::open(db_dir.join("desktop-cache.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_version (version INTEGER);
             INSERT INTO schema_version (version) VALUES (1);
             CREATE TABLE archived_changes (dated_name TEXT PRIMARY KEY, meta TEXT);
             INSERT INTO archived_changes (dated_name, meta) VALUES ('2026-06-08-theta', '');",
        )
        .unwrap();
        drop(conn);

        let v = archived_changes_at(&root);
        let item = &v["archived"].as_array().unwrap()[0];
        assert_eq!(item["tasksTotal"], 1, "v1 cache must be rebuilt so counts converge: {item}");
        assert_eq!(item["tasksDone"], 1);
        let conn = Connection::open(db_dir.join("desktop-cache.db")).unwrap();
        let version: i64 = conn
            .query_row("SELECT version FROM schema_version LIMIT 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, CACHE_VERSION, "schema version stamped to current after rebuild");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn archived_items_carry_card_info_fields() {
        // 封存变更卡收合信息（spec-archive-drawer design D4）：specCount 为 specs/ 下
        // capability 目录数、createdBy 取 .meta.yaml 的 created_by（缺席 null）、
        // fromDiscussions 为来源讨论 slug 数组（缺席空数组）；字段入缓存，首次收敛后零解析。
        let root = fixture_project("cardinfo", &["2026-06-10-kappa", "2026-06-11-lambda"]);
        let dir = root.join("specseal").join("changes").join("archive").join("2026-06-10-kappa");
        fs::write(
            dir.join(".meta.yaml"),
            "schema: spec-driven\ncreated: 2026-06-01\ncreated_by: momo\nfrom_discussion: alpha-search, beta-cache\narchived_at: 2026-06-10\n",
        )
        .unwrap();
        fs::create_dir_all(dir.join("specs").join("cap-a")).unwrap();
        fs::write(dir.join("specs").join("cap-a").join("spec.md"), "## ADDED Requirements\n").unwrap();
        fs::create_dir_all(dir.join("specs").join("cap-b")).unwrap();
        fs::write(dir.join("specs").join("cap-b").join("spec.md"), "## ADDED Requirements\n").unwrap();

        let v = archived_changes_at(&root);
        let arr = v["archived"].as_array().unwrap();
        let by_name = |n: &str| arr.iter().find(|i| i["datedName"] == n).unwrap().clone();
        let kappa = by_name("2026-06-10-kappa");
        assert_eq!(kappa["specCount"], 2, "specs/ 下两个 capability 目录: {kappa}");
        assert_eq!(kappa["createdBy"], "momo");
        assert_eq!(kappa["fromDiscussions"], json!(["alpha-search", "beta-cache"]));
        // meta 与 specs 全缺席的封存项：null／空数组，清单照常回传。
        let lambda = by_name("2026-06-11-lambda");
        assert_eq!(lambda["specCount"], 0);
        assert!(lambda["createdBy"].is_null());
        assert_eq!(lambda["fromDiscussions"], json!([]));

        // 首次收敛后零解析：改动 meta 不影响已缓存的字段（封存内容本就不再变动）。
        fs::write(dir.join(".meta.yaml"), "created_by: someone-else\n").unwrap();
        let v2 = archived_changes_at(&root);
        let item2 = v2["archived"].as_array().unwrap().iter().find(|i| i["datedName"] == "2026-06-10-kappa").unwrap().clone();
        assert_eq!(item2["createdBy"], "momo", "cached card info served without re-parsing");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn v2_cache_is_dropped_and_rebuilt_with_card_info() {
        // 版本递升（spec-archive-drawer design D5）：新字段入库使 CACHE_VERSION 2→3，
        // 旧 v2 缓存整表重建、新字段补齐、版本盖 3 章。
        let root = fixture_project("v2", &["2026-06-12-mu"]);
        let dir = root.join("specseal").join("changes").join("archive").join("2026-06-12-mu");
        fs::write(dir.join(".meta.yaml"), "created: 2026-06-01\ncreated_by: momo\n").unwrap();
        fs::create_dir_all(dir.join("specs").join("cap-a")).unwrap();
        fs::write(dir.join("specs").join("cap-a").join("spec.md"), "## ADDED Requirements\n").unwrap();
        fs::write(dir.join("tasks.md"), "- [x] 1.1 done\n").unwrap();
        // 预写一个 v2 缓存（v2 表结构、已含该列）——版本升级须整表重建。
        let db_dir = root.join(".specseal");
        fs::create_dir_all(&db_dir).unwrap();
        let conn = Connection::open(db_dir.join("desktop-cache.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_version (version INTEGER);
             INSERT INTO schema_version (version) VALUES (2);
             CREATE TABLE archived_changes (dated_name TEXT PRIMARY KEY, meta TEXT, tasks_total INTEGER, tasks_done INTEGER);
             INSERT INTO archived_changes (dated_name, meta, tasks_total, tasks_done) VALUES ('2026-06-12-mu', '', 1, 1);",
        )
        .unwrap();
        drop(conn);

        let v = archived_changes_at(&root);
        let item = &v["archived"].as_array().unwrap()[0];
        assert_eq!(item["specCount"], 1, "v2 cache must be rebuilt so card info converges: {item}");
        assert_eq!(item["createdBy"], "momo");
        assert_eq!(item["tasksTotal"], 1);
        let conn = Connection::open(db_dir.join("desktop-cache.db")).unwrap();
        let version: i64 = conn
            .query_row("SELECT version FROM schema_version LIMIT 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, CACHE_VERSION, "schema version stamped to current after rebuild");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn archived_items_carry_why_excerpt_and_created() {
        // spec client-protocol「已封存清单的呈现辅助字段」：whyExcerpt 为封存
        // proposal.md 的 Why 区段首个非空行、created 取 metadata 的创建日期；
        // 来源不可读或缺席时该字段不插 key（不以空字符串或 null 占位），
        // 清单其余字段照常回传。
        let root = fixture_project(
            "whyexcerpt",
            &["2026-07-01-nu", "2026-07-02-xi", "2026-07-03-omicron"],
        );
        let archive = root.join("specseal").join("changes").join("archive");
        // 两字段俱在。
        fs::write(
            archive.join("2026-07-01-nu").join("proposal.md"),
            "## Why\n\n看板搜索列缺席，跨卡找东西只能逐栏翻。\n\n## What Changes\n\n- 补搜索列\n",
        )
        .unwrap();
        fs::write(
            archive.join("2026-07-01-nu").join(".meta.yaml"),
            "schema: spec-driven\ncreated: 2026-06-20\narchived_at: 2026-07-01\n",
        )
        .unwrap();
        // proposal 缺席（fixture 缺省会写一份，此处移除）——metadata 仍可得。
        fs::remove_file(archive.join("2026-07-02-xi").join("proposal.md")).unwrap();
        fs::write(
            archive.join("2026-07-02-xi").join(".meta.yaml"),
            "schema: spec-driven\ncreated: 2026-06-21\n",
        )
        .unwrap();
        // proposal 在但无 Why 区段，且 metadata 全缺席。
        fs::write(
            archive.join("2026-07-03-omicron").join("proposal.md"),
            "## What Changes\n\n只有这段。\n",
        )
        .unwrap();

        let v = archived_changes_at(&root);
        let arr = v["archived"].as_array().unwrap();
        let by_name = |n: &str| arr.iter().find(|i| i["datedName"] == n).unwrap().clone();

        let nu = by_name("2026-07-01-nu");
        assert_eq!(nu["whyExcerpt"], "看板搜索列缺席，跨卡找东西只能逐栏翻。");
        assert_eq!(nu["created"], "2026-06-20");

        let xi = by_name("2026-07-02-xi");
        assert!(xi.get("whyExcerpt").is_none(), "proposal 缺席 → 不插 key: {xi}");
        assert_eq!(xi["created"], "2026-06-21", "另一字段照常");
        assert_eq!(xi["datedName"], "2026-07-02-xi", "既有字段照常回传");

        let omicron = by_name("2026-07-03-omicron");
        assert!(omicron.get("whyExcerpt").is_none(), "无 Why 区段 → 不插 key: {omicron}");
        assert!(omicron.get("created").is_none(), "metadata 无创建日期 → 不插 key");

        // 首次收敛后零解析：改动 proposal 不影响已缓存的字段。
        fs::write(
            archive.join("2026-07-01-nu").join("proposal.md"),
            "## Why\n\n改过的内容。\n",
        )
        .unwrap();
        let v2 = archived_changes_at(&root);
        let nu2 = v2["archived"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["datedName"] == "2026-07-01-nu")
            .unwrap()
            .clone();
        assert_eq!(
            nu2["whyExcerpt"], "看板搜索列缺席，跨卡找东西只能逐栏翻。",
            "cached excerpt served without re-parsing"
        );
        let _ = fs::remove_dir_all(&root);
    }

    const COST_KEYS: [&str; 5] = ["docLines", "leadDays", "leadHours", "reviewRounds", "verifyRounds"];

    fn numbered_lines(n: usize) -> String {
        (1..=n).map(|i| format!("line {i}\n")).collect()
    }

    #[test]
    fn archived_items_carry_process_cost_fields() {
        // spec client-protocol「已封存清单的流程成本字段」三个情境：新格式带齐、
        // 旧格式只带得出的字段、没有 metadata 与文档时全部缺席（不插 key）。
        let root = fixture_project("cost", &["2026-10-22-demo", "2026-08-14-old", "2026-08-15-empty"]);
        let archive = root.join("specseal").join("changes").join("archive");
        let demo = archive.join("2026-10-22-demo");
        fs::write(
            demo.join(".meta.yaml"),
            "schema: spec-driven\ncreated: 2026-10-21T10:00:00+08:00\nreviewed_rounds: 2\nverified_rounds: 3\narchived_at: 2026-10-22T16:30:00+08:00\n",
        )
        .unwrap();
        fs::write(demo.join("proposal.md"), numbered_lines(120)).unwrap();
        fs::write(demo.join("tasks.md"), numbered_lines(80)).unwrap();
        fs::create_dir_all(demo.join("specs").join("auth")).unwrap();
        fs::write(demo.join("specs").join("auth").join("spec.md"), numbered_lines(50)).unwrap();
        let old = archive.join("2026-08-14-old");
        fs::write(old.join(".meta.yaml"), "schema: spec-driven\ncreated: 2026-08-12\n").unwrap();
        fs::write(old.join("tasks.md"), "- [x] 1.1 a\n").unwrap();
        fs::remove_file(archive.join("2026-08-15-empty").join("proposal.md")).unwrap();

        let v = archived_changes_at(&root);
        let arr = v["archived"].as_array().unwrap();
        let by_name = |n: &str| arr.iter().find(|i| i["datedName"] == n).unwrap().clone();

        let demo = by_name("2026-10-22-demo");
        assert_eq!(demo["docLines"], 250, "{demo}");
        assert_eq!(demo["leadDays"], 1);
        assert_eq!(demo["leadHours"], 30.5);
        assert_eq!(demo["reviewRounds"], 2);
        assert_eq!(demo["verifyRounds"], 3);
        assert_eq!(demo["created"], "2026-10-21", "created keeps the date part");

        let old = by_name("2026-08-14-old");
        assert_eq!(old["docLines"], 3, "fixture proposal (2) + tasks (1): {old}");
        assert_eq!(old["leadDays"], 2);
        for key in ["leadHours", "reviewRounds", "verifyRounds"] {
            assert!(old.get(key).is_none(), "{key} absent: {old}");
        }
        assert_eq!(old["tasksTotal"], 1, "existing fields stay");

        let empty = by_name("2026-08-15-empty");
        for key in COST_KEYS {
            assert!(empty.get(key).is_none(), "{key} absent: {empty}");
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rounds_too_large_for_sqlite_are_left_out_instead_of_wrapping() {
        // u64 上限放不进 SQLite 的 i64：存 NULL、读出不插 key，不会变成负数。
        let root = fixture_project("huge-rounds", &["2026-07-06-rho"]);
        let dir = root.join("specseal").join("changes").join("archive").join("2026-07-06-rho");
        fs::write(dir.join(".meta.yaml"), format!("reviewed_rounds: {}\nverified_rounds: 4\n", u64::MAX))
            .unwrap();
        let v = archived_changes_at(&root);
        let item = &v["archived"].as_array().unwrap()[0];
        assert!(item.get("reviewRounds").is_none(), "oversized count is absent: {item}");
        assert_eq!(item["verifyRounds"], 4, "the other count stays");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn v6_cache_is_dropped_and_rebuilt_with_process_cost() {
        // design D5：五栏入库使 CACHE_VERSION 6→7，旧 v6 缓存整表重建。
        let root = fixture_project("v6", &["2026-07-05-pi"]);
        let db_dir = root.join(".specseal");
        fs::create_dir_all(&db_dir).unwrap();
        let conn = Connection::open(db_dir.join("desktop-cache.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_version (version INTEGER);
             INSERT INTO schema_version (version) VALUES (6);
             CREATE TABLE archived_changes (dated_name TEXT PRIMARY KEY, meta TEXT, tasks_total INTEGER, tasks_done INTEGER, spec_count INTEGER, created_by TEXT, from_discussions TEXT, review_status TEXT, verify_status TEXT, why_excerpt TEXT, created TEXT);
             INSERT INTO archived_changes (dated_name, meta, spec_count) VALUES ('2026-07-05-pi', '', 0);",
        )
        .unwrap();
        drop(conn);

        let v = archived_changes_at(&root);
        let item = &v["archived"].as_array().unwrap()[0];
        assert_eq!(item["docLines"], 2, "v6 cache must be rebuilt so the cost converges: {item}");
        let conn = Connection::open(db_dir.join("desktop-cache.db")).unwrap();
        let version: i64 = conn
            .query_row("SELECT version FROM schema_version LIMIT 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, CACHE_VERSION, "schema version stamped to current after rebuild");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn v7_cache_is_dropped_so_stored_outcomes_follow_the_ticket_first_rule() {
        // v8：结局改成「有工单优先」。v7 存下的 reviewed 是旧顺序算的，整表重建后重算。
        let root = fixture_project("v7", &["2026-11-04-reopened"]);
        let dir = root.join("specseal").join("changes").join("archive").join("2026-11-04-reopened");
        fs::write(
            dir.join(".meta.yaml"),
            "schema: spec-driven\ncreated: 2026-11-01\nreviewed_at: 2026-11-02\nreviewed_tasks_total: 1\nreviewed_scope:\n  - path: src/lib.rs\n    hash: dead\n",
        )
        .unwrap();
        fs::write(dir.join("review.md"), "# Review — reopened\n\n## Round 1\n\n**Scope**: src/lib.rs\n\n- [WARNING] src/lib.rs — reopened\n").unwrap();
        let db_dir = root.join(".specseal");
        fs::create_dir_all(&db_dir).unwrap();
        let conn = Connection::open(db_dir.join("desktop-cache.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_version (version INTEGER);
             INSERT INTO schema_version (version) VALUES (7);
             CREATE TABLE archived_changes (dated_name TEXT PRIMARY KEY, meta TEXT, tasks_total INTEGER, tasks_done INTEGER, spec_count INTEGER, created_by TEXT, from_discussions TEXT, review_status TEXT, verify_status TEXT, why_excerpt TEXT, created TEXT, doc_lines INTEGER, lead_days INTEGER, lead_hours REAL, review_rounds INTEGER, verify_rounds INTEGER);
             INSERT INTO archived_changes (dated_name, meta, spec_count, review_status, verify_status) VALUES ('2026-11-04-reopened', '', 0, 'reviewed', 'none');",
        )
        .unwrap();
        drop(conn);

        let v = archived_changes_at(&root);
        let item = &v["archived"].as_array().unwrap()[0];
        assert_eq!(item["reviewStatus"], "reviewedNotPassed", "{item}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cache_failure_falls_back_to_directory_listing_without_badges() {
        let root = fixture_project("fallback", &["2026-06-09-iota"]);
        // 让缓存档位置变成目录——Connection::open 失败，走目录直读退回路径。
        fs::create_dir_all(root.join(".specseal").join("desktop-cache.db")).unwrap();
        let v = archived_changes_at(&root);
        let got = dated_names(&v);
        assert_eq!(got, vec!["2026-06-09-iota"], "fallback still serves the directory truth");
        let item = &v["archived"].as_array().unwrap()[0];
        assert!(item.get("tasksTotal").is_none(), "fallback items carry no badge fields");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn non_project_yields_empty_archived() {
        let root = std::env::temp_dir().join(format!("specseal-cache-none-{}", std::process::id()));
        let _ = fs::create_dir_all(&root);
        assert_eq!(archived_changes_at(&root), json!({ "archived": [] }));
        let _ = fs::remove_dir_all(&root);
    }
}
