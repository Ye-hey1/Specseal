//! event manager 契约（design「决策 3：SSE 消费落 specseal-remote、event
//! manager 落 src-tauri」「决策 5：断线收敛进程」；规格「Query 加 ETag 为重读
//! 正典且 push 只做 invalidate」「断线以 Polling 加 ETag 收敛后续订」）。
//!
//! in-process specseal-server＋可注入的订阅闭包与退避串行：invalidate 到达即
//! 发 remote-workspace-changed（payload＝locator key）；同 connection 两
//! session 共用单一订阅（计数断言）；强制断流（TCP proxy sever）后以
//! /sync-state ETag 收敛、退避重连并 Last-Event-ID 续传；reset 信号发全量
//! 重载通知后自新位点续订。

use crate::common;

use specseal_remote::credentials::{CredentialKind, CredentialStore, MemoryCredentialStore};
use specseal_desktop_lib::event_manager::EventManager;
use specseal_desktop_lib::remote::{ConnectionState, ConnectionStateEvent, TokenManager};
use specseal_remote::client::Client;
use specseal_remote::events;
use specseal_server::events::EventSettings;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

const FOUR_TASKS: &str = "- [ ] 1.1 First\n- [ ] 1.2 Second\n- [ ] 1.3 Third\n- [ ] 1.4 Fourth\n";
const KEY: &str = "remote:conn_x/demo/backend";

// --- 退避轮询的 sync-state 失败纳入 connection failure count ---

#[test]
fn repeated_sync_state_failures_during_backoff_drive_the_connection_offline() {
    let (state_tx, state_rx) = mpsc::channel::<ConnectionStateEvent>();
    let manager = Arc::new(TokenManager::with_connection_state(
        "http://server.test",
        "conn_x",
        2,
        move |event| {
            let _ = state_tx.send(event);
        },
    ));
    manager.adopt_access_token("pat");
    let credentials = Arc::new(MemoryCredentialStore::new());
    credentials
        .set("http://server.test", CredentialKind::Pat, "pat")
        .expect("set PAT");

    let (notify, _rx) = sink();
    let events = EventManager::new(notify);
    let sync_manager = manager.clone();
    let sync_credentials = credentials.clone();
    events.register(
        KEY,
        |_| Err(specseal_remote::translate_transport()),
        move || {
            sync_manager.execute(sync_credentials.as_ref(), |_| -> Result<String, _> {
                Err(specseal_remote::translate_transport())
            })
        },
        vec![Duration::from_millis(5)],
    );

    let offline = state_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("每轮退避的 sync-state 失败达阈值后广播 offline");
    assert_eq!(offline.connection_id, "conn_x");
    assert_eq!(offline.state, ConnectionState::Offline);
    events.unregister(KEY);
}

// --- async 化后 IPC 顺序不再保证：先到的 unregister 抵销在途的 register ---

#[test]
fn an_unregister_arriving_before_its_register_cancels_that_subscription() {
    let (notify, _rx) = sink();
    let events = EventManager::new(notify);
    let attempts = Arc::new(AtomicUsize::new(0));

    // 快速 mount/unmount 下 cleanup 的 unregister 可先于 register 抵达。
    events.unregister(KEY);

    let sub_attempts = attempts.clone();
    events.register(
        KEY,
        move |_| {
            sub_attempts.fetch_add(1, Ordering::SeqCst);
            Err(specseal_remote::translate_transport())
        },
        || Err(specseal_remote::translate_transport()),
        vec![Duration::from_millis(5)],
    );
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(
        attempts.load(Ordering::SeqCst),
        0,
        "先到的 unregister 必须抵销这次 register——不得开出没人退订的 worker"
    );

    // 抵销是一次性的：下一个 register 照常开订阅。
    let sub_attempts = attempts.clone();
    events.register(
        KEY,
        move |_| {
            sub_attempts.fetch_add(1, Ordering::SeqCst);
            Err(specseal_remote::translate_transport())
        },
        || Err(specseal_remote::translate_transport()),
        vec![Duration::from_millis(5)],
    );
    let deadline = std::time::Instant::now() + Duration::from_secs(1);
    while attempts.load(Ordering::SeqCst) == 0 && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        attempts.load(Ordering::SeqCst) > 0,
        "抵销额度用掉后，新 register 必须照常开 worker"
    );
    events.unregister(KEY);
}

