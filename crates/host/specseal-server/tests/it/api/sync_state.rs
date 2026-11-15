//! Polling foundation (reference-server spec「健康检查与 ETag 轮询地基」).
//! `/sync-state` returns 304 while the scope is unchanged and 200 with a new
//! ETag after any commit; a query against an unreachable store is 503
//! unavailable.

use crate::common;

use specseal_protocol::error::{ErrorReason, ErrorResponse};
use specseal_remote::client::Client;
use specseal_store::memory::MemoryStore;
use specseal_store::{
    CommandContext, DocumentId, FaultPoint, ProjectId, RepoId, Scope, TeamStore,
};
use specseal_server::state::SharedStore;
use std::sync::Arc;

fn scope() -> Scope {
    Scope::new(ProjectId::new("demo"), RepoId::new("backend"))
}

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
        DocumentId::ChangeArtifact { change: "demo".into(), artifact: "tasks.md".into() },
        "- [ ] 1.1 First\n",
    );
    store.commit(uow, Vec::new()).expect("seed commit");
    store
}

fn crashed_store() -> SharedStore {
    let store = MemoryStore::new();
    store.crash_at(FaultPoint::AfterDocWrites);
    let mut uow = store
        .begin_unit_of_work(
            &scope(),
            CommandContext { command: "seed".into(), actor: "seed".into() },
        )
        .expect("begin uow");
    uow.create(DocumentId::WorkflowConfig, "x");
    let _ = store.commit(uow, Vec::new());
    Arc::new(store)
}

fn sync_url(base: &str) -> String {
    format!("{base}/api/specseal/v1/projects/demo/sync-state")
}

/// GET `/sync-state`, optionally with If-None-Match; returns (status, etag).
fn poll(url: &str, token: &str, if_none_match: Option<&str>) -> (u16, String) {
    let mut req = ureq::get(url)
        .set("Authorization", &format!("Bearer {token}"))
        .set("X-Specseal-Api-Version", "1")
        .set("X-Specseal-Repo", "backend");
    if let Some(inm) = if_none_match {
        req = req.set("If-None-Match", inm);
    }
    match req.call() {
        Ok(resp) => (resp.status(), resp.header("etag").unwrap_or_default().to_string()),
        Err(ureq::Error::Status(code, resp)) => {
            (code, resp.header("etag").unwrap_or_default().to_string())
        }
        Err(e) => panic!("transport error: {e}"),
    }
}

fn client(base: &str, token: &str) -> Client {
    Client::new(
        &format!("{base}/api/specseal/v1/projects/demo"),
        token,
        Some("backend"),
    )
}

#[test]
fn polling_detects_a_change_across_a_commit() {
    let store = seeded_store();
    let state = common::state_with(store);
    let (pat, _user) = common::seed_pat(&state.identity, &["demo"]);
    let base = common::start(state);
    let url = sync_url(&base);

    let (status, e0) = poll(&url, &pat, None);
    assert_eq!(status, 200, "the first poll returns the current token");
    assert!(!e0.is_empty(), "an ETag is declared");

    let (status, _) = poll(&url, &pat, Some(&e0));
    assert_eq!(status, 304, "re-polling before any write is not modified");

    // Another writer completes a commit.
    client(&base, &pat).task_done("demo", "1", &[], None).expect("task done");

    let (status, e1) = poll(&url, &pat, Some(&e0));
    assert_eq!(status, 200, "re-polling after the write returns 200");
    assert_ne!(e1, e0, "the ETag advanced with the commit");
}

/// GET `path` under the demo project and expect a failure; returns its
/// status and the reason of its error envelope. The typed client collapses
/// every 5xx to a generic reasonless message, so the raw response is read.
fn failure(base: &str, pat: &str, path: &str) -> (u16, ErrorReason) {
    let url = format!("{base}/api/specseal/v1/projects/demo/{path}");
    match ureq::get(&url)
        .set("Authorization", &format!("Bearer {pat}"))
        .set("X-Specseal-Api-Version", "1")
        .set("X-Specseal-Repo", "backend")
        .call()
    {
        Ok(resp) => panic!("expected a failure, got HTTP {}", resp.status()),
        Err(ureq::Error::Status(code, resp)) => {
            let body = resp.into_string().unwrap_or_default();
            let reason = serde_json::from_str::<ErrorResponse>(&body)
                .map(|e| e.reason)
                .unwrap_or_else(|_| panic!("body is an ErrorResponse: {body}"));
            (code, reason)
        }
        Err(e) => panic!("transport error: {e}"),
    }
}

#[test]
fn a_query_against_an_unreachable_store_is_503_unavailable() {
    let state = common::state_with(crashed_store());
    let (pat, _user) = common::seed_pat(&state.identity, &["demo"]);
    let base = common::start(state);
    let (status, reason) = failure(&base, &pat, "changes");
    assert_eq!(status, 503, "an unreachable store answers 503");
    assert_eq!(reason, ErrorReason::Unavailable, "the reason is unavailable");
}

#[test]
fn a_document_read_against_an_unreachable_store_is_503_unavailable() {
    // host-runtime「保存暂时无法使用」的 server 那一半：不经引擎的读取也回 unavailable。
    let state = common::state_with(crashed_store());
    let (pat, _user) = common::seed_pat(&state.identity, &["demo"]);
    let base = common::start(state);
    let (status, reason) = failure(&base, &pat, "config");
    assert_eq!(status, 503, "an unreachable store answers 503");
    assert_eq!(reason, ErrorReason::Unavailable, "the reason is unavailable");
}

#[test]
fn polling_the_scope_version_exports_nothing() {
    // 「连续只查找范围版本号不造成任何导出」：先读一次变更清单加载范围，再连续轮询三次。
    let store = seeded_store();
    let state = common::state_with(store.clone());
    let (pat, _user) = common::seed_pat(&state.identity, &["demo"]);
    let base = common::start(state);
    let url = sync_url(&base);

    client(&base, &pat).list_changes().expect("list changes");
    let loaded = store.export_count();
    assert!(loaded >= 1, "the list loaded the scope");

    let (status, etag) = poll(&url, &pat, None);
    assert_eq!(status, 200);
    for _ in 0..2 {
        assert_eq!(poll(&url, &pat, Some(&etag)).0, 304);
    }
    assert_eq!(store.export_count(), loaded, "no export while polling");
}
