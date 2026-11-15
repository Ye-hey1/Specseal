//! Discussion routes over the same bridge and commit path (reference-server
//! spec). Promoting a discussion returns the new change name and lands both a
//! discussion-promoted and a change-created event in the scope outbox.

use crate::common;

use serde_json::{json, Value};
use specseal_protocol::error::{ErrorReason, ErrorResponse};
use specseal_remote::client::Client;
use specseal_server::audit::AuditActor;
use specseal_server::identity::MembershipRole;
use specseal_store::memory::MemoryStore;
use specseal_store::{
    CommandContext, DocumentId, OutboxCursor, ProjectId, RepoId, Scope, TeamStore,
};
use std::sync::Arc;

fn scope() -> Scope {
    Scope::new(ProjectId::new("demo"), RepoId::new("backend"))
}

fn client(base: &str, token: &str) -> Client {
    Client::new(
        &format!("{base}/api/specseal/v1/projects/demo"),
        token,
        Some("backend"),
    )
}

#[test]
fn create_and_show_round_trip_a_discussion() {
    let store: Arc<MemoryStore> = Arc::new(MemoryStore::new());
    let state = common::state_with(store);
    let (pat, _user) = common::seed_pat(&state.identity, &["demo"]);
    let base = common::start(state);
    let client = client(&base, &pat);

    let created = client.new_discussion("Rate limiting", None, None).expect("create discussion");
    assert!(!created.slug.is_empty(), "a slug is derived from the topic");

    let shown = client.show_discussion(&created.slug).expect("show discussion");
    assert_eq!(shown.info.slug, created.slug);
    assert_eq!(shown.info.topic, "Rate limiting");
    assert_eq!(shown.info.kind, None, "一般讨论的 kind 缺席");

    let listed = client.list_discussions(false).expect("list discussions");
    assert!(listed.discussions.iter().any(|d| d.slug == created.slug), "the discussion is listed");
}

#[test]
fn improve_discussion_is_created_and_read_back_with_its_kind() {
    // add-improve-flow：--kind 上 wire → 引擎写入 frontmatter → 读取路径曝露。
    let store: Arc<MemoryStore> = Arc::new(MemoryStore::new());
    let state = common::state_with(store);
    let (pat, _user) = common::seed_pat(&state.identity, &["demo"]);
    let base = common::start(state);
    let client = client(&base, &pat);

    let created = client
        .new_discussion("内核结构改进", Some("improve-core"), Some("improve"))
        .expect("create improve discussion");
    assert_eq!(created.slug, "improve-core");

    let shown = client.show_discussion("improve-core").expect("show discussion");
    assert_eq!(shown.info.kind.as_deref(), Some("improve"));

    let listed = client.list_discussions(false).expect("list discussions");
    let info = listed
        .discussions
        .iter()
        .find(|d| d.slug == "improve-core")
        .expect("the improve discussion is listed");
    assert_eq!(info.kind.as_deref(), Some("improve"));
}

#[test]
fn list_discussions_carries_promoted_to_for_promoted_ones() {
    // remote-read-parity「讨论列表回应携带 promotedTo」：server 于 route 边缘
    // 以引擎 promoted_to 查找函数组装，顺序沿 frontmatter 累加、未转出无键。
    let store: Arc<MemoryStore> = Arc::new(MemoryStore::new());
    let mut uow = store
        .begin_unit_of_work(
            &scope(),
            CommandContext { command: "seed".into(), actor: "seed".into() },
        )
        .expect("begin uow");
    uow.create(
        DocumentId::Discussion { slug: "gamma-promoted".into(), archived: false },
        "---\ntopic: Gamma promoted\nslug: gamma-promoted\nstatus: promoted\npromoted_to: cut-a, cut-b\ncreated: 2026-07-01\n---\n\n## Conclusion\n\n**Decision**: split\n",
    );
    uow.create(
        DocumentId::Discussion { slug: "plain-topic".into(), archived: false },
        "---\ntopic: Plain topic\nslug: plain-topic\nstatus: open\ncreated: 2026-07-02\n---\n\n## Context\n\nseed\n",
    );
    store.commit(uow, Vec::new()).expect("seed commit");
    let state = common::state_with(store);
    let (pat, _user) = common::seed_pat(&state.identity, &["demo"]);
    let base = common::start(state);

    let listed = client(&base, &pat).list_discussions(false).expect("list discussions");
    let promoted = listed
        .discussions
        .iter()
        .find(|d| d.slug == "gamma-promoted")
        .expect("promoted discussion listed");
    assert_eq!(
        promoted.promoted_to,
        ["cut-a", "cut-b"],
        "promotedTo preserves the frontmatter accumulation order"
    );

    // camelCase 与缺席即省略走 raw wire 断言。
    let body: Value = ureq::get(&format!("{base}/api/specseal/v1/projects/demo/discussions"))
        .set("Authorization", &format!("Bearer {pat}"))
        .set("X-Specseal-Api-Version", specseal_protocol::API_VERSION)
        .set("X-Specseal-Repo", "backend")
        .call()
        .expect("GET /discussions")
        .into_json()
        .expect("JSON body");
    let items = body["discussions"].as_array().expect("discussions array");
    let promoted_item =
        items.iter().find(|d| d["slug"] == "gamma-promoted").expect("promoted item");
    assert_eq!(promoted_item["promotedTo"], json!(["cut-a", "cut-b"]));
    let plain_item = items.iter().find(|d| d["slug"] == "plain-topic").expect("plain item");
    assert!(
        plain_item.get("promotedTo").is_none(),
        "an unpromoted discussion carries no promotedTo: {plain_item}"
    );
}

