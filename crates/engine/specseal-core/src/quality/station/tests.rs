//! 共用盖章守门的分界测试（design D2：改一处两站同时生效）——站别 wiring
//! 与五栏写入由底下的 `review`／`verify` 子模块覆盖。
use super::*;
use crate::teststore::TestStore;

const META: &str = "schema: spec-driven\ncreated: 2026-07-01\n";
const REPO: &[(&str, &str)] = &[("crates/a/src/lib.rs", "fn a() {}\n")];

/// 一份 meta 上某站的章的冻结度：没有工单时的 [`status`]，再问 [`StationStatus::freshness`]
/// （读得到工作树）。这个档的冻结度测试都从 meta 出发。
fn freshness(
    st: &Station,
    meta: &ChangeMeta,
    counts: &crate::tasks::Counts,
    read_file: &ScopeReadFn<'_>,
) -> Freshness {
    status(st, meta, false).freshness(counts, Some(read_file))
}

fn store_with_round(round: &str) -> TestStore {
    let store = TestStore::with_meta("demo", META);
    store.put_artifact("demo", "tasks.md", "- [x] 1 a\n");
    add_round(&VERIFY, &store, "demo", round).expect("round recorded");
    store
}

fn stamp_demo(store: &TestStore, accept: bool) -> Result<()> {
    let files =
        |p: &str| REPO.iter().find(|(k, _)| *k == p).map(|(_, v)| v.as_bytes().to_vec());
    let present = |p: &str| REPO.iter().any(|(k, _)| *k == p);
    stamp(&VERIFY, store, "demo", accept, None, None, None, &files, &present)
}

#[test]
fn round_to_json_is_the_one_wire_shape_for_cli_and_desktop() {
    // CLI `--json` 的 `rounds` 项与桌面工单分页（drawer-quality-ticket-tab D1）共用
    // 这一份串行化：字段 camelCase、legacy 轮的 phase／patchHash 为明确 null。
    let text = format!(
        "# Review — demo\n\n## Round 1\n\n**Scope**: src/a.rs\n\n- [WARNING] src/a.rs — old style\n\n\
         ## Round 2\n\n**Phase**: validation\n**Patch**: sha256:{}\n**Scope**: src/a.rs, src/b.rs\n\n\
         - [SUGGESTION] src/b.rs — nit (accepted)\n",
        "b".repeat(64)
    );
    let ticket = parse_ticket(&REVIEW, &text).expect("two rounds parse");
    assert_eq!(
        ticket.rounds[0].to_json(),
        serde_json::json!({
            "index": 1,
            "phase": null,
            "patchHash": null,
            "rules": null,
            "scope": ["src/a.rs"],
            "findings": [{ "severity": "WARNING", "path": "src/a.rs", "text": "old style" }],
        })
    );
    assert_eq!(
        ticket.rounds[1].to_json(),
        serde_json::json!({
            "index": 2,
            "phase": "validation",
            "patchHash": format!("sha256:{}", "b".repeat(64)),
            "rules": null,
            "scope": ["src/a.rs", "src/b.rs"],
            "findings": [{ "severity": "SUGGESTION", "path": "src/b.rs", "text": "nit (accepted)" }],
        })
    );
}

#[test]
fn gate_ignores_suggestion_findings() {
    // 守门 (2) 的分界：SUGGESTION 不是必修，仅 SUGGESTION 的末轮放行。
    let store = store_with_round(
        "**Scope**: crates/a/src/lib.rs\n\n- [SUGGESTION] crates/a/src/lib.rs — nit\n",
    );
    stamp_demo(&store, false).expect("suggestion-only last round must pass the gate");
}

#[test]
fn gate_counts_only_must_fix_and_names_the_count() {
    // 混合轮：CRITICAL＋WARNING＋SUGGESTION → 计数 2（SUGGESTION 不计），
    // 消息点名数量与阻断级别。
    let store = store_with_round(
        "**Scope**: crates/a/src/lib.rs\n\n\
             - [CRITICAL] crates/a/src/lib.rs — broken\n\
             - [WARNING] crates/a/src/lib.rs — fragile\n\
             - [SUGGESTION] crates/a/src/lib.rs — nit\n",
    );
    let err = stamp_demo(&store, false).expect_err("must-fix findings must refuse");
    let msg = err.to_string();
    assert!(msg.contains("2 outstanding must-fix"), "count skips SUGGESTION: {msg}");
    assert!(msg.contains("(CRITICAL/WARNING)"), "names the blocking severities: {msg}");
}

#[test]
fn gate_counts_accepted_must_fix_lines_too() {
    // design D2：`(accepted)` 不另设豁免——已受理必修照样挡干净章、`--accept`
    // 才放行；消息以 outstanding（而非 unresolved）涵盖已裁决未修者。
    let store = store_with_round(
        "**Scope**: crates/a/src/lib.rs\n\n\
             - [WARNING] crates/a/src/lib.rs — fragile (accepted)\n",
    );
    let err = stamp_demo(&store, false).expect_err("accepted must-fix still blocks");
    assert!(err.to_string().contains("1 outstanding must-fix"), "{err}");
    stamp_demo(&store, true).expect("--accept stamps over accepted must-fix");
}

#[test]
fn freshness_takes_meta_and_reads_only_its_own_station() {
    // lifecycle-station-anchors D2：freshness 直接吃 meta，锚由 `meta.anchors(st)`
    // 取——无章 Unknown、锚全符 Fresh、任务锚破 Stale；另一站的章不影响本站判定。
    let h = content_fingerprint("fn a() {}\n");
    let counts = |md: &str| crate::tasks::counts(&crate::tasks::parse(md));
    let five_done = "- [x] a\n- [x] b\n- [x] c\n- [x] d\n- [x] e\n";
    let four_of_five = "- [x] a\n- [x] b\n- [x] c\n- [x] d\n- [ ] e\n";
    let rf = |p: &str| REPO.iter().find(|(k, _)| *k == p).map(|(_, v)| v.as_bytes().to_vec());
    let unstamped = crate::model::ChangeMeta::from_text(Some(META)).expect("meta parses");
    assert_eq!(freshness(&REVIEW, &unstamped, &counts(five_done), &rf), Freshness::Unknown);
    let both = format!(
        "{META}reviewed_at: 2026-08-01\nreviewed_tasks_total: 5\nreviewed_scope:\n  - path: crates/a/src/lib.rs\n    hash: {h}\n\
             verified_at: 2026-08-01\nverified_tasks_total: 3\nverified_scope:\n  - path: crates/a/src/lib.rs\n    hash: {h}\n"
    );
    let meta = crate::model::ChangeMeta::from_text(Some(&both)).expect("meta parses");
    assert_eq!(
        freshness(&REVIEW, &meta, &counts(five_done), &rf),
        Freshness::Fresh,
        "review anchors match; the broken verify anchor must not leak in"
    );
    assert_eq!(
        freshness(&VERIFY, &meta, &counts(five_done), &rf),
        Freshness::Stale,
        "verify task anchor (3 vs 5) is broken"
    );
    assert_eq!(
        freshness(&REVIEW, &meta, &counts(four_of_five), &rf),
        Freshness::Stale,
        "review task anchor breaks on uncheck"
    );
}

/// 盖章记录轮数（spec review-station「盖章记录审查轮数」、verify-station「盖章记录
/// 验证轮数」）：两站同一条规则，每个测试都对两站各跑一次。
mod stamp_rounds {
    use super::*;

    const CLEAN: &str = "**Scope**: crates/a/src/lib.rs\n";
    const MUST_FIX: &str =
        "**Scope**: crates/a/src/lib.rs\n\n- [WARNING] crates/a/src/lib.rs — possible Feature Envy\n";
    const CRITICAL: &str =
        "**Scope**: crates/a/src/lib.rs\n\n- [CRITICAL] crates/a/src/lib.rs — requirement R2 has no implementation\n";

    /// 任务全勾的 change，`st` 站工单有 `rounds` 轮：前面几轮带必修，末轮为 `last`。
    fn ticketed(st: &Station, meta: &str, rounds: usize, last: &str) -> TestStore {
        let store = TestStore::with_meta("demo", meta);
        store.put_artifact("demo", "tasks.md", "- [x] 1 a\n");
        for _ in 1..rounds {
            add_round(st, &store, "demo", MUST_FIX).expect("earlier round");
        }
        add_round(st, &store, "demo", last).expect("last round");
        store
    }

    fn stamp_at(st: &Station, store: &TestStore, accept: bool) -> Result<()> {
        let files =
            |p: &str| REPO.iter().find(|(k, _)| *k == p).map(|(_, v)| v.as_bytes().to_vec());
        let present = |p: &str| REPO.iter().any(|(k, _)| *k == p);
        stamp(st, store, "demo", accept, None, None, None, &files, &present)
    }

    /// meta 原文里 `<prefix>_<suffix>: ` 开头的每一行的值。
    fn values<'a>(st: &Station, suffix: &str, raw: &'a str) -> Vec<&'a str> {
        let key = format!("{}_{suffix}: ", st.meta_prefix);
        raw.lines().filter_map(|l| l.strip_prefix(key.as_str())).collect()
    }

    #[test]
    fn first_stamp_records_the_ticket_round_count() {
        // Scenario「首次盖章记录回合数」：审查 3 轮、验证 2 轮。
        for (st, rounds) in [(&REVIEW, 3), (&VERIFY, 2)] {
            let store = ticketed(st, META, rounds, CLEAN);
            stamp_at(st, &store, false).expect("clean stamp");
            let raw = store.meta("demo");
            assert_eq!(values(st, "rounds", &raw), [rounds.to_string()], "{}: {raw}", st.noun);
            let at = values(st, "at", &raw);
            assert!(
                at.len() == 1 && crate::util::is_offset_stamp(at[0]),
                "{}: the stamp time is an offset stamp: {raw}",
                st.noun
            );
            assert!(!store.artifact_exists("demo", st.doc), "{}: ticket deleted", st.noun);
        }
    }

    #[test]
    fn restamp_adds_the_new_ticket_rounds_to_the_recorded_count() {
        // Scenario「章失效后重新盖章累加轮数」：3＋2 与 2＋3 都是 5，只留一行。
        for (st, before, rounds) in [(&REVIEW, 3, 2), (&VERIFY, 2, 3)] {
            let meta = format!("{META}{}_rounds: {before}\n", st.meta_prefix);
            let store = ticketed(st, &meta, rounds, CLEAN);
            stamp_at(st, &store, false).expect("re-stamp");
            let raw = store.meta("demo");
            assert_eq!(values(st, "rounds", &raw), ["5"], "{}: {raw}", st.noun);
        }
    }

    #[test]
    fn restamp_on_the_largest_recorded_count_saturates_instead_of_wrapping() {
        for st in [&REVIEW, &VERIFY] {
            let meta = format!("{META}{}_rounds: {}\n", st.meta_prefix, u64::MAX);
            let store = ticketed(st, &meta, 2, CLEAN);
            stamp_at(st, &store, false).expect("re-stamp");
            let raw = store.meta("demo");
            assert_eq!(values(st, "rounds", &raw), [u64::MAX.to_string()], "{}: {raw}", st.noun);
        }
    }

    #[test]
    fn stamp_with_accept_records_the_rounds_too() {
        for st in [&REVIEW, &VERIFY] {
            let store = ticketed(st, META, 2, MUST_FIX);
            stamp_at(st, &store, true).expect("--accept stamps");
            assert_eq!(values(st, "rounds", &store.meta("demo")), ["2"], "{}", st.noun);
        }
    }

    #[test]
    fn refused_stamp_and_discard_leave_the_rounds_untouched() {
        // Scenario「守门失败不改轮数」（审查末轮 WARNING、验证末轮 CRITICAL）＋放弃工单不改轮数。
        for (st, last) in [(&REVIEW, MUST_FIX), (&VERIFY, CRITICAL)] {
            let meta = format!("{META}{}_rounds: 4\n", st.meta_prefix);
            let store = ticketed(st, &meta, 2, last);
            stamp_at(st, &store, false).expect_err("must-fix last round refuses");
            assert_eq!(store.meta("demo"), meta, "{}: refusal writes nothing", st.noun);
            assert!(store.artifact_exists("demo", st.doc), "{}: ticket survives", st.noun);
            discard(st, &store, "demo").expect("discard");
            assert_eq!(store.meta("demo"), meta, "{}: discard writes nothing", st.noun);
            assert_eq!(*store.meta_writes.borrow(), 0, "{}", st.noun);
        }
    }

    #[test]
    fn non_integer_recorded_rounds_refuse_the_stamp_with_zero_writes() {
        // Scenario「原有轮数不是整数时拒绝」：审查 many、验证 -1。
        for (st, bad) in [(&REVIEW, "many"), (&VERIFY, "-1")] {
            let meta = format!("{META}{}_rounds: {bad}\n", st.meta_prefix);
            let store = ticketed(st, &meta, 1, CLEAN);
            let err = stamp_at(st, &store, false).expect_err("unparsable meta refuses");
            assert!(
                err.to_string().contains("specseal/changes/demo/.meta.yaml"),
                "{}: the error names the metadata file: {err}",
                st.noun
            );
            assert_eq!(store.meta("demo"), meta, "{}", st.noun);
            assert_eq!(*store.meta_writes.borrow(), 0, "{}", st.noun);
            assert!(store.artifact_exists("demo", st.doc), "{}: ticket survives", st.noun);
        }
    }
}

/// 盖章记录代码的 commit（spec review-station「盖章记录代码的 commit」、verify-station
/// 「验证盖章记录代码的 commit」）：两站同一条规则，每个测试都对两站各跑一次。
mod stamp_commit {
    use super::*;

    const CLEAN: &str = "**Scope**: crates/a/src/lib.rs\n";
    const SHA: &str = "0123456789abcdef0123456789abcdef01234567";

    /// 任务全勾、`st` 站有一轮干净工单的 change。
    fn ticketed(st: &Station, meta: &str) -> TestStore {
        let store = TestStore::with_meta("demo", meta);
        store.put_artifact("demo", "tasks.md", "- [x] 1 a\n");
        add_round(st, &store, "demo", CLEAN).expect("round");
        store
    }

    fn stamp_at(st: &Station, store: &TestStore, head_commit: Option<&str>) -> Result<()> {
        let files =
            |p: &str| REPO.iter().find(|(k, _)| *k == p).map(|(_, v)| v.as_bytes().to_vec());
        let present = |p: &str| REPO.iter().any(|(k, _)| *k == p);
        stamp(st, store, "demo", false, None, None, head_commit, &files, &present)
    }

    fn commit_of(st: &Station, store: &TestStore) -> Option<String> {
        let meta = ChangeMeta::from_text(Some(&store.meta("demo"))).expect("stamped meta parses");
        meta.stamp(st).commit.map(str::to_string)
    }

    fn commit_lines(st: &Station, raw: &str) -> usize {
        let key = format!("{}_commit:", st.meta_prefix);
        raw.lines().filter(|l| l.starts_with(key.as_str())).count()
    }

    #[test]
    fn a_stamp_with_a_commit_records_it_in_the_same_write() {
        // Scenario「盖章记下 HEAD」：commit 与章的其他字段同一次写入，工单同时删除。
        for st in [&REVIEW, &VERIFY] {
            let store = ticketed(st, META);
            stamp_at(st, &store, Some(SHA)).expect("stamp");
            assert_eq!(commit_of(st, &store).as_deref(), Some(SHA), "{}", st.noun);
            let raw = store.meta("demo");
            assert_eq!(commit_lines(st, &raw), 1, "{}: {raw}", st.noun);
            assert_eq!(*store.meta_writes.borrow(), 1, "{}: one meta write", st.noun);
            assert!(!store.artifact_exists("demo", st.doc), "{}: ticket deleted", st.noun);
            assert!(is_stamped(ChangeMeta::from_text(Some(&raw)).unwrap().anchors(st)), "{}", st.noun);
        }
    }

    #[test]
    fn a_stamp_without_a_commit_writes_no_commit_key() {
        // Scenario「不是 git checkout 时照常盖章」。
        for st in [&REVIEW, &VERIFY] {
            let store = ticketed(st, META);
            stamp_at(st, &store, None).expect("stamp");
            assert_eq!(commit_lines(st, &store.meta("demo")), 0, "{}", st.noun);
            assert_eq!(commit_of(st, &store), None, "{}", st.noun);
        }
    }

    #[test]
    fn the_scope_injected_stamp_records_the_commit_too() {
        for st in [&REVIEW, &VERIFY] {
            let store = ticketed(st, META);
            let scope = vec![ReviewedScopeEntry {
                path: "crates/a/src/lib.rs".into(),
                hash: content_fingerprint("fn a() {}\n"),
            }];
            stamp_with_scope(st, &store, "demo", false, None, None, Some(SHA), scope, vec![])
                .expect("stamp");
            assert_eq!(commit_of(st, &store).as_deref(), Some(SHA), "{}", st.noun);
        }
    }

