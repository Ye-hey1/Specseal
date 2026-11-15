use super::{
    archive, merge_capability, merge_violations, skip_reason, ArchiveOptions, SkipReason,
};
use crate::store::Store;
use crate::tasks::TouchedRecord;
use crate::teststore::TestStore;
use crate::util;
use crate::workspace::Workspace;

#[test]
fn archive_preserves_started_fields_and_stamps_the_archived_station() {
    // A change carrying all three started_* fields (plus created_*) must
    // arrive in the archive with every lifecycle station intact —
    // started_* byte-for-byte, archived_at appended by the stamp. The host
    // root deliberately does not exist: the skip-specs path touches no
    // host files (git probes fail soft, no snapshot is written), so the
    // test needs no filesystem at all.
    let ws = Workspace {
        root: std::env::temp_dir().join("specseal-archive-test-ghost-root"),
        spec_dir_name: "openspec".to_string(),
    };
    let meta = "schema: spec-driven\ncreated: 2026-07-01\ncreated_by: Base Line <base@example.com>\ncreated_with: claude\nstarted_at: 2026-07-03\nstarted_by: Worker <w@example.com>\nstarted_with: claude\n";
    let store = TestStore::with_meta("demo", meta);
    store.put_artifact("demo", "tasks.md", "- [x] 1.1 done\n");
    let change = crate::model::find_change(&store, "demo").unwrap();

    let outcome = archive(
        &ws,
        &store,
        &change,
        &ArchiveOptions {
            skip_specs: true,
            carry_review: false,
            carry_verify: false,
            no_validate: true,
            mark_tasks_complete: false,
        },
        None,
    )
    .unwrap();

    let today = util::today();
    assert_eq!(outcome.dated_name, format!("{today}-demo"));
    let archived = store.read_archived_meta(&outcome.dated_name).unwrap();
    assert!(
        archived.starts_with(meta),
        "created_* and started_* must survive archive byte-for-byte, got: {archived}"
    );
    let stamps = archived_at_values(&archived);
    assert!(
        stamps.len() == 1 && stamps[0].starts_with(&format!("{today}T")),
        "one archived_at stamp from today: {archived}"
    );
    // All three stations coexist on the archived document.
    for field in ["created:", "started_at:", "started_by:", "started_with:", "archived_at:"] {
        assert!(archived.contains(field), "missing station field {field}");
    }
    assert!(!store.change_exists("demo"), "active change moved into the archive");
}

/// 每一行 `archived_at: ` 的值。
fn archived_at_values(meta: &str) -> Vec<&str> {
    meta.lines().filter_map(|l| l.strip_prefix("archived_at: ")).collect()
}

// --- spec change-lifecycle「封存写入 archived_at」（process-cost-metrics design D3）---

#[test]
fn archive_writes_one_archived_at_stamp_from_the_dated_name_instant() {
    // Scenario「成功封存带封存时戳」：时戳与目录名日期前缀取自同一个「现在」。
    let store = gate_store("- [x] 1.1 a\n");
    let change = crate::model::find_change(&store, "demo").unwrap();
    let outcome = archive(&ghost_ws(), &store, &change, &skip_opts(), None).unwrap();
    let archived = store.read_archived_meta(&outcome.dated_name).unwrap();
    let stamps = archived_at_values(&archived);
    assert_eq!(stamps.len(), 1, "exactly one archived_at line: {archived}");
    assert!(util::is_offset_stamp(stamps[0]), "archived_at is an offset stamp: {archived}");
    assert_eq!(&stamps[0][..10], &outcome.dated_name[..10], "same instant as the dated name");
}

#[test]
fn archived_at_equals_the_trace_updated_stamp() {
    // 同一个「现在」的第三方：正式规格 `@trace` 的 `updated` 与 archived_at 逐字相同。
    let t = TraceWs::new("archived-at-trace");
    let store = trace_store();
    let change = crate::model::find_change(&store, "demo").unwrap();
    let outcome = archive(&t.ws, &store, &change, &apply_opts(), None).unwrap();
    let trace = assert_trace_stamp(&store.read_canonical_spec("auth").unwrap(), &outcome.dated_name);
    let archived = store.read_archived_meta(&outcome.dated_name).unwrap();
    assert_eq!(archived_at_values(&archived), vec![trace.as_str()], "{archived}");
}

#[test]
fn retried_archive_replaces_a_leftover_archived_at() {
    // Scenario「重试封存只留一行封存时戳」：前一次移动失败留下的 archived_at 被取代。
    let leftover = "archived_at: 2026-10-20T09:00:00+08:00\n";
    let store = TestStore::with_meta("demo", &format!("schema: spec-driven\n{leftover}"));
    store.put_artifact("demo", "tasks.md", "- [x] 1.1 a\n");
    let change = crate::model::find_change(&store, "demo").unwrap();
    let outcome = archive(&ghost_ws(), &store, &change, &skip_opts(), None).unwrap();
    let archived = store.read_archived_meta(&outcome.dated_name).unwrap();
    let stamps = archived_at_values(&archived);
    assert_eq!(stamps.len(), 1, "exactly one archived_at line: {archived}");
    assert_eq!(&stamps[0][..10], &outcome.dated_name[..10], "the new stamp wins: {archived}");
}

#[test]
fn a_failed_archived_at_write_names_the_snapshot_location() {
    // archived_at 在正式规格写入之后才写：它失败时规格已合并，错误消息要像
    // canonical 写入失败一样指出 snapshot 备份位置，change 留在进行中。
    let tw = TraceWs::new("archived-at-fails");
    let store = trace_store();
    *store.fail_meta_write.borrow_mut() = Some("demo".to_string());
    let change = crate::model::find_change(&store, "demo").unwrap();
    let err = archive(&tw.ws, &store, &change, &apply_opts(), None)
        .expect_err("the injected meta write failure surfaces");
    assert!(
        err.to_string().contains(&tw.ws.snapshots_dir().display().to_string()),
        "the failure names the snapshot location: {err}"
    );
    assert!(store.change_exists("demo"), "the change was not moved");
    assert!(store.canonical.borrow().contains_key("auth"), "the canonical spec already landed");
}

#[test]
fn a_failed_archived_at_write_without_merged_specs_names_no_backup() {
    // 没有 delta 要合并时没有写任何备份：错误消息不指向不存在的 snapshot 目录，
    // 也不暗示正式规格已合并。
    let store = gate_store("- [x] 1.1 a\n");
    *store.fail_meta_write.borrow_mut() = Some("demo".to_string());
    let change = crate::model::find_change(&store, "demo").unwrap();
    let err = archive(&ghost_ws(), &store, &change, &skip_opts(), None)
        .expect_err("the injected meta write failure surfaces");
    let msg = err.to_string();
    assert!(msg.contains("the change was not moved"), "{msg}");
    assert!(!msg.contains("backups"), "no backup was written, none is named: {msg}");
    assert!(store.change_exists("demo"), "the change was not moved");
}

// --- spec change-lifecycle「封存的章失效守门」（design D5）---

mod stale_stamp_gate {
    use super::*;
    use crate::station::content_fingerprint;

    const SCOPE_PATH: &str = "crates/a/src/lib.rs";
    const FILE_A: &str = "fn a() {}\n";
    /// 全任务完成（含 `[M]`）——封存的任务完成度守门要求全勾，手测强制力保留。
    const TASKS_ALL_DONE: &str = "- [x] a\n- [x] b\n- [x] c\n- [x] d\n- [x] [M] 手测\n";

    /// 有工作树的 workspace：scope 档以 `content` 写入真实暂存目录。
    fn ws_with_scope_file(tag: &str, content: &str) -> Workspace {
        let root = std::env::temp_dir().join(format!("specseal-stale-stamp-{tag}"));
        let file = root.join(SCOPE_PATH);
        std::fs::create_dir_all(file.parent().expect("scope parent")).expect("mkdir");
        std::fs::write(&file, content).expect("write scope file");
        Workspace { root, spec_dir_name: "openspec".to_string() }
    }

    /// remote 封存信道：空 root＝无本地工作树（沿 guard_linked_worktree 的惯例）。
    fn remote_ws() -> Workspace {
        Workspace { root: std::path::PathBuf::new(), spec_dir_name: "openspec".to_string() }
    }

    /// 带指定站别章的 meta：锚记全任务总数 5、scope 为 FILE_A 的现值指纹。
    fn meta_with_stamps(prefixes: &[&str]) -> String {
        let hash = content_fingerprint(FILE_A);
        let mut meta = "schema: spec-driven\ncreated: 2026-07-01\n".to_string();
        for p in prefixes {
            meta.push_str(&format!(
                "{p}_at: 2026-08-01\n{p}_by: R <r@example.com>\n{p}_with: claude\n\
                     {p}_tasks_total: 5\n{p}_scope:\n  - path: {SCOPE_PATH}\n    hash: {hash}\n"
            ));
        }
        meta
    }

    fn try_archive(
        ws: &Workspace,
        store: &TestStore,
        opts: ArchiveOptions,
    ) -> anyhow::Result<()> {
        let change = crate::model::find_change(store, "demo").expect("change");
        archive(ws, store, &change, &opts, None).map(|_| ())
    }

    #[test]
    fn a_refused_archive_writes_no_archived_at() {
        // spec「封存守门拒绝不写封存时戳」：审查章已失效 → 拒绝，meta 没有 archived_at。
        let ws = ws_with_scope_file("no-archived-at", &format!("{FILE_A}fn extra() {{}}\n"));
        let meta = meta_with_stamps(&["reviewed"]);
        let store = TestStore::with_meta("demo", &meta);
        store.put_artifact("demo", "tasks.md", TASKS_ALL_DONE);
        try_archive(&ws, &store, skip_opts()).expect_err("stale stamp must refuse");
        assert!(store.change_exists("demo"), "the change stays in progress");
        assert_eq!(store.meta("demo"), meta, "no archived_at lands on a refusal");
    }

    #[test]
    fn stale_content_anchor_refuses_and_names_the_station() {
        // Example 表第一列：review 章齐备、scope 档内容改变 → 拒绝、点名 review。
        let ws = ws_with_scope_file("content", &format!("{FILE_A}fn extra() {{}}\n"));
        let store = TestStore::with_meta("demo", &meta_with_stamps(&["reviewed"]));
        store.put_artifact("demo", "tasks.md", TASKS_ALL_DONE);
        let err = try_archive(&ws, &store, skip_opts()).expect_err("stale stamp must refuse");
        let msg = err.to_string();
        assert!(msg.contains("review"), "must name the station: {msg}");
        assert!(msg.contains(SCOPE_PATH), "must name the changed file: {msg}");
        assert!(store.change_exists("demo"), "refusal must not move the change");
    }

    #[test]
    fn checking_a_manual_task_after_the_stamp_still_archives() {
        // Example 表第二列：两章齐备、补勾 [M]、scope 档零改动 → 放行。
        let ws = ws_with_scope_file("manual", FILE_A);
        let store =
            TestStore::with_meta("demo", &meta_with_stamps(&["reviewed", "verified"]));
        store.put_artifact("demo", "tasks.md", TASKS_ALL_DONE);
        try_archive(&ws, &store, skip_opts()).expect("manual toggle must not stale the stamp");
        assert!(!store.change_exists("demo"), "change must be archived");
    }

