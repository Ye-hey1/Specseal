//! remote workspace 的 handshake 与数据面三类矩阵（规格「handshake 成功后才
//! 创建 remote session」「capability 驱动停用且不伪造缺口」；design「决策 1：
//! RemoteDataSource 的三类覆盖矩阵」「决策 2：capability 描述随 session 创建
//! 产生」「决策 6：极简打开入口与 handshake fail-closed」）。
//!
//! in-process specseal-server：open_workspace 以 project[/repo] 识别
//! handshake——成功回 project/repo 显示名与 capability 描述、403/404/多义
//! 原样回错不建 runtime；直达类逐方法回 server 真值；组合类 set_tasks 中途
//! 失败中止并回报笔数；不支持类回拒绝错误。

use crate::common;

use chrono::{Duration, Utc};
use crate::common::Harness;
use specseal_remote::credentials::{CredentialKind, CredentialStore, MemoryCredentialStore};
use specseal_desktop_lib::remote::{self, RemoteWorkspace, TokenManager};
use specseal_remote::RemoteError;
use specseal_desktop_core::query::PLAN_FIELDS;
use specseal_protocol::query::ChangeSummary;
use specseal_server::identity::{IdentityStore, NewInvitation};
use specseal_store::{CommandContext, DocumentId, TeamStore};
use std::sync::Arc;

const FOUR_TASKS: &str = "- [ ] 1.1 First\n- [ ] 1.2 Second\n- [ ] 1.3 Third\n- [ ] 1.4 Fourth\n";

/// 一条 PAT 凭证入 in-memory store，回传 (credentials, manager)。
fn runtime(h: &Harness) -> (MemoryCredentialStore, Arc<TokenManager>) {
    let store = MemoryCredentialStore::new();
    store
        .set(&h.origin, CredentialKind::Pat, &common::pat_of(h))
        .expect("set pat");
    let manager = Arc::new(TokenManager::new(&h.origin));
    (store, manager)
}

/// handshake 成功开出 workspace。
fn open(
    h: &Harness,
    credentials: &MemoryCredentialStore,
    manager: &Arc<TokenManager>,
) -> RemoteWorkspace {
    let (workspace, _info) =
        remote::open_workspace(&h.origin, "demo", manager, credentials).expect("open workspace");
    workspace
}

/// 种一个讨论文档（concluded fixture 格式）进 demo/backend scope。
fn seed_discussion(store: &dyn TeamStore, slug: &str, topic: &str) {
    let doc = format!(
        "---\ntopic: {topic}\nslug: {slug}\nstatus: concluded\ncreated: 2026-01-02\n---\n\n\
         # Discussion: {topic}\n\n\
         ## Context\n\nFixture context.\n\n\
         ## Rounds\n\n### Round 1 — assumptions (2026-01-02)\n\n**Focus**: scope\n\n\
         ## Conclusion\n\n**Decision**: do it\n"
    );
    let mut uow = store
        .begin_unit_of_work(
            &common::scope(),
            CommandContext {
                command: "seed".into(),
                actor: "seed".into(),
            },
        )
        .expect("begin uow");
    uow.create(
        DocumentId::Discussion {
            slug: slug.into(),
            archived: false,
        },
        &doc,
    );
    store.commit(uow, Vec::new()).expect("seed discussion");
}

// --- 看板字段由生命周期标记驱动（spec desktop-app）---

#[test]
fn change_stage_matrix_follows_the_lifecycle_markers() {
    // spec「字段判定矩阵」Example：0=提案中、1=进行中、2=已就绪。
    fn summary(started_at: Option<&str>, completed: usize, total: usize) -> ChangeSummary {
        ChangeSummary {
            name: "demo".into(),
            summary: String::new(),
            status: "in-progress".into(),
            completed_tasks: completed,
            total_tasks: total,
            restale_from: Vec::new(),
            meta_error: None,
            repo: None,
            lifecycle: None,
            claimed_by: None,
            started_at: started_at.map(str::to_string),
            created_by: None,
            created: None,
            from_discussions: Vec::new(),
            delta_capabilities: Vec::new(),
            modified_at: None,
            review: None,
            verify: None,
            branch: None,
            landed_commit: None,
            fields: Default::default(),
        }
    }
    let cases: [(Option<&str>, usize, usize, u8); 7] = [
        (None, 0, 0, 0),
        (None, 0, 28, 0),
        (None, 3, 28, 1),
        (Some("2026-07-30"), 0, 28, 1),
        (Some("2026-07-30"), 13, 28, 1),
        (None, 28, 28, 2),
        (Some("2026-07-30"), 28, 28, 2),
    ];
    for (started, completed, total, want) in cases {
        assert_eq!(
            remote::change_stage(&summary(started, completed, total)),
            want,
            "started={started:?} progress={completed}/{total}"
        );
    }
}

#[test]
fn started_at_rides_the_remote_change_list_payload() {
    // in-progress 盖章后 startedAt 随清单 payload 进桌面（系统匣与看板同源）。
    let h = common::harness();
    common::seed_change(h.store.as_ref(), FOUR_TASKS);
    {
        let mut uow = h
            .store
            .begin_unit_of_work(
                &common::scope(),
                CommandContext {
                    command: "seed".into(),
                    actor: "seed".into(),
                },
            )
            .expect("begin uow");
        uow.create(
            DocumentId::ChangeMeta {
                change: "started-zero".into(),
            },
            "schema: spec-driven\ncreated: 2026-07-29\nstarted_at: 2026-07-30\nstarted_by: Momo <m@example.com>\n",
        );
        h.store.commit(uow, Vec::new()).expect("seed started change");
    }
    let (credentials, manager) = runtime(&h);
    let ws = open(&h, &credentials, &manager);

    let changes = ws.list_changes(&credentials, None).expect("list changes").changes;
    let started = changes
        .iter()
        .find(|c| c.summary.name == "started-zero")
        .expect("started change listed");
    assert_eq!(
        started.summary.started_at.as_deref(),
        Some("2026-07-30"),
        "startedAt comes from the server meta"
    );
    assert_eq!(
        remote::change_stage(&started.summary),
        1,
        "带 startedAt 且完成数 0 判为进行中"
    );
    let unstarted = changes.iter().find(|c| c.summary.name == "demo").expect("demo listed");
    assert_eq!(unstarted.summary.started_at, None, "未开工 change 不带 startedAt");
    assert_eq!(remote::change_stage(&unstarted.summary), 0, "未开工零进度停在提案中");
}

// --- 打开入口：handshake fail-closed ---