#[test]
fn list_discussions_carries_concluded_for_every_record() {
    // conclusion-gated-discussion-archive「讨论列表回应携带 concluded」：route
    // 边缘以引擎结论查找恒填 true／false（占位注解不算内文）。
    let store: Arc<MemoryStore> = Arc::new(MemoryStore::new());
    let mut uow = store
        .begin_unit_of_work(
            &scope(),
            CommandContext { command: "seed".into(), actor: "seed".into() },
        )
        .expect("begin uow");
    uow.create(
        DocumentId::Discussion { slug: "settled".into(), archived: false },
        "---\ntopic: Settled\nslug: settled\nstatus: promoted\npromoted_to: cut-a\ncreated: 2026-07-01\n---\n\n## Conclusion\n\n**Decision**: ship\n",
    );
    uow.create(
        DocumentId::Discussion { slug: "still-open".into(), archived: false },
        "---\ntopic: Still open\nslug: still-open\nstatus: promoted\npromoted_to: cut-b\ncreated: 2026-07-02\n---\n\n## Rounds\n\n## Conclusion\n\n<!-- Written by `specseal discuss conclude` -->\n",
    );
    store.commit(uow, Vec::new()).expect("seed commit");
    let state = common::state_with(store);
    let (pat, _user) = common::seed_pat(&state.identity, &["demo"]);
    let base = common::start(state);

    let listed = client(&base, &pat).list_discussions(false).expect("list discussions");
    let settled = listed.discussions.iter().find(|d| d.slug == "settled").expect("settled listed");
    assert_eq!(settled.concluded, Some(true));
    let open = listed.discussions.iter().find(|d| d.slug == "still-open").expect("open listed");
    assert_eq!(open.concluded, Some(false), "a placeholder conclusion reads as not concluded");

    // camelCase 走 raw wire 断言：两笔皆恒填。
    let body: Value = ureq::get(&format!("{base}/api/specseal/v1/projects/demo/discussions"))
        .set("Authorization", &format!("Bearer {pat}"))
        .set("X-Specseal-Api-Version", specseal_protocol::API_VERSION)
        .set("X-Specseal-Repo", "backend")
        .call()
        .expect("GET /discussions")
        .into_json()
        .expect("JSON body");
    let items = body["discussions"].as_array().expect("discussions array");
    let settled_item = items.iter().find(|d| d["slug"] == "settled").expect("settled item");
    assert_eq!(settled_item["concluded"], json!(true));
    let open_item = items.iter().find(|d| d["slug"] == "still-open").expect("open item");
    assert_eq!(open_item["concluded"], json!(false));
}

#[test]
fn discussion_routes_carry_hold_for_list_and_show() {
    // discussion-hold-until-release「讨论列表回应携带 concluded」：route 边缘自
    // 引擎的 frontmatter 解析恒填 hold true／false，单笔 show 的 info 同。
    let store: Arc<MemoryStore> = Arc::new(MemoryStore::new());
    let mut uow = store
        .begin_unit_of_work(
            &scope(),
            CommandContext { command: "seed".into(), actor: "seed".into() },
        )
        .expect("begin uow");
    uow.create(
        DocumentId::Discussion { slug: "held".into(), archived: false },
        "---\ntopic: Held\nslug: held\nstatus: promoted\npromoted_to: cut-a\ncreated: 2026-07-01\nhold: true\n---\n\n## Conclusion\n\n**Decision**: more cuts\n",
    );
    uow.create(
        DocumentId::Discussion { slug: "free".into(), archived: false },
        "---\ntopic: Free\nslug: free\nstatus: open\ncreated: 2026-07-02\n---\n\n## Rounds\n\n## Conclusion\n\n<!-- Written by `specseal discuss conclude` -->\n",
    );
    store.commit(uow, Vec::new()).expect("seed commit");
    let state = common::state_with(store);
    let (pat, _user) = common::seed_pat(&state.identity, &["demo"]);
    let base = common::start(state);

    let listed = client(&base, &pat).list_discussions(false).expect("list discussions");
    let held = listed.discussions.iter().find(|d| d.slug == "held").expect("held listed");
    assert_eq!(held.hold, Some(true));
    let free = listed.discussions.iter().find(|d| d.slug == "free").expect("free listed");
    assert_eq!(free.hold, Some(false), "无 hold 行的记录恒填 false");

    let shown = client(&base, &pat).show_discussion("held").expect("show discussion");
    assert_eq!(shown.info.hold, Some(true), "单笔回应的 info 同样携带");
    assert_eq!(shown.info.concluded, Some(true), "单笔回应的 info 两个字段都携带");

    // camelCase 走 raw wire 断言：两笔皆恒填。
    let body: Value = ureq::get(&format!("{base}/api/specseal/v1/projects/demo/discussions"))
        .set("Authorization", &format!("Bearer {pat}"))
        .set("X-Specseal-Api-Version", specseal_protocol::API_VERSION)
        .set("X-Specseal-Repo", "backend")
        .call()
        .expect("GET /discussions")
        .into_json()
        .expect("JSON body");
    let items = body["discussions"].as_array().expect("discussions array");
    let held_item = items.iter().find(|d| d["slug"] == "held").expect("held item");
    assert_eq!(held_item["hold"], json!(true));
    let free_item = items.iter().find(|d| d["slug"] == "free").expect("free item");
    assert_eq!(free_item["hold"], json!(false));
}

#[test]
fn promote_route_keeps_the_hold_flag_on_the_record() {
    // discussion-docs「转出保留旗标」的 remote 面：经 POST /discussions/{slug}/promote
    // 转出后，记录的 hold 行逐字保留，列表回应仍回 hold: true。
    let store: Arc<MemoryStore> = Arc::new(MemoryStore::new());
    let mut uow = store
        .begin_unit_of_work(
            &scope(),
            CommandContext { command: "seed".into(), actor: "seed".into() },
        )
        .expect("begin uow");
    uow.create(
        DocumentId::Discussion { slug: "held".into(), archived: false },
        "---\ntopic: Held\nslug: held\nstatus: promoted\npromoted_to: cut-a\ncreated: 2026-07-01\nhold: true\n---\n\n## Conclusion\n\n**Decision**: more cuts\n",
    );
    store.commit(uow, Vec::new()).expect("seed commit");
    let state = common::state_with(store.clone());
    let (pat, _user) = common::seed_pat(&state.identity, &["demo"]);
    let base = common::start(state);
    let client = client(&base, &pat);

    let promoted = client.discussion_promote("held", Some("cut-b"), false).expect("promote");
    assert_eq!(promoted.change, "cut-b");

    let record = store
        .snapshot(&scope())
        .expect("snapshot")
        .read(&DocumentId::Discussion { slug: "held".into(), archived: false })
        .expect("read record")
        .expect("record still live")
        .content;
    assert!(record.contains("promoted_to: cut-a, cut-b\n"), "累加下一刀: {record}");
    assert!(record.contains("hold: true\n"), "转出不清旗标: {record}");

    let listed = client.list_discussions(false).expect("list discussions");
    let held = listed.discussions.iter().find(|d| d.slug == "held").expect("held listed");
    assert_eq!(held.hold, Some(true));
}

