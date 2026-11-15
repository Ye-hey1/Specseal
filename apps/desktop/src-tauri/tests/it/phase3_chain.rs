//! Phase 3 收官验收：desktop remote 数据面、真实 CLI 与两个隔离 server 的
//! 单一连续剧本（phase3-acceptance spec）。

use crate::common;

use specseal_remote::credentials::{CredentialKind, CredentialStore, MemoryCredentialStore};
use specseal_desktop_lib::event_manager::EventManager;
use specseal_desktop_lib::remote::{self, ConnectionState, TokenManager};
use specseal_remote::events;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, Condvar, Mutex};
use std::time::Duration;

const TASKS: &str = "## 1. Work\n\n- [ ] 1.1 First\n";
const RD_TASKS: &str = "## 1. RD Work\n\n- [ ] 1.1 Reflect through PM\n";
const RD_PROPOSAL: &str =
    "## Why\n\nRD checkout 验证 CLI 与 desktop 数据面互通。\n\n## What Changes\n\n- 完成 RD 任务。\n";

/// 让竞态中的 refresh 读取先取得同一份旧值。singleflight 正常时只有 leader
/// 会进入此 gate，短暂 timeout 后即可自行前进；破坏互斥时两个 caller 会同时抵达。
struct ReconnectCredentialStore {
    inner: MemoryCredentialStore,
    armed: AtomicBool,
    refresh_readers: Mutex<HashSet<std::thread::ThreadId>>,
    arrived: Mutex<usize>,
    release: Condvar,
}

impl ReconnectCredentialStore {
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

impl CredentialStore for ReconnectCredentialStore {
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

#[test]
fn phase3_helpers_start_two_isolated_servers_and_drive_the_real_cli() {
    let h = common::phase3_harness();
    h.first.seed_change("pm", "chain-seed", TASKS);

    let checkout = h
        .first
        .remote_checkout("pm", &h.first.editor_pat, "helper-smoke");
    let output = checkout.run(&["list", "--json"]);

    assert!(
        output.status.success(),
        "CLI list 成功：{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("chain-seed"),
        "CLI 读到第一个 server 的 change"
    );
    assert_ne!(
        h.first.store_path, h.second.store_path,
        "两个 server 使用独立 SQLite"
    );
    assert!(h.second.is_ready(), "第二个 server 同时常驻");

    let credentials = MemoryCredentialStore::new();
    h.first.device_login_editor(&credentials);
    let refresh = credentials
        .get(&h.first.origin, CredentialKind::Refresh)
        .expect("read refresh credential")
        .expect("device login stored refresh credential");
    h.first.revoke_editor_device_family();
    assert!(
        specseal_remote::device::refresh(&h.first.origin, &refresh).is_err(),
        "撤销 device family 后 refresh credential 立即失效"
    );
}

#[test]
fn scenario_failures_include_the_name_both_server_tails_and_connection_states() {
    let h = common::phase3_harness();
    let states = [("first", "online"), ("second", "online")];
    let failure = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        common::scenario_assert!(&h, "多 tab", &states, false, "刻意失败以验证诊断形状");
    }))
    .expect_err("scenario assertion deliberately fails");
    let message = failure
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| {
            failure
                .downcast_ref::<&str>()
                .map(|text| (*text).to_string())
        })
        .expect("panic message");

    assert!(message.starts_with("[多 tab]"), "情境名是第一段：{message}");
    for section in [
        "first server output tail",
        "second server output tail",
        "connection states",
        "first=online",
        "second=online",
    ] {
        assert!(
            message.contains(section),
            "失败现场包含 {section}: {message}"
        );
    }
}

#[test]
fn failure_diagnostics_can_be_materialized_for_ci_upload() {
    let h = common::phase3_harness();
    let artifacts = tempfile::tempdir().expect("phase3 CI artifact tempdir");
    h.write_failure_artifacts(
        artifacts.path(),
        &[("first", "offline"), ("second", "online")],
    )
    .expect("write phase3 failure artifacts");

    for (name, expected) in [
        ("first-server.log", "first: started"),
        ("second-server.log", "second: started"),
        ("connection-states.log", "first=offline\nsecond=online"),
    ] {
        let content = std::fs::read_to_string(artifacts.path().join(name))
            .unwrap_or_else(|error| panic!("read {name}: {error}"));
        assert!(
            content.contains(expected),
            "{name} must contain {expected:?}: {content}"
        );
    }
}