    #[test]
    fn a_malformed_commit_refuses_with_zero_writes() {
        // 7 到 64 个十六进位字符；其余一律是调用端参数错误，meta 与工单都不动。
        let too_long = "a".repeat(65);
        let bad = ["not-a-sha", "012345", too_long.as_str(), "", "   ", "0123 4567", "0123456\nbranch: x", "0123456: x"];
        for st in [&REVIEW, &VERIFY] {
            for value in bad {
                let store = ticketed(st, META);
                let err = stamp_at(st, &store, Some(value)).expect_err("malformed commit must refuse");
                assert!(
                    err.downcast_ref::<crate::command::InvalidContent>().is_some(),
                    "{}: {value:?} is a caller error: {err}",
                    st.noun
                );
                assert_eq!(store.meta("demo"), META, "{}: {value:?}", st.noun);
                assert_eq!(*store.meta_writes.borrow(), 0, "{}: {value:?}", st.noun);
                assert!(store.artifact_exists("demo", st.doc), "{}: ticket survives", st.noun);
                let scope = vec![ReviewedScopeEntry { path: "crates/a/src/lib.rs".into(), hash: "aa".into() }];
                stamp_with_scope(st, &store, "demo", false, None, None, Some(value), scope, vec![])
                    .expect_err("the scope-injected stamp refuses too");
                assert_eq!(*store.meta_writes.borrow(), 0, "{}: {value:?}", st.noun);
            }
        }
    }

    #[test]
    fn the_shortest_longest_and_padded_commits_are_accepted() {
        let longest = "f".repeat(64);
        for st in [&REVIEW, &VERIFY] {
            for (given, want) in [("0123456", "0123456"), (longest.as_str(), longest.as_str()), ("  ABCdef0 \n", "ABCdef0")] {
                let store = ticketed(st, META);
                stamp_at(st, &store, Some(given)).expect("stamp");
                assert_eq!(commit_of(st, &store).as_deref(), Some(want), "{}: {given:?}", st.noun);
            }
        }
    }

    #[test]
    fn a_commit_of_digits_only_reads_back_as_the_same_text() {
        // 全数字的短 commit 不得被 YAML 读成数字（读成数字时整份 meta 解析失败）。
        for st in [&REVIEW, &VERIFY] {
            for digits in ["1234567", "0000000", "1234567890"] {
                let store = ticketed(st, META);
                stamp_at(st, &store, Some(digits)).expect("stamp");
                assert_eq!(commit_of(st, &store).as_deref(), Some(digits), "{}", st.noun);
            }
        }
    }

    #[test]
    fn a_restamp_replaces_or_drops_the_recorded_commit() {
        // Scenario「清章时一并清除」的重盖路径：commit 与章的其他字段同进退。
        for st in [&REVIEW, &VERIFY] {
            let old = format!("{META}{}_commit: \"abc1234\"\n", st.meta_prefix);
            let store = ticketed(st, &old);
            stamp_at(st, &store, Some(SHA)).expect("re-stamp with a commit");
            assert_eq!(commit_lines(st, &store.meta("demo")), 1, "{}", st.noun);
            assert_eq!(commit_of(st, &store).as_deref(), Some(SHA), "{}", st.noun);

            let store = ticketed(st, &old);
            stamp_at(st, &store, None).expect("re-stamp without a commit");
            assert_eq!(commit_lines(st, &store.meta("demo")), 0, "{}: the old commit must go", st.noun);
        }
    }

    #[test]
    fn the_commit_is_one_of_the_keys_cleared_with_the_stamp() {
        // 清章的字段清单只有这一份（`change schema` 用它清验证的章）。
        for st in [&REVIEW, &VERIFY] {
            let key = format!("{}_commit", st.meta_prefix);
            assert!(st.stamp_keys().contains(&key), "{}", st.noun);
        }
    }

    #[test]
    fn the_commit_does_not_take_part_in_freshness() {
        // Scenario「commit 不影响冻结判定」：章记下的 commit 与目前的 HEAD 无关，
        // 任务数与 scope 内容没有变就是 Fresh。
        let rf = |p: &str| REPO.iter().find(|(k, _)| *k == p).map(|(_, v)| v.as_bytes().to_vec());
        let counts = crate::tasks::counts(&crate::tasks::parse("- [x] 1 a\n"));
        for st in [&REVIEW, &VERIFY] {
            let store = ticketed(st, META);
            stamp_at(st, &store, Some(SHA)).expect("stamp");
            let meta = ChangeMeta::from_text(Some(&store.meta("demo"))).expect("meta parses");
            assert_eq!(freshness(st, &meta, &counts, &rf), Freshness::Fresh, "{}", st.noun);
        }
    }
}

/// 关卡状态的判定（station-status-and-landing D1）：`show --json` 与在线回应共用这一份。
mod station_status {
    use super::*;

    const STAMPED: &str = "schema: spec-driven\n\
reviewed_at: 2026-11-02T10:00:00+08:00\nreviewed_by: Rev <r@example.com>\nreviewed_with: claude\n\
reviewed_tasks_total: 12\nreviewed_rounds: 3\nreviewed_commit: \"0123456789ab\"\n\
reviewed_scope:\n  - path: src/a.rs\n    hash: aa\n  - path: src/b.rs\n    hash: bb\n";

    fn meta(text: &str) -> ChangeMeta {
        ChangeMeta::from_text(Some(text)).expect("meta parses")
    }

    #[test]
    fn an_archived_ticket_outranks_a_stamp() {
        // 已封存的结局与进行中同一个顺序：有工单 → 未通过，章还在 meta 里也一样
        // （盖章后重开的工单取代了旧章）。
        let table = [
            (true, true, ArchivedOutcome::NotPassed),
            (true, false, ArchivedOutcome::NotPassed),
            (false, true, ArchivedOutcome::Stamped),
            (false, false, ArchivedOutcome::None),
        ];
        for (ticket_archived, stamped, want) in table {
            assert_eq!(
                ArchivedOutcome::of(ticket_archived, stamped),
                want,
                "ticket_archived={ticket_archived} stamped={stamped}"
            );
        }
    }

    #[test]
    fn an_open_ticket_is_in_progress_even_over_an_earlier_stamp() {
        // 判定第一条：工单存在 → 进行中。章还在 meta 里时也一样，章的字段不带出。
        for text in [META, STAMPED] {
            let status = status(&REVIEW, &meta(text), true);
            assert_eq!(status.progress, StationProgress::InProgress);
            assert_eq!(status.to_json(), serde_json::json!({ "state": "inProgress" }));
            assert!(status.scope.is_empty());
        }
    }

    #[test]
    fn a_complete_stamp_without_a_ticket_is_stamped_with_its_fields() {
        let status = status(&REVIEW, &meta(STAMPED), false);
        assert_eq!(status.progress, StationProgress::Stamped);
        assert_eq!(
            status.to_json(),
            serde_json::json!({
                "state": "stamped",
                "stampedAt": "2026-11-02",
                "stampedBy": "Rev <r@example.com>",
                "stampedWith": "claude",
                "rounds": 3,
                "tasksTotal": 12,
                "commit": "0123456789ab",
            }),
            "the scope stays out of the JSON form"
        );
        let paths: Vec<&str> = status.scope.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, ["src/a.rs", "src/b.rs"]);
    }

    #[test]
    fn a_stamp_reports_only_the_fields_it_has() {
        let bare = "reviewed_at: 2026-11-02\nreviewed_tasks_total: 1\nreviewed_scope:\n  - path: a\n    hash: h\n";
        assert_eq!(
            status(&REVIEW, &meta(bare), false).to_json(),
            serde_json::json!({ "state": "stamped", "stampedAt": "2026-11-02", "rounds": 0, "tasksTotal": 1 }),
            "no by, with or commit key; rounds absent from an old stamp reads as 0"
        );
    }

    #[test]
    fn no_ticket_and_no_complete_stamp_is_none() {
        // 章不完整（没有 scope）读作未盖章，和引擎既有的判断同一条。
        for text in [META, "reviewed_at: 2026-11-02\nreviewed_tasks_total: 1\n", "reviewed_rounds: 4\n"] {
            let status = status(&REVIEW, &meta(text), false);
            assert_eq!(status.progress, StationProgress::None, "{text:?}");
            assert_eq!(status.to_json(), serde_json::json!({ "state": "none" }));
        }
    }

    #[test]
    fn the_two_stations_read_their_own_fields() {
        // Scenario「两个关卡各自独立」：审查已盖章、验证有未结的工单。
        let m = meta(STAMPED);
        assert_eq!(status(&REVIEW, &m, false).progress, StationProgress::Stamped);
        assert_eq!(status(&VERIFY, &m, true).progress, StationProgress::InProgress);
        assert_eq!(status(&VERIFY, &m, false).progress, StationProgress::None);
    }
}

/// add-round 写入前的 finding 路径检查（quality-gate-speedup）：两站同一条规则，
/// 前缀由调用端给（规格目录名来自本机设置）。
mod finding_paths {
    use super::super::*;

    const EXEMPT: &[&str] = &["openspec", ".specseal"];

    fn rounds(ticket: &str) -> Vec<Round> {
        parse_ticket(&REVIEW, ticket).expect("ticket parses").rounds
    }

    fn violations(existing: &[Round], content: &str) -> Vec<(String, PathViolationReason)> {
        finding_path_violations(&REVIEW, existing, content, EXEMPT)
            .expect("content parses")
            .into_iter()
            .map(|v| (v.path, v.reason))
            .collect()
    }

    const ROUND_1: &str = "# Review — demo\n\n## Round 1\n\n**Scope**: src/a.rs, src/b.rs\n\n\
                           - [WARNING] src/a.rs:12 — Correctness: x\n";

    #[test]
    fn line_suffixed_paths_are_violations() {
        let got = violations(
            &[],
            "**Scope**: src/a.rs\n\n- [WARNING] src/a.rs:42 — Correctness: edge\n\
             - [WARNING] src/a.rs:42-50 — Correctness: range\n",
        );
        assert_eq!(
            got,
            vec![
                ("src/a.rs:42".to_string(), PathViolationReason::LineNumber),
                ("src/a.rs:42-50".to_string(), PathViolationReason::LineNumber),
            ]
        );
    }

    #[test]
    fn other_line_forms_are_violations_even_in_exempt_dirs() {
        let got = violations(
            &[],
            "**Scope**: src/a.rs\n\n- [WARNING] src/a.rs:12- — Correctness: open range\n\
             - [WARNING] src/a.rs: — Correctness: bare colon\n\
             - [WARNING] src/a.rs:L12 — Correctness: L-prefixed\n\
             - [WARNING] openspec/changes/demo/design.md:12- — Coherence: exempt dir\n",
        );
        let reasons: Vec<_> = got.iter().map(|(_, r)| *r).collect();
        assert_eq!(reasons, vec![PathViolationReason::LineNumber; 4], "{got:?}");
    }

    #[test]
    fn paths_outside_every_scope_are_violations() {
        let got = violations(
            &rounds(ROUND_1),
            "**Scope**: src/a.rs\n\n- [WARNING] src/caller.rs — Correctness: caller breaks\n",
        );
        assert_eq!(got, vec![("src/caller.rs".to_string(), PathViolationReason::OutOfScope)]);
    }

    #[test]
    fn an_earlier_rounds_scope_admits_the_path() {
        // Round 2 的 patch 只动 src/a.rs，但 src/b.rs 在 Round 1 Scope 内。
        let got = violations(
            &rounds(ROUND_1),
            "**Scope**: src/a.rs\n\n- [WARNING] src/b.rs — Correctness: regression\n",
        );
        assert!(got.is_empty(), "{got:?}");
    }

    #[test]
    fn spec_dir_and_sidecar_paths_skip_the_scope_check_but_not_the_line_check() {
        let got = violations(
            &[],
            "**Scope**: src/a.rs\n\n\
             - [CRITICAL] openspec/changes/demo/specs/auth/spec.md — Completeness: missing\n\
             - [WARNING] openspec/changes/demo/design.md — Correctness: drift\n\
             - [WARNING] .specseal/review-scopes/demo/baseline.json — Correctness: stale\n\
             - [WARNING] openspec/changes/demo/design.md:3 — Correctness: drift\n\
             - [WARNING] openspecs/x.md — Correctness: lookalike\n",
        );
        assert_eq!(
            got,
            vec![
                ("openspec/changes/demo/design.md:3".to_string(), PathViolationReason::LineNumber),
                ("openspecs/x.md".to_string(), PathViolationReason::OutOfScope),
            ]
        );
    }

    #[test]
    fn verbatim_carry_overs_from_the_last_round_are_exempt() {
        // 检查上线前的旧工单：Round 1 已写了带行号的路径，原文沿用（含补上
        // `(accepted)`）不得卡住；改了描述就不是沿用，照样检查。
        let got = violations(
            &rounds(ROUND_1),
            "**Scope**: src/a.rs\n\n- [WARNING] src/a.rs:12 — Correctness: x\n\
             - [WARNING] src/a.rs:12 — Correctness: x (accepted)\n\
             - [WARNING] src/a.rs:12 — Correctness: reworded\n\
             - [CRITICAL] src/a.rs:12 — Correctness: x\n",
        );
        assert_eq!(
            got,
            vec![
                ("src/a.rs:12".to_string(), PathViolationReason::LineNumber),
                ("src/a.rs:12".to_string(), PathViolationReason::LineNumber),
            ],
            "only the reworded and the re-severitied lines are checked"
        );
    }

    #[test]
    fn accepted_lines_in_the_last_round_are_matched_without_the_token() {
        let ticket = "# Verify — demo\n\n## Round 1\n\n**Scope**: src/a.rs\n\n\
                      - [WARNING] src/a.rs:7-9 — Correctness: legacy (accepted)\n";
        let got = violations(
            &rounds(ticket),
            "**Scope**: src/a.rs\n\n- [WARNING] src/a.rs:7-9 — Correctness: legacy (accepted)\n",
        );
        assert!(got.is_empty(), "{got:?}");
    }

    #[test]
    fn backslash_paths_are_normalized_before_the_scope_check() {
        let got = violations(&[], "**Scope**: src/a.rs\n\n- [WARNING] src\\a.rs — Correctness: x\n");
        assert!(got.is_empty(), "{got:?}");
    }

    #[test]
    fn malformed_content_is_an_invalid_content_error() {
        // 文法错误与 add_round 同一则消息、同一类（invalid_argv）——检查先跑也
        // 不改变调用端看到的格式错误。
        let err = finding_path_violations(&REVIEW, &[], "- [WARNING] src/a.rs — x\n", EXEMPT)
            .expect_err("no scope line");
        assert!(err.downcast_ref::<crate::command::InvalidContent>().is_some(), "{err}");
    }

    #[test]
    fn violation_display_names_the_path_and_the_reason() {
        let line = PathViolation {
            path: "src/a.rs:42".into(),
            reason: PathViolationReason::LineNumber,
        };
        let scope = PathViolation {
            path: "src/caller.rs".into(),
            reason: PathViolationReason::OutOfScope,
        };
        assert!(line.to_string().contains("src/a.rs:42"), "{line}");
        assert!(line.to_string().contains("line number"), "{line}");
        assert!(scope.to_string().contains("src/caller.rs"), "{scope}");
        assert!(scope.to_string().contains("scope"), "{scope}");
    }
}

/// 审查站：工单动词、盖章守门与五个 `reviewed_*` 字段的写入、scope 注入
/// 盖章、structured rounds、指纹与失效判定——全部带 `&REVIEW` 走本模块的函数。
mod review {
    use super::super::*;
    use super::freshness;
    use crate::teststore::TestStore;

    const META: &str = "schema: spec-driven\ncreated: 2026-07-01\n";

    const ROUND_1: &str = "**Scope**: crates/a/src/lib.rs, crates/b/src/util.rs\n\n- [CRITICAL] crates/a/src/lib.rs — unwrap on user input\n- [SUGGESTION] crates/b/src/util.rs — rename helper\n";
    const ROUND_2: &str = "**Scope**: crates/a/src/lib.rs\n\n- [WARNING] crates/a/src/lib.rs — possible Feature Envy\n";
    const SUGGESTION_ROUND: &str =
        "**Scope**: crates/b/src/util.rs\n\n- [SUGGESTION] crates/b/src/util.rs — rename helper\n";

    fn store_with_change() -> TestStore {
        TestStore::with_meta("demo", META)
    }

    /// total 个写码任务、前 done 个已勾（无 `[M]`）——失效判定的计数输入。
    fn code_counts(total: usize, done: usize) -> crate::tasks::Counts {
        let md: String =
            (0..total).map(|i| if i < done { "- [x] t\n" } else { "- [ ] t\n" }).collect();
        crate::tasks::counts(&crate::tasks::parse(&md))
    }

    // --- spec「审查工单的创建与追加」---