#[test]
fn promote_route_with_last_releases_the_hold() {
    // server-verb-api「promote 端点带 last 解除 hold」：last: true 的转出把记录的 hold
    // 行移除、列表回 hold: false；不含 last 的转出仍保留旗标。
    let store: Arc<MemoryStore> = Arc::new(MemoryStore::new());
    let mut uow = store
        .begin_unit_of_work(
            &scope(),
            CommandContext { command: "seed".into(), actor: "seed".into() },
        )
        .expect("begin uow");
    for slug in ["last-cut", "more-cuts"] {
        uow.create(
            DocumentId::Discussion { slug: slug.into(), archived: false },
            &format!("---\ntopic: {slug}\nslug: {slug}\nstatus: promoted\npromoted_to: cut-a\ncreated: 2026-07-01\nhold: true\n---\n\n## Conclusion\n\n**Decision**: staged\n"),
        );
    }
    store.commit(uow, Vec::new()).expect("seed commit");
    let state = common::state_with(store.clone());
    let (pat, _user) = common::seed_pat(&state.identity, &["demo"]);
    let base = common::start(state);
    let client = client(&base, &pat);

    let promoted = client.discussion_promote("last-cut", Some("cut-b"), true).expect("promote --last");
    assert_eq!(promoted.change, "cut-b", "回应与不带 last 时同形");
    let promoted = client.discussion_promote("more-cuts", Some("cut-c"), false).expect("promote");
    assert_eq!(promoted.change, "cut-c");

    let snapshot = store.snapshot(&scope()).expect("snapshot");
    let read = |slug: &str| {
        snapshot
            .read(&DocumentId::Discussion { slug: slug.into(), archived: false })
            .expect("read record")
            .expect("record still live")
            .content
    };
    let released = read("last-cut");
    assert!(released.contains("promoted_to: cut-a, cut-b\n"), "累加最后一刀: {released}");
    assert!(!released.contains("hold"), "最后一刀解除旗标: {released}");
    let held = read("more-cuts");
    assert!(held.contains("hold: true\n"), "不带 last 的转出保留旗标: {held}");

    let listed = client.list_discussions(false).expect("list discussions");
    let find = |slug: &str| listed.discussions.iter().find(|d| d.slug == slug).expect("listed").hold;
    assert_eq!(find("last-cut"), Some(false));
    assert_eq!(find("more-cuts"), Some(true));
}

#[test]
fn archive_after_a_last_spin_out_co_archives_the_discussion() {
    // server-verb-api「带 last 转出后最后一个封存收走讨论」：promote --last 创建唯一的
    // 转出变更，封存它时随行封存清单列该讨论，live 清单不再有它。
    let store: Arc<MemoryStore> = Arc::new(MemoryStore::new());
    let mut uow = store
        .begin_unit_of_work(
            &scope(),
            CommandContext { command: "seed".into(), actor: "seed".into() },
        )
        .expect("begin uow");
    uow.create(
        DocumentId::Discussion { slug: "one-cut".into(), archived: false },
        "---\ntopic: One cut\nslug: one-cut\nstatus: concluded\ncreated: 2026-07-01\nhold: true\n---\n\n## Context\n\nx\n\n## Rounds\n\n## Conclusion\n\n**Decision**: one cut, then done\n",
    );
    store.commit(uow, Vec::new()).expect("seed commit");
    let state = common::state_with(store.clone());
    let (pat, _user) = common::seed_pat(&state.identity, &["demo"]);
    let base = common::start(state);
    let client = client(&base, &pat);

    let promoted = client.discussion_promote("one-cut", Some("only-cut"), true).expect("promote --last");
    assert_eq!(promoted.change, "only-cut");
    // 让转出的变更可封存：任务全勾（proposal 骨架由 promote 建好）。
    let mut uow = store
        .begin_unit_of_work(
            &scope(),
            CommandContext { command: "seed-tasks".into(), actor: "seed".into() },
        )
        .expect("begin uow");
    uow.create(
        DocumentId::ChangeArtifact { change: "only-cut".into(), artifact: "tasks.md".into() },
        "- [x] 1.1 done\n",
    );
    store.commit(uow, Vec::new()).expect("seed tasks");

    let resp = client.archive("only-cut", false, false).expect("archive over the wire");
    assert!(
        resp.archived_discussions.iter().any(|d| d.slug == "one-cut"),
        "最后一个封存随行封存讨论: {:?}",
        resp.archived_discussions
    );
    let live = client.list_discussions(false).expect("list live");
    assert!(live.discussions.iter().all(|d| d.slug != "one-cut"), "live 清单不再列它");
    let archived = client.list_discussions(true).expect("list archived");
    assert!(archived.discussions.iter().any(|d| d.slug == "one-cut"), "封存清单列它");
}

