//! 合并后的系统 view model（server-admin「管理 browser API 提供最小且完整的页面
//! view model」）。`/admin/data` 与 `/admin/system` 两份 view model 并为一份：单次
//! 回应同时给运行环境版本、保存状态与待送队列、可导出范围清单与迁移可用性，SPA 不再
//! 为其中任何一组打第二支 API。既有字段名称一律不重命名，新字段以 camelCase 输出。

use crate::common;

use chrono::{Duration, Utc};
use serde_json::{json, Value};
use specseal_server::identity::{IdentitySqlite, IdentityStore, NewInvitation};
use specseal_server::state::{AppState, SharedStore};
use specseal_store::memory::MemoryStore;
use specseal_store::{
    CommandContext, DocumentId, FaultPoint, ProjectId, RepoId, Scope, TeamStore,
};
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

fn start_over(store: SharedStore) -> String {
    let identity = Arc::new(IdentitySqlite::open_memory().expect("identity"));
    common::seed_demo_registry(&*identity);
    seed_user(&identity, "admin@example.com", true);
    let state = AppState::new(
        store,
        identity,
        Arc::new(common::demo_config()),
        common::detached_events(),
    );
    common::start(state)
}

fn start_healthy() -> String {
    start_over(Arc::new(MemoryStore::new()))
}

/// A store whose `health()` reports an error while identity stays readable.
fn start_crashed() -> String {
    let store = MemoryStore::new();
    store.crash_at(FaultPoint::AfterDocWrites);
    let scope = Scope::new(ProjectId::new("demo"), RepoId::new("backend"));
    let ctx = CommandContext { command: "crash".into(), actor: "seed".into() };
    let mut uow = store.begin_unit_of_work(&scope, ctx).expect("uow");
    uow.create(DocumentId::WorkflowConfig, "cfg");
    let _ = store.commit(uow, Vec::new());
    assert!(store.health().is_err(), "the store is unhealthy after the crash");
    start_over(Arc::new(store))
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

fn get(base: &str, path: &str, cookie: &str) -> (u16, Value) {
    let result = agent()
        .get(&format!("{base}{path}"))
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

#[test]
fn the_system_view_carries_all_four_groups_in_one_response() {
    let base = start_healthy();
    let cookie = login(&base);
    let (status, body) = get(&base, "/api/specseal/v1/web/admin/system", &cookie);
    assert_eq!(status, 200, "the system view loads: {body}");
    let data = &body["data"];

    // 1. 运行环境：引擎与 API 版本、识别数据结构版本（既有字段名称不变）。
    assert!(data["engineVersion"].is_string(), "engineVersion: {data}");
    assert!(data["apiVersion"].is_string(), "apiVersion: {data}");
    assert!(data["identitySchemaVersion"].is_number(), "identitySchemaVersion: {data}");

    // 2. 保存状态：驱动、契约版本、等级、能力、健康（既有字段名称不变）。
    assert!(data["storeDriver"].is_string(), "storeDriver: {data}");
    assert!(data["storeContractVersion"].is_number(), "storeContractVersion: {data}");
    assert!(data["storeLevel"].is_string(), "storeLevel: {data}");
    assert!(data["storeCapabilities"].is_array(), "storeCapabilities: {data}");
    assert_eq!(data["storeHealthy"], json!(true), "storeHealthy: {data}");

    // 3. 待送队列（既有字段名称不变）。
    let backlogs = data["outboxBacklogs"].as_array().expect("outboxBacklogs array");
    assert_eq!(backlogs[0]["project"], json!("demo"));
    assert_eq!(backlogs[0]["repo"], json!("backend"));
    assert!(backlogs[0]["backlog"].is_number());

    // 4. 原「数据操作」并入的两组：可导出范围清单与迁移可用性。
    let scopes = data["scopes"].as_array().expect("scopes array");
    assert_eq!(scopes[0]["project"], json!("demo"));
    assert_eq!(scopes[0]["repo"], json!("backend"));
    assert_eq!(
        scopes[0]["exportPath"],
        json!("/admin/data/export/demo/backend"),
        "the export download path is unchanged"
    );
    assert_eq!(data["migrateAvailable"], json!(true), "a healthy store can migrate");
}

#[test]
fn the_standalone_data_view_model_is_gone() {
    let base = start_healthy();
    let cookie = login(&base);
    let (status, _body) = get(&base, "/api/specseal/v1/web/admin/data", &cookie);
    assert_eq!(status, 404, "the data view model no longer exists");
}

#[test]
fn an_unhealthy_store_degrades_the_system_view_without_failing_it() {
    let base = start_crashed();
    let cookie = login(&base);
    let (status, body) = get(&base, "/api/specseal/v1/web/admin/system", &cookie);
    assert_eq!(status, 200, "a store failure degrades rather than 500s: {body}");
    let data = &body["data"];
    assert_eq!(data["storeHealthy"], json!(false));
    assert!(data["storeHealthError"].is_string(), "with a public error");
    assert_eq!(
        data["migrateAvailable"],
        json!(false),
        "an unhealthy store is not offered a migration"
    );
    // 识别侧数据仍可读，范围清单来自 registry。
    assert!(data["identitySchemaVersion"].is_number());
    assert!(!data["scopes"].as_array().expect("scopes").is_empty());
}

#[test]
fn the_system_view_carries_no_secret() {
    let base = start_healthy();
    let cookie = login(&base);
    let (_s, body) = get(&base, "/api/specseal/v1/web/admin/system", &cookie);
    let raw = body.to_string();
    for forbidden in ["hash", "password", "secret", "token", "refresh"] {
        assert!(!raw.contains(forbidden), "the system view must not carry `{forbidden}`: {raw}");
    }
}

#[test]
fn the_export_download_still_works_after_the_merge() {
    // 合并的是 view model，不是导出下载端点——旧路径仍要能下载。
    let base = start_healthy();
    let cookie = login(&base);
    let resp = agent()
        .get(&format!("{base}/admin/data/export/demo/backend"))
        .set("Cookie", &format!("specseal_session={cookie}"))
        .call()
        .expect("export download");
    assert_eq!(resp.status(), 200, "the scope export bundle still downloads");
}