    #[test]
    fn add_round_creates_ticket_with_round_1_on_first_call() {
        // spec Scenario「首轮创建工单」：无工单＋合法内容 → 建档且自 Round 1 起算。
        let store = store_with_change();
        let round = add_round(&REVIEW, &store, "demo", ROUND_1).expect("first round");
        assert_eq!(round, 1);
        let doc = store.read_artifact("demo", REVIEW_DOC).expect("ticket must be created");
        assert!(doc.contains("## Round 1"), "fixed skeleton must carry the round header: {doc}");
        assert!(
            doc.contains("**Scope**: crates/a/src/lib.rs"),
            "round content must be carried verbatim: {doc}"
        );
    }

    #[test]
    fn add_round_appends_round_2_keeping_round_1_byte_identical() {
        // spec Scenario「追加轮次不改写既有轮」：append-only，Round 1 比特级不变。
        let store = store_with_change();
        add_round(&REVIEW, &store, "demo", ROUND_1).expect("first round");
        let after_first = store.read_artifact("demo", REVIEW_DOC).expect("ticket");
        let round = add_round(&REVIEW, &store, "demo", ROUND_2).expect("second round");
        assert_eq!(round, 2);
        let after_second = store.read_artifact("demo", REVIEW_DOC).expect("ticket");
        assert!(
            after_second.starts_with(&after_first),
            "append-only: Round 1 must stay byte-identical\nbefore: {after_first}\nafter: {after_second}"
        );
        assert!(after_second.contains("## Round 2"));
    }

    #[test]
    fn add_round_rejects_missing_change_without_writing() {
        // spec Scenario「change 不存在」：拒绝且无文件创建。
        let store = store_with_change();
        let err = add_round(&REVIEW, &store, "ghost", ROUND_1).expect_err("missing change must be rejected");
        assert!(err.to_string().contains("ghost"), "error must name the change: {err}");
        // 沿 in-progress add／set_board_rank 的同款防护：非单一路径段名称拒绝。
        assert!(add_round(&REVIEW, &store, "../evil", ROUND_1).is_err());
        assert_eq!(*store.artifact_writes.borrow(), 0, "refusal must not write");
    }

    #[test]
    fn add_round_rejects_content_without_scope_without_writing() {
        // spec Scenario「内容缺少 Scope」：缺 `**Scope**:`（或清单为空）→ 拒绝、工单不变。
        let store = store_with_change();
        for bad in ["", "   \n", "- [CRITICAL] a.rs — no scope line\n", "**Scope**:  \n"] {
            let res = add_round(&REVIEW, &store, "demo", bad);
            let Err(err) = res else {
                panic!("content {bad:?} must be rejected");
            };
            assert!(err.to_string().contains("**Scope**:"), "error must explain the format: {err}");
        }
        assert_eq!(*store.artifact_writes.borrow(), 0, "refusal must not write");
        assert!(!store.artifact_exists("demo", REVIEW_DOC));
    }

    #[test]
    fn add_round_rejects_malformed_findings_and_round_header_injection() {
        // 系统边界验证（stdin 为外部输入）：severity 非三档之一、findings 行文法
        // 破损、或内容夹带 `## ` 行（伪造轮次分隔）→ 拒绝且零写入。
        let store = store_with_change();
        for bad in [
            "**Scope**: a.rs\n- [BLOCKER] a.rs — unknown severity\n",
            "**Scope**: a.rs\n- [CRITICAL a.rs — unclosed bracket\n",
            "**Scope**: a.rs\n## Round 99\n",
        ] {
            assert!(add_round(&REVIEW, &store, "demo", bad).is_err(), "content {bad:?} must be rejected");
        }
        assert_eq!(*store.artifact_writes.borrow(), 0, "refusal must not write");
    }

    // --- spec「审查工单的读取」---

    #[test]
    fn show_round_trips_rounds_scope_findings_and_last_round() {
        // spec Scenario「读取既有工单的 JSON」的解析内核：rounds 长度、每轮 index、
        // scope 清单与分级 findings 逐字段；lastRound 指向末轮。
        let store = store_with_change();
        add_round(&REVIEW, &store, "demo", ROUND_1).expect("round 1");
        add_round(&REVIEW, &store, "demo", ROUND_2).expect("round 2");
        let ticket = show(&REVIEW, &store, "demo").expect("ticket parses");
        assert_eq!(ticket.rounds.len(), 2);
        let r1 = &ticket.rounds[0];
        assert_eq!(r1.index, 1);
        assert_eq!(
            r1.scope,
            vec!["crates/a/src/lib.rs".to_string(), "crates/b/src/util.rs".to_string()]
        );
        assert_eq!(
            r1.findings,
            vec![
                Finding {
                    severity: Severity::Critical,
                    path: "crates/a/src/lib.rs".to_string(),
                    text: "unwrap on user input".to_string(),
                },
                Finding {
                    severity: Severity::Suggestion,
                    path: "crates/b/src/util.rs".to_string(),
                    text: "rename helper".to_string(),
                },
            ]
        );
        let last = ticket.last_round();
        assert_eq!(last.index, 2);
        assert_eq!(last.scope, vec!["crates/a/src/lib.rs".to_string()]);
        assert_eq!(last.findings.len(), 1);
        assert_eq!(last.findings[0].severity, Severity::Warning);
        assert_eq!(last.findings[0].text, "possible Feature Envy");
    }

    #[test]
    fn show_errors_when_change_has_no_ticket() {
        // spec Scenario「无工单」：非零收场的内核语意——错误说明该 change 无工单。
        let store = store_with_change();
        let err = show(&REVIEW, &store, "demo").expect_err("no ticket must error");
        assert!(err.to_string().contains("no review ticket"), "error must say so: {err}");
    }

    // --- spec「放弃审查」---

    #[test]
    fn discard_deletes_ticket_and_leaves_meta_untouched() {
        // spec Scenario「放弃既有工单」：工单删除、`.meta.yaml` 比特级不变。
        let store = store_with_change();
        add_round(&REVIEW, &store, "demo", ROUND_1).expect("round 1");
        discard(&REVIEW, &store, "demo").expect("discard");
        assert!(!store.artifact_exists("demo", REVIEW_DOC), "ticket must be gone");
        assert_eq!(store.meta("demo"), META, "metadata must stay byte-identical");
        assert_eq!(*store.meta_writes.borrow(), 0, "discard must not write metadata");
    }

    #[test]
    fn discard_errors_when_no_ticket() {
        // spec Scenario「无工单可放弃」。
        let store = store_with_change();
        let err = discard(&REVIEW, &store, "demo").expect_err("no ticket must error");
        assert!(err.to_string().contains("no review ticket"), "error must say so: {err}");
    }

    // --- spec「盖章守门与盖章效果」---

    const TASKS_5_DONE: &str = "- [x] 1 a\n- [x] 2 b\n- [x] 3 c\n- [x] 4 d\n- [x] 5 e\n";
    const TASKS_4_OF_5: &str = "- [x] 1 a\n- [x] 2 b\n- [x] 3 c\n- [x] 4 d\n- [ ] 5 e\n";
    /// 四个写码任务全勾、第五个是未勾的 `[M]` 手测——写码任务全完成预测子成立。
    const TASKS_CODE_DONE_MANUAL_OPEN: &str =
        "- [x] 1 a\n- [x] 2 b\n- [x] 3 c\n- [x] 4 d\n- [ ] [M] 5 手测\n";
    const CLEAN_ROUND: &str = "**Scope**: crates/a/src/lib.rs\n";

    const FILE_A: &str = "fn a() {}\n";
    const FILE_B: &str = "fn b() {}\n";

    /// repo 文件读取替身：固定 (path, content) 表（读档闭包吃字节）。
    fn files<'a>(map: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<Vec<u8>> + 'a {
        move |p: &str| map.iter().find(|(k, _)| *k == p).map(|(_, v)| v.as_bytes().to_vec())
    }

    /// repo 文件存在替身：与 `files` 共用同一张表。
    fn present<'a>(map: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> bool + 'a {
        move |p: &str| map.iter().any(|(k, _)| *k == p)
    }

