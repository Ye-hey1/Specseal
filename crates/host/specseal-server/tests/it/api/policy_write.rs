//! Remote workflow policy reads and CAS writes. The server owns both
//! authorization and validation: a reader cannot bypass the desktop, invalid
//! YAML never lands, and a stale revision leaves the winner untouched.

use crate::common;

use serde_json::{json, Value};
use specseal_protocol::error::{ErrorReason, ErrorResponse};
use specseal_server::audit::AuditActor;
use specseal_server::identity::MembershipRole;
use specseal_server::state::AppState;
use specseal_store::memory::MemoryStore;
use specseal_store::{CommandContext, DocumentId, ProjectId, RepoId, Scope, TeamStore};
use std::sync::Arc;

const INITIAL: &str = "schema: spec-driven\nlocale: en\n";
const WINNER: &str = "schema: spec-driven\nlocale: tw\ntdd: true\n";

struct Fixture {
    base: String,
    store: Arc<MemoryStore>,
    editor_pat: String,
    reader_pat: String,
}

fn scope() -> Scope {
    Scope::new(ProjectId::new("demo"), RepoId::new("backend"))
}

fn fixture() -> Fixture {
    let store = Arc::new(MemoryStore::new());
    let mut uow = store
        .begin_unit_of_work(
            &scope(),
            CommandContext {
                command: "seed-policy".into(),
                actor: "seed".into(),
            },
        )
        .expect("begin seed");
    uow.create(DocumentId::WorkflowConfig, INITIAL);
    store.commit(uow, Vec::new()).expect("seed policy");

    let state = common::state_with(store.clone());
    let (editor_pat, _editor_id) = common::seed_named_pat(
        &state.identity,
        "editor@example.com",
        "Editor",
        &["demo"],
    );
    let (reader_pat, reader_id) = common::seed_named_pat(
        &state.identity,
        "reader@example.com",
        "Reader",
        &["demo"],
    );
    state
        .identity
        .admin_set_membership(
            &AuditActor::system_cli(),
            &reader_id,
            "demo",
            MembershipRole::Reader,
            true,
        )
        .expect("set reader role");

    Fixture {
        base: common::start(AppState { ..state }),
        store,
        editor_pat,
        reader_pat,
    }
}

fn project_url(f: &Fixture, tail: &str) -> String {
    format!(
        "{}/api/specseal/v1/projects/demo/{tail}",
        f.base
    )
}

fn request(method: &str, f: &Fixture, pat: &str, tail: &str) -> ureq::Request {
    ureq::request(method, &project_url(f, tail))
        .set("Authorization", &format!("Bearer {pat}"))
        .set("X-Specseal-Api-Version", specseal_protocol::API_VERSION)
        .set("X-Specseal-Repo", "backend")
}

fn get_json(f: &Fixture, pat: &str, tail: &str) -> (Value, Option<String>) {
    let response = request("GET", f, pat, tail).call().expect("GET succeeds");
    let etag = response.header("ETag").map(str::to_string);
    let body = response.into_json::<Value>().expect("JSON body");
    (body, etag)
}

fn put_config(
    f: &Fixture,
    pat: &str,
    content: &str,
    expected_revision: u64,
) -> Result<ureq::Response, ureq::Error> {
    request("PUT", f, pat, "config").send_json(json!({
        "content": content,
        "expectedRevision": expected_revision,
    }))
}

fn protocol_error(result: Result<ureq::Response, ureq::Error>) -> (u16, ErrorResponse) {
    match result {
        Ok(response) => panic!("expected protocol error, got {}", response.status()),
        Err(ureq::Error::Status(status, response)) => {
            let body = response.into_string().unwrap_or_default();
            let error = serde_json::from_str(&body)
                .unwrap_or_else(|_| panic!("expected ErrorResponse, got {body:?}"));
            (status, error)
        }
        Err(error) => panic!("transport error: {error}"),
    }
}

fn stored_policy(f: &Fixture) -> (String, u64) {
    let snapshot = f.store.snapshot(&scope()).expect("snapshot");
    let document = snapshot
        .read(&DocumentId::WorkflowConfig)
        .expect("read policy")
        .expect("policy exists");
    (document.content, document.revision.0)
}