#[test]
fn a_failed_watch_neutralizes_its_paired_unwatch() {
    let (notify, _rx) = sink();
    let events = EventManager::new(notify);
    let attempts = Arc::new(AtomicUsize::new(0));

    // remote_watch 于注册前失败（如 registry 坏读）＝没有 register 入帐，
    // 但前端 unmount 照样发 unregister——这笔退订不得毒害之后的订阅。
    events.register_failed(KEY);
    events.unregister(KEY);

    let sub_attempts = attempts.clone();
    events.register(
        KEY,
        move |_| {
            sub_attempts.fetch_add(1, Ordering::SeqCst);
            Err(specseal_remote::translate_transport())
        },
        || Err(specseal_remote::translate_transport()),
        vec![Duration::from_millis(5)],
    );
    let deadline = std::time::Instant::now() + Duration::from_secs(1);
    while attempts.load(Ordering::SeqCst) == 0 && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        attempts.load(Ordering::SeqCst) > 0,
        "失败注册的配对退订被中和后，新 register 必须照常开 worker"
    );
    events.unregister(KEY);

    // 反向交错：unregister 先到（记额度）、失败注册后到（消额度）——
    // 同样不得留下毒药。
    events.unregister(KEY);
    events.register_failed(KEY);
    let sub_attempts = attempts.clone();
    attempts.store(0, Ordering::SeqCst);
    events.register(
        KEY,
        move |_| {
            sub_attempts.fetch_add(1, Ordering::SeqCst);
            Err(specseal_remote::translate_transport())
        },
        || Err(specseal_remote::translate_transport()),
        vec![Duration::from_millis(5)],
    );
    let deadline = std::time::Instant::now() + Duration::from_secs(1);
    while attempts.load(Ordering::SeqCst) == 0 && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        attempts.load(Ordering::SeqCst) > 0,
        "先到的退订被后到的失败注册消帐后，新 register 必须照常开 worker"
    );
    events.unregister(KEY);
}

#[test]
fn a_restarted_server_recovers_online_and_invalidates_without_user_action() {
    let h = common::harness_with_events(common::fast_events());
    common::seed_change(h.store.as_ref(), FOUR_TASKS);
    let pat = common::pat_of(&h);
    let credentials = Arc::new(MemoryCredentialStore::new());
    credentials
        .set(&h.origin, CredentialKind::Pat, &pat)
        .expect("set PAT");
    let (state_tx, state_rx) = mpsc::channel::<ConnectionStateEvent>();
    let runtime = Arc::new(TokenManager::with_connection_state(
        &h.origin,
        "conn_x",
        1,
        move |event| {
            let _ = state_tx.send(event);
        },
    ));
    runtime.adopt_access_token(&pat);

    h.server.stop();
    let (notify, notify_rx) = sink();
    let events = EventManager::new(notify);
    let sub_base = project_base(&h.origin);
    let sub_runtime = runtime.clone();
    let sub_credentials = credentials.clone();
    let sync_base = project_base(&h.origin);
    let sync_runtime = runtime.clone();
    let sync_credentials = credentials.clone();
    events.register(
        KEY,
        move |last| {
            sub_runtime.execute(sub_credentials.as_ref(), |token| {
                events::subscribe(&sub_base, token, Some("backend"), last)
            })
        },
        move || {
            sync_runtime.execute(sync_credentials.as_ref(), |token| {
                events::sync_state(&sync_base, token, Some("backend"))
            })
        },
        vec![Duration::from_millis(30)],
    );
    // Windows 对 refused connect 会在 winsock 内部重试（单次 ~1s 才回错），
    // CI runner 调度再放大——上限只防吊死，放宽不影响通过速度。
    let offline = state_rx
        .recv_timeout(Duration::from_secs(15))
        .expect("server 停止后 worker 自动转 offline");
    assert_eq!(offline.state, ConnectionState::Offline);

    // 仿真同一持久 store 在 desktop 断线期间由另一个 client 写入。
    common::seed_named_change(h.store.as_ref(), "recovered", "- [ ] 1.1 Recovered\n");
    h.server.start();

    let online = state_rx
        .recv_timeout(Duration::from_secs(15))
        .expect("server 重启后 worker 自动转 online");
    assert_eq!(online.state, ConnectionState::Online);
    expect_notified(&notify_rx, "恢复收敛后送出全量失效通知");
    let names = writer(&h.origin, &pat)
        .list_changes()
        .expect("恢复后可读 server 真值")
        .changes
        .into_iter()
        .map(|change| change.name)
        .collect::<Vec<_>>();
    assert!(names.iter().any(|name| name == "recovered"));
    events.unregister(KEY);
}