    /// 非 UTF-8 字节替身（PNG 式档头；0x89 开头即非法 UTF-8）。
    const BIN_A: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0xFF, 0x00];

    /// repo 字节读取替身：binary scope 案例用（文本案例走 `files`）。
    fn byte_files<'a>(map: &'a [(&'a str, &'a [u8])]) -> impl Fn(&str) -> Option<Vec<u8>> + 'a {
        move |p: &str| map.iter().find(|(k, _)| *k == p).map(|(_, v)| v.to_vec())
    }

    /// repo 文件存在替身：与 `byte_files` 共用同一张表。
    fn byte_present<'a>(map: &'a [(&'a str, &'a [u8])]) -> impl Fn(&str) -> bool + 'a {
        move |p: &str| map.iter().any(|(k, _)| *k == p)
    }

    const REPO: &[(&str, &str)] =
        &[("crates/a/src/lib.rs", FILE_A), ("crates/b/src/util.rs", FILE_B)];

    fn stamp_demo(store: &TestStore, accept: bool) -> Result<()> {
        stamp(
            &REVIEW,
            store,
            "demo",
            accept,
            Some("Rev <r@example.com>"),
            Some("claude"),
            None,
            &files(REPO),
            &present(REPO),
        )
    }

    #[test]
    fn stamp_refuses_when_tasks_incomplete() {
        // spec Scenario「任务未全完成即拒绝」：4/5 → 拒绝，metadata 与工单皆不变。
        let store = store_with_change();
        store.put_artifact("demo", "tasks.md", TASKS_4_OF_5);
        add_round(&REVIEW, &store, "demo", CLEAN_ROUND).expect("round 1");
        let err = stamp_demo(&store, false).expect_err("incomplete tasks must refuse");
        assert!(err.to_string().contains("4/5"), "error must show the count: {err}");
        assert_eq!(store.meta("demo"), META, "metadata must stay byte-identical");
        assert_eq!(*store.meta_writes.borrow(), 0);
        assert!(store.artifact_exists("demo", REVIEW_DOC), "ticket must survive refusal");
    }

    #[test]
    fn stamp_lands_when_only_manual_tasks_remain_and_anchors_the_full_total() {
        // spec Scenario「仅余手动任务可盖章」＋Example「盖章写入的任务锚」：
        // 写码 4/4 全勾、一个 [M] 未勾 → 盖章成功，锚为全任务总数 5（含 [M]）。
        let store = store_with_change();
        store.put_artifact("demo", "tasks.md", TASKS_CODE_DONE_MANUAL_OPEN);
        add_round(&REVIEW, &store, "demo", CLEAN_ROUND).expect("round 1");
        stamp_demo(&store, false).expect("manual-only remainder must stamp");
        let meta = crate::model::ChangeMeta::from_text(Some(&store.meta("demo"))).expect("meta");
        assert_eq!(meta.reviewed_tasks_total, Some(5), "anchor counts the [M] task too");
        assert!(!store.artifact_exists("demo", REVIEW_DOC), "ticket must be deleted");
    }

    #[test]
    fn stamp_refusal_names_the_code_task_counts() {
        // 拒绝消息点名写码任务——手测任务不计入计数。
        let store = store_with_change();
        store.put_artifact("demo", "tasks.md", "- [x] a\n- [ ] b\n- [ ] [M] 手测\n");
        add_round(&REVIEW, &store, "demo", CLEAN_ROUND).expect("round 1");
        let err = stamp_demo(&store, false).expect_err("open code task must refuse");
        let msg = err.to_string();
        assert!(msg.contains("1/2"), "counts must exclude the [M] task: {msg}");
        assert!(msg.contains("code task"), "message must name code tasks: {msg}");
    }

    #[test]
    fn stamp_refuses_unresolved_findings_without_accept() {
        // spec Scenario「末轮有未解 findings 且未带 --accept」：拒绝并提示 --accept。
        let store = store_with_change();
        store.put_artifact("demo", "tasks.md", TASKS_5_DONE);
        add_round(&REVIEW, &store, "demo", ROUND_1).expect("round with findings");
        let err = stamp_demo(&store, false).expect_err("unresolved findings must refuse");
        assert!(err.to_string().contains("--accept"), "error must offer --accept: {err}");
        assert_eq!(*store.meta_writes.borrow(), 0);
        assert!(store.artifact_exists("demo", REVIEW_DOC));
    }

    #[test]
    fn stamp_with_accept_overrides_findings_and_stamps() {
        // spec Scenario「带保留盖章」：--accept → 章写入且工单删除。
        let store = store_with_change();
        store.put_artifact("demo", "tasks.md", TASKS_5_DONE);
        add_round(&REVIEW, &store, "demo", ROUND_1).expect("round with findings");
        stamp_demo(&store, true).expect("--accept must stamp");
        assert!(!store.artifact_exists("demo", REVIEW_DOC), "ticket must be deleted");
        let meta = ChangeMeta::from_text(Some(&store.meta("demo"))).expect("meta parses");
        assert!(meta.reviewed_at.is_some());
    }

    #[test]
    fn stamp_allows_a_suggestion_only_last_round() {
        // spec Scenario「仅 SUGGESTION 的末轮干净盖章」：SUGGESTION 不是必修，
        // 无 --accept 也放行——五栏写入且工单删除。分界计数本身归
        // station.rs 的守门测试；这里钉站别 wiring 与盖章效果。
        let store = store_with_change();
        store.put_artifact("demo", "tasks.md", TASKS_5_DONE);
        add_round(&REVIEW, &store, "demo", SUGGESTION_ROUND).expect("suggestion-only round");
        stamp_demo(&store, false).expect("suggestion-only round must stamp clean");
        assert!(!store.artifact_exists("demo", REVIEW_DOC), "ticket must be deleted");
        let meta = ChangeMeta::from_text(Some(&store.meta("demo"))).expect("meta parses");
        assert_eq!(meta.reviewed_at.as_deref(), Some(crate::util::today().as_str()));
        assert_eq!(meta.reviewed_by.as_deref(), Some("Rev <r@example.com>"));
        assert_eq!(meta.reviewed_with.as_deref(), Some("claude"));
        assert_eq!(meta.reviewed_tasks_total, Some(5));
        assert!(!meta.reviewed_scope.is_empty(), "scope fingerprints must be recorded");
    }

    #[test]
    fn stamp_clean_round_writes_five_fields_and_deletes_ticket() {
        // spec Scenario「干净盖章」＋Example「盖章写入的任务锚」：5/5 任务、末轮
        // 零 findings → 五字段齐备（reviewed_tasks_total 为 5）、工单不存在。
        let store = store_with_change();
        store.put_artifact("demo", "tasks.md", TASKS_5_DONE);
        add_round(&REVIEW, &store, "demo", ROUND_1).expect("round 1 with findings");
        add_round(&REVIEW, &store, "demo", CLEAN_ROUND).expect("round 2 clean");
        stamp_demo(&store, false).expect("clean stamp");
        assert!(!store.artifact_exists("demo", REVIEW_DOC), "ticket must be deleted");
        let raw = store.meta("demo");
        let meta = ChangeMeta::from_text(Some(&raw)).expect("meta parses");
        assert_eq!(meta.reviewed_at.as_deref(), Some(crate::util::today().as_str()));
        assert_eq!(meta.reviewed_by.as_deref(), Some("Rev <r@example.com>"));
        assert_eq!(meta.reviewed_with.as_deref(), Some("claude"));
        assert_eq!(meta.reviewed_tasks_total, Some(5));
        assert!(!meta.reviewed_scope.is_empty(), "scope fingerprints must be recorded");
        assert!(raw.starts_with(META), "existing fields preserved byte-for-byte: {raw}");
    }

    #[test]
    fn stamp_scope_is_sorted_union_of_all_rounds() {
        // design D3：指纹范围＝工单各轮 Scope 联集（去重、排序保确定性）。
        let store = store_with_change();
        store.put_artifact("demo", "tasks.md", TASKS_5_DONE);
        add_round(&REVIEW, &store, "demo", ROUND_1).expect("round 1: a + b");
        add_round(&REVIEW, &store, "demo", CLEAN_ROUND).expect("round 2: a only");
        stamp_demo(&store, false).expect("stamp");
        let meta = ChangeMeta::from_text(Some(&store.meta("demo"))).expect("meta parses");
        let paths: Vec<&str> = meta.reviewed_scope.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, vec!["crates/a/src/lib.rs", "crates/b/src/util.rs"]);
        assert_eq!(meta.reviewed_scope[0].hash, content_fingerprint(FILE_A));
        assert_eq!(meta.reviewed_scope[1].hash, content_fingerprint(FILE_B));
    }

    #[test]
    fn stamp_normalizes_backslash_paths_into_meta() {
        // design D3：Windows 路径 `\` → `/` 范式后写入 reviewed_scope。
        let store = store_with_change();
        store.put_artifact("demo", "tasks.md", TASKS_5_DONE);
        add_round(&REVIEW, &store, "demo", "**Scope**: crates\\a\\src\\lib.rs\n").expect("round");
        stamp_demo(&store, false).expect("stamp");
        let meta = ChangeMeta::from_text(Some(&store.meta("demo"))).expect("meta parses");
        assert_eq!(meta.reviewed_scope[0].path, "crates/a/src/lib.rs");
    }

    #[test]
    fn stamp_refuses_when_no_ticket_or_every_scope_file_gone() {
        // 无工单不可盖章；联集全数消失代表工作树与工单严重脱节——跳过到一个
        // 不剩就不是「审查过」，fail-closed 并指名文件与处置。
        let store = store_with_change();
        store.put_artifact("demo", "tasks.md", TASKS_5_DONE);
        let err = stamp_demo(&store, false).expect_err("no ticket must refuse");
        assert!(err.to_string().contains("no review ticket"), "{err}");
        add_round(&REVIEW, &store, "demo", "**Scope**: gone/missing.rs\n").expect("round");
        let err = stamp_demo(&store, false).expect_err("all-gone scope must refuse");
        assert!(err.to_string().contains("gone/missing.rs"), "error must name the file: {err}");
        assert_eq!(*store.meta_writes.borrow(), 0);
    }

    #[test]
    fn stamp_skips_scope_files_deleted_by_later_fixes() {
        // 引擎死档卡章（Round 5 必修）：修正把早轮审过的档删除／改名后，联集
        // 中的死档无从指纹也无从再变动——跳过不入锚，其余照常，盖章不得永久
        // 卡死。存在但读不到者仍 fail-closed（见 stamp_reports_unreadable_*）。
        let store = store_with_change();
        store.put_artifact("demo", "tasks.md", TASKS_5_DONE);
        add_round(&REVIEW, &store, "demo", ROUND_1).expect("round 1: a + b");
        add_round(&REVIEW, &store, "demo", CLEAN_ROUND).expect("round 2 clean");
        let survivors: &[(&str, &str)] = &[("crates/a/src/lib.rs", FILE_A)];
        stamp(&REVIEW, &store, "demo", false, None, None, None, &files(survivors), &present(survivors))
            .expect("deleted scope file must not block the stamp");
        assert!(!store.artifact_exists("demo", REVIEW_DOC), "ticket must be deleted");
        let meta = ChangeMeta::from_text(Some(&store.meta("demo"))).expect("meta parses");
        let paths: Vec<&str> = meta.reviewed_scope.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, vec!["crates/a/src/lib.rs"], "dead path must not be anchored");
    }

    #[test]
    fn stamp_restamp_replaces_reviewed_fields_without_duplication() {
        // 再审后重盖：五字段原位更新（含多行 reviewed_scope 区块），不留重复键，
        // 其余字段逐字节保留——沿 started_*／board_rank 的文本手术纪律。
        let old = "schema: spec-driven\ncreated: 2026-07-01\nreviewed_at: 2026-07-10\nreviewed_by: Old <o@example.com>\nreviewed_with: codex\nreviewed_tasks_total: 3\nreviewed_scope:\n  - path: old/file.rs\n    hash: deadbeef\nboard_rank: n\n";
        let store = TestStore::with_meta("demo", old);
        store.put_artifact("demo", "tasks.md", TASKS_5_DONE);
        add_round(&REVIEW, &store, "demo", CLEAN_ROUND).expect("round");
        stamp_demo(&store, false).expect("re-stamp");
        let raw = store.meta("demo");
        assert_eq!(raw.matches("reviewed_at:").count(), 1, "no duplicate keys: {raw}");
        assert_eq!(raw.matches("reviewed_scope:").count(), 1, "no duplicate keys: {raw}");
        assert!(!raw.contains("old/file.rs"), "stale scope block must be gone: {raw}");
        assert!(raw.contains("schema: spec-driven\n"), "{raw}");
        assert!(raw.contains("created: 2026-07-01\n"), "{raw}");
        assert!(raw.contains("board_rank: n\n"), "{raw}");
        let meta = ChangeMeta::from_text(Some(&raw)).expect("meta parses");
        assert_eq!(meta.reviewed_tasks_total, Some(5));
        assert_eq!(meta.reviewed_scope.len(), 1);
        assert_eq!(meta.reviewed_scope[0].path, "crates/a/src/lib.rs");
    }

    #[test]
    fn stamp_refuses_on_corrupt_meta_without_writing() {
        // 沿 set_board_rank 的 fail-closed gate：坏 metadata 不得被叠写。
        const BAD: &str = ": : :\n\t bad yaml [unclosed\n";
        let store = TestStore::with_meta("demo", BAD);
        store.put_artifact("demo", "tasks.md", TASKS_5_DONE);
        add_round(&REVIEW, &store, "demo", CLEAN_ROUND).expect("round");
        let err = stamp_demo(&store, false).expect_err("corrupt meta must refuse");
        assert!(
            err.to_string().contains("specseal/changes/demo/.meta.yaml"),
            "error must name the metadata file: {err}"
        );
        assert_eq!(store.meta("demo"), BAD);
        assert_eq!(*store.meta_writes.borrow(), 0);
        assert!(store.artifact_exists("demo", REVIEW_DOC), "ticket must survive refusal");
    }

    // --- design D4a：scope 注入盖章（remote 承载）---

    #[test]
    fn stamp_with_scope_stamps_using_provided_entries() {
        // D4a：工作树持有者（remote CLI）预算好的 (path, hash) 直接入章，server
        // 不重算；乱序提交仍按 path 排序落章（决定性）。
        let store = store_with_change();
        store.put_artifact("demo", "tasks.md", TASKS_5_DONE);
        add_round(&REVIEW, &store, "demo", ROUND_1).expect("round with findings");
        add_round(&REVIEW, &store, "demo", CLEAN_ROUND).expect("clean round");
        let entries = vec![
            scope_entry("crates/b/src/util.rs", &content_fingerprint(FILE_B)),
            scope_entry("crates/a/src/lib.rs", &content_fingerprint(FILE_A)),
        ];
        stamp_with_scope(&REVIEW, &store, "demo", false, Some("Rev <r@example.com>"), Some("claude"), None, entries, vec![])
            .expect("provided-scope stamp");
        assert!(!store.artifact_exists("demo", REVIEW_DOC), "ticket must be deleted");
        let meta = ChangeMeta::from_text(Some(&store.meta("demo"))).expect("meta parses");
        let paths: Vec<&str> = meta.reviewed_scope.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, ["crates/a/src/lib.rs", "crates/b/src/util.rs"]);
        assert_eq!(meta.reviewed_scope[0].hash, content_fingerprint(FILE_A));
        assert_eq!(meta.reviewed_tasks_total, Some(5));
    }

    #[test]
    fn stamp_with_scope_rejects_path_set_mismatch_without_writing() {
        // D4a：提交 path 集合与工单各轮 Scope 联集不完全相等（CAS 式保护——
        // 工单在读取后被追加轮次）→ 拒绝并指名差集，工单与 meta 皆不动。
        let store = store_with_change();
        store.put_artifact("demo", "tasks.md", TASKS_5_DONE);
        add_round(&REVIEW, &store, "demo", ROUND_1).expect("round"); // 联集：a + b
        let missing = vec![scope_entry("crates/a/src/lib.rs", &content_fingerprint(FILE_A))];
        let err = stamp_with_scope(&REVIEW, &store, "demo", true, None, None, None, missing, vec![])
            .expect_err("missing path must refuse");
        assert!(err.to_string().contains("crates/b/src/util.rs"), "must name the gap: {err}");
        let extra = vec![
            scope_entry("crates/a/src/lib.rs", &content_fingerprint(FILE_A)),
            scope_entry("crates/b/src/util.rs", &content_fingerprint(FILE_B)),
            scope_entry("crates/c/extra.rs", &content_fingerprint("x")),
        ];
        let err = stamp_with_scope(&REVIEW, &store, "demo", true, None, None, None, extra, vec![])
            .expect_err("extra path must refuse");
        assert!(err.to_string().contains("crates/c/extra.rs"), "must name the extra: {err}");
        assert_eq!(*store.meta_writes.borrow(), 0);
        assert!(store.artifact_exists("demo", REVIEW_DOC), "ticket must survive refusal");
    }

    #[test]
    fn stamp_with_scope_rejects_duplicate_paths_without_writing() {
        // D4a 的集合相等是「集合」——同一 path 提交两份哈希时差集皆空而蒙混过关，
        // 章会落两笔同 path，freshness 逐笔比对必有一笔不符 → 该章永远 stale。
        let store = store_with_change();
        store.put_artifact("demo", "tasks.md", TASKS_5_DONE);
        add_round(&REVIEW, &store, "demo", CLEAN_ROUND).expect("round"); // 联集：a
        let dupes = vec![
            scope_entry("crates/a/src/lib.rs", &content_fingerprint(FILE_A)),
            scope_entry("crates/a/src/lib.rs", &content_fingerprint("tampered")),
        ];
        let err = stamp_with_scope(&REVIEW, &store, "demo", true, None, None, None, dupes, vec![])
            .expect_err("duplicate path must refuse");
        assert!(err.to_string().contains("crates/a/src/lib.rs"), "must name the dupe: {err}");
        assert_eq!(*store.meta_writes.borrow(), 0);
        assert!(store.artifact_exists("demo", REVIEW_DOC), "ticket must survive refusal");
    }

    fn scope_entry(path: &str, hash: &str) -> crate::model::ReviewedScopeEntry {
        crate::model::ReviewedScopeEntry { path: path.to_string(), hash: hash.to_string() }
    }

    #[test]
    fn stamp_with_scope_accepts_a_declared_missing_partition() {
        // 引擎死档卡章的 remote 面（Round 5 必修）：server 无工作树，文件是否
        // 仍存在只有 checkout 持有者知道——client 明示声明 missing，server 验
        // 「provided ∪ missing ＝联集且不相交」后放行，章只锚仍存在的档。
        let store = store_with_change();
        store.put_artifact("demo", "tasks.md", TASKS_5_DONE);
        add_round(&REVIEW, &store, "demo", ROUND_1).expect("round: a + b");
        add_round(&REVIEW, &store, "demo", CLEAN_ROUND).expect("clean round");
        let entries = vec![scope_entry("crates/a/src/lib.rs", &content_fingerprint(FILE_A))];
        stamp_with_scope(
            &REVIEW,
            &store,
            "demo",
            false,
            None,
            None,
            None,
            entries,
            vec!["crates/b/src/util.rs".into()],
        )
        .expect("declared-missing partition must stamp");
        let meta = ChangeMeta::from_text(Some(&store.meta("demo"))).expect("meta parses");
        let paths: Vec<&str> = meta.reviewed_scope.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, vec!["crates/a/src/lib.rs"], "declared-missing path must not anchor");
    }

    #[test]
    fn stamp_with_scope_rejects_bad_missing_declarations() {
        // 分割不成立即拒：missing 与 provided 重叠、声明联集外的路径、或声明到
        // 一个不剩——工单与 meta 皆不动。
        let store = store_with_change();
        store.put_artifact("demo", "tasks.md", TASKS_5_DONE);
        add_round(&REVIEW, &store, "demo", CLEAN_ROUND).expect("round"); // 联集：a
        let a_entry = || vec![scope_entry("crates/a/src/lib.rs", &content_fingerprint(FILE_A))];
        let err = stamp_with_scope(
            &REVIEW,
            &store,
            "demo",
            true,
            None,
            None,
            None,
            a_entry(),
            vec!["crates/a/src/lib.rs".into()],
        )
        .expect_err("overlap must refuse");
        assert!(err.to_string().contains("crates/a/src/lib.rs"), "names the overlap: {err}");
        let err =
            stamp_with_scope(&REVIEW, &store, "demo", true, None, None, None, a_entry(), vec!["not/in/union.rs".into()])
                .expect_err("outside-union declaration must refuse");
        assert!(err.to_string().contains("not/in/union.rs"), "names the stray: {err}");
        let err =
            stamp_with_scope(&REVIEW, &store, "demo", true, None, None, None, vec![], vec!["crates/a/src/lib.rs".into()])
                .expect_err("empty remainder must refuse");
        assert!(err.to_string().contains("crates/a/src/lib.rs"), "names the gone files: {err}");
        assert_eq!(*store.meta_writes.borrow(), 0);
        assert!(store.artifact_exists("demo", REVIEW_DOC), "ticket must survive refusals");
    }

    #[test]
    fn stamp_quotes_scope_scalars_so_yaml_metacharacters_survive() {
        // path 以未引号纯量写出时，「空白＋#」会被当注解截断（该档永远 stale），
        // 而 `@`／`*`／`&`／`!` 开头让整份 .meta.yaml 解析失败——之后所有
        // 动词对该 change fail-closed。写入端负责引号。
        let store = store_with_change();
        store.put_artifact("demo", "tasks.md", TASKS_5_DONE);
        add_round(&REVIEW, &store, "demo", "**Scope**: src/@odd #1.rs\n").expect("round");
        let repo: &[(&str, &str)] = &[("src/@odd #1.rs", FILE_A)];
        stamp(&REVIEW, &store, "demo", false, None, None, None, &files(repo), &present(repo)).expect("stamp");
        let raw = store.meta("demo");
        let meta = ChangeMeta::from_text(Some(&raw)).expect("re-parse must survive: {raw}");
        assert_eq!(meta.reviewed_scope.len(), 1);
        assert_eq!(meta.reviewed_scope[0].path, "src/@odd #1.rs", "path round-trips: {raw}");
        assert_eq!(meta.reviewed_scope[0].hash, content_fingerprint(FILE_A));
    }

    #[test]
    fn restamp_strips_a_scope_block_containing_blank_lines() {
        // 手改过的 meta 可能在 reviewed_scope 区块里留空行；把空行当区块结束会
        // 让其后的缩进项原样留下，重盖后成「mapping 接孤立缩进串行」而解析不能。
        let old = "schema: spec-driven\nreviewed_at: 2026-07-10\nreviewed_tasks_total: 3\nreviewed_scope:\n  - path: old/a.rs\n    hash: dead\n\n  - path: old/b.rs\n    hash: beef\ncreated: 2026-07-01\n";
        let store = TestStore::with_meta("demo", old);
        store.put_artifact("demo", "tasks.md", TASKS_5_DONE);
        add_round(&REVIEW, &store, "demo", CLEAN_ROUND).expect("round");
        stamp_demo(&store, false).expect("re-stamp");
        let raw = store.meta("demo");
        assert!(!raw.contains("old/a.rs"), "stale scope must be gone: {raw}");
        assert!(!raw.contains("old/b.rs"), "stale scope must be gone across the blank: {raw}");
        assert!(raw.contains("created: 2026-07-01\n"), "unrelated fields survive: {raw}");
        let meta = ChangeMeta::from_text(Some(&raw)).expect("re-stamped meta must still parse");
        assert_eq!(meta.reviewed_scope.len(), 1);
    }

    #[test]
    fn stamp_reports_unreadable_scope_files_without_claiming_they_are_missing() {
        // read_file 回 None 是 I/O 失败（如 EACCES；非 UTF-8 不是读取失败，走位
        // 元组指纹）——说成「不存在」会把人送去找一个明明还在的档。
        let store = store_with_change();
        store.put_artifact("demo", "tasks.md", TASKS_5_DONE);
        add_round(&REVIEW, &store, "demo", "**Scope**: assets/logo.png\n").expect("round");
        let err = stamp(&REVIEW, &store, "demo", false, None, None, None, &files(&[]), &|_: &str| true)
            .expect_err("must refuse");
        let msg = err.to_string();
        assert!(msg.contains("assets/logo.png"), "names the file: {msg}");
        assert!(
            !msg.contains("does not exist"),
            "must not assert absence it cannot know: {msg}"
        );
    }

    #[test]
    fn stamp_records_byte_hash_for_non_utf8_scope_and_freshness_tracks_bytes() {
        // spec Scenario「非 UTF-8 scope 档可盖章」＋「盖章后 binary 内容变动失效」：
        // reviewed_scope 记原始字节 SHA-256；失效判定共用同一分流。
        let store = store_with_change();
        store.put_artifact("demo", "tasks.md", TASKS_5_DONE);
        add_round(&REVIEW, &store, "demo", "**Scope**: assets/logo.png\n").expect("round");
        let repo: &[(&str, &[u8])] = &[("assets/logo.png", BIN_A)];
        stamp(&REVIEW, &store, "demo", false, None, None, None, &byte_files(repo), &byte_present(repo))
            .expect("a present non-UTF-8 scope file must stamp");
        let meta = ChangeMeta::from_text(Some(&store.meta("demo"))).expect("meta parses");
        // 字节规则本身由 content_fingerprint_bytes 的 golden 测试钉住；这里钉
        // 站别 wiring：章字段记的就是分流入口算出的值。
        assert_eq!(meta.reviewed_scope[0].hash, content_fingerprint_bytes(BIN_A));
        let counts = code_counts(5, 5);
        assert_eq!(freshness(&REVIEW, &meta, &counts, &byte_files(repo)), Freshness::Fresh);
        const BIN_A_FLIPPED: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0xFF, 0x01];
        let changed: &[(&str, &[u8])] = &[("assets/logo.png", BIN_A_FLIPPED)];
        assert_eq!(freshness(&REVIEW, &meta, &counts, &byte_files(changed)), Freshness::Stale);
    }

    #[test]
    fn stamp_survives_identity_and_agent_strings_carrying_yaml_indicators() {
        // `--agent "codex: cli"`、含 `#` 的 git user.name、或带换行的身分字符串以
        // 纯量直写会注入字段或整份炸掉——而工单已在同一步删除，无从回复。
        // 沿 started_* 的既有 clean() 纪律：控制字符压平、危险纯量加引号。
        let store = store_with_change();
        store.put_artifact("demo", "tasks.md", TASKS_5_DONE);
        add_round(&REVIEW, &store, "demo", CLEAN_ROUND).expect("round");
        stamp(
            &REVIEW,
            &store,
            "demo",
            false,
            Some("Rev: the #1 <r@example.com>\nboard_rank: injected"),
            Some("codex: cli"),
            None,
            &files(REPO),
            &present(REPO),
        )
        .expect("stamp");
        let raw = store.meta("demo");
        let meta = ChangeMeta::from_text(Some(&raw)).expect("meta must still parse: {raw}");
        assert_eq!(meta.reviewed_with.as_deref(), Some("codex: cli"), "{raw}");
        assert!(
            meta.reviewed_by.as_deref().is_some_and(|by| by.starts_with("Rev: the #1")),
            "identity round-trips: {raw}"
        );
        assert!(!raw.contains("\nboard_rank: injected"), "no field injection: {raw}");
    }

    #[test]
    fn stamp_with_scope_survives_a_hash_carrying_a_newline() {
        // 提交的 hash 未经文法验证（server 不重算），换行会让双引号纯量跨行、
        // 续行落在第 0 栏 → meta 解析不能。
        let store = store_with_change();
        store.put_artifact("demo", "tasks.md", TASKS_5_DONE);
        add_round(&REVIEW, &store, "demo", CLEAN_ROUND).expect("round");
        let entries = vec![scope_entry("crates/a/src/lib.rs", "dead\nbeef: injected")];
        stamp_with_scope(&REVIEW, &store, "demo", false, None, None, None, entries, vec![]).expect("stamp");
        let raw = store.meta("demo");
        ChangeMeta::from_text(Some(&raw)).expect("meta must still parse: {raw}");
        assert!(!raw.contains("\nbeef: injected"), "no field injection: {raw}");
    }

    #[test]
    fn restamp_strips_a_top_level_scope_sequence() {
        // `reviewed_scope:` 之下的串行项在第 0 栏也是合法 YAML；只认缩进区块会把
        // `- path:` 留下，重盖后 meta 成 mapping 混 sequence、之后所有动词 fail-closed。
        let old = "schema: spec-driven\nreviewed_at: 2026-07-10\nreviewed_tasks_total: 3\nreviewed_scope:\n- path: old/file.rs\n  hash: deadbeef\n";
        let store = TestStore::with_meta("demo", old);
        store.put_artifact("demo", "tasks.md", TASKS_5_DONE);
        add_round(&REVIEW, &store, "demo", CLEAN_ROUND).expect("round");
        stamp_demo(&store, false).expect("re-stamp");
        let raw = store.meta("demo");
        assert!(!raw.contains("old/file.rs"), "stale scope sequence must be gone: {raw}");
        let meta = ChangeMeta::from_text(Some(&raw)).expect("re-stamped meta must still parse");
        assert_eq!(meta.reviewed_scope.len(), 1);
        assert_eq!(meta.reviewed_scope[0].path, "crates/a/src/lib.rs");
    }

    #[test]
    fn add_round_rejects_scope_paths_that_escape_the_repo_root() {
        // Scope 是指纹读档的路径来源，而读档以 `root.join(p)` 解析——绝对路径会
        // 取代 root、`..` 会往上爬。remote 模式的工单来自 server，等于由 server
        // 指定 client 读哪个本机档，故守门落在文法层（stdin 与工单解析共用）。
        let store = store_with_change();
        for bad in [
            "**Scope**: /etc/passwd\n",
            "**Scope**: ../../../etc/passwd\n",
            "**Scope**: crates/../../secrets.rs\n",
            "**Scope**: C:\\Windows\\win.ini\n",
        ] {
            let Err(err) = add_round(&REVIEW, &store, "demo", bad) else {
                panic!("scope {bad:?} must be rejected");
            };
            assert!(
                err.to_string().contains("repo-root relative"),
                "error must explain the requirement: {err}"
            );
        }
        assert_eq!(*store.artifact_writes.borrow(), 0, "refusal must not write");
    }

    // --- spec「审查工单的创建与追加」：structured rounds（Phase／Patch 成对）---

    fn structured_round(phase: &str, hex: &str) -> String {
        format!(
            "**Phase**: {phase}\n**Patch**: sha256:{hex}\n**Scope**: src/lib.rs\n\n- [CRITICAL] src/lib.rs — unwrap on user input\n"
        )
    }

    #[test]
    fn structured_discovery_round_parses_phase_and_patch_hash() {
        // spec Scenario「首轮创建 structured discovery 工单」的解析内核。
        let store = store_with_change();
        let hex = "a".repeat(64);
        add_round(&REVIEW, &store, "demo", &structured_round("discovery", &hex)).expect("structured round");
        let ticket = show(&REVIEW, &store, "demo").expect("ticket parses");
        let round = &ticket.rounds[0];
        assert_eq!(round.phase, Some(RoundPhase::Discovery));
        assert_eq!(round.patch_hash.as_deref(), Some(format!("sha256:{hex}").as_str()));
        // 原文带 phase／patch 行（人眼工单）。
        let doc = store.read_artifact("demo", REVIEW_DOC).expect("ticket doc");
        assert!(doc.contains("**Phase**: discovery"), "{doc}");
        assert!(doc.contains(&format!("**Patch**: sha256:{hex}")), "{doc}");
    }

    #[test]
    fn structured_round_rejects_unpaired_or_malformed_fields_without_writing() {
        // spec Scenario「phase 与 patch 必须成对」＋格式验证：两栏只出现其一、
        // phase token 无效、hash 非 64 lowercase hex → 非零拒绝且工单零写入。
        let store = store_with_change();
        let hex = "a".repeat(64);
        for bad in [
            format!("**Phase**: discovery\n**Scope**: src/lib.rs\n"),
            format!("**Patch**: sha256:{hex}\n**Scope**: src/lib.rs\n"),
            structured_round("exploration", &hex),
            structured_round("discovery", "zz"),
            structured_round("discovery", &"A".repeat(64)),
            format!("**Phase**: discovery\n**Patch**: {hex}\n**Scope**: src/lib.rs\n"),
        ] {
            assert!(add_round(&REVIEW, &store, "demo", &bad).is_err(), "content {bad:?} must be rejected");
        }
        assert_eq!(*store.artifact_writes.borrow(), 0, "refusals must not write");
        assert!(!store.artifact_exists("demo", REVIEW_DOC));
    }

    #[test]
    fn second_discovery_is_rejected_after_a_structured_round() {
        // spec Scenario「第二个 discovery 被拒绝」：后续轮只能是 validation，
        // 工单比特级不变。
        let store = store_with_change();
        let hex = "a".repeat(64);
        add_round(&REVIEW, &store, "demo", &structured_round("discovery", &hex)).expect("round 1");
        let before = store.read_artifact("demo", REVIEW_DOC).expect("ticket");
        let err = add_round(&REVIEW, &store, "demo", &structured_round("discovery", &"b".repeat(64)))
            .expect_err("a second discovery must be rejected");
        assert!(err.to_string().contains("validation"), "error explains the sequence: {err}");
        assert_eq!(store.read_artifact("demo", REVIEW_DOC).as_deref(), Some(before.as_str()));
    }

    #[test]
    fn validation_appends_after_structured_and_legacy_tickets() {
        // spec Scenario「追加 validation 不改写既有轮」＋「legacy ticket 后 SHALL
        // 能追加 validation round」。
        let store = store_with_change();
        add_round(&REVIEW, &store, "demo", &structured_round("discovery", &"a".repeat(64))).expect("r1");
        let before = store.read_artifact("demo", REVIEW_DOC).expect("ticket");
        let round =
            add_round(&REVIEW, &store, "demo", &structured_round("validation", &"b".repeat(64))).expect("r2");
        assert_eq!(round, 2);
        let after = store.read_artifact("demo", REVIEW_DOC).expect("ticket");
        assert!(after.starts_with(&before), "append-only across structured rounds");
        let ticket = show(&REVIEW, &store, "demo").expect("parses");
        assert_eq!(ticket.last_round().phase, Some(RoundPhase::Validation));

        let legacy_store = store_with_change();
        add_round(&REVIEW, &legacy_store, "demo", ROUND_1).expect("legacy r1");
        add_round(&REVIEW, &legacy_store, "demo", &structured_round("validation", &"c".repeat(64)))
            .expect("validation may follow a legacy ticket");
    }

    #[test]
    fn validation_is_rejected_on_a_fresh_ticket() {
        // 无任何轮次可验收：首轮 validation 拒绝、零写入。
        let store = store_with_change();
        let err = add_round(&REVIEW, &store, "demo", &structured_round("validation", &"a".repeat(64)))
            .expect_err("fresh-ticket validation must be rejected");
        assert!(err.to_string().contains("discovery"), "error names the required phase: {err}");
        assert_eq!(*store.artifact_writes.borrow(), 0);
    }

    #[test]
    fn legacy_round_parses_with_null_phase_and_patch() {
        // spec Scenario「legacy round 保持兼容」：两栏缺席解析为 None，既有行为不变。
        let store = store_with_change();
        add_round(&REVIEW, &store, "demo", ROUND_1).expect("legacy round");
        let ticket = show(&REVIEW, &store, "demo").expect("parses");
        assert_eq!(ticket.rounds[0].phase, None);
        assert_eq!(ticket.rounds[0].patch_hash, None);
    }

    // --- spec「审查工单的创建与追加」：套用规则记录（`**Rules**:`／`**Rule**:`）---

    /// discovery 轮：Phase／Patch 之后接 `rules` 这几行规则记录，再接 Scope 与一条 finding。
    fn discovery_with_rules(rules: &str) -> String {
        format!(
            "**Phase**: discovery\n**Patch**: sha256:{}\n{rules}**Scope**: src/lib.rs\n\n\
             - [WARNING] src/lib.rs — possible Feature Envy\n",
            "a".repeat(64)
        )
    }

    fn rules(
        baseline: crate::config::ReviewBaseline,
        critical: &[&str],
        warning: &[&str],
        suggestion: &[&str],
    ) -> crate::config::ReviewConfig {
        let list = |l: &[&str]| l.iter().map(|s| s.to_string()).collect();
        crate::config::ReviewConfig {
            baseline,
            critical: list(critical),
            warning: list(warning),
            suggestion: list(suggestion),
        }
    }

    #[test]
    fn discovery_round_records_applied_rules() {
        // spec Scenario「首轮记录套用规则」：三行规则记录逐字落进 Round 1，
        // 解析成 baseline 与依严重度分组的规则原文。
        let store = store_with_change();
        let lines = "**Rules**: extend\n\
                     **Rule**: CRITICAL 所有 SQL 一律用参数化查找，不得用字符串拼接\n\
                     **Rule**: WARNING 添加的公开 API 要有对应的测试\n";
        add_round(&REVIEW, &store, "demo", &discovery_with_rules(lines)).expect("round with rules");
        let doc = store.read_artifact("demo", REVIEW_DOC).expect("ticket");
        assert!(doc.contains(lines), "rule lines are carried verbatim: {doc}");
        let ticket = show(&REVIEW, &store, "demo").expect("parses");
        assert_eq!(
            ticket.rounds[0].rules,
            Some(rules(
                crate::config::ReviewBaseline::Extend,
                &["所有 SQL 一律用参数化查找，不得用字符串拼接"],
                &["添加的公开 API 要有对应的测试"],
                &[],
            ))
        );
    }

    #[test]
    fn rule_text_is_trimmed_and_keeps_its_order_within_a_severity() {
        // design D2：同一严重度内依出现顺序保留；原文去头尾空白。
        let store = store_with_change();
        let lines = "**Rules**: replace\n\
                     **Rule**: CRITICAL   不得把密钥或密码写死在代码里  \n\
                     **Rule**: SUGGESTION 偏好以提早返回取代深层嵌套\n\
                     **Rule**: CRITICAL 所有 SQL 一律用参数化查找，不得用字符串拼接\n";
        add_round(&REVIEW, &store, "demo", &discovery_with_rules(lines)).expect("round with rules");
        let ticket = show(&REVIEW, &store, "demo").expect("parses");
        assert_eq!(
            ticket.rounds[0].rules,
            Some(rules(
                crate::config::ReviewBaseline::Replace,
                &["不得把密钥或密码写死在代码里", "所有 SQL 一律用参数化查找，不得用字符串拼接"],
                &[],
                &["偏好以提早返回取代深层嵌套"],
            ))
        );
    }

    #[test]
    fn rounds_without_rule_lines_parse_with_no_rules() {
        // 两种行皆选填：structured 与 legacy 轮不带规则记录时 rules 为 None。
        let store = store_with_change();
        add_round(&REVIEW, &store, "demo", &structured_round("discovery", &"a".repeat(64))).expect("r1");
        add_round(&REVIEW, &store, "demo", &structured_round("validation", &"b".repeat(64))).expect("r2");
        let ticket = show(&REVIEW, &store, "demo").expect("parses");
        assert!(ticket.rounds.iter().all(|r| r.rules.is_none()));

        let legacy = store_with_change();
        add_round(&REVIEW, &legacy, "demo", ROUND_1).expect("legacy round");
        assert_eq!(show(&REVIEW, &legacy, "demo").expect("parses").rounds[0].rules, None);
    }

    #[test]
    fn malformed_rule_records_are_rejected_without_writing() {
        // spec Example「拒绝的规则记录」：每列各自被拒绝，stderr 点名该行的问题，
        // 工单零写入。
        let cases: &[(&str, &[&str])] = &[
            ("**Rules**: Extend\n", &["extend", "replace"]),
            ("**Rules**: extend\n**Rules**: extend\n", &["multiple `**Rules**:`"]),
            ("**Rule**: WARNING 要有测试\n", &["`**Rules**:`"]),
            ("**Rules**: extend\n**Rule**: NOTE 要有测试\n", &["CRITICAL", "WARNING", "SUGGESTION"]),
            ("**Rules**: replace\n**Rule**: CRITICAL\n", &["rule text"]),
        ];
        for (lines, expected) in cases {
            let store = store_with_change();
            let err = add_round(&REVIEW, &store, "demo", &discovery_with_rules(lines))
                .expect_err("malformed rule record must be rejected");
            assert!(
                err.downcast_ref::<crate::command::InvalidContent>().is_some(),
                "{lines:?} is a caller content error: {err}"
            );
            for word in *expected {
                assert!(err.to_string().contains(word), "{lines:?}: error must mention {word:?}: {err}");
            }
            assert_eq!(*store.artifact_writes.borrow(), 0, "{lines:?}: refusal must not write");
        }
    }

    #[test]
    fn rule_record_edge_values_fail_closed() {
        // sharp-edges 检查（任务 1.3）：大小写不符的 severity、空值、只有空白的原文
        // （含全角空白）都拒绝且零写入。
        for lines in [
            "**Rules**: extend\n**Rule**: critical 要有测试\n",
            "**Rules**:\n",
            "**Rules**: extend\n**Rule**:\n",
            "**Rules**: extend\n**Rule**: WARNING \u{3000} \n",
        ] {
            let store = store_with_change();
            assert!(
                add_round(&REVIEW, &store, "demo", &discovery_with_rules(lines)).is_err(),
                "{lines:?} must be rejected"
            );
            assert_eq!(*store.artifact_writes.borrow(), 0, "{lines:?}: refusal must not write");
        }
    }

    #[test]
    fn rule_record_whitespace_crlf_and_duplicates_have_defined_results() {
        // sharp-edges 检查（任务 1.3）：
        // - 冒号后无空白、token 前后空白与全角空白（Unicode 空白）照 trim 处理；
        // - severity 与原文之间的全角空白也算分隔；原文内部的全角空白保留；
        // - CRLF 行尾不残留 `\r`；
        // - 相同的规则行照记录保留两条（config 清单本身允许重复）。
        let store = store_with_change();
        let lines = "**Rules**:replace\u{3000}\r\n\
                     **Rule**: CRITICAL\u{3000}密钥\u{3000}不得写死\r\n\
                     **Rule**: WARNING 要有测试\r\n\
                     **Rule**: WARNING 要有测试\r\n";
        add_round(&REVIEW, &store, "demo", &discovery_with_rules(lines)).expect("round with rules");
        let ticket = show(&REVIEW, &store, "demo").expect("parses");
        assert_eq!(
            ticket.rounds[0].rules,
            Some(rules(
                crate::config::ReviewBaseline::Replace,
                &["密钥\u{3000}不得写死"],
                &["要有测试", "要有测试"],
                &[],
            ))
        );

        // 前缀本身区分大小写：`**rules**:` 与 `**phase**:` 一样是一般文本行，不算记录。
        let prose = store_with_change();
        add_round(&REVIEW, &prose, "demo", &discovery_with_rules("**rules**: extend\n")).expect("prose line");
        assert_eq!(show(&REVIEW, &prose, "demo").expect("parses").rounds[0].rules, None);
    }

    #[test]
    fn rule_records_are_rejected_outside_a_discovery_round() {
        // spec Scenario「规则记录只能出现在 discovery 轮」：validation 轮与 legacy 轮
        // 带 `**Rules**:` 都拒绝，既有工单比特级不变。
        let store = store_with_change();
        add_round(&REVIEW, &store, "demo", &structured_round("discovery", &"a".repeat(64))).expect("r1");
        let before = store.read_artifact("demo", REVIEW_DOC).expect("ticket");
        let validation = format!(
            "**Phase**: validation\n**Patch**: sha256:{}\n**Rules**: extend\n**Scope**: src/lib.rs\n",
            "b".repeat(64)
        );
        let legacy = "**Rules**: extend\n**Scope**: src/lib.rs\n";
        for content in [validation.as_str(), legacy] {
            let err = add_round(&REVIEW, &store, "demo", content)
                .expect_err("rules outside discovery must be rejected");
            assert!(err.to_string().contains("discovery"), "error names the discovery round: {err}");
            assert_eq!(store.read_artifact("demo", REVIEW_DOC).as_deref(), Some(before.as_str()));
        }
    }

    #[test]
    fn round_to_json_carries_the_rules_object() {
        // design D3：`rules` 串行化为 { baseline, critical, warning, suggestion }，
        // 没有记录的轮为明确 null（另见档首的 wire 形状测试）。
        let store = store_with_change();
        let lines = "**Rules**: replace\n**Rule**: SUGGESTION 偏好以提早返回取代深层嵌套\n";
        add_round(&REVIEW, &store, "demo", &discovery_with_rules(lines)).expect("r1");
        add_round(&REVIEW, &store, "demo", &structured_round("validation", &"b".repeat(64))).expect("r2");
        let ticket = show(&REVIEW, &store, "demo").expect("parses");
        assert_eq!(
            ticket.rounds[0].to_json()["rules"],
            serde_json::json!({
                "baseline": "replace",
                "critical": [],
                "warning": [],
                "suggestion": ["偏好以提早返回取代深层嵌套"],
            })
        );
        let last = ticket.last_round().to_json();
        assert!(last.as_object().expect("object").contains_key("rules"), "rules key is always present");
        assert_eq!(last["rules"], serde_json::Value::Null);
    }

    // --- spec「内容指纹锚与失效判定」---

    #[test]
    fn content_fingerprint_normalizes_crlf_and_detects_change() {
        // 行尾 CRLF→LF 范式后哈希（git autocrlf 环境不误降级）；内容不同则不同。
        assert_eq!(content_fingerprint("a\r\nb\r\n"), content_fingerprint("a\nb\n"));
        assert_ne!(content_fingerprint("a\nb\n"), content_fingerprint("a\nc\n"));
        let hex = content_fingerprint("");
        assert_eq!(hex.len(), 64, "sha-256 hex digest");
        assert!(hex.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn content_fingerprint_bytes_branches_on_utf8_readability() {
        // spec Example「指纹分流表」三列：UTF-8(LF)＝既有文本规则、UTF-8(CRLF)
        // 与同内容 LF 版哈希相同、非 UTF-8 字节＝原始字节 SHA-256。
        assert_eq!(content_fingerprint_bytes(FILE_A.as_bytes()), content_fingerprint(FILE_A));
        assert_eq!(content_fingerprint_bytes(b"a\r\nb\r\n"), content_fingerprint("a\nb\n"));
        let png: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0xFF, 0x00];
        let raw_sha = {
            use sha2::{Digest, Sha256};
            format!("{:x}", Sha256::digest(png))
        };
        assert_eq!(content_fingerprint_bytes(png), raw_sha, "no line-ending normalization");
    }

    #[test]
    fn content_fingerprint_bytes_boundaries_bom_empty_and_type_flip() {
        // 分流边界：BOM 与空字节都是合法 UTF-8（走文本规则）；盖章后文件在
        // 文本↔binary 间转换，指纹必变 → 失效判定 stale（两个方向各钉一次）。
        assert_eq!(content_fingerprint_bytes(b"\xEF\xBB\xBFa\r\n"), content_fingerprint("\u{feff}a\n"));
        assert_eq!(content_fingerprint_bytes(b""), content_fingerprint(""));
        let path = "crates/a/src/lib.rs";
        let counts = code_counts(5, 5);
        let text_stamped = stamped_meta(5, &[(path, &content_fingerprint(FILE_A))]);
        let now_binary: &[(&str, &[u8])] = &[(path, BIN_A)];
        assert_eq!(
            freshness(&REVIEW, &text_stamped, &counts, &byte_files(now_binary)),
            Freshness::Stale,
            "text stamp, file turned binary"
        );
        let bin_stamped = stamped_meta(5, &[(path, &content_fingerprint_bytes(BIN_A))]);
        assert_eq!(
            freshness(&REVIEW, &bin_stamped, &counts, &files(&[(path, FILE_A)])),
            Freshness::Stale,
            "binary stamp, file turned text"
        );
    }

    /// 带完整章的 meta：tasks_total 任务锚＋entries 内容锚。
    fn stamped_meta(tasks_total: usize, entries: &[(&str, &str)]) -> ChangeMeta {
        let mut y = format!(
            "schema: spec-driven\nreviewed_at: 2026-08-01\nreviewed_by: Rev <r@example.com>\nreviewed_with: claude\nreviewed_tasks_total: {tasks_total}\nreviewed_scope:\n"
        );
        for (p, h) in entries {
            y.push_str(&format!("  - path: {p}\n    hash: {h}\n"));
        }
        ChangeMeta::from_text(Some(&y)).expect("meta parses")
    }

    #[test]
    fn freshness_all_anchors_match_is_fresh() {
        let h = content_fingerprint(FILE_A);
        let meta = stamped_meta(5, &[("crates/a/src/lib.rs", h.as_str())]);
        assert_eq!(freshness(&REVIEW, &meta, &code_counts(5, 5), &files(REPO)), Freshness::Fresh);
    }

    #[test]
    fn freshness_modified_scope_file_is_stale() {
        // spec Example「指纹比对」：文件追加一行 → 现值哈希不为 H1 → stale。
        let h1 = content_fingerprint(FILE_A);
        let meta = stamped_meta(5, &[("crates/a/src/lib.rs", h1.as_str())]);
        let grown = format!("{FILE_A}fn extra() {{}}\n");
        let now = [("crates/a/src/lib.rs", grown.as_str())];
        assert_eq!(freshness(&REVIEW, &meta, &code_counts(5, 5), &files(&now)), Freshness::Stale);
    }

    #[test]
    fn freshness_missing_scope_file_is_stale() {
        // spec：任一 scope 档内容哈希不符「含文件已不存在」→ stale。
        let h = content_fingerprint(FILE_A);
        let meta = stamped_meta(5, &[("crates/a/src/lib.rs", h.as_str())]);
        assert_eq!(freshness(&REVIEW, &meta, &code_counts(5, 5), &files(&[])), Freshness::Stale);
    }

    #[test]
    fn freshness_line_ending_change_stays_fresh() {
        // spec Scenario「行尾差异不触发失效」：LF → CRLF 仍 fresh。
        let h = content_fingerprint(FILE_A);
        let meta = stamped_meta(5, &[("crates/a/src/lib.rs", h.as_str())]);
        let crlf = FILE_A.replace('\n', "\r\n");
        let now = [("crates/a/src/lib.rs", crlf.as_str())];
        assert_eq!(freshness(&REVIEW, &meta, &code_counts(5, 5), &files(&now)), Freshness::Fresh);
    }

    #[test]
    fn freshness_task_anchor_breaks_on_recount_or_uncheck() {
        // spec：任务状态不再是「盖章当时任务总数的全完成」→ stale——添加任务
        //（总数变）与退勾（未全完成）皆触发。
        let h = content_fingerprint(FILE_A);
        let meta = stamped_meta(5, &[("crates/a/src/lib.rs", h.as_str())]);
        assert_eq!(freshness(&REVIEW, &meta, &code_counts(6, 6), &files(REPO)), Freshness::Stale, "task count grew");
        assert_eq!(freshness(&REVIEW, &meta, &code_counts(5, 4), &files(REPO)), Freshness::Stale, "task unchecked");
    }

    #[test]
    fn freshness_ignores_manual_task_toggles() {
        // spec Scenario「盖章后补勾手动任务不失效」：盖章当时 5 个任务（4 写码全勾
        // ＋1 个未勾 [M]），事后补勾该 [M] → 两种状态都 fresh。
        let h = content_fingerprint(FILE_A);
        let meta = stamped_meta(5, &[("crates/a/src/lib.rs", h.as_str())]);
        let counts = |md: &str| crate::tasks::counts(&crate::tasks::parse(md));
        let open = "- [x] a\n- [x] b\n- [x] c\n- [x] d\n- [ ] [M] 手测\n";
        let checked = "- [x] a\n- [x] b\n- [x] c\n- [x] d\n- [x] [M] 手测\n";
        assert_eq!(freshness(&REVIEW, &meta, &counts(open), &files(REPO)), Freshness::Fresh, "手测未勾");
        assert_eq!(freshness(&REVIEW, &meta, &counts(checked), &files(REPO)), Freshness::Fresh, "手测补勾");
    }

    #[test]
    fn freshness_unstamped_meta_is_unknown() {
        // 缺席读作未审查：无章的 meta 没有可判定的锚。
        let meta = ChangeMeta::from_text(Some(META)).expect("meta parses");
        assert_eq!(freshness(&REVIEW, &meta, &code_counts(5, 5), &files(REPO)), Freshness::Unknown);
    }
}