    #[test]
    fn a_new_task_after_the_stamp_breaks_the_task_anchor() {
        // Example 表第三列：两章齐备、任务总数自 5 变 6 → 拒绝（任务锚破）。
        let ws = ws_with_scope_file("recount", FILE_A);
        let store =
            TestStore::with_meta("demo", &meta_with_stamps(&["reviewed", "verified"]));
        store.put_artifact("demo", "tasks.md", &format!("{TASKS_ALL_DONE}- [x] f\n"));
        let err = try_archive(&ws, &store, skip_opts()).expect_err("task anchor must refuse");
        let msg = err.to_string();
        assert!(msg.contains("review") && msg.contains("verify"), "both stamps: {msg}");
        assert!(store.change_exists("demo"), "refusal must not move the change");
    }

    #[test]
    fn no_stamp_and_unknown_stamp_both_pass_through() {
        // Example 表第四、五列：无章与章字段不全 → 放行，行为与守门引入前一致。
        for (tag, meta) in [
            ("nostamp", "schema: spec-driven\ncreated: 2026-07-01\n".to_string()),
            // 章字段不全（缺 scope）→ Unknown，视同无章。
            (
                "partial",
                "schema: spec-driven\ncreated: 2026-07-01\nreviewed_at: 2026-08-01\n\
                     reviewed_tasks_total: 5\n"
                    .to_string(),
            ),
        ] {
            let ws = ws_with_scope_file(tag, &format!("{FILE_A}changed\n"));
            let store = TestStore::with_meta("demo", &meta);
            store.put_artifact("demo", "tasks.md", TASKS_ALL_DONE);
            try_archive(&ws, &store, skip_opts()).unwrap_or_else(|e| panic!("{tag}: {e}"));
            assert!(!store.change_exists("demo"), "{tag}: change must be archived");
        }
    }

    #[test]
    fn a_stale_stamp_refuses_before_the_merge_gate() {
        // 章失效＋delta 过期 → 章失效先拒；merge 拒绝字符串不出现。
        let ws = ws_with_scope_file("stale-before-merge", FILE_A);
        let store = TestStore::with_meta("demo", &meta_with_stamps(&["reviewed"]));
        store.put_artifact("demo", "tasks.md", &format!("{TASKS_ALL_DONE}- [x] e\n"));
        store.put_artifact("demo", "specs/auth/spec.md", ADDED_R1);
        store.canonical.borrow_mut().insert("auth".to_string(), CANON_R1.to_string());
        let err = try_archive(&ws, &store, apply_opts()).expect_err("stale stamp must refuse");
        let msg = err.to_string();
        assert!(msg.contains("tasks moved after the stamp"), "stale wording: {msg}");
        assert!(!msg.contains("cannot be archived"), "merge refusal never reached: {msg}");
    }

    #[test]
    fn the_task_readiness_gate_refuses_first() {
        // Example 表之外的顺序契约：写码任务未完成＋章已失效 → 任务守门先拒，
        // 消息维持既有样式、不提章失效。
        let ws = ws_with_scope_file("order", &format!("{FILE_A}changed\n"));
        let store = TestStore::with_meta("demo", &meta_with_stamps(&["reviewed"]));
        store.put_artifact("demo", "tasks.md", "- [x] a\n- [ ] b\n");
        let err = try_archive(&ws, &store, skip_opts()).expect_err("task gate must refuse");
        let msg = err.to_string();
        assert!(msg.contains("1/2 tasks complete"), "既有任务守门消息: {msg}");
        assert!(!msg.contains("stamp"), "任务守门消息不得提及章失效: {msg}");
    }

    #[test]
    fn the_remote_channel_judges_only_the_task_anchor() {
        // spec Scenario「remote 信道仅判任务锚」：无工作树 → 内容锚跳过（放行），
        // 任务锚破仍拒绝。scope 档在 remote 侧根本读不到，等同「改过」。
        let store = TestStore::with_meta("demo", &meta_with_stamps(&["reviewed"]));
        store.put_artifact("demo", "tasks.md", TASKS_ALL_DONE);
        try_archive(&remote_ws(), &store, skip_opts())
            .expect("no work tree → content anchor is not judged");

        let store = TestStore::with_meta("demo", &meta_with_stamps(&["reviewed"]));
        store.put_artifact("demo", "tasks.md", &format!("{TASKS_ALL_DONE}- [x] f\n"));
        let err = try_archive(&remote_ws(), &store, skip_opts())
            .expect_err("task anchor still refuses on the remote channel");
        assert!(err.to_string().contains("review"), "{err}");
    }
}

// --- 封存共行逐 slug（design D3；spec「多来源讨论的变更封存逐一共行」）---

fn ghost_ws() -> Workspace {
    Workspace {
        root: std::env::temp_dir().join("specseal-archive-co-travel-ghost-root"),
        spec_dir_name: "openspec".to_string(),
    }
}

fn skip_opts() -> ArchiveOptions {
    ArchiveOptions {
        skip_specs: true,
        no_validate: true,
        mark_tasks_complete: false,
        carry_review: false,
        carry_verify: false,
    }
}

fn discussion_doc(slug: &str) -> String {
    format!(
        "---\ntopic: {slug}\nslug: {slug}\nstatus: promoted\npromoted_to: cut\ncreated: 2026-07-01\n---\n\n## Conclusion\n\n**Decision**: x\n"
    )
}

#[test]
fn archive_co_travels_every_unreferenced_source_discussion() {
    // 两份来源讨论皆无其他在途变更引用 → 两份皆随行封存。
    let store = TestStore::with_meta(
        "cut",
        "schema: spec-driven\ncreated: 2026-07-01\nfrom_discussion: d1, d2\n",
    );
    store.put_artifact("cut", "tasks.md", "- [x] 1.1 done\n");
    store.discussions.borrow_mut().insert("d1".into(), discussion_doc("d1"));
    store.discussions.borrow_mut().insert("d2".into(), discussion_doc("d2"));
    let change = crate::model::find_change(&store, "cut").unwrap();

    let outcome = archive(&ghost_ws(), &store, &change, &skip_opts(), None).unwrap();

    let slugs: Vec<&str> =
        outcome.archived_discussions.iter().map(|(s, _)| s.as_str()).collect();
    assert_eq!(slugs, vec!["d1", "d2"], "both unreferenced discussions co-archive");
    assert!(store.archived_discussion_exists("d1"));
    assert!(store.archived_discussion_exists("d2"));
}

#[test]
fn archive_leaves_discussion_still_referenced_by_another_change() {
    // d2 仍被另一在途变更 cut2 引用 → 仅 d1 随行，d2 留在途。
    let store = TestStore::with_meta(
        "cut",
        "schema: spec-driven\ncreated: 2026-07-01\nfrom_discussion: d1, d2\n",
    );
    store.metas.borrow_mut().insert(
        "cut2".into(),
        "schema: spec-driven\ncreated: 2026-07-02\nfrom_discussion: d2\n".into(),
    );
    store.put_artifact("cut", "tasks.md", "- [x] 1.1 done\n");
    store.discussions.borrow_mut().insert("d1".into(), discussion_doc("d1"));
    store.discussions.borrow_mut().insert("d2".into(), discussion_doc("d2"));
    let change = crate::model::find_change(&store, "cut").unwrap();

    let outcome = archive(&ghost_ws(), &store, &change, &skip_opts(), None).unwrap();

    let slugs: Vec<&str> =
        outcome.archived_discussions.iter().map(|(s, _)| s.as_str()).collect();
    assert_eq!(slugs, vec!["d1"], "only the unreferenced discussion co-archives");
    assert!(store.archived_discussion_exists("d1"));
    assert!(!store.archived_discussion_exists("d2"), "d2 stays live — still referenced");
    assert!(store.live_discussion_exists("d2"));
}

#[test]
fn archive_leaves_unconcluded_discussion_live() {
    // 未结论（Conclusion 仍为占位注解）的来源讨论不随变更封存，维持在途。
    let store = TestStore::with_meta(
        "cut",
        "schema: spec-driven\ncreated: 2026-07-01\nfrom_discussion: pending\n",
    );
    store.put_artifact("cut", "tasks.md", "- [x] 1.1 done\n");
    store.discussions.borrow_mut().insert(
        "pending".into(),
        "---\ntopic: pending\nslug: pending\nstatus: promoted\npromoted_to: cut\ncreated: 2026-07-01\n---\n\n## Conclusion\n\n<!-- Written by `specseal discuss conclude` -->\n".into(),
    );
    let change = crate::model::find_change(&store, "cut").unwrap();

    let outcome = archive(&ghost_ws(), &store, &change, &skip_opts(), None).unwrap();

    assert!(
        outcome.archived_discussions.is_empty(),
        "unconcluded discussion must not co-archive"
    );
    assert!(store.live_discussion_exists("pending"), "record stays live");
    assert!(!store.archived_discussion_exists("pending"));
}

#[test]
fn archive_leaves_held_discussion_live() {
    // 已结论但带 hold（还欠下一刀）的来源讨论不随变更封存，维持在途。
    let store = TestStore::with_meta(
        "cut",
        "schema: spec-driven\ncreated: 2026-07-01\nfrom_discussion: staged\n",
    );
    store.put_artifact("cut", "tasks.md", "- [x] 1.1 done\n");
    store.discussions.borrow_mut().insert(
        "staged".into(),
        "---\ntopic: staged\nslug: staged\nstatus: promoted\npromoted_to: cut\ncreated: 2026-07-01\nhold: true\n---\n\n## Conclusion\n\n**Decision**: cut-b later\n".into(),
    );
    let change = crate::model::find_change(&store, "cut").unwrap();

    let outcome = archive(&ghost_ws(), &store, &change, &skip_opts(), None).unwrap();

    assert!(
        outcome.archived_discussions.is_empty(),
        "held discussion must not co-archive"
    );
    assert!(store.live_discussion_exists("staged"), "record stays live");
    assert!(!store.archived_discussion_exists("staged"));
}

#[test]
fn archive_judges_hold_per_source_discussion() {
    // 多来源逐一共行：同一 from_discussion 清单中，无 hold 者随行封存、带 hold 者留在途。
    let store = TestStore::with_meta(
        "cut",
        "schema: spec-driven\ncreated: 2026-07-01\nfrom_discussion: d1, staged\n",
    );
    store.put_artifact("cut", "tasks.md", "- [x] 1.1 done\n");
    store.discussions.borrow_mut().insert("d1".into(), discussion_doc("d1"));
    store.discussions.borrow_mut().insert(
        "staged".into(),
        "---\ntopic: staged\nslug: staged\nstatus: promoted\npromoted_to: cut\ncreated: 2026-07-01\nhold: true\n---\n\n## Conclusion\n\n**Decision**: cut-b later\n".into(),
    );
    let change = crate::model::find_change(&store, "cut").unwrap();

    let outcome = archive(&ghost_ws(), &store, &change, &skip_opts(), None).unwrap();

    let slugs: Vec<&str> =
        outcome.archived_discussions.iter().map(|(s, _)| s.as_str()).collect();
    assert_eq!(slugs, vec!["d1"], "only the unheld discussion co-archives");
    assert!(store.archived_discussion_exists("d1"));
    assert!(store.live_discussion_exists("staged"), "held sibling stays live");
    assert!(!store.archived_discussion_exists("staged"));
}

