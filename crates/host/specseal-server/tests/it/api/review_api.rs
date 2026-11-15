//! Review verb routes over the same bridge and commit path (design D4a):
//! add-round / show / stamp / discard ride `Command::Review*`, so gates, the
//! delete-ticket-with-stamp atomicity, and outbox events all come from the
//! engine. Stamp fingerprints are computed by the work-tree holder and
//! submitted on the wire — the server validates the path set, never re-hashes.

use crate::common;

use specseal_protocol::command::ReviewScopeEntryDto;
use specseal_protocol::error::{ErrorReason, ErrorResponse};
use specseal_remote::client::Client;
use specseal_server::audit::AuditActor;
use specseal_server::identity::MembershipRole;
use specseal_store::memory::MemoryStore;
use specseal_store::{CommandContext, DocumentId, OutboxCursor, ProjectId, RepoId, Scope, TeamStore};
use std::sync::Arc;

fn scope() -> Scope {
    Scope::new(ProjectId::new("demo"), RepoId::new("backend"))
}

fn client(base: &str, token: &str) -> Client {
    Client::new(&format!("{base}/api/specseal/v1/projects/demo"), token, Some("backend"))
}

struct Fixture {
    base: String,
    store: Arc<MemoryStore>,
    pat: String,
    reader_pat: String,
}

/// Server over a store seeded with change `demo-change` whose tasks are all
/// complete (the stamp gate's precondition), plus the scope file contents the
/// tests fingerprint against — the "work tree" lives in these constants.
const FILE_A: &str = "fn a() {}\n";
const ROUND_WITH_FINDING: &str =
    "**Scope**: src/lib.rs\n\n- [WARNING] src/lib.rs — possible Feature Envy\n";
const CLEAN_ROUND: &str = "**Scope**: src/lib.rs\n";

fn fixture() -> Fixture {
    let store = Arc::new(MemoryStore::new());
    let state = common::state_with(store.clone());
    let (pat, _) = common::seed_pat(&state.identity, &["demo"]);
    let (reader_pat, reader_id) =
        common::seed_named_pat(&state.identity, "reader@example.com", "Reader", &["demo"]);
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
    let mut uow = store
        .begin_unit_of_work(
            &scope(),
            CommandContext { command: "seed-review-api".into(), actor: "seed".into() },
        )
        .expect("begin seed uow");
    uow.create(
        DocumentId::ChangeMeta { change: "demo-change".into() },
        "schema: spec-driven\ncreated: 2026-08-01\n",
    );
    uow.create(
        DocumentId::ChangeArtifact { change: "demo-change".into(), artifact: "tasks.md".into() },
        "- [x] 1 done\n",
    );
    store.commit(uow, Vec::new()).expect("seed documents");
    Fixture { base: common::start(state), store, pat, reader_pat }
}

fn ticket_doc(f: &Fixture) -> Option<String> {
    f.store
        .snapshot(&scope())
        .expect("snapshot")
        .read(&DocumentId::ChangeArtifact {
            change: "demo-change".into(),
            artifact: "review.md".into(),
        })
        .expect("read ticket")
        .map(|d| d.content)
}

fn meta_doc(f: &Fixture) -> String {
    f.store
        .snapshot(&scope())
        .expect("snapshot")
        .read(&DocumentId::ChangeMeta { change: "demo-change".into() })
        .expect("read meta")
        .expect("meta exists")
        .content
}

fn outbox_names(f: &Fixture) -> Vec<String> {
    f.store
        .read_outbox(&scope(), OutboxCursor(0))
        .expect("read outbox")
        .iter()
        .map(|e| e.record.name.clone())
        .collect()
}