/// 验证站：同一组动词带 `&VERIFY`，外加 `add_round` 的任务全完成守门
/// （刻意不对称）、五个 `verified_*` 字段，以及与审查站互不屏蔽的断言。
mod verify {
    use super::super::*;
    use super::freshness;
    use crate::teststore::TestStore;

    const META: &str = "schema: spec-driven\ncreated: 2026-07-01\n";
    const TASKS_5_DONE: &str = "- [x] 1 a\n- [x] 2 b\n- [x] 3 c\n- [x] 4 d\n- [x] 5 e\n";
    const TASKS_4_OF_5: &str = "- [x] 1 a\n- [x] 2 b\n- [x] 3 c\n- [x] 4 d\n- [ ] 5 e\n";
    /// 四个写码任务全勾、第五个是未勾的 `[M]` 手测——写码任务全完成预测子成立。
    const TASKS_CODE_DONE_MANUAL_OPEN: &str =
        "- [x] 1 a\n- [x] 2 b\n- [x] 3 c\n- [x] 4 d\n- [ ] [M] 5 手测\n";

    const ROUND_1: &str = "**Scope**: crates/a/src/lib.rs, crates/b/src/util.rs\n\n- [CRITICAL] crates/a/src/lib.rs — requirement R2 has no implementation\n- [SUGGESTION] crates/b/src/util.rs — design says otherwise\n";
    const ROUND_2: &str = "**Scope**: crates/a/src/lib.rs\n\n- [WARNING] crates/a/src/lib.rs — scenario 3 untested\n";
    const SUGGESTION_ROUND: &str =
        "**Scope**: crates/b/src/util.rs\n\n- [SUGGESTION] crates/b/src/util.rs — design says otherwise\n";

