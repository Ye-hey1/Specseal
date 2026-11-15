//! remote runtime 的 token 生命周期契约（design 决策 4「token 生命周期与 401
//! 语意」；规格「token 换发全程 Rust 侧且 401 语意固定」）。
//!
//! in-process specseal-server（memory identity＋seeded change）＋in-memory
//! CredentialStore：TokenManager 请求前自动换发、401 → refresh 一次 → 重试
//! 一次、rotation 新 refresh credential 回写、refresh 亦失效 → needs-reauth
//! 状态且后续操作回拒绝错误。token 只存在 Rust——测试面没有任何 secret 出境
//! 断言对象。

use crate::common;

use crate::common::Harness;
use specseal_desktop_lib::connections::pat_login;
use specseal_remote::credentials::{CredentialKind, CredentialStore, MemoryCredentialStore};
use specseal_desktop_lib::remote::{
    ConnectionState, ConnectionStateEvent, RemoteWorkspace, TokenManager,
    REMOTE_CONNECTION_STATE_EVENT,
};
use specseal_remote::client::Client;
use specseal_remote::RemoteError;
use specseal_server::identity::IdentityStore;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, Condvar, Mutex};
use std::time::Duration;

/// 让前两个 refresh 读取都先取得同一份旧值再放行。修正后只有 singleflight
/// leader 会读取 refresh，因此第一个读取会在短暂 timeout 后自行前进，不会死锁。
struct RacingCredentialStore {
    inner: MemoryCredentialStore,
    armed: AtomicBool,
    refresh_readers: Mutex<HashSet<std::thread::ThreadId>>,
    arrived: Mutex<usize>,
    release: Condvar,
}

impl RacingCredentialStore {
    fn new() -> Self {
        Self {
            inner: MemoryCredentialStore::new(),
            armed: AtomicBool::new(false),
            refresh_readers: Mutex::new(HashSet::new()),
            arrived: Mutex::new(0),
            release: Condvar::new(),
        }
    }

    fn arm(&self) {
        self.refresh_readers.lock().expect("reader lock").clear();
        *self.arrived.lock().expect("arrival lock") = 0;
        self.armed.store(true, Ordering::SeqCst);
    }

    fn disarm(&self) {
        self.armed.store(false, Ordering::SeqCst);
        self.release.notify_all();
    }

    fn refresh_readers(&self) -> usize {
        self.refresh_readers.lock().expect("reader lock").len()
    }
}

impl CredentialStore for RacingCredentialStore {
    fn get(&self, origin: &str, kind: CredentialKind) -> Result<Option<String>, String> {
        let value = self.inner.get(origin, kind)?;
        if kind == CredentialKind::Refresh && self.armed.load(Ordering::SeqCst) {
            self.refresh_readers
                .lock()
                .expect("reader lock")
                .insert(std::thread::current().id());
            let mut arrived = self.arrived.lock().expect("arrival lock");
            *arrived += 1;
            if *arrived >= 2 {
                self.release.notify_all();
            } else {
                let (next, _) = self
                    .release
                    .wait_timeout_while(arrived, Duration::from_millis(250), |count| *count < 2)
                    .expect("refresh read gate");
                arrived = next;
            }
            drop(arrived);
        }
        Ok(value)
    }

    fn set(&self, origin: &str, kind: CredentialKind, secret: &str) -> Result<(), String> {
        self.inner.set(origin, kind, secret)
    }

    fn delete(&self, origin: &str, kind: CredentialKind) -> Result<(), String> {
        self.inner.delete(origin, kind)
    }
}

struct UnavailableCredentialStore {
    reads: AtomicUsize,
}

impl UnavailableCredentialStore {
    fn new() -> Self {
        Self {
            reads: AtomicUsize::new(0),
        }
    }
}

impl CredentialStore for UnavailableCredentialStore {
    fn get(&self, _origin: &str, _kind: CredentialKind) -> Result<Option<String>, String> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        Err("Keychain 暂时不可用".to_string())
    }

    fn set(&self, _origin: &str, _kind: CredentialKind, _secret: &str) -> Result<(), String> {
        Err("Keychain 暂时不可用".to_string())
    }

    fn delete(&self, _origin: &str, _kind: CredentialKind) -> Result<(), String> {
        Err("Keychain 暂时不可用".to_string())
    }
}

