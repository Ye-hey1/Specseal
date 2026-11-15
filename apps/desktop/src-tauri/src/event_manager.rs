//! per-connection 事件管理者（design 决策 3、5；规格「Query 加 ETag 为重读
//! 正典且 push 只做 invalidate」「断线以 Polling 加 ETag 收敛后续订」）。
//!
//! 以 locator key（connection＋project/repo）为订阅键：server 的 /events 是
//! project-scoped＋repo header，同 scope 的 sessions 以参照计数共用单一条流、
//! 事件以 key 分发（每事件每 key 恰一次通知）。收 invalidate 只转发失效提示
//! ——payload＝locator key，前端一律经 Query 重读，这里不携带、不缓存任何
//! 数据实体。
//!
//! 断线收敛进程（决策 5）：(1) 停流；(2) 以 /sync-state ETag 与已知值比对
//! ——不同即发重载通知（已知值由 invalidate 的 revision 推导：ETag＝加引号的
//! project revision，零额外请求）；(3) 依注入的退避串行重连并带 Last-Event-ID
//! 续传。SSE 持续不可用期间，每轮退避都跑一次 ETag 比对——轮询即心跳。收到
//! reset 信号：发全量重载通知、位点归零，自同一条流的新位点续订。
//!
//! 已知边界：server 若以全新 outbox 重启（例如 memory store），过大的
//! Last-Event-ID 会使续传静默失聪——重连当下的 ETag 比对会补发一次重载通知，
//! 其后的收敛依赖下一次断线或重订（sqlite/pg 后端的 outbox 跨重启连续，
//! 不受此影响）。

use specseal_remote::events::{EventStream, RemoteEvent};
use specseal_remote::RemoteError;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 一条共用订阅的控制面：参照计数＋收束把手。
struct SubEntry {
    count: usize,
    shutdown: Arc<AtomicBool>,
    /// 目前开着的流的中止把手（worker 每次开流后挂上）。
    stream_abort: Arc<Mutex<Option<specseal_remote::events::AbortHandle>>>,
}

/// 订阅表：共用订阅之外，另记两种帐目，让 register／unregister 在任何抵达
/// 顺序下总帐都平（async IPC 后顺序不再保证，cleanup 可先于 subscribe 抵达）：
///
/// - `debts`——先到的 unregister：对不存在的 key 退订＝记一笔额度，该 key 的
///   下一个 register（或失败注册的入帐）直接被抵销、不开 worker。
/// - `credits`——注册失败的入帐（[`EventManager::register_failed`]）：注册没
///   发生但前端 unmount 照样退订，先到的失败额度让那笔退订变 no-op，不毒害
///   之后的订阅。
///
/// 每笔 register（成功、失败皆入帐）＋1、每笔 unregister −1，两种额度互不
/// 共存（入帐先消 debt、退订先消 credit）——收敛后帐目归零：不会留下没人
/// 退订的孤儿 worker，也不会留下吃掉未来订阅的毒药额度（代价是罕见交错下
/// 订阅短暂断开重建，可接受）。
#[derive(Default)]
struct Subs {
    entries: HashMap<String, SubEntry>,
    debts: HashMap<String, usize>,
    credits: HashMap<String, usize>,
}

/// remote 事件的分发中枢：tauri 接线注入 notify（emit remote-workspace-changed），
/// 测试注入 channel 水槽。
pub struct EventManager {
    notify: Arc<dyn Fn(String) + Send + Sync>,
    subs: Mutex<Subs>,
}

impl Drop for EventManager {
    fn drop(&mut self) {
        let mut subs = self.subs.lock().expect("subs lock");
        for (_, entry) in subs.entries.drain() {
            entry.shutdown.store(true, Ordering::Relaxed);
            if let Some(abort) = entry.stream_abort.lock().expect("abort lock").take() {
                abort.abort();
            }
        }
    }
}

impl EventManager {
    pub fn new(notify: impl Fn(String) + Send + Sync + 'static) -> EventManager {
        EventManager {
            notify: Arc::new(notify),
            subs: Mutex::new(Subs::default()),
        }
    }

    /// 注册一个 session：先消掉先到的 unregister 额度（见 [`Subs`]），
    /// 其次同 key 已有订阅即共用（参照计数＋1，闭包弃用），
    /// 否则以给定的订阅／sync-state 闭包与退避串行开 worker 线程。
    pub fn register<S, P>(&self, key: &str, subscribe: S, sync_state: P, backoff: Vec<Duration>)
    where
        S: Fn(Option<u64>) -> Result<EventStream, RemoteError> + Send + 'static,
        P: Fn() -> Result<String, RemoteError> + Send + 'static,
    {
        let mut subs = self.subs.lock().expect("subs lock");
        if let Some(debt) = subs.debts.get_mut(key) {
            *debt -= 1;
            if *debt == 0 {
                subs.debts.remove(key);
            }
            return;
        }
        if let Some(entry) = subs.entries.get_mut(key) {
            entry.count += 1;
            return;
        }
        let shutdown = Arc::new(AtomicBool::new(false));
        let stream_abort: Arc<Mutex<Option<specseal_remote::events::AbortHandle>>> =
            Arc::new(Mutex::new(None));
        subs.entries.insert(
            key.to_string(),
            SubEntry {
                count: 1,
                shutdown: shutdown.clone(),
                stream_abort: stream_abort.clone(),
            },
        );
        let notify = Arc::clone(&self.notify);
        let key = key.to_string();
        std::thread::spawn(move || {
            worker(
                key,
                notify,
                subscribe,
                sync_state,
                backoff,
                shutdown,
                stream_abort,
            )
        });
    }