    /// total 个写码任务、前 done 个已勾（无 `[M]`）——失效判定的计数输入。
    fn code_counts(total: usize, done: usize) -> crate::tasks::Counts {
        let md: String =
            (0..total).map(|i| if i < done { "- [x] t\n" } else { "- [ ] t\n" }).collect();
        crate::tasks::counts(&crate::tasks::parse(&md))
    }

    /// 任务全数完成的 change——验证工单的前提（design D3）。
    fn finished_change() -> TestStore {
        let store = TestStore::with_meta("demo", META);
        store.put_artifact("demo", "tasks.md", TASKS_5_DONE);
        store
    }

    fn structured_round(phase: &str, hex: &str) -> String {
        format!(
            "**Phase**: {phase}\n**Patch**: sha256:{hex}\n**Scope**: src/lib.rs\n\n- [CRITICAL] src/lib.rs — requirement R2 has no implementation\n"
        )
    }

    // --- spec「验证工单的创建与追加」---

    #[test]
    fn add_round_refuses_until_every_task_is_done() {
        // spec Scenario「任务未全完成即拒绝落工单」＋design D3：verify 检查可中途
        // 跑，但盘点轮不得落工单——4/5 → 非零拒绝、零写入、无文件创建。
        let store = TestStore::with_meta("demo", META);
        store.put_artifact("demo", "tasks.md", TASKS_4_OF_5);
        let err = add_round(&VERIFY, &store, "demo", ROUND_1).expect_err("incomplete tasks must refuse");
        let msg = err.to_string();
        assert!(msg.contains("4/5"), "error must show the count: {msg}");
        assert!(
            err.downcast_ref::<crate::command::Refusal>().is_some(),
            "typed Refusal so the runtime classifies refused"
        );
        assert_eq!(*store.artifact_writes.borrow(), 0, "refusal must not write");
        assert!(!store.artifact_exists("demo", VERIFY_DOC), "no ticket may appear");
    }

    #[test]
    fn add_round_lands_the_ticket_when_only_manual_tasks_remain() {
        // spec Scenario「仅余手动任务可落工单」：写码 4/4 全勾、一个 [M] 未勾 → 放行。
        let store = TestStore::with_meta("demo", META);
        store.put_artifact("demo", "tasks.md", TASKS_CODE_DONE_MANUAL_OPEN);
        assert_eq!(add_round(&VERIFY, &store, "demo", ROUND_1).expect("manual-only remainder lands"), 1);
        assert!(store.artifact_exists("demo", VERIFY_DOC), "ticket must be created");
    }

    #[test]
    fn add_round_refusal_names_the_code_task_counts() {
        // spec「验证工单的创建与追加」：拒绝消息点名写码任务——手测任务不计入。
        let store = TestStore::with_meta("demo", META);
        store.put_artifact("demo", "tasks.md", "- [x] a\n- [ ] b\n- [ ] [M] 手测\n");
        let err = add_round(&VERIFY, &store, "demo", ROUND_1).expect_err("open code task must refuse");
        let msg = err.to_string();
        assert!(msg.contains("1/2"), "counts must exclude the [M] task: {msg}");
        assert!(msg.contains("code task"), "message must name code tasks: {msg}");
    }

    #[test]
    fn add_round_creates_ticket_with_round_1_on_first_call() {
        // spec Scenario「首轮创建工单」：任务全完成＋合法内容 → 建档且自 Round 1 起算。
        let store = finished_change();
        let round = add_round(&VERIFY, &store, "demo", ROUND_1).expect("first round");
        assert_eq!(round, 1);
        let doc = store.read_artifact("demo", VERIFY_DOC).expect("ticket must be created");
        assert!(doc.starts_with("# Verify — demo\n"), "station title heads the ticket: {doc}");
        assert!(doc.contains("## Round 1"), "fixed skeleton must carry the round header: {doc}");
        assert!(
            doc.contains("**Scope**: crates/a/src/lib.rs"),
            "round content must be carried verbatim: {doc}"
        );
    }

    #[test]
    fn add_round_appends_round_2_keeping_round_1_byte_identical() {
        // spec Scenario「追加轮次不改写既有轮」：append-only，Round 1 比特级不变。
        let store = finished_change();
        add_round(&VERIFY, &store, "demo", ROUND_1).expect("first round");
        let after_first = store.read_artifact("demo", VERIFY_DOC).expect("ticket");
        let round = add_round(&VERIFY, &store, "demo", ROUND_2).expect("second round");
        assert_eq!(round, 2);
        let after_second = store.read_artifact("demo", VERIFY_DOC).expect("ticket");
        assert!(
            after_second.starts_with(&after_first),
            "append-only: Round 1 must stay byte-identical\nbefore: {after_first}\nafter: {after_second}"
        );
        assert!(after_second.contains("## Round 2"));
    }

    #[test]
    fn add_round_rejects_content_without_scope_without_writing() {
        // spec Scenario「内容缺少 Scope」：缺 `**Scope**:`（或清单为空）→ 拒绝、零写入。
        let store = finished_change();
        for bad in ["", "   \n", "- [CRITICAL] a.rs — no scope line\n", "**Scope**:  \n"] {
            let Err(err) = add_round(&VERIFY, &store, "demo", bad) else {
                panic!("content {bad:?} must be rejected");
            };
            assert!(err.to_string().contains("**Scope**:"), "error must explain the format: {err}");
        }
        assert_eq!(*store.artifact_writes.borrow(), 0, "refusal must not write");
        assert!(!store.artifact_exists("demo", VERIFY_DOC));
    }

