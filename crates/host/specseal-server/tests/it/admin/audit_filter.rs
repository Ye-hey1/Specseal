//! 稽核 view model 的服务器端筛选与分页（server-admin「管理 browser API 提供最小且
//! 完整的页面 view model」）。`/api/specseal/v1/web/admin/audit` 接受关键字、动作、
//! 来源、时间区间与页码参数，于服务器端套用后只回当页事件、总页数与符合筛选的总笔数
//! （`total`）——未符合筛选的事件不出现在回应中。参数边界：页码小于 1 或时间区间起始晚于
//! 结束回 400 `invalid_argument`；页码超出总页数不是错误，回空清单与正确总页数及总笔数。

use crate::common;

use chrono::{Duration, Utc};
use serde_json::{json, Value};
use specseal_server::audit::{AuditAction, AuditActor, AuditSource};
use specseal_server::identity::{IdentitySqlite, IdentityStore, NewInvitation};
use specseal_server::state::AppState;
use specseal_store::memory::MemoryStore;
use std::sync::Arc;

const PASSWORD: &str = "pw-correct-horse";

fn seed_user(identity: &Arc<IdentitySqlite>, email: &str, admin: bool) -> String {
    let token = identity
        .create_invitation(NewInvitation {
            email: email.to_string(),
            display: format!("User <{email}>"),
            memberships: vec!["demo".to_string()],
            admin,
            expires_at: Utc::now() + Duration::days(1),
        })
        .expect("invite");
    identity.accept_invitation(&token, PASSWORD).expect("accept")
}

/// A server whose audit log starts empty (the seeding path records nothing).
fn start() -> (String, Arc<IdentitySqlite>, String) {
    let identity = Arc::new(IdentitySqlite::open_memory().expect("identity"));
    common::seed_demo_registry(&*identity);
    let admin_id = seed_user(&identity, "admin@example.com", true);
    let state = AppState::new(
        Arc::new(MemoryStore::new()),
        identity.clone(),
        Arc::new(common::demo_config()),
        common::detached_events(),
    );
    (common::start(state), identity, admin_id)
}

fn agent() -> ureq::Agent {
    ureq::builder().redirects(0).build()
}

fn login(base: &str) -> String {
    let resp = agent()
        .post(&format!("{base}/api/specseal/v1/web/login"))
        .set("Origin", "http://127.0.0.1")
        .send_json(json!({ "email": "admin@example.com", "password": PASSWORD }))
        .expect("login");
    resp.header("set-cookie")
        .and_then(|c| c.split(';').next())
        .and_then(|c| c.trim().strip_prefix("specseal_session="))
        .expect("session cookie")
        .to_string()
}

fn audit(base: &str, cookie: &str, query: &str) -> (u16, Value) {
    let result = agent()
        .get(&format!("{base}/api/specseal/v1/web/admin/audit{query}"))
        .set("Cookie", &format!("specseal_session={cookie}"))
        .call();
    match result {
        Ok(resp) => {
            let status = resp.status();
            (status, resp.into_json().unwrap_or(Value::Null))
        }
        Err(ureq::Error::Status(code, resp)) => (code, resp.into_json().unwrap_or(Value::Null)),
        Err(e) => panic!("transport error: {e}"),
    }
}

/// The subjects of a response page, newest-first.
fn subjects(body: &Value) -> Vec<String> {
    body["data"]["entries"]
        .as_array()
        .expect("entries array")
        .iter()
        .map(|e| e["subject"].as_str().expect("subject").to_string())
        .collect()
}

/// Seed the spec's five-event example, oldest first so the log reads back
/// newest-first as E1..E5. The spec writes the actions as `user.invite` /
/// `project.create` / `user.suspend`; those map onto this server's closed
/// [`AuditAction`] set as `user-invited` / `project-created` / `user-suspended`.
fn seed_example(identity: &Arc<IdentitySqlite>, admin_id: &str) {
    let actor = AuditActor::user(admin_id.to_string(), AuditSource::Web);
    for (subject, action) in [
        ("E5", AuditAction::UserInvited),
        ("E4", AuditAction::UserSuspended),
        ("E3", AuditAction::UserInvited),
        ("E2", AuditAction::ProjectCreated),
        ("E1", AuditAction::UserInvited),
    ] {
        identity
            .record_audit(&actor, action, subject)
            .expect("record audit");
    }
}