/// 收 remote-workspace-changed 的测试水槽。
fn sink() -> (
    impl Fn(String) + Send + Sync + 'static,
    mpsc::Receiver<String>,
) {
    let (tx, rx) = mpsc::channel();
    (
        move |key: String| {
            let _ = tx.send(key);
        },
        rx,
    )
}

/// 对 demo project 的数据面 client（直连 server、触发 outbox 事件用）。
fn writer(origin: &str, pat: &str) -> Client {
    Client::new(
        &format!("{origin}/api/specseal/v1/projects/demo"),
        pat,
        Some("backend"),
    )
}

fn project_base(origin_or_proxy: &str) -> String {
    format!("{origin_or_proxy}/api/specseal/v1/projects/demo")
}

/// 把 channel 内既有的通知全部沥干。
fn drain(rx: &mpsc::Receiver<String>) {
    while rx.try_recv().is_ok() {}
}

/// 在 timeout 内至少收到一则指定 key 的通知。
fn expect_notified(rx: &mpsc::Receiver<String>, why: &str) {
    let got = rx
        .recv_timeout(Duration::from_secs(5))
        .unwrap_or_else(|_| panic!("{why}: 未收到通知"));
    assert_eq!(got, KEY, "{why}: 通知 payload 是 locator key");
}

// --- 可 sever 的 TCP proxy：强制断流而不动 server ---

struct Proxy {
    /// proxy 的 http origin（指给 manager 的订阅面）。
    origin: String,
    live: Arc<Mutex<Vec<TcpStream>>>,
}

fn proxy_to(upstream_origin: &str) -> Proxy {
    let upstream = upstream_origin.trim_start_matches("http://").to_string();
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind proxy");
    let addr = listener.local_addr().expect("proxy addr");
    let live: Arc<Mutex<Vec<TcpStream>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = live.clone();
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(client) = conn else { break };
            let Ok(server) = TcpStream::connect(&upstream) else {
                continue;
            };
            sink.lock()
                .unwrap()
                .push(client.try_clone().expect("clone"));
            sink.lock()
                .unwrap()
                .push(server.try_clone().expect("clone"));
            let (mut c_read, mut s_write) = (
                client.try_clone().expect("clone"),
                server.try_clone().expect("clone"),
            );
            let (mut s_read, mut c_write) = (server, client);
            std::thread::spawn(move || pump(&mut c_read, &mut s_write));
            std::thread::spawn(move || pump(&mut s_read, &mut c_write));
        }
    });
    Proxy {
        origin: format!("http://{addr}"),
        live,
    }
}

fn pump(from: &mut TcpStream, to: &mut TcpStream) {
    let mut buf = [0u8; 4096];
    loop {
        match from.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if to.write_all(&buf[..n]).is_err() {
                    break;
                }
            }
        }
    }
    let _ = to.shutdown(Shutdown::Both);
}