#[test]
fn archive_single_source_discussion_co_travels_as_before() {
    // 单一来源情境：与变更前一致——恰一份讨论随行封存。
    let store = TestStore::with_meta(
        "cut",
        "schema: spec-driven\ncreated: 2026-07-01\nfrom_discussion: only\n",
    );
    store.put_artifact("cut", "tasks.md", "- [x] 1.1 done\n");
    store.discussions.borrow_mut().insert("only".into(), discussion_doc("only"));
    let change = crate::model::find_change(&store, "cut").unwrap();

    let outcome = archive(&ghost_ws(), &store, &change, &skip_opts(), None).unwrap();

    let slugs: Vec<&str> =
        outcome.archived_discussions.iter().map(|(s, _)| s.as_str()).collect();
    assert_eq!(slugs, vec!["only"]);
    assert!(store.archived_discussion_exists("only"));
}

#[test]
fn archive_leaves_discussion_live_when_an_in_flight_meta_is_corrupt() {
    // spec discussion-docs Example「坏 meta 的在途变更挡住随行封存」：d1 已结论、无 hold；
    // cut 的 meta 含 from_discussion: d1、tasks 全完成；另一在途变更 broken 的
    // .openspec.yaml 为 `schema: [unclosed`（解析失败）→ cut 照常封存、d1 留在途。
    // 坏 meta 视同仍引用（与 conclude 闭环步同一条规则）。
    let store = TestStore::with_meta(
        "cut",
        "schema: spec-driven\ncreated: 2026-07-01\nfrom_discussion: d1\n",
    );
    store.put_artifact("cut", "tasks.md", "- [x] 1.1 done\n");
    store.metas.borrow_mut().insert("broken".into(), "schema: [unclosed\n".into());
    store.discussions.borrow_mut().insert("d1".into(), discussion_doc("d1"));
    let change = crate::model::find_change(&store, "cut").unwrap();

    let outcome = archive(&ghost_ws(), &store, &change, &skip_opts(), None).unwrap();

    assert!(!store.change_exists("cut"), "cut 移入封存区");
    assert!(
        outcome.archived_discussions.is_empty(),
        "corrupt in-flight meta counts as a live reference — no co-archive"
    );
    assert!(store.live_discussion_exists("d1"), "d1 stays live");
    assert!(!store.archived_discussion_exists("d1"));
}

// --- 单笔封存任务完成度守门（design D1；spec change-lifecycle「单笔封存的任务完成度守门」）---

fn gate_store(tasks_md: &str) -> TestStore {
    let store = TestStore::with_meta("demo", "schema: spec-driven\ncreated: 2026-07-01\n");
    store.put_artifact("demo", "tasks.md", tasks_md);
    store
}

#[test]
fn incomplete_tasks_refuse_archive_with_evidence_and_zero_writes() {
    // spec Example 守门判定：3 任务仅 1 勾、未带 --mark-tasks-complete → 拒绝，
    // 消息载明 1/3 与两条出路，store 零写入。
    let store = gate_store("- [x] 1.1 a\n- [ ] 1.2 b\n- [ ] 1.3 c\n");
    let change = crate::model::find_change(&store, "demo").unwrap();
    let err = archive(&ghost_ws(), &store, &change, &skip_opts(), None)
        .expect_err("incomplete tasks must refuse archive");
    assert!(err.to_string().contains("1/3"), "evidence N/M in message: {err}");
    assert!(err.to_string().contains("--mark-tasks-complete"), "exit route named: {err}");
    assert!(
        err.downcast_ref::<crate::command::Refusal>().is_some(),
        "typed Refusal so the runtime classifies refused"
    );
    assert!(store.change_exists("demo"), "change stays in place");
    assert!(store.archived_metas.borrow().is_empty(), "nothing archived");
    assert!(store.canonical.borrow().is_empty(), "no canonical spec writes");
    assert_eq!(*store.meta_writes.borrow(), 0, "zero meta writes");
    assert_eq!(*store.artifact_writes.borrow(), 0, "zero artifact writes");
}

#[test]
fn all_tasks_complete_passes_the_gate() {
    // spec Example 守门判定：3/3 → 照常封存。
    let store = gate_store("- [x] 1.1 a\n- [x] 1.2 b\n- [x] 1.3 c\n");
    let change = crate::model::find_change(&store, "demo").unwrap();
    let outcome = archive(&ghost_ws(), &store, &change, &skip_opts(), None).unwrap();
    assert!(!store.change_exists("demo"), "change moved into the archive");
    assert!(store.archived_change_exists(&outcome.dated_name));
}

#[test]
fn zero_tasks_passes_the_gate() {
    // spec Example 守门判定：任务总数 0 → 照常封存（条件与批量预过滤一致：总数>0 才挡）。
    let store = gate_store("## Tasks\n\n(none)\n");
    let change = crate::model::find_change(&store, "demo").unwrap();
    archive(&ghost_ws(), &store, &change, &skip_opts(), None).unwrap();
    assert!(!store.change_exists("demo"), "zero-task change archives as before");
}

#[test]
fn mark_tasks_complete_flag_checks_every_task_inside_archive() {
    // design D1：豁免＝旗标本身，代勾也在 archive() 内——直呼入口（desktop）
    // 带旗标时与 CLI 同语意：封存成功，且封存后的 tasks.md 全部已勾。
    let store = gate_store("- [x] 1.1 a\n- [ ] 1.2 b\n- [ ] 1.3 c\n");
    let change = crate::model::find_change(&store, "demo").unwrap();
    let opts = ArchiveOptions { mark_tasks_complete: true, ..skip_opts() };
    let outcome = archive(&ghost_ws(), &store, &change, &opts, None).unwrap();
    assert!(!store.change_exists("demo"), "flag exempts the gate");
    assert_eq!(
        store.read_archived_artifact(&outcome.dated_name, "tasks.md").as_deref(),
        Some("- [x] 1.1 a\n- [x] 1.2 b\n- [x] 1.3 c\n"),
        "archive() itself checks every task before the move"
    );
}

const UNCHECKED_TASKS: &str = "- [x] 1.1 a\n- [ ] 1.2 b\n* [ ] 1.3 c\n- [ ]\t1.4 d\n";

#[test]
fn mark_tasks_complete_leaves_tasks_untouched_when_validation_refuses() {
    // design D1（spec archive-merge「两阶段合并计划与零半套写入」）：结构 validate
    // 拒绝（delta 档存在但零操作——结构检查对缺 proposal 宽松放行，这是它的硬错误）
    // 落在代勾之前，tasks.md 逐比特不变、零 artifact 写入。
    let store = gate_store(UNCHECKED_TASKS);
    store.put_artifact("demo", "specs/auth/spec.md", "## ADDED Requirements\n");
    let change = crate::model::find_change(&store, "demo").unwrap();
    // CLI `specseal archive <name> --mark-tasks-complete` 的形状：validate 与 spec 合并都开。
    let opts = ArchiveOptions { mark_tasks_complete: true, ..apply_opts_validating() };
    let err = archive(&ghost_ws(), &store, &change, &opts, None)
        .expect_err("a structurally invalid change must refuse archive");
    assert!(err.to_string().contains("Validation failed"), "frozen wording: {err}");
    assert!(store.change_exists("demo"), "change stays in place");
    assert_eq!(
        store.read_artifact("demo", "tasks.md").as_deref(),
        Some(UNCHECKED_TASKS),
        "tasks.md byte-for-byte untouched"
    );
    assert_eq!(*store.artifact_writes.borrow(), 0, "zero artifact writes");
}

#[test]
fn mark_tasks_complete_leaves_tasks_untouched_when_the_dated_name_collides() {
    // design D1：同日撞名拒绝也落在代勾之前——tasks.md 逐比特不变。
    let store = gate_store(UNCHECKED_TASKS);
    // archive() 自取一次日期；测试跨午夜时只放今天会撞不到，今天与明天都放。
    let today = chrono::NaiveDate::parse_from_str(&util::now_stamps().date, "%Y-%m-%d")
        .expect("now_stamps date is YYYY-MM-DD");
    for date in [today, today.succ_opt().expect("tomorrow exists")] {
        store
            .archived_metas
            .borrow_mut()
            .insert(format!("{date}-demo"), "schema: spec-driven\n".to_string());
    }
    let change = crate::model::find_change(&store, "demo").unwrap();
    let opts = ArchiveOptions { mark_tasks_complete: true, ..skip_opts() };
    let err = archive(&ghost_ws(), &store, &change, &opts, None)
        .expect_err("a same-day name collision must refuse archive");
    assert!(err.to_string().contains("already exists"), "frozen wording: {err}");
    assert!(store.change_exists("demo"), "change stays in place");
    assert_eq!(
        store.read_artifact("demo", "tasks.md").as_deref(),
        Some(UNCHECKED_TASKS),
        "tasks.md byte-for-byte untouched"
    );
    assert_eq!(*store.artifact_writes.borrow(), 0, "zero artifact writes");
}

#[test]
fn mark_tasks_complete_checks_star_bullets_and_tab_checkboxes() {
    // design D1：四条 replace 的冻结规则随代勾搬进 archive()——星号条列与
    // tab 分隔的 checkbox 同样被勾，全部守门通过时封存成功。
    let store = gate_store(UNCHECKED_TASKS);
    let change = crate::model::find_change(&store, "demo").unwrap();
    let opts = ArchiveOptions { mark_tasks_complete: true, ..skip_opts() };
    let outcome = archive(&ghost_ws(), &store, &change, &opts, None).unwrap();
    assert!(!store.change_exists("demo"), "change moved into the archive");
    assert_eq!(
        store.read_archived_artifact(&outcome.dated_name, "tasks.md").as_deref(),
        Some("- [x] 1.1 a\n- [x] 1.2 b\n* [x] 1.3 c\n- [x]\t1.4 d\n"),
        "every checkbox form is checked in the archived tasks.md"
    );
}

// --- 封存的未结工单守门（design D5；spec review-station「封存的未结工单守门」）---

const TICKET: &str = "# Review — demo\n\n## Round 1\n\n**Scope**: src/a.rs\n\n- [WARNING] src/a.rs — possible smell\n";

#[test]
fn open_review_ticket_refuses_archive_with_three_disposals() {
    // spec Scenario「有工单缺省拒绝」：stderr 同列 stamp／discard／--carry-review
    // 三处置，change 未被搬移、零写入。
    let store = gate_store("- [x] 1.1 a\n");
    store.put_artifact("demo", crate::station::REVIEW_DOC, TICKET);
    let change = crate::model::find_change(&store, "demo").unwrap();
    let err = archive(&ghost_ws(), &store, &change, &skip_opts(), None)
        .expect_err("open ticket must refuse archive");
    let msg = err.to_string();
    assert!(msg.contains("review stamp"), "stamp disposal named: {msg}");
    assert!(msg.contains("review discard"), "discard disposal named: {msg}");
    assert!(msg.contains("--carry-review"), "carry disposal named: {msg}");
    assert!(
        err.downcast_ref::<crate::command::Refusal>().is_some(),
        "typed Refusal so the runtime classifies refused"
    );
    assert!(store.change_exists("demo"), "change stays in place");
    assert!(store.archived_metas.borrow().is_empty(), "nothing archived");
    assert_eq!(*store.meta_writes.borrow(), 0, "zero meta writes");
    assert_eq!(*store.artifact_writes.borrow(), 0, "zero artifact writes");
}