fn harness() -> Harness {
    let h = common::harness();
    common::seed_change(h.store.as_ref(), "- [ ] 1.1 First\n- [ ] 1.2 Second\n");
    h
}

/// 对 in-process server 的 demo project 逐请求建构 client（决策 4 的消费形状）。
fn fetch_tasks(h: &Harness, token: &str) -> Result<String, RemoteError> {
    let client = Client::new(
        &format!("{}/api/specseal/v1/projects/demo", h.origin),
        token,
        Some("backend"),
    );
    client
        .get_artifact("demo", "tasks")
        .map(|artifact| artifact.content)
}

fn state_sink() -> (
    impl Fn(ConnectionStateEvent) + Send + Sync + 'static,
    std::sync::mpsc::Receiver<ConnectionStateEvent>,
) {
    let (tx, rx) = std::sync::mpsc::channel();
    (
        move |event| {
            let _ = tx.send(event);
        },
        rx,
    )
}

// --- per-connection 脱机状态机与事件 payload ---

#[test]
fn consecutive_transport_failures_go_offline_and_one_success_returns_online() {
    let (notify, rx) = state_sink();
    let manager = TokenManager::with_connection_state("http://server.test", "conn_x", 2, notify);
    manager.adopt_access_token("pat");
    let store = MemoryCredentialStore::new();

    let fail = || -> Result<(), RemoteError> { Err(specseal_remote::translate_transport()) };
    manager
        .execute(&store, |_| fail())
        .expect_err("第一次传输失败");
    assert!(
        rx.recv_timeout(Duration::from_millis(50)).is_err(),
        "未达阈值不得提早广播 offline"
    );
    manager
        .execute(&store, |_| fail())
        .expect_err("第二次传输失败");
    let offline = rx
        .recv_timeout(Duration::from_secs(1))
        .expect("达阈值广播 offline");
    assert_eq!(REMOTE_CONNECTION_STATE_EVENT, "remote-connection-state");
    assert_eq!(offline.connection_id, "conn_x");
    assert_eq!(offline.state, ConnectionState::Offline);
    assert!(offline
        .message
        .as_deref()
        .unwrap_or_default()
        .contains("脱机"));
    assert_eq!(manager.connection_state(), ConnectionState::Offline);

    manager.execute(&store, |_| Ok(())).expect("一次成功即恢复");
    let online = rx
        .recv_timeout(Duration::from_secs(1))
        .expect("恢复广播 online");
    assert_eq!(online.state, ConnectionState::Online);
    assert_eq!(manager.connection_state(), ConnectionState::Online);

    // 成功已把 failure count 归零；再失败一次仍不得立即 offline。
    manager
        .execute(&store, |_| fail())
        .expect_err("成功后第一次失败");
    assert!(
        rx.recv_timeout(Duration::from_millis(50)).is_err(),
        "成功后 failure count 从零重算"
    );
}

#[test]
fn needs_reauth_is_broadcast_and_wins_over_an_existing_offline_state() {
    let (notify, rx) = state_sink();
    let manager = TokenManager::with_connection_state("http://server.test", "conn_x", 1, notify);
    let store = MemoryCredentialStore::new();
    store
        .set("http://server.test", CredentialKind::Pat, "spk_pat_dead")
        .expect("set PAT");
    manager.adopt_access_token("spk_pat_dead");

    manager
        .execute(&store, |_| -> Result<(), RemoteError> {
            Err(specseal_remote::translate_transport())
        })
        .expect_err("传输失败使状态 offline");
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(1))
            .expect("offline event")
            .state,
        ConnectionState::Offline
    );

    manager
        .execute(&store, |_| -> Result<(), RemoteError> {
            Err(RemoteError {
                message: "unauthorized".into(),
                reason: Some("permission_denied".into()),
                status: Some(401),
                evidence: None,
            })
        })
        .expect_err("两次 401 进 needs-reauth");
    let reauth = rx
        .recv_timeout(Duration::from_secs(1))
        .expect("needs-reauth event");
    assert_eq!(reauth.state, ConnectionState::NeedsReauth);
    assert!(reauth
        .message
        .as_deref()
        .unwrap_or_default()
        .contains("重新登录"));
    assert_eq!(manager.connection_state(), ConnectionState::NeedsReauth);

    manager
        .execute(&store, |_| -> Result<(), RemoteError> {
            panic!("needs-reauth 时不得打 server")
        })
        .expect_err("needs-reauth 后立即拒绝");
    assert_eq!(manager.connection_state(), ConnectionState::NeedsReauth);
}