    /// 注册失败的入帐：command 在 register 之前失败（如 registry 坏读）时
    /// 调用——没有订阅入帐，但前端 unmount 照样退订，这笔额度让配对的
    /// unregister 变 no-op。先消先到的退订额度（反向交错）。
    pub fn register_failed(&self, key: &str) {
        let mut subs = self.subs.lock().expect("subs lock");
        if let Some(debt) = subs.debts.get_mut(key) {
            *debt -= 1;
            if *debt == 0 {
                subs.debts.remove(key);
            }
            return;
        }
        *subs.credits.entry(key.to_string()).or_insert(0) += 1;
    }

    /// 退出一个 session：先消失败注册的额度（该笔退订没有对应的订阅）；
    /// 其次参照计数归零时收束订阅（中止流、worker 退场）；
    /// key 不存在＝这笔退订先于它的 register 抵达，记一笔抵销额度。
    pub fn unregister(&self, key: &str) {
        let mut subs = self.subs.lock().expect("subs lock");
        if let Some(credit) = subs.credits.get_mut(key) {
            *credit -= 1;
            if *credit == 0 {
                subs.credits.remove(key);
            }
            return;
        }
        let Some(entry) = subs.entries.get_mut(key) else {
            *subs.debts.entry(key.to_string()).or_insert(0) += 1;
            return;
        };
        entry.count = entry.count.saturating_sub(1);
        if entry.count == 0 {
            let entry = subs.entries.remove(key).expect("entry exists");
            entry.shutdown.store(true, Ordering::Relaxed);
            let abort = entry.stream_abort.lock().expect("abort lock").take();
            if let Some(abort) = abort {
                abort.abort();
            }
        }
    }
}

/// 一条订阅的 worker：开流→分发→断线收敛→重连，直到 shutdown。
fn worker(
    key: String,
    notify: Arc<dyn Fn(String) + Send + Sync>,
    subscribe: impl Fn(Option<u64>) -> Result<EventStream, RemoteError>,
    sync_state: impl Fn() -> Result<String, RemoteError>,
    backoff: Vec<Duration>,
    shutdown: Arc<AtomicBool>,
    stream_abort: Arc<Mutex<Option<specseal_remote::events::AbortHandle>>>,
) {
    let mut last_event_id: Option<u64> = None;
    let mut last_etag: Option<String> = None;
    let mut attempt = 0usize;
    let mut recovery_episode = false;
    let mut recovery_invalidation_sent = false;
    loop {
        if shutdown.load(Ordering::Relaxed) {
            return;
        }
        if let Ok(mut stream) = subscribe(last_event_id) {
            // 曾断线后第一次成功重订即全量失效；若前一轮 sync-state 已送过，
            // 此处只结束 recovery episode，不重复通知。
            if recovery_episode && !recovery_invalidation_sent {
                notify(key.clone());
            }
            let abort = stream.abort_handle();
            *stream_abort.lock().expect("abort lock") = Some(abort.clone());
            // shutdown 恰于挂上把手前发生：自行收束。
            if shutdown.load(Ordering::Relaxed) {
                abort.abort();
                return;
            }
            attempt = 0;
            loop {
                match stream.next() {
                    Ok(Some(RemoteEvent::Invalidate(hint))) => {
                        if let Ok(seq) = hint.event_id.parse::<u64>() {
                            last_event_id = Some(seq);
                        }
                        // ETag＝加引号的 project revision（server 的 scope token
                        // 形制）——由事件推导，收敛比对零额外请求。
                        last_etag = Some(format!("\"{}\"", hint.revision));
                        notify(key.clone());
                    }
                    Ok(Some(RemoteEvent::Reset)) => {
                        // 续传位点已过保留期：全量重载，位点归零，自同一条流
                        // 的新位点续订。
                        last_event_id = None;
                        last_etag = None;
                        notify(key.clone());
                    }
                    // Ok(None)＝中止把手收束（unregister）。
                    Ok(None) => return,
                    // 断线：进收敛进程。
                    Err(_) => {
                        recovery_episode = true;
                        recovery_invalidation_sent = false;
                        break;
                    }
                }
            }
            *stream_abort.lock().expect("abort lock") = None;
        } else if !recovery_episode {
            recovery_episode = true;
            recovery_invalidation_sent = false;
        }
        if shutdown.load(Ordering::Relaxed) {
            return;
        }
        // 收敛 (2)：ETag 相异即发重载通知——完全漏掉 push 仍经 Query 收敛。
        // SSE 不可用期间每轮退避都经过这里：轮询即心跳。
        if let Ok(etag) = sync_state() {
            let changed = last_etag.as_deref() != Some(etag.as_str());
            if changed {
                last_etag = Some(etag);
                notify(key.clone());
            }
            // 同一断线 episode 第一次成功收敛必送一次全量失效；ETag 已变时
            // 上方通知即同一笔，不再重复。SSE 持续失败时后续轮询也不洗版。
            if recovery_episode && !recovery_invalidation_sent {
                if !changed {
                    notify(key.clone());
                }
                recovery_invalidation_sent = true;
            }
        }
        // 收敛 (3)：退避后重连（Last-Event-ID 续传）。串行走完即停在最末值。
        let delay = backoff
            .get(attempt.min(backoff.len().saturating_sub(1)))
            .copied()
            .unwrap_or(Duration::from_secs(5));
        attempt = attempt.saturating_add(1);
        sleep_interruptible(delay, &shutdown);
    }
}

/// 可被 shutdown 打断的睡眠（25ms 切片）。
fn sleep_interruptible(total: Duration, shutdown: &AtomicBool) {
    let slice = Duration::from_millis(25);
    let mut slept = Duration::ZERO;
    while slept < total {
        if shutdown.load(Ordering::Relaxed) {
            return;
        }
        let step = slice.min(total - slept);
        std::thread::sleep(step);
        slept += step;
    }
}