fn fingerprint(text: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(text.replace("\r\n", "\n").as_bytes());
    format!("{:x}", hasher.finalize())
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

fn raw(method: &str, f: &Fixture, tail: &str) -> ureq::Request {
    raw_as(method, f, &f.pat, tail)
}

fn raw_as(method: &str, f: &Fixture, pat: &str, tail: &str) -> ureq::Request {
    ureq::request(method, &format!("{}/api/specseal/v1/projects/demo/{tail}", f.base))
        .set("Authorization", &format!("Bearer {pat}"))
        .set("X-Specseal-Api-Version", specseal_protocol::API_VERSION)
        .set("X-Specseal-Repo", "backend")
}

#[test]
fn reader_cannot_settle_a_review_ticket() {
    // 破坏性删除 editor 限定（比照 change 删除、discuss discard）。discard 与
    // stamp 都以删掉工单收场——只挡 DELETE 而放行 stamp 等于守门没守到。
    let f = fixture();
    let c = client(&f.base, &f.pat);
    c.station_add_round("review", "demo-change", CLEAN_ROUND).expect("round");
    let before = ticket_doc(&f).expect("ticket exists");

    for (method, tail, body) in [
        ("DELETE", "changes/demo-change/review", None),
        (
            "POST",
            "changes/demo-change/review/stamp",
            Some(serde_json::json!({
                "accept": true,
                "scope": [{ "path": "src/lib.rs", "hash": fingerprint(FILE_A) }],
            })),
        ),
    ] {
        let request = raw_as(method, &f, &f.reader_pat, tail);
        let result = match body {
            Some(json) => request.send_json(json),
            None => request.call(),
        };
        let (status, error) = protocol_error(result);
        assert_eq!(status, 403, "{method} {tail} must refuse a reader");
        assert_eq!(error.reason, ErrorReason::PermissionDenied, "machine-readable role refusal");
    }
    assert_eq!(ticket_doc(&f).as_deref(), Some(before.as_str()), "reader refusals write nothing");
    assert!(!meta_doc(&f).contains("reviewed_at:"), "no stamp lands");
}

#[test]
fn review_loop_rides_the_verb_contract_end_to_end() {
    // 完整循环（design 契约 9）：add-round → GET 工单 → 有 findings 盖章 409 →
    // --accept＋预算指纹盖章 → meta 带章（actor＝binding、工具＝agent）且工单
    // 同 commit 删除；outbox 依序 review-round-added、review-stamped。
    let f = fixture();
    let c = client(&f.base, &f.pat);

    let added = c.station_add_round("review", "demo-change", ROUND_WITH_FINDING).expect("add round");
    assert_eq!(added.round, 1);
    assert!(ticket_doc(&f).is_some(), "the ticket document landed in the store");

    let ticket = c.station_ticket("review", "demo-change").expect("get ticket");
    assert_eq!(ticket.change, "demo-change");
    assert_eq!(ticket.rounds.len(), 1);
    assert_eq!(ticket.last_round.index, 1);
    assert_eq!(ticket.last_round.scope, ["src/lib.rs"]);
    assert_eq!(ticket.last_round.findings[0].severity, "WARNING");
    assert_eq!(
        ticket.content.as_deref(),
        ticket_doc(&f).as_deref(),
        "the ticket response carries the document verbatim, so the remote human \
         path prints what fs mode prints"
    );

    let scope_entries =
        vec![ReviewScopeEntryDto { path: "src/lib.rs".into(), hash: fingerprint(FILE_A) }];
    let (status, error) =
        protocol_error(raw("POST", &f, "changes/demo-change/review/stamp").send_json(
            serde_json::json!({ "accept": false, "scope": [{ "path": "src/lib.rs", "hash": fingerprint(FILE_A) }] }),
        ));
    assert_eq!(status, 409, "unresolved findings without accept refuse");
    assert_eq!(error.reason, ErrorReason::Refused);
    assert!(ticket_doc(&f).is_some(), "a refused stamp keeps the ticket");

    c.station_stamp("review", "demo-change", true, Some("claude"), None, &scope_entries, &[]).expect("accept stamp");
    let meta = meta_doc(&f);
    assert!(meta.contains("reviewed_at:"), "the stamp landed: {meta}");
    assert!(meta.contains("reviewed_with: claude"), "agent recorded: {meta}");
    assert!(
        meta.contains("- path: src/lib.rs"),
        "submitted fingerprints recorded verbatim: {meta}"
    );
    assert!(ticket_doc(&f).is_none(), "stamp and ticket delete land in one commit");

    let names = outbox_names(&f);
    assert!(names.contains(&"review-round-added".to_string()), "events: {names:?}");
    assert!(names.contains(&"review-stamped".to_string()), "events: {names:?}");
}

#[test]
fn stamp_rejects_a_scope_set_that_does_not_match_the_ticket() {
    // design D4a：CAS 式保护——提交的 path 集合与工单各轮 Scope 联集不等即拒，
    // 指名差集；工单与 meta 皆不动。
    let f = fixture();
    let c = client(&f.base, &f.pat);
    c.station_add_round("review", "demo-change", CLEAN_ROUND).expect("clean round");

    let (status, error) = protocol_error(
        raw("POST", &f, "changes/demo-change/review/stamp").send_json(serde_json::json!({
            "accept": false,
            "scope": [{ "path": "src/other.rs", "hash": fingerprint("x") }],
        })),
    );
    assert_eq!(status, 409);
    assert_eq!(error.reason, ErrorReason::Refused);
    assert!(error.message.contains("src/lib.rs"), "names the missing path: {}", error.message);
    assert!(error.message.contains("src/other.rs"), "names the extra path: {}", error.message);
    assert!(ticket_doc(&f).is_some());
    assert!(!meta_doc(&f).contains("reviewed_at:"), "a refused stamp writes nothing");
}

#[test]
fn stamp_accepts_a_declared_missing_partition_and_rejects_a_bad_one() {
    // spec「内容指纹锚与失效判定」remote 面：checkout 已删的联集档由 client 以
    // missing 明示声明，server 验「scope ∪ missing ＝联集且不相交」；分割不
    // 成立（重叠）即拒且不动任何档。
    let f = fixture();
    let c = client(&f.base, &f.pat);
    c.station_add_round("review", "demo-change", "**Scope**: src/lib.rs, src/gone.rs\n")
        .expect("round with a soon-dead file");

    let (status, error) = protocol_error(
        raw("POST", &f, "changes/demo-change/review/stamp").send_json(serde_json::json!({
            "accept": false,
            "scope": [{ "path": "src/lib.rs", "hash": fingerprint(FILE_A) }],
            "missing": ["src/lib.rs", "src/gone.rs"],
        })),
    );
    assert_eq!(status, 409, "overlapping partition refuses");
    assert_eq!(error.reason, ErrorReason::Refused);
    assert!(error.message.contains("src/lib.rs"), "names the overlap: {}", error.message);
    assert!(ticket_doc(&f).is_some(), "refusal keeps the ticket");

    let scope_entries =
        vec![ReviewScopeEntryDto { path: "src/lib.rs".into(), hash: fingerprint(FILE_A) }];
    c.station_stamp("review", "demo-change", false, Some("claude"), None, &scope_entries, &["src/gone.rs".into()])
        .expect("declared-missing partition stamps");
    let meta = meta_doc(&f);
    assert!(meta.contains("- path: src/lib.rs"), "surviving file anchored: {meta}");
    assert!(!meta.contains("src/gone.rs"), "declared-missing path must not anchor: {meta}");
    assert!(ticket_doc(&f).is_none(), "stamp deletes the ticket");
}

#[test]
fn discard_deletes_the_ticket_and_show_then_404s() {
    // spec「放弃审查」remote 面：DELETE 删工单、不写 metadata；之后 GET 404。
    let f = fixture();
    let c = client(&f.base, &f.pat);
    c.station_add_round("review", "demo-change", CLEAN_ROUND).expect("round");

    c.station_discard("review", "demo-change").expect("discard");
    assert!(ticket_doc(&f).is_none(), "the ticket document is deleted");
    assert!(!meta_doc(&f).contains("reviewed"), "discard writes no metadata");

    let (status, error) = protocol_error(raw("GET", &f, "changes/demo-change/review").call());
    assert_eq!(status, 404, "no ticket → not found: {}", error.message);
    let names = outbox_names(&f);
    assert!(names.contains(&"review-discarded".to_string()), "events: {names:?}");
}

#[test]
fn archive_with_an_open_ticket_refuses_over_http() {
    // D5 的守门经 server archive 路由同样生效：三处置消息完整上 wire。
    let f = fixture();
    let c = client(&f.base, &f.pat);
    c.station_add_round("review", "demo-change", CLEAN_ROUND).expect("round");

    let (status, error) =
        protocol_error(raw("POST", &f, "changes/demo-change/archive").call());
    assert_eq!(status, 409);
    assert_eq!(error.reason, ErrorReason::Refused);
    assert!(error.message.contains("review stamp"), "lists the disposals: {}", error.message);
}

#[test]
fn carry_review_rides_the_wire_so_remote_keeps_all_three_disposals() {
    // 拒绝消息叫人加 `--carry-review`——remote 模式下该旗标必须真的到得了引擎，
    // 否则三处置在远程只剩两条、带未结工单的 change 永远封存不了。
    let f = fixture();
    let c = client(&f.base, &f.pat);
    c.station_add_round("review", "demo-change", CLEAN_ROUND).expect("round");

    c.archive("demo-change", true, false).expect("carry-review archives over the wire");
    assert!(ticket_doc(&f).is_none(), "the change (with its ticket) left the active area");
}

// --- structured rounds（review-station spec：phase／patchHash 过 wire 同构）---

#[test]
fn structured_round_phase_and_patch_survive_the_wire() {
    // spec Scenario「local 与 remote payload 同构」：server 端 rounds[] 与
    // lastRound 带 phase／patchHash，legacy round 明确输出 null，字段集合与
    // local CLI 完全一致。
    let f = fixture();
    let c = client(&f.base, &f.pat);
    let hex = "a".repeat(64);
    let structured = format!(
        "**Phase**: discovery\n**Patch**: sha256:{hex}\n**Scope**: src/lib.rs\n\n- [WARNING] src/lib.rs — possible Feature Envy\n"
    );
    c.station_add_round("review", "demo-change", &structured).expect("structured round");
    let body = raw("GET", &f, "changes/demo-change/review")
        .call()
        .expect("get ticket")
        .into_string()
        .expect("body");
    let v: serde_json::Value = serde_json::from_str(&body).expect("valid JSON");
    assert_eq!(v["rounds"][0]["phase"], "discovery");
    assert_eq!(v["rounds"][0]["patchHash"], format!("sha256:{hex}"));
    assert_eq!(v["lastRound"]["phase"], "discovery");
    let mut keys: Vec<&str> =
        v["rounds"][0].as_object().expect("round object").keys().map(String::as_str).collect();
    keys.sort();
    assert_eq!(
        keys,
        ["findings", "index", "patchHash", "phase", "rules", "scope"],
        "field set matches the local CLI payload"
    );
    assert!(v["rounds"][0]["rules"].is_null(), "no rule record → explicit null: {v}");
}

#[test]
fn discovery_round_rules_survive_the_wire() {
    // review-station spec「审查工单的读取」：server 端 rounds[] 带出 discovery 轮的
    // 套用规则记录，形状与 local CLI 相同；复验轮与 lastRound 为 null。
    let f = fixture();
    let c = client(&f.base, &f.pat);
    let discovery = format!(
        "**Phase**: discovery\n**Patch**: sha256:{}\n**Rules**: replace\n\
         **Rule**: SUGGESTION 偏好以提早返回取代深层嵌套\n**Scope**: src/lib.rs\n",
        "a".repeat(64)
    );
    let validation =
        format!("**Phase**: validation\n**Patch**: sha256:{}\n**Scope**: src/lib.rs\n", "b".repeat(64));
    c.station_add_round("review", "demo-change", &discovery).expect("discovery round");
    c.station_add_round("review", "demo-change", &validation).expect("validation round");
    let body = raw("GET", &f, "changes/demo-change/review")
        .call()
        .expect("get ticket")
        .into_string()
        .expect("body");
    let v: serde_json::Value = serde_json::from_str(&body).expect("valid JSON");
    assert_eq!(
        v["rounds"][0]["rules"],
        serde_json::json!({
            "baseline": "replace",
            "critical": [],
            "warning": [],
            "suggestion": ["偏好以提早返回取代深层嵌套"],
        })
    );
    assert!(v["rounds"][1]["rules"].is_null(), "validation round carries no record: {v}");
    assert!(v["lastRound"]["rules"].is_null(), "lastRound mirrors the validation round: {v}");
}

#[test]
fn malformed_rule_record_is_an_invalid_argument_with_zero_writes() {
    // review-station spec「审查工单的创建与追加」：remote 模式由 server 以同一文法
    // 检查，拒绝时回 invalid_argument（HTTP 400），工单零写入。
    let f = fixture();
    let content = format!(
        "**Phase**: discovery\n**Patch**: sha256:{}\n**Rules**: Extend\n**Scope**: src/lib.rs\n",
        "a".repeat(64)
    );
    let (status, error) = protocol_error(
        raw("POST", &f, "changes/demo-change/review/rounds")
            .send_json(serde_json::json!({ "content": content })),
    );
    assert_eq!(status, 400);
    assert_eq!(error.reason, ErrorReason::InvalidArgument);
    assert!(error.message.contains("extend or replace"), "names the problem: {}", error.message);
    assert!(ticket_doc(&f).is_none(), "refusal must not write the ticket");
}

#[test]
fn legacy_round_emits_explicit_nulls_on_the_wire() {
    let f = fixture();
    let c = client(&f.base, &f.pat);
    c.station_add_round("review", "demo-change", ROUND_WITH_FINDING).expect("legacy round");
    let body = raw("GET", &f, "changes/demo-change/review")
        .call()
        .expect("get ticket")
        .into_string()
        .expect("body");
    let v: serde_json::Value = serde_json::from_str(&body).expect("valid JSON");
    let round = v["rounds"][0].as_object().expect("round object");
    assert!(
        round.get("phase").is_some_and(serde_json::Value::is_null),
        "phase key present and null: {round:?}"
    );
    assert!(
        round.get("patchHash").is_some_and(serde_json::Value::is_null),
        "patchHash key present and null: {round:?}"
    );
    assert!(
        round.get("rules").is_some_and(serde_json::Value::is_null),
        "rules key present and null: {round:?}"
    );
}