#[test]
fn filter_and_page_are_applied_server_side() {
    // Example「筛选与分页组合」：以动作筛选 user-invited、每页 2 笔、第 2 页
    // → 只回 E5，总页数 2，总笔数 3，且 E2 与 E4 不出现在回应中。
    let (base, identity, admin_id) = start();
    seed_example(&identity, &admin_id);
    let cookie = login(&base);
    let (status, body) = audit(&base, &cookie, "?action=user-invited&limit=2&page=2");
    assert_eq!(status, 200, "the filtered page loads: {body}");
    assert_eq!(subjects(&body), vec!["E5"], "page 2 of user-invited is E5");
    assert_eq!(body["data"]["totalPages"], json!(2), "three matches at 2 per page");
    assert_eq!(body["data"]["total"], json!(3), "the filter matches three events");
    let raw = body.to_string();
    assert!(!raw.contains("E2"), "a project-created event is filtered out: {raw}");
    assert!(!raw.contains("E4"), "a user-suspended event is filtered out: {raw}");
}

#[test]
fn a_page_below_one_is_invalid_argument() {
    // Example「参数边界」：页码 0 或负数 → 400 invalid_argument，不回传事件。
    let (base, identity, admin_id) = start();
    seed_example(&identity, &admin_id);
    let cookie = login(&base);
    for page in ["0", "-1"] {
        let (status, body) = audit(&base, &cookie, &format!("?page={page}"));
        assert_eq!(status, 400, "page={page} is refused: {body}");
        assert_eq!(body["error"]["code"], json!("invalid_argument"));
        assert!(body["data"].is_null(), "no events accompany the refusal");
    }
}

#[test]
fn a_page_beyond_the_last_is_empty_but_not_an_error() {
    // Example「参数边界」：页码大于总页数 → 空清单与正确总页数及总笔数，不回 404。
    let (base, identity, admin_id) = start();
    seed_example(&identity, &admin_id);
    let cookie = login(&base);
    let (status, body) = audit(&base, &cookie, "?limit=2&page=9");
    assert_eq!(status, 200, "an over-run page is not an error: {body}");
    assert!(subjects(&body).is_empty(), "the page is empty");
    assert_eq!(body["data"]["totalPages"], json!(3), "five events at 2 per page");
    assert_eq!(body["data"]["total"], json!(5), "the total ignores the page");
}

#[test]
fn an_unknown_action_returns_no_events_and_zero_pages() {
    // Example「参数边界」：未知动作名称 → 空清单、总页数 0 与总笔数 0。
    let (base, identity, admin_id) = start();
    seed_example(&identity, &admin_id);
    let cookie = login(&base);
    let (status, body) = audit(&base, &cookie, "?action=no-such-action");
    assert_eq!(status, 200, "an unknown action is not an error: {body}");
    assert!(subjects(&body).is_empty(), "nothing matches");
    assert_eq!(body["data"]["totalPages"], json!(0));
    assert_eq!(body["data"]["total"], json!(0));
}

#[test]
fn a_range_starting_after_it_ends_is_invalid_argument() {
    // Example「参数边界」：时间区间起始晚于结束 → 400 invalid_argument。
    let (base, identity, admin_id) = start();
    seed_example(&identity, &admin_id);
    let cookie = login(&base);
    let from = urlencoding((Utc::now() + Duration::days(1)).to_rfc3339());
    let to = urlencoding((Utc::now() - Duration::days(1)).to_rfc3339());
    let (status, body) = audit(&base, &cookie, &format!("?from={from}&to={to}"));
    assert_eq!(status, 400, "an inverted range is refused: {body}");
    assert_eq!(body["error"]["code"], json!("invalid_argument"));
}

#[test]
fn omitting_every_filter_returns_the_first_page_of_all_events() {
    // Example「参数边界」：全部筛选省略 → 第一页全部事件、总页数与全部事件的总笔数。
    let (base, identity, admin_id) = start();
    seed_example(&identity, &admin_id);
    let cookie = login(&base);
    let (status, body) = audit(&base, &cookie, "");
    assert_eq!(status, 200, "the unfiltered view loads: {body}");
    assert_eq!(
        subjects(&body),
        vec!["E1", "E2", "E3", "E4", "E5"],
        "every event, newest first"
    );
    assert_eq!(body["data"]["totalPages"], json!(1), "five events fit one default page");
    assert_eq!(body["data"]["total"], json!(5), "every event counts");
}