#[test]
fn offline_writes_are_rejected_without_queueing_while_reads_can_recover_in_place() {
    let h = harness();
    let store = MemoryCredentialStore::new();
    let pat = common::pat_of(&h);
    store
        .set(&h.origin, CredentialKind::Pat, &pat)
        .expect("set PAT");
    let manager = Arc::new(TokenManager::with_connection_state(
        &h.origin,
        "conn_x",
        1,
        |_| {},
    ));
    manager.adopt_access_token(&pat);
    let workspace = RemoteWorkspace::at(&h.origin, "demo", "backend", &manager);
    assert_eq!(
        workspace
            .list_changes(&store, None)
            .expect("baseline read")
            .changes
            .len(),
        1
    );

    h.server.stop();
    workspace
        .list_changes(&store, None)
        .expect_err("server 停止后读取失败并使 runtime offline");
    assert_eq!(manager.connection_state(), ConnectionState::Offline);

    let rejected = workspace
        .set_task_done(&store, "demo", "1", true)
        .expect_err("offline 写入立即拒绝");
    assert_eq!(rejected.reason.as_deref(), Some("offline"));
    assert!(rejected.message.contains("脱机"));

    h.server.start();
    let mut recovered = None;
    for _ in 0..20 {
        match workspace.list_changes(&store, None) {
            Ok(changes) => {
                recovered = Some(changes);
                break;
            }
            Err(_) => std::thread::sleep(Duration::from_millis(10)),
        }
    }
    assert!(
        recovered.is_some(),
        "offline 期间的读取路径仍放行，server 回来即可原地恢复"
    );
    assert_eq!(manager.connection_state(), ConnectionState::Online);
    let tasks = workspace
        .document(&store, "demo", "tasks.md")
        .expect("server 恢复后读取 tasks")
        .content;
    assert!(
        tasks.contains("- [ ] 1.1 First"),
        "脱机写入未排队、未于恢复后重放：{tasks}"
    );
}

// --- 请求前自动换发＋rotation 回写 ---

#[test]
fn a_request_with_no_access_token_refreshes_first_and_rotates_the_credential() {
    let h = harness();
    let store = MemoryCredentialStore::new();
    common::device_login_approved(&h, &store);
    let rt_before = store
        .get(&h.origin, CredentialKind::Refresh)
        .expect("get")
        .expect("credential");

    // 「重启后」：内存没有 access token——execute 请求前先以 refresh credential 换发。
    let manager = TokenManager::new(&h.origin);
    let content = manager
        .execute(&store, |token| fetch_tasks(&h, token))
        .expect("查找经自动换发后成功");
    assert!(content.contains("- [ ] 1.1"), "查找回真值：{content}");
    assert!(
        manager.needs_reauth().is_none(),
        "成功路径不进 needs-reauth"
    );

    // rotation 后的新 refresh credential 立即回写（规格「access token 过期自动换发」）。
    let rt_after = store
        .get(&h.origin, CredentialKind::Refresh)
        .expect("get")
        .expect("credential");
    assert_ne!(
        rt_after, rt_before,
        "rotation 新 refresh credential 回写 store"
    );
}

#[test]
fn concurrent_requests_without_a_bearer_share_one_refresh_rotation() {
    let h = harness();
    let store = Arc::new(RacingCredentialStore::new());
    common::device_login_approved(&h, store.as_ref());
    store.arm();

    let (notify, rx) = state_sink();
    let manager = Arc::new(TokenManager::with_connection_state(
        &h.origin, "conn_x", 1, notify,
    ));
    let start = Arc::new(Barrier::new(3));
    let mut threads = Vec::new();
    for _ in 0..2 {
        let manager = manager.clone();
        let store = store.clone();
        let start = start.clone();
        threads.push(std::thread::spawn(move || {
            start.wait();
            manager.execute(store.as_ref(), |_| Ok::<_, RemoteError>(()))
        }));
    }
    start.wait();

    let results = threads
        .into_iter()
        .map(|thread| thread.join().expect("request thread"))
        .collect::<Vec<_>>();
    store.disarm();

    assert!(
        results.iter().all(Result::is_ok),
        "两个 caller 都应共用成功 rotation：{results:?}"
    );
    assert_eq!(
        store.refresh_readers(),
        1,
        "同一枚 refresh credential 只能由 singleflight leader thread 读取"
    );
    assert!(manager.needs_reauth().is_none(), "不得误入 needs-reauth");
    assert!(
        rx.try_iter()
            .all(|event| event.state != ConnectionState::NeedsReauth),
        "不得广播 needs-reauth"
    );

    TokenManager::new(&h.origin)
        .execute(store.as_ref(), |_| Ok::<_, RemoteError>(()))
        .expect("latest refresh credential 仍可再次轮替，family 未被撤销");
}