impl Proxy {
    /// 切断所有既有连接（含 manager 的 SSE 流）；之后的新连接照常通行。
    fn sever(&self) {
        for stream in self.live.lock().unwrap().drain(..) {
            let _ = stream.shutdown(Shutdown::Both);
        }
    }
}

/// 对 manager 注入的订阅与 sync-state 闭包（带连接计数）。
fn register_via(manager: &EventManager, base: &str, pat: &str, connects: &Arc<AtomicUsize>) {
    let sub_base = project_base(base);
    let sub_pat = pat.to_string();
    let counter = connects.clone();
    let etag_base = project_base(base);
    let etag_pat = pat.to_string();
    manager.register(
        KEY,
        move |last| {
            counter.fetch_add(1, Ordering::SeqCst);
            events::subscribe(&sub_base, &sub_pat, Some("backend"), last)
        },
        move || events::sync_state(&etag_base, &etag_pat, Some("backend")),
        vec![Duration::from_millis(30)],
    );
}

// --- invalidate 分发 ---

#[test]
fn an_invalidate_dispatches_the_locator_key_to_the_frontend() {
    let h = common::harness_with_events(common::fast_events());
    common::seed_change(h.store.as_ref(), FOUR_TASKS);
    let pat = common::pat_of(&h);
    let (notify, rx) = sink();
    let manager = EventManager::new(notify);
    let connects = Arc::new(AtomicUsize::new(0));
    register_via(&manager, &h.origin, &pat, &connects);
    std::thread::sleep(Duration::from_millis(150));

    writer(&h.origin, &pat)
        .task_done("demo", "1", &[], None)
        .expect("task done");
    expect_notified(&rx, "invalidate 到达即发前端事件");
}

// --- 同 connection 两 session 共用单一订阅 ---

#[test]
fn two_sessions_on_one_connection_share_a_single_subscription() {
    let h = common::harness_with_events(common::fast_events());
    common::seed_change(h.store.as_ref(), FOUR_TASKS);
    let pat = common::pat_of(&h);
    let (notify, rx) = sink();
    let manager = EventManager::new(notify);
    let connects = Arc::new(AtomicUsize::new(0));

    register_via(&manager, &h.origin, &pat, &connects);
    register_via(&manager, &h.origin, &pat, &connects);
    std::thread::sleep(Duration::from_millis(150));
    assert_eq!(
        connects.load(Ordering::SeqCst),
        1,
        "两 session 共用单一订阅"
    );

    let w = writer(&h.origin, &pat);
    w.task_done("demo", "1", &[], None).expect("task done");
    expect_notified(&rx, "共用订阅仍分发");
    assert!(
        rx.recv_timeout(Duration::from_millis(350)).is_err(),
        "同 key 的事件只通知一次（session 以 key 对应、不重复）"
    );

    // 退掉一个 session：流仍在。
    manager.unregister(KEY);
    drain(&rx);
    w.task_done("demo", "2", &[], None).expect("task done");
    expect_notified(&rx, "仍有 session 注册时流不得中止");

    // 退掉最后一个 session：流收束、不再通知也不再重连。
    manager.unregister(KEY);
    std::thread::sleep(Duration::from_millis(300));
    drain(&rx);
    w.task_done("demo", "3", &[], None).expect("task done");
    assert!(
        rx.recv_timeout(Duration::from_millis(400)).is_err(),
        "最后一个 session 退出后订阅收束"
    );
    assert_eq!(connects.load(Ordering::SeqCst), 1, "全程只开过一条流");
}

// --- 断流 → ETag 收敛 → 退避重连＋Last-Event-ID 续传 ---