#[test]
fn promote_returns_the_change_and_lands_both_events() {
    let store: Arc<MemoryStore> = Arc::new(MemoryStore::new());
    let state = common::state_with(store.clone());
    let (pat, _user) = common::seed_pat(&state.identity, &["demo"]);
    let base = common::start(state);
    let client = client(&base, &pat);

    let created = client.new_discussion("Auth scope", None, None).expect("create discussion");
    let promoted = client
        .discussion_promote(&created.slug, None, false)
        .expect("promote discussion");
    assert!(!promoted.change.is_empty(), "promote returns the new change name");

    let entries = store.read_outbox(&scope(), OutboxCursor(0)).expect("read outbox");
    let kinds: Vec<&str> = entries.iter().map(|e| e.record.name.as_str()).collect();
    assert!(
        kinds.contains(&"discussion-promoted"),
        "a discussion-promoted event landed: {kinds:?}"
    );
    assert!(
        kinds.contains(&"change-created"),
        "a change-created event landed in the same promote: {kinds:?}"
    );
}

// --- 规格「讨论写入动词端点补齐」---

struct Fixture {
    base: String,
    store: Arc<MemoryStore>,
    editor_pat: String,
    reader_pat: String,
}

/// Server over an empty store with an editor PAT and a reader PAT both live.
fn fixture() -> Fixture {
    let store = Arc::new(MemoryStore::new());
    let state = common::state_with(store.clone());
    let (editor_pat, _) =
        common::seed_named_pat(&state.identity, "editor@example.com", "Editor", &["demo"]);
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
    Fixture { base: common::start(state), store, editor_pat, reader_pat }
}