// --- 401 → refresh 一次 → 重试一次成功 ---

#[test]
fn a_401_refreshes_once_and_retries_once_successfully() {
    let h = harness();
    let store = MemoryCredentialStore::new();
    common::device_login_approved(&h, &store);

    // 过期／失效的 access token 在缓存里（adopt＝登录流程交接 token 的同一入口）。
    let manager = TokenManager::new(&h.origin);
    manager.adopt_access_token("spk_at_expired_bogus");

    let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    let harness_ref = &h;
    let content = manager
        .execute(&store, move |token| {
            sink.lock().unwrap().push(token.to_string());
            fetch_tasks(harness_ref, token)
        })
        .expect("401 经 refresh 一次、重试一次后成功——用户无感");
    assert!(content.contains("- [ ] 1.1"));

    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 2, "恰好一次重试：{seen:?}");
    assert_eq!(seen[0], "spk_at_expired_bogus", "第一击带着过期 token");
    assert_ne!(seen[1], "spk_at_expired_bogus", "重试带着换发后的新 token");
}

#[test]
fn concurrent_401_responses_share_the_new_bearer_without_replaying_refresh() {
    const EXPIRED: &str = "spk_at_expired_bogus";

    let h = harness();
    let store = Arc::new(RacingCredentialStore::new());
    common::device_login_approved(&h, store.as_ref());
    store.arm();

    let (notify, rx) = state_sink();
    let manager = Arc::new(TokenManager::with_connection_state(
        &h.origin, "conn_x", 1, notify,
    ));
    manager.adopt_access_token(EXPIRED);
    let start = Arc::new(Barrier::new(3));
    let rejected = Arc::new(Barrier::new(2));
    let mut threads = Vec::new();
    for _ in 0..2 {
        let manager = manager.clone();
        let store = store.clone();
        let start = start.clone();
        let rejected = rejected.clone();
        threads.push(std::thread::spawn(move || {
            start.wait();
            manager.execute(store.as_ref(), |token| {
                if token == EXPIRED {
                    rejected.wait();
                    Err(RemoteError {
                        message: "unauthorized".into(),
                        reason: Some("permission_denied".into()),
                        status: Some(401),
                        evidence: None,
                    })
                } else {
                    Ok(token.to_string())
                }
            })
        }));
    }
    start.wait();

    let results = threads
        .into_iter()
        .map(|thread| thread.join().expect("request thread"))
        .collect::<Vec<_>>();
    store.disarm();

    assert!(
        results.iter().all(Result::is_ok),
        "两个 401 caller 都应以同一枚新 bearer 重试成功：{results:?}"
    );
    let first = results[0].as_ref().expect("first caller bearer");
    let second = results[1].as_ref().expect("second caller bearer");
    assert_eq!(first, second, "等待者共用 leader 发布的新 bearer");
    assert_eq!(
        store.refresh_readers(),
        1,
        "401 竞态只允许 singleflight leader thread 进入 rotation"
    );
    assert!(manager.needs_reauth().is_none(), "不得误入 needs-reauth");
    assert!(
        rx.try_iter()
            .all(|event| event.state != ConnectionState::NeedsReauth),
        "不得广播 needs-reauth"
    );
}

// --- refresh 亦失效 → needs-reauth＋后续操作回拒绝 ---