#[test]
fn config_read_returns_content_revision_and_same_etag_to_both_roles() {
    let f = fixture();
    for pat in [&f.editor_pat, &f.reader_pat] {
        let (config, etag) = get_json(&f, pat, "config");
        assert_eq!(config["schema"], "spec-driven");
        assert_eq!(config["content"], INITIAL);
        let revision = config["revision"].as_u64().expect("numeric revision");
        let expected_etag = format!("\"{revision}\"");
        assert_eq!(
            etag.as_deref(),
            Some(expected_etag.as_str()),
            "revision equals ETag",
        );
    }
}

#[test]
fn put_advances_revision_and_stale_expected_revision_has_no_side_effect() {
    let f = fixture();
    let (before, _) = get_json(&f, &f.editor_pat, "config");
    let revision = before["revision"].as_u64().expect("revision");

    let winner = put_config(&f, &f.editor_pat, WINNER, revision).expect("winner succeeds");
    let winner_body = winner.into_json::<Value>().expect("winner JSON");
    let next = winner_body["revision"].as_u64().expect("new revision");
    assert!(next > revision, "a successful write advances revision");
    let (after, etag) = get_json(&f, &f.editor_pat, "config");
    assert_eq!(after["content"], WINNER);
    assert_eq!(after["revision"], next);
    let expected_etag = format!("\"{next}\"");
    assert_eq!(etag.as_deref(), Some(expected_etag.as_str()));

    let (status, error) = protocol_error(put_config(
        &f,
        &f.editor_pat,
        "schema: spec-driven\nlocale: ja\n",
        revision,
    ));
    assert_eq!(status, 409);
    assert_eq!(error.reason, ErrorReason::RevisionConflict);
    assert_eq!(stored_policy(&f), (WINNER.to_string(), next));
}

#[test]
fn invalid_yaml_and_missing_expected_revision_are_rejected_without_writes() {
    let f = fixture();
    let (before, _) = get_json(&f, &f.editor_pat, "config");
    let revision = before["revision"].as_u64().expect("revision");

    let (status, error) = protocol_error(put_config(
        &f,
        &f.editor_pat,
        "schema: [unterminated",
        revision,
    ));
    assert_eq!(status, 422);
    assert_eq!(error.reason, ErrorReason::InvalidConfig);
    assert!(!error.message.is_empty(), "the parse error is explained");
    assert_eq!(stored_policy(&f), (INITIAL.to_string(), revision));

    let missing = request("PUT", &f, &f.editor_pat, "config")
        .send_json(json!({ "content": WINNER }))
        .expect_err("expectedRevision is mandatory");
    let status = match missing {
        ureq::Error::Status(status, _) => status,
        other => panic!("unexpected transport error: {other}"),
    };
    assert!((400..500).contains(&status), "missing CAS input is rejected");
    assert_eq!(stored_policy(&f), (INITIAL.to_string(), revision));
}

#[test]
fn invalid_content_wins_over_a_stale_expected_revision() {
    // Spec workflow-config「Server 的整份写入经同一个命令」：内容无法解析与预期版本
    // 不符同时成立时回 invalid_config。
    let f = fixture();
    let (before, _) = get_json(&f, &f.editor_pat, "config");
    let revision = before["revision"].as_u64().expect("revision");

    let (status, error) = protocol_error(put_config(
        &f,
        &f.editor_pat,
        "schema: [unterminated",
        revision + 7,
    ));
    assert_eq!(status, 422);
    assert_eq!(error.reason, ErrorReason::InvalidConfig);
    assert_eq!(stored_policy(&f), (INITIAL.to_string(), revision));
}

#[test]
fn a_write_of_the_same_content_keeps_the_revision() {
    // workflow-config-commands D7：内容没有变动的写入不提交，回应的版本等于写入前的版本。
    let f = fixture();
    let (before, _) = get_json(&f, &f.editor_pat, "config");
    let revision = before["revision"].as_u64().expect("revision");

    let same = put_config(&f, &f.editor_pat, INITIAL, revision).expect("the write succeeds");
    let etag = same.header("ETag").map(str::to_string);
    let body = same.into_json::<Value>().expect("JSON body");
    assert_eq!(body["revision"], revision, "nothing was committed");
    assert_eq!(etag, Some(format!("\"{revision}\"")));
    assert_eq!(stored_policy(&f), (INITIAL.to_string(), revision));

    // 版本没有前进，所以同一个预期版本还能再写一次。
    let winner = put_config(&f, &f.editor_pat, WINNER, revision).expect("a real change still lands");
    let next = winner.into_json::<Value>().expect("JSON body")["revision"].as_u64().expect("revision");
    assert!(next > revision);
    assert_eq!(stored_policy(&f), (WINNER.to_string(), next));
}