fn request(method: &str, f: &Fixture, pat: &str, tail: &str) -> ureq::Request {
    ureq::request(method, &format!("{}/api/specseal/v1/projects/demo/{tail}", f.base))
        .set("Authorization", &format!("Bearer {pat}"))
        .set("X-Specseal-Api-Version", specseal_protocol::API_VERSION)
        .set("X-Specseal-Repo", "backend")
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

fn revision(f: &Fixture) -> u64 {
    f.store.snapshot(&scope()).expect("snapshot").revision().0
}

fn outbox_names(f: &Fixture) -> Vec<String> {
    f.store
        .read_outbox(&scope(), OutboxCursor(0))
        .expect("read outbox")
        .iter()
        .map(|e| e.record.name.clone())
        .collect()
}

fn live_discussion(f: &Fixture, slug: &str) -> Option<String> {
    f.store
        .snapshot(&scope())
        .expect("snapshot")
        .read(&DocumentId::Discussion { slug: slug.into(), archived: false })
        .expect("read discussion")
        .map(|d| d.content)
}

fn change_meta(f: &Fixture, change: &str) -> Option<String> {
    f.store
        .snapshot(&scope())
        .expect("snapshot")
        .read(&DocumentId::ChangeMeta { change: change.into() })
        .expect("read change meta")
        .map(|d| d.content)
}

/// Seed change `demo` directly in the store (the link/seal subject).
fn seed_change(f: &Fixture) {
    let mut uow = f
        .store
        .begin_unit_of_work(
            &scope(),
            CommandContext { command: "seed".into(), actor: "seed".into() },
        )
        .expect("begin uow");
    uow.create(DocumentId::ChangeMeta { change: "demo".into() }, "schema: spec-driven\n");
    f.store.commit(uow, Vec::new()).expect("seed commit");
}

#[test]
fn create_with_a_legal_slug_override_lands_on_that_slug() {
    let f = fixture();
    let response = request("POST", &f, &f.editor_pat, "discussions")
        .send_json(json!({ "topic": "看板搜索列", "slug": "board-search-bar" }))
        .expect("create with slug override succeeds");
    assert_eq!(response.status(), 200);
    let body = response.into_json::<Value>().expect("JSON body");
    assert_eq!(body["slug"], "board-search-bar", "the response slug is the override");
    assert_eq!(body["topic"], "看板搜索列", "the topic stays verbatim");
    let doc = live_discussion(&f, "board-search-bar").expect("the record lands on the slug");
    assert!(doc.contains("topic: 看板搜索列"), "the document keeps the CJK topic: {doc}");
}

#[test]
fn create_with_an_invalid_slug_refuses_without_writing() {
    let f = fixture();
    let before = revision(&f);
    let (status, error) = protocol_error(
        request("POST", &f, &f.editor_pat, "discussions")
            .send_json(json!({ "topic": "看板搜索列", "slug": "中文slug" })),
    );
    assert_eq!(status, 400);
    assert_eq!(error.reason, ErrorReason::InvalidArgument, "semantic slug refusal");
    assert!(
        error.message.contains("must be ASCII kebab-case"),
        "the engine's frozen message is relayed verbatim: {}",
        error.message
    );
    assert_eq!(revision(&f), before, "a refused create writes nothing");
    assert!(outbox_names(&f).is_empty(), "a refused create publishes no event");
}

#[test]
fn create_with_an_unknown_kind_refuses_with_the_engine_message() {
    // 白名单的单一事实来源在引擎；server 逐字转述拒绝消息。
    let f = fixture();
    let before = revision(&f);
    let (status, error) = protocol_error(
        request("POST", &f, &f.editor_pat, "discussions")
            .send_json(json!({ "topic": "主题", "slug": "alpha", "kind": "refactor" })),
    );
    assert_eq!(status, 400);
    assert_eq!(error.reason, ErrorReason::InvalidArgument, "semantic kind refusal");
    assert!(error.message.contains("improve"), "消息点名唯一合法值：{}", error.message);
    assert_eq!(revision(&f), before, "a refused create writes nothing");
    assert!(outbox_names(&f).is_empty(), "a refused create publishes no event");
}

#[test]
fn create_with_a_multiline_topic_refuses_without_writing() {
    // topic 逐字写入 frontmatter——夹带换行可注入伪造的 kind:/status: 行，
    // 引擎在边界拒绝，server 判 400 语意拒绝。
    let f = fixture();
    let before = revision(&f);
    let (status, error) = protocol_error(
        request("POST", &f, &f.editor_pat, "discussions")
            .send_json(json!({ "topic": "x\nkind: improve\nstatus: promoted", "slug": "plain-a" })),
    );
    assert_eq!(status, 400, "injection refusal stays 400: {}", error.message);
    assert_eq!(error.reason, ErrorReason::InvalidArgument, "semantic topic refusal");
    assert_eq!(revision(&f), before, "a refused create writes nothing");
    assert!(outbox_names(&f).is_empty(), "a refused create publishes no event");
}

#[test]
fn create_with_a_kind_crafted_to_spoof_not_found_still_refuses_as_invalid_argument() {
    // kind 是 request body 全可控字符串——引擎消息会内嵌它，值带「' not found」
    // 不得把语意拒绝（400）操纵成 not_found（404）。
    let f = fixture();
    let (status, error) = protocol_error(
        request("POST", &f, &f.editor_pat, "discussions")
            .send_json(json!({ "topic": "主题", "kind": "x' not found" })),
    );
    assert_eq!(status, 400, "a semantic refusal stays 400: {}", error.message);
    assert_eq!(error.reason, ErrorReason::InvalidArgument, "spoofed kind refusal");
    assert!(outbox_names(&f).is_empty(), "a refused create publishes no event");
}

#[test]
fn delete_zero_round_discussion_removes_it_and_advances_revision() {
    let f = fixture();
    let slug = client(&f.base, &f.editor_pat)
        .new_discussion("Scrap idea", None, None)
        .expect("create discussion")
        .slug;
    let before = revision(&f);
    let response = request("DELETE", &f, &f.editor_pat, &format!("discussions/{slug}"))
        .call()
        .expect("delete a zero-round discussion succeeds");
    assert_eq!(response.status(), 200);
    assert_eq!(live_discussion(&f, &slug), None, "the record is gone");
    assert!(revision(&f) > before, "the delete commit advances the scope revision");
    assert!(
        outbox_names(&f).contains(&"discussion-discarded".to_string()),
        "the commit publishes discussion-discarded: {:?}",
        outbox_names(&f)
    );
}

#[test]
fn delete_with_rounds_requires_force_and_preserves_the_record() {
    let f = fixture();
    let c = client(&f.base, &f.editor_pat);
    let slug = c.new_discussion("Real tradeoffs", None, None).expect("create discussion").slug;
    c.discussion_add_round(&slug, "assumptions", "第一轮纪录")
        .expect("add a round");
    let doc_before = live_discussion(&f, &slug).expect("record exists");
    let before = revision(&f);

    let (status, error) = protocol_error(
        request("DELETE", &f, &f.editor_pat, &format!("discussions/{slug}")).call(),
    );
    assert_eq!(status, 409);
    assert_eq!(error.reason, ErrorReason::Refused, "machine-readable needs-force refusal");
    assert!(error.message.contains("--force"), "the refusal names --force: {}", error.message);
    assert_eq!(
        live_discussion(&f, &slug).as_deref(),
        Some(doc_before.as_str()),
        "the record is byte-identical after the refusal"
    );
    assert_eq!(revision(&f), before, "a refused delete writes nothing");

    let response =
        request("DELETE", &f, &f.editor_pat, &format!("discussions/{slug}?force=true"))
            .call()
            .expect("force=true deletes the discussion");
    assert_eq!(response.status(), 200);
    assert_eq!(live_discussion(&f, &slug), None, "force removes the record");
}

#[test]
fn reader_discussion_delete_is_forbidden_with_intact_record() {
    let f = fixture();
    let slug = client(&f.base, &f.editor_pat)
        .new_discussion("Reader target", None, None)
        .expect("create discussion")
        .slug;
    let before = revision(&f);
    let (status, error) = protocol_error(
        request("DELETE", &f, &f.reader_pat, &format!("discussions/{slug}")).call(),
    );
    assert_eq!(status, 403);
    assert_eq!(error.reason, ErrorReason::PermissionDenied, "machine-readable role refusal");
    assert!(live_discussion(&f, &slug).is_some(), "the discussion is fully preserved");
    assert_eq!(revision(&f), before, "a reader refusal writes nothing");
}

#[test]
fn link_forges_the_meta_chain_and_seal_marks_promoted() {
    let f = fixture();
    seed_change(&f);
    let c = client(&f.base, &f.editor_pat);
    let slug = c.new_discussion("Auth scope", None, None).expect("create discussion").slug;

    let response = request("POST", &f, &f.editor_pat, &format!("discussions/{slug}/link"))
        .send_json(json!({ "change": "demo" }))
        .expect("link succeeds");
    assert_eq!(response.status(), 200);
    let body = response.into_json::<Value>().expect("JSON body");
    assert_eq!(body["slug"], slug.as_str());
    assert_eq!(body["change"], "demo");
    let meta = change_meta(&f, "demo").expect("change meta exists");
    assert!(
        meta.contains(&format!("from_discussion: {slug}")),
        "link forges the from_discussion chain: {meta}"
    );

    let response = request("POST", &f, &f.editor_pat, &format!("discussions/{slug}/seal"))
        .send_json(json!({ "change": "demo" }))
        .expect("seal succeeds");
    assert_eq!(response.status(), 200);
    let shown = c.show_discussion(&slug).expect("show discussion");
    assert_eq!(shown.info.status, "promoted", "seal marks the discussion promoted");
    let kinds = outbox_names(&f);
    assert!(
        kinds.contains(&"discussion-linked".to_string())
            && kinds.contains(&"discussion-sealed".to_string()),
        "link and seal each publish their event: {kinds:?}"
    );
}

#[test]
fn link_ignores_last_and_seal_with_last_releases_the_hold() {
    // server-verb-api「seal 端点带 last 解除 hold 而 link 忽略」。
    let f = fixture();
    seed_change(&f);
    let c = client(&f.base, &f.editor_pat);
    let slug = c.new_discussion("Held scope", None, None).expect("create discussion").slug;
    c.discussion_conclude(&slug, "**Decision**: staged\n", true).expect("conclude --hold");
    let before = live_discussion(&f, &slug).expect("record");
    assert!(before.contains("hold: true\n"), "seed 带 hold: {before}");

    let response = request("POST", &f, &f.editor_pat, &format!("discussions/{slug}/link"))
        .send_json(json!({ "change": "demo", "last": true }))
        .expect("link succeeds");
    assert_eq!(response.status(), 200);
    assert_eq!(live_discussion(&f, &slug).as_deref(), Some(before.as_str()), "link 忽略 last、记录逐比特不变");

    let response = request("POST", &f, &f.editor_pat, &format!("discussions/{slug}/seal"))
        .send_json(json!({ "change": "demo", "last": true }))
        .expect("seal succeeds");
    assert_eq!(response.status(), 200);
    let after = live_discussion(&f, &slug).expect("record");
    assert!(after.contains("promoted_to: demo"), "seal 标记已转出: {after}");
    assert!(!after.contains("hold"), "seal --last 解除旗标: {after}");
    let shown = c.show_discussion(&slug).expect("show discussion");
    assert_eq!(shown.info.hold, Some(false));
}

#[test]
fn discussion_writes_on_missing_subjects_are_404_with_engine_messages() {
    let f = fixture();
    seed_change(&f);
    let slug = client(&f.base, &f.editor_pat)
        .new_discussion("Exists", None, None)
        .expect("create discussion")
        .slug;

    // 缺席的讨论：DELETE 与 link/seal 皆 404，消息为引擎冻结文本。
    let (status, error) =
        protocol_error(request("DELETE", &f, &f.editor_pat, "discussions/no-such").call());
    assert_eq!(status, 404);
    assert_eq!(error.reason, ErrorReason::NotFound);
    assert!(error.message.contains("'no-such' not found"), "{}", error.message);

    for verb in ["link", "seal"] {
        let (status, error) = protocol_error(
            request("POST", &f, &f.editor_pat, &format!("discussions/no-such/{verb}"))
                .send_json(json!({ "change": "demo" })),
        );
        assert_eq!(status, 404, "{verb} on a missing discussion");
        assert_eq!(error.reason, ErrorReason::NotFound);
        assert!(error.message.contains("'no-such' not found"), "{}", error.message);

        // 缺席的 change：同样 404。
        let (status, error) = protocol_error(
            request("POST", &f, &f.editor_pat, &format!("discussions/{slug}/{verb}"))
                .send_json(json!({ "change": "no-such-change" })),
        );
        assert_eq!(status, 404, "{verb} on a missing change");
        assert_eq!(error.reason, ErrorReason::NotFound);
        assert!(
            error.message.contains("Change 'no-such-change' not found."),
            "{}",
            error.message
        );
    }
}

// --- 规格「讨论定案搜索端点」（discuss-search-recall）---

/// Seed one discussion record straight into the store, live or archived.
fn seed_discussion(f: &Fixture, slug: &str, archived: bool, text: &str) {
    let mut uow = f
        .store
        .begin_unit_of_work(
            &scope(),
            CommandContext { command: "seed".into(), actor: "seed".into() },
        )
        .expect("begin uow");
    uow.create(DocumentId::Discussion { slug: slug.into(), archived }, text);
    f.store.commit(uow, Vec::new()).expect("seed commit");
}

const SEARCH_LIVE_RECORD: &str =
    "---\ntopic: Drawer scope\nslug: drawer-scope\nstatus: open\ncreated: 2026-07-01\n---\n\n\
     ## Context\n\nseed\n\n## Rounds\n\n## Conclusion\n";
const SEARCH_ARCHIVED_RECORD: &str =
    "---\ntopic: Trace links\nslug: trace-links-two-hops\nstatus: concluded\ncreated: 2026-08-20\n---\n\n\
     ## Context\n\nseed\n\n## Rounds\n\n\
     ### Round 1 — assumptions (2026-08-20)\n\n**Focus**: drawer\n**Ruled out**: nothing\n\n\
     ### Round 2 — interview (2026-08-21)\n\n**Ruled out**: RichDetailDrawer 加 readOnly 旗标（分支地狱）\n\n\
     ## Conclusion\n\n**Decision**: two hops\n";

fn seed_search_records(f: &Fixture) {
    seed_discussion(f, "drawer-scope", false, SEARCH_LIVE_RECORD);
    seed_discussion(f, "trace-links-two-hops", true, SEARCH_ARCHIVED_RECORD);
}

#[test]
fn discussion_search_returns_live_and_archived_hits_in_spec_order() {
    let f = fixture();
    seed_search_records(&f);
    let body: Value = request("GET", &f, &f.editor_pat, "discussions/search?q=drawer")
        .call()
        .expect("GET /discussions/search")
        .into_json()
        .expect("JSON body");
    let hits = body["hits"].as_array().expect("hits array");
    assert_eq!(hits.len(), 2, "one live topic hit, one archived ruled-out hit: {body}");
    assert_eq!(hits[0]["slug"], "drawer-scope");
    assert_eq!(hits[0]["archived"], false);
    assert_eq!(hits[0]["matches"][0]["kind"], "topic");
    assert_eq!(hits[0]["matches"][0]["where"], "frontmatter");
    assert_eq!(hits[1]["slug"], "trace-links-two-hops");
    assert_eq!(hits[1]["archived"], true);
    assert_eq!(hits[1]["matches"][0]["kind"], "ruled-out");
    assert_eq!(hits[1]["matches"][0]["where"], "round-2");
    assert_eq!(
        hits[1]["matches"][0]["text"],
        "**Ruled out**: RichDetailDrawer 加 readOnly 旗标（分支地狱）"
    );
}

#[test]
fn discussion_search_without_keywords_is_invalid_argument() {
    let f = fixture();
    seed_search_records(&f);
    let before = revision(&f);
    let (status, error) =
        protocol_error(request("GET", &f, &f.editor_pat, "discussions/search").call());
    assert_eq!(status, 400);
    assert_eq!(error.reason, ErrorReason::InvalidArgument);
    let (status, error) =
        protocol_error(request("GET", &f, &f.editor_pat, "discussions/search?q=%20").call());
    assert_eq!(status, 400, "an all-blank q is the same refusal");
    assert_eq!(error.reason, ErrorReason::InvalidArgument);
    assert_eq!(revision(&f), before, "a refused search writes nothing");
}

#[test]
fn discussion_search_is_open_to_readers_with_the_editor_shape() {
    let f = fixture();
    seed_search_records(&f);
    let reader: Value = request("GET", &f, &f.reader_pat, "discussions/search?q=drawer")
        .call()
        .expect("reader GET /discussions/search")
        .into_json()
        .expect("JSON body");
    let editor: Value = request("GET", &f, &f.editor_pat, "discussions/search?q=drawer")
        .call()
        .expect("editor GET /discussions/search")
        .into_json()
        .expect("JSON body");
    assert_eq!(reader["hits"].as_array().unwrap().len(), 2);
    assert_eq!(reader, editor, "the read shape does not depend on the role");
}

#[test]
fn discussion_search_reads_extras_from_each_hit_own_record_when_a_slug_is_reused() {
    // review 第一轮 must-fix：slug 封存后可重用；在途与封存同名同时命中时，
    // 封存那笔的 promotedTo／concluded 必须来自封存记录本身，不得抄在途值。
    let f = fixture();
    seed_discussion(
        &f,
        "reuse",
        false,
        "---\ntopic: Drawer reuse (live)\nslug: reuse\nstatus: open\ncreated: 2026-09-01\n---\n\n\
         ## Context\n\nseed\n\n## Rounds\n\n## Conclusion\n\n<!-- Written by `specseal discuss conclude` -->\n",
    );
    seed_discussion(
        &f,
        "reuse",
        true,
        "---\ntopic: Drawer reuse (archived)\nslug: reuse\nstatus: promoted\npromoted_to: drawer-cut\ncreated: 2026-07-01\n---\n\n\
         ## Context\n\nseed\n\n## Rounds\n\n## Conclusion\n\n**Decision**: settled\n",
    );
    let body: Value = request("GET", &f, &f.editor_pat, "discussions/search?q=drawer")
        .call()
        .expect("GET /discussions/search")
        .into_json()
        .expect("JSON body");
    let hits = body["hits"].as_array().expect("hits array");
    assert_eq!(hits.len(), 2, "{body}");
    let live = hits.iter().find(|h| h["archived"] == false).expect("live hit");
    let archived = hits.iter().find(|h| h["archived"] == true).expect("archived hit");
    assert_eq!(live["concluded"], false);
    assert!(live.get("promotedTo").is_none(), "live record was never promoted: {live}");
    assert_eq!(archived["concluded"], true, "the archived record's own conclusion: {archived}");
    assert_eq!(archived["promotedTo"], json!(["drawer-cut"]));
}

#[test]
fn discussion_search_route_matches_the_engine_search_over_the_same_records() {
    // command-runtime scenario「discuss search 本机与 server 同语意」：同一组记录放进
    // 本机 fs store 与 server，引擎函数与端点回同一串行的 hits（slug、字段、matches）。
    let f = fixture();
    seed_search_records(&f);
    let body: Value = request("GET", &f, &f.editor_pat, "discussions/search?q=drawer")
        .call()
        .expect("GET /discussions/search")
        .into_json()
        .expect("JSON body");

    let root = tempfile::tempdir().expect("tempdir");
    let discussions = root.path().join("openspec").join("discussions");
    std::fs::create_dir_all(discussions.join("archive")).unwrap();
    std::fs::write(discussions.join("drawer-scope.md"), SEARCH_LIVE_RECORD).unwrap();
    std::fs::write(
        discussions.join("archive").join("2026-08-20-trace-links-two-hops.md"),
        SEARCH_ARCHIVED_RECORD,
    )
    .unwrap();
    let engine = specseal_fs::FsStore::new(root.path(), "openspec");
    let hits = specseal_core::discuss::search(&engine, &["drawer".to_string()]).expect("engine search");

    // promotedTo／concluded／hold 是 route 边缘增栏、path 是各 store 的位置——
    // 都不是语意的一部分。
    let strip = |h: &Value| {
        let mut h = h.clone();
        let o = h.as_object_mut().unwrap();
        o.remove("promotedTo");
        o.remove("concluded");
        o.remove("hold");
        o.remove("path");
        h
    };
    let route: Vec<Value> = body["hits"].as_array().unwrap().iter().map(strip).collect();
    let engine: Vec<Value> =
        serde_json::to_value(&hits).unwrap().as_array().unwrap().iter().map(strip).collect();
    assert_eq!(route, engine, "the endpoint and the engine agree on order, fields and matches");
}

// --- 规格「讨论详情回应携带分刀」（discussion-cuts-from-engine）---

const CUTS_LIVE_RECORD: &str =
    "---\ntopic: Panel\nslug: panel\nstatus: promoted\npromoted_to: add-y\ncreated: 2026-11-01\n---\n\n\
     # Discussion: Panel\n\n## Context\n\nseed\n\n## Rounds\n\n## Conclusion\n\n\
     **Decision**: 分两刀。\n\n- **cut 2 `add-y`**: 引擎解析\n- **cut 3 `add-z`**: 路线图\n";
const CUTS_ARCHIVED_RECORD: &str =
    "---\ntopic: Old topic\nslug: old-topic\nstatus: promoted\npromoted_to: add-a\ncreated: 2026-08-01\n---\n\n\
     # Discussion: Old topic\n\n## Context\n\nseed\n\n## Rounds\n\n## Conclusion\n\n\
     **Decision**: 一刀。\n\n- **cut 1 `add-a`**: 骨架\n";
const CUTS_FRESH_RECORD: &str =
    "---\ntopic: Fresh topic\nslug: fresh-topic\nstatus: open\ncreated: 2026-11-02\n---\n\n\
     # Discussion: Fresh topic\n\n## Context\n\nseed\n\n## Rounds\n\n\
     ### Round 1 — assumptions (2026-11-02)\n\n**Focus**: scope\n";

/// GET /discussions/{slug} 的原始 JSON。
fn show_body(f: &Fixture, slug: &str) -> Value {
    request("GET", f, &f.reader_pat, &format!("discussions/{slug}"))
        .call()
        .expect("GET /discussions/{slug}")
        .into_json()
        .expect("JSON body")
}

/// 回应顶层只多 `cuts`；`content` 为记录原文；`info` 除 path（各 store 的位置）外与既有字段逐一相同。
fn assert_info_and_content_unchanged(body: &Value, text: &str, info: Value) {
    let mut keys: Vec<_> = body.as_object().expect("object body").keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, ["content", "cuts", "info"]);
    assert_eq!(body["content"], text);
    let mut got = body["info"].clone();
    let path = got.as_object_mut().unwrap().remove("path").expect("info.path");
    assert!(path.as_str().unwrap().ends_with(".md"), "{path}");
    assert_eq!(got, info);
}