#[test]
fn a_dead_refresh_credential_flags_needs_reauth_and_rejects_further_operations() {
    let h = harness();
    let store = MemoryCredentialStore::new();
    // 只有一枚已死（未经核发）的 refresh credential——server 会明确拒绝 rotation。
    store
        .set(&h.origin, CredentialKind::Refresh, "spk_rt_dead")
        .expect("set");

    let manager = TokenManager::new(&h.origin);
    let err = manager
        .execute(&store, |_token| -> Result<String, RemoteError> {
            panic!("refresh 被拒后不得再打数据面请求")
        })
        .expect_err("refresh 亦失效即失败");
    assert!(
        err.message.contains("重新登录"),
        "繁中消息指向重新登录：{}",
        err.message
    );

    let state = manager.needs_reauth().expect("连接进入 needs-reauth 状态");
    assert!(
        state.contains("重新登录"),
        "TS 可见的是繁中状态消息：{state}"
    );

    // 后续操作直接回拒绝错误，不再打 server、不再碰 credential。
    let err = manager
        .execute(&store, |_token| -> Result<String, RemoteError> {
            panic!("needs-reauth 后的操作不得触发任何请求")
        })
        .expect_err("后续操作回拒绝错误");
    assert!(
        err.message.contains("重新登录"),
        "拒绝错误同样是繁中：{}",
        err.message
    );
}

#[test]
fn a_revoked_device_family_still_flags_needs_reauth_once() {
    let h = harness();
    let store = MemoryCredentialStore::new();
    common::device_login_approved(&h, &store);
    let family = h
        .identity
        .list_device_families(&h.user_id)
        .expect("list device families")
        .into_iter()
        .find(|family| family.revoked_at.is_none())
        .expect("live device family");
    h.identity
        .revoke_family(&h.user_id, &family.id)
        .expect("revoke device family");

    let (notify, rx) = state_sink();
    let manager = TokenManager::with_connection_state(&h.origin, "conn_x", 1, notify);
    let error = manager
        .execute(&store, |_token| -> Result<(), RemoteError> {
            panic!("revoked refresh 不得进数据面")
        })
        .expect_err("revoked family 必须要求重新登录");
    assert_eq!(error.reason.as_deref(), Some("needs_reauth"));
    assert_eq!(manager.connection_state(), ConnectionState::NeedsReauth);
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(1))
            .expect("needs-reauth event")
            .state,
        ConnectionState::NeedsReauth
    );

    manager
        .execute(&store, |_token| -> Result<(), RemoteError> {
            panic!("needs-reauth 后不得重试 revoked refresh")
        })
        .expect_err("后续操作立即拒绝");
    assert!(
        rx.recv_timeout(Duration::from_millis(50)).is_err(),
        "相同状态不得重复广播"
    );
}

#[test]
fn a_temporary_credential_store_failure_remains_retryable_without_reauth() {
    let store = UnavailableCredentialStore::new();
    let manager = TokenManager::new("http://server.test");

    for expected_reads in 1..=2 {
        let error = manager
            .execute(&store, |_token| -> Result<(), RemoteError> {
                panic!("credential 读取失败不得进数据面")
            })
            .expect_err("暂时性 Keychain 失败原样回传");
        assert_eq!(error.message, "Keychain 暂时不可用");
        assert_eq!(error.reason, None);
        assert_eq!(error.status, None);
        assert_eq!(
            store.reads.load(Ordering::SeqCst),
            expected_reads,
            "下一个操作仍会重试 credential store"
        );
        assert!(manager.needs_reauth().is_none());
        assert_eq!(manager.connection_state(), ConnectionState::Online);
    }
}

// --- PAT 连接：PAT 即 bearer、无 rotation ---

#[test]
fn a_pat_connection_uses_the_pat_as_bearer_without_rotation() {
    let h = harness();
    let store = MemoryCredentialStore::new();
    let pat = common::pat_of(&h);
    pat_login(&h.origin, &pat, &store, &h.registry).expect("pat login");

    let manager = TokenManager::new(&h.origin);
    let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    let harness_ref = &h;
    let content = manager
        .execute(&store, move |token| {
            sink.lock().unwrap().push(token.to_string());
            fetch_tasks(harness_ref, token)
        })
        .expect("PAT 连接的查找成功");
    assert!(content.contains("- [ ] 1.1"));
    assert_eq!(
        seen.lock().unwrap().as_slice(),
        &[pat.clone()],
        "PAT 本身就是 bearer"
    );
    assert_eq!(
        store.get(&h.origin, CredentialKind::Refresh).expect("get"),
        None,
        "PAT 连接没有 refresh credential、无 rotation"
    );
}