    #[test]
    fn add_round_rejects_missing_change_and_unsafe_names() {
        // 沿 in-progress add／set_board_rank 的同款防护：不存在的 change 与
        // 非单一路径段名称皆拒绝、零写入。
        let store = finished_change();
        let err = add_round(&VERIFY, &store, "ghost", ROUND_1).expect_err("missing change must be rejected");
        assert!(err.to_string().contains("ghost"), "error must name the change: {err}");
        assert!(add_round(&VERIFY, &store, "../evil", ROUND_1).is_err());
        assert_eq!(*store.artifact_writes.borrow(), 0, "refusal must not write");
    }

    #[test]
    fn structured_round_rejects_unpaired_or_malformed_fields_without_writing() {
        // spec Scenario「phase 与 patch 必须成对」＋格式验证：两栏只出现其一、
        // phase token 无效、hash 非 64 lowercase hex → 非零拒绝且工单零写入。
        let store = finished_change();
        let hex = "a".repeat(64);
        for bad in [
            "**Phase**: discovery\n**Scope**: src/lib.rs\n".to_string(),
            format!("**Patch**: sha256:{hex}\n**Scope**: src/lib.rs\n"),
            structured_round("exploration", &hex),
            structured_round("discovery", "zz"),
            structured_round("discovery", &"A".repeat(64)),
            format!("**Phase**: discovery\n**Patch**: {hex}\n**Scope**: src/lib.rs\n"),
        ] {
            assert!(add_round(&VERIFY, &store, "demo", &bad).is_err(), "content {bad:?} must be rejected");
        }
        assert_eq!(*store.artifact_writes.borrow(), 0, "refusals must not write");
        assert!(!store.artifact_exists("demo", VERIFY_DOC));
    }

    #[test]
    fn structured_discovery_round_parses_phase_and_patch_hash() {
        // spec Scenario「追加 structured validation」的前半：Round 1 是 discovery，
        // phase／patch 进工单原文并解析回值。
        let store = finished_change();
        let hex = "a".repeat(64);
        add_round(&VERIFY, &store, "demo", &structured_round("discovery", &hex)).expect("structured round");
        let ticket = show(&VERIFY, &store, "demo").expect("ticket parses");
        assert_eq!(ticket.rounds[0].phase, Some(RoundPhase::Discovery));
        assert_eq!(ticket.rounds[0].patch_hash.as_deref(), Some(format!("sha256:{hex}").as_str()));
        let doc = store.read_artifact("demo", VERIFY_DOC).expect("ticket doc");
        assert!(doc.contains("**Phase**: discovery"), "{doc}");
        assert!(doc.contains(&format!("**Patch**: sha256:{hex}")), "{doc}");
    }

    #[test]
    fn discovery_then_validation_is_the_only_allowed_sequence() {
        // spec Scenario「第二个 discovery 被拒绝」＋「追加 structured validation」：
        // structured Round 1 只能是 discovery，其后只能是 validation；第二个
        // discovery 拒绝且工单比特级不变。
        let store = finished_change();
        add_round(&VERIFY, &store, "demo", &structured_round("discovery", &"a".repeat(64))).expect("r1");
        let before = store.read_artifact("demo", VERIFY_DOC).expect("ticket");
        let err = add_round(&VERIFY, &store, "demo", &structured_round("discovery", &"b".repeat(64)))
            .expect_err("a second discovery must be rejected");
        assert!(err.to_string().contains("validation"), "error explains the sequence: {err}");
        assert_eq!(store.read_artifact("demo", VERIFY_DOC).as_deref(), Some(before.as_str()));

        let round = add_round(&VERIFY, &store, "demo", &structured_round("validation", &"c".repeat(64)))
            .expect("validation may follow discovery");
        assert_eq!(round, 2);
        let after = store.read_artifact("demo", VERIFY_DOC).expect("ticket");
        assert!(after.starts_with(&before), "append-only across structured rounds");
        assert_eq!(show(&VERIFY, &store, "demo").expect("parses").last_round().phase, Some(RoundPhase::Validation));
    }

    #[test]
    fn validation_is_rejected_on_a_fresh_ticket() {
        // 无任何轮次可验收：首轮 validation 拒绝、零写入。
        let store = finished_change();
        let err = add_round(&VERIFY, &store, "demo", &structured_round("validation", &"a".repeat(64)))
            .expect_err("fresh-ticket validation must be rejected");
        assert!(err.to_string().contains("discovery"), "error names the required phase: {err}");
        assert_eq!(*store.artifact_writes.borrow(), 0);
    }

    #[test]
    fn legacy_round_parses_with_null_phase_and_patch() {
        // spec Scenario「legacy round 保持兼容」：两栏缺席解析为 None，行为不变。
        let store = finished_change();
        add_round(&VERIFY, &store, "demo", ROUND_1).expect("legacy round");
        let ticket = show(&VERIFY, &store, "demo").expect("parses");
        assert_eq!(ticket.rounds[0].phase, None);
        assert_eq!(ticket.rounds[0].patch_hash, None);
    }

    #[test]
    fn add_round_rejects_scope_paths_that_escape_the_repo_root() {
        // Scope 是指纹读档的路径来源；remote 模式的工单来自 server，等于由 server
        // 指定 client 读哪个本机档——守门落在文法层（两站共用同一道）。
        let store = finished_change();
        for bad in [
            "**Scope**: /etc/passwd\n",
            "**Scope**: ../../../etc/passwd\n",
            "**Scope**: C:\\Windows\\win.ini\n",
        ] {
            let Err(err) = add_round(&VERIFY, &store, "demo", bad) else {
                panic!("scope {bad:?} must be rejected");
            };
            assert!(
                err.to_string().contains("repo-root relative"),
                "error must explain the requirement: {err}"
            );
        }
        assert_eq!(*store.artifact_writes.borrow(), 0, "refusal must not write");
    }

    // --- spec「验证工单的读取」---

    #[test]
    fn show_round_trips_rounds_scope_findings_and_last_round() {
        // spec Scenario「读取 JSON」的解析内核：rounds 长度、每轮 index、scope 清单
        // 与分级 findings 逐字段；lastRound 指向末轮。
        let store = finished_change();
        add_round(&VERIFY, &store, "demo", ROUND_1).expect("round 1");
        add_round(&VERIFY, &store, "demo", ROUND_2).expect("round 2");
        let ticket = show(&VERIFY, &store, "demo").expect("ticket parses");
        assert_eq!(ticket.rounds.len(), 2);
        let r1 = &ticket.rounds[0];
        assert_eq!(r1.index, 1);
        assert_eq!(
            r1.scope,
            vec!["crates/a/src/lib.rs".to_string(), "crates/b/src/util.rs".to_string()]
        );
        assert_eq!(
            r1.findings,
            vec![
                Finding {
                    severity: Severity::Critical,
                    path: "crates/a/src/lib.rs".to_string(),
                    text: "requirement R2 has no implementation".to_string(),
                },
                Finding {
                    severity: Severity::Suggestion,
                    path: "crates/b/src/util.rs".to_string(),
                    text: "design says otherwise".to_string(),
                },
            ]
        );
        let last = ticket.last_round();
        assert_eq!(last.index, 2);
        assert_eq!(last.scope, vec!["crates/a/src/lib.rs".to_string()]);
        assert_eq!(last.findings.len(), 1);
        assert_eq!(last.findings[0].severity, Severity::Warning);
        assert_eq!(last.findings[0].text, "scenario 3 untested");
    }

    #[test]
    fn show_errors_when_change_has_no_ticket() {
        // spec Scenario「无工单」：错误说明该 change 无「验证」工单——站别词不得
        // 说成 review，否则用户被送去看另一个站的工单。
        let store = finished_change();
        let err = show(&VERIFY, &store, "demo").expect_err("no ticket must error");
        assert!(err.to_string().contains("no verify ticket"), "error must say so: {err}");
        assert!(
            err.downcast_ref::<NotFound>().is_some(),
            "typed NotFound so the server maps 404"
        );
    }

    // --- spec「放弃验证」---

    #[test]
    fn discard_deletes_the_verify_ticket_and_leaves_meta_untouched() {
        // spec Scenario「放弃既有工单」：工单删除、`.meta.yaml` 比特级不变。
        let store = finished_change();
        add_round(&VERIFY, &store, "demo", ROUND_1).expect("round 1");
        discard(&VERIFY, &store, "demo").expect("discard");
        assert!(!store.artifact_exists("demo", VERIFY_DOC), "ticket must be gone");
        assert_eq!(store.meta("demo"), META, "metadata must stay byte-identical");
        assert_eq!(*store.meta_writes.borrow(), 0, "discard must not write metadata");
    }

    #[test]
    fn discard_leaves_the_review_ticket_alone() {
        // 两站互不屏蔽：放弃验证不得动到审查工单（cleanup namespace 站别化的
        // 引擎面；snapshot 面由 CLI 测试覆盖）。
        let store = finished_change();
        add_round(&VERIFY, &store, "demo", ROUND_1).expect("verify round");
        add_round(&REVIEW, &store, "demo", ROUND_1).expect("review round");
        let review_doc = store.read_artifact("demo", REVIEW_DOC).expect("ticket");
        discard(&VERIFY, &store, "demo").expect("discard");
        assert!(!store.artifact_exists("demo", VERIFY_DOC), "verify ticket must be gone");
        assert_eq!(
            store.read_artifact("demo", REVIEW_DOC).as_deref(),
            Some(review_doc.as_str()),
            "the review ticket must survive byte-identically"
        );
    }

    #[test]
    fn discard_errors_when_no_ticket() {
        // spec：无工单时非零 exit code。
        let store = finished_change();
        let err = discard(&VERIFY, &store, "demo").expect_err("no ticket must error");
        assert!(err.to_string().contains("no verify ticket"), "error must say so: {err}");
    }

    // --- spec「验证盖章守门与盖章效果」---

    const CLEAN_ROUND: &str = "**Scope**: crates/a/src/lib.rs\n";
    const FILE_A: &str = "fn a() {}\n";
    const FILE_B: &str = "fn b() {}\n";
    const REPO: &[(&str, &str)] =
        &[("crates/a/src/lib.rs", FILE_A), ("crates/b/src/util.rs", FILE_B)];

    /// repo 文件读取替身：固定 (path, content) 表（读档闭包吃字节）。
    fn files<'a>(map: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<Vec<u8>> + 'a {
        move |p: &str| map.iter().find(|(k, _)| *k == p).map(|(_, v)| v.as_bytes().to_vec())
    }

    /// repo 文件存在替身：与 `files` 共用同一张表。
    fn present<'a>(map: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> bool + 'a {
        move |p: &str| map.iter().any(|(k, _)| *k == p)
    }

