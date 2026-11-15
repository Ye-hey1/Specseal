//! Change command routes: writes commit atomically through the bridge and a
//! CAS conflict is distinguishable (reference-server spec「写入原子提交且 CAS
//! 冲突可辨」). The losing competitor gets a 409 revision_conflict with no partial
//! write; a completed task lands a task-completed event in the outbox.

use crate::common;

use specseal_remote::client::Client;
use specseal_store::memory::MemoryStore;
use specseal_store::{CommandContext, DocumentId, OutboxCursor, ProjectId, RepoId, Scope, TeamStore};
use std::sync::Arc;

const SCOPE_PROJECT: &str = "demo";
const SCOPE_REPO: &str = "backend";

fn scope() -> Scope {
    Scope::new(ProjectId::new(SCOPE_PROJECT), RepoId::new(SCOPE_REPO))
}

/// A store seeded with change `demo` (a proposal and a tasks file), returned so
/// the test can inspect its outbox after driving the server.
fn seeded_store() -> Arc<MemoryStore> {
    let store = Arc::new(MemoryStore::new());
    let mut uow = store
        .begin_unit_of_work(
            &scope(),
            CommandContext { command: "seed".into(), actor: "seed".into() },
        )
        .expect("begin uow");
    uow.create(DocumentId::ChangeMeta { change: "demo".into() }, "schema: spec-driven\n");
    uow.create(
        DocumentId::ChangeArtifact { change: "demo".into(), artifact: "proposal.md".into() },
        "## Why\n\noriginal\n",
    );
    uow.create(
        DocumentId::ChangeArtifact { change: "demo".into(), artifact: "tasks.md".into() },
        "- [ ] 1.1 First\n- [ ] 1.2 Second\n",
    );
    store.commit(uow, Vec::new()).expect("seed commit");
    store
}

fn client(base: &str, token: &str) -> Client {
    Client::new(
        &format!("{base}/api/specseal/v1/projects/demo"),
        token,
        Some("backend"),
    )
}

#[test]
fn competing_writers_on_the_same_version_leave_a_distinguishable_conflict() {
    let store = seeded_store();
    let state = common::state_with(store.clone());
    let (pat, _user) = common::seed_pat(&state.identity, &["demo"]);
    let base = common::start(state);
    let client = client(&base, &pat);

    let read = client.get_artifact("demo", "proposal").expect("read proposal");
    let version = read.version;

    let winner = client.put_artifact("demo", "proposal", "## Why\n\nwinner wins\n", version);
    assert!(winner.is_ok(), "the first writer at the read version succeeds: {winner:?}");

    let loser = client
        .put_artifact("demo", "proposal", "## Why\n\nloser loses\n", version)
        .expect_err("the second writer at the stale version conflicts");
    assert_eq!(
        loser.reason.as_deref(),
        Some("revision_conflict"),
        "the conflict is distinguishable: {loser:?}"
    );

    let after = client.get_artifact("demo", "proposal").expect("re-read proposal");
    assert_eq!(
        after.content, "## Why\n\nwinner wins\n",
        "the winner's write stands; no partial loser write"
    );
}