#[test]
fn expected_revision_is_the_scope_revision_not_the_document_revision() {
    // 在线协定不变：预期版本是整个 scope 的版本。别的文档在流程设置之后写入时，
    // 流程设置这份文档自己的版本落后于 scope 版本——用 scope 版本写入仍要成功，
    // 用文档自己的旧版本则是冲突。
    let f = fixture();
    let (_, document_revision) = stored_policy(&f);
    let mut uow = f
        .store
        .begin_unit_of_work(
            &scope(),
            CommandContext { command: "seed-language".into(), actor: "seed".into() },
        )
        .expect("begin");
    uow.create(DocumentId::Language, "# Vocabulary\n");
    f.store.commit(uow, Vec::new()).expect("another document lands");
    let (config, _) = get_json(&f, &f.editor_pat, "config");
    let scope_revision = config["revision"].as_u64().expect("revision");
    assert!(scope_revision > document_revision, "the scope moved past the config document");

    let (status, error) =
        protocol_error(put_config(&f, &f.editor_pat, WINNER, document_revision));
    assert_eq!(status, 409);
    assert_eq!(error.reason, ErrorReason::RevisionConflict);
    assert!(
        error.message.contains(&format!(
            "expected scope revision {document_revision}, actual {scope_revision}"
        )),
        "{}",
        error.message
    );

    let ok = put_config(&f, &f.editor_pat, WINNER, scope_revision).expect("the scope revision is accepted");
    let next = ok.into_json::<Value>().expect("JSON body")["revision"].as_u64().expect("revision");
    assert!(next > scope_revision);
    assert_eq!(stored_policy(&f), (WINNER.to_string(), next));
}

#[test]
fn a_config_write_that_lands_after_the_revision_check_is_a_conflict() {
    // 两个写入带同一个预期版本：后到的那个通过版本比对之后、读取流程设置之前，
    // 先到的那个提交了。后到的不得读到新内容再覆写——要回 409，先到的内容留着。
    let inner = Arc::new(MemoryStore::new());
    let mut uow = inner
        .begin_unit_of_work(&scope(), CommandContext { command: "seed-policy".into(), actor: "seed".into() })
        .expect("begin seed");
    uow.create(DocumentId::WorkflowConfig, INITIAL);
    let revision = inner.commit(uow, Vec::new()).expect("seed policy");
    let racing = common::Racing::after_the_first_snapshot(inner.clone(), move |store| {
        let mut uow = store
            .begin_unit_of_work(&scope(), CommandContext { command: "other".into(), actor: "other".into() })
            .expect("begin the other writer's uow");
        uow.update(DocumentId::WorkflowConfig, WINNER, revision);
        store.commit(uow, Vec::new()).expect("the other writer commits");
    });
    let state = common::state_with(Arc::new(racing));
    let (editor_pat, _) =
        common::seed_named_pat(&state.identity, "editor@example.com", "Editor", &["demo"]);
    let f = Fixture { base: common::start(state), store: inner, editor_pat, reader_pat: String::new() };

    let (status, error) = protocol_error(put_config(
        &f,
        &f.editor_pat,
        "schema: spec-driven\nlocale: ja\n",
        revision.0,
    ));

    assert_eq!(status, 409);
    assert_eq!(error.reason, ErrorReason::RevisionConflict);
    assert_eq!(stored_policy(&f).0, WINNER, "the first writer's content stands");
}