#[test]
fn same_origin_workspaces_share_one_rotation_after_reconnect() {
    const EXPIRED: &str = "spk_at_expired_multitab_reconnect";

    let h = common::phase3_harness();
    h.first.seed_change("pm", "pm-reconnect", TASKS);
    h.first.seed_change("rd", "rd-reconnect", RD_TASKS);

    let credentials = Arc::new(ReconnectCredentialStore::new());
    let access = h.first.device_login_editor(credentials.as_ref());
    let refresh_before = credentials
        .get(&h.first.origin, CredentialKind::Refresh)
        .expect("read initial refresh credential")
        .expect("device login stored refresh credential");
    let (state_tx, state_rx) = std::sync::mpsc::channel();
    let manager = Arc::new(TokenManager::with_connection_state(
        &h.first.origin,
        "conn_multitab_reconnect",
        1,
        move |state| {
            let _ = state_tx.send(state);
        },
    ));
    manager.adopt_access_token(&access);

    let (pm_workspace, _) =
        remote::open_workspace(&h.first.origin, "alpha/pm", &manager, credentials.as_ref())
            .expect("open PM workspace before reconnect");
    let (rd_workspace, _) =
        remote::open_workspace(&h.first.origin, "alpha/rd", &manager, credentials.as_ref())
            .expect("open RD workspace before reconnect");

    h.first.stop();
    h.first.start();
    manager.adopt_access_token(EXPIRED);
    while state_rx.try_recv().is_ok() {}
    credentials.arm();

    let start = Arc::new(Barrier::new(3));
    let pm_credentials = credentials.clone();
    let pm_start = start.clone();
    let pm_thread = std::thread::spawn(move || {
        pm_start.wait();
        pm_workspace.list_changes(pm_credentials.as_ref(), None)
    });
    let rd_credentials = credentials.clone();
    let rd_start = start.clone();
    let rd_thread = std::thread::spawn(move || {
        rd_start.wait();
        rd_workspace.list_changes(rd_credentials.as_ref(), None)
    });
    start.wait();

    let pm_changes = pm_thread.join().expect("PM reconnect thread");
    let rd_changes = rd_thread.join().expect("RD reconnect thread");
    let refresh_readers = credentials.refresh_readers();
    credentials.disarm();
    let refresh_after = credentials
        .get(&h.first.origin, CredentialKind::Refresh)
        .expect("read rotated refresh credential")
        .expect("rotation stored replacement refresh credential");

    assert!(
        pm_changes.as_ref().is_ok_and(|list| list
            .changes
            .iter()
            .any(|change| change.summary.name == "pm-reconnect")),
        "PM workspace 应在重连 rotation 后恢复：{pm_changes:?}"
    );
    assert!(
        rd_changes.as_ref().is_ok_and(|list| list
            .changes
            .iter()
            .any(|change| change.summary.name == "rd-reconnect")),
        "RD workspace 应共用 rotation 并恢复：{rd_changes:?}"
    );
    assert_ne!(
        refresh_after, refresh_before,
        "重连必须确实完成一次 refresh credential rotation"
    );
    assert_eq!(
        refresh_readers, 1,
        "同来源多 workspace 只能由 singleflight leader thread 运行 rotation"
    );
    assert!(
        manager.needs_reauth().is_none(),
        "竞态不得误入 needs-reauth"
    );
    assert_eq!(manager.connection_state(), ConnectionState::Online);
    assert!(
        state_rx
            .try_iter()
            .all(|event| event.state != ConnectionState::NeedsReauth),
        "竞态不得广播 needs-reauth"
    );
}