#[test]
fn open_handshakes_and_returns_identity_and_capability_description() {
    let h = common::harness();
    common::seed_change(h.store.as_ref(), FOUR_TASKS);
    let (credentials, manager) = runtime(&h);

    // 单 repo 的 project：省略 repo 由 server 自动绑定。
    let (_, info) =
        remote::open_workspace(&h.origin, "demo", &manager, &credentials).expect("open");
    assert_eq!(info.project_key, "demo");
    assert_eq!(info.project_name, "Demo", "handshake 回的 project 显示名");
    assert_eq!(info.repo_key, "backend", "单 repo 自动绑定");
    assert_eq!(info.repo_name, "backend");

    // 显式 project/repo 形式同样成立。
    let (_, info2) =
        remote::open_workspace(&h.origin, "demo/backend", &manager, &credentials).expect("open");
    assert_eq!(info2.repo_key, "backend");

    // capability 描述：直达／组合类为真、不支持类为假（决策 1 矩阵）。
    let caps = &info.capabilities;
    for (name, on) in [
        ("listChanges", caps.list_changes),
        ("listSpecs", caps.list_specs),
        ("status", caps.status),
        ("getDocument", caps.get_document),
        ("setTaskDone", caps.set_task_done),
        ("setAllTasks", caps.set_all_tasks),
        ("archive", caps.archive),
        ("listDiscussions", caps.list_discussions),
        ("getDiscussionDocument", caps.get_discussion_document),
        ("promoteDiscussion", caps.promote_discussion),
        ("archiveDiscussion", caps.archive_discussion),
        ("listArchived", caps.list_archived),
        ("getArchivedDocument", caps.get_archived_document),
        ("archivedCapabilities", caps.archived_capabilities),
        ("searchWorkspace", caps.search_workspace),
        ("getSpecDocument", caps.get_spec_document),
        // remote-verb-parity：动词端点直达，editor handshake 四栏全真。
        ("validate", caps.validate),
        ("analyze", caps.analyze),
        ("deleteChange", caps.delete_change),
        ("moveTask", caps.move_task),
        // remote-board-order：看板拖排直达 board resource，editor 为真。
        ("reorderCard", caps.reorder_card),
        // remote-read-parity：change 诠释数据与 capability 清单以 status
        // payload 既有字段映射——数据已在 wire 上，capability 为真。
        ("changeMeta", caps.change_meta),
        ("changeCapabilities", caps.change_capabilities),
        // remote-claim-ownership：editor handshake 的认领面为真。
        ("claim", caps.claim),
    ] {
        assert!(on, "{name} 是直达／组合／payload 映射类，capability 应为真");
    }
    assert!(
        caps.live_updates,
        "handshake 声明了 SSE 与 polling——事件能力为真"
    );
}

#[test]
fn open_fails_closed_on_403_404_and_ambiguity() {
    let h = common::harness();
    common::seed_change(h.store.as_ref(), FOUR_TASKS);

    // 403：有效 token、非成员——server 拒绝原样呈现。
    let stranger_invite = h
        .identity
        .create_invitation(NewInvitation {
            email: "stranger@example.com".to_string(),
            display: "Stranger".to_string(),
            memberships: vec![],
            admin: false,
            expires_at: Utc::now() + Duration::days(1),
        })
        .expect("invite");
    let stranger_id = h
        .identity
        .accept_invitation(&stranger_invite, "pw-stranger")
        .expect("accept");
    let (_, stranger_pat) = h
        .identity
        .create_pat(&stranger_id, "test", None)
        .expect("pat");
    let credentials = MemoryCredentialStore::new();
    credentials
        .set(&h.origin, CredentialKind::Pat, &stranger_pat)
        .expect("set");
    let manager = Arc::new(TokenManager::new(&h.origin));
    let err = remote::open_workspace(&h.origin, "demo", &manager, &credentials)
        .expect_err("非成员 fail-closed");
    assert_eq!(err.status, Some(403), "403 原样回错：{}", err.message);

    // 404：不存在的 project。
    let (credentials, manager) = runtime(&h);
    let err = remote::open_workspace(&h.origin, "nope", &manager, &credentials)
        .expect_err("不存在的 project fail-closed");
    assert_eq!(err.status, Some(404));
    assert!(
        err.message.contains("nope"),
        "server 错误原样呈现：{}",
        err.message
    );

    // 多义：multi 有两个 repo、未指定——server 的 refused 原样呈现。
    let err = remote::open_workspace(&h.origin, "multi", &manager, &credentials)
        .expect_err("多 repo 未指定 fail-closed");
    assert_eq!(err.status, Some(409));
    assert!(
        err.message.contains("web") && err.message.contains("api"),
        "多义拒绝带候选清单：{}",
        err.message
    );
}

#[test]
fn remote_open_failure_serializes_machine_readable_fields_without_credentials() {
    let cases = [
        ("transport", None, None),
        ("unauthorized", Some("permission_denied"), Some(401)),
        ("forbidden", Some("permission_denied"), Some(403)),
        ("missing", Some("not_found"), Some(404)),
        ("unknown", Some("future_reason"), Some(599)),
    ];

    for (message, reason, status) in cases {
        let failure = remote::RemoteOpenFailure::from(RemoteError {
            message: message.to_string(),
            reason: reason.map(str::to_string),
            status,
            evidence: None,
        });
        let value = serde_json::to_value(failure).expect("serialize remote_open failure");
        let object = value.as_object().expect("failure is an object");

        assert_eq!(object.len(), 3, "failure payload 只允许三个公开字段");
        assert_eq!(object.get("message").and_then(|v| v.as_str()), Some(message));
        assert_eq!(object.get("reason").and_then(|v| v.as_str()), reason);
        assert_eq!(object.get("status").and_then(|v| v.as_u64()), status.map(u64::from));
        for forbidden in [
            "token",
            "accessToken",
            "refreshCredential",
            "pat",
            "authorization",
            "keychain",
        ] {
            assert!(!object.contains_key(forbidden), "不得串行化 {forbidden}");
        }
    }
}

// --- 直达类：逐方法回 server 真值 ---

#[test]
fn changes_specs_and_artifacts_read_server_truth() {
    let h = common::harness();
    common::seed_change(h.store.as_ref(), FOUR_TASKS);
    {
        let mut uow = h
            .store
            .begin_unit_of_work(
                &common::scope(),
                CommandContext {
                    command: "seed".into(),
                    actor: "seed".into(),
                },
            )
            .expect("begin uow");
        uow.create(
            DocumentId::CanonicalSpec {
                capability: "auth".into(),
            },
            "## Purpose\n\nAuth canon.\n",
        );
        h.store.commit(uow, Vec::new()).expect("seed spec");
    }
    let (credentials, manager) = runtime(&h);
    let ws = open(&h, &credentials, &manager);

    let changes = ws.list_changes(&credentials, None).expect("list changes");
    assert_eq!(changes.changes.len(), 1);
    assert_eq!(changes.changes[0].summary.name, "demo");
    assert_eq!(changes.changes[0].summary.total_tasks, 4, "任务数是 server 真值");

    let specs = ws.list_specs(&credentials).expect("list specs");
    assert!(
        specs.specs.iter().any(|s| s.id == "auth"),
        "正式规格清单：{:?}",
        specs.specs
    );

    let status = ws.change_status(&credentials, "demo").expect("status");
    assert_eq!(status.change_name, "demo");
    assert_eq!(status.schema_name, "spec-driven");
    assert!(
        status.artifacts.iter().any(|a| a.id == "tasks"),
        "artifact 状态来自 server"
    );

    let doc = ws
        .document(&credentials, "demo", "tasks")
        .expect("document");
    assert!(
        doc.content.contains("- [ ] 1.1 First"),
        "artifact 内文是 server 真值"
    );

    // SpecsealDataSource 的寻址是文件名（proposal.md、tasks.md、specs/{cap}/spec.md）
    // ——server 端点吃 artifact id；runtime 单点范式，UI 文件名不得漏成 400。
    let doc = ws
        .document(&credentials, "demo", "tasks.md")
        .expect("文件名寻址同样成立");
    assert!(doc.content.contains("- [ ] 1.1 First"));
    let err = ws
        .document(&credentials, "demo", "proposal.md")
        .expect_err("不存在的 artifact 是 404");
    assert_eq!(
        err.status,
        Some(404),
        "文件名范式后缺席是 not_found、不是 invalid_argument"
    );
}