#[test]
fn a_write_between_a_verbs_read_and_its_commit_is_a_409_that_names_the_document() {
    // host-runtime「版本冲突经 Server 回报」：动词读过 metadata 之后、提交
    // 之前，另一方改写了同一份文档。
    let meta = DocumentId::ChangeMeta { change: "demo".into() };
    let inner = seeded_store();
    let base = inner.snapshot(&scope()).expect("snapshot").revision();
    let racing_meta = meta.clone();
    let store = Arc::new(common::Racing::at_unit_of_work(inner.clone(), move |store| {
        let mut uow = store
            .begin_unit_of_work(
                &scope(),
                CommandContext { command: "other".into(), actor: "other".into() },
            )
            .expect("begin the other writer's uow");
        uow.update(racing_meta, "schema: spec-driven\nclaimed_by: Other\n", base);
        store.commit(uow, Vec::new()).expect("the other writer commits");
    }));
    let state = common::state_with(store);
    let (pat, _user) = common::seed_pat(&state.identity, &["demo"]);
    let base_url = common::start(state);

    // The raw response: the typed client replaces a 409's message with its
    // own wording.
    let response = ureq::post(&format!(
        "{base_url}/api/specseal/v1/projects/demo/changes/demo/in-progress"
    ))
    .set("Authorization", &format!("Bearer {pat}"))
    .set("X-Specseal-Api-Version", specseal_protocol::API_VERSION)
    .set("X-Specseal-Repo", "backend")
    .call();
    let (status, body) = match response {
        Err(ureq::Error::Status(status, response)) => {
            (status, response.into_string().expect("the error body"))
        }
        other => panic!("expected a 409 status error, got {other:?}"),
    };
    let error: serde_json::Value = serde_json::from_str(&body).expect("a JSON error body");

    assert_eq!(status, 409);
    assert_eq!(error["reason"], "revision_conflict");
    assert_eq!(
        error["message"],
        format!("changes/demo/.meta.yaml: expected {}, actual {}", base.0, base.0 + 1),
        "the message names the key, expected and actual"
    );
    let after = inner.snapshot(&scope()).expect("snapshot");
    assert_eq!(
        after.read(&meta).expect("read").expect("meta").content,
        "schema: spec-driven\nclaimed_by: Other\n",
        "the other writer's content stands"
    );
    assert!(
        inner.read_outbox(&scope(), OutboxCursor(0)).expect("outbox").is_empty(),
        "the refused verb published no event"
    );
}

/// A store seeded with an archive-ready change: tasks all done, one delta spec
/// so the archive reports capability counts, and a source discussion linked
/// both ways so it co-travels into the archive. The change is named `change`.
fn archive_ready_store(change: &str) -> Arc<MemoryStore> {
    let store = Arc::new(MemoryStore::new());
    let mut uow = store
        .begin_unit_of_work(
            &scope(),
            CommandContext { command: "seed-archive".into(), actor: "seed".into() },
        )
        .expect("begin uow");
    uow.create(
        DocumentId::ChangeMeta { change: change.into() },
        "schema: spec-driven\ncreated: 2026-07-01\nfrom_discussion: scope-talk\n",
    );
    uow.create(
        DocumentId::ChangeArtifact { change: change.into(), artifact: "tasks.md".into() },
        "- [x] 1.1 done\n",
    );
    uow.create(
        DocumentId::ChangeArtifact {
            change: change.into(),
            artifact: "specs/user-auth/spec.md".into(),
        },
        "## Purpose\n\n本 capability 是测试用的示范能力，涵盖一个可观察行为与其成功路径，专供伺服端的测试取用。\n\n## ADDED Requirements\n\n### Requirement: R1\n\nIt SHALL work.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n",
    );
    uow.create(
        DocumentId::Discussion { slug: "scope-talk".into(), archived: false },
        format!(
            "---\ntopic: Scope talk\nslug: scope-talk\nstatus: promoted\npromoted_to: {change}\n---\n\n## Conclusion\n\nGo.\n"
        ),
    );
    store.commit(uow, Vec::new()).expect("seed commit");
    store
}

#[test]
fn conclude_reports_the_restale_flagged_changes_over_the_wire() {
    // spec server-verb-api「结论端点回填被打回的变更」：对已转出且进行中的
    // 讨论 re-conclude，回应点名被打回重收的变更。
    let store = Arc::new(MemoryStore::new());
    let mut uow = store
        .begin_unit_of_work(
            &scope(),
            CommandContext { command: "seed-conclude".into(), actor: "seed".into() },
        )
        .expect("begin uow");
    uow.create(
        DocumentId::ChangeMeta { change: "add-auth".into() },
        "schema: spec-driven\ncreated: 2026-07-01\nfrom_discussion: auth-scope\n",
    );
    uow.create(
        DocumentId::Discussion { slug: "auth-scope".into(), archived: false },
        "---\ntopic: Auth scope\nslug: auth-scope\nstatus: promoted\npromoted_to: add-auth\n---\n\n## Context\n\nx\n\n## Rounds\n\n## Conclusion\n\nold\n",
    );
    store.commit(uow, Vec::new()).expect("seed commit");
    let state = common::state_with(store.clone());
    let (pat, _user) = common::seed_pat(&state.identity, &["demo"]);
    let base = common::start(state);
    let client = client(&base, &pat);

    let resp = client
        .discussion_conclude("auth-scope", "**Decision**: revised\n", false)
        .expect("conclude over the wire");
    assert_eq!(
        resp.restale_flagged,
        ["add-auth"],
        "the re-conclude names the in-flight derived change"
    );
    assert!(!resp.auto_archived, "an in-flight derived change blocks the closing step");
}