#[test]
fn carry_review_archives_and_the_ticket_travels() {
    // spec Scenario「明示带走」：--carry-review 放行，封存目录内含 review.md
    //（化石工单——封存侧「曾审查未通过」标示的证据）。
    let store = gate_store("- [x] 1.1 a\n");
    store.put_artifact("demo", crate::station::REVIEW_DOC, TICKET);
    let change = crate::model::find_change(&store, "demo").unwrap();
    let opts = ArchiveOptions { carry_review: true, ..skip_opts() };
    let outcome = archive(&ghost_ws(), &store, &change, &opts, None).unwrap();
    assert!(!store.change_exists("demo"), "change moved into the archive");
    assert_eq!(
        store.read_archived_artifact(&outcome.dated_name, crate::station::REVIEW_DOC).as_deref(),
        Some(TICKET),
        "ticket rides the directory move byte-identically"
    );
}

#[test]
fn archive_without_ticket_is_unaffected_by_the_gate() {
    // spec Scenario「无工单行为不变」：本档其余测试全数无工单、即回归网；
    // 此处钉住 carry_review 缺省 false 下无工单照常封存、封存区无工单档。
    let store = gate_store("- [x] 1.1 a\n");
    let change = crate::model::find_change(&store, "demo").unwrap();
    let outcome = archive(&ghost_ws(), &store, &change, &skip_opts(), None).unwrap();
    assert!(!store.change_exists("demo"), "change moved into the archive");
    assert!(
        store.read_archived_artifact(&outcome.dated_name, crate::station::REVIEW_DOC).is_none(),
        "no fossil ticket appears out of nowhere"
    );
}

// --- 封存的验证工单守门与双工单并存（design D4；spec verify-station）---

const VERIFY_TICKET: &str = "# Verify — demo\n\n## Round 1\n\n**Scope**: src/a.rs\n\n- [CRITICAL] src/a.rs — requirement R2 has no implementation\n";

#[test]
fn open_verify_ticket_refuses_archive_with_three_disposals() {
    // spec Scenario「仅验证工单时拒绝」：stderr 同列 stamp／discard／--carry-verify
    // 三处置，change 未被搬移、零写入。
    let store = gate_store("- [x] 1.1 a\n");
    store.put_artifact("demo", crate::station::VERIFY_DOC, VERIFY_TICKET);
    let change = crate::model::find_change(&store, "demo").unwrap();
    let err = archive(&ghost_ws(), &store, &change, &skip_opts(), None)
        .expect_err("open verify ticket must refuse archive");
    let msg = err.to_string();
    assert!(msg.contains("verify stamp"), "stamp disposal named: {msg}");
    assert!(msg.contains("verify discard"), "discard disposal named: {msg}");
    assert!(msg.contains("--carry-verify"), "carry disposal named: {msg}");
    assert!(
        err.downcast_ref::<crate::command::Refusal>().is_some(),
        "typed Refusal so the runtime classifies refused"
    );
    assert!(store.change_exists("demo"), "change stays in place");
    assert!(store.archived_metas.borrow().is_empty(), "nothing archived");
    assert_eq!(*store.meta_writes.borrow(), 0, "zero meta writes");
    assert_eq!(*store.artifact_writes.borrow(), 0, "zero artifact writes");
}

#[test]
fn both_open_tickets_list_both_disposal_groups() {
    // spec Scenario「双工单并存」：两站处置并列——只报一站会让用户处理完
    // 一张工单再撞一次同样的墙。
    let store = gate_store("- [x] 1.1 a\n");
    store.put_artifact("demo", crate::station::REVIEW_DOC, TICKET);
    store.put_artifact("demo", crate::station::VERIFY_DOC, VERIFY_TICKET);
    let change = crate::model::find_change(&store, "demo").unwrap();
    let err = archive(&ghost_ws(), &store, &change, &skip_opts(), None)
        .expect_err("two open tickets must refuse archive");
    let msg = err.to_string();
    for needle in [
        "review stamp",
        "review discard",
        "--carry-review",
        "verify stamp",
        "verify discard",
        "--carry-verify",
    ] {
        assert!(msg.contains(needle), "both disposal groups listed, missing {needle}: {msg}");
    }
    assert!(store.change_exists("demo"), "change stays in place");
}

#[test]
fn carry_verify_archives_and_the_ticket_travels() {
    // spec Scenario「明示带走验证工单」：--carry-verify 放行，封存目录内含
    // verify.md（化石工单——封存侧「曾验证未通过」标示的证据）。
    let store = gate_store("- [x] 1.1 a\n");
    store.put_artifact("demo", crate::station::VERIFY_DOC, VERIFY_TICKET);
    let change = crate::model::find_change(&store, "demo").unwrap();
    let opts = ArchiveOptions { carry_verify: true, ..skip_opts() };
    let outcome = archive(&ghost_ws(), &store, &change, &opts, None).unwrap();
    assert!(!store.change_exists("demo"), "change moved into the archive");
    assert_eq!(
        store.read_archived_artifact(&outcome.dated_name, crate::station::VERIFY_DOC).as_deref(),
        Some(VERIFY_TICKET),
        "ticket rides the directory move byte-identically"
    );
}

#[test]
fn the_two_carry_flags_are_independent_and_combine() {
    // spec「`--carry-review` 与 `--carry-verify` 可同时带」：单带一支仍被
    // 另一站挡下（带走哪种工单是两个独立决定），两支齐带才放行。
    let one_flag_still_refuses = |carry_review: bool, carry_verify: bool, expect: &str| {
        let store = gate_store("- [x] 1.1 a\n");
        store.put_artifact("demo", crate::station::REVIEW_DOC, TICKET);
        store.put_artifact("demo", crate::station::VERIFY_DOC, VERIFY_TICKET);
        let change = crate::model::find_change(&store, "demo").unwrap();
        let opts = ArchiveOptions { carry_review, carry_verify, ..skip_opts() };
        let err = archive(&ghost_ws(), &store, &change, &opts, None)
            .expect_err("the other station's ticket must still refuse");
        assert!(err.to_string().contains(expect), "names the remaining station: {err}");
    };
    one_flag_still_refuses(true, false, "--carry-verify");
    one_flag_still_refuses(false, true, "--carry-review");

    let store = gate_store("- [x] 1.1 a\n");
    store.put_artifact("demo", crate::station::REVIEW_DOC, TICKET);
    store.put_artifact("demo", crate::station::VERIFY_DOC, VERIFY_TICKET);
    let change = crate::model::find_change(&store, "demo").unwrap();
    let opts = ArchiveOptions { carry_review: true, carry_verify: true, ..skip_opts() };
    let outcome = archive(&ghost_ws(), &store, &change, &opts, None).unwrap();
    assert!(!store.change_exists("demo"), "both flags archive the change");
    assert!(store
        .read_archived_artifact(&outcome.dated_name, crate::station::REVIEW_DOC)
        .is_some());
    assert!(store
        .read_archived_artifact(&outcome.dated_name, crate::station::VERIFY_DOC)
        .is_some());
}

#[test]
fn archive_without_a_verify_ticket_is_unaffected_by_the_gate() {
    // spec「皆无工单时 archive 行为 SHALL 维持不变」的回归断言：本档其余测试
    // 全数无工单即回归网；此处钉住封存区不会凭空长出 verify.md。
    let store = gate_store("- [x] 1.1 a\n");
    let change = crate::model::find_change(&store, "demo").unwrap();
    let outcome = archive(&ghost_ws(), &store, &change, &skip_opts(), None).unwrap();
    assert!(!store.change_exists("demo"), "change moved into the archive");
    assert!(
        store.read_archived_artifact(&outcome.dated_name, crate::station::VERIFY_DOC).is_none(),
        "no fossil ticket appears out of nowhere"
    );
}

// --- archive trace 由 evidence 创建（spec verify-evidence）---

/// 新开 capability 的 delta：Purpose 守门（design D3）要求它自带合格 Purpose，
/// 否则封存被拒——这里带着，让测试专注在 trace 与 evidence 面。
const DELTA_SPEC: &str = "## Purpose\n\n本 capability 负责身分验证的签发与撤销，涵盖权杖生命周期各阶段的可观察行为、失败处置与稽核纪录。\n\n## ADDED Requirements\n\n### Requirement: R1\n\nIt SHALL work.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n";

fn temp_root(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir()
        .join(format!("specseal-archive-trace-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn trace_store() -> TestStore {
    let store = TestStore::with_meta("demo", "schema: spec-driven\ncreated: 2026-07-01\n");
    store.put_artifact("demo", "tasks.md", "- [x] 1.1 done\n");
    store.put_artifact("demo", "specs/auth/spec.md", DELTA_SPEC);
    store
}

fn apply_opts() -> ArchiveOptions {
    ArchiveOptions { skip_specs: false, ..skip_opts() }
}

/// bulk 与 CLI 单笔的缺省旗标形状：validate 与 spec 合并都开、不代勾。
fn apply_opts_validating() -> ArchiveOptions {
    ArchiveOptions { no_validate: false, ..apply_opts() }
}

/// spec「archive trace 注入与零证据提示」：`updated` 是 RFC 3339 带偏移量的秒级时戳，
/// 其日历日等于封存目录名前缀。回传截取到的时戳。
fn assert_trace_stamp(canon: &str, dated_name: &str) -> String {
    let re = regex::Regex::new(
        r"<!-- @trace\nsource: demo\nupdated: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2})\n-->",
    )
    .unwrap();
    let caps = re.captures(canon).unwrap_or_else(|| panic!("trace block is exactly source + RFC 3339 updated: {canon}"));
    let stamp = caps[1].to_string();
    assert_eq!(&stamp[..10], &dated_name[..10], "stamp day equals the dated directory prefix");
    stamp
}

/// A workspace whose root exists on disk, so evidence can be written under it.
struct TraceWs {
    ws: Workspace,
}

impl TraceWs {
    fn new(tag: &str) -> TraceWs {
        TraceWs {
            ws: Workspace { root: temp_root(tag), spec_dir_name: "openspec".to_string() },
        }
    }

    /// Record one v2 evidence entry for "demo" — the record's mere presence
    /// is all archive reads now.
    fn record_evidence(&self, store: &TestStore) {
        let record = TouchedRecord {
            version: Some(2),
            change: "demo".to_string(),
            touched: Vec::new(),
            entries: vec![crate::tasks::EvidenceEntry {
                task_id: "tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV".to_string(),
                task_desc: "1.1 done".to_string(),
                actor: Some("Tester <t@example.com>".to_string()),
                repo: None,
                head_commit: None,
                touched_files: vec!["src/a.rs".to_string()],
                recorded_at: "2026-07-13T00:00:00Z".to_string(),
            }],
        };
        record.save(store).unwrap();
    }
}

impl Drop for TraceWs {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.ws.root);
    }
}