#[test]
fn a_severed_stream_converges_via_etag_and_resumes_live() {
    let h = common::harness_with_events(common::fast_events());
    common::seed_change(h.store.as_ref(), FOUR_TASKS);
    let pat = common::pat_of(&h);
    let proxy = proxy_to(&h.origin);
    let (notify, rx) = sink();
    let manager = EventManager::new(notify);
    let connects = Arc::new(AtomicUsize::new(0));
    register_via(&manager, &proxy.origin, &pat, &connects);
    std::thread::sleep(Duration::from_millis(150));

    let w = writer(&h.origin, &pat);
    w.task_done("demo", "1", &[], None).expect("task done");
    expect_notified(&rx, "断流前的基线事件");
    drain(&rx);

    // 强制断流；断线期间 server 侧发生变更。
    proxy.sever();
    w.task_done("demo", "2", &[], None)
        .expect("task done while severed");
    // 收敛：sync-state ETag 相异即发重载通知（Query 为重读正典），并以注入
    // 退避串行重连、Last-Event-ID 续传——错过的变更不得遗漏。
    expect_notified(&rx, "断线期间的变更经收敛反映");

    // 重连后的新事件走正常推播。
    drain(&rx);
    w.task_done("demo", "3", &[], None)
        .expect("task done after recovery");
    expect_notified(&rx, "续订后新事件照常分发");
    assert!(
        connects.load(Ordering::SeqCst) >= 2,
        "断流后经重连（计数前进）"
    );
}

// --- reset 信号 → 全量重载通知 → 自新位点续订 ---

#[test]
fn a_reset_triggers_a_full_reload_notification_and_a_stable_fresh_subscription() {
    // retention 2：断线期间的写入把 acked floor 推过 manager 的续传位点，
    // 重连的 Last-Event-ID 续传被 server 以 reset 回应。
    let h = common::harness_with_events(EventSettings {
        retention: 2,
        buffer: 64,
        heartbeat: Duration::from_millis(100),
    });
    common::seed_change(h.store.as_ref(), FOUR_TASKS);
    let pat = common::pat_of(&h);

    // 一条测试自有的直连订阅持续沥干——让 server 的保留期 floor 前进。
    let mut driver = events::subscribe(&project_base(&h.origin), &pat, Some("backend"), None)
        .expect("driver subscribe");
    let driver_abort = driver.abort_handle();
    std::thread::spawn(move || while let Ok(Some(_)) = driver.next() {});

    let proxy = proxy_to(&h.origin);
    let (notify, rx) = sink();
    let manager = EventManager::new(notify);
    let connects = Arc::new(AtomicUsize::new(0));
    register_via(&manager, &proxy.origin, &pat, &connects);
    std::thread::sleep(Duration::from_millis(150));

    let w = writer(&h.origin, &pat);
    w.task_done("demo", "1", &[], None).expect("task done");
    expect_notified(&rx, "基线事件（manager 持有续传位点）");
    drain(&rx);

    // 断流后连写四笔：driver 沥干使 floor 越过 manager 的位点。
    proxy.sever();
    for task in ["2", "3", "4", "1"] {
        // 最后一笔是 undone——只为多产生一个 outbox 事件。
        if task == "1" {
            w.task_undone("demo", task).expect("undone");
        } else {
            w.task_done("demo", task, &[], None)
                .expect("task done while severed");
        }
    }
    std::thread::sleep(Duration::from_millis(300));

    // 重连的续传位点已被清理——server 回 reset，manager 发全量重载通知。
    expect_notified(&rx, "reset 信号触发全量重载通知");

    // 自新位点续订：新事件照常分发，且流保持稳定（不重连震荡）。
    drain(&rx);
    w.task_done("demo", "1", &[], None).expect("a fresh write");
    expect_notified(&rx, "reset 后自新位点续订");
    let settled = connects.load(Ordering::SeqCst);
    drain(&rx);
    w.task_undone("demo", "1").expect("another fresh write");
    expect_notified(&rx, "续订后的流持续分发");
    assert_eq!(
        connects.load(Ordering::SeqCst),
        settled,
        "reset 后的流是稳定的单一订阅、不重连震荡"
    );

    driver_abort.abort();
}