#[test]
fn conclude_backfills_auto_archived_over_the_wire() {
    // spec server-verb-api「讨论结论端点回填顺手封存事实」：promoted_to 非空且
    // 无在途变更引用 → 回应含 autoArchived: true，讨论自 live 清单消失。
    let store = Arc::new(MemoryStore::new());
    let mut uow = store
        .begin_unit_of_work(
            &scope(),
            CommandContext { command: "seed-auto-archive".into(), actor: "seed".into() },
        )
        .expect("begin uow");
    uow.create(
        DocumentId::Discussion { slug: "done-talk".into(), archived: false },
        "---\ntopic: Done talk\nslug: done-talk\nstatus: promoted\npromoted_to: shipped-change\ncreated: 2026-07-01\n---\n\n## Context\n\nx\n\n## Rounds\n\n## Conclusion\n\n<!-- Written by `specseal discuss conclude` -->\n",
    );
    store.commit(uow, Vec::new()).expect("seed commit");
    let state = common::state_with(store.clone());
    let (pat, _user) = common::seed_pat(&state.identity, &["demo"]);
    let base = common::start(state);
    let client = client(&base, &pat);

    let resp = client
        .discussion_conclude("done-talk", "**Decision**: done\n", false)
        .expect("conclude over the wire");
    assert!(resp.auto_archived, "the closing step is reported over the wire");

    let listed = client.list_discussions(false).expect("list live discussions");
    assert!(
        listed.discussions.iter().all(|d| d.slug != "done-talk"),
        "the record left the live list"
    );
    let archived = client.list_discussions(true).expect("list archived discussions");
    assert!(
        archived.discussions.iter().any(|d| d.slug == "done-talk"),
        "the record landed in the archived list"
    );
}

#[test]
fn conclude_with_hold_keeps_the_record_live_over_the_wire() {
    // spec server-verb-api「讨论结论端点转传保留旗标并回填 held」：闭环条件原本
    // 成立的讨论以 hold: true 结论 → 回应 held: true 无 autoArchived，记录留 live。
    let store = Arc::new(MemoryStore::new());
    let mut uow = store
        .begin_unit_of_work(
            &scope(),
            CommandContext { command: "seed-hold".into(), actor: "seed".into() },
        )
        .expect("begin uow");
    uow.create(
        DocumentId::Discussion { slug: "staged-talk".into(), archived: false },
        "---\ntopic: Staged talk\nslug: staged-talk\nstatus: promoted\npromoted_to: shipped-change\ncreated: 2026-07-01\n---\n\n## Context\n\nx\n\n## Rounds\n\n## Conclusion\n\n<!-- Written by `specseal discuss conclude` -->\n",
    );
    store.commit(uow, Vec::new()).expect("seed commit");
    let before = store.snapshot(&scope()).expect("snapshot").revision().0;
    let state = common::state_with(store.clone());
    let (pat, _user) = common::seed_pat(&state.identity, &["demo"]);
    let base = common::start(state);
    let client = client(&base, &pat);

    let resp = client
        .discussion_conclude("staged-talk", "**Decision**: cut-b later\n", true)
        .expect("conclude with hold over the wire");
    assert!(resp.held, "held 回填");
    assert!(!resp.auto_archived, "带 hold 不触发闭环");
    let after = store.snapshot(&scope()).expect("snapshot").revision().0;
    assert!(after > before, "the conclude commit advances the scope revision");

    let listed = client.list_discussions(false).expect("list live discussions");
    assert!(
        listed.discussions.iter().any(|d| d.slug == "staged-talk"),
        "the record stays in the live list"
    );
    let archived = client.list_discussions(true).expect("list archived discussions");
    assert!(
        archived.discussions.iter().all(|d| d.slug != "staged-talk"),
        "the record never reaches the archive"
    );
}