#[test]
fn keyword_source_and_range_filters_narrow_the_page() {
    let (base, identity, admin_id) = start();
    seed_example(&identity, &admin_id);
    let cookie = login(&base);
    // 关键字比对 subject 与 action——不含操作者 id（不透明 hex，短的十六进位关键字
    // 会意外命中整份纪录）。
    let (_s, body) = audit(&base, &cookie, "?q=E3");
    assert_eq!(subjects(&body), vec!["E3"], "the keyword narrows to one subject");
    let (_s, body) = audit(&base, &cookie, "?q=project-created");
    assert_eq!(subjects(&body), vec!["E2"], "the keyword also matches the action");
    // 来源：本测试全部记于 web，api 应无结果。
    let (_s, body) = audit(&base, &cookie, "?source=api");
    assert!(subjects(&body).is_empty(), "no api-source event exists");
    assert_eq!(body["data"]["totalPages"], json!(0));
    let (_s, body) = audit(&base, &cookie, "?source=web");
    assert_eq!(subjects(&body).len(), 5, "every event was recorded from web");
    // 时间区间：涵盖现在的区间拿到全部；已结束的过去区间拿不到任何事件。
    let from = urlencoding((Utc::now() - Duration::days(1)).to_rfc3339());
    let to = urlencoding((Utc::now() + Duration::days(1)).to_rfc3339());
    let (_s, body) = audit(&base, &cookie, &format!("?from={from}&to={to}"));
    assert_eq!(subjects(&body).len(), 5, "the surrounding range keeps every event");
    let old_from = urlencoding((Utc::now() - Duration::days(9)).to_rfc3339());
    let old_to = urlencoding((Utc::now() - Duration::days(8)).to_rfc3339());
    let (_s, body) = audit(&base, &cookie, &format!("?from={old_from}&to={old_to}"));
    assert!(subjects(&body).is_empty(), "a past window holds nothing");
}

#[test]
fn the_audit_view_is_camel_case_and_carries_no_secret() {
    let (base, identity, admin_id) = start();
    seed_example(&identity, &admin_id);
    let cookie = login(&base);
    let (_s, body) = audit(&base, &cookie, "");
    let first = &body["data"]["entries"][0];
    for field in ["id", "actorId", "action", "subject", "source", "createdAt"] {
        assert!(first[field].is_string(), "{field} is present (camelCase): {first}");
    }
    for field in ["totalPages", "total"] {
        assert!(body["data"][field].is_u64(), "{field} is a non-negative number: {body}");
    }
    let raw = body.to_string();
    for forbidden in ["hash", "password", "secret", "token"] {
        assert!(!raw.contains(forbidden), "the audit view must not carry `{forbidden}`: {raw}");
    }
}

/// Percent-encode the characters an RFC3339 timestamp contributes to a query.
fn urlencoding(value: String) -> String {
    value
        .replace('%', "%25")
        .replace('+', "%2B")
        .replace(':', "%3A")
}

#[test]
fn an_out_of_range_page_size_is_clamped_not_refused() {
    // 页面大小是呈现偏好而非正确性参数：0、负数与超过上限都夹到有效范围，
    // 不会落到反串行化失败（那会回一个 SPA 读不出 code 的 400）。
    let (base, identity, admin_id) = start();
    seed_example(&identity, &admin_id);
    let cookie = login(&base);
    for limit in ["0", "-3"] {
        let (status, body) = audit(&base, &cookie, &format!("?limit={limit}"));
        assert_eq!(status, 200, "limit={limit} is clamped, not refused: {body}");
        assert_eq!(subjects(&body), vec!["E1"], "clamped to one row per page");
        assert_eq!(body["data"]["totalPages"], json!(5), "five events at 1 per page");
    }
    // 超过上限：夹到上限，仍在一页内装下全部五笔。
    let (status, body) = audit(&base, &cookie, "?limit=100000");
    assert_eq!(status, 200, "an oversized page is clamped: {body}");
    assert_eq!(subjects(&body).len(), 5);
    assert_eq!(body["data"]["totalPages"], json!(1));
    assert_eq!(body["data"]["total"], json!(5), "the total ignores the page size");
}

#[test]
fn a_malformed_time_bound_is_invalid_argument() {
    let (base, identity, admin_id) = start();
    seed_example(&identity, &admin_id);
    let cookie = login(&base);
    let (status, body) = audit(&base, &cookie, "?from=not-a-date");
    assert_eq!(status, 400, "an unparseable bound is refused: {body}");
    assert_eq!(body["error"]["code"], json!("invalid_argument"));
}

#[test]
fn a_bare_date_range_covers_that_whole_day() {
    // `from` 读为当日起点、`to` 读为当日终点——同一天的区间要包含那天的事件。
    let (base, identity, admin_id) = start();
    seed_example(&identity, &admin_id);
    let cookie = login(&base);
    let today = Utc::now().format("%Y-%m-%d").to_string();
    let (status, body) = audit(&base, &cookie, &format!("?from={today}&to={today}"));
    assert_eq!(status, 200, "a same-day range is valid: {body}");
    assert_eq!(subjects(&body).len(), 5, "today's events are inside today");
}

#[test]
fn a_keyword_of_sql_wildcards_matches_them_literally() {
    // LIKE 的通配符经跳脱：搜索 `%` 不该把整份纪录都捞回来。
    let (base, identity, admin_id) = start();
    seed_example(&identity, &admin_id);
    let cookie = login(&base);
    let (status, body) = audit(&base, &cookie, "?q=%25");
    assert_eq!(status, 200, "a wildcard keyword is a literal search: {body}");
    assert!(subjects(&body).is_empty(), "no subject contains a literal %");
    assert_eq!(body["data"]["totalPages"], json!(0));
}