#[test]
fn show_discussion_carries_cuts_for_a_live_record() {
    let f = fixture();
    seed_discussion(&f, "panel", false, CUTS_LIVE_RECORD);
    let body = show_body(&f, "panel");
    assert_eq!(
        body["cuts"],
        json!([
            {
                "cut": "cut 2", "title": "引擎解析", "note": "", "line": "**cut 2 `add-y`**: 引擎解析",
                "changes": ["add-y"], "changesInBold": true, "unpromoted": []
            },
            {
                "cut": "cut 3", "title": "路线图", "note": "", "line": "**cut 3 `add-z`**: 路线图",
                "changes": ["add-z"], "changesInBold": true, "unpromoted": ["add-z"]
            }
        ])
    );
    let engine = specseal_core::discuss::record_cuts(CUTS_LIVE_RECORD, &["add-y".to_string()]);
    assert_eq!(body["cuts"], serde_json::to_value(engine).unwrap(), "the route reports the engine's cuts");
    assert_info_and_content_unchanged(
        &body,
        CUTS_LIVE_RECORD,
        json!({
            "slug": "panel", "topic": "Panel", "status": "promoted", "rounds": 0, "created": "2026-11-01",
            "promotedTo": ["add-y"], "concluded": true, "hold": false, "archived": false
        }),
    );
}