#[test]
fn trace_carries_only_source_and_updated_on_a_fresh_canonical() {
    // spec Scenario「trace 两栏一律注入」：ADDED 物化到新正典，trace 仅两栏、无 code 清单。
    let t = TraceWs::new("fresh");
    let store = trace_store();
    t.record_evidence(&store);
    let change = crate::model::find_change(&store, "demo").unwrap();
    let outcome = archive(&t.ws, &store, &change, &apply_opts(), None).unwrap();

    assert!(outcome.evidence_recorded, "a change with a v2 entry reports evidence recorded");
    let canon = store.read_canonical_spec("auth").unwrap();
    assert_trace_stamp(&canon, &outcome.dated_name);
    assert!(!canon.contains("code:"), "no file list may survive: {canon}");
    assert!(!canon.contains("  - src/a.rs"), "no file list may survive: {canon}");
}

#[test]
fn trace_is_injected_for_modified_even_with_a_clean_work_tree() {
    // spec Scenario「trace 两栏一律注入」：注入不再依文件清单有无决定——
    // 干净工作树、无任何脏档的 MODIFIED 一样拿到 trace。
    let t = TraceWs::new("modified");
    let store = TestStore::with_meta("demo", "schema: spec-driven\ncreated: 2026-07-01\n");
    store.put_artifact("demo", "tasks.md", "- [x] 1.1 done\n");
    store.put_artifact(
        "demo",
        "specs/auth/spec.md",
        "## MODIFIED Requirements\n\n### Requirement: R1\n\nIt SHALL work harder.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n",
    );
    store.canonical.borrow_mut().insert("auth".to_string(), CANON_R1.to_string());
    t.record_evidence(&store);
    let change = crate::model::find_change(&store, "demo").unwrap();
    archive(&t.ws, &store, &change, &apply_opts(), None).unwrap();

    let canon = store.read_canonical_spec("auth").unwrap();
    assert!(canon.contains("<!-- @trace"), "MODIFIED gets a trace block: {canon}");
    assert!(canon.contains("source: demo"), "{canon}");
    assert!(!canon.contains("code:"), "no file list may survive: {canon}");
}

#[test]
fn modified_leaves_other_requirements_date_only_trace_untouched() {
    // spec Scenario「既有纯日期 trace 不回改」：只有被物化的需求拿到新时戳，
    // 正典内其他需求的纯日期 updated 行逐比特不变。
    let t = TraceWs::new("keep-dates");
    let store = TestStore::with_meta("demo", "schema: spec-driven\ncreated: 2026-07-01\n");
    store.put_artifact("demo", "tasks.md", "- [x] 1.1 done\n");
    store.put_artifact(
        "demo",
        "specs/auth/spec.md",
        "## MODIFIED Requirements\n\n### Requirement: R1\n\nIt SHALL work harder.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n",
    );
    let r2_trace = "<!-- @trace\nsource: older\nupdated: 2026-07-10\n-->";
    let canon_before = format!("{CANON_R1_R2}\n{r2_trace}\n");
    store.canonical.borrow_mut().insert("auth".to_string(), canon_before);
    t.record_evidence(&store);
    let change = crate::model::find_change(&store, "demo").unwrap();
    let outcome = archive(&t.ws, &store, &change, &apply_opts(), None).unwrap();

    let canon = store.read_canonical_spec("auth").unwrap();
    assert_trace_stamp(&canon, &outcome.dated_name);
    assert!(canon.contains(r2_trace), "R2's date-only trace survives byte-for-byte: {canon}");
    assert_eq!(canon.matches("updated: ").count(), 2, "one stamp per requirement: {canon}");
}

#[test]
fn a_change_without_evidence_archives_and_reports_it() {
    // spec Scenario「零证据照常封存并提示」的引擎面：无任何 v2 entry 不再是拒绝
    // 理由——封存照常完成，outcome 带着「没有证据」这个事实供 CLI 呈现。
    let t = TraceWs::new("no-evidence");
    let store = trace_store();
    let change = crate::model::find_change(&store, "demo").unwrap();
    let outcome = archive(&t.ws, &store, &change, &apply_opts(), None).unwrap();

    assert!(!outcome.evidence_recorded, "zero entries is reported, not refused");
    assert!(!store.change_exists("demo"), "the change still archives");
    let canon = store.read_canonical_spec("auth").unwrap();
    assert_trace_stamp(&canon, &outcome.dated_name);
}

#[test]
fn evidence_content_never_blocks_the_archive() {
    // 讨论 evidence-gate-false-blocks：记录的内容（含前版写入的 basis digests）
    // 不再被判读——只要记录在，封存就通过,连「过期」这个概念都不存在了。
    let t = TraceWs::new("stale-shaped");
    let store = trace_store();
    // 前一版格式：带 basisDigests 且必然对不上当前基准。
    store.put_evidence(
        "demo",
        r#"{"version":2,"change":"demo","entries":[{"taskId":"tsk_LEGACY","taskDesc":"1.1 done","touchedFiles":["src/a.rs"],"basisDigests":{"spec":"sha256:0","tasks":"sha256:0","policy":"sha256:0"},"recordedAt":"2026-07-13T00:00:00Z"}]}"#,
    );
    let change = crate::model::find_change(&store, "demo").unwrap();
    let outcome = archive(&t.ws, &store, &change, &apply_opts(), None).unwrap();

    assert!(outcome.evidence_recorded, "the entry counts however its basis reads");
    assert!(!store.change_exists("demo"), "no staleness judgment stands in the way");
}

#[test]
fn archive_sweeps_the_legacy_touched_record_with_the_change() {
    // 旧路径残档不得比 change 活得久：留着的话，同名新 change 的第一次 load
    // 会把死帐读成活帐（seen 污染、零证据提示被吞）。封存比照 `.started`
    // 标记顺手带走。evidence_recorded 的事实经 Store seam 读取（旧路径内容
    // 「仍算这个 change 的事实」由 specseal-fs 的回退读取测试钉住）。
    let t = TraceWs::new("legacy-sweep");
    let store = trace_store();
    store.put_evidence(
        "demo",
        r#"{"version":2,"change":"demo","entries":[{"taskId":"tsk_LEGACY","taskDesc":"1.1 done","touchedFiles":["src/a.rs"],"recordedAt":"2026-07-13T00:00:00Z"}]}"#,
    );
    let legacy = t.ws.legacy_touched_file("demo");
    util::write_file(&legacy, "{\"change\":\"demo\",\"touched\":[]}").unwrap();
    let change = crate::model::find_change(&store, "demo").unwrap();
    let outcome = archive(&t.ws, &store, &change, &apply_opts(), None).unwrap();

    assert!(outcome.evidence_recorded, "the seam-read record still counts as this change's fact");
    assert!(!legacy.exists(), "the legacy touched record dies with the change");
}

#[test]
fn a_pure_removed_merge_keeps_the_trailing_newline() {
    // 纯 REMOVED（或纯 RENAMED）的合并不注入任何 @trace——这种输出维持文本档
    // 的结尾换行；以 `-->` 收尾者除外（不论来自本轮注入或前次封存的残尾，
    // 见下一测试），冻结为无结尾换行的形状。
    let t = TraceWs::new("removed-newline");
    let store = TestStore::with_meta("demo", "schema: spec-driven\ncreated: 2026-07-01\n");
    store.put_artifact("demo", "tasks.md", "- [x] 1.1 done\n");
    store.put_artifact(
        "demo",
        "specs/auth/spec.md",
        "## REMOVED Requirements\n\n### Requirement: R1\n\n**Reason**: retired.\n**Migration**: none.\n",
    );
    store.canonical.borrow_mut().insert("auth".to_string(), CANON_R1_R2.to_string());
    let change = crate::model::find_change(&store, "demo").unwrap();
    archive(&t.ws, &store, &change, &apply_opts(), None).unwrap();

    let canon = store.read_canonical_spec("auth").unwrap();
    assert!(!canon.contains("@trace"), "a pure REMOVED merge injects nothing: {canon}");
    assert!(
        canon.ends_with('\n') && !canon.ends_with("\n\n"),
        "a trace-less merge ends with exactly one trailing newline: {:?}",
        &canon[canon.len().saturating_sub(20)..]
    );
}

#[test]
fn a_trace_tailed_canon_keeps_its_frozen_tail_through_a_pure_removed_merge() {
    // 补结尾换行的规则有一道例外，与 fresh 路径同规则：末块以先前封存注入的
    // `-->` 收尾的正典维持冻结形状——`-->` 之后永不补换行。
    let t = TraceWs::new("trace-tail");
    let store = TestStore::with_meta("demo", "schema: spec-driven\ncreated: 2026-07-01\n");
    store.put_artifact("demo", "tasks.md", "- [x] 1.1 done\n");
    store.put_artifact(
        "demo",
        "specs/auth/spec.md",
        "## REMOVED Requirements\n\n### Requirement: R1\n\n**Reason**: retired.\n**Migration**: none.\n",
    );
    let traced_tail_canon = format!(
        "{}\n\n<!-- @trace\nsource: earlier\nupdated: 2026-07-01\n-->",
        CANON_R1_R2.trim_end()
    );
    store.canonical.borrow_mut().insert("auth".to_string(), traced_tail_canon);
    let change = crate::model::find_change(&store, "demo").unwrap();
    archive(&t.ws, &store, &change, &apply_opts(), None).unwrap();

    let canon = store.read_canonical_spec("auth").unwrap();
    assert!(
        canon.ends_with("-->"),
        "no newline may ever follow a trailing `-->`: {:?}",
        &canon[canon.len().saturating_sub(20)..]
    );
}

// --- 封存合并 fail-closed 守门（design「违规清单与聚合错误形状」；
//     spec archive-merge「封存合并 fail-closed 守门」）---

const CANON_R1: &str = "# auth Specification\n\n## Purpose\n\nAuth.\n\n## Requirements\n\n### Requirement: R1\n\nIt SHALL work.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n";
const CANON_R1_R2: &str = "# auth Specification\n\n## Purpose\n\nAuth.\n\n## Requirements\n\n### Requirement: R1\n\nIt SHALL work.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n\n---\n\n### Requirement: R2\n\nIt SHALL also work.\n\n#### Scenario: fine\n\n- **WHEN** used\n- **THEN** fine\n";
const ADDED_R1: &str = "## ADDED Requirements\n\n### Requirement: R1\n\nIt SHALL work.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n";

/// 一份可封存的 change（任务全勾、无工单），delta 与正典由调用端指定。
fn merge_store(deltas: &[(&str, &str)], canon: &[(&str, &str)]) -> TestStore {
    let store = TestStore::with_meta("demo", "schema: spec-driven\ncreated: 2026-07-01\n");
    store.put_artifact("demo", "tasks.md", "- [x] 1.1 done\n");
    for (cap, text) in deltas {
        store.put_artifact("demo", &crate::model::delta_spec_artifact(cap), text);
    }
    for (cap, text) in canon {
        store.canonical.borrow_mut().insert((*cap).to_string(), (*text).to_string());
    }
    store
}