#[test]
fn archive_reports_the_full_engine_outcome_over_the_wire() {
    let store = archive_ready_store("demo-archive");
    let state = common::state_with(store.clone());
    let (pat, _user) = common::seed_pat(&state.identity, &["demo"]);
    let base = common::start(state);
    let client = client(&base, &pat);

    let resp = client.archive("demo-archive", false, false).expect("archive over the wire");

    let dated = resp.dated_name.as_deref().expect("datedName is the sentinel for a new server");
    assert!(
        dated.ends_with("demo-archive"),
        "datedName carries the archive destination: {dated}"
    );
    let spec = resp.specs.iter().find(|s| s.capability == "user-auth").expect("capability listed");
    assert_eq!(spec.added, 1, "the delta's one ADDED requirement is counted: {spec:?}");
    assert_eq!((spec.modified, spec.removed, spec.renamed), (0, 0, 0));
    let discussion = resp
        .archived_discussions
        .iter()
        .find(|d| d.slug == "scope-talk")
        .expect("the source discussion co-travels");
    assert!(
        discussion.file.ends_with("scope-talk.md"),
        "the archived file name travels: {}",
        discussion.file
    );
    assert_eq!(
        resp.evidence_recorded,
        Some(false),
        "a change with no per-task evidence reports the fact"
    );
}

#[test]
fn a_remote_archive_reports_no_backup_and_writes_none_locally() {
    // host-runtime「远程封存的回应」：改写既有正式规格的封存，回应的 snapshotCreated 是 false，
    // 其余字段照旧；server 的进程目录没有出现备份。变更名称只用在这里：修正之前的程序
    // 跑过的测试，在 crate 文件夹留下过其他名称的备份。
    const CHANGE: &str = "rewrite-without-backup";
    let store = archive_ready_store(CHANGE);
    let mut uow = store
        .begin_unit_of_work(
            &scope(),
            CommandContext { command: "seed-canonical".into(), actor: "seed".into() },
        )
        .expect("begin uow");
    uow.create(
        DocumentId::CanonicalSpec { capability: "user-auth".into() },
        "# user-auth Specification\n\n## Purpose\n\nAuth.\n\n## Requirements\n\n### Requirement: R0\n\nIt SHALL start.\n\n#### Scenario: start\n\n- **WHEN** used\n- **THEN** starts\n",
    );
    store.commit(uow, Vec::new()).expect("seed commit");
    let state = common::state_with(store.clone());
    let (pat, _user) = common::seed_pat(&state.identity, &["demo"]);
    let base = common::start(state);
    let client = client(&base, &pat);

    let resp = client.archive(CHANGE, false, false).expect("archive over the wire");

    assert_eq!(resp.snapshot_created, Some(false), "no local backup over a store port");
    let dated = resp.dated_name.as_deref().expect("datedName");
    assert!(dated.ends_with(&format!("-{CHANGE}")), "{dated}");
    let spec = resp.specs.iter().find(|s| s.capability == "user-auth").expect("capability listed");
    assert_eq!((spec.added, spec.modified, spec.removed, spec.renamed), (1, 0, 0, 0));
    assert!(resp.archived_discussions.iter().any(|d| d.slug == "scope-talk"));
    assert_eq!(resp.evidence_recorded, Some(false));
    let canonical = client.spec_document("user-auth").expect("the canonical spec");
    assert!(
        canonical.content.contains("### Requirement: R0") && canonical.content.contains("### Requirement: R1"),
        "the existing spec was rewritten: {}",
        canonical.content
    );
    let local = std::path::Path::new(".specseal").join("snapshots").join(dated);
    assert!(!local.exists(), "the server's working directory got no backup: {}", local.display());
}

#[test]
fn a_completed_task_lands_a_task_completed_event_in_the_outbox() {
    let store = seeded_store();
    let state = common::state_with(store.clone());
    let (pat, _user) = common::seed_pat(&state.identity, &["demo"]);
    let base = common::start(state);
    let client = client(&base, &pat);

    let done = client.task_done("demo", "1", &[], None).expect("task done");
    assert!(!done.already_done, "the task flipped for the first time");

    let entries = store.read_outbox(&scope(), OutboxCursor(0)).expect("read outbox");
    let completed: Vec<_> = entries
        .iter()
        .filter(|e| e.record.name == "task-completed")
        .collect();
    assert_eq!(completed.len(), 1, "exactly one task-completed event landed in the outbox");
}
