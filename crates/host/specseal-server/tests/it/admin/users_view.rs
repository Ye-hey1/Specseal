//! 用户 view model 的待激活邀请（server-web-console「总览提供可行动入口与待办」的
//! 落点）：受邀者在接受邀请前没有 user row，却是管理员需要看见的对象——总览的「待激活」
//! 指针正是连往这一页。view model 因此在用户清单之外另附一份待激活邀请清单。
//!
//! 秘密边界不变：回应带邀请的 email、显示名称、角色、成员资格与时间，绝不带 token 或
//! 其 hash。

use crate::common;

use chrono::{Duration, Utc};
use serde_json::{json, Value};
use specseal_server::identity::{AuditFilter, IdentitySqlite, IdentityStore, NewInvitation};
use specseal_server::state::AppState;
use specseal_store::memory::MemoryStore;
use std::sync::Arc;

const PASSWORD: &str = "pw-correct-horse";

fn invite(identity: &Arc<IdentitySqlite>, email: &str, admin: bool, days: i64) -> String {
    identity
        .create_invitation(NewInvitation {
            email: email.to_string(),
            display: format!("Invited {email}"),
            memberships: vec!["demo".to_string()],
            admin,
            expires_at: Utc::now() + Duration::days(days),
        })
        .expect("invite")
}

fn start() -> (String, Arc<IdentitySqlite>, String) {
    let identity = Arc::new(IdentitySqlite::open_memory().expect("identity"));
    common::seed_demo_registry(&*identity);
    let token = invite(&identity, "admin@example.com", true, 1);
    identity.accept_invitation(&token, PASSWORD).expect("accept");
    let state = AppState::new(
        Arc::new(MemoryStore::new()),
        identity.clone(),
        Arc::new(common::demo_config()),
        common::detached_events(),
    );
    let base = common::start(state);
    let cookie = login(&base);
    (base, identity, cookie)
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

fn revoke_invitation(base: &str, cookie: &str, id: &str) -> u16 {
    agent()
        .post(&format!(
            "{base}/api/specseal/v1/web/admin/users/invitations/{id}/revoke"
        ))
        .set("Origin", "http://127.0.0.1")
        .set("Cookie", &format!("specseal_session={cookie}"))
        .call()
        .map(|r| r.status())
        .unwrap_or_else(|e| match e {
            ureq::Error::Status(code, _) => code,
            other => panic!("revoke: {other}"),
        })
}

/// The users view model as raw text, so secret-exclusion assertions see the wire bytes.
fn users_text(base: &str, cookie: &str) -> String {
    agent()
        .get(&format!("{base}/api/specseal/v1/web/admin/users"))
        .set("Cookie", &format!("specseal_session={cookie}"))
        .call()
        .expect("users")
        .into_string()
        .expect("body")
}

fn users(base: &str, cookie: &str) -> Value {
    serde_json::from_str(&users_text(base, cookie)).expect("json")
}

#[test]
fn pending_invitations_appear_in_the_users_view() {
    let (base, identity, cookie) = start();
    invite(&identity, "invited@example.com", false, 1);

    let body = users(&base, &cookie);
    let pending = body["data"]["pending"]
        .as_array()
        .expect("pending is an array");
    assert_eq!(pending.len(), 1, "刚创建的邀请要出现在待激活清单");

    let row = &pending[0];
    assert_eq!(row["email"], "invited@example.com");
    assert_eq!(row["display"], "Invited invited@example.com");
    assert_eq!(row["admin"], false);
    assert_eq!(row["memberships"], serde_json::json!(["demo"]));
    assert!(row["createdAt"].as_str().is_some(), "createdAt 为 RFC3339 字符串");
    assert!(row["expiresAt"].as_str().is_some(), "expiresAt 为 RFC3339 字符串");
}

#[test]
fn accepted_invitations_leave_the_pending_list_and_become_users() {
    let (base, identity, cookie) = start();
    let token = invite(&identity, "invited@example.com", false, 1);
    identity.accept_invitation(&token, PASSWORD).expect("accept");

    let body = users(&base, &cookie);
    assert!(
        body["data"]["pending"].as_array().expect("pending").is_empty(),
        "已接受的邀请不再是待激活"
    );
    let users = body["data"]["users"].as_array().expect("users");
    assert!(
        users.iter().any(|u| u["email"] == "invited@example.com"),
        "接受后成为正式用户"
    );
}

#[test]
fn expired_invitations_are_not_pending() {
    let (base, identity, cookie) = start();
    invite(&identity, "stale@example.com", false, -1);

    let body = users(&base, &cookie);
    assert!(
        body["data"]["pending"].as_array().expect("pending").is_empty(),
        "过期的邀请没有任何动作可清除，不列为待激活"
    );
}

#[test]
fn pending_invitations_never_expose_the_token() {
    let (base, identity, cookie) = start();
    let token = invite(&identity, "invited@example.com", false, 1);

    let raw = users_text(&base, &cookie);
    assert!(!raw.contains(&token), "回应不得带邀请 token");
    assert!(!raw.contains("tokenHash"), "回应不得带 token hash");
}

#[test]
fn revoking_a_pending_invitation_removes_it_and_kills_the_token() {
    let (base, identity, cookie) = start();
    let token = invite(&identity, "invited@example.com", false, 1);
    let id = users(&base, &cookie)["data"]["pending"][0]["id"]
        .as_str()
        .expect("pending id")
        .to_string();

    assert_eq!(revoke_invitation(&base, &cookie, &id), 200);

    let body = users(&base, &cookie);
    assert!(
        body["data"]["pending"].as_array().expect("pending").is_empty(),
        "取消后不再是待激活"
    );
    // 取消的重点是链接立刻失效——受邀者手上那份链接不能还能建帐号。
    assert!(
        identity.find_valid_invitation(&token).expect("lookup").is_none(),
        "取消后 token 不再有效"
    );
    assert!(
        identity.accept_invitation(&token, PASSWORD).is_err(),
        "取消后不得再以该 token 创建帐号"
    );
}

#[test]
fn revoking_writes_an_audit_event_naming_the_invitee() {
    let (base, identity, cookie) = start();
    invite(&identity, "invited@example.com", false, 1);
    let id = users(&base, &cookie)["data"]["pending"][0]["id"]
        .as_str()
        .expect("pending id")
        .to_string();

    revoke_invitation(&base, &cookie, &id);

    let entries = identity
        .query_audit(&AuditFilter {
            keyword: None,
            action: Some("invitation-revoked".to_string()),
            source: None,
            from: None,
            to: None,
            page: 1,
            per_page: 10,
        })
        .expect("audit");
    assert_eq!(entries.entries.len(), 1, "取消邀请要留下稽核事件");
    assert_eq!(entries.entries[0].subject, "invited@example.com");
}

#[test]
fn revoking_an_unknown_or_accepted_invitation_is_not_found() {
    let (base, identity, cookie) = start();
    assert_eq!(revoke_invitation(&base, &cookie, "no-such-id"), 404);

    let token = invite(&identity, "invited@example.com", false, 1);
    let id = users(&base, &cookie)["data"]["pending"][0]["id"]
        .as_str()
        .expect("pending id")
        .to_string();
    identity.accept_invitation(&token, PASSWORD).expect("accept");
    // 已接受的邀请不能「取消」：帐号已经存在，该走停权而不是回收邀请。
    assert_eq!(revoke_invitation(&base, &cookie, &id), 404);
}