/// 封存必须被守门拒绝：typed Refusal、正典与 change 零效果，回传错误消息供逐条断言。
fn refuse_merge(store: &TestStore) -> String {
    let before = store.canonical.borrow().clone();
    let change = crate::model::find_change(store, "demo").unwrap();
    let err = archive(&ghost_ws(), store, &change, &apply_opts(), None)
        .expect_err("a violating delta must refuse archive");
    assert!(
        err.downcast_ref::<crate::command::Refusal>().is_some(),
        "typed Refusal so the runtime classifies refused: {err}"
    );
    assert!(store.change_exists("demo"), "change stays in place");
    assert!(store.archived_metas.borrow().is_empty(), "nothing archived");
    assert_eq!(*store.canonical.borrow(), before, "canonical specs untouched");
    err.to_string()
}

// --- bulk 预检的唯读投影（design D4；spec archive-merge「过期判定单源共用」）---

/// 过期 delta（ADDED 撞正典）＋结构不合法（零操作 delta）＋任务未完成（1/2）
/// 三条同时成立的 change。
fn triple_skip_store() -> TestStore {
    let store = merge_store(&[("auth", ADDED_R1), ("bad", "## ADDED Requirements\n")], &[("auth", CANON_R1)]);
    store.put_artifact("demo", "tasks.md", "- [x] 1.1 a\n- [ ] 1.2 b\n");
    store
}

#[test]
fn skip_reason_picks_merge_then_validate_then_tasks_in_bulk_order() {
    // 判定顺序是 bulk 的冻结输出契约（merge → validate → tasks），不是 archive() 的守门序：
    // 三条同时成立时回 merge；每豁免一条，下一条浮上来。调用过程零写入。
    let store = triple_skip_store();
    let change = crate::model::find_change(&store, "demo").unwrap();

    let reason = skip_reason(&store, &change, &apply_opts_validating());
    assert!(
        matches!(&reason, Some(SkipReason::MergeRefused(vs)) if !vs.is_empty()),
        "merge comes first: {reason:?}"
    );

    let opts = ArchiveOptions { skip_specs: true, ..apply_opts_validating() };
    let reason = skip_reason(&store, &change, &opts);
    assert!(
        matches!(reason, Some(SkipReason::StructuralInvalid)),
        "--skip-specs drops merge, validate is next: {reason:?}"
    );

    let opts = ArchiveOptions { skip_specs: true, no_validate: true, ..apply_opts_validating() };
    let reason = skip_reason(&store, &change, &opts);
    assert!(
        matches!(reason, Some(SkipReason::TasksIncomplete { complete: 1, total: 2 })),
        "--no-validate drops validate, tasks is last: {reason:?}"
    );

    assert_eq!(*store.meta_writes.borrow(), 0, "zero meta writes");
    assert_eq!(*store.artifact_writes.borrow(), 0, "zero artifact writes");
    assert!(store.change_exists("demo"), "a projection never moves the change");
}

#[test]
fn skip_reason_is_none_when_every_condition_is_exempted() {
    // 三旗标齐带 → 没有可跳过的理由；--mark-tasks-complete 在投影里从不代勾。
    let store = triple_skip_store();
    let change = crate::model::find_change(&store, "demo").unwrap();
    let opts = ArchiveOptions {
        skip_specs: true,
        no_validate: true,
        mark_tasks_complete: true,
        ..apply_opts_validating()
    };
    let reason = skip_reason(&store, &change, &opts);
    assert!(reason.is_none(), "every reason exempted: {reason:?}");
    assert_eq!(*store.artifact_writes.borrow(), 0, "the flag never pre-writes here");
}

#[test]
fn skip_reason_is_none_for_a_ready_change() {
    // 全就绪（delta 对得上正典、结构合法、任务全勾）→ None，bulk 不跳过。
    let store = merge_store(&[("auth", DELTA_SPEC)], &[]);
    let change = crate::model::find_change(&store, "demo").unwrap();
    let reason = skip_reason(&store, &change, &apply_opts_validating());
    assert!(reason.is_none(), "ready change has no skip reason: {reason:?}");
    assert_eq!(*store.artifact_writes.borrow(), 0, "zero artifact writes");
}

// --- 守门序只在 archive() 一份：任务、章失效、结构 validate 皆先于 merge 拒绝 ---

#[test]
fn incomplete_tasks_refuse_before_the_merge_gate() {
    // 任务未完成＋delta 过期 → 任务守门先拒（消息不变），merge 拒绝字符串不出现。
    let store = merge_store(&[("auth", ADDED_R1)], &[("auth", CANON_R1)]);
    store.put_artifact("demo", "tasks.md", "- [ ] 1.1 a\n");
    let change = crate::model::find_change(&store, "demo").unwrap();
    let err = archive(&ghost_ws(), &store, &change, &apply_opts_validating(), None)
        .expect_err("incomplete tasks must refuse");
    let msg = err.to_string();
    assert!(msg.contains("0/1 tasks complete"), "task gate wording: {msg}");
    assert!(!msg.contains("cannot be archived"), "merge refusal never reached: {msg}");
}

#[test]
fn structural_invalidity_refuses_before_the_merge_gate() {
    // 结构不合法＋delta 过期 → `Validation failed:` 先于 merge 拒绝。
    let store = merge_store(
        &[("auth", ADDED_R1), ("bad", "## ADDED Requirements\n")],
        &[("auth", CANON_R1)],
    );
    let change = crate::model::find_change(&store, "demo").unwrap();
    let err = archive(&ghost_ws(), &store, &change, &apply_opts_validating(), None)
        .expect_err("structural invalidity must refuse");
    let msg = err.to_string();
    assert!(msg.contains("Validation failed"), "validate wording: {msg}");
    assert!(!msg.contains("cannot be archived"), "merge refusal never reached: {msg}");
}

#[test]
fn added_requirement_already_in_canon_refuses_archive() {
    // spec Scenario「过期 ADDED 被拒绝」：撞名的 ADDED 不再静默跳过。
    let store = merge_store(&[("auth", ADDED_R1)], &[("auth", CANON_R1)]);
    let msg = refuse_merge(&store);
    assert!(msg.contains("auth"), "capability named: {msg}");
    assert!(msg.contains("ADDED"), "operation named: {msg}");
    assert!(msg.contains("R1"), "requirement named: {msg}");
    assert!(msg.contains("already exists"), "reason given: {msg}");
}

#[test]
fn modified_removed_renamed_missing_target_refuses_archive() {
    // spec Scenario「缺目标的 MODIFIED 被拒绝」：三种操作缺来源需求时一致拒绝。
    for (op, delta) in [
        ("MODIFIED", "## MODIFIED Requirements\n\n### Requirement: Ghost\n\nIt SHALL change.\n"),
        ("REMOVED", "## REMOVED Requirements\n\n### Requirement: Ghost\n"),
        (
            "RENAMED",
            "## RENAMED Requirements\n\n- FROM: `### Requirement: Ghost`\n- TO: `### Requirement: Spirit`\n",
        ),
    ] {
        let store = merge_store(&[("auth", delta)], &[("auth", CANON_R1)]);
        let msg = refuse_merge(&store);
        assert!(msg.contains(op), "operation named ({op}): {msg}");
        assert!(msg.contains("Ghost"), "requirement named ({op}): {msg}");
        assert!(msg.contains("no longer exists"), "reason given ({op}): {msg}");
    }
}

#[test]
fn same_requirement_in_two_operation_sections_refuses_archive() {
    // spec Scenario「多区段互撞被拒绝」：同名需求横跨 MODIFIED 与 REMOVED。
    let delta = "## MODIFIED Requirements\n\n### Requirement: R1\n\nIt SHALL work.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n\n## REMOVED Requirements\n\n### Requirement: R1\n";
    let store = merge_store(&[("auth", delta)], &[("auth", CANON_R1)]);
    let msg = refuse_merge(&store);
    assert!(msg.contains("R1"), "requirement named: {msg}");
    assert!(
        msg.contains("MODIFIED") && msg.contains("REMOVED"),
        "both colliding operations listed: {msg}"
    );
}

#[test]
fn renamed_target_name_already_in_canon_refuses_archive() {
    // spec Scenario「多区段互撞被拒绝」之 RENAMED 目标侧：改名后会撞既有需求。
    let store = merge_store(
        &[(
            "auth",
            "## RENAMED Requirements\n\n- FROM: `### Requirement: R1`\n- TO: `### Requirement: R2`\n",
        )],
        &[("auth", CANON_R1_R2)],
    );
    let msg = refuse_merge(&store);
    assert!(msg.contains("RENAMED"), "operation named: {msg}");
    assert!(msg.contains("R2"), "rename target named: {msg}");
    assert!(msg.contains("already exists"), "reason given: {msg}");
}

#[test]
fn fresh_capability_with_non_added_operation_refuses_archive() {
    // spec Scenario「新 capability 仅接受 ADDED」：正典不存在时 MODIFIED 不再物化成新规格。
    let store = merge_store(
        &[("fresh", "## MODIFIED Requirements\n\n### Requirement: R1\n\nIt SHALL change.\n")],
        &[],
    );
    let msg = refuse_merge(&store);
    assert!(msg.contains("fresh"), "capability named: {msg}");
    assert!(msg.contains("MODIFIED"), "operation named: {msg}");
    assert!(msg.contains("does not exist"), "reason given: {msg}");
    assert!(store.canonical.borrow().is_empty(), "no canonical spec materialized");
}

#[test]
fn every_violation_is_reported_at_once_with_remediation_guidance() {
    // spec Scenario「违规聚合一次回报」：跨 capability 的违规单次列齐，并附 drift → ingest 动线。
    let store = merge_store(
        &[
            ("auth", ADDED_R1),
            ("billing", "## MODIFIED Requirements\n\n### Requirement: Ghost\n\nIt SHALL change.\n"),
        ],
        &[("auth", CANON_R1), ("billing", CANON_R1)],
    );
    let msg = refuse_merge(&store);
    assert!(msg.contains("auth") && msg.contains("R1"), "first violation listed: {msg}");
    assert!(
        msg.contains("billing") && msg.contains("Ghost"),
        "second violation listed in the same report: {msg}"
    );
    assert!(msg.contains("drift"), "drift remediation named: {msg}");
    assert!(msg.contains("ingest"), "ingest remediation named: {msg}");
}

#[test]
fn no_validate_does_not_unlock_the_merge_gate() {
    // spec Scenario「no-validate 不解锁守门」：文档验证略过，合并守门照常拒绝。
    let store = merge_store(&[("auth", ADDED_R1)], &[("auth", CANON_R1)]);
    let change = crate::model::find_change(&store, "demo").unwrap();
    let opts = ArchiveOptions { skip_specs: false, no_validate: true, ..skip_opts() };
    let err = archive(&ghost_ws(), &store, &change, &opts, None)
        .expect_err("--no-validate must not unlock the merge gate");
    assert!(err.to_string().contains("already exists"), "gate still speaks: {err}");
}