#[test]
fn show_discussion_carries_cuts_for_an_archived_record() {
    let f = fixture();
    seed_discussion(&f, "old-topic", true, CUTS_ARCHIVED_RECORD);
    let body = show_body(&f, "old-topic");
    assert_eq!(body["info"]["archived"], true);
    assert_eq!(
        body["cuts"],
        json!([{
            "cut": "cut 1", "title": "骨架", "note": "", "line": "**cut 1 `add-a`**: 骨架",
            "changes": ["add-a"], "changesInBold": true, "unpromoted": []
        }])
    );
    assert_info_and_content_unchanged(
        &body,
        CUTS_ARCHIVED_RECORD,
        json!({
            "slug": "old-topic", "topic": "Old topic", "status": "promoted", "rounds": 0, "created": "2026-08-01",
            "promotedTo": ["add-a"], "concluded": true, "hold": false, "archived": true
        }),
    );
}

#[test]
fn show_discussion_without_a_conclusion_has_empty_cuts() {
    let f = fixture();
    seed_discussion(&f, "fresh-topic", false, CUTS_FRESH_RECORD);
    let body = show_body(&f, "fresh-topic");
    assert_eq!(body["cuts"], json!([]));
    assert_info_and_content_unchanged(
        &body,
        CUTS_FRESH_RECORD,
        json!({
            "slug": "fresh-topic", "topic": "Fresh topic", "status": "open", "rounds": 1, "created": "2026-11-02",
            "concluded": false, "hold": false, "archived": false
        }),
    );
}