    /// 非 UTF-8 字节替身（PNG 式档头；0x89 开头即非法 UTF-8）。
    const BIN_A: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0xFF, 0x00];

    /// repo 字节读取替身：binary scope 案例用（文本案例走 `files`）。
    fn byte_files<'a>(map: &'a [(&'a str, &'a [u8])]) -> impl Fn(&str) -> Option<Vec<u8>> + 'a {
        move |p: &str| map.iter().find(|(k, _)| *k == p).map(|(_, v)| v.to_vec())
    }

    /// repo 文件存在替身：与 `byte_files` 共用同一张表。
    fn byte_present<'a>(map: &'a [(&'a str, &'a [u8])]) -> impl Fn(&str) -> bool + 'a {
        move |p: &str| map.iter().any(|(k, _)| *k == p)
    }

    fn stamp_demo(store: &TestStore, accept: bool) -> Result<()> {
        stamp(
            &VERIFY,
            store,
            "demo",
            accept,
            Some("Ver <v@example.com>"),
            Some("claude"),
            None,
            &files(REPO),
            &present(REPO),
        )
    }

    #[test]
    fn stamp_refuses_unresolved_findings_without_accept() {
        // spec Scenario「末轮有未解 findings 且未带 --accept」：拒绝并提示 --accept
        // 或先修正重验；站别祈使词为 re-verify（审查站是 re-review）。
        let store = finished_change();
        add_round(&VERIFY, &store, "demo", ROUND_1).expect("round with findings");
        let err = stamp_demo(&store, false).expect_err("unresolved findings must refuse");
        let msg = err.to_string();
        assert!(msg.contains("--accept"), "error must offer --accept: {msg}");
        assert!(msg.contains("re-verify"), "station word must be the verify one: {msg}");
        assert_eq!(*store.meta_writes.borrow(), 0);
        assert!(store.artifact_exists("demo", VERIFY_DOC), "ticket must survive refusal");
    }

    #[test]
    fn stamp_refuses_when_tasks_regress_after_the_ticket_was_opened() {
        // 守门 (1) 与审查站同一条：工单开立后任务被退勾 → 4/5 拒绝，消息用
        // 「verify stamp」而非另一站的动词。
        let store = finished_change();
        add_round(&VERIFY, &store, "demo", CLEAN_ROUND).expect("round 1");
        store.put_artifact("demo", "tasks.md", TASKS_4_OF_5);
        let err = stamp_demo(&store, false).expect_err("incomplete tasks must refuse");
        let msg = err.to_string();
        assert!(msg.contains("4/5"), "error must show the count: {msg}");
        assert!(msg.contains("verify stamp"), "error must name the verb: {msg}");
        assert_eq!(store.meta("demo"), META, "metadata must stay byte-identical");
        assert_eq!(*store.meta_writes.borrow(), 0);
        assert!(store.artifact_exists("demo", VERIFY_DOC), "ticket must survive refusal");
    }

    #[test]
    fn stamp_lands_when_only_manual_tasks_remain_and_anchors_the_full_total() {
        // spec Scenario「仅余手动任务可盖章」：写码全勾、[M] 未勾 → 盖章成功，
        // verified_tasks_total 记全任务总数（含 [M]）。
        let store = finished_change();
        add_round(&VERIFY, &store, "demo", CLEAN_ROUND).expect("round 1");
        store.put_artifact("demo", "tasks.md", TASKS_CODE_DONE_MANUAL_OPEN);
        stamp_demo(&store, false).expect("manual-only remainder must stamp");
        let meta = crate::model::ChangeMeta::from_text(Some(&store.meta("demo"))).expect("meta");
        assert_eq!(meta.verified_tasks_total, Some(5), "anchor counts the [M] task too");
        assert!(!store.artifact_exists("demo", VERIFY_DOC), "ticket must be deleted");
    }

    #[test]
    fn stamp_clean_round_writes_five_fields_and_deletes_the_ticket() {
        // spec Scenario「干净盖章」：五个 verified 字段齐备、`verify.md` 不存在。
        let store = finished_change();
        add_round(&VERIFY, &store, "demo", ROUND_1).expect("round 1 with findings");
        add_round(&VERIFY, &store, "demo", CLEAN_ROUND).expect("round 2 clean");
        stamp_demo(&store, false).expect("clean stamp");
        assert!(!store.artifact_exists("demo", VERIFY_DOC), "ticket must be deleted");
        let raw = store.meta("demo");
        let meta = crate::model::ChangeMeta::from_text(Some(&raw)).expect("meta parses");
        assert_eq!(meta.verified_at.as_deref(), Some(crate::util::today().as_str()));
        assert_eq!(meta.verified_by.as_deref(), Some("Ver <v@example.com>"));
        assert_eq!(meta.verified_with.as_deref(), Some("claude"));
        assert_eq!(meta.verified_tasks_total, Some(5));
        assert!(!meta.verified_scope.is_empty(), "scope fingerprints must be recorded");
        assert!(raw.starts_with(META), "existing fields preserved byte-for-byte: {raw}");
    }

    #[test]
    fn stamp_writes_the_task_anchor_from_the_ticket_moment() {
        // spec Example「盖章写入的任务锚」：8 个任务、7 个写码任务全勾、1 个
        // `[M]` 未勾 → `verified_tasks_total` 为 8（未勾的 [M] 也计入锚）。
        let store = TestStore::with_meta("demo", META);
        let tasks: String = (1..=7).map(|i| format!("- [x] {i} t\n")).collect::<String>()
            + "- [ ] [M] 8 hand check\n";
        store.put_artifact("demo", "tasks.md", &tasks);
        add_round(&VERIFY, &store, "demo", CLEAN_ROUND).expect("clean round 1");
        stamp_demo(&store, false).expect("stamp");
        let meta = crate::model::ChangeMeta::from_text(Some(&store.meta("demo"))).expect("parses");
        assert_eq!(meta.verified_tasks_total, Some(8));
    }

    #[test]
    fn stamp_with_accept_overrides_findings_and_stamps() {
        // spec「`--accept` SHALL 仅豁免后者」：带保留盖章 → 章写入且工单删除。
        let store = finished_change();
        add_round(&VERIFY, &store, "demo", ROUND_1).expect("round with findings");
        stamp_demo(&store, true).expect("--accept must stamp");
        assert!(!store.artifact_exists("demo", VERIFY_DOC), "ticket must be deleted");
        let meta = crate::model::ChangeMeta::from_text(Some(&store.meta("demo"))).expect("parses");
        assert!(meta.verified_at.is_some());
    }

    #[test]
    fn stamp_allows_a_suggestion_only_last_round() {
        // spec Scenario「仅 SUGGESTION 的末轮干净盖章」：SUGGESTION 不是必修，
        // 无 `--accept` 也放行——五栏写入且工单删除。分界计数本身归
        // station.rs 的守门测试；这里钉站别 wiring 与盖章效果。
        let store = finished_change();
        add_round(&VERIFY, &store, "demo", SUGGESTION_ROUND).expect("suggestion-only round");
        stamp_demo(&store, false).expect("suggestion-only round must stamp clean");
        assert!(!store.artifact_exists("demo", VERIFY_DOC), "ticket must be deleted");
        let meta = crate::model::ChangeMeta::from_text(Some(&store.meta("demo"))).expect("parses");
        assert_eq!(meta.verified_at.as_deref(), Some(crate::util::today().as_str()));
        assert_eq!(meta.verified_by.as_deref(), Some("Ver <v@example.com>"));
        assert_eq!(meta.verified_with.as_deref(), Some("claude"));
        assert_eq!(meta.verified_tasks_total, Some(5));
        assert!(!meta.verified_scope.is_empty(), "scope fingerprints must be recorded");
    }

    #[test]
    fn stamp_leaves_the_review_station_untouched() {
        // 两站互不屏蔽：验证盖章不得动到审查工单或 `reviewed_*` 字段。
        const STAMPED: &str = "schema: spec-driven\nreviewed_at: 2026-08-01\nreviewed_by: Rev <r@example.com>\nreviewed_with: claude\nreviewed_tasks_total: 5\nreviewed_scope:\n  - path: crates/a/src/lib.rs\n    hash: dead\n";
        let store = TestStore::with_meta("demo", STAMPED);
        store.put_artifact("demo", "tasks.md", TASKS_5_DONE);
        add_round(&REVIEW, &store, "demo", CLEAN_ROUND).expect("review round");
        add_round(&VERIFY, &store, "demo", CLEAN_ROUND).expect("verify round");
        stamp_demo(&store, false).expect("verify stamp");
        assert!(!store.artifact_exists("demo", VERIFY_DOC), "verify ticket must be gone");
        assert!(
            store.artifact_exists("demo", REVIEW_DOC),
            "the review ticket must survive a verify stamp"
        );
        let raw = store.meta("demo");
        let meta = crate::model::ChangeMeta::from_text(Some(&raw)).expect("meta parses");
        assert_eq!(meta.reviewed_at.as_deref(), Some("2026-08-01"), "review stamp intact: {raw}");
        assert_eq!(meta.reviewed_scope.len(), 1, "review anchors intact: {raw}");
        assert_eq!(meta.reviewed_scope[0].hash, "dead");
        assert!(meta.verified_at.is_some(), "verify stamp landed: {raw}");
    }

    #[test]
    fn stamp_scope_is_the_sorted_union_of_all_rounds() {
        // spec「验证指纹锚与失效判定」：指纹范围＝工单各轮 Scope 联集（去重、排序）。
        let store = finished_change();
        add_round(&VERIFY, &store, "demo", ROUND_1).expect("round 1: a + b");
        add_round(&VERIFY, &store, "demo", CLEAN_ROUND).expect("round 2: a only");
        stamp_demo(&store, false).expect("stamp");
        let meta = crate::model::ChangeMeta::from_text(Some(&store.meta("demo"))).expect("parses");
        let paths: Vec<&str> = meta.verified_scope.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, vec!["crates/a/src/lib.rs", "crates/b/src/util.rs"]);
        assert_eq!(meta.verified_scope[0].hash, content_fingerprint(FILE_A));
        assert_eq!(meta.verified_scope[1].hash, content_fingerprint(FILE_B));
    }

    #[test]
    fn restamp_replaces_verified_fields_without_duplication() {
        // 重验后重盖：五字段原位更新（含多行 verified_scope 区块），不留重复键，
        // 其余字段（含审查章）逐字节保留。
        let old = "schema: spec-driven\ncreated: 2026-07-01\nverified_at: 2026-07-10\nverified_by: Old <o@example.com>\nverified_with: codex\nverified_tasks_total: 3\nverified_scope:\n  - path: old/file.rs\n    hash: deadbeef\nboard_rank: n\n";
        let store = TestStore::with_meta("demo", old);
        store.put_artifact("demo", "tasks.md", TASKS_5_DONE);
        add_round(&VERIFY, &store, "demo", CLEAN_ROUND).expect("round");
        stamp_demo(&store, false).expect("re-stamp");
        let raw = store.meta("demo");
        assert_eq!(raw.matches("verified_at:").count(), 1, "no duplicate keys: {raw}");
        assert_eq!(raw.matches("verified_scope:").count(), 1, "no duplicate keys: {raw}");
        assert!(!raw.contains("old/file.rs"), "stale scope block must be gone: {raw}");
        assert!(raw.contains("board_rank: n\n"), "unrelated fields survive: {raw}");
        let meta = crate::model::ChangeMeta::from_text(Some(&raw)).expect("re-stamped meta parses");
        assert_eq!(meta.verified_tasks_total, Some(5));
        assert_eq!(meta.verified_scope.len(), 1);
        assert_eq!(meta.verified_scope[0].path, "crates/a/src/lib.rs");
    }

    #[test]
    fn stamp_normalizes_backslash_paths_into_meta() {
        // spec「路径范式…与审查站比特级同构」：Windows 路径 `\` → `/` 后入章，
        // 否则同一档在两个平台指纹成两笔、章永远 stale。
        let store = finished_change();
        add_round(&VERIFY, &store, "demo", "**Scope**: crates\\a\\src\\lib.rs\n").expect("round");
        stamp_demo(&store, false).expect("stamp");
        let meta = crate::model::ChangeMeta::from_text(Some(&store.meta("demo"))).expect("parses");
        assert_eq!(meta.verified_scope[0].path, "crates/a/src/lib.rs");
    }

    #[test]
    fn stamp_quotes_scalars_so_yaml_metacharacters_survive() {
        // 身分／工具／path 以未引号纯量直写会注入字段或炸掉整份 meta——而工单已在
        // 同一步删除，无从回复。写入端负责引号（与审查站同一道 yaml_scalar）。
        let store = TestStore::with_meta("demo", META);
        store.put_artifact("demo", "tasks.md", TASKS_5_DONE);
        add_round(&VERIFY, &store, "demo", "**Scope**: src/@odd #1.rs\n").expect("round");
        let repo: &[(&str, &str)] = &[("src/@odd #1.rs", FILE_A)];
        stamp(
            &VERIFY,
            &store,
            "demo",
            false,
            Some("Ver: the #1 <v@example.com>\nboard_rank: injected"),
            Some("codex: cli"),
            None,
            &files(repo),
            &present(repo),
        )
        .expect("stamp");
        let raw = store.meta("demo");
        let meta = crate::model::ChangeMeta::from_text(Some(&raw)).expect("meta must parse: {raw}");
        assert_eq!(meta.verified_scope[0].path, "src/@odd #1.rs", "path round-trips: {raw}");
        assert_eq!(meta.verified_with.as_deref(), Some("codex: cli"), "{raw}");
        assert!(!raw.contains("\nboard_rank: injected"), "no field injection: {raw}");
    }

    #[test]
    fn stamp_records_byte_hash_for_non_utf8_scope_and_freshness_tracks_bytes() {
        // spec Scenario「非 UTF-8 scope 档可盖章」：两站算出的指纹完全一样——共用
        // station 同一份实作（规格称「比特级同构」）；字节变动 → stale、未变 →
        // fresh。
        let store = finished_change();
        add_round(&VERIFY, &store, "demo", "**Scope**: assets/logo.png\n").expect("round");
        let repo: &[(&str, &[u8])] = &[("assets/logo.png", BIN_A)];
        stamp(&VERIFY, &store, "demo", false, None, None, None, &byte_files(repo), &byte_present(repo))
            .expect("a present non-UTF-8 scope file must stamp");
        let meta = crate::model::ChangeMeta::from_text(Some(&store.meta("demo"))).expect("parses");
        // 字节规则本身由 review 侧的 golden 测试钉住；这里钉站别 wiring：
        // 章字段记的就是分流入口算出的值。
        assert_eq!(meta.verified_scope[0].hash, content_fingerprint_bytes(BIN_A));
        let counts = code_counts(5, 5);
        assert_eq!(freshness(&VERIFY, &meta, &counts, &byte_files(repo)), Freshness::Fresh);
        const BIN_A_FLIPPED: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0xFF, 0x01];
        let changed: &[(&str, &[u8])] = &[("assets/logo.png", BIN_A_FLIPPED)];
        assert_eq!(freshness(&VERIFY, &meta, &counts, &byte_files(changed)), Freshness::Stale);
    }

    #[test]
    fn stamp_still_refuses_unreadable_and_all_gone_scope() {
        // 既有语意维持：读不到就拒绝盖章，这条没有因为指纹分流而放宽。两条
        // 拒章路由消息不同，分别比对区别性措辞——只查路径会让路由接错仍绿灯。
        let store = finished_change();
        add_round(&VERIFY, &store, "demo", CLEAN_ROUND).expect("round");
        let err = stamp(&VERIFY, &store, "demo", false, None, None, None, &|_: &str| None, &|_: &str| true)
            .expect_err("present but unreadable must refuse");
        let msg = err.to_string();
        assert!(msg.contains("crates/a/src/lib.rs"), "names the file: {msg}");
        assert!(msg.contains("must be present and readable"), "I/O route wording: {msg}");
        let err = stamp(&VERIFY, &store, "demo", false, None, None, None, &|_: &str| None, &|_: &str| false)
            .expect_err("all-gone union must refuse");
        let msg = err.to_string();
        assert!(msg.contains("crates/a/src/lib.rs"), "names the file: {msg}");
        assert!(msg.contains("gone from the work tree"), "all-gone route wording: {msg}");
        assert_eq!(*store.meta_writes.borrow(), 0);
    }

    #[test]
    fn stamp_refuses_on_corrupt_meta_and_without_a_ticket() {
        // 沿 set_board_rank 的 fail-closed gate：坏 metadata 不得被叠写；无工单
        // 不可盖章。
        let store = finished_change();
        let err = stamp_demo(&store, false).expect_err("no ticket must refuse");
        assert!(err.to_string().contains("no verify ticket"), "{err}");

        const BAD: &str = ": : :\n\t bad yaml [unclosed\n";
        let corrupt = TestStore::with_meta("demo", BAD);
        corrupt.put_artifact("demo", "tasks.md", TASKS_5_DONE);
        add_round(&VERIFY, &corrupt, "demo", CLEAN_ROUND).expect("round");
        let err = stamp_demo(&corrupt, false).expect_err("corrupt meta must refuse");
        assert!(
            err.to_string().contains("specseal/changes/demo/.meta.yaml"),
            "error must name the metadata file: {err}"
        );
        assert_eq!(corrupt.meta("demo"), BAD);
        assert_eq!(*corrupt.meta_writes.borrow(), 0);
        assert!(corrupt.artifact_exists("demo", VERIFY_DOC), "ticket must survive refusal");
    }

    // --- spec「验证指纹锚与失效判定」---

    /// 带完整验证章的 meta：tasks_total 任务锚＋entries 内容锚。
    fn stamped_meta(tasks_total: usize, entries: &[(&str, &str)]) -> crate::model::ChangeMeta {
        let mut y = format!(
            "schema: spec-driven\nverified_at: 2026-08-01\nverified_by: Ver <v@example.com>\nverified_with: claude\nverified_tasks_total: {tasks_total}\nverified_scope:\n"
        );
        for (p, h) in entries {
            y.push_str(&format!("  - path: {p}\n    hash: {h}\n"));
        }
        crate::model::ChangeMeta::from_text(Some(&y)).expect("meta parses")
    }

    #[test]
    fn freshness_matches_the_review_station_bit_for_bit() {
        // spec「路径范式与行尾 CRLF→LF 后 SHA-256 规则 SHALL 与审查站比特级
        // 同构（共用同一实作）」：同一组锚与现值，两站判定必须逐一相同。
        let h = content_fingerprint(FILE_A);
        let path = "crates/a/src/lib.rs";
        let grown = format!("{FILE_A}fn extra() {{}}\n");
        let crlf = FILE_A.replace('\n', "\r\n");
        let cases: &[(&str, &[(&str, &str)], usize, usize, Freshness)] = &[
            ("all anchors match", REPO, 5, 5, Freshness::Fresh),
            ("scope file modified", &[(path, "")], 5, 5, Freshness::Stale),
            ("scope file gone", &[], 5, 5, Freshness::Stale),
            ("task count grew", REPO, 6, 6, Freshness::Stale),
            ("task unchecked", REPO, 5, 4, Freshness::Stale),
        ];
        for (label, repo, total, complete, want) in cases {
            let repo: Vec<(&str, &str)> = repo
                .iter()
                .map(|(p, c)| (*p, if *p == path && c.is_empty() { grown.as_str() } else { *c }))
                .collect();
            let verified = stamped_meta(5, &[(path, h.as_str())]);
            assert_eq!(
                freshness(&VERIFY, &verified, &code_counts(*total, *complete), &files(&repo)),
                *want,
                "verify station, case: {label}"
            );
            let reviewed = crate::model::ChangeMeta {
                reviewed_at: verified.verified_at.clone(),
                reviewed_tasks_total: verified.verified_tasks_total,
                reviewed_scope: verified.verified_scope.clone(),
                ..Default::default()
            };
            assert_eq!(
                freshness(&REVIEW, &reviewed, &code_counts(*total, *complete), &files(&repo)),
                *want,
                "review station must agree, case: {label}"
            );
        }
        // spec Scenario「行尾差异不触发失效」：LF → CRLF 仍 fresh。
        let now = [(path, crlf.as_str())];
        let meta = stamped_meta(5, &[(path, h.as_str())]);
        assert_eq!(freshness(&VERIFY, &meta, &code_counts(5, 5), &files(&now)), Freshness::Fresh);

        // spec Scenario「盖章后补勾手动任务不失效」：勾 [M] 前后皆 fresh。
        let counts = |md: &str| crate::tasks::counts(&crate::tasks::parse(md));
        let open = "- [x] a\n- [x] b\n- [x] c\n- [x] d\n- [ ] [M] 手测\n";
        let checked = "- [x] a\n- [x] b\n- [x] c\n- [x] d\n- [x] [M] 手测\n";
        assert_eq!(freshness(&VERIFY, &meta, &counts(open), &files(REPO)), Freshness::Fresh, "手测未勾");
        assert_eq!(freshness(&VERIFY, &meta, &counts(checked), &files(REPO)), Freshness::Fresh, "手测补勾");

        // binary 分支的两站同构直接钉在同一张表：字节章在两站以同一分流
        // 实作判定——未变 fresh、变动 stale，判定逐一相同。
        const BIN_FLIPPED: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0xFF, 0x01];
        let bin_cases: &[(&str, &[(&str, &[u8])], Freshness)] = &[
            ("binary unchanged", &[(path, BIN_A)], Freshness::Fresh),
            ("binary bytes flipped", &[(path, BIN_FLIPPED)], Freshness::Stale),
        ];
        let h_bin = content_fingerprint_bytes(BIN_A);
        for (label, now, want) in bin_cases {
            let verified = stamped_meta(5, &[(path, h_bin.as_str())]);
            assert_eq!(
                freshness(&VERIFY, &verified, &code_counts(5, 5), &byte_files(now)),
                *want,
                "verify station, case: {label}"
            );
            let reviewed = crate::model::ChangeMeta {
                reviewed_at: verified.verified_at.clone(),
                reviewed_tasks_total: verified.verified_tasks_total,
                reviewed_scope: verified.verified_scope.clone(),
                ..Default::default()
            };
            assert_eq!(
                freshness(&REVIEW, &reviewed, &code_counts(5, 5), &byte_files(now)),
                *want,
                "review station must agree, case: {label}"
            );
        }
    }

    #[test]
    fn freshness_reads_absence_as_unverified() {
        // 缺席读作未验证：无验证章的 meta 没有可判定的锚，即使审查章齐备。
        const REVIEWED_ONLY: &str = "schema: spec-driven\nreviewed_at: 2026-08-01\nreviewed_tasks_total: 5\nreviewed_scope:\n  - path: crates/a/src/lib.rs\n    hash: dead\n";
        let meta = crate::model::ChangeMeta::from_text(Some(REVIEWED_ONLY)).expect("parses");
        assert_eq!(freshness(&VERIFY, &meta, &code_counts(5, 5), &files(REPO)), Freshness::Unknown);
    }
}