#[test]
fn archived_spec_document_and_search_reads_reach_server_truth() {
    let h = common::harness();
    common::seed_change(h.store.as_ref(), FOUR_TASKS);
    seed_discussion(h.store.as_ref(), "search-talk", "RemoteNeedle discussion");
    let dated_name = "2026-07-19-old-feature";
    let mut uow = h
        .store
        .begin_unit_of_work(
            &common::scope(),
            CommandContext {
                command: "seed-read-surfaces".into(),
                actor: "seed".into(),
            },
        )
        .expect("begin uow");
    for (document, content) in [
        (
            DocumentId::CanonicalSpec {
                capability: "auth".into(),
            },
            "# auth Specification\n\nRemote canonical truth.\n",
        ),
        (
            DocumentId::ChangeArtifact {
                change: "demo".into(),
                artifact: "proposal.md".into(),
            },
            "## Why\n\nRemoteNeedle in a change.\n",
        ),
        (
            DocumentId::ArchivedChange {
                change: dated_name.into(),
                doc: ".openspec.yaml".into(),
            },
            "schema: spec-driven\ncreated_by: Creator\nfrom_discussion: source-talk\n",
        ),
        (
            DocumentId::ArchivedChange {
                change: dated_name.into(),
                doc: "proposal.md".into(),
            },
            "## Why\n\nRemote archived truth.\n",
        ),
        (
            DocumentId::ArchivedChange {
                change: dated_name.into(),
                doc: "tasks.md".into(),
            },
            "- [x] 1.1 Done\n",
        ),
        (
            DocumentId::ArchivedChange {
                change: dated_name.into(),
                doc: "specs/auth/spec.md".into(),
            },
            "## ADDED Requirements\n\n### Requirement: Login\n",
        ),
    ] {
        uow.create(document, content);
    }
    h.store.commit(uow, Vec::new()).expect("seed read surfaces");

    let (credentials, manager) = runtime(&h);
    let ws = open(&h, &credentials, &manager);
    assert_eq!(
        ws.spec_document(&credentials, "auth")
            .expect("spec document")
            .content,
        "# auth Specification\n\nRemote canonical truth.\n"
    );

    let archived = ws.list_archived(&credentials).expect("archived list");
    let entry = archived
        .archived
        .iter()
        .find(|entry| entry.item.dated_name == dated_name)
        .expect("archived item");
    let item = &entry.item;
    assert_eq!(item.tasks_done, Some(1));
    assert_eq!(item.spec_count, 1);
    assert_eq!(item.created_by.as_deref(), Some("Creator"));
    assert_eq!(item.from_discussions, ["source-talk"]);
    // 没有章也没有化石工单：两个关卡的结局都是 none。
    assert_eq!((entry.review_status, entry.verify_status), (Some("none"), Some("none")));
    assert_eq!(
        ws.archived_document(&credentials, dated_name, "proposal.md")
            .expect("archived document")
            .content,
        "## Why\n\nRemote archived truth.\n"
    );
    assert_eq!(
        ws.archived_capabilities(&credentials, dated_name)
            .expect("archived capabilities"),
        ["auth"]
    );

    let search = ws
        .search_workspace(&credentials, "remoteneedle")
        .expect("search");
    assert_eq!(search.hits.len(), 2);
    assert!(search.hits.iter().any(|hit| hit.kind == "change"));
    assert!(search.hits.iter().any(|hit| hit.kind == "discussion"));
}

#[test]
fn task_flips_claim_and_archive_write_through() {
    let h = common::harness();
    common::seed_change(h.store.as_ref(), FOUR_TASKS);
    {
        // 一个 delta spec 让 archive 有 capability 可折入正典。
        let mut uow = h
            .store
            .begin_unit_of_work(
                &common::scope(),
                CommandContext {
                    command: "seed".into(),
                    actor: "seed".into(),
                },
            )
            .expect("begin uow");
        uow.create(
            DocumentId::ChangeArtifact {
                change: "demo".into(),
                artifact: "specs/auth/spec.md".into(),
            },
            // 新开 capability 的 delta 自带合格 Purpose，否则封存被 Purpose 守门挡下
            // （spec archive-merge「新 capability 的 Purpose 自 delta 带入」）。
            "## Purpose\n\n本 capability 负责用户登录与注销的可观察行为，涵盖工作阶段的创建、续期与撤销三段流程。\n\n\
             ## ADDED Requirements\n\n### Requirement: Login\n\nUsers SHALL log in.\n\n\
             #### Scenario: ok\n\n- **WHEN** login\n- **THEN** ok\n",
        );
        h.store.commit(uow, Vec::new()).expect("seed delta spec");
    }
    let (credentials, manager) = runtime(&h);
    let ws = open(&h, &credentials, &manager);

    ws.set_task_done(&credentials, "demo", "1", true)
        .expect("task done");
    let doc = ws
        .document(&credentials, "demo", "tasks")
        .expect("document");
    assert!(
        doc.content.contains("- [x] 1.1 First"),
        "勾选写穿 server：{}",
        doc.content
    );

    ws.set_task_done(&credentials, "demo", "1", false)
        .expect("task undone");
    let doc = ws
        .document(&credentials, "demo", "tasks")
        .expect("document");
    assert!(
        doc.content.contains("- [ ] 1.1 First"),
        "取消勾选写穿 server"
    );

    let claim = ws.claim(&credentials, "demo").expect("claim");
    assert_eq!(
        claim.claimed_by.as_deref(),
        Some(common::ACTOR_IDENTITY),
        "claim 回实际 actor"
    );

    // 封存前补完任务——单笔封存的任务完成度守门（archive-readiness-gating）
    // 一体适用 server 信道，未完成 change 会被拒绝。
    for task in ["1", "2", "3", "4"] {
        ws.set_task_done(&credentials, "demo", task, true)
            .expect("complete before archive");
    }

    let archived = ws.archive(&credentials, "demo", false, false).expect("archive");
    assert_eq!(archived.specs.len(), 1, "delta spec 折入正典");
    assert_eq!(archived.specs[0].capability, "auth");
    let changes = ws.list_changes(&credentials, None).expect("list changes");
    assert!(changes.changes.is_empty(), "archive 后不在 active 清单");
}

// --- spec desktop-app「remote 项目的审查与验证标示」（station-status-and-landing D7）---

const ONE_TASK_DONE: &str = "- [x] 1.1 Only\n";
const REVIEW_TICKET: &str = "# Review — demo\n\n## Round 1\n\n**Scope**: src/a.rs\n";
const VERIFY_TICKET: &str = "# Verify — demo\n\n## Round 1\n\n**Scope**: src/a.rs\n";

fn artifact(change: &str, artifact: &str) -> DocumentId {
    DocumentId::ChangeArtifact { change: change.into(), artifact: artifact.into() }
}

/// 一份已审查的 meta：任务锚 `tasks_total`、scope 是 `src/a.rs`（内容 `fn a() {}`）。
fn reviewed_meta(tasks_total: usize) -> String {
    reviewed_meta_at(tasks_total, None)
}

/// 同上，章另外记下盖章时的 commit。
fn reviewed_meta_at(tasks_total: usize, commit: Option<&str>) -> String {
    let hash = specseal_core::station::content_fingerprint("fn a() {}\n");
    let commit = commit.map(|c| format!("reviewed_commit: \"{c}\"\n")).unwrap_or_default();
    format!(
        "schema: spec-driven\ncreated: 2026-11-01\nreviewed_at: 2026-11-02T10:00:00+08:00\n\
         reviewed_by: Rev <r@example.com>\nreviewed_tasks_total: {tasks_total}\nreviewed_rounds: 1\n{commit}\
         reviewed_scope:\n  - path: src/a.rs\n    hash: {hash}\n"
    )
}