/// client-protocol「分刀各栏」Example 的记录：promoted_to 为 `a`，Decision 三条顶层列点。
const CUTS_EXAMPLE_RECORD: &str =
    "---\ntopic: Panel\nslug: panel\nstatus: promoted\npromoted_to: a\ncreated: 2026-11-01\n---\n\n\
     # Discussion: Panel\n\n## Context\n\nseed\n\n## Rounds\n\n## Conclusion\n\n\
     **Decision**: 分三刀。\n\n- **cut 1 `a`**: 骨架——三种详情页改三栏\n\
     - **cut 2 外壳**（拆两个 change：`b` 外壳、`c` 菜单）\n- **cut 3 `d` `e`**: 收尾\n";

#[test]
fn show_discussion_carries_the_example_cut_columns() {
    // client-protocol 场景「详情回应带分刀」：三列的各栏（note 非空、changesInBold 为 false、
    // unpromoted 为 d、e）经 GET /discussions/panel 原样送出。
    let f = fixture();
    seed_discussion(&f, "panel", false, CUTS_EXAMPLE_RECORD);
    let body = show_body(&f, "panel");
    assert_eq!(
        body["cuts"],
        json!([
            {
                "cut": "cut 1", "title": "骨架", "note": "三种详情页改三栏",
                "line": "**cut 1 `a`**: 骨架——三种详情页改三栏",
                "changes": ["a"], "changesInBold": true, "unpromoted": []
            },
            {
                "cut": "cut 2", "title": "外壳", "note": "拆两个 change：`b` 外壳、`c` 菜单",
                "line": "**cut 2 外壳**（拆两个 change：`b` 外壳、`c` 菜单）",
                "changes": ["b", "c"], "changesInBold": false, "unpromoted": []
            },
            {
                "cut": "cut 3", "title": "收尾", "note": "", "line": "**cut 3 `d` `e`**: 收尾",
                "changes": ["d", "e"], "changesInBold": true, "unpromoted": ["d", "e"]
            }
        ])
    );
    assert_info_and_content_unchanged(
        &body,
        CUTS_EXAMPLE_RECORD,
        json!({
            "slug": "panel", "topic": "Panel", "status": "promoted", "rounds": 0, "created": "2026-11-01",
            "promotedTo": ["a"], "concluded": true, "hold": false, "archived": false
        }),
    );
}