#[test]
fn phase3_five_scenarios_run_as_one_continuous_chain() {
    let h = common::phase3_harness();
    h.first.seed_change("pm", "pm-plan", TASKS);
    let initial_states = [("first", "not-opened"), ("second", "not-opened")];
    common::scenario_assert!(
        &h,
        "第一幕：双 server 起机与 setup",
        &initial_states,
        h.first.is_ready() && h.second.is_ready(),
        "两个隔离 server 必须同时常驻"
    );

    let credentials = Arc::new(MemoryCredentialStore::new());
    h.first.device_login_editor(credentials.as_ref());
    let (first_state_tx, first_state_rx) = std::sync::mpsc::channel();
    let first_manager = Arc::new(TokenManager::with_connection_state(
        &h.first.origin,
        "conn_first",
        1,
        move |state| {
            let _ = first_state_tx.send(state);
        },
    ));
    let opened = remote::open_workspace(
        &h.first.origin,
        "alpha/pm",
        &first_manager,
        credentials.as_ref(),
    );
    let first_state = format!("{:?}", first_manager.connection_state());
    let states = [("first", first_state.as_str()), ("second", "not-opened")];
    common::scenario_assert!(
        &h,
        "第二幕：PM 无 checkout 登录与 handshake",
        &states,
        opened.is_ok(),
        &format!("handshake 失败：{:?}", opened.as_ref().err())
    );
    let (pm_workspace, pm_info) = opened.expect("checked PM handshake");
    common::scenario_assert!(
        &h,
        "第二幕：PM 无 checkout session 身分",
        &states,
        pm_info.project_key == "alpha" && pm_info.repo_key == "pm",
        "handshake 必须绑定 alpha/pm"
    );

    let changes = pm_workspace.list_changes(credentials.as_ref(), None);
    common::scenario_assert!(
        &h,
        "第二幕：PM 清单读取",
        &states,
        changes
            .as_ref()
            .is_ok_and(|list| { list.changes.len() == 1 && list.changes[0].summary.name == "pm-plan" }),
        "清单必须只包含前幕播种的 pm-plan"
    );
    let document = pm_workspace.document(credentials.as_ref(), "pm-plan", "tasks.md");
    common::scenario_assert!(
        &h,
        "第二幕：PM 文档读取",
        &states,
        document
            .as_ref()
            .is_ok_and(|artifact| artifact.content.contains("- [ ] 1.1 First")),
        "tasks.md 必须来自 server 真值"
    );
    let written = pm_workspace.set_task_done(credentials.as_ref(), "pm-plan", "1", true);
    common::scenario_assert!(
        &h,
        "第二幕：PM 任务勾选写入",
        &states,
        written.is_ok(),
        &format!("task done 失败：{written:?}")
    );
    let after_write = pm_workspace.document(credentials.as_ref(), "pm-plan", "tasks.md");
    common::scenario_assert!(
        &h,
        "第二幕：PM 任务写穿 server",
        &states,
        after_write
            .as_ref()
            .is_ok_and(|artifact| artifact.content.contains("- [x] 1.1 First")),
        "勾选结果必须可由同一 session 重读"
    );

    let reader_credentials = MemoryCredentialStore::new();
    reader_credentials
        .set(&h.first.origin, CredentialKind::Pat, &h.first.reader_pat)
        .expect("reader PAT into memory store");
    let reader_manager = Arc::new(TokenManager::new(&h.first.origin));
    let reader_open = remote::open_workspace(
        &h.first.origin,
        "alpha/pm",
        &reader_manager,
        &reader_credentials,
    );
    common::scenario_assert!(
        &h,
        "第二幕：reader capability 停用",
        &states,
        reader_open
            .as_ref()
            .is_ok_and(|(_, info)| !info.capabilities.policy_write),
        "reader 的 policyWrite capability 必须为 false"
    );

    let rd_open = remote::open_workspace(
        &h.first.origin,
        "alpha/rd",
        &first_manager,
        credentials.as_ref(),
    );
    common::scenario_assert!(
        &h,
        "第三幕：PM 打开 RD spec-only 数据面",
        &states,
        rd_open.is_ok(),
        &format!("RD scope handshake 失败：{:?}", rd_open.as_ref().err())
    );
    let (rd_workspace, _) = rd_open.expect("checked RD handshake");

    const RD_KEY: &str = "remote:conn_first/alpha/rd";
    let (invalidated_tx, invalidated_rx) = std::sync::mpsc::channel();
    let event_manager = EventManager::new(move |key| {
        let _ = invalidated_tx.send(key);
    });
    let rd_connects = Arc::new(AtomicUsize::new(0));
    let sub_base = h.first.project_url();
    let sub_runtime = first_manager.clone();
    let sub_credentials = credentials.clone();
    let sub_counter = rd_connects.clone();
    let sync_base = h.first.project_url();
    let sync_runtime = first_manager.clone();
    let sync_credentials = credentials.clone();
    event_manager.register(
        RD_KEY,
        move |last| {
            sub_counter.fetch_add(1, Ordering::SeqCst);
            sub_runtime.execute(sub_credentials.as_ref(), |token| {
                events::subscribe(&sub_base, token, Some("rd"), last)
            })
        },
        move || {
            sync_runtime.execute(sync_credentials.as_ref(), |token| {
                events::sync_state(&sync_base, token, Some("rd"))
            })
        },
        vec![Duration::from_millis(30)],
    );
    std::thread::sleep(Duration::from_millis(150));

    let checkout = h
        .first
        .remote_checkout("rd", &h.first.editor_pat, "rd-checkout");
    checkout.write_git_marker("phase3.marker", "alpha/rd checkout\n");
    for (args, stdin) in [
        (vec!["new", "change", "rd-plan"], None),
        (
            vec![
                "new", "artifact", "proposal", "--change", "rd-plan", "--stdin",
            ],
            Some(RD_PROPOSAL),
        ),
        (
            vec!["new", "artifact", "tasks", "--change", "rd-plan", "--stdin"],
            Some(RD_TASKS),
        ),
    ] {
        let output = match stdin {
            Some(content) => checkout.run_stdin(&args, content),
            None => checkout.run(&args),
        };
        common::scenario_assert!(
            &h,
            "第三幕：RD CLI 创建 change 与 artifacts",
            &states,
            output.status.success(),
            &format!(
                "specseal {:?} 失败：{}",
                args,
                String::from_utf8_lossy(&output.stderr)
            )
        );
    }
    while invalidated_rx.try_recv().is_ok() {}
    let task_done = checkout.run(&["task", "done", "1", "--change", "rd-plan"]);
    common::scenario_assert!(
        &h,
        "第三幕：RD CLI task done",
        &states,
        task_done.status.success(),
        &format!(
            "task done 失败：{}",
            String::from_utf8_lossy(&task_done.stderr)
        )
    );
    let invalidated = invalidated_rx.recv_timeout(Duration::from_secs(5));
    common::scenario_assert!(
        &h,
        "第三幕：RD 写入即时反映至 PM 数据面",
        &states,
        invalidated.as_deref() == Ok(RD_KEY),
        &format!("五秒内必须收到 locator invalidate：{invalidated:?}")
    );
    let reflected = rd_workspace.document(credentials.as_ref(), "rd-plan", "tasks.md");
    common::scenario_assert!(
        &h,
        "第三幕：PM 经 invalidate 重查 server 真值",
        &states,
        reflected
            .as_ref()
            .is_ok_and(|artifact| artifact.content.contains("- [x] 1.1 Reflect through PM")),
        "PM 数据面重查必须看见 RD 完成状态"
    );

    h.second.seed_change("main", "second-plan", TASKS);
    let first_refresh_before_second_login = credentials
        .get(&h.first.origin, CredentialKind::Refresh)
        .expect("read first refresh before second login")
        .expect("first refresh exists before second login");
    common::scenario_assert!(
        &h,
        "第四幕：多 server credential 依 origin 隔离",
        &states,
        credentials
            .get(&h.second.origin, CredentialKind::Refresh)
            .is_ok_and(|credential| credential.is_none()),
        "第二个 origin 登录前不得读到第一个 origin 的 refresh credential"
    );
    h.second.device_login_editor(credentials.as_ref());
    let first_refresh_after_second_login = credentials
        .get(&h.first.origin, CredentialKind::Refresh)
        .expect("read first refresh after second login")
        .expect("first refresh remains after second login");
    let second_refresh = credentials
        .get(&h.second.origin, CredentialKind::Refresh)
        .expect("read second refresh")
        .expect("second refresh stored by origin");
    common::scenario_assert!(
        &h,
        "第四幕：多 server credential 不互相覆写",
        &states,
        first_refresh_after_second_login == first_refresh_before_second_login
            && second_refresh != first_refresh_after_second_login,
        "第二个 origin 登录后，两边 refresh credential 必须各自保留"
    );

    let (second_state_tx, second_state_rx) = std::sync::mpsc::channel();
    let second_manager = Arc::new(TokenManager::with_connection_state(
        &h.second.origin,
        "conn_second",
        1,
        move |state| {
            let _ = second_state_tx.send(state);
        },
    ));
    let second_open = remote::open_workspace(
        &h.second.origin,
        "beta/main",
        &second_manager,
        credentials.as_ref(),
    );
    let first_state = format!("{:?}", first_manager.connection_state());
    let second_state = format!("{:?}", second_manager.connection_state());
    let multi_server_states = [
        ("first", first_state.as_str()),
        ("second", second_state.as_str()),
    ];
    common::scenario_assert!(
        &h,
        "第四幕：第二连接打开独立 session",
        &multi_server_states,
        second_open.is_ok(),
        &format!("第二连接 handshake 失败：{:?}", second_open.as_ref().err())
    );
    let (second_workspace, second_info) = second_open.expect("checked second handshake");
    common::scenario_assert!(
        &h,
        "第四幕：第二连接只看见自己的 scope",
        &multi_server_states,
        second_info.project_key == "beta"
            && second_info.repo_key == "main"
            && second_workspace
                .list_changes(credentials.as_ref(), None)
                .is_ok_and(|list| {
                    list.changes.len() == 1 && list.changes[0].summary.name == "second-plan"
                }),
        "第二连接必须绑定 beta/main 且不能读到第一个 server 的 changes"
    );

    const SECOND_KEY: &str = "remote:conn_second/beta/main";
    let second_connects = Arc::new(AtomicUsize::new(0));
    let second_sub_base = h.second.project_url();
    let second_sub_runtime = second_manager.clone();
    let second_sub_credentials = credentials.clone();
    let second_sub_counter = second_connects.clone();
    let second_sync_base = h.second.project_url();
    let second_sync_runtime = second_manager.clone();
    let second_sync_credentials = credentials.clone();
    event_manager.register(
        SECOND_KEY,
        move |last| {
            second_sub_counter.fetch_add(1, Ordering::SeqCst);
            second_sub_runtime.execute(second_sub_credentials.as_ref(), |token| {
                events::subscribe(&second_sub_base, token, Some("main"), last)
            })
        },
        move || {
            second_sync_runtime.execute(second_sync_credentials.as_ref(), |token| {
                events::sync_state(&second_sync_base, token, Some("main"))
            })
        },
        vec![Duration::from_millis(30)],
    );
    std::thread::sleep(Duration::from_millis(150));

    while invalidated_rx.try_recv().is_ok() {}
    let first_server_write =
        rd_workspace.set_task_done(credentials.as_ref(), "rd-plan", "1", false);
    let first_server_event = invalidated_rx.recv_timeout(Duration::from_secs(5));
    let first_server_extra = invalidated_rx.recv_timeout(Duration::from_millis(300));
    common::scenario_assert!(
        &h,
        "第四幕：第一 server 事件不串到第二 server",
        &multi_server_states,
        first_server_write.is_ok()
            && first_server_event.as_deref() == Ok(RD_KEY)
            && first_server_extra.is_err(),
        &format!(
            "第一 server 写入只应分发 {RD_KEY}：write={first_server_write:?}, event={first_server_event:?}, extra={first_server_extra:?}"
        )
    );

    let second_server_write =
        second_workspace.set_task_done(credentials.as_ref(), "second-plan", "1", true);
    let second_server_event = invalidated_rx.recv_timeout(Duration::from_secs(5));
    let second_server_extra = invalidated_rx.recv_timeout(Duration::from_millis(300));
    common::scenario_assert!(
        &h,
        "第四幕：第二 server 事件不串到第一 server",
        &multi_server_states,
        second_server_write.is_ok()
            && second_server_event.as_deref() == Ok(SECOND_KEY)
            && second_server_extra.is_err(),
        &format!(
            "第二 server 写入只应分发 {SECOND_KEY}：write={second_server_write:?}, event={second_server_event:?}, extra={second_server_extra:?}"
        )
    );

    const PM_KEY: &str = "remote:conn_first/alpha/pm";
    let pm_connects = Arc::new(AtomicUsize::new(0));
    let pm_sub_base = h.first.project_url();
    let pm_sub_runtime = first_manager.clone();
    let pm_sub_credentials = credentials.clone();
    let pm_sub_counter = pm_connects.clone();
    let pm_sync_base = h.first.project_url();
    let pm_sync_runtime = first_manager.clone();
    let pm_sync_credentials = credentials.clone();
    event_manager.register(
        PM_KEY,
        move |last| {
            pm_sub_counter.fetch_add(1, Ordering::SeqCst);
            pm_sub_runtime.execute(pm_sub_credentials.as_ref(), |token| {
                events::subscribe(&pm_sub_base, token, Some("pm"), last)
            })
        },
        move || {
            pm_sync_runtime.execute(pm_sync_credentials.as_ref(), |token| {
                events::sync_state(&pm_sync_base, token, Some("pm"))
            })
        },
        vec![Duration::from_millis(30)],
    );
    let duplicate_rd_connects = Arc::new(AtomicUsize::new(0));
    let duplicate_sub_counter = duplicate_rd_connects.clone();
    event_manager.register(
        RD_KEY,
        move |_| {
            duplicate_sub_counter.fetch_add(1, Ordering::SeqCst);
            unreachable!("same locator must reuse the existing stream")
        },
        || unreachable!("same locator must reuse the existing sync worker"),
        vec![Duration::from_millis(30)],
    );
    std::thread::sleep(Duration::from_millis(150));
    let first_server_streams =
        rd_connects.load(Ordering::SeqCst) + pm_connects.load(Ordering::SeqCst);
    common::scenario_assert!(
        &h,
        "第五幕：多 tab 依 locator scope 共用与隔离事件流",
        &multi_server_states,
        first_server_streams == 2
            && rd_connects.load(Ordering::SeqCst) == 1
            && pm_connects.load(Ordering::SeqCst) == 1
            && duplicate_rd_connects.load(Ordering::SeqCst) == 0,
        &format!(
            "PM／RD 各一条、同 RD locator 第二个 session 不另开流：total={first_server_streams}, rd={}, pm={}, duplicate={}",
            rd_connects.load(Ordering::SeqCst),
            pm_connects.load(Ordering::SeqCst),
            duplicate_rd_connects.load(Ordering::SeqCst)
        )
    );

    while invalidated_rx.try_recv().is_ok() {}
    let pm_write = pm_workspace.set_task_done(credentials.as_ref(), "pm-plan", "1", false);
    let pm_event = invalidated_rx.recv_timeout(Duration::from_secs(5));
    let pm_extra = invalidated_rx.recv_timeout(Duration::from_millis(300));
    common::scenario_assert!(
        &h,
        "第五幕：PM scope 写入只分发 PM locator",
        &multi_server_states,
        pm_write.is_ok() && pm_event.as_deref() == Ok(PM_KEY) && pm_extra.is_err(),
        &format!("PM write={pm_write:?}, event={pm_event:?}, extra={pm_extra:?}")
    );

    let rd_write = rd_workspace.set_task_done(credentials.as_ref(), "rd-plan", "1", true);
    let rd_event = invalidated_rx.recv_timeout(Duration::from_secs(5));
    let rd_extra = invalidated_rx.recv_timeout(Duration::from_millis(300));
    common::scenario_assert!(
        &h,
        "第五幕：RD scope 写入只分发 RD locator",
        &multi_server_states,
        rd_write.is_ok() && rd_event.as_deref() == Ok(RD_KEY) && rd_extra.is_err(),
        &format!("RD write={rd_write:?}, event={rd_event:?}, extra={rd_extra:?}")
    );

    while first_state_rx.try_recv().is_ok() {}
    while invalidated_rx.try_recv().is_ok() {}
    h.first.stop();
    let offline_event = first_state_rx.recv_timeout(Duration::from_secs(5));
    let offline_state = format!("{:?}", first_manager.connection_state());
    let second_live_state = format!("{:?}", second_manager.connection_state());
    let outage_states = [
        ("first", offline_state.as_str()),
        ("second", second_live_state.as_str()),
    ];
    common::scenario_assert!(
        &h,
        "第六幕：第一 server 失联广播 offline",
        &outage_states,
        offline_event
            .as_ref()
            .is_ok_and(|event| event.state == ConnectionState::Offline)
            && first_manager.connection_state() == ConnectionState::Offline
            && !h.first.is_ready(),
        &format!("五秒内必须转为 offline：{offline_event:?}")
    );

    let offline_write = pm_workspace.set_task_done(credentials.as_ref(), "pm-plan", "1", true);
    common::scenario_assert!(
        &h,
        "第六幕：脱机写入即拒且不排队",
        &outage_states,
        offline_write
            .as_ref()
            .is_err_and(|error| error.reason.as_deref() == Some("offline")),
        &format!("offline write 必须以 offline reason 拒绝：{offline_write:?}")
    );

    let second_live_write =
        second_workspace.set_task_done(credentials.as_ref(), "second-plan", "1", false);
    let second_checkout = h
        .second
        .remote_checkout("main", &h.second.editor_pat, "second-outage");
    let second_cli_write = second_checkout.run(&["new", "change", "second-during-outage"]);
    let second_during_outage = second_workspace.list_changes(credentials.as_ref(), None);
    common::scenario_assert!(
        &h,
        "第六幕：第一 server 失联不波及第二 server",
        &outage_states,
        second_live_write.is_ok()
            && second_cli_write.status.success()
            && second_manager.connection_state() == ConnectionState::Online
            && second_during_outage.as_ref().is_ok_and(|list| {
                list.changes
                    .iter()
                    .any(|change| change.summary.name == "second-during-outage")
            })
            && second_state_rx.try_recv().is_err(),
        &format!(
            "第二 server 应维持 online 并接受 CLI 写入：write={second_live_write:?}, cli={}, list={second_during_outage:?}",
            second_cli_write.status
        )
    );

    h.first.seed_change("pm", "first-during-outage", TASKS);
    while invalidated_rx.try_recv().is_ok() {}
    h.first.start();
    // 期限须盖过 client 的 SSE stall 侦测（45s）：半开连接的 worker 要等
    // stall 逾时才会重订。正常路径事件毫秒级到达，循环立即结束。
    let online_event = first_state_rx.recv_timeout(Duration::from_secs(75));
    let recovery_deadline = std::time::Instant::now() + Duration::from_secs(75);
    let mut recovery_keys = Vec::new();
    while std::time::Instant::now() < recovery_deadline
        && !(recovery_keys.iter().any(|key| key == PM_KEY)
            && rd_connects.load(Ordering::SeqCst) >= 2)
    {
        if let Ok(key) = invalidated_rx.recv_timeout(Duration::from_millis(250)) {
            recovery_keys.push(key);
        }
    }
    let recovered_changes = pm_workspace.list_changes(credentials.as_ref(), None);
    let rejected_write_absent = pm_workspace.document(credentials.as_ref(), "pm-plan", "tasks.md");
    common::scenario_assert!(
        &h,
        "第六幕：第一 server 重启后以 Polling＋ETag 自动收敛",
        &multi_server_states,
        online_event
            .as_ref()
            .is_ok_and(|event| event.state == ConnectionState::Online)
            && recovery_keys.iter().any(|key| key == PM_KEY)
            && recovered_changes.as_ref().is_ok_and(|list| {
                list.changes
                    .iter()
                    .any(|change| change.summary.name == "first-during-outage")
            })
            && rejected_write_absent
                .as_ref()
                .is_ok_and(|artifact| artifact.content.contains("- [ ] 1.1 First")),
        &format!(
            "重启应 online、发 PM invalidate、读到期间变更且脱机写入未入列：state={online_event:?}, keys={recovery_keys:?}, changes={recovered_changes:?}, task={rejected_write_absent:?}"
        )
    );

    while first_state_rx.try_recv().is_ok() {}
    h.first.revoke_editor_device_family();
    let revoked_read = pm_workspace.list_changes(credentials.as_ref(), None);
    let reauth_event = first_state_rx.recv_timeout(Duration::from_secs(5));
    common::scenario_assert!(
        &h,
        "第六幕：撤销 device family 转为 needs-reauth",
        &multi_server_states,
        revoked_read
            .as_ref()
            .is_err_and(|error| { error.reason.as_deref() == Some("needs_reauth") })
            && reauth_event
                .as_ref()
                .is_ok_and(|event| event.state == ConnectionState::NeedsReauth)
            && first_manager.connection_state() == ConnectionState::NeedsReauth,
        &format!("撤销后必须广播 needs-reauth：read={revoked_read:?}, state={reauth_event:?}")
    );

    let relogin_access = h.first.device_login_editor(credentials.as_ref());
    first_manager.adopt_access_token(&relogin_access);
    let relogin_event = first_state_rx.recv_timeout(Duration::from_secs(5));
    let recovered_in_place = pm_workspace.list_changes(credentials.as_ref(), None);
    common::scenario_assert!(
        &h,
        "第六幕：重新登录后原 session 原地恢复",
        &multi_server_states,
        relogin_event
            .as_ref()
            .is_ok_and(|event| event.state == ConnectionState::Online)
            && first_manager.connection_state() == ConnectionState::Online
            && recovered_in_place.as_ref().is_ok_and(|list| {
                list.changes
                    .iter()
                    .any(|change| change.summary.name == "first-during-outage")
            }),
        &format!(
            "同一 workspace／manager 应恢复：state={relogin_event:?}, list={recovered_in_place:?}"
        )
    );

    let repo_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..");
    let local_context = specseal_desktop_core::init_core_context(&repo_root);
    common::scenario_assert!(
        &h,
        "Gate 1：local＋remote spec-only＋remote checkout 三形态 session 并存",
        &multi_server_states,
        local_context.is_some()
            && recovered_in_place.is_ok()
            && checkout.root().join(".git").is_dir()
            && rd_workspace
                .list_changes(credentials.as_ref(), None)
                .is_ok_and(|list| list.changes.iter().any(|change| change.summary.name == "rd-plan")),
        "本地数据层、PM spec-only 与 RD checkout 必须在同一剧本同时存活"
    );

    let rd_key_with_checkout = "remote:conn_first/alpha/rd";
    common::scenario_assert!(
        &h,
        "Gate 2：分页身分使用 locator key 而非 root path",
        &multi_server_states,
        PM_KEY != rd_key_with_checkout
            && RD_KEY == rd_key_with_checkout
            && !rd_key_with_checkout.contains(checkout.root().to_string_lossy().as_ref()),
        "PM／RD scope 应有不同 locator key，checkoutRoot 不得参与 RD 身分"
    );

    common::scenario_assert!(
        &h,
        "Gate 3：capability 驱动 reader policy 停用",
        &multi_server_states,
        reader_open
            .as_ref()
            .is_ok_and(|(_, info)| !info.capabilities.policy_write),
        "reader handshake 的 policyWrite 必须持续为 false"
    );

    let persisted_tabs = serde_json::json!({
        "version": 2,
        "tabs": [
            {
                "locator": { "kind": "local", "root": repo_root.display().to_string() },
                "name": "local"
            },
            {
                "locator": {
                    "kind": "remote",
                    "connectionId": "conn_first",
                    "projectId": "alpha",
                    "repoId": "pm"
                },
                "name": "alpha/pm"
            },
            {
                "locator": {
                    "kind": "remote",
                    "connectionId": "conn_first",
                    "projectId": "alpha",
                    "repoId": "rd",
                    "checkoutRoot": checkout.root().display().to_string()
                },
                "name": "alpha/rd"
            }
        ],
        "activeKey": RD_KEY
    })
    .to_string();
    let registry_payloads = [
        std::fs::read_to_string(&h.first.registry).expect("read first connection registry"),
        std::fs::read_to_string(&h.second.registry).expect("read second connection registry"),
        persisted_tabs,
    ];
    let current_first_refresh = credentials
        .get(&h.first.origin, CredentialKind::Refresh)
        .expect("read current first refresh")
        .expect("current first refresh exists");
    let current_second_refresh = credentials
        .get(&h.second.origin, CredentialKind::Refresh)
        .expect("read current second refresh")
        .expect("current second refresh exists");
    let known_credentials = [
        h.first.editor_pat.as_str(),
        h.first.reader_pat.as_str(),
        h.second.editor_pat.as_str(),
        h.second.reader_pat.as_str(),
        current_first_refresh.as_str(),
        current_second_refresh.as_str(),
        relogin_access.as_str(),
    ];
    common::scenario_assert!(
        &h,
        "Gate 4：registry 与 tabs 持久化 payload 无 credential",
        &multi_server_states,
        known_credentials.iter().all(|credential| {
            !credential.is_empty()
                && registry_payloads
                    .iter()
                    .all(|payload| !payload.contains(*credential))
        }),
        "connection registry 与分页串行化不得含 PAT、refresh 或 access token"
    );

    common::scenario_assert!(
        &h,
        "Gate 5：Polling＋ETag 使重启后自动收敛",
        &multi_server_states,
        pm_connects.load(Ordering::SeqCst) >= 2
            && rd_connects.load(Ordering::SeqCst) >= 2
            && recovery_keys.iter().any(|key| key == PM_KEY)
            && recovered_in_place.as_ref().is_ok_and(|list| {
                list.changes
                    .iter()
                    .any(|change| change.summary.name == "first-during-outage")
            }),
        &format!(
            "两 scope 都应重连且 PM 应经 invalidate 重读新真值：pm={}, rd={}, keys={recovery_keys:?}",
            pm_connects.load(Ordering::SeqCst),
            rd_connects.load(Ordering::SeqCst)
        )
    );

    common::scenario_assert!(
        &h,
        "Gate 6：stale 只读、脱机写入不排队",
        &multi_server_states,
        offline_write
            .as_ref()
            .is_err_and(|error| error.reason.as_deref() == Some("offline"))
            && rejected_write_absent
                .as_ref()
                .is_ok_and(|artifact| artifact.content.contains("- [ ] 1.1 First")),
        "脱机写入必须即拒，恢复后 server tasks.md 仍维持未勾选"
    );
}