fn git_in(dir: &std::path::Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git").args(args).current_dir(dir).output().expect("run git");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// 清单 payload 里名为 `name` 的那一项（串行化后，即前端看到的形状）。
fn listed(list: &remote::RemoteChangeList, name: &str) -> serde_json::Value {
    let payload = serde_json::to_value(list).expect("serialize list");
    payload["changes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == name)
        .unwrap_or_else(|| panic!("{name} in {payload}"))
        .clone()
}

#[test]
fn the_remote_list_carries_the_station_statuses_the_board_reads() {
    // Scenarios「remote 看板显示审查中」「没有 checkout 时只看任务数」：键与本机清单项相同。
    let h = common::harness();
    seed_docs(
        h.store.as_ref(),
        &[
            (change_meta("in-review"), "schema: spec-driven\ncreated: 2026-11-01\n"),
            (artifact("in-review", "tasks.md"), ONE_TASK_DONE),
            (artifact("in-review", "review.md"), REVIEW_TICKET),
            (change_meta("reviewed"), &reviewed_meta(1)),
            (artifact("reviewed", "tasks.md"), ONE_TASK_DONE),
            (artifact("reviewed", "verify.md"), VERIFY_TICKET),
            (change_meta("recounted"), &reviewed_meta(3)),
            (artifact("recounted", "tasks.md"), ONE_TASK_DONE),
            (change_meta("plain"), "schema: spec-driven\ncreated: 2026-11-01\n"),
        ],
    );
    let (credentials, manager) = runtime(&h);
    let ws = open(&h, &credentials, &manager);
    let list = ws.list_changes(&credentials, None).expect("list changes");

    let in_review = listed(&list, "in-review");
    assert_eq!(in_review["reviewStatus"], "inReview", "{in_review}");
    assert_eq!(in_review["verifyStatus"], "none");
    assert!(in_review.get("reviewedAt").is_none(), "a ticket carries no stamp fields");

    let reviewed = listed(&list, "reviewed");
    assert_eq!(reviewed["reviewStatus"], "reviewed", "the task count matches: {reviewed}");
    assert_eq!(reviewed["reviewedAt"], "2026-11-02");
    assert_eq!(reviewed["reviewedBy"], "Rev <r@example.com>");
    assert_eq!(reviewed["verifyStatus"], "inVerify", "the two stations are judged apart");

    let recounted = listed(&list, "recounted");
    assert_eq!(recounted["reviewStatus"], "reviewedStale", "stamped over 3 tasks, 1 now: {recounted}");

    let plain = listed(&list, "plain");
    assert_eq!((&plain["reviewStatus"], &plain["verifyStatus"]), (&serde_json::json!("none"), &serde_json::json!("none")));
}

#[test]
fn a_checkout_turns_a_stamp_stale_when_a_scope_file_differs() {
    // Scenario「有 checkout 时侦测其后有变动」：任务数相符的已盖章变更，再拿单笔回应
    // 的 scope 比 checkout 里文件的现值。
    // checkout 是一个 git repo，章记下的 commit 就是它的 HEAD——checkout 握有盖章的那一版。
    let checkout = tempfile::tempdir().expect("checkout dir");
    for args in [&["init", "-q", "-b", "main"][..], &["config", "user.name", "T"], &["config", "user.email", "t@example.com"], &["config", "commit.gpgsign", "false"]] {
        git_in(checkout.path(), args);
    }
    std::fs::create_dir_all(checkout.path().join("src")).unwrap();
    let file = checkout.path().join("src").join("a.rs");
    std::fs::write(&file, "fn a() {}\n").unwrap();
    git_in(checkout.path(), &["add", "src/a.rs"]);
    git_in(checkout.path(), &["commit", "-q", "-m", "init"]);
    let head = git_in(checkout.path(), &["rev-parse", "HEAD"]);

    let h = common::harness();
    seed_docs(
        h.store.as_ref(),
        &[
            (change_meta("demo"), &reviewed_meta_at(1, Some(&head))),
            (artifact("demo", "tasks.md"), ONE_TASK_DONE),
            // 章盖在这个 checkout 没有的 commit 上：不比文件。
            (change_meta("elsewhere"), &reviewed_meta_at(1, Some("0123456789abcdef0123456789abcdef01234567"))),
            (artifact("elsewhere", "tasks.md"), ONE_TASK_DONE),
        ],
    );
    let (credentials, manager) = runtime(&h);
    let ws = open(&h, &credentials, &manager);
    let status = |ws: &RemoteWorkspace| {
        listed(&ws.list_changes(&credentials, Some(checkout.path())).expect("list changes"), "demo")["reviewStatus"]
            .clone()
    };

    std::fs::write(&file, "fn a() {}\n").unwrap();
    assert_eq!(status(&ws), "reviewed", "the checkout holds the stamped content");
    std::fs::write(&file, "fn a() { changed(); }\n").unwrap();
    assert_eq!(status(&ws), "reviewedStale", "the file changed after the stamp");
    let elsewhere = listed(&ws.list_changes(&credentials, Some(checkout.path())).unwrap(), "elsewhere");
    assert_eq!(elsewhere["reviewStatus"], "reviewed", "stamped on a commit this checkout does not hold");
    std::fs::remove_file(&file).unwrap();
    assert_eq!(status(&ws), "reviewedStale", "a scope file that is gone reads as changed");
    // 没有 checkout：只比任务数。
    let unbound = ws.list_changes(&credentials, None).expect("list changes");
    assert_eq!(listed(&unbound, "demo")["reviewStatus"], "reviewed");
}

#[test]
fn archiving_a_remote_change_in_review_carries_the_ticket_when_told_to() {
    // Scenario「封存审查中的 remote 变更」：不带旗标被拒；带上保留审查工单的旗标后封存，
    // 已封存清单显示曾审查未通过。
    let h = common::harness();
    seed_docs(
        h.store.as_ref(),
        &[
            (change_meta("demo"), "schema: spec-driven\ncreated: 2026-11-01\n"),
            (artifact("demo", "tasks.md"), ONE_TASK_DONE),
            (artifact("demo", "review.md"), REVIEW_TICKET),
        ],
    );
    let (credentials, manager) = runtime(&h);
    let ws = open(&h, &credentials, &manager);

    let refused = ws.archive(&credentials, "demo", false, false).expect_err("an open ticket refuses the archive");
    assert!(refused.message.contains("review ticket"), "{}", refused.message);

    ws.archive(&credentials, "demo", true, false).expect("archive carrying the review ticket");
    let archived = ws.list_archived(&credentials).expect("archived list");
    let entry = archived.archived.iter().find(|e| e.item.name == "demo").expect("archived demo");
    assert_eq!(entry.review_status, Some("reviewedNotPassed"));
    assert_eq!(entry.verify_status, Some("none"));
    let payload = serde_json::to_value(&archived).expect("serialize archived list");
    assert_eq!(payload["archived"][0]["reviewStatus"], "reviewedNotPassed", "{payload}");
}

#[test]
fn discarding_a_remote_ticket_lets_the_archive_go_on() {
    // 三选项对话框的「放弃审查」在 remote 也作用：工单删掉后一般封存放行。
    let h = common::harness();
    seed_docs(
        h.store.as_ref(),
        &[
            (change_meta("demo"), "schema: spec-driven\ncreated: 2026-11-01\n"),
            (artifact("demo", "tasks.md"), ONE_TASK_DONE),
            (artifact("demo", "verify.md"), VERIFY_TICKET),
        ],
    );
    let (credentials, manager) = runtime(&h);
    let ws = open(&h, &credentials, &manager);
    ws.discard_station(&credentials, "demo", "verify").expect("discard the verify ticket");
    assert_eq!(listed(&ws.list_changes(&credentials, None).unwrap(), "demo")["verifyStatus"], "none");
    ws.archive(&credentials, "demo", false, false).expect("archive");
}

#[test]
fn board_reorder_writes_the_board_resource_only_and_meta_is_untouched() {
    // 规格「board resource 为 scope 单文档且 server 不解析」Scenario「拖排不动
    // 卡片文档」＋「看板卡片顺序以 board_rank 字段为真相」修订后的 remote 不写
    // meta 断言：拖排后只有 board resource 产生新 revision。
    let h = common::harness();
    common::seed_named_change(h.store.as_ref(), "alpha", FOUR_TASKS);
    common::seed_named_change(h.store.as_ref(), "bravo", FOUR_TASKS);
    common::seed_named_change(h.store.as_ref(), "carol", FOUR_TASKS);
    let (credentials, manager) = runtime(&h);
    let ws = open(&h, &credentials, &manager);

    let read_meta = |name: &str| {
        let snap = h.store.snapshot(&common::scope()).expect("snapshot");
        snap.read(&DocumentId::ChangeMeta {
            change: name.into(),
        })
        .expect("read meta")
        .expect("meta exists")
    };
    let before: Vec<_> = ["alpha", "bravo", "carol"].map(read_meta).into();

    ws.reorder_card(&credentials, "change", "carol", None, Some("alpha"))
        .expect("reorder lands");

    let snap = h.store.snapshot(&common::scope()).expect("snapshot");
    snap.read(&DocumentId::BoardOrder)
        .expect("read board resource")
        .expect("board resource created by the first reorder");
    for (name, was) in ["alpha", "bravo", "carol"].iter().zip(before) {
        let now = read_meta(name);
        assert_eq!(now.content, was.content, "{name} 的 meta 内容不变");
        assert_eq!(now.revision, was.revision, "{name} 的 meta revision 不变");
    }

    // 清单 overlay 反映新序：carol 移到栏顶（alpha 之前），跨读取持久。
    let changes = ws.list_changes(&credentials, None).expect("list changes");
    let names: Vec<&str> = changes.changes.iter().map(|c| c.summary.name.as_str()).collect();
    let pos = |n: &str| names.iter().position(|x| *x == n).expect("card present");
    assert!(pos("carol") < pos("alpha"), "拖排后 carol 在 alpha 前：{names:?}");
}

// --- 规格「remote 变更清单的调度字段」「remote 排序 overlay 与本地语意同构」---

/// 一次 commit 新建多份文档进 demo/backend scope。
fn seed_docs(store: &dyn TeamStore, docs: &[(DocumentId, &str)]) {
    let mut uow = store
        .begin_unit_of_work(
            &common::scope(),
            CommandContext {
                command: "seed".into(),
                actor: "seed".into(),
            },
        )
        .expect("begin uow");
    for (id, content) in docs {
        uow.create(id.clone(), *content);
    }
    store.commit(uow, Vec::new()).expect("seed docs");
}

fn change_meta(name: &str) -> DocumentId {
    DocumentId::ChangeMeta {
        change: name.into(),
    }
}

#[test]
fn change_list_follows_the_plan_order_and_carries_the_schedule_fields() {
    // Scenario「remote 清单带调度字段」＋「变更卡依 plan 配置顺序」：board 的
    // rank 让 add-b 在前，但 add-b 依赖 add-a——清单照 plan 排成 add-a、add-b。
    let h = common::harness();
    seed_docs(
        h.store.as_ref(),
        &[
            (change_meta("add-a"), "schema: spec-driven\ncreated: 2026-09-01\n"),
            (
                change_meta("add-b"),
                "schema: spec-driven\ncreated: 2026-09-02\ndepends_on: add-a\n",
            ),
            (
                DocumentId::BoardOrder,
                r#"{"changes":{"add-b":"b","add-a":"f"},"discussions":{"beta":"b","alpha":"f"}}"#,
            ),
        ],
    );
    seed_discussion(h.store.as_ref(), "alpha", "Alpha");
    seed_discussion(h.store.as_ref(), "beta", "Beta");
    let (credentials, manager) = runtime(&h);
    let ws = open(&h, &credentials, &manager);

    let list = ws.list_changes(&credentials, None).expect("list changes");
    let names: Vec<&str> = list.changes.iter().map(|c| c.summary.name.as_str()).collect();
    assert_eq!(names, ["add-a", "add-b"], "plan order, not the board overlay");
    assert_eq!(list.plan_error, None);
    let payload = serde_json::to_value(&list).expect("serialize list");
    assert_eq!(payload["planError"], serde_json::Value::Null, "planError always travels");
    assert_eq!(payload["changes"][0]["wave"], 1);
    assert_eq!(payload["changes"][0]["blockedBy"], serde_json::json!([]));
    assert_eq!(payload["changes"][1]["name"], "add-b");
    assert_eq!(payload["changes"][1]["wave"], 2);
    assert_eq!(payload["changes"][1]["blockedBy"], serde_json::json!(["add-a"]));
    assert_eq!(payload["changes"][1]["dependsOn"], serde_json::json!(["add-a"]));
    assert_eq!(payload["changes"][1]["overlaps"], serde_json::json!([]));
    assert_eq!(payload["changes"][1]["totalTasks"], 0, "ChangeSummary fields stay flat");

    // 讨论卡仍照 board resource overlay。
    let discussions = ws.list_discussions(&credentials).expect("list discussions");
    let slugs: Vec<&str> = discussions.active.iter().map(|d| d.slug.as_str()).collect();
    assert_eq!(slugs, ["beta", "alpha"]);
}

#[test]
fn merge_plan_carries_six_plan_fields() {
    // Scenario「remote 清单带调度字段」：add-b 依赖 add-a，add-b 与 add-c MODIFIED
    // 同一个 requirement；board 的 rank 让 add-c 配置在 add-b 前——server 的 plan
    // 带来的调度字段全部叠到 add-b 上，archiveAfter 为 ["add-c"]。
    let h = common::harness();
    let modified = |change: &str| DocumentId::ChangeArtifact {
        change: change.into(),
        artifact: "specs/desktop-app/spec.md".into(),
    };
    let delta = "## MODIFIED Requirements\n\n### Requirement: 看板与任务\n\nbody\n";
    seed_docs(
        h.store.as_ref(),
        &[
            (change_meta("add-a"), "schema: spec-driven\ncreated: 2026-09-01\n"),
            (
                change_meta("add-b"),
                "schema: spec-driven\ncreated: 2026-09-02\ndepends_on: add-a\n",
            ),
            (change_meta("add-c"), "schema: spec-driven\ncreated: 2026-09-03\n"),
            (modified("add-b"), delta),
            (modified("add-c"), delta),
            (DocumentId::BoardOrder, r#"{"changes":{"add-b":"b","add-c":"c","add-a":"f"}}"#),
        ],
    );
    let (credentials, manager) = runtime(&h);
    let ws = open(&h, &credentials, &manager);

    let list = ws.list_changes(&credentials, None).expect("list changes");
    let names: Vec<&str> = list.changes.iter().map(|c| c.summary.name.as_str()).collect();
    assert_eq!(names, ["add-c", "add-a", "add-b"], "plan order");
    let payload = serde_json::to_value(&list).expect("serialize list");
    let add_b = &payload["changes"][2];
    assert_eq!(add_b["wave"], 2, "{add_b}");
    assert_eq!(add_b["blockedBy"], serde_json::json!(["add-a"]), "{add_b}");
    assert_eq!(add_b["dependsOn"], serde_json::json!(["add-a"]), "{add_b}");
    assert_eq!(
        add_b["overlaps"],
        serde_json::json!([{ "change": "add-c", "capabilities": ["desktop-app"] }]),
        "{add_b}"
    );
    assert_eq!(
        add_b["requirementOverlap"],
        serde_json::json!([{
            "change": "add-c",
            "capability": "desktop-app",
            "requirement": "看板与任务",
            "ownOperation": "MODIFIED",
            "otherOperation": "MODIFIED",
            "conflict": false,
        }]),
        "{add_b}"
    );
    assert_eq!(add_b["archiveAfter"], serde_json::json!(["add-c"]), "{add_b}");
    // 配置在前的 add-c 不必等任何人封存。
    assert_eq!(payload["changes"][0]["archiveAfter"], serde_json::json!([]));
}

#[test]
fn a_plan_cycle_falls_back_to_the_board_overlay_with_the_cycle_message() {
    // Scenario「remote 成环退回」：plan 回 409 → board overlay 序、调度字段缺席、
    // planError 为消息。
    let h = common::harness();
    seed_docs(
        h.store.as_ref(),
        &[
            (
                change_meta("add-a"),
                "schema: spec-driven\ncreated: 2026-09-01\ndepends_on: add-b\n",
            ),
            (
                change_meta("add-b"),
                "schema: spec-driven\ncreated: 2026-09-02\ndepends_on: add-a\n",
            ),
            (DocumentId::BoardOrder, r#"{"changes":{"add-b":"b","add-a":"f"}}"#),
        ],
    );
    let (credentials, manager) = runtime(&h);
    let ws = open(&h, &credentials, &manager);

    let list = ws.list_changes(&credentials, None).expect("a cycle still lists");
    let names: Vec<&str> = list.changes.iter().map(|c| c.summary.name.as_str()).collect();
    assert_eq!(names, ["add-b", "add-a"], "board overlay order");
    assert_eq!(
        list.plan_error.as_deref(),
        Some("dependency cycle: add-b -> add-a -> add-b")
    );
    let payload = serde_json::to_value(&list).expect("serialize list");
    for item in payload["changes"].as_array().expect("changes") {
        for field in PLAN_FIELDS {
            assert!(item.get(field).is_none(), "{field} is absent on a cycle: {item}");
        }
    }
}

#[test]
fn a_remote_drag_across_a_declared_dependency_sends_no_put() {
    // change-plan Scenario「remote 拖排违反依赖不发 PUT」：add-b 依赖 add-a，把
    // add-b 拖到 add-a 之前——单行错误、board resource 的内容与 revision 皆不变。
    let h = common::harness();
    seed_docs(
        h.store.as_ref(),
        &[
            (change_meta("add-a"), "schema: spec-driven\ncreated: 2026-09-01\n"),
            (
                change_meta("add-b"),
                "schema: spec-driven\ncreated: 2026-09-02\ndepends_on: add-a\n",
            ),
            (DocumentId::BoardOrder, r#"{"changes":{"add-a":"f","add-b":"n"},"discussions":{}}"#),
        ],
    );
    let (credentials, manager) = runtime(&h);
    let ws = open(&h, &credentials, &manager);
    let board = || {
        h.store
            .snapshot(&common::scope())
            .expect("snapshot")
            .read(&DocumentId::BoardOrder)
            .expect("read board")
            .map(|doc| (doc.content, doc.revision))
    };
    let before = board();

    let error = ws
        .reorder_card(&credentials, "change", "add-b", None, Some("add-a"))
        .expect_err("crossing a declared dependency is refused");
    assert_eq!(error.message, "cannot move 'add-b' there: it depends on add-a");
    assert_eq!(board(), before, "no PUT reached the board resource");

    // 不跨依赖的拖排照常落地。
    ws.reorder_card(&credentials, "change", "add-a", None, Some("add-b"))
        .expect("a legal move lands");
    assert_ne!(board(), before, "the legal move rewrote the board resource");
}

#[test]
fn discussion_flow_reads_and_writes_through() {
    let h = common::harness();
    common::seed_change(h.store.as_ref(), FOUR_TASKS);
    seed_discussion(h.store.as_ref(), "rate-limiting", "Rate limiting");
    seed_discussion(h.store.as_ref(), "old-topic", "Old topic");
    let (credentials, manager) = runtime(&h);
    let ws = open(&h, &credentials, &manager);

    let lists = ws.list_discussions(&credentials).expect("list discussions");
    assert!(
        lists.active.iter().any(|d| d.slug == "rate-limiting"),
        "active 清单是 server 真值"
    );
    assert!(lists.archived.is_empty(), "尚无 archived 讨论");

    let shown = ws
        .discussion_document(&credentials, "rate-limiting")
        .expect("show")
        .expect("found");
    assert!(shown.content.contains("topic: Rate limiting"));
    assert!(
        shown.content.contains("**Decision**: do it"),
        "讨论内文是 server 真值"
    );
    assert!(shown.cuts.is_empty(), "结论没有刀");
    assert!(
        ws.discussion_document(&credentials, "no-such-topic").expect("404 is not an error").is_none(),
        "不存在的讨论回 None"
    );

    let promoted = ws
        .promote_discussion(&credentials, "rate-limiting", None)
        .expect("promote");
    assert!(!promoted.change.is_empty(), "promote 回新 change 名");
    let changes = ws.list_changes(&credentials, None).expect("list changes");
    assert!(
        changes.changes.iter().any(|c| c.summary.name == promoted.change),
        "promote 产生的 change 出现在清单"
    );

    let archived = ws
        .archive_discussion(&credentials, "old-topic")
        .expect("archive discussion");
    assert!(
        archived.archived_to.contains("old-topic"),
        "封存路径回真值：{}",
        archived.archived_to
    );
    let lists = ws.list_discussions(&credentials).expect("list discussions");
    assert!(
        !lists.active.iter().any(|d| d.slug == "old-topic"),
        "封存后离开 active"
    );
    assert!(
        lists.archived.iter().any(|d| d.slug == "old-topic"),
        "出现在 archived"
    );
}

// --- 组合类：set_tasks 中途失败中止并回报笔数 ---

#[test]
fn composed_set_tasks_aborts_midway_and_reports_the_completed_count() {
    let h = common::harness();
    common::seed_change(h.store.as_ref(), FOUR_TASKS);
    let (credentials, manager) = runtime(&h);
    let ws = open(&h, &credentials, &manager);

    // 「99」不存在：前两笔成功、第三笔失败即中止，第四笔不得运行。
    let ids: Vec<String> = ["1", "2", "99", "4"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let failure = ws
        .set_tasks(&credentials, "demo", &ids, true)
        .expect_err("中途失败即中止");
    assert_eq!(failure.completed, 2, "回报已完成笔数");

    let doc = ws
        .document(&credentials, "demo", "tasks")
        .expect("document");
    assert_eq!(
        doc.content.matches("- [x]").count(),
        2,
        "恰好前两笔落地：{}",
        doc.content
    );
    assert!(doc.content.contains("- [ ] 1.4 Fourth"), "中止后不再前进");

    // set_all_tasks 走 server 的任务清单组合——把剩余任务补完。
    let completed = ws
        .set_all_tasks(&credentials, "demo", true)
        .expect("set all");
    assert_eq!(completed, 2, "剩余两笔由组合实作补完");
    let doc = ws
        .document(&credentials, "demo", "tasks")
        .expect("document");
    assert_eq!(
        doc.content.matches("- [x]").count(),
        4,
        "全数完成：{}",
        doc.content
    );
}

// --- 不支持类：回拒绝错误 ---

#[test]
fn unsupported_operations_are_refused_with_a_zh_tw_message() {
    let err = remote::unsupported("全文搜索");
    assert_eq!(
        err.reason.as_deref(),
        Some("unsupported"),
        "机读 reason 固定"
    );
    assert!(
        err.message.contains("全文搜索"),
        "消息点名操作：{}",
        err.message
    );
    assert!(
        err.message.contains("尚未提供"),
        "繁中说明缺口来自 server：{}",
        err.message
    );
}

// --- 认领：capability 位依 role（remote-workspace-data「认领操作与认领人呈现」）---

#[test]
fn claim_capability_follows_the_membership_role() {
    let h = common::harness();
    common::seed_change(h.store.as_ref(), FOUR_TASKS);

    let (credentials, manager) = runtime(&h);
    let (_, editor) =
        remote::open_workspace(&h.origin, "demo", &manager, &credentials).expect("editor opens");
    assert!(editor.capabilities.claim, "editor 可认领");

    let invite = h
        .identity
        .create_invitation(NewInvitation {
            email: "reader@example.com".to_string(),
            display: "Reader".to_string(),
            memberships: vec!["demo".to_string()],
            admin: false,
            expires_at: Utc::now() + Duration::days(1),
        })
        .expect("invite reader");
    let reader_id = h
        .identity
        .accept_invitation(&invite, "pw-reader")
        .expect("accept");
    h.identity
        .admin_set_membership(
            &specseal_server::audit::AuditActor::system_cli(),
            &reader_id,
            "demo",
            specseal_server::identity::MembershipRole::Reader,
            true,
        )
        .expect("demote to reader");
    let (_, reader_pat) = h.identity.create_pat(&reader_id, "test", None).expect("pat");
    let reader_credentials = MemoryCredentialStore::new();
    reader_credentials
        .set(&h.origin, CredentialKind::Pat, &reader_pat)
        .expect("set reader pat");
    let reader_manager = Arc::new(TokenManager::new(&h.origin));
    let (_, reader) =
        remote::open_workspace(&h.origin, "demo", &reader_manager, &reader_credentials)
            .expect("reader opens");
    assert!(!reader.capabilities.claim, "reader 的认领面停用");
}

#[test]
fn station_ticket_maps_404_to_none_and_200_to_rounds() {
    // spec desktop-app「详情抽屉的工单分页」Scenario「远程工单 404 显示空态」：
    // 无工单时 GET /changes/{name}/{station} 是 404 → None（不是错误）；工单种下
    // 后回结构化 rounds，serde 串行化即 D1 形状（camelCase、patchHash）。两站
    // 互不混入：review 工单在，verify 仍是 None。
    let h = common::harness();
    common::seed_change(h.store.as_ref(), FOUR_TASKS);
    let (credentials, manager) = runtime(&h);
    let ws = open(&h, &credentials, &manager);

    assert!(
        ws.station_ticket(&credentials, "demo", "review")
            .expect("404 is the plain no-ticket branch, not an error")
            .is_none()
    );
    assert!(
        ws.station_ticket(&credentials, "ghost", "review")
            .expect("unknown change is 404 as well")
            .is_none()
    );

    let mut uow = h
        .store
        .begin_unit_of_work(
            &common::scope(),
            CommandContext {
                command: "seed-ticket".into(),
                actor: "seed".into(),
            },
        )
        .expect("begin uow");
    let ticket_text = format!(
        "# Review — demo\n\n## Round 1\n\n**Phase**: discovery\n**Patch**: sha256:{}\n**Rules**: replace\n**Rule**: WARNING 添加的公开 API 要有对应的测试\n**Scope**: src/lib.rs\n\n- [WARNING] src/lib.rs — possible smell\n",
        "a".repeat(64)
    );
    uow.create(
        DocumentId::ChangeArtifact {
            change: "demo".into(),
            artifact: "review.md".into(),
        },
        &ticket_text,
    );
    h.store.commit(uow, Vec::new()).expect("seed ticket");

    let ticket = ws
        .station_ticket(&credentials, "demo", "review")
        .expect("200")
        .expect("ticket present");
    assert_eq!(ticket.rounds.len(), 1);
    assert_eq!(ticket.rounds[0].index, 1);
    assert_eq!(ticket.rounds[0].phase.as_deref(), Some("discovery"));
    assert_eq!(ticket.rounds[0].scope, ["src/lib.rs"]);
    assert_eq!(ticket.rounds[0].findings[0].severity, "WARNING");
    assert_eq!(ticket.rounds[0].findings[0].text, "possible smell");
    let json = serde_json::to_value(&ticket.rounds).expect("rounds serialize");
    assert!(
        json[0].get("patchHash").is_some() && json[0].get("patch_hash").is_none(),
        "D1 shape is camelCase: {json}"
    );
    // 远程活工单交给与本机同一个组装函数（D5）：payload 与本机解析同一份原文逐项相同，
    // 含 rules 与 reviewBaselineSmells。
    assert_eq!(
        remote::station_ticket_payload(ticket.clone()),
        specseal_desktop_core::query::ticket_json_from_text("review", &ticket_text),
        "remote live payload matches the local parse"
    );
    // server 比这支 desktop 新、带来不认得的 baseline：比照封存原文解析失败回 None
    // （空态），不画成 replace 的套用规则列。
    let mut newer = ticket.clone();
    newer.rounds[0].rules.as_mut().expect("rules carried").baseline = "strict".into();
    assert_eq!(remote::station_ticket_payload(newer), None, "unknown baseline reads as no ticket");
    assert!(
        ws.station_ticket(&credentials, "demo", "verify")
            .expect("404")
            .is_none(),
        "the review ticket must not leak into the verify station"
    );
}

#[test]
fn archived_station_ticket_text_parses_into_the_d1_shape() {
    // spec desktop-app Scenario「远程封存工单原文解析」：封存端点只给原文——
    // GET /archived/{dated}/artifacts/verify.md 取回后交引擎解析（desktop core 的
    // `ticket_json_from_text`），形状与本机相同：rounds[].index／phase／patchHash／
    // scope／findings[].severity／path／text。未带走的站（review.md 缺席）是 404，
    // 对应指令回 null。
    let h = common::harness();
    common::seed_change(h.store.as_ref(), FOUR_TASKS);
    let dated_name = "2026-07-19-carried-verify";
    let hash = "c".repeat(64);
    let ticket_text = format!(
        "# Verify — demo\n\n## Round 1\n\n**Phase**: discovery\n**Patch**: sha256:{hash}\n**Scope**: src/lib.rs\n\n- [WARNING] src/lib.rs — Correctness: scenario uncovered\n"
    );
    let archived = |doc: &str| DocumentId::ArchivedChange {
        change: dated_name.into(),
        doc: doc.into(),
    };
    seed_docs(
        h.store.as_ref(),
        &[
            (archived(".openspec.yaml"), "schema: spec-driven\n"),
            (archived("verify.md"), ticket_text.as_str()),
        ],
    );

    let (credentials, manager) = runtime(&h);
    let ws = open(&h, &credentials, &manager);
    let document = ws
        .archived_document(&credentials, dated_name, "verify.md")
        .expect("carried verify.md is served as raw text");
    let ticket =
        specseal_desktop_core::query::ticket_json_from_text("verify", &document.content)
            .expect("raw text parses through the engine");
    assert_eq!(
        ticket,
        serde_json::json!({
            "rounds": [{
                "index": 1,
                "phase": "discovery",
                "patchHash": format!("sha256:{hash}"),
                "rules": null,
                "scope": ["src/lib.rs"],
                "findings": [{
                    "severity": "WARNING",
                    "path": "src/lib.rs",
                    "text": "Correctness: scenario uncovered",
                }],
            }],
            "reviewBaselineSmells": specseal_core::skills::REVIEW_BASELINE_SMELLS,
        })
    );
    let missing = ws
        .archived_document(&credentials, dated_name, "review.md")
        .err()
        .expect("review.md was not carried");
    assert_eq!(missing.status, Some(404), "{}", missing.message);
}

// --- remote 项目的技能档：基准是 Server 提供的技能（remote-skill-delivery D6） ---

#[test]
fn a_remote_checkout_is_probed_and_updated_from_what_the_server_gives() {
    use specseal_core::init::{managed_skills, ASSET_VERSION};
    use specseal_core::skills::{RenderTarget, SpecLocation, Tool};

    let h = common::harness();
    let (credentials, manager) = runtime(&h);
    let ws = open(&h, &credentials, &manager);
    let dir = tempfile::tempdir().expect("tempdir");
    let url = format!("{}/api/specseal/v1/projects/demo", h.origin);
    specseal_core::init::init_remote(dir.path(), &[Tool::Claude], true, &url, Some("backend")).expect("checkout");
    let propose = dir.path().join(".claude").join("skills").join("specseal-propose").join("SKILL.md");
    let probe = || ws.probe_assets(&credentials, dir.path()).expect("probe").expect("the server declares skills");

    // 这台 server 与 app 同版、流程设置没有打开 worktree：刚产生的技能档就是它提供的。
    let current = probe();
    assert_eq!(current["status"], "current", "{current}");
    assert_eq!(current["serverVersion"], ASSET_VERSION);
    assert_eq!(current["appOlderThanServer"], false);

    // 改坏一支：过期，并列出那个文件。
    std::fs::write(&propose, "edited by hand\n").expect("edit");
    let stale = probe();
    assert_eq!(stale["status"], "stale", "{stale}");
    assert_eq!(stale["differingFiles"], serde_json::json!([".claude/skills/specseal-propose/SKILL.md"]));

    // 更新：写回 Server 的全文。
    let outcome = ws
        .skills_to_install(&credentials, dir.path())
        .expect("the server's texts")
        .install(dir.path())
        .expect("update");
    assert_eq!(outcome["updated"], serde_json::json!(["claude"]), "{outcome}");
    let served = managed_skills(
        RenderTarget::Builtin(Tool::Claude),
        false,
        specseal_core::workspace::DEFAULT_SPEC_DIR,
        SpecLocation::Elsewhere,
    );
    let (_, expected) = served.iter().find(|(dir, _)| dir == "specseal-propose").expect("propose is served");
    assert_eq!(&std::fs::read_to_string(&propose).expect("read"), expected);
    assert_eq!(probe()["status"], "current");
}

#[test]
fn a_remote_checkout_without_a_tool_has_nothing_to_probe() {
    let h = common::harness();
    let (credentials, manager) = runtime(&h);
    let ws = open(&h, &credentials, &manager);
    let dir = tempfile::tempdir().expect("tempdir");
    let url = format!("{}/api/specseal/v1/projects/demo", h.origin);
    std::fs::write(dir.path().join(".specseal.yaml"), format!("remote:\n  url: {url}\n")).expect("config");
    assert_eq!(ws.probe_assets(&credentials, dir.path()).expect("probe"), None);
}

/// 一台固定回应的假 server：`/binding` 回 `binding`，`/skills` 回 `skills`；记下每个请求的
/// 「METHOD 路径」与内容。回传 (origin, 请求记录)。
fn skills_fake(
    binding: String,
    skills: &'static str,
) -> (Arc<tiny_http::Server>, String, Arc<std::sync::Mutex<Vec<(String, String)>>>) {
    let server = Arc::new(tiny_http::Server::http("127.0.0.1:0").expect("bind"));
    let origin = format!("http://{}", server.server_addr());
    let asked: Arc<std::sync::Mutex<Vec<(String, String)>>> = Arc::default();
    let (looper, log) = (server.clone(), asked.clone());
    std::thread::spawn(move || {
        for mut req in looper.incoming_requests() {
            let mut body = String::new();
            let _ = req.as_reader().read_to_string(&mut body);
            let path = req.url().to_string();
            log.lock().unwrap().push((format!("{} {path}", req.method()), body));
            let answer = if path.ends_with("/binding") { binding.clone() } else { skills.to_string() };
            let _ = req.respond(tiny_http::Response::from_string(answer));
        }
    });
    (server, origin, asked)
}

fn fake_binding(capabilities: &str) -> String {
    format!(
        r#"{{"actor":{{"id":"u_1","name":"Tester"}},"project":{{"id":"prj_demo","key":"demo","name":"Demo"}},"repo":{{"id":"repo_backend","key":"backend","name":"Backend"}},"apiVersion":"1","engineVersion":"0.12.0","capabilities":{capabilities}}}"#
    )
}

/// 连到 `origin` 的 claude checkout 与它的 workspace 把手。
fn fake_checkout(origin: &str) -> (tempfile::TempDir, MemoryCredentialStore, RemoteWorkspace) {
    let dir = tempfile::tempdir().expect("tempdir");
    let url = format!("{origin}/api/specseal/v1/projects/demo");
    let claude = [specseal_core::skills::Tool::Claude];
    specseal_core::init::init_remote(dir.path(), &claude, true, &url, Some("backend")).expect("checkout");
    let credentials = MemoryCredentialStore::new();
    credentials.set(origin, CredentialKind::Pat, "spk_pat_test").expect("set pat");
    let workspace = RemoteWorkspace::at(origin, "demo", "backend", &Arc::new(TokenManager::new(origin)));
    (dir, credentials, workspace)
}

#[test]
fn a_server_that_declares_no_skills_gives_nothing_to_probe_and_is_not_asked_for_skills() {
    let (server, origin, asked) = skills_fake(fake_binding("{}"), "{}");
    let (dir, credentials, ws) = fake_checkout(&origin);

    assert_eq!(ws.probe_assets(&credentials, dir.path()).expect("probe"), None);
    let calls: Vec<String> = asked.lock().unwrap().iter().map(|(call, _)| call.clone()).collect();
    assert_eq!(calls, ["GET /api/specseal/v1/projects/demo/binding"], "the handshake, and no skills request");
    assert!(ws.skills_to_install(&credentials, dir.path()).is_err(), "nothing to install either");
    server.unblock();
}

#[test]
fn a_probe_asks_for_digests_only() {
    let skills = r#"{"version":"v1.58.0","targets":[{"tool":"claude","skills":[{"name":"apply","digest":"sha256:00"}]}]}"#;
    let (server, origin, asked) = skills_fake(fake_binding(r#"{"skills":{"version":"v1.58.0"}}"#), skills);
    let (dir, credentials, ws) = fake_checkout(&origin);

    let probe = ws.probe_assets(&credentials, dir.path()).expect("probe").expect("the server declares skills");
    assert_eq!(probe["serverVersion"], "v1.58.0");
    assert_eq!(probe["status"], "stale", "the checkout holds the local templates: {probe}");
    let sent = asked.lock().unwrap().clone();
    let (call, body) = sent.last().expect("a skills request");
    assert_eq!(call, "POST /api/specseal/v1/projects/demo/skills");
    assert_eq!(body, r#"{"targets":[{"tool":"claude"}]}"#, "no `contents`: the texts are not downloaded");
    server.unblock();
}