#[test]
fn invalid_locale_value_is_rejected_without_writes() {
    // Spec scenario 非法 locale 值不落盘（workflow-config-locale-validation）：
    // 可解析但 locale 值域外的文档不得落盘，沿用 invalid_config 家族。
    let f = fixture();
    let (before, _) = get_json(&f, &f.editor_pat, "config");
    let revision = before["revision"].as_u64().expect("revision");

    let (status, error) = protocol_error(put_config(
        &f,
        &f.editor_pat,
        "schema: spec-driven\nlocale: 繁体中文\n",
        revision,
    ));
    assert_eq!(status, 422);
    assert_eq!(error.reason, ErrorReason::InvalidConfig, "existing reason family, no new wire shape");
    for needle in ["locale", "tw", "ja", "en"] {
        assert!(
            error.message.contains(needle),
            "message names the field and codes ({needle}): {}",
            error.message
        );
    }
    assert_eq!(stored_policy(&f), (INITIAL.to_string(), revision), "nothing lands");

    let (status, error) = protocol_error(put_config(
        &f,
        &f.editor_pat,
        "schema: spec-driven\nspec_locale: zh-Hant\n",
        revision,
    ));
    assert_eq!(status, 422);
    assert_eq!(error.reason, ErrorReason::InvalidConfig);
    assert!(error.message.contains("auto"), "spec_locale codes include auto: {}", error.message);
    assert_eq!(stored_policy(&f), (INITIAL.to_string(), revision));

    // 合法代码（WINNER 为 locale: tw）照常成功并前进 revision。
    let ok = put_config(&f, &f.editor_pat, WINNER, revision).expect("valid codes succeed");
    let body = ok.into_json::<Value>().expect("JSON body");
    assert!(body["revision"].as_u64().expect("new revision") > revision);
}

#[test]
fn review_block_typo_is_rejected_without_writes() {
    // Spec scenario remote 写入以同一解析拒收（review-rules-config）：review 底下的
    // 未知子键 critcal 由同一引擎解析挡下，文档与 revision 皆不变。
    let f = fixture();
    let (before, _) = get_json(&f, &f.editor_pat, "config");
    let revision = before["revision"].as_u64().expect("revision");

    let (status, error) = protocol_error(put_config(
        &f,
        &f.editor_pat,
        "schema: spec-driven\nreview:\n  critcal:\n    - x\n",
        revision,
    ));
    assert_eq!(status, 422);
    assert_eq!(error.reason, ErrorReason::InvalidConfig);
    assert!(error.message.contains("critcal"), "message names the key: {}", error.message);
    assert_eq!(stored_policy(&f), (INITIAL.to_string(), revision), "nothing lands");
}

#[test]
fn subagent_model_block_typo_is_rejected_without_writes() {
    // Spec scenario remote 写入以同一解析拒收（station-subagent-model）：subagent_model
    // 底下的未知子键 reveiw 由同一引擎解析挡下，文档与 revision 皆不变。
    let f = fixture();
    let (before, _) = get_json(&f, &f.editor_pat, "config");
    let revision = before["revision"].as_u64().expect("revision");

    let (status, error) = protocol_error(put_config(
        &f,
        &f.editor_pat,
        "schema: spec-driven\nsubagent_model:\n  reveiw:\n    claude: opus\n",
        revision,
    ));
    assert_eq!(status, 422);
    assert_eq!(error.reason, ErrorReason::InvalidConfig);
    assert!(error.message.contains("reveiw"), "message names the key: {}", error.message);
    assert_eq!(stored_policy(&f), (INITIAL.to_string(), revision), "nothing lands");
}

#[test]
fn reader_write_is_forbidden_and_binding_capability_follows_role() {
    let f = fixture();
    let (config, _) = get_json(&f, &f.reader_pat, "config");
    let revision = config["revision"].as_u64().expect("revision");

    let (status, error) = protocol_error(put_config(&f, &f.reader_pat, WINNER, revision));
    assert_eq!(status, 403);
    assert_eq!(error.reason, ErrorReason::PermissionDenied);
    assert_eq!(stored_policy(&f), (INITIAL.to_string(), revision));

    let (editor_binding, _) = get_json(&f, &f.editor_pat, "binding");
    let (reader_binding, _) = get_json(&f, &f.reader_pat, "binding");
    assert_eq!(editor_binding["capabilities"]["policyWrite"], true);
    assert_eq!(reader_binding["capabilities"]["policyWrite"], false);
}