#[test]
fn skip_specs_bypasses_the_merge_gate_as_before() {
    // 既有逃生口：--skip-specs 整段跳过规格套用，守门自然不触发。
    let store = merge_store(&[("auth", ADDED_R1)], &[("auth", CANON_R1)]);
    let change = crate::model::find_change(&store, "demo").unwrap();
    archive(&ghost_ws(), &store, &change, &skip_opts(), None)
        .expect("--skip-specs keeps its existing escape-hatch semantics");
    assert!(!store.change_exists("demo"), "change moved into the archive");
    assert_eq!(
        store.read_canonical_spec("auth").as_deref(),
        Some(CANON_R1),
        "canonical spec untouched when spec application is skipped"
    );
}

// --- 两阶段合并计划与零半套写入（design「两阶段合并」；
//     spec archive-merge「两阶段合并计划与零半套写入」）---

#[test]
fn one_violating_capability_leaves_every_capability_untouched() {
    // spec Scenario「任一 capability 违规则全部不写」：双 capability 其一合法、
    // 其一违规 → 两正典皆未变、无 snapshot 落地、change 仍在进行区原位。
    let root = temp_root("two-phase");
    let ws = Workspace { root: root.clone(), spec_dir_name: "openspec".to_string() };
    let store = merge_store(
        &[
            ("auth", "## ADDED Requirements\n\n### Requirement: Brand new\n\nIt SHALL work.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n"),
            ("billing", ADDED_R1),
        ],
        &[("auth", CANON_R1), ("billing", CANON_R1)],
    );
    let before = store.canonical.borrow().clone();
    let change = crate::model::find_change(&store, "demo").unwrap();

    let err = archive(&ws, &store, &change, &apply_opts(), None)
        .expect_err("a single violating capability refuses the whole archive");

    assert!(err.to_string().contains("billing"), "the violating capability is named: {err}");
    assert_eq!(*store.canonical.borrow(), before, "no canonical spec was written");
    assert!(store.change_exists("demo"), "change stays in the active area");
    assert!(store.archived_metas.borrow().is_empty(), "nothing archived");
    assert!(
        !ws.snapshots_dir().exists(),
        "zero file effect: no snapshot directory was created"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn all_snapshots_land_before_any_canonical_write() {
    // spec Scenario「snapshot 先于正式规格写入」：对第一个 capability 的正式规格写入注入
    // 失败；顺序正确时第二个 capability 的 snapshot 已在磁盘上（交错写入则不会）。
    let root = temp_root("write-order");
    let ws = Workspace { root: root.clone(), spec_dir_name: "openspec".to_string() };
    let store = merge_store(
        &[
            ("auth", "## ADDED Requirements\n\n### Requirement: Fresh A\n\nIt SHALL work.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n"),
            ("billing", "## ADDED Requirements\n\n### Requirement: Fresh B\n\nIt SHALL work.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n"),
        ],
        &[("auth", CANON_R1), ("billing", CANON_R1)],
    );
    *store.fail_canonical_write.borrow_mut() = Some("auth".to_string());
    let change = crate::model::find_change(&store, "demo").unwrap();

    let err = archive(&ws, &store, &change, &apply_opts(), None)
        .expect_err("the injected canonical write failure surfaces");
    // design 风险表：commit 阶段失败的错误消息指出 snapshot 位置。
    assert!(
        err.to_string().contains(&ws.snapshots_dir().display().to_string()),
        "the failure names the snapshot location: {err}"
    );

    let dated = format!("{}-demo", util::today());
    for cap in ["auth", "billing"] {
        assert!(
            ws.snapshots_dir().join(&dated).join("specs").join(cap).join("spec.md").is_file(),
            "every snapshot backup lands before the first canonical write ({cap})"
        );
    }
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_local_archive_backs_up_the_spec_it_rewrites() {
    // spec Scenario「本机封存照旧写备份」：有 workspace 时，改写的正式规格先备份成改写前的内容。
    let root = temp_root("local-backup");
    let ws = Workspace { root: root.clone(), spec_dir_name: "openspec".to_string() };
    let added_r2 = "## ADDED Requirements\n\n### Requirement: R2\n\nIt SHALL also work.\n\n#### Scenario: fine\n\n- **WHEN** used\n- **THEN** fine\n";
    let store = merge_store(&[("auth", added_r2)], &[("auth", CANON_R1)]);
    let change = crate::model::find_change(&store, "demo").unwrap();

    let outcome = archive(&ws, &store, &change, &apply_opts(), None).expect("archive");

    assert!(outcome.snapshot_created);
    let backup = ws.snapshots_dir().join(&outcome.dated_name).join("specs").join("auth").join("spec.md");
    assert_eq!(std::fs::read_to_string(&backup).expect("the backup"), CANON_R1);
    let _ = std::fs::remove_dir_all(&root);
}

// --- MODIFIED 的 scenario 保全与明示删除声明（design「scenario superset check
//     与明示删除声明」；spec archive-merge 同名需求）---

/// spec Example 的正典目标需求：两个 scenario「逾时重试」与「脱机队列」。
const CANON_TWO_SCENARIOS: &str = "# net Specification\n\n## Purpose\n\nNet.\n\n## Requirements\n\n### Requirement: 重试策略\n\nIt SHALL retry.\n\n#### Scenario: 逾时重试\n\n- **WHEN** timeout\n- **THEN** retry\n\n#### Scenario: 脱机队列\n\n- **WHEN** offline\n- **THEN** queue\n";

#[test]
fn modified_dropping_a_canonical_scenario_refuses_and_names_it() {
    // spec Scenario「漏抄 scenario 被拒绝并点名」：delta 只留「逾时重试」、
    // 无删除声明 → 拒绝并点名遗失的「脱机队列」。
    let delta = "## MODIFIED Requirements\n\n### Requirement: 重试策略\n\nIt SHALL retry harder.\n\n#### Scenario: 逾时重试\n\n- **WHEN** timeout\n- **THEN** retry twice\n";
    let store = merge_store(&[("net", delta)], &[("net", CANON_TWO_SCENARIOS)]);
    let msg = refuse_merge(&store);
    assert!(msg.contains("重试策略"), "requirement named: {msg}");
    assert!(msg.contains("脱机队列"), "the dropped scenario is named: {msg}");
    assert!(!msg.contains("逾时重试"), "the surviving scenario is not flagged: {msg}");
}

#[test]
fn declared_scenario_removal_passes_and_the_note_is_stripped() {
    // spec Scenario「明示声明后允许删除」：声明放行，合并后正典含「逾时重试」、
    // 不含「脱机队列」、也不含声明注解本身。
    let delta = "## MODIFIED Requirements\n\n### Requirement: 重试策略\n\n<!-- REMOVED-SCENARIO: 脱机队列 -->\n\nIt SHALL retry harder.\n\n#### Scenario: 逾时重试\n\n- **WHEN** timeout\n- **THEN** retry twice\n";
    let store = merge_store(&[("net", delta)], &[("net", CANON_TWO_SCENARIOS)]);
    let change = crate::model::find_change(&store, "demo").unwrap();
    archive(&ghost_ws(), &store, &change, &apply_opts(), None)
        .expect("an explicit removal declaration lets the merge through");
    let canon = store.read_canonical_spec("net").expect("canonical spec written");
    assert!(canon.contains("#### Scenario: 逾时重试"), "kept scenario survives: {canon}");
    assert!(!canon.contains("脱机队列"), "declared scenario is gone: {canon}");
    assert!(!canon.contains("REMOVED-SCENARIO"), "the declaration itself is stripped: {canon}");
}

#[test]
fn crlf_authored_delta_matches_scenario_names_the_same_way() {
    // design Risk「Windows 换行使 scenario 名比对失准」：CRLF 样本的判定与 LF 一致
    // ——完整抄录放行、漏抄则拒绝并点名。
    let complete = "## MODIFIED Requirements\r\n\r\n### Requirement: 重试策略\r\n\r\nIt SHALL retry harder.\r\n\r\n#### Scenario: 逾时重试\r\n\r\n- **WHEN** timeout\r\n- **THEN** retry twice\r\n\r\n#### Scenario: 脱机队列\r\n\r\n- **WHEN** offline\r\n- **THEN** queue\r\n";
    let store = merge_store(&[("net", complete)], &[("net", CANON_TWO_SCENARIOS)]);
    let change = crate::model::find_change(&store, "demo").unwrap();
    archive(&ghost_ws(), &store, &change, &apply_opts(), None)
        .expect("a CRLF delta carrying every scenario passes the superset check");

    let partial = "## MODIFIED Requirements\r\n\r\n### Requirement: 重试策略\r\n\r\nIt SHALL retry harder.\r\n\r\n#### Scenario: 逾时重试\r\n\r\n- **WHEN** timeout\r\n- **THEN** retry twice\r\n";
    let store = merge_store(&[("net", partial)], &[("net", CANON_TWO_SCENARIOS)]);
    let msg = refuse_merge(&store);
    assert!(msg.contains("脱机队列"), "CRLF authoring still names the dropped scenario: {msg}");
}

// --- 新 capability 的 Purpose 自 delta 带入（design 同名决策；
//     spec archive-merge「新 capability 的 Purpose 自 delta 带入」）---

const DELTA_WITH_PURPOSE: &str = "## Purpose\n\n本 capability 管理权杖的轮替与撤销，涵盖签发、验证与失效三段生命周期的可观察行为与清理时机。\n\n## ADDED Requirements\n\n### Requirement: Fresh\n\nIt SHALL work.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n";

#[test]
fn delta_purpose_becomes_the_new_canonical_purpose() {
    // spec Scenario「delta 提供 Purpose」：新建正典的 Purpose 为 delta 区段内容，非占位文本。
    let store = merge_store(&[("token", DELTA_WITH_PURPOSE)], &[]);
    let change = crate::model::find_change(&store, "demo").unwrap();
    archive(&ghost_ws(), &store, &change, &apply_opts(), None).unwrap();
    let canon = store.read_canonical_spec("token").expect("canonical spec created");
    let purpose = crate::model::purpose_content(DELTA_WITH_PURPOSE).expect("fixture purpose");
    assert!(
        canon.contains(&format!("## Purpose\n\n{purpose}\n")),
        "delta Purpose copied verbatim: {canon}"
    );
    assert!(!canon.contains("TBD"), "no placeholder skeleton remains: {canon}");
    assert!(
        !canon.contains(&format!("{purpose}\n\n## ADDED")),
        "the delta's operation heading does not leak into the canon: {canon}"
    );
}

const ADDED_ONLY: &str = "## ADDED Requirements\n\n### Requirement: Fresh\n\nIt SHALL work.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n";

#[test]
fn new_capability_without_purpose_refuses_archive() {
    // spec Scenario「新 capability 缺 Purpose 封存被拒」：守门取代静默写占位，
    // 拒绝时零文件效果（refuse_merge 逐项断言）。
    let store = merge_store(&[("token", ADDED_ONLY)], &[]);
    let msg = refuse_merge(&store);
    assert!(msg.contains("token"), "不合格的 capability 被点名: {msg}");
    assert!(msg.contains("Purpose"), "不合格原因指向 Purpose: {msg}");
}

#[test]
fn new_capability_with_a_too_short_purpose_refuses_archive() {
    // spec Scenario「新 capability 的 Purpose 过短封存被拒」。
    let short = format!("## Purpose\n\n管权杖。\n\n{ADDED_ONLY}");
    let store = merge_store(&[("token", &short)], &[]);
    let msg = refuse_merge(&store);
    assert!(msg.contains("token"), "capability 被点名: {msg}");
    assert!(
        msg.contains(&crate::model::MIN_PURPOSE_LENGTH.to_string()),
        "回报不足门槛的原因: {msg}"
    );
}

#[test]
fn an_existing_capability_never_hits_the_purpose_gate() {
    // 既有 capability 的 delta 无论带不带 Purpose 都不构成封存拒绝理由
    // （spec：忽略不报错）——正典已有 Purpose，守门只管新开的。
    for delta in [
        ADDED_R1.replace("R1", "Brand new"),
        format!("## Purpose\n\n短。\n\n{}", ADDED_R1.replace("R1", "Brand new")),
    ] {
        let store = merge_store(&[("auth", &delta)], &[("auth", CANON_R1)]);
        let change = crate::model::find_change(&store, "demo").unwrap();
        archive(&ghost_ws(), &store, &change, &apply_opts(), None)
            .expect("既有 capability 不受 Purpose 守门影响");
    }
}

#[test]
fn skip_specs_archive_does_not_trigger_the_purpose_gate() {
    // spec：skip_specs 封存不触发此守门（无 delta 可验）。
    let store = merge_store(&[("token", ADDED_ONLY)], &[]);
    let change = crate::model::find_change(&store, "demo").unwrap();
    archive(&ghost_ws(), &store, &change, &skip_opts(), None)
        .expect("--skip-specs 不套用 delta，也就不验 Purpose");
    assert!(store.read_canonical_spec("token").is_none(), "正典未被创建");
}

#[test]
fn purpose_reason_carries_the_refusal_wording() {
    // spec archive-merge「新 capability 缺 Purpose 的违规呈现三处一致」：
    // 三处（drift／bulk 预检／单笔 archive）共用同一 reason 字符串，语意比照
    // ADDED_EXISTS 的「archive would refuse it」。
    let store = merge_store(&[("token", ADDED_ONLY)], &[]);
    let violations = merge_violations(&store, "demo");
    assert_eq!(violations.len(), 1);
    assert!(violations[0].is_purpose_gate(), "the purpose violation self-identifies");
    assert!(
        violations[0].reason.contains("archive would refuse it"),
        "refusal wording travels in the shared reason: {}",
        violations[0].reason
    );
}

#[test]
fn purpose_only_refusal_names_the_remedy_not_drift_ingest() {
    // 纯 Purpose 违规的拒绝消息：说对原因（缺 `## Purpose`）、给对修法
    // （补区段＋validate 指引），不再指向修不了它的 drift → ingest。
    let store = merge_store(&[("token", ADDED_ONLY)], &[]);
    let msg = refuse_merge(&store);
    assert!(msg.contains("## Purpose"), "the real cause is named: {msg}");
    assert!(
        msg.contains(&crate::model::MIN_PURPOSE_LENGTH.to_string()),
        "the remedy names the threshold: {msg}"
    );
    assert!(msg.contains("specseal validate"), "the remedy points at validate: {msg}");
    assert!(!msg.contains("/specseal-ingest"), "ingest cannot fix this: {msg}");
    assert!(
        !msg.contains("no longer match the canonical spec"),
        "the stale preamble does not misdescribe a purpose violation: {msg}"
    );
}

#[test]
fn mixed_refusal_lists_both_classes_with_both_remedies() {
    // 过期操作与 Purpose 违规并存：两类各自列明、两套补救动线并列。
    let stale = "## ADDED Requirements\n\n### Requirement: R1\n\nIt SHALL work.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n";
    let store = merge_store(&[("auth", stale), ("token", ADDED_ONLY)], &[("auth", CANON_R1)]);
    let msg = refuse_merge(&store);
    assert!(msg.contains("no longer match the canonical spec"), "stale class kept: {msg}");
    assert!(msg.contains("/specseal-ingest"), "stale remedy kept: {msg}");
    assert!(msg.contains("## Purpose"), "purpose class listed: {msg}");
    assert!(msg.contains("specseal validate"), "purpose remedy listed: {msg}");
}

#[test]
fn the_placeholder_skeleton_survives_as_an_unreachable_branch() {
    // 守门上线后 delta 缺 Purpose 走不到合并，占位分支成为理论不可达的
    // 死路防御（design D3）——分支本身仍在，且文案仍取自单一常数。
    let (canon, _) = merge_capability("token", "demo", "2026-08-11", ADDED_ONLY, None);
    assert!(
        canon.contains(&format!(
            "{} change 'demo'. Update Purpose after archive.",
            crate::model::PURPOSE_TBD_PREFIX
        )),
        "占位文案沿用 core 常数: {canon}"
    );
}

#[test]
fn delta_purpose_never_rewrites_an_existing_canonical_purpose() {
    // spec Scenario「既有正式规格 Purpose 不受 delta 影响」。
    let delta = "## Purpose\n\n这段不该进正典。\n\n## ADDED Requirements\n\n### Requirement: Brand new\n\nIt SHALL work.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n";
    let store = merge_store(&[("auth", delta)], &[("auth", CANON_R1)]);
    let change = crate::model::find_change(&store, "demo").unwrap();
    archive(&ghost_ws(), &store, &change, &apply_opts(), None).unwrap();
    let canon = store.read_canonical_spec("auth").expect("canonical spec merged");
    assert!(canon.contains("## Purpose\n\nAuth.\n"), "existing Purpose survives: {canon}");
    assert!(!canon.contains("这段不该进正典"), "delta Purpose is not applied: {canon}");
}

// --- 自相矛盾 delta 与注解剥除的守门补强（design「违规清单与聚合错误形状」）---

#[test]
fn duplicate_added_names_in_one_delta_refuse_archive() {
    // 自相矛盾的 delta 必须拒绝：同一 delta 内重复 ADDED 名称若放行，
    // 合并端（已无去重）会在正典写出两个同名需求。
    let delta = "## ADDED Requirements\n\n### Requirement: Fresh\n\nA.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n\n### Requirement: Fresh\n\nB.\n\n#### Scenario: ok2\n\n- **WHEN** used\n- **THEN** works\n";
    let store = merge_store(&[("auth", delta)], &[("auth", CANON_R1)]);
    let msg = refuse_merge(&store);
    assert!(msg.contains("Fresh"), "requirement named: {msg}");
    assert!(msg.contains("more than once"), "duplication reason given: {msg}");
}

#[test]
fn two_renames_to_the_same_target_refuse_archive() {
    // A→C 与 B→C 两对 rename 指向同一目标（C 不在正典）若放行，
    // 合并后正典出现两个名为 C 的需求——以 mention 计数拦下。
    let delta = "## RENAMED Requirements\n\n- FROM: `### Requirement: R1`\n- TO: `### Requirement: C`\n\n- FROM: `### Requirement: R2`\n- TO: `### Requirement: C`\n";
    let store = merge_store(&[("auth", delta)], &[("auth", CANON_R1_R2)]);
    let msg = refuse_merge(&store);
    assert!(msg.contains('C'), "colliding rename target named: {msg}");
    assert!(msg.contains("more than once"), "duplication reason given: {msg}");
}

#[test]
fn scenario_quoted_only_inside_a_before_note_is_not_carried() {
    // 守门必须以剥除后文本判定：BEFORE 注解内引用的 scenario 行不算已抄录，
    // 否则写入前剥除会整段删掉 → 正典静默掉 scenario。
    let delta = "## MODIFIED Requirements\n\n### Requirement: 重试策略\n\n<!-- BEFORE:\n#### Scenario: 脱机队列\n-->\n\nIt SHALL retry harder.\n\n#### Scenario: 逾时重试\n\n- **WHEN** timeout\n- **THEN** retry twice\n";
    let store = merge_store(&[("net", delta)], &[("net", CANON_TWO_SCENARIOS)]);
    let msg = refuse_merge(&store);
    assert!(msg.contains("脱机队列"), "the dropped scenario is named: {msg}");
}

#[test]
fn unterminated_removed_scenario_declaration_refuses_archive() {
    // 畸形声明必须拒绝：漏打 `-->` 的声明若被接受，多行剥除会吞掉其后整个
    // block → 需求本体消失。
    let delta = "## MODIFIED Requirements\n\n### Requirement: 重试策略\n\n<!-- REMOVED-SCENARIO: 脱机队列\n\nIt SHALL retry harder.\n\n#### Scenario: 逾时重试\n\n- **WHEN** timeout\n- **THEN** retry twice\n";
    let store = merge_store(&[("net", delta)], &[("net", CANON_TWO_SCENARIOS)]);
    let msg = refuse_merge(&store);
    assert!(msg.contains("REMOVED-SCENARIO"), "malformed declaration named: {msg}");
}

#[test]
fn renamed_header_without_to_line_refuses_archive() {
    // fail-closed 守门：header 形式的 RENAMED 缺 TO: 行套用不到任何目标，
    // 必须拒绝而非静默忽略。
    let delta = "## ADDED Requirements\n\n### Requirement: Brand new\n\nIt SHALL work.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n\n## RENAMED Requirements\n\n### Requirement: R1\n";
    let store = merge_store(&[("auth", delta)], &[("auth", CANON_R1)]);
    let msg = refuse_merge(&store);
    assert!(msg.contains("RENAMED") && msg.contains("R1"), "dangling rename named: {msg}");
    assert!(msg.contains("TO:"), "missing-target reason given: {msg}");
}

#[test]
fn bullet_rename_without_to_refuses_archive() {
    // fail-closed 守门的 bullet 形式对称面：孤儿 `- FROM:`（无 TO 行）与
    // 空值 TO 皆套用不到目标，必须拒绝而非静默忽略。
    const ADDED_OK: &str = "## ADDED Requirements\n\n### Requirement: Brand new\n\nIt SHALL work.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n\n";
    let orphan = format!(
        "{ADDED_OK}## RENAMED Requirements\n\n- FROM: `### Requirement: R1`\n"
    );
    let store = merge_store(&[("auth", &orphan)], &[("auth", CANON_R1)]);
    let msg = refuse_merge(&store);
    assert!(msg.contains("RENAMED") && msg.contains("R1"), "orphan FROM named: {msg}");

    let empty_to = format!(
        "{ADDED_OK}## RENAMED Requirements\n\n- FROM: `### Requirement: R1`\n- TO: ``\n"
    );
    let store = merge_store(&[("auth", &empty_to)], &[("auth", CANON_R1)]);
    let msg = refuse_merge(&store);
    assert!(msg.contains("RENAMED") && msg.contains("R1"), "empty TO named: {msg}");
}

#[test]
fn unterminated_before_note_refuses_archive() {
    // 注解剥除守门：未终结的 `<!-- BEFORE:` 会让剥除吞到 block 结尾，
    // 需求内容静默消失——与畸形 REMOVED-SCENARIO 同类，必须拒绝。
    let delta = "## ADDED Requirements\n\n### Requirement: Brand new\n\n<!-- BEFORE:\nold text\n\nIt SHALL work.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n";
    let store = merge_store(&[("auth", delta)], &[("auth", CANON_R1)]);
    let msg = refuse_merge(&store);
    assert!(msg.contains("BEFORE"), "malformed BEFORE note named: {msg}");
}
